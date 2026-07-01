/**
 * Settings → MCP panel. Three clients auto-connect (StashBase writes their
 * config file); every other client just gets the standard MCP config shown
 * inline below, with their names listed for reference.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { MCP_CLIENTS, mcpClientLabel, type McpClientId } from '../../agentCatalog';
import { CopyIcon, CheckIcon } from '../../icons';

interface McpConfigureResult {
  client?: McpClientId;
  file?: string;
  command?: string;
}

type McpClientStatus = {
  configured: boolean;
  cliInstalled?: boolean;
  restartRequired?: boolean;
};

export function McpClientsPanel() {
  const mountedRef = useRef(true);
  const copyResetTimerRef = useRef<number | null>(null);
  const [busy, setBusy] = useState<McpClientId | null>(null);
  const [clientStatus, setClientStatus] = useState<Record<string, McpClientStatus>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [config, setConfig] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    mountedRef.current = false;
    if (copyResetTimerRef.current != null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const loadStatus = useCallback(async (opts: { silent?: boolean } = {}) => {
    try {
      const res = await api.mcpStatus();
      if (!mountedRef.current) return;
      setClientStatus(normalizeClientStatuses(res.clients));
      setConfig(JSON.stringify(res.config ?? {}, null, 2));
    } catch (err: unknown) {
      if (!mountedRef.current || opts.silent) return;
      const text = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', text });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadStatus({ silent: true });
  }, [loadStatus]);

  async function connect(client: McpClientId) {
    setBusy(client);
    setStatus(null);
    try {
      const result = await api.configureMcp(client) as McpConfigureResult;
      if (!mountedRef.current) return;
      const file = result.file ? ` (${result.file})` : '';
      setClientStatus((next) => ({
        ...next,
        [client]: {
          ...(next[client] ?? { configured: false }),
          configured: true,
        },
      }));
      setStatus({ kind: 'ok', text: `Connected ${mcpClientLabel(client)}${file}.` });
      void loadStatus({ silent: true });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const text = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', text });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function disconnect(client: McpClientId) {
    setBusy(client);
    setStatus(null);
    try {
      const result = await api.disconnectMcp(client) as McpConfigureResult;
      if (!mountedRef.current) return;
      const file = result.file ? ` (${result.file})` : '';
      setClientStatus((next) => ({
        ...next,
        [client]: {
          ...(next[client] ?? { configured: true }),
          configured: false,
          restartRequired: false,
        },
      }));
      setStatus({ kind: 'ok', text: `Disconnected ${mcpClientLabel(client)}${file}.` });
      void loadStatus({ silent: true });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const text = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', text });
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function copyConfig() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(config);
      ok = true;
    } catch {
      // navigator.clipboard can reject in an unfocused / restricted
      // Electron webview — fall back to the legacy execCommand path.
      try {
        const ta = document.createElement('textarea');
        ta.value = config;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    if (ok) {
      if (!mountedRef.current) return;
      setCopied(true);
      if (copyResetTimerRef.current != null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        copyResetTimerRef.current = null;
        if (mountedRef.current) setCopied(false);
      }, 1500);
    } else {
      if (!mountedRef.current) return;
      setStatus({ kind: 'error', text: 'Couldn’t copy — select the text and copy manually.' });
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title">MCP clients</div>
      <div className="settings-section-hint">
        Connect StashBase to your agents. Restart each app after connecting.
      </div>
      <div className="mcp-client-list">
        {MCP_CLIENTS.map((client) => {
          const status = clientStatus[client.id] ?? { configured: false };
          const badge = clientBadge(client, status);
          const isConnected = status.configured;
          const isBusy = busy === client.id;
          const Icon = client.Icon;
          return (
            <div className="mcp-client-row" key={client.id}>
              <span className="mcp-client-label">
                <span className="mcp-client-icon">
                  <Icon />
                </span>
                <span className="mcp-client-copy">
                  <span className="mcp-client-name">{client.name}</span>
                </span>
              </span>
              {badge && (
                <span className={'mcp-status-pill ' + badge.tone} title={badge.title}>
                  {badge.label}
                </span>
              )}
              <button
                type="button"
                className={'modal-btn mcp-connector-btn' + (isConnected ? ' connected' : '')}
                disabled={busy != null}
                onClick={() => void (isConnected ? disconnect(client.id) : connect(client.id))}
                title={isConnected ? `Disconnect ${client.name}` : `Connect ${client.name}`}
              >
                {isBusy
                  ? (isConnected ? 'Disconnecting…' : 'Connecting…')
                  : isConnected ? 'Disconnect' : 'Connect'}
              </button>
            </div>
          );
        })}
      </div>
      {status && (
        <div className={status.kind === 'error' ? 'modal-error' : 'mcp-success'}>
          {status.text}
        </div>
      )}

      <div className="mcp-other">
        <div className="settings-section-hint">
          For any other MCP-compatible agent, paste this configuration into its MCP settings:
        </div>
        <div className="mcp-config-preview">
          <div className="mcp-config-preview-head">
            MCP configuration
            <button
              type="button"
              className={'mcp-config-copy' + (copied ? ' copied' : '')}
              onClick={() => void copyConfig()}
              title={copied ? 'Copied' : 'Copy configuration'}
              aria-label={copied ? 'Copied' : 'Copy configuration'}
            >
              {copied ? <CheckIcon className="mcp-config-copy-icon" /> : <CopyIcon className="mcp-config-copy-icon" />}
            </button>
          </div>
          <pre>{config}</pre>
        </div>
      </div>
    </div>
  );
}

function normalizeClientStatuses(
  clients: Record<string, boolean | { configured?: boolean; cliInstalled?: boolean; restartRequired?: boolean }>,
): Record<string, McpClientStatus> {
  return Object.fromEntries(Object.entries(clients).map(([id, value]) => {
    if (typeof value === 'boolean') return [id, { configured: value, restartRequired: value }];
    return [id, {
      configured: value.configured === true,
      ...(typeof value.cliInstalled === 'boolean' ? { cliInstalled: value.cliInstalled } : {}),
      restartRequired: value.restartRequired === true,
    }];
  }));
}

function clientBadge(
  client: { cliId?: string },
  status: McpClientStatus,
): { label: string; tone: string; title: string } | null {
  if (client.cliId && status.cliInstalled === false) {
    return {
      label: 'CLI missing',
      tone: 'warn',
      title: 'Install the CLI before starting the built-in chat.',
    };
  }
  if (status.restartRequired) {
    return {
      label: 'Restart client',
      tone: 'pending',
      title: 'The config is written. Restart the client so it picks up StashBase.',
    };
  }
  return null;
}
