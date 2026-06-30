/**
 * All SVG icons used in the UI. Sized via parent CSS so each component
 * stays a pure shape — no width/height props. Stroke colour follows
 * `currentColor` so the parent's `color` rule wins.
 */

type IconProps = { className?: string };

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function SearchIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** History / past sessions — a clean clock (Lucide `clock`), matching
 *  the VSCode chat panel's history glyph. */
export function HistoryIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

/** Up arrow — the composer send button. An SVG (not the "↑" glyph, which
 *  renders thin and baseline-low); slim + tall, stroke matched to
 *  SlashSquareIcon's visual weight. Symmetric in x about 12 so grid
 *  centring lands it dead-centre. */
export function ArrowUpIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.8} {...stroke}>
      <line x1="12" y1="20" x2="12" y2="4.5" />
      <polyline points="7 9.5 12 4.5 17 9.5" />
    </svg>
  );
}

/** Plain plus — new chat / add. */
export function PlusIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/** Chat bubble with a plus — "new chat" (Lucide `message-square-plus`),
 *  matching the VSCode chat panel's new-conversation glyph. */
export function NewChatIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="9" y1="10" x2="15" y2="10" />
      <line x1="12" y1="7" x2="12" y2="13" />
    </svg>
  );
}

/** `</>` — code / edit-mode glyph for the composer mode button. */
export function CodeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

/** Rounded square with a slash — the slash-command button glyph (the box
 *  is part of the icon, not a CSS border). The square nearly fills the
 *  viewBox so a hover background sized to the button reads as the box
 *  filling in, not an off-centre halo around a small glyph. */
export function SlashSquareIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <line x1="14" y1="7" x2="10" y2="17" />
    </svg>
  );
}

/** Raised palm — "ask / stop before each edit" permission mode. */
export function HandIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

/** Clipboard with list lines — "plan mode" (explore then present a plan). */
export function ClipboardListIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </svg>
  );
}

/** Dumbbell — "effort" (thinking depth) control in the Modes dropdown. */
export function DumbbellIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <path d="M6 7v10" />
      <path d="M18 7v10" />
      <path d="M3 9.5v5" />
      <path d="M21 9.5v5" />
      <line x1="6" y1="12" x2="18" y2="12" />
    </svg>
  );
}

/** Lightning bolt — "auto mode" (model picks the permission mode). */
export function BoltIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function NewFileIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

export function NewFolderIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function SyncIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke}>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <polyline points="21 3 21 8 16 8" />
    </svg>
  );
}

/** Chevrons point INWARD (top points down, bottom points up — meeting
 *  in the middle). Reads as "compress / fold". Sidebar shows this
 *  when some folders are still open; clicking collapses them. */
export function CollapseAllIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke}>
      <polyline points="8 4 12 9 16 4" />
      <polyline points="8 20 12 15 16 20" />
    </svg>
  );
}

/** Chevrons point OUTWARD (top points up, bottom points down — pulling
 *  apart). Reads as "spread / expand". Sidebar swaps to this when
 *  everything is already folded; clicking expands all. */
export function ExpandAllIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke}>
      <polyline points="8 9 12 4 16 9" />
      <polyline points="8 15 12 20 16 15" />
    </svg>
  );
}

export function FileGenericIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.5} {...stroke}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** Stacked-pages icon for the "Files" activity-bar view — two
 *  overlapping document silhouettes, à la VS Code's Explorer icon.
 *  Two independent paths (back-doc visible outline + front-doc full
 *  outline) so the folded corners read cleanly; the back doc only
 *  draws the edges that aren't occluded by the front. */
export function FilesViewIcon({ className }: IconProps) {
  // Lucide `file-text` — same document frame as `NewFileIcon` so the
  // two read as a family; three text rows say "file listing".
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
      <line x1="8" y1="9" x2="10" y2="9" />
    </svg>
  );
}

export function EditIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.8} {...stroke}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

/** Trash can (Lucide `trash-2`) — delete a session in the History dropdown. */
export function TrashIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.8} {...stroke}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

export function PreviewIcon({ className }: IconProps) {
  // Open-book silhouette for the floating edit/read toggle. Earlier it
  // was drawn with two geometric half-pages that read as "two
  // trapezoids", not a book; this shape is unambiguous.
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.7} {...stroke}>
      <path d="M3 5 C7 4 9 4 12 6 C15 4 17 4 21 5 V19 C17 18 15 18 12 20 C9 18 7 18 3 19 Z" />
      <path d="M12 6 V20" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2.2} {...stroke}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/* Agent rules-books are tagged with the logo of the agent that owns
 * them: CLAUDE.md → Claude, AGENTS.md → OpenAI/Codex. Each keeps its
 * brand mark recognisable rather than sharing one generic "rules" glyph.
 * The marks carry explicit colour except Codex, whose mono mark follows
 * `--fg` to read on either theme. */

/** StashBase mark — the app's own cube logo (`build/icon.svg`, minus
 *  the rounded background plate that would render as a white square at
 *  16px). Used as the stashing-progress pill/list logo. */
export function StashBaseIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="31 25 450 450" fill="none">
      <g stroke="#6b7280" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round">
        <path d="M92 158 L92 342" />
        <path d="M92 342 L256 436" />
      </g>
      <g stroke="#6b7280" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round">
        <path d="M338 111 L256 64 L92 158" />
        <path d="M92 158 L256 252 L420 158" />
        <path d="M420 158 L420 342" />
        <path d="M420 342 L256 436" />
        <path d="M256 436 L256 342" />
      </g>
      <g className="s-cyan" stroke="#0891b2" strokeWidth={32} strokeLinecap="round" strokeLinejoin="round">
        <path d="M338 111 L256 64 L92 158" />
        <path d="M92 158 L256 252 L420 158" />
        <path d="M420 158 L420 342" />
        <path d="M420 342 L256 436" />
        <path d="M256 436 L256 342" />
      </g>
    </svg>
  );
}

/** Claude mark (Simple Icons, CC0) in the Claude brand coral. File
 *  glyph for CLAUDE.md, the Claude Code rules file. */
export function ClaudeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="#D97757">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/** OpenAI / Codex mark (Simple Icons, CC0). Monochrome, so it follows
 *  `--fg` to stay legible on light and dark. File glyph for AGENTS.md,
 *  the Codex agent rules file. The mark fills its native 24-box almost
 *  edge-to-edge, so the viewBox is padded to ~78% fill — otherwise it
 *  reads visibly larger than the other glyphs in the same 16px slot. */
export function CodexIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="-2 -2 28 28" fill="var(--fg)">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

/** Two overlapping sheets — the conventional "copy to clipboard" glyph
 *  (Lucide proportions: front sheet + back sheet peeking top-left). */
export function CopyIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}


export function SettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={1.6} {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  );
}


export function CubeLogoIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g stroke="#6b7280" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round">
        <path d="M92 158 L92 342" />
        <path d="M92 342 L256 436" />
      </g>
      <g stroke="#0891b2" strokeWidth={20} strokeLinecap="round" strokeLinejoin="round">
        <path d="M92 158 L256 64 L338 111" />
        <path d="M92 158 L256 252 L420 158" />
        <path d="M420 158 L420 342" />
        <path d="M256 436 L420 342" />
        <path d="M256 342 L256 436" />
      </g>
    </svg>
  );
}

/** House — chrome-strip button that returns to the Welcome screen
 *  (`actions.goHome()`). The clean way to switch folders without
 *  losing tab/nav state to a full page reload. */
export function HomeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" strokeWidth={2} {...stroke}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </svg>
  );
}
