import { useEffect, useMemo, useRef } from 'react';
import { assetUrl } from '../api';
import { useApp, type MatchInfo } from '../store/AppContext';

/**
 * Read-only HTML preview. Loads via `/asset/*` so the iframe's base
 * resolves relative references in the page (`<img src="X_files/foo.png">`)
 * to the sibling files inside the space dir.
 *
 * Sandbox = `allow-scripts allow-same-origin` — `allow-scripts` lets
 * inline scripts run (Wikipedia snapshots, arxiv reports, self-contained
 * bundler apps); `allow-same-origin` gives the page a real localhost
 * origin so that `URL.createObjectURL` produces loadable `blob:http://`
 * URLs (without it, blob URLs are `blob:null/…` which Electron/Chromium
 * refuses to load as `<script src>`). For a local desktop app whose HTML
 * content is user-controlled, this tradeoff mirrors what Obsidian and
 * VS Code do. The server-injected scroll-bootstrap listens for
 * postMessage from the parent (anchor scroll + cross-file link
 * forwarding).
 *
 * Auto-reload on external edits (Claude Code edits the file from the
 * chat panel) is the reason for the cache-buster query string on
 * the iframe src — the URL would otherwise be identical between
 * versions and React would never re-set it, leaving the iframe
 * stuck on whatever the asset route served first. See the `src`
 * computation below.
 */
export function HtmlPreview({ name }: { name: string }) {
  const { state, actions, activeTab } = useApp();
  const pendingAnchor = activeTab?.pendingAnchor ?? null;
  const pendingHighlight = activeTab?.pendingHighlight ?? null;
  const content = activeTab?.file?.content ?? '';
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // Tracks which `name` the iframe has finished loading. We only post
  // the scroll message when this matches the current `name` — otherwise
  // the message lands on the previous file's content and the pending
  // anchor gets consumed before the new content arrives.
  const loadedNameRef = useRef<string>('');
  // Snapshot find-bar state so the iframe re-apply path doesn't churn
  // the find effect on every find tick.
  const findAtMount = useRef(state.find);
  findAtMount.current = state.find;

  // Cheap content fingerprint used to bust the iframe cache when the
  // file changes on disk (e.g. Claude Code wrote to it via the
  // chat panel; `refreshActiveTabFromDisk` patched our local
  // state but the iframe is fed by `assetUrl(name)` which the server
  // re-reads from disk on every request — without a query-string
  // change React keeps the same `src`, so the iframe never refetches).
  // djb2 over the whole content; usable as a 32-bit base36 token.
  const fingerprint = useMemo(() => {
    let h = 5381;
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) + h + content.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }, [content]);
  // `assetUrl()` already carries a `?windowId=…` query — append the
  // cache-bust with `&` so we don't end up with two `?` separators
  // (the second would be swallowed into the value of `windowId`).
  const src = `${assetUrl(name)}&v=${fingerprint}`;

  function postScroll() {
    if (!pendingAnchor) return;
    if (loadedNameRef.current !== name) return; // iframe still loading
    try {
      frameRef.current?.contentWindow?.postMessage(
        { type: 'stashbase-scroll', id: pendingAnchor },
        '*',
      );
    } catch { /* swallow */ }
    actions.consumePendingScroll();
  }

  function postChunkHighlight() {
    if (!pendingHighlight) return;
    if (loadedNameRef.current !== name) return;
    try {
      frameRef.current?.contentWindow?.postMessage(
        { type: 'stashbase-chunk-highlight', text: pendingHighlight.chunkText },
        '*',
      );
    } catch { /* swallow */ }
    actions.consumePendingHighlight();
  }

  function onLoad() {
    loadedNameRef.current = name;
    postScroll();
    postChunkHighlight();
    // Re-apply the current query if the bar is open across reload.
    const snap = findAtMount.current;
    if (snap.open && snap.query) {
      queueMicrotask(() => actions.setFindQuery(snap.query));
    }
  }

  // Same-file anchor jumps fire this; cross-file jumps wait for onLoad.
  useEffect(() => { postScroll(); /* eslint-disable-next-line */ }, [pendingAnchor, name]);
  useEffect(() => { postChunkHighlight(); /* eslint-disable-next-line */ }, [pendingHighlight, name]);

  // Forward OS-file drops out of the iframe. The iframe swallows drag
  // events, so the window-level listeners in useGlobalDragDrop never
  // fire while the cursor is over the preview area. `/asset/*` is
  // same-origin with the app and the sandbox carries
  // `allow-same-origin`, so the parent can attach to the
  // contentDocument directly — same relay as MarkdownPreview.
  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe) return;
    let installedDoc: Document | null = null;

    function iframeDragOver(e: Event) {
      const de = e as DragEvent;
      if (de.dataTransfer?.types.includes('Files')) de.preventDefault();
    }
    function iframeDrop(e: Event) {
      const de = e as DragEvent;
      if (!de.dataTransfer?.types.includes('Files')) return;
      de.preventDefault();
      de.stopPropagation();
      // Collect entries synchronously before any await — Chromium
      // invalidates DataTransfer.items on the first await.
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < (de.dataTransfer.items?.length ?? 0); i++) {
        const entry = de.dataTransfer.items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
      window.dispatchEvent(
        new CustomEvent('stashbase:iframe-drop', { detail: { entries } }),
      );
    }

    function attach() {
      const doc = iframe?.contentDocument;
      if (!doc || installedDoc === doc) return;
      installedDoc = doc;
      doc.addEventListener('dragover', iframeDragOver);
      doc.addEventListener('drop', iframeDrop);
    }

    iframe.addEventListener('load', attach);
    if (iframe.contentDocument?.readyState === 'complete') attach();
    return () => {
      iframe.removeEventListener('load', attach);
      installedDoc?.removeEventListener('dragover', iframeDragOver);
      installedDoc?.removeEventListener('drop', iframeDrop);
    };
  }, [src]);

  // Register a postMessage-based find controller. The iframe runs the
  // walk-and-highlight algorithm itself (sandbox=allow-scripts blocks
  // same-origin DOM access) and replies with the count via reqId.
  useEffect(() => {
    let seq = 0;
    const pending = new Map<number, (info: MatchInfo) => void>();
    const TIMEOUT_MS = 2000;

    function send(op: 'set' | 'next' | 'prev' | 'close', extra?: Record<string, unknown>): Promise<MatchInfo> {
      const reqId = ++seq;
      const win = frameRef.current?.contentWindow;
      if (!win) return Promise.resolve({ current: 0, total: 0 });
      return new Promise<MatchInfo>((resolve) => {
        pending.set(reqId, resolve);
        try {
          win.postMessage({ type: 'stashbase-find', op, reqId, ...extra }, '*');
        } catch {
          pending.delete(reqId);
          resolve({ current: 0, total: 0 });
          return;
        }
        // Iframe may have unloaded / errored before responding —
        // resolve to empty after a short timeout so the bar's spinner
        // (if any) doesn't hang.
        setTimeout(() => {
          const r = pending.get(reqId);
          if (r) { pending.delete(reqId); r({ current: 0, total: 0 }); }
        }, TIMEOUT_MS);
      });
    }

    function onMessage(e: MessageEvent) {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'stashbase-find-result' && typeof d.reqId === 'number') {
        const r = pending.get(d.reqId);
        if (r) {
          pending.delete(d.reqId);
          r({ current: d.current ?? 0, total: d.total ?? 0 });
        }
      } else if (d.type === 'stashbase-open-find') {
        actions.openFind();
      } else if (d.type === 'stashbase-find-step') {
        // Bootstrap inside the iframe forwards Cmd+G / Shift+Cmd+G.
        if (d.dir === 'prev') actions.findPrev(); else actions.findNext();
      }
    }
    window.addEventListener('message', onMessage);

    actions.registerFindController({
      setQuery: (q, opts) => send('set', { query: q, wholeWord: opts.wholeWord }),
      next: () => send('next'),
      prev: () => send('prev'),
      close: () => { void send('close'); },
    });

    return () => {
      window.removeEventListener('message', onMessage);
      actions.registerFindController(null);
    };
  }, [actions]);

  return (
    <div className="viewer-shell">
      <iframe
        ref={frameRef}
        id="previewFrame"
        className="html-viewer"
        sandbox="allow-scripts allow-same-origin"
        src={src}
        title="HTML preview"
        onLoad={onLoad}
      />
    </div>
  );
}
