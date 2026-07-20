/** Wraps rendered Markdown in the self-contained preview iframe document. */
export function createPreviewDocument(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PREVIEW_CSS}</style></head><body>${bodyHtml}</body></html>`;
}

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
a { color: #0e7490; text-decoration: underline; text-decoration-color: rgba(14, 116, 144, 0.4); overflow-wrap: anywhere; }
a:hover { text-decoration-color: rgba(14, 116, 144, 0.85); }
a:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; border-radius: 2px; }
sup:has([data-footnote\\:ref]) { font-size: 0.75em; line-height: 0; vertical-align: super; }
[data-footnote\\:ref] { padding: 0 0.12em; text-decoration: none; }
.footnotes {
  margin-top: 2.5em; color: rgba(55, 53, 47, 0.78); font-size: 0.875em;
}
.footnotes hr { margin-bottom: 1.25em; }
.footnotes ol { padding-left: 1.8em; }
.footnotes li { padding-left: 0.25em; scroll-margin-top: 1em; }
.footnotes li:target { background: rgba(14, 116, 144, 0.08); }
.footnotes p { margin: 0.45em 0; }
[data-footnote\\:backref] { display: inline-block; margin-left: 0.3em; padding: 0 0.2em; text-decoration: none; }
[data-footnote\\:ref]:focus-visible,
[data-footnote\\:backref]:focus-visible {
  outline: 2px solid #0e7490; outline-offset: 2px; border-radius: 2px;
}
code {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.875em;
  background: rgba(140, 149, 159, 0.1);
  color: rgb(55, 53, 47);
  padding: 0.15em 0.4em; border-radius: 4px;
  overflow-wrap: anywhere;
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
.markdown-alert {
  --alert-color: #0969da;
  --alert-background: #ddf4ff;
  margin: 1em 0; padding: 12px 16px;
  border-left: 4px solid var(--alert-color); border-radius: 4px;
  background: var(--alert-background);
}
.markdown-alert-title { display: flex; align-items: center; gap: 0.45em; margin: 0; font-weight: 700; color: var(--alert-color); }
.markdown-alert-title svg { width: 1em; height: 1em; fill: currentColor; flex: 0 0 auto; }
.markdown-alert > :not(.markdown-alert-title) { margin: 0.55em 0 0; }
.markdown-alert-tip { --alert-color: #1a7f37; --alert-background: #dafbe1; }
.markdown-alert-important { --alert-color: #8250df; --alert-background: #fbefff; }
.markdown-alert-warning { --alert-color: #9a6700; --alert-background: #fff8c5; }
.markdown-alert-caution { --alert-color: #cf222e; --alert-background: #ffebe9; }
ul, ol { padding-left: 1.6em; margin: 0.9em 0; }
li { margin: 0.35em 0; }
li:has(> input[type="checkbox"]),
li:has(> p:first-child > input[type="checkbox"]) { list-style: none; }
li > input[type="checkbox"],
li > p:first-child > input[type="checkbox"] {
  margin: 0 0.5em 0.15em -1.3em; vertical-align: middle; accent-color: #0e7490;
}
table {
  border-collapse: collapse; margin: 0.5em 0; font-size: 0.95em;
  display: block; width: max-content; max-width: 100%; overflow-x: auto;
}
th, td { border: 1px solid rgb(236, 238, 241); padding: 6px 10px; }
th { background: rgb(248, 250, 252); font-weight: 600; }
img { max-width: 100%; height: auto; border-radius: 3px; }
img[data-stashbase-previewable="true"] { cursor: zoom-in; }
hr { border: 0; border-top: 1px solid rgb(236, 238, 241); margin: 1em 0; }
kbd {
  display: inline-block; padding: 0.15em 0.45em;
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 0.8em; line-height: 1.3; vertical-align: middle;
  background: rgb(248, 250, 252);
  border: 1px solid rgb(212, 218, 226); border-bottom-width: 2px; border-radius: 4px;
}
mark { background: rgba(255, 212, 0, 0.35); padding: 0 0.15em; border-radius: 2px; }
abbr[title] { text-decoration: underline dotted; cursor: help; }
details { margin: 0.9em 0; }
summary { cursor: pointer; font-weight: 600; }
summary:focus-visible { outline: 2px solid #0e7490; outline-offset: 2px; border-radius: 2px; }

/* Highlight.js token palette — static spans only, tuned to the light
 * preview theme (GitHub-Primer-like hues on the existing pre background). */
.hljs-comment, .hljs-quote { color: #57606a; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-template-tag { color: #cf222e; }
.hljs-title, .hljs-title.class_, .hljs-title.function_, .hljs-section { color: #8250df; }
.hljs-string, .hljs-regexp, .hljs-char.escape_ { color: #0a3069; }
.hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet,
.hljs-selector-class, .hljs-selector-id, .hljs-meta, .hljs-link { color: #0550ae; }
.hljs-attr, .hljs-attribute, .hljs-property, .hljs-params,
.hljs-selector-attr, .hljs-selector-pseudo, .hljs-variable, .hljs-template-variable, .hljs-operator { color: #953800; }
.hljs-name, .hljs-tag, .hljs-built_in, .hljs-type { color: #116329; }
.hljs-addition { color: #116329; background: #dafbe1; }
.hljs-deletion { color: #82071e; background: #ffebe9; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
`;
