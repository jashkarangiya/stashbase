/**
 * Find-in-iframe driver. Matches the query against the concatenated
 * text of the document's visible text nodes — so a match may span
 * inline element boundaries (formatting markup, highlighted-code token
 * spans) but never a block boundary or `<br>`, where a separator is
 * inserted — and paints each match Range with the CSS Custom Highlight
 * API. One Range gets the "current" highlight (used by the counter +
 * scrollIntoView); the rest get a duller "match" tint.
 *
 * Realm-aware: every Range / Highlight is built against the supplied
 * window so the highlight registers in that document's `CSS.highlights`
 * registry — not the parent's. Used by `MarkdownPreview` where the
 * parent reaches into a `sandbox="allow-same-origin"` iframe directly;
 * `server/html.ts`'s injected bootstrap for the sandboxed `HtmlPreview`
 * (which the parent cannot touch, so the iframe runs its own copy)
 * carries a simpler per-text-node variant of the same approach.
 *
 * Browser support: CSS Custom Highlight API ships in Chromium 105+,
 * which covers every Electron version we target. No fallback needed.
 */
import type { FindController, MatchInfo } from '../store/AppContext';

const HL_ALL = 'stash-find';
const HL_CURRENT = 'stash-find-current';
const STYLE_ID = 'stash-find-style';

/** Make a controller that drives find against the given iframe.
 *  `getDoc` / `getWin` are getters because the iframe's document is
 *  replaced on every content reload — the controller must re-resolve
 *  to the live one on each call instead of caching a stale reference. */
export function makeIframeFindController(
  getDoc: () => Document | null,
  getWin: () => Window | null,
): FindController {
  let matches: Range[] = [];
  let cursor = -1; // index into `matches`, -1 = nothing selected
  let query = '';
  let caseSensitive = false;
  let wholeWord = false;

  function recompute(): MatchInfo {
    matches = [];
    cursor = -1;
    const doc = getDoc();
    const win = getWin();
    if (!doc || !win) return clearAndReport(getWin());
    if (!query) return clearAndReport(win);
    ensureStyle(doc);
    const re = buildRegex(query, wholeWord, caseSensitive);
    if (!re) return clearAndReport(win);

    matches = collectMatches(doc, re);
    if (matches.length === 0) {
      paint(win, [], null);
      return { current: 0, total: 0 };
    }
    cursor = 0;
    paint(win, matches, matches[cursor]);
    scrollToCurrent();
    return { current: 1, total: matches.length };
  }

  function step(dir: 1 | -1): MatchInfo {
    if (matches.length === 0) return { current: 0, total: 0 };
    cursor = (cursor + dir + matches.length) % matches.length;
    const win = getWin();
    if (win) paint(win, matches, matches[cursor]);
    scrollToCurrent();
    return { current: cursor + 1, total: matches.length };
  }

  function scrollToCurrent(): void {
    const r = matches[cursor];
    if (!r) return;
    const win = getWin();
    if (!win) return;
    const rect = firstVisibleRect(r);
    if (!rect) return;
    win.scrollBy({
      top: rect.top + rect.height / 2 - win.innerHeight / 2,
      left: rect.left + rect.width / 2 - win.innerWidth / 2,
      behavior: 'auto',
    });
  }

  return {
    setQuery(q, opts) {
      query = q;
      wholeWord = opts.wholeWord;
      caseSensitive = opts.caseSensitive;
      return recompute();
    },
    next() { return step(1); },
    prev() { return step(-1); },
    close() {
      matches = [];
      cursor = -1;
      query = '';
      const win = getWin();
      if (win) paint(win, [], null);
    },
  };
}

function clearAndReport(win: Window | null): MatchInfo {
  if (win) paint(win, [], null);
  return { current: 0, total: 0 };
}

type TextSegment = { node: Text; start: number };

/** Minimal structural view of a DOM subtree. `Element` and `Text`
 *  satisfy it directly; tests build literal fixtures without a
 *  browser document. */
export interface CorpusNode {
  nodeType: number;
  tagName?: string;
  data?: string;
  firstChild: CorpusNode | null;
  nextSibling: CorpusNode | null;
}

const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

/** Block-level elements the sanitizer can emit. Crossing one inserts a
 *  separator so text in different blocks cannot join into one match. */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS',
  'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5',
  'H6', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/** The find input is single-line, so a query can never contain this
 *  character and no match can ever span a separator. */
const BLOCK_SEPARATOR = '\n';

/** Flattens visible text into one searchable string plus a map back to
 *  the source text nodes. Adjacent inline fragments (formatting markup,
 *  highlighted-code token spans) join, mirroring what the user visually
 *  reads; block-level boundaries and `<br>` insert a separator so raw
 *  HTML like `<p>foo</p><p>bar</p>` cannot match "foobar". Skips
 *  <script> / <style> subtrees — same exclusion set Chrome's find uses. */
export function buildFindCorpus(root: CorpusNode): { joined: string; segments: Array<{ node: CorpusNode; start: number }> } {
  const segments: Array<{ node: CorpusNode; start: number }> = [];
  let joined = '';
  const separate = () => {
    if (joined && !joined.endsWith(BLOCK_SEPARATOR)) joined += BLOCK_SEPARATOR;
  };
  const visit = (node: CorpusNode): void => {
    if (node.nodeType === 3) {
      if (!node.data) return;
      segments.push({ node, start: joined.length });
      joined += node.data;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName ?? '';
    if (EXCLUDED_TAGS.has(tag)) return;
    if (tag === 'BR') {
      separate();
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) separate();
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
    if (block) separate();
  };
  visit(root);
  return { joined, segments };
}

/** Runs the query over the flattened corpus and maps each match back to
 *  a (possibly multi-node) Range. */
function collectMatches(doc: Document, re: RegExp): Range[] {
  const corpus = buildFindCorpus(doc.body as unknown as CorpusNode);
  const joined = corpus.joined;
  // Every corpus node with nodeType 3 in a live document is a Text node.
  const segments = corpus.segments as unknown as TextSegment[];

  const out: Range[] = [];
  if (!joined) return out;
  re.lastIndex = 0;
  let seg = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined)) != null) {
    // Guard against zero-width matches (regex degenerate case) so
    // exec doesn't spin forever.
    if (m.index === re.lastIndex) re.lastIndex++;
    if (m[0].length === 0) continue;
    seg = advanceTo(segments, seg, m.index);
    const startSeg = segments[seg];
    const endSeg = segments[advanceTo(segments, seg, m.index + m[0].length - 1)];
    const r = doc.createRange();
    try {
      r.setStart(startSeg.node, m.index - startSeg.start);
      r.setEnd(endSeg.node, m.index + m[0].length - endSeg.start);
      out.push(r);
    } catch { /* node mutated under us — skip */ }
  }
  return out;
}

/** Index of the segment containing global text offset `idx`. Matches
 *  arrive in ascending order, so the scan resumes from `from`. */
function advanceTo(segments: TextSegment[], from: number, idx: number): number {
  let i = from;
  while (i + 1 < segments.length && segments[i + 1].start <= idx) i++;
  return i;
}

function firstVisibleRect(r: Range): DOMRect | null {
  const rects = Array.from(r.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length > 0) return rects[0];
  const rect = r.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

/** Inject highlight styles into the iframe doc once. Scoped to our two
 *  highlight names so we don't fight any page-supplied `::highlight()`
 *  rules. Yellow for all matches, orange for the active one — Chrome's
 *  find-in-page palette. */
function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    `::highlight(${HL_ALL}) { background: #ffe082; color: inherit; }` +
    `::highlight(${HL_CURRENT}) { background: #1a73e8; color: #fff; }`;
  doc.head.appendChild(style);
}

function paint(win: Window, all: Range[], current: Range | null): void {
  const CSSNS = (win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const HL = (win as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!CSSNS?.highlights || !HL) return;
  if (all.length === 0) {
    CSSNS.highlights.delete(HL_ALL);
    CSSNS.highlights.delete(HL_CURRENT);
    return;
  }
  // Active range is excluded from the "all matches" highlight so the
  // orange current band reads cleanly without yellow bleed underneath.
  const others = current ? all.filter((r) => r !== current) : all;
  CSSNS.highlights.set(HL_ALL, new HL(...others));
  if (current) CSSNS.highlights.set(HL_CURRENT, new HL(current));
  else CSSNS.highlights.delete(HL_CURRENT);
}

function buildRegex(q: string, wholeWord: boolean, caseSensitive: boolean): RegExp | null {
  if (!q) return null;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
  try {
    return new RegExp(body, caseSensitive ? 'gu' : 'giu');
  } catch {
    return null;
  }
}
