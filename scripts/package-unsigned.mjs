import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const platform = args.includes('--win') ? 'win' : 'mac';
const target = args.includes('--dir')
  ? ['dir']
  : platform === 'win'
    ? ['nsis', 'zip']
    : ['dmg', 'zip'];
const xattr = fs.existsSync('/usr/bin/xattr') ? '/usr/bin/xattr' : 'xattr';
const packageManagerCli = process.env.npm_execpath;
const electronBuilderBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

function clearQuarantine(extraCandidates = []) {
  if (process.platform !== 'darwin') return;
  const candidates = [
    'electron',
    'dist',
    'web',
    'python/stashbase_daemon.py',
    'python/requirements.txt',
    'python/sidecar.nosync',
    'package.json',
    'package-lock.json',
    'node_modules',
    ...extraCandidates,
  ]
    .map((item) => path.join(root, item))
    .filter((item) => fs.existsSync(item));

  if (candidates.length === 0) return;
  run(xattr, ['-cr', ...candidates]);
}

function runScript(script) {
  if (packageManagerCli) {
    run(process.execPath, [packageManagerCli, 'run', script]);
    return;
  }
  run('npm', ['run', script]);
}

function runElectronBuilder() {
  if (!fs.existsSync(electronBuilderBin)) {
    throw new Error('Missing local electron-builder binary. Run your package manager install first.');
  }
  run(electronBuilderBin, [`--${platform}`, ...target], {
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  });
}

function assertWindowsSidecar() {
  if (platform !== 'win') return;
  const sidecar = path.join(root, 'python', 'sidecar.nosync', 'stashbase-daemon.exe');
  if (!fs.existsSync(sidecar)) {
    throw new Error(
      'Windows packaging requires python/sidecar.nosync/stashbase-daemon.exe. ' +
        'Build the Windows Python sidecar on Windows before running `pnpm dist:win`.',
    );
  }
}

if (platform === 'win' && process.platform !== 'win32') {
  assertWindowsSidecar();
  runScript('build');
} else {
  runScript('build:desktop');
  assertWindowsSidecar();
}
clearQuarantine();
runElectronBuilder();
clearQuarantine(['release.nosync']);
