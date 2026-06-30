/**
 * StashBase orientation preamble for the built-in Claude panel.
 *
 * Appended to the SDK's `claude_code` system prompt in server/agent.ts.
 * Without it the panel runs *bare*: cwd happens to be a folder, but the
 * model has no idea it's inside StashBase, what the library MCP tools are for,
 * or what the house rules are — so it behaves exactly like a `claude`
 * launched in a random folder (architecture.md §8.4).
 *
 * The MCP `instructions` field + a `library_info` round-trip advertise the same
 * facts, but only *advisorily* and only if the model bothers to call
 * `library_info`. This puts orientation into the system prompt deterministically
 * instead.
 *
 * Built per session: cwd is fixed for a session's lifetime (switching
 * folders tears the session down), so the live context here — current folder,
 * sibling folders — is always current.
 */
import path from 'node:path';
import { getLibraryInfo } from './library-info.ts';
import { toPosixAbs } from './folder.ts';

export function buildStashbasePreamble(cwd: string): string {
  const info = getLibraryInfo();
  const cwdAbs = toPosixAbs(cwd);
  const current = path.basename(cwd);
  const others = info.folders.filter((f) => f.path !== cwdAbs).map((f) => f.name);

  const lines: string[] = [
    `You are operating inside **StashBase**, a local file-based library. ` +
      `This is not a generic working directory: the folder you're in (\`${cwd}\`) ` +
      `is a StashBase *folder*, and the default folder home is \`${info.folder_home}\`.`,
    '',
    `Current folder: **${current}**.` +
      (others.length ? ` Other folders in your library: ${others.join(', ')}.` : ''),
    '',
    'Beyond your normal shell/file tools you have two StashBase MCP tools that ' +
      'the filesystem alone cannot give you:',
    '- `search_library` — semantic / vector retrieval across the library. Finds things by ' +
      'meaning rather than literal text, surfacing cross-file conceptual links ' +
      'that grep/ripgrep miss.',
    '- `reindex` — there is **no filesystem watcher**. After you create, edit, ' +
      'delete, or move any file, call `reindex` so the change becomes searchable.',
    '',
    'This library likely holds relevant prior context for whatever you are asked, so a ' +
      'quick `search_library` before answering from memory is usually worth it — but ' +
      'you decide when retrieval helps and when your own file tools or reasoning ' +
      'are enough.',
  ];

  return lines.join('\n');
}
