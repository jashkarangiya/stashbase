/** Safe, account-free checks that an installed native CLI still exposes the
 * protocol entry point required by its Shared Agent Contract adapter. */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import readline from 'node:readline';
import { agentCliEnv, agentCliNeedsShell, commandDir } from './agent-cli.ts';
import type { AgentId } from './agent-contract.ts';

export interface NativeAgentSmokeResult {
  id: AgentId;
  executable: string;
  ok: boolean;
  message: string;
}

type NativeSmokeRunner = (command: string, args: string[]) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

function nativeCliSpawnOptions(executable: string): { env: NodeJS.ProcessEnv; shell: boolean } {
  return {
    env: agentCliEnv({}, [commandDir(executable)]),
    shell: agentCliNeedsShell(executable),
  };
}

export function smokeNativeAgentCli(
  id: AgentId,
  executable: string,
  run: NativeSmokeRunner = (command, args) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], ...nativeCliSpawnOptions(command),
  }),
): NativeAgentSmokeResult {
  const args = id === 'codex' ? ['app-server', '--help'] : ['--version'];
  const result = run(executable, args);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error) {
    return { id, executable, ok: false, message: `${id} native smoke could not start ${executable}: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { id, executable, ok: false, message: `${id} native smoke failed with exit code ${result.status ?? 'unknown'}: ${output || 'no output'}` };
  }
  if (id === 'codex' && !/app-server/i.test(output)) {
    return { id, executable, ok: false, message: 'Codex CLI lacks the required `app-server` command; upgrade or reinstall @openai/codex.' };
  }
  return { id, executable, ok: true, message: `${id} native smoke passed (${executable}).` };
}

/** Exercise each native protocol boundary without a prompt, account fixture,
 * or workspace mutation. Claude must retain SDK stream flags; Codex must
 * complete the app-server initialization RPC. */
export async function smokeNativeAgentProtocol(id: AgentId, executable: string): Promise<NativeAgentSmokeResult> {
  if (id === 'claude') {
    const probe = spawnSync(executable, ['--help'], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'], ...nativeCliSpawnOptions(executable),
    });
    const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
    if (probe.error || probe.status !== 0) {
      return { id, executable, ok: false, message: `Claude CLI help probe failed: ${probe.error?.message ?? `exit code ${probe.status ?? 'unknown'}`}` };
    }
    if (!/--output-format/.test(output) || !/--print/.test(output)) {
      return { id, executable, ok: false, message: 'Claude CLI lacks the stream-json flags required by the Agent SDK bridge; upgrade or reinstall @anthropic-ai/claude-code.' };
    }
    return { id, executable, ok: true, message: `claude native protocol smoke passed (${executable}).` };
  }

  return new Promise((resolve) => {
    const proc = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'], ...nativeCliSpawnOptions(executable),
    });
    let settled = false;
    const finish = async (result: NativeAgentSmokeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      output.close();
      try { proc.stdin.end(); } catch { /* process already exited */ }
      if (proc.exitCode === null && proc.signalCode === null) {
        const closed = new Promise<void>((done) => proc.once('close', () => done()));
        try { proc.kill('SIGTERM'); } catch { /* process already exited */ }
        const forceKill = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* process already exited */ }
        }, 1_000);
        forceKill.unref?.();
        await closed;
        clearTimeout(forceKill);
      }
      resolve(result);
    };
    const timeout = setTimeout(() => { void finish({ id, executable, ok: false, message: 'Codex app-server did not answer initialize within 10 seconds; upgrade or reinstall @openai/codex.' }); }, 10_000);
    timeout.unref?.();
    const output = readline.createInterface({ input: proc.stdout });
    proc.once('error', (error) => { void finish({ id, executable, ok: false, message: `Codex app-server could not start: ${error.message}` }); });
    proc.once('exit', (code) => { void finish({ id, executable, ok: false, message: `Codex app-server exited before initialize (code ${code ?? 'unknown'}).` }); });
    output.on('line', (line) => {
      try {
        const response = JSON.parse(line) as { id?: number; error?: unknown };
        if (response.id !== 1) return;
        if (response.error) {
          void finish({ id, executable, ok: false, message: `Codex app-server rejected initialize: ${JSON.stringify(response.error)}` });
          return;
        }
        void finish({ id, executable, ok: true, message: `codex native protocol smoke passed (${executable}).` });
      } catch {
        // Diagnostics may appear before the JSON-RPC response.
      }
    });
    proc.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'StashBase native smoke', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null },
    } })}\n`);
  });
}
