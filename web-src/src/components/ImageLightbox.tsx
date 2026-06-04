import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt = '', onClose }: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [src]);

  useEffect(() => {
    // Inline the zoom/reset logic off the stable state setters so the
    // listener binds once per `onClose` rather than re-binding on every
    // render (each zoom/pan tick re-renders).
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === '0') { setScale(1); setOffset({ x: 0, y: 0 }); }
      else if (e.key === '+' || e.key === '=') setScale((v) => clamp(v * 1.2));
      else if (e.key === '-') setScale((v) => clamp(v / 1.2));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function zoomBy(factor: number) {
    setScale((v) => clamp(v * factor));
  }

  function reset() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (scale <= 1) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setOffset((p) => ({ x: p.x + dx, y: p.y + dy }));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
  }

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview">
      <div className="image-lightbox-toolbar">
        <div className="image-lightbox-title">{alt || 'Image preview'}</div>
        <button type="button" onClick={() => zoomBy(1 / 1.2)}>Zoom out</button>
        <span className="image-lightbox-scale">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.2)}>Zoom in</button>
        <button type="button" onClick={reset}>Reset</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div
        className={'image-lightbox-stage' + (scale > 1 ? ' pannable' : '')}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
        />
      </div>
    </div>
  );
}

function clamp(value: number): number {
  return Math.min(6, Math.max(0.2, value));
}
