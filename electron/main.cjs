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
const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, screen, session, shell, systemPreferences } = require('electron');
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
let capturePickerWindow = null;
let recorderWindow = null;
let recordingIndicatorWindow = null;
// Four thin edge strips (top/bottom/left/right) forming the recording frame.
// Thin windows float over fullscreen Spaces like the pill does; a single
// screen-sized window gets ordered *under* the fullscreen app instead.
let recordingBorderWindows = [];
// Human label for the recording indicator pill — "right screen", "a window",
// etc. Set from the recorder's capture metadata; '' = generic (just "REC").
let recordingTargetLabel = '';
let recordingActive = false;
let recordingPending = false;

// macOS 15+ (Darwin 24+) has the system source picker, which getDisplayMedia
// can raise via `useSystemPicker` — the only chooser that lists fullscreen
// apps. Below that we fall back to our own desktopCapturer-based picker.
function supportsSystemPicker() {
  if (process.platform !== 'darwin') return false;
  const major = parseInt(os.release().split('.')[0], 10);
  return Number.isFinite(major) && major >= 24;
}

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
    // The recorder window's getUserMedia desktop-capture request surfaces
    // as a 'media' permission; grant it only for that window.
    if (
      permission === 'media' &&
      recorderWindow &&
      !recorderWindow.isDestroyed() &&
      webContents === recorderWindow.webContents
    ) {
      callback(true);
      return;
    }
    callback(false);
  });
  // On macOS 15+ the recorder uses getDisplayMedia + the system picker
  // (`useSystemPicker: true`), so the handler isn't invoked for recording.
  // On older macOS the handler runs as a fallback (only used to prime the
  // screen-recording TCC prompt) and auto-grants the primary screen.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    }).then((sources) => {
      callback(sources[0] ? { video: sources[0] } : {});
    }).catch(() => {
      callback({});
    });
  }, { useSystemPicker: supportsSystemPicker() });
}

function internalCaptureSourceIds() {
  const ids = new Set();
  // Exclude StashBase's own windows from the picker — the main window(s),
  // the picker itself, the recorder, and the recording indicator pill.
  // Recording StashBase itself is never the intent and just clutters the
  // list (e.g. the main window titled after the current chat).
  const own = [capturePickerWindow, recorderWindow, recordingIndicatorWindow, ...recordingBorderWindows, ...mainWindows];
  for (const win of own) {
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

async function listCaptureWindows() {
  const internalIds = internalCaptureSourceIds();
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 200 },
  });
  return sources
    .filter((source) => source.id && source.name && !internalIds.has(source.id))
    .map((source) => ({
      id: source.id,
      name: source.name,
      // Some windows occasionally report an empty static thumbnail; keep
      // them listed (the picker shows a placeholder) rather than dropping
      // them. Fullscreen apps are a separate story — they live on their
      // own Space and aren't enumerated here at all (use macOS 15's system
      // picker for those).
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    }));
}

// Turn a raw capture/recording failure into the structured error the
// renderer's toast understands — permission problems get the "open
// settings" affordance, everything else is a generic retry.
function classifyCaptureError(detail) {
  const permission = getScreenPermission();
  const needsPermission = permission.needsGuide || /permission|denied|not.?allowed|access/i.test(detail);
  return needsPermission
    ? {
        kind: 'permission',
        title: 'Screen Recording is off',
        message: 'Turn on Screen Recording for StashBase, then restart the app.',
        detail,
        permission,
      }
    : {
        kind: 'capture-failed',
        title: 'Capture did not finish',
        message: 'Try again, or choose a different capture mode.',
        detail,
        permission,
      };
}

// --- Screen recording --------------------------------------------------
// Recording needs MediaRecorder, which only exists in a renderer. So a
// hidden recorder window (electron/recorder.html) does the getUserMedia +
// MediaRecorder work; main just picks the display, starts it, and on stop
// forwards the webm to the main window via the `capture:created` path.

function recordingFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `recording-${stamp}.webm`;
}


// Broadcast recording state to the sidebar record button in every open
// main window, so it stays in sync however recording was started or
// stopped (ball is gone; the rail button is the control now). Also the
// single hook that raises / tears down the floating indicator — every
// start / finish / crash path funnels through here, so the overlay's
// lifetime tracks `recordingActive` exactly.
function emitRecordingState(recording) {
  if (recording) { showRecordingBorder(); showRecordingIndicator(); }
  else { closeRecordingIndicator(); closeRecordingBorder(); }
  for (const win of mainWindows) {
    if (!win.isDestroyed()) win.webContents.send('recording:state', Boolean(recording));
  }
}

// Thickness of each edge strip (the coloured edge line + its inward glow).
const BORDER_STRIP = 18;

// Rects for the four edge strips covering a display's bounds. Top/bottom span
// the full width; left/right fill the gap between them.
function borderStripRects(b) {
  return {
    top: { x: b.x, y: b.y, width: b.width, height: BORDER_STRIP },
    bottom: { x: b.x, y: b.y + b.height - BORDER_STRIP, width: b.width, height: BORDER_STRIP },
    left: { x: b.x, y: b.y + BORDER_STRIP, width: BORDER_STRIP, height: b.height - 2 * BORDER_STRIP },
    right: { x: b.x + b.width - BORDER_STRIP, y: b.y + BORDER_STRIP, width: BORDER_STRIP, height: b.height - 2 * BORDER_STRIP },
  };
}

// A glowing frame around the recorded display, paired with the pill's caption.
// Built from four THIN edge windows rather than one screen-sized window: a
// full-screen window joins a fullscreen app's Space *under* the app (hidden),
// whereas thin auxiliary windows float over it like the pill. Like the pill
// they `canJoinAllSpaces` (so also visible on the desktop — the caption is
// what disambiguates a window capture), are click-through and content-protected.
function showRecordingBorder() {
  if (recordingBorderWindows.length) return;
  const rects = borderStripRects(screen.getPrimaryDisplay().bounds);
  recordingBorderWindows = ['top', 'bottom', 'left', 'right'].map((edge) => createBorderStrip(rects[edge], edge));
}

function createBorderStrip(rect, edge) {
  const win = new BrowserWindow({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    // Hidden until "join all Spaces" is set, so showing it doesn't yank the
    // user out of the fullscreen window they're recording (see the pill).
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(true);
  win.on('closed', () => {
    recordingBorderWindows = recordingBorderWindows.filter((w) => w !== win);
  });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(borderStripHtml(edge))}`);
  win.showInactive();
  return win;
}

function closeRecordingBorder() {
  for (const win of recordingBorderWindows) {
    if (win && !win.isDestroyed()) win.close();
  }
  recordingBorderWindows = [];
}

// Move the frame to cover a specific display (the matched recording target).
function positionBorderOnDisplay(display) {
  if (recordingBorderWindows.length !== 4) return;
  const rects = borderStripRects(display.bounds);
  ['top', 'bottom', 'left', 'right'].forEach((edge, i) => {
    const win = recordingBorderWindows[i];
    if (win && !win.isDestroyed()) win.setBounds(rects[edge]);
  });
}

function borderStripHtml(edge) {
  // Glow fades inward from the screen edge; a solid line sits on the edge.
  const fade = { top: 'to bottom', bottom: 'to top', left: 'to right', right: 'to left' }[edge];
  const horizontal = edge === 'top' || edge === 'bottom';
  const line = horizontal
    ? `left: 0; right: 0; height: 3px; ${edge}: 0;`
    : `top: 0; bottom: 0; width: 3px; ${edge}: 0;`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
    .glow { position: fixed; inset: 0;
      background: linear-gradient(${fade}, rgba(239, 68, 68, 0.5), rgba(239, 68, 68, 0));
      animation: breathe 1.8s ease-in-out infinite; }
    .line { position: fixed; ${line} background: rgba(239, 68, 68, 0.95);
      animation: breathe 1.8s ease-in-out infinite; }
    @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
  </style>
</head>
<body><div class="glow"></div><div class="line"></div></body>
</html>`;
}

// A small always-on-top pill that stays visible across every Space —
// including other apps' fullscreen Spaces, where macOS hides its own
// menu-bar recording glyph and our rail button is on an unreachable
// window. So while recording you always have one persistent "REC + timer
// + Stop" cue no matter where you've swiped. `setContentProtection(true)`
// keeps the pill visible to the user but excluded from the capture itself,
// so it never bleeds into the recorded video.
function showRecordingIndicator() {
  if (recordingIndicatorWindow && !recordingIndicatorWindow.isDestroyed()) return;
  // Wide enough for the longest pill ("REC · 0:00 · right screen · Stop");
  // the pill itself is inline and centred, so extra width is just slack.
  const width = 300;
  const height = 44;
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 12,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // Don't steal focus from / yank the user out of the Space they're in
    // when the pill appears or is clicked through.
    focusable: false,
    // Created hidden so "join all Spaces" is set before it's shown — else
    // macOS switches the user from the fullscreen window being recorded
    // back to the Space the pill first appears on.
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Visible to the eye, invisible to screen capture — so the indicator
  // doesn't end up baked into the recording it's announcing.
  win.setContentProtection(true);
  win.on('closed', () => {
    if (recordingIndicatorWindow === win) recordingIndicatorWindow = null;
  });
  // The capture target's metadata may already have arrived (older path sets
  // the pill up before the recorder loads; system path the other way round),
  // so push whatever label we have once the pill's DOM is ready.
  win.webContents.once('did-finish-load', () => {
    if (recordingTargetLabel && !win.isDestroyed()) win.webContents.send('recording:label', recordingTargetLabel);
  });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recordingIndicatorHtml())}`);
  // showInactive: join the current Space without activating / switching to it.
  win.showInactive();
  recordingIndicatorWindow = win;
}

function closeRecordingIndicator() {
  if (recordingIndicatorWindow && !recordingIndicatorWindow.isDestroyed()) {
    recordingIndicatorWindow.close();
  }
  recordingIndicatorWindow = null;
  recordingTargetLabel = '';
}

// Resolve the recorder's capture metadata into (a) a human label for the
// pill and (b) the physical display being recorded, if we can pin it down.
// Whole-screen capture reports its pixel size, which we match against each
// display's native resolution; with ≥2 displays we add a left/middle/right
// word so the pill says *which* screen. A window capture has no single
// screen, so it's just labelled "a window".
function describeRecordingTarget(meta) {
  const surface = meta && typeof meta.displaySurface === 'string' ? meta.displaySurface : '';
  // The pill floats over every Space (it must, to stay visible over fullscreen
  // windows — macOS couples that with "all Spaces"), so it can appear on the
  // desktop while a *window* is what's being recorded. The label states the
  // subject ("a window") so the pill never reads as "this Space is recording".
  if (surface === 'window') return { label: 'Recording a window', display: null };
  const w = meta && Number(meta.width);
  const h = meta && Number(meta.height);
  const displays = screen.getAllDisplays();
  let best = null;
  let bestErr = Infinity;
  if (w && h) {
    for (const d of displays) {
      const pw = Math.round(d.size.width * d.scaleFactor);
      const ph = Math.round(d.size.height * d.scaleFactor);
      const err = Math.abs(pw - w) + Math.abs(ph - h);
      if (err < bestErr) { bestErr = err; best = d; }
    }
  }
  // `displaySurface === 'monitor'` means the target IS some display, so trust
  // the closest resolution match unconditionally (HiDPI rounding shouldn't
  // strand the pill on the primary screen). An unknown surface only counts
  // as a screen on a tight match — otherwise it's most likely a window
  // (e.g. the older getUserMedia path, which only ever records windows).
  const match = surface === 'monitor' ? best : (best && bestErr <= (w + h) * 0.05 ? best : null);
  if (!match) return { label: 'Recording a window', display: null };
  if (displays.length < 2) return { label: 'Recording the screen', display: match };
  return { label: `Recording the ${displayPositionWord(match, displays)} screen`, display: match };
}

// Left / middle / right by horizontal position among the displays. Matches
// how users name monitors ("the right screen"), which the menu-bar glyph
// and OS picker never tell them.
function displayPositionWord(display, displays) {
  const byX = [...displays].sort((a, b) => a.bounds.x - b.bounds.x);
  const i = byX.findIndex((d) => d.id === display.id);
  if (i === 0) return 'left';
  if (i === byX.length - 1) return 'right';
  return 'middle';
}

function positionIndicatorOnDisplay(display) {
  if (!recordingIndicatorWindow || recordingIndicatorWindow.isDestroyed()) return;
  const [width] = recordingIndicatorWindow.getSize();
  const area = display.workArea;
  recordingIndicatorWindow.setPosition(Math.round(area.x + (area.width - width) / 2), area.y + 12);
}

function recordingIndicatorHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline';">
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: transparent;
      font: 13px -apple-system, system-ui, sans-serif; user-select: none; cursor: default; }
    /* The pill body is the drag handle so the user can reposition it; the
       Stop button opts out of the drag region so its click registers. */
    .pill { -webkit-app-region: drag; display: inline-flex; align-items: center; gap: 8px;
      height: 28px; margin: 6px; padding: 0 6px 0 12px; border-radius: 999px;
      background: rgba(17, 24, 39, 0.92); color: #fff;
      box-shadow: 0 4px 14px rgba(0,0,0,0.32); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444;
      flex: none; animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.78); } }
    .loc { white-space: nowrap; }
    .time { font-variant-numeric: tabular-nums; letter-spacing: 0.3px; min-width: 34px;
      color: rgba(255,255,255,0.62); }
    .time::before { content: "·"; margin-right: 7px; color: rgba(255,255,255,0.32); }
    .stop { -webkit-app-region: no-drag; margin-left: 2px; display: flex; align-items: center;
      gap: 5px; height: 20px; padding: 0 9px; border: 0; border-radius: 999px;
      background: rgba(255,255,255,0.14); color: #fff; font: inherit; font-size: 12px;
      cursor: pointer; }
    .stop:hover { background: rgba(239, 68, 68, 0.9); }
    .stop b { width: 8px; height: 8px; border-radius: 2px; background: currentColor; }
  </style>
</head>
<body>
  <div class="pill">
    <span class="dot"></span>
    <span class="loc" id="loc">Recording…</span>
    <span class="time" id="t">0:00</span>
    <button class="stop" id="stop" type="button"><b></b>Stop</button>
  </div>
  <script>
    const started = Date.now();
    const t = document.getElementById('t');
    function tick() {
      const s = Math.floor((Date.now() - started) / 1000);
      const m = Math.floor(s / 60);
      t.textContent = m + ':' + String(s % 60).padStart(2, '0');
    }
    tick();
    setInterval(tick, 1000);
    // The subject ("Recording a window" / "Recording the right screen") so the
    // pill states what's captured, never implying the Space it floats over is.
    const loc = document.getElementById('loc');
    // Report the pill's real content width so main shrinks the window to fit —
    // no truncated label, no oversized transparent click-catcher.
    const pill = document.querySelector('.pill');
    function reportSize() {
      requestAnimationFrame(() => {
        window.electron.setIndicatorSize({ width: Math.ceil(pill.getBoundingClientRect().width) + 14 });
      });
    }
    window.electron.onRecordingLabel((label) => {
      loc.textContent = label || 'Recording…';
      reportSize();
    });
    reportSize();
    document.getElementById('stop').addEventListener('click', () => {
      window.electron.stopRecording();
    });
  </script>
</body>
</html>`;
}

function createRecorderWindow() {
  const win = new BrowserWindow({
    width: 200,
    height: 120,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep timers / MediaRecorder running while the window is hidden.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'recorder.html'));
  // If the recorder window dies without delivering a clip (crash, quit),
  // don't leave the ball stuck in its red stop state.
  win.on('closed', () => {
    if (recorderWindow === win) {
      recorderWindow = null;
      if (recordingActive) {
        recordingActive = false;
        emitRecordingState(false);
      }
    }
  });
  return win;
}

// Entry point from the renderer's recording control. macOS 15+ goes
// straight to the system picker (it can list fullscreen apps); older
// macOS opens our own windows-only picker.
function beginRecording() {
  if (recordingActive || recordingPending) return;
  if (supportsSystemPicker()) startRecordingSystemPicker();
  else createCapturePickerWindow('record');
}

// macOS 15+ path: getDisplayMedia raises the system picker. We don't pass
// a source id — the picker is what lets the user choose a screen / window /
// fullscreen app. The UI only flips to "recording" on the `recorder:started`
// ack, so dismissing the picker leaves no stuck red ball (`recordingPending`
// guards re-entry meanwhile).
function startRecordingSystemPicker() {
  recordingPending = true;
  recorderWindow = createRecorderWindow();
  const trigger = () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      // `true` injects a user gesture; getDisplayMedia needs transient
      // activation, which the rail button's click (in a different renderer)
      // doesn't provide to this window.
      recorderWindow.webContents
        .executeJavaScript('window.startCapture && window.startCapture()', true)
        .catch(() => {});
    }
  };
  if (recorderWindow.webContents.isLoading()) {
    recorderWindow.webContents.once('did-finish-load', trigger);
  } else {
    trigger();
  }
}

// Older-macOS path: a source was chosen in our own picker. Spin up the
// recorder window for that window id (getUserMedia's `chromeMediaSource:
// 'desktop'`). No silent fallback — a missing id is an error.
function startRecording(sourceId) {
  if (recordingActive) return;
  if (!sourceId) {
    emitCaptureError(classifyCaptureError('No capture source was selected.'));
    return;
  }
  recordingActive = true;
  emitRecordingState(true);
  recorderWindow = createRecorderWindow();
  const send = () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.webContents.send('recorder:start', sourceId);
    }
  };
  if (recorderWindow.webContents.isLoading()) {
    recorderWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function stopScreenRecording() {
  if (!recordingActive || !recorderWindow || recorderWindow.isDestroyed()) return;
  recorderWindow.webContents.send('recorder:stop');
}

function finishScreenRecording() {
  recordingActive = false;
  recordingPending = false;
  emitRecordingState(false);
  if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.close();
  recorderWindow = null;
}

// `mode === 'record'` loads the picker in window-recording mode (it then
// starts a recording on pick instead of taking a screenshot).
function createCapturePickerWindow(mode) {
  if (capturePickerWindow && !capturePickerWindow.isDestroyed()) {
    capturePickerWindow.focus();
    return;
  }
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
  capturePickerWindow.loadFile(
    path.join(__dirname, 'capture-picker.html'),
    mode === 'record' ? { hash: 'record' } : undefined,
  );
  capturePickerWindow.on('closed', () => { capturePickerWindow = null; });
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
  await createWindow(name.trim());
  return true;
});

ipcMain.handle('capture:listWindows', async () => listCaptureWindows());

ipcMain.handle('capture:getSettings', async () => getCaptureSettings());

ipcMain.handle('capture:openScreenPermissionSettings', async () => openScreenPermissionSettings());

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

// Rail "record" button: start recording (system picker on macOS 15+, our
// own windows-only picker below that).
ipcMain.on('capture:startRecording', () => {
  beginRecording();
});

// Older-macOS picker handed us the chosen window — start recording it and
// dismiss the picker (the recording indicator pill is the stop control).
ipcMain.handle('recorder:recordWindow', (event, sourceId) => {
  if (typeof sourceId !== 'string' || !sourceId) return { ok: false, error: 'Nothing was selected.' };
  if (recordingActive) return { ok: false, error: 'A recording is already in progress.' };
  startRecording(sourceId);
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && senderWindow === capturePickerWindow && !senderWindow.isDestroyed()) {
    senderWindow.close();
  }
  return { ok: true };
});

// macOS 15+ path: the user picked a source in the system picker, recording
// is live — flip the UI into its recording state now.
ipcMain.on('recorder:started', (event) => {
  if (recorderWindow && event.sender !== recorderWindow.webContents) return;
  recordingPending = false;
  recordingActive = true;
  emitRecordingState(true);
});

// macOS 15+ path: the user dismissed the system picker — tear down quietly.
ipcMain.on('recorder:canceled', (event) => {
  if (recorderWindow && event.sender !== recorderWindow.webContents) return;
  recordingPending = false;
  if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.close();
  recorderWindow = null;
});

ipcMain.on('capture:stopRecording', () => {
  stopScreenRecording();
});

// Pill measured its content — shrink the window to fit so the label never
// truncates and the transparent window isn't a wider-than-needed click-catcher.
// Preserve the current centre so it stays put on whatever display it's on.
ipcMain.on('recording:indicator-size', (event, size) => {
  if (!recordingIndicatorWindow || recordingIndicatorWindow.isDestroyed()) return;
  if (event.sender !== recordingIndicatorWindow.webContents) return;
  const w = Math.round(size && Number(size.width));
  if (!w || w < 80) return;
  const clamped = Math.min(640, w);
  const b = recordingIndicatorWindow.getBounds();
  const centerX = b.x + b.width / 2;
  recordingIndicatorWindow.setBounds({
    x: Math.round(centerX - clamped / 2),
    y: b.y,
    width: clamped,
    height: b.height,
  });
});

// Recorder reported what it's capturing — label the indicator pill with the
// recorded display (and move it onto that screen) so the user can tell which
// screen is live even when the pill floats over other Spaces / monitors.
ipcMain.on('recorder:meta', (event, meta) => {
  if (recorderWindow && event.sender !== recorderWindow.webContents) return;
  const { label, display } = describeRecordingTarget(meta && typeof meta === 'object' ? meta : {});
  recordingTargetLabel = label;
  if (recordingIndicatorWindow && !recordingIndicatorWindow.isDestroyed()) {
    if (display) positionIndicatorOnDisplay(display);
    recordingIndicatorWindow.webContents.send('recording:label', label);
  }
  if (display) positionBorderOnDisplay(display);
});

// Recorder window handed back a finished clip — forward it to the main
// window via the `capture:created` path so it gets saved into the active
// space.
ipcMain.on('recorder:result', (event, payload) => {
  if (recorderWindow && event.sender !== recorderWindow.webContents) return;
  finishScreenRecording();
  if (!payload || typeof payload.dataUrl !== 'string') {
    emitCaptureError(classifyCaptureError('Recording produced no data.'));
    return;
  }
  emitCaptureCreated({
    ok: true,
    mode: 'recording',
    mime: typeof payload.mime === 'string' ? payload.mime : 'video/webm',
    dataUrl: payload.dataUrl,
    sourceTitle: 'Screen recording',
    filename: recordingFilename(),
  });
});

ipcMain.on('recorder:error', (event, message) => {
  if (recorderWindow && event.sender !== recorderWindow.webContents) return;
  finishScreenRecording();
  emitCaptureError(classifyCaptureError(typeof message === 'string' ? message : String(message)));
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
