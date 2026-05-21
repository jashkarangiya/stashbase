/**
 * Terminal CLI routes: enumerate the registry, switch the active CLI,
 * probe a single CLI's binary, and SSE-stream the npm install /
 * uninstall lifecycle so the renderer can show live progress.
 */
import express from 'express';
import {
  checkCliInstalled,
  CLIS,
  killActiveTerminal,
  launchCommandFor,
  spawnGlobalInstall,
  spawnGlobalUninstall,
} from '../terminal.ts';
import { setTerminalCli, getTerminalCli } from '../space.ts';

export function mount(app: express.Express): void {
  // Terminal CLI registry + user preference. The renderer reads this
  // to populate the picker and to know which CLI to run on open.
  app.get('/api/terminal/clis', (_req, res) => {
    const current = getTerminalCli();
    res.json({
      current,
      clis: Object.values(CLIS).map((c) => ({
        id: c.id,
        label: c.label,
        vendor: c.vendor,
        installHint: c.installHint,
        installed: checkCliInstalled(c.id),
        launchCommand: launchCommandFor(c),
      })),
    });
  });

  // Switch the *default* CLI used when the renderer opens a new chat
  // tab. Existing tabs keep running their own CLI — each tab owns its
  // own PTY (see terminal.ts). Space switch still tears down everything
  // via onSwitch → killActiveTerminal.
  app.put('/api/terminal/cli', (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    if (!CLIS[id]) return res.status(400).json({ error: 'unknown cli id' });
    setTerminalCli(id);
    res.json({ current: id });
  });

  // Probe a single CLI's binary. UI calls this on demand (after a
  // fresh install) without re-listing the whole registry.
  app.get('/api/terminal/check/:cli', (req, res) => {
    const id = req.params.cli;
    if (!CLIS[id]) return res.status(404).json({ error: 'unknown cli id' });
    res.json({ installed: checkCliInstalled(id) });
  });

  // SSE-stream `npm install -g <pkg>` for a given CLI. Shared shape
  // across CLIs — only the underlying package name differs. Killed
  // when the client disconnects.
  app.get('/api/terminal/install/:cli', (req, res) => {
    streamPackageOp(req, res, spawnGlobalInstall(req.params.cli));
  });

  // Symmetric uninstall — `npm uninstall -g <pkg>` for the same CLI.
  app.get('/api/terminal/uninstall/:cli', (req, res) => {
    streamPackageOp(req, res, spawnGlobalUninstall(req.params.cli));
  });
}

/** Boilerplate shared by install + uninstall routes: pipe a child's
 *  stdout/stderr through SSE, emit a final `exit` event with the
 *  exit code, and kill the child if the client disconnects mid-run. */
function streamPackageOp(
  req: express.Request,
  res: express.Response,
  child: ReturnType<typeof spawnGlobalInstall> | null,
): void {
  if (!child) {
    res.status(404).json({ error: 'unknown cli id' });
    return;
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  const send = (event: string, data: string) => {
    res.write(`event: ${event}\ndata: ${data.replace(/\n/g, '\ndata: ')}\n\n`);
  };
  child.stdout?.on('data', (b) => send('out', b.toString('utf8')));
  child.stderr?.on('data', (b) => send('err', b.toString('utf8')));
  child.on('exit', (code, signal) => {
    send('exit', JSON.stringify({ code, signal }));
    res.end();
  });
  req.on('close', () => {
    if (!child.killed) child.kill('SIGTERM');
  });
}
