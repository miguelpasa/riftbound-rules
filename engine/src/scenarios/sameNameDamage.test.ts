import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseSpellText } from '../cardText.js';
import { runEffects } from '../effects.js';
import type { CardDatabase, CardDef, Target } from '../types/index.js';

const TEXT =
  'Deal 2 to a unit at a battlefield. This deals 1 Bonus Damage for each card with this name in your trash.';

describe('scenario: "1 Bonus Damage for each card with this name in your trash" (Consuming Curse)', () => {
  it('reads the second sentence onto the damage', () => {
    // Tests Rule 369: a spell's effects are carried out in printed order
    const fx = parseSpellText(TEXT);
    expect(fx).toHaveLength(1);
    expect(fx?.[0]).toMatchObject({ op: 'DAMAGE_TARGET', amount: 2, perSameNameInTrash: 1 });
  });

  it('adds 1 per copy in the caster’s own trash only', () => {
    // Tests Rule 369: the damage is worked out as the spell resolves
    const curse: CardDef = {
      ...(SCENARIO_CARDS['fx-bolt'] as CardDef),
      name: 'Consuming Curse',
      effects: parseSpellText(TEXT) ?? [],
    };
    const cards: CardDatabase = { ...SCENARIO_CARDS, 'fx-curse': curse };
    const run = (mine: number, theirs: number): number => {
      const sc = Scenario.start({}, cards);
      const victim = sc.putUnit('p0', 'fx-grunt', 'bf1');
      const move = (player: 'p0' | 'p1', n: number): void => {
        const ps = sc.state.players[player === 'p0' ? 0 : 1] as { hand: string[]; trash: string[] };
        for (const id of ps.hand.splice(0, n)) {
          ps.trash.push(id);
          const o = sc.state.objects[id] as { cardId: string; zone: unknown };
          o.cardId = 'fx-curse';
          o.zone = { kind: 'trash', player };
        }
      };
      move('p0', mine);
      move('p1', theirs);
      const targets: Target[] = [{ kind: 'object', id: victim }];
      runEffects(sc.state, 'p0', curse.effects ?? [], cards, targets, 'fx-curse', '');
      return sc.state.objects[victim]?.damage ?? 0;
    };
    expect(run(0, 0)).toBe(2);
    expect(run(2, 0)).toBe(4);
    expect(run(1, 3)).toBe(3); // the opponent's copies do not count
  });
});
