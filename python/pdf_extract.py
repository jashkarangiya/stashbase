#!/usr/bin/env python
"""PDF → markdown + image bundle.

Invoked by `server/pdf.ts` after the user drags a PDF into a folder.
Writes a derived note (`.<stem>.md`, dot-prefixed because it's an
app-maintained artifact rather than user content) alongside the PDF
and an image bundle dir named `.<stem>_files/` containing every
embedded image — matches the HTML-import convention so the rest of
StashBase (indexer / iframe asset routing / rename-cascade) treats
the result the same as a hand-imported note.

Uses `pymupdf4llm.to_markdown(write_images=True)` for structured markdown
and image extraction. If that richer layout pass fails on a PDF that still
has a readable text layer, falls back to plain PyMuPDF text extraction so
the PDF can still be searched.

Output shape is always:

    .<stem>.md          (dot-prefixed app-derived note)
    .<stem>_files/      (dot-prefixed image bundle)
        ...png

Args: ``<pdf> <out_note> <bundle_dir>``.

Exits 0 on success, non-zero on failure with a diagnostic on stderr.
"""

from __future__ import annotations

import argparse
import gc
import json
import multiprocessing
import os
import queue
import shutil
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

DEFAULT_BATCH_SIZE = 4
DEFAULT_OCR_DPI = 300
DEFAULT_OCR_MAX_MPIX = 12.0
DEFAULT_BATCH_TIMEOUT_S = 180.0


def parse_page_range(raw: str | None) -> list[int] | None:
    if raw is None or raw.strip() == "":
        return None
    m = raw.strip().split("-", 1)
    try:
        start = int(m[0])
        end = int(m[1]) if len(m) == 2 and m[1] else start
    except ValueError as err:
        raise argparse.ArgumentTypeError("pages must be like 3 or 3-10") from err
    if start < 1 or end < start:
        raise argparse.ArgumentTypeError("pages must be 1-based and increasing")
    return list(range(start - 1, end))


def parse_batch_size(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as err:
        raise argparse.ArgumentTypeError("batch size must be a positive integer") from err
    if value < 1:
        raise argparse.ArgumentTypeError("batch size must be a positive integer")
    return value


def parse_positive_float(raw: str) -> float:
    try:
        value = float(raw)
    except ValueError as err:
        raise argparse.ArgumentTypeError("value must be a positive number") from err
    if value <= 0:
        raise argparse.ArgumentTypeError("value must be a positive number")
    return value


def parse_non_negative_float(raw: str) -> float:
    try:
        value = float(raw)
    except ValueError as err:
        raise argparse.ArgumentTypeError("value must be a non-negative number") from err
    if value < 0:
        raise argparse.ArgumentTypeError("value must be a non-negative number")
    return value


def _pymupdf_module():
    try:
        import pymupdf  # type: ignore[import-not-found]
        return pymupdf
    except ImportError:
        try:
            import fitz as pymupdf  # type: ignore[import-not-found,no-redef]
            return pymupdf
        except ImportError as import_error:
            raise RuntimeError("plain PyMuPDF fallback unavailable") from import_error


def _page_text(page: object) -> str:
    get_text = getattr(page, "get_text")
    text = get_text("text")
    return text if isinstance(text, str) else ""


def _selected_pages(pdf_path: Path, pages: list[int] | None) -> list[int]:
    pymupdf = _pymupdf_module()
    with pymupdf.open(str(pdf_path)) as doc:
        page_count = len(doc)
    selected = list(range(page_count)) if pages is None else pages
    invalid = [p + 1 for p in selected if p < 0 or p >= page_count]
    if invalid:
        raise RuntimeError(f"page range outside PDF length ({page_count} pages): {invalid[0]}")
    if not selected:
        raise RuntimeError("page range selected no pages")
    return selected


def _batches(items: list[int], size: int) -> list[list[int]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def _source_signature(pdf_path: Path) -> dict[str, int]:
    st = pdf_path.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def _resume_dir_for(out_path: Path) -> Path:
    return out_path.with_name(f"{out_path.name}.batches")


def _resume_meta(
    pdf_path: Path,
    page_batches: list[list[int]],
    batch_size: int,
    ocr_max_mpix: float,
) -> dict[str, Any]:
    return {
        "version": 1,
        "source": str(pdf_path),
        "source_signature": _source_signature(pdf_path),
        "page_batches": page_batches,
        "batch_size": batch_size,
        "ocr_max_mpix": ocr_max_mpix,
    }


def _prepare_resume_dir(
    resume_dir: Path,
    pdf_path: Path,
    page_batches: list[list[int]],
    batch_size: int,
    ocr_max_mpix: float,
) -> None:
    expected = _resume_meta(pdf_path, page_batches, batch_size, ocr_max_mpix)
    meta_path = resume_dir / "meta.json"
    if resume_dir.exists():
        try:
            current = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            current = None
        if current != expected:
            shutil.rmtree(resume_dir, ignore_errors=True)
    resume_dir.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(expected, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.rmtree(resume_dir / "work", ignore_errors=True)


def _resume_batch_paths(resume_dir: Path, batch_index: int) -> tuple[Path, Path, Path]:
    batch_note = resume_dir / f"batch-{batch_index:04d}.md"
    batch_bundle = resume_dir / f"batch-{batch_index:04d}_files"
    batch_meta = resume_dir / f"batch-{batch_index:04d}.json"
    return batch_note, batch_bundle, batch_meta


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def _read_resume_batch(
    resume_dir: Path,
    page_batch: list[int],
    batch_index: int,
    batch_count: int,
) -> tuple[int, str, str, bool] | None:
    batch_note, batch_bundle, batch_meta = _resume_batch_paths(resume_dir, batch_index)
    if not batch_note.is_file() or not batch_bundle.is_dir() or not batch_meta.is_file():
        return None
    try:
        meta = json.loads(batch_meta.read_text(encoding="utf-8"))
    except Exception:
        return None
    if meta.get("pages") != page_batch:
        return None
    print(
        f"[pdf_extract] batch {batch_index}/{batch_count} pages "
        f"{page_batch[0] + 1}-{page_batch[-1] + 1} resumed",
        file=sys.stderr,
        flush=True,
    )
    return batch_index, str(batch_note), str(batch_bundle), bool(meta.get("has_text"))


def _persist_resume_batch(
    resume_dir: Path,
    page_batch: list[int],
    result: tuple[int, str, str, bool],
) -> tuple[int, str, str, bool]:
    batch_index, batch_note_raw, batch_bundle_raw, has_text = result
    final_note, final_bundle, final_meta = _resume_batch_paths(resume_dir, batch_index)
    final_note_tmp = final_note.with_suffix(f"{final_note.suffix}.tmp")
    final_bundle_tmp = resume_dir / f"{final_bundle.name}.tmp"
    final_meta_tmp = final_meta.with_suffix(f"{final_meta.suffix}.tmp")

    try:
        final_note_tmp.unlink(missing_ok=True)
    except OSError:
        pass
    shutil.rmtree(final_bundle_tmp, ignore_errors=True)
    os.replace(batch_note_raw, final_note_tmp)
    os.replace(batch_bundle_raw, final_bundle_tmp)
    final_meta_tmp.write_text(
        json.dumps({"pages": page_batch, "has_text": has_text}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    shutil.rmtree(final_bundle, ignore_errors=True)
    os.replace(final_bundle_tmp, final_bundle)
    os.replace(final_note_tmp, final_note)
    os.replace(final_meta_tmp, final_meta)
    return batch_index, str(final_note), str(final_bundle), has_text


def _ocr_dpi_for_pages(
    pdf_path: Path,
    pages: list[int],
    *,
    base_dpi: int = DEFAULT_OCR_DPI,
    max_mpix: float = DEFAULT_OCR_MAX_MPIX,
) -> int:
    pymupdf = _pymupdf_module()
    max_pixels = max_mpix * 1_000_000
    dpi = base_dpi
    with pymupdf.open(str(pdf_path)) as doc:
        for page_index in pages:
            rect = doc[page_index].rect
            rendered_pixels = (rect.width / 72 * base_dpi) * (rect.height / 72 * base_dpi)
            if rendered_pixels > max_pixels:
                page_dpi = int((max_pixels / (rect.width * rect.height)) ** 0.5 * 72)
                dpi = min(dpi, max(72, page_dpi))
    return dpi


def _plain_text_for_pages(
    pdf_path: Path,
    pages: list[int],
    *,
    include_title: bool,
    allow_empty_pages: bool,
) -> tuple[str, bool]:
    pymupdf = _pymupdf_module()
    try:
        with pymupdf.open(str(pdf_path)) as doc:
            chunks: list[str] = []
            has_text = False
            for page_index in pages:
                page = doc[page_index]
                text = _page_text(page).strip()
                if text:
                    has_text = True
                    chunks.append(f"## Page {page_index + 1}\n\n{text}")
                elif allow_empty_pages:
                    chunks.append(f"## Page {page_index + 1}\n\n[No extractable text on this page]")
            title = pdf_path.stem.replace("_", " ").replace("-", " ").strip() or pdf_path.name
            body = "\n\n".join(chunks)
            if body:
                prefix = f"# {title}\n\n" if include_title else ""
                return f"{prefix}{body}\n", has_text
            raise RuntimeError("no extractable text layer")
    except Exception:
        raise


def _fallback_plain_text(pdf_path: Path, original_error: Exception, pages: list[int] | None = None) -> str:
    """Recover searchable text when pymupdf4llm's richer layout pass fails.

    Some PDFs open normally but trip pymupdf4llm internals while walking
    layout structures (for example ``'NoneType' object is not iterable``).
    Plain PyMuPDF text extraction is less structured, but preserving a
    searchable derived note is better than marking the whole PDF failed.
    """
    try:
        md, _has_text = _plain_text_for_pages(
            pdf_path,
            _selected_pages(pdf_path, pages),
            include_title=True,
            allow_empty_pages=False,
        )
        return md
    except Exception as fallback_error:
        raise RuntimeError(
            f"pymupdf4llm failed ({original_error}); plain PyMuPDF fallback failed ({fallback_error})"
        ) from fallback_error


def _rewrite_batch_assets(md: str, batch_bundle: Path, final_bundle_name: str, batch_index: int) -> str:
    """Give per-batch image files stable unique names and point markdown at
    the final bundle. Separate workers may otherwise emit the same image
    basename."""
    for asset in list(batch_bundle.iterdir()):
        if not asset.is_file():
            continue
        old_abs = str(asset)
        new_name = f"batch{batch_index:04d}-{asset.name}"
        new_abs = batch_bundle / new_name
        os.replace(asset, new_abs)
        final_ref = f"{final_bundle_name}/{new_name}"
        md = md.replace(old_abs, final_ref)
        md = md.replace(old_abs.replace(os.sep, "/"), final_ref)
        md = md.replace(f"]({asset.name})", f"]({final_ref})")
    abs_prefix = str(batch_bundle) + os.sep
    return md.replace(abs_prefix, final_bundle_name + "/").strip()


def _page_marked_markdown(page_number: int, text: str) -> str:
    body = text.strip()
    if not body:
        return ""
    return f"<!-- stashbase-pdf-page: {page_number} -->\n\n{body}"


def _markdown_from_page_chunks(value: object, fallback_pages: list[int]) -> tuple[str, bool]:
    if isinstance(value, str):
        return value, bool(value.strip())
    if not isinstance(value, list):
        raise TypeError(f"pymupdf4llm returned {type(value).__name__}, expected str or page chunk list")
    parts: list[str] = []
    has_text = False
    for index, chunk in enumerate(value):
        text = ""
        page_number = fallback_pages[index] + 1 if index < len(fallback_pages) else index + 1
        if isinstance(chunk, dict):
            raw_text = chunk.get("text")
            if isinstance(raw_text, str):
                text = raw_text
            meta = chunk.get("metadata")
            if isinstance(meta, dict) and isinstance(meta.get("page_number"), int):
                page_number = int(meta["page_number"])
        elif isinstance(chunk, str):
            text = chunk
        marked = _page_marked_markdown(page_number, text)
        if marked:
            parts.append(marked)
            has_text = True
    return "\n\n".join(parts), has_text


def _convert_batch_worker(args: tuple[str, list[int], int, int, str, str, float]) -> tuple[int, str, str, bool]:
    pdf_path_raw, page_batch, batch_index, batch_count, bundle_name, tmp_parent_raw, ocr_max_mpix = args
    pdf_path = Path(pdf_path_raw)
    tmp_parent = Path(tmp_parent_raw)
    batch_bundle = Path(tempfile.mkdtemp(
        prefix=f"{bundle_name}.batch-{batch_index:04d}-",
        dir=str(tmp_parent),
    ))
    tmp_fd, batch_note_name = tempfile.mkstemp(
        prefix=f"{bundle_name}.batch-{batch_index:04d}-",
        suffix=".md",
        dir=str(tmp_parent),
        text=True,
    )
    os.close(tmp_fd)
    batch_note = Path(batch_note_name)
    print(
        f"[pdf_extract] batch {batch_index}/{batch_count} pages "
        f"{page_batch[0] + 1}-{page_batch[-1] + 1} started",
        file=sys.stderr,
        flush=True,
    )
    try:
        import pymupdf4llm  # type: ignore[import-not-found]

        has_text = False
        ocr_dpi = _ocr_dpi_for_pages(pdf_path, page_batch, max_mpix=ocr_max_mpix)
        if ocr_dpi < DEFAULT_OCR_DPI:
            print(
                f"[pdf_extract] batch {batch_index}/{batch_count} pages "
                f"{page_batch[0] + 1}-{page_batch[-1] + 1} using ocr_dpi={ocr_dpi} "
                f"(cap {ocr_max_mpix:g}MP/page)",
                file=sys.stderr,
                flush=True,
            )
        try:
            md = pymupdf4llm.to_markdown(
                str(pdf_path),
                write_images=True,
                image_path=str(batch_bundle),
                image_format="png",
                ocr_dpi=ocr_dpi,
                pages=page_batch,
                page_chunks=True,
            )
            md_text, has_text = _markdown_from_page_chunks(md, page_batch)
            batch_text = _rewrite_batch_assets(md_text, batch_bundle, bundle_name, batch_index)
        except Exception as err:
            shutil.rmtree(batch_bundle, ignore_errors=True)
            batch_bundle = Path(tempfile.mkdtemp(
                prefix=f"{bundle_name}.batch-{batch_index:04d}-",
                dir=str(tmp_parent),
            ))
            print(
                f"[pdf_extract] pymupdf4llm rich extraction unavailable for pages "
                f"{page_batch[0] + 1}-{page_batch[-1] + 1}; using plain text fallback: {err}",
                file=sys.stderr,
                flush=True,
            )
            batch_text, has_text = _plain_text_for_pages(
                pdf_path,
                page_batch,
                include_title=False,
                allow_empty_pages=True,
            )
            batch_text = batch_text.strip()
        batch_note.write_text(batch_text + ("\n" if batch_text else ""), encoding="utf-8")
        print(
            f"[pdf_extract] batch {batch_index}/{batch_count} pages "
            f"{page_batch[0] + 1}-{page_batch[-1] + 1} done",
            file=sys.stderr,
            flush=True,
        )
        del batch_text
        try:
            del md
        except UnboundLocalError:
            pass
        gc.collect()
        return batch_index, str(batch_note), str(batch_bundle), has_text
    except Exception:
        try:
            batch_note.unlink(missing_ok=True)
        except OSError:
            pass
        shutil.rmtree(batch_bundle, ignore_errors=True)
        raise


def _convert_batch_plain_text_worker(
    args: tuple[str, list[int], int, int, str, str, float],
    reason: str,
) -> tuple[int, str, str, bool]:
    pdf_path_raw, page_batch, batch_index, batch_count, bundle_name, tmp_parent_raw, _ocr_max_mpix = args
    pdf_path = Path(pdf_path_raw)
    tmp_parent = Path(tmp_parent_raw)
    batch_bundle = Path(tempfile.mkdtemp(
        prefix=f"{bundle_name}.batch-{batch_index:04d}-",
        dir=str(tmp_parent),
    ))
    tmp_fd, batch_note_name = tempfile.mkstemp(
        prefix=f"{bundle_name}.batch-{batch_index:04d}-",
        suffix=".md",
        dir=str(tmp_parent),
        text=True,
    )
    os.close(tmp_fd)
    batch_note = Path(batch_note_name)
    print(
        f"[pdf_extract] pymupdf4llm rich extraction unavailable for pages "
        f"{page_batch[0] + 1}-{page_batch[-1] + 1}; using plain text fallback: {reason}",
        file=sys.stderr,
        flush=True,
    )
    try:
        batch_text, has_text = _plain_text_for_pages(
            pdf_path,
            page_batch,
            include_title=False,
            allow_empty_pages=True,
        )
        batch_text = batch_text.strip()
        batch_note.write_text(batch_text + ("\n" if batch_text else ""), encoding="utf-8")
        print(
            f"[pdf_extract] batch {batch_index}/{batch_count} pages "
            f"{page_batch[0] + 1}-{page_batch[-1] + 1} done",
            file=sys.stderr,
            flush=True,
        )
        return batch_index, str(batch_note), str(batch_bundle), has_text
    except Exception:
        try:
            batch_note.unlink(missing_ok=True)
        except OSError:
            pass
        shutil.rmtree(batch_bundle, ignore_errors=True)
        raise


def _batch_child_main(
    out_queue: "multiprocessing.Queue[tuple[str, tuple[int, str, str, bool] | str]]",
    args: tuple[str, list[int], int, int, str, str, float],
) -> None:
    try:
        out_queue.put(("ok", _convert_batch_worker(args)))
    except BaseException:
        out_queue.put(("err", traceback.format_exc()))


def _multiprocessing_context() -> multiprocessing.context.BaseContext:
    methods = multiprocessing.get_all_start_methods()
    if "fork" in methods:
        return multiprocessing.get_context("fork")
    return multiprocessing.get_context()


def _run_batch_with_timeout(
    args: tuple[str, list[int], int, int, str, str, float],
    batch_timeout_s: float,
) -> tuple[int, str, str, bool]:
    if batch_timeout_s == 0:
        return _convert_batch_worker(args)

    _pdf_path_raw, page_batch, batch_index, _batch_count, _bundle_name, _tmp_parent_raw, _ocr_max_mpix = args
    ctx = _multiprocessing_context()
    out_queue = ctx.Queue(maxsize=1)
    proc = ctx.Process(target=_batch_child_main, args=(out_queue, args))
    proc.start()
    proc.join(batch_timeout_s)
    if proc.is_alive():
        proc.terminate()
        proc.join(5)
        if proc.is_alive():
            proc.kill()
            proc.join()
        return _convert_batch_plain_text_worker(
            args,
            f"batch timed out after {batch_timeout_s:g}s",
        )

    try:
        status, payload = out_queue.get_nowait()
    except queue.Empty:
        if proc.exitcode == 0:
            raise RuntimeError("batch worker exited without a result")
        raise RuntimeError(f"batch worker exited {proc.exitcode}")

    if status == "ok":
        return payload  # type: ignore[return-value]
    if status == "err":
        raise RuntimeError(str(payload).strip())
    raise RuntimeError(f"batch worker returned unknown status {status!r}")


def _run_batches(
    pdf_path: Path,
    page_batches: list[list[int]],
    bundle_name: str,
    tmp_parent: Path,
    ocr_max_mpix: float,
    batch_timeout_s: float,
    resume_dir: Path,
) -> list[tuple[int, str, str, bool]]:
    args = [
        (str(pdf_path), page_batch, index, len(page_batches), bundle_name, str(tmp_parent), ocr_max_mpix)
        for index, page_batch in enumerate(page_batches, start=1)
    ]
    results: list[tuple[int, str, str, bool]] = []
    for arg in args:
        _pdf_path_raw, page_batch, batch_index, batch_count, _bundle_name, _tmp_parent_raw, _ocr_max_mpix = arg
        resumed = _read_resume_batch(resume_dir, page_batch, batch_index, batch_count)
        if resumed is not None:
            results.append(resumed)
            continue
        result = _run_batch_with_timeout(arg, batch_timeout_s)
        results.append(_persist_resume_batch(resume_dir, page_batch, result))
    return results


def convert_with_pymupdf(
    pdf_path: Path,
    out_path: Path,
    bundle_dir: Path,
    pages: list[int] | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    ocr_max_mpix: float = DEFAULT_OCR_MAX_MPIX,
    batch_timeout_s: float = DEFAULT_BATCH_TIMEOUT_S,
) -> None:
    """`pymupdf4llm.to_markdown` writes a markdown document and dumps
    each figure / chart region as a PNG into `image_path`. We point
    it at the dot-prefixed bundle dir and then rewrite the absolute
    image URLs it emits into bundle-relative refs so the resulting
    markdown stays portable when the folder moves."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bundle_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_note_name = tempfile.mkstemp(
        prefix=f"{out_path.name}.tmp-",
        dir=str(out_path.parent),
        text=True,
    )
    os.close(tmp_fd)
    tmp_note = Path(tmp_note_name)
    tmp_bundle = Path(tempfile.mkdtemp(
        prefix=f"{bundle_dir.name}.tmp-",
        dir=str(bundle_dir.parent),
    ))
    try:
        selected_pages = _selected_pages(pdf_path, pages)
        wrote_any_text = False
        wrote_body = False
        title = pdf_path.stem.replace("_", " ").replace("-", " ").strip() or pdf_path.name
        page_batches = _batches(selected_pages, batch_size)
        resume_dir = _resume_dir_for(out_path)
        _prepare_resume_dir(resume_dir, pdf_path, page_batches, batch_size, ocr_max_mpix)
        batch_parent = resume_dir / "work"
        batch_parent.mkdir(parents=True, exist_ok=True)
        try:
            results = _run_batches(
                pdf_path,
                page_batches,
                bundle_dir.name,
                batch_parent,
                ocr_max_mpix,
                batch_timeout_s,
                resume_dir,
            )
            with tmp_note.open("w", encoding="utf-8") as out:
                out.write(f"# {title}\n\n")
                for (_batch_index, batch_note_raw, batch_bundle_raw, has_text), page_batch in zip(results, page_batches):
                    batch_note = Path(batch_note_raw)
                    batch_bundle = Path(batch_bundle_raw)
                    is_resume_artifact = _is_relative_to(batch_note, resume_dir)
                    try:
                        for asset in batch_bundle.iterdir():
                            if asset.is_file():
                                target = tmp_bundle / asset.name
                                if is_resume_artifact:
                                    shutil.copy2(asset, target)
                                else:
                                    os.replace(asset, target)
                        wrote_any_text = wrote_any_text or has_text
                        batch_text = batch_note.read_text(encoding="utf-8").strip()
                        if batch_text:
                            if wrote_body:
                                out.write("\n\n")
                            page_start = page_batch[0] + 1
                            page_end = page_batch[-1] + 1
                            if page_start == page_end:
                                out.write(f"<!-- stashbase-pdf-pages: {page_start} -->\n\n")
                            else:
                                out.write(f"<!-- stashbase-pdf-pages: {page_start}-{page_end} -->\n\n")
                            out.write(batch_text)
                            out.write("\n")
                            wrote_body = True
                        out.flush()
                    finally:
                        if not is_resume_artifact:
                            try:
                                batch_note.unlink(missing_ok=True)
                            except OSError:
                                pass
                            shutil.rmtree(batch_bundle, ignore_errors=True)
        finally:
            shutil.rmtree(batch_parent, ignore_errors=True)
        if not wrote_any_text:
            raise RuntimeError("no extractable text layer")
        if tmp_bundle.exists():
            shutil.rmtree(bundle_dir, ignore_errors=True)
            os.replace(tmp_bundle, bundle_dir)
        os.replace(tmp_note, out_path)
        shutil.rmtree(resume_dir, ignore_errors=True)
    except Exception:
        try:
            tmp_note.unlink(missing_ok=True)
        except OSError:
            pass
        shutil.rmtree(tmp_bundle, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="PDF → markdown + bundle for StashBase.")
    parser.add_argument("pdf")
    parser.add_argument("out_path", help="Target note path (`.<stem>.md`).")
    parser.add_argument("bundle_dir", help="Bundle dir (`.<stem>_files/`) to dump images into.")
    parser.add_argument("--pages", type=parse_page_range, help="1-based inclusive page range, e.g. 3 or 3-10.")
    parser.add_argument(
        "--batch-size",
        type=parse_batch_size,
        default=parse_batch_size(os.environ.get("STASHBASE_PDF_BATCH_SIZE", str(DEFAULT_BATCH_SIZE))),
        help=f"Pages per extraction batch. Default: {DEFAULT_BATCH_SIZE}.",
    )
    parser.add_argument(
        "--ocr-max-mpix",
        type=parse_positive_float,
        default=parse_positive_float(os.environ.get("STASHBASE_PDF_OCR_MAX_MPIX", str(DEFAULT_OCR_MAX_MPIX))),
        help=f"Maximum OCR render size per page in megapixels. Default: {DEFAULT_OCR_MAX_MPIX:g}.",
    )
    parser.add_argument(
        "--batch-timeout-s",
        type=parse_non_negative_float,
        default=parse_non_negative_float(os.environ.get("STASHBASE_PDF_BATCH_TIMEOUT_S", str(DEFAULT_BATCH_TIMEOUT_S))),
        help=f"Seconds before a page batch falls back to plain text. Use 0 to disable. Default: {DEFAULT_BATCH_TIMEOUT_S:g}.",
    )
    args = parser.parse_args()

    pdf_path = Path(args.pdf).resolve()
    out_path = Path(args.out_path).resolve()
    bundle_dir = Path(args.bundle_dir).resolve()
    if not pdf_path.is_file():
        print(f"[pdf_extract] not a file: {pdf_path}", file=sys.stderr)
        return 2

    try:
        convert_with_pymupdf(
            pdf_path,
            out_path,
            bundle_dir,
            args.pages,
            args.batch_size,
            args.ocr_max_mpix,
            args.batch_timeout_s,
        )
    except Exception as err:
        print(f"[pdf_extract] pymupdf failed: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
