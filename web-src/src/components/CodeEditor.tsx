import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  indentOnInput,
} from '@codemirror/language';
import {
  searchKeymap,
  highlightSelectionMatches,
  search,
  setSearchQuery,
  getSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
} from '@codemirror/search';
import { markdown as mdLang, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import GithubSlugger from 'github-slugger';
import { useApp, type MatchInfo } from '../store/AppContext';
import {
  createLiveMarkdownProjection,
  liveMarkdownCompositionGuard,
  toggleMarkdownEmphasis,
  toggleMarkdownLink,
  toggleMarkdownStrong,
  type LiveMarkdownLink,
} from './liveMarkdown';

/**
 * CodeMirror 6 host. Mounts a CM EditorView into a div the first time,
 * destroys it on unmount, and registers `{ getValue, focus }` with the
 * store so the save / rename actions can read the live buffer without
 * prop-drilling refs around.
 *
 * Markdown is the only editable format, so the editor is md-only.
 * Editor identity is keyed by the tab plus its document generation, so
 * replacing a tab's file starts fresh while renames preserve its state.
 * Initial content is read once per document generation; CM owns it after.
 */
export function CodeEditor({
  tabId,
  sessionVersion,
  name,
  initialContent,
  onChange,
}: {
  tabId: string;
  sessionVersion: number;
  name: string;
  initialContent: string;
  onChange?: (doc: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { state, actions } = useApp();
  // A session survives renames, so interactive link navigation must read the
  // current path instead of the name captured when CodeMirror first mounted.
  const nameRef = useRef(name);
  nameRef.current = name;
  // Snapshot at mount time: if a rename is in progress (newNote starts
  // edit-mode AND rename together), let the RenameInput keep focus —
  // grabbing it here would blur the input, fire its onBlur commit,
  // and tear down the rename UI before the user can type a name.
  const renamingAtMountRef = useRef(state.renaming != null);
  renamingAtMountRef.current = state.renaming != null;
  // Track rename transition so we can pull focus back to the editor
  // when the user finishes (Enter) or cancels (Esc) — completes the
  // newNote → name it → start typing flow without a manual click.
  const prevRenamingRef = useRef(state.renaming != null);
  // Stable callbacks accessed from inside the CM updateListener (which
  // captures whatever's current at mount time). Refs side-step that.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const lang = mdLang({ base: markdownLanguage, addKeymap: false });
    // Strip CM's built-in Cmd-F binding — we route Cmd+F to our own
    // FindBar component instead. Cmd-G / Shift-Cmd-G (find next/prev)
    // stay so the bar's hotkeys still work when focus is in the editor.
    const editorSearchKeymap = searchKeymap.filter((b) => b.key !== 'Mod-f');
    const writingKeymap = [
      { key: 'Mod-b', run: toggleMarkdownStrong },
      { key: 'Mod-i', run: toggleMarkdownEmphasis },
      { key: 'Mod-k', run: toggleMarkdownLink },
    ];
    const extensions = [
      history(),
      bracketMatching(),
      indentOnInput(),
      EditorView.lineWrapping,
      liveMarkdownCompositionGuard,
      createLiveMarkdownProjection((link) => followLiveMarkdownLink(link, nameRef.current, actions.navigateTo)),
      highlightSelectionMatches(),
      // search() owns the SearchQuery state + match decorations even
      // though we never call openSearchPanel — our FindBar drives it
      // imperatively via setSearchQuery / findNext / findPrevious.
      search(),
      keymap.of([indentWithTab, ...writingKeymap, ...defaultKeymap, ...historyKeymap, ...editorSearchKeymap]),
      EditorView.theme({
        '&': { height: '100%', fontSize: '16px' },
        '.cm-scroller': {
          fontFamily:
            'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          lineHeight: '1.7',
        },
        '.cm-line': {
          overflowWrap: 'anywhere',
        },
        '.cm-content': { maxWidth: '820px', width: '100%', margin: '0 auto', padding: '32px 56px 80px' },
        '.cm-live-heading': { fontWeight: '700', lineHeight: '1.25' },
        '.cm-live-heading-1': { fontSize: '2em' },
        '.cm-live-heading-2': { fontSize: '1.5em' },
        '.cm-live-heading-3': { fontSize: '1.25em' },
        '.cm-live-heading-4, .cm-live-heading-5, .cm-live-heading-6': { fontSize: '1.1em' },
        '.cm-live-emphasis': { fontStyle: 'italic' },
        '.cm-live-strong': { fontWeight: '700' },
        '.cm-live-inline-code': {
          fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
          fontSize: '0.9em',
          backgroundColor: 'rgba(175, 184, 193, 0.2)',
          borderRadius: '4px',
          padding: '0.1em 0.25em',
        },
        '.cm-live-code-block': {
          fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
          fontSize: '0.9em',
          backgroundColor: 'rgba(175, 184, 193, 0.16)',
        },
        '.cm-live-strikethrough': { textDecoration: 'line-through' },
        '.cm-live-link': {
          color: '#0e7490',
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationColor: 'rgba(14, 116, 144, 0.5)',
        },
        '.cm-live-link:focus-visible': { outline: '2px solid #0e7490', outlineOffset: '2px', borderRadius: '2px' },
        '.cm-live-horizontal-rule': { border: '0', borderTop: '1px solid #d0d7de', margin: '1.25em 0', width: '100%' },
      }),
      lang,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
      }),
    ];

    const session = actions.getEditorSession(tabId);
    const savedSession = session?.version === sessionVersion ? session : undefined;
    const view = new EditorView({
      state: savedSession?.state ?? EditorState.create({ doc: initialContent, extensions }),
      parent: host,
    });
    if (savedSession) {
      view.scrollDOM.scrollTop = savedSession.scrollTop;
      view.scrollDOM.scrollLeft = savedSession.scrollLeft;
    }
    viewRef.current = view;
    actions.registerEditor({
      getValue: () => view.state.doc.toString(),
      focus: () => view.focus(),
    });
    actions.registerFindController({
      setQuery: (q, opts) => applyEditorQuery(view, q, opts.wholeWord, opts.caseSensitive),
      restoreQuery: (q, opts) => applyEditorQuery(view, q, opts.wholeWord, opts.caseSensitive, false),
      next: () => { findNext(view); return matchInfoFor(view); },
      prev: () => { findPrevious(view); return matchInfoFor(view); },
      close: () => {
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
      },
    });
    if (!renamingAtMountRef.current) view.focus();

    return () => {
      actions.setEditorSession(tabId, {
        version: sessionVersion,
        state: view.state,
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
      });
      actions.registerFindController(null);
      actions.registerEditor(null);
      view.destroy();
      viewRef.current = null;
    };
  // Mount once per document generation; initialContent and onChange are captured via
  // refs so they don't trigger re-mounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionVersion, tabId]);

  // Re-focus the editor when an inline rename ends (commit or cancel).
  useEffect(() => {
    const isRenaming = state.renaming != null;
    if (prevRenamingRef.current && !isRenaming) {
      viewRef.current?.focus();
    }
    prevRenamingRef.current = isRenaming;
  }, [state.renaming]);

  // Chunk-highlight after a SearchHit click. We pick the line range
  // (1-based) from pendingHighlight, then dispatch a scroll + select
  // so the chunk visibly highlights via the selection background.
  // Sufficient for V1; a fading line decoration is V2.
  const pendingHighlight = state.tabs.find((t) => t.id === state.activeTabId)?.pendingHighlight ?? null;
  useEffect(() => {
    if (!pendingHighlight?.startLine) return;
    const view = viewRef.current;
    if (!view) return;
    const startLine = Math.max(1, Math.min(view.state.doc.lines, pendingHighlight.startLine));
    const endLine = Math.max(startLine, Math.min(view.state.doc.lines, pendingHighlight.endLine ?? startLine));
    const from = view.state.doc.line(startLine).from;
    const to = view.state.doc.line(endLine).to;
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    actions.consumePendingHighlight();
  }, [pendingHighlight, actions]);

  const pendingAnchor = state.tabs.find((t) => t.id === state.activeTabId)?.pendingAnchor ?? null;
  useEffect(() => {
    if (!pendingAnchor) return;
    const view = viewRef.current;
    if (!view) return;
    let retryTimer: number | undefined;
    let cancelled = false;
    const scrollToAnchor = () => {
      const result = resolveLiveHeadingPosition(view.state, pendingAnchor);
      if (!result.ready) {
        // CodeMirror intentionally parses outside the viewport in the
        // background. Keep the app-owned anchor until that parse can cover
        // the whole document rather than treating an unseen heading as absent.
        retryTimer = window.setTimeout(scrollToAnchor, 50);
        return;
      }
      if (cancelled) return;
      if (result.position != null) {
        view.dispatch({ effects: EditorView.scrollIntoView(result.position, { y: 'start', yMargin: 24 }) });
      }
      // A missing heading is consumed only after the complete source has been
      // checked, so an invalid anchor cannot retry forever.
      actions.consumePendingScroll();
    };
    scrollToAnchor();
    return () => {
      cancelled = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, [pendingAnchor, actions]);

  return <div ref={hostRef} style={{ height: '100%' }} />;
}

/** Push a new SearchQuery and, for an interactive query, land selection on
 * the first match at or after the current cursor. Restored sessions keep
 * their saved selection while regaining query decorations and match counts. */
export function applyEditorQuery(
  view: EditorView,
  q: string,
  wholeWord: boolean,
  caseSensitive: boolean,
  selectMatch = true,
): MatchInfo {
  const query = new SearchQuery({
    search: q,
    caseSensitive,
    regexp: false,
    wholeWord,
  });
  view.dispatch({ effects: setSearchQuery.of(query) });
  if (selectMatch && q && query.valid) findNext(view);
  return matchInfoFor(view);
}

/** Compute "current of total" by iterating the search cursor across the
 *  full document. Linear in match count — fine for a single doc; the
 *  iterator is the canonical way to count matches in CM6 since
 *  decorations don't expose a count API. */
function matchInfoFor(view: EditorView): MatchInfo {
  const q = getSearchQuery(view.state);
  if (!q.search || !q.valid) return { current: 0, total: 0 };
  const sel = view.state.selection.main;
  const cursor = q.getCursor(view.state) as Iterator<{ from: number; to: number }>;
  let total = 0;
  let current = 0;
  while (true) {
    const r = cursor.next();
    if (r.done) break;
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
  }
  return { current, total };
}

/** Dispatches through the same app navigation and system-browser boundaries
 * used by Reading View. The projection only calls this for supported targets. */
export function followLiveMarkdownLink(
  link: LiveMarkdownLink,
  currentPath: string,
  navigateTo: (path: string, anchor?: string) => Promise<void>,
) {
  if (/^https?:\/\//i.test(link.href)) {
    const bridge = (window as { electron?: { openExternal?: (url: string) => Promise<boolean> } }).electron;
    if (bridge?.openExternal) void bridge.openExternal(link.href);
    else window.open(link.href, '_blank', 'noopener,noreferrer');
    return;
  }
  const [pathPart, fragment = ''] = link.href.split('#', 2);
  const path = pathPart ? resolveNotePath(currentPath, pathPart) : currentPath;
  const anchor = decodeLinkComponent(fragment);
  if (path && anchor != null) void navigateTo(path, anchor || undefined);
}

/** Mirrors Reading View's GitHub-style generated heading IDs so internal
 * Live Editing links can scroll without serializing or changing source. */
export function liveHeadingPosition(state: EditorState, anchor: string): number | null {
  return resolveLiveHeadingPosition(state, anchor).position;
}

function resolveLiveHeadingPosition(state: EditorState, anchor: string): { ready: boolean; position: number | null } {
  // `syntaxTree` is permitted to be viewport-only. Anchor navigation instead
  // needs a complete tree so an off-screen heading is distinguishable from a
  // missing one. The bounded parse keeps this work responsive; the effect
  // above retries until the background parser catches up.
  const tree = ensureSyntaxTree(state, state.doc.length, 20);
  if (!tree) return { ready: false, position: null };
  const slugger = new GithubSlugger();
  let position: number | null = null;
  tree.iterate({
    enter(node) {
      if (!/^((ATX|Setext)Heading[1-6])$/.test(node.name) || position != null) return;
      const heading = liveHeadingText(state.sliceDoc(node.from, node.to));
      if (slugger.slug(heading.toLowerCase()) === anchor) position = node.from;
    },
  });
  return { ready: true, position };
}

function liveHeadingText(source: string) {
  const firstLine = source.split('\n')[0]
    .replace(/^ {0,3}#{1,6}[ \t]*/, '')
    .replace(/[ \t]+#+[ \t]*$/, '');
  // Reading View generates IDs from rendered heading text. Remove inline
  // destinations and tags first, so e.g. `[Guide](note.md)` and `Guide`
  // share `#guide`, without pulling the full preview renderer into the editor.
  return decodeHeadingEntities(firstLine
    .replace(/!\[[^\]\n]*\]\([^\n)]*\)/g, '')
    .replace(/\[([^\]\n]*)\]\([^\n)]*\)/g, '$1')
    .replace(/\[([^\]\n]*)\]\[[^\]\n]*\]/g, '$1')
    .replace(/<[^>]*>/g, '')).trim();
}

function decodeHeadingEntities(html: string) {
  return html.replace(/&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/ig, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'colon') return ':';
    if (normalized.startsWith('#x')) return String.fromCharCode(parseInt(normalized.slice(2), 16));
    if (normalized.startsWith('#')) return String.fromCharCode(Number(normalized.slice(1)));
    return '';
  });
}

function resolveNotePath(currentPath: string, href: string) {
  const parts = currentPath.split('/').slice(0, -1);
  for (const rawSegment of href.split('/')) {
    const segment = decodeLinkComponent(rawSegment);
    if (segment == null || segment.includes('/') || segment.includes('\\')) return null;
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** Markdown destinations are URLs: decode percent-encoded filenames only
 * after splitting path segments, never before. */
function decodeLinkComponent(value: string) {
  try { return decodeURIComponent(value); } catch { return null; }
}
