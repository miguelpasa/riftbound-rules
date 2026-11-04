import { describe, it, expect } from 'vitest';
import { checkInvariants } from './invariants.js';
import { getLegalActions, getRuneActivations } from './legalActions.js';
import { reduce } from './reducer.js';
import { createGame } from './setup.js';
import { FIXTURE_CARDS, FIXTURE_DECK_A, FIXTURE_DECK_B } from './testing/fixtures.js';
import { RulesValidator, validateIntent } from './validator.js';
import type { GameState, Intent } from './types/index.js';

const fresh = (): GameState => createGame(FIXTURE_CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'la');
function started(): GameState {
  let s = fresh();
  for (const p of ['p0', 'p1'] as const) {
    const r = reduce(s, FIXTURE_CARDS, { type: 'MULLIGAN', playerId: p, cardIds: [] });
    if (!r.ok) throw new Error(r.message);
    s = r.state;
  }
  return s;
}

describe('getLegalActions', () => {
  it('offers keep / single / pair mulligans to the deciding player only', () => {
    // Tests Rule 117: sequential mulligan, up to two cards
    const s = fresh();
    const mine = getLegalActions(s, FIXTURE_CARDS, 'p0');
    expect(mine.every((a) => a.type === 'MULLIGAN')).toBe(true);
    expect(mine).toHaveLength(1 + 4 + 6);
    expect(getLegalActions(s, FIXTURE_CARDS, 'p1')).toEqual([]);
  });

  it('lists END_TURN and plays for the turn player, nothing for the other player', () => {
    // Tests Rule 316: the Main Phase belongs to the turn player
    const s = started();
    const acts = getLegalActions(s, FIXTURE_CARDS, 'p0');
    expect(acts.some((a) => a.type === 'END_TURN')).toBe(true);
    expect(acts.some((a) => a.type === 'PLAY_CARD')).toBe(true);
    expect(acts.some((a) => a.type === 'CONCEDE' || a.type === 'ACTIVATE_RUNE')).toBe(false);
    expect(getLegalActions(s, FIXTURE_CARDS, 'p1')).toEqual([]);
  });

  it('only lists actions the reducer accepts, deterministically', () => {
    // Tests Rule 100: the list never disagrees with the reducer
    const s = started();
    const a = getLegalActions(s, FIXTURE_CARDS, 'p0');
    expect(getLegalActions(s, FIXTURE_CARDS, 'p0')).toEqual(a);
    for (const i of a) expect(reduce(s, FIXTURE_CARDS, i).ok).toBe(true);
  });

  it('keeps END_TURN when truncated by maxActions', () => {
    // Tests Rule 317: the player can always end the turn
    const acts = getLegalActions(started(), FIXTURE_CARDS, 'p0', { maxActions: 2 });
    expect(acts).toHaveLength(2);
    expect(acts.some((a) => a.type === 'END_TURN')).toBe(true);
  });

  it('returns nothing once the game is over', () => {
    // Tests Rule 473.1: no actions after the game ends
    const r = reduce(started(), FIXTURE_CARDS, { type: 'CONCEDE', playerId: 'p0' });
    if (!r.ok) throw new Error('concede failed');
    expect(getLegalActions(r.state, FIXTURE_CARDS, 'p1')).toEqual([]);
  });
});

describe('getRuneActivations', () => {
  it('lists EXHAUST and RECYCLE for channeled runes, none during the mulligan', () => {
    // Tests Rule 164.2: a rune can be exhausted for Energy or recycled for Power
    expect(getRuneActivations(fresh(), FIXTURE_CARDS, 'p0')).toEqual([]);
    const acts = getRuneActivations(started(), FIXTURE_CARDS, 'p0');
    expect(acts).toHaveLength(4);
    expect(new Set(acts.map((a) => (a as { mode: string }).mode))).toEqual(
      new Set(['EXHAUST', 'RECYCLE']),
    );
  });
});

describe('validateIntent / RulesValidator', () => {
  it('reports ok or the RuleError without touching the state', () => {
    // Tests Rule 100: validation is a dry run of the reducer
    const s = started();
    const before = JSON.stringify(s);
    expect(validateIntent(s, FIXTURE_CARDS, { type: 'END_TURN', playerId: 'p0' })).toEqual({
      ok: true,
    });
    const bad: Intent = { type: 'END_TURN', playerId: 'p1' };
    expect(RulesValidator.validate(s, FIXTURE_CARDS, bad)).toMatchObject({ ok: false });
    expect(RulesValidator.getLegalActions(s, FIXTURE_CARDS, 'p0').length).toBeGreaterThan(0);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('checkInvariants', () => {
  it('is clean for fresh and started games and flags corruption', () => {
    // Tests Rule 107: every object lives in exactly one zone
    const s = started();
    expect(checkInvariants(fresh(), FIXTURE_CARDS)).toEqual([]);
    expect(checkInvariants(s, FIXTURE_CARDS)).toEqual([]);

    const lost = structuredClone(s);
    lost.players[0].hand.pop();
    expect(checkInvariants(lost, FIXTURE_CARDS).length).toBeGreaterThan(0);

    const dup = structuredClone(s);
    dup.players[1].hand.push(dup.players[0].hand[0] as string);
    expect(checkInvariants(dup, FIXTURE_CARDS).length).toBeGreaterThan(0);

    const dangling = structuredClone(s);
    dangling.players[0].trash.push('o9999');
    expect(checkInvariants(dangling, FIXTURE_CARDS).join()).toContain('dangling');

    const neg = structuredClone(s);
    neg.players[0].points = -1;
    (Object.values(neg.objects)[0] as { damage: number }).damage = -2;
    expect(checkInvariants(neg, FIXTURE_CARDS).length).toBeGreaterThanOrEqual(2);

    const fin = structuredClone(s);
    fin.gameStatus = 'FINISHED';
    expect(checkInvariants(fin, FIXTURE_CARDS).join()).toContain('no winner');

    const ctl = structuredClone(s);
    (ctl.battlefields[0] as { controller: string | null }).controller = 'p0';
    expect(checkInvariants(ctl, FIXTURE_CARDS).join()).toContain('controlled by');
  });
});
