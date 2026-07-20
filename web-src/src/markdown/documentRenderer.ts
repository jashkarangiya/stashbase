import hljs from 'highlight.js/lib/common';
import markedFootnote from 'marked-footnote';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import { markedHighlight } from 'marked-highlight';
import { Marked } from 'marked';
import markedAlert from 'marked-alert';

import { stripLeadingYamlFrontmatter } from './frontmatter';
import { normalizeHeadingIds, stripRawHeadingIds } from './headingIds';
import { createPreviewDocument } from './previewDocument';
import { sanitizeMarkdownHtml } from './sanitization';

/** Owns the ordered document-preview transformation pipeline. */
export function renderDocumentMarkdown(markdown: string): string {
  const documentMarkdown = new Marked({ gfm: true, breaks: false });
  // GitHub heading slugs omit colons, so this keeps package-generated
  // footnote targets disjoint from document heading anchors.
  documentMarkdown.use(
    markedFootnote({ prefixId: 'footnote:' }),
    gfmHeadingId(),
    markedAlert(),
    markedHighlight({ highlight: highlightFencedCode }),
  );
  documentMarkdown.use({
    renderer: {
      html: ({ text }) => stripRawHeadingIds(text),
    },
  });
  const parsed = documentMarkdown.parse(stripLeadingYamlFrontmatter(markdown), { async: false }) as string;
  return createPreviewDocument(normalizeHeadingIds(sanitizeMarkdownHtml(parsed)));
}

/** Static Highlight.js pass for explicitly-labelled fenced code. Returning
 *  the input unchanged makes marked-highlight keep marked's own escaping
 *  (it only trusts output that differs from the input), so unlabelled and
 *  unregistered languages stay readable plain code and never throw. */
function highlightFencedCode(code: string, lang: string): string {
  if (!lang || !hljs.getLanguage(lang)) return code;
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return code;
  }
}
