import { api } from '../api';
import { useApp } from '../store/AppContext';
import { getConversionFailure } from '../store/fileReadiness';
import { Menu, type MenuItem } from './Menu';

/** Drag-import veil. Visibility flows from the global drag handler in
 *  the parent (`useGlobalDragDrop`) via the `hot` prop. */
export function DropVeil({ hot }: { hot: boolean }) {
  return <div className={'drop-veil' + (hot ? ' hot' : '')}>Release to import</div>;
}

/**
 * Right-click menu on file / folder rows. Rendered at cursor position
 * when `state.ctxMenu` is set. Positioning, dismissal (click-outside /
 * Escape / blur) and keyboard nav all live in the shared `<Menu>`.
 */
export function ContextMenu() {
  const { state, dispatch, actions } = useApp();
  if (!state.ctxMenu) return null;
  const { x, y, target, kind } = state.ctxMenu;
  const folderPathAtOpen = state.folderPath;
  const close = () => dispatch({ type: 'CTX_MENU', menu: null });

  // "Retry conversion" is only meaningful when the target is a PDF or
  // image currently in the failures list. Showing it on every such file
  // would let the user nuke + re-convert a working one by accident — the
  // route deletes the derived `.<stem>.md` (+ PDF `_files/`) before
  // re-running. Membership already implies the file is a PDF / image.
  const conversionFailure = kind === 'file'
    ? getConversionFailure(state, target)
    : undefined;
  const canRetryConversion = Boolean(conversionFailure);

  const items: MenuItem[] = [
    {
      label: 'Rename…',
      onSelect: () => dispatch({ type: 'RENAMING', renaming: { path: target, kind } }),
    },
    { label: revealLabel(), onSelect: () => void api.revealFile(target) },
    ...(canRetryConversion
      ? [
          {
            label: 'Retry conversion',
            title: 'Re-run text extraction — clears the derived note (and PDF bundle) first',
            // Fire-and-forget — the failures-list / banner update on the
            // next index-status poll (~1.5s in pending mode). If the API
            // itself 4xx's we log; user-facing feedback comes via that
            // banner flipping `failed` → in-flight → done.
            onSelect: () => {
              actions.toast('Retrying text extraction…', { level: 'info' });
              void api.retryConversion(target, { folder: folderPathAtOpen || undefined })
                .then(() => actions.refreshIndexState())
                .catch((err) => {
                  const msg = err instanceof Error ? err.message : String(err);
                  actions.toast('Retry conversion failed: ' + msg, { level: 'error' });
                  console.warn('[ctxmenu] retry conversion failed:', msg);
                });
            },
          } satisfies MenuItem,
        ]
      : []),
    { separator: true },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => (kind === 'folder' ? void actions.deleteFolder(target) : void actions.deleteFile(target)),
    },
  ];

  return <Menu anchor={{ x, y }} items={items} onClose={close} />;
}

/** OS-appropriate label for the reveal-in-file-manager action. macOS
 *  users expect "Finder"; Windows users expect "Explorer"; other
 *  platforms fall back to the generic "File Manager". */
function revealLabel(): string {
  const p = (navigator.platform || '').toLowerCase();
  if (p.includes('mac')) return 'Reveal in Finder';
  if (p.includes('win')) return 'Reveal in Explorer';
  return 'Show in File Manager';
}
