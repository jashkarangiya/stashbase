/**
 * One-time Python sidecar installer.
 *
 * 1. Find a Python >= 3.10 on PATH (preferring `python3.13` / `python3.12`
 *    / `python3.11` / `python3.10` over a bare `python3` whose version
 *    might be 3.9 — that combo silently fails on `mfs-cli` install).
 * 2. Create `python/.venv.nosync` if missing (the `.nosync` suffix keeps
 *    iCloud Drive from corrupting it when the repo is under ~/Documents).
 * 3. `pip install -r python/requirements.txt` into it.
 *
 * Fails loudly with an actionable message rather than letting the
 * embedding daemon crash later with "No module named 'mfs'".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENV = path.join(ROOT, 'python', '.venv.nosync');
const REQS = path.join(ROOT, 'python', 'requirements.txt');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(VENV, 'Scripts', 'python.exe')
  : path.join(VENV, 'bin', 'python');

const MIN_MAJOR = 3;
const MIN_MINOR = 10;

const CANDIDATES = [
  'python3.13',
  'python3.12',
  'python3.11',
  'python3.10',
  'python3',
  'python',
];

function probe(bin) {
  const r = spawnSync(bin, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const [major, minor] = r.stdout.trim().split(/\s+/).map(Number);
  return { bin, major, minor };
}

function findPython() {
  const tried = [];
  for (const c of CANDIDATES) {
    const r = probe(c);
    if (!r) continue;
    tried.push(`${c} (${r.major}.${r.minor})`);
    if (r.major > MIN_MAJOR || (r.major === MIN_MAJOR && r.minor >= MIN_MINOR)) {
      return r;
    }
  }
  const seen = tried.length ? tried.join(', ') : 'none';
  console.error(
    `[setup:python] no Python >= ${MIN_MAJOR}.${MIN_MINOR} found on PATH.\n` +
      `  Probed: ${seen}\n` +
      `  Install Python 3.10+ (e.g. \`brew install python@3.12\`) and re-run.`,
  );
  process.exit(1);
}

const py = findPython();
console.log(`[setup:python] using ${py.bin} (${py.major}.${py.minor})`);

mkdirSync(path.dirname(VENV), { recursive: true });
if (!existsSync(VENV)) {
  console.log(`[setup:python] creating venv at ${VENV}`);
  execFileSync(py.bin, ['-m', 'venv', VENV], { stdio: 'inherit' });
}

console.log(`[setup:python] installing deps from ${REQS}`);
execFileSync(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit' });
execFileSync(VENV_PYTHON, ['-m', 'pip', 'install', '-r', REQS], { stdio: 'inherit' });

// Smoke-test the imports the daemon needs, so a corrupt venv reports
// failure here instead of at first daemon spawn.
const probeImports = `
import sys
try:
    import mfs, openai, numpy, pymupdf4llm, rapidocr_onnxruntime
    print(f'[setup:python] ok: mfs, openai ({openai.__version__}), numpy, pymupdf4llm, rapidocr_onnxruntime')
except Exception as e:
    print(f'[setup:python] import probe failed: {e}', file=sys.stderr)
    sys.exit(1)
`;
execFileSync(VENV_PYTHON, ['-c', probeImports], { stdio: 'inherit' });
