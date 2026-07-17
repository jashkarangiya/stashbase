import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';

const KILL_GRACE_MS = 1500;
const EXTRACTOR_NICE_PRIORITY = 15;

export function spawnOptionsForExtractor(): {
  detached: boolean;
  stdio: ['ignore', 'pipe', 'pipe'];
  env: NodeJS.ProcessEnv;
} {
  return {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      OMP_NUM_THREADS: process.env.STASHBASE_EXTRACTOR_THREADS ?? '1',
      OPENBLAS_NUM_THREADS: process.env.STASHBASE_EXTRACTOR_THREADS ?? '1',
      MKL_NUM_THREADS: process.env.STASHBASE_EXTRACTOR_THREADS ?? '1',
      VECLIB_MAXIMUM_THREADS: process.env.STASHBASE_EXTRACTOR_THREADS ?? '1',
      NUMEXPR_NUM_THREADS: process.env.STASHBASE_EXTRACTOR_THREADS ?? '1',
      OMP_WAIT_POLICY: 'PASSIVE',
    },
  };
}

export function lowerExtractorPriority(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    os.setPriority(proc.pid, EXTRACTOR_NICE_PRIORITY);
  } catch {
    // Best effort only. Thread limits above are the primary guard; priority
    // lowering is an extra courtesy to keep the Electron UI responsive.
  }
}

export function terminateExtractorTree(proc: ChildProcess): void {
  if (process.platform === 'win32') {
    terminateWindowsTree(proc);
    return;
  }
  sendSignal(proc, 'SIGTERM');
  setTimeout(() => {
    if (proc.exitCode == null && proc.signalCode == null) sendSignal(proc, 'SIGKILL');
  }, KILL_GRACE_MS).unref();
}

/** Node cannot address Windows process groups with a negative PID. `taskkill`
 * is the OS-provided tree primitive; `/T /F` makes cancellation a real tree
 * kill before the scheduler observes the extractor's close event. */
function terminateWindowsTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  const fallback = () => {
    if (proc.exitCode == null && proc.signalCode == null) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  };
  try {
    const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', fallback);
    killer.once('close', (code) => {
      if (code !== 0) fallback();
    });
  } catch {
    fallback();
  }
}

function sendSignal(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}
