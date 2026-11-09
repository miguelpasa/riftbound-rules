import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { runCleanup } from '../cleanup.js';
import { runEffects } from '../effects.js';
import { parseSpellText } from '../cardText.js';
import type { CardInstance } from '../types/index.js';

describe('scenario: "kill all damaged enemy units here" (Warwick)', () => {
  it('kills only the damaged enemy units at the source battlefield', () => {
    // Tests Rule 142.4: a killed unit goes to the Trash in the next Cleanup
    const sc = Scenario.start();
    const bf = sc.state.battlefields[0]!.id;
    const me = sc.putUnit('p0', 'fx-ash-tank', bf, { control: true });
    const hurt = sc.putUnit('p1', 'fx-order-tank', bf, { damage: 1 });
    const fine = sc.putUnit('p1', 'fx-tide-grunt', bf);
    const away = sc.putUnit('p1', 'fx-tide-archer', 'base', { damage: 1 });
    const effects = parseSpellText('Kill all damaged enemy units here.');
    expect(effects).toEqual([{ op: 'KILL_ALL_UNITS', side: 'enemy', damaged: true, here: true }]);
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', effects ?? [], sc.cards, [], 'fx-ash-tank', me);
    const cl = runCleanup(s, sc.cards);
    if (!cl.ok) throw new Error(cl.message);
    const zone = (id: string): string => (cl.state.objects[id] as CardInstance).zone.kind;
    expect(zone(hurt)).toBe('trash');
    expect(zone(fine)).toBe('battlefield');
    expect(zone(away)).toBe('base');
    expect(zone(me)).toBe('battlefield');
  });
});
