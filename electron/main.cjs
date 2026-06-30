/**
 * Electron main process for StashBase.
 *
 * Boots the Express server as a child process, waits for :8090 to
 * answer, then opens the window pointed at localhost. Server logs are
 * inherited to this terminal so `tsx watch` rebuilds + diagnostics
 * surface naturally. Quitting the app kills the server.
 *
 * The renderer is sandboxed; all main → renderer surfaces are exposed
 * through the narrow IPC bridge in preload.cjs.
 */
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { isCompatibleServerHealth } = require('./main-probe.cjs');

function parsePortArg(argv, fallback) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
const SERVER_PORT = parsePortArg(process.argv.slice(1), 8090);

function pythonCandidates(root) {
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

function sidecarExecutable(root, name, opts = {}) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  return opts.direct ? path.join(root, exe) : path.join(root, name, exe);
}

function statIsFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function readFileTail(file, maxBytes = 5000) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function appendServerLogHint(message) {
  const tail = readFileTail(SERVER_LOG_PATH);
  return tail
    ? `${message}\n\nRecent server log:\n${tail}`
    : message;
}

function stopSpawnedServer() {
  const proc = serverProc;
  if (!proc || proc.exitCode != null || proc.signalCode != null) return;
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    if (proc.exitCode == null && proc.signalCode == null) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 1500).unref();
}

// Capture server stdout/stderr to a file the user can `cat` after a
// failed launch. Dock-launched packaged apps inherit Electron's stderr
// which goes to /dev/null, so without this every server crash is
// invisible. Path is shown in the failure dialog.
const SERVER_LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'StashBase');
const SERVER_LOG_PATH = path.join(SERVER_LOG_DIR, 'server.log');
// Use the IPv4 loopback address explicitly. The server binds to
// 127.0.0.1, and `localhost` may resolve to ::1 first on dual-stack
// systems — pointing the renderer at 127.0.0.1 sidesteps the silent
// "can't connect" race.
const SERVER_HOST = '127.0.0.1';
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_PROTOCOL_VERSION = 1;
const PROJECT_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const SERVER_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'server', 'index.mjs')
  : path.join(PROJECT_ROOT, 'server', 'index.ts');
const MCP_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'mcp', 'server.mjs')
  : path.join(PROJECT_ROOT, 'mcp', 'server.ts');
const RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;

let serverProc = null;
const mainWindows = new Set();
let lastMainWindow = null;

const APP_CONFIG_FILE = path.join(os.homedir(), '.stashbase', 'config.json');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readJsonObject(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn(`[electron] ${file} is not a JSON object; leaving untouched`);
  } catch (err) {
    console.warn(`[electron] couldn't parse ${file}: ${err.message}; leaving untouched`);
  }
  return null;
}

function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function readAppConfig() {
  const cfg = readJsonObject(APP_CONFIG_FILE);
  return cfg && typeof cfg === 'object' ? cfg : {};
}

function writeAppConfig(cfg) {
  writeFileAtomic(APP_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

function writeMcpWrapper() {
  const binDir = path.join(os.homedir(), '.stashbase', 'bin');
  const wrapper = path.join(binDir, 'stashbase-mcp');
  const resourcesPath = RESOURCES_ROOT;
  const commandLines = app.isPackaged
    ? [
        'export ELECTRON_RUN_AS_NODE=1',
        `exec ${shellQuote(process.execPath)} ${shellQuote(MCP_ENTRY)} "$@"`,
      ]
    : [
        `exec ${shellQuote(path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'))} ${shellQuote(MCP_ENTRY)} "$@"`,
      ];
  const content = [
    '#!/bin/sh',
    'set -eu',
    `export STASHBASE_APP_ROOT=${shellQuote(PROJECT_ROOT)}`,
    `export STASHBASE_RESOURCES_PATH=${shellQuote(resourcesPath)}`,
    ...commandLines,
    '',
  ].join('\n');
  writeFileAtomic(wrapper, content, { mode: 0o755 });
  return wrapper;
}

function configureJsonMcp(file, serverConfig) {
  const config = readJsonObject(file);
  if (!config) throw new Error(`Couldn't parse ${file}; leaving it untouched.`);
  const currentServers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
  config.mcpServers = {
    ...currentServers,
    stashbase: serverConfig,
  };
  writeJson(file, config);
}

function removeJsonMcp(file) {
  if (!fs.existsSync(file)) return;
  const config = readJsonObject(file);
  if (!config) throw new Error(`Couldn't parse ${file}; leaving it untouched.`);
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  delete servers.stashbase;
  if (Object.keys(servers).length === 0) delete config.mcpServers;
  writeJson(file, config);
}

function replaceTomlTable(raw, tableName, block) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  const headerRe = /^\s*\[([^\]]+)\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRe);
    if (!match || match[1] !== tableName) {
      out.push(lines[i]);
      continue;
    }
    i += 1;
    while (i < lines.length) {
      const nextMatch = lines[i].match(headerRe);
      if (nextMatch && nextMatch[1] !== tableName && !nextMatch[1].startsWith(`${tableName}.`)) {
        break;
      }
      i += 1;
    }
    i -= 1;
  }
  const trimmed = out.join('\n').trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ''}${block}\n`;
}

function configureCodex(wrapper) {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = [
    '[mcp_servers.stashbase]',
    `command = ${JSON.stringify(wrapper)}`,
  ].join('\n');
  writeFileAtomic(file, replaceTomlTable(raw, 'mcp_servers.stashbase', block));
  return true;
}

function removeTomlTable(raw, tableName) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  const headerRe = /^\s*\[([^\]]+)\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRe);
    if (!match || match[1] !== tableName) {
      out.push(lines[i]);
      continue;
    }
    i += 1;
    while (i < lines.length) {
      const nextMatch = lines[i].match(headerRe);
      if (nextMatch && nextMatch[1] !== tableName && !nextMatch[1].startsWith(`${tableName}.`)) {
        break;
      }
      i += 1;
    }
    i -= 1;
  }
  const trimmed = out.join('\n').trimEnd();
  return trimmed ? `${trimmed}\n` : '';
}

function removeCodex() {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(file)) return true;
  const raw = fs.readFileSync(file, 'utf8');
  writeFileAtomic(file, removeTomlTable(raw, 'mcp_servers.stashbase'));
  return true;
}

function writeFileAtomic(file, content, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const nonce = Math.random().toString(36).slice(2);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${nonce}.tmp`);
  try {
    fs.writeFileSync(tmp, content, options);
    fs.renameSync(tmp, file);
    if (typeof options.mode === 'number') {
      try { fs.chmodSync(file, options.mode); } catch { /* best-effort */ }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

function getStandardMcpJson(wrapper) {
  return {
    mcpServers: {
      stashbase: {
        command: wrapper,
      },
    },
  };
}

// Only these three clients support one-click auto-connect; every other client
// gets the standard config to paste. Mirror of server/routes/mcp.ts.
function configureMcpClient(client) {
  if (!fs.existsSync(MCP_ENTRY)) {
    throw new Error(`MCP entry missing: ${MCP_ENTRY}`);
  }

  const wrapper = writeMcpWrapper();
  if (client === 'claude-desktop') {
    if (process.platform !== 'darwin') {
      throw new Error('Claude Desktop auto configuration is currently supported on macOS only.');
    }
    const file = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
    configureJsonMcp(file, { command: wrapper });
    return { client, file, command: wrapper, manual: getStandardMcpJson(wrapper), mode: 'file' };
  }
  if (client === 'claude-code') {
    const file = path.join(os.homedir(), '.claude.json');
    configureJsonMcp(file, { type: 'stdio', command: wrapper });
    return { client, file, command: wrapper, manual: getStandardMcpJson(wrapper), mode: 'file' };
  }
  if (client === 'codex-cli') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    configureCodex(wrapper);
    return { client, file, command: wrapper, manual: getStandardMcpJson(wrapper), mode: 'file' };
  }
  // Everything else: hand back the standard stdio config to paste manually.
  return { client, command: wrapper, manual: getStandardMcpJson(wrapper), mode: 'clipboard' };
}

function disconnectMcpClient(client) {
  if (client === 'claude-desktop') {
    if (process.platform !== 'darwin') {
      throw new Error('Claude Desktop auto configuration is currently supported on macOS only.');
    }
    const file = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
    removeJsonMcp(file);
    return { client, file, mode: 'file' };
  }
  if (client === 'claude-code') {
    const file = path.join(os.homedir(), '.claude.json');
    removeJsonMcp(file);
    return { client, file, mode: 'file' };
  }
  if (client === 'codex-cli') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    removeCodex();
    return { client, file, mode: 'file' };
  }
  throw new Error(`${client} configuration is managed outside StashBase. Remove the pasted stashbase server from that client.`);
}

/** Spawn the Express server as a child. If something else is already on
 *  the port (e.g. you've got `pnpm dev` running in a terminal), we
 *  skip the spawn and just point the window at it — handy for editing
 *  the server in your editor with tsx-watch hot reload. */
async function ensureServer() {
  const existing = await probeServer(SERVER_PORT, 300);
  if (existing.compatible) {
    console.log(`[electron] reusing existing server at ${SERVER_URL}`);
    return;
  }
  if (existing.occupied) {
    const what = existing.legacyStashBase
      ? 'an older StashBase server'
      : 'another local service';
    throw new Error(
      `Port ${SERVER_PORT} is already in use by ${what}, so this StashBase build cannot start its server.\n` +
      `Quit the other StashBase/app using ${SERVER_URL}, then reopen StashBase.`,
    );
  }
  const serverBin = app.isPackaged
    ? process.execPath
    : path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  // `watch` mode in dev so server-side edits hot-reload without a full
  // app restart. Packaged builds run the pre-bundled Node entry through
  // Electron's embedded Node runtime. `--port=N` is appended only when
  // overriding the default so the server's argv parser sees the standard
  // CLI flag (matches the `npm start -- --port=...` workflow).
  const portArgs = SERVER_PORT === 8090 ? [] : [`--port=${SERVER_PORT}`];
  const serverArgs = app.isPackaged
    ? [SERVER_ENTRY, ...portArgs]
    : ['watch', SERVER_ENTRY, ...portArgs];
  // In packaged builds the Python sidecar lives under
  // `process.resourcesPath` (electron-builder `extraResources`). In dev
  // tsx finds python via the local venv, so we only override when
  // packaged. Model weights are cached by huggingface_hub under
  // `~/.cache/huggingface/` regardless of dev vs packaged.
  const packagedPythonCandidates = [
    ...pythonCandidates(path.join(RESOURCES_ROOT, 'python', 'runtime')),
    ...pythonCandidates(path.join(RESOURCES_ROOT, 'python', '.venv')),
  ];
  const packagedPython = packagedPythonCandidates.find((candidate) => {
    try { return require('node:fs').existsSync(candidate); } catch { return false; }
  });
  // PyInstaller --onedir lays out the bundle as
  // `sidecar/stashbase-daemon/stashbase-daemon` (outer name = dir,
  // inner name = executable). The --onefile layout used to put the
  // executable directly at `sidecar/stashbase-daemon`, so check both
  // for forward compat with anyone still on the old layout, and stat
  // each candidate as a *file* — spawn-ing the outer directory by
  // mistake yields EACCES with no useful hint.
  const packagedDaemonCandidates = [
    sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-daemon'),
    sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-daemon', { direct: true }),
  ];
  const packagedDaemon = packagedDaemonCandidates.find((candidate) => {
    return statIsFile(candidate);
  });
  const hasPackagedDaemon = Boolean(packagedDaemon);
  // The PDF / OCR extractors ship as a second PyInstaller --onedir bundle
  // (`sidecar/stashbase-extract/stashbase-extract`) so the packaged app can
  // run them without a Python interpreter — there's no bundled venv. The
  // server (pdf.ts / image.ts) spawns this binary with a `pdf` / `ocr`
  // subcommand when STASHBASE_EXTRACT_BIN is set; in dev it spawns the
  // scripts via the local venv instead.
  const packagedExtractCandidates = [
    sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-extract'),
    sidecarExecutable(path.join(RESOURCES_ROOT, 'python', 'sidecar'), 'stashbase-extract', { direct: true }),
  ];
  const packagedExtract = packagedExtractCandidates.find((candidate) => {
    return statIsFile(candidate);
  });
  const hasPackagedExtract = Boolean(packagedExtract);
  const packagedDaemonScript = path.join(RESOURCES_ROOT, 'python', 'stashbase_daemon.py');
  const packagedPdfScript = path.join(RESOURCES_ROOT, 'python', 'pdf_extract.py');
  const packagedOcrScript = path.join(RESOURCES_ROOT, 'python', 'ocr_extract.py');
  if (app.isPackaged) {
    if (!statIsFile(SERVER_ENTRY)) {
      throw new Error(`Packaged server entry is missing: ${SERVER_ENTRY}`);
    }
    if (!hasPackagedDaemon && !(packagedPython && statIsFile(packagedDaemonScript))) {
      throw new Error(
        'Packaged Python daemon is missing. Rebuild with `pnpm build:python-sidecar` and package again.\n' +
        `Looked for: ${packagedDaemonCandidates.join(', ')}\n` +
        `Fallback script: ${packagedDaemonScript}`,
      );
    }
  }
  const packagedEnv = app.isPackaged
    ? {
        ELECTRON_RUN_AS_NODE: '1',
        STASHBASE_APP_ROOT: PROJECT_ROOT,
        STASHBASE_RESOURCES_PATH: RESOURCES_ROOT,
        ...(hasPackagedDaemon ? { STASHBASE_DAEMON_BIN: packagedDaemon } : {}),
        ...(hasPackagedExtract ? { STASHBASE_EXTRACT_BIN: packagedExtract } : {}),
        ...(packagedPython ? { STASHBASE_PYTHON: packagedPython } : {}),
      }
    : { STASHBASE_APP_ROOT: PROJECT_ROOT };
  // In packaged+asar mode PROJECT_ROOT is `.../Resources/app.asar` —
  // a FILE, not a directory. spawn(cwd) hits the OS syscall (no
  // electron asar shim) and bails with ENOTDIR. Use the real
  // Resources/ directory there; in dev keep PROJECT_ROOT (the repo).
  const serverCwd = app.isPackaged ? RESOURCES_ROOT : PROJECT_ROOT;
  // Tee server output to a per-launch log file in ~/Library/Logs/StashBase/
  // so a packaged Dock launch is debuggable, AND to the parent stdio so
  // `pnpm electron` from a terminal still shows live logs. The file is
  // truncated each launch — old crashes would only confuse the user.
  fs.mkdirSync(SERVER_LOG_DIR, { recursive: true });
  const logFd = fs.openSync(SERVER_LOG_PATH, 'w');
  fs.writeSync(
    logFd,
    `--- StashBase server launch ${new Date().toISOString()} (pid=${process.pid}, packaged=${app.isPackaged}) ---\n`,
  );
  fs.writeSync(logFd, `server entry: ${SERVER_ENTRY}\n`);
  fs.writeSync(logFd, `server cwd: ${serverCwd}\n`);
  if (app.isPackaged) {
    fs.writeSync(logFd, `resources: ${RESOURCES_ROOT}\n`);
    fs.writeSync(logFd, `daemon: ${packagedDaemon || '(missing; using Python script fallback if available)'}\n`);
    fs.writeSync(logFd, `extractor: ${packagedExtract || '(missing; using Python script fallback if available)'}\n`);
    fs.writeSync(logFd, `python: ${packagedPython || '(missing)'}\n`);
    if (!hasPackagedExtract && !(packagedPython && statIsFile(packagedPdfScript) && statIsFile(packagedOcrScript))) {
      fs.writeSync(
        logFd,
        'warning: packaged extractor resources are missing; PDF/image text extraction will fail until the package is rebuilt\n',
      );
    }
  }
  serverProc = spawn(serverBin, serverArgs, {
    cwd: serverCwd,
    // Port flows via the CLI arg above, not the env — keeps the server
    // entry's argv parser the single source of truth for port config.
    env: { ...process.env, ...packagedEnv },
    // stdin = 'ignore' is intentional: the server never reads from
    // stdin, and inheriting the parent's TTY made Node attach a real
    // TTY ReadStream to the child's fd 0. Any flake on that TTY
    // (shell repaint, tmux/screen detach, Ctrl-Z, terminal closed
    // while the app was still running) emitted an `EIO` on the
    // unread stream which had no listener → unhandled 'error'
    // event, killed the whole electron process. Closing stdin
    // entirely sidesteps the class of bug.
    // stdout + stderr go to the per-launch log file so dock launches
    // are debuggable; terminal launches can `tail -f` the same file.
    stdio: ['ignore', logFd, logFd],
  });
  try { fs.closeSync(logFd); } catch { /* child owns its dup */ }
  // `spawn` can fail asynchronously (ENOENT when tsx isn't installed,
  // permission errors, etc.). Without an explicit listener Node treats
  // the 'error' event as fatal and the whole Electron process crashes
  // with an unhelpful stack — surface a useful message instead.
  let serverSpawnError = null;
  serverProc.on('error', (err) => {
    serverSpawnError = err;
    console.warn(`[electron] server spawn failed: ${err.message}`);
    if (err.code === 'ENOENT') {
      console.warn(`[electron]   couldn't find ${serverBin}. ` +
        `Run \`pnpm install\` to populate node_modules/.bin.`);
    }
  });
  serverProc.on('exit', (code) => {
    if (code != null && code !== 0) {
      console.warn(`[electron] server exited with code ${code}`);
    }
  });
  // Poll until the server is up. Embedding cold-start on first model load
  // call can be slow, but listen() is sub-second — 10s ceiling is
  // generous; we surface a clear error rather than hanging forever.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverSpawnError) {
      throw new Error(appendServerLogHint(`server spawn failed: ${serverSpawnError.message}`));
    }
    if ((await probeServer(SERVER_PORT, 200)).compatible) return;
    if (serverProc.exitCode != null || serverProc.signalCode != null) {
      const detail = serverProc.exitCode != null
        ? `server exited with code ${serverProc.exitCode}`
        : `server exited with signal ${serverProc.signalCode}`;
      throw new Error(appendServerLogHint(`${detail} before reporting healthy on :${SERVER_PORT}`));
    }
    await sleep(150);
  }
  stopSpawnedServer();
  throw new Error(appendServerLogHint(`server did not come up on :${SERVER_PORT} within 10s`));
}

async function probeServer(port, timeoutMs) {
  const health = await requestJson(port, '/api/health', timeoutMs);
  if (!health.reachable) return { compatible: false, occupied: false, legacyStashBase: false };
  if (
    health.statusCode === 200 &&
    isCompatibleServerHealth(health.body, {
      protocolVersion: SERVER_PROTOCOL_VERSION,
      appRoot: PROJECT_ROOT,
      resourcesPath: RESOURCES_ROOT,
    })
  ) {
    return { compatible: true, occupied: true, legacyStashBase: false };
  }

  const folder = await requestJson(port, '/api/folder', timeoutMs);
  const legacyStashBase =
    folder.statusCode === 200 &&
    folder.body &&
    typeof folder.body === 'object' &&
    ('current' in folder.body || 'recent' in folder.body) &&
    'homeDir' in folder.body;
  return { compatible: false, occupied: true, legacyStashBase };
}

function requestJson(port, requestPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: SERVER_HOST, port, path: requestPath, method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ reachable: true, statusCode: res.statusCode ?? 0, body: JSON.parse(body) });
          } catch {
            resolve({ reachable: true, statusCode: res.statusCode ?? 0, body: null });
          }
        });
      },
    );
    req.on('error', () => resolve({ reachable: false, statusCode: 0, body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, statusCode: 0, body: null });
    });
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAppUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin === new URL(SERVER_URL).origin;
  } catch {
    return false;
  }
}

async function openExternalUnchecked(rawUrl, label = 'external URL') {
  try {
    await shell.openExternal(rawUrl);
    return { ok: true };
  } catch (err) {
    const message = err && typeof err.message === 'string' ? err.message : String(err);
    console.warn(`[electron] failed to open ${label}: ${message}`);
    return { ok: false, error: message };
  }
}

async function openHttpExternal(rawUrl, label = 'external URL') {
  if (typeof rawUrl !== 'string' || !isHttpUrl(rawUrl)) return false;
  const result = await openExternalUnchecked(rawUrl, label);
  return result.ok;
}

function isLiveMainWindow(win) {
  return !!(win && mainWindows.has(win) && !win.isDestroyed());
}

// --- Clipboard image offer ---------------------------------------------
// When a main window regains focus we peek at the clipboard: if it holds
// an image we haven't offered yet (e.g. the user just took a screenshot
// with Cmd+Ctrl+Shift+4, which copies to the clipboard, then switched
// back), we ping the renderer to ask "add this to the library?". Reading
// the clipboard is cheap; we hash the PNG bytes so the same image is only
// offered once — dismiss is final until the clipboard content changes.
// Default-on; toggleable from the renderer via `clipboard:setWatch`.
let clipboardWatchEnabled = true;
let lastClipboardOfferHash = null;

function clipboardImageFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `clipboard-${stamp}.png`;
}

function offerClipboardImage(win) {
  if (!clipboardWatchEnabled) return;
  if (!win || win.isDestroyed()) return;
  let img;
  try {
    img = clipboard.readImage();
  } catch {
    return;
  }
  if (!img || img.isEmpty()) return;
  let png;
  try {
    png = img.toPNG();
  } catch {
    return;
  }
  if (!png || !png.length) return;
  const hash = crypto.createHash('sha1').update(png).digest('hex');
  // Same image we've already offered (or one the renderer just imported,
  // which calls clipboard:markHandled). Don't re-prompt on every focus.
  if (hash === lastClipboardOfferHash) return;
  lastClipboardOfferHash = hash;
  const size = img.getSize();
  win.webContents.send('clipboard:image-available', {
    dataUrl: img.toDataURL(),
    mime: 'image/png',
    width: size.width,
    height: size.height,
    hash,
    filename: clipboardImageFilename(),
  });
}

// Poll the clipboard while a StashBase window is focused so a system
// screenshot taken *while browsing* (⌘⇧⌃4 copies to the clipboard) is
// offered the instant macOS finishes writing it. The bare 'focus' read
// alone raced that async write — the bytes often land just after focus
// returns, so the single read came up empty and the offer didn't appear
// until the user manually clicked away and back. The timer self-stops
// once focus leaves a main window, so we never poll while the user is in
// another app. `offerClipboardImage` already dedups by hash, so a clip
// sitting in the clipboard is encoded+offered once, not every tick.
let clipboardPollTimer = null;
const CLIPBOARD_POLL_MS = 600;
function startClipboardPolling() {
  if (clipboardPollTimer || !clipboardWatchEnabled) return;
  clipboardPollTimer = setInterval(() => {
    const win = BrowserWindow.getFocusedWindow();
    if (win && mainWindows.has(win) && !win.isDestroyed()) offerClipboardImage(win);
    else stopClipboardPolling();
  }, CLIPBOARD_POLL_MS);
}
function stopClipboardPolling() {
  if (clipboardPollTimer) {
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
  }
}

async function createWindow(initialFolder) {
  try {
    await ensureServer();
  } catch (err) {
    dialog.showErrorBox(
      'StashBase failed to start',
      `${String(err?.message ?? err)}\n\nServer log: ${SERVER_LOG_PATH}`,
    );
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    // OS-level title (Dock right-click, Cmd+Tab, mission control) —
    // the visible app-name in the window itself is drawn by HTML in a
    // custom titlebar so we control typography and color seamlessly
    // (see `.electron-titlebar` rule).
    title: 'StashBase',
    backgroundColor: '#fafafa',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `require` for ipcRenderer
    },
  });
  mainWindows.add(win);
  lastMainWindow = win;
  win.on('focus', () => {
    lastMainWindow = win;
    offerClipboardImage(win);
    startClipboardPolling();
  });
  win.on('closed', () => {
    mainWindows.delete(win);
    if (lastMainWindow === win) lastMainWindow = null;
    if (mainWindows.size === 0) {
      if (process.platform !== 'darwin') app.quit();
    }
  });

  // External links → OS default browser. Anything else (popups,
  // accidental navigation away from the app shell) gets denied so the
  // main window stays anchored at SERVER_URL.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) void openHttpExternal(url, 'window-open URL');
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    void openHttpExternal(url, 'navigation URL');
  });

  // macOS fullscreen hides the traffic lights, so the chrome strip
  // shouldn't reserve room for them. Push state to the renderer so CSS
  // can flip a body class. Send the initial state once the renderer is
  // up in case the window started fullscreen (rare but possible via
  // `Restore Window` on relaunch).
  function pushFullscreen() {
    if (win.isDestroyed()) return;
    win.webContents.send('fullscreen-change', win.isFullScreen());
  }
  win.on('enter-full-screen', pushFullscreen);
  win.on('leave-full-screen', pushFullscreen);
  win.webContents.on('did-finish-load', pushFullscreen);

  // Swallow ⌘R / Ctrl+R from the keyboard. Electron's default View
  // menu binds it to "Reload", which does a full renderer re-mount —
  // dropping all tab / nav / search state on the floor. The intentional
  // "back to Welcome" path is the Home icon in the chrome strip
  // (`actions.goHome()`), which resets tabs cleanly without re-mounting.
  // The View → Reload menu item is left in place as an escape hatch
  // (mouse click); only the keyboard chord is gone.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!(input.meta || input.control)) return;
    if (input.shift) return; // ⌘⇧R (Force Reload) stays — dev escape hatch.
    if (input.key.toLowerCase() === 'r') event.preventDefault();
  });

  const url = initialFolder
    ? `${SERVER_URL}/?folder=${encodeURIComponent(initialFolder)}`
    : SERVER_URL;
  win.loadURL(url);
  return win;
}

// Folder picker for Open/New folder flows. `defaultPath` lets New
// folder start at `~/Documents/StashBase`, while the OS panel owns the
// actual directory creation affordance.
ipcMain.handle('dialog:openFolder', async (_e, opts = {}) => {
  const properties = ['openDirectory'];
  if (opts.allowCreateDirectory !== false) properties.push('createDirectory');
  const dialogOpts = {
    title: opts.title || 'Choose a folder',
    buttonLabel: opts.buttonLabel || 'Choose',
    properties,
  };
  if (typeof opts.defaultPath === 'string' && opts.defaultPath) {
    dialogOpts.defaultPath = opts.defaultPath;
  }
  const focused = BrowserWindow.getFocusedWindow();
  const result = focused
    ? await dialog.showOpenDialog(focused, dialogOpts)
    : await dialog.showOpenDialog(dialogOpts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Renderer-initiated external link → OS default browser. Validates the
// scheme so an injected `file://` / `javascript:` URL can't smuggle a
// local navigation through us.
ipcMain.handle('shell:openExternal', async (_e, url) => {
  return openHttpExternal(url, 'renderer external URL');
});

ipcMain.handle('mcp:configure', async (_e, client) => {
  if (typeof client !== 'string') {
    return { ok: false, error: 'Invalid MCP client.' };
  }
  try {
    const result = configureMcpClient(client);
    return { ok: true, ...result };
  } catch (err) {
    const message = err && typeof err.message === 'string' ? err.message : String(err);
    return { ok: false, error: message };
  }
});

ipcMain.handle('mcp:disconnect', async (_e, client) => {
  if (typeof client !== 'string') {
    return { ok: false, error: 'Invalid MCP client.' };
  }
  try {
    const result = disconnectMcpClient(client);
    return { ok: true, ...result };
  } catch (err) {
    const message = err && typeof err.message === 'string' ? err.message : String(err);
    return { ok: false, error: message };
  }
});

ipcMain.handle('window:openFolder', async (_e, name) => {
  if (typeof name !== 'string' || !name.trim()) return false;
  await createWindow(name.trim());
  return true;
});

// Renderer toggles clipboard-image watching (privacy switch). When
// turning it back on we clear the last-offered hash so the current
// clipboard image becomes eligible again.
ipcMain.handle('clipboard:setWatch', (_event, enabled) => {
  clipboardWatchEnabled = enabled !== false;
  if (clipboardWatchEnabled) {
    lastClipboardOfferHash = null;
    const win = BrowserWindow.getFocusedWindow();
    if (win && mainWindows.has(win)) { offerClipboardImage(win); startClipboardPolling(); }
  } else {
    stopClipboardPolling();
  }
  return clipboardWatchEnabled;
});

// Renderer confirms it imported (or chose to keep ignoring) a clipboard
// image; remember the hash so re-focus doesn't re-offer the same one.
ipcMain.on('clipboard:markHandled', (_event, hash) => {
  if (typeof hash === 'string' && hash) lastClipboardOfferHash = hash;
});


app.whenReady().then(async () => {
  // Refresh the MCP wrapper on every launch so the most recently-opened
  // app owns it. Without this, a wrapper written by an earlier `pnpm
  // dev` run still points at a vanished `node_modules/.bin/tsx`, and
  // Claude Code / Claude Desktop spawn it after a brew install with
  // "command not found" (or, on macOS, "Operation not permitted" when
  // the old path is under ~/Downloads and TCC blocks it). Skip silently
  // if the entry for *this* app isn't on disk — partial dev checkouts
  // shouldn't clobber a working packaged wrapper.
  try {
    if (fs.existsSync(MCP_ENTRY)) writeMcpWrapper();
  } catch (err) {
    console.warn(`[electron] MCP wrapper refresh failed: ${err && err.message ? err.message : err}`);
  }
  await createWindow();
});

app.on('activate', () => {
  if (mainWindows.size === 0) {
    void createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Drag the server down with us on real shutdown. macOS keeps the
// process alive on window-close (Cmd+Q is the actual quit signal), so
// we hook `will-quit` rather than `window-all-closed` here.
//
// We need to **wait** for the server to actually exit before quitting
// Electron — otherwise the Python daemon orphans, still holding
// Milvus Lite's flock, and the next launch fails to open the DB.
// Hard 4 s ceiling so a stuck server can't pin the Electron quit.
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  if (!serverProc || serverProc.killed) return;
  event.preventDefault();
  quitting = true;
  serverProc.kill('SIGTERM');
  const fallback = setTimeout(() => app.exit(0), 4000);
  serverProc.once('exit', () => {
    clearTimeout(fallback);
    app.exit(0);
  });
});
