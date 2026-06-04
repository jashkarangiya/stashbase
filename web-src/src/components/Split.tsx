import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assetBaseUrl } from '../api';
import { renderMarkdown, withScrollBootstrap } from '../markdown';
import { useApp } from '../store/AppContext';
import { injectAssetBase, previewClickHandler } from '../lib/previewIframe';
import { CodeEditor } from './CodeEditor';

type SplitOrientation = 'horizontal' | 'vertical';
const SPLIT_RATIO_KEY = 'stashbase:split-ratio';
const SPLIT_ORIENTATION_KEY = 'stashbase:split-orientation';
const SPLIT_RATIO_MIN = 0.15;
const SPLIT_RATIO_MAX = 0.85;
const SPLIT_RATIO_DEFAULT = 0.5;

function readStoredRatio(): number {
  if (typeof window === 'undefined') return SPLIT_RATIO_DEFAULT;
  const raw = window.localStorage.getItem(SPLIT_RATIO_KEY);
  if (!raw) return SPLIT_RATIO_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, n));
}

function readStoredOrientation(): SplitOrientation {
  if (typeof window === 'undefined') return 'horizontal';
  return window.localStorage.getItem(SPLIT_ORIENTATION_KEY) === 'vertical' ? 'vertical' : 'horizontal';
}

/**
 * Two-pane source+preview for both MD and HTML. Edits debounce-update
 * the right pane (~80ms — below perceptual threshold but spares
 * re-renders on every keystroke).
 *
 * Initial content for the editor comes from the open file's "last
 * saved" baseline. The editor owns the live buffer thereafter; preview
 * follows.
 */
export function Split({
  name,
  format,
  initialContent,
}: {
  name: string;
  format: 'md' | 'html';
  initialContent: string;
}) {
  const { actions, activeTab } = useApp();
  const pendingAnchor = activeTab?.pendingAnchor ?? null;
  // The preview source updates after a small debounce. We keep it in
  // local state so React handles the iframe diff for us (changing the
  // `srcDoc` prop replaces the iframe doc; changing `src` triggers a
  // full navigation — we revoke + recreate a blob URL for HTML to keep
  // the scroll position stable).
  const [previewSource, setPreviewSource] = useState(initialContent);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  // What the iframe finished parsing last. Pending scroll only applies
  // when this matches the current preview html (avoid scrolling on a
  // stale doc during file-switch reloads).
  const loadedHtmlRef = useRef<string>('');

  // Reset preview when the file switches.
  useEffect(() => {
    setPreviewSource(initialContent);
  }, [name, initialContent]);

  // Cleanup blob URLs on unmount and when source changes.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const previewHtml = useMemo(() => {
    if (format === 'md') return injectAssetBase(renderMarkdown(previewSource), assetBaseUrl(name));
    return injectAssetBase(withScrollBootstrap(previewSource), assetBaseUrl(name));
  }, [previewSource, format, name]);

  // HTML preview is driven by a blob URL so the live buffer can render
  // without round-tripping through disk. `withHtmlAssetBase` points
  // relative refs at the saved file's directory, matching read-only
  // preview behavior for sidecar images / CSS / fonts.
  const iframeProps =
    format === 'html'
      ? (() => {
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = URL.createObjectURL(
            new Blob([previewHtml], { type: 'text/html' }),
          );
          return { src: blobUrlRef.current };
        })()
      : { srcDoc: previewHtml };

  function onEditorChange(doc: string) {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setPreviewSource(doc), 80);
    actions.scheduleSave();
  }

  const applyPendingScroll = useCallback(() => {
    if (!pendingAnchor) return;
    if (format === 'md') {
      const doc = previewFrameRef.current?.contentDocument;
      const el = doc?.getElementById(pendingAnchor);
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
    } else {
      try {
        previewFrameRef.current?.contentWindow?.postMessage(
          { type: 'stashbase-scroll', id: pendingAnchor },
          '*',
        );
      } catch { /* swallow */ }
    }
    actions.consumePendingScroll();
  }, [pendingAnchor, format, actions]);

  // Pending anchor without an iframe reload (same-file jumps).
  useEffect(() => {
    if (!pendingAnchor) return;
    if (loadedHtmlRef.current !== previewHtml) return; // wait for onLoad
    applyPendingScroll();
  }, [pendingAnchor, previewHtml, applyPendingScroll]);

  // Imperative `load` listener — React's onLoad on srcDoc iframes
  // misfires in some environments, leaving the click handler unbound.
  // For HTML format (cross-origin sandbox), parent can't reach the
  // contentDocument anyway; the in-iframe bootstrap handles clicks.
  useEffect(() => {
    if (format !== 'md') return;
    const iframe = previewFrameRef.current;
    if (!iframe) return;
    let installedDoc: Document | null = null;

    function attach() {
      const doc = iframe?.contentDocument;
      if (!doc || installedDoc === doc) return;
      installedDoc = doc;
      for (const img of Array.from(doc.images)) {
        img.dataset.stashbasePreviewable = 'true';
      }
      doc.addEventListener('click', previewClickHandler);
      loadedHtmlRef.current = previewHtml;
      applyPendingScroll();
    }

    iframe.addEventListener('load', attach);
    if (iframe.contentDocument?.readyState === 'complete') attach();
    return () => {
      iframe.removeEventListener('load', attach);
      installedDoc?.removeEventListener('click', previewClickHandler);
    };
  }, [previewHtml, format, applyPendingScroll]);

  const [ratio, setRatio] = useState<number>(readStoredRatio);
  const [orientation, setOrientation] = useState<SplitOrientation>(readStoredOrientation);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<boolean>(false);

  // Persist on every settled change. The user pays a single localStorage
  // write per drag — we don't write per mousemove tick — and orientation
  // changes are user-initiated clicks so they write at most a few times
  // per session.
  useEffect(() => { window.localStorage.setItem(SPLIT_RATIO_KEY, String(ratio)); }, [ratio]);
  useEffect(() => { window.localStorage.setItem(SPLIT_ORIENTATION_KEY, orientation); }, [orientation]);

  function onDividerMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    draggingRef.current = true;
    const el = splitRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Lock the cursor look while dragging so cross-component mouse events
    // don't flicker between resize / default. Reset on mouseup.
    document.body.style.cursor = orientation === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    function onMove(ev: MouseEvent) {
      if (!draggingRef.current) return;
      const next = orientation === 'horizontal'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      const clamped = Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, next));
      setRatio(clamped);
    }
    function onUp() {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function toggleOrientation() {
    setOrientation((prev) => (prev === 'horizontal' ? 'vertical' : 'horizontal'));
  }

  // Use template strings so the divider is its own track — clicking on
  // it doesn't accidentally route into either pane (which would steal
  // focus to the editor mid-drag).
  const sourcePct = (ratio * 100).toFixed(3);
  const previewPct = ((1 - ratio) * 100).toFixed(3);
  const splitStyle: React.CSSProperties = orientation === 'horizontal'
    ? { gridTemplateColumns: `${sourcePct}% 6px ${previewPct}%`, gridTemplateRows: '1fr' }
    : { gridTemplateRows: `${sourcePct}% 6px ${previewPct}%`, gridTemplateColumns: '1fr' };

  return (
    <div
      ref={splitRef}
      className={'split split-' + orientation}
      style={splitStyle}
    >
      <div className="split-source">
        <CodeEditor
          // Re-mount on file/format change so CM picks up the new
          // initial content cleanly without any state migration.
          key={`${name}|${format}`}
          initialContent={initialContent}
          format={format}
          onChange={onEditorChange}
        />
      </div>
      <div
        className={'split-divider split-divider-' + orientation}
        onMouseDown={onDividerMouseDown}
        onDoubleClick={() => setRatio(SPLIT_RATIO_DEFAULT)}
        title="Drag to resize · double-click to reset · click ⇆ to flip orientation"
      >
        <button
          type="button"
          className="split-orient-btn"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); toggleOrientation(); }}
          title={orientation === 'horizontal' ? 'Switch to vertical (top/bottom)' : 'Switch to horizontal (left/right)'}
        >
          {orientation === 'horizontal' ? '⇅' : '⇆'}
        </button>
      </div>
      <div className="split-preview">
        <iframe
          ref={previewFrameRef}
          id="previewFrame"
          className="html-viewer"
          sandbox={format === 'html' ? 'allow-scripts' : 'allow-same-origin'}
          {...iframeProps}
          title="Preview"
        />
      </div>
    </div>
  );
}

/** Mirror of MarkdownPreview's click handler for the edit-mode MD
 *  preview: forward cross-file `.md/.html` links + external links to
 *  the parent, leave `#anchor` to the same-origin browser. */
