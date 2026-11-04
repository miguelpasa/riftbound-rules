import { useEffect, useRef } from 'react';
import type { PopoverState } from './useBoardUi';

/** Small menu anchored at a screen position: used for the play-location chooser and the card context menu. */
export function Popover({ popover, onClose }: { popover: PopoverState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, popover]);

  const left = Math.max(8, Math.min(popover.x, window.innerWidth - 280));
  const top = Math.max(8, Math.min(popover.y, window.innerHeight - 40 - popover.items.length * 40));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={popover.title}
      style={{ left, top }}
      className="fixed z-40 w-64 rounded-lg border border-slate-600 bg-slate-900 p-1 shadow-xl"
    >
      <p className="px-2 py-1 text-xs font-semibold text-slate-400">{popover.title}</p>
      {popover.items.map((item, i) => (
        <button
          key={`${i}-${item.label}`}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={item.onSelect}
          className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-slate-100 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed disabled:text-slate-500"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
