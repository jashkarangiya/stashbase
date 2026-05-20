# StashBase

**Your knowledge base as AI context — not just your codebase.**

[![Status](https://img.shields.io/badge/status-early%20alpha-orange.svg)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![Powered by mfs](https://img.shields.io/badge/powered%20by-mfs-0891b2.svg)](https://github.com/zilliztech/mfs)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**StashBase** is a local knowledge base supporting HTML and Markdown, with deep integration of Claude/Codex, and retrievable via MCP.

🎨 **HTML-first notes:** Native HTML rendering for rich layouts, links, tables, and media — ready for AI workflows and long-term reference.
*"Ask your LLM to structure your response as HTML." — Andrej Karpathy*

⚡ **Entire knowledge base as context:** Notes are semantically embedded and indexed as they land, giving your AI clients a searchable, long-lived library without multi-round searching or manual discovery.

🤖 **MCP-compatible access:** Query your indexed knowledge from any MCP-aware AI client — Claude, ChatGPT, Codex — for direct AI workflows.

---

## 🚀 Demo

![Demo](.github/assets/demo.gif)

> Claude Code turns a raw podcast transcript into structured question cards (my preferred note format). StashBase indexes the notes automatically so the ideas become part of your long-term AI context.

---

## Install

```bash
brew install --cask liliu-z/stashbase/stashbase
```

The cask installs from the latest [GitHub Release](https://github.com/liliu-z/stashbase/releases/latest). It automatically clears the Gatekeeper quarantine and applies an ad-hoc signature so the unsigned alpha build launches without intervention.

Direct download if you don't have brew: [latest macOS build](https://github.com/liliu-z/stashbase/releases/latest) — macOS arm64 (Apple Silicon). Unsigned; the DMG includes a `Fix.sh` script to handle Gatekeeper.

For Intel Mac, Windows, or Linux, build from source (see below).

Once the app is running:

1. From the Welcome screen, open a folder of notes or clone a repo by URL
2. Let StashBase build the local index (progress shown in the status bar)
3. Open the in-app Claude Code or Codex terminal from the sidebar
4. Start generating or retrieving knowledge

**Starter content:** clone [`stashbase-cs183b`](https://github.com/0-bingwu-0/stashbase-cs183b) from the Welcome screen's "Clone repo" option — example notes built from Y Combinator's *How to Start a Startup* (CS183B) lectures.

---

## The accumulation problem

Most AI tools treat knowledge as temporary context:

* uploaded files
* copied notes
* chat history
* local code indexes

But personal knowledge lasts longer.

Papers, transcripts, notes, saved analysis, and half-finished ideas accumulate across folders and apps over time.

StashBase is built for that accumulation layer.

It continuously indexes your library locally and exposes it through semantic + keyword retrieval for Claude, ChatGPT, Codex, and other MCP-compatible AI tools.

Instead of repeatedly loading entire folders into context, your AI retrieves only the relevant pieces when needed.

---

## Example workflow

```text
podcast transcript
        ↓
Claude Code generates notes
        ↓
StashBase indexes them locally
        ↓
later, in Claude or ChatGPT...
        ↓
"that discussion about AI killing SaaS"
        ↓
relevant notes retrieved instantly
```

Example query:

```text
Query:
"that podcast arguing AI won't kill SaaS"

→ notes/saas-maintenance.html

  Software is only part of the cost.
  Reliability, upgrades, permissions,
  integrations, and support are usually
  the harder problem.
```

Codebase retrieval is already well served by tools like [Claude Context](https://github.com/zilliztech/claude-context).

StashBase focuses on everything else that accumulates around AI work:

* papers
* transcripts
* reading notes
* research fragments
* saved analysis
* generated HTML knowledge pages

---

## Features

### Built-in agent workspace

StashBase treats coding agents as first-class citizens inside the knowledge workspace itself.

**In-app terminal.** Claude Code and Codex are pre-wired. The terminal launches directly inside the current space, and anything the agent writes is immediately indexed — no manual refresh or re-indexing step.

**Skills mirrored across CLIs.** Drop a `skills/<name>/SKILL.md` into a space and StashBase mirrors it into:

* `.claude/commands/<name>.md`
* `.codex/prompts/<name>.md`

Write an agent workflow once and reuse it across multiple coding agents.

**Cross-file link cascade.** Rename a note and StashBase rewrites Markdown / HTML links pointing to the old path with a VS Code-style confirmation dialog.

**PDF → HTML pipeline.** Drop in a PDF and the marker pipeline generates a readable, indexable HTML note + asset bundle.

**Git clone as a space starter.** Paste a repo URL into the Welcome screen and StashBase clones, opens, and indexes it automatically.

---

## Retrieval

Each selected folder becomes a "space".

Every space maintains a continuously updated local semantic index powered by [mfs](https://github.com/zilliztech/mfs) and [Milvus Lite](https://milvus.io/docs/milvus_lite.md).

Files are indexed automatically on boot. External edits — from editors, git checkouts, sync tools, or coding agents — are picked up through filesystem watching.

Supported embedding providers:

* **OpenAI embeddings** — best retrieval quality
* **Local ONNX embeddings (`bge-m3`)** — fully local after first download

> Embedding configuration is locked per space after the initial index build, so pick before the first index runs.

Hybrid semantic + keyword retrieval is shared across AI tools through MCP.

```text
          Claude Code · Codex
                   │
            shared workspace
                   │
        ┌──────────────────────┐
        │      StashBase       │
        │ semantic retrieval   │
        │ keyword retrieval    │
        │ continuous indexing  │
        └──────────────────────┘
                   │
                  MCP
                   │
     Claude · ChatGPT · AI clients
```

---

## Why HTML

Markdown became the default not because it was more expressive, but because it was the lowest-friction format humans were willing to type.

That tradeoff changes once models generate most of the structure.

To an LLM, HTML and Markdown are both just text. But HTML carries richer structure for long-lived knowledge:

* semantic sections
* anchors
* embedded media
* tables
* expandable blocks
* durable layouts

Markdown still works well for drafts and quick notes. StashBase supports both side by side.

But for finished, shareable, AI-generated knowledge pages, HTML becomes much more compelling once humans are no longer hand-authoring every tag.

> "HTML is the new markdown. I've stopped writing markdown files for almost everything and switched to using Claude Code to generate HTML for me."
>
> — [Thariq Shihipar](https://x.com/trq212/status/2052809885763747935), Anthropic / Claude Code

> "Ask your LLM to structure your response as HTML."
>
> — [Andrej Karpathy](https://x.com/karpathy/status/2053872850101285137)

---

## Build from source

For developers, contributors, and platforms without a prebuilt binary (Intel Mac, Windows, Linux). Most users should use the [installer](#install) above.

```bash
# Setup
cd StashBase
pnpm install
pnpm setup:python

# Run the Electron app
pnpm electron

# Development mode
pnpm dev

# Build distributable app
pnpm dist:mac
pnpm dist:win
```

---

## MCP integration

Connect StashBase to Claude Desktop or other MCP-compatible AI clients.

Open Claude Desktop config:

```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/StashBase/mcp/server.ts"]
    }
  }
}
```

Restart Claude Desktop.

Once connected, Claude can retrieve notes, papers, transcripts, and saved analysis directly from your indexed library.

The same retrieval layer can also be shared with ChatGPT, Codex, or custom MCP workflows.

---

## Status

Early alpha.

macOS receives the most testing today. Windows and Linux generally work but are less exercised.

### Reasonably stable

* Note CRUD
* File watching
* Space switching
* Hybrid retrieval
* Claude Code / Codex terminal integration

### Still evolving

* MCP tool signatures
* `.stashbase/mfs/` sidecar schema
* Skill mirroring conventions

Pin a commit if you're embedding StashBase into a larger workflow.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Small focused PRs are preferred. Open an issue before larger changes so scope and direction can be discussed first.

---

## About

Built by Li Liu.

I work on [Milvus](https://github.com/milvus-io/milvus) at [Zilliz](https://zilliz.com), where I've spent the last few years building vector retrieval infrastructure for AI systems.

Coding with AI already feels fluid inside IDEs. Personal knowledge tools still largely don't.

StashBase is my attempt at the missing layer: a local-first workspace where papers, notes, transcripts, and saved analysis remain continuously retrievable across AI workflows.

This is a personal side project built in the open. PRs, issues, and experiments are welcome.

