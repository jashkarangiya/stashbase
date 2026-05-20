import { useEffect, useRef } from 'react';
import { useApp } from '../store/AppContext';

/**
 * Global keyboard shortcuts. Renderless — mounts a `keydown` listener
 * on document and dispatches into the store.
 *
 *   Cmd/Ctrl + N → new note
 *   Cmd/Ctrl + S → flush autosave immediately
 *   Cmd/Ctrl + O → focus the sidebar search (quick-switcher analog)
 *   Cmd/Ctrl + W → close the active tab
 *   Cmd/Ctrl + F → open in-document find bar
 *   Cmd/Ctrl + G → next find match (Shift = prev). No-op when bar is closed.
 *   Esc          → close the find bar (only when it's open)
 *
 * `actions` is stable (memoised) and every handler is action-only — no
 * state reads inline — so the listener binds once and stays. Adding a
 * new shortcut here should not require any state plumbing.
 */
export function Hotkeys() {
  const { state, actions } = useApp();
  // Read state via ref so the listener doesn't rebind on every find
  // tick (which would shake out the listener registration unnecessarily).
  const findOpenRef = useRef(state.find.open);
  findOpenRef.current = state.find.open;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Esc closes the find bar without consuming the keystroke for
      // anyone else — `closeFind` is the only intent here.
      if (e.key === 'Escape' && findOpenRef.current) {
        e.preventDefault();
        actions.closeFind();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'n') {
        e.preventDefault();
        void actions.newNote();
      } else if (k === 's') {
        e.preventDefault();
        void actions.flushSave();
      } else if (k === 'o') {
        e.preventDefault();
        actions.focusSearch();
      } else if (k === 'w') {
        // Swallow the chord even when no tab is open so the browser /
        // Electron doesn't close the window out from under us.
        e.preventDefault();
        void actions.closeActiveTab();
      } else if (k === 'f') {
        e.preventDefault();
        actions.openFind();
      } else if (k === 'g') {
        // Cmd+G / Shift+Cmd+G step through matches without forcing the
        // user back into the find input. No-op when the bar is closed
        // so we don't surprise users mid-edit.
        if (!findOpenRef.current) return;
        e.preventDefault();
        if (e.shiftKey) actions.findPrev(); else actions.findNext();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [actions]);
  return null;
}
