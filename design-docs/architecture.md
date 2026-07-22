# Architecture

This document records StashBase's high-level system contracts. It explains
what must remain true when implementation changes; source code remains the
source of truth for file, module, route, and function-level detail.

## System Shape

```text
Local files → Convert → Index → Retrieve → MCP → Agents
     ↑                                          │
     └──────────── Agent-written files ─────────┘
```

The desktop application owns file access, user interaction, format
preparation, and the MCP boundary. A local indexing runtime owns chunking,
embedding, storage, and semantic retrieval. Together they operate as one local
library per installation.

## Ownership

| Data | Owner | Rule |
|---|---|---|
| Local files and folders | User | They remain the source of truth. |
| `AGENTS.md` and `CLAUDE.md` | User | They are ordinary visible files and are never overwritten by StashBase. |
| Extracted text, previews, indexes, preparation records | StashBase | They are rebuildable derived state. |
| Credentials and user settings | StashBase settings | They are managed through Settings, not environment variables. |

Derived artifacts must not appear as ordinary files in the workspace. When
search finds derived evidence, the result still identifies and opens the
user-visible source file.

## Scope And Access

- The library is the set of local folders the user has added or opened.
- A window works primarily in one current folder; this is UI scope, not a
  separate library.
- In-app search defaults to that current folder. MCP can search the library and
  narrow to an authorized folder or path prefix.
- MCP file operations are deliberately bounded to authorized library folders;
  they are never a general filesystem interface.
- One local runtime owns indexing state. Other processes communicate through
  its supported boundary rather than maintaining competing copies of the index.

## Preparation And Retrieval

- Markdown is read, edited, and indexed from its source file.
- Other formats may gain a derived representation for Agent reading or search,
  while the original remains the visible file.
- Conversion and semantic indexing are separate stages. A prepared file may be
  available to keyword retrieval before semantic indexing is ready.
- Semantic retrieval is optional. Without embedding configuration, browsing,
  editing, and keyword retrieval remain available.
- Incomplete, stale, or partial derived output is never current truth.
- Reconcile and reindex bring external file changes back into the library.

## Liveness And Recovery

- Entering a folder prioritizes a usable workspace; listing, conversion, and
  indexing continue in the background.
- Background work must not make ordinary file browsing depend on preparation.
- Explicit user cancellation is respected; interrupted background work is
  rediscovered when its durable output is incomplete.
- Removing a folder clears StashBase-owned state for that folder without
  deleting the user's source files.
- File mutation and deletion must retire or invalidate related derived state so
  retrieval never presents orphaned or stale evidence as current.
- Import publishes through a no-clobber path; recovery only removes an
  identity-proven partial reservation, never a completed or externally replaced
  destination.
- Closing or failing to open the local index must release the client connection
  and local database server before cleanup returns.

## Trust Boundaries

- Untrusted document content is rendered without granting it application
  privileges.
- External URLs and local-file navigation follow explicit, validated paths.
- Network, commands, deletion, rename, and broader filesystem access remain
  explicit approval decisions in the Agent Panel.

## Documentation Boundary

Update this document when these system contracts, ownership boundaries, or
major flows change. Put user-experience and contribution guidance in the
relevant [design area](README.md). Do not turn either into a source-tree map.
