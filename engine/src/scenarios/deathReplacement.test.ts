import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { runCleanup } from '../cleanup.js';
import { expireTurnEffects, runEffects } from '../effects.js';
import { parseSpellText } from '../cardText.js';
import type { CardEffect, CardInstance, GameState } from '../types/index.js';

function killAndSettle(
  sc: Scenario,
  s: GameState,
): { state: GameState; events: { type: string }[] } {
  runEffects(s, 'p0', [{ op: 'KILL_ALL_UNITS' }], sc.cards);
  const cl = runCleanup(s, sc.cards);
  if (!cl.ok) throw new Error(cl.message);
  return { state: cl.state, events: cl.events };
}

function shield(sc: Scenario, unit: string, mode: 'RECALL' | 'BANISH'): GameState {
  const s = structuredClone(sc.state);
  (s.objects[unit] as CardInstance).deathReplace = mode;
  return s;
}

describe('scenario: "would die ... instead" replacement (X7)', () => {
  it('RECALL heals, exhausts and sends the unit to its base instead of killing it', () => {
    // Tests Rule 573: a replacement effect alters the execution of the Game Effect it applies to
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const { state, events } = killAndSettle(sc, shield(sc, u, 'RECALL'));
    const o = state.objects[u] as CardInstance;
    expect(o.zone.kind).toBe('base');
    expect(o.ready).toBe(false);
    expect(o.damage).toBe(0);
    expect(o.deathReplace).toBeUndefined();
    expect(state.players[0].base).toContain(u);
    expect(events.some((e) => e.type === 'UNIT_KILLED')).toBe(false);
    expect(events.some((e) => e.type === 'UNIT_DEATH_REPLACED')).toBe(true);
    expect(events.some((e) => e.type === 'UNIT_MOVED')).toBe(false); // 'This isn't a move'
  });

  it('it is one-shot: the second lethal hit kills the unit', () => {
    // Tests Rule 573.1: "the next time" - the replacement is used up once applied
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const first = killAndSettle(sc, shield(sc, u, 'RECALL'));
    const again = killAndSettle(sc, first.state);
    expect((again.state.objects[u] as CardInstance).zone.kind).toBe('trash');
  });

  it('BANISH exiles the unit instead of killing it, with no death trigger', () => {
    // Tests Rule 573: "banish it instead"
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
    const { state, events } = killAndSettle(sc, shield(sc, u, 'BANISH'));
    expect((state.objects[u] as CardInstance).zone.kind).toBe('banishment');
    expect(state.players[0].banishment).toContain(u);
    expect(events.some((e) => e.type === 'UNIT_KILLED')).toBe(false);
  });

  it('the replacement expires at the end of the turn', () => {
    // Tests Rule 317: "this turn" effects end in the Ending step
    const sc = Scenario.start();
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const ended = expireTurnEffects(shield(sc, u, 'RECALL'), sc.cards).state;
    expect((ended.objects[u] as CardInstance).deathReplace).toBeUndefined();
  });

  it('parses Highlander / Tactical Retreat and Smite', () => {
    // Tests Rule 573.1: "instead" marks a replacement effect
    const recall: CardEffect[] = [{ op: 'DEATH_REPLACE_TARGET', mode: 'RECALL', side: 'friendly' }];
    expect(
      parseSpellText(
        'Choose a friendly unit. The next time it would die this turn, heal it, exhaust it, and recall it instead.',
      ),
    ).toEqual(recall);
    expect(
      parseSpellText(
        'Deal 3 to a unit at a battlefield. If it would die this turn, banish it instead.',
      ),
    ).toEqual([
      { op: 'DAMAGE_TARGET', amount: 3, atBattlefield: true },
      { op: 'DEATH_REPLACE_TARGET', mode: 'BANISH' },
    ]);
  });
});
