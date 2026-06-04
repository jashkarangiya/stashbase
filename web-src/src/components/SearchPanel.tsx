import { useEffect, useRef, type ReactNode } from 'react';
import type { KeywordHitFile, KeywordMatch, SearchHit } from '../api';
import { useApp } from '../store/AppContext';

/**
 * The "search" sidebar view — owns the search input, the mode toggle
 * (≈ ↔ =) with conditional `Aa` / `ab` sub-filters when in keyword
 * mode, and the result list.
 *
 * Empty query → empty body (no "Recent searches" prompt yet — that's
 * deferred until we add a real history feature).
 *
 * This component is intentionally siblings with `FilesPanel`, switched
 * by `state.activeSidebarView` from the `Sidebar` wrapper. Splitting
 * search out of the files panel means the user no longer has to clear
 * the query to get the tree back — they just click the Files icon in
 * the activity bar.
 */
export function SearchPanel() {
  const { state } = useApp();
  const query = state.filterQuery.trim();
  return (
    <div className="search-panel" id="sidebar-panel-search" role="tabpanel">
      <SearchBox />
      <div className="search-panel-body">
        {query ? (
          <SearchResults query={query} />
        ) : (
          // Per design: nothing shown until the user starts typing.
          // The user has plenty of feedback from the input itself.
          null
        )}
      </div>
    </div>
  );
}

/** Input + ≈/= mode flip + (keyword-only) Aa / ab sub-toggles. The
 *  mode flip swaps the icon based on current mode so the button
 *  doubles as a state indicator. */
function SearchBox() {
  const { state, actions, dispatch } = useApp();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  // Hand the input handle to the store on mount so `actions.focusSearch`
  // can reach it without a global DOM query.
  useEffect(() => {
    actions.registerSearchInput(inputRef.current);
    return () => actions.registerSearchInput(null);
  }, [actions]);

  function onChange(value: string) {
    dispatch({ type: 'FILTER', q: value });
    if (debounce.current) clearTimeout(debounce.current);
    if (!value.trim()) {
      void actions.runSearch('');
      return;
    }
    debounce.current = setTimeout(() => { void actions.runSearch(value); }, 250);
  }

  function flipMode() {
    const next = state.searchMode === 'semantic' ? 'keyword' : 'semantic';
    dispatch({ type: 'SEARCH_MODE', mode: next });
    if (state.filterQuery.trim()) {
      void actions.runSearch(state.filterQuery, next);
    }
  }

  function toggleCaseStrict() {
    const next = !state.caseStrict;
    dispatch({ type: 'SEARCH_CASE_STRICT', strict: next });
    if (state.filterQuery.trim()) void actions.runSearch(state.filterQuery);
  }

  function toggleWholeWord() {
    const next = !state.wholeWord;
    dispatch({ type: 'SEARCH_WHOLE_WORD', on: next });
    if (state.filterQuery.trim()) void actions.runSearch(state.filterQuery);
  }

  const isKeyword = state.searchMode === 'keyword';

  return (
    <div className="side-search">
      {/* `type="text"` (not `search`) on purpose — we don't want the
       *  native cancel-X glyph crowding the toggle row on the right,
       *  and we don't want the native Esc-clears-input behaviour
       *  either; clearing happens by deleting characters or by
       *  flipping back to Files via the activity bar. */}
      <input
        ref={inputRef}
        type="text"
        placeholder="Search…"
        autoComplete="off"
        spellCheck={false}
        value={state.filterQuery}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="side-search-mode" role="group" aria-label="Search mode">
        {isKeyword && (
          <>
            <button
              type="button"
              className={'side-search-mode-btn' + (state.caseStrict ? ' active' : '')}
              onClick={toggleCaseStrict}
              aria-label="Match case"
              aria-pressed={state.caseStrict}
              title="Match Case"
            >
              Aa
            </button>
            <button
              type="button"
              className={'side-search-mode-btn ab-toggle' + (state.wholeWord ? ' active' : '')}
              onClick={toggleWholeWord}
              aria-label="Match whole word"
              aria-pressed={state.wholeWord}
              title="Match Whole Word"
            >
              ab
            </button>
          </>
        )}
        <button
          type="button"
          className="side-search-mode-btn side-search-mode-flip"
          onClick={flipMode}
          aria-label={isKeyword ? 'Switch to semantic search' : 'Switch to keyword search'}
          title={isKeyword ? 'Keyword search · click for semantic' : 'Semantic search · click for keyword'}
        >
          {isKeyword ? '=' : '≈'}
        </button>
      </div>
    </div>
  );
}

function SearchResults({ query }: { query: string }) {
  const { state } = useApp();
  // A real failure (server / daemon error) — distinct from "no matches".
  if (state.searchError) {
    return <div className="empty-list search-failed">Search failed: {state.searchError}</div>;
  }
  if (state.searchMode === 'keyword') {
    return <KeywordSearchResults query={query} />;
  }
  if (state.searching && state.searchHits === null) {
    return <div className="empty-list">Searching…</div>;
  }
  if (!state.searchHits || state.searchHits.length === 0) {
    return <div className="empty-list">No matches</div>;
  }
  return (
    <div className="search-hits">
      {state.searchHits.map((hit, i) => (
        <SearchHitRow key={`${hit.fileName}#${hit.chunkIndex}#${i}`} hit={hit} query={query} />
      ))}
    </div>
  );
}

function KeywordSearchResults({ query }: { query: string }) {
  const { state } = useApp();
  if (state.searching && state.keywordResult === null) {
    return <div className="empty-list">Searching…</div>;
  }
  const result = state.keywordResult;
  if (!result || result.files.length === 0) {
    return <div className="empty-list">No matches</div>;
  }
  return (
    <div className="search-hits keyword-hits">
      <div className="keyword-summary">
        {result.totalMatches} match{result.totalMatches === 1 ? '' : 'es'} in {result.files.length} file{result.files.length === 1 ? '' : 's'}
        {result.truncated && ' (truncated)'}
      </div>
      {result.files.map((file) => (
        <KeywordFileGroup key={file.path} file={file} query={query} />
      ))}
    </div>
  );
}

function KeywordFileGroup({ file, query }: { file: KeywordHitFile; query: string }) {
  const { actions } = useApp();
  const basename = file.path.split('/').pop() ?? file.path;
  const hiddenCount = file.totalMatches - file.matches.length;
  return (
    <div className="keyword-file-group">
      <div
        className="keyword-file-header"
        title={file.path}
        onClick={() => {
          void actions.selectFileWithHighlight(file.path, {
            startLine: file.matches[0]?.line,
            chunkText: query,
            openFindBar: true,
          });
        }}
      >
        <span className="keyword-file-name">{basename}</span>
        <span className="keyword-file-count">{file.totalMatches}</span>
      </div>
      {file.matches.map((m, i) => (
        <KeywordMatchRow key={`${file.path}#${m.line}#${i}`} file={file} match={m} query={query} />
      ))}
      {hiddenCount > 0 && (
        <div className="keyword-match-row keyword-truncated">+ {hiddenCount} more in this file</div>
      )}
    </div>
  );
}

function KeywordMatchRow({ file, match, query }: { file: KeywordHitFile; match: KeywordMatch; query: string }) {
  const { actions } = useApp();
  return (
    <div
      className="keyword-match-row"
      onClick={() => {
        void actions.selectFileWithHighlight(file.path, {
          startLine: match.line,
          chunkText: query,
          openFindBar: true,
        });
      }}
      title={`Line ${match.line}`}
    >
      <span className="keyword-line-num">{match.line}</span>
      <span className="keyword-line-text">{highlightRanges(match.text, match.ranges)}</span>
    </div>
  );
}

function highlightRanges(text: string, ranges: Array<[number, number]>) {
  if (ranges.length === 0) return <span>{text}</span>;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push(<span key={`g${cursor}`}>{text.slice(cursor, start)}</span>);
    parts.push(<mark key={`m${start}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(<span key={`g${cursor}`}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

function SearchHitRow({ hit, query }: { hit: SearchHit; query: string }) {
  const { actions } = useApp();
  const fileBasename = hit.fileName.split('/').pop() ?? hit.fileName;
  return (
    <div
      className="search-hit"
      onClick={() => {
        void actions.selectFileWithHighlight(hit.fileName, {
          startLine: hit.startLine,
          endLine: hit.endLine,
          chunkText: hit.content,
        });
      }}
      title={hit.fileName}
    >
      {hit.heading && <div className="search-hit-heading">{hit.heading}</div>}
      <div className="search-hit-snippet">{highlightTerms(hit.content, query)}</div>
      <div className="search-hit-meta">
        <span className="search-hit-file">{fileBasename}</span>
      </div>
    </div>
  );
}

function highlightTerms(text: string, query: string) {
  const terms = query.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (terms.length === 0) return text;
  const re = new RegExp(`(${terms.join('|')})`, 'gi');
  const trimmed = text.length > 240 ? text.slice(0, 240) + '…' : text;
  const parts = trimmed.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
