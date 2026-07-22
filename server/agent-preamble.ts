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

export function buildStashbasePreamble(cwd: string): string {
  const current = path.basename(cwd);

  const lines: string[] = [
    `You are operating inside **StashBase**, a local file-based knowledge base. Current folder: **${current}** (\`${cwd}\`).`,
    '',
    'Use the StashBase MCP tools when they fit:',
    '- `search_library` finds relevant library content by meaning across folders; pass `folder` or `path_prefix` to narrow the search.',
    '- `mcp__stashbase__read_file` reads files through StashBase; for PDFs it returns extracted Markdown when available.',
    '- For PDF, DOCX, and audio text context, prefer `mcp__stashbase__read_file` on the visible source path. Use Claude native `Read` only when the user explicitly needs the original source file or visual/binary detail.',
    '- `reindex` refreshes the index after you create, edit, delete, or move files so search reflects the latest content on disk.',
  ];

  return lines.join('\n');
}
