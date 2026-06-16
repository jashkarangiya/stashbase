/**
 * Shared resolution of the Python interpreter + sidecar scripts that the
 * Node side spawns (PDF extraction, image OCR). Extracted from `pdf.ts`
 * so `image.ts` and any future converter share one interpreter-discovery
 * path instead of each re-implementing the packaged-vs-dev venv probe.
 *
 * The packaged app ships a relocated runtime under
 * `<resources>/python/runtime/`; in dev we fall back to the project's
 * `python/.venv.nosync/`, then to a bare `python3` on PATH.
 */
import { existsSync, statSync } from 'node:fs';
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
    ...pythonCandidates(path.join(RESOURCES_ROOT, 'python', 'runtime')),
    ...pythonCandidates(path.join(RESOURCES_ROOT, 'python', '.venv')),
    ...pythonCandidates(path.join(PROJECT_ROOT, 'python', '.venv.nosync')),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'python3';
}

/** Absolute path to a sidecar script under `python/` (e.g.
 *  `pdf_extract.py`, `ocr_extract.py`). */
function pythonScript(name: string): string {
  return path.join(PROJECT_ROOT, 'python', name);
}

/** Resolve how to spawn a one-shot extractor.
 *
 *  Packaged builds have no Python interpreter — the extractors ship as a
 *  single self-contained PyInstaller binary (`stashbase-extract`) that
 *  dispatches on a `pdf` / `ocr` mode arg (see `python/extract_main.py`).
 *  When `STASHBASE_EXTRACT_BIN` points at it we spawn `<bin> <mode> …`.
 *  In dev there's no binary, so we spawn `<venv python> <script.py> …`.
 *
 *  Returns the command + full arg list ready for `child_process.spawn`. */
export function extractorSpawn(
  mode: 'pdf' | 'ocr' | 'video',
  scriptName: string,
  args: string[],
): { cmd: string; args: string[] } {
  const bin = process.env.STASHBASE_EXTRACT_BIN || resolvePackagedExtractBin();
  if (bin) return { cmd: bin, args: [mode, ...args] };
  return { cmd: pythonBin(), args: [pythonScript(scriptName), ...args] };
}

function pythonCandidates(root: string): string[] {
  return process.platform === 'win32'
    ? [
        path.join(root, 'Scripts', 'python.exe'),
        path.join(root, 'bin', 'python'),
      ]
    : [
        path.join(root, 'bin', 'python'),
        path.join(root, 'Scripts', 'python.exe'),
      ];
}

function resolvePackagedExtractBin(): string | undefined {
  if (process.env.STASHBASE_DEV_VITE) return undefined;
  const name = 'stashbase-extract';
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    path.join(RESOURCES_ROOT, 'python', 'sidecar', name, exe),
    path.join(RESOURCES_ROOT, 'python', 'sidecar', exe),
    path.join(PROJECT_ROOT, 'python', 'sidecar.nosync', name, exe),
    path.join(PROJECT_ROOT, 'python', 'sidecar.nosync', exe),
  ];
  return candidates.find(isFile);
}

function isFile(candidate: string): boolean {
  try { return statSync(candidate).isFile(); } catch { return false; }
}
