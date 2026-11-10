import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import { runEffects } from '../effects.js';

const TEXT =
  "When you play me, if you control 7 or more runes, choose an enemy gear. If it's [Empowered], disempower it. Otherwise, kill it.";

describe('scenario: "choose an enemy gear. If it\'s [Empowered], disempower it. Otherwise, kill it" (Tomb-Raider Barbara)', () => {
  it('reads a rune-gated PLAY trigger with a disempower-or-kill gear effect', () => {
    // Tests Rule 303: a triggered ability with a general condition
    const t = parseCardAbilities(TEXT)?.triggers[0];
    expect(t).toMatchObject({ on: 'PLAY', when: { kind: 'COUNT', what: 'rune', n: 7 } });
    expect(t?.effects).toEqual([{ op: 'KILL_GEAR', disempowerInstead: true, side: 'enemy' }]);
  });

  it('disempowers an Empowered gear and kills a plain one', () => {
    // Tests Rule 303: the effect reads the gear as it resolves
    const effects = parseCardAbilities(TEXT)?.triggers[0]?.effects ?? [];
    const run = (empowered: boolean): { zone: string; empowered: boolean } => {
      const sc = Scenario.start({}, SCENARIO_CARDS);
      const gear = sc.putUnit('p1', 'fx-blade', 'base');
      if (empowered) (sc.state.objects[gear] as { empowered?: boolean }).empowered = true;
      runEffects(sc.state, 'p0', effects, sc.cards, [{ kind: 'object', id: gear }], 'fx-grunt', '');
      const o = sc.state.objects[gear];
      return { zone: o?.zone.kind ?? 'gone', empowered: o?.empowered === true };
    };
    expect(run(true)).toEqual({ zone: 'base', empowered: false });
    expect(run(false).zone).toBe('trash');
  });
});
