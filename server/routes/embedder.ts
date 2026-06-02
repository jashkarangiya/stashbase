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
import {
  getApiKey,
  getCurrentSpace,
  getEmbedderProvider,
  setApiKey,
} from '../space.ts';
import { bindIndexerForSpace } from '../state.ts';
import { validateOpenAIKey } from '../http.ts';

const log = logger('routes/embedder');

export function mount(app: express.Express): void {
  // Embedder status: the fixed provider + whether a key is configured.
  app.get('/api/embedder', (_req, res) => {
    res.json({
      provider: getEmbedderProvider(),
      hasKey: !!getApiKey(),
    });
  });

  // Set / rotate the global OpenAI key. Validates first so a typo can't
  // blow away a working one, then rebinds the current space so the
  // daemon picks up the key for subsequent embeds (and creates the
  // collection on the first key).
  app.put('/api/embedder/key', async (req, res) => {
    const key = typeof req.body?.openaiKey === 'string' ? req.body.openaiKey.trim() : '';
    if (!key) return res.status(400).json({ error: 'openaiKey required' });
    const check = await validateOpenAIKey(key);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    setApiKey(key);
    const cur = getCurrentSpace();
    if (cur) {
      try {
        await bindIndexerForSpace(cur);
      } catch (err: unknown) {
        log.warn(`key set: rebind failed: ${errorMessage(err)}`);
      }
    }
    res.json({ hasKey: true });
  });

  // Wipe the global OpenAI key. New embed / search calls will no-op
  // until a key is added back; existing vectors stay valid.
  app.delete('/api/embedder/key', (_req, res) => {
    setApiKey(undefined);
    res.json({ hasKey: false });
  });

  // Validate an OpenAI key without persisting it (for the key-entry UI).
  app.post('/api/embedder/validate', async (req, res) => {
    const key = typeof req.body?.openaiKey === 'string' ? req.body.openaiKey.trim() : '';
    if (!key) return res.status(400).json({ error: 'openaiKey required' });
    const check = await validateOpenAIKey(key);
    if (check.ok) return res.json({});
    res.status(check.status).json({ error: check.error });
  });
}
