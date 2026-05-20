"""StashBase sidecar daemon.

Owns MFS's default ONNX embedding pipeline (bge-m3 int8, 1024-dim,
multilingual) and a per-space Milvus Lite collection. The Node side
(server/mfs-daemon.ts) spawns this script once and talks to it over
stdin/stdout in line-delimited JSON.

Protocol
--------
Each request is one JSON object on a single stdin line:

    {"id": 7, "op": "<name>", "args": {...}}

Each response is one JSON object on a single stdout line:

    {"id": 7, "ok": true,  "result": ...}
    {"id": 7, "ok": false, "error": "..."}

The daemon also emits zero or more unsolicited progress events
(``{"event": "ready" | "indexing" | ...}``) — Node treats events as
informational and matches results back to requests by ``id``.

Supported ops
-------------
- ``set_space {home}``  — change ``MFS_HOME`` and reopen the store.
                          Must be called before any other data op.
- ``upsert {path, content, ext}``
                        — chunk + embed + insert/replace one file.
- ``delete {path}``     — drop all rows for one file.
- ``delete_prefix {prefix}``
                        — drop all rows for files under a folder;
                          used by recursive folder delete.
- ``rename {old, new, content, ext}``
                        — delete + re-embed, not a true rename
                          (MFS has no in-place source update).
- ``rename_prefix {old, new, files}``
                        — folder rename: delete every row under the
                          old prefix, re-embed each file under the new
                          prefix. Painful but correct (gap §3).
- ``search {query, top_k}``  — hybrid search (dense + BM25 + RRF).
- ``scan_diff {root}``  — walk the space with MFS Scanner + diff
                          against current index. Returns
                          ``{added, modified, deleted}`` lists of
                          space-relative paths. Picks up external
                          edits (vim / git checkout) that the
                          in-app save path doesn't go through.
- ``status {root}``     — lightweight progress check. Returns
                          ``{total, indexed, pending_count, pending,
                          orphaned_count, up_to_date}``. ``pending``
                          is the full list of unindexed paths so the
                          web UI can grey out exactly those rows.
                          No hashing — see ``scan_diff`` for that.
- ``set_embedder {provider, model?, api_key?, dimension?}``
                        — swap the embedding provider. Closes the
                          Milvus store if dim changes; server should
                          delete the on-disk DB before next
                          ``set_space`` if it wants the new dim.
- ``close_store``       — release Milvus Lite's flock so the server
                          can delete or move the DB file.

Paths
-----
``path`` in every op is **space-relative POSIX** (``topic/note.md``)
exactly as the Node side stores it. The daemon writes that string
verbatim into Milvus's ``source`` field; no abs-path conversion either
direction. The space root is implicit in ``MFS_HOME`` (which lives
inside the space's ``.stashbase/mfs/``).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import traceback
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

# Defer all heavy imports until after stdout is unbuffered + greeting
# is printed, so the Node side can tell quickly whether Python even
# launched.
print(json.dumps({"event": "starting", "pid": os.getpid()}), flush=True)


# ---------------------------------------------------------------- embedder
#
# Daemon ships with MFS's ONNX provider as the default (`bge-m3-onnx-int8`,
# 1024d, local, ~200 MB downloaded once into `~/.cache/huggingface/`). The
# server can swap it at runtime via `set_embedder` — currently used to
# switch to OpenAI's `text-embedding-3-small` (1536d, API). Provider swap
# closes any open Milvus store; the server is responsible for deleting
# the on-disk Milvus DB before re-binding so the fresh collection picks
# up the new dimension.

def make_embedder(provider: str = "onnx", *, model=None, api_key=None, dimension=None):
    """Build an embedding provider satisfying MFS's protocol
    (`.embed(texts) -> list[list[float]]`, `.dimension`, `.model_name`).

    OpenAI is rolled in-house — see `_OpenAIEmbedder` for why we don't
    use `mfs.embedder.get_provider('openai')`. ONNX (and any future
    provider) goes through MFS.
    """
    if provider == "openai":
        if not api_key:
            raise ValueError("openai embedder requires api_key")
        return _OpenAIEmbedder(
            model=model or "text-embedding-3-small",
            api_key=api_key,
            dimension=dimension,
        )
    from mfs.embedder import get_provider
    kwargs = {}
    if model is not None:
        kwargs["model"] = model
    if api_key is not None:
        kwargs["api_key"] = api_key
    if dimension is not None:
        kwargs["dimension"] = dimension
    return get_provider(provider, **kwargs)


class _OpenAIEmbedder:
    """OpenAI embedding provider, rolled in-house.

    Rolled separately from `mfs.embedder.get_provider('openai')` so we can
    (a) cap the OpenAI client timeout at 60s instead of the SDK default
    of 10 minutes — a stalled embed-on-save shouldn't lock up indexing
    for ten minutes before the user can retry — and (b) wrap retries
    around transient errors without monkey-patching MFS internals.

    Satisfies MFS's `EmbeddingProvider` protocol used by `StashbaseStore`:
    `.embed(texts) -> list[list[float]]`, `.dimension`, `.model_name`.
    """

    # OpenAI's matryoshka-style truncation lets us request a smaller dim
    # via the `dimensions` parameter; passing None falls back to the
    # model's native size.
    _NATIVE_DIMS = {
        "text-embedding-3-small": 1536,
        "text-embedding-3-large": 3072,
        "text-embedding-ada-002": 1536,
    }

    def __init__(self, *, model: str, api_key: str, dimension: int | None = None,
                 timeout: float = 60.0, max_retries: int = 3, base_delay: float = 1.5) -> None:
        import openai
        self._openai = openai
        self._client = openai.OpenAI(api_key=api_key, timeout=timeout)
        self.model_name = model
        self.dimension = dimension or self._NATIVE_DIMS.get(model, 1536)
        self._max_retries = max(1, max_retries)
        self._base_delay = base_delay

    def embed(self, texts: list[str]) -> list[list[float]]:
        transient = (
            self._openai.APITimeoutError,
            self._openai.APIConnectionError,
            self._openai.RateLimitError,
            self._openai.InternalServerError,
        )
        # Only forward `dimensions` when it diverges from the model's
        # native size — older OpenAI models reject the parameter.
        native = self._NATIVE_DIMS.get(self.model_name)
        kwargs: dict = {"model": self.model_name, "input": texts}
        if native is not None and self.dimension != native:
            kwargs["dimensions"] = self.dimension
        last_err: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                resp = self._client.embeddings.create(**kwargs)
                return [d.embedding for d in resp.data]
            except transient as err:
                last_err = err
                if attempt == self._max_retries - 1:
                    raise
                delay = self._base_delay * (2 ** attempt)
                print(
                    f"[stashbase] openai embed attempt {attempt + 1}/{self._max_retries} "
                    f"failed ({type(err).__name__}); retrying in {delay:.1f}s",
                    file=sys.stderr,
                )
                time.sleep(delay)
        # Unreachable: the final transient raise re-raises; non-transient
        # errors propagate without entering this branch. Guards against
        # someone tightening `max_retries=0` later and silently returning
        # None into Milvus as if it were a vector.
        raise RuntimeError(f"embed retry loop exhausted: {last_err}")


# ---------------------------------------------------------------- chunking

def _chunk(path_rel: str, content: str, ext: str):
    """Route to MFS's chunker. Returns list of MFS ``Chunk``.

    HTML is fed in as markdown-shaped plaintext by the Node side (see
    ``server/html.ts``), so we always pass ``.md`` to MFS regardless
    of the on-disk extension — the chunker doesn't know HTML and would
    otherwise fall back to dumb char splits.
    """
    from mfs.ingest.chunker import chunk_file
    effective_ext = ".md" if ext in (".html", ".htm") else ext
    # `path` is only used for content_type routing; the real source key
    # is set in the ChunkRecord below.
    return chunk_file(Path(path_rel), content, effective_ext)


# ---------------------------------------------------------------- store

def _patch_inverted_index_skip() -> None:
    """Drop INVERTED scalar indexes that Milvus Lite refuses.

    MFS adds INVERTED indexes on `source` / `parent_dir` / `content_type`
    / `is_dir` to speed up filter queries. Recent pymilvus + Milvus Lite
    versions are stricter: they reject any ``add_index`` call without an
    explicit ``metric_type``, but INVERTED is a scalar index type that
    has no meaningful metric. For now we monkey-patch ``add_index`` to
    swallow these calls — the affected fields fall back to table-scan
    filtering, which on a single-user KB is comfortably under 10ms.
    Idempotent: safe to call before every ``connect()``.

    The idempotency check reads a sentinel attribute off ``add_index``
    itself rather than a module-global flag — that way a re-import or
    hot-reload can't get the global out of sync with the actually-
    installed function.
    """
    try:
        from pymilvus.milvus_client.index import IndexParams  # type: ignore
    except ImportError:
        # Layout shifts across pymilvus versions — if we can't find the
        # symbol the collection create will surface the real error, no
        # need to mask it here.
        return
    if getattr(IndexParams.add_index, "__stashbase_patched__", False):
        return
    original = IndexParams.add_index

    def _add_index(self, field_name, index_type=None, index_name="", **kwargs):
        if index_type == "INVERTED" and not kwargs.get("metric_type"):
            return self
        return original(self, field_name=field_name, index_type=index_type,
                        index_name=index_name, **kwargs)

    _add_index.__stashbase_patched__ = True  # type: ignore[attr-defined]
    IndexParams.add_index = _add_index


class StashbaseStore:
    """Thin wrapper around ``mfs.store.MilvusStore`` keyed by space.

    The Node side calls ``set_space`` whenever the user switches; we
    close the old store and open a fresh one against the new
    ``MFS_HOME``. Lazy-loaded on first data op so cold start cost
    lands on the user's first interaction, not on daemon spawn.
    """

    def __init__(self, embedder) -> None:
        # `embedder` satisfies the MFS `EmbeddingProvider` protocol:
        # `.embed(texts) -> list[list[float]]` + `.dimension` + `.model_name`.
        self._embedder = embedder
        self._store = None
        self._home: Path | None = None

    def set_space(self, home: str) -> None:
        from mfs.store import MilvusStore
        from mfs.config import MilvusConfig

        new_home = Path(home).resolve()
        new_home.mkdir(parents=True, exist_ok=True)
        os.environ["MFS_HOME"] = str(new_home)

        # Close any existing connection cleanly; MilvusClient holds a
        # file lock on the Lite db.
        if self._store is not None:
            try:
                self._store.close()
            except Exception:
                pass

        config = MilvusConfig(uri=str(new_home / "milvus.db"))
        self._store = MilvusStore(config, self._embedder.dimension)
        _patch_inverted_index_skip()
        try:
            self._store.connect()
        except Exception as err:
            # Milvus Lite uses flock() on the data dir. A stale daemon
            # from a crashed earlier run holds the lock and prevents us
            # from opening the same DB. pymilvus wraps this as
            # ConnectionConfigException("Open local milvus failed"),
            # so we walk __cause__ to find the real reason and surface
            # an actionable message — "pkill -f stashbase_daemon" beats
            # staring at a generic error.
            # Walk both __cause__ (explicit `raise ... from`) and
            # __context__ (implicit chain from raising inside except).
            # pymilvus uses the latter, hiding the real lock error.
            chain = [err]
            cur = err
            seen = {id(err)}
            for _ in range(20):  # depth cap, paranoia
                nxt = cur.__cause__ or cur.__context__
                if nxt is None or id(nxt) in seen:
                    break
                seen.add(id(nxt))
                chain.append(nxt)
                cur = nxt
            # Milvus Lite's lock error gets swallowed by pymilvus and
            # rethrown as a generic "Open local milvus failed". The
            # original DataDirLockedError lives across a thread boundary
            # and isn't reachable via __cause__ / __context__, so we
            # match on the wrapper message as a heuristic — this exact
            # phrasing is only ever produced for local-DB connection
            # failures, and the lock conflict is by far the most common.
            msg = str(err)
            is_lock = (
                'open local milvus failed' in msg.lower()
                or any('lock' in str(e).lower() or 'DataDirLocked' in type(e).__name__ for e in chain)
            )
            if is_lock:
                raise RuntimeError(
                    f"Milvus DB is locked by another process: {new_home / 'milvus.db'}\n"
                    f"  Most likely a stale stashbase_daemon from a previous run.\n"
                    f"  Fix: pkill -f stashbase_daemon, then retry."
                ) from err
            raise
        # Recent Milvus Lite leaves freshly-created (and re-opened)
        # collections in the "released" state — any query fails with
        # code=101 until we explicitly load it into memory. MFS's
        # ensure_collection doesn't do this for us; one extra call here
        # keeps it transparent to the rest of the daemon.
        try:
            self._store.client.load_collection(config.collection_name)
        except Exception as err:
            # If load_collection isn't supported in this pymilvus build
            # (Milvus Lite skipped the no-op in older versions), let
            # downstream ops surface the real error rather than masking it.
            print(f"[stashbase] load_collection warn: {err}", file=sys.stderr)
        self._home = new_home

    @property
    def store(self):
        if self._store is None:
            raise RuntimeError("set_space must be called before any data op")
        return self._store

    @property
    def embedder(self):
        return self._embedder

    def set_embedder(self, embedder) -> None:
        """Swap in a new embedding provider and close the current store
        unconditionally.

        We used to only close on dim change. That was wrong: two
        same-dim providers (e.g. two 1024d ONNX models, or a finetune
        vs base) produce vectors that live in different spaces, so
        mixing old + new rows in one collection silently corrupts
        ranking. The Node side always re-issues `set_space` after
        `set_embedder` anyway, so the close here is the cheap part —
        what matters is that we never serve a hybrid index.
        """
        self._embedder = embedder
        if self._store is not None:
            try:
                self._store.close()
            except Exception:
                pass
            self._store = None
            self._home = None

    def close_store(self) -> None:
        """Release Milvus Lite's flock so the server can delete / move
        the on-disk DB file. Next `set_space` reopens fresh."""
        if self._store is None:
            return
        try:
            self._store.close()
        except Exception:
            pass
        self._store = None
        self._home = None



# ---------------------------------------------------------------- ops

def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _require(args: dict, *keys: str) -> None:
    """Validate required fields are present (not None) in an op args dict.

    A full Pydantic / TypedDict layer would be overkill — the protocol
    has 11 ops, each with 1-4 fields — but raw `args["x"]` access in
    handlers turns a missing field into an opaque `KeyError: 'x'` that
    Node surfaces verbatim. One ``_require`` call at the top of every op
    converts that into ``{"error": "missing field(s): x", "op": "..."}``
    which the Node side can log / display meaningfully.
    """
    missing = [k for k in keys if args.get(k) is None]
    if missing:
        raise ValueError(f"missing field(s): {', '.join(missing)}")


def op_upsert(svc: StashbaseStore, args: dict) -> dict:
    """Replace all rows for ``path`` with freshly-embedded chunks.

    Args: ``path`` (space-relative POSIX), ``content`` (raw text or
    pre-flattened HTML-as-markdown), ``ext`` (file extension, default
    ``.md``), optional ``file_hash`` (sha256 of original bytes — used by
    ``scan_diff`` to detect external edits).

    MFS's chunker may emit zero chunks for an empty file — we still
    issue the delete so the file effectively disappears from the
    index instead of leaving stale rows."""
    from mfs.store import ChunkRecord

    _require(args, "path", "content")
    path = args["path"]
    content = args["content"]
    ext = args.get("ext", ".md")
    chunks = _chunk(path, content, ext)

    # Prefer the hash Node computed over the original on-disk content,
    # so it matches what Scanner.compute_file_hash will produce later
    # during sync_diff. Falling back to hashing `content` only works
    # when content == disk bytes (markdown), not for the HTML path
    # where content has been transformed to markdown-shaped text.
    file_hash = args.get("file_hash") or _hash_text(content)
    t0 = time.time()

    svc.store.delete_by_source(path)
    if not chunks:
        return {"chunks": 0, "embed_ms": 0, "total_ms": int((time.time() - t0) * 1000)}

    texts = [c.text for c in chunks]
    te0 = time.time()
    vectors = svc.embedder.embed(texts)
    embed_ms = int((time.time() - te0) * 1000)

    parent = "/".join(path.split("/")[:-1])
    records = []
    for i, (ch, vec) in enumerate(zip(chunks, vectors)):
        records.append(ChunkRecord(
            id=hashlib.sha256(
                f"{path}:{ch.start_line}:{ch.end_line}:{_hash_text(ch.text)}".encode(),
            ).hexdigest()[:32],
            source=path,
            parent_dir=parent,
            chunk_index=i,
            start_line=ch.start_line,
            end_line=ch.end_line,
            chunk_text=ch.text,
            dense_vector=vec,
            content_type=ch.content_type,
            file_hash=file_hash,
            is_dir=False,
            embed_status="complete",
            metadata=ch.metadata or {},
            account_id="stashbase",
        ))
    svc.store.insert_chunks(records)
    return {
        "chunks": len(records),
        "embed_ms": embed_ms,
        "total_ms": int((time.time() - t0) * 1000),
    }


def op_delete(svc: StashbaseStore, args: dict) -> dict:
    """Drop all rows whose ``source`` equals ``path``."""
    _require(args, "path")
    n = svc.store.delete_by_source(args["path"])
    return {"removed": int(n)}


def op_rename(svc: StashbaseStore, args: dict) -> dict:
    """Delete-and-reinsert (MFS lacks in-place source update).

    Args: ``old``, ``new`` (both space-relative POSIX), ``content``
    (new file body), ``ext``, ``file_hash``.
    """
    _require(args, "old", "new", "content")
    svc.store.delete_by_source(args["old"])
    return op_upsert(svc, {
        "path": args["new"],
        "content": args["content"],
        "ext": args.get("ext", ".md"),
        "file_hash": args.get("file_hash"),
    })


def op_rename_prefix(svc: StashbaseStore, args: dict) -> dict:
    """Folder rename — delete every old-prefix row, re-embed each file
    under the new prefix.

    Args: ``old``, ``new`` (folder paths), ``files`` (list of
    ``{path, content, ext?, file_hash?}`` for every file under ``new``;
    may be empty if the folder had no indexable content).

    Node supplies the full list of files so we don't have to re-walk
    disk; total time scales with content, not with file count.
    """
    _require(args, "old", "new")
    old_prefix = args["old"].rstrip("/") + "/"
    files = args.get("files", [])
    svc.store.delete_by_prefix(old_prefix)
    total = 0
    for f in files:
        res = op_upsert(svc, {
            "path": f["path"], "content": f["content"], "ext": f.get("ext", ".md"),
            "file_hash": f.get("file_hash"),
        })
        total += int(res.get("chunks", 0))
    return {"files": len(files), "chunks": total}


def op_delete_prefix(svc: StashbaseStore, args: dict) -> dict:
    """Drop every chunk row whose source starts with ``prefix/``.
    Used by folder-delete (recursive) to clear the index in one
    Milvus call instead of per-file deletes. Safe to call with no
    matching rows — store returns 0."""
    _require(args, "prefix")
    prefix = args["prefix"].rstrip("/") + "/"
    removed = svc.store.delete_by_prefix(prefix)
    return {"removed": int(removed)}


def op_search(svc: StashbaseStore, args: dict) -> dict:
    """Hybrid search via Milvus server-side BM25 + RRFRanker.

    `top_k` is bounded to [1, 200]. The upper limit is defensive: a
    misconfigured MCP client could otherwise pass an absurd `top_k`
    and OOM the daemon assembling the result list. 200 is well past
    anything a human search UI needs and still cheap for Milvus Lite.
    """
    _require(args, "query")
    query = args["query"].strip()
    top_k_raw = int(args.get("top_k", 10))
    top_k = max(1, min(200, top_k_raw))
    if not query:
        return {"hits": []}

    if svc.store.is_empty():
        return {"hits": []}

    qvec = svc.embedder.embed([query])[0]
    raw_hits = svc.store.hybrid_search(qvec, query, path_filter=None, top_k=top_k)
    return {
        "hits": [
            {
                "path": h.source,
                "chunk_index": h.chunk_index,
                "chunk_text": h.chunk_text,
                "start_line": h.start_line,
                "end_line": h.end_line,
                "content_type": h.content_type,
                "score": h.score,
                "metadata": h.metadata or {},
            }
            for h in raw_hits if not h.is_dir
        ],
    }


def op_list(svc: StashbaseStore, _args: dict) -> dict:
    """Return ``{path: file_hash}`` for every file with rows in the
    index. Used by the Node-side ``MfsIndexer`` to prime its in-memory
    indexed-names cache after ``set_space``, so subsequent ``status()``
    calls don't have to round-trip through the daemon (which would
    queue behind any in-flight embed and freeze the UI poll)."""
    return {"files": svc.store.get_indexed_files("")}


def _make_scanner():
    """Configure an MFS Scanner for our space layout.

    Two tweaks over MFS defaults:
      - `.html` / `.htm` aren't in `INDEXED_EXTENSIONS`, inject via
        `IndexingConfig.include_extensions`
      - `.stashbase/` is our sidecar dir and must be skipped
    """
    from mfs.config import Config, IndexingConfig
    from mfs.ingest.scanner import Scanner
    config = Config(indexing=IndexingConfig(include_extensions=[".html", ".htm"]))
    return Scanner(config, extra_excludes=[".stashbase/", ".stashbase"])


def _walk_disk(space_root: Path) -> dict:
    """Return ``{space_relative_path: FileInfo}`` for every indexable
    file under ``space_root``. Absolute paths from Scanner get
    translated to space-relative POSIX at this boundary.

    Also filters out anything inside a ``<stem>_files/`` bundle dir —
    those hold a note's iframe assets (images, JS, CSS, fonts) and
    must never be embedded. The Node-side ``files.ts:walk`` already
    hides bundles from the sidebar; this is the daemon-side equivalent
    for ``scan_diff`` / ``status``."""
    scanner = _make_scanner()
    raw = []
    for f in scanner.scan([space_root]):
        try:
            rel = str(f.path.relative_to(space_root))
        except ValueError:
            continue
        raw.append((rel.replace(os.sep, "/"), f))

    # Build the set of "note stems" at each directory level so we know
    # which `<stem>_files/` dirs are real bundles vs. coincidentally-
    # named user folders. Stem = parent path + filename minus the
    # `.md` / `.html` extension.
    note_stems = set()
    for rel, _ in raw:
        base = rel.rsplit("/", 1)[-1]
        for ext in (".md", ".markdown", ".html", ".htm"):
            if base.lower().endswith(ext):
                parent = rel[: -len(base)]
                stem = base[: -len(ext)]
                note_stems.add(parent + stem)
                break

    on_disk = {}
    for rel, f in raw:
        if _under_bundle(rel, note_stems):
            continue
        try:
            if f.path.stat().st_size == 0:
                continue
        except OSError:
            continue
        on_disk[rel] = f
    return on_disk


def _under_bundle(rel: str, note_stems: set) -> bool:
    """True if ``rel`` lives inside any ``<stem>_files/`` bundle dir
    whose ``<stem>.{md,html}`` note we know about."""
    segments = rel.split("/")
    # Walk segment prefixes — at each, check whether the segment is
    # `<X>_files` and `<parent>/X` is a known note stem.
    for i, seg in enumerate(segments[:-1]):  # exclude the filename itself
        if not seg.endswith("_files"):
            continue
        stem = seg[: -len("_files")]
        parent = "/".join(segments[:i])
        candidate = (parent + "/" + stem) if parent else stem
        if candidate in note_stems:
            return True
    return False


def op_scan_diff(svc: StashbaseStore, args: dict) -> dict:
    """Walk the space + content-hash diff against the index.

    Catches the external-edit drift case the name-set diff misses:
    file present in both disk and index but with different content
    (vim / git checkout / Dropbox sync). Hashes every disk file once
    per call — for big vaults this is the slow op.

    See ``op_status`` for a cheaper name-only version.
    """
    _require(args, "root")
    scanner = _make_scanner()
    space_root = Path(args["root"]).resolve()
    on_disk = _walk_disk(space_root)
    indexed = svc.store.get_indexed_files("")  # {source: file_hash}

    added, modified, unchanged = [], [], []
    for rel, f in on_disk.items():
        if rel not in indexed:
            added.append(rel)
            continue
        try:
            disk_hash = scanner.compute_file_hash(f.path)
        except OSError:
            # Unreadable file — leave alone, don't pretend it's modified
            unchanged.append(rel)
            continue
        if disk_hash != indexed[rel]:
            modified.append(rel)
        else:
            unchanged.append(rel)
    deleted = [rel for rel in indexed if rel not in on_disk]

    return {
        "added": added,
        "modified": modified,
        "deleted": deleted,
        "unchanged_count": len(unchanged),
    }


def op_status(svc: StashbaseStore, args: dict) -> dict:
    """Lightweight progress check — name-set diff only, no hashing.

    Designed for two callers:
      - Claude (via MCP `index_status` tool): "is search caught up?"
      - The web UI: greys out file rows that aren't indexed yet,
        polling until `up_to_date`.

    Cheap on big vaults: O(files) directory walk + one Milvus name
    query, no per-file sha256. Doesn't detect external content drift
    — use `scan_diff` for that.

    `pending` is the **full** list of unindexed file names (not a
    sample); the UI needs all of them to grey out the right rows.
    Worst-case payload is small even for 10k-file vaults (~500 KB).
    """
    _require(args, "root")
    space_root = Path(args["root"]).resolve()
    on_disk = set(_walk_disk(space_root).keys())
    indexed = set(svc.store.get_indexed_files("").keys())

    pending = sorted(on_disk - indexed)
    orphaned_count = len(indexed - on_disk)

    return {
        "total": len(on_disk),
        "indexed": len(on_disk & indexed),
        "pending_count": len(pending),
        "pending": pending,
        "orphaned_count": orphaned_count,
        "up_to_date": len(pending) == 0 and orphaned_count == 0,
    }


# ---------------------------------------------------------------- loop

def op_set_embedder(svc: StashbaseStore, args: dict) -> dict:
    """Swap the embedding provider. Server must call this before
    `set_space` if the dimension changes — and must have deleted the
    on-disk Milvus DB for any space about to be reopened."""
    _require(args, "provider")
    provider = args["provider"]
    embedder = make_embedder(
        provider,
        model=args.get("model"),
        api_key=args.get("api_key"),
        dimension=args.get("dimension"),
    )
    svc.set_embedder(embedder)
    return {"provider": provider, "model": embedder.model_name, "dim": embedder.dimension}


def op_close_store(svc: StashbaseStore, _args: dict) -> dict:
    """Release the Milvus Lite flock so the server can `rm` the DB file."""
    svc.close_store()
    return {}


OPS = {
    "upsert": op_upsert,
    "delete": op_delete,
    "delete_prefix": op_delete_prefix,
    "rename": op_rename,
    "rename_prefix": op_rename_prefix,
    "search": op_search,
    "scan_diff": op_scan_diff,
    "status": op_status,
    "list": op_list,
    "set_embedder": op_set_embedder,
    "close_store": op_close_store,
}


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    import atexit
    import signal

    try:
        embedder = make_embedder()
    except Exception as exc:
        _emit({"event": "error", "phase": "embedder_init", "error": str(exc)})
        return 1
    svc = StashbaseStore(embedder)

    # Release Milvus Lite's flock cleanly on any exit path. Without
    # this, killing the Node parent (or daemon crashing) leaves the
    # lock held until the kernel reaps the FD, and the next StashBase
    # launch gets `another process holds the lock` from MilvusLite.
    def _cleanup_store(*_):
        try:
            if svc._store is not None:
                svc._store.close()
        except Exception:
            pass
    atexit.register(_cleanup_store)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(sig, lambda *_: (_cleanup_store(), sys.exit(0)))
        except (ValueError, OSError):
            pass

    _emit({"event": "ready", "model": embedder.model_name, "dim": embedder.dimension})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            op = req["op"]
            args = req.get("args", {}) or {}
        except (ValueError, KeyError) as exc:
            _emit({"id": None, "ok": False, "error": f"bad request: {exc}"})
            continue

        try:
            if op == "set_space":
                _require(args, "home")
                svc.set_space(args["home"])
                _emit({"id": req_id, "ok": True, "result": None})
                continue
            handler = OPS.get(op)
            if handler is None:
                _emit({"id": req_id, "ok": False, "error": f"unknown op: {op}", "op": op})
                continue
            result = handler(svc, args)
            _emit({"id": req_id, "ok": True, "result": result})
        except (KeyError, ValueError) as exc:
            # Argument validation failure — clean message back to Node,
            # short stderr breadcrumb (no full traceback — these are
            # caller bugs and tracebacks would just be noise).
            sys.stderr.write(f"[stashbase] bad args for {op}: {exc}\n")
            _emit({"id": req_id, "ok": False, "error": f"bad args for {op}: {exc}", "op": op})
        except Exception as exc:
            # Full traceback to stderr so the Node side can surface it
            # in the developer console; short message in the JSON reply
            # so the UI doesn't get spammed.
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            _emit({"id": req_id, "ok": False, "error": str(exc), "op": op})

    return 0


if __name__ == "__main__":
    sys.exit(main())
