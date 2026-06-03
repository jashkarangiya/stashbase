import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import { useApp } from '../../store/AppContext';
import { ModalShell } from '../ModalShell';

interface ElectronBridge {
  openFolderDialog?: (opts?: unknown) => Promise<string | null>;
}

/** Per-conflict choice in the migration dialog. `skip` is UI-only —
 *  skipped spaces are simply omitted from the request. */
type ConflictChoice = 'overwrite' | 'rename' | 'skip';

/** What the API expects per space being moved. */
type MigrateEntry = { name: string; action: 'move' | 'overwrite' | 'rename' };

interface Migration {
  step: 'choose' | 'conflicts';
  target: string;
  /** Space folders under the current root that could move. */
  spaces: string[];
  /** Of those, the ones whose name already exists in the target. */
  collisions: string[];
  /** Per-collision resolution; defaults to the safe `rename`. */
  resolutions: Record<string, ConflictChoice>;
}

export function LibraryPanel() {
  const { actions } = useApp();
  const [kbRoot, setKbRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [migration, setMigration] = useState<Migration | null>(null);

  useEffect(() => {
    void api.getKbRoot()
      .then((r) => setKbRoot(r.path))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  async function choose() {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    const picked = await bridge?.openFolderDialog?.({
      title: 'Choose root folder',
      buttonLabel: 'Use as Root folder',
      defaultPath: kbRoot || undefined,
    });
    if (picked) setKbRoot(picked);
  }

  /** Apply a successful switch: update the field, go home, re-bootstrap,
   *  and surface any leftover-original warnings from a move. */
  async function applySaved(path: string, warnings?: string[]) {
    setKbRoot(path);
    actions.goHome();
    await actions.bootstrap();
    setSaved(true);
    setNotice(warnings && warnings.length ? warnings.join(' ') : null);
  }

  /** Switch the root without moving anything. The target may be
   *  non-empty (a different existing library) — confirm that case. */
  async function plainSwitch(target: string, confirmNonEmpty = false) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await api.setKbRoot(target, { confirmNonEmpty });
      await applySaved(r.path);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !confirmNonEmpty) {
        setBusy(false);
        const ok = await actions.confirm('That directory is not empty. Use it as the root folder anyway?');
        if (ok) void plainSwitch(target, true);
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const next = kbRoot.trim();
    if (!next) { setError('Path required'); return; }
    setError(null);
    setNotice(null);
    setSaved(false);
    let preview;
    try {
      preview = await api.kbRootMigrationPreview(next);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    // Same folder, or nothing to bring along → just switch.
    if (preview.sameRoot || preview.spaces.length === 0) {
      void plainSwitch(next);
      return;
    }
    // Offer to move the existing spaces over; collisions default to the
    // non-destructive "keep both".
    const resolutions: Record<string, ConflictChoice> = {};
    for (const c of preview.collisions) resolutions[c] = 'rename';
    setMigration({
      step: 'choose',
      target: next,
      spaces: preview.spaces,
      collisions: preview.collisions,
      resolutions,
    });
  }

  async function runMigration(m: Migration) {
    const collisionSet = new Set(m.collisions);
    const migrate = m.spaces.flatMap((name): MigrateEntry[] => {
      if (!collisionSet.has(name)) return [{ name, action: 'move' }];
      const choice = m.resolutions[name];
      if (choice === 'skip') return [];
      return [{ name, action: choice }];
    });
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await api.setKbRoot(m.target, { migrate });
      setMigration(null);
      await applySaved(r.path, r.warnings);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const anyOverwrite =
    migration?.step === 'conflicts' &&
    Object.values(migration.resolutions).some((c) => c === 'overwrite');

  return (
    <div className="settings-panel">
      <div className="settings-section-title">Root folder</div>
      <p className="settings-copy">
        Spaces are the direct child folders inside this directory. When you change it, StashBase asks whether to move your existing spaces over or just switch and leave them where they are.
      </p>
      <div className="settings-field-row">
        <input
          className="settings-text-input"
          value={kbRoot}
          disabled={busy}
          onChange={(e) => setKbRoot(e.target.value)}
          spellCheck={false}
        />
        <button type="button" className="settings-secondary-btn" onClick={choose} disabled={busy}>
          Browse
        </button>
        <button type="button" className="settings-primary-btn" onClick={() => { void save(); }} disabled={busy || !kbRoot.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {saved && <div className="settings-ok">Root folder updated.</div>}
      {notice && <div className="modal-warning">{notice}</div>}
      {error && <div className="settings-error">{error}</div>}

      {migration && (
        <ModalShell wide onCancel={busy ? () => {} : () => setMigration(null)}>
          {migration.step === 'choose' ? (
            <>
              <h3>Move your spaces?</h3>
              <p className="modal-hint">
                Your current library has {migration.spaces.length} space{migration.spaces.length === 1 ? '' : 's'}. Move them into the new location, or just switch and leave them where they are?
              </p>
              <div className="modal-actions">
                <button type="button" className="modal-btn" onClick={() => setMigration(null)} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="modal-btn"
                  onClick={() => { setMigration(null); void plainSwitch(migration.target); }}
                  disabled={busy}
                >
                  Just switch
                </button>
                <button
                  type="button"
                  className="modal-btn primary"
                  disabled={busy}
                  onClick={() => {
                    if (migration.collisions.length === 0) void runMigration(migration);
                    else setMigration({ ...migration, step: 'conflicts' });
                  }}
                >
                  Move them
                </button>
              </div>
            </>
          ) : (
            <>
              <h3>Resolve name conflicts</h3>
              <p className="modal-hint">
                These spaces already exist in the new location. Choose what to do with each.
              </p>
              <div className="migrate-conflict-list">
                {migration.collisions.map((name) => {
                  const choice = migration.resolutions[name];
                  return (
                    <div className="migrate-conflict-row" key={name}>
                      <span className="migrate-conflict-name">{name}</span>
                      <div className="migrate-choices">
                        {(['rename', 'skip', 'overwrite'] as ConflictChoice[]).map((c) => (
                          <button
                            key={c}
                            type="button"
                            className={
                              'migrate-choice' +
                              (choice === c ? ' active' : '') +
                              (c === 'overwrite' ? ' overwrite' : '')
                            }
                            onClick={() =>
                              setMigration({
                                ...migration,
                                resolutions: { ...migration.resolutions, [name]: c },
                              })
                            }
                          >
                            {c === 'rename' ? 'Keep both' : c === 'skip' ? 'Skip' : 'Overwrite'}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {anyOverwrite && (
                <div className="modal-warning">
                  Overwrite permanently replaces the existing space's files in the new location.
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="modal-btn"
                  onClick={() => setMigration({ ...migration, step: 'choose' })}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="modal-btn primary"
                  onClick={() => { void runMigration(migration); }}
                  disabled={busy}
                >
                  {busy ? 'Moving…' : 'Move'}
                </button>
              </div>
            </>
          )}
        </ModalShell>
      )}
    </div>
  );
}
