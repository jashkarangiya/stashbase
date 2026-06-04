/**
 * Shared resolution of the Python interpreter + sidecar scripts that the
 * Node side spawns (PDF extraction, image OCR). Extracted from `pdf.ts`
 * so `image.ts` and any future converter share one interpreter-discovery
 * path instead of each re-implementing the packaged-vs-dev venv probe.
 *
 * The packaged app ships a relocated runtime under
 * `<resources>/python/runtime/`; in dev we fall back to the project's
 * `python/.venv/`, then to a bare `python3` on PATH.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(__dirname, '..');

const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : PROJECT_ROOT;

/** Absolute path to the Python interpreter to spawn. Honours
 *  `STASHBASE_PYTHON`, then the packaged runtime, then the dev venv,
 *  then bare `python3`. */
export function pythonBin(): string {
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

/** Absolute path to a sidecar script under `python/` (e.g.
 *  `pdf_extract.py`, `ocr_extract.py`). */
export function pythonScript(name: string): string {
  return path.join(PROJECT_ROOT, 'python', name);
}
