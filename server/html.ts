/**
 * HTML → viewer-ready markup + section headings + indexable plaintext.
 *
 * One lightweight tokenizer pass walks heading blocks in document order:
 *   - heading elements (h1..h6) become section boundaries AND get a
 *     stable `id="h-<N>"` injected so the iframe viewer can scroll to
 *     them via postMessage.
 *   - text between consecutive headings becomes that section's body,
 *     stripped to plaintext for indexing.
 *
 * Chunking is **no longer done here** — that's MFS's job. We emit
 * `plaintext` shaped like markdown (`# Heading\n\nbody…`) so MFS's
 * markdown chunker keeps respecting our heading boundaries even though
 * it doesn't natively parse HTML.
 */

export interface Heading {
  level: number;          // 1-6
  text: string;
  id: string;             // matches the id attribute injected on the element
}

export interface HtmlAnalysis {
  headings: Heading[];
  /** Original HTML with `id="h-<N>"` attrs injected on each heading.
   *  This is what the iframe viewer renders. */
  preparedHtml: string;
  /** Markdown-shaped plaintext of the doc (`# heading\n\nbody…`). Fed
   *  to MFS for chunking + embedding; preserves heading boundaries. */
  plaintext: string;
}

export function analyzeHtml(html: string): HtmlAnalysis {
  // Single combined regex walks heading opening tags + skips
  // non-indexable blocks (script/style/noscript/template) in one pass,
  // so we know each heading's character offset and can also rewrite
  // its opening tag with `id="h-<N>"` for the iframe viewer.
  const tokenRe = /<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>|<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\2\s*>/gi;

  const headings: Heading[] = [];
  const preparedParts: string[] = [];           // accumulated rewritten HTML
  const indexableSegments: string[] = [];       // text segments to flatten for plaintext
  const plaintextParts: string[] = [];
  let preparedCursor = 0;
  let indexableCursor = 0;
  // Build the "indexable" version (HTML minus script/style/...) and the
  // "prepared" version (HTML with heading ids injected) simultaneously.
  // For plaintext we want indexable; for preparedHtml we want the
  // original markup with ids added.
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    const [, skipTag, level, attrs, headingInner] = m;
    if (skipTag) {
      // Non-indexable block — keep verbatim in preparedHtml, drop from
      // plaintext input.
      preparedParts.push(html.slice(preparedCursor, m.index + m[0].length));
      preparedCursor = m.index + m[0].length;
      indexableSegments.push(html.slice(indexableCursor, m.index));
      indexableCursor = m.index + m[0].length;
      continue;
    }
    // Body before this heading goes into plaintext as flowing text.
    indexableSegments.push(html.slice(indexableCursor, m.index));
    const bodyText = collapseWhitespace(htmlToText(indexableSegments.join('')));
    indexableSegments.length = 0;
    if (bodyText) plaintextParts.push(bodyText, '');

    const lvl = Number(level);
    const headingText = collapseWhitespace(htmlToText(headingInner));
    const id = `h-${headings.length}`;
    headings.push({ level: lvl, text: headingText, id });
    plaintextParts.push(`${'#'.repeat(lvl)} ${headingText}`, '');

    // Rewrite the opening tag with `id="h-N"` in preparedHtml. The
    // heading inner + closing tag pass through unchanged.
    const cleanAttrs = (attrs ?? '').replace(/\s+id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
    preparedParts.push(html.slice(preparedCursor, m.index));
    preparedParts.push(`<h${lvl}${cleanAttrs} id="${id}">`);
    preparedCursor = m.index + `<h${lvl}${attrs}>`.length;
    // Restart the indexable cursor right after the heading element
    // (we consume the inner via headingText, not as body).
    indexableCursor = m.index + m[0].length;
  }
  // Tail: remaining body for plaintext + remaining markup for preparedHtml.
  indexableSegments.push(html.slice(indexableCursor));
  const tailText = collapseWhitespace(htmlToText(indexableSegments.join('')));
  if (tailText) plaintextParts.push(tailText);
  preparedParts.push(html.slice(preparedCursor));

  return {
    headings,
    preparedHtml: addScrollBootstrap(preparedParts.join('')),
    plaintext: plaintextParts.join('\n').trim(),
  };
}

function addScrollBootstrap(html: string): string {
  // The iframe viewer uses `sandbox="allow-scripts allow-same-origin"`.
  // `allow-same-origin` gives the page a real localhost origin so
  // `URL.createObjectURL` produces `blob:http://localhost/…` (loadable as
  // `<script src>`), but the parent window cannot reach the iframe DOM
  // directly. This tiny trusted listener gives in-doc anchor links a safe
  // scroll target, runs the in-iframe half of the Cmd+F find bar (parent
  // posts queries, iframe paints highlights via CSS Custom Highlights), and
  // forwards external link clicks so a YouTube/GitHub/etc link doesn't
  // navigate the sandboxed iframe to a blank page.
  const script = `<script>
(function() {
  var HL_ALL = 'stash-find';
  var HL_CUR = 'stash-find-current';
  var STYLE_ID = 'stash-find-style';
  var matches = [];
  var cursor = -1;
  var query = '';
  var caseSensitive = false;
  var wholeWord = false;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = '::highlight(' + HL_ALL + ') { background: #ffe082; color: inherit; }' +
                    '::highlight(' + HL_CUR + ') { background: #1a73e8; color: #fff; }' +
                    '::highlight(stashbase-chunk) { background: rgba(46, 116, 230, 0.18); ' +
                    'box-shadow: 0 0 0 2px rgba(46, 116, 230, 0.45); border-radius: 2px; }';
    document.head.appendChild(s);
  }
  function buildRegex(q, ww) {
    if (!q) return null;
    var escaped = q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    var body = ww ? '(?<![\\\\p{L}\\\\p{N}_])' + escaped + '(?![\\\\p{L}\\\\p{N}_])' : escaped;
    try { return new RegExp(body, caseSensitive ? 'gu' : 'giu'); } catch (_) { return null; }
  }
  function rebuild() {
    matches = [];
    var re = buildRegex(query, wholeWord);
    if (!re || !document.body) return;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        var t = n.parentElement && n.parentElement.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var text = n.nodeValue || '';
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text))) {
        var r = document.createRange();
        try {
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          matches.push(r);
        } catch (_) {}
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  function paint() {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    if (matches.length === 0) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CUR);
      return;
    }
    var current = cursor >= 0 ? matches[cursor] : null;
    var others = current ? matches.filter(function(r) { return r !== current; }) : matches;
    if (others.length) CSS.highlights.set(HL_ALL, new Highlight(...others));
    else CSS.highlights.delete(HL_ALL);
    if (current) CSS.highlights.set(HL_CUR, new Highlight(current));
    else CSS.highlights.delete(HL_CUR);
  }
  function scrollToCurrent() {
    if (cursor < 0 || !matches[cursor]) return;
    var rects = Array.prototype.slice.call(matches[cursor].getClientRects())
      .filter(function(rect) { return rect.width > 0 && rect.height > 0; });
    var rect = rects[0] || matches[cursor].getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    try {
      window.scrollBy({
        top: rect.top + rect.height / 2 - window.innerHeight / 2,
        left: rect.left + rect.width / 2 - window.innerWidth / 2,
        behavior: 'auto'
      });
    } catch (_) {}
  }
  function setQuery(q, ww, cs) {
    query = q || '';
    wholeWord = !!ww;
    caseSensitive = !!cs;
    ensureStyle();
    rebuild();
    cursor = matches.length > 0 ? 0 : -1;
    paint();
    if (cursor >= 0) scrollToCurrent();
    paint();
  }
  function step(dir) {
    if (matches.length === 0) return;
    cursor = (cursor + dir + matches.length) % matches.length;
    paint();
    scrollToCurrent();
    paint();
  }
  function clearFind() {
    matches = []; cursor = -1; query = '';
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CUR);
    }
  }
  function reply(reqId) {
    try {
      window.parent.postMessage({
        type: 'stashbase-find-result',
        reqId: reqId,
        current: cursor >= 0 ? cursor + 1 : 0,
        total: matches.length
      }, '*');
    } catch (_) {}
  }

  var HL_CHUNK = 'stashbase-chunk';
  var chunkHlTimer = null;
  function clearChunkHl() {
    if (chunkHlTimer) { clearTimeout(chunkHlTimer); chunkHlTimer = null; }
    if (window.CSS && CSS.highlights) CSS.highlights.delete(HL_CHUNK);
  }
  function normalizeChunkText(s) {
    return (s || '')
      .replace(/[‐-―−]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[  ​]/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  }
  function cleanChunkText(s) {
    var tick = String.fromCharCode(96);
    return normalizeChunkText(s)
      .replace(new RegExp(tick + tick + tick + '[\\\\s\\\\S]*?' + tick + tick + tick, 'g'), ' ')
      .replace(new RegExp(tick + '([^' + tick + ']+)' + tick, 'g'), '$1')
      .replace(/!\\[[^\\]]*\\]\\([^)]*\\)/g, ' ')
      .replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, '$1')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|\\s)[*_]([^\\s*_][^*_]*?)[*_](?=\\s|$|[.,;:])/g, '$1$2')
      .replace(/^#{1,6}\\s+/gm, '')
      .replace(/^>\\s+/gm, '')
      .replace(/\\s+/g, ' ')
      .trim();
  }
  function chunkAnchors(raw) {
    var cleaned = cleanChunkText(raw);
    if (!cleaned) return [];
    var slice = 80;
    var mid = Math.max(0, Math.floor(cleaned.length / 2) - Math.floor(slice / 2));
    var tail = Math.max(0, cleaned.length - slice);
    var minLen = Math.min(12, cleaned.length);
    var seen = {};
    return [cleaned.slice(0, slice), cleaned.slice(mid, mid + slice), cleaned.slice(tail)]
      .map(normalizeChunkText)
      .filter(function(anchor) {
        if (anchor.length < minLen || seen[anchor]) return false;
        seen[anchor] = true;
        return true;
      });
  }
  function charLengthAt(text, offset) {
    var code = text.charCodeAt(offset);
    return code >= 0xd800 && code <= 0xdbff && offset + 1 < text.length ? 2 : 1;
  }
  function flattenDocumentText() {
    var text = '';
    var points = [];
    var lastWasSpace = true;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        var t = n.parentElement && n.parentElement.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var raw = node.nodeValue || '';
      for (var offset = 0; offset < raw.length;) {
        var len = charLengthAt(raw, offset);
        var ch = raw.slice(offset, offset + len);
        if (/\\s/u.test(ch)) {
          if (!lastWasSpace) {
            text += ' ';
            points.push({ node: node, offset: offset });
            lastWasSpace = true;
          }
        } else {
          text += ch;
          points.push({ node: node, offset: offset });
          lastWasSpace = false;
        }
        offset += len;
      }
    }
    return { text: text.trim(), points: points };
  }
  function findTextRange(needle) {
    var anchors = chunkAnchors(needle);
    if (!anchors.length || !document.body) return null;
    var flat = flattenDocumentText();
    for (var i = 0; i < anchors.length; i++) {
      var idx = flat.text.indexOf(anchors[i]);
      if (idx < 0) continue;
      var start = flat.points[idx];
      var last = flat.points[idx + anchors[i].length - 1];
      if (!start || !last) continue;
      var r = document.createRange();
      try {
        r.setStart(start.node, start.offset);
        r.setEnd(last.node, last.offset + charLengthAt(last.node.nodeValue || '', last.offset));
        return r;
      } catch (_) {}
    }
    return null;
  }
  function highlightChunk(text) {
    clearChunkHl();
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return false;
    var range = findTextRange(text);
    if (!range) return false;
    try {
      CSS.highlights.set(HL_CHUNK, new Highlight(range));
    } catch (_) { return false; }
    // Use a probe so the smooth scroll lands centred even when the
    // match sits deep in a long block.
    var probe = document.createElement('span');
    probe.setAttribute('data-stashbase-chunk-probe', '1');
    try { range.insertNode(probe); probe.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (_) {}
    var parent = probe.parentNode;
    probe.remove();
    if (parent) parent.normalize();
    // Auto-fade after 4s — long enough to register the location,
    // short enough not to fight a follow-up find.
    chunkHlTimer = setTimeout(clearChunkHl, 4000);
    return true;
  }

  window.addEventListener('message', function(e) {
    if (!e || !e.data) return;
    var d = e.data;
    if (d.type === 'stashbase-scroll') {
      var el = document.getElementById(d.id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (d.type === 'stashbase-chunk-highlight') {
      var ok = highlightChunk(d.text || '');
      try {
        window.parent.postMessage({
          type: 'stashbase-chunk-highlight-result',
          reqId: d.reqId,
          ok: ok
        }, '*');
      } catch (_) {}
      return;
    }
    if (d.type === 'stashbase-find') {
      if (d.op === 'set') setQuery(d.query || '', d.wholeWord, d.caseSensitive);
      else if (d.op === 'next') step(1);
      else if (d.op === 'prev') step(-1);
      else if (d.op === 'close') clearFind();
      reply(d.reqId);
      return;
    }
  });

  // Cmd+F / Cmd+G inside the iframe → tell the parent so the find bar
  // opens (or steps) even when focus lives in the sandboxed document.
  document.addEventListener('keydown', function(e) {
    if (!(e.metaKey || e.ctrlKey)) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'f') {
      e.preventDefault();
      try { window.parent.postMessage({ type: 'stashbase-open-find' }, '*'); } catch (_) {}
    } else if (k === 'g') {
      e.preventDefault();
      try {
        window.parent.postMessage({
          type: 'stashbase-find-step',
          dir: e.shiftKey ? 'prev' : 'next'
        }, '*');
      } catch (_) {}
    }
  });
})();
document.addEventListener('click', function(e) {
  var node = e.target;
  while (node && node.tagName !== 'A' && node.tagName !== 'IMG') node = node.parentElement;
  if (!node) return;
  if (node.tagName === 'IMG') {
    var src = node.currentSrc || node.getAttribute('src');
    if (!src) return;
    try {
      e.preventDefault();
      window.parent.postMessage({
        type: 'stashbase-preview-image',
        src: new URL(src, document.baseURI).href,
        alt: node.getAttribute('alt') || ''
      }, '*');
    } catch (_) {}
    return;
  }
  var raw = node.getAttribute('href');
  if (!raw) return;
  if (raw.charAt(0) === '#') {
    var hashOnly = raw.slice(1);
    if (!hashOnly) return;
    try {
      if (location.pathname.indexOf('/asset/') === 0) {
        var currentEncoded = location.pathname.slice('/asset/'.length);
        if (currentEncoded.indexOf('__window/') === 0) {
          var currentWindowSlash = currentEncoded.indexOf('/', '__window/'.length);
          currentEncoded = currentWindowSlash >= 0 ? currentEncoded.slice(currentWindowSlash + 1) : '';
        }
        var currentDecoded = currentEncoded.split('/').map(decodeURIComponent).join('/');
        e.preventDefault();
        window.parent.postMessage({
          type: 'stashbase-nav',
          path: currentDecoded,
          anchor: hashOnly
        }, '*');
      }
    } catch (_) {}
    return;
  }
  try {
    var url = new URL(raw, document.baseURI);
    // Same-origin /asset/ links to .md / .html files = cross-file
    // navigation inside the folder. Hand off to the parent so the
    // back/forward stack records the jump.
    if (url.origin === location.origin && url.pathname.indexOf('/asset/') === 0) {
      var encoded = url.pathname.slice('/asset/'.length);
      if (encoded.indexOf('__window/') === 0) {
        var windowSlash = encoded.indexOf('/', '__window/'.length);
        encoded = windowSlash >= 0 ? encoded.slice(windowSlash + 1) : '';
      }
      var decoded;
      try {
        decoded = encoded.split('/').map(decodeURIComponent).join('/');
      } catch (_) { return; }
      if (/\\.(md|markdown|html|htm)$/i.test(decoded)) {
        e.preventDefault();
        var anchor = url.hash && url.hash.charAt(0) === '#' ? url.hash.slice(1) : '';
        window.parent.postMessage({
          type: 'stashbase-nav',
          path: decoded,
          anchor: anchor || undefined
        }, '*');
        return;
      }
      e.preventDefault();
      window.parent.postMessage({ type: 'stashbase-open-external', href: url.href }, '*');
      return;
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin) {
      e.preventDefault();
      window.parent.postMessage({ type: 'stashbase-open-external', href: url.href }, '*');
    }
  } catch (_) {}
});
</script>`;
  const idx = html.search(/<\/body\s*>/i);
  return idx >= 0 ? html.slice(0, idx) + script + html.slice(idx) : html + script;
}

function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|section|article|li|tr|h[1-6])\s*>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '));
}

/** Decode the HTML entities we care about for preview / chunking —
 *  the named-entity short list (`&nbsp;`, `&amp;`, …) plus numeric
 *  refs (`&#8217;`, `&#x2014;`). Not exhaustive (no `&hellip;`, no
 *  full HTML 5 named-entity table) but covers what arxiv / Wikipedia
 *  exports and hand-written notes use in practice. Exported so the
 *  files-layer preview can reuse it instead of carrying its own copy. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => {
      const code = Number.parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function collapseWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
