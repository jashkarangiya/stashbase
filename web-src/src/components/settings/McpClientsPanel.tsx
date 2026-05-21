/**
 * Settings → MCP panel. The body of the old MCP Settings modal,
 * lifted into the unified Settings shell. The "Copied configuration"
 * confirmation still pops as a secondary modal because it carries the
 * full JSON the user just put on their clipboard.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { ModalShell } from '../ModalShell';

type McpClientId =
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'qwen-code'
  | 'cursor'
  | 'void'
  | 'claude-desktop'
  | 'windsurf'
  | 'vscode'
  | 'cherry-studio'
  | 'cline'
  | 'augment'
  | 'roo-code'
  | 'zencoder'
  | 'langchain-langgraph'
  | 'chatgpt'
  | 'other';

interface McpConfigureResult {
  ok: boolean;
  client?: McpClientId;
  file?: string;
  command?: string;
  manual?: unknown;
  mode?: 'file' | 'clipboard';
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
    name: 'OpenAI Codex CLI',
    detail: 'Adds stashbase to ~/.codex/config.toml.',
    restart: 'Restart Codex CLI after connecting.',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    detail: 'Adds stashbase to ~/.gemini/settings.json.',
    restart: 'Restart Gemini CLI after connecting.',
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    detail: 'Adds stashbase to ~/.qwen/settings.json.',
    restart: 'Restart Qwen Code after connecting.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detail: 'Adds stashbase to ~/.cursor/mcp.json.',
    restart: 'Restart Cursor after connecting.',
  },
  {
    id: 'void',
    name: 'Void',
    detail: 'Copies a standard MCP JSON config for Void settings.',
    restart: 'Paste it into Settings -> MCP -> Add MCP Server.',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    detail: 'Adds @stashbase to Claude Desktop config.',
    restart: 'Restart Claude Desktop after connecting.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    detail: 'Copies a standard MCP JSON config for Windsurf settings.',
    restart: 'Paste it into Windsurf MCP settings.',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    detail: 'Copies a standard MCP JSON config for VS Code MCP settings.',
    restart: 'Reload VS Code after connecting.',
  },
  {
    id: 'cherry-studio',
    name: 'Cherry Studio',
    detail: 'Copies STDIO server fields for the Cherry Studio GUI.',
    restart: 'Paste the fields in Settings -> MCP Servers -> Add Server.',
  },
  {
    id: 'cline',
    name: 'Cline',
    detail: 'Copies a standard MCP JSON config for Cline advanced settings.',
    restart: 'Paste it into cline_mcp_settings.json.',
  },
  {
    id: 'augment',
    name: 'Augment',
    detail: 'Copies the Augment advanced settings snippet.',
    restart: 'Paste it into Augment advanced settings.',
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    detail: 'Copies a standard MCP JSON config for Roo Code.',
    restart: 'Paste it into Roo Code MCP global config.',
  },
  {
    id: 'zencoder',
    name: 'Zencoder',
    detail: 'Copies the custom MCP server config for Zencoder.',
    restart: 'Paste it into Add Custom MCP.',
  },
  {
    id: 'langchain-langgraph',
    name: 'LangChain/LangGraph',
    detail: 'Copies the stdio MCP server config for framework integrations.',
    restart: 'Use it in your MCP client or adapter code.',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    detail: 'Copies a generic stdio MCP config for ChatGPT connector setup.',
    restart: 'Paste it into ChatGPT connector settings.',
  },
  {
    id: 'other',
    name: 'Other MCP clients',
    detail: 'Copies a generic stdio MCP config for clients with manual connector setup.',
    restart: 'Paste it into your client connector settings.',
  },
];

export function McpClientsPanel() {
  const [busy, setBusy] = useState<McpClientId | null>(null);
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [copyNotice, setCopyNotice] = useState<{
    title: string;
    usage: string;
    config: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.mcpStatus()
      .then((res) => { if (!cancelled) setConnected(res.clients); })
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
      if (result.mode === 'clipboard') {
        const text = typeof result.manual === 'string'
          ? result.manual
          : JSON.stringify(result.manual ?? {}, null, 2);
        await navigator.clipboard.writeText(text);
        setCopyNotice({
          title: `${clientLabel(client)} Connector`,
          usage: clientUsage(client),
          config: text,
        });
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

  return (
    <>
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
                onClick={() => void connect(client.id)}
                title={connected[client.id] ? `${client.name} is connected. Click to reconnect.` : `Connect ${client.name}`}
              >
                {busy === client.id ? 'Connecting…' : connected[client.id] ? 'Connected' : 'Connector'}
              </button>
            </div>
          ))}
        </div>
        {status && (
          <div className={status.kind === 'error' ? 'modal-error' : 'mcp-success'}>
            {status.text}
          </div>
        )}
      </div>

      {copyNotice && (
        <ModalShell wide onCancel={() => setCopyNotice(null)}>
          <h3>{copyNotice.title}</h3>
          <p className="modal-hint">{copyNotice.usage}</p>
          <div className="mcp-config-preview">
            <div className="mcp-config-preview-head">Copied configuration</div>
            <pre>{copyNotice.config}</pre>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn primary"
              onClick={() => setCopyNotice(null)}
            >OK</button>
          </div>
        </ModalShell>
      )}
    </>
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

function clientUsage(id: McpClientId): string {
  switch (id) {
    case 'void':
      return 'Copied. In Void, open Settings -> MCP -> Add MCP Server, then paste this JSON configuration.';
    case 'windsurf':
      return 'Copied. Open Windsurf MCP settings and paste this JSON configuration.';
    case 'vscode':
      return 'Copied. Open your VS Code MCP-compatible extension settings and paste this JSON configuration.';
    case 'cherry-studio':
      return 'Copied. In Cherry Studio, go to Settings -> MCP Servers -> Add Server, choose STDIO, then use these fields.';
    case 'cline':
      return 'Copied. In Cline, open MCP Servers -> Installed -> Advanced MCP Settings, then paste this into cline_mcp_settings.json.';
    case 'augment':
      return 'Copied. In Augment, open Advanced settings.json and merge this snippet into your settings.';
    case 'roo-code':
      return 'Copied. In Roo Code, open Settings -> MCP Servers -> Edit Global Config, then paste this JSON configuration.';
    case 'zencoder':
      return 'Copied. In Zencoder, open Tools -> Add Custom MCP, paste this custom server config, then install/save it.';
    case 'langchain-langgraph':
      return 'Copied. Use this stdio server config with your LangChain/LangGraph MCP adapter or client setup.';
    case 'chatgpt':
      return 'Copied. Paste this stdio server config into ChatGPT connector settings.';
    case 'other':
      return 'Copied. Paste this standard stdio MCP server configuration into your client connector settings.';
    default:
      return 'Copied. Paste this MCP connector configuration into the client settings.';
  }
}
