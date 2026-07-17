/**
 * Shared "unstructured source → extracted structured text" plumbing for
 * PDFs (`pdf_extract.py`), images (`ocr_extract.py`), and DOCX (`mammoth`).
 * Each extracts the file's useful text into an AppData-derived representation
 * that becomes the text layer for search. PDFs/DOCX also use that layer for
 * Agent text reading. Materialized to disk — unlike HTML's in-memory transform
 * — because these conversions are expensive and worth caching.
 *
 * The two formats differ in only three things — captured by a
 * `ConversionSpec`:
 *   - `matches`     which filenames are convertible sources
 *   - `derivedNote` the AppData derived-text path a source maps to
 *   - `convert`     the actual extractor spawn (PDF emits an extra bundle)
 *
 * Context-free by design: every sourcePath is the source file's absolute path,
 * never derived from ambient window context, so discovery
 * and conversion behave identically from the GUI, a headless server, or
 * a `reindex` on a folder no window has open.
 *
 * On success the derived text is pushed into the index DIRECTLY (via the
 * hook `setDerivedNoteIndexer` wires at boot) — there is no fs-watcher
 * intermediary. Failures persist for reprocess affordances; in-flight
 * state is process memory (see `conversion-status.ts`).
 */
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { isPendingOrFailed, markDone, markFailed, markInFlight, setProgress, type ConversionProgress } from './conversion-status.ts';
import { clearRecord } from './conversion-status.ts';
import { fromSourcePath, getActiveFolders, memberRootForAbs, onClose, onSwitch, relInFolder, toPosixAbs } from './folder.ts';
import { logger, errorMessage } from './log.ts';
import { isCloudPlaceholderName } from './indexable.ts';
import { hasNoExtractableText, indexableFileSizeError } from './indexable.ts';
import { registerDerivedSource } from './derived-store.ts';
import {
  ConversionScheduler,
  type ConversionCancellationReason,
  type ConversionLane,
  type ConversionSchedulerSnapshot,
  type ConversionUrgency,
  type ScheduledConversion,
} from './conversion-scheduler.ts';

const log = logger('conversion');

interface SourceSignature {
  size: number;
  mtimeMs: number;
}

export interface ConversionSpec {
  /** Short label for logs, e.g. `pdf_extract` / `ocr_extract`. */
  kind: string;
  /** Resource lane. DOCX is light; subprocess PDF/OCR work is heavy. */
  lane: ConversionLane;
  /** Initial relative cost within one urgency tier. Lower runs first. */
  cost: number;
  /** Optional scheduler-owned, bounded preflight that refines relative cost. */
  classifyCost?: (absPath: string, signal: AbortSignal) => Promise<number>;
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
  /** Best-effort final-output invalidation before enqueue and again before
   *  execution. Defaults to cleanupDerived. PDF keeps resumable batch scratch
   *  while deleting stale final artifacts. */
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

/** Wired at boot (`server/index.ts`): index a freshly written derived text
 *  UNDER its source path (the derived representation lives in app data; the
 *  source PDF/image/DOCX is the indexed entity). Injected to avoid a module
 *  cycle with `state.ts` — conversion is below the indexer in the import
 *  graph. */
let indexDerivedNote: ((sourceAbs: string, derivedAbs: string) => Promise<void>) | null = null;
export function setDerivedNoteIndexer(fn: (sourceAbs: string, derivedAbs: string) => Promise<void>): void {
  indexDerivedNote = fn;
}

/** True when a source's derived text exists AND is at least as new as the
 *  source (i.e. not stale). A changed source has a newer mtime than its
 *  old derived text → re-convert. This is the change-detection signal now
 *  that the derived text lives in app data (path-hash keyed, so its
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

function isSourceInActiveFolder(sourcePath: string): boolean {
  for (const { windowId, path: folderRoot } of getActiveFolders()) {
    // `runWithFolderRoot` creates short-lived internal bindings for MCP and
    // cross-folder operations. They are execution context, not user windows.
    if (windowId.startsWith('__folder:')) continue;
    if (relInFolder(sourcePath, folderRoot) != null) return true;
  }
  return false;
}

const scheduler = new ConversionScheduler({
  laneCapacity: { light: 2, heavy: 1 },
  classifierCapacity: 4,
  ageingMs: 60_000,
  isActive: isSourceInActiveFolder,
});

onSwitch(() => scheduler.prioritiesChanged());
onClose(() => scheduler.prioritiesChanged());

export function cancelConversion(sourcePath: string): boolean {
  return scheduler.cancel(toPosixAbs(sourcePath), 'source-change') != null;
}

export async function cancelAllConversions(timeoutMs = 2500): Promise<string[]> {
  const cancelled = scheduler.cancelAll('shutdown');
  const sourcePaths = cancelled.map((item) => item.key);
  if (cancelled.length === 0) return [];
  await Promise.race([
    Promise.allSettled(cancelled.map((item) => item.completion)),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return sourcePaths;
}

export async function cancelConversionsUnder(sourcePathPrefix: string, timeoutMs = 2500): Promise<string[]> {
  const cancelled = scheduler.cancelUnder(toPosixAbs(sourcePathPrefix), 'folder-removed');
  const sourcePaths = cancelled.map((item) => item.key);
  if (cancelled.length === 0) return [];
  await Promise.race([
    Promise.allSettled(cancelled.map((item) => item.completion)),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return sourcePaths;
}

export function isConversionPending(sourcePath: string): boolean {
  return scheduler.has(toPosixAbs(sourcePath));
}

/** True when derived text must not be served as current: queued/running work
 *  or a durable preparation failure owns the source. */
export function isConversionTextUnavailable(sourcePath: string): boolean {
  const key = toPosixAbs(sourcePath);
  return scheduler.has(key) || isPendingOrFailed(key);
}

export function hasConversionsUnder(sourcePathPrefix: string): boolean {
  return scheduler.hasUnder(toPosixAbs(sourcePathPrefix));
}

export function hasRunningConversionsUnder(sourcePathPrefix: string): boolean {
  return scheduler.hasRunningUnder(toPosixAbs(sourcePathPrefix));
}

export function getConversionSchedulerSnapshot(): ConversionSchedulerSnapshot {
  return scheduler.snapshot();
}

export function getScheduledConversion(sourcePath: string): ScheduledConversion | null {
  return scheduler.get(toPosixAbs(sourcePath));
}

export function promoteConversion(sourcePath: string, urgency: ConversionUrgency): boolean {
  return scheduler.promote(toPosixAbs(sourcePath), urgency);
}

/** Absolute POSIX identity for a source path — the conversion-status key,
 *  matching what `toSourcePath` produces and what the daemon stores. */
function sourcePathOf(absPath: string): string {
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

type ConversionOutcome = 'settled' | 'rediscover';

/** Execute one task after the scheduler grants its lane a slot. */
async function executeConversion(
  absPath: string,
  sourcePath: string,
  spec: ConversionSpec,
  signal: AbortSignal,
): Promise<ConversionOutcome> {
  markInFlight(sourcePath);
  const startedWith = sourceSignature(absPath);
  const t0 = Date.now();
  log.info(`${spec.kind}: running ${absPath} → ${path.basename(spec.derivedNote(absPath))} …`);
  try { (spec.cleanupBeforeConvert ?? spec.cleanupDerived)?.(absPath); } catch (err: unknown) {
    log.warn(`${spec.kind}: preflight cleanup failed for ${absPath}: ${errorMessage(err)}`);
  }
  const cleanupFailedOutput = () => {
    try { (spec.cleanupBeforeConvert ?? spec.cleanupDerived)?.(absPath); } catch (cleanupErr: unknown) {
      log.warn(`${spec.kind}: failed-output cleanup failed for ${absPath}: ${errorMessage(cleanupErr)}`);
    }
  };
  try {
    await spec.convert(absPath, (progress) => setProgress(sourcePath, progress), signal);
    if (signal.aborted) throw new TransientConversionError(`${spec.kind} cancelled`);
    log.info(`${spec.kind}: done in ${Date.now() - t0}ms (${path.basename(spec.derivedNote(absPath))})`);
    if (!existsSync(absPath)) {
      log.info(`${spec.kind}: source disappeared before completion, cleaning derived output for ${absPath}`);
      try { spec.cleanupDerived?.(absPath); } catch (err: unknown) {
        log.warn(`${spec.kind}: derived cleanup failed for deleted source ${absPath}: ${errorMessage(err)}`);
      }
      clearRecord(sourcePath);
      return 'settled';
    }
    if (!sameSourceSignature(startedWith, sourceSignature(absPath))) {
      log.info(`${spec.kind}: source changed before completion, cleaning stale derived output for ${absPath}`);
      try { spec.cleanupDerived?.(absPath); } catch (cleanupErr: unknown) {
        log.warn(`${spec.kind}: stale derived cleanup failed for changed source ${absPath}: ${errorMessage(cleanupErr)}`);
      }
      clearRecord(sourcePath);
      return 'rediscover';
    }
    // Try to index the derived text before flipping the status. Conversion
    // success is still defined by the derived text existing: semantic indexing
    // can be unavailable or fail transiently while extracted text remains useful.
    try {
      const noteAbs = spec.derivedNote(absPath);
      const indexSizeError = indexableFileSizeError(noteAbs);
      if (indexSizeError) {
        cleanupFailedOutput();
        markFailed(sourcePath, `extracted text could not be indexed: ${indexSizeError}`);
        return 'settled';
      }
      if (hasNoExtractableText(noteAbs)) {
        cleanupFailedOutput();
        markFailed(sourcePath, 'extracted text is empty, so this file is not searchable');
        return 'settled';
      }
      setProgress(sourcePath, { phase: 'indexing' });
      await indexDerivedNote?.(absPath, noteAbs);
    } catch (err: unknown) {
      const msg = errorMessage(err);
      log.warn(`${spec.kind}: derived-text index failed for ${absPath}: ${msg}`);
    }
    if (signal.aborted) throw new TransientConversionError(`${spec.kind} cancelled`);
    if (!existsSync(absPath)) {
      try { spec.cleanupDerived?.(absPath); } catch (cleanupErr: unknown) {
        log.warn(`${spec.kind}: derived cleanup failed for deleted source ${absPath}: ${errorMessage(cleanupErr)}`);
      }
      clearRecord(sourcePath);
      return 'settled';
    }
    if (!sameSourceSignature(startedWith, sourceSignature(absPath))) {
      log.info(`${spec.kind}: source changed during indexing, retiring stale output for ${absPath}`);
      try { spec.cleanupDerived?.(absPath); } catch (cleanupErr: unknown) {
        log.warn(`${spec.kind}: stale derived cleanup failed for changed source ${absPath}: ${errorMessage(cleanupErr)}`);
      }
      clearRecord(sourcePath);
      return 'rediscover';
    }
    markDone(sourcePath);
    return 'settled';
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn(`${spec.kind}: failed for ${absPath}: ${error.message}`);
    if (!existsSync(absPath)) {
      try { spec.cleanupDerived?.(absPath); } catch (cleanupErr: unknown) {
        log.warn(`${spec.kind}: derived cleanup failed for deleted source ${absPath}: ${errorMessage(cleanupErr)}`);
      }
      clearRecord(sourcePath);
      return 'settled';
    }
    if (signal.aborted) {
      try { (spec.cleanupBeforeConvert ?? spec.cleanupDerived)?.(absPath); } catch (cleanupErr: unknown) {
        log.warn(`${spec.kind}: cancelled-conversion cleanup failed for ${absPath}: ${errorMessage(cleanupErr)}`);
      }
      clearRecord(sourcePath);
      const reason = signal.reason as ConversionCancellationReason | undefined;
      return reason === 'folder-removed' || reason === 'source-change' ? 'rediscover' : 'settled';
    }
    if (!sameSourceSignature(startedWith, sourceSignature(absPath))) {
      clearRecord(sourcePath);
      return 'rediscover';
    }
    if (isTransientConversionError(error)) {
      try { (spec.cleanupBeforeConvert ?? spec.cleanupDerived)?.(absPath); } catch (cleanupErr: unknown) {
        log.warn(`${spec.kind}: transient-conversion cleanup failed for ${absPath}: ${errorMessage(cleanupErr)}`);
      }
      clearRecord(sourcePath);
      return 'settled';
    }
    try { spec.cleanupDerived?.(absPath); } catch (cleanupErr: unknown) {
      log.warn(`${spec.kind}: failed-conversion cleanup failed for ${absPath}: ${errorMessage(cleanupErr)}`);
    }
    markFailed(sourcePath, error.message);
    return 'settled';
  }
}

/** Queue a conversion; the scheduler owns lane capacity and priority. */
function runConversion(
  absPath: string,
  sourcePath: string,
  spec: ConversionSpec,
  urgency: ConversionUrgency,
  cost: number,
): Promise<void> {
  registerDerivedSource(absPath);
  let rediscoverAfterFinish = false;
  const scheduled = scheduler.schedule({
    key: sourcePath,
    lane: spec.lane,
    urgency,
    cost,
    classifyCost: spec.classifyCost
      ? (signal) => spec.classifyCost!(absPath, signal)
      : undefined,
    run: async (signal) => {
      const outcome = await executeConversion(absPath, sourcePath, spec, signal);
      rediscoverAfterFinish = outcome === 'rediscover';
    },
    onSettled: () => {
      if (!rediscoverAfterFinish) return;
      // Folder removal and source replacement both retire the old task first.
      // Re-check membership and disk state before safely enqueueing the current
      // source; delete/rename and permanently removed folders stay retired.
      if (!existsSync(absPath) || memberRootForAbs(sourcePath) == null) return;
      maybeConvert(absPath, spec, { urgency: 'background', cost: spec.cost });
    },
  });
  if (scheduled.created) {
    try { (spec.cleanupBeforeConvert ?? spec.cleanupDerived)?.(absPath); } catch (err: unknown) {
      log.warn(`${spec.kind}: enqueue cleanup failed for ${absPath}: ${errorMessage(err)}`);
    }
    log.info(`${spec.kind}: queued ${absPath} → ${path.basename(spec.derivedNote(absPath))}`);
  }
  return scheduled.completion;
}

/** Fire-and-forget convert used by the upload / retry routes. Skips
 *  silently if the derived note already exists (re-drop of the same
 *  source). sourcePath derives from the absolute path — no window context. */
export function maybeConvert(
  absPath: string,
  spec: ConversionSpec,
  options: { urgency?: ConversionUrgency; cost?: number } = {},
): Promise<void> | null {
  const sourcePath = sourcePathOf(absPath);
  if (scheduler.has(sourcePath)) {
    return runConversion(
      absPath,
      sourcePath,
      spec,
      options.urgency ?? 'background',
      options.cost ?? spec.cost,
    );
  }
  if (isPendingOrFailed(sourcePath)) return null;
  if (derivedIsFresh(spec, absPath)) {
    log.info(`${spec.kind}: skipped ${absPath} — derived note already present and current`);
    markDone(sourcePath);
    return null;
  }
  if (!existsSync(absPath)) {
    clearRecord(sourcePath);
    return null;
  }
  return runConversion(
    absPath,
    sourcePath,
    spec,
    options.urgency ?? 'background',
    options.cost ?? spec.cost,
  );
}

/** Reindex an already-fresh derived note under its source path. Used when a
 *  PDF/image/DOCX was converted while semantic indexing was unavailable, then a
 *  later reconcile runs after an API key has been configured. */
export async function indexFreshDerived(absPath: string, spec: ConversionSpec): Promise<boolean> {
  const sourcePath = sourcePathOf(absPath);
  if (isPendingOrFailed(sourcePath) || scheduler.has(sourcePath)) return false;
  if (!derivedIsFresh(spec, absPath)) return false;
  markDone(sourcePath);
  await indexDerivedNote?.(absPath, spec.derivedNote(absPath));
  return true;
}

/** Reconcile hook: walk `folderAbs` for convertible sources and queue any
 *  that need converting. The decision is pure disk + memory truth:
 *  fresh derived text exists → nothing to do; conversion running or failure
 *  recorded → leave it (Retry is a human decision); otherwise queue.
 *  Idempotent across crashes — no persisted in-flight state to reclaim. */
export function discoverNewSources(
  folderAbs: string,
  spec: ConversionSpec,
  queueConversion: (absPath: string) => void = (abs) => {
    const sourcePath = sourcePathOf(abs);
    runConversion(abs, sourcePath, spec, 'background', spec.cost);
  },
): void {
  walkSources(folderAbs, '', spec, (_rel, abs) => {
    if (derivedIsFresh(spec, abs)) return;
    const sourcePath = sourcePathOf(abs);
    if (isPendingOrFailed(sourcePath) || scheduler.has(sourcePath)) return;
    log.info(`reconcile: queueing untracked ${spec.kind} source ${sourcePath}`);
    queueConversion(abs);
  });
}

/** Folder-relative paths of every queued or running conversion. */
export function getInFlightConversions(folderRoot?: string): string[] {
  const out: string[] = [];
  for (const { key: sourcePath } of scheduler.snapshot().tasks) {
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
