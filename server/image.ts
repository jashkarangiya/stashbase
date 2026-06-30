/**
 * Image → OCR-text note conversion, driven by `python/ocr_extract.py`.
 *
 * The image analogue of `pdf.ts`: whenever a `.png` / `.jpg` / `.jpeg`
 * / `.webp` lands in a folder (drag-in, clipboard paste, in-app capture)
 * we spawn RapidOCR in the background. It writes OCR Markdown under AppData;
 * on completion the note is pushed into the index directly when an API key is
 * available — so a screenshot's text becomes searchable. The image itself
 * stays on disk as the user-facing file.
 *
 * Unlike PDFs there is no image bundle — OCR yields only text.
 *
 * Conversion status reuses the same `state.db`-backed store as PDFs
 * (`conversion-status.ts`, keyed by path) so the "Converting…" indicator and
 * the in-flight list cover images for free.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { isImageFile } from './format.ts';
import { derivedNoteFor, derivedDir } from './derived-store.ts';
import { extractorSpawn } from './python-host.ts';
import { discoverNewSources, indexFreshDerived, maybeConvert, TransientConversionError, type ConversionSpec } from './conversion.ts';
import { spawnOptionsForExtractor, terminateExtractorTree } from './extractor-process.ts';

/** App-data derived note path for an image (the OCR text layer) — never in
 *  the user's opened folder (see `derived-store.ts`). No image bundle. */
export function derivedNotePathForImage(imageAbsPath: string): string {
  return derivedNoteFor(imageAbsPath);
}

function cleanupDerivedImage(imageAbsPath: string): void {
  rmSync(derivedNotePathForImage(imageAbsPath), { force: true });
}

/** Run the OCR extractor on a single image. Resolves with the note path
 *  on success; rejects with the extractor's stderr tail on failure.
 *  Does not throw synchronously — fire-and-forget at the call site. */
function convertImage(
  imageAbsPath: string,
  _onProgress?: unknown,
  signal?: AbortSignal,
): Promise<{ notePath: string }> {
  const notePath = derivedNotePathForImage(imageAbsPath);
  mkdirSync(derivedDir(), { recursive: true });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ocr_extract cancelled'));
      return;
    }
    const { cmd, args } = extractorSpawn('ocr', 'ocr_extract.py', [imageAbsPath, notePath]);
    const proc = spawn(cmd, args, spawnOptionsForExtractor());
    let stderr = '';
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      terminateExtractorTree(proc);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', (b) => { stderr += String(b); });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`spawn failed: ${err.message}`));
    });
    proc.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (cancelled) {
        reject(new TransientConversionError('ocr_extract cancelled'));
        return;
      }
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
  cleanupDerived: cleanupDerivedImage,
};

/** Fire-and-forget OCR used by the upload route. Skips if the note
 *  already exists; persists in-flight → done/failed to `state.db`
 *  (shared with PDFs) so the UI can show status. */
export function maybeConvertImage(imageAbsPath: string): void {
  maybeConvert(imageAbsPath, IMAGE_SPEC);
}

/** Reconcile hook: OCR any untracked image under the folder (added via git
 *  checkout / external copy / `mv`). */
export function discoverNewImages(folderAbs: string): void {
  discoverNewSources(folderAbs, IMAGE_SPEC);
}

export function indexFreshImage(imageAbsPath: string): Promise<boolean> {
  return indexFreshDerived(imageAbsPath, IMAGE_SPEC);
}

function isMissingRapidOcrError(message: string): boolean {
  return /rapidocr_onnxruntime/i.test(message)
    || /No module named ['"][^'"]*rapidocr/i.test(message)
    || /OCR dependency rapidocr/i.test(message);
}
