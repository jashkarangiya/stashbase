import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentCliSpec {
  name: string;
  envNames: string[];
  logLabel: string;
}

const CLI_SEARCH_DIRS = [
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.local', 'bin'),
  ...(process.platform === 'win32'
    ? [
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm') : '',
      ]
    : []),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
];

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.com', '.exe', '.cmd', '.bat']);

export function isWindowsLaunchableAgentCliPath(file: string): boolean {
  return WINDOWS_EXECUTABLE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    if (process.platform === 'win32') {
      return fs.statSync(file).isFile() && isWindowsLaunchableAgentCliPath(file);
    }
    return true;
  } catch {
    return false;
  }
}

function expandHome(candidate: string): string {
  if (candidate === '~') return os.homedir();
  if (candidate.startsWith('~/')) return path.join(os.homedir(), candidate.slice(2));
  return candidate;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

export function agentCliPath(extraDirs: string[] = [], basePath = process.env.PATH ?? ''): string {
  return unique([
    ...extraDirs,
    ...CLI_SEARCH_DIRS,
    ...basePath.split(path.delimiter),
  ]).join(path.delimiter);
}

export function agentCliEnv(extraEnv: NodeJS.ProcessEnv = {}, extraDirs: string[] = []): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extraEnv,
    PATH: agentCliPath(extraDirs, extraEnv.PATH ?? process.env.PATH ?? ''),
    ELECTRON_RUN_AS_NODE: undefined,
  } as NodeJS.ProcessEnv;
}

export function agentCliExecutableCandidates(name: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [name];
  const ext = path.extname(name);
  if (ext) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.com`, name];
}

export function resolveAgentCli(spec: AgentCliSpec, warn?: (message: string) => void): string | null {
  const explicit = spec.envNames
    .map((name) => process.env[name])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  for (const candidate of explicit) {
    const resolved = path.resolve(expandHome(candidate));
    if (isExecutable(resolved)) return resolved;
    warn?.(`${spec.logLabel} binary override is not executable: ${candidate}`);
  }

  for (const dir of agentCliPath().split(path.delimiter)) {
    for (const name of agentCliExecutableCandidates(spec.name)) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return null;
}

export function agentCliNeedsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

export function commandDir(command: string): string {
  return command.includes('/') || command.includes('\\') ? path.dirname(command) : '';
}
