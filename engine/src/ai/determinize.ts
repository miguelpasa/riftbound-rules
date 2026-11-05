/**
 * Determinization: turn a sanitized ClientGameState (what the bot is allowed to see) into a full,
 * playable GameState by filling every hidden object with a plausible card.
 *
 * MIRROR ASSUMPTION: the bot does not know the opponent's decklist. Unless the caller passes an
 * `opponentMainPool`, the opponent is assumed to play the SAME cards as the bot (`ownDeck`), minus
 * the opponent cards already visible on the table (units, gear, trash, ...). This is only a prior
 * used to fill the opponent's hand, deck, rune deck and facedown cards; it can be wrong, and the
 * bot never relies on the filled values being exact.
 *
 * Hidden information handling:
 *  - the bot's own hand is visible (real ids). Its own main/rune deck ORDER is secret even to the
 *    bot, so the deck is re-created as `ownDeck` minus every own card visible elsewhere, shuffled.
 *  - the opponent's hand / decks / facedown cards come from the pool, shuffled with the bot's PRNG.
 *  - ids: visible objects keep their real ids; hidden `hidden:<owner>:<zone>:<i>` tokens get invented
 *    ids `o<N>` above every visible id, assigned in a deterministic token order.
 *  - the returned state's `rng` / `seed` derive from the bot's seed, NEVER from the game's seed.
 */
import { randomInt, seedRng, shuffle } from '../rng.js';
import { isHiddenCard, opponentOf } from '../types/index.js';
import type {
  CardDatabase,
  CardInstance,
  ClientGameState,
  DeckList,
  FlowState,
  GameState,
  PlayerId,
  PlayerState,
  RngState,
} from '../types/index.js';

export interface DeterminizeOptions {
  /** Cards (with repeats) the opponent's main deck may contain. Default: mirror of `ownDeck`. */
  opponentMainPool?: string[];
  /** Opponent rune cards. Default: mirror of `ownDeck.runeDeck`. */
  opponentRunePool?: string[];
}

const NON_POOL_TYPES = new Set(['RUNE', 'LEGEND', 'BATTLEFIELD', 'TOKEN']);

/** Small stateful wrapper over the pure PRNG helpers (the bot's own PRNG, never the game's). */
class BotRng {
  private r: RngState;
  constructor(seed: string) {
    this.r = seedRng(seed);
  }
  shuffle<T>(arr: readonly T[]): T[] {
    const [out, next] = shuffle(arr, this.r);
    this.r = next;
    return out;
  }
  int(n: number): number {
    const [v, next] = randomInt(this.r, n);
    this.r = next;
    return v;
  }
}

/** Remove one occurrence of `id` from `pool` if present. */
function takeOne(pool: string[], id: string): void {
  const i = pool.indexOf(id);
  if (i >= 0) pool.splice(i, 1);
}

/**
 * `count` cards: from the (already shuffled) remaining pool, topped up by sampling the full pool
 * with replacement when the visible-card subtraction left too few (the prior was wrong).
 */
function fill(rng: BotRng, remaining: string[], full: string[], count: number): string[] {
  const out = remaining.splice(0, count);
  while (out.length < count && full.length > 0) out.push(full[rng.int(full.length)] as string);
  return out;
}

interface Slot {
  token: string;
  id: string;
}

export function determinize(
  view: ClientGameState,
  cards: CardDatabase,
  ownDeck: DeckList,
  seed: string,
  opts: DeterminizeOptions = {},
): GameState {
  const me = view.viewer;
  const opp = opponentOf(me);
  const rng = new BotRng(`${seed}/fill`);

  // ---- visible objects (real ids)
  const objects: Record<string, CardInstance> = {};
  let maxNum = 0;
  for (const [id, o] of Object.entries(view.objects)) {
    if (isHiddenCard(o)) continue;
    objects[id] = structuredClone(o);
    const n = Number(id.slice(1));
    if (/^o\d+$/.test(id) && n > maxNum) maxNum = n;
  }
  // Chain item ids come from the same counter as object ids; never reuse them for invented ids.
  for (const item of view.flow.chain) {
    const n = Number(item.id.slice(1));
    if (/^o\d+$/.test(item.id) && n > maxNum) maxNum = n;
  }
  let nextNum = maxNum + 1;

  // ---- hidden tokens -> invented ids, in a deterministic order
  const tokenIds = new Map<string, string>();
  const claim = (token: string): Slot => {
    let id = tokenIds.get(token);
    if (id === undefined) {
      id = `o${nextNum++}`;
      tokenIds.set(token, id);
    }
    return { token, id };
  };
  const isTok = (id: string): boolean => id.startsWith('hidden:');
  const mapId = (id: string): string => (isTok(id) ? claim(id).id : id);

  const slots: Record<PlayerId, { hand: Slot[]; mainDeck: Slot[]; runeDeck: Slot[] }> = {
    p0: { hand: [], mainDeck: [], runeDeck: [] },
    p1: { hand: [], mainDeck: [], runeDeck: [] },
  };
  for (const p of view.players) {
    if (p.id !== me) slots[p.id].hand = p.hand.map(claim);
    slots[p.id].mainDeck = p.mainDeck.map(claim);
    slots[p.id].runeDeck = p.runeDeck.map(claim);
  }
  const facedown: { slot: Slot; battlefieldId: string; owner: PlayerId }[] = [];
  for (const bf of view.battlefields) {
    if (bf.facedownSlotId !== null && isTok(bf.facedownSlotId)) {
      facedown.push({
        slot: claim(bf.facedownSlotId),
        battlefieldId: bf.id,
        owner: (bf.facedownSlotId.split(':')[1] as PlayerId | undefined) ?? opp,
      });
    }
  }

  // ---- pools
  const visibleOf = (owner: PlayerId): CardInstance[] =>
    Object.values(objects).filter(
      (o) => o.owner === owner && !NON_POOL_TYPES.has(cards[o.cardId]?.type ?? ''),
    );
  const visibleRunes = (owner: PlayerId): CardInstance[] =>
    Object.values(objects).filter((o) => o.owner === owner && cards[o.cardId]?.type === 'RUNE');

  // The champion is created in the champion zone, not the main deck; treat it as one more card of
  // the pool so that its (always visible) object is subtracted like any other.
  const ownMainFull = [...ownDeck.mainDeck, ownDeck.championId];
  const oppMainFull = opts.opponentMainPool ?? ownMainFull;
  const ownRuneFull = ownDeck.runeDeck;
  const oppRuneFull = opts.opponentRunePool ?? ownRuneFull;

  const remainingMain = (full: string[], owner: PlayerId): string[] => {
    const pool = [...full];
    for (const o of visibleOf(owner)) takeOne(pool, o.cardId);
    return rng.shuffle(pool);
  };
  const remainingRunes = (full: string[], owner: PlayerId): string[] => {
    const pool = [...full];
    for (const o of visibleRunes(owner)) takeOne(pool, o.cardId);
    return rng.shuffle(pool);
  };

  const create = (
    slot: Slot,
    cardId: string,
    owner: PlayerId,
    zone: CardInstance['zone'],
  ): void => {
    objects[slot.id] = {
      id: slot.id,
      cardId,
      owner,
      controller: owner,
      zone,
      ready: true,
      damage: 0,
      mightBonus: 0,
    };
  };

  // ---- own hidden decks
  const ownMain = fill(rng, remainingMain(ownMainFull, me), ownMainFull, slots[me].mainDeck.length);
  slots[me].mainDeck.forEach((s, i) =>
    create(s, ownMain[i] as string, me, { kind: 'mainDeck', player: me }),
  );
  const ownRunes = fill(
    rng,
    remainingRunes(ownRuneFull, me),
    ownRuneFull,
    slots[me].runeDeck.length,
  );
  slots[me].runeDeck.forEach((s, i) =>
    create(s, ownRunes[i] as string, me, { kind: 'runeDeck', player: me }),
  );

  // ---- opponent: facedown first (prefer a Hidden card), then hand, then deck
  const oppPool = remainingMain(oppMainFull, opp);
  const isHiddenKw = (id: string): boolean =>
    cards[id]?.keywords.some((k) => k.name === 'Hidden') === true;
  const anyUnit = (): string => {
    const own = oppMainFull.filter((id) => cards[id]?.type === 'UNIT');
    const pick =
      own.length > 0 ? own : Object.keys(cards).filter((id) => cards[id]?.type === 'UNIT');
    return pick[rng.int(pick.length)] ?? (oppMainFull[0] as string);
  };
  for (const f of facedown) {
    const hi = oppPool.findIndex(isHiddenKw);
    let cardId: string;
    if (hi >= 0) cardId = oppPool.splice(hi, 1)[0] as string;
    else {
      const hiddenAll = oppMainFull.filter(isHiddenKw);
      cardId = hiddenAll.length > 0 ? (hiddenAll[rng.int(hiddenAll.length)] as string) : anyUnit();
    }
    create(f.slot, cardId, f.owner, {
      kind: 'facedown',
      player: f.owner,
      battlefieldId: f.battlefieldId,
    });
    (objects[f.slot.id] as CardInstance).facedown = true;
  }
  const oppHand = fill(rng, oppPool, oppMainFull, slots[opp].hand.length);
  slots[opp].hand.forEach((s, i) =>
    create(s, oppHand[i] as string, opp, { kind: 'hand', player: opp }),
  );
  const oppDeck = fill(rng, oppPool, oppMainFull, slots[opp].mainDeck.length);
  slots[opp].mainDeck.forEach((s, i) =>
    create(s, oppDeck[i] as string, opp, { kind: 'mainDeck', player: opp }),
  );
  const oppRunes = fill(
    rng,
    remainingRunes(oppRuneFull, opp),
    oppRuneFull,
    slots[opp].runeDeck.length,
  );
  slots[opp].runeDeck.forEach((s, i) =>
    create(s, oppRunes[i] as string, opp, { kind: 'runeDeck', player: opp }),
  );

  // ---- players
  const players = view.players.map((cp): PlayerState => {
    const rest: Record<string, unknown> = structuredClone(cp) as unknown as Record<string, unknown>;
    delete rest.handCount;
    delete rest.mainDeckCount;
    delete rest.runeDeckCount;
    const s = slots[cp.id];
    return {
      ...(rest as unknown as PlayerState),
      hand: cp.id === me ? [...cp.hand] : s.hand.map((x) => x.id),
      mainDeck: s.mainDeck.map((x) => x.id),
      runeDeck: s.runeDeck.map((x) => x.id),
    };
  }) as [PlayerState, PlayerState];

  // ---- remap leftover token references (attachedTo, facedown slots, flow)
  for (const o of Object.values(objects)) {
    if (o.attachedTo !== undefined) o.attachedTo = mapId(o.attachedTo);
  }
  const battlefields = view.battlefields.map((b) => ({
    ...structuredClone(b),
    facedownSlotId: b.facedownSlotId === null ? null : mapId(b.facedownSlotId),
  }));
  const flow: FlowState = structuredClone(view.flow);
  flow.chain = flow.chain.map((item) => ({
    ...item,
    sourceObjectId: mapId(item.sourceObjectId),
    targets: item.targets.map((t) =>
      t.kind === 'object' ? { kind: 'object' as const, id: mapId(t.id) } : t,
    ),
  }));
  if (flow.combat?.damageAssignment) {
    const da = flow.combat.damageAssignment;
    for (const k of Object.keys(da) as PlayerId[]) {
      da[k] = (da[k] ?? []).map((a) => ({ ...a, unitId: mapId(a.unitId) }));
    }
  }

  const state: GameState = {
    engineVersion: view.engineVersion,
    mode: view.mode,
    victoryScore: view.victoryScore,
    players,
    objects,
    battlefields,
    seed: { seed },
    rng: seedRng(`${seed}/sim`),
    turn: structuredClone(view.turn),
    turnState: structuredClone(view.turnState),
    flow,
    mulligan: structuredClone(view.mulligan),
    gameStatus: view.gameStatus,
    nextObjectId: nextNum,
    nextEventSeq: 1,
  };
  if (view.winner !== undefined) state.winner = view.winner;
  return state;
}
