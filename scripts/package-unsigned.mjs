import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const platform = args.includes('--linux') ? 'linux' : args.includes('--win') ? 'win' : 'mac';
const target = args.includes('--dir')
  ? ['dir']
  : platform === 'win'
    ? ['nsis', 'zip']
    : platform === 'linux'
      ? ['deb']
      : ['dmg', 'zip'];
const xattr = fs.existsSync('/usr/bin/xattr') ? '/usr/bin/xattr' : 'xattr';
const packageManagerCli = process.env.npm_execpath;
const electronBuilderBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
const pnpmListFallback = path.join(root, 'scripts', 'pnpm-list-for-electron-builder.mjs');

function run(command, args, env = {}) {
  execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

function findCommand(command) {
  try {
    return execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function clearQuarantine(extraCandidates = []) {
  if (process.platform !== 'darwin') return;
  const candidates = [
    'electron',
    'dist',
    'web',
    'python/stashbase_daemon.py',
    'python/requirements.txt',
    'python/requirements-extract.txt',
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
  assertPnpmCollectorInput();
  const fallback = preparePnpmCollectorFallback();
  try {
    run(electronBuilderBin, [`--${platform}`, ...target], {
      ...fallback.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    });
  } finally {
    fallback.cleanup();
  }
}

function assertPnpmCollectorInput() {
  if (!fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return;
  try {
    execFileSync(process.execPath, [pnpmListFallback, root], {
      cwd: root,
      stdio: 'ignore',
    });
  } catch (err) {
    throw new Error(
      `Unable to synthesize electron-builder's pnpm dependency tree fallback: ${err.message}`,
    );
  }
}

function preparePnpmCollectorFallback() {
  if (!fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    return { env: {}, cleanup() {} };
  }
  const realPnpm = findCommand('pnpm');
  if (!realPnpm) return { env: {}, cleanup() {} };

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stashbase-pnpm-wrapper-'));
  const wrapper = path.join(binDir, 'pnpm');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "list" ]; then
  exec "${process.execPath}" "${pnpmListFallback}" "${root}"
fi
exec "${realPnpm}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  return {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      STASHBASE_REAL_PNPM: realPnpm,
    },
    cleanup() {
      fs.rmSync(binDir, { recursive: true, force: true });
    },
  };
}

function sidecarCandidates(name) {
  const exe = process.platform === 'win32' || platform === 'win' ? `${name}.exe` : name;
  return [
    path.join(root, 'python', 'sidecar.nosync', name, exe),
    path.join(root, 'python', 'sidecar.nosync', exe),
  ];
}

function assertSidecarsForPlatform() {
  const daemon = sidecarCandidates('stashbase-daemon').find((candidate) => fs.existsSync(candidate));
  const extract = sidecarCandidates('stashbase-extract').find((candidate) => fs.existsSync(candidate));
  const requireExtract = process.env.STASHBASE_REQUIRE_EXTRACT === '1' || process.env.STASHBASE_BUILD_EXTRACT === '1';
  if (daemon && (extract || !requireExtract)) {
    if (!extract) {
      console.warn(
        `[package] optional PDF/OCR extractor sidecar not found; packaged local PDF/OCR extraction will be disabled.\n` +
          `          To include it, run with STASHBASE_BUILD_EXTRACT=1.`,
      );
    }
    return;
  }

  const expected = sidecarCandidates('stashbase-daemon')[0];
  const extractExpected = sidecarCandidates('stashbase-extract')[0];
  const hint = platform === 'win'
    ? 'Build the Windows Python sidecars on Windows before running `pnpm dist:win` from another OS.'
    : requireExtract
      ? 'Run `STASHBASE_BUILD_EXTRACT=1 pnpm build:python-sidecar` before packaging.'
      : 'Run `pnpm build:python-sidecar` before packaging.';
  const missing = [
    daemon ? null : path.relative(root, expected),
    requireExtract && !extract ? path.relative(root, extractExpected) : null,
  ].filter(Boolean);
  throw new Error(
    `${platform} packaging requires missing Python sidecar${missing.length === 1 ? '' : 's'}:\n` +
      missing.map((item) => `  - ${item}`).join('\n') +
      `\n${hint}`,
  );
}

if (platform === 'win' && process.platform !== 'win32') {
  assertSidecarsForPlatform();
  runScript('build');
} else {
  runScript('build:desktop');
  assertSidecarsForPlatform();
}
clearQuarantine();
runElectronBuilder();
clearQuarantine(['release.nosync']);
