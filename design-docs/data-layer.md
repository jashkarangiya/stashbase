# Data Correctness & Recovery

> StashBase looks simple at the product surface: open a folder, import files, search the library. The hard part is underneath. Conversion and indexing can be interrupted, partially completed, retried, or made stale by external file changes. This document defines how the system avoids lying to itself.

This is not a second architecture document. `architecture.md` explains where modules live and how flows connect. This document explains the correctness contracts that must hold when user operations meet conversion, indexing, AppData, process memory, and failure recovery.

---

# 1. Operation Risk Map

| User operation | What can go wrong | Data-layer contract |
|-|-|-|
| Open a folder | A previous run was interrupted; derived state may be missing, stale, or partial. Recursive listing or status calls may also be slow for large folders. | Reconcile must rediscover missing or incomplete work, but navigation must not wait for recursive listing or status snapshots before entering the folder view. |
| Open a folder with no `AGENTS.md` | The folder becomes an Agent workspace without a stable local instruction entry. | Create a short root-level `AGENTS.md` if missing. Use create-only writes; never overwrite an existing file. The file is user-owned source content, not app-owned state. |
| Land on Welcome | The user may not open any specific folder, but previous library work may still be incomplete. | Welcome triggers folder-explicit reconcile in the background with a cooldown when idle; status polling alone is not recovery. |
| Go Home / close the active folder | Conversion may still be running, while the UI leaves the folder view. | In-flight work is process-owned. The renderer returns to Welcome immediately; server-side folder close runs in the background and must not block navigation. Welcome may keep a display snapshot, but it is not data truth. |
| Open a library folder from Welcome | Folder opening can fail or hang at the transport/action boundary before the folder view appears. | The Welcome opening overlay is only a UI guard: it does not block library clicks, follows the latest click, clears when the latest open action settles, and has a 20s watchdog so it cannot permanently cover the app. |
| Reopen a folder | Old derived text may exist from a partial or legacy conversion. | Completion must be verified, not inferred from file existence alone. |
| Import or copy in a large PDF | Some PDF batches may finish before the app exits or the extractor is killed. | Batch scratch can be reused, but the final PDF note is complete only with the completion marker. |
| Import several PDFs, including scans | Scanned PDFs can monopolize conversion time because OCR is slow. | PDF scheduling probes for a text layer and runs text-layer PDFs before scanned PDFs. |
| Open a folder while other library PDFs are queued | Background library conversion can delay the folder the user is actively trying to search/read. | PDF scheduling prefers queued work in the current folder, then text-layer PDFs, then original enqueue order. Already-running conversions are not preempted. |
| OCR a scanned PDF or image | OCR libraries may use many native threads and make the desktop UI feel stuck even though work is in a child process. | Extractor work runs through a bounded global slot, with conservative native-thread limits and lower OS priority; OCR may take longer, but UI responsiveness has priority. |
| Run without optional native helpers | A packaged build may be missing the PDF/OCR extractor, or a native status-store dependency may fail to load. | Optional preparation/status layers must degrade to warnings or failed preparation records; opening folders and browsing source files must keep working. |
| Import an image | OCR may fail or produce empty text. | Empty OCR text is a preparation failure for search; the source image remains viewable. |
| Search immediately after import | Conversion completion and semantic indexing completion are different clocks. | Keyword search can use completed derived text; semantic search depends on daemon index status only when embeddings are enabled. |
| Reprocess a failed file | Stale derived artifacts or stale failure rows may poison the next attempt. | Reprocess clears the failure row. PDF/image/DOCX sources clear stale final artifacts and queue extraction; directly readable files trigger reconcile/index from source. |
| Add or remove the OpenAI API key | Folder bindings or semantic readiness may reflect stale daemon runtime config. | Reset/rebind the daemon runtime and reconcile library folders after key changes; without a key, semantic search is disabled, not pending. |
| Edit or replace a source file externally | Existing index rows or derived notes may describe old content. | Reconcile compares source identity and content state; stale derived/index state must not be treated as current. |
| Rename or move a file | Old source identity may leave derived artifacts, failure rows, or index rows behind. | Source identity is absolute path; rename/move must remap or clean old app-owned state. |
| Delete a source file | Derived text, failure rows, and index rows may become orphaned. | Cleanup must remove app-owned state for the deleted source. |
| Remove a folder from the library | User files must remain, but app state for that subtree must disappear. | Cancel queued/running conversions, then clear index rows, derived artifacts, preparation rows, sidebar order, runtime bindings, and library membership. |
| Delete a folder inside the active tree | The user intends a real filesystem delete, but app-owned state can become orphaned. | Delete the folder on disk only through the explicit file-tree delete path, then clean derived state, preparation rows, file order, and index rows for that subtree. |
| App restart | Process-memory in-flight state is gone. | Persisted failures survive; incomplete work is rediscovered by reconcile. |
| Start built-in Claude in a folder | Claude Code expects `CLAUDE.md`, while StashBase uses `AGENTS.md` as the shared folder contract. | Create `CLAUDE.md` only when missing, with `@AGENTS.md` as a bridge. Never overwrite an existing `CLAUDE.md`. |
| MCP `reindex` on an unopened folder | There may be no active UI folder context. | Reindex/status must be folder-explicit and must not depend on the current window. |
| Sync after PDF/image/DOCX conversion | The daemon's direct text-file scan may report a converted source row as deleted because the raw source is not directly indexable. | If the source PDF/image/DOCX still exists under the synced folder, sync must preserve the converted index row and its derived artifacts. |

---

# 2. Completion Contracts

Completion is format-specific. A file or row existing somewhere is not always enough.

## Markdown

Markdown is complete when the source file exists and is readable. It is indexed directly from the source file.

## HTML

HTML remains the source file for reading. The extracted text used for indexing is an internal indexing input. HTML extraction is not a user-visible conversion artifact.

## Images

Images remain the source file for viewing and Agent reading. OCR-derived Markdown exists to make image text searchable.

An image conversion is complete when the derived Markdown is current for the source, contains extractable text, and includes the StashBase OCR completion marker. If OCR produces no searchable text, the conversion records a failure instead of pretending the image is searchable.

## PDFs

PDFs are different: the derived Markdown is both the searchable text and the Agent-readable text form.

A PDF conversion is complete only when:

- the derived Markdown exists under `<appData>/derived.nosync/`
- it is current for the source PDF
- it includes the StashBase PDF completion marker

PDF batch scratch is not completion. A marker-less PDF derived note is treated as incomplete and is rediscovered.

## DOCX

DOCX files remain the source files, but StashBase reads them through derived HTML because the app does not provide a native Word renderer.

A DOCX conversion is complete only when:

- the derived HTML exists under `<appData>/derived.nosync/`
- it is current for the source DOCX
- it includes the StashBase DOCX completion marker
- it contains extractable text

The derived HTML is used for preview, Agent text reading, keyword search, and semantic indexing. Search results still point to the source `.docx`.

## Semantic Index

Conversion completion is not semantic indexing completion.

If embedding is unavailable or a daemon index write fails after extraction, conversion can still be complete: derived text exists and keyword search can use it. Semantic availability is determined by daemon index status.

Without an OpenAI API key, semantic search is disabled, not pending. `/api/index-status` reports semantic readiness separately from conversion readiness so the UI can keep keyword search available while showing semantic setup copy instead of an endless preparing state.

---

# 3. Conversion State & Recovery

Conversion has four practical states:

| State | Stored where | Recovery rule |
|-|-|-|
| Queued | Process memory | Exposed through status for search-readiness accounting; lost on process exit and rediscovered by reconcile. |
| In-flight | Process memory | Lost on process exit; rediscovered if derived output is missing or incomplete. |
| Failed | `<appData>/state/state.db` | Durable until user reprocess or source/folder cleanup. |
| Done | Complete derived output on disk | Reused until source changes or artifacts are deleted. |

Transient interruption is not a durable failure. Examples include app exit, cancellation, extractor process termination, or source replacement during conversion. These clear in-flight state and allow the next reconcile to rediscover the source.

On graceful shutdown, StashBase cancels active extractors before closing state storage. Shutdown cancellation is transient: it must not persist a failure row, and the next reconcile must rediscover incomplete work.

Persistent preparation failures are durable. They are not silently retried forever because repeated automatic retries can burn time, CPU, OCR, or embedding budget. The user can reprocess the file manually.

Preparation status is auxiliary. If the status store cannot load, StashBase may lose durable failure markers for that session, but it must not block folder opening, source browsing, or basic search over already available content.

Reprocess does this:

- clears the failure row
- for PDF/image/DOCX sources, removes stale final derived artifacts and queues extraction again
- for directly readable sources, reconciles the folder so the source can be indexed again

For PDFs, reprocess and transient recovery preserve resumable batch scratch when possible, so a large PDF can continue from completed batches instead of starting from page one.

PDF queue priority is an optimization, not a source of truth. Text-layer PDFs are scheduled ahead of scanned PDFs so slow OCR does not block cheaper work. Manual PDF reprocess is prioritized ahead of normal queued work.

PDF text-layer probing is also auxiliary. If the packaged extractor is unavailable, the probe is skipped and the conversion attempt fails quietly as preparation work; the server must not crash.

---

# 4. Incomplete Work & Resume

Incomplete work must never become visible as truth.

PDF extraction is batch-based. Completed batches may exist under AppData while the final derived Markdown is still missing or incomplete. On the next run:

- matching batch scratch can be reused
- stale final note/bundle artifacts are removed before conversion
- the final note is assembled only after all batches complete
- the completion marker is written only at the end

If the app exits halfway through a large PDF, the next open/sync/reindex should resume the remaining work and then assemble a complete final note. Search should not treat partial derived output as complete PDF text.

Images do not have batch resume. If OCR is interrupted before a valid derived note is produced, reconcile queues it again.

---

# 5. Reconcile Rules

Reconcile is the operation that catches the system up with disk reality.

It runs on:

- server boot, after all member folders are bound into the daemon
- Welcome loading the library list, with a per-folder cooldown
- opening or switching a folder
- manual Sync
- MCP `reindex`
- app focus returning
- Agent turn completion
- OpenAI key changes

Reconcile must be folder-explicit. It must not rely on an active window when the caller already names a folder.

For each folder, reconcile checks:

- source files added, modified, deleted, or renamed
- derived text missing, stale, or incomplete
- durable preparation failures that should remain blocked until manual reprocess
- AppData-derived sources whose original source path no longer exists
- daemon index rows that need add/update/delete
- source paths that should no longer surface in search

Only changed content should be embedded. A no-op reconcile should not spend embedding tokens. When no OpenAI key is configured, reconcile still discovers PDF/image/DOCX work and keeps keyword-searchable derived text fresh; semantic indexing is skipped and reported as disabled.

External writes are not immediately searchable. Editors, Git, cloud sync, terminal commands, and external Agents change the filesystem outside StashBase's write path. They become searchable after reconcile. StashBase-owned file helper writes should schedule or perform index maintenance as part of the write when possible.

---

# 6. Cleanup Rules

User files belong to the user. Library removal removes only app-owned state.

Removing a folder from the library:

- removes it from `~/.stashbase/config.json` `recentFolders`
- cancels queued/running conversions under that folder path
- clears semantic index rows under that folder path
- deletes AppData-derived text/assets for sources under that folder
- clears preparation records under that path prefix
- removes AppData sidebar ordering for that folder
- unbinds the folder from the daemon
- never deletes the folder on disk

Library removal returns after membership and UI-visible app state are cleared. Conversion cancellation, derived cleanup, index-row deletion, daemon unbind, and runtime-state cleanup continue as background app-owned cleanup so the Welcome screen does not wait on long-running PDF work.

Deleting a folder from inside an opened folder is a separate filesystem operation. It deletes the user folder on disk after confirmation, then removes derived artifacts, preparation rows, file-order state, and index rows for that subtree.

Deleting a PDF/image/DOCX source clears:

- derived Markdown or derived HTML
- derived bundle
- PDF batch scratch
- derived source manifest entries
- preparation failure/in-flight rows
- index rows for the source path

Reprocessing a PDF/image/DOCX clears stale final derived artifacts and failure rows before queueing extraction. Reprocessing a directly readable source clears the failure row and reconciles the folder. It should not leave old output available as if it belonged to the new attempt.

Renames and moves use absolute source path identity. A file rename request with a basename target stays in the source file's current parent folder; requests with a folder-relative target path are moves. Structured text files can move index rows when the content remains readable. PDF/image/DOCX moves clear old derived artifacts and old index rows, then queue conversion again under the new absolute source path.

---

# 7. State Ownership

| State | Owner | Durable? | Review question |
|-|-|-|-|
| Source files | User filesystem | Yes | Are we ever moving or rewriting user files as app state? |
| Agent rules files | User filesystem (`AGENTS.md`, `CLAUDE.md`) | Yes | Are they created only when missing, never overwritten, and treated as ordinary visible Markdown source files? |
| Library membership | `~/.stashbase/config.json` `recentFolders` | Yes | Does this represent searchable membership, not just MRU? |
| Folder descriptions | `~/.stashbase/config.json` | Yes | Are they treated as orientation metadata, not indexed source content? |
| Derived text/assets | AppData | Rebuildable | Can stale or partial artifacts be mistaken for completion? |
| Derived source manifest | AppData | Rebuildable | Can AppData artifacts still be traced to a source path when semantic indexing is disabled? Is the manifest updated atomically, and do failed cleanups keep enough mapping to reprocess? |
| PDF batch scratch | AppData | Rebuildable/resumable | Is it preserved across transient interruption but removed on source cleanup? |
| MCP launcher wrapper | `~/.stashbase/bin/stashbase-mcp` on macOS/Linux; `%USERPROFILE%\.stashbase\bin\stashbase-mcp.cmd` on Windows | Rebuildable | Is generated client setup kept outside app config and regenerated by the server when needed? |
| Client MCP config | Claude/Codex client config files | Yes | Is Settings writing the target client's own config file, not duplicating config state in StashBase? |
| Vector index | AppData daemon store | Rebuildable | Is the daemon the source of truth for semantic index status? |
| Preparation failures | AppData `state.db` | Yes | Is reprocess possible, and are persistent failures not silently retried forever? |
| In-flight conversions | Process memory | No | Can lost in-flight state be rediscovered? |
| Search readiness snapshot | Renderer memory | No | Is it display-only and reconciled from `/api/index-status`? |

---

# 8. Review Checklist

When reviewing code that touches conversion, indexing, sync, search, folder membership, or AppData cleanup, check these invariants:

- Completion is explicit. A partial artifact cannot be mistaken for done.
- Conversion completion and semantic indexing completion are separate states.
- In-flight state can be lost without making work permanently stuck.
- Persistent failures are reprocessable but not auto-retried forever.
- Reprocess clears stale output before queueing new work.
- Large PDF interruption can resume completed batches.
- Derived artifacts never appear as user-editable source files.
- Search results point to user-facing source paths, not AppData paths.
- Source identity is absolute POSIX path once work enters conversion, indexing, search, or daemon calls.
- Folder-explicit routes work even when no folder is open in the UI.
- HTTP static serving must not intercept or redirect `/api/*` or `/asset/*`;
  file paths need to reach data-route handlers unchanged.
- Packaged native helpers such as ripgrep must spawn from the real unpacked
  filesystem, not from virtual `app.asar` paths.
- Vector-index initialization must preserve atomic-overwrite semantics on every
  platform; Windows must not fail folder open because a rebuildable Milvus Lite
  manifest target already exists.
- Removing a folder from the library deletes app-owned state but never deletes user files.
- Deleting a folder in the active file tree is a real filesystem delete and must clean app-owned state for the deleted subtree.
- `AGENTS.md` and `CLAUDE.md` are not hidden config or derived state. They are ordinary root-level Markdown files and create-only writes must not overwrite user edits.
- UI status snapshots do not become data truth.
- Background preparation is quiet by default. Welcome library rows and affected file rows show failure markers only; in-folder headers do not show preparation badges. The Search view is where pending/failed preparation is summarized because that is where incomplete readiness affects the user.

---

# 9. Representative Failure Modes

These are not historical release notes. They are recurring classes of bugs that the data layer and UI liveness rules must keep preventing.

## 9.1 Navigation Blocked By Preparation

Opening a folder, going Home, or clicking another library folder must feel like navigation, not like indexing.

Representative failure:

- A large PDF or scanned PDF is being prepared.
- A user clicks Home or another library folder.
- The UI waits for a folder-close request, recursive file listing, index status, or Welcome reconcile before visually moving.
- The app appears frozen even though the background work is merely slow.

Current contract:

- Opening a folder establishes renderer folder identity and hides Welcome before `/api/files`, file order, or `/api/index-status` finish.
- Folder-switch side effects such as index sync and Agent-session cleanup are scheduled after the open-folder response, so they cannot turn navigation into a failed request.
- Folder-sync queue cleanup consumes rejected promises; an indexer or daemon startup failure records an index warning but must not exit the Node server.
- Going Home resets renderer folder state and shows Welcome before the server-side close request returns.
- Welcome status polling and reconcile are deferred while a folder open is in progress.
- The Welcome opening overlay is visual only: it must not intercept clicks, follows the latest folder click, and has a watchdog fallback.

## 9.2 Search Readiness Leaking Into Browsing

Preparation state is about search completeness, not file availability.

Representative failure:

- A folder contains files that can be opened and read immediately.
- Some files are still being converted or embedded.
- The folder header shows a preparation badge, making the folder look unfinished or partially unavailable.

Current contract:

- Browsing surfaces stay quiet while preparation is pending.
- The in-folder header shows no preparation or failure badge.
- A durable failure is marked on the affected file row, where the user can locate it.
- Welcome can show a lightweight folder-level failure marker because it does not expose file rows.
- Search is the place that explains how many files are ready and how many are still being prepared.

## 9.3 Background PDF Work Starving The Active Folder

PDF conversion order is a liveness concern, not a correctness source of truth.

Representative failure:

- Welcome or startup queues PDFs from several library folders.
- A user opens one folder and expects its files to become searchable first.
- Already-queued PDFs from other folders occupy the queue before the active folder's PDFs.

Current contract:

- Queued PDFs in the active folder are preferred over queued PDFs in other folders.
- Within that, text-layer PDFs run before scanned PDFs.
- Original enqueue order is the final tie-breaker.
- Already-running conversions are not preempted; the priority rule applies to queued work.

## 9.4 Status Snapshots Becoming Truth

Status exists to explain the system, not to define data correctness.

Representative failure:

- Welcome or the sidebar shows an old readiness snapshot.
- A retry, reprocess, file delete, or folder switch changes the real state.
- The UI treats the old snapshot as authoritative and keeps showing stale readiness.

Current contract:

- Renderer status snapshots are disposable display state.
- Durable failures live in AppData `state.db`.
- Conversion completion is defined by complete derived artifacts and completion markers.
- Semantic readiness is defined by daemon index status.
- Reconcile is the operation that catches storage up with filesystem reality.

## 9.5 Rebuildable Vector State Blocking Folder Open

The vector index is derived state. Initializing it must not prevent browsing a
folder that otherwise exists on disk.

Representative failure:

- A packaged Windows daemon starts with a fresh AppData vector store.
- Milvus Lite creates the collection and then persists index metadata.
- Its manifest update writes `manifest.json.tmp` and renames it over an
  existing `manifest.json`.
- Windows rejects the rename because the target exists, so `bind_folder` fails
  before the server can mark semantic indexing as unavailable or degraded.

Current contract:

- The daemon applies platform compatibility patches before opening Milvus Lite.
- Manifest commits keep the upstream crash-safety shape: write a temporary file,
  keep a `.prev` backup when possible, and atomically replace the current
  manifest.
- If the vector store still fails, the Node server records an index warning; it
  must not turn source-file browsing into a startup crash.

## 9.6 Removed Folder PDF Work Continuing

Folder membership is a source of truth for background preparation. A conversion
queue snapshot must not outlive the user's library removal.

Representative failure:

- A folder with many PDFs is opened and queues background PDF extraction.
- The user removes that folder from the library while one PDF is running.
- Runtime bindings are cleared, so the daemon no longer has a root for that
  path, but the PDF queue continues to start later PDFs from the removed folder.
- Extraction logs keep appearing for the removed folder, followed by
  "no bound root matches path" index warnings.

Current contract:

- Removing a library folder cancels active conversions under that path.
- It also removes queued PDFs under that path and marks the path as cancelled
  for the PDF scheduler, so a stale queue snapshot cannot start the next PDF.
- Reopening the folder clears that scheduler cancellation and allows discovery
  to queue the folder's PDFs again.
