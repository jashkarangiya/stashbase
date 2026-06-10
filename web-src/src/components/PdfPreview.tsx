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
 *  thin / zero-width spaces) to ASCII so a needle built from chunk text
 *  or a find query matches the page's flattened string. */
function foldPdfText(s: string): string {
  return s
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[  ​]/g, ' ');
}

interface FlatPage {
  flat: string;
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
  return {
    flat: foldPdfText(segments.join('')),
    items,
    itemStarts,
    viewport1x: page.getViewport({ scale: 1 }),
  };
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
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryStarted, setRetryStarted] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [pageHighlight, setPageHighlight] = useState<PdfPageHighlight | null>(null);
  const failure = state.conversionFailures.find((f) => f.path === name);
  const failureMessage = failure ? pdfConversionFailureMessage(failure.lastError) : '';
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

  // Load PDF on name change.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setError(null);
    setDoc(null);
    setNumPages(0);
    setPageHighlight(null);
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
    const clean = (s: string) =>
      s
        // Strip markdown noise — chunk text comes from pymupdf4llm
        // which embeds bold / italic / link / code markers, none of
        // which appear in the rendered PDF text.
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/(^|\s)[*_]([^\s*_][^*_]*?)[*_](?=\s|$|[.,;:])/g, '$1$2')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^>\s+/gm, '')
        // Fold Unicode variants the PDF text would have used.
        .replace(/[‐-―−]/g, '-')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[  ​]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const cleaned = clean(pendingHighlight.chunkText);
    if (!cleaned) { actions.consumePendingHighlight(); return; }
    // Three anchors: head, middle, tail. Each ~60 chars so column
    // breaks don't bisect them. We bail on the first hit.
    const SLICE = 60;
    const mid = Math.max(0, Math.floor(cleaned.length / 2) - Math.floor(SLICE / 2));
    const tail = Math.max(0, cleaned.length - SLICE);
    const anchors = Array.from(new Set([
      cleaned.slice(0, SLICE),
      cleaned.slice(mid, mid + SLICE),
      cleaned.slice(tail),
    ]).values()).filter((a) => a.length >= 12);
    if (anchors.length === 0) { actions.consumePendingHighlight(); return; }

    void (async () => {
      let found = false;
      for (let i = 0; i < numPages; i++) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(i + 1);
          const fp = await flattenPageText(page);
          let idx = -1;
          let anchorLength = 0;
          for (const a of anchors) {
            const pos = fp.flat.indexOf(a);
            if (pos >= 0) { idx = pos; anchorLength = a.length; break; }
          }
          if (idx < 0) continue;
          found = true;
          const yRatio = yRatioForIndex(fp, idx);
          const rects = highlightRectsForMatch(fp, idx, anchorLength);
          setPageHighlight(rects.length > 0 ? { page: i + 1, rects } : null);
          const root = containerRef.current;
          const target = root?.querySelector(`[data-page="${i + 1}"]`) as HTMLElement | null;
          if (!root || !target) break;
          const renderedHeight = target.offsetHeight;
          const desiredScroll = target.offsetTop
            + yRatio * renderedHeight
            - root.clientHeight * 0.3;
          root.scrollTo({ top: Math.max(0, desiredScroll), behavior: 'smooth' });
          break;
        } catch { /* skip page */ }
      }
      if (!cancelled && found) actions.consumePendingHighlight();
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
    try {
      await api.retryConversion(name);
      setRetryStarted(true);
    } catch (err: unknown) {
      setRetryError(errorMessage(err));
      setRetryStarted(false);
    } finally {
      setRetryBusy(false);
    }
  }

  return (
    <div className="pdf-preview" ref={containerRef}>
      {showConversionBanner && failure && (
        <div className="pdf-failure-banner" role="status">
          <span className="pdf-failure-text">
            PDF text extraction failed{failureMessage ? `: ${failureMessage}` : ''}. The original
            PDF still opens normally.
            {retryError ? ` (${retryError})` : ''}
          </span>
          <button
            type="button"
            className="pdf-failure-retry"
            disabled={retryInProgress}
            onClick={() => { void onRetry(); }}
          >
            {retryInProgress ? 'Retrying…' : 'Retry conversion'}
          </button>
        </div>
      )}
      {error && <div className="pdf-error">Failed to open PDF: {error}</div>}
      {!error && !doc && <div className="pdf-loading">Loading PDF…</div>}
      <PdfChromePortal
        scale={scale}
        numPages={numPages}
        onZoomOut={() => setScale((s) => Math.max(0.5, s - 0.2))}
        onZoomIn={() => setScale((s) => Math.min(3, s + 0.2))}
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

/** Render the PDF chrome (zoom controls + page count) into the
 *  `#pdf-chrome-slot` MainPane mounts at the top-right of the
 *  breadcrumb row — replaces the old "second toolbar row" so the
 *  viewer doesn't waste vertical space on what's effectively chrome.
 *  Falls back to inline rendering if MainPane hasn't mounted yet
 *  (initial render race). */
function PdfChromePortal({
  scale,
  numPages,
  onZoomOut,
  onZoomIn,
}: {
  scale: number;
  numPages: number;
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
      <button type="button" className="icon-btn" title="Zoom out" onClick={onZoomOut}>−</button>
      <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
      <button type="button" className="icon-btn" title="Zoom in" onClick={onZoomIn}>+</button>
      {numPages > 0 && <span className="pdf-pageinfo">{numPages} pages</span>}
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
