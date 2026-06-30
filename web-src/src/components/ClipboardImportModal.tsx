import { useEffect } from 'react';
import { ModalShell } from './ModalShell';

export interface ClipboardOffer {
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
  hash: string;
  filename: string;
}

/**
 * Asks whether to import an image found on the clipboard (e.g. a
 * screenshot the user just copied, then switched back to StashBase).
 * Shown only in the Electron app — `main.cjs` pushes the offer on window
 * focus and the renderer mounts this. A thumbnail makes the source
 * obvious; Add runs the same upload path as drag-in / capture (so the
 * image gets OCR'd into a hidden note), Dismiss leaves it alone.
 *
 * Modal (not a toast) by product decision — a screenshot is a
 * deliberate "I want to keep this" moment worth a clear yes/no. Esc /
 * backdrop dismiss, Enter adds.
 */
export function ClipboardImportModal({
  offer,
  onAdd,
  onClose,
}: {
  offer: ClipboardOffer;
  onAdd: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'Enter') { e.preventDefault(); onAdd(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAdd, onClose]);

  return (
    <ModalShell onCancel={onClose}>
      <h2 className="modal-title">Add image to StashBase?</h2>
      <p className="modal-hint">
        There's an image on your clipboard. Add it to this folder — its text
        gets extracted so you can search it later.
      </p>
      <div className="clipboard-offer-preview">
        <img src={offer.dataUrl} alt="Clipboard image" />
      </div>
      <div className="modal-actions">
        <button type="button" className="modal-btn" onClick={onClose}>Dismiss</button>
        <button type="button" className="modal-btn primary" onClick={onAdd}>Add</button>
      </div>
    </ModalShell>
  );
}
