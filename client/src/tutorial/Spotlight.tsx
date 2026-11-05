import { useEffect, useId, useLayoutEffect, useState } from 'react';

/** `[data-tutorial-id="x"]` for plain ids; ids starting with `[`, `.` or `#` are raw CSS selectors. */
export function selectorFor(id: string): string {
  if (/^[[.#]/.test(id)) return id;
  return `[data-tutorial-id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

/** All elements matching the given tutorial ids / selectors (deduplicated). */
export function findTargets(ids: readonly string[], root: ParentNode = document): HTMLElement[] {
  const out = new Set<HTMLElement>();
  for (const id of ids) {
    try {
      root.querySelectorAll<HTMLElement>(selectorFor(id)).forEach((el) => out.add(el));
    } catch {
      /* invalid selector: ignore */
    }
  }
  return [...out];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 6;

function measure(ids: readonly string[]): Box[] {
  return findTargets(ids)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 }));
}

const same = (a: Box[], b: Box[]): boolean =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i]!;
    return (
      Math.abs(r.x - o.x) < 0.5 &&
      Math.abs(r.y - o.y) < 0.5 &&
      Math.abs(r.w - o.w) < 0.5 &&
      Math.abs(r.h - o.h) < 0.5
    );
  });

/**
 * Dims the page and outlines the elements for `ids`. The whole layer is pointer-events:none, so it
 * can never block a click on the highlighted element (or anything else). Repositions on resize,
 * scroll (any scroller) and DOM changes; `version` forces a re-measure after state updates.
 */
export function Spotlight({ ids, version }: { ids: readonly string[]; version: number }) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const maskId = `spot-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const key = ids.join('|');

  useLayoutEffect(() => {
    const next = measure(ids);
    setBoxes((cur) => (same(cur, next) ? cur : next));
  }, [key, version]);

  useEffect(() => {
    if (ids.length === 0) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = measure(ids);
        setBoxes((cur) => (same(cur, next) ? cur : next));
      });
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const mo = new MutationObserver(update);
    mo.observe(document.body, { childList: true, subtree: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    findTargets(ids).forEach((el) => ro?.observe(el));
    // Bring the first target into view when the step changes, but only when it is entirely off
    // screen: scrolling for a partly visible (tall) target would push the board header away.
    const first = findTargets(ids)[0];
    if (first && typeof first.scrollIntoView === 'function') {
      const r = first.getBoundingClientRect();
      const offscreen = r.bottom <= 0 || r.top >= window.innerHeight;
      if (offscreen) first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      mo.disconnect();
      ro?.disconnect();
    };
  }, [key]);

  if (ids.length === 0 || boxes.length === 0) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="spotlight"
      className="pointer-events-none fixed inset-0 z-[35]"
      style={{ pointerEvents: 'none' }}
    >
      <svg width="100%" height="100%" style={{ pointerEvents: 'none' }}>
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {boxes.map((b, i) => (
              <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={10} fill="black" />
            ))}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(2,6,23,0.72)" mask={`url(#${maskId})`} />
        {boxes.map((b, i) => (
          <rect
            key={i}
            data-testid="spotlight-box"
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={10}
            fill="none"
            stroke="#fcd34d"
            strokeWidth={3}
            className="animate-pulse"
          />
        ))}
      </svg>
    </div>
  );
}
