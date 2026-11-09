import { itemSourceId } from '@riftbound/engine';
import { cardNameOf, triggerDeclineIntent } from './interaction';
import type { BoardUi } from './useBoardUi';

/**
 * Prompt shown while a targeted spell, ability or triggered ability waits for its targets
 * (click-to-target). A trigger's choice is mandatory (no Cancel); the opponent of the chooser sees a
 * short waiting notice.
 */
export function TargetBanner({ ui }: { ui: BoardUi }) {
  const t = ui.targeting;
  const { api } = ui;
  const pc = api.view.flow.pendingChoice;
  if (!t && pc?.kind === 'TRIGGER_TARGET' && pc.player !== api.seat && !api.gameOver) {
    const item = api.view.flow.chain.find((i) => i.id === pc.chainItemId);
    const name = item ? cardNameOf(itemSourceId(item), api.view, api.cards) : 'a card';
    return (
      <section
        aria-label="Waiting for targets"
        className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm text-slate-200"
      >
        <p role="status" data-testid="trigger-waiting">
          {`Your opponent is choosing the targets of ${name}.`}
        </p>
      </section>
    );
  }
  if (!t && pc?.kind === 'TRIGGER_TARGET' && pc.player === api.seat && !api.gameOver) {
    // The board cannot drive this choice (e.g. a non-board target): offer every legal answer.
    const answers = api.legal.filter((i) => i.type === 'CHOOSE_TRIGGER_TARGET');
    return (
      <section
        aria-label="Targeting"
        className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-400 bg-rose-950/60 px-3 py-2 text-sm text-slate-100"
      >
        <p role="status" className="mr-auto font-semibold">
          Choose the targets of your triggered ability
        </p>
        {answers.map((a, k) => (
          <button
            key={k}
            type="button"
            onClick={() => void ui.submit(a)}
            className="rounded-md bg-amber-300 px-3 py-1 font-semibold text-slate-950"
          >
            {a.type === 'CHOOSE_TRIGGER_TARGET'
              ? a.targets
                  .map((x) =>
                    x.kind === 'object'
                      ? cardNameOf(x.id, api.view, api.cards)
                      : x.kind === 'battlefield'
                        ? x.battlefieldId === 'base'
                          ? 'the Base'
                          : (api.cards[
                              api.view.battlefields.find((b) => b.id === x.battlefieldId)?.cardId ??
                                ''
                            ]?.name ?? 'a battlefield')
                        : 'target',
                  )
                  .join(' + ') || 'Decline (do nothing)'
              : ''}
          </button>
        ))}
      </section>
    );
  }
  if (!t) return null;
  const declineIntent =
    t.source.kind === 'trigger' ? triggerDeclineIntent(api.legal, t.source.chainItemId) : undefined;
  return (
    <section
      aria-label="Targeting"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-400 bg-rose-950/60 px-3 py-2 text-sm text-slate-100"
    >
      <p role="status" className="mr-auto font-semibold">
        {`Choose target ${t.slot} of ${t.total}: ${t.cardName}`}
      </p>
      {t.confirmOptions.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={o.onSelect}
          className="rounded-md bg-amber-300 px-3 py-1 font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {o.label}
        </button>
      ))}
      {t.source.kind === 'trigger' && declineIntent ? (
        <button
          type="button"
          onClick={() => void ui.submit(declineIntent)}
          className="rounded-md border border-slate-500 px-3 py-1 text-slate-100 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          Decline (do nothing)
        </button>
      ) : null}
      {t.cancelable ? (
        <button
          type="button"
          onClick={ui.cancelTargeting}
          className="rounded-md border border-slate-500 px-3 py-1 text-slate-100 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          Cancel
        </button>
      ) : null}
    </section>
  );
}
