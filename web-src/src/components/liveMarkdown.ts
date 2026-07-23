import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, type ViewUpdate, ViewPlugin, WidgetType } from '@codemirror/view';
import { sourceMatches, sourceMatchVersion } from './editorMatches';

type ConstructKind = 'heading' | 'emphasis' | 'strong' | 'strikethrough' | 'inline-code' | 'fenced-code' | 'horizontal-rule' | 'link';

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
    .map((construct) => ({
      kind: construct.kind,
      from: construct.from,
      to: construct.to,
      active: isConstructActive(state, construct),
    }));
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
      const lineDecoration = Decoration.line({ class: construct.rule.lineClass });
      for (let pos = construct.from; pos <= construct.to;) {
        const line = state.doc.lineAt(pos);
        markers.push({ from: line.from, to: line.from, decoration: lineDecoration });
        if (line.to >= construct.to) break;
        pos = line.to + 1;
      }
    }
    if (!active) {
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
