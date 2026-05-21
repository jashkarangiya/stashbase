/**
 * Single-terminal sidecar. Spawns a PTY (via `node-pty`) bound to the
 * current space's directory and bridges its stdin/stdout to a
 * WebSocket. One terminal at a time — switching spaces kills the
 * current PTY and the renderer opens a fresh one on demand.
 *
 * Protocol (line-delimited JSON over a single ws):
 *   client → server:
 *     { type: "open",   cwd, cols, rows, run? }  // open + optional first command
 *     { type: "stdin",  data }
 *     { type: "resize", cols, rows }
 *     { type: "close" }
 *   server → client:
 *     { type: "open-ok" }
 *     { type: "open-fail", error }
 *     { type: "data",  data }
 *     { type: "exit",  code, signal }
 */
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import { logger, errorMessage } from './log.ts';
import { getCurrentSpace } from './space.ts';
import { ensureLightTheme } from './claude-settings.ts';

const log = logger('term');

/** Per-platform login shell. POSIX honours `$SHELL` (covers bash / fish
 *  / nu / etc.) with a zsh fallback for the rare case where the env
 *  var is unset. Windows ignores `$SHELL` entirely and uses
 *  `ComSpec` — falling back to PowerShell only if even that's missing
 *  (no user-overridable env var on Windows). */
function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

/** Registry of supported AI CLIs. Adding a new one = one entry here +
 *  it surfaces in the renderer's picker automatically. `install` is
 *  the command we run when the user clicks "Install for me"; `bin` is
 *  what we feed into the PTY once detection succeeds. */
export interface CliDef {
  id: string;
  label: string;
  vendor: string;
  bin: string;           // PATH name we probe + run
  /** Argv appended after `bin` when we launch the CLI inside the
   *  panel. Used to nudge it toward our light terminal — Claude Code
   *  in particular ignores `COLORFGBG` and hardcodes dark-friendly
   *  diff colours, but accepts `--theme light` on the CLI. */
  launchArgs: string[];
  install: string[];     // argv for `npm install -g ...` style invocation
  installHint: string;   // human-readable command (for the install card)
}

export const CLIS: Record<string, CliDef> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    bin: 'claude',
    // No launch flags — Claude Code doesn't accept `--theme` on the
    // CLI. Its theme lives in `~/.claude/settings.json` (or the
    // project-local `.claude/settings.local.json`) and is also
    // switchable in-app via the `/theme` slash command.
    launchArgs: [],
    install: ['install', '-g', '@anthropic-ai/claude-code'],
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    bin: 'codex',
    // Codex doesn't yet expose a CLI-level theme flag; it (mostly)
    // honours COLORFGBG from the spawn env. Track upstream and add
    // a flag here if/when one appears.
    launchArgs: [],
    install: ['install', '-g', '@openai/codex'],
    installHint: 'npm install -g @openai/codex',
  },
};

/** Full shell command to launch a CLI in our panel: `<bin> <args…>`.
 *  Surfaced via `/api/terminal/clis` so the renderer doesn't have to
 *  know which CLIs want which flags. */
export function launchCommandFor(cli: CliDef): string {
  return [cli.bin, ...cli.launchArgs].join(' ');
}

/** Check whether a given CLI's binary is on PATH. Cheap shell probe —
 *  runs `command -v <bin>` in the user's login shell so PATH additions
 *  from `.zprofile` / nvm shims are honoured. */
export function checkCliInstalled(id: string): boolean {
  const cli = CLIS[id];
  if (!cli) return false;
  const shell = defaultShell();
  try {
    const r = spawnSync(shell, ['-l', '-c', `command -v ${cli.bin}`], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

interface OpenMessage {
  type: 'open';
  cols: number;
  rows: number;
  /** Optional command to feed once the shell is ready (e.g. `claude`
   *  or `npm install -g @anthropic-ai/claude-code`). */
  run?: string;
}

interface StdinMessage { type: 'stdin'; data: string }
interface ResizeMessage { type: 'resize'; cols: number; rows: number }
interface CloseMessage { type: 'close' }

type ClientMessage = OpenMessage | StdinMessage | ResizeMessage | CloseMessage;

/** A live PTY <-> WebSocket bridge. Lives for the duration of one
 *  terminal session. Disposing the WS or the PTY tears down the
 *  other side. */
class TerminalSession {
  private pty: IPty | null = null;

  constructor(private ws: WebSocket) {
    ws.on('message', (raw) => this.onMessage(String(raw)));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  private onMessage(text: string): void {
    let msg: ClientMessage;
    try { msg = JSON.parse(text); }
    catch { return; }
    switch (msg.type) {
      case 'open':  this.open(msg); break;
      case 'stdin': this.pty?.write(msg.data); break;
      case 'resize': this.pty?.resize(msg.cols, msg.rows); break;
      case 'close': this.dispose(); break;
    }
  }

  private open(msg: OpenMessage): void {
    if (this.pty) {
      this.send({ type: 'open-fail', error: 'already open' });
      return;
    }
    // cwd is the server-side absolute path to the current space —
    // the client only sees the basename ("Podcasts") so we can't
    // trust the renderer for this. No space open → no terminal.
    const cwd = getCurrentSpace();
    if (!cwd) {
      this.send({ type: 'open-fail', error: 'no space open' });
      return;
    }
    // Heuristic: the renderer's `msg.run` is the full launch command
    // (e.g. `claude --foo`). If it kicks off Claude Code, drop a
    // light-theme hint into the space's `.claude/settings.local.json`
    // so the in-terminal diff blocks aren't dark-on-dark against our
    // light xterm background. No-op when the file already pins a
    // theme — the user's choice always wins.
    if (msg.run && /(^|\s|\/)claude(\s|$)/.test(msg.run)) {
      ensureLightTheme(cwd);
    }
    const shell = defaultShell();
    try {
      this.pty = ptySpawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: Math.max(20, msg.cols),
        rows: Math.max(5, msg.rows),
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          // Strip variables that point back at the Electron node so
          // the user's shell + tools (npm, claude) don't accidentally
          // pick them up.
          ELECTRON_RUN_AS_NODE: undefined,
          // Signal flag the user can gate their shell config on —
          // e.g. skip powerlevel10k / starship / oh-my-zsh prompt
          // theming inside the StashBase panel so screen recordings
          // and screenshots stay clean. Doesn't affect regular
          // terminal usage.
          STASHBASE_TERMINAL: '1',
          // Tell colour-aware CLIs (Claude Code, vim, less, fzf, …)
          // that the terminal has a LIGHT background. Format is
          // `fg;bg` with the standard 16-colour codes — 0 (black) on
          // 15 (white) is the canonical "dark text on light" pair.
          // Without this, most TUIs assume a dark terminal and emit
          // pale text that's nearly invisible against `#fafafa`.
          COLORFGBG: '0;15',
        } as NodeJS.ProcessEnv,
      });
    } catch (err: unknown) {
      log.warn(`spawn failed (shell=${shell}, cwd=${cwd}): ${errorMessage(err)}`);
      this.send({ type: 'open-fail', error: errorMessage(err) });
      return;
    }
    this.pty.onData((data) => this.send({ type: 'data', data }));
    this.pty.onExit(({ exitCode, signal }) => {
      this.send({ type: 'exit', code: exitCode, signal: signal ?? null });
      this.pty = null;
    });
    this.send({ type: 'open-ok' });
    if (msg.run) {
      // Small delay so the shell finishes its login prompt before we
      // pipe in the command — otherwise our text gets mixed with the
      // prompt's redraw and looks weird.
      setTimeout(() => { this.pty?.write(msg.run + '\r'); }, 120);
    }
  }

  private send(obj: unknown): void {
    if (this.ws.readyState !== 1 /* OPEN */) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* ws gone */ }
  }

  dispose(): void {
    if (this.pty) {
      try { this.pty.kill(); } catch { /* already dead */ }
      this.pty = null;
    }
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/** Live PTY sessions — one per chat tab in the renderer. Space switch
 *  iterates this set to tear them all down (the old cwd is meaningless
 *  in the new space). Each session removes itself on `ws.close`. */
const sessions = new Set<TerminalSession>();

export function attachTerminalWebSocket(ws: WebSocket): void {
  const session = new TerminalSession(ws);
  sessions.add(session);
  ws.on('close', () => { sessions.delete(session); });
}

/** Kill every live PTY. Used when the user switches spaces — every
 *  session's cwd no longer makes sense. */
export function killActiveTerminal(): void {
  for (const session of sessions) session.dispose();
  sessions.clear();
}

/** Spawn `npm install -g <package>` for a given CLI outside the PTY,
 *  so the renderer can stream progress as plain text + react on
 *  completion. Returns null if the CLI id isn't known. */
export function spawnGlobalInstall(id: string): ReturnType<typeof childSpawn> | null {
  const cli = CLIS[id];
  if (!cli) return null;
  return childSpawn('npm', cli.install, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}

/** Symmetric counterpart to `spawnGlobalInstall` — `npm uninstall -g
 *  <package>`. We derive the args from the install argv so the
 *  registry stays the single source of truth. */
export function spawnGlobalUninstall(id: string): ReturnType<typeof childSpawn> | null {
  const cli = CLIS[id];
  if (!cli) return null;
  const args = cli.install.map((a) => (a === 'install' ? 'uninstall' : a));
  return childSpawn('npm', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
}
