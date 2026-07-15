/**
 * Markdown → self-contained HTML for preview iframes. Mirrors the
 * legacy `editor-src/code-editor.js:renderMarkdown` so visual parity
 * is preserved across the migration.
 *
 * Headings get stable, duplicate-safe slug IDs so in-doc anchor links can
 * scroll to fragment targets. Styles are inlined because the iframe is
 * sandboxed and would not inherit the host page's CSS anyway.
 */
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const documentMarkdown = new Marked({ gfm: true, breaks: false });
const inlineMarkdown = new Marked({ gfm: true, breaks: true });

/** Markdown → HTML *fragment* (no `<html>`/`<style>` wrapper), for
 *  rendering inline inside the app's own DOM — chat bubbles use this so
 *  assistant prose, code blocks, and lists render in place rather than
 *  in a sandboxed iframe. Styling comes from the host page's CSS. */
export function renderMarkdownInline(md: string): string {
  return inlineMarkdown.parse(md ?? '', { async: false }) as string;
}

export function renderMarkdown(md: string): string {
  let html = documentMarkdown.parse(md ?? '', { async: false }) as string;
  html = sanitizeHtml(html, MARKDOWN_SANITIZE_OPTIONS);
  const nextSuffix = new Map<string, number>();
  const usedSlugs = new Set<string>();
  html = html.replace(
    /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g,
    (_match, level: string, attrs: string | undefined, inner: string) => {
      const text = stripInlineTags(inner).trim();
      const id = nextSlug(text, nextSuffix, usedSlugs);
      const safeAttrs = (attrs ?? '').replace(/\sid=(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
      return `<h${level} id="${id}"${safeAttrs}>${inner}</h${level}>`;
    },
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_CSS}</style></head><body>${html}</body></html>`;
}

const MARKDOWN_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br',
    'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
    'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li',
    'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small',
    'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var',
  ],
  allowedAttributes: {
    '*': ['id', 'title', 'dir', 'lang', 'aria-*'],
    a: ['href'],
    blockquote: ['cite'],
    code: ['class'],
    col: ['span'],
    colgroup: ['span'],
    del: ['cite', 'datetime'],
    details: ['open'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    input: ['type', 'checked', 'disabled'],
    ins: ['cite', 'datetime'],
    li: ['class', 'value'],
    ol: ['start', 'reversed', 'type'],
    q: ['cite'],
    td: ['colspan', 'rowspan', 'headers', 'align'],
    th: ['colspan', 'rowspan', 'headers', 'scope', 'align'],
    ul: ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: {
    img: ['http', 'https'],
  },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    input: (_tagName, attributes) => ({
      tagName: 'input',
      attribs: {
        type: 'checkbox',
        disabled: '',
        ...(Object.hasOwn(attributes, 'checked') ? { checked: '' } : {}),
      },
    }),
  },
};

/** Kebab-case heading slug. Mirrors GitHub's approach: lowercase, drop
 *  punctuation, collapse folders to dashes. Cross-file anchor links use
 *  this so `[..](other.md#layered-small-world-routing)` resolves. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function nextSlug(
  text: string,
  nextSuffix: Map<string, number>,
  usedSlugs: Set<string>,
): string {
  const base = slugifyHeading(text) || 'section';
  let suffix = nextSuffix.get(base) ?? 0;
  let candidate = suffix === 0 ? base : `${base}-${suffix}`;
  while (usedSlugs.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  nextSuffix.set(base, suffix + 1);
  usedSlugs.add(candidate);
  return candidate;
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

/** Notion-flavoured preview styles. Generous heading margins, an airy
 *  paragraph rhythm (Typora-like prose spacing), monospace code blocks on a
 *  warm-grey background. */
const PREVIEW_CSS = `
html, body { margin: 0; padding: 0; background: #fff; color: rgb(55, 53, 47); }
body {
  font: 16px/1.7 ui-sans-serif, -apple-system, BlinkMacSystemFont,
    "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  padding: 32px 56px 80px;
  max-width: 820px; margin: 0 auto;
}
h1, h2, h3, h4, h5, h6 {
  font-weight: 700; line-height: 1.3; color: rgb(55, 53, 47);
  letter-spacing: -0.01em;
  margin: 1.8em 0 0.6em;
}
h1 { font-size: 1.875em; margin-top: 1.4em; padding-bottom: 0.3em; border-bottom: 1px solid rgb(236, 238, 241); }
h2 { font-size: 1.5em; padding-bottom: 0.25em; border-bottom: 1px solid rgb(236, 238, 241); }
h3 { font-size: 1.25em; }
h4 { font-size: 1.05em; }
h5 { font-size: 0.95em; }
h6 { font-size: 0.85em; color: rgba(55, 53, 47, 0.65); }
p { margin: 0.9em 0; }
a { color: #0e7490; text-decoration: underline; text-decoration-color: rgba(14, 116, 144, 0.4); }
a:hover { text-decoration-color: rgba(14, 116, 144, 0.85); }
code {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.875em;
  background: rgba(140, 149, 159, 0.1);
  color: rgb(55, 53, 47);
  padding: 0.15em 0.4em; border-radius: 4px;
}
pre {
  background: rgb(248, 250, 252); padding: 14px 18px; border-radius: 6px;
  border: 1px solid rgb(236, 238, 241);
  overflow-x: auto; line-height: 1.5; margin: 1em 0;
}
pre code { background: transparent; color: rgb(55, 53, 47); padding: 0; font-size: 0.88em; }
blockquote {
  margin: 1em 0; padding: 4px 14px;
  border-left: 3px solid rgb(55, 53, 47);
  color: inherit;
}
ul, ol { padding-left: 1.6em; margin: 0.9em 0; }
li { margin: 0.35em 0; }
table { border-collapse: collapse; margin: 0.5em 0; font-size: 0.95em; }
th, td { border: 1px solid rgb(236, 238, 241); padding: 6px 10px; }
th { background: rgb(248, 250, 252); font-weight: 600; }
img { max-width: 100%; height: auto; border-radius: 3px; }
img[data-stashbase-previewable="true"] { cursor: zoom-in; }
hr { border: 0; border-top: 1px solid rgb(236, 238, 241); margin: 1em 0; }
`;
