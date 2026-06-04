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

    function attach() {
      const doc = iframe?.contentDocument;
      if (!doc || installedDoc === doc) return;
      installedDoc = doc;
      for (const img of Array.from(doc.images)) {
        img.dataset.stashbasePreviewable = 'true';
      }
      doc.addEventListener('click', previewClickHandler);
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
      installedDoc?.removeEventListener('click', previewClickHandler);
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
    applyChunkHighlight(doc, pendingHighlight.chunkText);
    actions.consumePendingHighlight();
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

/** Find the first occurrence of `text` (normalised to a single-space
 *  representation) inside `doc.body`, wrap it in a transient span with
 *  a fade-out CSS animation, and scroll it into view. The span removes
 *  itself after 4s so the highlight doesn't linger across navigations. */
function applyChunkHighlight(doc: Document, raw: string): void {
  const needle = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!needle) return;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const txt = (node.nodeValue || '').replace(/\s+/g, ' ');
    const idx = txt.indexOf(needle);
    if (idx < 0) continue;
    // Re-find in the raw nodeValue so range offsets line up. We don't
    // bother building a precise raw-vs-normalised offset map; the
    // visible difference between "found within normalised text" and
    // "found within raw text" is rarely material for highlighting.
    const rawValue = node.nodeValue || '';
    const rawIdx = rawValue.indexOf(needle);
    const start = rawIdx >= 0 ? rawIdx : 0;
    const end = Math.min(rawValue.length, start + needle.length);
    const range = doc.createRange();
    try { range.setStart(node, start); range.setEnd(node, end); } catch { return; }
    const span = doc.createElement('span');
    span.setAttribute('data-stashbase-chunk-hl', '1');
    span.style.background = 'rgba(46, 116, 230, 0.18)';
    span.style.boxShadow = '0 0 0 2px rgba(46, 116, 230, 0.45)';
    span.style.borderRadius = '2px';
    span.style.transition = 'background 0.6s ease-out, box-shadow 0.6s ease-out';
    try { range.surroundContents(span); }
    catch { return; }
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      span.style.background = 'transparent';
      span.style.boxShadow = 'none';
    }, 3000);
    setTimeout(() => {
      // Unwrap so the DOM returns to its original shape; no need for
      // a global cleanup pass on next highlight.
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    }, 4000);
    return;
  }
}

