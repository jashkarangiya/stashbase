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
  onFullscreenChange?: (handler: (isFullScreen: boolean) => void) => (() => void);
}

interface CapturePayload {
  ok?: boolean;
  mode?: 'screen' | 'window' | 'region';
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
import { CascadePromptModal } from './components/CascadePromptModal';
import { AlertConfirmModal } from './components/AlertConfirmModal';
import { Toasts } from './components/Toasts';
import { ChatPane } from './components/ChatPane';
import { ChatToggleButton } from './components/ChatToggleButton';
import { SettingsPortal, openSettings } from './components/SettingsModal';
import { HomeIcon } from './icons';
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
  // Mount the chat panel lazily on first open and then NEVER
  // unmount it — collapsing the panel just hides the column via CSS,
  // the underlying xterm + WebSocket + PTY stay alive. Killing the
  // session on every collapse would lose Claude Code's chat history,
  // any in-flight agent run, the shell's cwd / aliases, etc. The
  // explicit "Start new session" item in the agent picker dropdown is
  // how the user restarts (it makes `XtermView`'s effect re-run + tear
  // down the old session cleanly).
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
  // Track macOS fullscreen — traffic lights hide in that mode, so the
  // chrome strip should drop its 62px left inset.
  useEffect(() => {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    return bridge?.onFullscreenChange?.((isFullScreen) => {
      document.body.classList.toggle('is-fullscreen', isFullScreen);
    });
  }, []);
  useEffect(() => {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    return bridge?.onCaptureCreated?.((capture) => {
      void handleCaptureCreated(capture);
    });

    async function handleCaptureCreated(capture: CapturePayload) {
      if (!capture.dataUrl || !capture.mime?.startsWith('image/')) return;
      const sourceTitle = capture.sourceTitle || 'Screenshot';
      setPreviewImage({ src: capture.dataUrl, alt: sourceTitle });

      if (state.welcomeVisible || !state.space) {
        actions.toast('Open a space to save this screenshot.', { level: 'warning' });
        return;
      }

      try {
        const file = await dataUrlToFile(
          capture.dataUrl,
          capture.filename || defaultCaptureFilename(capture.mode),
          capture.mime,
        );
        const saved = await actions.upload([{ file, relPath: file.name }], state.activeFolder);
        if (!saved) return;
        const suffix = state.activeFolder ? ` to ${state.activeFolder}` : '';
        actions.toast(`Saved ${file.name}${suffix}.`, { level: 'success' });
      } catch (err) {
        console.warn('[capture] save failed:', err);
        actions.toast('Screenshot captured, but it could not be saved.', { level: 'error' });
      }
    }
  }, [actions, state.activeFolder, state.space, state.welcomeVisible]);
  useEffect(() => {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    return bridge?.onCaptureError?.((error) => {
      if (error.detail) console.warn('[capture] failed:', error.detail);
      const isPermission = error.kind === 'permission';
      actions.toast(
        error.message || (isPermission
          ? 'Turn on Screen Recording for StashBase, then restart the app.'
          : 'Screenshot did not finish. Try again.'),
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
          {!state.welcomeVisible && (
            <button
              className="icon-btn"
              type="button"
              title="Back to Welcome"
              onClick={() => actions.goHome()}
            ><HomeIcon /></button>
          )}
        </div>
        {!state.welcomeVisible && state.space && (
          <div className="app-chrome-title">{state.space}</div>
        )}
        <div className="app-chrome-right">
          {!state.welcomeVisible && <ChatToggleButton />}
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
        {!state.welcomeVisible && !state.sidebarCollapsed && <SidebarSplitter />}
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
      <CascadePromptModal />
      <AlertConfirmModal />
      <Toasts />
      {!state.welcomeVisible && <EmbedderRequireKeyGate />}
      <SettingsPortal />
    </>
  );
}

function defaultCaptureFilename(mode?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `screenshot-${mode || 'capture'}-${stamp}.png`;
}

async function dataUrlToFile(dataUrl: string, filename: string, mime: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], filename, { type: mime });
}

/** Vertical drag handle on the sidebar's right edge (between the side
 *  panel and the main pane). Drags the panel width within
 *  [MIN, MAX]; dragging narrower than COLLAPSE_AT collapses it to the
 *  rail-only state — the 44px activity rail itself never goes away.
 *  Positioned absolutely so it doesn't perturb the `.app` grid tracks;
 *  pointer-capture keeps the drag alive once the cursor crosses into
 *  the main pane. */
function SidebarSplitter() {
  const { state, dispatch } = useApp();
  const startRef = useRef<{ x: number; w: number } | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    startRef.current = { x: e.clientX, w: state.sidebarWidth };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = startRef.current;
    if (!start) return;
    // Dragging right grows the panel (it sits on the left).
    const next = start.w + (e.clientX - start.x);
    if (next < SIDEBAR_COLLAPSE_AT) {
      dispatch({ type: 'SIDEBAR_SET_COLLAPSED', collapsed: true });
      return;
    }
    // The reducer clamps to [MIN, MAX]; we just snap the floor so the
    // panel doesn't visually dip below MIN before the collapse kicks in.
    dispatch({ type: 'SIDEBAR_WIDTH', width: Math.max(next, SIDEBAR_MIN_WIDTH) });
  }
  function onPointerUp() { startRef.current = null; }

  return (
    <div
      className="sidebar-splitter"
      style={{ left: `calc(44px + var(--sidebar-width, ${SIDEBAR_MAX_WIDTH}px))` }}
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
