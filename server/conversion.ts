/**
 * Shared "unstructured source → extracted structured markdown" plumbing
 * for the two unstructured formats: PDFs (`pdf_extract.py`) and images
 * (`ocr_extract.py`). Each extracts the file's structured content into a
 * AppData-derived Markdown that becomes the text layer for search (and, for
 * PDFs, Agent text reading). Materialized to disk — unlike HTML's in-memory
 * transform — because these conversions are expensive (subprocess) and worth
 * caching.
 *
 * The two formats differ in only three things — captured by a
 * `ConversionSpec`:
 *   - `matches`     which filenames are convertible sources
 *   - `derivedNote` the AppData Markdown path a source maps to
 *   - `convert`     the actual extractor spawn (PDF emits an extra bundle)
 *
 * Context-free by design: every sourcePath is the source file's absolute path,
 * never derived from ambient window context, so discovery
 * and conversion behave identically from the GUI, a headless server, or
 * a `reindex` on a folder no window has open.
 *
 * On success the derived note is pushed into the index DIRECTLY (via the
 * hook `setDerivedNoteIndexer` wires at boot) — there is no fs-watcher
 * intermediary. Failures persist for reprocess affordances; in-flight
 * state is process memory (see `conversion-status.ts`).
 */
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { isPendingOrFailed, listInFlight, markDone, markFailed, markInFlight, setProgress, type ConversionProgress } from './conversion-status.ts';
import { clearRecord } from './conversion-status.ts';
import { fromSourcePath, relInFolder, toPosixAbs } from './folder.ts';
import { logger, errorMessage } from './log.ts';
import { isCloudPlaceholderName } from './indexable.ts';
import { hasNoExtractableText, indexableFileSizeError } from './indexable.ts';
import { registerDerivedSource } from './derived-store.ts';

const log = logger('conversion');

// Keep the in-flight indicator visible long enough for a 500ms-poll
// client to catch even a sub-second run.
const MIN_VISIBLE_MS = 800;
const DEFAULT_CONVERSION_CONCURRENCY = 1;

interface SourceSignature {
  size: number;
  mtimeMs: number;
}

export interface ConversionSpec {
  /** Short label for logs, e.g. `pdf_extract` / `ocr_extract`. */
  kind: string;
  /** Does this filename look like a convertible source (`.pdf`, image)? */
  matches: (name: string) => boolean;
  /** The AppData derived-note path for a source file. */
  derivedNote: (absPath: string) => string;
  /** Optional completeness check for formats whose derived note can be
   *  assembled from resumable partial work. */
  derivedReady?: (absPath: string, derivedAbsPath: string) => boolean;
  /** Run the extractor; resolve on success, reject with the stderr tail. */
  convert: (
    absPath: string,
    onProgress?: (progress: ConversionProgress) => void,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  /** Best-effort cleanup before a fresh run. Defaults to cleanupDerived.
   *  PDF uses this to keep resumable batch scratch while deleting stale
   *  final artifacts. */
  cleanupBeforeConvert?: (absPath: string) => void;
  /** Best-effort cleanup for derived files if the source disappears mid-run. */
  cleanupDerived?: (absPath: string) => void;
}

export class TransientConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientConversionError';
  }
}

function isTransientConversionError(err: unknown): boolean {
  return err instanceof TransientConversionError;
}

/** Wired at boot (`server/index.ts`): index a freshly written derived note
 *  UNDER its source path (the derived markdown lives in app data; the
 *  source PDF/image is the indexed entity). Injected to avoid a module
 *  cycle with `state.ts` — conversion is below the indexer in the import
 *  graph. */
let indexDerivedNote: ((sourceAbs: string, derivedAbs: string) => Promise<void>) | null = null;
export function setDerivedNoteIndexer(fn: (sourceAbs: string, derivedAbs: string) => Promise<void>): void {
  indexDerivedNote = fn;
}

/** True when a source's derived note exists AND is at least as new as the
 *  source (i.e. not stale). A changed source has a newer mtime than its
 *  old derived note → re-convert. This is the change-detection signal now
 *  that the derived note lives in app data (path-hash keyed, so its
 *  location doesn't change when the source content changes). */
function derivedIsFresh(spec: ConversionSpec, absPath: string): boolean {
  try {
    const derivedAbs = spec.derivedNote(absPath);
    const derivedMtime = fs.statSync(derivedAbs).mtimeMs;
    const sourceMtime = fs.statSync(absPath).mtimeMs;
    return derivedMtime >= sourceMtime && (spec.derivedReady?.(absPath, derivedAbs) ?? true);
  } catch {
    return false; // derived missing (or source gone) → not fresh
  }
}

const activeControllers = new Map<string, AbortController>();
const activeRuns = new Map<string, Promise<void>>();
let activeConversionSlots = 0;
const conversionSlotQueue: Array<() => void> = [];

function conversionConcurrency(): number {
  const raw = Number(process.env.STASHBASE_CONVERSION_CONCURRENCY ?? DEFAULT_CONVERSION_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CONVERSION_CONCURRENCY;
}

async function withConversionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeConversionSlots >= conversionConcurrency()) {
    await new Promise<void>((resolve) => conversionSlotQueue.push(resolve));
  }
  activeConversionSlots += 1;
  try {
    return await fn();
  } finally {
    activeConversionSlots -= 1;
    conversionSlotQueue.shift()?.();
  }
}

export function cancelConversion(sourcePath: string): boolean {
  const controller = activeControllers.get(sourcePath);
  if (!controller) return false;
  controller.abort();
  activeControllers.delete(sourcePath);
  return true;
}

export async function cancelAllConversions(timeoutMs = 2500): Promise<string[]> {
  const sourcePaths = [...activeControllers.keys()];
  if (sourcePaths.length === 0) return [];
  for (const sourcePath of sourcePaths) cancelConversion(sourcePath);
  const runs = sourcePaths
    .map((sourcePath) => activeRuns.get(sourcePath))
    .filter((run): run is Promise<void> => run != null);
  if (runs.length === 0) return sourcePaths;
  await Promise.race([
    Promise.allSettled(runs),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return sourcePaths;
}

export async function cancelConversionsUnder(sourcePathPrefix: string, timeoutMs = 2500): Promise<string[]> {
  const root = toPosixAbs(sourcePathPrefix).replace(/\/+$/, '');
  const sourcePaths = [...activeControllers.keys()]
    .filter((sourcePath) => sourcePath === root || sourcePath.startsWith(`${root}/`));
  if (sourcePaths.length === 0) return [];
  for (const sourcePath of sourcePaths) cancelConversion(sourcePath);
  const runs = sourcePaths
    .map((sourcePath) => activeRuns.get(sourcePath))
    .filter((run): run is Promise<void> => run != null);
  if (runs.length === 0) return sourcePaths;
  await Promise.race([
    Promise.allSettled(runs),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return sourcePaths;
}

/** Absolute POSIX identity for a source path — the conversion-status key,
 *  matching what `toSourcePath` produces and what the daemon stores. */
function sourcePathOf(absPath: string): string | null {
  return toPosixAbs(absPath);
}

function sourceSignature(absPath: string): SourceSignature | null {
  try {
    const st = fs.statSync(absPath);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

function sameSourceSignature(a: SourceSignature | null, b: SourceSignature | null): boolean {
  return a != null && b != null && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Run a conversion fire-and-forget, tracking in-flight in memory and
 *  persisting failures so the UI can offer Retry. On success the derived
 *  note goes straight into the index — no watcher round-trip. */
function runConversion(absPath: string, sourcePath: string | null, spec: ConversionSpec): Promise<void> {
  log.info(`${spec.kind}: ${absPath} → ${path.basename(spec.derivedNote(absPath))} …`);
  registerDerivedSource(absPath);
  if (sourcePath) markInFlight(sourcePath);
  const controller = new AbortController();
  if (sourcePath) activeControllers.set(sourcePath, controller);
  const startedWith = sourceSignature(absPath);
  const t0 = Date.now();
  // Defer the terminal status write briefly so a 500ms-poll client can
  // observe a short conversion as pending for search-readiness accounting.
  const settle = (fn: () => void): Promise<void> => {
    if (!sourcePath) { fn(); return Promise.resolve(); }
    return new Promise((resolve) => {
      setTimeout(() => {
        fn();
        resolve();
      }, Math.max(0, MIN_VISIBLE_MS - (Date.now() - t0)));
    });
  };
  try { (spec.cleanupBeforeConvert ?? spec.cleanupDerived)?.(absPath); } catch (err: unknown) {
    log.warn(`${spec.kind}: preflight cleanup failed for ${absPath}: ${errorMessage(err)}`);
  }
  const cleanupFailedOutput = () => {
    try { (spec.cleanupBeforeConvert ?? spec.cleanupDerived)?.(absPath); } catch (cleanupErr: unknown) {
      log.warn(`${spec.kind}: failed-output cleanup failed for ${absPath}: ${errorMessage(cleanupErr)}`);
    }
  };
  const run = withConversionSlot(() =>
    spec.convert(absPath, (progress) => { if (sourcePath) setProgress(sourcePath, progress); }, controller.signal),
  ).then(
    async () => {
      if (sourcePath) activeControllers.delete(sourcePath);
      log.info(`${spec.kind}: done in ${Date.now() - t0}ms (${path.basename(spec.derivedNote(absPath))})`);
      if (!existsSync(absPath)) {
        log.info(`${spec.kind}: source disappeared before completion, cleaning derived output for ${absPath}`);
        try { spec.cleanupDerived?.(absPath); } catch (err: unknown) {
          log.warn(`${spec.kind}: derived cleanup failed for deleted source ${absPath}: ${errorMessage(err)}`);
        }
        await settle(() => { if (sourcePath) clearRecord(sourcePath); });
        return;
      }
      if (!sameSourceSignature(startedWith, sourceSignature(absPath))) {
        log.info(`${spec.kind}: source changed before completion, cleaning stale derived output for ${absPath}`);
        try { spec.cleanupDerived?.(absPath); } catch (cleanupErr: unknown) {
          log.warn(`${spec.kind}: stale derived cleanup failed for changed source ${absPath}: ${errorMessage(cleanupErr)}`);
        }
        await settle(() => { if (sourcePath) clearRecord(sourcePath); });
        return;
      }
      // Try to index the note before flipping the status. Conversion success
      // is still defined by the derived markdown existing: semantic indexing
      // can be unavailable (no API key) or fail transiently, while the
      // extracted text remains useful for keyword search and future reindex.
      try {
        const noteAbs = spec.derivedNote(absPath);
        const indexSizeError = indexableFileSizeError(noteAbs);
        if (indexSizeError) {
          cleanupFailedOutput();
          await settle(() => { if (sourcePath) markFailed(sourcePath, `extracted text could not be indexed: ${indexSizeError}`); });
          return;
        }
        if (hasNoExtractableText(noteAbs)) {
          cleanupFailedOutput();
          await settle(() => { if (sourcePath) markFailed(sourcePath, 'extracted text is empty, so this file is not searchable'); });
          return;
        }
        if (sourcePath) setProgress(sourcePath, { phase: 'indexing' });
        await indexDerivedNote?.(absPath, noteAbs);
      } catch (err: unknown) {
        const msg = errorMessage(err);
        log.warn(`${spec.kind}: derived-note index failed for ${absPath}: ${msg}`);
      }
      await settle(() => { if (sourcePath) markDone(sourcePath); });
    },
    async (err: Error) => {
      if (sourcePath) activeControllers.delete(sourcePath);
      log.warn(`${spec.kind}: failed for ${absPath}: ${err.message}`);
      if (!existsSync(absPath)) {
        try { spec.cleanupDerived?.(absPath); } catch (cleanupErr: unknown) {
          log.warn(`${spec.kind}: derived cleanup failed for deleted source ${absPath}: ${errorMessage(cleanupErr)}`);
        }
        await settle(() => { if (sourcePath) clearRecord(sourcePath); });
        return;
      }
      if (!sameSourceSignature(startedWith, sourceSignature(absPath))) {
        await settle(() => { if (sourcePath) clearRecord(sourcePath); });
        return;
      }
      if (isTransientConversionError(err)) {
        try { (spec.cleanupBeforeConvert ?? spec.cleanupDerived)?.(absPath); } catch (cleanupErr: unknown) {
          log.warn(`${spec.kind}: transient-conversion cleanup failed for ${absPath}: ${errorMessage(cleanupErr)}`);
        }
        await settle(() => { if (sourcePath) clearRecord(sourcePath); });
        return;
      }
      try { spec.cleanupDerived?.(absPath); } catch (cleanupErr: unknown) {
        log.warn(`${spec.kind}: failed-conversion cleanup failed for ${absPath}: ${errorMessage(cleanupErr)}`);
      }
      await settle(() => { if (sourcePath) markFailed(sourcePath, err.message); });
    },
  ).finally(() => {
    if (sourcePath) activeRuns.delete(sourcePath);
  });
  if (sourcePath) activeRuns.set(sourcePath, run);
  return run;
}

/** Fire-and-forget convert used by the upload / retry routes. Skips
 *  silently if the derived note already exists (re-drop of the same
 *  source). sourcePath derives from the absolute path — no window context. */
export function maybeConvert(absPath: string, spec: ConversionSpec): Promise<void> | null {
  const sourcePath = sourcePathOf(absPath);
  if (sourcePath && isPendingOrFailed(sourcePath)) return null;
  if (derivedIsFresh(spec, absPath)) {
    log.info(`${spec.kind}: skipped ${absPath} — derived note already present and current`);
    if (sourcePath) markDone(sourcePath);
    return null;
  }
  if (!existsSync(absPath)) {
    if (sourcePath) clearRecord(sourcePath);
    return null;
  }
  return runConversion(absPath, sourcePath, spec);
}

/** Reindex an already-fresh derived note under its source path. Used when a
 *  PDF/image was converted while semantic indexing was unavailable, then a
 *  later reconcile runs after an API key has been configured. */
export async function indexFreshDerived(absPath: string, spec: ConversionSpec): Promise<boolean> {
  const sourcePath = sourcePathOf(absPath);
  if (sourcePath && isPendingOrFailed(sourcePath)) return false;
  if (!derivedIsFresh(spec, absPath)) return false;
  if (sourcePath) markDone(sourcePath);
  await indexDerivedNote?.(absPath, spec.derivedNote(absPath));
  return true;
}

/** Reconcile hook: walk `folderAbs` for convertible sources and queue any
 *  that need converting. The decision is pure disk + memory truth:
 *  derived note exists → nothing to do; conversion running or failure
 *  recorded → leave it (Retry is a human decision); otherwise queue.
 *  Idempotent across crashes — no persisted in-flight state to reclaim. */
export function discoverNewSources(
  folderAbs: string,
  spec: ConversionSpec,
  queueConversion: (absPath: string) => void = (abs) => {
    const sourcePath = sourcePathOf(abs);
    if (sourcePath == null) return;
    runConversion(abs, sourcePath, spec);
  },
): void {
  walkSources(folderAbs, '', spec, (_rel, abs) => {
    if (derivedIsFresh(spec, abs)) return;
    const sourcePath = sourcePathOf(abs);
    if (sourcePath == null || isPendingOrFailed(sourcePath)) return;
    log.info(`reconcile: queueing untracked ${spec.kind} source ${sourcePath}`);
    queueConversion(abs);
  });
}

/** Folder-relative paths of every source whose conversion is currently
 *  in-flight. Prefer passing the absolute `folderRoot` from the
 *  request/window; the ambient current-folder fallback exists for older
 *  internal callers. */
export function getInFlightConversions(folderRoot?: string): string[] {
  const out: string[] = [];
  for (const sourcePath of listInFlight()) {
    const folderRel = folderRoot ? relInFolder(sourcePath, folderRoot) : fromSourcePath(sourcePath);
    if (folderRel != null) out.push(folderRel);
  }
  out.sort();
  return out;
}

function walkSources(
  dir: string,
  prefix: string,
  spec: ConversionSpec,
  fn: (rel: string, full: string) => void,
): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (isCloudPlaceholderName(e.name)) continue;
    // Skip hidden / sidecar / git plumbing and derived `_files` bundles.
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory() && e.name.endsWith('_files')) continue;
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walkSources(full, rel, spec, fn);
    else if (e.isFile() && spec.matches(e.name)) fn(rel, full);
  }
}
