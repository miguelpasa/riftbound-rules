/**
 * Host-side game timers: maps the authoritative engine state to a `TimerSituation`, and a fired
 * timeout to the intent the policy prescribes (host-forced for that seat).
 *
 *   REACTION   -> PASS_PRIORITY      MULLIGAN   -> keep hand (MULLIGAN with no cards)
 *   TURN       -> END_TURN           ASSIGNMENT -> engine `autoAssign`
 *
 * Only HUMAN seats are ever timed: when the player the game waits for is the bot, nothing is armed.
 * The multiplayer default is the 30 s reaction window with no turn clock.
 */
import { actorToAct, autoAssign } from '@riftbound/engine';
import type { CardDatabase, GameState, Intent, PlayerId } from '@riftbound/engine';
import type { HostSession } from '../host/hostSession';
import { TurnTimer, type TimeoutInfo, type TimerClock, type TimerSituation } from '../host/timers';
import type { HostBridge } from './adapters';

export function timerSituation(state: GameState): TimerSituation {
  const mulliganPlayer =
    state.mulligan && state.turn.phase === 'MULLIGAN'
      ? (state.mulligan.order[state.mulligan.current] ?? null)
      : null;
  return {
    actor: actorToAct(state),
    phase: state.turn.phase,
    chainLength: state.flow.chain.length,
    showdown: state.flow.showdown !== undefined || state.flow.pendingChoice !== undefined,
    combatAwaiting: state.flow.combat?.awaitingAssignmentFrom ?? null,
    mulliganPlayer,
    gameOver: state.gameStatus !== 'IN_PROGRESS',
    revision: state.nextEventSeq,
  };
}

/** The seat a situation is waiting for (the one that would be timed). */
export function timedSeat(s: TimerSituation): PlayerId {
  return s.mulliganPlayer ?? s.combatAwaiting ?? s.actor;
}

/** The intent that applying the timeout policy yields, or null when none can be built. */
export function timeoutIntent(
  info: TimeoutInfo,
  state: GameState,
  cards: CardDatabase,
): Intent | null {
  const playerId = info.player;
  switch (info.kind) {
    case 'REACTION':
      return { type: 'PASS_PRIORITY', playerId };
    case 'TURN':
      return { type: 'END_TURN', playerId };
    case 'MULLIGAN':
      return { type: 'MULLIGAN', playerId, cardIds: [] };
    case 'ASSIGNMENT': {
      try {
        return {
          type: 'ASSIGN_COMBAT_DAMAGE',
          playerId,
          assignments: autoAssign(state, cards, playerId),
        };
      } catch {
        return null;
      }
    }
  }
}

export interface TimerPublish {
  /** Epoch ms when the armed timer fires, or null when nothing is armed. */
  deadline: number | null;
  kind: TimeoutInfo['kind'] | null;
  player: PlayerId | null;
}

export interface HostTimersOptions {
  session: HostSession;
  cards: CardDatabase;
  bridge: HostBridge;
  /** Seats that are people (never the bot). */
  humanSeats: PlayerId[];
  reactionWindowMs?: number;
  mulliganMs?: number;
  assignmentMs?: number;
  /** Optional per-turn clock; null/omitted = none. */
  turnMs?: number | null;
  clock?: Partial<TimerClock>;
  onPublish?: (p: TimerPublish) => void;
}

export class HostTimers {
  private readonly timer: TurnTimer;
  private readonly off: () => void;
  private disposed = false;

  constructor(private readonly o: HostTimersOptions) {
    this.timer = new TurnTimer({
      onTimeout: (info) => this.timedOut(info),
      ...(o.reactionWindowMs !== undefined ? { reactionWindowMs: o.reactionWindowMs } : {}),
      ...(o.mulliganMs !== undefined ? { mulliganMs: o.mulliganMs } : {}),
      ...(o.assignmentMs !== undefined ? { assignmentMs: o.assignmentMs } : {}),
      ...(o.turnMs !== undefined ? { turnMs: o.turnMs } : {}),
      ...(o.clock ? { clock: o.clock } : {}),
    });
    this.off = o.bridge.onUpdate(() => this.sync());
    this.sync();
  }

  /** Re-evaluate against the session's current state (also called after every commit). */
  sync(): void {
    if (this.disposed) return;
    const s = timerSituation(this.o.session.getFullStateForPersistence());
    const human = this.o.humanSeats.includes(timedSeat(s));
    this.timer.sync(human ? s : { ...s, gameOver: true });
    const remaining = this.timer.remainingMs();
    const cur = this.timer.current();
    const now = this.o.clock?.now ?? (() => Date.now());
    this.o.onPublish?.({
      deadline: remaining === null ? null : now() + remaining,
      kind: cur?.kind ?? null,
      player: cur?.player ?? null,
    });
  }

  private timedOut(info: TimeoutInfo): void {
    if (this.disposed) return;
    const session = this.o.session;
    const state = session.getFullStateForPersistence();
    const intent = timeoutIntent(info, state, this.o.cards);
    let res = intent ? session.forceIntent(info.player, intent) : null;
    if (!res || !res.ok) {
      const legal = session.getLegal(info.player);
      // R42 / R45: an optional ("you may" / "you may pay") ability is declined on timeout (never
      // pay on the player's behalf); otherwise the lowest index.
      const decline = legal.find(
        (i) =>
          (i.type === 'CHOOSE_TRIGGER_TARGET' && i.targets.length === 0) ||
          (i.type === 'DECIDE_OPTIONAL' && !i.accept) ||
          (i.type === 'DECIDE_REPLACEMENT' && !i.accept),
      );
      const fb =
        decline ??
        legal.find(
          (i) =>
            i.type === 'CHOOSE_STAGED' ||
            i.type === 'CHOOSE_TRIGGER_TARGET' ||
            i.type === 'CHOOSE_TRIGGER_ORDER' ||
            i.type === 'CHOOSE_HAND_CARDS',
        ) ?? // lowest index (R11 / R41 timeout default)
        legal.find((i) => i.type === 'PASS_PRIORITY' || i.type === 'END_TURN') ??
        legal.find((i) => i.type === 'MULLIGAN' && i.cardIds.length === 0) ??
        // R77: a mandatory cost has no decline: the first listed answer (the lowest cards) is used.
        legal.find((i) => i.type === 'DECIDE_OPTIONAL');
      res = fb ? session.forceIntent(info.player, fb) : res;
    }
    if (!res || !res.ok) console.warn('[timers] could not apply timeout policy', info, res);
  }

  dispose(): void {
    this.disposed = true;
    this.off();
    this.timer.dispose();
    this.o.onPublish?.({ deadline: null, kind: null, player: null });
  }
}
