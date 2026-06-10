import { StashBaseIcon } from '../icons';

/**
 * Calm "processing" state shown in the main pane for a file that's still
 * stashing and has no content yet — in practice a just-stopped recording
 * whose OCR note hasn't been written to disk. This is a render-time
 * overlay, NOT file content, so it auto-clears the instant the note lands
 * (the tab's content fills in) and never risks being saved to disk.
 *
 * Motion is the same breathing pulse the tab / pill stashing marks use —
 * one shared cue, no competing spinner. Respects reduced-motion.
 */
export function StashingPlaceholder() {
  return (
    <div className="stashing-placeholder">
      <StashBaseIcon className="stashing-placeholder-logo" />
      <div className="stashing-placeholder-title">Processing your recording…</div>
      <div className="stashing-placeholder-sub">
        The transcript will appear here when it's ready.
      </div>
    </div>
  );
}
