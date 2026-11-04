import { ObjectCard } from './ObjectCard';
import type { BoardUi } from './useBoardUi';

/** The viewer's hand as an overlapping row; playable cards are highlighted from api.legal. */
export function Hand({ ui }: { ui: BoardUi }) {
  const { view, seat } = ui.api;
  const me = view.players.find((p) => p.id === seat);
  if (!me) return null;
  const crowded = me.hand.length > 6;
  return (
    <section aria-label="Your hand" className="flex flex-col gap-1">
      <h2 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
        Your hand ({me.hand.length})
      </h2>
      <div
        className={`flex min-h-44 items-end overflow-x-auto px-2 pt-3 pb-2 ${crowded ? '' : 'gap-2'}`}
      >
        {me.hand.map((id, i) => (
          <div
            key={id}
            className={`shrink-0 transition-[margin] hover:z-10 focus-within:z-10 ${crowded && i > 0 ? '-ml-10 hover:mr-10 focus-within:mr-10' : ''}`}
          >
            <ObjectCard id={id} ui={ui} size="board" inHand />
          </div>
        ))}
        {me.hand.length === 0 ? (
          <span className="text-sm text-slate-500">Hand is empty</span>
        ) : null}
      </div>
    </section>
  );
}
