import { describe, it, expect } from 'vitest';
import { FIXTURE_CARDS, getObjectByCardId, makeTestGame } from '../testing/fixtures.js';
import { DEFAULT_WEIGHTS, evaluate } from './evaluate.js';

describe('evaluate', () => {
  it('is antisymmetric in the perspective for point and board terms', () => {
    // Tests Rule 473: points are the victory currency
    const s = makeTestGame('eval-1');
    s.players[0].points = 3;
    const a = evaluate(s, FIXTURE_CARDS, 'p0');
    const b = evaluate(s, FIXTURE_CARDS, 'p1');
    expect(a).toBeGreaterThan(b);
    expect(a - b).toBeGreaterThanOrEqual(2 * 3 * DEFAULT_WEIGHTS.point - 100);
  });

  it('rewards own points, held battlefields and board Might; punishes damage', () => {
    // Tests Rule 143: Might measures a unit's strength
    const s = makeTestGame('eval-2');
    const base = evaluate(s, FIXTURE_CARDS, 'p0');
    const p = structuredClone(s);
    p.players[0].points += 1;
    expect(evaluate(p, FIXTURE_CARDS, 'p0') - base).toBe(DEFAULT_WEIGHTS.point);

    const b = structuredClone(s);
    (b.battlefields[0] as { controller: 'p0' }).controller = 'p0';
    expect(evaluate(b, FIXTURE_CARDS, 'p0') - base).toBe(DEFAULT_WEIGHTS.battlefield);

    const u = structuredClone(s);
    const unit =
      getObjectByCardId(u, 'fx-grunt', 'p0') ?? getObjectByCardId(u, 'fx-ash-tank', 'p0');
    if (unit) {
      u.players[0].hand = u.players[0].hand.filter((id) => id !== unit.id);
      unit.zone = { kind: 'base', player: 'p0' };
      u.players[0].base.push(unit.id);
      const withUnit = evaluate(u, FIXTURE_CARDS, 'p0');
      const hurt = structuredClone(u);
      (hurt.objects[unit.id] as { damage: number }).damage = 1;
      expect(evaluate(hurt, FIXTURE_CARDS, 'p0')).toBeLessThan(withUnit);
    }
  });

  it('returns a huge value for a finished game', () => {
    // Tests Rule 473: reaching the victory score wins the game
    const s = makeTestGame('eval-3');
    s.gameStatus = 'FINISHED';
    s.winner = 'p1';
    expect(evaluate(s, FIXTURE_CARDS, 'p1')).toBe(DEFAULT_WEIGHTS.win);
    expect(evaluate(s, FIXTURE_CARDS, 'p0')).toBe(-DEFAULT_WEIGHTS.win);
  });
});
