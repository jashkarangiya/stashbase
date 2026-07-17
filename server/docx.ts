/**
 * DOCX -> semantic HTML conversion, driven by Mammoth.
 *
 * DOCX stays as the user-facing source file. The renderer converts that source
 * directly for the immediate visible preview. This server-side path stores a
 * durable derived HTML representation in AppData for preview fallback, keyword
 * search, Agent text reads, and semantic indexing under the original `.docx`
 * path.
 */
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { isDocxFile } from './format.ts';
import { derivedDir, derivedHtmlFor } from './derived-store.ts';
import {
  discoverNewSources,
  indexFreshDerived,
  maybeConvert,
  TransientConversionError,
  type ConversionSpec,
} from './conversion.ts';
import { logger } from './log.ts';
import { hasNoExtractableText } from './indexable.ts';
import { docxSanitizePolicy } from '../shared/html-sanitization.ts';

const log = logger('docx');
const DOCX_COMPLETE_MARKER = '<!-- stashbase-docx-conversion: complete -->';
const DOCX_CONVERSION_TIMEOUT_MS = 60_000;
const moduleRequire = createRequire(import.meta.url);
const mammothModuleUrl = pathToFileURL(moduleRequire.resolve('mammoth')).href;
const sanitizeHtmlModuleUrl = pathToFileURL(moduleRequire.resolve('sanitize-html')).href;

type DocxWorkerMessage =
  | { ok: true; html: string; messages: string[] }
  | { ok: false; error: string };

// An eval worker avoids shipping a second server entry point while still
// giving the scheduler a process boundary it can terminate. Pass Mammoth's
// resolved path explicitly so pnpm and packaged Electron layouts both work.
const DOCX_WORKER_SOURCE = [
  "void import('node:worker_threads').then(async ({ parentPort, workerData }) => {",
  '  try {',
  '    const mammothModule = await import(workerData.mammothModuleUrl);',
  '    const sanitizeHtmlModule = await import(workerData.sanitizeHtmlModuleUrl);',
  '    const mammoth = mammothModule.default || mammothModule;',
  '    const sanitizeHtml = sanitizeHtmlModule.default || sanitizeHtmlModule;',
  '    const result = await mammoth.convertToHtml(',
  '      { path: workerData.docxPath },',
  '      { convertImage: mammoth.images.dataUri },',
  '    );',
  '    const html = sanitizeHtml(result.value, {',
  '      ...workerData.sanitizePolicy,',
  '      transformTags: {',
  "        input: (_tagName, attributes) => ({ tagName: 'input', attribs: { type: 'checkbox', disabled: '', ...(Object.hasOwn(attributes, 'checked') ? { checked: '' } : {}) } }),",
  "        img: (_tagName, attributes) => { const { src, ...safeAttributes } = attributes; if (src && (!src.toLowerCase().startsWith('data:') || /^data:image\\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(src))) safeAttributes.src = src; return { tagName: 'img', attribs: safeAttributes }; },",
  '      },',
  '    });',
  '    parentPort.postMessage({',
  '      ok: true,',
  '      html,',
  "      messages: result.messages.map((message) => message.message || String(message)),",
  '    });',
  '  } catch (error) {',
  "    parentPort.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });",
  '  }',
  '});',
].join('\n');

export function derivedHtmlPathForDocx(docxAbsPath: string): string {
  return derivedHtmlFor(docxAbsPath);
}

function cleanupDerivedDocx(docxAbsPath: string): void {
  rmSync(derivedHtmlPathForDocx(docxAbsPath), { force: true });
}

function derivedDocxIsComplete(_docxAbsPath: string, htmlPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(htmlPath, 'r');
    const tailBytes = 2048;
    const size = statSync(htmlPath).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8').includes(DOCX_COMPLETE_MARKER) && !hasNoExtractableText(htmlPath);
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function extractDocxInWorker(
  docxAbsPath: string,
  signal?: AbortSignal,
): Promise<{ html: string; messages: string[] }> {
  if (signal?.aborted) {
    return Promise.reject(new TransientConversionError('docx_extract cancelled'));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(DOCX_WORKER_SOURCE, {
      eval: true,
      workerData: {
        docxPath: docxAbsPath,
        mammothModuleUrl,
        sanitizeHtmlModuleUrl,
        sanitizePolicy: docxSanitizePolicy(),
      },
    });
    let stopping = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.removeAllListeners();
    };

    const finish = (result: { value?: { html: string; messages: string[] }; error?: Error }) => {
      if (stopping) return;
      stopping = true;
      cleanup();
      // A task does not release its scheduler lane until its worker has
      // actually terminated, including timeout and cancellation paths.
      void worker.terminate().catch(() => undefined).then(() => {
        if (result.error) reject(result.error);
        else resolve(result.value!);
      });
    };

    const onAbort = () => finish({ error: new TransientConversionError('docx_extract cancelled') });
    const timer = setTimeout(() => {
      finish({ error: new Error(`docx_extract timed out after ${DOCX_CONVERSION_TIMEOUT_MS}ms`) });
    }, DOCX_CONVERSION_TIMEOUT_MS);
    timer.unref?.();

    worker.once('message', (message: unknown) => {
      const result = message as Partial<DocxWorkerMessage>;
      if (result.ok === true && typeof result.html === 'string' && Array.isArray(result.messages)) {
        finish({ value: { html: result.html, messages: result.messages.filter((item): item is string => typeof item === 'string') } });
        return;
      }
      const error = result.ok === false && typeof result.error === 'string'
        ? result.error
        : 'DOCX worker returned an invalid response';
      finish({ error: new Error(error) });
    });
    worker.once('error', (error) => finish({ error }));
    worker.once('exit', (code) => {
      if (stopping) return;
      stopping = true;
      cleanup();
      reject(new Error(`DOCX worker exited before producing a result (code ${code})`));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    // Cover an abort racing worker construction and listener installation.
    if (signal?.aborted) onAbort();
  });
}

async function convertDocx(
  docxAbsPath: string,
  _onProgress?: unknown,
  signal?: AbortSignal,
): Promise<{ htmlPath: string }> {
  const htmlPath = derivedHtmlPathForDocx(docxAbsPath);
  mkdirSync(derivedDir(), { recursive: true });
  const result = await extractDocxInWorker(docxAbsPath, signal);
  if (result.messages.length) {
    const sample = result.messages.slice(0, 3).join('; ');
    log.info(`docx_extract ${path.basename(docxAbsPath)}: ${result.messages.length} warning(s): ${sample}`);
  }
  // The worker returns a sanitized fragment. The durable representation is
  // served through HtmlPreview as a fallback, where StashBase's own bootstrap
  // remains the only script in the resulting document.
  const html = renderDocxHtml(result.html, path.basename(docxAbsPath));
  writeFileSync(htmlPath, html, 'utf8');
  return { htmlPath };
}

function renderDocxHtml(bodyHtml: string, title: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${escapeHtml(title)}</title>`,
    '  <style>',
    '    body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #222; max-width: 840px; margin: 40px auto; padding: 0 32px; }',
    '    img { max-width: 100%; height: auto; }',
    '    table { border-collapse: collapse; }',
    '    td, th { border: 1px solid #d7dbe2; padding: 6px 8px; }',
    '  </style>',
    '</head>',
    '<body>',
    bodyHtml,
    DOCX_COMPLETE_MARKER,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DOCX_SPEC: ConversionSpec = {
  kind: 'docx_extract',
  lane: 'light',
  cost: 0,
  matches: isDocxFile,
  derivedNote: derivedHtmlPathForDocx,
  derivedReady: derivedDocxIsComplete,
  convert: convertDocx,
  cleanupDerived: cleanupDerivedDocx,
};

export function maybeConvertDocx(
  docxAbsPath: string,
  opts: { urgency?: 'interactive' } = {},
): Promise<void> | null {
  return maybeConvert(docxAbsPath, DOCX_SPEC, { urgency: opts.urgency ?? 'background' });
}

export function discoverNewDocx(folderAbs: string): void {
  discoverNewSources(folderAbs, DOCX_SPEC);
}

export function indexFreshDocx(docxAbsPath: string): Promise<boolean> {
  return indexFreshDerived(docxAbsPath, DOCX_SPEC);
}
