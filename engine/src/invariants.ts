/**
 * Structural invariants of a GameState, for tests, fuzzing and host sanity checks.
 *
 * `checkInvariants` returns human-readable violations (empty = healthy). It is meant to be run on
 * states returned by `reduce` (i.e. after Cleanup): the battlefield-control rule is only checked in
 * a Neutral Open state with nothing ongoing, where Cleanup has had its say.
 *
 * Checks:
 *  - zones: every object is referenced by exactly the zone array that its ZoneRef names (hand, decks,
 *    trash, banishment, base, champion zone, legend). Objects in battlefield / facedown / chain zones
 *    are tracked elsewhere and must appear in NO array; facedown ones must match a battlefield slot,
 *    chain ones a chain item. No array holds a dangling id or a duplicate.
 *  - bookkeeping: ids are 'o<N>' with N < nextObjectId; chain item ids are unique and do not collide
 *    with object ids; CARD chain items point at objects in the 'chain' zone.
 *  - numbers/flags: points, damage are non-negative integers; ready is boolean; rune counts <= 12.
 *  - victory: FINISHED has a winner; IN_PROGRESS has none; turnState matches the flow.
 *  - control: in a Neutral Open state, a controlled battlefield has a unit of its controller.
 */
import { RUNE_DECK_SIZE } from './types/constants.js';
import type { CardDatabase, GameState, PlayerId } from './types/index.js';

export function checkInvariants(state: GameState, cards: CardDatabase): string[] {
  const v: string[] = [];
  const objects = state.objects;

  // ---- membership of zone arrays
  const holders = new Map<string, string[]>();
  const hold = (id: string, where: string): void => {
    const list = holders.get(id);
    if (list) list.push(where);
    else holders.set(id, [where]);
  };
  for (const p of state.players) {
    const arrays: [string, string[]][] = [
      ['hand', p.hand],
      ['mainDeck', p.mainDeck],
      ['runeDeck', p.runeDeck],
      ['trash', p.trash],
      ['banishment', p.banishment],
      ['base', p.base],
      ['champion', p.championZone],
    ];
    for (const [kind, ids] of arrays) for (const id of ids) hold(id, `${kind}:${p.id}`);
    if (p.legend !== null) hold(p.legend, `legend:${p.id}`);
  }
  for (const [id, where] of holders) {
    if (!objects[id]) v.push(`dangling id ${id} in ${where.join(', ')}`);
    if (where.length > 1) v.push(`object ${id} appears in several zones: ${where.join(', ')}`);
  }

  const chainSources = new Set(state.flow.chain.map((c) => c.sourceObjectId));
  const slotted = new Set(
    state.battlefields.map((b) => b.facedownSlotId).filter((x) => x !== null),
  );
  const runeCount: Record<PlayerId, number> = { p0: 0, p1: 0 };

  for (const [id, o] of Object.entries(objects)) {
    if (o.id !== id) v.push(`object key ${id} != id ${o.id}`);
    if (!/^o\d+$/.test(id) || Number(id.slice(1)) >= state.nextObjectId) {
      v.push(`object id ${id} is not below nextObjectId ${state.nextObjectId}`);
    }
    if (typeof o.ready !== 'boolean') v.push(`object ${id}: ready is not a boolean`);
    if (!Number.isInteger(o.damage) || o.damage < 0) v.push(`object ${id}: damage ${o.damage}`);
    if (!Number.isFinite(o.mightBonus)) v.push(`object ${id}: mightBonus ${o.mightBonus}`);
    if (!cards[o.cardId]) v.push(`object ${id}: unknown card ${o.cardId}`);
    if (cards[o.cardId]?.type === 'RUNE') runeCount[o.owner] += 1;
    if (o.attachedTo !== undefined && !objects[o.attachedTo]) {
      v.push(`object ${id}: attachedTo ${o.attachedTo} does not exist`);
    }

    const z = o.zone;
    const where = holders.get(id) ?? [];
    switch (z.kind) {
      case 'chain':
        if (where.length > 0) v.push(`chain object ${id} also listed in ${where.join(', ')}`);
        if (!chainSources.has(id))
          v.push(`object ${id} is in the chain zone but has no chain item`);
        break;
      case 'battlefield':
        if (where.length > 0) v.push(`battlefield object ${id} also listed in ${where.join(', ')}`);
        if (!state.battlefields.some((b) => b.id === z.battlefieldId)) {
          v.push(`object ${id} sits at unknown battlefield ${z.battlefieldId}`);
        }
        break;
      case 'facedown':
        if (where.length > 0) v.push(`facedown object ${id} also listed in ${where.join(', ')}`);
        if (!slotted.has(id)) v.push(`facedown object ${id} is not in a battlefield slot`);
        break;
      default: {
        const expected = `${z.kind}:${z.player}`;
        if (where.length !== 1 || where[0] !== expected) {
          v.push(`object ${id} claims ${expected} but is listed in [${where.join(', ')}]`);
        }
      }
    }
  }
  for (const b of state.battlefields) {
    if (b.facedownSlotId !== null) {
      const o = objects[b.facedownSlotId];
      if (!o) v.push(`battlefield ${b.id}: facedown slot ${b.facedownSlotId} dangling`);
      else if (o.zone.kind !== 'facedown' || o.zone.battlefieldId !== b.id) {
        v.push(`battlefield ${b.id}: slot object ${o.id} is in zone ${o.zone.kind}`);
      }
    }
    if (b.controller !== null && b.controller !== 'p0' && b.controller !== 'p1') {
      v.push(`battlefield ${b.id}: bad controller`);
    }
  }

  // ---- chain
  const chainIds = new Set<string>();
  for (const item of state.flow.chain) {
    if (chainIds.has(item.id)) v.push(`duplicate chain item id ${item.id}`);
    chainIds.add(item.id);
    if (objects[item.id]) v.push(`chain item id ${item.id} collides with an object id`);
    if (item.kind === 'CARD') {
      const src = objects[item.sourceObjectId];
      if (!src) v.push(`chain item ${item.id}: source ${item.sourceObjectId} dangling`);
      else if (src.zone.kind !== 'chain') {
        v.push(`chain item ${item.id}: source ${src.id} is in zone ${src.zone.kind}, not chain`);
      }
    }
  }

  // ---- players
  for (const p of state.players) {
    if (!Number.isInteger(p.points) || p.points < 0) v.push(`${p.id}: points ${p.points}`);
    if (p.runePool.energy < 0) v.push(`${p.id}: negative energy`);
    for (const [d, n] of Object.entries(p.runePool.power)) {
      if ((n ?? 0) < 0) v.push(`${p.id}: negative ${d} power`);
    }
  }
  for (const pid of ['p0', 'p1'] as const) {
    if (runeCount[pid] > RUNE_DECK_SIZE)
      v.push(`${pid}: ${runeCount[pid]} runes exceed ${RUNE_DECK_SIZE}`);
  }

  // ---- victory / status
  if (state.gameStatus === 'FINISHED' && state.winner === undefined)
    v.push('finished game has no winner');
  if (state.gameStatus === 'IN_PROGRESS' && state.winner !== undefined) {
    v.push('game in progress has a winner');
  }

  // ---- turn state vs flow
  const showdown = state.flow.showdown !== undefined || state.flow.combat !== undefined;
  const open = state.flow.chain.length === 0;
  if (
    state.turnState.kind !== (showdown ? 'SHOWDOWN' : 'NEUTRAL') ||
    state.turnState.open !== open
  ) {
    v.push(`turnState ${JSON.stringify(state.turnState)} does not match flow`);
  }

  // ---- control (323.5), only in a settled Neutral Open state
  if (state.gameStatus === 'IN_PROGRESS' && !showdown && open) {
    for (const b of state.battlefields) {
      if (b.controller === null) continue;
      const has = Object.values(objects).some(
        (o) =>
          o.zone.kind === 'battlefield' &&
          o.zone.battlefieldId === b.id &&
          o.controller === b.controller,
      );
      if (!has)
        v.push(`battlefield ${b.id} is controlled by ${b.controller} but has none of their units`);
    }
  }
  return v;
}
