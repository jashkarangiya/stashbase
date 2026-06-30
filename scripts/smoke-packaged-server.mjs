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

function requestJson(port, requestPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 8192) body += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ ok: true, statusCode: res.statusCode ?? 0, body: JSON.parse(body) });
          } catch {
            resolve({ ok: true, statusCode: res.statusCode ?? 0, body: null });
          }
        });
      },
    );
    req.on('error', () => resolve({ ok: false, statusCode: 0, body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, statusCode: 0, body: null });
    });
    req.end();
  });
}

async function requestOk(port, timeoutMs) {
  const res = await requestJson(port, '/api/folder', timeoutMs);
  return res.ok && res.statusCode >= 200 && res.statusCode < 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sidecarCandidates(root, name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const base = path.join(root, 'python', 'sidecar');
  return [
    path.join(base, name, exe),
    path.join(base, exe),
  ];
}

function findSidecarExecutable(root, name) {
  return sidecarCandidates(root, name).find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) ?? sidecarCandidates(root, name)[0];
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

async function assertPackagedHealth(port, expected) {
  const res = await requestJson(port, '/api/health', 1000);
  if (!res.ok || res.statusCode !== 200 || !res.body || typeof res.body !== 'object') {
    throw new Error(`packaged health probe failed: status=${res.statusCode}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (res.body[key] !== value) {
      throw new Error(
        `packaged health ${key} mismatch:\n` +
          `  expected: ${value}\n` +
          `  actual: ${res.body[key]}`,
      );
    }
  }
}

function writeTinyPdf(file) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '5 0 obj\n<< /Length 51 >>\nstream\nBT /F1 18 Tf 40 80 Td (Hello StashBase PDF smoke) Tj ET\nendstream\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += obj;
  }
  const xref = Buffer.byteLength(body, 'utf8');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, body);
}


function writeOcrFixture(file) {
  const pngBase64 = [
    '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',
  ].join('');
  fs.writeFileSync(file, Buffer.from(pngBase64, 'base64'));
}

function runProcess(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(command)} timed out`));
    }, options.timeoutMs ?? 10_000);
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output: out });
    });
  });
}

async function smokeOcrExtractor(extractBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-smoke-ocr-'));
  try {
    const image = path.join(tmp, 'smoke.png');
    const out = path.join(tmp, '.smoke.md');
    writeOcrFixture(image);
    const probe = await runProcess(extractBin, ['ocr', image, out], { timeoutMs: 20_000 });
    if (probe.code !== 0) {
      throw new Error(`ocr extractor failed: exit=${probe.code}\n${probe.output.slice(-4_000)}`);
    }
    const note = fs.readFileSync(out, 'utf8').replace(/\s+/g, '');
    if (!/HELLOSTASHBASEOCR/i.test(note)) {
      throw new Error(`ocr extractor did not preserve expected text\n${note.slice(0, 1_000)}`);
    }
    console.log('[smoke] python OCR extractor converted a fixture');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function smokePdfExtractor(extractBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-smoke-pdf-'));
  try {
    const pdf = path.join(tmp, 'smoke.pdf');
    const out = path.join(tmp, '.smoke.md');
    const bundle = path.join(tmp, '.smoke_files');
    writeTinyPdf(pdf);
    const probe = await runProcess(extractBin, ['pdf', pdf, out, bundle], { timeoutMs: 15_000 });
    if (probe.code !== 0) {
      throw new Error(`pdf extractor failed: exit=${probe.code}\n${probe.output.slice(-4_000)}`);
    }
    const note = fs.readFileSync(out, 'utf8');
    if (!/Hello\s+StashBase\s+PDF\s+smoke/i.test(note)) {
      throw new Error(`pdf extractor did not preserve expected text\n${note.slice(0, 1_000)}`);
    }
    console.log('[smoke] python PDF extractor converted a fixture');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function smokeDaemon(daemonBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-smoke-py-'));
  const folderHome = path.join(tmp, 'folder-home');
  const folderRoot = path.join(folderHome, 'Smoke');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(folderRoot, { recursive: true });
  const child = spawn(daemonBin, ['--store-root', storeRoot], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`daemon smoke did not finish within 20s\n${output.slice(-4_000)}`));
      }, 20_000);
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const send = (id, op, args) => {
        child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
      };
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.event === 'ready') {
              send(1, 'bind_folder', { folder: folderRoot, provider: 'openai', api_key: 'sk-smoke' });
              continue;
            }
            if (msg.id === 1) {
              if (!msg.ok) {
                settle(reject, new Error(`daemon bind_folder failed: ${msg.error}\n${output.slice(-4_000)}`));
                continue;
              }
              send(2, 'list', { folder: folderRoot });
              continue;
            }
            if (msg.id === 2) {
              if (!msg.ok) {
                settle(reject, new Error(`daemon list failed: ${msg.error}\n${output.slice(-4_000)}`));
                continue;
              }
              settle(resolve);
            }
            if (msg.event === 'error') settle(reject, new Error(`daemon error: ${msg.error}`));
          } catch {
            // Keep collecting output; the daemon should speak JSON lines.
          }
        }
      });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.on('error', (err) => settle(reject, err));
      child.on('exit', (code, signal) => {
        settle(reject, new Error(`daemon exited before smoke completed (code=${code}, signal=${signal})\n${output.slice(-4_000)}`));
      });
    });
    console.log('[smoke] python daemon responded to bind/list');
  } finally {
    child.stdin.end();
    if (child.exitCode == null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2_000).then(() => {
        if (child.exitCode == null) child.kill('SIGKILL');
      }),
    ]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const appPath = findPackagedApp();
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const appRoot = path.join(resourcesPath, 'app.asar');
const serverEntry = path.join(appRoot, 'dist', 'server', 'index.mjs');
const electronBin = path.join(appPath, 'Contents', 'MacOS', pkg.build?.productName || pkg.name);
const daemonBin = findSidecarExecutable(resourcesPath, 'stashbase-daemon');
const extractBin = findSidecarExecutable(resourcesPath, 'stashbase-extract');
const requireExtract = args.includes('--require-extract')
  || process.env.STASHBASE_REQUIRE_EXTRACT === '1'
  || process.env.STASHBASE_BUILD_EXTRACT === '1';
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
assertFile(daemonBin, 'packaged Python daemon sidecar');
if (requireExtract) assertFile(extractBin, 'packaged Python extractor sidecar');

await smokeDaemon(daemonBin);
if (fs.existsSync(extractBin)) {
  const extractProbe = await runProcess(extractBin, [], { timeoutMs: 5_000 });
  if (extractProbe.code !== 2 || !/usage: stashbase-extract/.test(extractProbe.output)) {
    throw new Error(`unexpected extractor probe result: exit=${extractProbe.code}\n${extractProbe.output.slice(-4_000)}`);
  }
  console.log('[smoke] python extractor responded');
  await smokePdfExtractor(extractBin);
  await smokeOcrExtractor(extractBin);
} else {
  console.log('[smoke] optional Python PDF/OCR extractor not bundled; skipping extractor smoke');
}

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
  await assertPackagedHealth(port, {
    app: 'stashbase',
    ok: true,
    protocolVersion: 1,
    appRoot,
    resourcesPath,
  });
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
