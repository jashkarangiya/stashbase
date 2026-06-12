/**
 * Agent CLI registry routes: enumerate the supported CLIs (with their
 * installed-state) and record the user's last-used default. The chat
 * panel reads these to populate its launchers; the CLIs themselves run
 * via the SDK-backed agent session (see server/agent.ts), not a PTY.
 */
import express from 'express';
import { checkCliInstalled, CLIS, launchCommandFor } from '../terminal.ts';
import { setTerminalCli, getTerminalCli } from '../app-config.ts';

export function mount(app: express.Express): void {
  // Agent CLI registry + user preference. The renderer reads this to
  // populate the launchers and know each CLI's installed-state.
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

  // Record the *default* agent the chat panel opens next. Existing tabs
  // keep their own agent (locked at tab creation).
  app.put('/api/terminal/cli', (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    if (!CLIS[id]) return res.status(400).json({ error: 'unknown cli id' });
    setTerminalCli(id);
    res.json({ current: id });
  });
}
