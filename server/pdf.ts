/**
 * PDF → markdown-with-bundle conversion, driven by `python/pdf_extract.py`.
 *
 * Wired from upload/sync/retry: whenever a `.pdf` needs text extraction we
 * spawn the extractor in the background. It writes derived Markdown and any
 * extracted asset bundle under AppData (`derived-store.ts`), never next to
 * the user's PDF. On completion the derived Markdown is pushed into the
 * semantic index under the original PDF path when an API key is available.
 * The PDF itself stays on disk as the user-facing source.
 *
 * Default `pymupdf` route uses `pymupdf4llm` for LLM-friendly markdown
 * (heading detection, table extraction, figure screenshots), falling back
 * to plain PyMuPDF text extraction when the richer layout pass fails.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDerivedNoteName, matchDerivedNote, NOTE_EXTS } from './format.ts';
import { relInFolder, toPosixAbs } from './folder.ts';
import { derivedNoteFor, derivedBundleFor, derivedBatchesFor, derivedDir } from './derived-store.ts';
import { extractorSpawn } from './python-host.ts';
import { discoverNewSources, indexFreshDerived, maybeConvert, TransientConversionError, type ConversionSpec } from './conversion.ts';
import { lowerExtractorPriority, spawnOptionsForExtractor, terminateExtractorTree } from './extractor-process.ts';
import type { ConversionProgress } from './conversion-status.ts';
import { logger } from './log.ts';

const log = logger('pdf');
const STDERR_TAIL_BYTES = 64 * 1024;
const PDF_COMPLETE_MARKER = '<!-- stashbase-pdf-conversion: complete -->';
const PDF_QUEUE_DEBOUNCE_MS = 100;
const PDF_TEXT_PROBE_TIMEOUT_MS = 5000;
const PDF_TEXT_PROBE_CONCURRENCY = 4;

interface QueuedPdf {
  absPath: string;
  priority?: number;
  priorityPromise?: Promise<number>;
}

const queuedPdfs = new Map<string, QueuedPdf>();
let pdfQueueTimer: ReturnType<typeof setTimeout> | null = null;
let pdfQueueRunning = false;

export interface ConvertResult {
  /** Absolute AppData path of the written derived Markdown. */
  notePath: string;
  /** Absolute AppData path of the extracted asset bundle. */
  bundleDir: string;
}

/** Derive the AppData paths for a given PDF. Returns both the markdown note
 *  and the extracted asset bundle dir so callers don't repeat the naming. */
export function derivedPathsForPdf(pdfAbsPath: string): { notePath: string; bundleDir: string } {
  // Derived artifacts live in per-machine app data, NEVER in the user's
  // opened folder (see `derived-store.ts`). The PDF resume-batch scratch
  // follows `notePath` automatically (`pdf_extract.py:_resume_dir_for`).
  return {
    notePath: derivedNoteFor(pdfAbsPath),
    bundleDir: derivedBundleFor(pdfAbsPath),
  };
}

function cleanupDerivedPdf(pdfAbsPath: string): void {
  const { notePath, bundleDir } = derivedPathsForPdf(pdfAbsPath);
  rmSync(notePath, { force: true });
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(derivedBatchesFor(pdfAbsPath), { recursive: true, force: true });
}

function cleanupFinalPdfArtifacts(pdfAbsPath: string): void {
  const { notePath, bundleDir } = derivedPathsForPdf(pdfAbsPath);
  rmSync(notePath, { force: true });
  rmSync(bundleDir, { recursive: true, force: true });
}

function derivedPdfIsComplete(_pdfAbsPath: string, notePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(notePath, 'r');
    const tailBytes = 4096;
    const size = statSync(notePath).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8').includes(PDF_COMPLETE_MARKER);
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function pdfQueueKey(pdfAbsPath: string): string {
  return toPosixAbs(path.resolve(pdfAbsPath));
}

function schedulePdfQueueDrain(): void {
  if (pdfQueueTimer || pdfQueueRunning) return;
  pdfQueueTimer = setTimeout(() => {
    pdfQueueTimer = null;
    void drainPdfQueue();
  }, PDF_QUEUE_DEBOUNCE_MS);
}

async function drainPdfQueue(): Promise<void> {
  if (pdfQueueRunning) return;
  pdfQueueRunning = true;
  try {
    while (queuedPdfs.size > 0) {
      const items = [...queuedPdfs.values()];
      await resolvePdfPriorities(items);
      items.sort((a, b) =>
        (a.priority ?? 0) - (b.priority ?? 0)
        || a.absPath.localeCompare(b.absPath),
      );
      const next = items.find((item) => queuedPdfs.has(pdfQueueKey(item.absPath)));
      if (!next) break;
      queuedPdfs.delete(pdfQueueKey(next.absPath));
      const run = maybeConvert(next.absPath, PDF_SPEC);
      if (run) await run;
    }
  } finally {
    pdfQueueRunning = false;
    if (queuedPdfs.size > 0) schedulePdfQueueDrain();
  }
}

export function cancelQueuedPdfsUnder(folderAbs: string): string[] {
  const root = toPosixAbs(folderAbs).replace(/\/+$/, '');
  const removed: string[] = [];
  for (const item of queuedPdfs.values()) {
    const abs = toPosixAbs(item.absPath);
    if (abs !== root && !abs.startsWith(`${root}/`)) continue;
    queuedPdfs.delete(pdfQueueKey(abs));
    removed.push(abs);
  }
  return removed;
}

async function resolvePdfPriorities(items: QueuedPdf[]): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(PDF_TEXT_PROBE_CONCURRENCY, items.length) },
    async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        if (item) await resolvePdfPriority(item);
      }
    },
  );
  await Promise.all(workers);
}

async function resolvePdfPriority(item: QueuedPdf): Promise<number> {
  if (item.priority != null) return item.priority;
  item.priorityPromise ??= pdfConversionPriority(item.absPath)
    .then((priority) => {
      item.priority = priority;
      return priority;
    });
  return item.priorityPromise;
}

async function pdfConversionPriority(pdfAbsPath: string): Promise<number> {
  const hasTextLayer = await probePdfTextLayer(pdfAbsPath);
  // Text-layer PDFs are cheap and should run first. Scanned PDFs fall behind
  // because their OCR path is usually the slowest conversion work.
  return hasTextLayer ? 0 : 10;
}

function probePdfTextLayer(pdfAbsPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];
    try {
      ({ cmd, args } = extractorSpawn('pdf', 'pdf_extract.py', ['--probe-text-layer', pdfAbsPath]));
    } catch (err: unknown) {
      log.warn(`pdf text probe skipped for ${path.basename(pdfAbsPath)}: ${err instanceof Error ? err.message : String(err)}`);
      resolve(true);
      return;
    }
    const proc = spawn(cmd, args, spawnOptionsForExtractor());
    lowerExtractorPriority(proc);
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      terminateExtractorTree(proc);
      // A probe that cannot finish quickly is likely not a cheap text-layer
      // document; defer it behind definitely text-readable PDFs.
      done(false);
    }, PDF_TEXT_PROBE_TIMEOUT_MS);
    proc.on('error', () => done(true));
    proc.on('exit', (code) => {
      if (code === 0) done(true);
      else if (code === 10) done(false);
      else done(true);
    });
  });
}

function enqueuePdf(pdfAbsPath: string, priority?: number): void {
  const key = pdfQueueKey(pdfAbsPath);
  const current = queuedPdfs.get(key);
  if (current) {
    if (priority != null && (current.priority == null || priority < current.priority)) {
      current.priority = priority;
      current.priorityPromise = Promise.resolve(priority);
    }
    return;
  }
  queuedPdfs.set(key, { absPath: pdfAbsPath, priority });
  schedulePdfQueueDrain();
}

/** Given a POSIX-relative path to a legacy dot-prefixed derived note
 *  (`.paper.pdf.md` / `.shot.png.md`), return the relative path of its
 *  parent binary source (PDF / image) when that source exists on disk —
 *  or null if the shape doesn't match or the source is gone. The source
 *  filename is encoded in the derived name, so this is a direct read +
 *  existence check (no extension probing). Used by the search routes to
 *  rewrite hits so users see the PDF / image row rather than the hidden
 *  derived note. `baseAbs` is the folder root for relative GUI hits; absolute
 *  library hits already carry their full source identity. */
function originalForDerivedNote(noteRel: string, baseAbs: string): string | null {
  // The derived name encodes the full source filename, so the source is
  // read straight off it — no extension probing.
  const m = matchDerivedNote(noteRel);
  if (!m) return null;
  return existsSync(path.join(baseAbs, m.source)) ? m.source : null;
}

function originalForLegacyDerivedNote(noteRel: string, baseAbs: string): string | null {
  const norm = noteRel.replace(/\\/g, '/');
  const dir = path.posix.dirname(norm);
  const base = path.posix.basename(norm);
  const extAlt = NOTE_EXTS.join('|');
  const m = base.match(new RegExp(`^\\.(.+)\\.(${extAlt})$`, 'i'));
  if (!m) return null;
  const stem = m[1];
  // Extension-bearing legacy artifacts (`.paper.pdf.md`) are handled above.
  // Treat extension-less legacy names (`.paper.md`) as derived only when a
  // source with the same stem exists next to them; this keeps ordinary
  // user-authored hidden notes visible unless they collide with a legacy
  // converter artifact.
  if (/\.(pdf|png|jpe?g|webp)$/i.test(stem)) return null;
  for (const ext of ['pdf', 'png', 'jpg', 'jpeg', 'webp']) {
    const sourceBase = `${stem}.${ext}`;
    const source = dir === '.' ? sourceBase : `${dir}/${sourceBase}`;
    if (existsSync(path.join(baseAbs, source))) return source;
  }
  return null;
}

/** Compatibility remap for legacy dot-prefixed derived notes that may still
 *  exist in user folders. Current PDF/image derived Markdown lives in AppData
 *  and search routes map it to the source file before display.
 *
 *    • legacy derived note (`.paper.pdf.md` / `.shot.png.md`) with a live source
 *        → the source PDF / image (the clickable, openable original);
 *    • derived note whose source is gone (orphan)
 *        → `null`, i.e. drop the hit — the bare `.md` is hidden in the
 *          sidebar and must never surface as an unopenable row;
 *    • any normal file → unchanged.
 *
 *  `rel` is relative to `baseAbs` for GUI routes, and may already be absolute
 *  for library/MCP routes. Centralised here so `/api/search`,
 *  `/api/keyword-search`, and `/api/library/search` can't drift apart. */
export function displayPathForHit(rel: string, baseAbs: string): string | null {
  const source = originalForDerivedNote(rel, baseAbs);
  if (source) return source;
  const legacySource = originalForLegacyDerivedNote(rel, baseAbs);
  if (legacySource) return legacySource;
  if (isDerivedNoteName(rel)) return null;
  return rel;
}

/** Run the extractor on a single PDF. Resolves with paths on success;
 *  rejects with the extractor's stderr tail on failure. Fire-and-
 *  forget at the call site if you don't want to block — `convertPdf`
 *  itself does not throw synchronously. */
function convertPdf(
  pdfAbsPath: string,
  onProgress?: (progress: ConversionProgress) => void,
  signal?: AbortSignal,
): Promise<ConvertResult> {
  const { notePath, bundleDir } = derivedPathsForPdf(pdfAbsPath);
  mkdirSync(derivedDir(), { recursive: true });

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('pdf_extract cancelled'));
      return;
    }
    const { cmd, args } = extractorSpawn('pdf', 'pdf_extract.py', [
      pdfAbsPath, notePath, bundleDir,
    ]);
    const proc = spawn(cmd, args, spawnOptionsForExtractor());
    lowerExtractorPriority(proc);
    let stderr = '';
    let stderrLineBuffer = '';
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      terminateExtractorTree(proc);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const handleStderrLine = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('[pdf_extract]')) {
        const message = trimmed.replace(/^\[pdf_extract\]\s*/, '');
        const started = message.match(/^batch \d+\/\d+ pages (\d+)-\d+ started$/);
        const done = message.match(/^batch \d+\/\d+ pages \d+-(\d+) done$/);
        if (started) onProgress?.({ phase: 'extracting', currentPage: Number(started[1]) });
        if (done) onProgress?.({ phase: 'extracting', currentPage: Number(done[1]) });
        log.info(`${path.basename(pdfAbsPath)}: ${message}`);
      } else if (/^(Using RapidOCR|OCR on page\.number=)/.test(trimmed)) {
        log.debug(`${path.basename(pdfAbsPath)}: ${trimmed}`);
      }
    };
    proc.stderr.on('data', (b) => {
      const text = String(b);
      stderr = (stderr + text).slice(-STDERR_TAIL_BYTES);
      const lines = (stderrLineBuffer + text).split(/\r?\n/);
      stderrLineBuffer = lines.pop() ?? '';
      for (const line of lines) handleStderrLine(line);
    });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`spawn failed: ${err.message}`));
    });
    proc.on('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (stderrLineBuffer) {
        handleStderrLine(stderrLineBuffer);
        stderrLineBuffer = '';
      }
      if (cancelled) {
        reject(new TransientConversionError('pdf_extract cancelled'));
        return;
      }
      if (code === 0) {
        resolve({ notePath, bundleDir });
      } else {
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        const message = `pdf_extract exit ${code}: ${tail || '(no stderr)'}`;
        reject(code === null ? new TransientConversionError(message) : new Error(message));
      }
    });
  });
}

/** Conversion spec wiring PDFs into the shared `conversion.ts` plumbing. */
const PDF_SPEC: ConversionSpec = {
  kind: 'pdf_extract',
  matches: (name) => /\.pdf$/i.test(name),
  derivedNote: (abs) => derivedPathsForPdf(abs).notePath,
  derivedReady: derivedPdfIsComplete,
  convert: convertPdf,
  cleanupBeforeConvert: cleanupFinalPdfArtifacts,
  cleanupDerived: cleanupDerivedPdf,
};

/** Fire-and-forget convert used by the upload route. Skips if the note
 *  already exists; persists in-flight → done/failed to `state.db` so
 *  search-readiness accounting and retry recovery survive restart. */
export function maybeConvertPdf(
  pdfAbsPath: string,
  opts: { priority?: 'immediate' } = {},
): void {
  enqueuePdf(pdfAbsPath, opts.priority === 'immediate' ? -10 : undefined);
}

/** Reconcile hook: convert any untracked `.pdf` under the folder (dropped
 *  in via git checkout / external copy / `mv`). */
export function discoverNewPdfs(folderAbs: string): void {
  discoverNewSources(folderAbs, PDF_SPEC, (abs) => maybeConvertPdf(abs));
}

export function indexFreshPdf(pdfAbsPath: string): Promise<boolean> {
  return indexFreshDerived(pdfAbsPath, PDF_SPEC);
}

export function getQueuedPdfConversions(folderRoot?: string): string[] {
  const out: string[] = [];
  for (const item of queuedPdfs.values()) {
    if (!existsSync(item.absPath)) continue;
    const sourcePath = toPosixAbs(item.absPath);
    const folderRel = folderRoot ? relInFolder(sourcePath, folderRoot) : sourcePath;
    if (folderRel != null) out.push(folderRel);
  }
  out.sort();
  return out;
}
