/**
 * Claude session-history routes for the chat panel's History dropdown.
 *
 * These wrap the Agent SDK's on-disk session store (`~/.claude/projects/`,
 * the same transcripts the `claude` CLI writes). They sit OUTSIDE the
 * `requireFolder` gate (no 412 before a folder is open), but the LIST is filtered to
 * the current folder by session `cwd` — the panel belongs to one folder, so
 * its History shows only that folder's conversations (falls back to all
 * when no folder is open). `:id` reads/rename/delete stay global by id.
 *
 *   GET    /api/agent/sessions             → list this folder's sessions
 *   GET    /api/agent/sessions/:id/messages→ a session's transcript as
 *                                            renderable panel blocks
 *   PATCH  /api/agent/sessions/:id { title }→ rename
 *   DELETE /api/agent/sessions/:id         → delete
 *
 * Resuming a session is NOT here — that rides the `/ws/agent` connect URL
 * (`resume=<id>`, see server/agent.ts); this route only feeds the list +
 * the transcript the client paints before reconnecting.
 */
import express from 'express';
import path from 'node:path';
import {
  listSessions,
  getSessionMessages,
  getSessionInfo,
  renameSession,
  deleteSession,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { getCurrentFolder } from '../folder.ts';
import { sendError } from '../http.ts';

/** Trimmed session row sent to the client. */
interface SessionRow {
  id: string;
  title: string;
  lastModified: number;
  cwd?: string;
  gitBranch?: string;
}

function toRow(s: SDKSessionInfo): SessionRow {
  return {
    id: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
    lastModified: s.lastModified,
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
  };
}

export function mount(app: express.Express): void {
  // Sessions for the CURRENT folder, newest first. The agent always runs
  // with cwd = the open folder dir, and the SDK records `cwd` per session,
  // so filter on it — the History dropdown then shows only this folder's
  // conversations (incl. terminal Claude Code runs in the same dir),
  // matching "this panel belongs to this folder". No folder open (rare —
  // the panel needs one) → fall back to listing all so it's never blank.
  app.get('/api/agent/sessions', async (_req, res) => {
    try {
      const sessions = await listSessions();
      const folder = getCurrentFolder();
      const cur = folder ? path.resolve(folder) : null;
      const rows = sessions
        .map(toRow)
        .filter((r) => !cur || (r.cwd != null && path.resolve(r.cwd) === cur))
        .sort((a, b) => b.lastModified - a.lastModified);
      res.json(rows);
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // A session's transcript, mapped to the same block shape the WS streams
  // so the client renders it with its existing BlockView untouched.
  app.get('/api/agent/sessions/:id/messages', async (req, res) => {
    try {
      if (!(await sessionBelongsToCurrentFolder(req.params.id))) {
        res.status(404).json({ error: 'session not found for current folder' });
        return;
      }
      const msgs = await getSessionMessages(req.params.id);
      res.json(transcriptToBlocks(msgs));
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Rename (the pencil). Returns the refreshed row.
  app.patch('/api/agent/sessions/:id', async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) {
      res.status(400).json({ error: 'title required' });
      return;
    }
    try {
      if (!(await sessionBelongsToCurrentFolder(req.params.id))) {
        res.status(404).json({ error: 'session not found for current folder' });
        return;
      }
      await renameSession(req.params.id, title);
      const info = await getSessionInfo(req.params.id);
      res.json(info ? toRow(info) : { id: req.params.id, title, lastModified: 0 });
    } catch (err: unknown) {
      sendError(res, err);
    }
  });

  // Delete (the trash) — removes the `{id}.jsonl` transcript.
  app.delete('/api/agent/sessions/:id', async (req, res) => {
    try {
      if (!(await sessionBelongsToCurrentFolder(req.params.id))) {
        res.status(404).json({ error: 'session not found for current folder' });
        return;
      }
      await deleteSession(req.params.id);
      res.json({});
    } catch (err: unknown) {
      sendError(res, err);
    }
  });
}

async function sessionBelongsToCurrentFolder(id: string): Promise<boolean> {
  const folder = getCurrentFolder();
  // When no folder is open, the list route intentionally falls back to
  // all sessions; keep direct actions global before a folder is open.
  if (!folder) return true;
  const info = await getSessionInfo(id);
  return sessionInfoMatchesFolder(info, folder);
}

export function sessionInfoMatchesFolder(info: { cwd?: unknown } | null | undefined, folder: string): boolean {
  return !!(info && typeof info.cwd === 'string' && path.resolve(info.cwd) === path.resolve(folder));
}

// ----- transcript → panel blocks ----------------------------------------

/** The renderable block shape the client's BlockView consumes. Mirrors
 *  AgentView's `Block` union (history tools are always settled: 'done' or
 *  'error'). */
type WireBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; status: 'done' | 'error'; result?: string };

/** Walk a session's messages in order into panel blocks, stitching each
 *  `tool_result` (which arrives as a later user-role message) back onto
 *  its originating `tool_use` block by id — the same correlation the live
 *  WS path does, just replayed from disk. */
function transcriptToBlocks(msgs: Array<{ type: string; message: unknown }>): WireBlock[] {
  const blocks: WireBlock[] = [];
  const toolById = new Map<string, Extract<WireBlock, { kind: 'tool' }>>();
  let seq = 0;
  const id = () => `h${seq++}`;

  for (const m of msgs) {
    const message = m.message as { role?: string; content?: unknown };
    const content = message?.content;

    if (m.type === 'user') {
      if (typeof content === 'string') {
        if (content.trim()) blocks.push({ kind: 'user', id: id(), text: content });
        continue;
      }
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === 'text' && typeof b.text === 'string') {
            texts.push(b.text);
          } else if (b.type === 'tool_result') {
            const tool = toolById.get(String(b.tool_use_id));
            if (tool) {
              tool.result = stringifyToolResult(b.content);
              if (b.is_error === true) tool.status = 'error';
            }
          }
        }
        const joined = texts.join('\n').trim();
        if (joined) blocks.push({ kind: 'user', id: id(), text: joined });
      }
      continue;
    }

    if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          blocks.push({ kind: 'assistant', id: id(), text: b.text });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          blocks.push({ kind: 'thinking', id: id(), text: b.thinking });
        } else if (b.type === 'tool_use') {
          const tool: Extract<WireBlock, { kind: 'tool' }> = {
            kind: 'tool',
            id: id(),
            name: String(b.name ?? ''),
            input: (b.input as Record<string, unknown>) ?? {},
            status: 'done',
          };
          toolById.set(String(b.id), tool);
          blocks.push(tool);
        }
      }
    }
  }
  return blocks;
}

/** Stringify a tool_result `content` (string, or text/other blocks) — the
 *  same shape `server/agent.ts` renders for live tool results. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}
