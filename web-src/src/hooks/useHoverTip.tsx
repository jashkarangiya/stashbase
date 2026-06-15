import { useEffect, useRef, useState } from 'react';

/**
 * Hover tooltip for chrome buttons. The native HTML `title` tooltip is
 * unreliable in this Electron window (custom `hiddenInset` title bar —
 * it often never appears no matter how long you hover), so we render our
 * own. It's `position: fixed` so it escapes the sidebar's
 * `overflow: hidden` (the rail lives inside it); a pure-CSS `::after`
 * bubble would be clipped to the 44px rail.
 *
 * Returns props to spread on the trigger (no wrapper element, so the
 * button stays a direct flex child and the rail layout is untouched) and
 * the bubble node to drop inside it. Shows after a 600ms hover, matching
 * the OS tooltip delay; hides on leave or press.
 *
 *   const { tipProps, tip } = useHoverTip('Settings');
 *   return <button {...tipProps}>{icon}{tip}</button>;
 */
export function useHoverTip(label: string, placement: 'right' | 'bottom' = 'right') {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const timer = useRef<number | null>(null);

  function clear() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }
  // A stuck timer firing after unmount would setState on a dead component.
  useEffect(() => clear, []);

  const tipProps = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      // currentTarget is only valid synchronously — snapshot the rect now,
      // use it when the delay fires.
      const r = e.currentTarget.getBoundingClientRect();
      clear();
      timer.current = window.setTimeout(() => {
        setPos(placement === 'bottom'
          ? { top: r.bottom + 6, left: r.left + r.width / 2 }
          : { top: r.top + r.height / 2, left: r.right + 8 });
      }, 600);
    },
    onMouseLeave: () => { clear(); setPos(null); },
    onMouseDown: () => { clear(); setPos(null); },
  };

  const tip = pos
    ? (
      <span
        className={'hover-tip hover-tip-' + placement}
        style={{ top: pos.top, left: pos.left }}
        role="tooltip"
      >
        {label}
      </span>
    )
    : null;

  return { tipProps, tip };
}
