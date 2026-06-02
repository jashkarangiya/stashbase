/**
 * MFS sidecar daemon manager.
 *
 * Spawns `python/stashbase_daemon.py` once per server process, talks to
 * it over stdin/stdout in line-delimited JSON, and matches replies back
 * to requests by an auto-incrementing id. Auto-respawns if the daemon
 * dies (in-flight requests get rejected with the exit info).
 *
 * The daemon is anchored at the **KB root**: every space lives under
 * `<kb_root>/<space>/...` and one `milvus.db` at
 * `<kb_root>/.stashbase/store/milvus.db` holds every collection. The
 * Node side ensures each known space is `bind_space`-ed (recorded
 * here so a respawn can replay them).
 *
 * Python lives in `<project>/python/.venv/bin/python` after the user
 * runs `pnpm setup:python`. In packaged Electron a portable Python
 * runtime is bundled via `extraResources` and the path is overridden
 * via `STASHBASE_PYTHON` env var (see `electron/main.cjs`).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { logger } from './log.ts';

const log = logger('mfs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.STASHBASE_APP_ROOT
  ? path.resolve(process.env.STASHBASE_APP_ROOT)
  : path.resolve(__dirname, '..');
const RESOURCES_ROOT = process.env.STASHBASE_RESOURCES_PATH
  ? path.resolve(process.env.STASHBASE_RESOURCES_PATH)
  : PROJECT_ROOT;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface BindSpaceArgs {
  provider: 'openai';
  apiKey?: string;
  model?: string;
  dimension?: number;
}

/** Singleton-ish handle. Use `getDaemon()` to access. */
class MfsDaemon extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyP: Promise<void> | null = null;
  /** Bumps every time we (re)spawn the Python process. Callers that
   *  cache "I already configured this daemon" state can compare against
   *  the value at config time — if it changed, re-issue the config op. */
  private generation = 0;

  /** KB-root passed to every Python child via `--kb-root`. Configured
   *  exactly once via `configure()` before the first `ensureReady()`. */
  private kbRoot: string | null = null;

  /** Every space the server has asked us to bind. Keyed by the
   *  kb-root-relative space name (e.g. `cs183b` or `work/research`).
   *  Persisted in memory so we can replay them after a respawn — the
   *  Python child loses its `_bindings` map on exit. */
  private bindings = new Map<string, BindSpaceArgs>();

  /** Set the KB root before the first spawn. Must be called once at
   *  startup; later spawns reuse the same value. Idempotent on the
   *  same path. */
  configure(opts: { kbRoot: string }): void {
    if (this.kbRoot !== null && this.kbRoot !== opts.kbRoot) {
      if (this.proc || this.readyP) {
        throw new Error(`kbRoot already configured to ${this.kbRoot}; close daemon before reconfigure`);
      }
      this.bindings.clear();
    }
    this.kbRoot = opts.kbRoot;
  }

  /** Spawn (idempotent) and resolve once the daemon emits `ready`. */
  async ensureReady(): Promise<void> {
    if (this.readyP) return this.readyP;
    this.readyP = this.spawnAndWait();
    return this.readyP;
  }

  /** Opaque token identifying the current Python process. Increments on
   *  every respawn. Callers should treat as a black-box equality check. */
  currentGeneration(): number {
    return this.generation;
  }

  /** Issue a `bind_space` op, recording the binding for replay on a
   *  later respawn. Safe to call repeatedly with the same args (the
   *  daemon-side op is idempotent). */
  async bindSpace(space: string, cfg: BindSpaceArgs): Promise<void> {
    this.bindings.set(space, cfg);
    await this.call('bind_space', {
      space,
      provider: cfg.provider,
      ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.dimension ? { dimension: cfg.dimension } : {}),
    });
  }

  /** Drop the renderer-side binding entry AND ask the daemon to stop
   *  routing new files for the space. Existing rows stay searchable
   *  until explicit delete. */
  async unbindSpace(space: string): Promise<void> {
    this.bindings.delete(space);
    if (this.proc) {
      try { await this.call('unbind_space', { space }); }
      catch (err) { log.warn(`unbind_space ${space} failed: ${(err as Error).message}`); }
    }
  }

  /** Snapshot of every space currently bound on the renderer side.
   *  Used by the boot path to seed all spaces under kbRoot before the
   *  first search. */
  knownBindings(): ReadonlyMap<string, BindSpaceArgs> {
    return this.bindings;
  }

  private spawnAndWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.kbRoot) {
        reject(new Error('MfsDaemon.configure({ kbRoot }) must be called before ensureReady'));
        return;
      }
      const daemon = resolveDaemonCommand(this.kbRoot);
      log.info(`spawning ${daemon.command} ${daemon.args.join(' ')}`);
      const proc = spawn(daemon.command, daemon.args, {
        cwd: daemon.cwd,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // Milvus Lite spins up its own gRPC server in-process; pymilvus
          // client's default keepalive ping (every 10s) is too aggressive
          // for that loopback server and trips a `ENHANCE_YOUR_CALM`
          // GOAWAY ~every minute. The reconnect is transparent — only
          // the log is noisy. Drop gRPC's INFO chatter to ERROR.
          GRPC_VERBOSITY: process.env.GRPC_VERBOSITY ?? 'ERROR',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      this.generation += 1;

      const lines = readline.createInterface({ input: proc.stdout });
      lines.on('line', (line) => this.onLine(line, resolve));

      proc.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(`[mfs/py] ${chunk.toString()}`);
      });

      proc.on('exit', (code, signal) => {
        const err = new Error(
          `MFS daemon exited (code=${code}, signal=${signal ?? 'null'})`,
        );
        log.warn(`${err.message}`);
        for (const slot of this.pending.values()) slot.reject(err);
        this.pending.clear();
        this.proc = null;
        this.readyP = null;
        // If we never got `ready`, surface the failure to the caller.
        reject(err);
      });
    });
  }

  private onLine(line: string, readyResolve: () => void): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch {
      log.warn(`non-JSON line from daemon: ${line}`);
      return;
    }
    if ('event' in msg) {
      // Namespaced event prefix so a daemon-side `{event:"error"}` doesn't
      // collide with EventEmitter's bare 'error' (which is fatal without
      // a listener).
      this.emit(`daemon:${msg.event}`, msg);
      if (msg.event === 'ready') {
        log.info(`daemon ready: kb_root=${msg.kb_root}`);
        // Replay every space binding the renderer has seen so far so a
        // crash + respawn doesn't strand the daemon empty-handed. Fire-
        // and-forget; if any individual rebind fails, the next user op
        // for that space surfaces the error.
        if (this.bindings.size > 0) {
          for (const [space, cfg] of this.bindings) {
            this.call('bind_space', {
              space,
              provider: cfg.provider,
              ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
              ...(cfg.model ? { model: cfg.model } : {}),
              ...(cfg.dimension ? { dimension: cfg.dimension } : {}),
            }).catch((err) => log.warn(`rebind ${space} after respawn failed: ${(err as Error).message}`));
          }
        }
        readyResolve();
      } else if (msg.event === 'starting') {
        log.info(`daemon starting, pid=${msg.pid}`);
      } else if (msg.event === 'error') {
        const hint = /No module named/i.test(msg.error ?? '')
          ? '\n  → Looks like the Python sidecar deps aren\'t installed. Run: pnpm setup:python'
          : '';
        log.warn(`daemon error in ${msg.phase}: ${msg.error}${hint}`);
      }
      return;
    }
    const id = msg.id;
    const slot = this.pending.get(id);
    if (!slot) {
      log.warn(`reply with unknown id=${id}`);
      return;
    }
    this.pending.delete(id);
    if (msg.ok) slot.resolve(msg.result);
    else slot.reject(new Error(msg.error ?? 'daemon error'));
  }

  /** Send one op and await the matching reply. Awaits `ensureReady` first. */
  async call<T = unknown>(op: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureReady();
    if (!this.proc) throw new Error('MFS daemon not running');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc!.stdin.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.readyP = null;
    // Reject any in-flight calls so awaiters don't hang forever once
    // the process is gone.
    const inflight = [...this.pending.values()];
    this.pending.clear();
    const closeErr = new Error('MFS daemon closing');
    for (const slot of inflight) slot.reject(closeErr);
    proc.stdin.end();
    // Escalation ladder: graceful EOF → SIGTERM → SIGKILL. The Python
    // signal handler can't run while the main thread is blocked inside
    // a C extension (Milvus Lite, ONNX), so a stuck daemon won't die
    // on SIGTERM. SIGKILL can't be caught — guarantees the slot frees
    // up so the next bind doesn't trip on a stale flock.
    await new Promise<void>((resolve) => {
      let exited = false;
      proc.once('exit', () => { exited = true; resolve(); });
      setTimeout(() => {
        if (exited) return;
        try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      }, 1500);
      setTimeout(() => {
        if (exited) return;
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        setTimeout(() => { if (!exited) resolve(); }, 500);
      }, 3000);
    });
  }
}

/** Locate the Python binary. Precedence:
 *   1. ``STASHBASE_PYTHON`` env (used by packaged Electron to point at the
 *      bundled portable runtime under ``process.resourcesPath``).
 *   2. ``python/.venv/bin/python`` populated by ``pnpm setup:python``.
 *   3. system ``python3`` — last resort, gives a clearer error if mfs-cli
 *      isn't installed than just failing to spawn. */
function resolvePythonBin(): string {
  const bin = (() => {
    if (process.env.STASHBASE_PYTHON) return process.env.STASHBASE_PYTHON;
    const packagedRuntime = path.join(RESOURCES_ROOT, 'python', 'runtime', 'bin', 'python');
    if (existsSync(packagedRuntime)) return packagedRuntime;
    const packagedVenv = path.join(RESOURCES_ROOT, 'python', '.venv', 'bin', 'python');
    if (existsSync(packagedVenv)) return packagedVenv;
    const venvBin = path.join(PROJECT_ROOT, 'python', '.venv', 'bin', 'python');
    if (existsSync(venvBin)) return venvBin;
    log.warn('python/.venv not found, falling back to system `python3`');
    return 'python3';
  })();

  const probe = spawnSync(bin, ['-c', 'import mfs, openai, numpy'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    const lastErrLine = (probe.stderr || '').trim().split('\n').pop() ?? '';
    throw new Error(
      `Python sidecar deps missing at ${bin}\n` +
        `  ${lastErrLine}\n` +
        `  → fix: pnpm setup:python`,
    );
  }
  return bin;
}

function resolveDaemonCommand(kbRoot: string): { command: string; args: string[]; cwd: string } {
  const binary = resolveDaemonBinary();
  if (binary) {
    return { command: binary, args: ['--kb-root', kbRoot], cwd: path.dirname(binary) };
  }
  const pythonBin = resolvePythonBin();
  const script = resolvePythonDaemonScript();
  return { command: pythonBin, args: ['-u', script, '--kb-root', kbRoot], cwd: PROJECT_ROOT };
}

function resolveDaemonBinary(): string | null {
  // PyInstaller --onedir output: `python/sidecar/stashbase-daemon/stashbase-daemon`
  // (the outer name is the directory, the inner name is the executable).
  const candidates = [
    process.env.STASHBASE_DAEMON_BIN,
    path.join(RESOURCES_ROOT, 'python', 'sidecar', 'stashbase-daemon', 'stashbase-daemon'),
    path.join(PROJECT_ROOT, 'python', 'sidecar', 'stashbase-daemon', 'stashbase-daemon'),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolvePythonDaemonScript(): string {
  const candidates = [
    path.join(RESOURCES_ROOT, 'python', 'stashbase_daemon.py'),
    path.join(PROJECT_ROOT, 'python', 'stashbase_daemon.py'),
  ];
  const script = candidates.find((candidate) => existsSync(candidate));
  if (!script) {
    throw new Error(`Python sidecar script not found. Looked in: ${candidates.join(', ')}`);
  }
  return script;
}

let singleton: MfsDaemon | null = null;
export function getDaemon(): MfsDaemon {
  if (!singleton) singleton = new MfsDaemon();
  return singleton;
}
