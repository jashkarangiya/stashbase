# Architecture

> This document describes StashBase's core system architecture. For product motivation and positioning, see [overview](overview.md). This document stays on the main path: how local files become Agent-readable, searchable context exposed through MCP.

---

# 1. System Overview

StashBase turns local files into **Agent-ready context**.

The system has two core jobs:

- **Convert**: turn human-facing formats into cleaner Agent-readable text.
- **Index**: build semantic and keyword indexes so Agents can retrieve local knowledge by meaning.

The output is exposed through MCP, so the same local context can be used by Claude, Codex, ChatGPT, Cursor, and other MCP-capable clients.

At the product level this can feel like a personal knowledge base. At the system level it is one local **library**: ordinary folders on disk, plus derived state that makes those folders readable and searchable for Agents.

```text
Local files -> Convert -> Index -> Retrieve -> MCP -> Agents
       ^                                                |
       |                                                v
       +--------------- Agent-written local files <-----+
```

An Agent can write new output back as local files. Once those files are reindexed, they enter the same loop and become future context.

## 1.1 Runtime Shape

One installation has one desktop app and one local library.

```text
Electron renderer
      |
      | HTTP / WebSocket
      v
Node main process
      |-- file system read/write
      |-- format conversion
      |-- MCP server
      |
      v
Python daemon (MFS)
      |
      v
Milvus Lite vector store
```

The **Node process** owns application logic, file operations, conversion orchestration, and MCP.

The **Python daemon** owns chunking, embedding, storage, and search through MFS/Milvus Lite. It does not know how to convert PDFs, images, or HTML; those decisions stay in StashBase.

The **MCP server** is a Node process. It exposes retrieval, reindexing, and bounded file access to AI clients while the StashBase app is running.

---

# 2. Local Files and Scope

StashBase does not introduce a new workspace model. A user points it at ordinary files and folders on disk. Those paths become the input set for conversion and indexing. The files stay where they are.

## 2.1 Input Paths

- Opening a folder adds that local directory to the indexed set.
- Removing a folder clears StashBase-owned state for that folder — index rows, derived text/assets, conversion state, and runtime bindings. It never deletes the user's files.
- New Folder opens the native folder picker at `~/Documents/StashBase`. The picker creates or selects a normal local folder; the location is a default, not a boundary.
- One app window views one folder at a time. This is UI scope, not a separate library.

## 2.2 Library Scope

One installation has **one library**: the set of opened folders indexed into one collection and exposed by one MCP server.

MCP search defaults to the whole library. Calls can narrow scope by folder root or path prefix. The in-app search UI is scoped to the current window's folder.

Each opened folder can carry a short optional description in app config. The description is orientation metadata for humans and Agents: it explains what the folder is for, but it is not indexed content and it does not define access scope. It can be written by the user first and later generated or refreshed by AI. Removing a folder from "Your Folders" removes its description with the folder membership record.

---

# 3. Storage

The file system is the source of truth. Converted content, indexes, and app state are derived from local files.

## 3.1 Source and Derived Data

User-visible files stay in the folder tree. StashBase has one user-level config file under the user's home directory. Derived state stays in AppData.

```text
~/.stashbase/config.json          # user-level app config: library folders, embedder, MCP clients

<folder>/
  paper.pdf                       # user file

<appData>/vector-store.nosync/    # Milvus Lite store, per-machine derived data
<appData>/derived.nosync/         # converted text and extracted assets
<appData>/state/state.db          # conversion failures
<appData>/file-order/             # sidebar ordering keyed by folder path
```

The important ownership rule is simple:

- **Original files** belong to the user.
- **Converted text and extracted assets** are caches that make non-text formats Agent-readable.
- **Vector indexes and bookkeeping** are rebuildable machine state.

Deleting derived state may require re-conversion or re-embedding, but it should not destroy original user content.

## 3.2 App Config

`~/.stashbase/config.json` is the only persistent app config file. It stores user-level configuration such as the folders in the local library, embedder settings, and generated MCP client configuration.

---

# 4. Format Handling

Different formats have different read and search paths. The product rule is: keep the source file as the user-facing file, and introduce derived Markdown only when search or Agent reading needs a better text representation.

## 4.1 Read Path vs Index Path

| Format | Agent read path | Index input |
|-|-|-|
| Markdown | Source Markdown | Source Markdown |
| HTML | Source HTML | Extracted clean text / Markdown representation |
| Image | Source image | OCR-derived Markdown |
| PDF | Derived Markdown | Derived Markdown |

Markdown is edited, read, and indexed directly.

HTML stays as the source file. StashBase extracts clean text from HTML only as an indexing representation, so embedding and change tracking can operate on stable text. When an Agent reads an HTML file, it reads the original HTML.

Images stay as source images for viewing and Agent reading. OCR-derived Markdown exists to make image text searchable; it is not a replacement for the image itself.

PDFs are different: StashBase converts the document into derived Markdown, and that derived Markdown is used both for search and for Agent text reading.

## 4.2 Derived Markdown

PDFs and images produce derived Markdown stored under AppData:

```text
paper.pdf  -> <appData>/derived.nosync/<source-path-hash>.md
shot.png   -> <appData>/derived.nosync/<source-path-hash>.md
```

Derived Markdown is stored under AppData, but indexed under the original source path when semantic indexing is available. Keyword search can also read the AppData-derived text directly. Search results still point back to the visible source file.

PDF conversion extracts text and layout into Markdown. Image conversion uses OCR. If conversion fails, the original file remains available, but the file is not searchable until conversion succeeds. The failure is visible to the user and can be retried manually.

## 4.3 Conversion Boundary

StashBase owns format-specific preparation. The indexing layer only receives text.

For PDFs, the prepared text is the Agent-readable text form. For HTML and images, the prepared text is an internal indexing input, not a replacement for the source file.

---

# 5. Index

Indexing makes prepared content searchable.

## 5.1 Indexing Layer

StashBase uses MFS as the indexing layer and Milvus Lite as the local vector store.

The index stores chunks, embeddings, source paths, line ranges, and file hashes. Paths are absolute so search results can be handed directly to an Agent's file tools.

## 5.2 Embedding

The current embedder is OpenAI `text-embedding-3-small`.

Without an API key, semantic indexing and semantic retrieval are disabled. File browsing, editing, preview, conversion, and keyword search can still work.

This is the main cloud tradeoff: user files remain local, but embedding generation currently uses a cloud model.

## 5.3 Incremental Updates

The index is updated by deterministic reconciliation, not by a global background crawler.

Reconcile compares local files against indexed records using content hashes. It adds new files, updates changed files, removes deleted files, and avoids re-embedding when content has not changed.

Common triggers include:

- opening or switching a folder
- returning focus to the app
- an Agent turn ending
- manual Sync
- MCP `reindex`

---

# 6. Retrieve

Retrieval is how Agents and the UI find relevant local context.

## 6.1 Search Types

StashBase supports two retrieval paths:

- **Semantic search**: dense vector retrieval, combined with keyword signal through MFS/Milvus.
- **Keyword search**: literal search over source text plus AppData-derived PDF/OCR text, useful when embeddings are unavailable or exact matching is needed.

## 6.2 Scope

Search defaults to the whole library for MCP callers. It can be narrowed by folder root or path prefix.

The desktop UI search is scoped to the current folder because the UI is showing one folder at a time.

## 6.3 Result Mapping

Search results always use the visible source file as the identity and open target.

- **Markdown / HTML**: hits come from the source file text and point to the source file.
- **PDF**: hits come from AppData-derived Markdown. The result points to the original PDF path, but Agent text context should use the derived Markdown.
- **Image**: hits come from AppData OCR Markdown. The result points to the original image path; the OCR text is search evidence, while the image remains the read/view source.

---

# 7. MCP

MCP is the external interface of the library.

StashBase does not embed an LLM. It gives AI clients retrieval tools, explicit reindexing, and sandbox-safe access to opened folders.

## 7.1 Tool Surface

The core MCP tools are:

- **`library_info()`**: returns the default folder home, opened folders, optional folder descriptions, and embedder information so a client can orient itself.
- **`search_library(query, folder?, path_prefix?, top_k?)`**: searches the library and returns source paths, chunks, line ranges, and scores.
- **`reindex(folder?)`**: reconciles disk state with the index after local files change.

StashBase also exposes bounded file helpers:

- **`list_directory(path?)`**
- **`read_file(path)`**
- **`write_file(path, content, baseVersion?)`**
- **`edit_file(path, old_text, new_text, replace_all?, baseVersion?)`**
- **`move_file(path, new_path, cascade?)`**
- **`delete_file(path)`**

These helpers are not a second general-purpose filesystem. They exist because many local Agent clients run in sandboxes where the host user's files are not directly readable or writable. The helpers accept only absolute paths under opened folders, hide app-maintained derived artifacts, and update the semantic index when possible.

The design boundary is:

- MCP provides orientation, retrieval, explicit reindexing, and sandbox-safe access to opened folders.
- StashBase does not expose arbitrary host paths.
- External file changes made outside StashBase must call `reindex` when the Agent needs those changes to become searchable.

## 7.2 One Library, One MCP Server

One machine runs one StashBase library through one MCP server.

External clients and the built-in Agent panel use the same MCP server and the same generated client configuration while the StashBase app is running.

If the StashBase app is not running, the MCP server is unavailable in V1. This keeps process ownership simple.

## 7.3 Permissions

MCP has no separate auth layer. This follows the local-first assumption: any local process that can connect to the running StashBase MCP server is trusted as the local user.

The practical permission boundary in V1 is the opened-folder set. MCP file helpers cannot read or write outside those folders.

Hosted or multi-user versions would need a different permission model.

---

# 8. Built-In Agent Panel

The built-in panel is a convenience client for the same library, not a separate architecture path.

It runs the user's installed Agent CLI in the current folder and relies on the same global MCP configuration used by external clients.

The key architectural point is:

```text
Built-in Agent panel -> same MCP server -> same library
External AI client   -> same MCP server -> same library
```

The panel may add UI affordances such as structured messages, tool approvals, history, and attachments, but those are product/UI details rather than separate library infrastructure.

---

# 9. Boundaries

This architecture document does not try to specify every implementation detail.

Details that belong elsewhere:

- desktop UI layout and interaction details
- PDF/OCR batching, retries, and packaging mechanics
- low-level daemon lifecycle and lock handling
- component/file ownership maps
- built-in Agent panel UI protocol

Those topics can live in engineering notes or module-specific docs. The core architecture remains:

```text
Local files -> Convert -> Index -> Retrieve -> MCP -> Agents
```

StashBase makes local files readable and searchable for Agents.
