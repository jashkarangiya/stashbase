import type { ChildProcess } from 'node:child_process';

const KILL_GRACE_MS = 1500;

export function spawnOptionsForExtractor(): { detached: boolean; stdio: ['ignore', 'pipe', 'pipe'] } {
  return { detached: true, stdio: ['ignore', 'pipe', 'pipe'] };
}

export function terminateExtractorTree(proc: ChildProcess): void {
  sendSignal(proc, 'SIGTERM');
  setTimeout(() => {
    if (proc.exitCode == null && proc.signalCode == null) sendSignal(proc, 'SIGKILL');
  }, KILL_GRACE_MS).unref();
}

function sendSignal(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}
