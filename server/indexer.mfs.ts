/**
 * Indexer impl backed by the Python MFS sidecar. Each method translates
 * a logical op into one JSON request and reshapes the reply to match
 * the `Indexer` contract.
 *
 * HTML special-case: we feed MFS a markdown-shaped plaintext (see
 * `server/html.ts:analyzeHtml`) so its markdown chunker keeps respecting
 * heading boundaries even though it has no HTML parser. The on-disk
 * file extension stays `.html` — only what we send to the indexer is
 * rewritten.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { analyzeHtml } from './html.ts';
import { detectFormat, listFiles } from './files.ts';
import { logger, errorMessage } from './log.ts';
import { getDaemon } from './mfs-daemon.ts';
import type {
  EmbedderRuntimeConfig,
  Indexer,
  IndexStatus,
  SearchHit,
  SyncDiff,
} from './indexer.ts';

const log = logger('index');

/** Convert (fileName, raw content) into the (text, ext, fileHash) tuple
 *  the daemon expects. HTML gets pre-flattened to markdown-shaped
 *  plaintext so MFS's markdown chunker respects heading boundaries.
 *
 *  `fileHash` is **always sha256 of the ORIGINAL on-disk content**, not
 *  the chunked text — it has to match the hash MFS Scanner computes
 *  during sync_diff, otherwise an HTML file would forever look
 *  "modified" against the index. */
function prepareForIndex(fileName: string, content: string): {
  text: string;
  ext: string;
  fileHash: string;
} {
  const fileHash = createHash('sha256').update(content, 'utf8').digest('hex');
  const format = detectFormat(fileName);
  if (format === 'html') {
    const { plaintext } = analyzeHtml(content);
    return { text: plaintext, ext: '.md', fileHash };
  }
  return {
    text: content,
    ext: path.extname(fileName).toLowerCase() || '.md',
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
  private currentSpace: string | null = null;
  /** Daemon generation at the time we last sent `set_space`. If the
   *  daemon respawned (crash + auto-restart, or manual close+reopen)
   *  the new Python process doesn't know our space — `setSpace` must
   *  re-issue. Without this check, the cache lies after a respawn and
   *  every op fails with "set_space must be called before any data op". */
  private boundGeneration: number = -1;
  /** Set of space-relative paths currently in the Milvus index, kept
   *  in sync via upsert/delete/rename. Lets `status()` answer in ms
   *  without hopping through the daemon — critical because the daemon
   *  serializes ops, and a long-running embed would otherwise block
   *  every UI poll. Primed from a one-shot `list` call on setSpace. */
  private indexedNames: Set<string> = new Set();
  /** True until the initial `list` call has populated indexedNames.
   *  Status calls during this window return pending=all so the UI
   *  doesn't flash a misleading "all indexed" state. */
  private indexedReady: boolean = false;

  /** Resolves once a `setSpace` has succeeded; data ops await this so
   *  they can't race ahead of a kill/respawn cycle and hit a daemon
   *  with no store bound. Replaced with a fresh pending promise on
   *  `dropStore` / `closeStore` and on `setSpace` failure; resolved on
   *  the next successful `setSpace`. */
  private boundReady: Promise<void>;
  private boundReadyResolve!: () => void;
  private boundReadyReject!: (err: Error) => void;

  /** Embedder config to (re)apply on every fresh daemon process. Null
   *  means "use the daemon's startup default" (local ONNX). */
  private embedderConfig: EmbedderRuntimeConfig | null = null;
  /** Cache key of the embedder currently loaded in the daemon. Used so
   *  hopping between spaces that share the same provider is free. The
   *  key folds in the API key (hashed) so revoking + re-issuing a key
   *  forces a re-load. */
  private embedderKey: string | null = null;
  /** Daemon generation at the time we last sent `set_embedder`. After a
   *  respawn the new Python process is back on its default; we re-issue
   *  before any other op so the dim is correct for `set_space`. */
  private embedderGeneration: number = -1;

  constructor() {
    this.boundReady = this.makeBoundReady();
  }

  private makeBoundReady(): Promise<void> {
    const p = new Promise<void>((resolve, reject) => {
      this.boundReadyResolve = resolve;
      this.boundReadyReject = reject;
    });
    // Attach a no-op handler so an unattended rejection doesn't crash
    // the Node process. `setSpace` calls `boundReadyReject` whenever a
    // bind fails (so any data op queued behind `await ensureBound()`
    // fails fast), but in practice the bind often fails BEFORE any op
    // has had a chance to subscribe — typical case: user opens a space
    // whose `milvus.db` is locked by an orphan daemon, no other call
    // is in flight, rejection has no consumer. Node 22 treats that as
    // unhandled and aborts. The `.catch` here marks the promise as
    // handled for that purpose; the rejection is still surfaced
    // through any future `await this.boundReady` (rejections are
    // sticky), so real consumers still see the error.
    p.catch(() => { /* see comment above */ });
    return p;
  }

  async setSpace(spaceRoot: string): Promise<void> {
    const daemon = getDaemon();
    // Force a spawn (if needed) so the generation counter is meaningful.
    await daemon.ensureReady();
    if (spaceRoot === this.currentSpace && daemon.currentGeneration() === this.boundGeneration) {
      return;
    }
    try {
      await this.applyEmbedderIfStale();
      const home = path.join(spaceRoot, '.stashbase', 'mfs');
      await daemon.call('set_space', { home });
      this.currentSpace = spaceRoot;
      this.boundGeneration = daemon.currentGeneration();
      // Unblock any data ops queued behind a kill/respawn cycle. Done
      // before the `list` prime call below so a stalled `list` doesn't
      // hold sync / upserts hostage — the cache primes opportunistically.
      this.boundReadyResolve();
      this.boundReady = Promise.resolve();
    } catch (err) {
      // Bind failed (daemon crashed mid-call, dim mismatch, etc.). Fail
      // fast for any data ops queued behind boundReady, then arm a fresh
      // pending promise so a subsequent successful setSpace can unblock
      // future callers. Without this the queue would hang forever.
      const e = err instanceof Error ? err : new Error(String(err));
      this.boundReadyReject(e);
      this.boundReady = this.makeBoundReady();
      throw err;
    }
    // Prime the indexed-names cache. `list` is a single Milvus query
    // — no embed, no blocking on ongoing upserts (we just set_space,
    // queue is empty). Subsequent status() calls work off this cache.
    // Failure here is non-fatal: status() falls back to "all pending"
    // until a successful list runs, and binding itself already succeeded.
    this.indexedReady = false;
    this.indexedNames = new Set();
    try {
      const res = await daemon.call<{ files: Record<string, string> }>('list', {});
      this.indexedNames = new Set(Object.keys(res.files));
      this.indexedReady = true;
    } catch (err: unknown) {
      log.warn(`setSpace: list call failed, status will report all pending: ${errorMessage(err)}`);
    }
  }

  /** Block until the daemon has a space bound, then re-bind on the fly
   *  if its generation drifted (crash + respawn while we were waiting).
   *  Used by every data op to keep the "no space set" Python error
   *  from surfacing through races. */
  private async ensureBound(): Promise<void> {
    // First await any in-flight rebind. Captures the *current*
    // reference; if dropStore swaps it after, we'll loop once via
    // the generation check below.
    await this.boundReady;
    const daemon = getDaemon();
    await daemon.ensureReady();
    if (!this.currentSpace) {
      throw new Error('no space bound');
    }
    if (daemon.currentGeneration() !== this.boundGeneration) {
      // Daemon was killed (e.g. crash, or our own dropStore) since
      // the last bind. Re-issue against the same space.
      await this.setSpace(this.currentSpace);
    }
  }

  async upsertFile(fileName: string, content: string): Promise<void> {
    await this.ensureBound();
    const { text, ext, fileHash } = prepareForIndex(fileName, content);
    // Temporarily mark the file as not-indexed while we re-embed.
    // Critical for the "modified" path (external edit caught by sync)
    // — without this the cache still says "indexed" for the 10+ seconds
    // the re-embed takes, so the UI shows the row at full opacity even
    // though search results for it are about to be stale.
    this.indexedNames.delete(fileName);
    if (content.length === 0) {
      await getDaemon().call('delete', { path: fileName });
      log.info(`upsert ${fileName}: empty file, skipped embedding`);
      return;
    }
    const t0 = Date.now();
    const res = await getDaemon().call<{ chunks: number; embed_ms: number; total_ms: number }>(
      'upsert', { path: fileName, content: text, ext, file_hash: fileHash },
    );
    // Empty file embeds to 0 chunks — not searchable, leave it out so
    // status() shows it as pending instead of falsely "indexed".
    if (res.chunks > 0) this.indexedNames.add(fileName);
    log.info(
      `upsert ${fileName}: ${res.chunks} chunks ` +
        `(embed ${fmtMs(res.embed_ms)}, total ${fmtMs(res.total_ms)}, wall ${fmtMs(Date.now() - t0)})`,
    );
  }

  async deleteFile(fileName: string): Promise<void> {
    await this.ensureBound();
    await getDaemon().call('delete', { path: fileName });
    this.indexedNames.delete(fileName);
  }

  async deletePathPrefix(prefix: string): Promise<void> {
    await this.ensureBound();
    const norm = prefix.replace(/\/+$/, '');
    const matchPrefix = norm + '/';
    const res = await getDaemon().call<{ removed: number }>(
      'delete_prefix', { prefix: norm },
    );
    // Sweep the local cache so subsequent status() polls don't keep
    // showing the now-deleted files as indexed.
    for (const name of [...this.indexedNames]) {
      if (name === norm || name.startsWith(matchPrefix)) {
        this.indexedNames.delete(name);
      }
    }
    log.info(`delete_prefix ${prefix}: removed ${res.removed} chunk(s) from index`);
  }

  async renameFile(oldName: string, newName: string, content: string): Promise<void> {
    await this.ensureBound();
    const { text, ext, fileHash } = prepareForIndex(newName, content);
    const t0 = Date.now();
    const res = await getDaemon().call<{ chunks: number; embed_ms: number }>(
      'rename', { old: oldName, new: newName, content: text, ext, file_hash: fileHash },
    );
    this.indexedNames.delete(oldName);
    if (res.chunks > 0) this.indexedNames.add(newName);
    log.info(
      `rename ${oldName} → ${newName}: re-embedded ${res.chunks} chunks ` +
        `(embed ${fmtMs(res.embed_ms)}, wall ${fmtMs(Date.now() - t0)})`,
    );
  }

  async renamePathPrefix(
    oldPrefix: string,
    newPrefix: string,
    files: Array<{ fileName: string; content: string }>,
  ): Promise<void> {
    await this.ensureBound();
    if (files.length === 0) {
      // No content under the old prefix yet — just sweep any orphan rows.
      await getDaemon().call('rename_prefix', { old: oldPrefix, new: newPrefix, files: [] });
      return;
    }
    // The new path for each file is just rebasing onto the new prefix.
    const payload = files.map((f) => {
      const rel = f.fileName.slice(oldPrefix.length + 1); // strip "oldPrefix/"
      const newPath = `${newPrefix}/${rel}`;
      const { text, ext, fileHash } = prepareForIndex(newPath, f.content);
      return { path: newPath, content: text, ext, file_hash: fileHash };
    });
    const t0 = Date.now();
    const res = await getDaemon().call<{ files: number; chunks: number }>(
      'rename_prefix', { old: oldPrefix, new: newPrefix, files: payload },
    );
    // Reflect prefix rename in the local cache.
    for (const f of files) {
      this.indexedNames.delete(f.fileName);
      const rel = f.fileName.slice(oldPrefix.length + 1);
      this.indexedNames.add(`${newPrefix}/${rel}`);
    }
    log.info(
      `rename_prefix ${oldPrefix} → ${newPrefix}: ` +
        `${res.files} files, ${res.chunks} chunks (wall ${fmtMs(Date.now() - t0)})`,
    );
  }

  async syncDiff(spaceRoot: string): Promise<SyncDiff> {
    await this.ensureBound();
    const res = await getDaemon().call<SyncDiff & { unchanged_count: number }>(
      'scan_diff', { root: spaceRoot },
    );
    return { added: res.added, modified: res.modified, deleted: res.deleted };
  }

  async search(query: string, topK: number): Promise<SearchHit[]> {
    await this.ensureBound();
    const res = await getDaemon().call<{ hits: DaemonHit[] }>(
      'search', { query, top_k: topK },
    );
    return res.hits.map((h) => ({
      fileName: h.path,
      chunkIndex: h.chunk_index,
      content: h.chunk_text,
      // MFS markdown chunker stuffs heading info into metadata; lift
      // it to a top-level `heading` field so the external SearchHit
      // contract stays format-agnostic.
      heading: typeof h.metadata?.heading_text === 'string'
        ? (h.metadata.heading_text as string)
        : '',
      startLine: h.start_line,
      endLine: h.end_line,
      score: h.score,
    }));
  }

  async status(_spaceRoot: string): Promise<IndexStatus> {
    // Pure local computation — disk walk + diff against the
    // indexed-names cache maintained by upsert/delete/rename. Avoids
    // a daemon round-trip so the UI poll responds in ms even when
    // the daemon is mid-embed (which serialises all its other ops).
    //
    // Trade-off: until the initial `list` call in setSpace completes,
    // `indexedReady` is false and we report everything pending — that
    // window is < 100ms in practice and at worst flashes a brief
    // "indexing" state, never a stale "all indexed".
    const filesOnDisk = listFiles().filter((f) => f.size > 0);
    const onDiskNames = new Set(filesOnDisk.map((f) => f.name));
    const indexedNow = this.indexedReady ? this.indexedNames : new Set<string>();

    const pending: string[] = [];
    let indexed = 0;
    for (const name of onDiskNames) {
      if (indexedNow.has(name)) indexed++;
      else pending.push(name);
    }
    pending.sort();

    const orphaned: string[] = [];
    for (const name of indexedNow) if (!onDiskNames.has(name)) orphaned.push(name);
    orphaned.sort();

    return {
      total: onDiskNames.size,
      indexed,
      pendingCount: pending.length,
      pending,
      orphanedCount: orphaned.length,
      orphaned,
      upToDate: pending.length === 0 && orphaned.length === 0,
      indexReady: this.indexedReady,
    };
  }

  async close(): Promise<void> {
    await getDaemon().close();
  }

  async setEmbedder(cfg: EmbedderRuntimeConfig): Promise<void> {
    const daemon = getDaemon();
    await daemon.ensureReady();
    const key = embedderCacheKey(cfg);
    // No-op if the daemon is already loaded with this exact config in
    // this generation. Critical for the per-space provider flow —
    // hopping between two onnx spaces shouldn't reload the 200 MB ONNX
    // model each time.
    if (this.embedderKey === key && this.embedderGeneration === daemon.currentGeneration()) {
      this.embedderConfig = cfg;
      return;
    }
    this.embedderConfig = cfg;
    // Invalidate the bound-space cache: after a provider swap the
    // daemon's store is closed (mismatched dim) or about to be, so we
    // need to re-issue `set_space` before the next data op even if the
    // user didn't change space. Re-arms `boundReady` so data ops
    // queue behind the upcoming set_space.
    this.invalidateBinding();
    const res = await daemon.call<{ provider: string; model: string; dim: number }>('set_embedder', {
      provider: cfg.provider,
      ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.dimension ? { dimension: cfg.dimension } : {}),
    });
    // Daemon's `ready` event always reports the startup default (onnx
    // bge-m3); log the post-swap state so logs reflect what's actually
    // being used for embeds.
    log.info(`embedder set: provider=${res.provider} model=${res.model} dim=${res.dim}`);
    this.embedderKey = key;
    this.embedderGeneration = daemon.currentGeneration();
  }

  async closeStore(): Promise<void> {
    const daemon = getDaemon();
    // No spawn just to close — if the daemon isn't running there's
    // nothing to close.
    if (daemon.currentGeneration() === 0) return;
    await daemon.call('close_store', {});
    // The store is gone; any subsequent data op must go through
    // `setSpace` first. We keep `embedderKey` intact — closing the
    // store doesn't replace the embedder.
    this.invalidateBinding();
  }

  async dropStore(): Promise<void> {
    const daemon = getDaemon();
    if (daemon.currentGeneration() === 0) return;
    // pymilvus + Milvus Lite cache schema state at the Python-process
    // level: a per-collection `has_collection` check survives both
    // `drop_collection()` and a `close()`+reopen of the MilvusClient
    // pointed at the same URI. The only reliable way to clear it is
    // to kill the Python daemon entirely; the next op respawns it
    // fresh. Cost: re-loading the ~200 MB ONNX model when switching
    // back to local (file is cached in HF_HOME, so this is just
    // deserialization, ~5–10 s). Worth the simplicity.
    await daemon.close();
    this.invalidateBinding();
    this.embedderKey = null;
    this.embedderGeneration = -1;
    this.embedderConfig = null;
  }

  /** Clear the cached binding state and arm a fresh `boundReady` so
   *  any subsequent data op blocks until the next successful
   *  `setSpace`. Used by both `closeStore` and `dropStore`. */
  private invalidateBinding(): void {
    this.currentSpace = null;
    this.boundGeneration = -1;
    this.indexedReady = false;
    this.indexedNames = new Set();
    this.boundReady = this.makeBoundReady();
  }

  /** Re-issue `set_embedder` if the daemon respawned (or we never sent
   *  it). Called from `setSpace`; no-op when the daemon already has the
   *  right config for this generation. */
  private async applyEmbedderIfStale(): Promise<void> {
    if (this.embedderConfig === null) return;
    const daemon = getDaemon();
    if (daemon.currentGeneration() === this.embedderGeneration) return;
    const res = await daemon.call<{ provider: string; model: string; dim: number }>('set_embedder', {
      provider: this.embedderConfig.provider,
      ...(this.embedderConfig.apiKey ? { api_key: this.embedderConfig.apiKey } : {}),
      ...(this.embedderConfig.model ? { model: this.embedderConfig.model } : {}),
      ...(this.embedderConfig.dimension ? { dimension: this.embedderConfig.dimension } : {}),
    });
    log.info(`embedder re-applied after daemon respawn: provider=${res.provider} model=${res.model} dim=${res.dim}`);
    this.embedderKey = embedderCacheKey(this.embedderConfig);
    this.embedderGeneration = daemon.currentGeneration();
  }
}

/** Stable cache key for an embedder config — used to short-circuit
 *  `setEmbedder` when nothing changed. We hash the API key (sha256/16)
 *  so two openai configs with different keys don't collide and the key
 *  itself never lands in a log line. */
function embedderCacheKey(cfg: EmbedderRuntimeConfig): string {
  const parts: string[] = [cfg.provider];
  if (cfg.model) parts.push(`m=${cfg.model}`);
  if (cfg.dimension) parts.push(`d=${cfg.dimension}`);
  if (cfg.apiKey) parts.push(`k=${createHash('sha256').update(cfg.apiKey).digest('hex').slice(0, 16)}`);
  return parts.join('|');
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
