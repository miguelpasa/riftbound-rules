import { describe, it, expect } from 'vitest';
import { Scenario } from '../testing/scenario.js';
import { runEffects } from '../effects.js';
import { effectiveMight } from '../combat.js';
import { TOKEN_CARDS } from '../tokens.js';
import { parseSpellText } from '../cardText.js';

describe('Shadow Clone token (R64)', () => {
  it('is parsed by name and enters as a 0 Might unit token', () => {
    // Tests Rule 186.1: tokens are created by effects and exist only on the board
    const eff = parseSpellText('Play a 0 [M] Shadow Clone unit token to your base.');
    expect(eff).toEqual([{ op: 'PLAY_TOKEN', token: 'tok-shadow-clone', count: 1 }]);
    const sc = Scenario.start({}, { ...Scenario.start().cards, ...TOKEN_CARDS });
    const s = structuredClone(sc.state);
    const before = new Set(Object.keys(s.objects));
    runEffects(s, 'p0', eff ?? [], sc.cards);
    const id = Object.keys(s.objects).find((k) => !before.has(k)) as string;
    expect(s.objects[id]?.cardId).toBe('tok-shadow-clone');
    sc.state = s;
    expect(effectiveMight(sc.state, sc.cards, id, { role: null })).toBe(0);
  });
});
