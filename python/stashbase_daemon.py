"""StashBase sidecar daemon.

Owns the **single** Milvus Lite DB at ``<kb_root>/.stashbase/mfs/milvus.db``
and N collections inside it — one per (provider, dimension) pair (e.g.
``vectors_onnx_1024``, ``vectors_openai_1536``). Each space (a folder
directly under the KB root) is **bound** to exactly one collection, the
one matching the embedder provider chosen for that space. New files
under a space write to that space's bound collection.

The Node side (server/mfs-daemon.ts) spawns this script once and talks
to it over stdin/stdout in line-delimited JSON.

Protocol
--------
Each request is one JSON object on a single stdin line:

    {"id": 7, "op": "<name>", "args": {...}}

Each response is one JSON object on a single stdout line:

    {"id": 7, "ok": true,  "result": ...}
    {"id": 7, "ok": false, "error": "..."}

The daemon also emits unsolicited progress events
(``{"event": "ready" | "starting" | "error", ...}``) — Node treats
events as informational and matches results back to requests by ``id``.

Supported ops
-------------
- ``bind_space {space, provider, api_key?, model?, dimension?}``
                        — register that ``space`` writes to the
                          collection for ``provider``. Creates the
                          collection (and the corresponding embedder)
                          on demand. Idempotent; safe to call after a
                          daemon respawn to re-establish state.
- ``unbind_space {space}``
                        — stop routing ``space``'s new files. Existing
                          rows stay; the space can be re-bound later.
- ``upsert {path, content, ext, file_hash?}``
                        — chunk + embed + insert/replace one file.
                          ``path`` is **kbRoot-relative** (e.g.
                          ``cs183b/lecture-01.md``); the space is the
                          first path segment.
- ``delete {path}``     — drop rows for one file. Deletes from all
                          collections (provider may have changed).
- ``delete_prefix {prefix}``
                        — drop rows for files under a folder.
- ``rename {old, new, content, ext, file_hash}``
                        — delete (from all) + re-embed into the new
                          path's bound collection.
- ``rename_prefix {old, new, files}``
                        — folder rename: bulk version.
- ``search {query, space?, top_k}``
                        — hybrid search (dense + BM25 + RRF) across
                          all bound collections, optionally scoped to
                          one space via a ``source like "<space>/%"``
                          filter. Results from multiple collections
                          are re-fused with RRF.
- ``status {space?}``   — name-only diff of disk vs index. ``space``
                          omitted means the whole library.
- ``scan_diff {space?}`` — content-hash diff. ``space`` omitted = whole
                          library.
- ``list {space?}``     — ``{path: file_hash}`` of every indexed file.
                          Scoped by ``space`` prefix when given.
- ``close_store``       — release Milvus Lite's flock so the server can
                          delete or move the DB file.

Paths
-----
``path`` / ``prefix`` / ``old`` / ``new`` in every op are
**kbRoot-relative POSIX** (``cs183b/lecture-01.md``). The first path
segment is the space name; the daemon uses it to look up the bound
collection. The Node side translates between space-relative (its native
representation) and kbRoot-relative at the indexer boundary.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import traceback
from collections import defaultdict
from pathlib import Path
from typing import Any

# Defer all heavy imports until after stdout is unbuffered + greeting
# is printed, so the Node side can tell quickly whether Python even
# launched.
print(json.dumps({"event": "starting", "pid": os.getpid()}), flush=True)


# ---------------------------------------------------------------- embedder
#
# Two providers in v1: MFS's ONNX (`bge-m3-onnx-int8`, 1024d, local) and
# OpenAI (`text-embedding-3-small`, 1536d). Embedders are constructed
# lazily on first bind that needs them — the daemon may have zero
# embedders loaded at idle.

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
    of 10 minutes, and (b) wrap retries around transient errors without
    monkey-patching MFS internals.

    Satisfies MFS's `EmbeddingProvider` protocol: `.embed(texts)`,
    `.dimension`, `.model_name`.
    """

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
    return chunk_file(Path(path_rel), content, effective_ext)


# ---------------------------------------------------------------- store

def _patch_inverted_index_skip() -> None:
    """Drop INVERTED scalar indexes that Milvus Lite refuses.

    MFS adds INVERTED indexes on ``source`` / ``parent_dir`` /
    ``content_type`` / ``is_dir``. Recent pymilvus + Milvus Lite reject
    ``add_index`` calls without ``metric_type``; INVERTED is a scalar
    index with no meaningful metric, so we monkey-patch ``add_index`` to
    swallow them. Affected fields fall back to table-scan filtering,
    which on a single-user KB is comfortably under 10ms. Idempotent —
    flagged via a sentinel attribute on the patched function.
    """
    try:
        from pymilvus.milvus_client.index import IndexParams  # type: ignore
    except ImportError:
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


def _provider_key(provider: str, dim: int) -> str:
    """Stable identifier for a (provider, dim) pair used as both the
    in-process store dict key and the on-disk Milvus collection name
    suffix. Two embedders that produce the same dim with the same
    provider share a collection; switching model within a provider keeps
    routing stable as long as dim doesn't change. (`text-embedding-3-small`
    and `text-embedding-3-large` would differ — 1536 vs 3072.)
    """
    return f"{provider}_{dim}"


def _collection_name(provider_key: str) -> str:
    return f"vectors_{provider_key}"


class StashbaseStore:
    """Holds the kb-root-anchored DB and a lazy pool of per-provider
    ``MilvusStore`` instances, plus the space-to-provider routing table.

    Lifecycle:
        1. ``__init__`` records the kb-root and the resolved
           ``milvus.db`` path. No daemon-side I/O yet.
        2. ``bind_space(space, provider, ...)`` — first call for a
           given provider creates that collection on disk; subsequent
           calls reuse the cached store. Sets ``self._bindings[space]``.
        3. ``store_for_path(path)`` — looks up the bound collection
           for the space implied by ``path``. Raises if unbound.
        4. ``all_stores()`` — every collection currently in use; used
           by full-library reads (search, list, status).

    A daemon respawn loses ``_bindings``; the Node side re-issues
    ``bind_space`` for every known space on reconnect.
    """

    def __init__(self, kb_root: str) -> None:
        self._kb_root: Path = Path(kb_root).resolve()
        self._db_path: Path = self._kb_root / ".stashbase" / "mfs" / "milvus.db"
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # provider_key -> (embedder, MilvusStore)
        self._stores: dict[str, tuple[Any, Any]] = {}
        # space (kb-root-relative, first path segment) -> provider_key
        self._bindings: dict[str, str] = {}

    @property
    def kb_root(self) -> Path:
        return self._kb_root

    def _ensure_store(self, provider_key: str, embedder, dim: int):
        """Open (or reopen) the Milvus collection for ``provider_key``.

        Returns the ``MilvusStore``. Idempotent: a second call for the
        same ``provider_key`` reuses the cached instance. The collection
        is created on first access; the underlying ``milvus.db`` file
        accommodates multiple collections of varying dim side-by-side
        (verified — see ``mfs_probe.py``).
        """
        if provider_key in self._stores:
            return self._stores[provider_key][1]
        from mfs.store import MilvusStore
        from mfs.config import MilvusConfig
        os.environ["MFS_HOME"] = str(self._db_path.parent)
        config = MilvusConfig(uri=str(self._db_path), collection_name=_collection_name(provider_key))
        store = MilvusStore(config, dim)
        _patch_inverted_index_skip()
        try:
            store.connect()
        except Exception as err:
            # Lock-detection logic mirrors the old single-store flow:
            # pymilvus wraps Milvus Lite's lock error generically, so we
            # walk the exception chain (both __cause__ and __context__)
            # and also pattern-match the wrapper message.
            chain = [err]
            cur = err
            seen = {id(err)}
            for _ in range(20):
                nxt = cur.__cause__ or cur.__context__
                if nxt is None or id(nxt) in seen:
                    break
                seen.add(id(nxt))
                chain.append(nxt)
                cur = nxt
            msg = str(err)
            is_lock = (
                'open local milvus failed' in msg.lower()
                or any('lock' in str(e).lower() or 'DataDirLocked' in type(e).__name__ for e in chain)
            )
            if is_lock:
                raise RuntimeError(
                    f"Milvus DB is locked by another process: {self._db_path}\n"
                    f"  Most likely a stale stashbase_daemon from a previous run.\n"
                    f"  Fix: pkill -f stashbase_daemon, then retry."
                ) from err
            raise
        # Milvus Lite leaves freshly-created (and re-opened) collections
        # in the "released" state — queries fail with code=101 until we
        # explicitly load. MFS's ensure_collection doesn't do this for us.
        try:
            store.client.load_collection(config.collection_name)
        except Exception as err:
            print(f"[stashbase] load_collection warn: {err}", file=sys.stderr)
        self._stores[provider_key] = (embedder, store)
        return store

    def bind_space(self, space: str, provider: str, *, api_key=None, model=None, dimension=None) -> dict:
        embedder = make_embedder(provider, model=model, api_key=api_key, dimension=dimension)
        pk = _provider_key(provider, embedder.dimension)
        # Cache embedder per provider_key. Two bindings with the same pk
        # share the embedder instance so we don't reload the 200 MB ONNX
        # model when the second space binds.
        if pk in self._stores:
            self._stores[pk] = (embedder, self._stores[pk][1])
        else:
            self._ensure_store(pk, embedder, embedder.dimension)
        self._bindings[space] = pk
        return {
            "space": space,
            "provider": provider,
            "model": embedder.model_name,
            "dim": embedder.dimension,
            "collection": _collection_name(pk),
        }

    def unbind_space(self, space: str) -> dict:
        had = self._bindings.pop(space, None)
        return {"space": space, "was_bound": had is not None}

    def store_for_path(self, path: str):
        """Look up (embedder, store) for ``path`` (kb-root-relative).
        The space name is the **longest** binding key that's a prefix
        of ``path`` — spaces can be nested (e.g. a user clones the
        cs183b starter into an outer ``Business/`` folder, opens
        ``Business/stashbase-cs183b`` as a space, and the daemon needs
        to route ``Business/stashbase-cs183b/transcripts/...`` to that
        space, not to a non-existent ``Business``)."""
        if "/" not in path:
            # Top-level file directly under kbRoot — not allowed; every
            # file must live inside a space.
            raise RuntimeError(f"path '{path}' is not inside a space (must be '<space>/...')")
        match: str | None = None
        for sp in self._bindings.keys():
            if path == sp or path.startswith(sp + "/"):
                if match is None or len(sp) > len(match):
                    match = sp
        if match is None:
            raise RuntimeError(
                f"no bound space matches path '{path}'; call bind_space first",
            )
        return self._stores[self._bindings[match]]

    def all_stores(self) -> list[tuple[str, Any, Any]]:
        """Returns [(provider_key, embedder, store), ...] for every
        currently-open collection. Used by reads that span providers
        (search, list, status, scan_diff)."""
        return [(pk, emb, st) for pk, (emb, st) in self._stores.items()]

    def close_all(self) -> None:
        """Release Milvus Lite's flock on every collection. Subsequent
        ops will reopen lazily via ``bind_space``."""
        for _emb, store in self._stores.values():
            try:
                store.close()
            except Exception:
                pass
        self._stores.clear()
        self._bindings.clear()


# ---------------------------------------------------------------- ops

def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _require(args: dict, *keys: str) -> None:
    missing = [k for k in keys if args.get(k) is None]
    if missing:
        raise ValueError(f"missing field(s): {', '.join(missing)}")


def op_bind_space(svc: StashbaseStore, args: dict) -> dict:
    """Register ``space`` → ``provider`` mapping. Creates the
    collection if first use; idempotent."""
    _require(args, "space", "provider")
    return svc.bind_space(
        args["space"],
        args["provider"],
        api_key=args.get("api_key"),
        model=args.get("model"),
        dimension=args.get("dimension"),
    )


def op_unbind_space(svc: StashbaseStore, args: dict) -> dict:
    _require(args, "space")
    return svc.unbind_space(args["space"])


def op_upsert(svc: StashbaseStore, args: dict) -> dict:
    """Replace all rows for ``path`` with freshly-embedded chunks.

    Args: ``path`` (kb-root-relative POSIX), ``content`` (raw text /
    pre-flattened HTML-as-markdown), ``ext``, optional ``file_hash``.
    Routes to the bound provider for the space implied by ``path``.
    """
    from mfs.store import ChunkRecord

    _require(args, "path", "content")
    path = args["path"]
    content = args["content"]
    ext = args.get("ext", ".md")
    embedder, store = svc.store_for_path(path)
    chunks = _chunk(path, content, ext)
    file_hash = args.get("file_hash") or _hash_text(content)
    t0 = time.time()

    # Defensive: also wipe the same source from OTHER collections, so
    # if a user switched providers we don't accidentally retain stale
    # rows under the old collection that'd surface in search hits.
    for _pk, _emb, other in svc.all_stores():
        if other is store:
            continue
        try:
            other.delete_by_source(path)
        except Exception:
            pass
    store.delete_by_source(path)
    if not chunks:
        return {"chunks": 0, "embed_ms": 0, "total_ms": int((time.time() - t0) * 1000)}

    texts = [c.text for c in chunks]
    te0 = time.time()
    vectors = embedder.embed(texts)
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
    store.insert_chunks(records)
    return {
        "chunks": len(records),
        "embed_ms": embed_ms,
        "total_ms": int((time.time() - t0) * 1000),
    }


def op_delete(svc: StashbaseStore, args: dict) -> dict:
    """Drop rows whose ``source`` equals ``path`` from every open
    collection — a file may have rows in any collection if the user
    switched providers."""
    _require(args, "path")
    path = args["path"]
    n = 0
    for _pk, _emb, store in svc.all_stores():
        try:
            n += int(store.delete_by_source(path))
        except Exception:
            pass
    return {"removed": n}


def op_rename(svc: StashbaseStore, args: dict) -> dict:
    """Delete-and-reinsert (MFS lacks in-place source update). Old
    rows wiped from all collections; new rows land in the bound
    collection for the new path's space."""
    _require(args, "old", "new", "content")
    for _pk, _emb, store in svc.all_stores():
        try:
            store.delete_by_source(args["old"])
        except Exception:
            pass
    return op_upsert(svc, {
        "path": args["new"],
        "content": args["content"],
        "ext": args.get("ext", ".md"),
        "file_hash": args.get("file_hash"),
    })


def op_rename_prefix(svc: StashbaseStore, args: dict) -> dict:
    """Folder rename — wipe every old-prefix row from all collections,
    then re-embed each file under the new prefix into its bound
    collection."""
    _require(args, "old", "new")
    old_prefix = args["old"].rstrip("/") + "/"
    files = args.get("files", [])
    for _pk, _emb, store in svc.all_stores():
        try:
            store.delete_by_prefix(old_prefix)
        except Exception:
            pass
    total = 0
    for f in files:
        res = op_upsert(svc, {
            "path": f["path"], "content": f["content"], "ext": f.get("ext", ".md"),
            "file_hash": f.get("file_hash"),
        })
        total += int(res.get("chunks", 0))
    return {"files": len(files), "chunks": total}


def op_delete_prefix(svc: StashbaseStore, args: dict) -> dict:
    """Drop every chunk row whose source starts with ``prefix/`` from
    every collection."""
    _require(args, "prefix")
    prefix = args["prefix"].rstrip("/") + "/"
    removed = 0
    for _pk, _emb, store in svc.all_stores():
        try:
            removed += int(store.delete_by_prefix(prefix))
        except Exception:
            pass
    return {"removed": removed}


def op_search(svc: StashbaseStore, args: dict) -> dict:
    """Hybrid search across all bound collections, optionally scoped to
    one ``space``. Each collection's MFS ``hybrid_search`` is already
    RRF-fused (dense + BM25 within the collection); we do a second
    RRF across collections by rank position. ``top_k`` bounded to
    [1, 200]."""
    _require(args, "query")
    query = args["query"].strip()
    space = args.get("space")
    top_k_raw = int(args.get("top_k", 10))
    top_k = max(1, min(200, top_k_raw))
    if not query:
        return {"hits": []}
    stores = svc.all_stores()
    if not stores:
        return {"hits": []}

    # Path filter: MFS's _make_filter applies `source like "<prefix>%"`.
    # Passing `"cs183b/"` constrains to that space; None means whole library.
    path_filter = (space.rstrip("/") + "/") if space else None

    # Collect per-collection hits, each list ranked by score desc.
    # MFS's hybrid_search already returns sorted hits.
    per_store: list[list[Any]] = []
    for _pk, embedder, store in stores:
        try:
            if store.is_empty():
                continue
            qvec = embedder.embed([query])[0]
            hits = store.hybrid_search(qvec, query, path_filter=path_filter, top_k=top_k)
            per_store.append([h for h in hits if not h.is_dir])
        except Exception as exc:
            sys.stderr.write(f"[stashbase] search store failed: {exc}\n")

    if not per_store:
        return {"hits": []}

    # Cross-collection RRF fusion. Key by (source, chunk_index) so the
    # same chunk reported by multiple collections (shouldn't happen
    # post-rebind, but defensive) collapses to one entry.
    K = 60  # RRF damping; matches MFS's intra-collection ranker
    fused: dict[tuple[str, int], dict] = {}
    rep: dict[tuple[str, int], Any] = {}
    for hits in per_store:
        for rank, h in enumerate(hits):
            key = (h.source, h.chunk_index)
            contrib = 1.0 / (K + rank + 1)
            if key in fused:
                fused[key]["score"] += contrib
            else:
                fused[key] = {"score": contrib}
                rep[key] = h
    # Order by fused score descending; emit top_k.
    ranked = sorted(fused.items(), key=lambda kv: kv[1]["score"], reverse=True)[:top_k]
    out = []
    for key, info in ranked:
        h = rep[key]
        out.append({
            "path": h.source,
            "chunk_index": h.chunk_index,
            "chunk_text": h.chunk_text,
            "start_line": h.start_line,
            "end_line": h.end_line,
            "content_type": h.content_type,
            "score": info["score"],
            "metadata": h.metadata or {},
        })
    return {"hits": out}


def op_list(svc: StashbaseStore, args: dict) -> dict:
    """Return ``{path: file_hash}`` for every file with rows across all
    open collections, optionally scoped to one ``space``. A file in
    multiple collections collapses to one entry (last write wins —
    shouldn't matter in practice, files live in exactly one collection
    in the steady state)."""
    space = args.get("space")
    prefix = (space.rstrip("/") + "/") if space else ""
    out: dict[str, str] = {}
    for _pk, _emb, store in svc.all_stores():
        try:
            files = store.get_indexed_files(prefix)
        except Exception:
            continue
        for src, fh in files.items():
            out[src] = fh
    return {"files": out}


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


def _walk_disk(root: Path, rel_prefix: str = "") -> dict:
    """Walk ``root`` returning ``{rel_path: FileInfo}`` for indexable
    files. ``rel_path`` is prefixed with ``rel_prefix`` so callers can
    return kb-root-relative paths even when scanning a single space's
    subdir.

    Filters out anything inside a ``<stem>_files/`` bundle dir and any
    0-byte note — same rules as the sidebar's tree walk.
    """
    scanner = _make_scanner()
    raw = []
    for f in scanner.scan([root]):
        try:
            rel_local = str(f.path.relative_to(root)).replace(os.sep, "/")
        except ValueError:
            continue
        full_rel = f"{rel_prefix}/{rel_local}" if rel_prefix else rel_local
        raw.append((full_rel, rel_local, f))

    # Note-stem detection runs against the local-relative path; only
    # `.md` / `.html` files in the SAME directory can produce a bundle.
    note_stems = set()
    for _full, rel_local, _f in raw:
        base = rel_local.rsplit("/", 1)[-1]
        for ext in (".md", ".markdown", ".html", ".htm"):
            if base.lower().endswith(ext):
                parent = rel_local[: -len(base)]
                stem = base[: -len(ext)]
                note_stems.add(parent + stem)
                break

    on_disk = {}
    for full_rel, rel_local, f in raw:
        if _under_bundle(rel_local, note_stems):
            continue
        try:
            if f.path.stat().st_size == 0:
                continue
        except OSError:
            continue
        on_disk[full_rel] = f
    return on_disk


def _under_bundle(rel: str, note_stems: set) -> bool:
    """True if ``rel`` lives inside a ``<stem>_files/`` bundle whose
    sibling ``<stem>.{md,html}`` we know about."""
    segments = rel.split("/")
    for i, seg in enumerate(segments[:-1]):
        if not seg.endswith("_files"):
            continue
        stem = seg[: -len("_files")]
        parent = "/".join(segments[:i])
        candidate = (parent + "/" + stem) if parent else stem
        if candidate in note_stems:
            return True
    return False


def _walk_for_scope(svc: StashbaseStore, space: str | None) -> dict:
    """Pick the right disk walk for ``status`` / ``scan_diff``:
    - ``space`` given → walk just ``<kb_root>/<space>`` with the space
      name as rel-prefix so returned paths are kb-root-relative.
    - ``space`` omitted → walk every bound space; skip unbound
      directories so we don't count files no collection is responsible
      for.
    """
    if space is not None:
        root = svc.kb_root / space
        return _walk_disk(root, rel_prefix=space)
    out: dict = {}
    for sp in svc._bindings.keys():
        root = svc.kb_root / sp
        out.update(_walk_disk(root, rel_prefix=sp))
    return out


def op_scan_diff(svc: StashbaseStore, args: dict) -> dict:
    """Content-hash diff: catches external edits the name-set diff misses.

    ``args.space`` optional; whole library if omitted.
    """
    scanner = _make_scanner()
    space = args.get("space")
    on_disk = _walk_for_scope(svc, space)
    # Aggregate indexed files across all collections, scoped if needed.
    indexed: dict[str, str] = {}
    prefix = (space.rstrip("/") + "/") if space else ""
    for _pk, _emb, store in svc.all_stores():
        try:
            for src, fh in store.get_indexed_files(prefix).items():
                indexed[src] = fh
        except Exception:
            continue

    added, modified, unchanged = [], [], []
    for rel, f in on_disk.items():
        if rel not in indexed:
            added.append(rel)
            continue
        try:
            disk_hash = scanner.compute_file_hash(f.path)
        except OSError:
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
    """Name-only diff. ``args.space`` optional; whole library if omitted."""
    space = args.get("space")
    on_disk = set(_walk_for_scope(svc, space).keys())
    prefix = (space.rstrip("/") + "/") if space else ""
    indexed: set[str] = set()
    for _pk, _emb, store in svc.all_stores():
        try:
            indexed.update(store.get_indexed_files(prefix).keys())
        except Exception:
            continue

    pending = sorted(on_disk - indexed)
    orphaned_count = len(indexed - on_disk)
    orphaned = sorted(indexed - on_disk)

    return {
        "total": len(on_disk),
        "indexed": len(on_disk & indexed),
        "pending_count": len(pending),
        "pending": pending,
        "orphaned_count": orphaned_count,
        "orphaned": orphaned,
        "up_to_date": len(pending) == 0 and orphaned_count == 0,
    }


def op_close_store(svc: StashbaseStore, _args: dict) -> dict:
    """Release every Milvus Lite flock so the server can move / wipe the
    DB. Next ``bind_space`` reopens lazily."""
    svc.close_all()
    return {}


OPS = {
    "bind_space": op_bind_space,
    "unbind_space": op_unbind_space,
    "upsert": op_upsert,
    "delete": op_delete,
    "delete_prefix": op_delete_prefix,
    "rename": op_rename,
    "rename_prefix": op_rename_prefix,
    "search": op_search,
    "scan_diff": op_scan_diff,
    "status": op_status,
    "list": op_list,
    "close_store": op_close_store,
}


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    import atexit
    import signal

    parser = argparse.ArgumentParser(description="StashBase MFS sidecar daemon")
    parser.add_argument("--kb-root", required=True,
                        help="Absolute path of the StashBase library root; the daemon "
                             "owns one Milvus DB at <kb_root>/.stashbase/mfs/milvus.db")
    parsed, _unknown = parser.parse_known_args()
    try:
        svc = StashbaseStore(parsed.kb_root)
    except Exception as exc:
        _emit({"event": "error", "phase": "store_init", "error": str(exc)})
        return 1

    # Release every Milvus Lite flock cleanly on any exit path. Without
    # this, killing the Node parent leaves the locks held until the kernel
    # reaps the FDs, and the next StashBase launch gets a "DataDirLocked"
    # error from MilvusLite.
    def _cleanup_store(*_):
        try:
            svc.close_all()
        except Exception:
            pass
    atexit.register(_cleanup_store)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            signal.signal(sig, lambda *_: (_cleanup_store(), sys.exit(0)))
        except (ValueError, OSError):
            pass

    _emit({"event": "ready", "kb_root": str(svc.kb_root), "db": str(svc._db_path)})

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
            handler = OPS.get(op)
            if handler is None:
                _emit({"id": req_id, "ok": False, "error": f"unknown op: {op}", "op": op})
                continue
            result = handler(svc, args)
            _emit({"id": req_id, "ok": True, "result": result})
        except (KeyError, ValueError) as exc:
            sys.stderr.write(f"[stashbase] bad args for {op}: {exc}\n")
            _emit({"id": req_id, "ok": False, "error": f"bad args for {op}: {exc}", "op": op})
        except Exception as exc:
            sys.stderr.write(traceback.format_exc())
            sys.stderr.flush()
            _emit({"id": req_id, "ok": False, "error": str(exc), "op": op})

    return 0


if __name__ == "__main__":
    sys.exit(main())
