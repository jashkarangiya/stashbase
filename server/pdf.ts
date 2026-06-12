/**
 * PDF → markdown-with-bundle conversion, driven by `python/pdf_extract.py`.
 *
 * Wired from the upload route: whenever a `.pdf` lands in a space we
 * spawn the extractor in the background. It writes `.<sourceBasename>.md` and
 * `.<sourceBasename>_files/` alongside the PDF; on completion the note is pushed into the index directly and the pipeline picks
 * them up and the indexer embeds the new note. Both the derived note
 * and its bundle are dot-prefixed — they're app-maintained artifacts,
 * not user content, so they sit alongside `.stashbase/` / `.claude/`
 * in our "dot-prefix = system, no-prefix = user" convention. The PDF
 * itself stays on disk as a regular file — the user-facing copy.
 *
 * Hidden in the sidebar via `files.ts walk()`'s sibling-bound hide
 * rule (a `paper.pdf` next to `.paper.pdf.md` collapses the derived files
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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isDerivedNoteName, matchDerivedNote } from './format.ts';
import { extractorSpawn } from './python-host.ts';
import { discoverNewSources, maybeConvert, type ConversionSpec } from './conversion.ts';

export interface ConvertResult {
  /** Absolute path of the written `.<sourceBasename>.md` (dot-prefixed app-
   *  derived note; hidden from the sidebar via sibling-bound rules
   *  in files.ts walk()). */
  notePath: string;
  /** Absolute path of the `.<sourceBasename>_files/` bundle (dot-prefixed for
   *  the same reason). */
  bundleDir: string;
}

/** Derive the dot-prefixed sibling paths for a given PDF — the file
 *  layout the rest of this module operates on. Returns both the
 *  markdown note we'll emit and the image bundle dir, so callers
 *  don't need to repeat the naming. */
export function derivedPathsForPdf(pdfAbsPath: string): { notePath: string; bundleDir: string } {
  const dir = path.dirname(pdfAbsPath);
  // Derived names carry the full source filename (`paper.pdf`) so a
  // `paper.pdf` and a `paper.png` don't collide on `.paper.pdf.md`.
  const base = path.basename(pdfAbsPath);
  return {
    notePath: path.join(dir, `.${base}.md`),
    bundleDir: path.join(dir, `.${base}_files`),
  };
}

/** Given a POSIX-relative path to a dot-prefixed app-derived note
 *  (`.paper.pdf.md` / `.shot.png.md`), return the relative path of its
 *  parent binary source (PDF / image) when that source exists on disk —
 *  or null if the shape doesn't match or the source is gone. The source
 *  filename is encoded in the derived name, so this is a direct read +
 *  existence check (no extension probing). Used by the search routes to
 *  rewrite hits so users see the PDF / image row rather than the hidden
 *  derived note. `baseAbs` is the root the relative path resolves against
 *  (space root for /api/search, kb root for /api/kb/search). */
function originalForDerivedNote(noteRel: string, baseAbs: string): string | null {
  // The derived name encodes the full source filename, so the source is
  // read straight off it — no extension probing.
  const m = matchDerivedNote(noteRel);
  if (!m) return null;
  return existsSync(path.join(baseAbs, m.source)) ? m.source : null;
}

/** The single remap-or-drop rule every search route applies to a hit's
 *  path so a hidden derived note is never shown to the user:
 *
 *    • app-derived note (`.paper.pdf.md` / `.shot.png.md`) with a live source
 *        → the source PDF / image (the clickable, openable original);
 *    • derived note whose source is gone (orphan)
 *        → `null`, i.e. drop the hit — the bare `.md` is hidden in the
 *          sidebar and must never surface as an unopenable row;
 *    • any normal file → unchanged.
 *
 *  `rel` is relative to `baseAbs` (space root for the GUI routes, KB root
 *  for MCP). Centralised here so `/api/search`, `/api/keyword-search`,
 *  and `/api/kb/search` can't drift apart. */
export function displayPathForHit(rel: string, baseAbs: string): string | null {
  const source = originalForDerivedNote(rel, baseAbs);
  if (source) return source;
  if (isDerivedNoteName(rel)) return null;
  return rel;
}

/** Run the extractor on a single PDF. Resolves with paths on success;
 *  rejects with the extractor's stderr tail on failure. Fire-and-
 *  forget at the call site if you don't want to block — `convertPdf`
 *  itself does not throw synchronously. */
function convertPdf(pdfAbsPath: string): Promise<ConvertResult> {
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

/** Conversion spec wiring PDFs into the shared `conversion.ts` plumbing. */
const PDF_SPEC: ConversionSpec = {
  kind: 'pdf_extract',
  matches: (name) => /\.pdf$/i.test(name),
  derivedNote: (abs) => derivedPathsForPdf(abs).notePath,
  convert: convertPdf,
};

/** Fire-and-forget convert used by the upload route. Skips if the note
 *  already exists; persists in-flight → done/failed to `state.db` so the
 *  UI can show "Converting…" and a Retry banner even after restart. */
export function maybeConvertPdf(pdfAbsPath: string): void {
  maybeConvert(pdfAbsPath, PDF_SPEC);
}

/** Reconcile hook: convert any untracked `.pdf` under the space (dropped
 *  in via git checkout / external copy / `mv`), back-filling a `done`
 *  record when the sibling note already exists. */
export function discoverNewPdfs(spaceAbs: string): void {
  discoverNewSources(spaceAbs, PDF_SPEC);
}
