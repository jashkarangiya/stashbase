/**
 * Markdown → self-contained HTML for preview iframes. Mirrors the
 * legacy `editor-src/code-editor.js:renderMarkdown` so visual parity
 * is preserved across the migration.
 *
 * Headings get stable `id="h-N"` attributes so in-doc anchor links can
 * scroll-to via fragment nav. Styles are inlined because the iframe is
 * sandboxed and wouldn't inherit the host page's CSS anyway.
 */
import { marked } from 'marked';

// `breaks: true` makes single newlines render as <br> instead of
// collapsing to spaces. Matches GitHub / Obsidian default and "what you
// see in the editor is what you see in the preview" — important for
// transcripts and other line-per-thought notes where the author meant
// the line break literally. Prose with soft-wrap at 72 columns is
// uncommon enough in this app's audience to make it the right trade.
marked.use({ gfm: true, breaks: true });

/** Markdown → HTML *fragment* (no `<html>`/`<style>` wrapper), for
 *  rendering inline inside the app's own DOM — chat bubbles use this so
 *  assistant prose, code blocks, and lists render in place rather than
 *  in a sandboxed iframe. Styling comes from the host page's CSS. */
export function renderMarkdownInline(md: string): string {
  return marked.parse(md ?? '', { async: false }) as string;
}

export function renderMarkdown(md: string): string {
  let html = marked.parse(md ?? '', { async: false }) as string;
  const taken = new Map<string, number>();
  html = html.replace(
    /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g,
    (_match, level: string, attrs: string | undefined, inner: string) => {
      const text = stripInlineTags(inner).trim();
      const id = nextSlug(text, taken);
      return `<h${level} id="${id}"${attrs ?? ''}>${inner}</h${level}>`;
    },
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_CSS}</style></head><body>${html}</body></html>`;
}

/** Kebab-case heading slug. Mirrors GitHub's approach: lowercase, drop
 *  punctuation, collapse spaces to dashes. Cross-file anchor links use
 *  this so `[..](other.md#layered-small-world-routing)` resolves. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function nextSlug(text: string, taken: Map<string, number>): string {
  const base = slugifyHeading(text) || 'section';
  const n = taken.get(base) ?? 0;
  taken.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function stripInlineTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/** Notion-flavoured preview styles. Big top margin on headings, tight
 *  paragraph rhythm, monospace code blocks on a warm-grey background. */
const PREVIEW_CSS = `
html, body { margin: 0; padding: 0; background: #fff; color: rgb(55, 53, 47); }
body {
  font: 16px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont,
    "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    sans-serif;
  padding: 32px 56px 80px;
  max-width: 820px; margin: 0 auto;
}
h1, h2, h3, h4, h5, h6 {
  font-weight: 700; line-height: 1.3; color: rgb(55, 53, 47);
  margin: 1.6em 0 0.25em;
}
h1 { font-size: 1.875em; margin-top: 1.4em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1.05em; }
h5 { font-size: 0.95em; }
h6 { font-size: 0.85em; color: rgba(55, 53, 47, 0.65); }
p { margin: 0.25em 0; }
a { color: rgb(55, 53, 47); text-decoration: underline; text-decoration-color: rgba(55, 53, 47, 0.4); }
a:hover { text-decoration-color: rgba(55, 53, 47, 0.85); }
code {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.85em;
  background: rgba(135, 131, 120, 0.15);
  color: #eb5757;
  padding: 0.15em 0.4em; border-radius: 4px;
}
pre {
  background: rgb(247, 246, 243); padding: 14px 18px; border-radius: 4px;
  overflow-x: auto; line-height: 1.5; margin: 0.4em 0;
}
pre code { background: transparent; color: rgb(55, 53, 47); padding: 0; font-size: 0.88em; }
blockquote {
  margin: 0.4em 0; padding: 4px 14px;
  border-left: 3px solid rgb(55, 53, 47);
  color: inherit;
}
ul, ol { padding-left: 1.6em; margin: 0.25em 0; }
li { margin: 0.15em 0; }
table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.95em; }
th, td { border: 1px solid rgb(233, 233, 231); padding: 6px 10px; }
th { background: rgb(247, 246, 243); font-weight: 600; }
img { max-width: 100%; height: auto; border-radius: 3px; }
img[data-stashbase-previewable="true"] { cursor: zoom-in; }
hr { border: 0; border-top: 1px solid rgb(233, 233, 231); margin: 1em 0; }
`;

/** Append the same postMessage scroll / external-link listener
 *  `server/html.ts` injects into prepared HTML, so edit-mode previews
 *  behave like read-only ones. */
export function withScrollBootstrap(html: string): string {
  // Mirrors `server/html.ts:addScrollBootstrap` (kept in sync by hand).
  // Used for edit-mode HTML preview where the source is a blob URL and
  // `server/html.ts` hasn't processed it.
  const script = `<script>
window.addEventListener("message", function(e) {
  if (!e || !e.data || e.data.type !== "stashbase-scroll") return;
  var el = document.getElementById(e.data.id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.addEventListener("click", function(e) {
  var node = e.target;
  while (node && node.tagName !== "A" && node.tagName !== "IMG") node = node.parentElement;
  if (!node) return;
  if (node.tagName === "IMG") {
    var src = node.currentSrc || node.getAttribute("src");
    if (!src) return;
    try {
      e.preventDefault();
      window.parent.postMessage({
        type: "stashbase-preview-image",
        src: new URL(src, document.baseURI).href,
        alt: node.getAttribute("alt") || ""
      }, "*");
    } catch (_) {}
    return;
  }
  var raw = node.getAttribute("href");
  if (!raw || raw.charAt(0) === "#") return;
  try {
    var url = new URL(raw, document.baseURI);
    if (url.origin === location.origin && url.pathname.indexOf("/asset/") === 0) {
      var encoded = url.pathname.slice("/asset/".length);
      var decoded;
      try {
        decoded = encoded.split("/").map(decodeURIComponent).join("/");
      } catch (_) { return; }
      if (/\\.(md|markdown|html|htm)$/i.test(decoded)) {
        e.preventDefault();
        var anchor = url.hash && url.hash.charAt(0) === "#" ? url.hash.slice(1) : "";
        window.parent.postMessage({
          type: "stashbase-nav",
          path: decoded,
          anchor: anchor || undefined
        }, "*");
        return;
      }
    }
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== location.origin) {
      e.preventDefault();
      window.parent.postMessage({ type: "stashbase-open-external", href: url.href }, "*");
    }
  } catch (_) {}
});
<\/script>`;
  const idx = html.lastIndexOf('</body>');
  return idx >= 0 ? html.slice(0, idx) + script + html.slice(idx) : html + script;
}
