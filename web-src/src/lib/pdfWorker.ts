/**
 * pdf.js worker entry. Applies the Map-upsert polyfill in the worker
 * scope *before* loading the real pdfjs worker, then re-exports it.
 * Loaded via Vite's `?worker` from `PdfPreview.tsx` and wrapped in a
 * `new PDFWorker({ port })`, so the worker thread gets the same
 * `getOrInsertComputed` shim the main thread does (the render operator
 * list is built worker-side and would otherwise throw there too).
 */
import './pdfPolyfill';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
