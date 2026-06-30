import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PDFWorker,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
// Load the worker via Vite's `?worker` so we can wrap it with the
// Map-upsert polyfill pdfjs 5.7 needs but Electron's V8 lacks (see
// `lib/pdfWorker.ts` / `lib/pdfPolyfill.ts`). `?worker` bundles the
// worker for both dev and the packaged build, unlike a bare `?url`.
import PdfWorker from '../lib/pdfWorker?worker';
import { api, assetUrl, errorMessage } from '../api';
import { useApp } from '../store/AppContext';
import { getFileReadiness } from '../store/fileReadiness';

// Polyfill the main-thread scope too — render() calls getOrInsertComputed
// synchronously before it ever talks to the worker.
import '../lib/pdfPolyfill';

// One shared worker for the viewer, owned by US (a PDFWorker we construct)
// rather than handed to pdfjs via `GlobalWorkerOptions.workerPort`. The
// distinction is load-bearing: a `workerPort` worker is owned by whichever
// loadingTask is created over it, so `loadingTask.destroy()` — fired by the
// load effect's cleanup on tab close AND on React StrictMode's dev
// mount→unmount→mount — terminates the shared worker thread. The next
// getDocument then hits "PDFWorker.create - the worker is being destroyed".
// A worker passed explicitly to getDocument is NOT owned by the task, so
// destroy() tears down only the document and the thread survives every reopen.
// (PDFWorker.create over `new PDFWorker({ port })` only because the latter's
// generated d.ts mistypes `port` as null; both wrap the same port instance.)
const pdfWorker = PDFWorker.create({ port: new PdfWorker() });
const PDF_FIT_SIDE_PADDING = 48;
const PDF_MIN_SCALE = 0.5;
const PDF_MAX_SCALE = 3;

/**
 * PDF viewer built on pdfjs-dist's programmatic API. Renders every
 * page as a canvas in a single scrollable column so search /
 * chunk-highlight scrolling lands on the right page without virtual-
 * scroll bookkeeping. Pages render lazily once they enter (or come
 * within one viewport of) the visible area — bundle size win on
 * large papers.
 *
 * Two things this component is responsible for, neither of which the
 * out-of-the-box pdfjs viewer.html gives us cleanly:
 *   1. Failure banner sourced from `state.db` so users see
 *      "conversion failed, click to retry" in-context, not buried in
 *      a separate failure list.
 *   2. Chunk text search — when a search hit on a PDF-derived HTML
 *      file co-opens the PDF, we call into the find controller with
 *      the chunk text so the PDF jumps to the same passage.
 */
/** Fold the unicode variants pdfjs emits (curly quotes, en/em dashes,
 *  thin / zero-width folders) to ASCII so a needle built from chunk text
 *  or a find query matches the page's flattened string. */
function foldPdfText(s: string): string {
  return s
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[  ​]/g, ' ');
}

function charLengthAt(text: string, offset: number): number {
  const first = text.charCodeAt(offset);
  if (first >= 0xd800 && first <= 0xdbff && offset + 1 < text.length) {
    const second = text.charCodeAt(offset + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return 2;
  }
  return 1;
}

interface FlatPage {
  flat: string;
  compact: string;
  compactToFlat: number[];
  items: PdfFlatItem[];
  itemStarts: number[];
  viewport1x: { width: number; height: number };
}

interface PdfFlatItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
}

interface PdfHighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PdfPageHighlight {
  page: number;
  rects: PdfHighlightRect[];
}

/** Flatten a pdfjs page's text items into one folded string, tracking
 *  where each item starts so a match index maps back to a y-position.
 *  Shared by the chunk-highlight scroll and the FindBar controller — both
 *  used to inline this same ~30-line pass. */
async function flattenPageText(page: PDFPageProxy): Promise<FlatPage> {
  const tc = await page.getTextContent();
  type StrItem = { str: string; transform: number[]; width?: number; height?: number };
  const items: PdfFlatItem[] = [];
  const itemStarts: number[] = [];
  const segments: string[] = [];
  let pos = 0;
  let lastEnd = '';
  for (const it of tc.items) {
    if (!('str' in it) || typeof it.str !== 'string') continue;
    const raw = it.str;
    if (raw === '') continue;
    if (lastEnd && !/\s/.test(lastEnd) && !/^\s/.test(raw)) { segments.push(' '); pos += 1; }
    const piece = raw.replace(/\s+/g, ' ');
    itemStarts.push(pos);
    items.push(it as StrItem);
    segments.push(piece);
    pos += piece.length;
    lastEnd = piece.slice(-1);
  }
  const flat = foldPdfText(segments.join(''));
  const compactToFlat: number[] = [];
  let compact = '';
  for (let i = 0; i < flat.length;) {
    const len = charLengthAt(flat, i);
    const ch = flat.slice(i, i + len);
    if (!/\s/u.test(ch)) {
      compact += ch;
      compactToFlat.push(i);
    }
    i += len;
  }
  return {
    flat,
    compact,
    compactToFlat,
    items,
    itemStarts,
    viewport1x: page.getViewport({ scale: 1 }),
  };
}

function cleanPdfSearchText(raw: string): string {
  return foldPdfText(raw)
    // Strip markdown noise — chunk text comes from pymupdf4llm
    // which embeds bold / italic / link / code markers, none of
    // which appear in the rendered PDF text.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)[*_]([^\s*_][^*_]*?)[*_](?=\s|$|[.,;:])/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactPdfSearchText(raw: string): string {
  return cleanPdfSearchText(raw).replace(/\s+/g, '');
}

function textAnchors(raw: string, slice: number, minLen: number): string[] {
  const cleaned = cleanPdfSearchText(raw);
  if (!cleaned) return [];
  const mid = Math.max(0, Math.floor(cleaned.length / 2) - Math.floor(slice / 2));
  const tail = Math.max(0, cleaned.length - slice);
  return Array.from(new Set([
    cleaned.slice(0, slice),
    cleaned.slice(mid, mid + slice),
    cleaned.slice(tail),
  ].filter((a) => a.length >= Math.min(minLen, cleaned.length))));
}

function compactAnchors(raw: string, slice: number, minLen: number): string[] {
  const compacted = compactPdfSearchText(raw);
  if (!compacted) return [];
  const mid = Math.max(0, Math.floor(compacted.length / 2) - Math.floor(slice / 2));
  const tail = Math.max(0, compacted.length - slice);
  return Array.from(new Set([
    compacted.slice(0, slice),
    compacted.slice(mid, mid + slice),
    compacted.slice(tail),
  ].filter((a) => a.length >= Math.min(minLen, compacted.length))));
}

function findPdfChunkMatch(fp: FlatPage, raw: string): { idx: number; length: number; score: number } | null {
  for (const anchor of textAnchors(raw, 60, 12)) {
    const idx = fp.flat.indexOf(anchor);
    if (idx >= 0) return { idx, length: anchor.length, score: 1000 + anchor.length };
  }
  for (const anchor of compactAnchors(raw, 40, 10)) {
    const compactIdx = fp.compact.indexOf(anchor);
    const idx = compactIdx >= 0 ? fp.compactToFlat[compactIdx] : undefined;
    if (idx !== undefined) return { idx, length: anchor.length, score: 800 + anchor.length };
  }

  // Fuzzy fallback: short compact anchors survive OCR-added folders,
  // heading markers, and small reflow differences. Use the earliest
  // matching anchor on the highest-scoring page.
  const anchors = compactAnchors(raw, 18, 8);
  let best: { idx: number; length: number; score: number } | null = null;
  for (const anchor of anchors) {
    const compactIdx = fp.compact.indexOf(anchor);
    const idx = compactIdx >= 0 ? fp.compactToFlat[compactIdx] : undefined;
    if (idx === undefined) continue;
    const score = anchor.length;
    if (!best || score > best.score) best = { idx, length: anchor.length, score };
  }
  return best;
}

function exactPageForHighlight(highlight: { pdfPage?: number }, numPages: number): number | null {
  if (numPages <= 0) return null;
  if (typeof highlight.pdfPage === 'number' && highlight.pdfPage > 0) {
    return Math.max(1, Math.min(numPages, Math.round(highlight.pdfPage)));
  }
  return null;
}

/** y-ratio (0 = page top, 1 = bottom) of the text item covering the
 *  flat-string index `idx` — for scroll-to-match positioning. */
function yRatioForIndex(p: FlatPage, idx: number): number {
  const itemIdx = itemIndexForFlatIndex(p, idx);
  const m = p.items[itemIdx];
  const yFromTop = p.viewport1x.height - (m.transform[5] ?? 0);
  return Math.max(0, Math.min(1, yFromTop / p.viewport1x.height));
}

function itemIndexForFlatIndex(p: FlatPage, idx: number): number {
  let itemIdx = 0;
  for (let k = 0; k < p.itemStarts.length; k++) {
    if (p.itemStarts[k] > idx) break;
    itemIdx = k;
  }
  return itemIdx;
}

function highlightRectsForMatch(p: FlatPage, idx: number, length: number): PdfHighlightRect[] {
  if (p.items.length === 0 || length <= 0) return [];
  const startItem = itemIndexForFlatIndex(p, idx);
  const endItem = itemIndexForFlatIndex(p, idx + length - 1);
  const groups: Array<{ top: number; bottom: number; left: number; right: number }> = [];
  const pageW = Math.max(1, p.viewport1x.width);
  const pageH = Math.max(1, p.viewport1x.height);

  for (let i = startItem; i <= endItem; i++) {
    const item = p.items[i];
    if (!item) continue;
    const x = Number(item.transform[4] ?? 0);
    const baselineY = Number(item.transform[5] ?? 0);
    const h = Math.max(8, Number(item.height ?? Math.abs(item.transform[3] ?? 0) ?? 10));
    const w = Math.max(2, Number(item.width ?? item.str.length * h * 0.45));
    const top = pageH - baselineY - h * 0.9;
    const bottom = pageH - baselineY + h * 0.25;
    const existing = groups.find((g) => Math.abs((g.top + g.bottom) / 2 - (top + bottom) / 2) < h * 0.8);
    if (existing) {
      existing.top = Math.min(existing.top, top);
      existing.bottom = Math.max(existing.bottom, bottom);
      existing.left = Math.min(existing.left, x);
      existing.right = Math.max(existing.right, x + w);
    } else {
      groups.push({ top, bottom, left: x, right: x + w });
    }
  }

  return groups.map((g) => {
    const padX = 4;
    const padY = 3;
    const left = Math.max(0, g.left - padX);
    const top = Math.max(0, g.top - padY);
    const right = Math.min(pageW, g.right + padX);
    const bottom = Math.min(pageH, g.bottom + padY);
    return {
      x: left / pageW,
      y: top / pageH,
      width: Math.max(0.01, (right - left) / pageW),
      height: Math.max(0.008, (bottom - top) / pageH),
    };
  });
}

export function pdfConversionFailureMessage(raw: string): string {
  return raw
    .replace(/^pdf_extract exit \d+:\s*/i, '')
    .replace(/^\[pdf_extract\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function PdfPreview({ name, showConversionBanner = true }: { name: string; showConversionBanner?: boolean }) {
  const { state, actions } = useApp();
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef({ folderPath: state.folderPath, name });
  currentRef.current = { folderPath: state.folderPath, name };
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [autoFit, setAutoFit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryStarted, setRetryStarted] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [pageHighlight, setPageHighlight] = useState<PdfPageHighlight | null>(null);
  const readiness = getFileReadiness(state, name);
  const failure = readiness.conversionFailure;
  const failureMessage = failure ? pdfConversionFailureMessage(failure.lastError) : '';
  const conversionProgress = state.conversionProgress[name];
  const notSearchableYet = !failure && readiness.isStashing;
  const notSearchableDetail = pdfNotSearchableDetail(conversionProgress, numPages);
  const chromeStatus = failure && showConversionBanner
    ? {
        kind: 'error' as const,
        text: `This PDF is not searchable.${failureMessage ? ` ${failureMessage}` : ''}${retryError ? ` (${retryError})` : ''}`,
      }
    : showConversionBanner && notSearchableYet
      ? { kind: 'pending' as const, text: `This PDF is not searchable yet. ${notSearchableDetail}` }
      : null;
  const retryInProgress = retryBusy || retryStarted;
  // Sampled page 1 viewport at 1× scale. Used as the per-page
  // placeholder height so the lazy-rendered pages reserve the
  // correct layout slot up front — without this, scrolling to a
  // chunk would mis-fire by hundreds of pixels whenever the target
  // page hadn't rendered yet (placeholder 800px vs. real ~1100px
  // shifts everything below). All pages in a typical paper share
  // the same page size, so a single sample is enough.
  const [pageMetrics, setPageMetrics] = useState<{ width: number; height: number } | null>(null);

  // Stable URL for this PDF + cache-bust so reopening after a Retry
  // re-fetches the binary instead of the stale 404 / failed body.
  const fileUrl = useMemo(() => assetUrl(name), [name]);

  function fitScale(): number {
    const viewportWidth = containerRef.current?.clientWidth ?? 0;
    const pageWidth = pageMetrics?.width ?? 0;
    if (viewportWidth <= 0 || pageWidth <= 0) return 1;
    const available = Math.max(1, viewportWidth - PDF_FIT_SIDE_PADDING);
    return Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, available / pageWidth));
  }

  // Load PDF on name change.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setError(null);
    setDoc(null);
    setNumPages(0);
    setPageMetrics(null);
    setScale(1);
    setAutoFit(true);
    setPageHighlight(null);
    setRetryBusy(false);
    setRetryStarted(false);
    setRetryError(null);
    loadingTask = getDocument({ url: fileUrl, worker: pdfWorker });
    loadingTask.promise.then(
      (pdf) => {
        if (cancelled) { void pdf.destroy(); return; }
        setDoc(pdf);
        setNumPages(pdf.numPages);
        // Sample page 1 size for placeholder heights — see pageMetrics.
        void pdf.getPage(1).then((p) => {
          if (cancelled) return;
          const vp = p.getViewport({ scale: 1 });
          setPageMetrics({ width: vp.width, height: vp.height });
        }).catch(() => { /* keep falling back to the 800px default */ });
      },
      (err: Error) => {
        if (cancelled) return;
        setError(err?.message || 'failed to open PDF');
      },
    );
    return () => {
      cancelled = true;
      if (loadingTask) loadingTask.destroy().catch(() => { /* ignore */ });
    };
  }, [fileUrl, actions]);

  useEffect(() => {
    if (!autoFit || !pageMetrics) return;
    setScale(fitScale());
  }, [autoFit, pageMetrics]);

  useEffect(() => {
    if (!autoFit) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(fitScale()));
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoFit, pageMetrics]);

  useEffect(() => {
    if (!failure || state.pendingConversions.includes(name)) setRetryStarted(false);
  }, [failure, name, state.pendingConversions]);

  // Search for the chunk text across pages and scroll directly to
  // the matched paragraph (not just the page top).
  //
  // Two robustness measures, on top of the per-page placeholder
  // trick that keeps target.offsetTop stable:
  //   1. Both the chunk text and the pdfjs flat text get stripped
  //      of markdown noise (bold / italic / links / code) and have
  //      Unicode variants (smart quotes, dash variants) folded to
  //      ASCII. Without this, a chunk like "**Figure 1:** Training
  //      loss" never matches the PDF's "Figure 1: Training loss".
  //   2. If the first ~60 chars don't hit, we retry with a slice
  //      from the middle and one from the end. PDF column boundaries
  //      and pymupdf4llm's paragraph reflowing can leave the head
  //      of a chunk unrecognisable in pdfjs's reading order.
  useEffect(() => {
    if (!doc || !pendingHighlight?.chunkText) return;
    let cancelled = false;
    const cleaned = cleanPdfSearchText(pendingHighlight.chunkText);
    if (!cleaned) { actions.consumePendingHighlight(); return; }

    void (async () => {
      let best: { page: number; idx: number; length: number; score: number; fp: FlatPage } | null = null;
      for (let i = 0; i < numPages; i++) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(i + 1);
          const fp = await flattenPageText(page);
          const match = findPdfChunkMatch(fp, pendingHighlight.chunkText);
          if (!match) continue;
          if (!best || match.score > best.score) {
            best = { page: i + 1, idx: match.idx, length: match.length, score: match.score, fp };
            if (match.score >= 800) break;
          }
        } catch { /* skip page */ }
      }
      if (cancelled || !best) {
        if (!cancelled) {
          const fallbackPage = exactPageForHighlight(pendingHighlight, numPages);
          const root = containerRef.current;
          const target = fallbackPage
            ? root?.querySelector(`[data-page="${fallbackPage}"]`) as HTMLElement | null
            : null;
          if (root && target) {
            setPageHighlight(null);
            root.scrollTo({
              top: Math.max(0, target.offsetTop - root.clientHeight * 0.12),
              behavior: 'smooth',
            });
            actions.consumePendingHighlight();
          }
        }
        return;
      }
      const yRatio = yRatioForIndex(best.fp, best.idx);
      const rects = highlightRectsForMatch(best.fp, best.idx, best.length);
      setPageHighlight(rects.length > 0 ? { page: best.page, rects } : null);
      const root = containerRef.current;
      const target = root?.querySelector(`[data-page="${best.page}"]`) as HTMLElement | null;
      if (root && target) {
        const renderedHeight = target.offsetHeight;
        const desiredScroll = target.offsetTop
          + yRatio * renderedHeight
          - root.clientHeight * 0.3;
        root.scrollTo({ top: Math.max(0, desiredScroll), behavior: 'smooth' });
      }
      actions.consumePendingHighlight();
    })();
    return () => { cancelled = true; };
  }, [doc, numPages, pendingHighlight, actions]);

  // FindBar integration — registers a Cmd+F-driven controller so the
  // user can search PDFs the same way they search MD / HTML / code.
  // The controller scans pdfjs text content across all pages, builds
  // an in-memory list of match positions, and jumps to each one on
  // next / prev. No overlay or per-match highlight (pdfjs canvas
  // rendering doesn't host DOM-selectable spans) — the FindBar's
  // "N of M" counter + scroll-on-jump carries the navigation; the
  // user's eye picks the match on the page.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    type PdfMatch = { page: number; yRatio: number; rects: PdfHighlightRect[] };
    const state: { matches: PdfMatch[]; current: number } = { matches: [], current: 0 };

    function escapeRegExp(s: string): string {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function scrollTo(m: PdfMatch) {
      const root = containerRef.current;
      const target = root?.querySelector(`[data-page="${m.page}"]`) as HTMLElement | null;
      if (!root || !target) return;
      const rendered = target.offsetHeight;
      const desired = target.offsetTop + m.yRatio * rendered - root.clientHeight * 0.3;
      setPageHighlight(m.rects.length > 0 ? { page: m.page, rects: m.rects } : null);
      root.scrollTo({ top: Math.max(0, desired), behavior: 'smooth' });
    }
    async function rebuild(query: string, wholeWord: boolean, caseSensitive: boolean): Promise<void> {
      state.matches = [];
      state.current = 0;
      const needle = foldPdfText(query).trim();
      if (!needle) return;
      const re = wholeWord
        ? new RegExp(`\\b${escapeRegExp(needle)}\\b`, caseSensitive ? 'g' : 'gi')
        : null;
      for (let i = 0; i < numPages; i++) {
        if (cancelled) return;
        try {
          const page = await doc!.getPage(i + 1);
          const fp = await flattenPageText(page);
          const flat = fp.flat;
          function emit(idx: number, length: number) {
            state.matches.push({
              page: i + 1,
              yRatio: yRatioForIndex(fp, idx),
              rects: highlightRectsForMatch(fp, idx, length),
            });
          }
          if (re) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(flat)) !== null) {
              emit(m.index, m[0].length);
              if (re.lastIndex === m.index) re.lastIndex += 1;
            }
          } else {
            const needleCmp = caseSensitive ? needle : needle.toLowerCase();
            const flatCmp = caseSensitive ? flat : flat.toLowerCase();
            let from = 0;
            while (true) {
              const idx = flatCmp.indexOf(needleCmp, from);
              if (idx === -1) break;
              emit(idx, needle.length);
              from = idx + needleCmp.length;
            }
          }
        } catch { /* skip page */ }
      }
    }

    actions.registerFindController({
      setQuery: async (q, { wholeWord, caseSensitive }) => {
        await rebuild(q, wholeWord, caseSensitive);
        if (state.matches.length === 0) return { current: 0, total: 0 };
        scrollTo(state.matches[0]);
        return { current: 1, total: state.matches.length };
      },
      next: () => {
        if (state.matches.length === 0) return { current: 0, total: 0 };
        state.current = (state.current + 1) % state.matches.length;
        scrollTo(state.matches[state.current]);
        return { current: state.current + 1, total: state.matches.length };
      },
      prev: () => {
        if (state.matches.length === 0) return { current: 0, total: 0 };
        state.current = (state.current - 1 + state.matches.length) % state.matches.length;
        scrollTo(state.matches[state.current]);
        return { current: state.current + 1, total: state.matches.length };
      },
      close: () => {
        state.matches = [];
        state.current = 0;
        setPageHighlight(null);
      },
    });

    return () => {
      cancelled = true;
      actions.registerFindController(null);
    };
  }, [doc, numPages, actions]);

  async function onRetry() {
    setRetryBusy(true);
    setRetryError(null);
    const folderPathAtStart = state.folderPath;
    const nameAtStart = name;
    const stillCurrent = () =>
      currentRef.current.folderPath === folderPathAtStart && currentRef.current.name === nameAtStart;
    try {
      await api.retryConversion(name, { folder: folderPathAtStart || undefined });
      if (!stillCurrent()) return;
      setRetryStarted(true);
    } catch (err: unknown) {
      if (!stillCurrent()) return;
      setRetryError(errorMessage(err));
      setRetryStarted(false);
    } finally {
      if (stillCurrent()) setRetryBusy(false);
    }
  }

  return (
    <div className="pdf-preview" ref={containerRef}>
      {error && <div className="pdf-error">Failed to open PDF: {error}</div>}
      {!error && !doc && <div className="pdf-loading">Loading PDF…</div>}
      <PdfChromePortal
        scale={scale}
        numPages={numPages}
        status={chromeStatus}
        retryLabel={retryInProgress ? 'Retrying…' : 'Retry conversion'}
        retryDisabled={retryInProgress}
        onRetry={failure && showConversionBanner ? onRetry : undefined}
        onFit={() => {
          setAutoFit(true);
          setScale(fitScale());
        }}
        onZoomOut={() => {
          setAutoFit(false);
          setScale((s) => Math.max(PDF_MIN_SCALE, s - 0.2));
        }}
        onZoomIn={() => {
          setAutoFit(false);
          setScale((s) => Math.min(PDF_MAX_SCALE, s + 0.2));
        }}
      />
      <div className="pdf-pages">
        {doc && Array.from({ length: numPages }, (_, i) => (
          <PdfPage
            key={`p-${i}`}
            doc={doc}
            pageIndex={i}
            scale={scale}
            placeholderHeight={pageMetrics ? pageMetrics.height * scale : 800}
            highlight={pageHighlight?.page === i + 1 ? pageHighlight : null}
          />
        ))}
      </div>
    </div>
  );
}

function pdfNotSearchableDetail(
  progress: { phase: 'extracting'; currentPage?: number } | { phase: 'indexing' } | undefined,
  numPages: number,
): string {
  if (progress?.phase === 'indexing') return 'Preparing search index';
  if (progress?.phase === 'extracting') {
    const page = progress.currentPage;
    if (typeof page === 'number' && page > 0) {
      return numPages > 0 ? `Reading page ${Math.min(page, numPages)} of ${numPages}` : `Reading page ${page}`;
    }
    return 'Reading PDF';
  }
  return 'Preparing search';
}

/** Render the PDF chrome (zoom controls + page count) into the
 *  `#pdf-chrome-slot` MainPane mounts at the top-right of the
 *  breadcrumb row — replaces the old "second toolbar row" so the
 *  viewer doesn't waste vertical folder on what's effectively chrome.
 *  Falls back to inline rendering if MainPane hasn't mounted yet
 *  (initial render race). */
function PdfChromePortal({
  scale,
  numPages,
  status,
  retryLabel,
  retryDisabled,
  onRetry,
  onFit,
  onZoomOut,
  onZoomIn,
}: {
  scale: number;
  numPages: number;
  status: { kind: 'pending' | 'error'; text: string } | null;
  retryLabel: string;
  retryDisabled: boolean;
  onRetry?: () => void;
  onFit: () => void;
  onZoomOut: () => void;
  onZoomIn: () => void;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // Resolve the portal target once on mount — MainPane renders the
  // `#pdf-chrome-slot` div alongside this viewer, so it's present by the
  // time this effect runs. (No deps: a per-render getElementById is
  // wasteful and the slot doesn't move.)
  useEffect(() => {
    setSlot(document.getElementById('pdf-chrome-slot'));
  }, []);
  const chrome = (
    <div className="pdf-chrome">
      <div className={'pdf-search-status' + (status ? ` ${status.kind}` : '')} role={status ? 'status' : undefined}>
        {status?.text ?? ''}
        {status?.kind === 'error' && onRetry && (
          <button
            type="button"
            className="pdf-search-retry"
            disabled={retryDisabled}
            onClick={() => { void onRetry(); }}
          >
            {retryLabel}
          </button>
        )}
      </div>
      <div className="pdf-zoom-controls">
        <button type="button" className="icon-btn" title="Zoom out" onClick={onZoomOut}>−</button>
        <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
        <button type="button" className="icon-btn" title="Zoom in" onClick={onZoomIn}>+</button>
        <button type="button" className="pdf-fit-btn" title="Fit to width" onClick={onFit}>Fit</button>
        {numPages > 0 && <span className="pdf-pageinfo">{numPages} pages</span>}
      </div>
    </div>
  );
  return slot ? createPortal(chrome, slot) : null;
}

/** Render a single PDF page into a canvas with text layer on top so
 *  selection + find work. Mounted lazily via IntersectionObserver so
 *  the long-tail of pages in a 200-page paper doesn't eat memory. */
function PdfPage({
  doc,
  pageIndex,
  scale,
  placeholderHeight,
  highlight,
}: {
  doc: PDFDocumentProxy;
  pageIndex: number;
  scale: number;
  placeholderHeight: number;
  highlight: PdfPageHighlight | null;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageIndex < 2); // eager-render first 2 pages
  const [renderedSize, setRenderedSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
      }
    }, { rootMargin: '500px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let pageProxy: PDFPageProxy | null = null;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    void doc.getPage(pageIndex + 1).then((page) => {
      if (cancelled) {
        page.cleanup();
        return;
      }
      pageProxy = page;
      // Canonical pdfjs HiDPI pattern: size the backing store by the
      // device pixel ratio, keep the CSS box at logical size, and let a
      // `transform` matrix scale the drawing up.
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const logicalWidth = Math.floor(viewport.width);
      const logicalHeight = Math.floor(viewport.height);
      const backingWidth = Math.floor(viewport.width * ratio);
      const backingHeight = Math.floor(viewport.height * ratio);
      const renderCanvas = document.createElement('canvas');
      renderCanvas.width = backingWidth;
      renderCanvas.height = backingHeight;
      renderTask = page.render({
        canvas: renderCanvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      renderTask.promise.then(() => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        // Resizing a visible canvas clears it immediately. Render the new
        // zoom level offscreen first, then swap the finished bitmap in one
        // frame so zooming does not flash white between old/new paints.
        canvas.width = backingWidth;
        canvas.height = backingHeight;
        canvas.style.width = `${logicalWidth}px`;
        canvas.style.height = `${logicalHeight}px`;
        ctx.drawImage(renderCanvas, 0, 0);
        setRenderedSize({ width: logicalWidth, height: logicalHeight });
      }).catch((err: unknown) => {
        // Cancels (tab switch / scroll-out) reject with
        // RenderingCancelledException — expected, ignore. Surface the rest.
        if ((err as { name?: string })?.name === 'RenderingCancelledException') return;
        console.error(`[pdf] page ${pageIndex + 1} render failed:`, err);
      });
    });
    return () => {
      cancelled = true;
      if (renderTask) renderTask.cancel();
      if (pageProxy) pageProxy.cleanup();
    };
  }, [doc, pageIndex, scale, visible]);

  const reservedHeight = renderedSize?.height ?? placeholderHeight;
  const reservedWidth = renderedSize?.width;

  return (
    <div
      ref={rootRef}
      className="pdf-page-wrap"
      data-page={pageIndex + 1}
      style={{
        minHeight: reservedHeight,
        width: reservedWidth ? `${reservedWidth}px` : undefined,
      }}
    >
      {visible ? <canvas ref={canvasRef} className="pdf-page-canvas" /> : (
        <div className="pdf-page-placeholder">Page {pageIndex + 1}</div>
      )}
      {visible && renderedSize && highlight && (
        <div className="pdf-page-highlight-layer" aria-hidden="true">
          {highlight.rects.map((rect, i) => (
            <div
              key={i}
              className="pdf-page-highlight"
              style={{
                left: `${rect.x * renderedSize.width}px`,
                top: `${rect.y * renderedSize.height}px`,
                width: `${rect.width * renderedSize.width}px`,
                height: `${rect.height * renderedSize.height}px`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
