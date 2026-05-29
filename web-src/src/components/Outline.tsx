import { useState } from 'react';
import { ChevronDownIcon } from '../icons';
import { extractHeadings } from '../markdown';
import { useApp } from '../store/AppContext';

/**
 * Bottom-of-sidebar Outline panel. Always rendered (even collapsed) so
 * toggling expand is instant. Pulls live content for MD edit mode from
 * the CM buffer via the editor ref; HTML trusts the server-provided
 * `headings` list (matched 1:1 with `id="h-N"` attrs in the prepared
 * page).
 */
export function Outline() {
  const [collapsed, setCollapsed] = useState(true);
  const { activeTab } = useApp();
  const cur = activeTab?.file ?? null;
  const editMode = activeTab?.editMode ?? false;

  // MD: prefer the live headings the Split editor pushes via
  // OUTLINE_HEADINGS; fall back to extracting from the saved buffer
  // (which is what we'll see in read-only preview before any edit).
  // HTML: trust the server-provided list.
  // PDF: trust whatever PdfPreview pushed via OUTLINE_HEADINGS — the
  // outline comes from pdfjs `getOutline()` at load time.
  const items = !cur
    ? []
    : cur.format === 'md' && cur.headings.length === 0
      ? extractHeadings(cur.content)
      : cur.headings;

  return (
    <div className={'outline-section' + (collapsed ? ' collapsed' : '')}>
      <div className="outline-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="outline-chev"><ChevronDownIcon /></span>
        <span className="outline-title-label">OUTLINE</span>
      </div>
      <div className="outline-body">
        {!cur && <div className="empty-list">No note open</div>}
        {cur && items.length === 0 && <div className="empty-list">No headings</div>}
        {cur && items.length > 0 && items.map((h, i) => (
          // Heading slugs are unique within a single document. Combine
          // with the index so even duplicate-text headings (rare but
          // legal in markdown — `# Notes` twice) keep stable keys.
          <div
            key={`${h.id}-${i}`}
            className={`outline-item level-${h.level}`}
            onClick={() => scrollToHeading(h.id, cur.format, editMode)}
          >
            {h.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Click an outline entry → scroll the preview iframe to that heading.
 *  HTML runs scripts (sandbox=allow-scripts, no same-origin) so we
 *  postMessage; MD read-only preview uses allow-same-origin and lets
 *  us hash-nav directly. Edit-mode MD preview is also script-mode
 *  (we injected the bootstrap), so postMessage works there too.
 *  PDF outline entries are addressed `pdf-h-N`; PdfPreview listens on
 *  the window for `stashbase-pdf-scroll` and scrolls to the matching
 *  outline entry. */
function scrollToHeading(id: string, format: 'md' | 'html' | 'pdf', editMode: boolean) {
  if (format === 'pdf') {
    try {
      window.dispatchEvent(new CustomEvent('stashbase-pdf-scroll', { detail: { id } }));
    } catch { /* swallow */ }
    return;
  }
  const iframe = document.getElementById('previewFrame') as HTMLIFrameElement | null;
  if (!iframe) return;
  if (format === 'html' || editMode) {
    try {
      iframe.contentWindow?.postMessage(
        { type: 'stashbase-scroll', id },
        '*',
      );
    } catch { /* swallow */ }
    return;
  }
  try {
    if (iframe.contentWindow) iframe.contentWindow.location.hash = id;
  } catch { /* swallow */ }
}

