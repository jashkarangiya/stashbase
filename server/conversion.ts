/**
 * Shared "unstructured source → extracted structured markdown" plumbing
 * for the two unstructured formats: PDFs (`pdf_extract.py`) and images
 * (`ocr_extract.py`). Each extracts the file's structured content into a
 * hidden derived `.<sourceBasename>.md` that becomes the single source of
 * truth for that file's indexed content (the binary stays only for
 * viewing). Materialized to disk — unlike HTML's in-memory transform —
 * because these conversions are expensive (subprocess) and worth caching.
 *
 * The two formats differ in only three things — captured by a
 * `ConversionSpec`:
 *   - `matches`     which filenames are convertible sources
 *   - `derivedNote` the dot-prefixed `.<sourceBasename>.md` a source maps to
 *   - `convert`     the actual extractor spawn (PDF emits an extra bundle)
 *
 * Context-free by design: every kbRel is derived from the absolute path
 * against kbRoot — never from the ambient window context — so discovery
 * and conversion behave identically from the GUI, a headless server, or
 * an `update_index` on a space no window has open.
 *
 * On success the derived note is pushed into the index DIRECTLY (via the
 * hook `setDerivedNoteIndexer` wires at boot) — there is no fs-watcher
 * intermediary. Failures persist for the Retry banner; in-flight state is
 * process memory (see `conversion-status.ts`).
 */
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { isPendingOrFailed, listInFlight, markDone, markFailed, markInFlight } from './conversion-status.ts';
import { clearRecord } from './conversion-status.ts';
import { fromKbRel, getKbRoot } from './space.ts';
import { logger, errorMessage } from './log.ts';

const log = logger('conversion');

// Keep the in-flight indicator visible long enough for a 500ms-poll
// client to catch even a sub-second run.
const MIN_VISIBLE_MS = 800;

export interface ConversionSpec {
  /** Short label for logs, e.g. `pdf_extract` / `ocr_extract`. */
  kind: string;
  /** Does this filename look like a convertible source (`.pdf`, image)? */
  matches: (name: string) => boolean;
  /** The dot-prefixed `.<sourceBasename>.md` derived-note path for a source file. */
  derivedNote: (absPath: string) => string;
  /** Run the extractor; resolve on success, reject with the stderr tail. */
  convert: (absPath: string) => Promise<unknown>;
}

/** Wired at boot (`server/index.ts`): push a freshly written derived
 *  note into the index. Injected to avoid a module cycle with
 *  `state.ts` — conversion is below the indexer in the import graph. */
let indexDerivedNote: ((noteAbs: string) => Promise<void>) | null = null;
export function setDerivedNoteIndexer(fn: (noteAbs: string) => Promise<void>): void {
  indexDerivedNote = fn;
}

/** kbRoot-relative path for an absolute path inside the KB, or null when
 *  outside (shouldn't happen for conversion sources). */
function kbRelOf(absPath: string): string | null {
  const rel = path.relative(getKbRoot(), absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Run a conversion fire-and-forget, tracking in-flight in memory and
 *  persisting failures so the UI can offer Retry. On success the derived
 *  note goes straight into the index — no watcher round-trip. */
function runConversion(absPath: string, kbRel: string | null, spec: ConversionSpec): void {
  log.info(`${spec.kind}: ${absPath} → ${path.basename(spec.derivedNote(absPath))} …`);
  if (kbRel) markInFlight(kbRel);
  const t0 = Date.now();
  // Defer the terminal status write so a 500ms-poll client catches even
  // a sub-second conversion's "Converting…" state.
  const settle = (fn: () => void) => {
    if (!kbRel) { fn(); return; }
    setTimeout(fn, Math.max(0, MIN_VISIBLE_MS - (Date.now() - t0)));
  };
  spec.convert(absPath).then(
    async () => {
      log.info(`${spec.kind}: done in ${Date.now() - t0}ms (${path.basename(spec.derivedNote(absPath))})`);
      // Index the note before flipping the status — when "Converting…"
      // clears, the content is already searchable.
      try {
        await indexDerivedNote?.(spec.derivedNote(absPath));
      } catch (err: unknown) {
        log.warn(`${spec.kind}: derived-note index failed for ${absPath}: ${errorMessage(err)} (reconcile will pick it up)`);
      }
      settle(() => { if (kbRel) markDone(kbRel); });
    },
    (err: Error) => {
      log.warn(`${spec.kind}: failed for ${absPath}: ${err.message}`);
      settle(() => { if (kbRel) markFailed(kbRel, err.message); });
    },
  );
}

/** Run an arbitrary background job under the same in-flight tracking the
 *  file converters use, keyed to `kbRel` so it surfaces in the sidebar's
 *  "Converting…" banner (`getInFlightConversions`). Used by the recording
 *  pipeline. On failure we `clearRecord` rather than `markFailed`: the
 *  recording flow writes its own error note and has no Retry semantics. */
export function runBackgroundConversion(kbRel: string, work: () => Promise<void>): Promise<void> {
  markInFlight(kbRel);
  const t0 = Date.now();
  const settle = (fn: () => void) => {
    setTimeout(fn, Math.max(0, MIN_VISIBLE_MS - (Date.now() - t0)));
  };
  return work().then(
    () => { settle(() => markDone(kbRel)); },
    (err: Error) => {
      log.warn(`background conversion failed for ${kbRel}: ${err.message}`);
      settle(() => clearRecord(kbRel));
    },
  );
}

/** Fire-and-forget convert used by the upload / retry routes. Skips
 *  silently if the derived note already exists (re-drop of the same
 *  source). kbRel derives from the absolute path — no window context. */
export function maybeConvert(absPath: string, spec: ConversionSpec): void {
  if (existsSync(spec.derivedNote(absPath))) {
    log.info(`${spec.kind}: skipped ${absPath} — ${path.basename(spec.derivedNote(absPath))} already present`);
    return;
  }
  runConversion(absPath, kbRelOf(absPath), spec);
}

/** Reconcile hook: walk `spaceAbs` for convertible sources and queue any
 *  that need converting. The decision is pure disk + memory truth:
 *  derived note exists → nothing to do; conversion running or failure
 *  recorded → leave it (Retry is a human decision); otherwise queue.
 *  Idempotent across crashes — no persisted in-flight state to reclaim. */
export function discoverNewSources(spaceAbs: string, spec: ConversionSpec): void {
  walkSources(spaceAbs, '', spec, (_rel, abs) => {
    if (existsSync(spec.derivedNote(abs))) return;
    const kbRel = kbRelOf(abs);
    if (kbRel == null || isPendingOrFailed(kbRel)) return;
    log.info(`reconcile: queueing untracked ${spec.kind} source ${kbRel}`);
    runConversion(abs, kbRel, spec);
  });
}

/** Space-relative paths of every source whose conversion is currently
 *  in-flight, scoped to the current window's space — this is a UI view,
 *  so the ambient window context is the right scope here. */
export function getInFlightConversions(): string[] {
  const out: string[] = [];
  for (const kbRel of listInFlight()) {
    const spaceRel = fromKbRel(kbRel);
    if (spaceRel != null) out.push(spaceRel);
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
    // Skip hidden / sidecar / git plumbing and derived `_files` bundles.
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory() && e.name.endsWith('_files')) continue;
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) walkSources(full, rel, spec, fn);
    else if (e.isFile() && spec.matches(e.name)) fn(rel, full);
  }
}
