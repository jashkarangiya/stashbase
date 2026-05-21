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
  onFullscreenChange?: (handler: (isFullScreen: boolean) => void) => (() => void);
}
import { Welcome } from './components/Welcome';
import { Sidebar } from './components/Sidebar';
import { MainPane } from './components/MainPane';
import { ContextMenu, DropVeil } from './components/Overlays';
import { EmbedderControl } from './components/EmbedderControl';
import { Hotkeys } from './components/Hotkeys';
import { ImageLightbox } from './components/ImageLightbox';
import { CascadePromptModal } from './components/CascadePromptModal';
import { AlertConfirmModal } from './components/AlertConfirmModal';
import { TerminalPane } from './components/TerminalPane';
import { TerminalCliPicker } from './components/TerminalCliPicker';
import { McpSettingsButton, McpSettingsPortal } from './components/McpSettingsButton';
import { HomeIcon, SidebarLeftIcon } from './icons';
import { AppProvider, useApp } from './store/AppContext';
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
    <AppProvider>
      <AppBody />
    </AppProvider>
  );
}

function AppBody() {
  const veilHot = useGlobalDragDrop();
  const { state, actions, dispatch } = useApp();
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  // Mount the terminal panel lazily on first open and then NEVER
  // unmount it — collapsing the panel just hides the column via CSS,
  // the underlying xterm + WebSocket + PTY stay alive. Killing the
  // session on every collapse would lose Claude Code's chat history,
  // any in-flight agent run, the shell's cwd / aliases, etc. The
  // explicit "Start new session" item in the CLI picker dropdown is
  // how the user restarts (it bumps `terminalSessionId`, which makes
  // `XtermView`'s effect re-run + tear down the old session cleanly).
  const [terminalMounted, setTerminalMounted] = useState(state.terminalOpen);
  useEffect(() => {
    if (state.terminalOpen) setTerminalMounted(true);
  }, [state.terminalOpen]);
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
       *  right. Sidebar toggle on the left mirrors VSCode's panel-left
       *  control. Pulled out of the file header (`.main-head`) so file
       *  controls and app controls stop sharing the same row. */}
      <div className="app-chrome">
        <div className="app-chrome-left">
          {!state.welcomeVisible && (
            <button
              className="icon-btn"
              type="button"
              title={state.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              onClick={() => dispatch({ type: 'SIDEBAR_FOLD_TOGGLE' })}
            ><SidebarLeftIcon /></button>
          )}
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
          {!state.welcomeVisible && <EmbedderControl />}
          {!state.welcomeVisible && <TerminalCliPicker />}
          {!state.welcomeVisible && <McpSettingsButton />}
        </div>
      </div>
      <div
        className={
          'app'
          + (state.sidebarCollapsed ? ' sidebar-collapsed' : '')
          + (state.terminalOpen ? ' terminal-open' : '')
        }
        style={{ '--terminal-width': `${state.terminalWidth}px` } as CSSProperties}
      >
        <Sidebar />
        <MainPane />
        {terminalMounted && <TerminalSplitter />}
        {terminalMounted && <TerminalPane />}
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
      <McpSettingsPortal />
    </>
  );
}

/** Vertical drag handle between the main pane and the terminal panel.
 *  Drags the terminal width; lifecycle is pointer-capture style so the
 *  drag survives even if the cursor briefly leaves the handle. */
function TerminalSplitter() {
  const { state, dispatch } = useApp();
  const startRef = useRef<{ x: number; w: number } | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    startRef.current = { x: e.clientX, w: state.terminalWidth };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = startRef.current;
    if (!start) return;
    // Dragging left grows the terminal (it sits on the right). The
    // reducer clamps to [280, 1200] so we don't need to validate here.
    const next = start.w - (e.clientX - start.x);
    dispatch({ type: 'TERMINAL_WIDTH', width: next });
  }
  function onPointerUp() { startRef.current = null; }

  return (
    <div
      className="terminal-splitter"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
