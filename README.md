# StashBase

**Your knowledge base as AI context — not just your codebase.**

[![Status](https://img.shields.io/badge/status-early%20alpha-orange.svg)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![Powered by mfs](https://img.shields.io/badge/powered%20by-mfs-0891b2.svg)](https://github.com/zilliztech/mfs)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**StashBase** is an HTML-first local knowledge base with built-in Claude Code/Codex, continuous indexing, and MCP-compatible access for AI clients.

🎨 **HTML-first notes:** Rich layouts, links, tables, and media — designed for AI-assisted writing and long-term reference.

⚡ **Continuously indexed:** New notes become searchable immediately through semantic retrieval.

🤖 **MCP-compatible access:** Expose the whole indexed knowledge base to Claude, ChatGPT, Codex, and other AI tools.

---

## 🚀 Demo

![Demo](.github/assets/demo_0521.gif)

> Import the CS183B starter — 20 YC startup lectures, pre-indexed. Surface ideas in Claude Desktop via `@stashbase`, then use the in-app Claude Code terminal to organize what resonates into HTML notes.

---

## ⚡ Try it

Install the macOS cask with Homebrew:

```bash
brew install --cask liliu-z/stashbase/stashbase
```

Once the app is running:

1. On the Welcome screen, hit **Clone repo** and paste `https://github.com/0-bingwu-0/stashbase-cs183b` — Stanford CS183B's 20 startup lectures (Sam Altman, …) with a pre-built index.
2. Open **Settings → MCP** (gear in the top-right corner), click **Connector** for your AI client, restart that client, then ask `@stashbase what's the best time to start a startup?`.
3. Then bring your own notes: hit **New space** on the Welcome screen and drag your `.md` / `.html` files onto the app — StashBase indexes them in the background.

**Embeddings.** StashBase asks for an OpenAI API key on first launch — used only for embeddings (no chat completions). The default `text-embedding-3-small` is only $0.02 per 1M tokens. [Create a key.](https://platform.openai.com/api-keys) No API key? Pick the built-in local model (`bge-m3` ONNX) in the same modal — fully offline, no account, might be slower.

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

The packaged app includes an MCP command for `@stashbase`. Open **Settings → MCP** (gear in the top-right corner) to connect it to Claude Code, OpenAI Codex CLI, Gemini CLI, Qwen Code, Cursor, Void, Claude Desktop, Windsurf, VS Code, Cherry Studio, Cline, Augment, Roo Code, Zencoder, ChatGPT, LangChain/LangGraph, or another MCP-aware client.

Use the manual config below if you're running from source, if a client was installed after StashBase, or if you want to inspect the exact MCP settings.

**Connector support.** From **Settings → MCP**, StashBase can write known config files directly for Claude Code, Claude Desktop, OpenAI Codex CLI, Gemini CLI, Qwen Code, and Cursor. For GUI-driven or extension-managed clients such as Void, Windsurf, VS Code, Cherry Studio, Cline, Augment, Roo Code, Zencoder, ChatGPT, LangChain/LangGraph, and other MCP clients, the same Connector button copies the right stdio config for pasting into that client's MCP settings.

### MCP command

Homebrew / packaged app:

```bash
~/.stashbase/bin/stashbase-mcp
```

Source checkout:

```bash
npx tsx /absolute/path/to/StashBase/mcp/server.ts
```

The packaged command is generated when you connect a client from **Settings → MCP**. For source builds, replace `/absolute/path/to/StashBase` with your local repo path.

### Claude Code

For a Homebrew / packaged install:

```bash
claude mcp add stashbase -- ~/.stashbase/bin/stashbase-mcp
```

For a source checkout:

```bash
claude mcp add stashbase -- npx tsx /absolute/path/to/StashBase/mcp/server.ts
```

Restart Claude Code after changing MCP servers.

### Claude Desktop

Open Claude Desktop's config:

```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

For a Homebrew / packaged install, add:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
    }
  }
}
```

For a source checkout, add:

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

Restart Claude Desktop after saving the file.

### Codex CLI

Codex CLI uses TOML configuration. Create or edit:

```bash
~/.codex/config.toml
```

For a Homebrew / packaged install, add:

```toml
[mcp_servers.stashbase]
command = "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
```

For a source checkout, add:

```toml
[mcp_servers.stashbase]
command = "npx"
args = ["tsx", "/absolute/path/to/StashBase/mcp/server.ts"]
```

Restart Codex CLI after saving the file. Codex app configuration is not currently managed by this manual TOML path.

### Other MCP clients

StashBase uses stdio transport, so most MCP-aware clients can use the same command.

Homebrew / packaged install:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
    }
  }
}
```

Source checkout:

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
