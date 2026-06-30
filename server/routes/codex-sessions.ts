/**
 * Codex thread-history routes for the chat panel's History dropdown.
 *
 * Backed by Codex app-server's structured thread APIs. Delete maps to
 * archive because app-server exposes archive/unarchive rather than a hard
 * transcript deletion endpoint.
 */
import express from 'express';
import { getCurrentFolder } from '../folder.ts';
import { sendError } from '../http.ts';
import {
  deleteCodexSession,
  getCodexSessionMessages,
  listCodexSessions,
  renameCodexSession,
} from '../codex-agent.ts';

export function mount(app: express.Express): void {
  app.get('/api/codex/sessions', async (_req, res) => {
    try {
      res.json(await listCodexSessions(getCurrentFolder()));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.get('/api/codex/sessions/:id/messages', async (req, res) => {
    try {
      res.json(await getCodexSessionMessages(req.params.id, getCurrentFolder()));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.patch('/api/codex/sessions/:id', async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title required' });
      return;
    }
    try {
      res.json(await renameCodexSession(req.params.id, title, getCurrentFolder()));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  app.delete('/api/codex/sessions/:id', async (req, res) => {
    try {
      await deleteCodexSession(req.params.id, getCurrentFolder());
      res.json({});
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}
