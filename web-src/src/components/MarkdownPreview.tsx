import { useEffect, useMemo, useRef } from 'react';
import { assetBaseUrl } from '../api';
import { renderMarkdown } from '../markdown';
import { useApp } from '../store/AppContext';
import { makeIframeFindController } from './findIframe';

/**
 * Read-only MD preview. Renders the markdown to a self-contained HTML
 * document and feeds it to the iframe via `srcDoc`. Sandbox is
 * `allow-same-origin` (no scripts) so the parent can hash-nav into it
 * for outline clicks AND directly intercept `<a>` / `<img>` events.
 *
 * The iframe id `previewFrame` is shared with HtmlPreview and the
 * split-edit iframe — outline clicks pick whichever exists.
 */
export function MarkdownPreview({ name, content }: { name: string; content: string }) {
  const { state, actions, activeTab } = useApp();
  const pendingAnchor = activeTab?.pendingAnchor ?? null;
  const pendingScrollY = activeTab?.pendingScrollY ?? null;
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
    return withMarkdownAssetBase(rendered, assetBaseUrl(name));
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

    function clickHandler(e: Event) {
      // Duck-type instead of `instanceof Element`: events fired inside
      // the iframe carry elements from the iframe's separate JS realm,
      // so the parent's `Element` constructor doesn't match (even when
      // sandbox=allow-same-origin keeps the origin shared).
      const target = e.target as (Element & { closest?: typeof Element.prototype.closest }) | null;
      if (!target || typeof target.closest !== 'function') return;
      const img = target.closest('img') as HTMLImageElement | null;
      if (img) {
        const src = img.currentSrc || img.src;
        if (!src) return;
        e.preventDefault();
        window.postMessage({
          type: 'stashbase-preview-image',
          src,
          alt: img.alt || '',
        }, window.location.origin);
        return;
      }
      const anchor = target.closest('a') as HTMLAnchorElement | null;
      if (anchor) handleAnchorClick(anchor, e);
    }

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
      doc.addEventListener('click', clickHandler);
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
      installedDoc?.removeEventListener('click', clickHandler);
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

/** Resolve a clicked `<a>` and forward intent to the parent app:
 *  - `#anchor`: let the browser handle (same-origin iframe).
 *  - relative `.md`/`.html` (with optional `#anchor`): post `stashbase-nav`.
 *  - external `http(s)`: post `stashbase-open-external` so the host
 *    opens it in the embedded browser (Electron) or new tab.
 *  Other schemes (`mailto:` etc.) fall through. */
function handleAnchorClick(anchor: HTMLAnchorElement, e: Event) {
  const raw = anchor.getAttribute('href');
  if (!raw || raw.startsWith('#')) return;
  // `anchor.href` is the browser-resolved absolute URL (uses the
  // iframe's `<base>` which points at `/asset/<dir>/`).
  let url: URL;
  try { url = new URL(anchor.href, window.location.href); } catch { return; }
  if (url.origin === window.location.origin && url.pathname.startsWith('/asset/')) {
    const navTarget = parseAssetUrl(url);
    if (!navTarget) return;
    e.preventDefault();
    window.postMessage({
      type: 'stashbase-nav',
      path: navTarget.path,
      anchor: navTarget.anchor,
    }, window.location.origin);
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    e.preventDefault();
    window.postMessage({ type: 'stashbase-open-external', href: url.href }, window.location.origin);
  }
}

/** Convert an `/asset/...` URL back into a space-relative path + anchor.
 *  Only navigable formats (`.md` / `.html` / `.htm`) qualify — anything
 *  else (image, css, etc.) returns `null` so the click falls through. */
function parseAssetUrl(url: URL): { path: string; anchor?: string } | null {
  const encoded = url.pathname.slice('/asset/'.length);
  let decoded: string;
  try {
    decoded = encoded.split('/').map(decodeURIComponent).join('/');
  } catch { return null; }
  if (!/\.(md|markdown|html|htm)$/i.test(decoded)) return null;
  const anchor = url.hash.startsWith('#') ? url.hash.slice(1) : undefined;
  return { path: decoded, anchor };
}

function withMarkdownAssetBase(html: string, baseHref: string): string {
  const tag = `<base href="${escapeAttr(baseHref)}">`;
  if (/<base\b/i.test(html)) return html;
  return html.replace(/<head\b[^>]*>/i, (m) => m + tag);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
