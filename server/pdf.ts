/**
 * PDF → note-with-bundle conversion, driven by `python/pdf_extract.py`.
 *
 * Wired from the upload route: whenever a `.pdf` lands in a space we
 * spawn the extractor in the background. It writes `<stem>.html`
 * (default) and `<stem>_files/` alongside the PDF, then the fs.watch
 * debounce picks them up and the indexer embeds the new note. The
 * PDF stays on disk as a sibling — not indexed, not previewable from
 * sidebar, but kept so the user can verify against the source.
 *
 * Format / converter knobs (set on the server process, no per-space
 * config yet):
 *   - `STASHBASE_PDF_FORMAT`     html | md   (default html)
 *   - `STASHBASE_PDF_CONVERTER`  pymupdf | marker  (default pymupdf)
 *
 * `marker` needs a separate `pip install marker-pdf` inside the same
 * venv — see `python/pdf_extract.py` for why.
 */
import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './log.ts';
import {
  hasRecord,
  listByStatus,
  markDone,
  markFailed,
  markInFlight,
} from './pdf-status.ts';
import { fromKbRel, toKbRel } from './space.ts';

const log = logger('pdf');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(__dirname, '..');
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : PROJECT_ROOT;

function pythonBin(): string {
  if (process.env.STASHBASE_PYTHON) return process.env.STASHBASE_PYTHON;
  for (const candidate of [
    path.join(RESOURCES_ROOT, 'python', 'runtime', 'bin', 'python'),
    path.join(RESOURCES_ROOT, 'python', '.venv', 'bin', 'python'),
    path.join(PROJECT_ROOT, 'python', '.venv', 'bin', 'python'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'python3';
}

function extractorScript(): string {
  return path.join(PROJECT_ROOT, 'python', 'pdf_extract.py');
}

export interface ConvertResult {
  /** Absolute path of the written `<stem>.{md,html}`. */
  notePath: string;
  /** Absolute path of the `<stem>_files/` bundle. */
  bundleDir: string;
  /** Resolved output format — needed by the caller to pick the right
   *  re-index step. */
  format: 'md' | 'html';
}

/** Run the extractor on a single PDF. Resolves with paths on success;
 *  rejects with the extractor's stderr tail on failure. Fire-and-
 *  forget at the call site if you don't want to block — `convertPdf`
 *  itself does not throw synchronously. */
export function convertPdf(pdfAbsPath: string): Promise<ConvertResult> {
  const fmt = (process.env.STASHBASE_PDF_FORMAT === 'md' ? 'md' : 'html') as 'md' | 'html';
  const dir = path.dirname(pdfAbsPath);
  const stem = path.basename(pdfAbsPath, path.extname(pdfAbsPath));
  const notePath = path.join(dir, `${stem}.${fmt}`);
  const bundleDir = path.join(dir, `${stem}_files`);
  const converter = process.env.STASHBASE_PDF_CONVERTER === 'marker' ? 'marker' : 'pymupdf';

  return new Promise((resolve, reject) => {
    const proc = spawn(
      pythonBin(),
      [extractorScript(), pdfAbsPath, notePath, bundleDir, '--converter', converter, '--format', fmt],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += String(b); });
    proc.on('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve({ notePath, bundleDir, format: fmt });
      } else {
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        reject(new Error(`pdf_extract exit ${code}: ${tail || '(no stderr)'}`));
      }
    });
  });
}

/** Space-relative paths of PDFs whose conversion is currently in
 *  progress, scoped to the current space. The /api/index-status route
 *  reads this so the sidebar can render a "Converting…" indicator
 *  and auto-reload once the entry disappears (= the new note has
 *  landed on disk).
 *
 *  Backed by `<KB>/.stashbase/pdf-status.json` (KB-wide) — we filter
 *  to the current space here so the sidebar's space-relative view
 *  stays correct. */
export function getInFlightPdfs(): string[] {
  const out: string[] = [];
  for (const { path: kbRel } of listByStatus('in-flight')) {
    const spaceRel = fromKbRel(kbRel);
    if (spaceRel != null) out.push(spaceRel);
  }
  out.sort();
  return out;
}

/** Fire-and-forget wrapper used by the upload route. Skips silently
 *  if the target note already exists (re-drop of the same PDF). On
 *  success / failure persists the outcome to `pdf-status.json` so
 *  the UI can surface "Conversion failed" + a Retry button, even
 *  after app restart. `spaceRelative` is what we expose to clients
 *  via the in-flight list — same path shape the rest of the API
 *  uses. */
export function maybeConvertPdf(pdfAbsPath: string, spaceRelative: string): void {
  const fmt = process.env.STASHBASE_PDF_FORMAT === 'md' ? 'md' : 'html';
  const dir = path.dirname(pdfAbsPath);
  const stem = path.basename(pdfAbsPath, path.extname(pdfAbsPath));
  const existing = path.join(dir, `${stem}.${fmt}`);
  if (existsSync(existing)) {
    log.info(`skipped ${pdfAbsPath} — ${path.basename(existing)} already present`);
    return;
  }
  let kbRel: string;
  try {
    kbRel = toKbRel(spaceRelative);
  } catch {
    // No current space — shouldn't happen at upload time, but if it
    // does we still run the conversion; just skip status tracking.
    log.warn(`conversion without space context, status tracking skipped: ${pdfAbsPath}`);
    runConvert(pdfAbsPath, null);
    return;
  }
  runConvert(pdfAbsPath, kbRel);
}

/** Recursively walk `spaceAbs` for `.pdf` files that have no status
 *  record yet and queue them for conversion. Called from reconcile so
 *  that PDFs dropped in via git checkout / external copy / `mv` from
 *  outside StashBase still get auto-converted on the next open of the
 *  space — without re-attempting any PDF that's already succeeded,
 *  failed, or was cancelled (those have a record, so we skip).
 *
 *  Also "back-fills" a `done` record for PDFs whose sibling note already
 *  exists on disk (e.g. cloned from a repo where conversion was done
 *  upstream). That keeps the JSON map in sync with reality and prevents
 *  this discovery from re-firing on every reconcile. */
export function discoverNewPdfs(spaceAbs: string): void {
  const fmt = process.env.STASHBASE_PDF_FORMAT === 'md' ? 'md' : 'html';
  walkPdfs(spaceAbs, '', (rel, abs) => {
    let kbRel: string;
    try { kbRel = toKbRel(rel); }
    catch { return; }
    if (hasRecord(kbRel)) return;
    const stem = path.basename(abs, path.extname(abs));
    const sibling = path.join(path.dirname(abs), `${stem}.${fmt}`);
    if (existsSync(sibling)) {
      // Already converted upstream — record it so we don't keep
      // re-checking on every reconcile.
      markDone(kbRel);
      return;
    }
    log.info(`reconcile: queueing untracked PDF ${rel}`);
    runConvert(abs, kbRel);
  });
}

function walkPdfs(dir: string, prefix: string, fn: (rel: string, full: string) => void): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    // Skip hidden / sidecar / git plumbing / bundle dirs.
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory() && e.name.endsWith('_files')) continue;
    const full = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walkPdfs(full, rel, fn);
    } else if (e.isFile() && /\.pdf$/i.test(e.name)) {
      fn(rel, full);
    }
  }
}

function runConvert(pdfAbsPath: string, kbRel: string | null): void {
  const targetName = (() => {
    const fmt = process.env.STASHBASE_PDF_FORMAT === 'md' ? 'md' : 'html';
    return `${path.basename(pdfAbsPath, path.extname(pdfAbsPath))}.${fmt}`;
  })();
  log.info(`converting ${pdfAbsPath} → ${targetName} …`);
  if (kbRel) markInFlight(kbRel);
  const t0 = Date.now();
  // MIN_VISIBLE_MS keeps the in-flight indicator visible long enough
  // for a 500ms-poll client to pick it up even on sub-second pymupdf
  // runs.
  const MIN_VISIBLE_MS = 800;
  convertPdf(pdfAbsPath).then(
    (res) => {
      log.info(
        `converted in ${Date.now() - t0}ms: ` +
          `${path.basename(res.notePath)} + ${path.basename(res.bundleDir)}/`,
      );
      if (kbRel) {
        const elapsed = Date.now() - t0;
        const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
        setTimeout(() => markDone(kbRel), wait);
      }
    },
    (err: Error) => {
      log.warn(`conversion failed for ${pdfAbsPath}: ${err.message}`);
      if (kbRel) {
        const elapsed = Date.now() - t0;
        const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
        setTimeout(() => markFailed(kbRel, err.message), wait);
      }
    },
  );
}
