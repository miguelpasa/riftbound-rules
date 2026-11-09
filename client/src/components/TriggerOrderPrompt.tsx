import type { CardDatabase, ChooseTriggerOrderIntent } from '@riftbound/engine';
import { itemSourceId } from '@riftbound/engine';
import { useGame } from '../app/gameApi';
import { useIntentSender } from './useIntentSender';
import { cardNameOf } from '../game/interaction';

/**
 * X6 (583.3.b): the controller of several simultaneous triggered abilities chooses the order. One button per
 * order (the engine's own legal CHOOSE_TRIGGER_ORDER intents), worded "first to resolve, then ...". The
 * opponent sees a waiting notice.
 */
export function TriggerOrderPrompt() {
  const api = useGame();
  const { send, pending, error } = useIntentSender();
  const choice = api.view.flow.pendingChoice;
  if (!choice || choice.kind !== 'TRIGGER_ORDER' || api.gameOver) return null;
  const cards = api.cards as CardDatabase;
  const nameOf = (chainItemId: string): string => {
    const item = api.view.flow.chain.find((i) => i.id === chainItemId);
    return item ? cardNameOf(itemSourceId(item), api.view, cards) : 'an ability';
  };

  if (choice.player !== api.seat) {
    return (
      <div
        role="status"
        data-testid="trigger-order-waiting"
        className="pointer-events-none fixed inset-x-0 top-24 z-40 mx-auto w-fit max-w-md rounded-lg border border-slate-600 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-lg"
      >
        Your opponent is ordering their triggered abilities.
      </div>
    );
  }

  const orders = api.legal.filter(
    (i): i is ChooseTriggerOrderIntent => i.type === 'CHOOSE_TRIGGER_ORDER',
  );
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="trigger-order-title"
        data-testid="trigger-order-prompt"
        className="w-full max-w-md rounded-xl border border-amber-400/60 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 id="trigger-order-title" className="text-lg font-semibold text-amber-200">
          Several abilities triggered: choose the order
        </h2>
        <p className="mt-1 text-sm text-slate-300">The first one listed resolves first.</p>
        <div className="mt-3 flex flex-col gap-2">
          {orders.map((o) => (
            <button
              key={o.order.join(',')}
              type="button"
              disabled={pending}
              data-testid="trigger-order-option"
              onClick={() => void send(o)}
              className="rounded-md border border-slate-500 px-3 py-2 text-left text-sm hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:opacity-50"
            >
              {o.order.map(nameOf).join(', then ')}
            </button>
          ))}
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
