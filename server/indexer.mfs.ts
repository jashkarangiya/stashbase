/**
 * Indexer impl backed by the Python MFS sidecar. Each method translates
 * a logical op into one JSON request and reshapes the reply to match
 * the `Indexer` contract. All paths flowing through here are
 * **kbRoot-relative POSIX** — see `server/space.ts:toKbRel` /
 * `fromKbRel` for the conversion at call sites that still think in
 * space-relative terms.
 *
 * HTML special-case: we feed MFS a markdown-shaped plaintext (see
 * `server/html.ts:analyzeHtml`) so its markdown chunker keeps respecting
 * heading boundaries even though it has no HTML parser. The on-disk
 * file extension stays `.html` — only what we send to the indexer is
 * rewritten.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeHtml } from './html.ts';
import { detectFormat } from './format.ts';
import { resolveFileMetadata, isReservedMetadataFile } from './metadata.ts';
import { logger, errorMessage } from './log.ts';
import { getDaemon } from './mfs-daemon.ts';
import { getKbRoot } from './space.ts';
import type {
  EmbedderRuntimeConfig,
  Indexer,
  IndexStatus,
  SearchHit,
  SyncDiff,
} from './indexer.ts';

const log = logger('index');

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
  /** Per-space indexed-file cache, keyed by kbRoot-relative space name.
   *  Lets `status(space)` answer in ms without a daemon round-trip —
   *  critical because the daemon serialises ops, and a long-running
   *  embed would otherwise block every UI poll. Primed lazily on first
   *  `status()` for a given space; updated by upsert / delete / rename. */
  private spaceIndex = new Map<string, Set<string>>();
  /** Spaces whose indexedNames cache has been primed via a daemon
   *  `list` call. Status queries against unprimed spaces report all
   *  pending until the prime completes — better than flashing
   *  "everything's indexed" before we know. */
  private spaceReady = new Set<string>();
  /** Daemon generation when each space was primed; invalidate on
   *  respawn so a fresh process re-primes from scratch. */
  private spaceGeneration = new Map<string, number>();
  /** In-flight prime promises so concurrent status() calls dedupe. */
  private primeInflight = new Map<string, Promise<void>>();

  async bindSpace(space: string, cfg: EmbedderRuntimeConfig): Promise<void> {
    const daemon = getDaemon();
    await daemon.bindSpace(space, {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      model: cfg.model,
      dimension: cfg.dimension,
    });
    // Stale local cache for this space — could be from before the bind
    // (e.g. a status() call against an unbound space populated nothing,
    // then bind brings the collection into the world).
    this.spaceIndex.delete(space);
    this.spaceReady.delete(space);
    this.spaceGeneration.delete(space);
    log.info(`bound ${space} → ${cfg.provider}`);
  }

  async unbindSpace(space: string): Promise<void> {
    await getDaemon().unbindSpace(space);
    this.spaceIndex.delete(space);
    this.spaceReady.delete(space);
    this.spaceGeneration.delete(space);
  }

  /** Reset the local indexed-name cache for a space and queue a fresh
   *  prime via `list`. Used after first bind and after a daemon respawn.
   *  Concurrent calls dedupe via `primeInflight`. */
  private primeSpace(space: string): Promise<void> {
    const existing = this.primeInflight.get(space);
    if (existing) return existing;
    const daemon = getDaemon();
    const p = (async () => {
      try {
        const res = await daemon.call<{ files: Record<string, string> }>(
          'list', { space },
        );
        this.spaceIndex.set(space, new Set(Object.keys(res.files)));
        this.spaceReady.add(space);
        this.spaceGeneration.set(space, daemon.currentGeneration());
      } catch (err: unknown) {
        log.warn(`prime ${space}: list call failed: ${errorMessage(err)}`);
      } finally {
        this.primeInflight.delete(space);
      }
    })();
    this.primeInflight.set(space, p);
    return p;
  }

  /** Best-effort: ensure the cache for `space` is primed against the
   *  current daemon generation. Bails silently on failure — `status()`
   *  falls back to reporting all-pending until a successful prime. */
  private async ensurePrimed(space: string): Promise<void> {
    const gen = getDaemon().currentGeneration();
    if (this.spaceReady.has(space) && this.spaceGeneration.get(space) === gen) return;
    await this.primeSpace(space);
  }

  /** Find the bound space owning `kbRel`. Spaces are flat under
   *  kbRoot, so the owner is simply the first path segment. Returns
   *  null if no primed space covers the path, in which case the cache
   *  simply skips the update (the daemon is still the source of
   *  truth). */
  private spaceForKbRel(kbRel: string): string | null {
    const slash = kbRel.indexOf('/');
    const head = slash >= 0 ? kbRel.slice(0, slash) : kbRel;
    return this.spaceIndex.has(head) ? head : null;
  }

  /** Mark a file as indexed in the local cache. */
  private noteIndexed(kbRel: string): void {
    const space = this.spaceForKbRel(kbRel);
    if (!space) return;
    this.spaceIndex.get(space)?.add(kbRel);
  }

  private noteUnindexed(kbRel: string): void {
    const space = this.spaceForKbRel(kbRel);
    if (!space) return;
    this.spaceIndex.get(space)?.delete(kbRel);
  }

  async upsertFile(filePath: string, content: string): Promise<void> {
    // Reserved agent metadata files (`<space>/file-metadata.md`,
    // `<kbRoot>/.stashbase/space-metadata.md`) must not be indexed — their
    // YAML / 目录 prose would surface as bogus hits.
    if (isReservedMetadataFile(filePath)) return;
    const { text, ext, fileHash } = prepareForIndex(filePath, content);
    // Mark not-indexed while we re-embed so an in-flight status() during
    // a re-embed doesn't claim the file is up to date.
    this.noteUnindexed(filePath);
    if (content.length === 0) {
      await getDaemon().call('delete', { path: filePath });
      log.info(`upsert ${filePath}: empty file, skipped embedding`);
      return;
    }
    const t0 = Date.now();
    // File-level metadata (user front-matter / HTML <meta> + the agent's
    // `<space>/file-metadata.md` sidecar) rides along so every chunk carries it.
    const metadata = resolveFileMetadata(filePath, content);
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; total_ms: number }>(
      'upsert', { path: filePath, content: text, ext, file_hash: fileHash, metadata },
    );
    if (res.chunks > 0) this.noteIndexed(filePath);
    log.info(
      `upsert ${filePath}: ${res.chunks} chunks ` +
        `(embed ${fmtMs(res.embed_ms)}, total ${fmtMs(res.total_ms)}, wall ${fmtMs(Date.now() - t0)})`,
    );
  }

  async deleteFile(filePath: string): Promise<void> {
    await getDaemon().call('delete', { path: filePath });
    this.noteUnindexed(filePath);
  }

  async deletePathPrefix(prefix: string): Promise<void> {
    const norm = prefix.replace(/\/+$/, '');
    const matchPrefix = norm + '/';
    const res = await getDaemon().call<{ removed: number }>(
      'delete_prefix', { prefix: norm },
    );
    // Sweep local cache so subsequent status() polls don't keep
    // showing the now-deleted files as indexed.
    for (const [space, set] of this.spaceIndex) {
      void space;
      for (const name of [...set]) {
        if (name === norm || name.startsWith(matchPrefix)) set.delete(name);
      }
    }
    log.info(`delete_prefix ${prefix}: removed ${res.removed} chunk(s) from index`);
  }

  async renameFile(oldPath: string, newPath: string, content: string): Promise<void> {
    const { text, ext, fileHash } = prepareForIndex(newPath, content);
    const t0 = Date.now();
    // Metadata only matters on the re-embed fallback (content changed);
    // the hash-match fast path copies existing rows, metadata included.
    const metadata = resolveFileMetadata(newPath, content);
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; fast_path?: boolean }>(
      'rename', { old: oldPath, new: newPath, content: text, ext, file_hash: fileHash, metadata },
    );
    this.noteUnindexed(oldPath);
    if (res.chunks > 0) this.noteIndexed(newPath);
    // Fast path reuses the cached vectors (embed_ms == 0); only the
    // fallback actually re-embeds. Log which one ran so a slow rename
    // is distinguishable from a copied one.
    const how = res.fast_path ? 'copied' : 're-embedded';
    log.info(
      `rename ${oldPath} → ${newPath}: ${how} ${res.chunks} chunks ` +
        `(embed ${fmtMs(res.embed_ms)}, wall ${fmtMs(Date.now() - t0)})`,
    );
  }

  async renamePathPrefix(
    oldPrefix: string,
    newPrefix: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void> {
    if (files.length === 0) {
      await getDaemon().call('rename_prefix', { old: oldPrefix, new: newPrefix, files: [] });
      return;
    }
    const payload = files.map((f) => {
      const rel = f.path.slice(oldPrefix.length + 1);
      const newP = `${newPrefix}/${rel}`;
      const { text, ext, fileHash } = prepareForIndex(newP, f.content);
      return { path: newP, content: text, ext, file_hash: fileHash };
    });
    const t0 = Date.now();
    const res = await getDaemon().call<{ files: number; chunks: number; fast_path_files?: number }>(
      'rename_prefix', { old: oldPrefix, new: newPrefix, files: payload },
    );
    for (const f of files) {
      this.noteUnindexed(f.path);
      const rel = f.path.slice(oldPrefix.length + 1);
      const next = `${newPrefix}/${rel}`;
      this.noteIndexed(next);
    }
    const fast = res.fast_path_files ?? 0;
    log.info(
      `rename_prefix ${oldPrefix} → ${newPrefix}: ` +
        `${res.files} files (${fast} copied, ${res.files - fast} re-embedded), ` +
        `${res.chunks} chunks (wall ${fmtMs(Date.now() - t0)})`,
    );
  }

  async syncDiff(space?: string): Promise<SyncDiff> {
    const args: Record<string, unknown> = {};
    if (space) args.space = space;
    const res = await getDaemon().call<{
      added: string[];
      modified: string[];
      deleted: string[];
      renamed?: Array<{ old: string; new: string; file_hash: string }>;
      unchanged_count: number;
    }>('scan_diff', args);
    const renamed = (res.renamed ?? []).map((r) => ({ old: r.old, new: r.new, fileHash: r.file_hash }));
    return { added: res.added, modified: res.modified, deleted: res.deleted, renamed };
  }

  async search(query: string, topK: number, space?: string, pathPrefix?: string): Promise<SearchHit[]> {
    const args: Record<string, unknown> = { query, top_k: topK };
    if (space) args.space = space;
    if (pathPrefix) args.path_prefix = pathPrefix;
    const res = await getDaemon().call<{ hits: DaemonHit[] }>('search', args);
    return res.hits.map((h) => ({
      fileName: h.path,
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

  async status(space?: string): Promise<IndexStatus> {
    // Per-space status: ask the daemon directly (it walks disk + reads
    // indexed names from Milvus). Cached at the daemon level; on the
    // Node side we prime the indexed-name cache opportunistically so
    // future calls answer quicker via a local diff.
    //
    // We hand the whole computation to the daemon for simplicity in the
    // multi-collection world — the old "Node-side disk walk + cache
    // diff" path made sense when one space owned one DB, but with N
    // collections any cache miss against any of them re-routes back to
    // the daemon anyway. Trade-off: a busy daemon serialises status
    // behind embeds; UI polls feel slower while a big embed is in
    // flight. Acceptable for v1; revisit if it bites.
    const args: Record<string, unknown> = {};
    if (space) args.space = space;
    const res = await getDaemon().call<{
      total: number;
      indexed: number;
      pending_count: number;
      pending: string[];
      orphaned_count: number;
      orphaned: string[];
      up_to_date: boolean;
    }>('status', args);
    // Opportunistically prime the local cache from the response so
    // upsert/delete have something to mutate.
    if (space) {
      const idx = new Set<string>();
      // We don't get the indexed-list back from `status`; if we
      // care later, switch to `list` + diff here. For now, just mark
      // ready when daemon reports up-to-date so callers know the
      // window of "everything pending" has closed.
      void idx;
      this.spaceReady.add(space);
      this.spaceGeneration.set(space, getDaemon().currentGeneration());
    }
    return {
      total: res.total,
      indexed: res.indexed,
      pendingCount: res.pending_count,
      pending: res.pending,
      orphanedCount: res.orphaned_count,
      orphaned: res.orphaned,
      upToDate: res.up_to_date,
      indexReady: !space ? true : this.spaceReady.has(space),
    };
  }

  async listFiles(space?: string): Promise<Record<string, string>> {
    const args: Record<string, unknown> = {};
    if (space) args.space = space;
    const res = await getDaemon().call<{ files: Record<string, string> }>('list', args);
    return res.files;
  }

  async closeStore(): Promise<void> {
    const daemon = getDaemon();
    if (daemon.currentGeneration() === 0) return;
    await daemon.call('close_store', {});
    this.spaceIndex.clear();
    this.spaceReady.clear();
    this.spaceGeneration.clear();
  }

  async close(): Promise<void> {
    await getDaemon().close();
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
