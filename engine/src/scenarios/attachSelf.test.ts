import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, SC_LURKER_A, Scenario } from '../testing/scenario.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const TEXT = 'When you play this from face down, attach it to a unit you control (here).';

describe('scenario: "When you play this from face down, attach it to a unit you control" (Edge of Night)', () => {
  it('reads a face-down-only trigger with an attach-self effect', () => {
    // Tests Rule 811: a self trigger conditioned on the facedown play
    expect(parseCardAbilities(TEXT, { gearLike: true })?.triggers[0]).toEqual({
      on: 'PLAY',
      when: { kind: 'FROM_FACEDOWN' },
      effects: [{ op: 'ATTACH_SELF_TARGET', side: 'friendly' }],
    });
  });

  it('attaches the Equipment to the chosen friendly unit when played from face down', () => {
    // Tests Rule 811 / 818: the Equipment ends up attached to a unit its controller controls
    const edge: CardDef = {
      ...(SCENARIO_CARDS[SC_LURKER_A] as CardDef),
      type: 'GEAR',
      stats: {},
      cost: { energy: 0 },
      keywords: [{ name: 'Hidden' }, { name: 'Equip' }],
      triggers: parseCardAbilities(TEXT, { gearLike: true })?.triggers ?? [],
    };
    const cards: CardDatabase = { ...SCENARIO_CARDS, [SC_LURKER_A]: edge };
    const sc = Scenario.start({}, cards);
    const unit = sc.putUnit('p0', 'fx-grunt', 'bf0', { control: true });
    const gear = sc.putInHand('p0', SC_LURKER_A);
    sc.do({ type: 'HIDE_CARD', playerId: 'p0', cardInstanceId: gear, battlefieldId: 'bf0' });
    sc.endTurn('p0');
    sc.endTurn('p1');
    sc.play('p0', gear, { location: { kind: 'base' } });
    for (let i = 0; i < 12 && (sc.state.flow.chain.length > 0 || sc.state.flow.pendingChoice); i++) {
      const pc = sc.state.flow.pendingChoice;
      if (pc?.kind === 'TRIGGER_TARGET') {
        sc.do({
          type: 'CHOOSE_TRIGGER_TARGET',
          playerId: pc.player,
          chainItemId: pc.chainItemId,
          targets: [{ kind: 'object', id: unit }],
        });
      } else if (!pc) {
        sc.pass(sc.state.flow.priority!);
      } else {
        throw new Error('unexpected ' + pc.kind);
      }
    }
    expect(sc.obj(gear).zone.kind).toBe('base');
    expect(sc.obj(gear).attachedTo).toBe(unit);
  });
});
