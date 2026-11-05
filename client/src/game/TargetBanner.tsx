import type { BoardUi } from './useBoardUi';

/** Prompt shown while a targeted spell waits for its targets (click-to-target). */
export function TargetBanner({ ui }: { ui: BoardUi }) {
  const t = ui.targeting;
  if (!t) return null;
  return (
    <section
      aria-label="Targeting"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-400 bg-rose-950/60 px-3 py-2 text-sm text-slate-100"
    >
      <p role="status" className="mr-auto font-semibold">
        {`Choose target ${t.slot} of ${t.total}: ${t.cardName}`}
      </p>
      {t.confirmOptions.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={o.onSelect}
          className="rounded-md bg-amber-300 px-3 py-1 font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {o.label}
        </button>
      ))}
      <button
        type="button"
        onClick={ui.cancelTargeting}
        className="rounded-md border border-slate-500 px-3 py-1 text-slate-100 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300"
      >
        Cancel
      </button>
    </section>
  );
}
