import { useMemo, useState } from 'react';
import type { CardDatabase, ClientGameState, GameEvent, PlayerId } from '@riftbound/engine';
import { useGame } from '../app/gameApi';
import {
  TIER_LABEL,
  assignmentConstraintsFromView,
  autoAssignFromView,
  validateAssignment,
  type OrderedUnit,
  type ViewConstraints,
} from './combat/damage';
import { useIntentSender } from './useIntentSender';
import { battlefieldName, nameOf } from './viewObjects';

const who = (p: PlayerId | null | undefined, seat: PlayerId): string =>
  p == null ? 'nobody' : p === seat ? 'You' : 'Opponent';

const TIER_BADGE: Record<OrderedUnit['tier'], string> = {
  TANK: 'border-sky-500 bg-sky-500/15 text-sky-200',
  NORMAL: 'border-slate-600 bg-slate-800 text-slate-300',
  BACKLINE: 'border-violet-500 bg-violet-500/15 text-violet-200',
};

// ------------------------------------------------------------------ (a) showdown banner

function ShowdownBanner({
  view,
  cards,
  seat,
}: {
  view: ClientGameState;
  cards: CardDatabase;
  seat: PlayerId;
}) {
  const sd = view.flow.showdown;
  if (!sd) return null;
  const where = battlefieldName(view, cards, sd.battlefieldId);
  const roles =
    sd.attacker && sd.defender
      ? `: Attacker ${who(sd.attacker, seat)}, Defender ${who(sd.defender, seat)}`
      : '';
  const focus = view.flow.focus;
  return (
    <section
      aria-label="Showdown"
      data-testid="showdown-banner"
      className="pointer-events-none max-w-md rounded-lg border border-amber-400/70 bg-slate-900/95 px-4 py-2 text-center text-sm text-slate-100 shadow-lg"
    >
      <p className="font-semibold text-amber-200">
        {`Showdown at ${where}${roles}; Focus: ${focus ? who(focus, seat) : 'nobody'}`}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">
        {sd.isCombat ? 'Combat will follow. ' : ''}
        Only Action and Reaction cards may be played, and no Standard Moves. Each player passes in
        turn; two passes in a row end the Showdown (Rule 144).
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ (b) damage assignment

function DamageAssignment({
  constraints,
  where,
  seat,
}: {
  constraints: ViewConstraints;
  where: string;
  seat: PlayerId;
}) {
  const api = useGame();
  const { send, pending, error, clearError } = useIntentSender();
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const { total, ordered } = constraints;

  const assigned = ordered.reduce((n, u) => n + (amounts[u.unitId] ?? 0), 0);
  const check = validateAssignment(constraints, amounts);

  const setAmount = (unitId: string, amount: number): void => {
    clearError();
    setAmounts((cur) => ({ ...cur, [unitId]: Math.max(0, amount) }));
  };

  const auto = (): void => {
    clearError();
    const legal = api.legal.find((i) => i.type === 'ASSIGN_COMBAT_DAMAGE' && i.playerId === seat);
    if (legal && legal.type === 'ASSIGN_COMBAT_DAMAGE') {
      const next: Record<string, number> = {};
      for (const a of legal.assignments) next[a.unitId] = a.amount;
      setAmounts(next);
    } else {
      setAmounts(autoAssignFromView(constraints));
    }
  };

  const confirm = (): void => {
    if (!check.ok) return;
    void send({ type: 'ASSIGN_COMBAT_DAMAGE', playerId: seat, assignments: check.assignments });
  };

  const totalMismatch = assigned !== total;

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="damage-title"
        className="w-full max-w-lg rounded-xl border border-amber-400/60 bg-slate-900 p-5 text-slate-100 shadow-2xl"
      >
        <h2 id="damage-title" className="text-lg font-semibold text-amber-200">
          Assign combat damage
        </h2>
        <p className="mt-1 text-sm text-slate-300">
          {`Combat at ${where}. Your units deal `}
          <strong data-testid="damage-total">{total}</strong>
          {` damage in total. Tank units must take lethal damage first and Backline units last (a unit with both may go first or last).`}
        </p>

        <ul aria-label="Enemy units" className="mt-4 flex flex-col gap-2">
          {ordered.map((u, index) => {
            const amount = amounts[u.unitId] ?? 0;
            const lethalFill = Math.min(u.lethal, total - (assigned - amount));
            return (
              <li
                key={u.unitId}
                data-unit-id={u.unitId}
                className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2"
              >
                <span className="w-5 text-center text-xs text-slate-500">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{u.name}</span>
                    <span
                      className={`rounded border px-1.5 text-[10px] font-semibold uppercase ${TIER_BADGE[u.tier]}`}
                    >
                      {u.dual ? 'Tank or Backline' : TIER_LABEL[u.tier]}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    {`Might ${Math.max(0, u.might)}${u.damage > 0 ? `, ${u.damage} damage marked` : ''}; lethal needs ${u.lethal}`}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Remove damage from ${u.name} (${u.unitId})`}
                    disabled={amount <= 0 || pending}
                    onClick={() => setAmount(u.unitId, amount - 1)}
                    className="h-7 w-7 rounded border border-slate-600 bg-slate-700 text-lg leading-none hover:bg-slate-600 disabled:opacity-40"
                  >
                    -
                  </button>
                  <output
                    aria-label={`Damage to ${u.name} (${u.unitId})`}
                    className="w-8 text-center text-lg font-semibold tabular-nums"
                  >
                    {amount}
                  </output>
                  <button
                    type="button"
                    aria-label={`Add damage to ${u.name} (${u.unitId})`}
                    disabled={assigned >= total || pending}
                    onClick={() => setAmount(u.unitId, amount + 1)}
                    className="h-7 w-7 rounded border border-slate-600 bg-slate-700 text-lg leading-none hover:bg-slate-600 disabled:opacity-40"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label={`Lethal to ${u.name} (${u.unitId})`}
                    title="Assign exactly lethal damage (as much as remains to be assigned)"
                    disabled={u.lethal <= 0 || lethalFill <= 0 || pending}
                    onClick={() => setAmount(u.unitId, lethalFill)}
                    className="ml-1 rounded border border-rose-500/70 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20 disabled:opacity-40"
                  >
                    Lethal
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        <p aria-live="polite" data-testid="damage-status" className="mt-3 text-sm">
          <span className="font-semibold tabular-nums">{`${assigned} / ${total} assigned. `}</span>
          {!check.ok && (
            <span
              data-testid="damage-validation"
              className={totalMismatch ? 'text-amber-300' : 'text-rose-300'}
            >
              {check.message}
            </span>
          )}
        </p>
        {error && (
          <p role="alert" className="mt-2 rounded border border-rose-700 bg-rose-950 p-2 text-sm">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={auto}
            disabled={pending}
            title="Fill in the engine's default assignment: lethal in the required order"
            className="rounded-md border border-slate-500 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            Auto assign
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!check.ok || pending}
            className="rounded-md bg-amber-400 px-4 py-1.5 text-sm font-semibold text-slate-900 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ (c) result summary

export interface CombatSummary {
  /** Seq of the last COMBAT_DAMAGE_ASSIGNED event; identifies the combat. */
  key: number;
  lines: string[];
}

const DAMAGE_TYPES = new Set([
  'COMBAT_DAMAGE_ASSIGNED',
  'UNIT_KILLED',
  'POINT_GAINED',
  'BATTLEFIELD_CONTROL_CHANGED',
]);

/** Summarise the most recent combat in `events` (null if none dealt damage). */
export function summarizeCombat(
  events: GameEvent[],
  view: ClientGameState,
  cards: CardDatabase,
  seat: PlayerId,
): CombatSummary | null {
  let last = -1;
  events.forEach((e, i) => {
    if (e.type === 'COMBAT_DAMAGE_ASSIGNED') last = i;
  });
  if (last < 0) return null;
  let first = last;
  while (first > 0 && events[first - 1]?.type === 'COMBAT_DAMAGE_ASSIGNED') first--;

  const damage: string[] = [];
  const killed: string[] = [];
  const rest: string[] = [];
  for (const e of events.slice(first)) {
    if (!DAMAGE_TYPES.has(e.type)) continue;
    switch (e.type) {
      case 'COMBAT_DAMAGE_ASSIGNED':
        damage.push(
          `${who(e.player, seat)} dealt ${e.amount} damage to ${nameOf(view, cards, e.unitId)}`,
        );
        break;
      case 'UNIT_KILLED':
        killed.push(nameOf(view, cards, e.unitId));
        break;
      case 'POINT_GAINED':
        rest.push(
          `${who(e.player, seat)} gained ${e.amount} point${e.amount === 1 ? '' : 's'} (${e.source.toLowerCase()})`,
        );
        break;
      case 'BATTLEFIELD_CONTROL_CHANGED':
        rest.push(
          e.controller === null
            ? `${battlefieldName(view, cards, e.battlefieldId)} is now uncontrolled`
            : `${who(e.controller, seat)} now control${e.controller === seat ? '' : 's'} ${battlefieldName(view, cards, e.battlefieldId)}`,
        );
        break;
      default:
        break;
    }
  }
  const lines = [
    ...damage,
    ...(killed.length > 0 ? [`Killed: ${killed.join(', ')}`] : []),
    ...rest,
  ];
  const lastEvent = events[last];
  return { key: lastEvent ? lastEvent.seq : last, lines };
}

function ResultSummary({ summary, onDismiss }: { summary: CombatSummary; onDismiss: () => void }) {
  return (
    <section
      aria-label="Combat result"
      data-testid="combat-result"
      className="pointer-events-auto w-72 rounded-lg border border-slate-600 bg-slate-900/95 p-3 text-sm text-slate-100 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold text-amber-200">Combat result</h2>
        <button
          type="button"
          aria-label="Dismiss combat result"
          onClick={onDismiss}
          className="rounded px-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
        >
          x
        </button>
      </div>
      <ul className="mt-1 list-disc pl-4 text-slate-200">
        {summary.lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ root

/**
 * Showdown banner, combat damage assignment dialog and post-combat summary. Reads useGame().
 * The wrapper is pointer-events-none so it can sit over the playmat.
 */
export function CombatDialog() {
  const api = useGame();
  const { view, cards, seat, recentEvents } = api;
  const combat = view.flow.combat;
  const [dismissedKey, setDismissedKey] = useState<number | null>(null);

  const assigning = combat?.step === 'DAMAGE' && combat.awaitingAssignmentFrom === seat;
  const opponentAssigning =
    combat?.step === 'DAMAGE' &&
    combat.awaitingAssignmentFrom != null &&
    combat.awaitingAssignmentFrom !== seat;

  const constraints = useMemo(
    () => (assigning ? assignmentConstraintsFromView(view, cards, seat) : null),
    [assigning, view, cards, seat],
  );
  const summary = useMemo(
    () => (combat ? null : summarizeCombat(recentEvents, view, cards, seat)),
    [combat, recentEvents, view, cards, seat],
  );

  const showSummary = summary !== null && summary.key !== dismissedKey;
  const hasBanner = Boolean(view.flow.showdown);
  if (!hasBanner && !assigning && !opponentAssigning && !showSummary) return null;

  const where = combat ? battlefieldName(view, cards, combat.battlefieldId) : '';
  // Re-mount the form whenever the combat situation changes so stale inputs never leak across.
  const formKey = constraints
    ? `${combat?.battlefieldId}:${constraints.total}:${constraints.ordered.map((u) => `${u.unitId}/${u.lethal}`).join(',')}`
    : 'none';

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-40 flex flex-col items-center gap-2 px-4">
      {hasBanner && <ShowdownBanner view={view} cards={cards} seat={seat} />}
      {opponentAssigning && (
        <p
          role="status"
          className="pointer-events-auto rounded-lg border border-slate-600 bg-slate-900/95 px-4 py-2 text-sm text-slate-200 shadow-lg"
        >
          Opponent is assigning damage...
        </p>
      )}
      {assigning && constraints && (
        <DamageAssignment key={formKey} constraints={constraints} where={where} seat={seat} />
      )}
      {showSummary && summary && (
        <ResultSummary summary={summary} onDismiss={() => setDismissedKey(summary.key)} />
      )}
    </div>
  );
}
