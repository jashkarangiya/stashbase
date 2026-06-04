import { type ReactNode } from 'react';

/**
 * Shared backdrop + card wrapper for every modal in the app. Click on
 * the backdrop dismisses; click on the card itself doesn't (we
 * `stopPropagation` so users can highlight text / press buttons without
 * accidentally closing). `wide` opts into the larger card style used
 * by the re-embed confirmation (which has cost stats to lay out).
 *
 * NOTE: Esc-to-dismiss is deliberately NOT owned here. A window-level
 * keydown on every mounted ModalShell would fire for ALL stacked
 * instances at once (e.g. a confirm dialog over the migration modal),
 * closing more than the topmost. Until there's a modal-stack that can
 * target only the top layer, modals keep their own input-focused Esc
 * handler (which only fires for the focused, topmost modal).
 *
 * Each modal still owns its own header / body / buttons.
 */
export function ModalShell({
  onCancel,
  wide,
  children,
}: {
  onCancel: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="modal-veil" onClick={onCancel}>
      <div
        className={'modal-card' + (wide ? ' wide' : '')}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
