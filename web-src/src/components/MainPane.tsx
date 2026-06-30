import { EditIcon, PreviewIcon } from '../icons';
import { useApp } from '../store/AppContext';
import { EmptyTabLanding } from './EmptyTabLanding';
import { FindBar } from './FindBar';
import { HtmlPreview } from './HtmlPreview';
import { ImagePreview } from './ImagePreview';
import { MarkdownPreview } from './MarkdownPreview';
import { PdfPreview } from './PdfPreview';
import { CodeEditor } from './CodeEditor';
import { TabStrip } from './TabStrip';

/**
 * Right rail. Layout from top to bottom:
 *   • TabStrip                   (when any tab is open)
 *   • main-body                  (preview / md editor / empty-tab landing)
 *   • absolute-positioned chrome (top-right, `top: 44px` to clear the tab
 *     strip): the md edit toggle + save status, and the PDF control slot.
 *
 * When there are no tabs at all, `.main.no-file > *` hides every child so
 * the pane is a clean canvas.
 */
export function MainPane() {
  const { state, actions, activeTab } = useApp();
  const cur = activeTab?.file ?? null;
  const editMode = activeTab?.editMode ?? false;
  const saveStatus = activeTab?.saveStatus ?? { text: '', cls: '' };
  const hasTabs = state.tabs.length > 0;
  const emptyTab = !!activeTab && !cur;

  return (
    <main className={'main' + (hasTabs ? '' : ' no-file') + (cur ? ' fmt-' + cur.format : '')}>
      {hasTabs && <TabStrip />}
      <div className="main-body">
        {!hasTabs && (
          // One <p> wrapper so the grid centers a single block and the
          // text keeps normal inline flow — otherwise each <br>/inline
          // child becomes its own grid item and scatters vertically.
          <div className="empty-doc">
            <p>
              Drop files or folders anywhere to stash them<br />
              — Markdown, HTML, PDFs, images —<br />
              or click{' '}
              <button
                type="button"
                className="empty-doc-new"
                onClick={() => { void actions.newNote(); }}
              >+</button>{' '}
              for a new note (⌘N)
            </p>
          </div>
        )}
        {emptyTab && <EmptyTabLanding />}
        {cur && !editMode && cur.format === 'md' && (
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
        {cur && editMode && cur.format === 'md' && (
          // Markdown is the only editable format — HTML/PDF/image are
          // read-only viewers. The editor is a single CodeMirror pane
          // (no source+preview split); save is scheduled on every edit.
          <div className="md-editor">
            <CodeEditor
              key={cur.name}
              name={cur.name}
              initialContent={cur.content}
              onChange={() => actions.scheduleSave()}
            />
          </div>
        )}
      </div>
      {emptyTab && (
        <div className="main-breadcrumb empty">
          <span className="seg current">Untitled</span>
        </div>
      )}
      <FindBar />
      {cur && cur.format === 'md' && (
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
        <div className="main-floating-actions pdf-chrome-slot" id="pdf-chrome-slot" />
      )}
    </main>
  );
}
