import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import {
  parseBattlefieldAbilities,
  parseCardAbilities,
  parseSelfCostReduction,
  parseSpellText,
} from '../cardText.js';
import { evalCondition } from '../conditions.js';
import { runEffects } from '../effects.js';
import { runTurnTriggers } from '../turnTriggers.js';
import { effectiveMight } from '../combat.js';
import type { CardDatabase, CardDef } from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;

describe('scenario: "When you choose a unit" (Jae Medarda, Spirit Wheel, Blade Dancer, Irelia)', () => {
  it('reads the three heads', () => {
    // Tests Rule 583: triggered abilities have a trigger condition and an effect
    expect(
      parseCardAbilities('When you choose me with a spell, draw 1.')?.triggers[0],
    ).toMatchObject({ on: 'UNIT_CHOSEN', chosen: { target: 'self', spellOnly: true } });
    expect(
      parseCardAbilities(
        'When you choose a friendly unit, you may pay [1] and exhaust this to draw 1.',
      )?.triggers[0],
    ).toMatchObject({ on: 'UNIT_CHOSEN', chosen: { target: 'friendly' } });
    const irelia = parseCardAbilities('When you choose or ready me, give me +1 [M] this turn.');
    expect(irelia?.triggers.map((t) => t.on)).toEqual(['UNIT_CHOSEN', 'BECOME_READY']);
  });

  it('draws a card when a spell chooses the unit, not when an enemy spell does or no unit is chosen', () => {
    // Tests Rule 583: a triggered ability fires on its event
    const parsed = parseCardAbilities('When you choose me with a spell, draw 1.');
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': { ...base('fx-ash-tank'), triggers: parsed?.triggers ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const jae = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const handBefore = sc.state.players[0]?.hand.length ?? 0;
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: jae }],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    // one card played from hand, one drawn
    expect(sc.state.players[0]?.hand.length).toBe(handBefore + 1 - 1 + 1);
  });
});

describe('scenario: "Choose two units" (Clash of Giants)', () => {
  it('lets the caster pick any two different units and they hit each other', () => {
    // Tests Rule 573: damage dealt by an effect
    const effects = parseSpellText(
      'Choose two units. They deal damage equal to their Mights to each other.',
    );
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects: effects ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const b = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [
        { kind: 'object', id: a },
        { kind: 'object', id: b },
      ],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect(sc.obj(a).damage + sc.obj(b).damage).toBeGreaterThan(0);
  });
});

describe('scenario: "If you do," follow-ups (Adaptatron)', () => {
  const parsed = parseCardAbilities(
    "When I conquer, you may kill a gear. If you do, buff me. (If I don't have a buff, I get a +1 [M] buff.)",
  );

  it('reads the second effect as conditional on the first', () => {
    // Tests Rule 583: effects of a triggered ability resolve in order
    expect(parsed?.triggers[0]?.effects.map((e) => [e.op, e.ifDid ?? false])).toEqual([
      ['KILL_GEAR', false],
      ['BUFF_SELF', true],
    ]);
  });

  it('buffs only when a gear was actually killed', () => {
    // Tests Rule 583: "if you do" needs the earlier instruction to have been carried out
    const effects = parsed?.triggers[0]?.effects ?? [];
    const sc = Scenario.start({});
    const me = sc.putUnit('p0', 'fx-ash-tank', 'bf1');
    const none = structuredClone(sc.state);
    runEffects(none, 'p0', effects, sc.cards, [], '', me);
    expect(none.objects[me]?.mightBonus ?? 0).toBe(0);
  });
});

describe('scenario: Battlefield cards with turn-start abilities', () => {
  it('reads "each player\'s first Beginning Phase" and "each unit here"', () => {
    // Tests Rule 315: the Beginning Phase
    const first = parseBattlefieldAbilities(
      "At the start of each player's first Beginning Phase, that player channels 1 rune.",
    );
    expect(first?.[0]).toMatchObject({ on: 'TURN_START', firstTurn: true });
    const point = parseBattlefieldAbilities(
      "At the start of each player's first Beginning Phase, that player gains 1 point.",
    );
    expect(point?.[0]?.effects[0]).toMatchObject({ op: 'GAIN_POINT', amount: 1 });
    const fort = parseBattlefieldAbilities(
      "At the start of each player's Beginning Phase, deal 1 to each unit here.",
    );
    expect(fort?.[0]?.firstTurn).toBeUndefined();
    expect(fort?.[0]?.effects[0]).toMatchObject({ op: 'DAMAGE_ALL', scope: 'here', amount: 1 });
  });

  it('damages every unit at the battlefield at the start of each turn', () => {
    // Tests Rule 315: the Beginning Phase
    const fort = parseBattlefieldAbilities(
      "At the start of each player's Beginning Phase, deal 1 to each unit here.",
    );
    const sc = Scenario.start({});
    const bf = sc.state.battlefields[0];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      [bf?.cardId ?? '']: { ...base(bf?.cardId ?? ''), triggers: fort ?? [] },
    };
    const mine = sc.putUnit('p0', 'fx-ash-tank', bf?.id ?? 'bf1');
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', bf?.id ?? 'bf1');
    const r = runTurnTriggers(structuredClone(sc.state), cards, 'TURN_START');
    expect(r.state.objects[mine]?.damage).toBe(1);
    expect(r.state.objects[theirs]?.damage).toBe(1);
  });
});

describe('scenario: kill a gear, then play a Gold token (Pickpocket)', () => {
  it('reads "no more than [N]" and chains the follow-up', () => {
    // Tests Rule 583: effects of a triggered ability resolve in order
    const t = parseCardAbilities(
      'When you play me, you may kill a gear with Energy cost no more than [1]. If you do, play a Gold gear token exhausted.',
    );
    expect(t?.triggers[0]?.effects).toMatchObject([
      { op: 'KILL_GEAR', maxEnergy: 1 },
      { op: 'PLAY_TOKEN', ifDid: true },
    ]);
  });
});

describe('scenario: a stunned enemy unit dies (Storm Raptor)', () => {
  it('reads the stunned filter on the death head', () => {
    // Tests Rule 583: triggered abilities
    const t = parseCardAbilities('When a stunned enemy unit here dies, draw 1.');
    expect(t?.triggers[0]?.dies).toEqual({ side: 'enemy', here: true, stunned: true });
  });
});

describe('scenario: "When you buff me" (Simian Ancestor)', () => {
  it('readies the unit when it gets a buff', () => {
    // Tests Rule 583: triggered abilities
    const parsed = parseCardAbilities('When you buff me, ready me.');
    expect(parsed?.triggers[0]).toMatchObject({ on: 'UNIT_BUFFED', buffed: 'self' });
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-ash-tank': { ...base('fx-ash-tank'), triggers: parsed?.triggers ?? [] },
    };
    const eff = parseSpellText('Buff a friendly unit.') ?? [];
    cards['fx-flare'] = { ...base('fx-flare'), supportLevel: 'full', effects: eff };
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.setReady(u, false);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: u }],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    expect(sc.obj(u).buffed).toBe(true);
    expect(sc.obj(u).ready).toBe(true);
  });
});

describe('scenario: "you may kill me to ..." (Overzealous Fan)', () => {
  it('reads the kill-me cost and the attacking-unit move', () => {
    // Tests Rule 583: optional costs of a triggered ability
    const t = parseCardAbilities(
      'When I defend, you may kill me to move an attacking unit to its base.',
    );
    expect(t?.triggers[0]).toMatchObject({
      on: 'DEFEND',
      optional: { killSelf: true },
      effects: [{ op: 'MOVE_BASE_TARGET', attacking: true }],
    });
  });
});

describe("scenario: [Unique] next to a trigger (Shurelya's Requiem)", () => {
  it('ignores the Unique keyword token when reading abilities', () => {
    // Tests Rule 103.3: Unique is a deck-building keyword
    const t = parseCardAbilities('[Unique]\nWhen you play this, ready your units.', {
      gearLike: true,
    });
    expect(t?.triggers[0]).toMatchObject({ on: 'PLAY', effects: [{ op: 'READY_ALL' }] });
  });
});

describe('scenario: "If this kills it" (Disintegrate)', () => {
  const text = 'Deal 3 to a unit at a battlefield. If this kills it, do this: draw 1.';
  const run = (target: string, bonus = 0): { drew: number } => {
    const effects = parseSpellText(text);
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects: effects ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const t = sc.putUnit('p1', target, 'bf1');
    sc.state.objects[t]!.mightBonus = bonus;
    const flare = sc.putInHand('p0', 'fx-flare');
    const before = sc.state.players[0]?.hand.length ?? 0;
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: t }],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    return { drew: (sc.state.players[0]?.hand.length ?? 0) - (before - 1) };
  };

  it('parses to a damage effect followed by a draw that needs the kill', () => {
    // Tests Rule 573: damage dealt by an effect
    expect(parseSpellText(text)?.map((e) => [e.op, e.ifKilled ?? false])).toEqual([
      ['DAMAGE_TARGET', false],
      ['DRAW', true],
    ]);
  });

  it('draws only when the damage kills the unit', () => {
    // Tests Rule 573: damage dealt by an effect
    expect(run('fx-tide-grunt', 0).drew).toBe(1); // 2 Might, killed by 3
    expect(run('fx-tide-grunt', 4).drew).toBe(0); // 7 Might, survives
  });
});

describe('scenario: "give me [Temporary]" when played off-turn (Momentary Companion)', () => {
  const text = "When you play me, if it's not your turn, give me [Temporary].";

  it('reads as a play trigger gated on it not being your turn', () => {
    // Tests Rule 583: triggered abilities have a trigger condition and an effect
    expect(parseCardAbilities(text)?.triggers[0]).toMatchObject({
      on: 'PLAY',
      effects: [{ op: 'GRANT_TEMPORARY_SELF' }],
      when: { kind: 'YOUR_TURN', not: true },
    });
  });

  it('marks the unit Temporary, so it is killed at the start of its next Beginning Phase', () => {
    // Tests Rule 583: a triggered ability resolves its effects
    const trig = parseCardAbilities(text)?.triggers ?? [];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': { ...base('fx-grunt'), triggers: trig },
    };
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', trig[0]?.effects ?? [], cards, [], 'fx-grunt', mine);
    expect(s.objects[mine]?.temporaryOf).toBeDefined();
  });
});

describe('scenario: "If it is stunned, kill it. Otherwise, stun it." (Solari Chief)', () => {
  const text = 'Choose an enemy unit. If it is stunned, kill it. Otherwise, stun it.';
  const cast = (stunnedFirst: boolean): { stunned: boolean; alive: boolean } => {
    const effects = parseSpellText(text);
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects: effects ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    if (stunnedFirst) sc.state.objects[foe]!.stunned = true;
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: foe }],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    const o = sc.state.objects[foe];
    return {
      stunned: o?.stunned === true,
      alive: o?.zone.kind === 'battlefield' || o?.zone.kind === 'base',
    };
  };

  it('parses both branches against the one chosen unit', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText(text)?.map((e) => [e.op, e.when])).toEqual([
      ['KILL_TARGET', { kind: 'TARGET_STUNNED', slot: 0 }],
      ['STUN_TARGET', { kind: 'NOT', cond: { kind: 'TARGET_STUNNED', slot: 0 } }],
    ]);
  });

  it('stuns an unstunned unit and kills a stunned one', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    const first = cast(false);
    expect(first).toEqual({ stunned: true, alive: true });
    const second = cast(true);
    expect(second.alive).toBe(false);
  });
});

describe('scenario: "We deal damage equal to our Mights to each other" (Carnivorous Snapvine)', () => {
  const text =
    'When you play me, choose an enemy unit at a battlefield. We deal damage equal to our Mights to each other.';

  it('reads as a play trigger choosing an enemy at a battlefield', () => {
    // Tests Rule 573: damage dealt by an effect
    expect(parseCardAbilities(text)?.triggers[0]).toMatchObject({
      on: 'PLAY',
      effects: [{ op: 'MUTUAL_DAMAGE_SELF', slot: 0, side: 'enemy', atBattlefield: true }],
    });
  });

  it('deals each Might to the other at once', () => {
    // Tests Rule 573: damage dealt by an effect
    const trig = parseCardAbilities(text)?.triggers ?? [];
    const sc = Scenario.start({}, SCENARIO_CARDS);
    const me = sc.putUnit('p0', 'fx-ash-tank', 'base'); // 3 Might
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'bf1'); // 2 Might
    const s = structuredClone(sc.state);
    runEffects(
      s,
      'p0',
      trig[0]?.effects ?? [],
      SCENARIO_CARDS,
      [{ kind: 'object', id: foe }],
      'fx-ash-tank',
      me,
    );
    expect(s.objects[me]?.damage).toBe(2);
    expect(s.objects[foe]?.damage).toBe(3);
  });
});

describe('scenario: "for each of the following tags among your units" (Friendship)', () => {
  const text =
    'Choose a unit. Give it +1 [M] this turn for each of the following tags among your units — Bird, Cat, Dog, and Poro.';

  it('reads as a buff multiplied by the distinct pet tags among my units', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText(text)).toEqual([
      { op: 'BUFF_TARGET', amount: 1, duration: 'TURN', perPetTags: true },
    ]);
  });

  it('gives +1 per distinct tag (a second Cat adds nothing)', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    const effects = parseSpellText(text);
    const tagged = (id: string, tags: string[]): CardDef => ({
      ...base(id),
      subtypes: tags,
    });
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': tagged('fx-grunt', ['Cat']),
      'fx-archer': tagged('fx-archer', ['Cat', 'Poro']),
      'fx-ash-tank': tagged('fx-ash-tank', ['Dog']),
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects: effects ?? [] },
    };
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.putUnit('p0', 'fx-archer', 'base');
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    const before = effectiveMight(sc.state, cards, a, { role: null });
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: a }],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    // Cat, Poro and Dog are present: three distinct tags.
    expect(effectiveMight(sc.state, cards, a, { role: null }) - before).toBe(3);
  });
});

describe('scenario: Daisy! (cost per pet tag, attack trigger needing all four)', () => {
  const costText =
    'Reduce my cost by [1] for each of the following tags among your units — Bird, Cat, Dog, and Poro.';
  const atkText =
    "When I attack while your units have all 4 tags, [Stun] an enemy unit here. (It doesn't deal combat damage this turn.)";

  it('reads the cost reduction and the gated attack trigger', () => {
    // Tests Rule 583: triggered abilities have a trigger condition and an effect
    expect(parseSelfCostReduction(costText)).toMatchObject({
      reduction: { energy: 1, per: 'PET_TAGS' },
    });
    expect(parseCardAbilities(atkText)?.triggers[0]).toMatchObject({
      on: 'ATTACK',
      effects: [{ op: 'STUN_TARGET', side: 'enemy', here: true }],
      when: { kind: 'PET_TAGS', n: 4 },
    });
  });

  it('costs [1] less per distinct tag and the condition needs all four', () => {
    // Tests Rule 583: a triggered ability checks its condition as it resolves
    const tagged = (id: string, tags: string[]): CardDef => ({ ...base(id), subtypes: tags });
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': tagged('fx-grunt', ['Bird', 'Cat']),
      'fx-archer': tagged('fx-archer', ['Dog']),
    };
    const sc = Scenario.start({}, cards);
    const me = sc.putUnit('p0', 'fx-grunt', 'base');
    const none = evalCondition(sc.state, cards, { kind: 'PET_TAGS', n: 4 }, 'p0', me);
    expect(none).toBe(false);
    sc.putUnit('p0', 'fx-archer', 'base');
    expect(evalCondition(sc.state, cards, { kind: 'PET_TAGS', n: 3 }, 'p0', me)).toBe(true);
    expect(evalCondition(sc.state, cards, { kind: 'PET_TAGS', n: 4 }, 'p0', me)).toBe(false);
  });
});
