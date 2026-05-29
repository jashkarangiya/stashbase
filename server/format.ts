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
 *  binary "viewable but not indexable" formats like PDF. Kept distinct
 *  from `FileFormat` so anything in the indexing pipeline (chunker,
 *  daemon upsert, scan_diff) still only sees `md` / `html` — there's no
 *  risk of routing a PDF into a text-only pipeline by accident. */
export type ViewerFormat = FileFormat | 'pdf';

/** Recognised note extensions and how the rest of the pipeline should
 *  treat them. Adding a format = one line here + a chunker + a viewer. */
const NOTE_FORMATS: Array<{ pattern: RegExp; format: FileFormat }> = [
  { pattern: /\.(md|markdown)$/i, format: 'md' },
  { pattern: /\.(html|htm)$/i, format: 'html' },
];

const VIEWER_ONLY_FORMATS: Array<{ pattern: RegExp; format: ViewerFormat }> = [
  { pattern: /\.pdf$/i, format: 'pdf' },
];

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
