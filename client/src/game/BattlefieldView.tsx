import type { DragEvent } from 'react';
import { isHiddenCard } from '@riftbound/engine';
import type { BattlefieldState, PlayerId } from '@riftbound/engine';
import { Card, CardBack } from '../components/Card';
import { unitTutorialId } from './BaseRow';
import { ObjectCard } from './ObjectCard';
import type { BoardUi } from './useBoardUi';

function Badge({ children, tone }: { children: string; tone: 'amber' | 'sky' | 'rose' | 'slate' }) {
  const cls = {
    amber: 'bg-amber-400/20 text-amber-200 border-amber-400/60',
    sky: 'bg-sky-400/20 text-sky-200 border-sky-400/60',
    rose: 'bg-rose-500/20 text-rose-200 border-rose-500/60',
    slate: 'bg-slate-700/60 text-slate-200 border-slate-600',
  }[tone];
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

export interface BattlefieldViewProps {
  battlefield: BattlefieldState;
  ui: BoardUi;
}

export function BattlefieldView({ battlefield: bf, ui }: BattlefieldViewProps) {
  const { view, cards, seat } = ui.api;
  const opp: PlayerId = seat === 'p0' ? 'p1' : 'p0';
  const def = cards[bf.cardId];
  const name = def?.name ?? 'Battlefield';

  const unitsOf = (player: PlayerId): string[] =>
    Object.values(view.objects)
      .filter(
        (o) =>
          !isHiddenCard(o) &&
          o.zone.kind === 'battlefield' &&
          o.zone.battlefieldId === bf.id &&
          o.controller === player,
      )
      .map((o) => (o as { id: string }).id);
  const mineUnits = unitsOf(seat);
  const oppUnits = unitsOf(opp);

  const slot = bf.facedownSlotId ? view.objects[bf.facedownSlotId] : undefined;
  const option = ui.destOptions.get(bf.id);
  // X-loc: a spell or ability is choosing a battlefield / location: this one may be picked.
  const pickable = ui.targeting?.candidates.has('loc:' + bf.id) === true;
  const dragging = ui.dragIds !== null;
  const canTarget = ui.selected.length > 0;
  const who = (p: PlayerId | null): string =>
    p === null ? 'nobody' : p === seat ? 'you' : 'the opponent';

  const onDragOver = (e: DragEvent) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const controlLabel =
    bf.controller === null
      ? 'Uncontrolled'
      : bf.controller === seat
        ? 'You control'
        : 'Opponent controls';

  return (
    <section
      aria-label={`Battlefield: ${name}`}
      data-dest={bf.id}
      data-tutorial-id={`battlefield:${view.battlefields.findIndex((b) => b.id === bf.id)}`}
      data-legal-dest={option ? 'true' : undefined}
      data-pickable={pickable ? 'true' : undefined}
      onClick={
        pickable
          ? (e) => {
              e.stopPropagation();
              ui.pickTarget('loc:' + bf.id);
            }
          : canTarget
            ? (e) => {
                e.stopPropagation();
                void ui.moveTo(bf.id);
              }
            : undefined
      }
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        void ui.dropOn(bf.id);
      }}
      className={`flex min-w-0 flex-1 flex-col gap-2 rounded-xl border bg-slate-900 p-2 ${
        option || pickable ? 'border-amber-300 ring-2 ring-amber-300/60' : 'border-slate-700'
      }`}
    >
      <header className="flex flex-wrap items-center gap-1.5">
        <h3 className="mr-auto text-sm font-semibold text-slate-100">{name}</h3>
        <Badge tone={bf.controller === seat ? 'sky' : bf.controller === null ? 'slate' : 'rose'}>
          {controlLabel}
        </Badge>
        {bf.contestedBy !== null ? (
          <Badge tone="amber">{`Contested by ${who(bf.contestedBy)}`}</Badge>
        ) : null}
        {bf.scoredThisTurnBy.map((p) => (
          <Badge
            key={p}
            tone="slate"
          >{`${p === seat ? 'You' : 'Opponent'} scored this turn`}</Badge>
        ))}
        {pickable ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              ui.pickTarget('loc:' + bf.id);
            }}
            className="rounded-md bg-amber-300 px-2 py-0.5 text-xs font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {`Choose ${name}`}
          </button>
        ) : null}
        {option ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void ui.moveTo(bf.id);
            }}
            className="rounded-md bg-amber-300 px-2 py-0.5 text-xs font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {`Move to ${name}`}
          </button>
        ) : null}
      </header>

      <div className="flex gap-2">
        <div className="flex shrink-0 flex-col items-center gap-1">
          {def ? <Card def={def} size="chain" /> : null}
          <div aria-label="Facedown slot" className="flex flex-col items-center gap-0.5">
            {slot ? (
              isHiddenCard(slot) ? (
                <CardBack owner={slot.owner} size="chain" className="!h-16 !w-12" />
              ) : (
                <ObjectCard id={slot.id} ui={ui} size="chain" className="!h-16 !w-12" />
              )
            ) : null}
            {slot ? <span className="text-[10px] text-slate-400">Facedown</span> : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div
            aria-label="Opponent units here"
            className="flex min-h-12 flex-1 flex-wrap content-start items-start gap-2 rounded-lg bg-rose-950/20 p-1.5"
          >
            {oppUnits.map((id) => (
              <div key={id} data-tutorial-id={unitTutorialId(view.objects[id], false)}>
                <ObjectCard id={id} ui={ui} size="chain" />
              </div>
            ))}
          </div>
          <div
            aria-label="Your units here"
            className="flex min-h-12 flex-1 flex-wrap content-start items-start gap-2 rounded-lg bg-sky-950/20 p-1.5"
          >
            {mineUnits.map((id) => (
              <div key={id} data-tutorial-id={unitTutorialId(view.objects[id], true)}>
                <ObjectCard id={id} ui={ui} size="chain" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
