import { useMemo, useState } from 'react';
import { assetUrl } from '../api';
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
 */
export function ImagePreview({ name }: { name: string }) {
  const src = useMemo(() => assetUrl(name), [name]);
  const [zoomed, setZoomed] = useState(false);
  const alt = name.split('/').pop() ?? name;

  return (
    <div className="image-preview">
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
