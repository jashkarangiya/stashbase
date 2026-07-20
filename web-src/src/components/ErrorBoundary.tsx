import {
  Component,
  lazy,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

interface LazyLoadBoundaryProps {
  children: ReactNode;
  className: string;
  label: string;
  resetKey?: string;
}

interface LazyLoadBoundaryState {
  error: Error | null;
  resetKey?: string;
}

export async function loadWithRetry<T>(
  loader: () => Promise<T>,
  retries = 1,
  delayMs = 250,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await loader();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < retries && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export function lazyWithRetry<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
) {
  return lazy(() => loadWithRetry(loader));
}

export class LazyLoadBoundary extends Component<LazyLoadBoundaryProps, LazyLoadBoundaryState> {
  constructor(props: LazyLoadBoundaryProps) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromProps(
    props: LazyLoadBoundaryProps,
    state: LazyLoadBoundaryState,
  ): LazyLoadBoundaryState | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: Error): Pick<LazyLoadBoundaryState, 'error'> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError(error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={`${this.props.className} lazy-load-error`} role="alert">
        <span>Could not open {this.props.label}.</span>
        <button type="button" className="lazy-load-reload" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

/**
 * Root-level error boundary. Without this, any render-time exception
 * anywhere in the tree blanks the whole renderer — the user sees a
 * white window with no recovery path. With it, we trap the error,
 * render a recovery surface (reload button + error text + copyable
 * stack trace), and POST the stack to the server log so the failure
 * shows up alongside other server-side issues for debugging.
 *
 * Reload uses `window.location.reload()` because the renderer state
 * may be in an inconsistent shape — a softer "reset state and try
 * again" risks re-triggering the same crash on the next render. The
 * SAVE_STATUS / activeTab buffer is already persisted (autosave runs
 * on every edit + a `beforeunload` `sendBeacon`), so a hard reload
 * loses at most the cursor position in the current tab.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    reportClientError(error, info);
  }

  reset = () => window.location.reload();

  copyDetails = async () => {
    if (!this.state.error) return;
    const details = [
      `Error: ${this.state.error.message}`,
      '',
      'Stack:',
      this.state.error.stack ?? '(no stack)',
      '',
      'Component stack:',
      this.state.componentStack ?? '(no component stack)',
    ].join('\n');
    try { await navigator.clipboard.writeText(details); } catch { /* clipboard denied */ }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="errbnd-veil" role="alert">
        <div className="errbnd-card">
          <div className="errbnd-title">Something went wrong</div>
          <div className="errbnd-msg">{this.state.error.message || 'Unknown error'}</div>
          <pre className="errbnd-stack">
            {this.state.error.stack ?? '(no stack)'}
          </pre>
          <div className="errbnd-actions">
            <button type="button" className="errbnd-btn primary" onClick={this.reset}>Reload</button>
            <button type="button" className="errbnd-btn" onClick={() => void this.copyDetails()}>Copy details</button>
          </div>
        </div>
      </div>
    );
  }
}

function reportClientError(error: Error, info: ErrorInfo): void {
  // Fire-and-forget so a logging failure never masks the renderer error.
  void fetch('/api/log/client-error', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: error.message,
      stack: error.stack ?? null,
      componentStack: info.componentStack ?? null,
      url: window.location.href,
      userAgent: navigator.userAgent,
      at: new Date().toISOString(),
    }),
  }).catch(() => { /* swallow */ });
}
