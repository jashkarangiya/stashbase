/**
 * Indexer abstraction — the only surface the rest of the server is
 * allowed to import. Concrete impl currently `MfsIndexer` (sidecar
 * Python over stdio). Switching to a native TS MFS package (when
 * upstream ships one) means writing a new class behind this interface
 * and changing one import line in `index.ts`.
 *
 * Paths are space-relative POSIX (`topic/note.md`) on every method —
 * the impl is responsible for any conversion to / from the underlying
 * store's path representation.
 */

export interface SearchHit {
  /** Space-relative POSIX path (`topic/note.md`). */
  fileName: string;
  chunkIndex: number;
  /** Indexed chunk body — already heading-prefixed for markdown / html. */
  content: string;
  /** Heading breadcrumb (`A › B › C`), or empty if the chunker didn't tag one. */
  heading: string;
  /** 1-based source-line offsets — useful for "jump to line N" UX. */
  startLine?: number;
  endLine?: number;
  /** Hybrid (RRF) score, higher = better. Scale is opaque; compare within a single response only. */
  score: number;
}

export interface EmbedderRuntimeConfig {
  provider: 'onnx' | 'openai';
  /** API key for hosted providers. Required for `openai`. */
  apiKey?: string;
  /** Optional override; impls have sensible defaults per provider. */
  model?: string;
  /** Optional override; if omitted the impl uses the provider's default. */
  dimension?: number;
}

export interface Indexer {
  /** Bind the indexer to a space directory. Idempotent on repeated calls
   *  with the same path; switches the underlying store on a new path. */
  setSpace(spaceRoot: string): Promise<void>;

  /** Swap the embedding provider. After this call the indexer is in a
   *  "no space bound" state — caller must `setSpace` again before any
   *  data op. The impl is responsible for closing any open store with
   *  the old dim; the caller is responsible for clearing on-disk Milvus
   *  files (so the fresh collection can be created at the new dim). */
  setEmbedder(cfg: EmbedderRuntimeConfig): Promise<void>;

  /** Release any open underlying store file so the caller can `rm` it.
   *  Used as the second half of "delete the milvus.db then rebind". */
  closeStore(): Promise<void>;

  /** Drop the current collection in the backing store AND release the
   *  underlying file. Use this instead of `closeStore` when the next
   *  embedder will have a different vector dimension — just `rm`-ing
   *  the DB on disk leaves the backend's in-process schema cache
   *  stale, which then rejects the new `setSpace` with a dim mismatch. */
  dropStore(): Promise<void>;

  /** Insert / replace all chunks for one file. Empty content is valid —
   *  the file disappears from the index but no error is raised. */
  upsertFile(fileName: string, content: string): Promise<void>;

  /** Drop all chunks for one file. Safe to call on a never-indexed file. */
  deleteFile(fileName: string): Promise<void>;

  /** Drop all chunks for every file whose path starts with `prefix/`.
   *  Used by recursive folder-delete to clear the index in one shot
   *  instead of per-file deletes (avoids N round-trips to the daemon
   *  when wiping a populated folder). Safe on a prefix that has no
   *  matching rows. */
  deletePathPrefix(prefix: string): Promise<void>;

  /** Move a file in the index. `content` is the (unchanged) body — the
   *  impl may or may not re-embed depending on the backend. The MFS
   *  impl does a full re-embed (no in-place source update upstream). */
  renameFile(oldName: string, newName: string, content: string): Promise<void>;

  /** Move every file under `oldPrefix` to `newPrefix`. `files` carries
   *  the bodies under the OLD names, ordered however the caller likes.
   *  The MFS impl deletes every old-prefix row and re-embeds each file. */
  renamePathPrefix(
    oldPrefix: string,
    newPrefix: string,
    files: Array<{ fileName: string; content: string }>,
  ): Promise<void>;

  /** Hybrid search. Returns at most `topK` ordered by descending score. */
  search(query: string, topK: number): Promise<SearchHit[]>;

  /** Walk the space root and compute the diff against the current index.
   *  Used by `syncIndex` to catch external edits (vim / git checkout /
   *  Dropbox) that the in-app save path doesn't go through. Paths in
   *  the returned lists are space-relative. */
  syncDiff(spaceRoot: string): Promise<SyncDiff>;

  /** Lightweight progress check — name-set diff only, no hashing. Cheap
   *  enough that the MCP `index_status` tool can call it inline during
   *  a chat to tell the user whether search results may be incomplete. */
  status(spaceRoot: string): Promise<IndexStatus>;

  /** Shut down underlying resources. Currently called only on process exit. */
  close(): Promise<void>;
}

export interface SyncDiff {
  /** On disk, not yet in the index. */
  added: string[];
  /** In both, but content hash differs — likely an external edit. */
  modified: string[];
  /** In the index, gone from disk. */
  deleted: string[];
}

export interface IndexStatus {
  /** Files on disk that look indexable. */
  total: number;
  /** Files on disk that already have rows in the index. */
  indexed: number;
  /** How many files are still waiting to be indexed. */
  pendingCount: number;
  /** **Full** list of space-relative paths waiting to be indexed.
   *  The web UI uses this to grey out exactly those rows in the
   *  sidebar; MCP / Claude can sample / quote as needed. */
  pending: string[];
  /** Files in the index that no longer exist on disk. Usually 0. */
  orphanedCount: number;
  /** **Full** list of orphaned paths. The startup-sync path
   *  uses this to drop stale rows without paying a re-embed cost.
   *  Same shape as `pending` so both lists are comparable. */
  orphaned: string[];
  /** True iff pending = 0 and orphaned = 0. */
  upToDate: boolean;
  /** False while the indexer is still loading its indexed-file cache. */
  indexReady?: boolean;
  /** PDFs currently being converted to a readable note + bundle.
   *  Stashed onto the status response (rather than its own route)
   *  so the sidebar polls one endpoint to drive its busy-state UI. */
  pendingConversions?: string[];
}
