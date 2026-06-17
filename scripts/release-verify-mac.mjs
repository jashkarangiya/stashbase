import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release.nosync');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const productName = pkg.build?.productName || pkg.name;

if (process.platform !== 'darwin') {
  throw new Error('release:verify:mac must run on macOS.');
}

function run(command, args, options = {}) {
  console.log(`[release:verify:mac] ${command} ${args.join(' ')}`);
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
}

function findDmg() {
  const files = fs.existsSync(releaseDir) ? fs.readdirSync(releaseDir) : [];
  const dmgs = files
    .filter((name) => name.endsWith('.dmg'))
    .filter((name) => name.includes(pkg.version))
    .sort()
    .map((name) => path.join(releaseDir, name));
  if (dmgs.length !== 1) {
    throw new Error(
      `Expected exactly one ${pkg.version} DMG in ${releaseDir}, found ${dmgs.length}:\n` +
        dmgs.map((file) => `  ${path.basename(file)}`).join('\n'),
    );
  }
  return dmgs[0];
}

function assertPath(target, label) {
  if (!fs.existsSync(target)) throw new Error(`DMG is missing ${label}: ${target}`);
}

function verifyMountedDmg(dmg) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-dmg-verify-'));
  let attached = false;
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg]);
    attached = true;
    assertPath(path.join(mountPoint, `${productName}.app`), `${productName}.app`);
    assertPath(path.join(mountPoint, 'Fix.sh'), 'Fix.sh');
    assertPath(path.join(mountPoint, 'Read Me.txt'), 'Read Me.txt');
    assertPath(path.join(mountPoint, '.sign-macos-app.sh'), '.sign-macos-app.sh');
    assertPath(path.join(mountPoint, 'Applications'), 'Applications link');
    console.log(`[release:verify:mac] verified DMG contents in ${path.basename(dmg)}`);
  } finally {
    if (attached) {
      run('hdiutil', ['detach', mountPoint]);
    }
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

run(process.execPath, ['scripts/package-unsigned.mjs']);
run(process.execPath, ['scripts/smoke-packaged-server.mjs']);
verifyMountedDmg(findDmg());
console.log('[release:verify:mac] ok');
