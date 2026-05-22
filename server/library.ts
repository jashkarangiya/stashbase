/**
 * Library-level metadata: `<kbRoot>/AGENT.md` — a single markdown file
 * the agent maintains as its working map of the library. Sits **outside**
 * every space, so it's not indexed (the daemon walks per-space dirs) and
 * doesn't show up in any sidebar; the UI surfaces it via a chrome-strip
 * button that opens it as a special read-only tab.
 *
 * The agent updates the file via MCP's `update_library_overview`; users
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
} from './space.ts';
import { getDaemon } from './mfs-daemon.ts';

const log = logger('library');

const FILENAME = 'AGENT.md';

const PLACEHOLDER = `# StashBase Library

(Empty — ask your AI assistant to summarize your spaces here via the
\`update_library_overview\` MCP tool. The assistant should describe
each space's topic and contents so future searches can route
intelligently.)
`;

function agentMdPath(): string {
  return path.join(getKbRoot(), FILENAME);
}

/** Read `<kbRoot>/AGENT.md`. Returns empty string if missing (callers
 *  decide whether to treat that as "no overview yet" or render a
 *  placeholder). */
export function getLibraryOverview(): string {
  try {
    return fs.readFileSync(agentMdPath(), 'utf8');
  } catch {
    return '';
  }
}

/** Overwrite `<kbRoot>/AGENT.md`. Atomic via `.tmp` + rename so a
 *  partial write doesn't leave the file half-baked if the process
 *  dies mid-write. */
export function setLibraryOverview(content: string): void {
  const target = agentMdPath();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/** Idempotent boot hook. Writes a placeholder so the agent has
 *  something to extend on its first read, and users opening the
 *  library tab see a "(Empty)" message instead of a 404. */
export function ensureLibraryOverview(): void {
  const target = agentMdPath();
  try {
    fs.accessSync(target);
    return;
  } catch {
    /* not present — fall through to create */
  }
  try {
    setLibraryOverview(PLACEHOLDER);
    log.info(`wrote placeholder ${FILENAME}`);
  } catch (err: unknown) {
    log.warn(`failed to write placeholder ${target}: ${errorMessage(err)}`);
  }
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
}

export interface LibraryInfo {
  /** `<kbRoot>/AGENT.md` content (agent-maintained narrative). */
  overview: string;
  /** Per-space structured facts. */
  spaces: SpaceInfo[];
}

/** Build the library-info payload by asking the daemon for indexed
 *  files per space, plus filesystem peek for headings. Cheap enough
 *  to compute on demand — typical libraries are O(100s of files). */
export async function getLibraryInfo(): Promise<LibraryInfo> {
  const overview = getLibraryOverview();
  const root = getKbRoot();
  const provider = getEmbedderProvider();
  const spaces: SpaceInfo[] = [];
  for (const name of listKnownSpaces()) {
    let files: string[] = [];
    try {
      const r = await getDaemon().call<{ files: Record<string, string> }>(
        'list', { space: name },
      );
      files = Object.keys(r.files).sort();
    } catch (err) {
      log.warn(`library_info: list ${name} failed: ${errorMessage(err)}`);
    }
    const sample_files = files.slice(0, 8);
    const sample_headings = collectHeadings(root, sample_files);
    spaces.push({
      name,
      provider,
      file_count: files.length,
      sample_files,
      sample_headings,
    });
  }
  return { overview, spaces };
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
