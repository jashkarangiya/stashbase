import { useEffect, useState } from 'react';
import { api, setKbRootConfirming, errorMessage } from '../../api';
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

/** Trim + drop a trailing slash so `/a/b` and `/a/b/` compare equal. */
function normPath(p: string): string {
  return p.trim().replace(/\/+$/, '');
}

export function StoragePanel() {
  const { actions } = useApp();
  const [kbRoot, setKbRoot] = useState('');
  /** The persisted root — what's actually saved. Save is disabled while
   *  the field still matches it (nothing to change). */
  const [savedRoot, setSavedRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [migration, setMigration] = useState<Migration | null>(null);
  /** Errors raised while the migration modal is open — shown *inside* it.
   *  The panel-level `error` sits behind the modal veil, so a failure
   *  there would be invisible until the modal closed. */
  const [migrationError, setMigrationError] = useState<string | null>(null);

  useEffect(() => {
    const locked = busy || migration !== null;
    window.dispatchEvent(new CustomEvent('stashbase-settings-lock', { detail: { locked } }));
    return () => {
      window.dispatchEvent(new CustomEvent('stashbase-settings-lock', { detail: { locked: false } }));
    };
  }, [busy, migration]);

  useEffect(() => {
    void api.getKbRoot()
      .then((r) => { setKbRoot(r.path); setSavedRoot(r.path); })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const unchanged = normPath(kbRoot) === normPath(savedRoot);

  async function choose() {
    const bridge = (window as { electron?: ElectronBridge }).electron;
    try {
      const picked = await bridge?.openFolderDialog?.({
        title: 'Choose root folder',
        buttonLabel: 'Use as Root folder',
        defaultPath: kbRoot || undefined,
      });
      if (picked) {
        setKbRoot(picked);
        setError(null);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /** Apply a successful switch: update the field, go home, re-bootstrap,
   *  and surface any leftover-original warnings from a move. */
  async function applySaved(path: string, warnings?: string[]) {
    setKbRoot(path);
    setSavedRoot(path);
    actions.goHome();
    setSaved(true);
    setNotice(warnings && warnings.length ? warnings.join(' ') : null);
    void actions.bootstrap().catch((err) => {
      setNotice(`Root folder updated, but refresh failed: ${errorMessage(err)}`);
    });
  }

  /** Switch the root without moving anything. The target may be
   *  non-empty (a different existing knowledge base) — confirm that case. */
  async function plainSwitch(target: string) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await setKbRootConfirming(target, actions.confirm);
      if (r) await applySaved(r.path); // null → user declined the non-empty confirm
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const next = kbRoot.trim();
    if (!next) { setError('Path required'); return; }
    setBusy(true);
    setError(null);
    setNotice(null);
    setSaved(false);
    let preview;
    try {
      preview = await api.kbRootMigrationPreview(next);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
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
    setMigrationError(null);
    setMigration({
      step: 'choose',
      target: next,
      spaces: preview.spaces,
      collisions: preview.collisions,
      resolutions,
    });
    setBusy(false);
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
    setMigrationError(null);
    setSaved(false);
    try {
      const r = await api.setKbRoot(m.target, { migrate });
      setMigration(null);
      await applySaved(r.path, r.warnings);
    } catch (err) {
      // Surface inside the modal — it stays open so the user can retry or
      // adjust their conflict choices without losing them.
      setMigrationError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const anyOverwrite =
    migration?.step === 'conflicts' &&
    Object.values(migration.resolutions).some((c) => c === 'overwrite');

  return (
    <div className="settings-panel">
      <div className="settings-section">
        <div className="settings-section-title">Root folder</div>
        <div className="settings-section-hint">
          Each space is a folder directly inside this directory.
        </div>
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
          <button type="button" className="settings-primary-btn" onClick={() => { void save(); }} disabled={busy || !kbRoot.trim() || unchanged}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="settings-section-hint settings-hint-foot">
          Changing it asks whether to move your existing spaces over, or just switch.
        </div>
        {saved && <div className="settings-ok">Root folder updated.</div>}
        {notice && <div className="modal-warning">{notice}</div>}
        {error && <div className="settings-error">{error}</div>}
      </div>

      {migration && (
        <ModalShell wide onCancel={busy ? () => {} : () => setMigration(null)}>
          {migration.step === 'choose' ? (
            <>
              <h3>Move your spaces?</h3>
              <p className="modal-hint">
                The current folder has {migration.spaces.length} space{migration.spaces.length === 1 ? '' : 's'}. Move them into the new location, or just switch and leave them where they are?
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
                    else { setMigrationError(null); setMigration({ ...migration, step: 'conflicts' }); }
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
                  onClick={() => { setMigrationError(null); setMigration({ ...migration, step: 'choose' }); }}
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
          {migrationError && <div className="modal-error">{migrationError}</div>}
        </ModalShell>
      )}
    </div>
  );
}
