import { costCardText, itemSourceId } from '@riftbound/engine';
import type {
  CardDatabase,
  ClientGameState,
  DecideOptionalIntent,
  OptionalCost,
  PaymentPlan,
} from '@riftbound/engine';
import { useGame } from '../app/gameApi';
import { useIntentSender } from './useIntentSender';
import { cardNameOf } from '../game/interaction';
import { CostCardPicker, costCandidates } from './CostCardPicker';

/** The card id behind an ability source: an object on the board, or a Battlefield card (R44). */
function sourceCardId(view: ClientGameState, id: string): string | undefined {
  const o = view.objects[id];
  if (o && 'cardId' in o) return o.cardId;
  return view.battlefields.find((b) => b.id === id)?.cardId;
}

/** "Pay 1 Energy and 1 Power (Fury)", "Burn 1 card"; "nothing" for a free "you may". */
export function describeOptionalCost(cost: OptionalCost, domains: readonly string[]): string {
  const parts: string[] = [];
  if (cost.energy) parts.push(`${cost.energy} Energy`);
  if (cost.power) {
    parts.push(`${cost.power} Power${domains.length > 0 ? ` (${domains.join(' or ')})` : ''}`);
  }
  if (cost.anyPower) parts.push(`${cost.anyPower} Power (any Domain)`);
  const pay = parts.length > 0 ? `Pay ${parts.join(' and ')}` : '';
  const burn = cost.burn
    ? `Burn ${cost.burn} card${cost.burn === 1 ? '' : 's'} (top of your Main Deck to your Trash)`
    : '';
  const card = cost.card ? costCardText(cost.card) : '';
  return [pay, burn, card].filter(Boolean).join(', ') || 'Free';
}

/** What the automatic payment plan will do to the player's runes. */
export function describePlan(plan: PaymentPlan | undefined): string {
  if (!plan || plan.length === 0) return 'Paid from your Rune Pool.';
  const ex = plan.filter((a) => a.mode === 'EXHAUST').length;
  const re = plan.filter((a) => a.mode === 'RECYCLE').length;
  const bits = [
    ex > 0 ? `exhausts ${ex} rune${ex === 1 ? '' : 's'}` : '',
    re > 0 ? `recycles ${re} rune${re === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `Payment ${bits.join(' and ')}.`;
}

/**
 * "You may [pay COST to] ..." (R45): shown while the engine is paused on an OPTIONAL_EFFECT choice.
 * The controller sees the card, what accepting costs and two buttons (the engine's own legal
 * DECIDE_OPTIONAL intents, so the payment plan is the engine's automatic one); the opponent sees a
 * waiting notice. A card-choice cost (R46: discard, kill, exhaust, return) adds a picker listing the
 * cards that may pay; the accept button is the picker's confirm and sends the chosen cards.
 */
export function OptionalPrompt() {
  const api = useGame();
  const { send, pending, error } = useIntentSender();
  const choice = api.view.flow.pendingChoice;
  if (!choice || choice.kind !== 'OPTIONAL_EFFECT' || api.gameOver) return null;

  const item = api.view.flow.chain.find((i) => i.id === choice.chainItemId);
  const sourceId = item ? itemSourceId(item) : '';
  const name = cardNameOf(sourceId, api.view, api.cards as CardDatabase);
  const def = api.cards[sourceCardId(api.view, sourceId) ?? ''];

  if (choice.player !== api.seat) {
    return (
      <div
        role="status"
        data-testid="optional-waiting"
        className="pointer-events-none fixed inset-x-0 top-24 z-40 mx-auto w-fit max-w-md rounded-lg border border-slate-600 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-lg"
      >
        {`Your opponent is deciding whether to use ${name}.`}
      </div>
    );
  }

  const answers = api.legal.filter((i) => i.type === 'DECIDE_OPTIONAL');
  const accept = answers.find((i) => i.type === 'DECIDE_OPTIONAL' && i.accept);
  const decline = answers.find((i) => i.type === 'DECIDE_OPTIONAL' && !i.accept);
  const costText = describeOptionalCost(choice.cost, def?.domains ?? []);
  const free = costText === 'Free';
  const cardCost = choice.cost.card;
  const candidates = cardCost
    ? costCandidates(api.view, api.cards as CardDatabase, api.seat, sourceId, cardCost)
    : [];
  /** The engine's own accept intent for exactly these cards, else the first one with the cards swapped in. */
  const acceptFor = (ids: string[]): DecideOptionalIntent | undefined => {
    const same = (a: readonly string[], b: readonly string[]): boolean =>
      a.length === b.length && a.every((x) => b.includes(x));
    const listed = answers.find(
      (i) => i.type === 'DECIDE_OPTIONAL' && i.accept && same(i.costCards ?? [], ids),
    );
    if (listed && listed.type === 'DECIDE_OPTIONAL') return listed;
    return accept && accept.type === 'DECIDE_OPTIONAL' ? { ...accept, costCards: ids } : undefined;
  };

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="optional-title"
        data-testid="optional-prompt"
        className="w-full max-w-md rounded-xl border border-amber-400/60 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 id="optional-title" className="text-lg font-semibold text-amber-200">
          {`${name}: use its optional effect?`}
        </h2>
        {def?.text ? (
          <p className="mt-1 text-sm whitespace-pre-line text-slate-300">{def.text}</p>
        ) : null}
        <p className="mt-3 text-sm" data-testid="optional-cost">
          <span className="font-semibold">{free ? 'No cost.' : `Cost: ${costText}.`}</span>{' '}
          {accept && accept.type === 'DECIDE_OPTIONAL' && !free ? (
            <span className="text-slate-300">{describePlan(accept.payment)}</span>
          ) : null}
        </p>
        {cardCost && accept ? (
          <CostCardPicker
            view={api.view}
            cards={api.cards as CardDatabase}
            cost={cardCost}
            candidates={candidates}
            confirmLabel="Pay and do it"
            busy={pending}
            onConfirm={(ids) => {
              const intent = acceptFor(ids);
              if (intent) void send(intent);
            }}
          />
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {cardCost ? null : (
            <button
              type="button"
              disabled={pending || !accept}
              data-testid="optional-accept"
              onClick={() => accept && void send(accept)}
              className="rounded-md bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
            >
              {free ? 'Yes, do it' : 'Pay and do it'}
            </button>
          )}
          <button
            type="button"
            disabled={pending || !decline}
            data-testid="optional-decline"
            onClick={() => decline && void send(decline)}
            className="rounded-md border border-slate-500 px-4 py-2 text-sm text-slate-100 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:opacity-50"
          >
            Decline (do nothing)
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
