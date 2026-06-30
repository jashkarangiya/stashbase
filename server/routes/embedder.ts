/**
 * Embedder routes: manage the global OpenAI key (the only embedder
 * setting in V1) and validate a key without persisting it.
 *
 * V1 fixes the embedder to OpenAI — there is no provider switching and
 * no multi-collection migration. The daemon owns one Milvus collection;
 * with no key set, indexing/search are disabled until the user adds one
 * (files still save and preview — graceful no-key degrade).
 */
import express from 'express';
import { logger, errorMessage } from '../log.ts';
import { currentWindowId, getCurrentFolder } from '../folder.ts';
import { getApiKey, getEmbedderProvider, setApiKey } from '../app-config.ts';
import { bootBindAllFolders, resetIndexerRuntime, scheduleIndexerSync } from '../state.ts';
import { sendError, validateOpenAIKey } from '../http.ts';

const log = logger('routes/embedder');

export function mount(app: express.Express): void {
  // Embedder status: the fixed provider + whether a key is configured.
  app.get('/api/embedder', (_req, res) => {
    res.json({
      provider: getEmbedderProvider(),
      hasKey: !!getApiKey(),
    });
  });

  // Set / rotate the global OpenAI key. A definite OpenAI rejection
  // blocks the save so a typo can't blow away a working key. A network /
  // transient validation failure still saves the key: offline/proxied
  // machines need to configure first and let indexing report connectivity
  // failures later.
  app.put('/api/embedder/key', async (req, res) => {
    const key = typeof req.body?.openaiKey === 'string' ? req.body.openaiKey.trim() : '';
    if (!key) return res.status(400).json({ error: 'openaiKey required' });
    const check = await validateOpenAIKey(key);
    const warning = check.ok ? undefined : check.error;
    if (!check.ok && check.status < 500) return res.status(check.status).json({ error: check.error });
    try {
      setApiKey(key);
    } catch (err: unknown) {
      sendError(res, err);
      return;
    }
    try {
      await resetIndexerRuntime({ forgetBindings: true });
      await bootBindAllFolders();
      const cur = getCurrentFolder();
      if (cur) {
        scheduleIndexerSync(cur, 'embedder key set', currentWindowId());
      }
    } catch (err: unknown) {
      log.warn(`key set: runtime reset/rebind failed: ${errorMessage(err)}`);
    }
    res.json({ hasKey: true, ...(warning ? { warning } : {}) });
  });

  // Wipe the global OpenAI key. New embed / search calls will no-op
  // until a key is added back; existing vectors stay valid.
  app.delete('/api/embedder/key', async (_req, res) => {
    try {
      setApiKey(undefined);
    } catch (err: unknown) {
      sendError(res, err);
      return;
    }
    try {
      await resetIndexerRuntime({ forgetBindings: true });
      await bootBindAllFolders();
    } catch (err: unknown) {
      log.warn(`key delete: runtime reset failed: ${errorMessage(err)}`);
    }
    res.json({ hasKey: false });
  });
}
