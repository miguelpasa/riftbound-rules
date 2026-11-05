import type { PlayerId } from '@riftbound/engine';
import { useGame } from '../app/gameApi';
import { useIntentSender } from './useIntentSender';
import { battlefieldName } from './viewObjects';

/**
 * "Choose which battlefield resolves first" (Rules 323.11, 323.12, 463.1): shown to the turn player
 * only while the engine is paused on flow.pendingChoice. One button per staged battlefield; the other
 * player sees a short waiting notice (not interactive).
 */
export function ChoicePrompt() {
  const api = useGame();
  const { send, pending, error } = useIntentSender();
  const choice = api.view.flow.pendingChoice;
  if (!choice || api.gameOver) return null;

  const seat: PlayerId = api.seat;
  const noun = choice.stage === 'SHOWDOWN' ? 'Showdown' : 'Combat';

  if (choice.player !== seat) {
    return (
      <div
        role="status"
        data-testid="choice-waiting"
        className="pointer-events-none fixed inset-x-0 top-24 z-40 mx-auto w-fit max-w-md rounded-lg border border-slate-600 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-lg"
      >
        {`Waiting for your opponent to choose which battlefield's ${noun} begins first.`}
      </div>
    );
  }

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="choice-title"
        data-testid="choice-prompt"
        className="w-full max-w-md rounded-xl border border-amber-400/60 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 id="choice-title" className="text-lg font-semibold text-amber-200">
          Choose which battlefield resolves first
        </h2>
        <p className="mt-1 text-sm text-slate-300">
          {`Several ${noun}s are waiting. As the turn player you pick which one begins first (Rule ${
            choice.stage === 'SHOWDOWN' ? '323.11' : '323.12'
          }).`}
        </p>
        <ul aria-label="Battlefield options" className="mt-4 flex flex-col gap-2">
          {choice.options.map((id) => {
            const name = battlefieldName(api.view, api.cards, id);
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={pending}
                  data-battlefield-id={id}
                  aria-label={`Resolve ${name} first`}
                  onClick={() =>
                    void send({ type: 'CHOOSE_STAGED', playerId: seat, battlefieldId: id })
                  }
                  className="w-full rounded-md border border-amber-400/70 bg-slate-800 px-4 py-2 text-left text-sm font-semibold hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:opacity-50"
                >
                  {name}
                </button>
              </li>
            );
          })}
        </ul>
        {error && (
          <p role="alert" className="mt-2 rounded border border-rose-700 bg-rose-950 p-2 text-sm">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
