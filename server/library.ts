/**
 * Library-level metadata: `<kbRoot>/.stashbase/space-metadata.md` — a single
 * markdown file the agent maintains as its working "目录" of the library
 * (what each space is about, what changed recently). Lives in the KB
 * sidecar because it is agent-maintained derived metadata, not user
 * source content. It's outside every space, so the daemon never indexes it; the
 * UI surfaces it via the LibraryPanel as a special library-kind tab.
 *
 * Renamed from the legacy `<kbRoot>/AGENT.md` (which historically mixed
 * "rules" and "目录" roles): STASHBASE.md is now the rules book, and this
 * file is the 目录. `ensureLibraryOverview()` migrates old root-level
 * AGENT.md / space-metadata.md files to the new sidecar path once on boot.
 *
 * The agent updates the file via MCP's `update_space_metadata`; users
 * are expected to ask the agent to make changes rather than edit
 * directly (mirroring the CLAUDE.md pattern). The file is plain
 * markdown — no schema — so the agent has freedom to structure it
 * however reads best.
 *
 * Structured per-space facts (file count, provider, sample headings)
 * are derived on demand from the indexer + filesystem; they're not
 * stored. The agent reads them via `library_info` together with the
 * overview narrative.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger, errorMessage } from './log.ts';
import {
  getEmbedderProvider,
  getKbRoot,
  listKnownSpaces,
  requireSpaceExistsByName,
  validateSpaceName,
} from './space.ts';
import { indexer } from './state.ts';

const log = logger('library');

/** `<kbRoot>/.stashbase/space-metadata.md` — the agent-maintained 目录. */
const FILENAME = 'space-metadata.md';
/** Transitional root-level name from the first rename implementation. */
const ROOT_FILENAME = 'space-metadata.md';
/** Legacy name migrated away from on boot (see `ensureLibraryOverview`). */
const LEGACY_FILENAME = 'AGENT.md';
const RULES_FILENAME = 'STASHBASE.md';

const PLACEHOLDER = `# StashBase Library

(Empty — ask your AI assistant to summarize your spaces here via the
\`update_space_metadata\` MCP tool. The assistant should describe
each space's topic and contents so future searches can route
intelligently.)
`;

function spaceMetadataPath(): string {
  return path.join(getKbRoot(), '.stashbase', FILENAME);
}

function rootSpaceMetadataPath(): string {
  return path.join(getKbRoot(), ROOT_FILENAME);
}

function legacyOverviewPath(): string {
  return path.join(getKbRoot(), LEGACY_FILENAME);
}

function kbRulesPath(): string {
  return path.join(getKbRoot(), RULES_FILENAME);
}

function spaceRulesPath(spaceName: string): string {
  const bad = validateSpaceName(spaceName);
  if (bad) throw new Error(bad);
  return path.join(getKbRoot(), spaceName, RULES_FILENAME);
}

/** Read `<kbRoot>/.stashbase/space-metadata.md`. Returns empty string if missing
 *  (callers decide whether to treat that as "no 目录 yet" or render a
 *  placeholder). */
export function getLibraryOverview(): string {
  try {
    return fs.readFileSync(spaceMetadataPath(), 'utf8');
  } catch {
    return '';
  }
}

/** Overwrite `<kbRoot>/.stashbase/space-metadata.md`. Atomic via `.tmp` + rename so
 *  a partial write doesn't leave the file half-baked if the process dies
 *  mid-write. */
export function setLibraryOverview(content: string): void {
  const target = spaceMetadataPath();
  const tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/** Idempotent boot hook. (1) One-time migration: if the legacy
 *  `<kbRoot>/AGENT.md` or transitional `<kbRoot>/space-metadata.md` still
 *  exists and sidecar `space-metadata.md` doesn't, move it (filename /
 *  location realigns with the design; content unchanged). (2) Writes
 *  a placeholder so the agent has something to extend on its first read,
 *  and users opening the library tab see a "(Empty)" message instead of a
 *  404. */
export function ensureLibraryOverview(): void {
  const target = spaceMetadataPath();
  const legacy = [rootSpaceMetadataPath(), legacyOverviewPath()].find((candidate) => fs.existsSync(candidate));
  if (!fs.existsSync(target) && legacy) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(legacy, target);
      log.info(`migrated ${path.basename(legacy)} → .stashbase/${FILENAME}`);
      return;
    } catch (err: unknown) {
      log.warn(`failed to migrate ${legacy} → ${target}: ${errorMessage(err)}`);
      // fall through — try to seed a placeholder so the UI isn't blank
    }
  }
  if (fs.existsSync(target)) return;
  try {
    setLibraryOverview(PLACEHOLDER);
    log.info(`wrote placeholder ${FILENAME}`);
  } catch (err: unknown) {
    log.warn(`failed to write placeholder ${target}: ${errorMessage(err)}`);
  }
}

export function getKbRules(): string {
  try { return fs.readFileSync(kbRulesPath(), 'utf8'); } catch { return ''; }
}

export function getSpaceRules(spaceName: string): string {
  requireSpaceExistsByName(spaceName);
  try { return fs.readFileSync(spaceRulesPath(spaceName), 'utf8'); } catch { return ''; }
}

export function setSpaceRules(spaceName: string, content: string): void {
  requireSpaceExistsByName(spaceName);
  const target = spaceRulesPath(spaceName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + '.tmp', content, 'utf8');
  fs.renameSync(target + '.tmp', target);
}

export function getResolvedRules(spaceName?: string): string {
  const parts = [getKbRules().trim()];
  if (spaceName) parts.push(getSpaceRules(spaceName).trim());
  return parts.filter(Boolean).join('\n\n');
}

export interface SpaceInfo {
  /** kbRoot-relative space name (`cs183b`, `work/research`). */
  name: string;
  /** Embedder provider configured for this space. */
  provider: 'onnx' | 'openai';
  /** Number of indexed files in this space. */
  file_count: number;
  /** Sample of file names (kbRoot-relative), up to 8. */
  sample_files: string[];
  /** Sample of first-line headings from indexed files, up to 15.
   *  Best-effort: derived from each sampled file's leading H1/H2. */
  sample_headings: string[];
  /** KB rules plus this space's `STASHBASE.md`, concatenated in precedence order. */
  rules: string;
}

export interface LibraryInfo {
  /** `<kbRoot>/.stashbase/space-metadata.md` content (agent-maintained 目录). */
  overview: string;
  /** KB-level maintenance rules from `<kbRoot>/STASHBASE.md`. */
  rules: string;
  /** Per-space structured facts. */
  spaces: SpaceInfo[];
}

/** `SpaceInfo` plus the slice of the library 目录 that talks about this
 *  space. Returned by the `space_info` MCP tool so an agent can dig into
 *  one space without re-reading the whole library payload. */
export interface SpaceInfoFull extends SpaceInfo {
  /** The `## <spaceName>` section of `<kbRoot>/.stashbase/space-metadata.md`
   *  (heading line + body, up to the next `##`), or empty string when
   *  the 目录 has no section for this space. */
  overview_section: string;
}

/** Structured facts for ONE space: provider, file count, a sample of
 *  file paths + their leading headings, and the resolved rules. Asks the
 *  daemon for the indexed file set, then peeks the filesystem for
 *  headings. Validates the space exists first. */
export async function getSpaceInfo(spaceName: string): Promise<SpaceInfo> {
  requireSpaceExistsByName(spaceName);
  const root = getKbRoot();
  const provider = getEmbedderProvider();
  let files: string[] = [];
  try {
    const r = await indexer.listFiles(spaceName);
    files = Object.keys(r).sort();
  } catch (err) {
    log.warn(`space_info: list ${spaceName} failed: ${errorMessage(err)}`);
  }
  const sample_files = files.slice(0, 8);
  const sample_headings = collectHeadings(root, sample_files);
  return {
    name: spaceName,
    provider,
    file_count: files.length,
    sample_files,
    sample_headings,
    rules: getResolvedRules(spaceName),
  };
}

/** `getSpaceInfo` plus the matching slice of the library 目录. */
export async function getSpaceInfoFull(spaceName: string): Promise<SpaceInfoFull> {
  const info = await getSpaceInfo(spaceName);
  return { ...info, overview_section: extractOverviewSection(getLibraryOverview(), spaceName) };
}

/** Build the library-info payload by asking the daemon for indexed
 *  files per space, plus filesystem peek for headings. Cheap enough
 *  to compute on demand — typical libraries are O(100s of files). */
export async function getLibraryInfo(): Promise<LibraryInfo> {
  const overview = getLibraryOverview();
  const rules = getKbRules();
  const spaces: SpaceInfo[] = [];
  for (const name of listKnownSpaces()) {
    spaces.push(await getSpaceInfo(name));
  }
  return { overview, rules, spaces };
}

/** Return the `## <spaceName>` section of the 目录 markdown: from that
 *  heading line up to (but not including) the next `##` of equal-or-
 *  shallower depth, or end of doc. Empty string when no such section.
 *  Heading match is exact on the trimmed text (so `## cs183b` matches
 *  the space `cs183b` but `## cs183b-archive` does not). */
function extractOverviewSection(overview: string, spaceName: string): string {
  if (!overview) return '';
  const lines = overview.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m && m[1].trim() === spaceName) { start = i; break; }
  }
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** First H1/H2 line per file, capped at 15 across the input set.
 *  Skips files larger than 256 KB (don't slurp the universe to find a
 *  heading). Returns the heading text without the leading `#`s. */
function collectHeadings(root: string, kbRelPaths: string[]): string[] {
  const out: string[] = [];
  for (const rel of kbRelPaths) {
    if (out.length >= 15) break;
    const abs = path.join(root, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.size > 256 * 1024) continue;
      const text = fs.readFileSync(abs, 'utf8');
      const heading = firstMarkdownHeading(text);
      if (heading) out.push(heading);
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

function firstMarkdownHeading(md: string): string | null {
  // Scan the first ~50 lines; markdown convention puts the title
  // at or near the top. Avoids reading huge documents fully.
  const lines = md.split('\n', 50);
  for (const line of lines) {
    const m = line.match(/^#{1,2}\s+(.+?)\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}
