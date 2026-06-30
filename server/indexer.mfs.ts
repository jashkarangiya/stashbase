/**
 * Indexer impl backed by the Python MFS sidecar. Each method translates
 * a logical op into one JSON request and reshapes the reply to match
 * the `Indexer` contract. The `Indexer` API speaks absolute POSIX paths;
 * this module is the daemon boundary and currently passes those identities
 * through unchanged (`toAbs`/`fromAbs`). The daemon keys one global
 * collection by absolute path and scopes by an absolute folder root.
 *
 * HTML special-case: we feed MFS a markdown-shaped plaintext (see
 * `server/html.ts:analyzeHtml`) so its markdown chunker keeps respecting
 * heading boundaries even though it has no HTML parser. The on-disk
 * file extension stays `.html` — only what we send to the indexer is
 * rewritten.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import path from 'node:path';
import { analyzeHtml } from './html.ts';
import { detectFormat } from './format.ts';
import { contentSizeError, shouldIndexSourcePath } from './indexable.ts';
import { logger } from './log.ts';
import { getDaemon } from './mfs-daemon.ts';
import type {
  EmbedderRuntimeConfig,
  Indexer,
  IndexStatus,
  SearchHit,
  SyncDiff,
} from './indexer.ts';

const log = logger('index');

// The daemon keys its single global collection by **absolute POSIX path**
// and binds absolute folder roots. Under the Folder model every caller
// already passes absolute paths/roots (`state.ts` binds absolute roots) and accepts absolute paths
// back, so this module is a straight pass-through. `toAbs`/`fromAbs` are
// kept as identity seams in case a future model needs translation again.
const toAbs = (p: string): string => p;
const fromAbs = (p: string): string => p;

/** Convert (path, raw content) into the (text, ext, fileHash) tuple
 *  the daemon expects. HTML gets pre-flattened to markdown-shaped
 *  plaintext so MFS's markdown chunker respects heading boundaries.
 *
 *  `fileHash` is **always BLAKE3 of the ORIGINAL on-disk content**, not
 *  the chunked text — it has to match the hash MFS Scanner computes
 *  during scan_diff (we patch the scanner to BLAKE3 too — see
 *  `python/stashbase_daemon.py:_patch_scanner_blake3`), otherwise an HTML
 *  file would forever look "modified" against the index. BLAKE3(content
 *  as UTF-8) here equals the daemon's BLAKE3 of the raw file bytes for
 *  any UTF-8 file — the same invariant SHA256 relied on. */
function prepareForIndex(filePath: string, content: string): {
  text: string;
  ext: string;
  fileHash: string;
} {
  const fileHash = bytesToHex(blake3(new TextEncoder().encode(content)));
  const format = detectFormat(filePath);
  if (format === 'html') {
    // HTML is structured (the .html file is the source of truth), but
    // MFS's chunker splits on markdown headings — so we run a cheap,
    // in-memory "targeted optimization" that turns <h1-6> into `#`
    // headings + flattened body. Done here at feed time (not materialized
    // to a hidden .md) because the transform is pure-regex / near-free and
    // the .html already covers viewing. Unstructured sources (pdf/image),
    // by contrast, are extracted to a hidden `.md` on disk because their
    // conversion is expensive and worth caching.
    const { plaintext } = analyzeHtml(content);
    return { text: plaintext, ext: '.md', fileHash };
  }
  // Markdown (incl. the derived `.md` of an unstructured source): the
  // file already IS the structured single source of truth — index as-is.
  return {
    text: content,
    ext: path.extname(filePath).toLowerCase() || '.md',
    fileHash,
  };
}

interface DaemonHit {
  path: string;
  chunk_index: number;
  chunk_text: string;
  start_line?: number;
  end_line?: number;
  score: number;
  metadata?: Record<string, unknown>;
}

export class MfsIndexer implements Indexer {
  private loggedBindings = new Map<string, string>();
  /** Folders that have successfully received at least one daemon status
   *  response in this process. */
  private folderReady = new Set<string>();

  async bindFolder(folder: string, cfg: EmbedderRuntimeConfig): Promise<void> {
    const daemon = getDaemon();
    await daemon.bindFolder(toAbs(folder), {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      model: cfg.model,
      dimension: cfg.dimension,
    });
    this.folderReady.delete(folder);
    const bindingKey = `${cfg.provider}:${cfg.model ?? ''}:${cfg.dimension ?? ''}`;
    if (this.loggedBindings.get(folder) === bindingKey) {
      log.debug(`bound ${folder} → ${cfg.provider}`);
    } else {
      this.loggedBindings.set(folder, bindingKey);
      log.info(`bound ${folder} → ${cfg.provider}`);
    }
  }

  async unbindFolder(folder: string): Promise<void> {
    await getDaemon().unbindFolder(toAbs(folder));
    this.folderReady.delete(folder);
    this.loggedBindings.delete(folder);
  }

  async upsertFile(filePath: string, content: string): Promise<number> {
    if (!shouldIndexSourcePath(filePath)) {
      await getDaemon().call('delete', { path: toAbs(filePath) });
      log.info(`upsert ${filePath}: skipped by index rules`);
      return 0;
    }
    const tooLarge = contentSizeError(content);
    if (tooLarge) {
      await getDaemon().call('delete', { path: toAbs(filePath) });
      log.warn(`upsert ${filePath}: ${tooLarge}`);
      return 0;
    }
    const { text, ext, fileHash } = prepareForIndex(filePath, content);
    // Covers truly empty files AND files whose extractable text is empty
    // (bundler-format HTML that is one giant <script>, whitespace-only
    // notes) — embedding either would store 0 chunks, so skip the
    // round-trip. `/api/index-status` filters the same files out of
    // `pending` (see `hasNoExtractableText`) so they don't pulse forever.
    if (text.trim().length === 0) {
      await getDaemon().call('delete', { path: toAbs(filePath) });
      log.info(`upsert ${filePath}: no extractable text, skipped embedding`);
      return 0;
    }
    const t0 = Date.now();
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; total_ms: number }>(
      'upsert', { path: toAbs(filePath), content: text, ext, file_hash: fileHash, metadata: {} },
    );
    log.info(
      `upsert ${filePath}: ${res.chunks} chunks ` +
        `(embed ${fmtMs(res.embed_ms)}, total ${fmtMs(res.total_ms)}, wall ${fmtMs(Date.now() - t0)})`,
    );
    return res.chunks;
  }

  async upsertConvertedFile(sourceAbs: string, derivedMd: string, sourceHash: string): Promise<number> {
    // PDF/image: the searchable text is the derived markdown (stored in app
    // data), but we index it UNDER the source's own path so folder-scoped
    // search finds it and the daemon's source-file hash diff matches. Force
    // ext='.md' (the content is markdown regardless of the .pdf/.png path)
    // and stamp the source's byte hash so reconcile sees "unchanged".
    if (derivedMd.trim().length === 0) {
      await getDaemon().call('delete', { path: toAbs(sourceAbs) });
      return 0;
    }
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; total_ms: number }>(
      'upsert', { path: toAbs(sourceAbs), content: derivedMd, ext: '.md', file_hash: sourceHash, metadata: {} },
    );
    log.info(`upsert(converted) ${sourceAbs}: ${res.chunks} chunks (embed ${fmtMs(res.embed_ms)})`);
    return res.chunks;
  }

  async deleteFile(filePath: string): Promise<void> {
    await getDaemon().call('delete', { path: toAbs(filePath) });
  }

  async deletePathPrefix(prefix: string): Promise<void> {
    const norm = prefix.replace(/\/+$/, '');
    const res = await getDaemon().call<{ removed: number }>(
      'delete_prefix', { prefix: toAbs(norm) },
    );
    log.info(`delete_prefix ${prefix}: removed ${res.removed} chunk(s) from index`);
  }

  async renameFile(oldPath: string, newPath: string, content: string): Promise<number> {
    const { text, ext, fileHash } = prepareForIndex(newPath, content);
    const t0 = Date.now();
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; fast_path?: boolean }>(
      'rename', { old: toAbs(oldPath), new: toAbs(newPath), content: text, ext, file_hash: fileHash, metadata: {} },
    );
    // Fast path reuses the cached vectors (embed_ms == 0); only the
    // fallback actually re-embeds. Log which one ran so a slow rename
    // is distinguishable from a copied one.
    const how = res.fast_path ? 'copied' : 're-embedded';
    log.info(
      `rename ${oldPath} → ${newPath}: ${how} ${res.chunks} chunks ` +
        `(embed ${fmtMs(res.embed_ms)}, wall ${fmtMs(Date.now() - t0)})`,
    );
    return res.chunks;
  }

  async renamePathPrefix(
    oldPrefix: string,
    newPrefix: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void> {
    if (files.length === 0) {
      await getDaemon().call('rename_prefix', { old: toAbs(oldPrefix), new: toAbs(newPrefix), files: [] });
      return;
    }
    const payload = files.map((f) => {
      const rel = f.path.slice(oldPrefix.length + 1);
      const newP = `${newPrefix}/${rel}`;
      const { text, ext, fileHash } = prepareForIndex(newP, f.content);
      return { path: toAbs(newP), content: text, ext, file_hash: fileHash };
    });
    const t0 = Date.now();
    const res = await getDaemon().call<{ files: number; chunks: number; fast_path_files?: number }>(
      'rename_prefix', { old: toAbs(oldPrefix), new: toAbs(newPrefix), files: payload },
    );
    const fast = res.fast_path_files ?? 0;
    log.info(
      `rename_prefix ${oldPrefix} → ${newPrefix}: ` +
        `${res.files} files (${fast} copied, ${res.files - fast} re-embedded), ` +
        `${res.chunks} chunks (wall ${fmtMs(Date.now() - t0)})`,
    );
  }

  async syncDiff(folder?: string): Promise<SyncDiff> {
    const args: Record<string, unknown> = {};
    if (folder) args.folder = toAbs(folder);
    const res = await getDaemon().call<{
      added: string[];
      modified: string[];
      deleted: string[];
      renamed?: Array<{ old: string; new: string; file_hash: string }>;
      unchanged_count: number;
    }>('scan_diff', args);
    const renamed = (res.renamed ?? []).map((r) => ({ old: fromAbs(r.old), new: fromAbs(r.new), fileHash: r.file_hash }));
    return {
      added: res.added.map(fromAbs),
      modified: res.modified.map(fromAbs),
      deleted: res.deleted.map(fromAbs),
      renamed,
    };
  }

  async search(query: string, topK: number, folder?: string, pathPrefix?: string): Promise<SearchHit[]> {
    const args: Record<string, unknown> = { query, top_k: topK };
    if (folder) args.folder = toAbs(folder);
    if (pathPrefix) args.path_prefix = toAbs(pathPrefix);
    const res = await getDaemon().call<{ hits: DaemonHit[] }>('search', args);
    return res.hits.map((h) => ({
      fileName: fromAbs(h.path),
      chunkIndex: h.chunk_index,
      content: h.chunk_text,
      // MFS markdown chunker stuffs heading info into metadata; lift it
      // to a top-level `heading` field so the external SearchHit contract
      // stays format-agnostic.
      heading: typeof h.metadata?.heading_text === 'string'
        ? (h.metadata.heading_text as string)
        : '',
      startLine: h.start_line,
      endLine: h.end_line,
      score: h.score,
    }));
  }

  async status(folder?: string): Promise<IndexStatus> {
    // Per-folder status: ask the daemon directly. It owns both disk scan
    // and indexed-name truth, which keeps Node from maintaining a second
    // partial cache that can drift from the vector store.
    const args: Record<string, unknown> = {};
    if (folder) args.folder = toAbs(folder);
    const res = await getDaemon().call<{
      total: number;
      indexed: number;
      pending_count: number;
      pending: string[];
      orphaned_count: number;
      orphaned: string[];
      up_to_date: boolean;
    }>('status', args);
    if (folder) {
      this.folderReady.add(folder);
    }
    return {
      total: res.total,
      indexed: res.indexed,
      pendingCount: res.pending_count,
      pending: res.pending.map(fromAbs),
      orphanedCount: res.orphaned_count,
      orphaned: res.orphaned.map(fromAbs),
      upToDate: res.up_to_date,
      indexReady: !folder ? true : this.folderReady.has(folder),
    };
  }

  async listFiles(folder?: string): Promise<Record<string, string>> {
    const args: Record<string, unknown> = {};
    if (folder) args.folder = toAbs(folder);
    const res = await getDaemon().call<{ files: Record<string, string> }>('list', args);
    const out: Record<string, string> = {};
    for (const [abs, hash] of Object.entries(res.files)) out[fromAbs(abs)] = hash;
    return out;
  }

  async closeStore(): Promise<void> {
    const daemon = getDaemon();
    if (daemon.currentGeneration() === 0) return;
    try {
      await daemon.call('close_store', {});
    } finally {
      await daemon.close();
    }
    this.folderReady.clear();
  }

  async close(): Promise<void> {
    await getDaemon().close();
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
