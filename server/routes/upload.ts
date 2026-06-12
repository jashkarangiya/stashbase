/**
 * Drop-zone / sidebar import route. Accepts multipart `files[]` with a
 * parallel `paths[]` array preserving the dropped folder layout, plus
 * an optional `dir` form field that scopes the import to a subfolder
 * of the active space.
 *
 * Two non-obvious behaviours worth knowing about:
 *   1. A note `<stem>.{md,html}` and its iframe bundle `<stem>_files/`
 *      land as siblings at the drop target (NOT wrapped in `<stem>/`),
 *      matching how browsers' "Save Page As Complete" produces them.
 *   2. Stem collisions are renumbered (`stem-2.md`, `stem-2_files/`)
 *      across BOTH the note and its bundle in lockstep, so the iframe
 *      can still find its assets after the import.
 */
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import {
  detectFormat,
  pathExists,
  sanitizeFilename,
  saveBytes,
  saveText,
} from '../files.ts';
import { isImageFile, isNoteName } from '../format.ts';
import { errorMessage, logger } from '../log.ts';
import { getCurrentSpace, runWithWindowId, toKbRel, WINDOW_ID_HEADER } from '../space.ts';
import { extractEmbeddedResources } from '../resources.ts';
import { maybeConvertImage } from '../image.ts';
import { maybeConvertPdf } from '../pdf.ts';
import { indexer } from '../state.ts';

const log = logger('routes/upload');

// In-memory upload buffer. Bumped beyond the original 8 MB / 50-file
// limits to accommodate "Save Page As Complete" bundles (arxiv HTML
// pulls in dozens of figures + CSS).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024, files: 500 },
});

export function mount(app: express.Express): void {
  app.post('/api/upload', upload.array('files', 500), async (req, res) => {
    // Multer consumes the request body stream, and its callbacks run in the
    // connection-time async context — which drops the windowId that
    // `withWindowContext` stashed in AsyncLocalStorage. Without re-binding
    // it here, every space-scoped lookup inside the handler
    // (getCurrentSpace, saveBytes → resolveSafe) falls back to
    // DEFAULT_WINDOW_ID and the upload fails with "no space open" even
    // though the client sent the right window header. Re-establish the
    // context from the header before doing any per-window work.
    await runWithWindowId(req.header(WINDOW_ID_HEADER), () => handleUpload(req, res));
  });
}

async function handleUpload(req: express.Request, res: express.Response): Promise<void> {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'no files' }); return; }
  // Optional `dir` form field: space-relative path of the folder to
  // drop the files into. Sanitised the same way we treat any other
  // write path so a stray `..` or absolute path can't escape the space.
  let dir = typeof req.body?.dir === 'string' ? req.body.dir.trim() : '';
  if (dir) dir = sanitizeFilename(dir).replace(/\/+$/, '');
  const prefix = dir ? dir + '/' : '';

  // Parallel `paths` array preserves the dropped folder layout —
  // see web `walkEntry`. Multer normalises a single value to a string
  // and ≥2 to an array; coerce to a string array.
  const rawPaths = req.body?.paths;
  const paths: string[] = Array.isArray(rawPaths)
    ? rawPaths.map(String)
    : typeof rawPaths === 'string' ? [rawPaths] : [];

  const finalNames = computeFinalNames(files, paths, prefix);

  const out: { file: string; error?: string }[] = [];
  const toIndex: { name: string; text: string }[] = [];
  const toConvertPdf: { abs: string; rel: string }[] = [];
  const toOcrImage: { abs: string; rel: string }[] = [];
  const spaceAbs = getCurrentSpace();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = finalNames[i];
    try {
      // Always save bytes to disk — bundle assets (PNG / CSS / WOFF
      // shipped alongside an arxiv HTML) are needed by the iframe even
      // though they're not indexable. Only indexable formats go to
      // the indexer.
      saveBytes(name, f.buffer);
      out.push({ file: name });
      if (detectFormat(name)) {
        let text = f.buffer.toString('utf8');
        // Pipeline §4.2 steps 2-3: pull inline `data:` images out into
        // the note's `<stem>_files/` bundle and rewrite the refs, so a
        // standalone HTML/Markdown drop doesn't carry megabytes of
        // base64 (and the images become real, previewable assets).
        try {
          const { content, assets } = extractEmbeddedResources(name, text);
          if (assets.length > 0) {
            text = content;
            saveText(name, text);
            for (const a of assets) saveBytes(a.path, a.bytes);
            log.info(`upload: extracted ${assets.length} embedded resource(s) from ${name}`);
          }
        } catch (err: unknown) {
          log.warn(`upload: resource extraction failed for ${name}: ${errorMessage(err)}`);
        }
        toIndex.push({ name, text });
      } else if (spaceAbs && /\.pdf$/i.test(name)) {
        // PDFs run through the pymupdf / marker pipeline so the
        // user gets a readable note + image bundle they can preview
        // and that the converter pushes into the index on completion.
        toConvertPdf.push({ abs: path.join(spaceAbs, name), rel: name });
      } else if (spaceAbs && isImageFile(name)) {
        // Images run through RapidOCR so any text in a screenshot /
        // photo becomes a hidden `.<sourceBasename>.md` note the converter indexes
        // up and indexes — mirrors the PDF path, minus the bundle.
        toOcrImage.push({ abs: path.join(spaceAbs, name), rel: name });
      }
    } catch (err: unknown) {
      log.warn(`upload: save failed for ${name}: ${errorMessage(err)}`);
      out.push({ file: name, error: errorMessage(err) });
    }
  }
  res.json({ files: out });
  // Background indexing — don't await; the response has already been sent.
  (async () => {
    for (const { name, text } of toIndex) {
      try {
        await indexer.upsertFile(toKbRel(name), text);
      } catch (err: unknown) {
        log.warn(`upload: index failed for ${name}: ${errorMessage(err)}`);
      }
    }
  })();
  // Kick off conversions fire-and-forget. They handle their own async
  // failures internally; guard only against a synchronous throw at
  // kickoff (the response is already sent, so it'd otherwise be an
  // unhandled error) — same discipline as the index loop above.
  for (const { abs, rel } of toConvertPdf) {
    try { maybeConvertPdf(abs); } catch (err: unknown) { log.warn(`upload: pdf convert kickoff failed for ${rel}: ${errorMessage(err)}`); }
  }
  for (const { abs, rel } of toOcrImage) {
    try { maybeConvertImage(abs); } catch (err: unknown) { log.warn(`upload: image OCR kickoff failed for ${rel}: ${errorMessage(err)}`); }
  }
}

/** Compute the on-disk paths for a batch up front so any top-level file
 *  that would clash with an existing file gets a `-2` / `-3` suffix —
 *  a drag means "add this", so we keep both rather than silently
 *  overwriting (which `saveBytes` would otherwise do for non-note
 *  files). Notes additionally reserve against their `<stem>_files/`
 *  bundle and carry it along when renamed. Files dropped inside a
 *  subfolder keep their layout verbatim. */
function computeFinalNames(
  files: Express.Multer.File[],
  paths: string[],
  prefix: string,
): string[] {
  function relForFile(idx: number): string {
    const f = files[idx];
    return paths[idx] && paths[idx].length ? paths[idx] : f.originalname;
  }

  // Step 1: reserve a non-colliding name for every TOP-LEVEL file (any
  // type). "Top-level" = no folder separator (so it lives directly at
  // the drop target, alongside its `<stem>_files/` bundle if it's a
  // note). Bundle members (rel contains `/`) are handled in step 2.
  const reserved = new Set<string>();             // finalName (stem+ext) taken this batch
  const finalByIndex = new Map<number, string>(); // idx → final top-level name
  const noteStemRenames = new Map<string, string>(); // note origStem → finalStem (for bundles)
  for (let i = 0; i < files.length; i++) {
    const rel = relForFile(i);
    if (rel.includes('/')) continue;
    const isNote = isNoteName(rel);
    const dot = rel.lastIndexOf('.');
    const origStem = dot > 0 ? rel.slice(0, dot) : rel;
    const ext = dot > 0 ? rel.slice(dot) : ''; // includes leading dot, '' if none
    let finalStem = origStem;
    let n = 2;
    while (
      pathExists(prefix + finalStem + ext)
      || reserved.has(finalStem + ext)
      || (isNote && pathExists(prefix + finalStem + '_files'))
    ) {
      finalStem = `${origStem}-${n}`;
      n++;
    }
    reserved.add(finalStem + ext);
    finalByIndex.set(i, finalStem + ext);
    if (isNote && finalStem !== origStem) noteStemRenames.set(origStem, finalStem);
  }
  // Step 2: rewrite every file's path. Top-level files use their
  // reserved final name; bundle files under a renamed note's
  // `<stem>_files/...` track the renumbered stem.
  return files.map((_, i) => {
    const rel = relForFile(i);
    const segments = rel.split('/');
    if (segments.length === 1) {
      return sanitizeFilename(prefix + (finalByIndex.get(i) ?? rel));
    }
    const top = segments[0];
    const bm = top.match(/^(.+)_files$/);
    if (bm && noteStemRenames.has(bm[1])) {
      segments[0] = noteStemRenames.get(bm[1])! + '_files';
      return sanitizeFilename(prefix + segments.join('/'));
    }
    return sanitizeFilename(prefix + rel);
  });
}
