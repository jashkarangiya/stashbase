import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release.nosync');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);

if (process.platform !== 'darwin') {
  console.log('[smoke] packaged server smoke test is currently macOS-only');
  process.exit(0);
}

function argValue(name) {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return null;
}

function findPackagedApp() {
  const explicit = argValue('--app');
  if (explicit) return path.resolve(explicit);

  const productName = pkg.build?.productName || pkg.name;
  const candidates = [
    path.join(releaseDir, 'mac-arm64', `${productName}.app`),
    path.join(releaseDir, 'mac', `${productName}.app`),
  ];
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  if (hit) return hit;

  throw new Error(
    `No packaged ${productName}.app found. Run \`pnpm pack:mac\` or pass --app=/path/to/${productName}.app.`,
  );
}

function requestOk(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/space', method: 'GET', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    if (await requestOk(port, 250)) return;
    await sleep(150);
  }

  const tail = output.join('').slice(-8_000);
  throw new Error(`Packaged server did not respond on :${port} within 10s.\n${tail}`);
}

function assertFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${label}: ${file}`);
}

const appPath = findPackagedApp();
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const appRoot = path.join(resourcesPath, 'app.asar');
const serverEntry = path.join(appRoot, 'dist', 'server', 'index.mjs');
const electronBin = path.join(appPath, 'Contents', 'MacOS', pkg.build?.productName || pkg.name);
const rgPath = path.join(
  resourcesPath,
  'app.asar.unpacked',
  'node_modules',
  '@vscode',
  'ripgrep-darwin-arm64',
  'bin',
  'rg',
);

assertFile(electronBin, 'packaged Electron binary');
assertFile(appRoot, 'app.asar');
assertFile(rgPath, 'packaged ripgrep binary');

const port = Number(argValue('--port')) || 18_000 + Math.floor(Math.random() * 20_000);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-smoke-home-'));
const output = [];

console.log(`[smoke] app ${path.relative(root, appPath)}`);
console.log(`[smoke] server ${serverEntry}`);
console.log(`[smoke] port ${port}`);

const child = spawn(electronBin, [serverEntry, `--port=${port}`], {
  cwd: resourcesPath,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOME: home,
    STASHBASE_APP_ROOT: appRoot,
    STASHBASE_RESOURCES_PATH: resourcesPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

try {
  await waitForServer(port, child, output);
  console.log('[smoke] packaged server responded');
} finally {
  if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2_000).then(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    }),
  ]);
  fs.rmSync(home, { recursive: true, force: true });
}
