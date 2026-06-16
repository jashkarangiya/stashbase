import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

interface ElectronBridge {
  openFolderDialog?: (opts?: unknown) => Promise<string | null>;
  openExternal?: (url: string) => Promise<boolean>;
  configureMcp?: (client: string) => Promise<unknown>;
  onCaptureCreated?: (handler: (capture: CapturePayload) => void) => (() => void);
  onCaptureError?: (handler: (error: CaptureErrorPayload) => void) => (() => void);
  onClipboardImage?: (handler: (offer: ClipboardOffer) => void) => (() => void);
  markClipboardHandled?: (hash: string) => void;
}

interface CapturePayload {
  ok?: boolean;
  mode?: 'recording';
  mime?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  sourceTitle?: string;
  filename?: string;
}

interface CaptureErrorPayload {
  kind?: 'permission' | 'capture-failed' | string;
  title?: string;
  message?: string;
  detail?: string;
}
import { Welcome } from './components/Welcome';
import { Sidebar } from './components/Sidebar';
import { MainPane } from './components/MainPane';
import { ContextMenu, DropVeil } from './components/Overlays';
import { EmbedderRequireKeyGate } from './components/EmbedderRequireKeyGate';
import { Hotkeys } from './components/Hotkeys';
import { ImageLightbox } from './components/ImageLightbox';
import { ClipboardImportModal, type ClipboardOffer } from './components/ClipboardImportModal';
import { CascadePromptModal } from './components/CascadePromptModal';
import { AlertConfirmModal } from './components/AlertConfirmModal';
import { Toasts } from './components/Toasts';
import { ChatPane } from './components/ChatPane';
import { ChatLaunchButtons } from './components/ChatLaunchButtons';
import { SettingsPortal, openSettings } from './components/SettingsModal';
import { HomeIcon } from './icons';
import { useHoverTip } from './hooks/useHoverTip';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppProvider, useApp } from './store/AppContext';
import { SIDEBAR_COLLAPSE_AT, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from './store/state';
import { useGlobalDragDrop } from './hooks/useGlobalDragDrop';

/**
 * Top-level shell. Wraps everything in <AppProvider> (the single
 * store) and mounts the global drag-drop / hotkey side effects.
 *
 * The welcome overlay sits *above* the app via fixed positioning so
 * the rest of the UI keeps its scroll / selection state when the user
 * goes back home (cf. legacy `web/index.html`).
 */
export function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppBody />
      </AppProvider>
    </ErrorBoundary>
  );
}

function AppBody() {
  const veilHot = useGlobalDragDrop();
  const { state, actions } = useApp();
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [clipboardOffer, setClipboardOffer] = useState<ClipboardOffer | null>(null);
  // Mount the chat panel lazily on first open and then NEVER
  // unmount it — collapsing the panel just hides the column via CSS,
  // the underlying agent WebSocket sessions stay alive. Killing them
  // on every collapse would lose Claude Code's chat history and any
  // in-flight agent run. The in-panel "new chat" `+` is how the user
  // starts a fresh session.
  const [chatMounted, setChatMounted] = useState(state.chatOpen);
  useEffect(() => {
    if (state.chatOpen) setChatMounted(true);
  }, [state.chatOpen]);
  // Tag the body as Electron for the chrome-region CSS, only when the
  // preload bridge is exposed.
  useEffect(() => {
    if ((window as { electron?: unknown }).electron) {
      document.body.classList.add('is-electron');
    }
  }, []);
  // macOS fullscreen toggles the `is-fullscreen` body class so the chrome
  // strip can drop its traffic-light inset. That's owned entirely by the
  // preload (registered before page load, so it catches the initial state
  // push even when the window starts in fullscreen) — see preload.cjs.
  useEffect(() => {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    return bridge?.onCaptureCreated?.((capture) => {
      void handleCaptureCreated(capture);
    });

    async function handleCaptureCreated(capture: CapturePayload) {
      // `capture:created` only ever carries a screen recording now — the
      // built-in screenshot tool was removed; system screenshots come in
      // through the clipboard offer instead. Recordings aren't stored as
      // video: they're OCR'd into a visible note and the webm is
      // discarded server-side. The note shows up via the "Converting…"
      // banner when its text is ready.
      if (!capture.dataUrl || !capture.mime?.startsWith('video/')) return;
      if (state.welcomeVisible || !state.space) {
        actions.toast('Open a space to save this recording.', { level: 'warning' });
        return;
      }
      try {
        const file = await dataUrlToFile(
          capture.dataUrl,
          capture.filename || defaultCaptureFilename(),
          capture.mime ?? 'video/webm',
        );
        const ok = await actions.recordVideo(file, state.activeFolder);
        if (ok) actions.toast('Recording captured — extracting text…', { level: 'info' });
      } catch (err) {
        console.warn('[capture] save failed:', err);
        actions.toast('Recording captured, but it could not be processed.', { level: 'error' });
      }
    }
  }, [actions, state.activeFolder, state.space, state.welcomeVisible]);
  useEffect(() => {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    return bridge?.onClipboardImage?.((offer) => {
      if (!offer.dataUrl || !offer.mime?.startsWith('image/')) return;
      // No place to put it — skip silently rather than nag (main already
      // recorded the hash, so it won't re-offer the same image).
      if (state.welcomeVisible || !state.space) return;
      setClipboardOffer(offer);
    });
  }, [state.space, state.welcomeVisible]);
  useEffect(() => {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    return bridge?.onCaptureError?.((error) => {
      if (error.detail) console.warn('[capture] failed:', error.detail);
      const isPermission = error.kind === 'permission';
      actions.toast(
        error.message || (isPermission
          ? 'Turn on Screen Recording for StashBase, then restart the app.'
          : 'Recording did not finish. Try again.'),
        {
          level: isPermission ? 'warning' : 'error',
          ttl: isPermission ? null : undefined,
          action: isPermission
            ? { label: 'Open settings', onClick: () => openSettings('capture') }
            : undefined,
        },
      );
    });
  }, [actions]);
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!e.data) return;
      if (e.data.type === 'stashbase-nav') {
        const path = typeof e.data.path === 'string' ? e.data.path : '';
        const anchor = typeof e.data.anchor === 'string' && e.data.anchor ? e.data.anchor : undefined;
        if (!path) return;
        void actions.navigateTo(path, anchor);
        return;
      }
      if (e.data.type === 'stashbase-preview-image') {
        const raw = typeof e.data.src === 'string' ? e.data.src : '';
        try {
          const url = new URL(raw, window.location.href);
          if (
            url.protocol === 'http:' ||
            url.protocol === 'https:' ||
            url.protocol === 'data:' ||
            url.protocol === 'blob:'
          ) {
            setPreviewImage({
              src: url.href,
              alt: typeof e.data.alt === 'string' ? e.data.alt : '',
            });
          }
        } catch {
          // Ignore malformed image preview payloads.
        }
        return;
      }
      if (e.data.type !== 'stashbase-open-external') return;
      const href = typeof e.data.href === 'string' ? e.data.href : '';
      try {
        const url = new URL(href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        const bridge = (window as { electron?: ElectronBridge }).electron;
        if (bridge?.openExternal) {
          void bridge.openExternal(url.href);
        } else {
          window.open(url.href, '_blank', 'noopener,noreferrer');
        }
      } catch {
        // Ignore malformed messages from sandboxed preview content.
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [actions]);

  async function handleClipboardAdd(offer: ClipboardOffer) {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    bridge?.markClipboardHandled?.(offer.hash);
    setClipboardOffer(null);
    try {
      const file = await dataUrlToFile(offer.dataUrl, offer.filename, offer.mime);
      const saved = await actions.upload([{ file, relPath: file.name }], state.activeFolder);
      if (!saved) return;
      const suffix = state.activeFolder ? ` to ${state.activeFolder}` : '';
      actions.toast(`Saved ${file.name}${suffix}.`, { level: 'success' });
    } catch (err) {
      console.warn('[clipboard] save failed:', err);
      actions.toast('Could not save the clipboard image.', { level: 'error' });
    }
  }

  return (
    <>
      <Welcome />
      {/* Dedicated chrome strip across the very top of the window.
       *  In Electron it doubles as the macOS `hiddenInset` drag region;
       *  the centered space name plays the role VSCode's titlebar fills
       *  (workspace identity), and the embedder picker sits at the
       *  right. The sidebar has no explicit toggle button — it's
       *  resized (and collapsed) by dragging its right edge, à la
       *  VSCode; the activity rail always stays visible. Pulled out of
       *  the file header (`.main-head`) so file controls and app
       *  controls stop sharing the same row. */}
      <div className="app-chrome">
        <div className="app-chrome-left">
          {!state.welcomeVisible && <HomeChromeButton onClick={() => actions.goHome()} />}
        </div>
        {!state.welcomeVisible && state.space && (
          <div className="app-chrome-title">{state.space}</div>
        )}
        <div className="app-chrome-right">
          {!state.welcomeVisible && <ChatLaunchButtons />}
        </div>
      </div>
      <div
        className={
          'app'
          + (state.sidebarCollapsed ? ' sidebar-collapsed' : '')
          + (state.chatOpen ? ' chat-open' : '')
        }
        style={{
          '--chat-width': `${state.chatWidth}px`,
          '--sidebar-width': `${state.sidebarWidth}px`,
        } as CSSProperties}
      >
        <Sidebar />
        {!state.welcomeVisible && <SidebarSplitter />}
        <MainPane />
        {chatMounted && <ChatSplitter />}
        {chatMounted && <ChatPane />}
      </div>
      <DropVeil hot={veilHot} />
      <ContextMenu />
      <Hotkeys />
      {previewImage && (
        <ImageLightbox
          src={previewImage.src}
          alt={previewImage.alt}
          onClose={() => setPreviewImage(null)}
        />
      )}
      {clipboardOffer && (
        <ClipboardImportModal
          offer={clipboardOffer}
          onClose={() => {
            const bridge = (window as { electron?: ElectronBridge }).electron;
            bridge?.markClipboardHandled?.(clipboardOffer.hash);
            setClipboardOffer(null);
          }}
          onAdd={() => { void handleClipboardAdd(clipboardOffer); }}
        />
      )}
      <CascadePromptModal />
      <AlertConfirmModal />
      <Toasts />
      {!state.welcomeVisible && <EmbedderRequireKeyGate />}
      <SettingsPortal />
    </>
  );
}

function defaultCaptureFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `recording-${stamp}.webm`;
}

/** Home button in the top chrome. Its own component so the hover-tip hook
 *  isn't called conditionally (the button only renders outside Welcome).
 *  Tip drops *below* the button — it sits at the very top of the window,
 *  so a tooltip above would be clipped off-screen. */
function HomeChromeButton({ onClick }: { onClick: () => void }) {
  const { tipProps, tip } = useHoverTip('Back to Welcome', 'bottom');
  return (
    <button className="icon-btn" type="button" aria-label="Back to Welcome" onClick={onClick} {...tipProps}>
      <HomeIcon />
      {tip}
    </button>
  );
}

/** Decode a `data:` URL into a File. Decodes the base64 (or percent-
 *  encoded) payload directly rather than `fetch(dataUrl)` — the app's CSP
 *  `connect-src 'self'` blocks data: fetches, which made every capture /
 *  clipboard import throw "Could not save". Synchronous; callers `await`
 *  it harmlessly. */
function dataUrlToFile(dataUrl: string, filename: string, mime: string): File {
  const comma = dataUrl.indexOf(',');
  const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  if (header.includes(';base64')) {
    const bin = atob(payload);
    const buf = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return new File([buf], filename, { type: mime });
  }
  // Non-base64 data URL: hand the decoded text straight to File (UTF-8
  // encoded by the Blob constructor).
  return new File([decodeURIComponent(payload)], filename, { type: mime });
}

/** Vertical drag handle on the sidebar's right edge (between the side
 *  panel and the main pane). Drags the panel width within [MIN, MAX];
 *  dragging narrower than COLLAPSE_AT collapses it to the rail-only
 *  state — the 44px activity rail itself never goes away. Stays mounted
 *  while collapsed (pinned to the rail's right edge at 44px) so the user
 *  can grab it and drag the panel back open. Positioned absolutely so it
 *  doesn't perturb the `.app` grid tracks; pointer-capture keeps the
 *  drag alive once the cursor crosses into the main pane. */
function SidebarSplitter() {
  const { state, dispatch } = useApp();
  // `w` is the panel width at drag start. `done` ends the gesture after a
  // collapse or a re-open snap so each grab does exactly one thing —
  // resize, OR collapse, OR re-open. Mixing them is what produced the
  // min-width "gap": there's a hard discontinuity between collapsed (0)
  // and the 200px floor, so you can't smoothly drag *across* it. Instead
  // we snap: pull a collapsed panel right past a few px → it pops open at
  // its remembered width; pull an open panel below COLLAPSE_AT → it snaps
  // shut. Re-grab to do the next thing.
  const startRef = useRef<{ x: number; w: number; collapsed: boolean; done: boolean } | null>(null);
  // The `.app` grid animates `grid-template-columns` (220ms) for smooth
  // collapse/expand toggles — but during a live drag that lag makes the
  // panel edge trail the splitter, opening a blank gap. We drop the
  // transition for the duration of the drag via this class.
  const appRef = useRef<HTMLElement | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    startRef.current = {
      x: e.clientX,
      w: state.sidebarWidth,
      collapsed: state.sidebarCollapsed,
      done: false,
    };
    appRef.current = e.currentTarget.parentElement as HTMLElement | null;
    appRef.current?.classList.add('sidebar-dragging');
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = startRef.current;
    if (!start || start.done) return;
    const dx = e.clientX - start.x;
    if (start.collapsed) {
      // Collapsed: a small rightward pull re-opens at the remembered
      // width (state.sidebarWidth survives a collapse untouched). One
      // discrete snap — we don't track width during the same gesture,
      // which is what avoided the min-width gap.
      if (dx > 6) {
        dispatch({ type: 'SIDEBAR_SET_COLLAPSED', collapsed: false });
        start.done = true;
      }
      return;
    }
    // Open: track width; pulling narrower than COLLAPSE_AT snaps shut.
    const next = start.w + dx;
    if (next < SIDEBAR_COLLAPSE_AT) {
      dispatch({ type: 'SIDEBAR_SET_COLLAPSED', collapsed: true });
      start.done = true;
      return;
    }
    // The reducer clamps to [MIN, MAX]; we snap the floor so the panel
    // doesn't visually dip below MIN before the collapse kicks in.
    dispatch({ type: 'SIDEBAR_WIDTH', width: Math.max(next, SIDEBAR_MIN_WIDTH) });
  }
  function onPointerUp() {
    startRef.current = null;
    appRef.current?.classList.remove('sidebar-dragging');
    appRef.current = null;
  }

  return (
    <div
      className="sidebar-splitter"
      style={{
        left: state.sidebarCollapsed
          ? '44px'
          : `calc(44px + var(--sidebar-width, ${SIDEBAR_MAX_WIDTH}px))`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

/** Vertical drag handle between the main pane and the chat panel.
 *  Drags the chat-panel width; lifecycle is pointer-capture style so the
 *  drag survives even if the cursor briefly leaves the handle. */
function ChatSplitter() {
  const { state, dispatch } = useApp();
  const startRef = useRef<{ x: number; w: number } | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    startRef.current = { x: e.clientX, w: state.chatWidth };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = startRef.current;
    if (!start) return;
    // Dragging left grows the panel (it sits on the right). The
    // reducer clamps to [280, 1200] so we don't need to validate here.
    const next = start.w - (e.clientX - start.x);
    dispatch({ type: 'CHAT_WIDTH', width: next });
  }
  function onPointerUp() { startRef.current = null; }

  return (
    <div
      className="chat-splitter"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
