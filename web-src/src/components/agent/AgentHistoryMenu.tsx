import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type SessionInfo } from '../../api';
import { EditIcon, HistoryIcon, TrashIcon } from '../../icons';
import type { AgentKind } from './types';

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString();
}

export function AgentHistoryMenu({
  open, currentSessionId, agent, onToggle, onClose, onResume, onActiveDeleted,
}: {
  open: boolean;
  currentSessionId: string | null;
  agent: AgentKind;
  onToggle: () => void;
  onClose: () => void;
  onResume: (id: string) => void;
  onActiveDeleted: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  async function refresh() {
    setLoading(true);
    try { setSessions(await api.listSessions(agent)); }
    catch { setSessions([]); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (open) { void refresh(); }
    else { setQ(''); setEditingId(null); }
  }, [open, agent]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;
  }, [sessions, q]);

  async function commitRename(id: string) {
    const title = editText.trim();
    setEditingId(null);
    if (!title) return;
    try {
      const updated = await api.renameSession(id, title, agent);
      setSessions((ss) => ss.map((s) => (s.id === id ? updated : s)));
    } catch { /* leave list as-is */ }
  }

  async function remove(id: string) {
    try { await api.deleteSession(id, agent); } catch { return; }
    setSessions((ss) => ss.filter((s) => s.id !== id));
    if (id === currentSessionId) onActiveDeleted();
  }

  return (
    <div className="agent-history-wrap" ref={wrapRef}>
      <button
        type="button"
        className="agent-head-btn"
        title="Chat history"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <HistoryIcon />
      </button>
      {open && (
        <div className="agent-history-menu" role="menu">
          <div className="agent-history-search">
            <input
              type="text"
              autoFocus
              placeholder="Search sessions…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="agent-history-list">
            {loading && <div className="agent-history-empty">Loading…</div>}
            {!loading && shown.length === 0 && (
              <div className="agent-history-empty">{q ? 'No matches.' : 'No sessions yet.'}</div>
            )}
            {!loading && shown.map((s) => (
              <div
                key={s.id}
                className={'agent-history-row' + (s.id === currentSessionId ? ' active' : '')}
              >
                {editingId === s.id ? (
                  <input
                    className="agent-history-rename"
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.id); }
                      else if (e.key === 'Escape') setEditingId(null);
                    }}
                    onBlur={() => void commitRename(s.id)}
                  />
                ) : (
                  <button
                    type="button"
                    className="agent-history-open"
                    title={s.title}
                    onClick={() => onResume(s.id)}
                  >
                    <span className="agent-history-title">{s.title}</span>
                    <span className="agent-history-time">{relTime(s.lastModified)}</span>
                  </button>
                )}
                <div className="agent-history-row-actions">
                  <button
                    type="button"
                    className="agent-history-act"
                    title="Rename"
                    onClick={() => { setEditingId(s.id); setEditText(s.title); }}
                  >
                    <EditIcon />
                  </button>
                  <button
                    type="button"
                    className="agent-history-act"
                    title="Delete"
                    onClick={() => void remove(s.id)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
