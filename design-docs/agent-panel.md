# Built-In Agent Panel Design

This document captures the product design contract for the built-in Claude/Codex panel. The architecture remains in [architecture.md](architecture.md); this file is only about renderer behavior and visual direction.

## Direction

The built-in Agent panel should feel like a VS Code-style agent side panel for local files, not a separate AI workspace.

The panel may make agent work easier to scan, but it should stay quiet:

- low chrome
- compact controls
- restrained borders and cards
- no decorative motion or visual metaphor
- no new workspace model separate from the user's local folder

Community contributions can land as useful first iterations, but the long-term design should continue to be simplified toward this side-panel model when needed.

## Design Rules

- Keep the panel renderer-led. Do not change agent transport, session persistence, MCP, indexing, or permission policy just to support presentation changes.
- Prefer small, familiar agent-chat affordances over a bespoke workbench UI.
- Treat user-action states as first-class. Permission approvals, retry actions, and stopped-turn editing must remain visible and directly actionable.
- Keep background activity compact. Tool calls may be grouped or summarized, but the user must be able to inspect them when needed.
- File outputs should be easy to open, but artifact UI should stay lightweight. Prefer rows or compact affordances over large delivery cards.
- Streaming should not steal the user's scroll position. If the user has scrolled away from the bottom, show a clear jump-to-latest affordance.
- The current document is never implicit agent context. Users attach files by drag/drop, file picker, or `@` mention.
- The top-bar Claude and Codex icons select or toggle existing chats. Creating a new chat belongs to the in-panel `+`.

## Current Baseline

The accepted baseline includes:

- per-agent chat tab selection and toggle behavior
- keyboard navigation for `@` file mentions
- smooth chat-side resize without drag-frequency global state updates
- compact activity grouping for non-actionable tool calls, with inspectable
  command/read/search labels rather than lifecycle-only summaries
- visible permission cards outside collapsed activity
- lightweight file/artifact open affordances
- jump-to-latest behavior for transcript scrolling

These are still implementation details, not a new product category. If the panel starts to feel heavier than VS Code/Codex/Claude Code side chat, the preferred follow-up is to reduce visual weight rather than add more structure.
