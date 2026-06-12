import { ArrowLeftIcon, ArrowRightIcon, EditIcon, PreviewIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { EmptyTabLanding } from './EmptyTabLanding';
import { FindBar } from './FindBar';
import { HtmlPreview } from './HtmlPreview';
import { ImagePreview } from './ImagePreview';
import { MarkdownPreview } from './MarkdownPreview';
import { PathBreadcrumb } from './PathBreadcrumb';
import { PdfPreview } from './PdfPreview';
import { Split } from './Split';
import { StashingPlaceholder } from './StashingPlaceholder';
import { TabStrip } from './TabStrip';

/**
 * Right rail. Layout from top to bottom:
 *   • TabStrip                   (when any tab is open)
 *   • main-body                  (preview / split / empty-tab landing)
 *   • absolute-positioned chrome:
 *       - nav-actions  (back / forward, top-left)
 *       - breadcrumb   (path, top-center)
 *       - floating     (edit toggle + save status, top-right)
 *
 * The chrome row sits at `top: 44px` to clear the tab strip — see
 * `.main-nav-actions` / `.main-breadcrumb` / `.main-floating-actions`
 * in styles.css. When there are no tabs at all, `.main.no-file > *`
 * hides every child so the pane is a clean canvas.
 */
export function MainPane() {
  const { state, actions, activeTab } = useApp();
  const cur = activeTab?.file ?? null;
  const editMode = activeTab?.editMode ?? false;
  const saveStatus = activeTab?.saveStatus ?? { text: '', cls: '' };
  const navStack = activeTab?.navStack ?? [];
  const navCursor = activeTab?.navCursor ?? -1;
  const canBack = navCursor > 0;
  const canForward = navCursor >= 0 && navCursor < navStack.length - 1;
  const hasTabs = state.tabs.length > 0;
  const emptyTab = !!activeTab && !cur;
  // A recording's tab pops open before its OCR note exists, so its body
  // is empty while it's still stashing. Show a calm "processing" state
  // instead of a blank editor; it clears itself the moment the note
  // lands (content fills) or the conversion drops out of flight.
  const isStashingPlaceholder =
    !!cur && cur.format === 'md' && !cur.content && state.pendingConversions.includes(cur.name);

  return (
    <main className={'main' + (hasTabs ? '' : ' no-file')}>
      {hasTabs && <TabStrip />}
      <div className="main-body">
        {!hasTabs && (
          <div className="empty-doc">
            Drop files or folders anywhere to stash them<br />
            — Markdown, HTML, PDFs, images —<br />
            or click <strong>+</strong> for a new note (⌘N)
          </div>
        )}
        {emptyTab && <EmptyTabLanding />}
        {isStashingPlaceholder && <StashingPlaceholder />}
        {cur && !isStashingPlaceholder && !editMode && cur.format === 'md' && (
          <MarkdownPreview name={cur.name} content={cur.content} />
        )}
        {cur && !editMode && cur.format === 'html' && (
          <HtmlPreview name={cur.name} />
        )}
        {cur && cur.format === 'pdf' && (
          // PDFs have no edit mode — the source is a binary file. Only
          // the original PDF is shown: the extracted `.md` is a hidden
          // implementation detail (search hits remap back to the PDF;
          // the derived note must never surface as content). The
          // conversion failure banner + Retry live inside PdfPreview.
          <PdfPreview name={cur.name} />
        )}
        {cur && cur.format === 'image' && (
          // Images, like PDFs, are binary — no edit mode.
          <ImagePreview name={cur.name} />
        )}
        {cur && !isStashingPlaceholder && editMode && cur.format !== 'pdf' && cur.format !== 'image' && (
          <Split name={cur.name} format={cur.format} initialContent={cur.content} />
        )}
      </div>
      {activeTab && (
        <div className="main-nav-actions">
          <button
            className="icon-btn nav-btn"
            type="button"
            title="Back"
            disabled={!canBack}
            onClick={() => { void actions.navBack(); }}
          >
            <ArrowLeftIcon />
          </button>
          <button
            className="icon-btn nav-btn"
            type="button"
            title="Forward"
            disabled={!canForward}
            onClick={() => { void actions.navForward(); }}
          >
            <ArrowRightIcon />
          </button>
        </div>
      )}
      {cur && <PathBreadcrumb name={cur.name} />}
      {emptyTab && (
        <div className="main-breadcrumb empty">
          <span className="seg current">Untitled</span>
        </div>
      )}
      <FindBar />
      {cur && !isStashingPlaceholder && cur.kind !== 'kb' && cur.format !== 'pdf' && cur.format !== 'image' && (
        <div className={'main-floating-actions' + (editMode ? ' editing' : '')}>
          {editMode && saveStatus.text && (
            <span className={'save-status' + (saveStatus.cls ? ' ' + saveStatus.cls : '')}>
              {saveStatus.text}
            </span>
          )}
          <button
            className={'icon-btn edit-toggle' + (editMode ? ' editing' : '')}
            type="button"
            title={editMode ? 'Preview (read-only)' : 'Edit'}
            onClick={() => { void actions.toggleEditMode(); }}
          >
            <EditIcon className="icon-edit" />
            <PreviewIcon className="icon-preview" />
          </button>
        </div>
      )}
      {cur && cur.format === 'pdf' && (
        // Slot that PdfPreview portals its zoom / page-count chrome
        // into — sits on the same row as back/forward + breadcrumb
        // so we don't waste a row on viewer chrome.
        <div className="main-floating-actions" id="pdf-chrome-slot" />
      )}
    </main>
  );
}
