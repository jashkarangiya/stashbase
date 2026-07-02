import json
import sys
import time
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).parent))
import pdf_extract


class _FakePage:
    def __init__(self, text: str) -> None:
        self.text = text
        self.rect = types.SimpleNamespace(width=595, height=842)

    def get_text(self, mode: str) -> str:
        assert mode == "text"
        return self.text


class _FakeDoc:
    def __init__(self, pages: list[_FakePage] | None = None) -> None:
        self.pages = pages or [_FakePage("first page text"), _FakePage("second page text")]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def __iter__(self):
        return iter(self.pages)

    def __len__(self):
        return len(self.pages)

    def __getitem__(self, index: int):
        return self.pages[index]


class PdfExtractTests(unittest.TestCase):
    def tearDown(self) -> None:
        sys.modules.pop("pymupdf4llm", None)
        sys.modules.pop("pymupdf", None)

    def test_pymupdf_converter_falls_back_to_plain_text_when_rich_extraction_fails(self) -> None:
        rich = types.ModuleType("pymupdf4llm")

        def to_markdown(*args, **kwargs):
            image_path = Path(kwargs["image_path"])
            image_path.mkdir(parents=True, exist_ok=True)
            (image_path / "partial.png").write_bytes(b"partial")
            raise TypeError("'NoneType' object is not iterable")

        rich.to_markdown = to_markdown
        sys.modules["pymupdf4llm"] = rich

        plain = types.ModuleType("pymupdf")
        plain.open = lambda path: _FakeDoc()
        sys.modules["pymupdf"] = plain

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "Broken Layout.pdf"
            pdf.write_bytes(b"%PDF-1.7\n")
            out = root / ".Broken Layout.pdf.md"
            bundle = root / ".Broken Layout.pdf_files"

            pdf_extract.convert_with_pymupdf(pdf, out, bundle)

            text = out.read_text(encoding="utf-8")
            self.assertIn("# Broken Layout", text)
            self.assertIn("## Page 1", text)
            self.assertIn("first page text", text)
            self.assertIn("second page text", text)
            self.assertTrue(bundle.is_dir())
            self.assertFalse((bundle / "partial.png").exists())
            self.assertEqual(list(root.glob(".*.tmp-*")), [])

    def test_plain_text_fallback_fails_when_pdf_has_no_text_layer(self) -> None:
        plain = types.ModuleType("pymupdf")
        plain.open = lambda path: _FakeDoc([_FakePage("   ")])
        sys.modules["pymupdf"] = plain

        with TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "Scan.pdf"
            pdf.write_bytes(b"%PDF-1.7\n")

            with self.assertRaisesRegex(RuntimeError, "no extractable text layer"):
                pdf_extract._fallback_plain_text(pdf, TypeError("rich failed"))

    def test_plain_text_fallback_honors_page_range(self) -> None:
        plain = types.ModuleType("pymupdf")
        plain.open = lambda path: _FakeDoc([
            _FakePage("first page text"),
            _FakePage("second page text"),
            _FakePage("third page text"),
        ])
        sys.modules["pymupdf"] = plain

        with TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "Range.pdf"
            pdf.write_bytes(b"%PDF-1.7\n")

            text = pdf_extract._fallback_plain_text(pdf, TypeError("rich failed"), [1])

            self.assertNotIn("Page 1", text)
            self.assertIn("## Page 2", text)
            self.assertIn("second page text", text)
            self.assertNotIn("third page text", text)

    def test_rich_fallback_reason_hides_internal_image_paths(self) -> None:
        reason = pdf_extract._rich_fallback_reason(
            RuntimeError(
                "code=2: cannot open file "
                "'/Users/me/Library/Application_Support/StashBase/derived.nosync/x.md.batches/work/file.png': "
                "No such file or directory",
            ),
        )

        self.assertEqual(reason, "layout image extraction failed")
        self.assertNotIn("Library", reason)
        self.assertNotIn(".png", reason)

    def test_pymupdf_converter_processes_pages_in_batches(self) -> None:
        rich = types.ModuleType("pymupdf4llm")
        seen_batches: list[list[int]] = []

        def to_markdown(*args, **kwargs):
            pages = list(kwargs["pages"])
            seen_batches.append(pages)
            return "\n".join(f"## Page {p + 1}\n\nrich page {p + 1}" for p in pages)

        rich.to_markdown = to_markdown
        sys.modules["pymupdf4llm"] = rich

        plain = types.ModuleType("pymupdf")
        plain.open = lambda path: _FakeDoc([
            _FakePage("first page text"),
            _FakePage("second page text"),
            _FakePage("third page text"),
        ])
        sys.modules["pymupdf"] = plain

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "Batched.pdf"
            pdf.write_bytes(b"%PDF-1.7\n")
            out = root / ".Batched.pdf.md"
            bundle = root / ".Batched.pdf_files"

            pdf_extract.convert_with_pymupdf(pdf, out, bundle, batch_size=1, batch_timeout_s=0)

            self.assertEqual(seen_batches, [[0], [1], [2]])
            text = out.read_text(encoding="utf-8")
            self.assertIn("rich page 1", text)
            self.assertIn("rich page 2", text)
            self.assertIn("rich page 3", text)

    def test_pymupdf_converter_marks_physical_pdf_pages(self) -> None:
        rich = types.ModuleType("pymupdf4llm")

        def to_markdown(*args, **kwargs):
            self.assertTrue(kwargs["page_chunks"])
            return [
                {"metadata": {"page_number": p + 1}, "text": f"rich page {p + 1}"}
                for p in kwargs["pages"]
            ]

        rich.to_markdown = to_markdown
        sys.modules["pymupdf4llm"] = rich

        plain = types.ModuleType("pymupdf")
        plain.open = lambda path: _FakeDoc([
            _FakePage("first page text"),
            _FakePage("second page text"),
        ])
        sys.modules["pymupdf"] = plain

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "Marked.pdf"
            pdf.write_bytes(b"%PDF-1.7\n")
            out = root / ".Marked.pdf.md"
            bundle = root / ".Marked.pdf_files"

            pdf_extract.convert_with_pymupdf(pdf, out, bundle, batch_size=2, batch_timeout_s=0)

            text = out.read_text(encoding="utf-8")
            self.assertIn("<!-- stashbase-pdf-page: 1 -->", text)
            self.assertIn("<!-- stashbase-pdf-page: 2 -->", text)
            self.assertIn("rich page 2", text)

    def test_ocr_dpi_is_capped_for_large_page_rects(self) -> None:
        page = _FakePage("")
        page.rect = types.SimpleNamespace(width=1848, height=2728)
        plain = types.ModuleType("pymupdf")
        plain.open = lambda path: _FakeDoc([page])
        sys.modules["pymupdf"] = plain

        with TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "Huge.pdf"
            pdf.write_bytes(b"%PDF-1.7\n")

            self.assertLess(pdf_extract._ocr_dpi_for_pages(pdf, [0], max_mpix=12), 300)

    def test_pymupdf_converter_falls_back_when_batch_times_out(self) -> None:
        rich = types.ModuleType("pymupdf4llm")

        def to_markdown(*args, **kwargs):
            time.sleep(10)
            return "never returned"

        rich.to_markdown = to_markdown
        sys.modules["pymupdf4llm"] = rich

        plain = types.ModuleType("pymupdf")
        plain.open = lambda path: _FakeDoc([_FakePage("rescued text")])
        sys.modules["pymupdf"] = plain

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "Hung Batch.pdf"
            pdf.write_bytes(b"%PDF-1.7\n")
            out = root / ".Hung Batch.pdf.md"
            bundle = root / ".Hung Batch.pdf_files"

            pdf_extract.convert_with_pymupdf(pdf, out, bundle, batch_timeout_s=0.05)

            text = out.read_text(encoding="utf-8")
            self.assertIn("# Hung Batch", text)
            self.assertIn("rescued text", text)

    def test_pymupdf_converter_resumes_completed_batches(self) -> None:
        rich = types.ModuleType("pymupdf4llm")

        def to_markdown(*args, **kwargs):
            raise AssertionError("completed batch should have been resumed")

        rich.to_markdown = to_markdown
        sys.modules["pymupdf4llm"] = rich

        plain = types.ModuleType("pymupdf")
        plain.open = lambda path: _FakeDoc([_FakePage("source text")])
        sys.modules["pymupdf"] = plain

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf = root / "Resume.pdf"
            pdf.write_bytes(b"%PDF-1.7\n")
            out = root / ".Resume.pdf.md"
            bundle = root / ".Resume.pdf_files"
            resume = pdf_extract._resume_dir_for(out)
            resume.mkdir()
            meta = pdf_extract._resume_meta(pdf, [[0]], 1, pdf_extract.DEFAULT_OCR_MAX_MPIX)
            (resume / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (resume / "batch-0001.md").write_text("## Page 1\n\nresumed text\n", encoding="utf-8")
            (resume / "batch-0001_files").mkdir()
            (resume / "batch-0001.json").write_text(
                json.dumps({"pages": [0], "has_text": True}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            pdf_extract.convert_with_pymupdf(pdf, out, bundle, batch_size=1)

            text = out.read_text(encoding="utf-8")
            self.assertIn("resumed text", text)
            self.assertFalse(resume.exists())


if __name__ == "__main__":
    unittest.main()
