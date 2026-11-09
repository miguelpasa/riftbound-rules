import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { fireTriggers } from '../triggers.js';
import { runEffects } from '../effects.js';
import { staticBonus } from '../statics.js';
import { parseCardAbilities, parseStaticLines } from '../cardText.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  GameEvent,
  Intent,
  PlayerId,
} from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;

const activate = (player: PlayerId, sourceId: string): Intent => ({
  type: 'ACTIVATE_ABILITY',
  playerId: player,
  sourceId,
  abilityIndex: 0,
  payment: [],
});

describe('scenario: Legion on activated abilities (Hand of Noxus, Sun Disc)', () => {
  const parsed = parseCardAbilities('[E]: [Reaction], [Legion] — [Add] [1].', { gearLike: true });
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    ...TOKEN_CARDS,
    'fx-grunt': {
      ...base('fx-grunt'),
      type: 'GEAR',
      stats: {},
      abilities: parsed?.abilities ?? [],
    },
  };

  it('parses the Legion prefix as a flag on the ability', () => {
    // Tests Rule 812: Legion is active once another card was played this turn
    expect(parsed?.abilities[0]).toMatchObject({ reaction: true, legion: true });
    const disc = parseCardAbilities(
      '[E]: [Legion] — The next unit you play this turn enters ready.',
      {
        gearLike: true,
      },
    );
    expect(disc?.abilities[0]).toMatchObject({
      legion: true,
      effects: [{ op: 'ENTER_READY_NEXT' }],
    });
  });

  it('cannot be used until another card was played this turn', () => {
    // Tests Rule 812: the Legion effect needs another card played this turn
    const sc = Scenario.start({}, cards);
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    expect(sc.reject(activate('p0', g)).code).toBe('ABILITY_NOT_AVAILABLE');
    const s = structuredClone(sc.state);
    (s.players[0] as { playedThisTurn?: unknown }).playedThisTurn = {
      turn: s.turn.number,
      objectIds: ['o-other'],
    };
    sc.state = s;
    sc.do(activate('p0', g));
    expect(sc.player('p0').runePool.energy).toBe(1);
  });

  it('"the next unit you play enters ready" applies once, to the first unit only', () => {
    // Tests Rule 359.2: units normally enter exhausted; the grant is consumed by the next unit
    const sc = Scenario.start({}, SCENARIO_CARDS);
    sc.giveRunes('p0', 6);
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', [{ op: 'ENTER_READY_NEXT' }], sc.cards);
    sc.state = s;
    const a = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', a, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.obj(a).ready).toBe(true);
    expect(sc.state.players[0]?.enterReadyNext).toBeUndefined();
    const b = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', b, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    expect(sc.obj(b).ready).toBe(false);
  });
});

describe('scenario: "Friendly buffed units have [Deflect]" (Spirit\'s Refuge)', () => {
  it('grants the keyword to buffed friendly units only', () => {
    // Tests Rule 563: a static ability grants keywords while its condition holds
    const st = parseStaticLines("Friendly buffed units have [Deflect] if they didn't already.");
    expect(st?.statics[0]).toMatchObject({ affects: 'FRIENDLY_UNITS', onlyBuffed: true });
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ember-totem': { ...base('fx-ember-totem'), statics: st?.statics ?? [] },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    const plain = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const buffed = sc.putUnit('p0', 'fx-ash-tank', 'base');
    (sc.state.objects[buffed] as CardInstance).buffed = true;
    const kw = (id: string): string[] =>
      staticBonus(sc.state, cards, sc.state.objects[id] as CardInstance).keywords.map(
        (k) => k.name,
      );
    expect(kw(plain)).not.toContain('Deflect');
    expect(kw(buffed)).toContain('Deflect');
  });
});

describe('scenario: "another non-Recruit unit you control dies" (Viktor)', () => {
  it('plays a Recruit for a dying non-Recruit unit, but not for a dying Recruit', () => {
    // Tests Rule 583.3: a death trigger with a subtype exception
    const vik = parseCardAbilities(
      'When another non-Recruit unit you control dies, play a 1 [M] Recruit unit token into your base.',
    );
    expect(vik?.triggers[0]?.dies).toEqual({ side: 'friendly', exceptSubtype: 'Recruit' });
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      ...TOKEN_CARDS,
      'fx-ember-totem': {
        ...base('fx-ember-totem'),
        type: 'UNIT',
        stats: { might: 3 },
        triggers: vik?.triggers ?? [],
      },
    };
    const kill = (sc: Scenario, id: string): void => {
      const s = structuredClone(sc.state);
      const o = s.objects[id] as CardInstance;
      const cardId = o.cardId;
      s.players[0].base = s.players[0].base.filter((x) => x !== id);
      s.players[0].trash.push(id);
      o.zone = { kind: 'trash', player: 'p0' };
      const ev = {
        seq: 1,
        type: 'UNIT_KILLED',
        unitId: id,
        controller: 'p0',
        cardId,
        at: 'base',
        alone: false,
      } as GameEvent;
      sc.state = fireTriggers(s, sc.cards, [ev]).state;
      for (let k = 0; k < 8 && sc.state.flow.chain.length > 0; k++) {
        sc.pass(sc.state.flow.priority as PlayerId);
      }
    };
    const tokens = (sc: Scenario): number =>
      Object.values(sc.state.objects).filter((o) => o.cardId === 'tok-recruit').length;

    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    const victim = sc.putUnit('p0', 'fx-ash-tank', 'base');
    kill(sc, victim);
    expect(tokens(sc)).toBe(1);

    const sc2 = Scenario.start(
      {},
      { ...cards, 'fx-ash-tank': { ...base('fx-ash-tank'), subtypes: ['Recruit'] } },
    );
    sc2.putUnit('p0', 'fx-ember-totem', 'base');
    const rec = sc2.putUnit('p0', 'fx-ash-tank', 'base');
    kill(sc2, rec);
    expect(tokens(sc2)).toBe(0);
  });
});

describe('scenario: "Deal N to all units at my battlefield" (Kog\'Maw Deathknell)', () => {
  it('parses to the same effect as "here"', () => {
    // Tests Rule 726: Deathknell triggers when the unit dies
    const r = parseCardAbilities('[Deathknell] — Deal 2 to all units at my battlefield.');
    expect(r?.triggers[0]).toMatchObject({
      on: 'DEATH',
      effects: [{ op: 'DAMAGE_ALL', amount: 2, scope: 'here' }],
    });
  });
});
