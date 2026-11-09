import { useState } from 'react';
import type { CardDatabase, ChooseHandCardsIntent } from '@riftbound/engine';
import { useGame } from '../app/gameApi';
import { useIntentSender } from './useIntentSender';

/**
 * X-hand: "Each player discards 1" / "They reveal their hand. Choose a card from it ...". Shown while the engine
 * is paused on a HAND_CHOICE. The chooser ticks exactly `count` of the offered cards and confirms; the opponent of
 * the chooser sees a waiting notice. Every answer is one of the engine's own legal CHOOSE_HAND_CARDS intents.
 */
export function HandChoicePrompt() {
  const api = useGame();
  const { send, pending, error } = useIntentSender();
  const [picked, setPicked] = useState<string[]>([]);
  const choice = api.view.flow.pendingChoice;
  if (!choice || choice.kind !== 'HAND_CHOICE' || api.gameOver) return null;
  const cards = api.cards as CardDatabase;

  if (choice.player !== api.seat) {
    return (
      <div
        role="status"
        data-testid="hand-choice-waiting"
        className="pointer-events-none fixed inset-x-0 top-24 z-40 mx-auto w-fit max-w-md rounded-lg border border-slate-600 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-lg"
      >
        {choice.action === 'DISCARD' && choice.mode === 'SELF'
          ? 'Your opponent is choosing cards to discard.'
          : 'Your opponent is choosing a card from your revealed hand.'}
      </div>
    );
  }

  const legal = api.legal.filter((i): i is ChooseHandCardsIntent => i.type === 'CHOOSE_HAND_CARDS');
  const answer = legal.find(
    (i) => i.cardIds.length === picked.length && i.cardIds.every((id) => picked.includes(id)),
  );
  const verb = choice.action === 'DISCARD' ? 'discard' : 'recycle';
  const title =
    choice.mode === 'SELF'
      ? `Choose ${choice.count} card${choice.count === 1 ? '' : 's'} to discard`
      : `Choose ${choice.count} card from the opponent's hand to ${verb}`;
  const toggle = (id: string): void =>
    setPicked((cur) =>
      cur.includes(id)
        ? cur.filter((x) => x !== id)
        : cur.length < choice.count
          ? [...cur, id]
          : cur,
    );

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hand-choice-title"
        data-testid="hand-choice-prompt"
        className="w-full max-w-md rounded-xl border border-amber-400/60 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 id="hand-choice-title" className="text-lg font-semibold text-amber-200">
          {title}
        </h2>
        <ul className="mt-3 flex flex-col gap-2">
          {choice.options.map((o) => {
            const def = cards[o.cardId];
            const on = picked.includes(o.id);
            return (
              <li key={o.id}>
                <button
                  type="button"
                  data-testid="hand-choice-option"
                  aria-pressed={on}
                  onClick={() => toggle(o.id)}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-amber-300 ${
                    on ? 'border-amber-300 bg-amber-300/20' : 'border-slate-600 hover:bg-slate-800'
                  }`}
                >
                  <span className="font-semibold">{def?.name ?? 'A card'}</span>
                  <span className="ml-2 text-slate-400">
                    {def ? `${def.type.toLowerCase()}, ${def.cost.energy} energy` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          disabled={pending || !answer}
          data-testid="hand-choice-confirm"
          onClick={() => {
            if (!answer) return;
            void send(answer).then(() => setPicked([]));
          }}
          className="mt-4 rounded-md bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
        >
          {`Confirm (${picked.length}/${choice.count})`}
        </button>
        {error && (
          <p role="alert" className="mt-2 rounded border border-rose-700 bg-rose-950 p-2 text-sm">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
