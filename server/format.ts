/**
 * Leaf module for file-format detection — and the home of the
 * structured-vs-unstructured model the whole ingestion pipeline rests on.
 *
 * The index unit is always markdown. Formats split two ways:
 *   - **Structured** (`FileFormat`: md, html): the source file is itself
 *     the single source of truth and is indexed directly — markdown
 *     as-is; HTML via a cheap in-memory "→ heading markdown" optimization
 *     at MFS-feed time (`analyzeHtml`), NOT materialized to disk.
 *   - **Convertible** (`UNSTRUCTURED_SOURCE_EXTS`: pdf, images): a converter
 *     extracts text into AppData-derived Markdown. That text layer feeds
 *     search; PDFs also use it for Agent text reading, while images remain
 *     the read/view source.
 * So MFS only ever sees markdown; all format knowledge lives here / in
 * the converters, never in MFS.
 *
 * Lives separately from `files.ts` because `files.ts` imports from
 * `watcher.ts` (→ `state.ts`, which instantiates `MfsIndexer` at module
 * top level). The MCP bundle entry only needs `detectFormat`, so
 * isolating it here keeps `mcp/server.ts` → `indexer.mfs.ts` from
 * pulling watcher/state into the bundle and creating an init-order
 * cycle that the packaged bundle can't resolve correctly.
 */

/** Structured note formats — indexed directly (the file is the source). */
export type FileFormat = 'md' | 'html';

/** Everything the renderer can open in the file tree: the structured
 *  note formats plus the convertible binaries (pdf, image) that are
 *  viewable but searched via AppData-derived Markdown. Kept
 *  distinct from `FileFormat` so the indexing pipeline (chunker, daemon
 *  upsert, scan_diff) only ever sees structured `md` / `html`. */
export type ViewerFormat = FileFormat | 'pdf' | 'image';

/** Recognised note extensions and how the rest of the pipeline should
 *  treat them. Adding a format = one line here + a chunker + a viewer —
 *  every note / derived-note / bundle regex elsewhere derives from this
 *  list (via `NOTE_EXTS` and the `isNoteName` / `matchNoteStem` /
 *  `matchDerivedNote` helpers), so the extension set has a single home. */
const NOTE_FORMATS: Array<{ exts: string[]; format: FileFormat }> = [
  { exts: ['md', 'markdown'], format: 'md' },
  { exts: ['html', 'htm'], format: 'html' },
];

/** Every note extension (no leading dot), e.g. `['md','markdown','html','htm']`.
 *  Single source for the alternation baked into the regexes below. */
export const NOTE_EXTS: readonly string[] = NOTE_FORMATS.flatMap((f) => f.exts);

/** Convertible source extensions — PDFs (pdf_extract) and images
 *  (ocr_extract). Current derived Markdown lives in AppData. The hidden
 *  sibling-note regex below remains for legacy cleanup/remap only. */
const UNSTRUCTURED_SOURCE_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'webp'] as const;

const NOTE_EXT_ALT = NOTE_EXTS.join('|');
const SRC_EXT_ALT = UNSTRUCTURED_SOURCE_EXTS.join('|');
const NOTE_EXT_RE = new RegExp(`\\.(${NOTE_EXT_ALT})$`, 'i');
/** Legacy `<dir>/.<sourceBasename>.md` — an app-derived hidden note, where
 *  `sourceBasename` is the full source filename incl. extension. Capture
 *  1 = dir (trailing slash kept), capture 2 = the source basename. The
 *  required source extension is what keeps a user's own hidden `.foo.md`
 *  from being mistaken for a derived note. */
const DERIVED_NOTE_RE = new RegExp(`^(.*/)?\\.(.+\\.(?:${SRC_EXT_ALT}))\\.(?:${NOTE_EXT_ALT})$`, 'i');
/** `<dir>/<stem>.<noteExt>` — a visible note, captured for bundle naming. */
const NOTE_STEM_RE = new RegExp(`^(.*/)?([^/]+)\\.(${NOTE_EXT_ALT})$`, 'i');

/** True when `name` ends in a note extension (= the indexer would pick it
 *  up). Same set as `detectFormat(name) !== null`; use this for boolean
 *  "is it a note?" checks so the extension set isn't re-spelled. */
export function isNoteName(name: string): boolean {
  return NOTE_EXT_RE.test(name);
}


/** True when a path/basename has the legacy hidden-note shape
 *  (`.<sourceBasename>.md`, e.g. `.report.pdf.md`). Used for cleanup/remap
 *  so old on-disk derived notes do not leak. */
export function isDerivedNoteName(pathOrName: string): boolean {
  return DERIVED_NOTE_RE.test(pathOrName);
}

/** Split a derived-note relative path into `{ dir, source }` where
 *  `source` is the source file's relative path (dir + full basename, e.g.
 *  `sub/report.pdf`), or null if it isn't a derived note. The source is
 *  read straight from the name — no extension probing. */
export function matchDerivedNote(rel: string): { dir: string; source: string } | null {
  const m = rel.replace(/\\/g, '/').match(DERIVED_NOTE_RE);
  return m ? { dir: m[1] ?? '', source: `${m[1] ?? ''}${m[2]}` } : null;
}

/** Split a (visible) note relative path into `{ dir, stem }` for deriving
 *  the `<stem>_files/` bundle name, or null if it isn't a note. */
export function matchNoteStem(rel: string): { dir: string; stem: string } | null {
  const m = rel.replace(/\\/g, '/').match(NOTE_STEM_RE);
  return m ? { dir: m[1] ?? '', stem: m[2] } : null;
}

/** Image extensions we OCR + view. Deliberately narrow for V1
 *  (png / jpg / jpeg / webp) — the OCR pipeline and viewer are tested
 *  against these; widen here when we add gif / heic / etc. */
const IMAGE_PATTERN = /\.(png|jpe?g|webp)$/i;

const VIEWER_ONLY_FORMATS: Array<{ pattern: RegExp; format: ViewerFormat }> = [
  { pattern: /\.pdf$/i, format: 'pdf' },
  { pattern: IMAGE_PATTERN, format: 'image' },
];

/** True for the image extensions the OCR pipeline handles. Used by the
 *  upload route to decide whether to spawn `ocr_extract.py`, and by the
 *  derived-note remap to probe for an image original. */
export function isImageFile(name: string): boolean {
  return IMAGE_PATTERN.test(name);
}

/** True for an unstructured **convertible source** (PDF or image) — files
 *  whose searchable text comes from an app-data derived note and are
 *  indexed under their own path. They are NOT directly index-readable
 *  (raw bytes would be garbage), so reconcile must not treat them as plain
 *  notes; it lets the conversion path own their index entry. */
export function isConvertibleSource(name: string): boolean {
  return /\.pdf$/i.test(name) || isImageFile(name);
}

const NOTE_FORMAT_RES: Array<{ re: RegExp; format: FileFormat }> = NOTE_FORMATS.map((f) => ({
  re: new RegExp(`\\.(${f.exts.join('|')})$`, 'i'),
  format: f.format,
}));

export function detectFormat(name: string): FileFormat | null {
  for (const { re, format } of NOTE_FORMAT_RES) {
    if (re.test(name)) return format;
  }
  return null;
}

/** Like `detectFormat` but also recognises viewer-only formats (PDF).
 *  Used by the sidebar / file tree which surfaces every viewable file
 *  to the user, even ones that don't go through indexing. */
export function detectViewerFormat(name: string): ViewerFormat | null {
  const note = detectFormat(name);
  if (note) return note;
  for (const { pattern, format } of VIEWER_ONLY_FORMATS) {
    if (pattern.test(name)) return format;
  }
  return null;
}
