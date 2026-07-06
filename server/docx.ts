/**
 * DOCX -> semantic HTML conversion, driven by Mammoth.
 *
 * DOCX stays as the user-facing source file. StashBase stores a derived HTML
 * representation in AppData because Electron/browser do not provide a native
 * Word renderer. The derived HTML powers preview, keyword search, Agent text
 * reads, and semantic indexing under the original `.docx` path.
 */
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { isDocxFile } from './format.ts';
import { derivedDir, derivedHtmlFor } from './derived-store.ts';
import { discoverNewSources, indexFreshDerived, maybeConvert, type ConversionSpec } from './conversion.ts';
import { logger } from './log.ts';
import { hasNoExtractableText } from './indexable.ts';

const log = logger('docx');
const DOCX_COMPLETE_MARKER = '<!-- stashbase-docx-conversion: complete -->';

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

async function convertDocx(docxAbsPath: string): Promise<{ htmlPath: string }> {
  const htmlPath = derivedHtmlPathForDocx(docxAbsPath);
  mkdirSync(derivedDir(), { recursive: true });
  const result = await mammoth.convertToHtml({ path: docxAbsPath });
  if (result.messages.length) {
    const sample = result.messages.slice(0, 3).map((m) => m.message).join('; ');
    log.info(`docx_extract ${path.basename(docxAbsPath)}: ${result.messages.length} warning(s): ${sample}`);
  }
  const html = renderDocxHtml(result.value, path.basename(docxAbsPath));
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
  matches: isDocxFile,
  derivedNote: derivedHtmlPathForDocx,
  derivedReady: derivedDocxIsComplete,
  convert: convertDocx,
  cleanupDerived: cleanupDerivedDocx,
};

export function maybeConvertDocx(docxAbsPath: string): void {
  maybeConvert(docxAbsPath, DOCX_SPEC);
}

export function discoverNewDocx(folderAbs: string): void {
  discoverNewSources(folderAbs, DOCX_SPEC);
}

export function indexFreshDocx(docxAbsPath: string): Promise<boolean> {
  return indexFreshDerived(docxAbsPath, DOCX_SPEC);
}
