import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
// `?url` import gives Vite a stable URL for the worker bundle. The
// worker runs in its own scope and is required by pdfjs to off-load
// page rendering.
// eslint-disable-next-line import/no-unresolved
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, assetUrl, type Heading, type PdfStatusEntry } from '../api';
import { useApp } from '../store/AppContext';

GlobalWorkerOptions.workerSrc = workerSrc;

/**
 * PDF viewer built on pdfjs-dist's programmatic API. Renders every
 * page as a canvas in a single scrollable column so search /
 * chunk-highlight scrolling lands on the right page without virtual-
 * scroll bookkeeping. Pages render lazily once they enter (or come
 * within one viewport of) the visible area — bundle size win on
 * large papers.
 *
 * Three things this component is responsible for, none of which the
 * out-of-the-box pdfjs viewer.html gives us cleanly:
 *   1. Outline extraction → dispatched into the shared `cur.headings`
 *      slot so the existing Outline panel works without a per-format
 *      fork.
 *   2. Failure banner sourced from `pdf-status.json` so users see
 *      "conversion failed, click to retry" in-context, not buried in
 *      a separate failure list.
 *   3. Chunk text search — when a search hit on a PDF-derived HTML
 *      file co-opens the PDF, we call into the find controller with
 *      the chunk text so the PDF jumps to the same passage.
 */
export function PdfPreview({ name }: { name: string }) {
  const { state, actions } = useApp();
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [pdfStatus, setPdfStatus] = useState<PdfStatusEntry | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);

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
    loadingTask = getDocument(fileUrl);
    loadingTask.promise.then(
      (pdf) => {
        if (cancelled) { void pdf.destroy(); return; }
        setDoc(pdf);
        setNumPages(pdf.numPages);
        void extractOutline(pdf, actions.setOutlineHeadings);
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

  // Poll PDF status on name change. Cheap (one JSON read) and only
  // happens on open/Retry, not on every render.
  useEffect(() => {
    let cancelled = false;
    const spaceName = state.space;
    if (!spaceName) { setPdfStatus(null); return; }
    const kbName = `${spaceName}/${name}`;
    void api.pdfStatus().then((r) => {
      if (cancelled) return;
      setPdfStatus(r.entries[kbName] ?? null);
    }).catch(() => {
      if (!cancelled) setPdfStatus(null);
    });
    return () => { cancelled = true; };
  }, [name, state.space, retryBusy]);

  // Search for the chunk text across pages and scroll the matched
  // page into view. Best-effort match: collapse whitespace, slice to
  // first ~80 chars, indexOf on each page's concatenated text. Falls
  // back to fade-out toast if no page matches. We don't draw a bbox
  // overlay in V1 — landing on the right page is the dominant UX win.
  useEffect(() => {
    if (!doc || !pendingHighlight?.chunkText) return;
    let cancelled = false;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    let needle = norm(pendingHighlight.chunkText).slice(0, 80);
    void (async () => {
      for (let i = 0; i < numPages; i++) {
        if (cancelled) return;
        try {
          const page = await doc.getPage(i + 1);
          const tc = await page.getTextContent();
          const txt = norm(
            tc.items
              .map((it) => ('str' in it && typeof it.str === 'string' ? it.str : ''))
              .join(' '),
          );
          if (txt.indexOf(needle) >= 0) {
            const root = containerRef.current;
            if (root) {
              const target = root.querySelector(`[data-page="${i + 1}"]`) as HTMLElement | null;
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            break;
          }
        } catch { /* skip page */ }
      }
      if (!cancelled) actions.consumePendingHighlight();
    })();
    return () => { cancelled = true; };
  }, [doc, numPages, pendingHighlight, actions]);

  async function onRetry() {
    setRetryBusy(true);
    try {
      await api.retryPdf(name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setRetryBusy(false);
    }
  }

  return (
    <div className="pdf-preview" ref={containerRef}>
      {pdfStatus?.status === 'failed' && (
        <div className="pdf-failure-banner" role="status">
          <span className="pdf-failure-text">
            Conversion failed
            {pdfStatus.lastError ? `: ${pdfStatus.lastError}` : ''}.
          </span>
          <button
            type="button"
            className="pdf-failure-retry"
            disabled={retryBusy}
            onClick={() => { void onRetry(); }}
          >
            {retryBusy ? 'Retrying…' : 'Retry conversion'}
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
          <PdfPage key={`p-${i}`} doc={doc} pageIndex={i} scale={scale} />
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
  useEffect(() => {
    setSlot(document.getElementById('pdf-chrome-slot'));
  });
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
}: { doc: PDFDocumentProxy; pageIndex: number; scale: number }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageIndex < 2); // eager-render first 2 pages

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
    void doc.getPage(pageIndex + 1).then((page) => {
      if (cancelled) return;
      pageProxy = page;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = viewport.width * ratio;
      canvas.height = viewport.height * ratio;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const renderTask = page.render({
        canvas,
        viewport: page.getViewport({ scale: scale * ratio }),
      });
      renderTask.promise.catch(() => { /* destroyed mid-render */ });
    });
    return () => {
      cancelled = true;
      if (pageProxy) pageProxy.cleanup();
    };
  }, [doc, pageIndex, scale, visible]);

  return (
    <div
      ref={rootRef}
      className="pdf-page-wrap"
      data-page={pageIndex + 1}
      style={{ minHeight: 800 }}
    >
      {visible ? <canvas ref={canvasRef} className="pdf-page-canvas" /> : (
        <div className="pdf-page-placeholder">Page {pageIndex + 1}</div>
      )}
    </div>
  );
}

/** Pull the PDF's outline (if any) and dispatch as headings so the
 *  existing Outline panel renders entries without a per-format fork. */
async function extractOutline(
  pdf: PDFDocumentProxy,
  setHeadings: (h: Heading[]) => void,
): Promise<void> {
  try {
    const outline = await pdf.getOutline();
    if (!outline || outline.length === 0) { setHeadings([]); return; }
    const items: Heading[] = [];
    let counter = 0;
    const walk = (entries: Array<{ title: string; items: typeof outline }>, level: number) => {
      for (const e of entries) {
        if (!e?.title) continue;
        // `id` stays format-neutral — Outline.tsx already keys on it
        // for React; the PDF scroll-to-anchor handler matches by the
        // counter-derived suffix to find the right outline entry.
        items.push({ level: Math.min(level, 6) as Heading['level'], text: e.title, id: `pdf-h-${counter}` });
        counter++;
        if (e.items && e.items.length) walk(e.items as never, level + 1);
      }
    };
    walk(outline as never, 1);
    setHeadings(items);
  } catch {
    setHeadings([]);
  }
}

