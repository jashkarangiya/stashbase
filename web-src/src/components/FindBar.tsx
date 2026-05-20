import { useEffect, useRef } from 'react';
import { useApp } from '../store/AppContext';

/**
 * Chrome-style in-document find bar. Floats over the top-right of the
 * main pane. Whichever view is below (CM editor / MD preview iframe /
 * HTML preview iframe) supplies a `FindController` via the AppContext;
 * this component is purely UI + keyboard, never reads the underlying
 * document directly.
 *
 * Hotkey contract:
 *   - Cmd+F            → opens this bar (handled in Hotkeys.tsx). When
 *                        already open, re-focuses + selects the input.
 *   - Enter            → next match (Shift+Enter = prev). Implemented
 *                        here so it works without leaving the input.
 *   - Esc              → close.
 *   - Cmd+G / S-Cmd+G  → next/prev. Handled in Hotkeys.tsx so it
 *                        also works from editor / sidebar focus.
 */
export function FindBar() {
  const { state, actions } = useApp();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-focus on every open transition — Cmd+F'ing while the bar is
  // already open re-runs `openFind` (no-op state) but bumps a render,
  // and that render lands here. The select() lets the user retype on
  // top of the prior query without a clear step.
  useEffect(() => {
    if (!state.find.open) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [state.find.open]);

  if (!state.find.open) return null;

  const { query, wholeWord, current, total } = state.find;
  const hasQuery = query.length > 0;
  const noMatch = hasQuery && total === 0;

  return (
    <div className="find-bar" role="search" aria-label="Find in document">
      <input
        ref={inputRef}
        className={'find-input' + (noMatch ? ' no-match' : '')}
        type="text"
        placeholder="Find"
        value={query}
        onChange={(e) => actions.setFindQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) actions.findPrev(); else actions.findNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            actions.closeFind();
          }
        }}
      />
      <span className="find-count">
        {hasQuery ? (total === 0 ? '0/0' : `${current || '?'}/${total}`) : ''}
      </span>
      <button
        type="button"
        className={'find-toggle' + (wholeWord ? ' on' : '')}
        title="Whole word"
        aria-pressed={wholeWord}
        onClick={() => actions.toggleFindWholeWord()}
      >
        ab
      </button>
      <button
        type="button"
        className="find-step"
        title="Previous (Shift+Enter)"
        disabled={total === 0}
        onClick={() => actions.findPrev()}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="find-step"
        title="Next (Enter)"
        disabled={total === 0}
        onClick={() => actions.findNext()}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="find-close"
        title="Close (Esc)"
        onClick={() => actions.closeFind()}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
