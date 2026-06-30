import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpIcon, BoltIcon, CheckIcon, ClipboardListIcon, CodeIcon, DumbbellIcon,
  FileGenericIcon, HandIcon, PlusIcon, SlashSquareIcon,
} from '../../icons';
import { useApp } from '../../store/AppContext';
import { baseName } from './attachments';
import type { Attachment, EffortLevel, PermMode } from './types';

const MODES: { id: PermMode; label: string; desc: string; Icon: typeof HandIcon }[] = [
  { id: 'default', label: 'Ask before edits', desc: 'Claude will ask for approval before making each edit', Icon: HandIcon },
  { id: 'acceptEdits', label: 'Edit automatically', desc: 'Claude will apply edits without asking each time', Icon: CodeIcon },
  { id: 'plan', label: 'Plan mode', desc: 'Claude will explore and present a plan before editing', Icon: ClipboardListIcon },
  { id: 'auto', label: 'Auto mode', desc: 'Claude automatically chooses the best permission mode for each task', Icon: BoltIcon },
];

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max',
};

function ModeMenu({
  mode, effort, open, disabled, wrapRef, onToggle, onPick, onSetEffort,
}: {
  mode: PermMode;
  effort: EffortLevel;
  open: boolean;
  disabled: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onPick: (m: PermMode) => void;
  onSetEffort: (level: EffortLevel) => void;
}) {
  const active = MODES.find((m) => m.id === mode) ?? MODES[0];
  const ActiveIcon = active.Icon;
  return (
    <div className="agent-mode-wrap" ref={wrapRef}>
      {open && (
        <div className="agent-mode-menu" role="menu">
          <div className="agent-mode-menu-head">
            <span>Modes</span>
          </div>
          {MODES.map((m) => {
            const Icon = m.Icon;
            return (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={m.id === mode}
                className={'agent-mode-opt' + (m.id === mode ? ' active' : '')}
                onClick={() => onPick(m.id)}
              >
                <Icon className="agent-mode-opt-icon" />
                <span className="agent-mode-opt-text">
                  <span className="agent-mode-opt-title">{m.label}</span>
                  <span className="agent-mode-opt-desc">{m.desc}</span>
                </span>
                {m.id === mode && <CheckIcon className="agent-mode-opt-check" />}
              </button>
            );
          })}
          <EffortBar effort={effort} onSet={onSetEffort} />
        </div>
      )}
      <button
        type="button"
        className="agent-mode-btn"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Permission mode (⇧+Tab)"
        onClick={onToggle}
      >
        <ActiveIcon className="agent-mode-icon" />
        {active.label}
      </button>
    </div>
  );
}

function EffortBar({ effort, onSet }: { effort: EffortLevel; onSet: (l: EffortLevel) => void }) {
  const cur = EFFORTS.indexOf(effort);
  return (
    <div className="agent-effort">
      <DumbbellIcon className="agent-effort-icon" />
      <span className="agent-effort-label">
        Effort <span className="agent-effort-level">({EFFORT_LABEL[effort]})</span>
      </span>
      <div className="agent-effort-track" role="group" aria-label="Effort">
        {EFFORTS.map((lv, i) => (
          <button
            key={lv}
            type="button"
            className={
              'agent-effort-notch'
              + (i <= cur ? ' on' : '')
              + (lv === effort ? ' cur' : '')
              + (lv === 'max' ? ' max' : '')
            }
            aria-label={EFFORT_LABEL[lv]}
            aria-pressed={lv === effort}
            title={EFFORT_LABEL[lv]}
            onClick={() => onSet(lv)}
          />
        ))}
      </div>
    </div>
  );
}

function EffortMenu({
  effort, open, disabled, wrapRef, onToggle, onSetEffort,
}: {
  effort: EffortLevel;
  open: boolean;
  disabled: boolean;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onSetEffort: (level: EffortLevel) => void;
}) {
  return (
    <div className="agent-mode-wrap" ref={wrapRef}>
      {open && (
        <div className="agent-mode-menu effort-only" role="menu">
          <EffortBar effort={effort} onSet={onSetEffort} />
        </div>
      )}
      <button
        type="button"
        className="agent-mode-btn agent-effort-btn"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Effort"
        onClick={onToggle}
      >
        <DumbbellIcon className="agent-mode-icon" />
        {EFFORT_LABEL[effort]}
      </button>
    </div>
  );
}

export function AgentComposer({
  phase, disabled, turnActive, active, activeFile, mode, onSetMode, effort, onSetEffort,
  attachments, uploading, agentShortName, showModeMenu, showEffortMenu, onPickFiles, onRemoveAttachment, onSend, onStop,
}: {
  phase: 'connecting' | 'live' | 'closed';
  disabled: boolean;
  turnActive: boolean;
  active: boolean;
  activeFile: string | null;
  mode: PermMode;
  onSetMode: (mode: PermMode) => void;
  effort: EffortLevel;
  onSetEffort: (level: EffortLevel) => void;
  attachments: Attachment[];
  uploading: boolean;
  agentShortName: string;
  showModeMenu: boolean;
  showEffortMenu: boolean;
  onPickFiles: (files: File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { state } = useApp();
  const [mention, setMention] = useState<{ q: string; from: number } | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (active) taRef.current?.focus(); }, [active]);

  useEffect(() => {
    if (!modeOpen) return;
    function onDown(e: MouseEvent) {
      if (!modeWrapRef.current?.contains(e.target as Node)) setModeOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modeOpen]);

  function cycleMode() {
    const i = MODES.findIndex((m) => m.id === mode);
    onSetMode(MODES[(i + 1) % MODES.length].id);
  }

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return state.files
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, state.files]);

  const placeholder = phase === 'connecting'
    ? 'Connecting…'
    : phase === 'closed'
      ? 'Reconnect to continue…'
      : turnActive
        ? `${agentShortName} is working…`
        : `Message ${agentShortName}…`;

  function onChange(v: string, caret: number) {
    setText(v);
    const upto = v.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(upto);
    if (m) setMention({ q: m[2], from: caret - m[2].length });
    else setMention(null);
  }

  function pickMention(path: string) {
    const ta = taRef.current;
    if (!ta || !mention) return;
    const before = text.slice(0, mention.from);
    const after = text.slice(ta.selectionStart);
    const next = before + path + ' ' + after;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      ta.focus();
      const c = (before + path + ' ').length;
      ta.setSelectionRange(c, c);
    });
  }

  function submit() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || disabled || uploading) return;
    onSend(t);
    setText('');
    setMention(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      pickMention(suggestions[0].name);
      return;
    }
    if (showModeMenu && e.key === 'Tab' && e.shiftKey && !disabled) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && mention) setMention(null);
  }

  return (
    <div className="agent-composer">
      {mention && suggestions.length > 0 && (
        <div className="agent-mention">
          {suggestions.map((f) => (
            <button key={f.name} type="button" className="agent-mention-item" onClick={() => pickMention(f.name)}>
              <span className="agent-mention-name">{baseName(f.name)}</span>
              <span className="agent-mention-path">{f.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="agent-composer-box">
        {(attachments.length > 0 || uploading) && (
          <div className="agent-attachments">
            {attachments.map((a) => (
              <span key={a.path} className="agent-attach-chip" title={a.path}>
                <FileGenericIcon className="agent-attach-icon" />
                <span className="agent-attach-name">{a.name}</span>
                {a.dims && <span className="agent-attach-dims">{a.dims}</span>}
                <button
                  type="button"
                  className="agent-attach-x"
                  title="Remove attachment"
                  onClick={() => onRemoveAttachment(a.path)}
                >×</button>
              </span>
            ))}
            {uploading && <span className="agent-attach-loading">Uploading…</span>}
          </div>
        )}
        <textarea
          ref={taRef}
          className="agent-input"
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            onPickFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <div className="agent-composer-bar">
          <button
            type="button"
            className="agent-bar-btn"
            title={uploading ? 'Uploading…' : 'Upload local files'}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <PlusIcon />
          </button>
          <button type="button" className="agent-bar-btn slash" title="Slash commands (coming soon)" disabled>
            <SlashSquareIcon />
          </button>
          {activeFile && (
            <>
              <span className="agent-bar-divider" />
              <span className="agent-ctx-chip" title={activeFile}>
                <FileGenericIcon className="agent-ctx-icon" />
                <span className="agent-ctx-name">{baseName(activeFile)}</span>
              </span>
            </>
          )}
          <span className="agent-bar-spacer" />
          {showModeMenu && (
            <ModeMenu
              mode={mode}
              effort={effort}
              open={modeOpen}
              disabled={disabled}
              wrapRef={modeWrapRef}
              onToggle={() => setModeOpen((o) => !o)}
              onPick={(m) => { onSetMode(m); setModeOpen(false); }}
              onSetEffort={onSetEffort}
            />
          )}
          {showEffortMenu && (
            <EffortMenu
              effort={effort}
              open={modeOpen}
              disabled={disabled}
              wrapRef={modeWrapRef}
              onToggle={() => setModeOpen((o) => !o)}
              onSetEffort={onSetEffort}
            />
          )}
          {turnActive ? (
            <button type="button" className="agent-send stop" title="Stop" onClick={onStop}>■</button>
          ) : (
            <button
              type="button"
              className="agent-send"
              title="Send"
              disabled={disabled || uploading || (!text.trim() && attachments.length === 0)}
              onClick={submit}
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
