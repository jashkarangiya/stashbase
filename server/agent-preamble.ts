/**
 * StashBase orientation preamble for the built-in Claude panel.
 *
 * Appended to the SDK's `claude_code` system prompt in server/agent.ts.
 * Without it the panel runs *bare*: cwd happens to be a space, but the
 * model has no idea it's inside StashBase, what the KB MCP tools are for,
 * or what the house rules are — so it behaves exactly like a `claude`
 * launched in a random folder (architecture.md §8.4).
 *
 * The MCP `instructions` field + a `kb_info` round-trip advertise the same
 * facts, but only *advisorily* and only if the model bothers to call
 * `kb_info`. This puts orientation + the rules book into the system prompt
 * deterministically instead.
 *
 * Built per session: cwd is fixed for a session's lifetime (switching
 * spaces tears the session down), so the live context here — current space,
 * sibling spaces — is always current. Rules are read from STASHBASE.md,
 * never forked, so the user's rules book stays the single source of truth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getKbInfo } from './kb.ts';
import { getCurrentSpaceName } from './space.ts';

const RULES_FILENAME = 'STASHBASE.md';

export function buildStashbasePreamble(cwd: string): string {
  const info = getKbInfo();
  const current = getCurrentSpaceName() ?? path.basename(cwd);
  const others = info.spaces.map((s) => s.name).filter((n) => n !== current);

  // Space-level rules layer on top of the KB baseline (kb.ts). cwd is the
  // open space, so its STASHBASE.md — if present — is the most specific.
  let spaceRules = '';
  try { spaceRules = fs.readFileSync(path.join(cwd, RULES_FILENAME), 'utf8').trim(); }
  catch { /* no per-space rules — baseline only */ }
  const rules = [info.rules.trim(), spaceRules].filter(Boolean).join('\n\n');

  const lines: string[] = [
    `You are operating inside **StashBase**, a local file-based knowledge base. ` +
      `This is not a generic working directory: the folder you're in (\`${cwd}\`) ` +
      `is a StashBase *space*, and the whole KB lives under \`${info.kb_root}\`.`,
    '',
    `Current space: **${current}**.` +
      (others.length ? ` Other spaces in this KB: ${others.join(', ')}.` : ''),
    '',
    'Beyond your normal shell/file tools you have two StashBase MCP tools that ' +
      'the filesystem alone cannot give you:',
    '- `search_kb` — semantic / vector retrieval across the KB. Finds things by ' +
      'meaning rather than literal text, surfacing cross-file conceptual links ' +
      'that grep/ripgrep miss.',
    '- `reindex` — there is **no filesystem watcher**. After you create, edit, ' +
      'delete, or move any file, call `reindex` so the change becomes searchable.',
    '',
    'This KB likely holds relevant prior context for whatever you are asked, so a ' +
      'quick `search_kb` before answering from memory is usually worth it — but ' +
      'you decide when retrieval helps and when your own file tools or reasoning ' +
      'are enough.',
  ];

  if (rules) {
    lines.push(
      '',
      '---',
      'House rules for this knowledge base (from STASHBASE.md — follow them):',
      '',
      rules,
    );
  }
  return lines.join('\n');
}
