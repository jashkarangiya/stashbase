import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, type ViewUpdate, ViewPlugin, WidgetType } from '@codemirror/view';
import { sourceMatches, sourceMatchVersion } from './editorMatches';

type ConstructKind = 'heading' | 'emphasis' | 'strong' | 'strikethrough' | 'inline-code' | 'fenced-code' | 'horizontal-rule' | 'link' | 'list-item' | 'blockquote';

export type ProjectionRange = { from: number; to: number };

type Construct = {
  kind: ConstructKind;
  from: number;
  to: number;
  markers: ProjectionRange[];
  rule: ProjectionRule;
  level?: number;
  link?: LiveMarkdownLink;
};

type FencedCodeInfo = { code: string; language: string };

export type LiveMarkdownLink = {
  label: string;
  href: string;
};

type ProjectionRule = {
  kind: ConstructKind;
  nodeNames: readonly string[];
  markerNames: readonly string[];
  level?: (nodeName: string) => number | undefined;
  /** Class applied to every line the construct spans, giving block
   *  forms a stable full-width presentation independent of the
   *  active/inactive marker reveal. */
  lineClass?: string;
  sourceRanges?: (state: EditorState, construct: Construct) => ProjectionRange[];
  decorations: (construct: Construct, active: boolean) => Decoration[];
};

export type LiveMarkdownLinkActivation = (link: LiveMarkdownLink) => void;

export type LiveMarkdownProjection = Pick<Construct, 'kind' | 'from' | 'to'> & { active: boolean };

export type ProjectionOptions = {
  /** Parsed document ranges that are currently visible to the user. */
  ranges?: readonly ProjectionRange[];
  /** Ranges that must remain ordinary source, such as an IME composing line. */
  sourceFallbackRanges?: readonly ProjectionRange[];
};

/** Composition events do not themselves produce a CodeMirror update. This
 * state effect makes their lifecycle visible to the projection plugin. */
export const setLiveMarkdownComposition = StateEffect.define<boolean>();

const liveMarkdownCompositionState = StateField.define<boolean>({
  create: () => false,
  update: (composing, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setLiveMarkdownComposition)) return effect.value;
    }
    return composing;
  },
});

/** Install this beside the projection so composition start/end causes a
 * transaction even when the IME has not inserted any document text. */
export const liveMarkdownCompositionGuard = [
  liveMarkdownCompositionState,
  EditorView.domEventHandlers({
    compositionstart: (_event, view) => {
      view.dispatch({ effects: setLiveMarkdownComposition.of(true) });
      return false;
    },
    compositionend: (_event, view) => {
      view.dispatch({ effects: setLiveMarkdownComposition.of(false) });
      return false;
    },
  }),
];

const hiddenMarkdownMarkupDecoration = Decoration.replace({});
// View plugins may neither provide block decorations nor replace line breaks.
// A line decoration leaves the source range intact and projects the rule with
// CSS only, so it remains legal in the viewport-bounded projection.
const horizontalRuleDecoration = Decoration.line({ class: 'cm-live-horizontal-rule' });

/**
 * Rules are deliberately internal: Live Editing has one CodeMirror adapter,
 * but each supported syntax form owns its parser nodes, source ranges, and
 * inactive presentation in one place. New forms extend this registry instead
 * of scattering special cases through selection and decoration code.
 */
const projectionRules: readonly ProjectionRule[] = [
  {
    kind: 'link',
    nodeNames: ['Link'],
    markerNames: [],
    sourceRanges: (state, construct) => inlineLinkFor(state, construct) ? [{ from: construct.from, to: construct.to }] : [],
    decorations: () => [],
  },
  {
    kind: 'heading',
    nodeNames: ['ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6', 'SetextHeading1', 'SetextHeading2'],
    markerNames: ['HeaderMark'],
    level: (nodeName) => Number(nodeName.slice(-1)),
    sourceRanges: headingSourceRanges,
    decorations: (construct) => [Decoration.mark({
      class: `cm-live-heading cm-live-heading-${construct.level}`,
      attributes: { role: 'heading', 'aria-level': String(construct.level) },
    })],
  },
  {
    kind: 'emphasis',
    nodeNames: ['Emphasis'],
    markerNames: ['EmphasisMark'],
    decorations: () => [Decoration.mark({ class: 'cm-live-emphasis' })],
  },
  {
    kind: 'strong',
    nodeNames: ['StrongEmphasis'],
    markerNames: ['EmphasisMark'],
    decorations: () => [Decoration.mark({ class: 'cm-live-strong' })],
  },
  {
    kind: 'strikethrough',
    nodeNames: ['Strikethrough'],
    markerNames: ['StrikethroughMark'],
    decorations: () => [Decoration.mark({ class: 'cm-live-strikethrough' })],
  },
  {
    kind: 'inline-code',
    nodeNames: ['InlineCode'],
    markerNames: ['CodeMark'],
    decorations: () => [Decoration.mark({ class: 'cm-live-inline-code' })],
  },
  {
    // The block is presented as an inert monospace surface; entering it
    // reveals the concealed fences and language label as one construct.
    // The parser owns the boundaries, so backticks inside content and
    // unterminated fences never split a block. The label is never parsed
    // or executed — it is only concealed markup.
    kind: 'fenced-code',
    nodeNames: ['FencedCode'],
    markerNames: ['CodeMark', 'CodeInfo'],
    lineClass: 'cm-live-code-block',
    decorations: () => [],
  },
  {
    kind: 'horizontal-rule',
    nodeNames: ['HorizontalRule'],
    markerNames: [],
    decorations: (_construct, active) => active ? [] : [horizontalRuleDecoration],
  },
  {
    // A list item, rather than its containing list, owns its visible marker.
    // This keeps a nested branch readable while the current row is edited.
    kind: 'list-item',
    nodeNames: ['ListItem'],
    markerNames: ['ListMark', 'TaskMarker'],
    decorations: () => [],
  },
  {
    kind: 'blockquote',
    nodeNames: ['Blockquote'],
    markerNames: ['QuoteMark'],
    decorations: () => [],
  },
];

const ruleByNodeName = new Map(projectionRules.flatMap((rule) => rule.nodeNames.map((name) => [name, rule] as const)));

/** Returns source-tree constructs projected by Live Editing. This is the
 * test seam: source text, parser ranges, and editor selections stay authority. */
export function describeLiveMarkdownProjection(
  state: EditorState,
  options: ProjectionOptions = {},
): LiveMarkdownProjection[] {
  return collectConstructs(state, options.ranges)
    .filter((construct) => !intersectsAny(construct, options.sourceFallbackRanges))
    .filter((construct) => construct.kind !== 'link' || !!inlineLinkFor(state, construct))
    .map((construct) => {
      const marker = construct.kind === 'list-item' ? listItemMarker(state, construct) : null;
      return {
        kind: construct.kind,
        from: construct.from,
        to: construct.to,
        active: marker ? isSourceMarkerActive(state, marker) : isConstructActive(state, construct),
      };
    });
}

/** A selection-aware, syntax-tree-derived presentation layer. It adds no
 * document changes: malformed or unsupported Markdown has no recognized tree
 * node and stays ordinary editable source. */
export function createLiveMarkdownProjection(onLinkActivate: LiveMarkdownLinkActivation) {
  return ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private composing = false;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view, onLinkActivate);
  }

  update(update: ViewUpdate) {
    const composing = isLiveMarkdownComposition(update.view);
    if (composing) {
      // Keep the composition surface as ordinary source from compositionstart
      // through compositionend. In particular, no replacement widget can be
      // rebuilt inside the browser-owned IME DOM during that interval.
      this.decorations = Decoration.none;
      this.composing = true;
      return;
    }
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    const searchChanged = sourceMatchVersion(update.startState) !== sourceMatchVersion(update.state);
    if (this.composing || shouldRefreshLiveMarkdownProjection({
      docChanged: update.docChanged,
      selectionSet: update.selectionSet,
      viewportChanged: update.viewportChanged,
      treeChanged,
      searchChanged,
    })) {
      this.decorations = buildDecorations(update.view, onLinkActivate);
    }
    this.composing = false;
  }
  }, {
    decorations: (value) => value.decorations,
  });
}

/** The default projection is kept for test and non-interactive callers. */
export const liveMarkdownProjection = createLiveMarkdownProjection(() => {});

export function toggleMarkdownStrong(view: EditorView): boolean {
  return toggleMarkdownDelimiter(view, '**', 'StrongEmphasis');
}

export function toggleMarkdownEmphasis(view: EditorView): boolean {
  return toggleMarkdownDelimiter(view, '*', 'Emphasis');
}

/** Cmd/Ctrl+K is deliberately source-first: selection wrapping inserts a
 * writable destination, an existing link selects its destination, and an
 * empty cursor receives paired syntax with a writable label. */
export function toggleMarkdownLink(view: EditorView): boolean {
  const selection = view.state.selection.main;
  const existing = enclosingConstruct(view.state, 'Link', selection.from, selection.to);
  if (existing) {
    const target = linkTargetRange(view.state, existing);
    if (target) {
      view.dispatch({ selection: { anchor: target.from, head: target.to } });
      return true;
    }
  }
  if (selection.empty) {
    const inserted = '[link text](url)';
    view.dispatch({
      changes: { from: selection.from, insert: inserted },
      selection: { anchor: selection.from + 1, head: selection.from + 'link text'.length + 1 },
    });
    return true;
  }
  const selected = view.state.sliceDoc(selection.from, selection.to);
  const inserted = `[${selected}](url)`;
  const targetFrom = selection.from + inserted.length - 'url)'.length;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: inserted },
    selection: { anchor: targetFrom, head: targetFrom + 3 },
  });
  return true;
}

/** The explicit state effect covers the start/end events, while the view flag
 * covers a composition already in progress before an event is observed. */
export function isLiveMarkdownComposition(view: Pick<EditorView, 'compositionStarted' | 'state'>): boolean {
  return view.state.field(liveMarkdownCompositionState, false) || view.compositionStarted;
}

export function shouldRefreshLiveMarkdownProjection(change: {
  docChanged: boolean;
  selectionSet: boolean;
  viewportChanged: boolean;
  treeChanged: boolean;
  searchChanged?: boolean;
}): boolean {
  return change.docChanged || change.selectionSet || change.viewportChanged || change.treeChanged || !!change.searchChanged;
}

/** Source-first Markdown conveniences. A single backtick pairs inline code;
 * three typed at an otherwise empty line add the closing fence on the next line. */
export function completeMarkdownBacktick(view: EditorView, from: number, to: number, text: string): boolean {
  if (text !== '`') return false;
  // A fence being typed inside an existing block is its closing delimiter,
  // not a request to open a nested block. Let CodeMirror insert each tick
  // normally so the closing fence remains ordinary Markdown source.
  if (enclosingConstruct(view.state, 'FencedCode', from, to)) return false;
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const before = view.state.sliceDoc(line.from, from);
  const after = view.state.sliceDoc(to, line.to);
  if (from === to && before === '``' && after === '') {
    const start = from - 2;
    view.dispatch({
      changes: { from: start, to, insert: '```\n```' },
      // Put the cursor directly after the opening fence so the next text is
      // its language label (for example, ```ts) before the code body starts.
      selection: { anchor: start + 3 },
      userEvent: 'input.type',
    });
    return true;
  }
  // Leave the first two fence characters untouched so the third can expand
  // them into a complete block rather than producing an inline pair.
  if (from === to && before === '`' && after === '') return false;
  if (from === to && view.state.sliceDoc(from, from + 1) === '`') {
    view.dispatch({ selection: { anchor: from + 1 }, userEvent: 'input.type' });
    return true;
  }
  if (!selection.empty) {
    const selected = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: `\`${selected}\`` },
      selection: { anchor: from + 1, head: from + 1 + selected.length },
      userEvent: 'input.type',
    });
    return true;
  }
  view.dispatch({ changes: { from, to, insert: '``' }, selection: { anchor: from + 1 }, userEvent: 'input.type' });
  return true;
}

type ListPrefix = {
  indent: string;
  marker: string;
  spacing: string;
  task: boolean;
  taskLength: number;
  content: string;
};

/** Enter is a list-item transform, not a source-line regex convenience. The
 * parser establishes that the cursor is in a real list before we preserve its
 * marker form, branch indentation, and one-step undo boundary. */
export function continueMarkdownListItem(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (selection.from !== selection.to) return false;
  const item = listItemAt(view.state, selection.from);
  if (!item) return false;
  const line = view.state.doc.lineAt(selection.from);
  const prefix = listPrefix(view.state.sliceDoc(line.from, line.to));
  if (!prefix) return false;
  const after = view.state.sliceDoc(selection.from, line.to);
  if (prefix.content !== '') {
    if (selection.from === listContentStart(line.from, prefix)) {
      // A writer can turn a newly-created item back into prose without
      // retaining a Markdown indentation that would keep it in the list.
      view.dispatch({
        changes: {
          from: line.from,
          to: selection.from,
          insert: '',
        },
        selection: { anchor: line.from },
        userEvent: 'input.type',
      });
      return true;
    }
    const next = `${prefix.indent}${nextListMarker(prefix)}${prefix.spacing}${prefix.task ? '[ ] ' : ''}`;
    view.dispatch({
      changes: { from: selection.from, to: line.to, insert: `\n${next}${after}` },
      selection: { anchor: selection.from + 1 + next.length },
      userEvent: 'input.type',
    });
    return true;
  }

  const parent = parentListPrefix(view.state, line.number, prefix.indent);
  if (parent) {
    const next = `${parent.indent}${nextListMarker(parent)}${parent.spacing}${parent.task ? '[ ] ' : ''}`;
    const descendants = dedentListBranch(view.state.sliceDoc(line.to, item.to), prefix.indent);
    view.dispatch({
      changes: { from: line.from, to: item.to, insert: `${next}${descendants}` },
      selection: { anchor: line.from + next.length },
      userEvent: 'input.type',
    });
  } else {
    const descendants = view.state.sliceDoc(line.to + (line.to < item.to ? 1 : 0), item.to);
    view.dispatch({
      // Removing a root item must promote its branch as a branch, rather than
      // leaving its children indented beneath a marker that no longer exists.
      changes: { from: line.from, to: item.to, insert: dedentListBranchToRoot(descendants) },
      selection: { anchor: line.from },
      userEvent: 'input.type',
    });
  }
  return true;
}

export function continueMarkdownStructure(view: EditorView): boolean {
  return continueMarkdownListItem(view) || continueMarkdownBlockquote(view);
}

/** Continue one parser-recognized quote line. An empty quote drops a single
 * nesting level, preserving the outer quote when there is one. */
export function continueMarkdownBlockquote(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (selection.from !== selection.to || !enclosingConstruct(view.state, 'Blockquote', selection.from, selection.from)) return false;
  const line = view.state.doc.lineAt(selection.from);
  const source = view.state.sliceDoc(line.from, line.to);
  const quote = /^(\s*(?:>\s*)+)(.*)$/.exec(source);
  if (!quote) return false;
  const [, prefix, content] = quote;
  if (content !== '') {
    const after = view.state.sliceDoc(selection.from, line.to);
    view.dispatch({
      changes: { from: selection.from, to: line.to, insert: `\n${prefix}${after}` },
      selection: { anchor: selection.from + 1 + prefix.length },
      userEvent: 'input.type',
    });
  } else {
    const outerPrefix = prefix.replace(/>\s*$/, '');
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: outerPrefix },
      selection: { anchor: line.from + outerPrefix.length },
      userEvent: 'input.type',
    });
  }
  return true;
}

/** Indent/outdent the current list-item branch. Every source line in the
 * parser-owned item moves together, so children cannot be detached from their
 * parent by a Tab press. Outside a list we return false and do not trap focus. */
export function indentMarkdownListItem(view: EditorView, outdent = false): boolean {
  const items = selectedListItems(view.state);
  if (!items.length) return false;
  const changes: Array<{ from: number; to?: number; insert?: string }> = [];
  for (const item of items) {
    const firstLine = view.state.doc.lineAt(item.from);
    const prefix = listPrefix(view.state.sliceDoc(firstLine.from, firstLine.to));
    if (!prefix) return false;
    if (!outdent && !hasPreviousListSibling(view.state, firstLine.number, prefix.indent)) return false;
    const unit = indentationUnit(prefix.indent);
    if (outdent && !prefix.indent) continue;
    for (let number = firstLine.number; number <= view.state.doc.lineAt(item.to).number; number++) {
      const line = view.state.doc.line(number);
      if (outdent) {
        const removable = line.text.startsWith('\t') ? '\t' : line.text.match(/^ {1,2}/)?.[0];
        if (removable) changes.push({ from: line.from, to: line.from + removable.length });
      } else {
        changes.push({ from: line.from, insert: unit });
      }
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: 'input.indent' });
  return true;
}

function hasPreviousListSibling(state: EditorState, beforeLine: number, indent: string) {
  for (let number = beforeLine - 1; number >= 1; number--) {
    const prefix = listPrefix(state.doc.line(number).text);
    if (!prefix) continue;
    if (prefix.indent === indent) return true;
    if (prefix.indent.length < indent.length) return false;
  }
  return false;
}

/** Shift+Enter keeps a continuation paragraph in the same list item. */
export function continueMarkdownListLine(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (selection.from !== selection.to || !listItemAt(view.state, selection.from)) return false;
  const line = view.state.doc.lineAt(selection.from);
  const prefix = listPrefix(view.state.sliceDoc(line.from, line.to));
  if (!prefix) return false;
  const after = view.state.sliceDoc(selection.from, line.to);
  const indent = `${prefix.indent}${' '.repeat(prefix.marker.length + prefix.spacing.length + (prefix.task ? 4 : 0))}`;
  view.dispatch({
    changes: { from: selection.from, to: line.to, insert: `\n${indent}${after}` },
    selection: { anchor: selection.from + 1 + indent.length },
    userEvent: 'input.type',
  });
  return true;
}

function listPrefix(source: string): ListPrefix | null {
  const match = /^(\s*)([-+*]|\d+[.)])(\s+)(\[(?: |x|X)\]\s*)?(.*)$/.exec(source);
  if (!match) return null;
  const [, indent, marker, spacing, task = '', content] = match;
  return { indent, marker, spacing, task: !!task, taskLength: task.length, content };
}

function listContentStart(lineFrom: number, prefix: ListPrefix) {
  return lineFrom + prefix.indent.length + prefix.marker.length + prefix.spacing.length + prefix.taskLength;
}

function nextListMarker(prefix: ListPrefix) {
  const ordered = /^(\d+)([.)])$/.exec(prefix.marker);
  if (!ordered) return prefix.marker;
  const [, number, delimiter] = ordered;
  return `${String(Number(number) + 1).padStart(number.length, '0')}${delimiter}`;
}

function parentListPrefix(state: EditorState, beforeLine: number, indent: string): ListPrefix | null {
  for (let number = beforeLine - 1; number >= 1; number--) {
    const prefix = listPrefix(state.doc.line(number).text);
    if (!prefix) continue;
    if (prefix.indent.length < indent.length) return prefix;
  }
  return null;
}

function dedentListBranch(source: string, indent: string) {
  if (!indent) return source;
  return source.split('\n').map((line, index) => index && line.startsWith(indent)
    ? line.slice(indent.length)
    : line).join('\n');
}

function dedentListBranchToRoot(source: string) {
  const firstContent = source.split('\n').find((line) => line.trim() !== '');
  const indent = firstContent?.match(/^[\t ]*/)?.[0] ?? '';
  if (!indent) return source;
  return source.split('\n').map((line) => line.startsWith(indent)
    ? line.slice(indent.length)
    : line).join('\n');
}

function indentationUnit(indent: string) {
  return indent.includes('\t') ? '\t' : '  ';
}

function listItemAt(state: EditorState, position: number): ProjectionRange | null {
  return enclosingConstruct(state, 'ListItem', position, position);
}

function selectedListItems(state: EditorState): ProjectionRange[] {
  const items = state.selection.ranges
    .map((selection) => listItemAt(state, selection.from))
    .filter((item): item is ProjectionRange => !!item)
    .sort((a, b) => a.from - b.from || b.to - a.to);
  return items.filter((item, index) => !items.slice(0, index).some((other) => other.from <= item.from && other.to >= item.to));
}

function buildDecorations(view: EditorView, onLinkActivate: LiveMarkdownLinkActivation): DecorationSet {
  const state = view.state;
  const markers: Array<{ from: number; to?: number; decoration: Decoration }> = [];
  const constructs = collectConstructs(state, view.visibleRanges);
  const inactiveLinks = constructs.filter((construct) => construct.kind === 'link'
    && !isConstructActive(state, construct)
    && inlineLinkFor(state, construct));
  for (const construct of constructs) {
    // A presented link replaces its full source range. Nested presentation
    // would make the source only partly visible when the link is activated.
    if (construct.kind !== 'link' && inactiveLinks.some((link) => link.from <= construct.from && link.to >= construct.to)) continue;
    const active = isConstructActive(state, construct);
    if (construct.kind === 'link') {
      const link = inlineLinkFor(state, construct);
      if (!active && link) {
        markers.push({
          from: construct.from,
          to: construct.to,
          decoration: Decoration.replace({ widget: new LiveLinkWidget(construct.from, construct.to, link, onLinkActivate) }),
        });
      }
      continue;
    }
    if (construct.kind === 'list-item') {
      const marker = listItemMarker(state, construct);
      if (!marker) continue;
      // A list owns a first-line hanging gutter as soon as the parser accepts
      // its marker (including an empty `- ` item). This is independent of
      // whether the marker is currently shown as source or as a bullet.
      const line = state.doc.lineAt(marker.from);
      markers.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({ class: 'cm-live-list-item' }),
      });
      // Ordered markers are already the readable Markdown presentation. Only
      // unordered bullets and task controls receive a replacement widget.
      if ((marker.unordered || marker.task) && !isSourceMarkerActive(state, marker)) {
        markers.push({
          from: marker.from,
          to: marker.to,
          decoration: Decoration.replace({ widget: new LiveListMarkerWidget(marker.task, marker.checked) }),
        });
      }
      continue;
    }
    if (construct.kind === 'blockquote') {
      for (const quoteMarker of construct.markers) {
        const line = state.doc.lineAt(quoteMarker.from);
        markers.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({ class: 'cm-live-blockquote' }),
        });
        if (!isMarkerLineActive(state, quoteMarker)) {
          const to = state.sliceDoc(quoteMarker.to, quoteMarker.to + 1) === ' ' ? quoteMarker.to + 1 : quoteMarker.to;
          markers.push({ from: quoteMarker.from, to, decoration: hiddenMarkdownMarkupDecoration });
        }
      }
      continue;
    }
    for (const decoration of construct.rule.decorations(construct, active)) {
      markers.push({
        // A parser node can begin after indentation, but a line decoration
        // must be anchored exactly at the line start.
        from: construct.kind === 'horizontal-rule'
          ? state.doc.lineAt(construct.from).from
          : construct.from,
        // Line decorations are anchored at a line start and may not cover
        // source text; all other construct decorations cover their range.
        ...(construct.kind === 'horizontal-rule' ? {} : { to: construct.to }),
        decoration,
      });
    }
    if (construct.rule.lineClass) {
      const firstLine = state.doc.lineAt(construct.from).from;
      const lastLine = state.doc.lineAt(construct.to).from;
      for (let pos = construct.from; pos <= construct.to;) {
        const line = state.doc.lineAt(pos);
        const lineDecoration = Decoration.line({
          class: [
            construct.rule.lineClass,
            line.from === firstLine ? 'cm-live-code-block-start' : '',
            line.from === lastLine ? 'cm-live-code-block-end' : '',
          ].filter(Boolean).join(' '),
        });
        markers.push({ from: line.from, to: line.from, decoration: lineDecoration });
        if (line.to >= construct.to) break;
        pos = line.to + 1;
      }
    }
    if (!active) {
      if (construct.kind === 'fenced-code') {
        const code = fencedCodeInfo(state, construct);
        const lineStart = state.doc.lineAt(construct.from).from;
        markers.push({
          from: lineStart,
          to: lineStart,
          decoration: Decoration.widget({ widget: new FencedCodeCopyWidget(code), side: 1 }),
        });
      }
      for (const marker of sourceRangesFor(state, construct)) {
        // ViewPlugin replacement decorations cannot span a line break. Setext
        // heading markers can include their leading newline, so conceal every
        // same-line slice independently instead of invalidating the editor.
        for (const segment of inlineDecorationRanges(state, marker)) {
          markers.push({ from: segment.from, to: segment.to, decoration: hiddenMarkdownMarkupDecoration });
        }
      }
    }
  }
  markers.sort((a, b) => a.from - b.from || (b.to ?? b.from) - (a.to ?? a.from));
  return Decoration.set(markers.map(({ from, to, decoration }) => decoration.range(from, to)), true);
}

type ListItemMarker = ProjectionRange & { unordered: boolean; task: boolean; checked: boolean };

function listItemMarker(state: EditorState, item: Construct): ListItemMarker | null {
  const list = item.markers.find((marker) => /^[-+*]|^\d+[.)]$/.test(state.sliceDoc(marker.from, marker.to)));
  if (!list) return null;
  const markerText = state.sliceDoc(list.from, list.to);
  const task = item.markers.find((marker) => /^\[(?: |x|X)\]$/.test(state.sliceDoc(marker.from, marker.to)));
  const markerTo = task?.to ?? list.to;
  return {
    from: list.from,
    // A normal bullet replaces only its source character. The existing space
    // remains in the document, so the dot occupies exactly the `-` position.
    to: task ? (state.sliceDoc(markerTo, markerTo + 1) === ' ' ? markerTo + 1 : markerTo) : markerTo,
    unordered: /^[-+*]$/.test(markerText),
    task: !!task,
    checked: !!task && /^\[[xX]\]$/.test(state.sliceDoc(task.from, task.to)),
  };
}

function isMarkerLineActive(state: EditorState, marker: ProjectionRange) {
  const line = state.doc.lineAt(marker.from);
  return state.selection.ranges.some((selection) => {
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    return from <= line.to && to >= line.from;
  }) || sourceMatches(state).matches.some((match) => match.from < line.to && match.to > line.from);
}

function isSourceMarkerActive(state: EditorState, marker: ProjectionRange) {
  return state.selection.ranges.some((selection) => {
    if (selection.empty) return marker.from <= selection.from && selection.from < marker.to;
    return selection.from < marker.to && selection.to > marker.from;
  }) || sourceMatches(state).matches.some((match) => match.from < marker.to && match.to > marker.from);
}

class LiveListMarkerWidget extends WidgetType {
  constructor(private readonly task: boolean, private readonly checked: boolean) { super(); }

  eq(other: LiveListMarkerWidget) { return this.task === other.task && this.checked === other.checked; }

  toDOM() {
    if (this.task) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = this.checked;
      checkbox.disabled = true;
      checkbox.tabIndex = -1;
      return checkbox;
    }
    const marker = document.createElement('span');
    marker.className = 'cm-live-list-marker';
    marker.textContent = '•';
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }

  ignoreEvent() { return true; }
}

/** The Markdown parser owns these ranges, so copying does not depend on
 * brittle fence matching and never includes the concealed delimiters. */
function fencedCodeInfo(state: EditorState, construct: Construct): FencedCodeInfo {
  let code = '';
  let language = '';
  syntaxTree(state).iterate({
    from: construct.from,
    to: construct.to,
    enter: (node) => {
      if (node.name === 'CodeText') code = state.sliceDoc(node.from, node.to);
      if (node.name === 'CodeInfo') language = state.sliceDoc(node.from, node.to).trim();
    },
  });
  return { code, language };
}

class FencedCodeCopyWidget extends WidgetType {
  constructor(private readonly block: FencedCodeInfo) { super(); }

  eq(other: FencedCodeCopyWidget) {
    return this.block.code === other.block.code && this.block.language === other.block.language;
  }

  toDOM() {
    const button = document.createElement('button');
    const language = displayCodeLanguage(this.block.language);
    button.className = 'cm-live-code-copy';
    button.type = 'button';
    button.textContent = language;
    button.title = `Copy ${language} code`;
    button.setAttribute('aria-label', `Copy ${language} code block`);
    button.addEventListener('click', () => { void navigator.clipboard?.writeText(this.block.code); });
    return button;
  }

  ignoreEvent() { return true; }
}

function displayCodeLanguage(language: string): string {
  const labels: Record<string, string> = {
    ts: 'TypeScript', typescript: 'TypeScript', js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
    py: 'Python', python: 'Python', sh: 'Shell', shell: 'Shell', bash: 'Bash',
  };
  return labels[language.toLowerCase()] ?? (language || 'Code');
}

class LiveLinkWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly to: number,
    private readonly link: LiveMarkdownLink,
    private readonly onActivate: LiveMarkdownLinkActivation,
  ) { super(); }

  eq(other: LiveLinkWidget) {
    return this.from === other.from && this.to === other.to
      && this.link.label === other.link.label && this.link.href === other.link.href;
  }

  toDOM(view: EditorView) {
    const anchor = document.createElement('a');
    anchor.className = 'cm-live-link';
    anchor.href = this.link.href;
    anchor.textContent = this.link.label;
    anchor.setAttribute('aria-label', `Open link: ${this.link.label}`);
    const activate = (event: MouseEvent | KeyboardEvent) => {
      event.preventDefault();
      if ((event instanceof MouseEvent && (event.metaKey || event.ctrlKey || event.detail === 0)) || event instanceof KeyboardEvent) {
        this.onActivate(this.link);
        return;
      }
      view.dispatch({ selection: { anchor: this.from, head: this.to } });
      view.focus();
    };
    anchor.addEventListener('click', activate);
    anchor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
    return anchor;
  }

  /** The editor's pointer-down selection handler would otherwise reveal and
   * remove this widget before the subsequent Cmd/Ctrl click reaches the
   * anchor. The widget itself owns both reveal and follow interactions. */
  ignoreEvent() { return true; }
}

/** Returns source ranges that inactive constructs conceal. */
export function hiddenMarkdownMarkupRanges(state: EditorState, one?: Construct) {
  const constructs = one ? [one] : collectConstructs(state);
  return constructs
    .filter((construct) => !isConstructActive(state, construct))
    .flatMap((construct) => sourceRangesFor(state, construct));
}

function sourceRangesFor(state: EditorState, construct: Construct): ProjectionRange[] {
  return construct.rule.sourceRanges?.(state, construct) ?? construct.markers;
}

function inlineDecorationRanges(state: EditorState, range: ProjectionRange): ProjectionRange[] {
  const ranges: ProjectionRange[] = [];
  let from = range.from;
  for (let pos = range.from; pos < range.to; pos += 1) {
    if (state.sliceDoc(pos, pos + 1) !== '\n') continue;
    if (from < pos) ranges.push({ from, to: pos });
    from = pos + 1;
  }
  if (from < range.to) ranges.push({ from, to: range.to });
  return ranges;
}

function headingSourceRanges(state: EditorState, construct: Construct): ProjectionRange[] {
  const source = state.doc.toString();
  return construct.markers.map((marker) => {
    let { from, to } = marker;
    if (marker.from === construct.from) {
      while (to < construct.to && (source[to] === ' ' || source[to] === '\t')) to++;
    } else if (source[from - 1] === '\n') {
      from--;
    } else {
      while (from > construct.from && (source[from - 1] === ' ' || source[from - 1] === '\t')) from--;
    }
    return { from, to };
  });
}

function collectConstructs(state: EditorState, ranges?: readonly ProjectionRange[]): Construct[] {
  const constructs = new Map<string, Construct>();
  const parsedRanges = ranges === undefined ? [{ from: 0, to: state.doc.length }] : ranges;
  for (const range of parsedRanges) collectConstructsInRange(state, range, constructs);
  return [...constructs.values()].sort((a, b) => a.from - b.from || b.to - a.to);
}

function collectConstructsInRange(state: EditorState, range: ProjectionRange, constructs: Map<string, Construct>) {
  const stack: Construct[] = [];
  syntaxTree(state).iterate({
    from: range.from,
    to: range.to,
    enter(node) {
      const rule = ruleByNodeName.get(node.name);
      if (rule) {
        const key = `${rule.kind}:${node.from}:${node.to}`;
        let construct = constructs.get(key);
        if (!construct) {
          construct = {
            kind: rule.kind,
            from: node.from,
            to: node.to,
            rule,
            ...(rule.level ? { level: rule.level(node.name) } : {}),
            markers: [],
          };
          constructs.set(key, construct);
        }
        if (rule.kind === 'link') construct.link = inlineLinkFor(state, construct) ?? undefined;
        stack.push(construct);
        return;
      }
      const owner = [...stack].reverse().find((construct) => construct.rule.markerNames.includes(node.name));
      if (owner && !owner.markers.some((marker) => marker.from === node.from && marker.to === node.to)) {
        owner.markers.push({ from: node.from, to: node.to });
      }
    },
    leave(node) {
      if (ruleByNodeName.has(node.name)) stack.pop();
    },
  });
}

function inlineLinkFor(state: EditorState, construct: Construct): LiveMarkdownLink | null {
  const source = state.sliceDoc(construct.from, construct.to);
  const match = /^\[([^\]\n]+)\]\(([^()\s]+)\)$/.exec(source);
  if (!match) return null;
  const [, label, href] = match;
  return isSupportedLiveLinkTarget(href) ? { label, href } : null;
}

function isSupportedLiveLinkTarget(href: string) {
  if (href.startsWith('#') || /\.(md|markdown|html|htm)(?:#.*)?$/i.test(href)) return true;
  try {
    const url = new URL(href);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}

function linkTargetRange(state: EditorState, link: ProjectionRange): ProjectionRange | null {
  let target: ProjectionRange | null = null;
  syntaxTree(state).iterate({
    from: link.from,
    to: link.to,
    enter(node) {
      if (node.name === 'URL' && node.from >= link.from && node.to <= link.to) {
        target = { from: node.from, to: node.to };
      }
    },
  });
  return target;
}

function intersectsAny(construct: ProjectionRange, ranges: readonly ProjectionRange[] | undefined): boolean {
  return !!ranges?.some((range) => construct.from < range.to && construct.to > range.from);
}

function intersectsSelection(construct: Construct, from: number, to: number): boolean {
  if (from === to) return construct.from <= from && from <= construct.to;
  return construct.from < Math.max(from, to) && construct.to > Math.min(from, to);
}

function isConstructActive(state: EditorState, construct: Construct): boolean {
  return state.selection.ranges.some((range) => intersectsSelection(construct, range.from, range.to))
    || sourceMatches(state).matches.some((match) => match.from < construct.to && match.to > construct.from);
}

function toggleMarkdownDelimiter(view: EditorView, delimiter: string, nodeName: string): boolean {
  const selection = view.state.selection.main;
  const construct = enclosingConstruct(view.state, nodeName, selection.from, selection.to);
  const existingDelimiter = construct && delimiterForConstruct(view.state.doc.toString(), construct, delimiter);
  if (construct && existingDelimiter) {
    const contentFrom = construct.from + existingDelimiter.length;
    const contentTo = construct.to - existingDelimiter.length;
    view.dispatch({
      changes: [
        { from: contentTo, to: construct.to },
        { from: construct.from, to: contentFrom },
      ],
      selection: {
        anchor: clamp(selection.anchor - existingDelimiter.length, construct.from, contentTo - existingDelimiter.length),
        head: clamp(selection.head - existingDelimiter.length, construct.from, contentTo - existingDelimiter.length),
      },
    });
    return true;
  }
  if (selection.empty) {
    view.dispatch({ changes: { from: selection.from, insert: delimiter + delimiter }, selection: { anchor: selection.from + delimiter.length } });
  } else {
    view.dispatch({
      changes: [{ from: selection.to, insert: delimiter }, { from: selection.from, insert: delimiter }],
      selection: { anchor: selection.anchor + delimiter.length, head: selection.head + delimiter.length },
    });
  }
  return true;
}

function enclosingConstruct(state: EditorState, nodeName: string, from: number, to: number) {
  const candidates: ProjectionRange[] = [];
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== nodeName) return;
      const contains = start === end ? node.from <= start && start <= node.to : node.from <= start && node.to >= end;
      if (contains) candidates.push({ from: node.from, to: node.to });
    },
  });
  return candidates.sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] ?? null;
}

function delimiterForConstruct(source: string, construct: ProjectionRange, fallback: string) {
  const opening = source.slice(construct.from, construct.from + fallback.length);
  const closing = source.slice(construct.to - fallback.length, construct.to);
  const valid = fallback === '**' ? opening === '**' || opening === '__' : opening === '*' || opening === '_';
  return valid && opening === closing ? opening : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
