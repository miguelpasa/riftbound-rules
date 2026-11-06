import { costCardText } from '@riftbound/engine';
import type { BoardUi } from '../game/useBoardUi';
import { cardNameOf } from '../game/interaction';
import { describeAbilityAt } from '../game/abilities';
import { CostCardPicker, costCandidates } from './CostCardPicker';

/**
 * R46: pick the cards that pay the card-choice cost of an activated ability ("Discard a gear, [1], [E]:
 * ...", "Recycle 3 from your trash: ..."). Opened by `ui.activateAbility`; confirming sends the
 * activation (after the targets, if the ability has any, are clicked on the board). Escape or Cancel
 * closes it without doing anything.
 */
export function AbilityCostPrompt({ ui }: { ui: BoardUi }) {
  const pick = ui.costPick;
  const { api } = ui;
  if (!pick || api.gameOver) return null;
  const name = cardNameOf(pick.sourceId, api.view, api.cards);
  const obj = api.view.objects[pick.sourceId];
  const def = obj && 'cardId' in obj ? api.cards[obj.cardId] : undefined;
  const desc = describeAbilityAt(def, pick.abilityIndex);
  const candidates = costCandidates(api.view, api.cards, api.seat, pick.sourceId, pick.cost);
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ability-cost-title"
        data-testid="ability-cost-prompt"
        className="w-full max-w-md rounded-xl border border-amber-400/60 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 id="ability-cost-title" className="text-lg font-semibold text-amber-200">
          {`${name}: pay the cost`}
        </h2>
        {desc ? <p className="mt-1 text-sm text-slate-300">{desc.summary}</p> : null}
        <p className="mt-2 text-sm" data-testid="ability-cost-text">
          {`Cost: ${costCardText(pick.cost)}.`}
        </p>
        {candidates.length === 0 ? (
          <p role="status" className="mt-3 text-sm text-slate-300">
            Nothing can pay this cost right now.
          </p>
        ) : (
          <CostCardPicker
            view={api.view}
            cards={api.cards}
            cost={pick.cost}
            candidates={candidates}
            confirmLabel="Activate"
            onConfirm={ui.confirmCostPick}
          />
        )}
        <div className="mt-4">
          <button
            type="button"
            data-testid="ability-cost-cancel"
            onClick={ui.cancelCostPick}
            className="rounded-md border border-slate-500 px-4 py-2 text-sm text-slate-100 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
