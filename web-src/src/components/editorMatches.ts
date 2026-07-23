import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

export type SourceMatch = { from: number; to: number };
export type SourceMatchMode = 'find' | 'selection' | null;

export type SourceMatchSet = {
  mode: SourceMatchMode;
  matches: readonly SourceMatch[];
  activeIndex: number;
};

type StoredSourceMatchSet = SourceMatchSet & { findQuery: SearchQuery | null };

const emptyMatchSet: StoredSourceMatchSet = { mode: null, matches: [], activeIndex: -1, findQuery: null };

/** The app owns Find UI, so this distinguishes an explicit Find query from
 * CodeMirror's selection-derived default query. */
export const setSourceFindQuery = StateEffect.define<SearchQuery | null>();

/** One source-level match model for both the Find bar and ordinary text
 * selection. Consumers use it for navigation, Markdown projection reveal,
 * and visible decorations instead of independently re-searching the buffer. */
export const sourceMatchState = StateField.define<StoredSourceMatchSet>({
  create: (state) => buildSourceMatchSet(state, null),
  update: (value, transaction) => {
    let findQuery = value.findQuery;
    for (const effect of transaction.effects) {
      if (effect.is(setSourceFindQuery)) findQuery = effect.value;
    }
    const queryChanged = findQuery !== value.findQuery;
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    return transaction.docChanged || queryChanged || selectionChanged
      ? buildSourceMatchSet(transaction.state, findQuery)
      : value;
  },
});

export function sourceMatches(state: EditorState): SourceMatchSet {
  const matchSet = state.field(sourceMatchState, false) ?? buildSourceMatchSet(state, null);
  return { mode: matchSet.mode, matches: matchSet.matches, activeIndex: matchSet.activeIndex };
}

/** Identity changes whenever the cached source match list changes. */
export function sourceMatchVersion(state: EditorState): StoredSourceMatchSet | null {
  return state.field(sourceMatchState, false) ?? null;
}

/** Highlights are intentionally a single plugin. Find paints every result
 * yellow and its active result blue; selection paints peer occurrences green
 * and leaves the real selected text to CodeMirror's native selection color. */
export const sourceMatchHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = sourceMatchDecorations(view);
  }

  update(update: ViewUpdate) {
    const matchesChanged = sourceMatchVersion(update.startState) !== sourceMatchVersion(update.state);
    if (update.docChanged || update.selectionSet || update.viewportChanged || matchesChanged) {
      this.decorations = sourceMatchDecorations(update.view);
    }
  }
}, {
  decorations: (value) => value.decorations,
});

const findMatchDecoration = Decoration.mark({ class: 'cm-source-match cm-source-find-match' });
const activeFindMatchDecoration = Decoration.mark({ class: 'cm-source-match cm-source-find-match-active' });
const selectionMatchDecoration = Decoration.mark({ class: 'cm-source-match cm-source-selection-match' });

function buildSourceMatchSet(state: EditorState, findQuery: SearchQuery | null): StoredSourceMatchSet {
  if (findQuery?.valid) return matchSetFor(state, findQuery, 'find', findQuery);

  const selection = state.selection.main;
  if (selection.empty) return { ...emptyMatchSet, findQuery };
  const selected = state.sliceDoc(selection.from, selection.to);
  if (!selected.trim() || selected.includes('\n')) return { ...emptyMatchSet, findQuery };
  // Selection matching follows the document Find default. This makes a
  // selected `footnote` include a heading written as `Footnote`.
  return matchSetFor(state, new SearchQuery({ search: selected, caseSensitive: false, literal: true }), 'selection', findQuery);
}

function matchSetFor(state: EditorState, query: SearchQuery, mode: Exclude<SourceMatchMode, null>, findQuery: SearchQuery | null): StoredSourceMatchSet {
  const matches: SourceMatch[] = [];
  const cursor = query.getCursor(state);
  while (true) {
    const match = cursor.next();
    if (match.done) break;
    matches.push({ from: match.value.from, to: match.value.to });
  }
  const selection = state.selection.main;
  const activeIndex = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
  return { mode, matches, activeIndex, findQuery };
}

function sourceMatchDecorations(view: EditorView): DecorationSet {
  const matchSet = sourceMatches(view.state);
  if (!matchSet.mode) return Decoration.none;
  const visible = (match: SourceMatch) => view.visibleRanges.some((range) => match.from < range.to && match.to > range.from);
  const decorations = matchSet.matches
    .filter(visible)
    .flatMap((match, index) => {
      if (matchSet.mode === 'selection' && index === matchSet.activeIndex) return [];
      const decoration = matchSet.mode === 'find' && index === matchSet.activeIndex
        ? activeFindMatchDecoration
        : matchSet.mode === 'find' ? findMatchDecoration : selectionMatchDecoration;
      return [decoration.range(match.from, match.to)];
    });
  return Decoration.set(decorations, true);
}
