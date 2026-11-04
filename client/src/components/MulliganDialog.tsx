import { useId, useState, type ReactNode } from 'react';

export interface MulliganCard {
  id: string;
  name: string;
}

export interface MulliganDialogProps {
  cards: MulliganCard[];
  /** Receives the ids to swap; an empty array means keep the hand. */
  onConfirm: (selectedIds: string[]) => void;
  maxSwap?: number;
  waitingFor?: boolean;
  /** Optional renderer for the card face; defaults to the card name. */
  renderCard?: (id: string) => ReactNode;
}

/** Lets the player pick up to `maxSwap` cards to mulligan, then confirm. */
export function MulliganDialog({
  cards,
  onConfirm,
  maxSwap = 2,
  waitingFor = false,
  renderCard,
}: MulliganDialogProps) {
  const titleId = useId();
  const [selected, setSelected] = useState<string[]>([]);

  // Ignore selections for cards that are no longer in the hand.
  const valid = selected.filter((id) => cards.some((card) => card.id === id));
  const count = valid.length;
  const atLimit = count >= maxSwap;

  function toggle(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      if (current.length >= maxSwap) return current;
      return [...current, id];
    });
  }

  const confirmLabel = waitingFor
    ? 'Waiting for opponent...'
    : count === 0
      ? 'Keep hand'
      : `Swap ${count} ${count === 1 ? 'card' : 'cards'}`;

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900 p-4"
    >
      <header className="flex flex-col gap-1">
        <h2 id={titleId} className="text-lg font-semibold text-amber-300">
          Mulligan
        </h2>
        <p className="text-sm text-slate-400">
          Select up to {maxSwap} cards to swap, or keep your hand.
        </p>
      </header>

      <ul className="flex flex-wrap gap-2">
        {cards.map((card) => {
          const isSelected = valid.includes(card.id);
          return (
            <li key={card.id}>
              <button
                type="button"
                aria-label={card.name}
                aria-pressed={isSelected}
                disabled={waitingFor || (!isSelected && atLimit)}
                onClick={() => toggle(card.id)}
                className={`rounded-lg border px-3 py-2 text-sm transition focus-visible:outline-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed disabled:opacity-50 ${
                  isSelected
                    ? 'border-amber-400 bg-amber-400/15 text-amber-100 ring-2 ring-amber-400'
                    : 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700'
                }`}
              >
                {renderCard ? renderCard(card.id) : card.name}
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        disabled={waitingFor}
        onClick={() => onConfirm(valid)}
        className="rounded-lg bg-amber-400 px-4 py-2.5 font-semibold text-slate-950 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
      >
        {confirmLabel}
      </button>
    </section>
  );
}
