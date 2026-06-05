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
 * Everything else (status tracking, the min-visible timer, the
 * skip-if-note-present guard, the reconcile walk) is identical and lives
 * here so `pdf.ts` / `image.ts` stay thin. Conversion status is persisted
 * to `state.db` via `pdf-status.ts` (shared store) so the sidebar's
 * "Converting…" indicator and the Retry banner cover both kinds.
 */
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { hasRecord, markDone, markFailed, markInFlight } from './pdf-status.ts';
import { toKbRel } from './space.ts';
import { logger } from './log.ts';

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

/** Run a conversion fire-and-forget, persisting in-flight → done/failed
 *  to `state.db` (when a `kbRel` is known) so the UI can track it. */
function runConversion(absPath: string, kbRel: string | null, spec: ConversionSpec): void {
  log.info(`${spec.kind}: ${absPath} → ${path.basename(spec.derivedNote(absPath))} …`);
  if (kbRel) markInFlight(kbRel);
  const t0 = Date.now();
  const settle = (fn: () => void) => {
    if (!kbRel) return;
    setTimeout(fn, Math.max(0, MIN_VISIBLE_MS - (Date.now() - t0)));
  };
  spec.convert(absPath).then(
    () => {
      log.info(`${spec.kind}: done in ${Date.now() - t0}ms (${path.basename(spec.derivedNote(absPath))})`);
      settle(() => markDone(kbRel!));
    },
    (err: Error) => {
      log.warn(`${spec.kind}: failed for ${absPath}: ${err.message}`);
      settle(() => markFailed(kbRel!, err.message));
    },
  );
}

/** Fire-and-forget convert used by the upload route. Skips silently if
 *  the derived note already exists (re-drop of the same source). Runs
 *  even without a space context, just without status tracking. */
export function maybeConvert(absPath: string, spaceRelative: string, spec: ConversionSpec): void {
  if (existsSync(spec.derivedNote(absPath))) {
    log.info(`${spec.kind}: skipped ${absPath} — ${path.basename(spec.derivedNote(absPath))} already present`);
    return;
  }
  let kbRel: string | null = null;
  try {
    kbRel = toKbRel(spaceRelative);
  } catch {
    // No current space — shouldn't happen at upload time; convert anyway,
    // just skip status tracking.
    log.warn(`${spec.kind}: no space context, status tracking skipped: ${absPath}`);
  }
  runConversion(absPath, kbRel, spec);
}

/** Reconcile hook: walk `spaceAbs` for convertible sources with no status
 *  record and queue them — so files dropped in out-of-band (git checkout,
 *  external copy, `mv`) get converted on the next open of the space.
 *  Back-fills a `done` record when the sibling note already exists
 *  (converted upstream) so this doesn't re-fire every reconcile. */
export function discoverNewSources(spaceAbs: string, spec: ConversionSpec): void {
  walkSources(spaceAbs, '', spec, (rel, abs) => {
    let kbRel: string;
    try { kbRel = toKbRel(rel); } catch { return; }
    if (hasRecord(kbRel)) return;
    if (existsSync(spec.derivedNote(abs))) { markDone(kbRel); return; }
    log.info(`reconcile: queueing untracked ${spec.kind} source ${rel}`);
    runConversion(abs, kbRel, spec);
  });
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
