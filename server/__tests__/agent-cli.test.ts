import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentCliExecutableCandidates,
  isWindowsLaunchableAgentCliPath,
} from '../agent-cli.ts';

test('Windows agent CLI discovery prefers launchable shims over extensionless npm files', () => {
  assert.deepEqual(agentCliExecutableCandidates('codex', 'win32'), [
    'codex.exe',
    'codex.cmd',
    'codex.bat',
    'codex.com',
    'codex',
  ]);
  assert.equal(isWindowsLaunchableAgentCliPath('C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex'), false);
  assert.equal(isWindowsLaunchableAgentCliPath('C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex.cmd'), true);
});

test('non-Windows agent CLI discovery keeps bare command lookup', () => {
  assert.deepEqual(agentCliExecutableCandidates('codex', 'darwin'), ['codex']);
});
