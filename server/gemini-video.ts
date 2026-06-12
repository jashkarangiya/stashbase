/**
 * Screen-recording → Markdown note via Gemini's video understanding.
 *
 * Replaces frame-sampling OCR for recordings (`/api/recording`): Gemini
 * reads layout, reading order, and temporal flow natively, fixing the
 * multi-column / dynamic-content corner cases per-frame OCR can't.
 *
 * Talks to the Gemini Developer API (`generativelanguage.googleapis.com`)
 * over **raw REST with `?key=`** — deliberately NOT via the `@google/genai`
 * SDK, whose Files-upload path picks up ambient Google ADC / OAuth creds
 * and then fails with `ACCESS_TOKEN_TYPE_UNSUPPORTED`. The flow matches a
 * plain `curl`: resumable Files upload → poll until ACTIVE → generateContent
 * → delete the uploaded file.
 *
 * Opt-in: key is configured in Settings → Capture (stored in
 * `~/.stashbase/config.json`). Falls back to `GEMINI_API_KEY` / `GOOGLE_API_KEY`
 * env vars for backward compatibility. When absent, the recording route falls
 * back to local frame-OCR. Model override: `GEMINI_VIDEO_MODEL` (default flash).
 * Privacy: this uploads the recording to Google — a deliberate departure from
 * the otherwise local-first path.
 */
import { readFile } from 'node:fs/promises';
import { logger } from './log.ts';
import { getGeminiKey } from './app-config.ts';

const log = logger('gemini-video');
const BASE = 'https://generativelanguage.googleapis.com';

const PROMPT = `You are analyzing a screen recording for a personal knowledge base. Produce a single Markdown note.

Use exactly this structure:

# <concise title of what this recording is about>

## Summary
2–4 sentences: what the recording shows and what the user is doing.

## Content
Faithfully extract the meaningful on-screen text and information in natural reading order. Respect columns and sections — never interleave separate columns. Preserve structure as Markdown (headings, lists, code blocks, tables). Skip UI chrome (menu bars, OS clock, window controls, scrollbars, browser tab strips) and transient noise. If content scrolls or changes over time, consolidate it without duplication.

Output only the Markdown note — no preamble and no surrounding code fence.`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function apiKey(): string | undefined {
  return getGeminiKey() || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

/** True when a Gemini key is configured — the recording route uses this to
 *  choose Gemini vs the local frame-OCR fallback. */
export function geminiConfigured(): boolean {
  return Boolean(apiKey());
}

interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED' | string;
}

async function bodyText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 500); } catch { return '(no body)'; }
}

/** Resumable Files-API upload (start → upload+finalize). Returns the file
 *  record (still PROCESSING for video). */
async function uploadFile(key: string, bytes: Uint8Array, mimeType: string): Promise<GeminiFile> {
  const start = await fetch(`${BASE}/upload/v1beta/files?key=${key}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.byteLength),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'recording' } }),
  });
  if (!start.ok) throw new Error(`files:start ${start.status}: ${await bodyText(start)}`);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('files:start returned no upload URL');

  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.byteLength),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
  });
  if (!up.ok) throw new Error(`files:upload ${up.status}: ${await bodyText(up)}`);
  const json = (await up.json()) as { file?: GeminiFile };
  if (!json?.file?.name) throw new Error('files:upload returned no file');
  return json.file;
}

/** Upload `videoAbsPath` to Gemini, get the structured Markdown note, then
 *  delete the uploaded file. Rejects on any failure. */
export async function analyzeVideoWithGemini(videoAbsPath: string, mimeType: string): Promise<string> {
  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const model = process.env.GEMINI_VIDEO_MODEL || 'gemini-2.5-flash';

  const bytes = await readFile(videoAbsPath);
  log.info(`gemini: uploading recording (${mimeType}, ${bytes.byteLength} bytes) …`);
  let file = await uploadFile(key, bytes, mimeType);

  // Video files are processed asynchronously; wait for ACTIVE (capped).
  const deadline = Date.now() + 5 * 60 * 1000;
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('Gemini file processing timed out');
    await sleep(2000);
    const r = await fetch(`${BASE}/v1beta/${file.name}?key=${key}`);
    if (!r.ok) throw new Error(`files:get ${r.status}: ${await bodyText(r)}`);
    file = await r.json() as GeminiFile;
  }
  if (file.state !== 'ACTIVE') throw new Error(`Gemini file not ACTIVE (state=${file.state})`);

  log.info(`gemini: analysing with ${model} …`);
  try {
    const res = await fetch(`${BASE}/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
            { text: PROMPT },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`generateContent ${res.status}: ${await bodyText(res)}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text || '').join('').trim();
    if (!text) {
      const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || 'empty response';
      throw new Error(`Gemini returned no text (${reason})`);
    }
    return text;
  } finally {
    // Don't leave the recording on Google's servers longer than needed.
    try { await fetch(`${BASE}/v1beta/${file.name}?key=${key}`, { method: 'DELETE' }); }
    catch (err) { log.warn(`gemini: file delete failed: ${err instanceof Error ? err.message : err}`); }
  }
}
