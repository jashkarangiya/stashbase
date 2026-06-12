/**
 * Image → OCR-text note conversion, driven by `python/ocr_extract.py`.
 *
 * The image analogue of `pdf.ts`: whenever a `.png` / `.jpg` / `.jpeg`
 * / `.webp` lands in a space (drag-in, clipboard paste, in-app capture)
 * we spawn RapidOCR in the background. It writes `.<sourceBasename>.md` alongside
 * the image; on completion the note is pushed into the index directly and the indexer
 * embeds the note — so a screenshot's text becomes searchable. The
 * image itself stays on disk as the user-facing file.
 *
 * Unlike PDFs there is no image bundle (`.<sourceBasename>_files/`) — OCR yields
 * only text. The single derived note is dot-prefixed for the same
 * reason PDF notes are (app-maintained artifact, hidden in the sidebar
 * via `files.ts walk()`'s sibling-bound rule, but still indexed).
 *
 * Conversion status reuses the same `state.db`-backed store as PDFs
 * (`conversion-status.ts`, keyed by path) so the "Converting…" indicator and
 * the in-flight list cover images for free.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isImageFile } from './format.ts';
import { extractorSpawn } from './python-host.ts';
import { discoverNewSources, maybeConvert, type ConversionSpec } from './conversion.ts';

/** Dot-prefixed derived note path (`.<sourceBasename>.md`) for an image — same
 *  hidden-sibling layout PDFs use, minus the image bundle. */
export function derivedNotePathForImage(imageAbsPath: string): string {
  // Carry the full source filename (`shot.png`) so different-extension
  // images with the same stem don't collide on `.shot.png.md`.
  const dir = path.dirname(imageAbsPath);
  return path.join(dir, `.${path.basename(imageAbsPath)}.md`);
}

/** Run the OCR extractor on a single image. Resolves with the note path
 *  on success; rejects with the extractor's stderr tail on failure.
 *  Does not throw synchronously — fire-and-forget at the call site. */
function convertImage(imageAbsPath: string): Promise<{ notePath: string }> {
  const notePath = derivedNotePathForImage(imageAbsPath);
  return new Promise((resolve, reject) => {
    const { cmd, args } = extractorSpawn('ocr', 'ocr_extract.py', [imageAbsPath, notePath]);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += String(b); });
    proc.on('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve({ notePath });
      } else {
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        if (isMissingRapidOcrError(tail)) {
          reject(new Error(
            'OCR engine is not installed. Run `pnpm setup:python` and restart StashBase; the image still opens, but its text is not searchable yet.',
          ));
          return;
        }
        reject(new Error(`ocr_extract exit ${code}: ${tail || '(no stderr)'}`));
      }
    });
  });
}

/** Conversion spec wiring images into the shared `conversion.ts` plumbing.
 *  Unlike PDFs there's no image bundle — OCR yields only the text note. */
const IMAGE_SPEC: ConversionSpec = {
  kind: 'ocr_extract',
  matches: isImageFile,
  derivedNote: derivedNotePathForImage,
  convert: convertImage,
};

/** Fire-and-forget OCR used by the upload route. Skips if the note
 *  already exists; persists in-flight → done/failed to `state.db`
 *  (shared with PDFs) so the UI can show status. */
export function maybeConvertImage(imageAbsPath: string): void {
  maybeConvert(imageAbsPath, IMAGE_SPEC);
}

/** Reconcile hook: OCR any untracked image under the space (added via git
 *  checkout / external copy / `mv`), back-filling a `done` record when the
 *  sibling note already exists. */
export function discoverNewImages(spaceAbs: string): void {
  discoverNewSources(spaceAbs, IMAGE_SPEC);
}

function isMissingRapidOcrError(message: string): boolean {
  return /rapidocr_onnxruntime/i.test(message)
    || /No module named ['"][^'"]*rapidocr/i.test(message)
    || /OCR dependency rapidocr/i.test(message);
}
