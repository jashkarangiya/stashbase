import { useEffect, useMemo, useRef } from 'react';
import { assetBaseUrl } from '../api';
import { renderMarkdown } from '../markdown';
import { useApp } from '../store/AppContext';
import { injectAssetBase, previewClickHandler } from '../lib/previewIframe';
import { makeIframeFindController } from './findIframe';

/**
 * Read-only MD preview. Renders the markdown to a self-contained HTML
 * document and feeds it to the iframe via `srcDoc`. Sandbox is
 * `allow-same-origin` (no scripts) so the parent can hash-nav into it
 * for in-doc anchor links AND directly intercept `<a>` / `<img>` events.
 *
 * The iframe id `previewFrame` is shared with HtmlPreview and the
 * split-edit iframe — anchor scrolls pick whichever exists.
 */
export function MarkdownPreview({ name, content }: { name: string; content: string }) {
  const { state, actions, activeTab } = useApp();
  const pendingAnchor = activeTab?.pendingAnchor ?? null;
  const pendingScrollY = activeTab?.pendingScrollY ?? null;
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Snapshot find-bar state for the mount-time re-apply path. Read via
  // ref so the registration effect doesn't churn on every find tick.
  const findAtMount = useRef(state.find);
  findAtMount.current = state.find;
  // Tracks the html the iframe has finished parsing. We only apply
  // pending scroll when this matches the latest `html` — otherwise
  // we'd read elements from the stale doc and either scroll to the
  // wrong place or consume the pending intent prematurely.
  const loadedHtmlRef = useRef<string>('');
  const html = useMemo(() => {
    const rendered = renderMarkdown(content);
    return injectAssetBase(rendered, assetBaseUrl(name));
  }, [name, content]);

  // Imperative attach: React's `onLoad` prop on a `srcDoc` iframe is
  // unreliable across srcDoc swaps (in some environments it never
  // fires after the first load). Hook the iframe's native `load`
  // event each time `html` changes; also cover the race where the
  // doc is already parsed before this effect runs.
  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe) return;
    let installedDoc: Document | null = null;

    // Cmd+F in the iframe should pop OUR find bar instead of falling
    // through to the browser's default. The parent reaches in directly
    // because sandbox=allow-same-origin keeps the realm accessible.
    function findKeyHandler(e: Event) {
      const ke = e as KeyboardEvent;
      if (!(ke.metaKey || ke.ctrlKey)) return;
      const k = ke.key.toLowerCase();
      if (k === 'f') { ke.preventDefault(); actions.openFind(); }
      else if (k === 'g') {
        ke.preventDefault();
        if (ke.shiftKey) actions.findPrev(); else actions.findNext();
      }
    }

    function handleClick(e: Event) {
      previewClickHandler(e, name);
    }

    function attach() {
      const doc = iframe?.contentDocument;
      if (!doc || installedDoc === doc) return;
      installedDoc = doc;
      for (const img of Array.from(doc.images)) {
        img.dataset.stashbasePreviewable = 'true';
      }
      doc.addEventListener('click', handleClick);
      doc.addEventListener('keydown', findKeyHandler);
      loadedHtmlRef.current = html;
      applyPendingScroll(doc);
      // If the find bar is open across the content reload, re-paint
      // the highlights against the freshly parsed body.
      const snap = findAtMount.current;
      if (snap.open && snap.query) {
        // Schedule async so the controller (registered in a sibling
        // effect) is in place before we re-apply.
        queueMicrotask(() => actions.setFindQuery(snap.query));
      }
    }

    iframe.addEventListener('load', attach);
    if (iframe.contentDocument?.readyState === 'complete') attach();
    return () => {
      iframe.removeEventListener('load', attach);
      installedDoc?.removeEventListener('click', handleClick);
      installedDoc?.removeEventListener('keydown', findKeyHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  // Register the find controller once per mount. Reads the live
  // contentDocument on each call so it survives srcDoc reloads
  // without re-registering.
  useEffect(() => {
    const ctl = makeIframeFindController(
      () => frameRef.current?.contentDocument ?? null,
      () => frameRef.current?.contentWindow ?? null,
    );
    actions.registerFindController(ctl);
    return () => { actions.registerFindController(null); };
  }, [actions]);

  // Same-file anchor jump (no iframe reload): the loaded ref still
  // matches `html`, so the gate below lets us scroll synchronously.
  useEffect(() => {
    if (!pendingAnchor && pendingScrollY == null) return;
    if (loadedHtmlRef.current !== html) return; // iframe still loading
    const doc = frameRef.current?.contentDocument;
    if (doc) applyPendingScroll(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAnchor, pendingScrollY, html]);

  // Chunk-highlight after a SearchHit click. allow-same-origin lets
  // us walk the iframe DOM from the parent directly — no postMessage
  // needed (unlike HtmlPreview, which has to route through the
  // injected bootstrap because the HTML iframe is fully sandboxed).
  useEffect(() => {
    if (!pendingHighlight) return;
    if (loadedHtmlRef.current !== html) return;
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    if (applyChunkHighlight(doc, pendingHighlight.chunkText)) {
      actions.consumePendingHighlight();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHighlight, html]);

  function applyPendingScroll(doc: Document) {
    if (pendingAnchor) {
      const el = doc.getElementById(pendingAnchor);
      if (el) {
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      actions.consumePendingScroll();
      return;
    }
    if (pendingScrollY != null) {
      doc.documentElement.scrollTop = pendingScrollY;
      doc.body.scrollTop = pendingScrollY;
      actions.consumePendingScroll();
    }
  }

  return (
    <div className="viewer-shell">
      <iframe
        ref={frameRef}
        id="previewFrame"
        className="html-viewer"
        sandbox="allow-same-origin"
        srcDoc={html}
        title="Markdown preview"
      />
    </div>
  );
}

type TextPoint = { node: Text; offset: number };
const CHUNK_HIGHLIGHT = 'stashbase-chunk';
let markdownChunkTimer: number | null = null;

function applyChunkHighlight(doc: Document, raw: string): boolean {
  const range = findChunkRange(doc, raw);
  if (!range) return false;
  const win = doc.defaultView;
  const CSSNS = win as unknown as { CSS?: { highlights?: Map<string, unknown> } };
  const HL = win as unknown as { Highlight?: new (...r: Range[]) => unknown };
  if (CSSNS.CSS?.highlights && HL.Highlight) {
    ensureChunkHighlightStyle(doc);
    try {
      CSSNS.CSS.highlights.set(CHUNK_HIGHLIGHT, new HL.Highlight(range));
      scrollRangeIntoView(win, range);
      if (markdownChunkTimer != null) window.clearTimeout(markdownChunkTimer);
      markdownChunkTimer = window.setTimeout(() => {
        CSSNS.CSS?.highlights?.delete(CHUNK_HIGHLIGHT);
        markdownChunkTimer = null;
      }, 4000);
      return true;
    } catch {
      CSSNS.CSS.highlights.delete(CHUNK_HIGHLIGHT);
    }
  }
  return false;
}

function ensureChunkHighlightStyle(doc: Document): void {
  const id = 'stashbase-chunk-style';
  if (doc.getElementById(id)) return;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = '::highlight(stashbase-chunk) { background: rgba(46, 116, 230, 0.18); ' +
    'box-shadow: 0 0 0 2px rgba(46, 116, 230, 0.45); border-radius: 2px; }';
  doc.head.appendChild(style);
}

function scrollRangeIntoView(win: Window | null, range: Range): void {
  if (!win) return;
  const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0)
    ?? range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;
  win.scrollBy({
    top: rect.top + rect.height / 2 - win.innerHeight / 2,
    left: rect.left + rect.width / 2 - win.innerWidth / 2,
    behavior: 'smooth',
  });
}

function findChunkRange(doc: Document, raw: string): Range | null {
  const anchors = chunkAnchors(raw);
  if (anchors.length === 0 || !doc.body) return null;
  const flat = flattenDocumentText(doc);
  if (!flat.text) return null;
  for (const anchor of anchors) {
    const idx = flat.text.indexOf(anchor);
    if (idx < 0) continue;
    const start = flat.points[idx];
    const last = flat.points[idx + anchor.length - 1];
    if (!start || !last) continue;
    const range = doc.createRange();
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(last.node, last.offset + charLengthAt(last.node.data, last.offset));
      return range;
    } catch {
      continue;
    }
  }
  return null;
}

function flattenDocumentText(doc: Document): { text: string; points: TextPoint[] } {
  let text = '';
  const points: TextPoint[] = [];
  let lastWasSpace = true;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const parent = node.parentElement?.tagName;
      if (parent === 'SCRIPT' || parent === 'STYLE' || parent === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    for (let offset = 0; offset < node.data.length;) {
      const ch = node.data.slice(offset, offset + charLengthAt(node.data, offset));
      if (/\s/u.test(ch)) {
        if (!lastWasSpace) {
          text += ' ';
          points.push({ node, offset });
          lastWasSpace = true;
        }
      } else {
        text += ch;
        points.push({ node, offset });
        lastWasSpace = false;
      }
      offset += ch.length;
    }
  }
  return { text: text.trim(), points };
}

function chunkAnchors(raw: string): string[] {
  const cleaned = cleanChunkText(raw);
  if (!cleaned) return [];
  const slice = 80;
  const mid = Math.max(0, Math.floor(cleaned.length / 2) - Math.floor(slice / 2));
  const tail = Math.max(0, cleaned.length - slice);
  return Array.from(new Set([
    cleaned.slice(0, slice),
    cleaned.slice(mid, mid + slice),
    cleaned.slice(tail),
  ].map((s) => normalizeChunkText(s)).filter((s) => s.length >= Math.min(12, cleaned.length))));
}

function cleanChunkText(raw: string): string {
  return normalizeChunkText(raw)
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

function normalizeChunkText(text: string): string {
  return text
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[  ​]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charLengthAt(text: string, offset: number): number {
  const code = text.charCodeAt(offset);
  return code >= 0xd800 && code <= 0xdbff && offset + 1 < text.length ? 2 : 1;
}
