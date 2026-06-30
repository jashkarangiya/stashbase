/**
 * App-level config persistence — the single `~/.stashbase/config.json`
 * (0600). This module owns the file primitives and the user-preference
 * accessors (API keys, terminal CLI, embedder provider); `folder.ts`
 * reuses the same primitives for library membership. Extracted from folder.ts:
 * credentials and preferences have nothing to do with the folder registry, and
 * routes that only need a key shouldn't import the whole window-context machinery.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger, errorMessage } from './log.ts';

const log = logger('app-config');

const CONFIG_DIR = path.join(os.homedir(), '.stashbase');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface RecentFolder {
  path: string;
  openedAt: string;
  description?: string;
  descriptionSource?: 'user' | 'ai';
  descriptionUpdatedAt?: string;
}

/** V1 is OpenAI-only. Kept as a one-member type so the surrounding
 *  config plumbing reads clearly and a future provider re-introduction
 *  has an obvious seam. */
export type EmbedderProvider = 'openai';

export interface AppConfigFile {
  /** NOTE: the legacy `folderHome` field is no longer read or written — the
   *  configurable folder-home concept is gone. Existing configs may still carry
   *  it on disk; it is ignored. The default folder home is now a fixed,
   *  non-configurable path (see `folder.ts:getFolderHome`). */
  recentFolders?: RecentFolder[];
  /** Legacy field from when the concept was called "vault". Read for
   *  back-compat (existing users keep their recents) and rewritten as
   *  `recentFolders` on the next write. */
  recentVaults?: RecentFolder[];
  apiKey?: string;
  /** Embedder provider is library-wide (one collection family per
   *  provider on the daemon). `openaiKey` is a leftover from the very
   *  first global-config schema — its content moved into the top-level
   *  `apiKey` on read; we keep the type loose so legacy reads don't
   *  trip the parser. */
  embedder?: { provider?: EmbedderProvider; openaiKey?: string };
  /** Legacy last-used agent field. No longer written or read by the
   *  chat panel; kept so old config files parse without churn. */
  terminalCli?: string;
  /** Set once the bundled built-in folder (the product manual) has been
   *  seeded into a fresh folder home on first launch. A latch, not live state:
   *  it stays true even if the user later deletes the folder, so we
   *  never recreate it behind their back. See `seedBuiltinFolder`. */
  builtinSeeded?: boolean;
}

export function readAppConfig(): AppConfigFile {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // Migrate `recentVaults` → `recentFolders` on read so legacy users
    // don't lose their list when the rename rolls out.
    if (parsed.recentVaults && !parsed.recentFolders) {
      parsed.recentFolders = parsed.recentVaults;
    }
    return parsed as AppConfigFile;
  } catch {
    return {};
  }
}

// SINGLE-WRITER CONSTRAINT: only the web server process writes the
// config (the :8090 port bind already guarantees one instance). The MCP
// host (mcp/server.ts) must stay read-only — read-modify-write here is
// not cross-process safe (last write wins), and the tmp+rename below
// only protects against torn writes, not lost updates. If the MCP host
// ever needs to write config, add real cross-process locking first.
export function writeAppConfig(cfg: AppConfigFile): void {
  try {
    writeAppConfigStrict(cfg);
  } catch (err: any) {
    log.warn(`failed to persist config: ${errorMessage(err)}`);
  }
}

export function writeAppConfigStrict(cfg: AppConfigFile): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    // 0600 — config may carry API keys; keep it owner-only.
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export function getApiKey(): string | undefined {
  const k = readAppConfig().apiKey;
  return k && typeof k === 'string' && k.trim() ? k : undefined;
}

/** Persist (or clear, when `key` is falsy) the user's OpenAI key. */
export function setApiKey(key: string | undefined): void {
  const cfg = readAppConfig();
  if (key && key.trim()) cfg.apiKey = key.trim();
  else delete cfg.apiKey;
  writeAppConfigStrict(cfg);
}

/** The embedder provider. V1 is fixed to OpenAI — there's no switching,
 *  so this is a constant. Kept as a function so call sites that surface
 *  "which provider" in info payloads don't need to special-case. */
export function getEmbedderProvider(): EmbedderProvider {
  return 'openai';
}

/** One-time upgrade from the very first global-embedder schema, when
 *  the OpenAI key lived under `embedder.openaiKey` instead of the
 *  top-level `apiKey`. Migrates that key forward and drops the
 *  sub-field. Safe to call repeatedly. */
export function migrateLegacyEmbedderConfig(): void {
  const cfg = readAppConfig();
  if (!cfg.embedder?.openaiKey) return;
  const oldKey = cfg.embedder.openaiKey;
  if (typeof oldKey === 'string' && oldKey.trim() && !cfg.apiKey) {
    cfg.apiKey = oldKey.trim();
  }
  delete cfg.embedder.openaiKey;
  writeAppConfig(cfg);
  log.info('migrated legacy embedder.openaiKey into top-level apiKey');
}
