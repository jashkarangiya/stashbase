/**
 * File-level metadata: the two non-chunk sources that get merged into a
 * file's chunk metadata at index time.
 *
 *   1. **In-file** (item 03) — metadata the *user* wrote inside the file:
 *      Markdown YAML front-matter, or HTML `<head>` `<meta>` / `<title>`.
 *      Authoritative, because the user typed it.
 *   2. **`<space>/.stashbase/file-metadata.md`** (item 02) — metadata the *agent*
 *      extracted or supplemented, kept out of the user's file so the
 *      agent never edits user content. One `## <space-rel-path>` section
 *      per file, each holding a fenced ```yaml block. It lives in the
 *      hidden sidecar and is excluded from indexing so its YAML never
 *      pollutes search.
 *
 * `resolveFileMetadata()` merges the two with **in-file winning** (the
 * user is authoritative) and hands the result to the indexer, which
 * forwards it to the daemon `upsert` so every chunk carries it. The
 * daemon in turn lets each chunk's own keys (e.g. `heading_text`) win
 * over these file-level keys — see `op_upsert`.
 *
 * Kept separate from `files.ts` for the same bundling reason `format.ts`
 * is: the indexer / MCP path must reach this without dragging
 * `watcher.ts` → `state.ts` into the bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { getKbRoot } from './space.ts';
import { decodeEntities } from './html.ts';
import { detectFormat } from './format.ts';
import { logger, errorMessage } from './log.ts';

const log = logger('metadata');

export type FileMetadata = Record<string, unknown>;

/** Space sidecar agent metadata file. */
const FILE_METADATA_NAME = 'file-metadata.md';
/** KB-root agent 目录 (kept in sync with `library.ts:FILENAME`). */
const SPACE_METADATA_NAME = 'space-metadata.md';

/** These agent-maintained metadata files must never enter the index —
 *  their YAML / 目录 prose would surface as bogus search hits. The exact
 *  sidecar paths are skipped, plus legacy top-level `file-metadata.md`
 *  while old spaces migrate. */
export function isReservedMetadataFile(kbRelPath: string): boolean {
  const parts = kbRelPath.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[1] === '.stashbase' && parts[2] === FILE_METADATA_NAME) return true;
  if (parts.length >= 2 && parts[0] === '.stashbase' && parts[1] === SPACE_METADATA_NAME) return true;
  return parts.length === 2 && parts[1] === FILE_METADATA_NAME;
}

function isPlainObject(v: unknown): v is FileMetadata {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── In-file metadata (item 03) ──────────────────────────────────────

/** Pull metadata the user embedded in the file itself. Markdown → YAML
 *  front-matter; HTML → `<head>` `<meta name|property … content …>` plus
 *  `<title>`. Returns `{}` for unsupported formats, no metadata, or a
 *  parse error (never throws — a malformed front-matter block must not
 *  block indexing the body). */
export function extractInFileMetadata(filePath: string, content: string): FileMetadata {
  const format = detectFormat(filePath);
  try {
    if (format === 'html') return extractHtmlMeta(content);
    if (format === 'md') {
      const parsed = matter(content);
      return isPlainObject(parsed.data) ? parsed.data : {};
    }
  } catch (err) {
    log.warn(`in-file metadata parse failed for ${filePath}: ${errorMessage(err)}`);
  }
  return {};
}

function getAttr(attrs: string, key: string): string | null {
  const m = attrs.match(
    new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

function extractHtmlMeta(html: string): FileMetadata {
  // Scope to <head> when present so body text never masquerades as
  // metadata; fall back to the whole doc for fragments without a head.
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] ?? html;
  const out: FileMetadata = {};
  const title = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (title) {
    const t = decodeEntities(title[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t) out.title = t;
  }
  const metaRe = /<meta\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(head))) {
    const attrs = m[1];
    const name = getAttr(attrs, 'name') ?? getAttr(attrs, 'property');
    const value = getAttr(attrs, 'content');
    // Only keep named meta with a value; skip charset / http-equiv /
    // viewport-style entries that aren't document metadata.
    if (name && value != null && name.toLowerCase() !== 'viewport') {
      out[name] = decodeEntities(value);
    }
  }
  return out;
}

// ── Agent metadata sidecar (item 02) ────────────────────────────────

/** `<kbRoot>/<space>/.stashbase/file-metadata.md`. */
function fileMetadataPath(spaceName: string): string {
  return path.join(getKbRoot(), spaceName, '.stashbase', FILE_METADATA_NAME);
}

function legacyFileMetadataPath(spaceName: string): string {
  return path.join(getKbRoot(), spaceName, FILE_METADATA_NAME);
}

function migrateLegacyFileMetadata(spaceName: string): void {
  const target = fileMetadataPath(spaceName);
  const legacy = legacyFileMetadataPath(spaceName);
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(legacy, target);
  } catch (err: unknown) {
    log.warn(`failed to migrate ${legacy} → ${target}: ${errorMessage(err)}`);
  }
}

const DOC_HEADER = `# File metadata

> Maintained by StashBase's agent — **not** the user's file content. Each
> \`## <path>\` section (path is space-relative) holds one file's
> agent-extracted metadata as a fenced \`yaml\` block. Merged into that
> file's chunk metadata at index time, with any metadata the user wrote
> *inside* the file taking precedence.
`;

/** Parse the whole sidecar into `space-rel-path → metadata`. Tolerant:
 *  a section whose yaml is unparseable is skipped, not fatal. */
export function readFileMetadataDoc(spaceName: string): Map<string, FileMetadata> {
  const out = new Map<string, FileMetadata>();
  let text: string;
  try {
    migrateLegacyFileMetadata(spaceName);
    text = fs.readFileSync(fileMetadataPath(spaceName), 'utf8');
  } catch {
    return out;
  }
  // Split on level-2 headings; the heading text is the file path.
  const sections = text.split(/^##\s+/m).slice(1);
  for (const sec of sections) {
    const nl = sec.indexOf('\n');
    const relPath = (nl >= 0 ? sec.slice(0, nl) : sec).trim();
    if (!relPath) continue;
    const body = nl >= 0 ? sec.slice(nl + 1) : '';
    const yaml = body.match(/```ya?ml\s*\n([\s\S]*?)```/i)?.[1] ?? '';
    const data = parseYamlBlock(yaml);
    if (Object.keys(data).length > 0) out.set(relPath, data);
  }
  return out;
}

/** Metadata for one file from the sidecar (`{}` if absent). */
export function getFileMetadataEntry(spaceName: string, spaceRelPath: string): FileMetadata {
  return readFileMetadataDoc(spaceName).get(spaceRelPath) ?? {};
}

/** Upsert one file's section in the sidecar. Passing an empty object
 *  removes the section. Atomic via `.tmp` + rename. */
export function setFileMetadataEntry(
  spaceName: string,
  spaceRelPath: string,
  data: FileMetadata,
): void {
  const all = readFileMetadataDoc(spaceName);
  if (Object.keys(data).length === 0) all.delete(spaceRelPath);
  else all.set(spaceRelPath, data);

  const target = fileMetadataPath(spaceName);
  if (all.size === 0) {
    try { fs.unlinkSync(target); } catch { /* already gone */ }
    return;
  }
  const parts = [DOC_HEADER];
  for (const rel of [...all.keys()].sort()) {
    parts.push(`## ${rel}\n\n\`\`\`yaml\n${stringifyYaml(all.get(rel)!)}\`\`\`\n`);
  }
  const out = parts.join('\n');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + '.tmp', out, 'utf8');
  fs.renameSync(target + '.tmp', target);
}

// ── Merge + YAML helpers ────────────────────────────────────────────

/** The merged file-level metadata for `kbRelPath` (space + in-file),
 *  in-file winning. Returns `null` when there's nothing to attach so the
 *  indexer can skip sending an empty `metadata` arg. */
export function resolveFileMetadata(kbRelPath: string, content: string): FileMetadata | null {
  const slash = kbRelPath.indexOf('/');
  const space = slash >= 0 ? kbRelPath.slice(0, slash) : kbRelPath;
  const spaceRel = slash >= 0 ? kbRelPath.slice(slash + 1) : '';
  const fromSidecar = spaceRel ? getFileMetadataEntry(space, spaceRel) : {};
  const inFile = extractInFileMetadata(kbRelPath, content);
  const merged = { ...fromSidecar, ...inFile }; // in-file (user) wins
  return Object.keys(merged).length > 0 ? merged : null;
}

function parseYamlBlock(yamlText: string): FileMetadata {
  if (!yamlText.trim()) return {};
  try {
    // Reuse gray-matter's YAML engine by faking a front-matter block.
    const parsed = matter(`---\n${yamlText}\n---\n`);
    return isPlainObject(parsed.data) ? parsed.data : {};
  } catch {
    return {};
  }
}

function stringifyYaml(data: FileMetadata): string {
  // `matter.stringify('', data)` emits `---\n<yaml>---\n`; lift the body.
  const block = matter.stringify('', data);
  const m = block.match(/^---\n([\s\S]*?)\n?---\s*\n?/);
  return m ? m[1] + '\n' : '';
}
