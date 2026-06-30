import { useEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from 'react';
import { renderMarkdownInline } from '../../markdown';
import { ChevronDownIcon, FileGenericIcon } from '../../icons';
import type { Block, ToolBlock, ToolStatus } from './types';

export function MessageList({
  blocks, turnActive, phase, agentName, agentShortName, Icon, onPermission,
}: {
  blocks: Block[];
  turnActive: boolean;
  phase: 'connecting' | 'live' | 'closed';
  agentName: string;
  agentShortName: string;
  Icon: ComponentType<{ className?: string }>;
  onPermission: (toolBlockId: string, permId: string, allow: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });

  const turns = useMemo(() => groupTurns(blocks), [blocks]);

  return (
    <div className="agent-messages" ref={ref} onScroll={onScroll}>
      {blocks.length === 0 && phase === 'live' && <Hero name={agentName} Icon={Icon} />}
      {phase === 'connecting' && <div className="agent-empty">Connecting to {agentShortName}…</div>}
      {turns.map((turn) => (
        <div className="agent-turn" key={turn.key}>
          {turn.head && <UserTurnHead block={turn.head} scrollRef={ref} />}
          {turn.body.map((b) => <BlockView key={b.id} block={b} onPermission={onPermission} />)}
        </div>
      ))}
      {turnActive && <div className="agent-working"><span className="agent-dot" />{agentShortName} is working…</div>}
    </div>
  );
}

interface Turn { key: string; head: Extract<Block, { kind: 'user' }> | null; body: Block[] }

function groupTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const b of blocks) {
    if (b.kind === 'user') {
      cur = { key: b.id, head: b, body: [] };
      turns.push(cur);
    } else {
      if (!cur) { cur = { key: `lead-${b.id}`, head: null, body: [] }; turns.push(cur); }
      cur.body.push(b);
    }
  }
  return turns;
}

function UserTurnHead({
  block, scrollRef,
}: {
  block: Extract<Block, { kind: 'user' }>;
  scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = scrollRef?.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      ([e]) => setStuck(!e.isIntersecting),
      { root, threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollRef]);

  return (
    <>
      <span ref={sentinelRef} className="agent-turn-sentinel" aria-hidden="true" />
      <div className={'agent-turn-head' + (stuck ? ' stuck' : '')}>
        {block.attachments && block.attachments.length > 0 && (
          <div className="agent-turn-attach">
            {block.attachments.map((a) => (
              <span key={a.path} className="agent-attach-chip" title={a.path}>
                <FileGenericIcon className="agent-attach-icon" />
                <span className="agent-attach-name">{a.name}</span>
                {a.dims && <span className="agent-attach-dims">{a.dims}</span>}
              </span>
            ))}
          </div>
        )}
        {block.text && <span className="agent-turn-text">{block.text}</span>}
      </div>
    </>
  );
}

function Hero({ name, Icon }: { name: string; Icon: ComponentType<{ className?: string }> }) {
  return (
    <div className="agent-hero">
      <div className="agent-hero-wordmark">
        <Icon className="agent-hero-mark" />
        <span className="agent-hero-name">{name}</span>
      </div>
      {name === 'Claude Code' && <PixelMascot />}
    </div>
  );
}

function PixelMascot() {
  const color = '#D97757';
  const px: Array<[number, number]> = [];
  for (let x = 2; x <= 6; x++) for (let y = 1; y <= 4; y++) px.push([x, y]);
  px.push([2, 5], [3, 5], [5, 5], [6, 5]);
  const eyes = new Set(['3,2', '5,2']);
  return (
    <svg className="agent-hero-sprite" viewBox="0 0 9 7" shapeRendering="crispEdges" aria-hidden="true">
      {px.filter(([x, y]) => !eyes.has(`${x},${y}`)).map(([x, y]) => (
        <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={color} />
      ))}
    </svg>
  );
}

function BlockView({ block, onPermission }: { block: Block; onPermission: (t: string, p: string, a: boolean) => void }) {
  switch (block.kind) {
    case 'user':
      return <UserTurnHead block={block} />;
    case 'assistant':
      return (
        <div className="agent-msg assistant">
          <div className="agent-prose" dangerouslySetInnerHTML={{ __html: renderMarkdownInline(block.text) }} />
        </div>
      );
    case 'thinking':
      return <ThinkingView text={block.text} />;
    case 'error':
      return <div className="agent-error">{block.text}</div>;
    case 'tool':
      return <ToolCard block={block} onPermission={onPermission} />;
  }
}

function ThinkingView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={'agent-thinking' + (open ? ' open' : '')}>
      <button type="button" className="agent-thinking-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDownIcon className="agent-thinking-chev" />
        <span>Thinking</span>
      </button>
      {open && <div className="agent-thinking-body">{text}</div>}
    </div>
  );
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: 'Running',
  awaiting: 'Review',
  done: 'Done',
  error: 'Error',
  denied: 'Denied',
};

function ToolCard({ block, onPermission }: { block: ToolBlock; onPermission: (t: string, p: string, a: boolean) => void }) {
  const [open, setOpen] = useState(block.status === 'awaiting' || block.name === 'Bash');
  const diff = useMemo(() => buildDiff(block.name, block.input), [block.name, block.input]);
  const summary = toolSummary(block.name, block.input);

  return (
    <div className={'agent-tool status-' + block.status}>
      <button type="button" className="agent-tool-head" onClick={() => setOpen((o) => !o)}>
        <ChevronDownIcon className="agent-tool-chev" />
        <span className="agent-tool-name">{block.name}</span>
        <span className="agent-tool-summary">{summary}</span>
        <span className={'agent-tool-status s-' + block.status}>
          {block.status === 'running' && <span className="agent-dot" />}
          {STATUS_LABEL[block.status]}
        </span>
      </button>

      {block.status === 'awaiting' && block.permId && (
        <div className="agent-perm">
          <div className="agent-perm-title">{block.permTitle ?? `Allow Claude to run ${block.name}?`}</div>
          {diff && <DiffView diff={diff} />}
          {!diff && block.name === 'Bash' && (
            <pre className="agent-bash">{String(block.input.command ?? '')}</pre>
          )}
          <div className="agent-perm-actions">
            <button type="button" className="agent-btn ghost" onClick={() => onPermission(block.id, block.permId!, false)}>Reject</button>
            <button type="button" className="agent-btn primary" onClick={() => onPermission(block.id, block.permId!, true)}>Allow</button>
          </div>
        </div>
      )}

      {open && block.status !== 'awaiting' && (
        <div className="agent-tool-body">
          {diff && <DiffView diff={diff} />}
          {!diff && block.name === 'Bash' && <pre className="agent-bash">{String(block.input.command ?? '')}</pre>}
          {!diff && block.name !== 'Bash' && (
            <pre className="agent-tool-input">{JSON.stringify(block.input, null, 2)}</pre>
          )}
          {block.result != null && block.result !== '' && (
            <pre className={'agent-tool-result' + (block.status === 'error' ? ' err' : '')}>{clip(block.result)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

type DiffRow = { type: 'ctx' | 'del' | 'add'; text: string };

function DiffView({ diff }: { diff: { file: string; rows: DiffRow[] } }) {
  return (
    <div className="agent-diff">
      <div className="agent-diff-file">{diff.file}</div>
      <div className="agent-diff-body">
        {diff.rows.map((r, i) => (
          <div key={i} className={'agent-diff-row ' + r.type}>
            <span className="agent-diff-gutter">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
            <span className="agent-diff-text">{r.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildDiff(name: string, input: Record<string, unknown>): { file: string; rows: DiffRow[] } | null {
  const file = String(input.file_path ?? input.path ?? '');
  if (name === 'Edit') {
    return { file, rows: lineDiff(String(input.old_string ?? ''), String(input.new_string ?? '')) };
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const rows: DiffRow[] = [];
    for (const e of input.edits as Array<Record<string, unknown>>) {
      rows.push(...lineDiff(String(e.old_string ?? ''), String(e.new_string ?? '')));
    }
    return { file, rows };
  }
  if (name === 'Write') {
    return { file, rows: lineDiff('', String(input.content ?? '')) };
  }
  return null;
}

function lineDiff(oldStr: string, newStr: string): DiffRow[] {
  const o = oldStr === '' ? [] : oldStr.split('\n');
  const n = newStr === '' ? [] : newStr.split('\n');
  let p = 0;
  while (p < o.length && p < n.length && o[p] === n[p]) p++;
  let s = 0;
  while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;

  const rows: DiffRow[] = [];
  const ctx = 3;
  const headStart = Math.max(0, p - ctx);
  for (let i = headStart; i < p; i++) rows.push({ type: 'ctx', text: o[i] });
  for (let i = p; i < o.length - s; i++) rows.push({ type: 'del', text: o[i] });
  for (let i = p; i < n.length - s; i++) rows.push({ type: 'add', text: n[i] });
  const tailEnd = Math.min(o.length, o.length - s + ctx);
  for (let i = o.length - s; i < tailEnd; i++) rows.push({ type: 'ctx', text: o[i] });
  return rows;
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const f = input.file_path ?? input.path;
  if (typeof f === 'string') return baseName(f);
  if (name === 'Bash' && typeof input.command === 'string') return clipInline(input.command, 60);
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.url === 'string') return input.url;
  return '';
}

const baseName = (p: string) => p.split('/').pop() || p;
const clipInline = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const clip = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + '\n…(truncated)' : s);
