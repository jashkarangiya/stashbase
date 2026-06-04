/**
 * PDF → markdown-with-bundle conversion, driven by `python/pdf_extract.py`.
 *
 * Wired from the upload route: whenever a `.pdf` lands in a space we
 * spawn the extractor in the background. It writes `.<stem>.md` and
 * `.<stem>_files/` alongside the PDF, then the fs.watch debounce picks
 * them up and the indexer embeds the new note. Both the derived note
 * and its bundle are dot-prefixed — they're app-maintained artifacts,
 * not user content, so they sit alongside `.stashbase/` / `.claude/`
 * in our "dot-prefix = system, no-prefix = user" convention. The PDF
 * itself stays on disk as a regular file — the user-facing copy.
 *
 * Hidden in the sidebar via `files.ts walk()`'s sibling-bound hide
 * rule (a `paper.pdf` next to `.paper.md` collapses the derived files
 * into the PDF row), but the indexer still picks them up so RAG sees
 * the structured content.
 *
 * Converter knob (set on the server process, no per-space config yet):
 *   - `STASHBASE_PDF_CONVERTER`  pymupdf | marker  (default pymupdf)
 *
 * Default `pymupdf` route uses `pymupdf4llm` for LLM-friendly markdown
 * (heading detection, table extraction, figure screenshots). `marker`
 * needs `pip install marker-pdf` in the same venv (~2 GB models, much
 * heavier; ML-backed quality ceiling).
 */
import { spawn } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from './log.ts';
import {
  hasRecord,
  listByStatus,
  markDone,
  markFailed,
  markInFlight,
} from './pdf-status.ts';
import { DERIVED_SOURCE_EXTS } from './format.ts';
import { extractorSpawn } from './python-host.ts';
import { fromKbRel, toKbRel } from './space.ts';

const log = logger('pdf');

export interface ConvertResult {
  /** Absolute path of the written `.<stem>.md` (dot-prefixed app-
   *  derived note; hidden from the sidebar via sibling-bound rules
   *  in files.ts walk()). */
  notePath: string;
  /** Absolute path of the `.<stem>_files/` bundle (dot-prefixed for
   *  the same reason). */
  bundleDir: string;
}

/** Derive the dot-prefixed sibling paths for a given PDF — the file
 *  layout the rest of this module operates on. Returns both the
 *  markdown note we'll emit and the image bundle dir, so callers
 *  don't need to repeat the naming. */
export function derivedPathsForPdf(pdfAbsPath: string): { notePath: string; bundleDir: string } {
  const dir = path.dirname(pdfAbsPath);
  const stem = path.basename(pdfAbsPath, path.extname(pdfAbsPath));
  return {
    notePath: path.join(dir, `.${stem}.md`),
    bundleDir: path.join(dir, `.${stem}_files`),
  };
}

/** Given a POSIX-relative path that points at a dot-prefixed app-
 *  derived note (`.paper.md` / `.paper.html`, or an image's `.shot.md`),
 *  return the relative path of the parent binary source (PDF or image)
 *  when it exists on disk — or null if the shape doesn't match or no
 *  source is there. Used by the search routes to rewrite hits so users
 *  see the PDF / image row rather than the app-derived note (which they
 *  can't open anyway because it's hidden in the sidebar). `baseAbs` is
 *  the root the relative path resolves against (space root for
 *  /api/search, kb root for /api/kb/search). Probes `DERIVED_SOURCE_EXTS`
 *  in order and returns the first source present. */
export function originalForDerivedNote(noteRel: string, baseAbs: string): string | null {
  const m = noteRel.match(/^(.*\/)?\.([^/]+)\.(md|markdown|html|htm)$/i);
  if (!m) return null;
  const dir = m[1] ?? '';
  const stem = m[2];
  for (const ext of DERIVED_SOURCE_EXTS) {
    const candidateRel = `${dir}${stem}.${ext}`;
    if (existsSync(path.join(baseAbs, candidateRel))) return candidateRel;
  }
  return null;
}

/** Run the extractor on a single PDF. Resolves with paths on success;
 *  rejects with the extractor's stderr tail on failure. Fire-and-
 *  forget at the call site if you don't want to block — `convertPdf`
 *  itself does not throw synchronously. */
export function convertPdf(pdfAbsPath: string): Promise<ConvertResult> {
  const { notePath, bundleDir } = derivedPathsForPdf(pdfAbsPath);
  const converter = process.env.STASHBASE_PDF_CONVERTER === 'marker' ? 'marker' : 'pymupdf';

  return new Promise((resolve, reject) => {
    const { cmd, args } = extractorSpawn('pdf', 'pdf_extract.py', [
      pdfAbsPath, notePath, bundleDir, '--converter', converter,
    ]);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += String(b); });
    proc.on('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve({ notePath, bundleDir });
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
 *  Backed by `<KB>/.stashbase/state.db` (KB-wide) — we filter
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
 *  success / failure persists the outcome to `state.db` so
 *  the UI can surface "Conversion failed" + a Retry button, even
 *  after app restart. `spaceRelative` is what we expose to clients
 *  via the in-flight list — same path shape the rest of the API
 *  uses. */
export function maybeConvertPdf(pdfAbsPath: string, spaceRelative: string): void {
  const { notePath } = derivedPathsForPdf(pdfAbsPath);
  if (existsSync(notePath)) {
    log.info(`skipped ${pdfAbsPath} — ${path.basename(notePath)} already present`);
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
  walkPdfs(spaceAbs, '', (rel, abs) => {
    let kbRel: string;
    try { kbRel = toKbRel(rel); }
    catch { return; }
    if (hasRecord(kbRel)) return;
    const { notePath } = derivedPathsForPdf(abs);
    if (existsSync(notePath)) {
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
  const { notePath } = derivedPathsForPdf(pdfAbsPath);
  log.info(`converting ${pdfAbsPath} → ${path.basename(notePath)} …`);
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
