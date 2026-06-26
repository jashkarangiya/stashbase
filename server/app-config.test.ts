import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stashbase-${label}-`));
}

const home = tmpDir('app-config-home');
process.env.HOME = home;

const cfg = await import('./app-config.ts');

test('writeAppConfigStrict persists config atomically with owner-only mode', () => {
  cfg.writeAppConfigStrict({ apiKey: 'sk-test', terminalCli: 'claude' });

  const file = path.join(home, '.stashbase', 'config.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    apiKey: 'sk-test',
    terminalCli: 'claude',
  });
  if (process.platform !== 'win32') {
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});

test('readAppConfig migrates recentVaults in memory', () => {
  const file = path.join(home, '.stashbase', 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    recentVaults: [{ path: '/tmp/old', openedAt: '2026-01-01T00:00:00.000Z' }],
  }));

  assert.deepEqual(cfg.readAppConfig().recentSpaces, [
    { path: '/tmp/old', openedAt: '2026-01-01T00:00:00.000Z' },
  ]);
});

test('migrateLegacyEmbedderConfig moves legacy OpenAI key to top-level apiKey', () => {
  const file = path.join(home, '.stashbase', 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    embedder: { provider: 'openai', openaiKey: '  sk-legacy  ' },
  }));

  cfg.migrateLegacyEmbedderConfig();

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    embedder: { provider: 'openai' },
    apiKey: 'sk-legacy',
  });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
});

test('migrateLegacyEmbedderConfig keeps an existing top-level apiKey', () => {
  const file = path.join(home, '.stashbase', 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    apiKey: 'sk-current',
    embedder: { provider: 'openai', openaiKey: 'sk-legacy' },
  }));

  cfg.migrateLegacyEmbedderConfig();

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    apiKey: 'sk-current',
    embedder: { provider: 'openai' },
  });
});

test('preference setters use strict writes', () => {
  cfg.setApiKey('  sk-new  ');
  cfg.setGeminiKey('  gemini-new  ');

  const read = cfg.readAppConfig();
  assert.equal(read.apiKey, 'sk-new');
  assert.equal(read.geminiKey, 'gemini-new');
});

test('key setters clear stored credentials when unset', () => {
  cfg.setApiKey('sk-clear-me');
  cfg.setGeminiKey('gemini-clear-me');

  cfg.setApiKey(undefined);
  cfg.setGeminiKey(undefined);

  const read = cfg.readAppConfig();
  assert.equal(read.apiKey, undefined);
  assert.equal(read.geminiKey, undefined);
});
