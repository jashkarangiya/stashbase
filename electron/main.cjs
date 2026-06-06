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
const { app, BrowserWindow, Menu, clipboard, desktopCapturer, dialog, ipcMain, screen, session, shell, systemPreferences } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

function parsePortArg(argv, fallback) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
const SERVER_PORT = parsePortArg(process.argv.slice(1), 8090);

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
const PROJECT_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const SERVER_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'server', 'index.mjs')
  : path.join(PROJECT_ROOT, 'server', 'index.ts');
const MCP_ENTRY = app.isPackaged
  ? path.join(PROJECT_ROOT, 'dist', 'mcp', 'server.mjs')
  : path.join(PROJECT_ROOT, 'mcp', 'server.ts');

let serverProc = null;
const mainWindows = new Set();
let lastMainWindow = null;
let floatingBallWindow = null;
let capturePickerWindow = null;
let activeRecording = null;
let recordingStopTimer = null;

const APP_CONFIG_FILE = path.join(os.homedir(), '.stashbase', 'config.json');
const MAX_RECORDING_BYTES = 150 * 1024 * 1024;

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readAppConfig() {
  const cfg = readJsonObject(APP_CONFIG_FILE);
  return cfg && typeof cfg === 'object' ? cfg : {};
}

function writeAppConfig(cfg) {
  fs.mkdirSync(path.dirname(APP_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(APP_CONFIG_FILE, 0o600); } catch { /* best-effort */ }
}

function writeMcpWrapper() {
  const binDir = path.join(os.homedir(), '.stashbase', 'bin');
  const wrapper = path.join(binDir, 'stashbase-mcp');
  const resourcesPath = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;
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
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(wrapper, content, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function configureJsonMcp(file, serverConfig) {
  const config = readJsonObject(file);
  if (!config) return false;
  const currentServers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
  config.mcpServers = {
    ...currentServers,
    stashbase: serverConfig,
  };
  writeJson(file, config);
  return true;
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, replaceTomlTable(raw, 'mcp_servers.stashbase', block));
  return true;
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

/** Spawn the Express server as a child. If something else is already on
 *  the port (e.g. you've got `pnpm dev` running in a terminal), we
 *  skip the spawn and just point the window at it — handy for editing
 *  the server in your editor with tsx-watch hot reload. */
async function ensureServer() {
  if (await isServerLive(SERVER_PORT, 300)) {
    console.log(`[electron] reusing existing server at ${SERVER_URL}`);
    return;
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
    path.join(process.resourcesPath, 'python', 'runtime', 'bin', 'python'),
    path.join(process.resourcesPath, 'python', '.venv', 'bin', 'python'),
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
    path.join(process.resourcesPath, 'python', 'sidecar', 'stashbase-daemon', 'stashbase-daemon'),
    path.join(process.resourcesPath, 'python', 'sidecar', 'stashbase-daemon'),
  ];
  const packagedDaemon = packagedDaemonCandidates.find((candidate) => {
    try { return require('node:fs').statSync(candidate).isFile(); } catch { return false; }
  });
  const hasPackagedDaemon = Boolean(packagedDaemon);
  // The PDF / OCR extractors ship as a second PyInstaller --onedir bundle
  // (`sidecar/stashbase-extract/stashbase-extract`) so the packaged app can
  // run them without a Python interpreter — there's no bundled venv. The
  // server (pdf.ts / image.ts) spawns this binary with a `pdf` / `ocr`
  // subcommand when STASHBASE_EXTRACT_BIN is set; in dev it spawns the
  // scripts via the local venv instead.
  const packagedExtract = path.join(
    process.resourcesPath, 'python', 'sidecar', 'stashbase-extract', 'stashbase-extract',
  );
  const hasPackagedExtract = (() => {
    try { return require('node:fs').statSync(packagedExtract).isFile(); } catch { return false; }
  })();
  const packagedEnv = app.isPackaged
    ? {
        ELECTRON_RUN_AS_NODE: '1',
        STASHBASE_APP_ROOT: PROJECT_ROOT,
        STASHBASE_RESOURCES_PATH: process.resourcesPath,
        ...(hasPackagedDaemon ? { STASHBASE_DAEMON_BIN: packagedDaemon } : {}),
        ...(hasPackagedExtract ? { STASHBASE_EXTRACT_BIN: packagedExtract } : {}),
        ...(packagedPython ? { STASHBASE_PYTHON: packagedPython } : {}),
      }
    : { STASHBASE_APP_ROOT: PROJECT_ROOT };
  // In packaged+asar mode PROJECT_ROOT is `.../Resources/app.asar` —
  // a FILE, not a directory. spawn(cwd) hits the OS syscall (no
  // electron asar shim) and bails with ENOTDIR. Use the real
  // Resources/ directory there; in dev keep PROJECT_ROOT (the repo).
  const serverCwd = app.isPackaged ? process.resourcesPath : PROJECT_ROOT;
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
  // `spawn` can fail asynchronously (ENOENT when tsx isn't installed,
  // permission errors, etc.). Without an explicit listener Node treats
  // the 'error' event as fatal and the whole Electron process crashes
  // with an unhelpful stack — surface a useful message instead.
  serverProc.on('error', (err) => {
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
    if (await isServerLive(SERVER_PORT, 200)) return;
    await sleep(150);
  }
  throw new Error(`server did not come up on :${SERVER_PORT} within 10s`);
}

function isServerLive(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: SERVER_HOST, port, path: '/api/space', method: 'GET', timeout: timeoutMs },
      (res) => { res.resume(); resolve(true); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
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

function getMainTargetWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && mainWindows.has(focused) && !focused.isDestroyed()) return focused;
  if (lastMainWindow && mainWindows.has(lastMainWindow) && !lastMainWindow.isDestroyed()) return lastMainWindow;
  for (const win of Array.from(mainWindows)) {
    if (!win.isDestroyed()) return win;
  }
  return null;
}

function emitCaptureCreated(capture) {
  const target = getMainTargetWindow();
  if (!target) return false;
  target.webContents.send('capture:created', capture);
  if (target.isMinimized()) target.restore();
  target.show();
  return true;
}

function emitCaptureError(error) {
  const target = getMainTargetWindow();
  if (!target) return false;
  target.webContents.send('capture:error', error);
  return true;
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

function emitRecordingCreated(recording) {
  const target = getMainTargetWindow();
  if (!target) return false;
  target.webContents.send('recording:created', recording);
  if (target.isMinimized()) target.restore();
  return true;
}

function emitRecordingError(error) {
  const target = getMainTargetWindow();
  if (!target) return false;
  target.webContents.send('recording:error', error);
  return true;
}

function emitRecordingStatus(status) {
  const target = getMainTargetWindow();
  if (target) target.webContents.send('recording:status', status);
  if (floatingBallWindow && !floatingBallWindow.isDestroyed()) {
    floatingBallWindow.webContents.send('recording:status', status);
  }
}

function getScreenPermission() {
  if (process.platform !== 'darwin') {
    return {
      platform: process.platform,
      status: 'granted',
      needsGuide: false,
      canOpenSettings: false,
    };
  }
  let status = 'unknown';
  try {
    status = systemPreferences.getMediaAccessStatus('screen');
  } catch {
    status = 'unknown';
  }
  return {
    platform: 'darwin',
    status,
    needsGuide: status !== 'granted',
    canOpenSettings: true,
  };
}

function screenPermissionHint() {
  if (process.platform !== 'darwin') return '';
  const permission = getScreenPermission();
  if (permission.status === 'granted') return '';
  return ' Grant Screen Recording permission in macOS System Settings, then restart StashBase.';
}

function isScreenPermissionError(detail, permission = getScreenPermission()) {
  return permission.needsGuide || /permission|denied|not.?allowed|access|failed to get sources/i.test(String(detail || ''));
}

function screenPermissionError(detail, title = 'Screen Recording permission required') {
  return {
    kind: 'permission',
    title,
    message: 'Turn on Screen Recording for StashBase, then restart the app.',
    detail,
    permission: getScreenPermission(),
  };
}

async function openScreenPermissionSettings() {
  if (process.platform !== 'darwin') return false;
  const before = getScreenPermission();
  const primed = before.needsGuide ? await primeScreenRecordingPermission() : undefined;
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return {
    ok: true,
    opened: true,
    primed,
    permission: getScreenPermission(),
  };
}

async function primeScreenRecordingPermission() {
  if (process.platform !== 'darwin') {
    return { ok: true, permission: getScreenPermission() };
  }
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    });
    return { ok: true, permission: getScreenPermission() };
  } catch (err) {
    return {
      ok: false,
      error: err && typeof err.message === 'string' ? err.message : String(err),
      permission: getScreenPermission(),
    };
  }
}

function captureFilename(mode) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `screenshot-${mode}-${stamp}.png`;
}

function recordingFilename(mode) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `recording-${mode}-${stamp}.webm`;
}

function recordingStorageDir() {
  return path.join(os.homedir(), '.stashbase', 'captures', 'recordings');
}

function isInsidePath(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function getCaptureSettings() {
  return {
    permission: getScreenPermission(),
    identity: {
      appName: app.getName(),
      isPackaged: app.isPackaged,
      executablePath: process.execPath,
      appPath: app.getAppPath(),
    },
  };
}

function configureDisplayMediaRequests() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'display-capture') {
      callback(true);
      return;
    }
    if (permission === 'media' && activeRecording?.window?.webContents === webContents) {
      callback(true);
      return;
    }
    callback(false);
  });
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (activeRecording?.sourceId) {
      void desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1, height: 1 },
      }).then((sources) => {
        const source = sources.find((item) => item.id === activeRecording.sourceId);
        callback(source ? { video: source } : {});
      }).catch(() => {
        callback({});
      });
      return;
    }
    void desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    }).then((sources) => {
      callback({ video: sources[0] });
    }).catch(() => {
      callback({});
    });
  }, { useSystemPicker: false });
}

function internalCaptureSourceIds() {
  const ids = new Set();
  for (const win of [floatingBallWindow, capturePickerWindow]) {
    if (!win || win.isDestroyed()) continue;
    try {
      ids.add(win.getMediaSourceId());
    } catch {
      // Older Electron builds may not expose a source id for every
      // BrowserWindow; in that case the source simply remains visible.
    }
  }
  return ids;
}

function findSourceByDisplay(sources, display) {
  const id = String(display.id);
  return sources.find((source) => String(source.display_id) === id) || sources[0] || null;
}

async function captureDisplay(display) {
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
    },
  });
  const source = findSourceByDisplay(sources, display);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('No screen capture source is available.');
  }
  return { image: source.thumbnail, source };
}

async function captureScreenAtCursor() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const { image, source } = await captureDisplay(display);
  const size = image.getSize();
  return {
    ok: true,
    mode: 'screen',
    mime: 'image/png',
    dataUrl: image.toDataURL(),
    width: size.width,
    height: size.height,
    sourceTitle: source.name || 'Screen',
    filename: captureFilename('screen'),
  };
}

async function captureWindowSource(sourceId) {
  if (typeof sourceId !== 'string' || !sourceId) throw new Error('No window was selected.');
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 2400, height: 1800 },
  });
  const source = sources.find((item) => item.id === sourceId);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('The selected window is no longer available.');
  }
  const size = source.thumbnail.getSize();
  return {
    ok: true,
    mode: 'window',
    mime: 'image/png',
    dataUrl: source.thumbnail.toDataURL(),
    width: size.width,
    height: size.height,
    sourceTitle: source.name || 'Window',
    filename: captureFilename('window'),
  };
}

async function listCaptureWindows() {
  try {
    const internalIds = internalCaptureSourceIds();
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 200 },
    });
    return {
      ok: true,
      sources: sources
        .filter((source) => source.id && source.name && !source.thumbnail.isEmpty() && !internalIds.has(source.id))
        .map((source) => ({
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.toDataURL(),
        })),
    };
  } catch (err) {
    const detail = err && typeof err.message === 'string' ? err.message : String(err);
    const permission = getScreenPermission();
    const payload = isScreenPermissionError(detail, permission)
      ? screenPermissionError(detail, 'Screen Recording permission required')
      : {
          kind: 'capture-failed',
          title: 'Windows could not be listed',
          message: 'Could not list capturable windows. Try again.',
          detail: detail || 'Failed to get windows.',
          permission,
        };
    return { ok: false, ...payload };
  }
}

function hideFloatingBall() {
  if (floatingBallWindow && !floatingBallWindow.isDestroyed()) floatingBallWindow.hide();
}

function keepFloatingBallAboveApps() {
  if (!floatingBallWindow || floatingBallWindow.isDestroyed()) return;
  floatingBallWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating');
  if (process.platform === 'darwin') {
    floatingBallWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }
  try { floatingBallWindow.moveTop(); } catch { /* best-effort */ }
}

function showFloatingBall() {
  if (!floatingBallWindow || floatingBallWindow.isDestroyed()) return;
  keepFloatingBallAboveApps();
  floatingBallWindow.showInactive();
  keepFloatingBallAboveApps();
}

async function withFloatingBallHidden(fn) {
  hideFloatingBall();
  await sleep(120);
  try {
    return await fn();
  } finally {
    showFloatingBall();
  }
}

function createRegionOverlay(display) {
  return new Promise((resolve) => {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    overlay.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    let settled = false;
    function settle(value) {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('capture:region-selected', onSelected);
      ipcMain.removeListener('capture:region-cancel', onCancel);
      if (overlay.isDestroyed()) {
        resolve(value);
        return;
      }
      overlay.once('closed', () => resolve(value));
      overlay.close();
    }
    function onSelected(event, rect) {
      if (event.sender !== overlay.webContents) return;
      settle(rect && typeof rect === 'object' ? rect : null);
    }
    function onCancel(event) {
      if (event.sender !== overlay.webContents) return;
      settle(null);
    }
    ipcMain.on('capture:region-selected', onSelected);
    ipcMain.on('capture:region-cancel', onCancel);
    overlay.on('closed', () => settle(null));

    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(regionOverlayHtml())}`);
  });
}

async function captureRegionAtCursor() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const rect = await createRegionOverlay(display);
  if (!rect) return null;
  const x = Math.max(0, Number(rect.x) || 0);
  const y = Math.max(0, Number(rect.y) || 0);
  const width = Math.max(1, Number(rect.width) || 0);
  const height = Math.max(1, Number(rect.height) || 0);
  if (width < 4 || height < 4) return null;
  await sleep(120);
  const { image, source } = await captureDisplay(display);
  const imageSize = image.getSize();
  const scaleX = imageSize.width / display.bounds.width;
  const scaleY = imageSize.height / display.bounds.height;
  const cropped = image.crop({
    x: Math.round(x * scaleX),
    y: Math.round(y * scaleY),
    width: Math.round(width * scaleX),
    height: Math.round(height * scaleY),
  });
  const size = cropped.getSize();
  return {
    ok: true,
    mode: 'region',
    mime: 'image/png',
    dataUrl: cropped.toDataURL(),
    width: size.width,
    height: size.height,
    sourceTitle: source.name || 'Region',
    filename: captureFilename('region'),
  };
}

async function runCapture(request = {}, event) {
  const mode = typeof request.mode === 'string' ? request.mode : 'screen';
  let capture = null;
  if (mode === 'screen') {
    capture = await withFloatingBallHidden(() => captureScreenAtCursor());
  } else if (mode === 'window') {
    capture = await withFloatingBallHidden(() => captureWindowSource(request.sourceId));
  } else if (mode === 'region') {
    capture = await withFloatingBallHidden(() => captureRegionAtCursor());
  } else {
    throw new Error(`Unsupported capture mode: ${mode}`);
  }
  if (!capture) return { ok: false, canceled: true };
  emitCaptureCreated(capture);
  const senderWindow = event ? BrowserWindow.fromWebContents(event.sender) : null;
  if (senderWindow && senderWindow !== getMainTargetWindow() && senderWindow !== floatingBallWindow && !senderWindow.isDestroyed()) {
    senderWindow.close();
  }
  return { ok: true };
}

async function safeRunCapture(request = {}, event) {
  try {
    return await runCapture(request, event);
  } catch (err) {
    const detail = err && typeof err.message === 'string' ? err.message : String(err);
    const permission = getScreenPermission();
    const error = isScreenPermissionError(detail, permission)
      ? screenPermissionError(detail)
      : {
          kind: 'capture-failed',
          title: 'Screenshot did not finish',
          message: 'Try again, or choose a different capture mode.',
          detail,
          permission,
        };
    emitCaptureError(error);
    return { ok: false, error: detail, ...error };
  }
}

function recordingPublicStatus() {
  if (!activeRecording) return { active: false };
  return {
    active: true,
    id: activeRecording.id,
    sourceTitle: activeRecording.sourceName,
    startedAt: activeRecording.startedAt,
    filePath: activeRecording.filePath,
  };
}

function closeRecordingWindow(recording) {
  if (recording?.window && !recording.window.isDestroyed()) {
    try { recording.window.close(); } catch { /* best-effort */ }
  }
}

function failActiveRecording(detail) {
  const recording = activeRecording;
  if (!recording) return;
  if (recordingStopTimer) {
    clearTimeout(recordingStopTimer);
    recordingStopTimer = null;
  }
  activeRecording = null;
  try { recording.stream.destroy(); } catch { /* best-effort */ }
  try {
    if (recording.filePath && fs.existsSync(recording.filePath)) {
      fs.unlinkSync(recording.filePath);
    }
  } catch { /* best-effort */ }
  closeRecordingWindow(recording);
  emitRecordingStatus({ active: false });
  const permission = getScreenPermission();
  emitRecordingError(isScreenPermissionError(detail, permission)
    ? screenPermissionError(detail)
    : {
        kind: 'recording-failed',
        title: 'Recording did not finish',
        message: 'Window recording stopped before it could be saved.',
        detail,
        permission,
      });
}

function finishActiveRecording(id, info = {}) {
  const recording = activeRecording;
  if (!recording || recording.id !== id) return { ok: false, error: 'No matching recording is active.' };
  if (recordingStopTimer) {
    clearTimeout(recordingStopTimer);
    recordingStopTimer = null;
  }
  activeRecording = null;
  return new Promise((resolve) => {
    recording.stream.end(() => {
      const size = fs.existsSync(recording.filePath) ? fs.statSync(recording.filePath).size : recording.bytesWritten;
      closeRecordingWindow(recording);
      const payload = {
        ok: true,
        kind: 'recording',
        mode: 'window',
        mime: info.mime || recording.mime || 'video/webm',
        filePath: recording.filePath,
        filename: recording.filename,
        sourceTitle: recording.sourceName || 'Window recording',
        startedAt: recording.startedAt,
        durationMs: Math.max(0, Math.round(Number(info.durationMs) || (Date.now() - recording.startedAt))),
        size,
        limitReached: size >= MAX_RECORDING_BYTES,
      };
      emitRecordingStatus({ active: false });
      emitRecordingCreated(payload);
      resolve({ ok: true, recording: payload });
    });
  });
}

function writeRecordingChunk(id, chunk) {
  const recording = activeRecording;
  if (!recording || recording.id !== id) return Promise.resolve({ ok: false, error: 'No matching recording is active.' });
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (bytes.length === 0) return Promise.resolve({ ok: true, bytesWritten: recording.bytesWritten });
  recording.bytesWritten += bytes.length;
  return new Promise((resolve, reject) => {
    recording.stream.write(bytes, (err) => {
      if (err) {
        reject(err);
        return;
      }
      if (recording.bytesWritten >= MAX_RECORDING_BYTES && !recording.stopping) {
        stopWindowRecording();
      }
      resolve({
        ok: true,
        bytesWritten: recording.bytesWritten,
        limitReached: recording.bytesWritten >= MAX_RECORDING_BYTES,
      });
    });
  });
}

async function startWindowRecording(request = {}, event) {
  if (activeRecording) {
    return { ok: false, error: 'A recording is already in progress.' };
  }
  const sourceId = typeof request.sourceId === 'string' ? request.sourceId : '';
  if (!sourceId) return { ok: false, error: 'No window was selected.' };
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1, height: 1 },
  });
  const source = sources.find((item) => item.id === sourceId);
  if (!source) return { ok: false, error: 'The selected window is no longer available.' };

  fs.mkdirSync(recordingStorageDir(), { recursive: true });
  const id = `recording-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const filename = recordingFilename('window');
  const filePath = path.join(recordingStorageDir(), filename);
  const stream = fs.createWriteStream(filePath, { flags: 'wx' });
  const recorderWindow = new BrowserWindow({
    width: 420,
    height: 240,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  activeRecording = {
    id,
    sourceId,
    sourceName: request.sourceName || source.name || 'Window recording',
    startedAt: Date.now(),
    filePath,
    filename,
    mime: 'video/webm',
    bytesWritten: 0,
    stream,
    window: recorderWindow,
    stopping: false,
  };
  stream.on('error', (err) => failActiveRecording(err && err.message ? err.message : String(err)));
  recorderWindow.on('closed', () => {
    if (activeRecording?.id === id && !activeRecording.stopping) {
      failActiveRecording('The recording worker closed unexpectedly.');
    }
  });
  try {
    await recorderWindow.loadFile(path.join(__dirname, 'recorder.html'), { query: { id, sourceId } });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    failActiveRecording(detail);
    return { ok: false, error: detail };
  }

  const senderWindow = event ? BrowserWindow.fromWebContents(event.sender) : null;
  if (senderWindow && senderWindow !== getMainTargetWindow() && senderWindow !== floatingBallWindow && !senderWindow.isDestroyed()) {
    senderWindow.close();
  }
  emitRecordingStatus(recordingPublicStatus());
  return { ok: true, id, filePath, sourceTitle: activeRecording.sourceName };
}

function stopWindowRecording() {
  if (!activeRecording) return { ok: false, error: 'No recording is active.' };
  activeRecording.stopping = true;
  if (activeRecording.window && !activeRecording.window.isDestroyed()) {
    activeRecording.window.webContents.send('recording:stop');
  }
  if (recordingStopTimer) clearTimeout(recordingStopTimer);
  recordingStopTimer = setTimeout(() => {
    if (activeRecording) failActiveRecording('The recorder did not stop in time.');
  }, 8000);
  emitRecordingStatus(recordingPublicStatus());
  return { ok: true };
}

function showCaptureMenu() {
  keepFloatingBallAboveApps();
  const items = [
    { label: 'Full screen screenshot', click: () => { void safeRunCapture({ mode: 'screen' }); } },
    { label: 'Window screenshot', click: () => createCapturePickerWindow() },
    { label: 'Region screenshot', click: () => { void safeRunCapture({ mode: 'region' }); } },
    { type: 'separator' },
  ];
  if (activeRecording) {
    items.push(
      { label: `Recording ${activeRecording.sourceName}`, enabled: false },
      { label: 'Stop recording', click: () => stopWindowRecording() },
    );
  } else {
    items.push({ label: 'Record window', click: () => createCapturePickerWindow('record') });
  }
  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window: floatingBallWindow || undefined });
}

function clampFloatingPosition(point) {
  const bounds = floatingBallWindow && !floatingBallWindow.isDestroyed()
    ? floatingBallWindow.getBounds()
    : { width: 58, height: 58 };
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  return {
    x: Math.min(area.x + area.width - bounds.width, Math.max(area.x, point.x)),
    y: Math.min(area.y + area.height - bounds.height, Math.max(area.y, point.y)),
  };
}

function createFloatingBallWindow() {
  if (floatingBallWindow && !floatingBallWindow.isDestroyed()) {
    showFloatingBall();
    return;
  }
  const display = screen.getPrimaryDisplay();
  const x = display.workArea.x + display.workArea.width - 82;
  const y = display.workArea.y + Math.round(display.workArea.height * 0.55);
  floatingBallWindow = new BrowserWindow({
    x,
    y,
    width: 58,
    height: 58,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  keepFloatingBallAboveApps();
  floatingBallWindow.loadFile(path.join(__dirname, 'floating-ball.html'));
  floatingBallWindow.once('ready-to-show', () => showFloatingBall());
  floatingBallWindow.on('closed', () => { floatingBallWindow = null; });
}

function createCapturePickerWindow(action = 'capture') {
  if (capturePickerWindow && !capturePickerWindow.isDestroyed()) {
    capturePickerWindow.focus();
    return;
  }
  const normalizedAction = action === 'record' ? 'record' : 'capture';
  capturePickerWindow = new BrowserWindow({
    width: 720,
    height: 520,
    minWidth: 520,
    minHeight: 360,
    title: 'Choose window',
    backgroundColor: '#f8fafc',
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  capturePickerWindow.loadFile(path.join(__dirname, 'capture-picker.html'), { query: { action: normalizedAction } });
  capturePickerWindow.on('closed', () => { capturePickerWindow = null; });
}

function regionOverlayHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; cursor: crosshair; user-select: none; }
    body { background: rgba(15, 23, 42, 0.22); }
    #hint { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); padding: 8px 12px; border-radius: 8px; background: rgba(15, 23, 42, 0.86); color: white; font: 13px system-ui, sans-serif; }
    #box { position: fixed; border: 2px solid #38bdf8; background: rgba(56, 189, 248, 0.16); box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.28); display: none; }
  </style>
</head>
<body>
  <div id="hint">Drag to select a screenshot region. Press Esc to cancel.</div>
  <div id="box"></div>
  <script>
    const box = document.getElementById('box');
    let start = null;
    let current = null;
    function rect() {
      const x = Math.min(start.x, current.x);
      const y = Math.min(start.y, current.y);
      const width = Math.abs(current.x - start.x);
      const height = Math.abs(current.y - start.y);
      return { x, y, width, height };
    }
    function render() {
      if (!start || !current) return;
      const r = rect();
      box.style.display = 'block';
      box.style.left = r.x + 'px';
      box.style.top = r.y + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    }
    window.addEventListener('pointerdown', (event) => {
      start = { x: event.clientX, y: event.clientY };
      current = start;
      render();
    });
    window.addEventListener('pointermove', (event) => {
      if (!start) return;
      current = { x: event.clientX, y: event.clientY };
      render();
    });
    window.addEventListener('pointerup', () => {
      if (!start || !current) return window.electron.cancelCaptureRegion();
      window.electron.selectCaptureRegion(rect());
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.electron.cancelCaptureRegion();
    });
  </script>
</body>
</html>`;
}

async function createWindow(initialSpace) {
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
  });
  win.on('closed', () => {
    mainWindows.delete(win);
    if (lastMainWindow === win) lastMainWindow = null;
    if (mainWindows.size === 0) {
      hideFloatingBall();
      if (process.platform !== 'darwin') app.quit();
    }
  });

  // External links → OS default browser. Anything else (popups,
  // accidental navigation away from the app shell) gets denied so the
  // main window stays anchored at SERVER_URL.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url) && isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
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

  const url = initialSpace
    ? `${SERVER_URL}/?space=${encodeURIComponent(initialSpace)}`
    : SERVER_URL;
  win.loadURL(url);
  return win;
}

// Folder picker — invoked from the Clone modal (Open/New use the
// custom in-app SpacePicker so they can enforce the kbRoot rule via
// list filtering; Clone wants the native "New Folder" affordance so
// the user can spin up `~/Documents/StashBase/<new>` on the spot).
// `defaultPath` opens the panel at a sensible starting location; the
// caller still validates the result is under kbRoot before using it.
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
  if (typeof url !== 'string' || !isHttpUrl(url)) return false;
  await shell.openExternal(url);
  return true;
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

ipcMain.handle('window:openSpace', async (_e, name) => {
  if (typeof name !== 'string' || !name.trim()) return false;
  const win = await createWindow(name.trim());
  if (win) createFloatingBallWindow();
  return true;
});

ipcMain.handle('capture:listWindows', async () => listCaptureWindows());

ipcMain.handle('capture:capture', async (event, request = {}) => {
  return safeRunCapture(request, event);
});

ipcMain.handle('recording:startWindow', async (event, request = {}) => {
  try {
    return await startWindowRecording(request, event);
  } catch (err) {
    const detail = err && typeof err.message === 'string' ? err.message : String(err);
    const permission = getScreenPermission();
    const error = isScreenPermissionError(detail, permission)
      ? screenPermissionError(detail)
      : {
          kind: 'recording-failed',
          title: 'Recording did not start',
          message: 'Window recording could not start.',
          detail,
          permission,
        };
    emitRecordingError(error);
    return { ok: false, error: detail, ...error };
  }
});

ipcMain.handle('recording:stop', async () => stopWindowRecording());

ipcMain.handle('recording:status', async () => recordingPublicStatus());

ipcMain.handle('recording:started', async (_event, id, info = {}) => {
  if (!activeRecording || activeRecording.id !== id) return { ok: false };
  activeRecording.mime = info.mime || activeRecording.mime;
  emitRecordingStatus(recordingPublicStatus());
  return { ok: true };
});

ipcMain.handle('recording:writeChunk', async (_event, id, chunk) => {
  return writeRecordingChunk(id, chunk);
});

ipcMain.handle('recording:finish', async (_event, id, info = {}) => {
  return finishActiveRecording(id, info);
});

ipcMain.handle('recording:failed', async (_event, id, detail) => {
  if (!activeRecording || activeRecording.id !== id) return { ok: false };
  failActiveRecording(typeof detail === 'string' && detail ? detail : 'The recorder failed.');
  return { ok: true };
});

ipcMain.handle('capture:getSettings', async () => getCaptureSettings());

ipcMain.handle('capture:openScreenPermissionSettings', async () => openScreenPermissionSettings());

// Renderer toggles clipboard-image watching (privacy switch). When
// turning it back on we clear the last-offered hash so the current
// clipboard image becomes eligible again.
ipcMain.handle('clipboard:setWatch', (_event, enabled) => {
  clipboardWatchEnabled = enabled !== false;
  if (clipboardWatchEnabled) lastClipboardOfferHash = null;
  return clipboardWatchEnabled;
});

// Renderer confirms it imported (or chose to keep ignoring) a clipboard
// image; remember the hash so re-focus doesn't re-offer the same one.
ipcMain.on('clipboard:markHandled', (_event, hash) => {
  if (typeof hash === 'string' && hash) lastClipboardOfferHash = hash;
});

ipcMain.handle('recording:reveal', async (_event, filePath) => {
  if (typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  const root = recordingStorageDir();
  if (!isInsidePath(root, resolved) || !fs.existsSync(resolved)) return false;
  shell.showItemInFolder(resolved);
  return true;
});

ipcMain.handle('floating:getBounds', () => {
  if (!floatingBallWindow || floatingBallWindow.isDestroyed()) return null;
  return floatingBallWindow.getBounds();
});

ipcMain.handle('floating:setPosition', (_event, point) => {
  if (!floatingBallWindow || floatingBallWindow.isDestroyed()) return false;
  const x = Math.round(Number(point?.x));
  const y = Math.round(Number(point?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const next = clampFloatingPosition({ x, y });
  floatingBallWindow.setPosition(next.x, next.y, false);
  return true;
});

ipcMain.on('floating:captureMenu', () => {
  showCaptureMenu();
});

app.whenReady().then(async () => {
  configureDisplayMediaRequests();
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
  const win = await createWindow();
  if (win) createFloatingBallWindow();
});

app.on('activate', () => {
  if (mainWindows.size === 0) {
    void createWindow().then((win) => {
      if (win) createFloatingBallWindow();
    });
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
