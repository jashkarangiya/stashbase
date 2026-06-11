/**
 * Screen-recording ingest route.
 *
 * Recordings differ from dropped-in videos by design (see design-docs):
 * the video is a *means to text*, not content to archive. So unlike the
 * upload route — which saves a dropped video and OCRs it into a hidden
 * `.<file>.md` sidecar (video kept) — this route:
 *
 *   1. writes the webm to a throwaway OS temp file (NOT the space),
 *   2. frame-OCRs it in the background,
 *   3. writes a VISIBLE `recording-<ts>.md` note into the space,
 *   4. deletes the temp webm.
 *
 * No multi-GB webms accumulate in the KB; the note is a first-class
 * document (not a hidden derivative of a file that no longer exists).
 * Progress surfaces through the same "Converting…" banner as the file
 * converters (`runBackgroundConversion`, keyed to the note path).
 */
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBackgroundConversion } from '../conversion.ts';
import { sanitizeFilename, saveText } from '../files.ts';
import { analyzeVideoWithGemini, geminiConfigured } from '../gemini-video.ts';
import { errorMessage, logger } from '../log.ts';
import { getCurrentSpace, getGeminiKey, runWithWindowId, setGeminiKey, toKbRel, WINDOW_ID_HEADER } from '../space.ts';
import { indexer } from '../state.ts';

const log = logger('routes/recording');

// Recordings are processed from memory then discarded; allow comfortably
// larger than the 64 MB upload cap since nothing persists to the space.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024, files: 1 },
});

export function mount(app: express.Express): void {
  app.post('/api/recording', upload.single('file'), async (req, res) => {
    // Re-bind the window context dropped by multer's body parsing (same
    // reason as the upload route) so space-scoped lookups resolve.
    await runWithWindowId(req.header(WINDOW_ID_HEADER), () => handleRecording(req, res));
  });

  // Gemini key management — GET (configured?), PUT (set), DELETE (remove).
  app.get('/api/gemini/key', (_req, res) => {
    res.json({ hasKey: geminiConfigured() });
  });

  app.put('/api/gemini/key', (req, res) => {
    const key = typeof req.body?.geminiKey === 'string' ? req.body.geminiKey.trim() : '';
    if (!key) { res.status(400).json({ error: 'geminiKey required' }); return; }
    setGeminiKey(key);
    res.json({ hasKey: true });
  });

  app.delete('/api/gemini/key', (_req, res) => {
    setGeminiKey(undefined);
    res.json({ hasKey: false });
  });
}

function recordingStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Debug switch (developer-facing env var, like `STASHBASE_PYTHON`). When
 *  on, the recording isn't discarded: the webm + final note are kept under
 *  `~/.stashbase/recording-debug/recording-<ts>/` so the Gemini output can
 *  be compared against the source video. */
function recordingDebugEnabled(): boolean {
  const v = process.env.STASHBASE_RECORDING_DEBUG;
  return v === '1' || v === 'true' || v === 'yes';
}

function handleRecording(req: express.Request, res: express.Response): void {
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'no file' }); return; }

  // Recording is Gemini-only by design — no local frame-OCR fallback.
  // (2026-06 decision: the feature's promise is a high-quality structured
  // note; a low-quality offline fallback dilutes it. The renderer
  // pre-checks the key before recording starts; this is the backstop.)
  if (!geminiConfigured()) {
    res.status(412).json({
      error: 'Screen recording needs a Gemini API key — add one in Settings → Capture.',
      code: 'GEMINI_KEY_REQUIRED',
    });
    return;
  }

  const space = getCurrentSpace();
  if (!space) { res.status(412).json({ error: 'no space open', code: 'NO_SPACE' }); return; }

  let dir = typeof req.body?.dir === 'string' ? req.body.dir.trim() : '';
  if (dir) dir = sanitizeFilename(dir).replace(/\/+$/, '');
  const prefix = dir ? dir + '/' : '';
  const stamp = recordingStamp();
  const noteRel = `${prefix}recording-${stamp}.md`;

  // Resolve the KB-relative form now, while the window context is live —
  // the background job runs after the response and we re-bind there.
  let kbRel: string;
  try {
    kbRel = toKbRel(noteRel);
  } catch {
    res.status(412).json({ error: 'no space open', code: 'NO_SPACE' });
    return;
  }

  // Stash the webm in a throwaway temp file for the extractor to read.
  const tmpVideo = path.join(os.tmpdir(), `stashbase-rec-${stamp}-${process.pid}.webm`);
  try {
    fs.writeFileSync(tmpVideo, file.buffer);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
    return;
  }

  // Respond now; OCR runs in the background and the note appears when done
  // (the sidebar's "Converting…" banner tracks `kbRel` meanwhile).
  res.json({ ok: true, file: noteRel });

  // Debug bundle dir (kept across the run) when the env switch is on.
  let debugDir: string | null = null;
  if (recordingDebugEnabled()) {
    debugDir = path.join(os.homedir(), '.stashbase', 'recording-debug', `recording-${stamp}`);
    try { fs.mkdirSync(debugDir, { recursive: true }); }
    catch (err) { log.warn(`recording debug dir failed: ${errorMessage(err)}`); debugDir = null; }
  }

  const windowId = req.header(WINDOW_ID_HEADER);
  void runBackgroundConversion(kbRel, () => runWithWindowId(windowId, async () => {
    let text: string;
    try {
      // Gemini video understanding — reads layout / reading order /
      // temporal flow that per-frame OCR can't (multi-column, dynamic).
      text = await analyzeVideoWithGemini(tmpVideo, 'video/webm');
    } catch (err) {
      // Always leave a visible note — the video is gone, so a silent
      // failure would lose the recording entirely.
      log.warn(`recording analysis failed for ${noteRel}: ${errorMessage(err)}`);
      text = `# Recording\n\n_Could not analyze this recording: ${errorMessage(err)}_\n`;
    } finally {
      // Debug mode keeps the source webm in the bundle instead of dropping it.
      if (debugDir) {
        try { fs.copyFileSync(tmpVideo, path.join(debugDir, 'source.webm')); }
        catch (err) { log.warn(`recording debug copy failed: ${errorMessage(err)}`); }
      }
      try { fs.rmSync(tmpVideo, { force: true }); } catch { /* best-effort */ }
    }
    saveText(noteRel, text);
    await indexer.upsertFile(kbRel, text);
    if (debugDir) {
      try { fs.writeFileSync(path.join(debugDir, path.basename(noteRel)), text); } catch { /* best-effort */ }
      log.info(`recording debug bundle: ${debugDir}`);
    }
    log.info(`recording note written: ${noteRel}`);
  }));
}
