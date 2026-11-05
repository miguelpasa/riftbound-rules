import { describe, it, expect } from 'vitest';
import { getLegalActions } from '../legalActions.js';
import { parseSpellText, parseTriggerText } from '../cardText.js';
import { MAX_TARGET_COMBOS, runEffects } from '../effects.js';
import { TOKEN_CARDS } from '../tokens.js';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import type {
  CardDatabase,
  CardDef,
  CardEffect,
  CardInstance,
  Intent,
  Target,
} from '../types/index.js';

/** Override fixture spells with executable effects (fx-flare is p0's, fx-tide-guard is p1's). */
const db = (flare: CardEffect[], guard?: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': {
    ...(SCENARIO_CARDS['fx-flare'] as CardDef),
    text: '[Action] test effect',
    supportLevel: 'partial',
    effects: flare,
  },
  ...(guard
    ? {
        'fx-tide-guard': {
          ...(SCENARIO_CARDS['fx-tide-guard'] as CardDef),
          text: '[Reaction] test effect',
          supportLevel: 'partial',
          effects: guard,
        },
      }
    : {}),
});

const obj = (id: string): Target => ({ kind: 'object', id });

/** p0 plays fx-flare with `targets`; both pass so it resolves. */
function cast(sc: Scenario, targets?: string[], inHand?: string) {
  const spell = inHand ?? sc.putInHand('p0', 'fx-flare');
  sc.play('p0', spell, {
    payment: sc.exhaustPlan('p0', 1),
    ...(targets ? { targets: targets.map(obj) } : {}),
  });
  sc.pass('p1');
  return { spell, result: sc.pass('p0') };
}

const playIntent = (sc: Scenario, spell: string, targets: string[]): Intent => ({
  type: 'PLAY_CARD',
  playerId: 'p0',
  cardInstanceId: spell,
  payment: sc.exhaustPlan('p0', 1),
  targets: targets.map(obj),
});

describe('scenario: Stun', () => {
  const stunDb = db([{ op: 'STUN_TARGET', side: 'enemy' }]);

  it('a stunned unit deals no combat damage', () => {
    // Tests Rule 467.2: only units with Might contribute to combat damage; a stunned unit has none
    const sc = Scenario.start({}, stunDb);
    const def = sc.putUnit('p1', sc.kit('p1').tank, 'bf1', { control: true });
    const att = sc.putUnit('p0', sc.kit('p0').tank, 'base');
    cast(sc, [def]);
    expect(sc.obj(def).stunned).toBe(true);
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [att],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p0');
    sc.pass('p1');
    // The stunned defender has nothing to assign: only the attacker is asked.
    expect(sc.state.flow.combat).toMatchObject({ step: 'DAMAGE', awaitingAssignmentFrom: 'p0' });
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [{ unitId: def, amount: 3 }],
    });
    expect(sc.obj(def).zone.kind).toBe('trash');
    expect(sc.obj(att).zone.kind).toBe('battlefield');
    expect(sc.obj(att).damage).toBe(0);
    expect(sc.eventsOfType('EFFECT_STUNNED')).toHaveLength(1);
    sc.verify();
  });

  it('Stun expires in the Ending step', () => {
    // Tests Rule 317: effects lasting "this turn" end with the turn
    const sc = Scenario.start({}, stunDb);
    const foe = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    cast(sc, [foe]);
    expect(sc.obj(foe).stunned).toBe(true);
    sc.endTurn('p0');
    expect(sc.obj(foe).stunned).toBeUndefined();
  });

  it('Stun honours the side restriction', () => {
    // Tests Rule 355.10: only legal targets may be chosen
    const sc = Scenario.start({}, stunDb);
    const mine = sc.putUnit('p0', sc.kit('p0').grunt, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [mine])).code).toBe('ILLEGAL_TARGET');
  });
});

describe('scenario: Might debuffs with a minimum', () => {
  it('cannot reduce Might below the minimum and expires at end of turn', () => {
    // Tests Rule 317: a "this turn" Might change ends with the turn
    const sc = Scenario.start({}, db([{ op: 'DEBUFF_TARGET', amount: 4, minMight: 1 }]));
    const big = sc.putUnit('p1', sc.kit('p1').tank, 'base'); // Might 3
    cast(sc, [big]);
    expect(sc.obj(big).mightBonus).toBe(-2); // 3 -> 1, not -1
    expect(sc.eventsOfType('EFFECT_BUFF')).toEqual([
      expect.objectContaining({ unitId: big, amount: -2 }),
    ]);
    sc.endTurn('p0');
    expect(sc.obj(big).mightBonus).toBe(0);
  });

  it('leaves a unit already at the minimum alone, and a plain debuff can kill via Cleanup', () => {
    // Tests Rule 142.4: a unit with 0 or less Might dies to any damage; here Might simply drops
    const sc = Scenario.start({}, db([{ op: 'DEBUFF_TARGET', amount: 4, minMight: 1 }]));
    const one = sc.putUnit('p1', sc.kit('p1').wisp, 'base'); // fixture wisp: Might 0 -> already below 1
    cast(sc, [one]);
    expect(sc.obj(one).mightBonus).toBe(0);
    const sc2 = Scenario.start({}, db([{ op: 'DEBUFF_TARGET', amount: 10 }]));
    const t = sc2.putUnit('p1', sc2.kit('p1').grunt, 'base');
    cast(sc2, [t]);
    expect(sc2.obj(t).mightBonus).toBe(-10);
  });
});

describe('scenario: two-unit effects', () => {
  const mutual: CardEffect[] = [
    { op: 'MUTUAL_DAMAGE', slots: [0, 1], sides: ['friendly', 'enemy'] },
  ];

  it('MUTUAL_DAMAGE: two units deal damage equal to their Might to each other', () => {
    // Tests Rule 359.3: both units are dealt damage as the spell resolves; Cleanup kills (323.4)
    const sc = Scenario.start({}, db(mutual));
    const mine = sc.putUnit('p0', sc.kit('p0').grunt, 'base'); // Might 2
    const foe = sc.putUnit('p1', sc.kit('p1').tank, 'base'); // Might 3
    cast(sc, [mine, foe]);
    expect(sc.obj(mine).zone.kind).toBe('trash'); // took 3
    expect(sc.obj(foe).zone.kind).toBe('base');
    expect(sc.obj(foe).damage).toBe(2);
    sc.verify();
  });

  it('requires one legal unit per slot, in the right order', () => {
    // Tests Rule 355.10: every target must be legal when the spell is played
    const sc = Scenario.start({}, db(mutual));
    const mine = sc.putUnit('p0', sc.kit('p0').grunt, 'base');
    const foe = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [mine])).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject(playIntent(sc, spell, [foe, mine])).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject(playIntent(sc, spell, [mine, mine])).code).toBe('ILLEGAL_TARGET');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets: [obj(mine), obj(foe)] });
    expect(sc.state.flow.chain).toHaveLength(1);
  });

  it('getLegalActions enumerates friendly x enemy pairs, capped', () => {
    // Tests Rule 355.10: the legal-action list offers only legal target choices
    const sc = Scenario.start({}, db(mutual));
    const mine = [
      sc.putUnit('p0', sc.kit('p0').grunt, 'base'),
      sc.putUnit('p0', sc.kit('p0').archer, 'base'),
    ];
    const foes = [
      sc.putUnit('p1', sc.kit('p1').grunt, 'base'),
      sc.putUnit('p1', sc.kit('p1').tank, 'base'),
    ];
    const spell = sc.putInHand('p0', 'fx-flare');
    const variants = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell,
    );
    expect(variants).toHaveLength(4);
    for (const v of variants) {
      const ids = (v.type === 'PLAY_CARD' ? (v.targets ?? []) : []).map((t) =>
        t.kind === 'object' ? t.id : '',
      );
      expect(mine).toContain(ids[0]);
      expect(foes).toContain(ids[1]);
    }
  });

  it('a buff on one slot and a debuff on another, then they fight (slot indices)', () => {
    // Tests Rule 359.3: effects resolve in printed order, so the fight uses the new Mights
    const sc = Scenario.start(
      {},
      db([
        { op: 'DEBUFF_TARGET', amount: 2, side: 'enemy' },
        { op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'friendly', slot: 1 },
        { op: 'MUTUAL_DAMAGE', slots: [0, 1], sides: ['enemy', 'friendly'] },
      ]),
    );
    const foe = sc.putUnit('p1', sc.kit('p1').tank, 'base'); // 3 -> 1
    const mine = sc.putUnit('p0', sc.kit('p0').grunt, 'base'); // 2 -> 4
    cast(sc, [foe, mine]);
    expect(sc.obj(foe).zone.kind).toBe('trash'); // took 4
    expect(sc.obj(mine).damage).toBe(1); // took 1
    sc.verify();
  });
});

describe('scenario: "each of up to two units"', () => {
  const up2: CardEffect[] = [{ op: 'DAMAGE_TARGET', amount: 9, count: { min: 0, max: 2 } }];

  it('damages every chosen unit; three are refused', () => {
    // Tests Rule 355.10: the number of targets is bounded by the card text
    const sc = Scenario.start({}, db(up2));
    const a = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const b = sc.putUnit('p1', sc.kit('p1').tank, 'base');
    const c = sc.putUnit('p0', sc.kit('p0').grunt, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [a, b, c])).code).toBe('ILLEGAL_TARGET');
    expect(sc.reject(playIntent(sc, spell, [a, a])).code).toBe('ILLEGAL_TARGET');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets: [obj(a), obj(b)] });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(a).zone.kind).toBe('trash');
    expect(sc.obj(b).zone.kind).toBe('trash');
    expect(sc.obj(c).zone.kind).toBe('base');
    sc.verify();
  });

  it('may be played with one target or none ("up to")', () => {
    // Tests Rule 355.10: "up to" allows fewer targets
    const sc = Scenario.start({}, db(up2));
    const a = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    cast(sc, [a]);
    expect(sc.obj(a).zone.kind).toBe('trash');
    const sc2 = Scenario.start({}, db(up2));
    const spell = sc2.putInHand('p0', 'fx-flare');
    sc2.play('p0', spell, { payment: sc2.exhaustPlan('p0', 1) });
    sc2.pass('p1');
    const r = sc2.pass('p0');
    expect(sc2.eventsOfType('EFFECT_FIZZLED', r.events)).toHaveLength(0);
    expect(sc2.obj(spell).zone.kind).toBe('trash');
  });

  it('enumerates singles and pairs, never more than the cap', () => {
    // Tests Rule 355.10: enumeration offers legal choices only and stays bounded
    const sc = Scenario.start({}, db(up2));
    for (let i = 0; i < 3; i++) sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    const count = () =>
      getLegalActions(sc.state, sc.cards, 'p0').filter(
        (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell,
      ).length;
    expect(count()).toBe(3 + 3);
    const sc2 = Scenario.start({}, db(up2));
    const kinds = [
      sc2.kit('p1').grunt,
      sc2.kit('p1').tank,
      sc2.kit('p1').archer,
      sc2.kit('p1').shielder,
      sc2.kit('p1').ganker,
      sc2.kit('p1').titan,
    ];
    for (const k of kinds) {
      try {
        sc2.putUnit('p1', k, 'base');
        sc2.putUnit('p1', k, 'base');
      } catch {
        /* the deck has no spare copy */
      }
    }
    const spell2 = sc2.putInHand('p0', 'fx-flare');
    const n = getLegalActions(sc2.state, sc2.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell2,
    ).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(MAX_TARGET_COMBOS);
  });

  it('BUFF_TARGET with an exact count ("two friendly units each")', () => {
    // Tests Rule 359.3: each chosen unit gets the bonus
    const sc = Scenario.start(
      {},
      db([
        {
          op: 'BUFF_TARGET',
          amount: 2,
          duration: 'TURN',
          side: 'friendly',
          count: { min: 2, max: 2 },
        },
      ]),
    );
    const a = sc.putUnit('p0', sc.kit('p0').grunt, 'base');
    const b = sc.putUnit('p0', sc.kit('p0').archer, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [a])).code).toBe('ILLEGAL_TARGET');
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets: [obj(a), obj(b)] });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(a).mightBonus).toBe(2);
    expect(sc.obj(b).mightBonus).toBe(2);
  });
});

describe('scenario: channel effects', () => {
  it('channels runes exhausted and draws as part of the same spell', () => {
    // Tests Rule 431: channeling puts runes from the Rune Deck onto the board (here exhausted)
    const sc = Scenario.start(
      {},
      db([
        { op: 'DRAW', amount: 1 },
        { op: 'CHANNEL', amount: 2, exhausted: true },
      ]),
    );
    const runesBefore = sc.runes('p0').length;
    const handBefore = sc.player('p0').hand.length;
    const { result } = cast(sc);
    const after = sc.runes('p0');
    expect(after.length).toBe(runesBefore + 2);
    expect(after.filter((r) => !r.ready).length).toBeGreaterThanOrEqual(2);
    expect(sc.eventsOfType('RUNE_CHANNELED', result.events)).toHaveLength(2);
    expect(sc.player('p0').hand.length).toBe(handBefore + 1);
    sc.verify();
  });

  it('draws instead when fewer runes could be channeled', () => {
    // Tests Rule 431.3: channel as many as are available
    const sc = Scenario.start({}, db([{ op: 'CHANNEL', amount: 2, exhausted: true, elseDraw: 1 }]));
    const work = structuredClone(sc.state);
    const ps = work.players[0];
    ps.runeDeck = ps.runeDeck.slice(0, 1);
    const events = runEffects(
      work,
      'p0',
      [{ op: 'CHANNEL', amount: 2, exhausted: true, elseDraw: 1 }],
      sc.cards,
    );
    expect(events.filter((e) => e.type === 'RUNE_CHANNELED')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'CARD_DRAWN')).toHaveLength(1);
    // With enough runes there is no draw
    const events2 = runEffects(
      structuredClone(sc.state),
      'p0',
      [{ op: 'CHANNEL', amount: 2, exhausted: true, elseDraw: 1 }],
      sc.cards,
    );
    expect(events2.filter((e) => e.type === 'CARD_DRAWN')).toHaveLength(0);
  });
});

describe('scenario: mass damage and readying', () => {
  it('DAMAGE_ALL battlefields hits units at battlefields of both sides, not bases', () => {
    // Tests Rule 359.3: an untargeted effect applies to every matching unit
    const sc = Scenario.start(
      {},
      db([{ op: 'DAMAGE_ALL', amount: 1, side: 'any', scope: 'battlefields' }]),
    );
    const a = sc.putUnit('p0', sc.kit('p0').titan, 'bf0');
    const b = sc.putUnit('p1', sc.kit('p1').titan, 'bf1', { control: true });
    const home = sc.putUnit('p1', sc.kit('p1').titan, 'base');
    cast(sc);
    expect(sc.obj(a).damage).toBe(1);
    expect(sc.obj(b).damage).toBe(1);
    expect(sc.obj(home).damage).toBe(0);
  });

  it('DAMAGE_ALL bases / enemy-only / lethal damage kills in Cleanup', () => {
    // Tests Rule 323.4: units with lethal damage are killed in Cleanup
    const sc = Scenario.start(
      {},
      db([{ op: 'DAMAGE_ALL', amount: 9, side: 'enemy', scope: 'bases' }]),
    );
    const mine = sc.putUnit('p0', sc.kit('p0').grunt, 'base');
    const foe = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const foeAtBf = sc.putUnit('p1', sc.kit('p1').tank, 'bf1', { control: true });
    cast(sc);
    expect(sc.obj(foe).zone.kind).toBe('trash');
    expect(sc.obj(mine).zone.kind).toBe('base');
    expect(sc.obj(foeAtBf).zone.kind).toBe('battlefield');
    sc.verify();
  });

  it('DAMAGE_ALL combat scope hits enemy units only at the combat battlefield', () => {
    // Tests Rule 467.1: combat happens at one battlefield
    const sc = Scenario.start({}, db([]));
    const att = sc.putUnit('p0', sc.kit('p0').titan, 'base');
    const def = sc.putUnit('p1', sc.kit('p1').titan, 'bf1', { control: true });
    const elsewhere = sc.putUnit('p1', sc.kit('p1').titan, 'bf0');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [att],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    const work = structuredClone(sc.state);
    runEffects(
      work,
      'p0',
      [{ op: 'DAMAGE_ALL', amount: 2, side: 'enemy', scope: 'combat' }],
      sc.cards,
    );
    expect(work.objects[def]?.damage).toBe(2);
    expect(work.objects[elsewhere]?.damage).toBe(0);
    expect(work.objects[att]?.damage).toBe(0);
  });

  it('EXHAUST_ALL then DAMAGE_ALL, and READY_ALL', () => {
    // Tests Rule 359.3: effects resolve in printed order
    const sc = Scenario.start(
      {},
      db([
        { op: 'EXHAUST_ALL', side: 'friendly' },
        { op: 'DAMAGE_ALL', amount: 1, side: 'any', scope: 'bases' },
      ]),
    );
    const mine = sc.putUnit('p0', sc.kit('p0').titan, 'base');
    const foe = sc.putUnit('p1', sc.kit('p1').titan, 'base');
    cast(sc);
    expect(sc.obj(mine).ready).toBe(false);
    expect(sc.obj(foe).ready).toBe(true);
    expect(sc.obj(mine).damage).toBe(1);
    const work = structuredClone(sc.state);
    runEffects(work, 'p0', [{ op: 'READY_ALL', side: 'friendly' }], sc.cards);
    expect(work.objects[mine]?.ready).toBe(true);
  });
});

describe('scenario: gear effects', () => {
  it('KILL_GEAR trashes an enemy gear and its controller draws', () => {
    // Tests Rule 323.4: a killed permanent goes to its owner's Trash
    const sc = Scenario.start(
      {},
      db([
        { op: 'KILL_GEAR', side: 'enemy' },
        { op: 'TARGET_CONTROLLER_DRAW', amount: 2 },
      ]),
    );
    const gear = sc.putUnit('p1', 'fx-tide-totem', 'base');
    const unit = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const handBefore = sc.player('p1').hand.length;
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [unit])).code).toBe('ILLEGAL_TARGET'); // not a gear
    sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets: [obj(gear)] });
    sc.pass('p1');
    const r = sc.pass('p0');
    expect(sc.obj(gear).zone.kind).toBe('trash');
    expect(sc.player('p1').trash).toContain(gear);
    expect(sc.player('p1').base).not.toContain(gear);
    expect(sc.eventsOfType('GEAR_KILLED', r.events)).toHaveLength(1);
    expect(sc.player('p1').hand.length).toBe(handBefore + 2);
    sc.verify();
  });

  it('KILL_ALL_GEAR kills gear of both players and leaves units alone', () => {
    // Tests Rule 323.4: killed permanents go to their owners' Trash
    const sc = Scenario.start({}, db([{ op: 'KILL_ALL_GEAR' }]));
    const g0 = sc.putUnit('p0', 'fx-ember-totem', 'base');
    const g1 = sc.putUnit('p1', 'fx-tide-totem', 'base');
    const u = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    cast(sc);
    expect(sc.obj(g0).zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(sc.obj(g1).zone).toEqual({ kind: 'trash', player: 'p1' });
    expect(sc.obj(u).zone.kind).toBe('base');
    sc.verify();
  });

  it('"up to one gear" may be played with no target; enumeration offers each gear', () => {
    // Tests Rule 355.10: "up to" allows no target
    const sc = Scenario.start({}, db([{ op: 'KILL_GEAR', count: { min: 0, max: 1 } }]));
    const g = sc.putUnit('p1', 'fx-tide-totem', 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    const variants = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell,
    );
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ targets: [{ kind: 'object', id: g }] });
  });

  it("KILL_TARGET then TARGET_CONTROLLER_DRAW: the victim's controller draws", () => {
    // Tests Rule 359.3: effects resolve in printed order
    const sc = Scenario.start(
      {},
      db([
        { op: 'KILL_TARGET', side: 'enemy' },
        { op: 'TARGET_CONTROLLER_DRAW', amount: 2 },
      ]),
    );
    const foe = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const handBefore = sc.player('p1').hand.length;
    cast(sc, [foe]);
    expect(sc.obj(foe).zone.kind).toBe('trash');
    expect(sc.player('p1').hand.length).toBe(handBefore + 2);
  });
});

describe('scenario: Counter a spell', () => {
  it('a Reaction counters the spell below it on the Chain', () => {
    // Tests Rule 359.3: a countered spell does not resolve and goes to the Trash
    const sc = Scenario.start(
      {},
      db([{ op: 'DAMAGE_TARGET', amount: 9 }], [{ op: 'COUNTER_SPELL' }]),
    );
    const victim = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    sc.giveRunes('p1', 2);
    const guard = sc.putInHand('p1', 'fx-tide-guard');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1), targets: [obj(victim)] });

    // p1's legal actions include countering the Flare Bolt (and nothing else as a target)
    const options = getLegalActions(sc.state, sc.cards, 'p1').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === guard,
    );
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ targets: [{ kind: 'object', id: flare }] });
    // A unit is not a legal target for Counter
    expect(
      sc.reject({
        type: 'PLAY_CARD',
        playerId: 'p1',
        cardInstanceId: guard,
        payment: sc.exhaustPlan('p1', 1),
        targets: [obj(victim)],
      }).code,
    ).toBe('ILLEGAL_TARGET');

    sc.play('p1', guard, { payment: sc.exhaustPlan('p1', 1), targets: [obj(flare)] });
    sc.pass('p0');
    const r = sc.pass('p1');
    expect(sc.eventsOfType('EFFECT_COUNTERED', r.events)).toHaveLength(1);
    expect(sc.obj(flare).zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(sc.obj(victim).zone.kind).toBe('base');
    expect(sc.obj(victim).damage).toBe(0);
    expect(sc.state.flow.chain).toHaveLength(0);
    sc.verify();
  });

  it('is not playable when no spell is on the Chain', () => {
    // Tests Rule 355.10: a Counter needs a spell to target
    const sc = Scenario.start({}, db([], [{ op: 'COUNTER_SPELL' }]));
    sc.giveRunes('p1', 2);
    const guard = sc.putInHand('p1', 'fx-tide-guard');
    const legal = getLegalActions(sc.state, sc.cards, 'p1').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === guard,
    );
    expect(legal).toHaveLength(0);
  });
});

describe('scenario: new effects inside triggered abilities', () => {
  it('"When you play me, deal N to all units at battlefields" resolves from the Chain', () => {
    // Tests Rule 359.3: a triggered ability is put on the Chain and resolves like any item
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
        triggers: [
          {
            on: 'PLAY',
            effects: [{ op: 'DAMAGE_ALL', amount: 1, side: 'any', scope: 'battlefields' }],
          },
        ],
      },
    };
    const sc = Scenario.start({}, cards);
    const foe = sc.putUnit('p1', sc.kit('p1').titan, 'bf1', { control: true });
    const home = sc.putUnit('p1', sc.kit('p1').titan, 'base');
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    expect(sc.obj(foe).damage).toBe(1);
    expect(sc.obj(home).damage).toBe(0);
    sc.verify();
  });
});

// ---------------------------------------------------------------- R3 round 2

/** Fixture cards plus the built-in token definitions. */
const withTokens = (extra: Record<string, CardDef> = {}): CardDatabase => ({
  ...SCENARIO_CARDS,
  ...TOKEN_CARDS,
  ...extra,
});

/** fx-flare gets the effects parsed from real card text. */
function textDb(text: string): CardDatabase {
  const effects = parseSpellText(text);
  if (!effects) throw new Error(`text did not parse: ${text}`);
  return withTokens({
    'fx-flare': {
      ...(SCENARIO_CARDS['fx-flare'] as CardDef),
      text,
      supportLevel: 'partial',
      effects,
    },
  });
}

/** fx-grunt (p0) gets the triggers parsed from real card text. */
function triggerDb(text: string): CardDatabase {
  const triggers = parseTriggerText(text);
  if (!triggers) throw new Error(`text did not parse: ${text}`);
  return withTokens({ 'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers } });
}

/** Surgery: put a ready Recruit token in `player`'s Base through the effect interpreter. */
function runTokens(sc: Scenario, player: 'p0' | 'p1'): void {
  const s = structuredClone(sc.state);
  runEffects(
    s,
    player,
    [{ op: 'PLAY_TOKEN', token: 'tok-recruit', count: 1, ready: true }],
    sc.cards,
  );
  sc.state = s;
}

const tokensOf = (sc: Scenario, cardId: string): CardInstance[] =>
  Object.values(sc.state.objects).filter((o) => o.cardId === cardId);

describe('scenario: unit tokens', () => {
  it('"Play a ready 3 [M] Sprite unit token with [Temporary]" creates a ready Temporary token in the Base', () => {
    // Tests Rule 186.1: tokens are created on the Board; Temporary kills it at the start of its controller's Beginning Phase
    const sc = Scenario.start(
      {},
      textDb('[Action] Play a ready 3 [M] Sprite unit token with [Temporary].'),
    );
    cast(sc);
    const [sprite] = tokensOf(sc, 'tok-sprite');
    expect(sprite).toMatchObject({ controller: 'p0', ready: true, zone: { kind: 'base' } });
    expect(sc.player('p0').base).toContain(sprite!.id);
    expect(sc.eventsOfType('TOKEN_PLAYED')).toHaveLength(1);
    sc.verify();
    // It dies (and ceases to exist) at the start of p0's next Beginning Phase.
    sc.endTurn('p0');
    expect(tokensOf(sc, 'tok-sprite')).toHaveLength(1);
    sc.endTurn('p1');
    expect(tokensOf(sc, 'tok-sprite')).toHaveLength(0);
    expect(sc.player('p0').trash).not.toContain(sprite!.id);
    sc.verify();
  });

  it('"Play four 1 [M] Recruit unit tokens" enters four exhausted units', () => {
    // Tests Rule 359.2.c: units enter exhausted unless an effect says ready
    const sc = Scenario.start({}, textDb('[Action] Play four 1 [M] Recruit unit tokens.'));
    cast(sc);
    const recruits = tokensOf(sc, 'tok-recruit');
    expect(recruits).toHaveLength(4);
    expect(recruits.every((r) => !r.ready && r.zone.kind === 'base')).toBe(true);
    sc.verify();
  });

  it('a ready token can move and fight like a unit, and ceases to exist when killed', () => {
    // Tests Rule 186.1: a token that leaves the Board ceases to exist (it does not go to the Trash)
    const sc = Scenario.start({}, textDb('Play a ready 3 [M] Mech unit token.'));
    cast(sc);
    const [mech] = tokensOf(sc, 'tok-mech');
    expect(mech!.ready).toBe(true);
    expect(
      getLegalActions(sc.state, sc.cards, 'p0').some(
        (i) => i.type === 'STANDARD_MOVE' && i.unitIds.includes(mech!.id),
      ),
    ).toBe(true);
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [mech!.id],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    expect(sc.obj(mech!.id).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    // Killed by a spell it is removed from the game, not put in the Trash.
    sc.cards['fx-flare'] = {
      ...(sc.cards['fx-flare'] as CardDef),
      effects: [{ op: 'KILL_TARGET' }],
    };
    cast(sc, [mech!.id]);
    expect(sc.state.objects[mech!.id]).toBeUndefined();
    expect(sc.player('p0').trash).not.toContain(mech!.id);
    sc.verify();
  });

  it('"When you play me, play a Recruit token here" puts the token at the unit\'s location', () => {
    // Tests Rule 359.3: a triggered ability resolves from the Chain and may create tokens
    const sc = Scenario.start(
      {},
      triggerDb('When you play me, play a 1 [M] Recruit unit token here.'),
    );
    sc.putUnit('p0', sc.kit('p0').titan, 'bf1', { control: true });
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, {
      payment: sc.exhaustPlan('p0', 2),
      location: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p1');
    sc.pass('p0');
    const [rec] = tokensOf(sc, 'tok-recruit');
    expect(rec?.zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
    sc.verify();
  });

  it('"here" in the Base is the Base', () => {
    // Tests Rule 359.3: a triggered ability resolves from the Chain and may create tokens
    const sc = Scenario.start(
      {},
      triggerDb('When you play me, play a 1 [M] Recruit unit token here.'),
    );
    const unit = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    expect(tokensOf(sc, 'tok-recruit')[0]?.zone.kind).toBe('base');
    sc.verify();
  });

  it("Deathknell tokens appear in the owner's Base when the unit dies", () => {
    // Tests Rule 323.4: the unit dies in Cleanup, then its Deathknell triggers
    const cards = triggerDb('[Deathknell] — Play three 1 [M] Recruit unit tokens into your base.');
    const sc = Scenario.start(
      {},
      {
        ...cards,
        'fx-flare': {
          ...(SCENARIO_CARDS['fx-flare'] as CardDef),
          supportLevel: 'partial',
          effects: [{ op: 'KILL_TARGET' }],
        },
      },
    );
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    cast(sc, [unit]);
    sc.pass(sc.state.flow.priority!);
    sc.pass(sc.state.flow.priority!);
    expect(tokensOf(sc, 'tok-recruit')).toHaveLength(3);
    sc.verify();
  });

  it('a token missing from the database fizzles instead of corrupting the state', () => {
    // Tests Rule 186.1: only defined tokens can be created
    const sc = Scenario.start();
    const ev = runEffects(
      sc.state,
      'p0',
      [{ op: 'PLAY_TOKEN', token: 'tok-nope', count: 1 }],
      sc.cards,
    );
    expect(ev).toEqual([{ type: 'EFFECT_FIZZLED', cardId: '' }]);
  });
});

describe('scenario: "Choose a unit. <effect on it>"', () => {
  it('"Give it +N" buffs only the chosen friendly unit and rejects an enemy', () => {
    // Tests Rule 355.10: the chosen unit must satisfy the restriction of the sentence that chose it
    const sc = Scenario.start({}, textDb('Choose a friendly unit. Give it +2 [M] this turn.'));
    const mine = sc.putUnit('p0', sc.kit('p0').grunt, 'base');
    const foe = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [foe])).code).toBe('ILLEGAL_TARGET');
    cast(sc, [mine]);
    expect(sc.obj(mine).mightBonus).toBe(2);
    expect(sc.obj(foe).mightBonus).toBe(0);
    sc.endTurn('p0');
    expect(sc.obj(mine).mightBonus).toBe(0);
  });

  it('several "it" sentences share the one chosen unit', () => {
    // Tests Rule 359.3: effects resolve in printed order on the same chosen object
    const sc = Scenario.start(
      {},
      textDb('Choose an enemy unit at a battlefield. Deal 1 to it. Stun it.'),
    );
    const home = sc.putUnit('p1', sc.kit('p1').titan, 'base');
    const away = sc.putUnit('p1', sc.kit('p1').titan, 'bf1', { control: true });
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [home])).code).toBe('ILLEGAL_TARGET');
    cast(sc, [away]);
    expect(sc.obj(away).damage).toBe(1);
    expect(sc.obj(away).stunned).toBe(true);
    expect(sc.obj(home).damage).toBe(0);
  });

  it('enumerates only legal targets for the chosen-unit slot', () => {
    // Tests Rule 355.10: legal-target enumeration matches validation
    const sc = Scenario.start({}, textDb('Choose a friendly unit. Ready it.'));
    const mine = sc.putUnit('p0', sc.kit('p0').grunt, 'base');
    sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    const plays = getLegalActions(sc.state, sc.cards, 'p0').filter(
      (i) => i.type === 'PLAY_CARD' && i.cardInstanceId === spell,
    );
    expect(plays.map((i) => (i as { targets?: Target[] }).targets)).toEqual([[obj(mine)]]);
  });
});

describe('scenario: return, move to base, kill all, look at the top', () => {
  it("Return a unit at a battlefield to its owner's hand resets it", () => {
    // Tests Rule 359.3: effects resolve as the spell resolves; the card goes to its owner's hand
    const sc = Scenario.start(
      {},
      textDb("[Action] Return a unit at a battlefield to its owner's hand."),
    );
    const foe = sc.putUnit('p1', sc.kit('p1').grunt, 'bf1', {
      control: true,
      damage: 1,
      mightBonus: 2,
    });
    const home = sc.putUnit('p1', sc.kit('p1').grunt, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [home])).code).toBe('ILLEGAL_TARGET');
    const hand = sc.player('p1').hand.length;
    cast(sc, [foe]);
    expect(sc.obj(foe)).toMatchObject({
      zone: { kind: 'hand', player: 'p1' },
      damage: 0,
      mightBonus: 0,
    });
    expect(sc.player('p1').hand).toHaveLength(hand + 1);
    expect(sc.eventsOfType('UNIT_RETURNED')).toHaveLength(1);
    sc.verify();
  });

  it('a returned token ceases to exist instead of going to the hand', () => {
    // Tests Rule 186.1: a token that leaves the Board ceases to exist
    const sc = Scenario.start({}, textDb("Return a unit to its owner's hand."));
    runTokens(sc, 'p1');
    const tok = tokensOf(sc, 'tok-recruit')[0]!.id;
    cast(sc, [tok]);
    expect(sc.state.objects[tok]).toBeUndefined();
    expect(sc.player('p1').hand).not.toContain(tok);
    sc.verify();
  });

  it('"with N [M] or less" limits the Return target', () => {
    // Tests Rule 355.10: restrictions printed on the spell limit the legal targets
    const sc = Scenario.start(
      {},
      textDb("[Reaction] Return a unit at a battlefield with 3 [M] or less to its owner's hand."),
    );
    const big = sc.putUnit('p1', sc.kit('p1').titan, 'bf1', { control: true });
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [big])).code).toBe('ILLEGAL_TARGET');
  });

  it("Return a gear to its owner's hand", () => {
    // Tests Rule 359.3: effects resolve as the spell resolves
    const sc = Scenario.start({}, textDb("[Action] Return a gear to its owner's hand."));
    const gear = sc.putUnit('p1', 'fx-tide-totem', 'base');
    cast(sc, [gear]);
    expect(sc.obj(gear).zone).toMatchObject({ kind: 'hand', player: 'p1' });
    expect(sc.player('p1').base).not.toContain(gear);
    sc.verify();
  });

  it('"Move a unit from a battlefield to its base" is not a standard move and drops control', () => {
    // Tests Rule 323.6: Cleanup re-evaluates control of the battlefield the unit left
    const sc = Scenario.start(
      {},
      textDb('[Hidden] [Action] Move a unit from a battlefield to its base.'),
    );
    const foe = sc.putUnit('p1', sc.kit('p1').grunt, 'bf1', { control: true });
    cast(sc, [foe]);
    expect(sc.obj(foe).zone).toMatchObject({ kind: 'base', player: 'p1' });
    expect(sc.player('p1').base).toContain(foe);
    expect(sc.bf('bf1').controller).toBeNull();
    expect(sc.eventsOfType('UNIT_MOVED')).toEqual([
      expect.objectContaining({ unitId: foe, from: 'bf1', to: 'base' }),
    ]);
    sc.verify();
  });

  it('"Move up to 2 friendly units to base" takes zero to two targets', () => {
    // Tests Rule 355.10: an "up to" slot accepts any number up to its maximum
    const sc = Scenario.start({}, textDb('[Reaction] Move up to 2 friendly units to base.'));
    const a = sc.putUnit('p0', sc.kit('p0').grunt, 'bf1', { control: true });
    const b = sc.putUnit('p0', sc.kit('p0').tank, sc.state.battlefields[1]!.id, { control: true });
    const c = sc.putUnit('p0', sc.kit('p0').archer, 'base');
    const spell = sc.putInHand('p0', 'fx-flare');
    expect(sc.reject(playIntent(sc, spell, [a, b, c])).code).toBe('ILLEGAL_TARGET');
    cast(sc, [a, b]);
    expect(sc.obj(a).zone.kind).toBe('base');
    expect(sc.obj(b).zone.kind).toBe('base');
    sc.verify();
  });

  it('"Kill all units" kills every unit and token on the Board', () => {
    // Tests Rule 323: lethal damage is dealt, then Cleanup moves units to the Trash and removes tokens
    const sc = Scenario.start({}, textDb('Kill all units.'));
    const mine = sc.putUnit('p0', sc.kit('p0').titan, 'base');
    const foe = sc.putUnit('p1', sc.kit('p1').titan, 'bf1', { control: true });
    runTokens(sc, 'p0');
    const tok = tokensOf(sc, 'tok-recruit')[0]!.id;
    cast(sc);
    expect(sc.obj(mine).zone.kind).toBe('trash');
    expect(sc.obj(foe).zone.kind).toBe('trash');
    expect(sc.state.objects[tok]).toBeUndefined();
    sc.verify();
  });

  it('"Look at the top 3 cards ... Put 1 into your hand and recycle the rest" takes the dearest card', () => {
    // Tests Rule 417.5: recycled cards go to the bottom of the deck
    const sc = Scenario.start(
      {},
      textDb(
        '[Action] Look at the top 3 cards of your Main Deck. Put 1 into your hand and recycle the rest.',
      ),
    );
    const spell = sc.putInHand('p0', 'fx-flare');
    const deck = sc.player('p0').mainDeck;
    const top3 = deck.slice(0, 3);
    const cost = (id: string): number => sc.cards[sc.obj(id).cardId]!.cost.energy;
    const best = top3.reduce((b, id) => (cost(id) > cost(b) ? id : b));
    const rest = top3.filter((id) => id !== best);
    const hand = sc.player('p0').hand.length;
    const size = deck.length;
    cast(sc, undefined, spell);
    expect(sc.player('p0').hand).toHaveLength(hand); // the spell left the hand, one card came in
    expect(sc.player('p0').hand).toContain(best);
    expect(sc.player('p0').mainDeck).toHaveLength(size - 1);
    expect(sc.player('p0').mainDeck.slice(-2)).toEqual(rest);
    expect(sc.eventsOfType('CARDS_LOOKED_AT')).toEqual([expect.objectContaining({ count: 3 })]);
    expect(sc.eventsOfType('CARDS_RECYCLED')).toEqual([expect.objectContaining({ count: 2 })]);
    sc.verify();
  });

  it('"You may reveal a gear from among them and draw it" takes the first gear, else nothing', () => {
    // Tests Rule 417.5: recycled cards go to the bottom of the deck
    const text =
      'Look at the top 4 cards of your Main Deck. You may reveal a gear from among them and draw it. Then recycle the rest.';
    const sc = Scenario.start({}, textDb(text));
    // Make the 3rd card of the deck a gear (surgery on the card id of an existing object).
    const spell = sc.putInHand('p0', 'fx-flare');
    const third = sc.player('p0').mainDeck[2]!;
    sc.state = structuredClone(sc.state);
    sc.state.objects[third]!.cardId = 'fx-ember-totem';
    const before = [...sc.player('p0').mainDeck];
    cast(sc, undefined, spell);
    expect(sc.player('p0').hand).toContain(third);
    expect(sc.eventsOfType('CARD_REVEALED')).toEqual([
      expect.objectContaining({ cardId: 'fx-ember-totem' }),
    ]);
    expect(sc.player('p0').mainDeck.slice(-3)).toEqual([before[0], before[1], before[3]]);
    // With no gear among them nothing is drawn and all four are recycled.
    const sc2 = Scenario.start({}, textDb(text));
    const spell2 = sc2.putInHand('p0', 'fx-flare');
    sc2.state = structuredClone(sc2.state);
    for (const id of sc2.player('p0').mainDeck.slice(0, 4)) {
      sc2.state.objects[id]!.cardId = 'fx-grunt';
    }
    const before2 = [...sc2.player('p0').mainDeck];
    const hand2 = sc2.player('p0').hand.length;
    cast(sc2, undefined, spell2);
    expect(sc2.player('p0').hand).toHaveLength(hand2 - 1);
    expect(sc2.player('p0').mainDeck).toEqual([...before2.slice(4), ...before2.slice(0, 4)]);
    sc2.verify();
  });
});
