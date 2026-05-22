/**
 * Embedder routes: pick the library-wide embedding provider, manage the
 * global OpenAI key, validate a key without persisting it, estimate the
 * re-embed cost of a provider switch.
 *
 * Multi-collection model: switching the provider does NOT drop any
 * data. The daemon owns one Milvus DB at kbRoot with one collection per
 * (provider, dim); `bind_space` registers which collection a space's
 * future writes go to. After a switch:
 *   - Already-indexed rows stay in their OLD collection, still
 *     searchable across the library via the same Milvus DB.
 *   - New / re-saved files write to the NEW collection.
 *   - A follow-up syncIndex re-embeds existing rows under the new
 *     provider — fire-and-forget so the UI stays responsive. Every
 *     bound space gets queued in the background.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { HIDDEN_DOT_DIRS } from '../files.ts';
import { logger, errorMessage } from '../log.ts';
import {
  getApiKey,
  getCurrentSpace,
  getCurrentSpaceName,
  getEmbedderProvider,
  getKbRoot,
  listKnownSpaces,
  setApiKey,
  setEmbedderProvider,
  type EmbedderProvider,
} from '../space.ts';
import { syncIndex } from '../sync.ts';
import { indexer, bindIndexerForSpace, resolveEmbedder } from '../state.ts';
import { sendError, validateOpenAIKey } from '../http.ts';

const log = logger('routes/embedder');

export function mount(app: express.Express): void {
  // Library-wide provider + global API key. The provider determines
  // which collection every space's NEW writes go to; existing rows in
  // the old collection stay searchable.
  app.get('/api/embedder', (_req, res) => {
    res.json({
      provider: getEmbedderProvider(),
      hasKey: !!getApiKey(),
    });
  });

  // Change the global OpenAI key WITHOUT touching the provider choice.
  // Validates the new key first so a typo can't blow away a working
  // one. If we're on OpenAI, rebind the current space so the daemon
  // picks up the new key for subsequent embeds (same dim, no data
  // movement).
  app.put('/api/embedder/key', async (req, res) => {
    const key = typeof req.body?.openaiKey === 'string' ? req.body.openaiKey.trim() : '';
    if (!key) return res.status(400).json({ error: 'openaiKey required' });
    const check = await validateOpenAIKey(key);
    if (!check.ok) return res.status(check.status).json({ error: check.error });
    setApiKey(key);
    const cur = getCurrentSpace();
    if (cur && getEmbedderProvider() === 'openai') {
      try {
        await bindIndexerForSpace(cur);
      } catch (err: unknown) {
        log.warn(`key rotate: rebind failed: ${errorMessage(err)}`);
      }
    }
    res.json({ hasKey: true });
  });

  // Wipe the global OpenAI key. If the provider is `openai`, new embed
  // / search calls will fail until a key is added back or the provider
  // is switched to Local; existing vectors stay valid.
  app.delete('/api/embedder/key', (_req, res) => {
    setApiKey(undefined);
    res.json({ hasKey: false });
  });

  // Validate an OpenAI key without persisting it.
  app.post('/api/embedder/validate', async (req, res) => {
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : 'openai';
    const key = typeof req.body?.openaiKey === 'string' ? req.body.openaiKey.trim() : '';
    if (provider !== 'openai') return res.json({});
    if (!key) return res.status(400).json({ error: 'openaiKey required' });
    const check = await validateOpenAIKey(key);
    if (check.ok) return res.json({});
    res.status(check.status).json({ error: check.error });
  });

  // Switch the library-wide embedder. Re-binds every known space to
  // the new provider's collection — existing rows stay in the OLD
  // collection (still searchable) and a background sync re-embeds them
  // into the NEW one to keep results stable. No space needs to be open.
  app.put('/api/embedder', async (req, res) => {
    const provider: EmbedderProvider | undefined = req.body?.provider;
    if (provider !== 'onnx' && provider !== 'openai') {
      return res.status(400).json({ error: 'provider must be "onnx" or "openai"' });
    }
    const rawKey = typeof req.body?.openaiKey === 'string' ? req.body.openaiKey.trim() : '';
    if (rawKey) setApiKey(rawKey);
    const apiKey = getApiKey();
    if (provider === 'openai' && !apiKey) {
      return res.status(400).json({ error: 'openaiKey required for openai provider' });
    }
    try {
      setEmbedderProvider(provider);
      const cfg = resolveEmbedder() ?? { provider: 'onnx' as const };
      // Rebind + re-embed every known space. The current space is
      // bound first / synced first so the UI sees fresh results
      // soonest; the rest fan out in the background.
      const known = listKnownSpaces();
      const current = getCurrentSpaceName();
      const ordered = current
        ? [current, ...known.filter((s) => s !== current)]
        : known;
      for (const space of ordered) {
        try {
          await indexer.bindSpace(space, cfg);
        } catch (err: unknown) {
          log.warn(`embedder: bindSpace ${space} failed: ${errorMessage(err)}`);
        }
      }
      // Fire-and-forget per-space re-embed. Errors logged, not fatal —
      // the user can hit the manual sync button per space if needed.
      for (const space of ordered) {
        syncIndex(indexer, space).catch((err) =>
          log.warn(`embedder: post-switch sync ${space} failed: ${errorMessage(err)}`),
        );
      }
      res.json({ provider, hasKey: !!apiKey });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Cost estimate for switching to a given provider. Walks the entire
  // library on disk and reports a rough token + USD estimate. Tokens
  // are estimated as bytes/4 — accurate for English, low for CJK.
  app.get('/api/embedder/cost-estimate', (req, res) => {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : 'openai';
    const root = getKbRoot();
    let files = 0;
    let bytes = 0;
    for (const space of listKnownSpaces()) {
      const spaceRoot = path.join(root, space);
      try {
        walkSpaceForCost(spaceRoot, (size) => { files++; bytes += size; });
      } catch (err: unknown) {
        log.warn(`cost-estimate: failed to walk ${spaceRoot}: ${errorMessage(err)}`);
      }
    }
    const tokens = Math.ceil(bytes / 4);
    const costUsd = provider === 'openai' ? (tokens * 0.02) / 1_000_000 : 0;
    res.json({ provider, files, bytes, tokens, costUsd });
  });
}

/** Walk a space directory and report each indexable file's size.
 *  Skips `.stashbase/` (our sidecar dir) and load-bearing hidden dirs. */
function walkSpaceForCost(root: string, onFile: (size: number) => void): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && HIDDEN_DOT_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (lower.endsWith('.md') || lower.endsWith('.html') || lower.endsWith('.htm')) {
          try { onFile(fs.statSync(full).size); } catch { /* unreadable — skip */ }
        }
      }
    }
  }
}
