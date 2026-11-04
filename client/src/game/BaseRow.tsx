import type { DragEvent } from 'react';
import { isHiddenCard } from '@riftbound/engine';
import type { PlayerId } from '@riftbound/engine';
import { CardBack } from '../components/Card';
import { domainColor } from '../components/cardStyles';
import { ObjectCard } from './ObjectCard';
import type { BoardUi } from './useBoardUi';

function RuneChips({ ids, ui }: { ids: string[]; ui: BoardUi }) {
  const { view, cards } = ui.api;
  if (ids.length === 0) return <span className="text-xs text-slate-500">No runes</span>;
  return (
    <ul aria-label="Runes" className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const o = view.objects[id];
        if (!o || isHiddenCard(o)) return null;
        const def = cards[o.cardId];
        const domain = def?.domains[0];
        const color = domain ? domainColor(domain).base : '#64748b';
        return (
          <li
            key={id}
            title={`${def?.name ?? 'Rune'} (${o.ready ? 'ready' : 'exhausted'})`}
            aria-label={`${def?.name ?? 'Rune'}, ${o.ready ? 'ready' : 'exhausted'}`}
            className={`h-5 w-5 rounded-full border-2 border-black/50 ${o.ready ? '' : 'opacity-35'}`}
            style={{ backgroundColor: color }}
          />
        );
      })}
    </ul>
  );
}

export interface BaseRowProps {
  owner: PlayerId;
  ui: BoardUi;
}

/** One player's base: units, gear, runes, piles, legend/champion, and (for the opponent) the hand as card backs. */
export function BaseRow({ owner, ui }: BaseRowProps) {
  const { view, cards, seat } = ui.api;
  const mine = owner === seat;
  const ps = view.players.find((p) => p.id === owner);
  if (!ps) return null;

  const units: string[] = [];
  const gear: string[] = [];
  const runes: string[] = [];
  for (const id of ps.base) {
    const o = view.objects[id];
    if (!o) continue;
    if (isHiddenCard(o)) {
      units.push(id);
      continue;
    }
    const type = cards[o.cardId]?.type;
    if (type === 'RUNE') runes.push(id);
    else if (type === 'GEAR') gear.push(id);
    else units.push(id);
  }

  const option = mine ? ui.destOptions.get('base') : undefined;
  const dragging = mine && ui.dragIds !== null;
  const canTarget = mine && ui.selected.length > 0;

  const onDragOver = (e: DragEvent) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  return (
    <section
      aria-label={mine ? 'Your base' : "Opponent's base"}
      data-dest={mine ? 'base' : undefined}
      data-legal-dest={option ? 'true' : undefined}
      onClick={
        canTarget
          ? (e) => {
              e.stopPropagation();
              void ui.moveTo('base');
            }
          : undefined
      }
      onDragOver={mine ? onDragOver : undefined}
      onDrop={
        mine
          ? (e) => {
              e.preventDefault();
              void ui.dropOn('base');
            }
          : undefined
      }
      className={`flex flex-col gap-2 rounded-xl border bg-slate-900/70 p-2 ${
        option ? 'border-amber-300 ring-2 ring-amber-300/60' : 'border-slate-800'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
          {mine ? 'Your base' : "Opponent's base"}
        </h2>
        {mine && option ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void ui.moveTo('base');
            }}
            className="rounded-md bg-amber-300 px-2 py-0.5 text-xs font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Move to base
          </button>
        ) : null}
        {!mine ? (
          <div
            aria-label={`Opponent hand, ${ps.handCount} cards`}
            className="flex items-center gap-2 text-xs text-slate-400"
          >
            <div className="flex">
              {ps.hand.slice(0, 8).map((id, i) => (
                <CardBack
                  key={id}
                  owner={owner}
                  size="chain"
                  className={`!h-12 !w-8 ${i ? '-ml-4' : ''}`}
                />
              ))}
            </div>
            <span>{ps.handCount} in hand</span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <div className="flex gap-2">
          {[
            ['Deck', ps.mainDeckCount],
            ['Runes', ps.runeDeckCount],
            ['Trash', ps.trash.length],
          ].map(([label, n]) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <CardBack count={n as number} size="chain" className="!h-16 !w-12" />
              <span className="text-[10px] text-slate-300">{`${label} (${n})`}</span>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div aria-label="Units in base" className="flex min-h-12 flex-wrap items-start gap-2">
            {units.map((id) => (
              <ObjectCard key={id} id={id} ui={ui} size="board" />
            ))}
            {units.length === 0 ? <span className="text-xs text-slate-500">No units</span> : null}
          </div>
          {gear.length > 0 ? (
            <div aria-label="Gear in base" className="flex flex-wrap items-start gap-2">
              {gear.map((id) => {
                const g = view.objects[id];
                const attached = g && !isHiddenCard(g) ? g.attachedTo : undefined;
                const target = attached ? view.objects[attached] : undefined;
                const targetName =
                  target && !isHiddenCard(target) ? cards[target.cardId]?.name : undefined;
                return (
                  <div key={id} className="flex flex-col items-center gap-0.5">
                    <ObjectCard id={id} ui={ui} size="chain" />
                    {targetName ? (
                      <span className="text-[10px] text-slate-400">on {targetName}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          <RuneChips ids={runes} ui={ui} />
        </div>
        <div className="flex gap-2">
          {ps.legend ? (
            <div className="flex flex-col items-center gap-0.5">
              <ObjectCard id={ps.legend} ui={ui} size="chain" />
              <span className="text-[10px] text-slate-400">Legend</span>
            </div>
          ) : null}
          {ps.championZone.map((id) => (
            <div key={id} className="flex flex-col items-center gap-0.5">
              <ObjectCard id={id} ui={ui} size="chain" />
              <span className="text-[10px] text-slate-400">Champion</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
