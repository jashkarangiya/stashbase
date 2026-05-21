/**
 * Express server entry point.
 *
 * Owns process lifecycle (boot middleware, mount route modules, listen,
 * graceful shutdown) but no business logic — that lives in the route
 * modules under `server/routes/` and the shared helpers in
 * `server/state.ts` and `server/http.ts`.
 *
 * Boot order matters:
 *   1. JSON body parser
 *   2. Security middleware (CSP + Origin check)
 *   3. Static web bundle (no-op in DEV_VITE; falls through on miss)
 *   4. `requireSpace` mounted on data-route prefixes
 *   5. Route modules in the order they should resolve
 *   6. Vite dev-only proxy (last — it swallows /everything/)
 *   7. `listen` + WebSocket upgrade handler
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { WebSocketServer } from 'ws';
import {
  attachTerminalWebSocket,
  killActiveTerminal,
} from './terminal.ts';
import { onSwitch, migrateLegacyEmbedderConfig } from './space.ts';
import { logger } from './log.ts';
import { startWatcher, stopWatcher } from './watcher.ts';
import { indexer } from './state.ts';
import { requireSpace } from './http.ts';
import { mount as mountSpaceRoutes } from './routes/space.ts';
import { mount as mountEmbedderRoutes } from './routes/embedder.ts';
import { mount as mountFilesRoutes } from './routes/files.ts';
import { mount as mountFoldersRoutes } from './routes/folders.ts';
import { mount as mountUploadRoutes } from './routes/upload.ts';
import { mount as mountIndexingRoutes } from './routes/indexing.ts';
import { mount as mountTerminalRoutes } from './routes/terminal.ts';
import { mount as mountMcpRoutes } from './routes/mcp.ts';

const log = logger('server');

function parsePortArg(argv: string[], fallback: number): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--port=')) return Number(a.slice(7)) || fallback;
    if (a === '--port') return Number(argv[i + 1]) || fallback;
  }
  return fallback;
}
const PORT = parsePortArg(process.argv.slice(2), 8090);
const VITE_PORT = Number(process.env.VITE_PORT ?? 5173);
// In dev mode the React app is served by Vite (HMR, fast refresh) but
// Electron still loads :8090 — so we proxy non-API requests through.
// Keeps the single-port story and avoids teaching Electron about Vite.
const DEV_VITE = process.env.STASHBASE_DEV_VITE === '1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(__dirname, '..');
const WEB_BUILD_DIR = path.resolve(APP_ROOT, 'web', 'dist-app');

// One-time migration from the old global-provider schema. Idempotent.
migrateLegacyEmbedderConfig();

// fs.watch the space root so external edits (vim / git / Dropbox)
// trigger a debounced re-sync. Self-writes are suppressed inside
// `files.ts:saveText` etc.
startWatcher(indexer);

const app = express();
app.use(express.json({ limit: '10mb' }));

// ----- security middleware ------------------------------------------------
//
// The server binds to 127.0.0.1 so it isn't reachable from the LAN, but a
// malicious webpage opened in the user's browser could still try to fetch
// our routes via DNS rebinding or cross-origin script injection. Two
// belt-and-suspenders defenses below:
//   1. `Content-Security-Policy` — limit what the renderer can load /
//      execute. Tighter in production; dev needs unsafe-eval for React
//      Refresh and unsafe-inline for Vite's HMR shim.
//   2. Origin check — reject requests whose `Origin` header points
//      anywhere other than our own localhost URL. Missing-Origin is
//      allowed because Electron's top-level navigation, the MCP server,
//      and `curl` all omit the header — none of which are exploitable
//      from a webpage.

const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

const CSP_PROD =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-src 'self' blob: about:; " +
  "worker-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'none';";

const CSP_DEV =
  // Same as prod but allow inline + eval scripts and a slightly wider
  // connect-src so Vite's HMR module shim and React Refresh work. Dev
  // bundle never ships to users.
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' ws: wss:; " +
  "frame-src 'self' blob: about:; " +
  "worker-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'none';";

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', DEV_VITE ? CSP_DEV : CSP_PROD);
  // Belt-and-suspenders defaults that don't change per request.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next(); // Electron loadURL / MCP / curl have none.
  if (ALLOWED_ORIGINS.has(origin)) return next();
  res.status(403).json({ error: 'cross-origin request rejected', code: 'BAD_ORIGIN' });
});

// Static layer is mounted before the API routes because it falls
// through on miss (no file → next middleware). In dev-vite mode we
// skip it entirely; the proxy at the end of the chain catches the
// browser bundle requests.
if (!DEV_VITE) {
  if (!fs.existsSync(path.join(WEB_BUILD_DIR, 'index.html'))) {
    throw new Error(
      `web/dist-app/index.html not found. Run \`pnpm build:web\` first.`,
    );
  }
  app.use(express.static(WEB_BUILD_DIR));
}

// Route-prefix gate: every API path under these roots needs an open
// space. Centralises the NO_SPACE 412 response so individual handlers
// don't have to call `requireCurrentSpace()` and the search route
// (which bypasses the files layer) can't silently run against a
// previously-bound space.
app.use([
  '/api/files',
  '/api/folders',
  '/api/search',
  '/api/sync',
  '/api/index-status',
  '/api/upload',
  '/api/rename-preview',
  '/api/file-order',
  '/api/skills',
  '/api/reveal',
  '/asset',
], requireSpace);

// ----- mount routes -------------------------------------------------------
mountSpaceRoutes(app);
mountEmbedderRoutes(app);
mountFilesRoutes(app);
mountFoldersRoutes(app);
mountUploadRoutes(app);
mountIndexingRoutes(app);
mountTerminalRoutes(app);
mountMcpRoutes(app);

// Dev-only fallthrough: any request that didn't match an `/api/*` or
// `/asset/*` route gets proxied to Vite. Must be the LAST middleware
// or it'll swallow API routes registered after it. WebSocket upgrade
// (for HMR) is wired below at `server.on('upgrade', ...)`.
const viteProxy = DEV_VITE
  ? createProxyMiddleware({
      target: `http://localhost:${VITE_PORT}`,
      changeOrigin: true,
      ws: true,
      logger: undefined,
    })
  : null;
if (viteProxy) app.use(viteProxy);

const server = app.listen(PORT, '127.0.0.1', () => {
  log.info(`listening on http://127.0.0.1:${PORT}`);
  if (DEV_VITE) log.info(`dev-proxy → vite at http://localhost:${VITE_PORT}`);
  log.info('waiting for the user to pick a space');
});

// Surface common bind failures (port collision, permission denied) with
// a clean message + exit code 1 instead of an unhandled `Error: listen
// EADDRINUSE` stack trace, which Electron presents as "server quit
// unexpectedly" with no useful context.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.warn(`port ${PORT} is already in use — is another StashBase running? Quit it (or pass --port=N to use a different port).`);
  } else if (err.code === 'EACCES') {
    log.warn(`permission denied binding to port ${PORT} — pick a port above 1024.`);
  } else {
    log.warn(`server error: ${err.message}`);
  }
  process.exit(1);
});

// Single-terminal WebSocket. The renderer connects here, the server
// spawns a PTY, and the two stream stdin/stdout for one shell. See
// `server/terminal.ts` for the protocol + lifecycle. `noServer: true`
// because we share the existing http.Server with Vite's HMR proxy.
const termWss = new WebSocketServer({ noServer: true });
termWss.on('connection', (ws) => attachTerminalWebSocket(ws));

// Tear the terminal down when the user switches spaces — that session
// was bound to the old cwd; the renderer will reconnect for the new
// space when the user opens the panel again.
onSwitch(() => killActiveTerminal());

// Hook WebSocket upgrades. `/ws/terminal` goes to our pty bridge;
// everything else (Vite HMR in dev) falls through to the existing
// proxy upgrade handler.
server.on('upgrade', (req, socket, head) => {
  // Same origin gate as the HTTP middleware — a webpage shouldn't be
  // able to open a WebSocket to our terminal bridge any more than it
  // can hit our HTTP routes. Missing Origin is allowed for non-browser
  // tools (browsers always send it on WS upgrade).
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.destroy();
    return;
  }
  const url = req.url ?? '';
  if (url.startsWith('/ws/terminal')) {
    termWss.handleUpgrade(req, socket, head, (ws) => {
      termWss.emit('connection', ws, req);
    });
    return;
  }
  if (viteProxy && 'upgrade' in viteProxy) {
    // `http.Server` types the upgrade socket as `Duplex` whereas
    // http-proxy-middleware's typed handler expects a `net.Socket`.
    // At runtime they're the same object — cast through unknown.
    (viteProxy.upgrade as unknown as (
      req: import('node:http').IncomingMessage,
      socket: unknown,
      head: Buffer,
    ) => void)(req, socket, head);
  } else {
    socket.destroy();
  }
});

// ----- graceful shutdown --------------------------------------------------
//
// Without this, SIGTERM (Electron `will-quit`) leaves the Python daemon
// orphaned still holding Milvus Lite's flock — the next launch then
// fails to open the same DB. Run the close ladder once, with a hard
// ceiling so a stuck close can't keep us pinned.

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutdown: ${reason}`);
  // Stop accepting new connections immediately; in-flight ones drain.
  try { server.close(); } catch { /* already gone */ }
  try { stopWatcher(); } catch { /* swallow */ }
  try { killActiveTerminal(); } catch { /* swallow */ }
  // Hard ceiling: if the indexer's close ladder can't unstick the
  // Python child in 4 s, exit anyway. The daemon's own kill ladder
  // is 1.5 s SIGTERM + 1.5 s SIGKILL + 0.5 s grace = 3.5 s; we leave
  // a small buffer for Milvus flush.
  const exitTimer = setTimeout(() => process.exit(0), 4000);
  try {
    await indexer.close();
  } catch (err: unknown) {
    log.warn(`shutdown: indexer.close failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(exitTimer);
    process.exit(0);
  }
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGHUP', () => { void shutdown('SIGHUP'); });
