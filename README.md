# StashBase

**Your knowledge base as AI context — not just your codebase.**

[![Status](https://img.shields.io/badge/status-early%20alpha-orange.svg)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![Powered by mfs](https://img.shields.io/badge/powered%20by-mfs-0891b2.svg)](https://github.com/zilliztech/mfs)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

🎨 **HTML-first notes:** Native HTML rendering for rich layouts, links, tables, and media — ready for AI workflows and long-term reference.

⚡ **Entire knowledge base as context:** Notes are semantically embedded and indexed as they land, giving your AI clients a searchable, long-lived library without multi-round searching or manual discovery.

🤖 **MCP-compatible access:** Query your indexed knowledge from any MCP-aware AI client — Claude, ChatGPT, Codex — for direct AI workflows.

---

## 🚀 Demo

![Demo](.github/assets/demo_0521.gif)

> Import the CS183B starter — 20 YC startup lectures, pre-indexed. Surface ideas in Claude Desktop via `@stashbase`, then use the in-app Claude Code terminal to organize what resonates into HTML notes.

---

## Try it

Install the macOS cask with Homebrew:

```bash
brew install --cask liliu-z/stashbase/stashbase
```

The cask installs the latest GitHub Release and wires `@stashbase` into Claude Desktop, Claude Code, and Codex automatically.

Once the app is running:

1. On the Welcome screen, hit **Clone repo** and paste `https://github.com/0-bingwu-0/stashbase-cs183b` — Stanford CS183B's 20 startup lectures (Sam Altman, Paul Graham, Peter Thiel, …) with a pre-built index. Retrieval works the moment it lands, no first-pass indexing wait.
2. From Claude Desktop, Claude Code, Codex, or any MCP-aware client, ask `@stashbase how does Sam Altman think about pivots?` — the brew install wires up the MCP server automatically.
3. Then point it at your own notes: open another folder from the Welcome screen and let StashBase index it in the background.

**Embeddings.** StashBase asks for an OpenAI API key on first launch — used only for embeddings (no chat completions), so cost is tiny (a few cents per month for a few MB of notes). [Create a key.](https://platform.openai.com/api-keys) No key? Pick the built-in local model (`bge-m3` ONNX) in the same modal — fully offline, no account, might be slow.

---

## Example workflow

Most AI tools treat knowledge as temporary context — uploaded files, copied notes, chat history, code indexes. But personal knowledge lasts longer: papers, transcripts, notes, half-finished analysis accumulate across folders and apps for years.

StashBase is built for that accumulation layer. It continuously indexes your library locally and serves it back to any MCP-aware AI client through semantic + keyword retrieval.

```text
research paper
        ↓
Claude Code reads and generates notes
        ↓
StashBase indexes them locally
        ↓
later, in Claude or ChatGPT...
        ↓
"that paper on test-time compute scaling"
        ↓
relevant notes retrieved instantly
```

Codebase retrieval is already well served by tools like [Claude Context](https://github.com/zilliztech/claude-context). StashBase focuses on everything else that accumulates around AI work — papers, transcripts, reading notes, research fragments, saved analysis, generated HTML knowledge pages.

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

Embedding provider (OpenAI or the local `bge-m3` ONNX) is locked per space after the initial index build — pick before the first index runs.

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

For contributors and developers building locally, and for platforms without a prebuilt cask (Intel Mac, Windows). End users should wait for the brew cask above.

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

## Publishing

`dist:brew` is the one-command publishing flow: build the macOS package, upload the current version's files in `release/` to this repository's GitHub Release, then publish the Homebrew cask update.

```bash
pnpm dist:brew
```

The cask defaults to `liliu-z/stashbase/stashbase`, backed by `git@github.com:liliu-z/homebrew-stashbase.git`; override it with `HOMEBREW_TAP`, `HOMEBREW_TAP_GIT_URL`, or `HOMEBREW_CASK` if needed. GitHub Release asset upload uses `gh` when `GITHUB_TOKEN` is not set, so run `brew install gh && gh auth login` once on a new machine. Homebrew cask publishing commits and pushes directly to the SSH tap repository.

---

## MCP integration

The packaged app wires `@stashbase` into Claude Desktop, Claude Code, and Codex automatically. The Homebrew cask runs that setup during install; direct DMG installs run it the first time the app launches. Skip the rest of this section unless you're running from source.

**Manual config** (source builds). Open Claude Desktop's config:

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

Restart Claude Desktop. The same MCP server wires into Codex, Claude Code, or any other MCP-aware client.

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
