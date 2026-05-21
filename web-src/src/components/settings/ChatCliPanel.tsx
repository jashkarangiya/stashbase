/**
 * Settings → Chat CLI panel. Pick the **default** CLI used when the
 * user clicks `+` to open a new chat tab on the right-side panel.
 * Existing tabs are unaffected — each tab is locked to its own CLI
 * (see TerminalPane). Runtime open/close of the panel stays on the
 * chrome `TerminalToggleButton`; restarting a session is now "close
 * tab + click +" in the panel itself.
 */
import { useEffect, useRef, useState } from 'react';
import { api, type TerminalClisResponse } from '../../api';
import { CheckIcon } from '../../icons';
import { useApp } from '../../store/AppContext';

export function ChatCliPanel() {
  const { state, dispatch, actions } = useApp();
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const refreshedRef = useRef(false);

  // Pull on first mount so `installed` reflects state since the last
  // chrome-row fetch (the user might have installed something via the
  // terminal in the meantime).
  useEffect(() => {
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    api.listClis().then((r: TerminalClisResponse) => {
      dispatch({ type: 'TERMINAL_CLIS', current: r.current, clis: r.clis });
    }).catch(() => { /* renderer falls back to local defaults */ });
  }, [dispatch]);

  function pick(id: string) {
    if (id === state.terminalCli) return;
    dispatch({ type: 'TERMINAL_CLI', id });
    api.setCli(id).catch(() => {
      dispatch({ type: 'TERMINAL_CLI', id: state.terminalCli });
    });
  }

  async function uninstall(cli: { id: string; label: string; installHint: string }) {
    const cmd = cli.installHint.replace('install', 'uninstall');
    if (!(await actions.confirm(`Uninstall ${cli.label}?\n\nThis runs:\n${cmd}`))) return;
    setUninstallingId(cli.id);
    const es = new EventSource('/api/terminal/uninstall/' + encodeURIComponent(cli.id));
    es.addEventListener('exit', () => {
      es.close();
      setUninstallingId(null);
      api.listClis().then((r) => {
        dispatch({ type: 'TERMINAL_CLIS', current: r.current, clis: r.clis });
      }).catch(() => { /* keep stale data */ });
    });
    es.addEventListener('error', () => {
      es.close();
      setUninstallingId(null);
    });
  }

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-title">Default chat CLI</div>
        <div className="settings-section-hint">
          Used when you click <code>+</code> in the chat panel to start a new tab. Existing tabs keep running whichever CLI they were started with.
        </div>
        <div className="settings-radio-list">
          {state.terminalClis.map((c) => {
            const busy = uninstallingId === c.id;
            return (
              <div
                key={c.id}
                className={'settings-radio-row cli-row' + (c.id === state.terminalCli ? ' current' : '')}
                onClick={() => pick(c.id)}
                role="button"
              >
                <span className="settings-radio-text">
                  <span className="settings-radio-name">{c.label}</span>
                  <span className="settings-radio-detail">
                    {c.vendor}{c.installed ? '' : ' · not installed'}
                  </span>
                </span>
                <span className="cli-row-actions">
                  {c.installed && (
                    <button
                      type="button"
                      className="cli-uninstall"
                      title={`Uninstall ${c.label}`}
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); uninstall(c); }}
                    >{busy ? 'Uninstalling…' : 'Uninstall'}</button>
                  )}
                  {c.id === state.terminalCli && <CheckIcon className="settings-radio-check" />}
                </span>
              </div>
            );
          })}
        </div>
      </div>

    </>
  );
}
