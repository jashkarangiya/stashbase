import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const python = path.join(root, 'python', '.venv', 'bin', 'python');
const entry = path.join(root, 'python', 'stashbase_daemon.py');
const distPath = path.join(root, 'python', 'sidecar');
const buildPath = path.join(root, 'dist', 'pyinstaller');
const specPath = path.join(root, 'dist', 'pyinstaller');
const buildReqs = path.join(root, 'python', 'build-requirements.txt');
const setupPython = path.join(root, 'scripts', 'setup-python.mjs');

if (!fs.existsSync(python)) {
  console.log('[build:python-sidecar] python/.venv is missing; running setup:python');
  execFileSync(process.execPath, [setupPython], {
    cwd: root,
    stdio: 'inherit',
  });
}

if (!fs.existsSync(python)) {
  throw new Error('python/.venv setup did not produce python/.venv/bin/python.');
}

const probe = spawnSync(python, ['-m', 'PyInstaller', '--version'], {
  cwd: root,
  encoding: 'utf8',
});
if (probe.status !== 0) {
  console.log('[build:python-sidecar] installing PyInstaller build dependency');
  execFileSync(python, ['-m', 'pip', 'install', '-r', buildReqs], {
    cwd: root,
    stdio: 'inherit',
  });
}

fs.rmSync(distPath, { recursive: true, force: true });
fs.mkdirSync(distPath, { recursive: true });
fs.mkdirSync(buildPath, { recursive: true });

execFileSync(
  python,
  [
    '-m',
    'PyInstaller',
    '--clean',
    '--noconfirm',
    '--name',
    'stashbase-daemon',
    '--onefile',
    '--hidden-import',
    'mfs.embedder.onnx',
    '--hidden-import',
    'mfs.store',
    '--hidden-import',
    'mfs.config',
    '--hidden-import',
    'mfs.ingest.chunker',
    '--hidden-import',
    'mfs.ingest.scanner',
    '--copy-metadata',
    'milvus-lite',
    '--copy-metadata',
    'pymilvus',
    '--copy-metadata',
    'mfs-cli',
    '--distpath',
    distPath,
    '--workpath',
    buildPath,
    '--specpath',
    specPath,
    entry,
  ],
  { cwd: root, stdio: 'inherit' },
);

const out = path.join(distPath, 'stashbase-daemon');
if (!fs.existsSync(out)) {
  throw new Error(`PyInstaller did not produce ${out}`);
}
fs.chmodSync(out, 0o755);
console.log('[build:python-sidecar] done ->', out);
