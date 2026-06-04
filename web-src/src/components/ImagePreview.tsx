import { useMemo, useState } from 'react';
import { api, assetUrl, errorMessage } from '../api';
import { useApp } from '../store/AppContext';
import { ImageLightbox } from './ImageLightbox';

/**
 * In-pane viewer for a standalone image file. The image binary is
 * pulled directly from `/asset/*` (never loaded as text); the
 * searchable text lives in the hidden `.<stem>.md` OCR note that
 * `ocr_extract.py` writes alongside it.
 *
 * Mirrors PdfPreview's "binary file, no edit mode" shape but far
 * simpler — no pdfjs, no chunk-highlight find controller (a search hit
 * on an image's OCR note just opens the image; there's no in-image text
 * layer to jump within). Click the image to open the shared
 * ImageLightbox for zoom / pan.
 *
 * If OCR failed for this image, a small banner offers Retry — the image
 * still renders (it's the user-facing file), only its searchable text is
 * missing. Failure state comes from `state.conversionFailures` (fed by
 * the index-status poll), the same list that drives PdfPreview's banner.
 */
export function ImagePreview({ name }: { name: string }) {
  const { state } = useApp();
  const src = useMemo(() => assetUrl(name), [name]);
  const [zoomed, setZoomed] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const alt = name.split('/').pop() ?? name;
  const failure = state.conversionFailures.find((f) => f.path === name);

  async function onRetry() {
    setRetryBusy(true);
    setRetryError(null);
    try {
      await api.retryConversion(name);
      // The failures list / banner clear on the next index-status poll.
    } catch (err: unknown) {
      setRetryError(errorMessage(err));
    } finally {
      setRetryBusy(false);
    }
  }

  return (
    <div className="image-preview">
      {failure && (
        <div className="pdf-failure-banner" role="status">
          <span className="pdf-failure-text">
            Text extraction failed{failure.lastError ? `: ${failure.lastError}` : ''} — the image
            still opens, but its text isn’t searchable.
            {retryError ? ` (${retryError})` : ''}
          </span>
          <button
            type="button"
            className="pdf-failure-retry"
            disabled={retryBusy}
            onClick={() => { void onRetry(); }}
          >
            {retryBusy ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      <img
        className="image-preview-img"
        src={src}
        alt={alt}
        draggable={false}
        onClick={() => setZoomed(true)}
        title="Click to zoom"
      />
      {zoomed && <ImageLightbox src={src} alt={alt} onClose={() => setZoomed(false)} />}
    </div>
  );
}
