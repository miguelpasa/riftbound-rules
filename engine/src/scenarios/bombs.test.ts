import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { runEffects } from '../effects.js';
import { fireTriggers } from '../triggers.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, GameEvent, PlayerId, Target } from '../types/index.js';

const cards: CardDatabase = { ...SCENARIO_CARDS, ...TOKEN_CARDS };
const bf = (battlefieldId: string): Target => ({ kind: 'battlefield', battlefieldId });
const bombs = (sc: Scenario): string[] =>
  Object.values(sc.state.objects)
    .filter((o) => o.cardId === 'tok-bomb')
    .map((o) => o.id);

function playBombs(sc: Scenario, count: number, at: string): void {
  const s = structuredClone(sc.state);
  runEffects(s, 'p0', [{ op: 'PLAY_TOKEN', token: 'tok-bomb', count, atSlot: 0 }], cards, [bf(at)]);
  sc.state = s;
}

describe('scenario: Bomb gear tokens (Ziggs, Amateur Demolitionist, Explosimian)', () => {
  it('parses the play sentences with a chosen battlefield', () => {
    // Tests Rule 355.10: the controller chooses the battlefield as the ability is put on the Chain
    expect(
      parseCardAbilities('When you play me, play a Bomb gear token to a battlefield.')?.triggers[0]
        ?.effects,
    ).toEqual([{ op: 'PLAY_TOKEN', token: 'tok-bomb', count: 1, atSlot: 0 }]);
  });

  it('plays the tokens to the chosen battlefield, where they stay', () => {
    // Tests Rule 186: a token is created at the stated location
    const sc = Scenario.start({}, cards);
    playBombs(sc, 2, 'bf1');
    expect(bombs(sc)).toHaveLength(2);
    for (const id of bombs(sc)) {
      expect(sc.obj(id).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    }
  });

  it('when one dies it deals 2 to an enemy there and kills your other Bombs there', () => {
    // Tests Rule 583.3: a death trigger uses the last known location of the dead token
    const sc = Scenario.start({}, cards);
    playBombs(sc, 2, 'bf1');
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const [first] = bombs(sc);
    const s = structuredClone(sc.state);
    const out = runEffects(s, 'p0', [{ op: 'KILL_TARGET', slot: 0, orGear: true }], cards, [
      { kind: 'object', id: first as string },
    ]);
    const events = out.map((e, i) => ({ ...e, seq: i + 1 }) as GameEvent);
    expect(events.some((e) => e.type === 'GEAR_KILLED')).toBe(true);
    sc.state = fireTriggers(s, cards, events).state;
    expect(sc.state.flow.chain).toHaveLength(1);
    const choice = sc.state.flow.pendingChoice;
    expect(choice?.kind).toBe('TRIGGER_TARGET');
    sc.do({
      type: 'CHOOSE_TRIGGER_TARGET',
      playerId: 'p0',
      chainItemId: sc.state.flow.chain[0]?.id as string,
      targets: [{ kind: 'object', id: enemy }],
    });
    for (let k = 0; k < 10 && sc.state.flow.chain.length > 0; k++) {
      sc.pass(sc.state.flow.priority as PlayerId);
    }
    expect(bombs(sc)).toHaveLength(0); // the other Bomb died too
    expect(sc.obj(enemy).zone.kind).toBe('trash'); // 2 damage kills the 2 [M] enemy
  });
});
