/**
 * Shared helpers for the same-origin (`sandbox=allow-same-origin`)
 * preview iframes used by `MarkdownPreview` and `Split`'s live-preview
 * pane. Both inject a `<base>` so relative asset URLs resolve under
 * `/asset/`, and both intercept in-iframe `<img>` / `<a>` clicks to
 * forward them to the host (image lightbox / in-app nav / external open)
 * via `postMessage`. Previously each component carried its own copy.
 */

/** Inject a `<base href>` so relative asset refs resolve under `/asset/`.
 *  Handles docs with or without a `<head>` and a leading `<!doctype>`. */
export function injectAssetBase(html: string, baseHref: string): string {
  if (/<base\b/i.test(html)) return html;
  const tag = `<base href="${escapeAttr(baseHref)}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => m + tag);
  }
  if (/^\s*<!doctype\b[^>]*>/i.test(html)) {
    return html.replace(/^(\s*<!doctype\b[^>]*>)/i, `$1<head>${tag}</head>`);
  }
  return `<head>${tag}</head>` + html;
}

/** Click handler for a preview iframe's document: a clicked image opens
 *  the shared lightbox; a clicked link forwards to in-app nav (relative
 *  notes) or external open (`http(s)`). Other schemes fall through.
 *
 *  Duck-types the target instead of `instanceof Element` because events
 *  fired inside the iframe carry elements from the iframe's separate JS
 *  realm (the parent's `Element` constructor won't match even with
 *  `allow-same-origin`). */
export function previewClickHandler(e: Event): void {
  const target = e.target as (Element & { closest?: typeof Element.prototype.closest }) | null;
  if (!target || typeof target.closest !== 'function') return;
  const img = target.closest('img') as HTMLImageElement | null;
  if (img) {
    const src = img.currentSrc || img.src;
    if (!src) return;
    e.preventDefault();
    window.postMessage({ type: 'stashbase-preview-image', src, alt: img.alt || '' }, window.location.origin);
    return;
  }
  const anchor = target.closest('a') as HTMLAnchorElement | null;
  if (anchor) forwardAnchorClick(anchor, e);
}

function forwardAnchorClick(anchor: HTMLAnchorElement, e: Event): void {
  const raw = anchor.getAttribute('href');
  if (!raw || raw.startsWith('#')) return; // in-doc anchor → let the iframe handle it
  // `anchor.href` is browser-resolved against the iframe's `<base>`.
  let url: URL;
  try { url = new URL(anchor.href, window.location.href); } catch { return; }
  if (url.origin === window.location.origin && url.pathname.startsWith('/asset/')) {
    const encoded = url.pathname.slice('/asset/'.length);
    let decoded: string;
    try { decoded = encoded.split('/').map(decodeURIComponent).join('/'); } catch { return; }
    if (!/\.(md|markdown|html|htm)$/i.test(decoded)) return; // only navigable notes
    e.preventDefault();
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : '';
    window.postMessage({ type: 'stashbase-nav', path: decoded, anchor: hash || undefined }, window.location.origin);
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    e.preventDefault();
    window.postMessage({ type: 'stashbase-open-external', href: url.href }, window.location.origin);
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
