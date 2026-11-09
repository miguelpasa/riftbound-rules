import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { TOKEN_CARDS } from '../tokens.js';
import { fireTriggers } from '../triggers.js';
import { countMove } from '../moveCount.js';
import { applyDamageMods } from '../damageMod.js';
import { runEffects } from '../effects.js';
import { staticBonus } from '../statics.js';
import { parseCardAbilities, parseSelfCostReduction, parseStaticLines } from '../cardText.js';
import { selfEnergyDiscount } from '../costReduction.js';
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

describe('scenario: counting moves in a turn (Yasuo, Kayn)', () => {
  const yasuo = parseCardAbilities('The third time I move in a turn, you score 1 point.');
  const kayn = parseStaticLines("If I have moved twice this turn, I don't take damage.");
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-ganker': {
      ...base('fx-ganker'),
      triggers: yasuo?.triggers ?? [],
      statics: kayn?.statics ?? [],
    },
  };

  it('parses both cards', () => {
    // Tests Rule 583.3: a triggered ability that fires on the n-th event of a turn
    expect(yasuo?.triggers[0]).toMatchObject({ on: 'MOVE', moveNth: 3 });
    expect(kayn?.statics[0]).toMatchObject({
      restrict: 'NO_DAMAGE',
      when: { kind: 'MOVES_AT_LEAST', n: 2 },
    });
  });

  it('a standard move to a battlefield is counted on the unit', () => {
    // Tests Rule 144: a standard move
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ganker', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [u],
      destination: { kind: 'battlefield', battlefieldId: 'bf0' },
    });
    expect(sc.obj(u).moves).toEqual({ turn: sc.state.turn.number, n: 1 });
  });

  it('only the third move scores, and the count starts over each turn', () => {
    // Tests Rule 583.3: "the third time I move in a turn"
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ganker', 'bf0');
    const moveEvent = (): GameEvent =>
      ({ seq: 1, type: 'UNIT_MOVED', unitId: u, from: 'base', to: 'bf0' }) as GameEvent;
    const fire = (): number => {
      const s = structuredClone(sc.state);
      countMove(s, sc.cards, s.objects[u] as CardInstance);
      return fireTriggers(s, sc.cards, [moveEvent()]).state.flow.chain.length;
    };
    const s1 = structuredClone(sc.state);
    countMove(s1, sc.cards, s1.objects[u] as CardInstance);
    countMove(s1, sc.cards, s1.objects[u] as CardInstance);
    expect(fireTriggers(s1, sc.cards, [moveEvent()]).state.flow.chain).toHaveLength(0);
    countMove(s1, sc.cards, s1.objects[u] as CardInstance);
    expect(fireTriggers(s1, sc.cards, [moveEvent()]).state.flow.chain).toHaveLength(1);
    expect(fire()).toBe(0); // a single move this turn is not the third
  });

  it('takes no damage after two moves this turn, and normal damage before', () => {
    // Tests Rule 583.3: a static ability with a "moved twice this turn" condition
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ganker', 'bf0');
    const s = structuredClone(sc.state);
    const o = s.objects[u] as CardInstance;
    expect(applyDamageMods(s, sc.cards, o, 2, { kind: 'COMBAT' })).toBe(2);
    countMove(s, sc.cards, o);
    expect(applyDamageMods(s, sc.cards, o, 2, { kind: 'COMBAT' })).toBe(2);
    countMove(s, sc.cards, o);
    expect(applyDamageMods(s, sc.cards, o, 2, { kind: 'COMBAT' })).toBe(0);
    expect(applyDamageMods(s, sc.cards, o, 2, { kind: 'EFFECT', controller: 'p1' })).toBe(0);
  });
});

describe('scenario: gear "When this leaves the board" (Treasure Trove, Scrapheap)', () => {
  it('parses both heads', () => {
    // Tests Rule 583.3: triggered abilities on a gear leaving the board
    const tt = parseCardAbilities(
      'When this leaves the board, draw 1 and channel 1 rune exhausted.',
      { gearLike: true },
    );
    expect(tt?.triggers[0]).toMatchObject({ on: 'GEAR_LEAVES' });
    const sp = parseCardAbilities('When this is played, discarded, or killed, draw 1.', {
      gearLike: true,
    });
    expect(sp?.triggers.map((t) => t.on)).toEqual(['PLAY', 'DISCARD_SELF', 'GEAR_LEAVES']);
  });

  it('a killed gear draws its controller a card', () => {
    // Tests Rule 583.3: the gear triggers from the Trash after being killed
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ember-totem': {
        ...base('fx-ember-totem'),
        triggers: [{ on: 'GEAR_LEAVES', effects: [{ op: 'DRAW', amount: 1 }] }],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    const before = sc.player('p0').hand.length;
    const s = structuredClone(sc.state);
    const out = runEffects(s, 'p0', [{ op: 'KILL_ALL_GEAR' }], sc.cards);
    const events = out.map((e, i) => ({ ...e, seq: i + 1 }) as GameEvent);
    sc.state = fireTriggers(s, sc.cards, events).state;
    for (let k = 0; k < 6 && sc.state.flow.chain.length > 0; k++) {
      sc.pass(sc.state.flow.priority as PlayerId);
    }
    expect(sc.player('p0').hand.length).toBe(before + 1);
  });
});

describe('scenario: "When a friendly unit attacks alone, give it +1 [M]" (Mask of Foresight)', () => {
  const mask = parseCardAbilities(
    'When a friendly unit attacks or defends alone, give it +1 [M] this turn.',
    { gearLike: true },
  );
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    ...TOKEN_CARDS,
    'fx-ember-totem': { ...base('fx-ember-totem'), triggers: mask?.triggers ?? [] },
  };
  const attack = (withMate: boolean): { buffed: number; chain: number } => {
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    const u = sc.putUnit('p0', 'fx-grunt', 'base');
    if (withMate) sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const ids = withMate
      ? [
          u,
          Object.keys(sc.state.objects).find(
            (k) => sc.state.objects[k]?.cardId === 'fx-ash-tank',
          ) as string,
        ]
      : [u];
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: ids,
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    const chain = sc.state.flow.chain.length;
    for (let k = 0; k < 8 && sc.state.flow.chain.length > 0; k++) {
      sc.pass(sc.state.flow.priority as PlayerId);
    }
    return { buffed: sc.obj(u).mightBonus ?? 0, chain };
  };

  it('parses the head with its unit filter', () => {
    // Tests Rule 583.3: a triggered ability on a unit attacking
    expect(mask?.triggers[0]).toMatchObject({
      on: 'UNIT_ATTACKS',
      unitFilter: { side: 'friendly', alone: true },
      effects: [{ op: 'BUFF_TARGET', amount: 1, side: 'friendly' }],
    });
  });

  it('buffs a unit that attacks alone, but not one that attacks with a mate', () => {
    // Tests Rule 583.3: "alone" means no other friendly unit in the combat
    const alone = attack(false);
    expect(alone.chain).toBeGreaterThan(0);
    expect(alone.buffed).toBe(1);
    expect(attack(true).buffed).toBe(0);
  });
});

describe('scenario: "Your [Deathknell] effects trigger an additional time" (Karthus)', () => {
  const kar = parseStaticLines('Your [Deathknell] effects trigger an additional time.');
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-ember-totem': { ...base('fx-ember-totem'), statics: kar?.statics ?? [] },
    'fx-grunt': {
      ...base('fx-grunt'),
      triggers: [{ on: 'DEATH', effects: [{ op: 'DRAW', amount: 1 }] }],
    },
  };
  const chainAfterDeath = (withKarthus: boolean): number => {
    const sc = Scenario.start({}, cards);
    if (withKarthus) sc.putUnit('p0', 'fx-ember-totem', 'base');
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    const s = structuredClone(sc.state);
    const o = s.objects[g] as CardInstance;
    s.players[0].base = s.players[0].base.filter((x) => x !== g);
    s.players[0].trash.push(g);
    o.zone = { kind: 'trash', player: 'p0' };
    const ev = {
      seq: 1,
      type: 'UNIT_KILLED',
      unitId: g,
      controller: 'p0',
      cardId: 'fx-grunt',
      at: 'base',
      alone: true,
    } as GameEvent;
    return fireTriggers(s, sc.cards, [ev]).state.flow.chain.length;
  };

  it('parses as a static marker', () => {
    // Tests Rule 726: Deathknell triggers when the unit dies
    expect(kar?.statics[0]).toMatchObject({ affects: 'SELF', doubleDeathknell: true });
  });

  it('a Deathknell triggers twice while the card is on the board, once otherwise', () => {
    // Tests Rule 726: an additional trigger of a Deathknell
    expect(chainAfterDeath(false)).toBe(1);
    expect(chainAfterDeath(true)).toBe(2);
  });
});

describe('scenario: "I cost [2] less to play from anywhere other than your hand" (Void Drone)', () => {
  const parsedCost = parseSelfCostReduction(
    'I cost [2] less to play from anywhere other than your hand.',
  );
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-titan': {
      ...base('fx-titan'),
      ...(parsedCost ? { costReduction: parsedCost.reduction } : {}),
    },
  };

  it('parses to a not-in-hand condition', () => {
    // Tests Rule 156: a cost reduction that depends on where the card is played from
    expect(parsedCost?.reduction).toEqual({ energy: 2, when: { kind: 'NOT_IN_HAND' } });
  });

  it('gives no discount from the hand, and the discount from the Trash', () => {
    // Tests Rule 156: reductions apply while the card is played from another zone
    const sc = Scenario.start({}, cards);
    const id = sc.putInHand('p0', 'fx-titan');
    const def = cards['fx-titan'] as CardDef;
    expect(selfEnergyDiscount(sc.state, cards, 'p0', def, id)).toBe(0);
    const s = structuredClone(sc.state);
    const o = s.objects[id] as CardInstance;
    s.players[0].hand = s.players[0].hand.filter((x) => x !== id);
    s.players[0].trash.push(id);
    o.zone = { kind: 'trash', player: 'p0' };
    expect(selfEnergyDiscount(s, cards, 'p0', def, id)).toBe(2);
  });
});
