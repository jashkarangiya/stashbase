/**
 * Composer attachments — files a user drags or picks into the chat panel
 * as transient context. Unlike `/api/upload` (which imports into the
 * active folder, where files are indexed + tree-visible + tracked by git),
 * these are written to a throwaway OS temp dir and referenced by absolute
 * path: the agent reads them via its Read tool, but they never land in
 * the user's library.
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeFilename } from '../files.ts';
import { errorMessage, logger } from '../log.ts';

const log = logger('routes/attach');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024, files: 50 },
});

const ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Root for transient attachment files, outside any folder. */
function attachRoot(): string {
  return path.join(os.tmpdir(), 'stashbase-attachments');
}

export function safeAttachmentName(original: string): string {
  const raw = original && original.trim() ? original : 'file';
  const base = path.posix.basename(raw.replace(/\\/g, '/')) || 'file';
  const sanitized = sanitizeFilename(base)
    .replace(/[\x00-\x1f'"]/g, '-')
    .replace(/^\.*/, '')
    .trim();
  return sanitized || 'file';
}

export function cleanupStaleAttachments(root = attachRoot(), maxAgeMs = ATTACHMENT_MAX_AGE_MS, now = Date.now()): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(root, entry.name);
    try {
      const st = fs.statSync(abs);
      if (now - st.mtimeMs > maxAgeMs) fs.rmSync(abs, { recursive: true, force: true });
    } catch (err: unknown) {
      log.warn(`attach: cleanup ${entry.name} failed: ${errorMessage(err)}`);
    }
  }
}

export function uniqueAttachmentName(original: string, used: Set<string>): string {
  const safe = safeAttachmentName(original);
  let candidate = safe;
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${stem}-${i}${ext}`;
    i += 1;
  }
  used.add(candidate);
  return candidate;
}

export function mount(app: express.Express): void {
  app.post('/api/agent/attach', (req, res) => {
    upload.array('files', 50)(req, res, (err: unknown) => {
      if (err) {
        sendAttachError(res, err);
        return;
      }
      const files = (req.files as Express.Multer.File[]) ?? [];
      if (files.length === 0) { res.status(400).json({ error: 'no files' }); return; }
      cleanupStaleAttachments();
      // One throwaway dir per batch so same-named files never collide.
      const dir = path.join(attachRoot(), randomUUID());
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err: unknown) {
        res.status(500).json({ error: errorMessage(err) });
        return;
      }
      const out: { name: string; path?: string; error?: string }[] = [];
      const usedNames = new Set<string>();
      for (const f of files) {
        const name = uniqueAttachmentName(f.originalname || 'file', usedNames);
        try {
          const abs = path.join(dir, name);
          fs.writeFileSync(abs, f.buffer);
          out.push({ name, path: abs });
        } catch (err: unknown) {
          log.warn(`attach: write ${name} failed: ${errorMessage(err)}`);
          out.push({ name, error: errorMessage(err) });
        }
      }
      if (out.every((entry) => entry.error)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      res.json({ files: out });
    });
  });
}

function sendAttachError(res: express.Response, err: unknown): void {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'file is too large to attach'
      : err.code === 'LIMIT_FILE_COUNT'
        ? 'too many files in one attachment batch'
        : err.message;
    res.status(status).json({ error: message, code: err.code });
    return;
  }
  res.status(400).json({ error: errorMessage(err) });
}
