#!/usr/bin/env python
"""Combined entry for the one-shot extractors.

Packaged by PyInstaller into a single self-contained `stashbase-extract`
binary so the desktop build ships PDF conversion + image OCR without
needing a separate Python interpreter on the user's machine — mirroring
how the MFS daemon ships as `stashbase-daemon`. The Node side
(`server/pdf.ts` / `server/image.ts`) spawns this binary with a mode
subcommand when `STASHBASE_EXTRACT_BIN` is set; in dev it keeps spawning
the individual scripts via the venv interpreter, so this entry only
matters for the packaged binary.

Usage:
    stashbase-extract pdf   <pdf>   <out_note> <bundle_dir> [--converter ...]
    stashbase-extract ocr   <image> <out_note>
"""

from __future__ import annotations

import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: stashbase-extract <pdf|ocr> ...", file=sys.stderr)
        return 2
    mode, rest = sys.argv[1], sys.argv[2:]
    if mode == "pdf":
        import pdf_extract

        sys.argv = ["pdf_extract", *rest]
        return pdf_extract.main()
    if mode == "ocr":
        import ocr_extract

        sys.argv = ["ocr_extract", *rest]
        return ocr_extract.main()
    print(f"[extract] unknown mode: {mode}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
