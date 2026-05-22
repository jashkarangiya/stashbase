import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(process.cwd());

const MCP_ENTRY = fs.existsSync(path.join(APP_ROOT, 'dist', 'mcp', 'server.mjs'))
  ? path.join(APP_ROOT, 'dist', 'mcp', 'server.mjs')
  : path.join(APP_ROOT, 'mcp', 'server.ts');

const JSON_MCP_CONFIG_FILES: Record<string, () => string> = {
  'gemini-cli': () => path.join(os.homedir(), '.gemini', 'settings.json'),
  'qwen-code': () => path.join(os.homedir(), '.qwen', 'settings.json'),
  cursor: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
};

export function mount(app: express.Express): void {
  app.get('/api/mcp/status', (_req, res) => {
    try {
      const wrapper = currentMcpWrapper();
      res.json({
        clients: Object.fromEntries(
          MCP_CLIENT_IDS.map((client) => [client, isMcpClientConnected(client, wrapper)]),
        ),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/mcp/configure', (req, res) => {
    const client = typeof req.body?.client === 'string' ? req.body.client : '';
    try {
      res.json({ ok: true, ...configureMcpClient(client) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: message });
    }
  });

  app.post('/api/mcp/disconnect', (req, res) => {
    const client = typeof req.body?.client === 'string' ? req.body.client : '';
    try {
      res.json({ ok: true, ...disconnectMcpClient(client) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: message });
    }
  });
}

const MCP_CLIENT_IDS = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'qwen-code',
  'cursor',
  'claude-desktop',
];

function configureMcpClient(client: string): Record<string, unknown> {
  if (!fs.existsSync(MCP_ENTRY)) {
    throw new Error(`MCP entry missing: ${MCP_ENTRY}`);
  }

  const wrapper = writeMcpWrapper();
  if (client === 'claude-desktop') {
    if (process.platform !== 'darwin') {
      throw new Error('Claude Desktop auto configuration is currently supported on macOS only.');
    }
    const file = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
    configureJsonMcp(file, getMcpServerConfig(wrapper));
    return { client, file, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'file' };
  }
  if (client === 'claude-code') {
    const file = path.join(os.homedir(), '.claude.json');
    configureJsonMcp(file, { type: 'stdio', command: wrapper });
    return { client, file, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'file' };
  }
  if (client === 'codex-cli') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    configureCodex(file, wrapper);
    return { client, file, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'file' };
  }
  if (client in JSON_MCP_CONFIG_FILES) {
    const file = JSON_MCP_CONFIG_FILES[client]();
    configureJsonMcp(file, getMcpServerConfig(wrapper));
    return { client, file, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'file' };
  }
  if (clipboardOnlyClient(client)) {
    return { client, command: wrapper, manual: getMcpManualConfig(client, wrapper), mode: 'clipboard' };
  }
  throw new Error(`Unknown MCP client: ${client}`);
}

function disconnectMcpClient(client: string): Record<string, unknown> {
  if (client === 'claude-desktop') {
    if (process.platform !== 'darwin') {
      throw new Error('Claude Desktop auto configuration is currently supported on macOS only.');
    }
    const file = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
    removeJsonMcp(file);
    return { client, file, mode: 'file' };
  }
  if (client === 'claude-code') {
    const file = path.join(os.homedir(), '.claude.json');
    removeJsonMcp(file);
    return { client, file, mode: 'file' };
  }
  if (client === 'codex-cli') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    removeCodex(file);
    return { client, file, mode: 'file' };
  }
  if (client in JSON_MCP_CONFIG_FILES) {
    const file = JSON_MCP_CONFIG_FILES[client]();
    removeJsonMcp(file);
    return { client, file, mode: 'file' };
  }
  if (clipboardOnlyClient(client)) {
    throw new Error(`${client} configuration is managed outside StashBase. Remove the pasted stashbase server from that client.`);
  }
  throw new Error(`Unknown MCP client: ${client}`);
}

function currentMcpWrapper(): string {
  return path.join(os.homedir(), '.stashbase', 'bin', 'stashbase-mcp');
}

function isMcpClientConnected(client: string, wrapper: string): boolean {
  if (client === 'claude-desktop') {
    if (process.platform !== 'darwin') return false;
    const file = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
    return jsonHasStashbaseCommand(file, wrapper);
  }
  if (client === 'claude-code') {
    const file = path.join(os.homedir(), '.claude.json');
    const config = readJsonObject(file);
    if (!config) return false;
    const servers = config.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
    const stashbase = (servers as Record<string, unknown>).stashbase;
    return !!(
      stashbase &&
      typeof stashbase === 'object' &&
      !Array.isArray(stashbase) &&
      (stashbase as Record<string, unknown>).command === wrapper
    );
  }
  if (client === 'codex-cli') {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    if (!fs.existsSync(file)) return false;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.includes('[mcp_servers.stashbase]') && raw.includes(`command = ${JSON.stringify(wrapper)}`);
  }
  if (client in JSON_MCP_CONFIG_FILES) {
    return jsonHasStashbaseCommand(JSON_MCP_CONFIG_FILES[client](), wrapper);
  }
  return false;
}

function jsonHasStashbaseCommand(file: string, wrapper: string): boolean {
  const config = readJsonObject(file);
  if (!config) return false;
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
  const stashbase = (servers as Record<string, unknown>).stashbase;
  return !!(
    stashbase &&
    typeof stashbase === 'object' &&
    !Array.isArray(stashbase) &&
    (stashbase as Record<string, unknown>).command === wrapper
  );
}

function clipboardOnlyClient(client: string): boolean {
  return [
    'chatgpt',
    'void',
    'windsurf',
    'vscode',
    'cherry-studio',
    'cline',
    'augment',
    'roo-code',
    'zencoder',
    'langchain-langgraph',
    'other',
  ].includes(client);
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeMcpWrapper(): string {
  const binDir = path.join(os.homedir(), '.stashbase', 'bin');
  const wrapper = path.join(binDir, 'stashbase-mcp');
  const resourcesPath = process.env.STASHBASE_RESOURCES_PATH || APP_ROOT;
  const isBuilt = MCP_ENTRY.endsWith(path.join('dist', 'mcp', 'server.mjs'));
  const commandLines = isBuilt
    ? [
        'export ELECTRON_RUN_AS_NODE=1',
        `exec ${shellQuote(process.execPath)} ${shellQuote(MCP_ENTRY)} "$@"`,
      ]
    : [
        `exec ${shellQuote(path.join(APP_ROOT, 'node_modules', '.bin', 'tsx'))} ${shellQuote(MCP_ENTRY)} "$@"`,
      ];
  const content = [
    '#!/bin/sh',
    'set -eu',
    `export STASHBASE_APP_ROOT=${shellQuote(APP_ROOT)}`,
    `export STASHBASE_RESOURCES_PATH=${shellQuote(resourcesPath)}`,
    ...commandLines,
    '',
  ].join('\n');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(wrapper, content, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function configureJsonMcp(file: string, serverConfig: Record<string, unknown>): void {
  const config = readJsonObject(file);
  if (!config) throw new Error(`Couldn't parse ${file}; leaving it untouched.`);
  const currentServers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? config.mcpServers as Record<string, unknown>
      : {};
  config.mcpServers = {
    ...currentServers,
    stashbase: serverConfig,
  };
  writeJson(file, config);
}

function removeJsonMcp(file: string): void {
  if (!fs.existsSync(file)) return;
  const config = readJsonObject(file);
  if (!config) throw new Error(`Couldn't parse ${file}; leaving it untouched.`);
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  delete (servers as Record<string, unknown>).stashbase;
  if (Object.keys(servers as Record<string, unknown>).length === 0) {
    delete config.mcpServers;
  }
  writeJson(file, config);
}

function replaceTomlTable(raw: string, tableName: string, block: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  const headerRe = /^\s*\[([^\]]+)\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRe);
    if (!match || match[1] !== tableName) {
      out.push(lines[i]);
      continue;
    }
    i += 1;
    while (i < lines.length) {
      const nextMatch = lines[i].match(headerRe);
      if (nextMatch && nextMatch[1] !== tableName && !nextMatch[1].startsWith(`${tableName}.`)) {
        break;
      }
      i += 1;
    }
    i -= 1;
  }
  const trimmed = out.join('\n').trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ''}${block}\n`;
}

function configureCodex(file: string, wrapper: string): void {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = [
    '[mcp_servers.stashbase]',
    `command = ${JSON.stringify(wrapper)}`,
  ].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, replaceTomlTable(raw, 'mcp_servers.stashbase', block));
}

function removeCodex(file: string): void {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, removeTomlTable(raw, 'mcp_servers.stashbase'));
}

function removeTomlTable(raw: string, tableName: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  const headerRe = /^\s*\[([^\]]+)\]\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRe);
    if (!match || match[1] !== tableName) {
      out.push(lines[i]);
      continue;
    }
    i += 1;
    while (i < lines.length) {
      const nextMatch = lines[i].match(headerRe);
      if (nextMatch && nextMatch[1] !== tableName && !nextMatch[1].startsWith(`${tableName}.`)) {
        break;
      }
      i += 1;
    }
    i -= 1;
  }
  const trimmed = out.join('\n').trimEnd();
  return trimmed ? `${trimmed}\n` : '';
}

function getMcpServerConfig(wrapper: string): Record<string, unknown> {
  return { command: wrapper };
}

function getStandardMcpJson(wrapper: string): Record<string, unknown> {
  return {
    mcpServers: {
      stashbase: {
        command: wrapper,
      },
    },
  };
}

function getMcpManualConfig(client: string, wrapper: string): Record<string, unknown> {
  if (client === 'cherry-studio') {
    return {
      kind: 'gui',
      name: 'stashbase',
      type: 'STDIO',
      command: wrapper,
      arguments: [],
    };
  }
  if (client === 'augment') {
    return {
      'augment.advanced': {
        mcpServers: [
          {
            name: 'stashbase',
            command: wrapper,
          },
        ],
      },
    };
  }
  if (client === 'zencoder') {
    return {
      command: wrapper,
      args: [],
    };
  }
  return getStandardMcpJson(wrapper);
}
