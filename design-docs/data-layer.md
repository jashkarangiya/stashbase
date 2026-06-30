# Data Layer

> This document describes StashBase data ownership and liveness: which bytes are authoritative, which state is derived, how the index catches up with local files, and what must stay true when folders are opened, removed, renamed, or searched.

---

# 1. Sources of Truth

StashBase has one local **library**: the set of folders in "Your Folders". A folder can live anywhere on disk. The default folder home (`~/Documents/StashBase`) is only where New Folder starts and where the built-in manual is seeded. It is not a boundary, an index scope, or a configurable root.

| Data | Source of truth | Durable? | Notes |
|-|-|-|-|
| User files | Filesystem | Yes | Markdown, HTML, PDF, images, and attachments stay in the user's folder tree. |
| Opened folders | `~/.stashbase/config.json` `recentFolders` | Yes | This is library membership, not a disposable MRU cache. |
| Folder descriptions | `~/.stashbase/config.json` `recentFolders[].description` | Yes | Optional short orientation metadata. Not indexed content and not a scope boundary. |
| Embedder/settings | `~/.stashbase/config.json` | Yes | Includes API key and generated MCP client configuration. |
| Derived text/assets | `<appData>/derived.nosync/` | Rebuildable | PDF/image text extraction and bundles live outside user folders. |
| Vector index | `<appData>/vector-store.nosync/` | Rebuildable | One per-machine Milvus Lite store and one collection. |
| Conversion failures | `<appData>/state/state.db` | Yes | Persisted because a failed conversion looks the same on disk as one that has not run. |
| Sidebar order | `<appData>/file-order/` | Rebuildable | Optional manual ordering keyed by folder path. Removed with folder membership. |
| In-flight work | Process memory | No | Rediscovered by reconcile after restart. |

The rule is simple: user-visible files belong to the user. StashBase-owned state lives in AppData and can be rebuilt unless it records a user-visible failure.

---

# 2. Library Membership

`recentFolders` is the searchable library membership. Opening a folder adds its absolute path to the list. Removing a folder:

- clears semantic index rows under that folder path
- deletes AppData-derived text/assets for sources under that folder
- removes AppData sidebar ordering for that folder
- unbinds the folder from the daemon
- clears conversion/runtime state for that path prefix
- removes it from `recentFolders`
- never deletes the folder on disk

Each `recentFolders` entry may also store a short `description`, with optional `descriptionSource` (`user` or `ai`) and `descriptionUpdatedAt`. This metadata is for orientation only. `library_info()` can expose it so Agents know what each folder is likely to contain before searching. Search and indexing do not depend on it.

At boot, `bootBindAllFolders` binds every member folder into the daemon so MCP search can cover the whole library even before the user opens each folder in the UI.

The active window still shows one folder at a time. That is UI scope only. MCP library scope is all member folders by default.

---

# 3. Identity

The index identity is the **absolute POSIX source path**.

```text
/Users/me/Notes/paper.md
/Users/me/Research/paper.pdf
```

Folder-relative paths exist only at UI and filesystem route boundaries. Once data enters conversion, indexing, search, or daemon calls, it is identified by absolute source path.

Content identity is separate:

- `file_hash`: BLAKE3 hash of the source file content, used by daemon diffing.
- chunk hash: used internally by MFS/Milvus for chunk reuse.

Path identity answers "where should this result open?" Content identity answers "did this file really change?"

---

# 4. Derived Data

Structured files:

- Markdown is indexed directly.
- HTML stays as HTML on disk and is read as HTML; StashBase extracts clean text before indexing.

Files with derived text layers:

- PDFs and images produce derived Markdown under `<appData>/derived.nosync/`.
- PDF derived Markdown is used for both Agent text reading and indexing.
- Image OCR Markdown is used for indexing; the image remains the read/view source.
- Search results map back to the visible source PDF/image. PDF hits use derived Markdown as text context; image hits use OCR text as search evidence.

Derived notes are app-maintained. They are hidden from normal file listings and should not be edited by users or agents as source files.

---

# 5. Reconcile

The index is eventually consistent with the filesystem. StashBase does not run a global background crawler.

Reconcile is triggered by definite events:

- opening or switching a folder
- app focus returning
- an Agent turn ending
- manual Sync
- MCP `reindex`

Reconcile asks the daemon for a content-hash diff, then:

- indexes added files
- re-indexes modified files
- deletes rows for removed files
- fast-paths renames when the content hash matches
- discovers PDF/image sources that need conversion

Only changed content is embedded. A no-op reconcile should not burn embedding tokens.

There are two write paths:

- Writes through StashBase HTTP/MCP file helpers are app-owned writes. They update or schedule index maintenance as part of the operation when possible.
- Writes through external filesystem tools, editors, Git, cloud sync, or an Agent's own sandbox are external writes. They become searchable only after reconcile, so Agents should call `reindex` when they need those changes in search.

---

# 6. Conversion State

Conversion has three practical states:

- **in-flight**: process memory only
- **failed**: persisted in `<appData>/state/state.db`
- **done**: represented by the derived Markdown existing on disk

Failures are persisted because retry behavior needs to survive restart and because automatic retry can burn money on persistently bad files. A failed PDF/image should never become permanently stuck: the user can manually retry extraction. In-flight state is not persisted because the child extractor dies with the process; after restart, reconcile rediscovers sources whose derived note is missing.

Semantic indexing is not part of conversion completion. If embedding is unavailable or an index write fails after extraction, the conversion can still be done: the derived Markdown exists, keyword search can use it, and a later reconcile can add it to the semantic index.

Retry clears the failure row, removes stale derived artifacts, and queues conversion again. Deleting a file or removing a folder clears conversion rows under the relevant absolute source path prefix.

---

# 7. Process Ownership

The Node server owns app logic, file operations, conversion orchestration, and HTTP/MCP routes.

The Python daemon owns chunking, embedding, vector-store writes, and vector search. It receives absolute file paths and text; it does not decide how PDFs, images, or HTML should be prepared for indexing.

There is one daemon for the app server. It owns one app-data vector store and one collection. Folders are registered by absolute path through the daemon's `bind_folder` wire op.

MCP does not open the vector store directly. It forwards retrieval, file-helper, and reindex requests to the running app server.

---

# 8. Invariants

- User files are never moved into AppData.
- App-derived state is never written into user folders. StashBase has no folder-level config; persistent app config lives in `~/.stashbase/config.json`.
- Search, index, and conversion identity is absolute source path, not folder-home-relative path.
- The default folder home is only a default location, not a scope boundary.
- Removing a folder from "Your Folders" must not delete user files, but it should delete StashBase-owned derived state for that folder.
- Folder descriptions are app config metadata. They should be removed with folder membership and must not be treated as indexed user content.
- A failed PDF/image conversion must remain retryable by the user; StashBase should not silently retry persistent failures forever.
- The daemon is the source of truth for index status; Node should not maintain a second indexed-file cache.
- Agents must call `reindex` after external file changes when they need those changes to become searchable. StashBase-owned file helper writes are responsible for their own index maintenance.
