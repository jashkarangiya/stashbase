# StashBase

**Turn what you save into persistent memory.**

[![Website](https://img.shields.io/badge/website-stashbase.ai-0a66c2.svg)](https://stashbase.ai)
[![Status](https://img.shields.io/badge/status-early%20alpha-orange.svg)](#status)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)
[![Powered by mfs](https://img.shields.io/badge/powered%20by-mfs-0891b2.svg)](https://github.com/zilliztech/mfs)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-support%20%26%20chat-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/zsRZH4PTq9)

> ⭐ **If this idea interests you, drop a star.** Every item on the [build map](https://stashbase.ai/build-map/) ships with detailed design — easy to pick up if you'd like to contribute.

StashBase is a local-first knowledge base that turns documents, screenshots, videos, and AI artifacts into persistent memory for you and your AI. You stash it. Agents organize and maintain it.

📥 **Capture what matters:** Import documents, folders, and AI artifacts. Snap a screenshot and it's saved with searchable text; record your screen and it turns into a structured note.

🤖 **One memory, every AI:** Claude, ChatGPT, Codex — every MCP client draws on the same knowledge base.

💾 **Local-first & user-owned:** Your original files stay on your disk in open formats. No vendor lock-in. Your memory remains portable and under your control.

---

## 🚀 Demo

![Demo](.github/assets/demo_0616.gif)

> Clone the CS183B starter, import it, then ask the built-in agent — it answers from all 20 Stanford startup lectures.

---

## ⚡ Try it

StashBase currently ships for **macOS (Apple Silicon)** and **Linux (x86_64 Debian/Ubuntu)** — Windows is on the [roadmap](#status).

### macOS Install (Apple Silicon)

Install with Homebrew:

```bash
brew install --cask liliu-z/stashbase/stashbase
```

### Linux Install (Debian/Ubuntu)

Download the latest `StashBase-*-linux-amd64.deb` asset from the [Releases](https://github.com/liliu-z/stashbase/releases) page and install it:

```bash
sudo dpkg -i ./StashBase-*-linux-amd64.deb
```

Once the app is running:

1. **Open `👋 Start Here`**, already waiting on your Welcome screen.
2. Open the **built-in Claude agent** and let it do the reading for you. Ask it something like *"How is StashBase different from a notes app or other knowledge bases?"*
3. Want a real example? Clone the [CS183B starter](https://github.com/0-bingwu-0/stashbase-cs183b) (Stanford's **How to Start a Startup**, 20 lectures) and open the cloned folder:
   ```bash
   git clone https://github.com/0-bingwu-0/stashbase-cs183b
   ```
   Skim `founder_playbook.html`, then work with the agent: discuss it, or drop in a new article and let it update the playbook.
4. Bring your own: use **New folder** to create a folder from the native picker, or **Open folder** to index an existing local folder in place.

Want this memory in Claude Desktop, ChatGPT, or Codex too? **Settings → MCP** → click **Connector** for your client, restart it, then `@stashbase` from there.

**Embeddings.** StashBase asks for an OpenAI API key when you open your first folder — used **only for embeddings** (no chat completions). `text-embedding-3-small` is only $0.02 per 1M tokens. [Create a key.](https://platform.openai.com/api-keys) Without a key, files still save, preview, and stay searchable by exact keyword — only semantic search waits for the key.

**Recordings.** Screen recording turns what you watched into a structured note via Gemini video understanding — the original video stays attached to the note and is linked at the bottom (it opens in your browser to play). Needs a Gemini API key — add one under **Settings → Capture**. [Create a key.](https://aistudio.google.com/apikey) `gemini-2.5-flash` runs about $0.30 per 1M input tokens — a 10-minute recording is roughly 150K tokens, so a few cents per recording.

---

## Example workflow

Drop in a research paper. Claude Code reads it and writes an HTML note; StashBase indexes the note locally. Weeks later, in Claude or ChatGPT: *"that paper on test-time compute scaling"* — retrieved instantly.

More workflows — course archives, research landscapes, podcast notes, competitor teardowns — on [stashbase.ai](https://stashbase.ai/#gallery).

---

## Capture

Stashing saves the content itself, not a link to it. Each format is handled its own way:

| Format | Viewing | Into the index |
|---|---|---|
| Markdown | Rendered preview / source edit / live split | Indexed directly |
| HTML | Full render; scripts and self-contained apps run | Indexed directly, split by headings |
| PDF | Built-in reader; hits locate the passage on the page | Background extraction to a hidden Markdown companion (figures included) |
| Images | Inline preview + lightbox | Local OCR text layer (RapidOCR, on-device) |
| Video & screen recordings | Linked from the note, opens in the browser to play | Multimodal understanding (Gemini, key required) → summary + structured content |

Structured formats are indexed as they are; unstructured formats are extracted into searchable text first.

### Local folders

**Open folder** points StashBase at an existing local directory and indexes it in place. **New folder** opens the same native picker at `~/Documents/StashBase`, so you can create a normal folder with the OS New Folder button and open it immediately.

---

## Retrieval

A StashBase library is the set of local folders you have opened. The default starting point for new folders is `~/Documents/StashBase`, but any local folder can join the library. Inside those folders: HTML, Markdown, PDF, images, plus extracted text and assets stored as rebuildable app data.

User content may live in iCloud-synced Documents, but local databases do not: Milvus indexes and StashBase's SQLite state live under the per-machine app data directory and are regenerated on each device.

Indexing runs locally via [mfs](https://github.com/zilliztech/mfs) + [Milvus Lite](https://milvus.io/docs/milvus_lite.md). The index is **library-wide** (one collection per library), so retrieval works across all opened folders or scoped to one.

### When is content indexed?

* App-internal writes (editor save, drag-and-drop) → indexed immediately
* External writes (other editors, git, scripts, **and agents writing files directly**) → reconciled at deterministic moments: when you return to the window, when an agent finishes a turn, when you open the folder, or on manual Sync
* Other folders → reconciled when you next open them or when an agent calls MCP `reindex`. No library-wide background scanning, so embedding spend stays predictable and visible
* There is no filesystem watcher; an agent that wrote files calls MCP `reindex` to make them searchable (it diffs disk against the index itself)

Renames, moves, and unchanged-content rewrites are detected by content hash and **never re-embed**. Vectors are the only expensive thing here, and they're never computed twice for the same bytes.

### Embedder

OpenAI `text-embedding-3-small` is the single, fixed embedder in V1 (no provider switching). The whole library lives in one Milvus collection. Without an API key, only embedding and semantic search are disabled; files still save and preview, and keyword search (ripgrep, no index involved) keeps working.

### Search

Hybrid retrieval: dense vector kNN + BM25, fused server-side via RRF in a single Milvus query. Hits on PDFs and images map back to the original file; hidden extraction notes never surface. Available through:

* GUI search bar (semantic by default; toggle to exact keyword via ripgrep)
* MCP `search_library` tool for any AI client
* The built-in chat panel (over MCP)

```text
        Built-in chat panel
       (Claude Code / Codex)
                │
                ▼
        ┌─────────────────────┐
        │      StashBase      │
        │  Hybrid retrieval   │
        │  (mfs + Milvus Lite)│
        └─────────┬───────────┘
                  │
              MCP (stdio)
                  │
                  ▼
    Claude Desktop · ChatGPT · Gemini
            any MCP client
```

### One-click MCP connector

**Settings → MCP** writes the StashBase MCP server entry directly into your AI client's global config (Claude Code, Claude Desktop, Codex CLI, Gemini CLI, Qwen Code) or copies the right stdio snippet for GUI-managed clients. One-time setup; afterwards those clients can search the library while the StashBase app is running.

The tool surface is just what the filesystem can't do, since the client is on the same machine as the library:

* **`library_info`** — orient: the default folder home and its member folders
* **`search_library`** — hybrid semantic + keyword search; read the full file directly from the returned path
* **`reindex`** — make on-disk changes searchable after you write (diffs disk against the index itself)

Everything else (reading a full file, creating / editing / deleting / moving notes) the client does with its own filesystem tools directly in the folders.

---

## Agents

### Built-in chat panel (Claude Code / Codex)

A structured chat panel runs Claude Code and Codex inside StashBase: message bubbles, streaming thinking, expandable tool calls, and an inline diff viewer with approve/reject. The design tracks the VS Code Claude extension closely.

* Runs the CLI already on your machine: your login, your subscription, your global config. Nothing separate to install or configure.
* `cwd` automatically set to the current folder, with the same global MCP configuration available
* Reads pass silently; file edits and commands round-trip to you for approval
* Permission modes (default / accept-edits / plan / auto) and thinking-effort switchable in-panel
* Sessions stored in the CLI's standard location (`~/.claude/`): start a conversation in the panel, resume it in your terminal, or the other way around
* Multiple tabs = multiple parallel sessions; files dragged into the panel become temporary context, never library imports

### Agents tidy as they work

Agents organize, link, summarize, and dedupe as a side effect of the work you ask them to do — directed by you, never on a schedule. The working contract (do CRUD with file tools, reindex after writing, tag generated files) reaches the agent over MCP at connect time and through the built-in panel's preamble — there's no rules file to maintain. **No background daemon, no scheduled jobs, no tokens quietly burned.**

---

## Build from source

For contributors and developers building locally, and for platforms without a prebuilt installer (Intel Mac, Windows). End users on Apple Silicon should just use the brew cask, and Linux users can install the Debian package.

```bash
# Setup
git clone https://github.com/liliu-z/stashbase
cd stashbase
pnpm install
pnpm setup:python

# Run the Electron app
pnpm build:web
pnpm electron

# Development mode (hot reload) — run `pnpm electron` in a second
# terminal and it reuses the dev server
pnpm dev

# Build distributable app
pnpm dist          # macOS DMG + zip
pnpm dist:win      # Windows NSIS + zip, built from Windows sidecars
pnpm dist:linux    # Linux Debian (.deb)
pnpm pack:mac      # macOS .app only, faster packaging smoke
pnpm build:python-extract-sidecar # optional: include local PDF/OCR extractor
```

**Debugging.** Dev knobs are plain environment variables — prefix the command, e.g. `STASHBASE_LOG=debug pnpm dev` (daemon ops, conversion timing; also: `STASHBASE_PYTHON=/path/to/python`, `STASHBASE_BUILD_EXTRACT=1`). API keys are NOT env vars — they live in Settings. Renderer logs: View → Toggle Developer Tools. Packaged-app server logs: `~/Library/Logs/StashBase/`.

Before opening a PR:

```bash
pnpm exec tsc --noEmit
pnpm build
```

## Publishing

CI runs typechecks and source builds. Installer packaging is release-only: `Release macOS` builds and uploads the DMG/zip and updates the Homebrew cask, `Release Linux` builds and uploads the Debian package, and `Release Windows` is a placeholder until Windows is supported. The macOS workflow requires a `HOMEBREW_TAP_TOKEN` secret with push access to `liliu-z/homebrew-stashbase`.

`release:verify:mac` is the local preflight: build the macOS package, run packaged smoke checks, and mount the DMG to verify its helper files. `dist:brew` remains the local fallback for macOS publishing: build the macOS package, upload the current version's files in `release.nosync/` to this repository's GitHub Release, then publish the Homebrew cask update. Both force-bundle the ~450MB PDF/OCR extractor sidecar (`STASHBASE_BUILD_EXTRACT=1` + `STASHBASE_REQUIRE_EXTRACT=1`) so distributed builds always support local PDF/OCR extraction — only dev builds (`pnpm build:python-sidecar`) omit it for speed. Use the release workflows' manual `tag` input to backfill an existing release.

```bash
pnpm release:verify:mac
pnpm dist:brew
```

The cask defaults to `liliu-z/stashbase/stashbase`, backed by `git@github.com:liliu-z/homebrew-stashbase.git`; override it with `HOMEBREW_TAP`, `HOMEBREW_TAP_GIT_URL`, or `HOMEBREW_CASK` if needed. GitHub Release asset upload uses `gh` when `GITHUB_TOKEN` is not set, so run `brew install gh && gh auth login` once on a new machine. Homebrew cask publishing commits and pushes directly to the SSH tap repository.

---

## MCP integration

**Settings → MCP** is the normal path (see [Retrieval](#one-click-mcp-connector)). The manual config below is for source builds, or for inspecting the exact settings.

The MCP server is a stdio command:

* Homebrew / packaged app: `~/.stashbase/bin/stashbase-mcp` (generated the first time you connect a client from **Settings → MCP**)
* Source checkout: `npx tsx /absolute/path/to/StashBase/mcp/server.ts`

Point any MCP-aware client at it. Examples use the packaged path — for source builds, substitute the `npx tsx` command. Restart the client after changing MCP servers.

### Claude Code

```bash
claude mcp add stashbase -- ~/.stashbase/bin/stashbase-mcp
```

### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
    }
  }
}
```

Other JSON-configured clients take the same shape in their own MCP settings.

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.stashbase]
command = "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
```

---

## Status

Early alpha. macOS arm64 and Linux x86_64 are the supported platforms today; Windows is post-V1. Screen recording uses the native system picker on macOS 15+; on older versions you can record individual windows, but not full-screen apps.

### Reasonably stable

* library / folder file model on disk (HTML / Markdown / PDF / images + rebuildable extracted text and assets)
* Hybrid retrieval (semantic + keyword), with PDF/image hits mapping back to originals
* MCP library server (stdio) — `library_info` / `search_library` / `reindex`, with everything else done via the client's own filesystem tools; one-click client connectors
* Event-point reconcile (folder open, window focus, agent turn end, manual sync); rename/move without re-embedding
* Conversion pipeline: PDF extraction, image OCR (local), with persisted failures + Retry
* Screen recording → structured note with the original video attached (Gemini video understanding; key required, checked before capture starts)
* Structured Claude chat panel: tool calls, inline diff approve/reject, permission modes, history & resume
* Multi-window, broader folder-management ergonomics, and packaging polish

### Evolving in V1

* **Codex chat panel** — the panel shell is in place; the structured Codex session is landing now
* **Recording pipeline polish** — extraction quality, noise filtering, long recordings
* **Retrieval filters** — file type / time range, pushed down into the index query

### Post-V1

Windows, note-first treatment for dropped-in videos, cloud sync, multi-device, mobile access, team collaboration.

Pin a commit if you're embedding StashBase into a larger workflow.

---

## Contributing

Small focused PRs are preferred. Open an issue before larger changes so scope and direction can be discussed first. Setup, debugging, and release live in [Build from source](#build-from-source) and [Publishing](#publishing) above.

---

## About

Built by Li Liu.

I work on [Milvus](https://github.com/milvus-io/milvus) at [Zilliz](https://zilliz.com), where I've spent the last few years building vector retrieval infrastructure for AI systems.

Coding with agents already feels fluid inside IDEs. Personal knowledge tools still largely don't.

StashBase is my attempt at the missing layer: an agent-native, local-first workspace where papers, notes, transcripts, and saved analysis remain continuously retrievable across AI workflows.

This is a personal side project built in the open. PRs, issues, and experiments are welcome.
