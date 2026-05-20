/**
 * Find-in-iframe driver. Walks text nodes in a Document, computes Range
 * objects for each substring match, paints them with the CSS Custom
 * Highlight API. One Range gets the "current" highlight (used by the
 * counter + scrollIntoView); the rest get a duller "match" tint.
 *
 * Realm-aware: every Range / Highlight is built against the supplied
 * window so the highlight registers in that document's `CSS.highlights`
 * registry — not the parent's. Used by `MarkdownPreview` where the
 * parent reaches into a `sandbox="allow-same-origin"` iframe directly;
 * the same algorithm is mirrored in `server/html.ts`'s injected
 * bootstrap for the sandboxed `HtmlPreview` (which the parent cannot
 * touch, so the iframe runs its own copy).
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
  let wholeWord = false;

  function recompute(): MatchInfo {
    matches = [];
    cursor = -1;
    const doc = getDoc();
    const win = getWin();
    if (!doc || !win) return clearAndReport(getWin());
    if (!query) return clearAndReport(win);
    ensureStyle(doc);
    const re = buildRegex(query, wholeWord);
    if (!re) return clearAndReport(win);

    // TreeWalker over text nodes, skipping <script> / <style> / hidden
    // subtrees — same exclusion set Chrome's find uses. `acceptNode`
    // walks up to find an excluded ancestor; cheap because most pages
    // have shallow exclusion chains.
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        const t = node.parentElement?.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue ?? '';
      if (!text) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) != null) {
        const r = doc.createRange();
        try {
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
        } catch { continue; }
        matches.push(r);
        // Guard against zero-width matches (regex degenerate case) so
        // exec doesn't spin forever.
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }

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
    // Range doesn't have scrollIntoView; use a temporary element at
    // the start, scroll it, then drop. Cheaper than always wrapping
    // the range in a <mark>.
    const doc = getDoc();
    if (!doc) return;
    const probe = doc.createElement('span');
    probe.setAttribute('data-stashbase-find-probe', '1');
    try {
      r.insertNode(probe);
      probe.scrollIntoView({ behavior: 'auto', block: 'center' });
    } catch { /* fall through */ }
    finally {
      // Re-merge text nodes that `insertNode` split so we don't leave
      // the doc fragmented after repeated next/prev steps.
      const parent = probe.parentNode;
      probe.remove();
      parent?.normalize();
      // `normalize()` invalidates the existing Range offsets — rebuild
      // matches against the merged text so the next step lands cleanly.
      if (parent) refreshMatchesFor(doc);
    }
  }

  // After normalize() the cached ranges still point to nodes, but
  // offsets relative to the now-merged text are wrong. Re-walk and
  // rebuild, preserving the cursor on the same logical match if we can
  // find it again (otherwise reset to 0).
  function refreshMatchesFor(_doc: Document): void {
    const win = getWin();
    if (!win) return;
    const oldCursorRange = matches[cursor];
    const oldText = oldCursorRange ? rangeText(oldCursorRange) : '';
    const oldStartContainer = oldCursorRange?.startContainer;
    // Re-execute the same query to rebuild the list. We can't call
    // recompute() because it would re-paint + scroll; we just need
    // fresh ranges.
    const next: Range[] = [];
    rebuild(next);
    matches = next;
    if (matches.length === 0) { cursor = -1; return; }
    let newCursor = 0;
    for (let i = 0; i < matches.length; i++) {
      const r = matches[i];
      if (r.startContainer === oldStartContainer && rangeText(r) === oldText) {
        newCursor = i; break;
      }
    }
    cursor = newCursor;
    paint(win, matches, matches[cursor]);
  }

  function rebuild(out: Range[]): void {
    const doc = getDoc();
    if (!doc || !query) return;
    const re = buildRegex(query, wholeWord);
    if (!re) return;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node) {
        const t = node.parentElement?.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n: Node | null = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue ?? '';
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) != null) {
        const r = doc.createRange();
        try {
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          out.push(r);
        } catch { /* node mutated under us — skip */ }
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }

  return {
    setQuery(q, opts) {
      query = q;
      wholeWord = opts.wholeWord;
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

function rangeText(r: Range): string {
  try { return r.toString(); } catch { return ''; }
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
    `::highlight(${HL_CURRENT}) { background: #ff9800; color: #fff; }`;
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

function buildRegex(q: string, wholeWord: boolean): RegExp | null {
  if (!q) return null;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
  try {
    return new RegExp(body, 'giu');
  } catch {
    return null;
  }
}
