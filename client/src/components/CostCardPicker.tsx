import { useState } from 'react';
import { costCardCandidates, costCardCount, costCardText, isHiddenCard } from '@riftbound/engine';
import type {
  CardDatabase,
  CardInstance,
  ClientGameState,
  CostCardChoice,
  PlayerId,
} from '@riftbound/engine';
import { cardNameOf, locationName } from '../game/interaction';

/**
 * Objects that can pay a card-choice cost (R46), listed from the player's own view with the engine's
 * own qualifying rule (`costCardCandidates`). The engine still validates the chosen cards; this only
 * decides what the picker offers. Hidden cards never qualify (only the viewer's own hand is real).
 */
export function costCandidates(
  view: ClientGameState,
  cards: CardDatabase,
  seat: PlayerId,
  sourceId: string,
  cost: CostCardChoice,
): string[] {
  const objects: Record<string, CardInstance> = {};
  for (const [id, o] of Object.entries(view.objects)) if (!isHiddenCard(o)) objects[id] = o;
  return costCardCandidates(
    { objects, battlefields: view.battlefields },
    cards,
    seat,
    sourceId,
    cost,
  );
}

/** Where a candidate card is, in words: "in your hand", "in your base", "at Reaver's Row", "in your Trash". */
function whereIs(view: ClientGameState, cards: CardDatabase, id: string): string {
  const o = view.objects[id];
  if (!o || isHiddenCard(o)) return '';
  switch (o.zone.kind) {
    case 'hand':
      return 'in your hand';
    case 'trash':
      return 'in your Trash';
    case 'base':
      return 'in your base';
    case 'battlefield':
      return `at ${locationName({ kind: 'battlefield', battlefieldId: o.zone.battlefieldId }, view, cards)}`;
    default:
      return '';
  }
}

function detailOf(view: ClientGameState, cards: CardDatabase, id: string): string {
  const o = view.objects[id];
  if (!o || isHiddenCard(o)) return '';
  const def = cards[o.cardId];
  if (!def) return '';
  const stats = def.stats.might !== undefined ? `${def.stats.might} Might` : '';
  return [def.type.charAt(0) + def.type.slice(1).toLowerCase(), stats].filter(Boolean).join(', ');
}

/**
 * Pick the cards that pay a card-choice cost: one toggle per qualifying card (a list, so it works the
 * same with a mouse, a keyboard and a finger), a counter and a confirm button that is enabled only
 * when exactly the required number is chosen.
 */
export function CostCardPicker(props: {
  view: ClientGameState;
  cards: CardDatabase;
  cost: CostCardChoice;
  candidates: readonly string[];
  confirmLabel: string;
  busy?: boolean;
  onConfirm: (ids: string[]) => void;
}) {
  const { view, cards, cost, candidates } = props;
  const need = costCardCount(cost);
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string): void =>
    setPicked((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (need === 1) return [id];
      return cur.length < need ? [...cur, id] : cur;
    });
  const ready = picked.length === need;
  return (
    <div data-testid="cost-picker" className="mt-3">
      <p className="text-sm font-semibold" id="cost-picker-label">
        {`${costCardText(cost)}: choose ${need === 1 ? 'one' : need} (${picked.length}/${need})`}
      </p>
      <ul
        aria-labelledby="cost-picker-label"
        className="mt-2 flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto pr-1"
      >
        {candidates.map((id) => {
          const on = picked.includes(id);
          const name = cardNameOf(id, view, cards);
          return (
            <li key={id}>
              <button
                type="button"
                aria-pressed={on}
                data-testid={`cost-card-${id}`}
                onClick={() => toggle(id)}
                className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 ${
                  on
                    ? 'border-amber-300 bg-amber-300/20 text-amber-100'
                    : 'border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700'
                }`}
              >
                <span className="font-semibold">{`${on ? '✓ ' : ''}${name}`}</span>
                <span className="text-xs text-slate-300">
                  {[detailOf(view, cards, id), whereIs(view, cards, id)]
                    .filter(Boolean)
                    .join(' - ')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={!ready || props.busy === true}
        data-testid="cost-confirm"
        onClick={() => props.onConfirm(picked)}
        className="mt-3 rounded-md bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
      >
        {props.confirmLabel}
      </button>
    </div>
  );
}
