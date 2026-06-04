/**
 * Image → OCR-text note conversion, driven by `python/ocr_extract.py`.
 *
 * The image analogue of `pdf.ts`: whenever a `.png` / `.jpg` / `.jpeg`
 * / `.webp` lands in a space (drag-in, clipboard paste, in-app capture)
 * we spawn RapidOCR in the background. It writes `.<stem>.md` alongside
 * the image, then the fs.watch debounce picks it up and the indexer
 * embeds the note — so a screenshot's text becomes searchable. The
 * image itself stays on disk as the user-facing file.
 *
 * Unlike PDFs there is no image bundle (`.<stem>_files/`) — OCR yields
 * only text. The single derived note is dot-prefixed for the same
 * reason PDF notes are (app-maintained artifact, hidden in the sidebar
 * via `files.ts walk()`'s sibling-bound rule, but still indexed).
 *
 * Conversion status reuses the same `state.db`-backed store as PDFs
 * (`pdf-status.ts`, keyed by path) so the "Converting…" indicator and
 * the in-flight list cover images for free.
 */
import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { isImageFile } from './format.ts';
import { logger } from './log.ts';
import { hasRecord, markDone, markFailed, markInFlight } from './pdf-status.ts';
import { pythonBin, pythonScript } from './python-host.ts';
import { toKbRel } from './space.ts';

const log = logger('image');

function extractorScript(): string {
  return pythonScript('ocr_extract.py');
}

/** Dot-prefixed derived note path (`.<stem>.md`) for an image — same
 *  hidden-sibling layout PDFs use, minus the image bundle. */
export function derivedNotePathForImage(imageAbsPath: string): string {
  const dir = path.dirname(imageAbsPath);
  const stem = path.basename(imageAbsPath, path.extname(imageAbsPath));
  return path.join(dir, `.${stem}.md`);
}

/** Run the OCR extractor on a single image. Resolves with the note path
 *  on success; rejects with the extractor's stderr tail on failure.
 *  Does not throw synchronously — fire-and-forget at the call site. */
export function convertImage(imageAbsPath: string): Promise<{ notePath: string }> {
  const notePath = derivedNotePathForImage(imageAbsPath);
  return new Promise((resolve, reject) => {
    const proc = spawn(
      pythonBin(),
      [extractorScript(), imageAbsPath, notePath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += String(b); });
    proc.on('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve({ notePath });
      } else {
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        reject(new Error(`ocr_extract exit ${code}: ${tail || '(no stderr)'}`));
      }
    });
  });
}

/** Fire-and-forget wrapper used by the upload route. Skips silently if
 *  the target note already exists (re-drop of the same image). Persists
 *  the outcome to `state.db` (shared with PDFs) so the UI can surface
 *  in-flight / failed status. `spaceRelative` is the path shape the rest
 *  of the API uses. */
export function maybeConvertImage(imageAbsPath: string, spaceRelative: string): void {
  const notePath = derivedNotePathForImage(imageAbsPath);
  if (existsSync(notePath)) {
    log.info(`skipped ${imageAbsPath} — ${path.basename(notePath)} already present`);
    return;
  }
  let kbRel: string | null = null;
  try {
    kbRel = toKbRel(spaceRelative);
  } catch {
    log.warn(`OCR without space context, status tracking skipped: ${imageAbsPath}`);
  }
  runConvert(imageAbsPath, kbRel);
}

/** Recursively walk `spaceAbs` for image files with no status record and
 *  OCR them. Called from reconcile so images added out-of-band (git
 *  checkout, external copy, `mv`) get OCR'd on the next open of the
 *  space — without re-attempting any image that already has a record or
 *  whose sibling note is already on disk. Mirrors `discoverNewPdfs`. */
export function discoverNewImages(spaceAbs: string): void {
  walkImages(spaceAbs, '', (rel, abs) => {
    let kbRel: string;
    try { kbRel = toKbRel(rel); }
    catch { return; }
    if (hasRecord(kbRel)) return;
    if (existsSync(derivedNotePathForImage(abs))) {
      markDone(kbRel);
      return;
    }
    log.info(`reconcile: queueing untracked image ${rel}`);
    runConvert(abs, kbRel);
  });
}

function walkImages(dir: string, prefix: string, fn: (rel: string, full: string) => void): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory() && e.name.endsWith('_files')) continue;
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walkImages(full, rel, fn);
    } else if (e.isFile() && isImageFile(e.name)) {
      fn(rel, full);
    }
  }
}

function runConvert(imageAbsPath: string, kbRel: string | null): void {
  const notePath = derivedNotePathForImage(imageAbsPath);
  log.info(`OCR ${imageAbsPath} → ${path.basename(notePath)} …`);
  if (kbRel) markInFlight(kbRel);
  const t0 = Date.now();
  // Keep the in-flight indicator visible long enough for a 500ms-poll
  // client to catch even a sub-second OCR run (mirrors pdf.ts).
  const MIN_VISIBLE_MS = 800;
  convertImage(imageAbsPath).then(
    () => {
      log.info(`OCR'd in ${Date.now() - t0}ms: ${path.basename(notePath)}`);
      if (kbRel) {
        const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - t0));
        setTimeout(() => markDone(kbRel), wait);
      }
    },
    (err: Error) => {
      log.warn(`OCR failed for ${imageAbsPath}: ${err.message}`);
      if (kbRel) {
        const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - t0));
        setTimeout(() => markFailed(kbRel, err.message), wait);
      }
    },
  );
}
