/**
 * Settings → MCP panel. Three clients auto-connect (StashBase writes their
 * config file); every other client just gets the standard MCP config shown
 * inline below, with their names listed for reference.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';

type McpClientId = 'claude-code' | 'codex-cli' | 'claude-desktop';

interface McpConfigureResult {
  ok: boolean;
  client?: McpClientId;
  file?: string;
  command?: string;
  error?: string;
}

interface ElectronBridge {
  configureMcp?: (client: McpClientId) => Promise<McpConfigureResult>;
}

const MCP_CLIENTS: {
  id: McpClientId;
  name: string;
  detail: string;
  restart: string;
}[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    detail: 'Adds @stashbase to Claude Code via ~/.claude.json.',
    restart: 'Restart Claude Code after connecting.',
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    detail: 'Adds stashbase to ~/.codex/config.toml.',
    restart: 'Restart Codex CLI after connecting.',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    detail: 'Adds @stashbase to Claude Desktop config.',
    restart: 'Restart Claude Desktop after connecting.',
  },
];

// Other clients that can't be auto-connected — listed by name only; users
// paste the config below into whatever each one's MCP settings happen to be.
const OTHER_CLIENTS = [
  'ChatGPT', 'Cursor', 'Gemini CLI', 'VS Code', 'Cline',
  'Windsurf', 'Qwen Code', 'Roo Code', 'Cherry Studio', 'Void',
];

export function McpClientsPanel() {
  const [busy, setBusy] = useState<McpClientId | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [config, setConfig] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.mcpStatus()
      .then((res) => {
        if (cancelled) return;
        setConnected(res.clients);
        setConfig(JSON.stringify(res.config ?? {}, null, 2));
      })
      .catch(() => { /* status is best-effort */ });
    return () => { cancelled = true; };
  }, []);

  async function connect(client: McpClientId) {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    setBusy(client);
    setStatus(null);
    try {
      const result = await configureMcp(client, bridge);
      if (!result.ok) {
        setStatus({ kind: 'error', text: result.error || 'Unable to configure MCP.' });
        return;
      }
      const file = result.file ? ` (${result.file})` : '';
      setConnected((next) => ({ ...next, [client]: true }));
      setStatus({ kind: 'ok', text: `Connected ${clientLabel(client)}${file}.` });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', text });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(client: McpClientId) {
    setBusy(client);
    setStatus(null);
    try {
      const result = await api.disconnectMcp(client);
      if (!result.ok) {
        setStatus({ kind: 'error', text: result.error || 'Unable to disconnect MCP.' });
        return;
      }
      const file = result.file ? ` (${result.file})` : '';
      setConnected((next) => ({ ...next, [client]: false }));
      setStatus({ kind: 'ok', text: `Disconnected ${clientLabel(client)}${file}.` });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', text });
    } finally {
      setBusy(null);
    }
  }

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be denied; the config is selectable inline */ }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title">MCP clients</div>
      <div className="settings-section-hint">
        Connect StashBase as <code>@stashbase</code> for the AI tools below.
      </div>
      <div className="mcp-client-list">
        {MCP_CLIENTS.map((client) => (
          <div className="mcp-client-row" key={client.id}>
            <span className="mcp-client-text">
              <span className="mcp-client-name">{client.name}</span>
              <span className="mcp-client-detail">{client.detail}</span>
              <span className="mcp-client-restart">{client.restart}</span>
            </span>
            <button
              type="button"
              className={'modal-btn mcp-connector-btn' + (connected[client.id] ? ' connected' : '')}
              disabled={busy != null}
              onClick={() => void (connected[client.id] ? disconnect(client.id) : connect(client.id))}
              title={connected[client.id] ? `Disconnect ${client.name}` : `Connect ${client.name}`}
            >
              {busy === client.id
                ? (connected[client.id] ? 'Disconnecting…' : 'Connecting…')
                : connected[client.id] ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        ))}
      </div>
      {status && (
        <div className={status.kind === 'error' ? 'modal-error' : 'mcp-success'}>
          {status.text}
        </div>
      )}

      <div className="mcp-other">
        <div className="settings-section-hint">
          For any other MCP client ({OTHER_CLIENTS.join(', ')}, …), paste this
          configuration into its MCP settings:
        </div>
        <div className="mcp-config-preview">
          <div className="mcp-config-preview-head">
            MCP configuration
            <button type="button" className="mcp-config-copy" onClick={() => void copyConfig()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre>{config}</pre>
        </div>
      </div>
    </div>
  );
}

async function configureMcp(
  client: McpClientId,
  bridge: ElectronBridge | undefined,
): Promise<McpConfigureResult> {
  if (bridge?.configureMcp) {
    try {
      return await bridge.configureMcp(client);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('No handler registered')) throw err;
    }
  }
  return await api.configureMcp(client) as McpConfigureResult;
}

function clientLabel(id: McpClientId): string {
  return MCP_CLIENTS.find((c) => c.id === id)?.name ?? id;
}
