/**
 * Leaf module for file-format detection.
 *
 * Lives separately from `files.ts` because `files.ts` imports from
 * `watcher.ts` (→ `state.ts`, which instantiates `MfsIndexer` at module
 * top level). The MCP bundle entry only needs `detectFormat`, so
 * isolating it here keeps `mcp/server.ts` → `indexer.mfs.ts` from
 * pulling watcher/state into the bundle and creating an init-order
 * cycle that the packaged bundle can't resolve correctly.
 */

export type FileFormat = 'md' | 'html';

/** Wider format set the renderer recognises in the file tree, including
 *  binary "viewable but not indexable" formats like PDF and images.
 *  Kept distinct from `FileFormat` so anything in the indexing pipeline
 *  (chunker, daemon upsert, scan_diff) still only sees `md` / `html` —
 *  there's no risk of routing a PDF / image into a text-only pipeline by
 *  accident. PDFs and images both get a hidden `.<stem>.md` derived note
 *  (pdf_extract / ocr_extract) that carries the actual indexed text. */
export type ViewerFormat = FileFormat | 'pdf' | 'image';

/** Recognised note extensions and how the rest of the pipeline should
 *  treat them. Adding a format = one line here + a chunker + a viewer. */
const NOTE_FORMATS: Array<{ pattern: RegExp; format: FileFormat }> = [
  { pattern: /\.(md|markdown)$/i, format: 'md' },
  { pattern: /\.(html|htm)$/i, format: 'html' },
];

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

/** Ordered list of "binary source" extensions that own a hidden
 *  `.<stem>.md` derived note — PDFs (pdf_extract) and images
 *  (ocr_extract). The derived-note → original remap probes these in
 *  order. `.pdf` first since it's the oldest / most common case. */
export const DERIVED_SOURCE_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'webp'] as const;

export function detectFormat(name: string): FileFormat | null {
  for (const { pattern, format } of NOTE_FORMATS) {
    if (pattern.test(name)) return format;
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
