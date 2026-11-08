import type { CardDatabase, DecideReplacementIntent } from '@riftbound/engine';
import { useGame } from '../app/gameApi';
import { useIntentSender } from './useIntentSender';
import { cardNameOf } from '../game/interaction';
import { CostCardPicker, costCandidates } from './CostCardPicker';
import { describeOptionalCost, describePlan } from './OptionalPrompt';

/**
 * X7 (575): "If it would die, you may pay ... to recall it instead". Shown while the engine is paused on a
 * DEATH_REPLACE choice. The controller sees the unit, each way to save it with its cost, and a button to let
 * it die. Every button sends the engine's own legal DECIDE_REPLACEMENT intent, so the payment plan is the
 * engine's automatic one; a card-choice cost (Mordekaiser kills a friendly unit) adds a picker. The opponent
 * sees a waiting notice.
 */
export function DeathReplacePrompt() {
  const api = useGame();
  const { send, pending, error } = useIntentSender();
  const choice = api.view.flow.pendingChoice;
  if (!choice || choice.kind !== 'DEATH_REPLACE' || api.gameOver) return null;
  const cards = api.cards as CardDatabase;
  const unitName = cardNameOf(choice.unitId, api.view, cards);

  if (choice.player !== api.seat) {
    return (
      <div
        role="status"
        data-testid="death-replace-waiting"
        className="pointer-events-none fixed inset-x-0 top-24 z-40 mx-auto w-fit max-w-md rounded-lg border border-slate-600 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-lg"
      >
        {`Your opponent is deciding whether to save ${unitName} from dying.`}
      </div>
    );
  }

  const answers = api.legal.filter(
    (i): i is DecideReplacementIntent => i.type === 'DECIDE_REPLACEMENT',
  );
  const decline = answers.find((i) => !i.accept);
  const sameCards = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((x) => b.includes(x));

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="death-replace-title"
        data-testid="death-replace-prompt"
        className="w-full max-w-md rounded-xl border border-amber-400/60 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 id="death-replace-title" className="text-lg font-semibold text-amber-200">
          {`${unitName} would die: save it?`}
        </h2>
        <p className="mt-1 text-sm text-slate-300">
          Pay to heal it, exhaust it and send it to your Base instead.
        </p>
        {choice.offers.map((offer) => {
          const source = cardNameOf(offer.sourceId, api.view, cards);
          const def = cards[offer.cardId];
          const mine = answers.filter((i) => i.accept && i.sourceId === offer.sourceId);
          const first = mine[0];
          const extras = [
            offer.exhaustSource ? 'exhaust it' : '',
            offer.spendBuff ? 'spend the unit buff' : '',
          ].filter(Boolean);
          const cardCost = offer.cost.card;
          const costText = describeOptionalCost(offer.cost, def?.domains ?? []);
          return (
            <div
              key={offer.sourceId}
              data-testid="death-replace-offer"
              className="mt-3 rounded-lg border border-slate-700 p-3"
            >
              <p className="text-sm font-semibold">{source}</p>
              <p className="text-sm">
                {`Cost: ${costText}${extras.length > 0 ? `, ${extras.join(', ')}` : ''}.`}{' '}
                {first && costText !== 'Free' && !cardCost ? (
                  <span className="text-slate-300">{describePlan(first.payment)}</span>
                ) : null}
              </p>
              {cardCost ? (
                <CostCardPicker
                  view={api.view}
                  cards={cards}
                  cost={cardCost}
                  candidates={costCandidates(api.view, cards, api.seat, offer.sourceId, cardCost)}
                  confirmLabel="Pay and save it"
                  busy={pending}
                  onConfirm={(ids) => {
                    const listed = mine.find((i) => sameCards(i.costCards ?? [], ids));
                    const base = listed ?? (first ? { ...first, costCards: ids } : undefined);
                    if (base) void send(base);
                  }}
                />
              ) : (
                <button
                  type="button"
                  disabled={pending || !first}
                  data-testid="death-replace-accept"
                  onClick={() => first && void send(first)}
                  className="mt-2 rounded-md bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
                >
                  Pay and save it
                </button>
              )}
            </div>
          );
        })}
        <div className="mt-4">
          <button
            type="button"
            disabled={pending || !decline}
            data-testid="death-replace-decline"
            onClick={() => decline && void send(decline)}
            className="rounded-md border border-slate-500 px-4 py-2 text-sm text-slate-100 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:opacity-50"
          >
            Let it die
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 rounded border border-rose-700 bg-rose-950 p-2 text-sm">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
