# Overview

StashBase turns local files into Agent-ready context.

HTML, Markdown, PDF, DOCX, images, folders — these files were built for people to store and read, not for Agents to search and reuse. StashBase prepares them for retrieval, indexes them, and exposes the result through MCP.

You choose which local files an Agent should be able to use. The original files stay on your computer. The extracted content and indexes become shared context for Claude, ChatGPT, Codex, and any MCP-capable client.

That is the core value today: **make local files readable and searchable for Agents**.

Over time, as Agents keep using that context and writing new output back into local files, the system grows into a personal knowledge base that can compound.

---

# 1. The Problem

Agents are getting better at complex work, but the local files on a computer are still hard for them to use.

Some formats are not built for Agent reading. PDFs are optimized for display and printing. Scans are images. Web pages carry structure and noise around the content. They may be readable to a person, but not cleanly usable by an Agent.

Even when an Agent can read one file, it still needs to find the right file first. A person can rely on memory: where something was saved, what it looked like, when they last saw it. An Agent without an index cannot search local files by meaning.

The knowledge is already on disk. It just has not become stable, searchable context an Agent can use again and again.

---

# 2. Why Now

Claude Code and Codex have proved that Agents can understand and work inside a large, evolving codebase. They can read across many files, find relevant information, and complete complex tasks with enough context.

If Agents are going to do more work outside code, the next bottleneck is not another chat window. It is access to the working environment: the documents, notes, research, project files, and AI outputs already on the machine.

StashBase focuses on that layer. It takes local knowledge and makes it Agent-ready: converted, indexed, and available across sessions and clients.

---

# 3. Design Rationale

StashBase is not another chat product, and it is not a generic file manager. It is designed to provide a small set of reliable capabilities inside the local working environment: **convert, index, search, and read**. Together, those capabilities turn files that already live on the user's computer into context an Agent can actually use.

AI products need to avoid two extremes. If the product over-specifies buttons, workflows, and user paths, it constrains what the model can do. If it only provides a generic AI entry point, it starts to look like using the base model directly.

StashBase takes a narrower path: define the setting and the capabilities. The setting is the local working environment. The capability is turning local files into Agent-usable context. The workflows users and Agents build on top of that should emerge from real use.

The design rests on four bets:

**Local PCs need context infrastructure.** Enterprise RAG already connects unstructured data to databases and retrieves it semantically for AI. Local search on a personal computer still mostly depends on filenames, paths, grep, or the user's memory. StashBase fills the missing infrastructure layer between local data and Agents on a personal machine.

**Documents need indexing.** Code comes with structure: files, symbols, references, grep, and language servers. Agents can often follow those signals to find context. Documents depend more on meaning, background, timelines, and cross-file relationships. Without a stable index, an Agent cannot reliably find the relevant context inside a document collection.

**Bring your own Agent.** Users are more likely to pay for a few Agents they trust than to buy another embedded Agent inside every tool. StashBase does not build a closed Agent. It exposes local context through MCP so Claude, ChatGPT, Codex, Cursor, and other MCP-capable Agents can use it.

**Product shape.** Long term, StashBase combines an Obsidian-like local file workspace, a VS Code-like Agent panel, and Cursor-like document indexing.

---

# 4. How StashBase Solves It

StashBase currently commits to four concrete capabilities: **Convert**, **Index**, **Search**, and **Read**.

The product surface stays intentionally small: choose local folders, make their contents readable, make them searchable, and expose them to Agents through MCP.

## Convert: prepare hard formats

Local files come in formats that Agents do not handle equally well. StashBase keeps the original files in place and creates derived text only where the format needs it.

- **PDF**: extracts Agent-readable Markdown from files that are awkward for Agents to read directly.
- **DOCX**: extracts semantic HTML so Word documents can be previewed, searched, and read by Agents without changing the source file.
- **Images**: uses OCR so text inside images can be searched.

Derived content is app-owned data and can be regenerated.

## Index: make files searchable

StashBase indexes existing text from Markdown and HTML, PDF-derived Markdown, OCR text from images, and DOCX-derived HTML. Agents can search by meaning and by keyword instead of relying on file names, paths, or manual folder structure.

For the Agent, local files stop being a pile of static documents. They become searchable context.

Everything remains local-first. The source files are local; extracted content and indexes are built from them. Through MCP, any MCP-capable Agent can read and search the same context.

Some Agents can read and write the host filesystem directly. Others run in sandboxes. StashBase supports both: MCP exposes search and reindexing, plus bounded file helpers for the folders the user has opened.

> **A typical loop.** You open an existing folder full of notes, documents, and papers. StashBase gives you a searchable entry point quickly, then keeps converting and indexing the harder formats in the background. When you discuss a related topic in Claude, ChatGPT, or Codex, the Agent can search that folder directly without you uploading files again or remembering exactly where each source lives.

## Search and Read: expose context to Agents

The index is not the end-user experience by itself. StashBase exposes search and read through MCP so Claude, ChatGPT, Codex, and other MCP-capable clients can use the same local context directly.

That interface keeps StashBase at the infrastructure layer. It does not replace the Agent, and it does not require the user to move into a new workspace. StashBase makes local files usable as Agent context; the Agent applies that context to the task at hand.

---

# 5. Principles

**Agent-native.** Whatever a person can read and recall, an Agent should be able to read and search too: human-facing files become usable context, and what a person would recall from memory an Agent retrieves by meaning. The goal is not to make people manage files harder — it is to make the same content first-class for Agents.

**File-first.** Local files are the source of truth. Extracted content, indexes, and product state are derived from files.

**Local-first.** Data stays on the user's computer by default. Cloud can add sync, sharing, or hosting, but the core workflow does not depend on it.

**Open.** StashBase does not lock context inside one AI product, and it does not require users to adopt a new built-in Agent. Through MCP, the same local context can be used by Claude, ChatGPT, Codex, and other clients.

**Small surface.** StashBase does not ask users to learn a new workspace or knowledge-base model. The user chooses local folders; StashBase converts and indexes the files inside them, then exposes them to Agents through search and read. Everything else should justify itself against that core loop.

---

# 6. Why We're Different

StashBase is not another Agent, and it does not try to replace Claude Code, Codex, ChatGPT, or Cursor.

Those products prove the Agent workflow. StashBase gives them better access to the local files on the computer.

The infrastructure layer is simple:

**convert local files into context any Agent can read and search.**

- **Claude Code and Codex** show how Agents can work inside large codebases. StashBase extends that pattern to local files beyond code.
- **NotebookLM** is useful for reading uploaded sources, but the context primarily lives inside NotebookLM. StashBase keeps files local and makes the same context available across Agents.
- **ChatGPT, Claude, and Gemini Projects** maintain context inside their own products. StashBase avoids creating another isolated context silo; it makes local files the shared context layer.
- **Notion, Obsidian, Roam, and Logseq** help people organize knowledge. StashBase focuses on helping Agents read and search knowledge.

StashBase does not own your knowledge or ask you to move into a new workspace. It turns local files into Agent-readable, Agent-searchable context and exposes that context through MCP.

---

# 7. Where It's Going

**Who it's for first.** Developers and technical founders who already use Claude Code, Codex, and Cursor. They know that better context makes Agents dramatically more useful. StashBase brings that workflow from code to local files.

**V1.** The first version focuses on the four core capabilities defined above: Convert, Index, Search, and Read.

MCP makes the same local context available to multiple Agents. Windows, cloud sync, mobile, and team collaboration can come later, but they do not change the core model: make local files readable and searchable for Agents.

**How it grows.** Early growth comes from the Agent community: GitHub, MCP directories, and real workflow demos. The bet is simple: if local files become easy for Agents to read and search, people will reuse more of what they already have instead of re-uploading, re-organizing, and re-explaining context every time.

Agent outputs can enter the same loop. A summary from Claude, a plan from Codex, or a report from a web Agent can become a local file, then be converted, indexed, and reused as context for the next task.

That is how StashBase thinks about knowledge bases: users do not need to build one upfront. Each local file and each Agent output becomes context for future work. When that loop repeats, the knowledge base grows naturally.

**Business.** The core product stays open source under Apache 2.0. Revenue comes from optional services: cloud sync, hosted knowledge services, multi-device access, and shared team context.

The model is open core, closer to Plausible, PostHog, or Sentry. The local file should remain the user's asset; StashBase provides the infrastructure that makes it useful to Agents.
