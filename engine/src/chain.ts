/**
 * Chain, turn states, Priority and Focus (Core Rules 307-313, 325-340, 346).
 *
 * All exported functions are pure: they structuredClone the input, mutate the clone and return it.
 * Isomorphic: no Node/DOM APIs.
 *
 * Design notes (readings of the rules; see also docs/ASSUMPTIONS.md):
 *  - Turn state (307-310) is derived: kind = SHOWDOWN if a Showdown/Combat is in progress (308.1)
 *    else NEUTRAL; open = chain empty (309.1: Closed iff a Chain exists).
 *  - Priority on finalize (312.2.c / 312.2.d): when an item is FINALIZED, the NEXT player in turn
 *    order after the item's controller receives Priority (2 players: the opponent of the controller).
 *  - Pass counting: FlowState has no pass counter for the Chain, so the number of consecutive passes
 *    is DERIVED from who holds Priority relative to the newest item's controller. Priority always
 *    starts with nextPlayerInTurnOrder(top.controller) (0 passes); after that player passes it
 *    rotates to the controller (1 pass); when the last player passes (passes == players) the chain
 *    resolves (339.1). Playing a new item puts a new controller on top, so the count resets
 *    automatically (339.2). Pass counting for an EMPTY chain inside a Showdown uses
 *    `showdown.passesInRow`.
 *  - After the newest item resolves (340.1) with items remaining, Priority is re-seeded to
 *    nextPlayerInTurnOrder(newTop.controller) with 0 passes. With an empty chain: Neutral -> Priority
 *    returns to the turn player (335/340.2); Showdown -> Focus (and Priority) pass to the next
 *    player after the Focus holder (340.2.a).
 *  - ChainItem has no "triggered / Add ability" marker, so the 340.2.a / 346.1 exemption is not
 *    modelled: every emptied Showdown chain passes Focus.
 *  - PASS_PRIORITY in Neutral Open with an empty chain is an ERROR (WRONG_PHASE, "use END_TURN"):
 *    there is nothing to pass to.
 */
import { cloneState, fork } from './workingCopy.js';
import { opponentOf, ruleError } from './types/index.js';
import type {
  CardDatabase,
  CardDef,
  ChainItem,
  GameEvent,
  GameEventInput,
  GameState,
  KeywordName,
  PassPriorityIntent,
  PlayerId,
  ReduceResult,
  RuleError,
  TurnState,
} from './types/index.js';

/** Result of resolving one chain item. Events are stamped with `seq` by this module. */
export interface ChainResolution {
  state: GameState;
  events: GameEventInput[];
}

/** Injected effect resolver (E5 supplies the real one). Receives a state with `item` already removed from the chain. */
export type ChainResolver = (
  state: GameState,
  item: ChainItem,
  cards: CardDatabase,
) => ChainResolution;

export interface PlayTimingOpts {
  /** Timing check is for an activated/triggered ability rather than a card. */
  isAbility?: boolean;
  /** The ability has Reaction speed (only meaningful with isAbility). */
  isReactionAbility?: boolean;
  /**
   * Rune abilities (ACTIVATE_RUNE) are Reaction-speed and need no Priority (handled by E2):
   * skips Priority/phase/state checks entirely.
   */
  isRuneAbility?: boolean;
  /**
   * Ambush (822): the card is a Unit played to a battlefield where its controller has units, which
   * gives it Reaction speed for this play.
   */
  ambush?: boolean;
}

/** Convenience opts for ACTIVATE_RUNE callers. */
export const RUNE_ABILITY_OPTS: Readonly<PlayTimingOpts> = Object.freeze({ isRuneAbility: true });

// ---------------------------------------------------------------- helpers

function stamp(state: GameState, inputs: GameEventInput[]): GameEvent[] {
  return inputs.map((e) => ({ ...e, seq: state.nextEventSeq++ }) as GameEvent);
}

function hasKeyword(card: CardDef, name: KeywordName): boolean {
  return card.keywords.some((k) => k.name === name);
}

/** Players in priority order starting from `from` (default: the turn player). 2-player Duel. */
export function getPriorityOrder(state: GameState, from?: PlayerId): PlayerId[] {
  const first = from ?? state.turn.activePlayer;
  return [first, opponentOf(first)];
}

/** Next player in turn order after `p` (Duel: the opponent). */
export function nextPlayerInTurnOrder(p: PlayerId): PlayerId {
  return opponentOf(p);
}

// ---------------------------------------------------------------- turn state

/** Derive Neutral/Showdown x Open/Closed from flow (307-310). Does not read state.turnState. */
export function deriveTurnState(state: GameState): TurnState {
  const showdown = state.flow.showdown !== undefined || state.flow.combat !== undefined;
  return { kind: showdown ? 'SHOWDOWN' : 'NEUTRAL', open: state.flow.chain.length === 0 };
}

export function getTurnStateKind(state: GameState): TurnState['kind'] {
  return deriveTurnState(state).kind;
}

function syncInPlace(state: GameState): void {
  state.turnState = deriveTurnState(state);
}

/** Returns a copy with `turnState` recomputed from the chain and Showdown presence. */
export function syncTurnState(state: GameState): GameState {
  const next = fork(state);
  syncInPlace(next);
  return next;
}

// ---------------------------------------------------------------- timing legality

const OK = { ok: true } as const;

/**
 * Pure timing legality for playing a card / activating an ability (144, 145, 155, 308-313).
 * Check order: game over, rune bypass, Priority (312.1), Closed (309.1.a), Showdown (308.1.a),
 * Neutral Open phase/turn.
 */
export function canPlayNow(
  state: GameState,
  _cards: CardDatabase,
  playerId: PlayerId,
  card: CardDef,
  opts: PlayTimingOpts = {},
): { ok: true } | RuleError {
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  if (opts.isRuneAbility) return OK;
  if (state.flow.priority !== playerId) {
    return ruleError('NOT_YOUR_PRIORITY', `priority: ${state.flow.priority ?? 'none'}`);
  }
  const isAbility = opts.isAbility === true;
  // R83: "can't play cards / spells this turn" (abilities are not cards).
  const lock = state.players[playerId === 'p0' ? 0 : 1]?.playLock;
  if (!isAbility && lock && lock.turn === state.turn.number) {
    if (lock.what === 'CARDS' || card.type === 'SPELL') {
      return ruleError('KEYWORD_RESTRICTION', 'you cannot play that this turn');
    }
  }
  const reaction = isAbility
    ? opts.isReactionAbility === true
    : hasKeyword(card, 'Reaction') || hasKeyword(card, 'QuickDraw') || opts.ambush === true; // 819: Quick-Draw has Reaction inherently; 822 Ambush
  const action = !isAbility && hasKeyword(card, 'Action');
  const ts = deriveTurnState(state);

  if (!ts.open) return reaction ? OK : ruleError('CLOSED_STATE_REACTION_ONLY');
  if (reaction) return OK;
  if (ts.kind === 'SHOWDOWN') {
    if (action) return OK;
    return isAbility
      ? ruleError('ABILITY_NOT_AVAILABLE', 'activated abilities are not usable during a Showdown')
      : ruleError('WRONG_PHASE', 'Showdown State: only Action or Reaction cards (Rule 308.1.a)');
  }
  // Neutral Open
  if (state.turn.phase !== 'MAIN') return ruleError('WRONG_PHASE', `phase ${state.turn.phase}`);
  if (state.turn.activePlayer !== playerId) return ruleError('NOT_YOUR_TURN');
  return OK;
}

// ---------------------------------------------------------------- chain manipulation

/** Place a PENDING item on top of the Chain (329, 330.2); the state becomes Closed (354.1). */
export function pushPendingItem(state: GameState, item: ChainItem): GameState {
  const next = fork(state);
  next.flow.chain.push({ ...cloneState(item), status: 'PENDING' });
  if (next.flow.showdown) next.flow.showdown.passesInRow = 0;
  syncInPlace(next);
  return next;
}

/**
 * PENDING -> FINALIZED (329). Priority goes to the next player in turn order after the item's
 * controller (312.2.c/d). Throws on an unknown id (programmer error).
 */
export function finalizeItem(state: GameState, itemId: string): GameState {
  const next = fork(state);
  const item = next.flow.chain.find((i) => i.id === itemId);
  if (!item) throw new Error(`finalizeItem: unknown chain item ${itemId}`);
  item.status = 'FINALIZED';
  next.flow.priority = nextPlayerInTurnOrder(item.controller);
  if (next.flow.showdown) next.flow.showdown.passesInRow = 0;
  syncInPlace(next);
  return next;
}

/** True if the item resolves immediately upon finalization (337.2): Units and Gear. */
export function isImmediateItem(item: ChainItem, state: GameState, cards: CardDatabase): boolean {
  if (item.kind !== 'CARD') return false;
  const obj = state.objects[item.sourceObjectId];
  const def = obj ? cards[obj.cardId] : undefined;
  return def !== undefined && (def.type === 'UNIT' || def.type === 'GEAR');
}

/**
 * Resolve the newest item, then re-seed Priority/Focus (340). `state` must already be a clone.
 * Exported for DECIDE_OPTIONAL (R45), which resolves the optional ability it was asked about.
 */
export function resolveTop(
  state: GameState,
  cards: CardDatabase,
  resolver: ChainResolver,
  events: GameEvent[],
): GameState {
  const top = state.flow.chain[state.flow.chain.length - 1];
  if (!top || top.status !== 'FINALIZED') throw new Error('resolveTop: no finalized item on top');
  state.flow.chain.pop();
  const res = resolver(state, top, cards);
  const s = fork(res.state);
  events.push(...stamp(s, res.events));
  // R45: an optional ability the resolver put back on the Chain (it waits for DECIDE_OPTIONAL) has not resolved yet.
  const suspended =
    s.flow.pendingChoice?.kind === 'OPTIONAL_EFFECT' && s.flow.chain.some((i) => i.id === top.id);
  if (!suspended) events.push(...stamp(s, [{ type: 'CHAIN_ITEM_RESOLVED', chainItemId: top.id }]));
  syncInPlace(s);

  const remaining = s.flow.chain;
  if (remaining.length > 0) {
    s.flow.priority = nextPlayerInTurnOrder(remaining[remaining.length - 1]!.controller);
  } else if (s.turnState.kind === 'SHOWDOWN') {
    // 340.2.a: Focus passes to the next player after the last item resolves.
    const next = s.flow.focus ? nextPlayerInTurnOrder(s.flow.focus) : s.turn.activePlayer;
    s.flow.focus = next;
    s.flow.priority = next;
    if (s.flow.showdown) s.flow.showdown.passesInRow = 0;
  } else {
    // 335 / 340.2: Open again; Priority returns to the turn player.
    s.flow.priority = s.turn.activePlayer;
  }
  return s;
}

/**
 * Default effect resolver: SPELL cards go to their owner's trash; unimplemented effects emit
 * EFFECT_UNIMPLEMENTED; Units/Gear are left alone (E5 places them).
 */
export const defaultResolver: ChainResolver = (state, item, cards) => {
  const s = fork(state);
  const events: GameEventInput[] = [];
  const obj = s.objects[item.sourceObjectId];
  const def = obj ? cards[obj.cardId] : undefined;
  if (item.unimplementedEffect && obj) {
    events.push({ type: 'EFFECT_UNIMPLEMENTED', cardId: obj.cardId });
  }
  if (item.kind === 'CARD' && obj && def?.type === 'SPELL') {
    const owner = s.players[obj.owner === 'p0' ? 0 : 1];
    owner.hand = owner.hand.filter((id) => id !== obj.id);
    if (!owner.trash.includes(obj.id)) owner.trash.push(obj.id);
    obj.zone = { kind: 'trash', player: obj.owner };
  }
  return { state: s, events };
};

/**
 * Finalize an item and, for Units/Gear (337.2), resolve it immediately. Emits CHAIN_ITEM_ADDED.
 */
export function finalizeAndSettle(
  state: GameState,
  cards: CardDatabase,
  itemId: string,
  resolver: ChainResolver = defaultResolver,
): ReduceResult {
  const item = state.flow.chain.find((i) => i.id === itemId);
  if (!item) return ruleError('NOT_FOUND', `chain item ${itemId}`);
  if (item.status !== 'PENDING') {
    return ruleError('NOT_FOUND', `chain item ${itemId} is not pending`);
  }
  let next = finalizeItem(state, itemId);
  const events = stamp(next, [
    { type: 'CHAIN_ITEM_ADDED', chainItemId: itemId, controller: item.controller },
  ]);
  if (isImmediateItem(item, next, cards)) next = resolveTop(next, cards, resolver, events);
  return { ok: true, state: next, events };
}

/**
 * PASS_PRIORITY (338-340). Chain non-empty: if everyone has passed in sequence the newest
 * FINALIZED item resolves (339.1, 340.1); otherwise Priority moves on (339.2).
 * Empty chain: Showdown -> Focus/Priority rotate (313.3, `showdown.passesInRow` counts; ending the
 * Showdown is the caller's job when it reaches 2); Neutral Open -> error (use END_TURN).
 */
export function passPriority(
  state: GameState,
  cards: CardDatabase,
  intent: PassPriorityIntent,
  resolver: ChainResolver = defaultResolver,
): ReduceResult {
  if (state.gameStatus !== 'IN_PROGRESS') return ruleError('GAME_OVER');
  if (state.flow.priority !== intent.playerId) {
    return ruleError('NOT_YOUR_PRIORITY', `priority: ${state.flow.priority ?? 'none'}`);
  }
  const next = fork(state);
  const chain = next.flow.chain;

  if (chain.length === 0) {
    if (!next.flow.showdown) {
      return ruleError('WRONG_PHASE', 'nothing to pass in a Neutral Open state; use END_TURN');
    }
    const other = nextPlayerInTurnOrder(intent.playerId);
    next.flow.showdown.passesInRow += 1;
    next.flow.priority = other;
    if (next.flow.focus) next.flow.focus = other; // passing keeps Focus in the cycle (313.3)
    return { ok: true, state: next, events: [] };
  }

  const top = chain[chain.length - 1]!;
  if (chain.some((i) => i.status === 'PENDING')) {
    return ruleError('NOT_YOUR_PRIORITY', 'a chain item is still pending');
  }
  const passesSoFar = intent.playerId === nextPlayerInTurnOrder(top.controller) ? 0 : 1;
  if (passesSoFar + 1 >= getPriorityOrder(next).length) {
    const events: GameEvent[] = [];
    const resolved = resolveTop(next, cards, resolver, events);
    return { ok: true, state: resolved, events };
  }
  next.flow.priority = nextPlayerInTurnOrder(intent.playerId);
  return { ok: true, state: next, events: [] };
}
