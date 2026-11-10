import { describe, it, expect } from 'vitest';
import { Scenario, SCENARIO_CARDS } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { enumerateSpellTargets, spellTargetsLegal } from '../effects.js';
import { parseSpellText } from '../cardText.js';
import { TOKEN_CARDS } from '../tokens.js';
import type {
  CardDatabase,
  CardDef,
  CardEffect,
  CardInstance,
  GameState,
  PlayerId,
  Target,
} from '../types/index.js';

const bf = (battlefieldId: string): Target => ({ kind: 'battlefield', battlefieldId });
const obj = (id: string): Target => ({ kind: 'object', id });

const spellWith = (effects: CardEffect[]): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-flare': { ...(SCENARIO_CARDS['fx-flare'] as CardDef), supportLevel: 'partial', effects },
});

/** Cast fx-flare with `targets`, then let both players pass until the Chain is empty. */
function cast(sc: Scenario, targets: Target[]): void {
  sc.giveRunes('p0', 4);
  const spell = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', spell, { payment: sc.exhaustPlan('p0', 1), targets });
  for (let k = 0; k < 8 && sc.state.flow.chain.length > 0; k++) {
    sc.pass(sc.state.flow.priority as PlayerId);
  }
}

describe('parser: choose a battlefield and move spells', () => {
  it('reads Siphon Power, For Demacia!, Charm and Ride the Wind', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(
      parseSpellText(
        'Choose a battlefield. Give friendly units there +1 [M] this turn and enemy units there -1 [M] this turn, to a minimum of 1 [M].',
      ),
    ).toEqual([{ op: 'BF_AREA', slot: 0, friendlyMight: 1, enemyMight: 1, minMight: 1 }]);
    expect(
      parseSpellText('Choose a battlefield. Give friendly units there [Shield 2] this turn.'),
    ).toEqual([{ op: 'BF_AREA', slot: 0, keywords: [{ name: 'Shield', value: 2 }] }]);
    expect(parseSpellText('Move an enemy unit.')).toEqual([
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, side: 'enemy' },
    ]);
    expect(parseSpellText('Move a friendly unit and ready it.')).toEqual([
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, side: 'friendly', ready: true },
    ]);
  });
});

describe('scenario: a chosen battlefield (Siphon Power, For Demacia!)', () => {
  it('buffs friendly units there, shrinks enemy units there to a minimum, and leaves others alone', () => {
    // Tests Rule 355.10: the battlefield is a chosen target
    const cards = spellWith([
      { op: 'BF_AREA', slot: 0, friendlyMight: 1, enemyMight: 5, minMight: 1 },
    ]);
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    const away = sc.putUnit('p0', 'fx-grunt', 'base');
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const printed = (id: string): number => effectiveMight(sc.state, sc.cards, id, { role: null });
    const [m0, a0] = [printed(mine), printed(away)];
    cast(sc, [bf('bf0')]);
    expect(printed(mine)).toBe(m0 + 1);
    expect(printed(away)).toBe(a0);
    expect(printed(theirs)).toBe(1); // cut by 5, but never below the minimum
  });

  it('grants a keyword to friendly units there until end of turn', () => {
    // Tests Rule 355.10: the battlefield is a chosen target
    const cards = spellWith([{ op: 'BF_AREA', slot: 0, keywords: [{ name: 'Shield', value: 2 }] }]);
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    cast(sc, [bf('bf0')]);
    expect(sc.obj(mine).tempKeywords).toEqual([{ name: 'Shield', value: 2 }]);
  });

  it('needs a battlefield target, and lists one choice per battlefield', () => {
    // Tests Rule 355.10: a spell needs its targets chosen
    const cards = spellWith([{ op: 'BF_AREA', slot: 0, friendlyMight: 1 }]);
    const sc = Scenario.start({}, cards);
    const effects = [{ op: 'BF_AREA', slot: 0, friendlyMight: 1 }] as CardEffect[];
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [])).toBe(false);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [bf('bf0')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [bf('nope')])).toBe(false);
    expect(enumerateSpellTargets(sc.state, cards, 'p0', effects)).toEqual([
      [bf('bf0')],
      [bf('bf1')],
    ]);
  });
});

describe('scenario: moving a chosen unit to a chosen location (Charm, Ride the Wind)', () => {
  const move = (ready: boolean): CardDatabase =>
    spellWith([
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, side: 'any', ...(ready ? { ready } : {}) },
    ]);

  it('moves an enemy unit to a battlefield, then another time back to its Base', () => {
    // Tests Rule 596.2.a: a unit moves when a game effect says so
    const sc = Scenario.start({}, move(false));
    const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    cast(sc, [obj(enemy), bf('bf0')]);
    expect(sc.obj(enemy).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf0' });

    const sc2 = Scenario.start({}, move(false));
    const e2 = sc2.putUnit('p1', 'fx-tide-grunt', 'bf1');
    cast(sc2, [obj(e2), bf('base')]);
    expect(sc2.obj(e2).zone).toMatchObject({ kind: 'base', player: 'p1' });
  });

  it('readies a moved friendly unit', () => {
    // Tests Rule 596.2.a: a unit moves when a game effect says so
    const sc = Scenario.start({}, move(true));
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'base', { ready: false });
    cast(sc, [obj(mine), bf('bf0')]);
    expect(sc.obj(mine).ready).toBe(true);
    expect(sc.obj(mine).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf0' });
  });

  it('cannot move a unit to where it already is, or from its Base to its Base', () => {
    // Tests Rule 596.1: moving is between two locations
    const cards = move(false);
    const sc = Scenario.start({}, cards);
    const atBf = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    const inBase = sc.putUnit('p0', 'fx-grunt', 'base');
    const effects = [{ op: 'MOVE_TARGET', slot: 0, destSlot: 1 }] as CardEffect[];
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(atBf), bf('bf0')])).toBe(false);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(atBf), bf('bf1')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(atBf), bf('base')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(inBase), bf('base')])).toBe(
      false,
    );
    const picks = enumerateSpellTargets(sc.state, cards, 'p0', effects) ?? [];
    expect(picks).toContainEqual([obj(atBf), bf('base')]);
    expect(picks).not.toContainEqual([obj(atBf), bf('bf0')]);
  });

  it('a friendly unit arriving at an enemy-held battlefield contests it', () => {
    // Tests Rule 190.3: a moved unit contests a battlefield its owner does not control
    const sc = Scenario.start({}, move(false));
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'base');
    expect(sc.bf('bf1').controller).not.toBe('p0');
    cast(sc, [obj(mine), bf('bf1')]);
    expect(sc.obj(mine).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf1' });
  });
});

describe('scenario: more battlefield and move shapes (Firestorm, Zenith Blade, Showstopper, Cataclysm)', () => {
  it('reads them from card text', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(parseSpellText('Deal 3 to all enemy units at a battlefield.')).toEqual([
      { op: 'DAMAGE_ALL', amount: 3, side: 'enemy', scope: 'chosen', slot: 0 },
    ]);
    expect(
      parseSpellText(
        "Stun an enemy unit at a battlefield. You may move a friendly unit to that enemy unit's battlefield.",
      ),
    ).toEqual([
      { op: 'STUN_TARGET', side: 'enemy', atBattlefield: true },
      {
        op: 'MOVE_TARGET',
        slot: 1,
        destSlot: -1,
        destFromSlot: 0,
        side: 'friendly',
        count: { min: 0, max: 1 },
      },
    ]);
    expect(
      parseSpellText('Buff a friendly unit in your base, then move it to a battlefield.'),
    ).toEqual([
      { op: 'BUFF_TARGET', amount: 1, buff: true, inBase: true, side: 'friendly' },
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, dest: 'BATTLEFIELD' },
    ]);
  });

  it('Firestorm damages only the enemy units at the chosen battlefield', () => {
    // Tests Rule 355.10: the battlefield is a chosen target
    const sc = Scenario.start(
      {},
      spellWith([{ op: 'DAMAGE_ALL', amount: 1, side: 'enemy', scope: 'chosen', slot: 0 }]),
    );
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    const there = sc.putUnit('p1', 'fx-order-tank', 'bf0');
    const elsewhere = sc.putUnit('p1', 'fx-tide-archer', 'bf1');
    cast(sc, [bf('bf0')]);
    expect(sc.obj(mine).damage).toBe(0);
    expect(sc.obj(there).damage).toBe(1);
    expect(sc.obj(elsewhere).damage).toBe(0);
  });

  it("Zenith Blade moves a friendly unit to the stunned unit's battlefield, or nothing if declined", () => {
    // Tests Rule 596.2.a: a unit moves when a game effect says so
    const effects: CardEffect[] = [
      { op: 'STUN_TARGET', side: 'enemy', atBattlefield: true },
      {
        op: 'MOVE_TARGET',
        slot: 1,
        destSlot: -1,
        destFromSlot: 0,
        side: 'friendly',
        count: { min: 0, max: 1 },
      },
    ];
    const run = (withMove: boolean): { zone: string; stunned: boolean } => {
      const sc = Scenario.start({}, spellWith(effects));
      const enemy = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
      const mine = sc.putUnit('p0', 'fx-ash-tank', 'base');
      cast(sc, withMove ? [obj(enemy), obj(mine)] : [obj(enemy)]);
      return { zone: sc.obj(mine).zone.kind, stunned: sc.obj(enemy).stunned === true };
    };
    expect(run(true)).toEqual({ zone: 'battlefield', stunned: true });
    expect(run(false)).toEqual({ zone: 'base', stunned: true });
  });

  it('Showstopper buffs a unit in the Base and moves it to a battlefield', () => {
    // Tests Rule 596.2.a: a unit moves when a game effect says so
    const effects: CardEffect[] = [
      { op: 'BUFF_TARGET', amount: 1, buff: true, inBase: true, side: 'friendly' },
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, dest: 'BATTLEFIELD' },
    ];
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const inBase = sc.putUnit('p0', 'fx-grunt', 'base');
    const atBf = sc.putUnit('p0', 'fx-ash-tank', 'bf0');
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(atBf), bf('bf1')])).toBe(false);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(inBase), bf('base')])).toBe(
      false,
    );
    cast(sc, [obj(inBase), bf('bf0')]);
    expect(sc.obj(inBase).buffed).toBe(true);
    expect(sc.obj(inBase).zone).toMatchObject({ kind: 'battlefield', battlefieldId: 'bf0' });
  });

  it('Cataclysm needs an occupied enemy battlefield', () => {
    // Tests Rule 596.1: moving is between two locations
    const effects: CardEffect[] = [
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, side: 'friendly', dest: 'ENEMY_OCCUPIED' },
    ];
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'base');
    sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(mine), bf('bf1')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(mine), bf('bf0')])).toBe(false);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(mine), bf('base')])).toBe(false);
  });
});

describe('scenario: "Move a unit with 3 [M] or less" (Twilight Step)', () => {
  const effects = parseSpellText('Move a unit with 3 [M] or less.') ?? [];

  it('reads the Might limit onto the move', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toEqual([{ op: 'MOVE_TARGET', slot: 0, destSlot: 1, maxMight: 3 }]);
  });

  it('refuses a unit with more Might than the limit', () => {
    // Tests Rule 355.10: a target must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const small = sc.putUnit('p0', 'fx-grunt', 'base');
    const big = sc.putUnit('p0', 'fx-titan', 'base');
    expect(effectiveMight(sc.state, cards, small, { role: null })).toBeLessThanOrEqual(3);
    expect(effectiveMight(sc.state, cards, big, { role: null })).toBeGreaterThan(3);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(small), bf('bf0')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(big), bf('bf0')])).toBe(false);
  });
});

describe('scenario: "Move an enemy unit that moved this turn" (Siren\'s Song)', () => {
  const effects = parseSpellText('Move an enemy unit that moved this turn.') ?? [];

  it('reads the moved-this-turn limit onto the move', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toEqual([
      { op: 'MOVE_TARGET', slot: 0, destSlot: 1, side: 'enemy', movedThisTurn: true },
    ]);
  });

  it('only a unit that moved this turn can be chosen', () => {
    // Tests Rule 355.10: a target must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const mover = sc.putUnit('p0', 'fx-grunt', 'base');
    const idle = sc.putUnit('p0', 'fx-archer', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [mover],
      destination: { kind: 'battlefield', battlefieldId: 'bf0' },
    });
    expect(spellTargetsLegal(sc.state, cards, 'p1', effects, [obj(mover), bf('base')])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p1', effects, [obj(idle), bf('bf1')])).toBe(false);
  });
});

describe('scenario: "If it has 3 [M] or less, banish it. Otherwise, return it" (Wind and Ghosts)', () => {
  const text =
    "Choose a unit at a battlefield. If it has 3 [M] or less, banish it. Otherwise, return it to its owner's hand.";
  const effects = parseSpellText(text) ?? [];

  it("reads a banish gated on the chosen unit's Might and the opposite return", () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      {
        op: 'BANISH_TARGET',
        atBattlefield: true,
        when: { kind: 'TARGET_MIGHT', slot: 0, max: 3 },
      },
      {
        op: 'RETURN_TARGET',
        when: { kind: 'NOT', cond: { kind: 'TARGET_MIGHT', slot: 0, max: 3 } },
      },
    ]);
  });

  it("banishes a small unit and returns a big one to its owner's hand", () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen unit
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const small = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    expect(effectiveMight(sc.state, cards, small, { role: null })).toBeLessThanOrEqual(3);
    cast(sc, [obj(small)]);
    expect(sc.obj(small).zone).toMatchObject({ kind: 'banishment', player: 'p1' });
    expect(sc.state.players[1]?.banishment).toContain(small);

    const sc2 = Scenario.start({}, cards);
    const big = sc2.putUnit('p0', 'fx-titan', 'bf0');
    expect(effectiveMight(sc2.state, cards, big, { role: null })).toBeGreaterThan(3);
    cast(sc2, [obj(big)]);
    expect(sc2.obj(big).zone).toMatchObject({ kind: 'hand', player: 'p0' });
  });
});

describe("scenario: damage equal to a chosen friendly gear's Energy cost (Improvised Projectile)", () => {
  const text =
    'Choose a friendly gear. Deal damage equal to its Energy cost to a unit at a battlefield.';
  const effects = parseSpellText(text) ?? [];

  it('reads the gear choice and the damage read from it', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      {
        op: 'DAMAGE_TARGET',
        amount: 0,
        amountFrom: 'SLOT_ENERGY',
        amountSlot: 0,
        slot: 1,
        atBattlefield: true,
      },
    ]);
  });

  it("deals the gear's Energy cost to the chosen unit", () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const totem = sc.putUnit('p0', 'fx-ember-totem', 'base'); // Energy cost 2
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    sc.state.objects[foe]!.mightBonus = 9; // survives
    cast(sc, [obj(totem), obj(foe)]);
    expect(sc.obj(foe).damage).toBe(2);
  });

  it('needs a friendly gear, not a unit', () => {
    // Tests Rule 355.10: a target must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(mine), obj(foe)])).toBe(false);
  });
});

describe('scenario: "Choose a friendly unit. Kill an enemy unit with less Might than it." (Public Execution)', () => {
  const text = 'Choose a friendly unit. Kill an enemy unit with less Might than it.';
  const effects = parseSpellText(text) ?? [];

  it('reads the kill with its relation to the first chosen unit', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'KILL_TARGET', side: 'enemy', slot: 1, lessMightThanSlot: 0 },
    ]);
  });

  it('only an enemy with less Might than the friendly unit is a legal pair', () => {
    // Tests Rule 355.10: a target must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const small = sc.putUnit('p0', 'fx-grunt', 'base');
    const big = sc.putUnit('p0', 'fx-titan', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const mine = (id: string) => effectiveMight(sc.state, cards, id, { role: null });
    expect(mine(small)).toBeLessThanOrEqual(mine(foe));
    expect(mine(big)).toBeGreaterThan(mine(foe));
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(big), obj(foe)])).toBe(true);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(small), obj(foe)])).toBe(false);
    const picks = enumerateSpellTargets(sc.state, cards, 'p0', effects) ?? [];
    expect(picks).toContainEqual([obj(big), obj(foe)]);
    expect(picks).not.toContainEqual([obj(small), obj(foe)]);
  });

  it('kills the weaker enemy', () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const big = sc.putUnit('p0', 'fx-titan', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    cast(sc, [obj(big), obj(foe)]);
    expect(sc.obj(foe).zone.kind).toBe('trash');
  });
});

describe("scenario: damage equal to a chosen unit's [Shield] (Ntofo Strikes)", () => {
  const text =
    'Give a friendly unit [Shield 2] this turn, then deal damage equal to its [Shield] to an enemy unit.';
  const effects = parseSpellText(text) ?? [];

  it('reads the grant, then damage read from the same unit', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'GRANT_KEYWORD_TARGET', keywords: [{ name: 'Shield', value: 2 }], side: 'friendly' },
      {
        op: 'DAMAGE_TARGET',
        amount: 0,
        amountFrom: 'SLOT_SHIELD',
        amountSlot: 0,
        side: 'enemy',
        slot: 1,
      },
    ]);
  });

  it('adds the granted Shield to what the unit already has and deals that much', () => {
    // Tests Rule 355.10: the spell resolves its effects in order
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.state.objects[foe]!.mightBonus = 9; // survives
    sc.state.objects[mine]!.tempKeywords = [{ name: 'Shield', value: 1 }]; // already has Shield 1
    cast(sc, [obj(mine), obj(foe)]);
    expect(sc.obj(foe).damage).toBe(3);
  });
});

describe('scenario: "Kill a friendly unit. If you do, give +[M] equal to its Might to another friendly unit" (Deathgrip)', () => {
  const text =
    'Kill a friendly unit. If you do, give +[M] equal to its Might to another friendly unit this turn. Draw 1.';
  const effects = parseSpellText(text) ?? [];

  it('reads the kill, the Might transfer and the draw', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'KILL_TARGET', side: 'friendly' },
      {
        op: 'BUFF_TARGET',
        amount: 0,
        mightOfSlot: 0,
        duration: 'TURN',
        side: 'friendly',
        another: true,
        slot: 1,
        ifDid: true,
      },
      { op: 'DRAW', amount: 1 },
    ]);
  });

  it("gives the other unit the killed unit's Might for the turn and draws", () => {
    // Tests Rule 355.10: the spell resolves its effects in order
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const big = sc.putUnit('p0', 'fx-titan', 'base');
    const ally = sc.putUnit('p0', 'fx-grunt', 'base');
    const bigMight = effectiveMight(sc.state, cards, big, { role: null });
    const before = effectiveMight(sc.state, cards, ally, { role: null });
    const hand = sc.player('p0').hand.length;
    cast(sc, [obj(big), obj(ally)]);
    expect(sc.obj(big).zone.kind).toBe('trash');
    expect(effectiveMight(sc.state, cards, ally, { role: null })).toBe(before + bigMight);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
  });
});

describe('scenario: "increase its Might to the Might of another friendly unit" (Convergent Mutation)', () => {
  const text =
    'Choose a friendly unit. This turn, increase its Might to the Might of another friendly unit.';
  const effects = parseSpellText(text) ?? [];

  it('reads a buff up to the Might of a second friendly unit', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      {
        op: 'BUFF_TARGET',
        amount: 0,
        mightUpToSlot: 1,
        duration: 'TURN',
        side: 'friendly',
        slot: 0,
      },
    ]);
  });

  it("raises a weaker unit to the other unit's Might, and never lowers a stronger one", () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const small = sc.putUnit('p0', 'fx-grunt', 'base');
    const big = sc.putUnit('p0', 'fx-titan', 'base');
    const m = (id: string) => effectiveMight(sc.state, cards, id, { role: null });
    const bigMight = m(big);
    cast(sc, [obj(small), obj(big)]);
    expect(m(small)).toBe(bigMight);

    const sc2 = Scenario.start({}, cards);
    const s2 = sc2.putUnit('p0', 'fx-grunt', 'base');
    const b2 = sc2.putUnit('p0', 'fx-titan', 'base');
    const bigBefore = effectiveMight(sc2.state, cards, b2, { role: null });
    cast(sc2, [obj(b2), obj(s2)]);
    expect(effectiveMight(sc2.state, cards, b2, { role: null })).toBe(bigBefore);
  });

  it('needs two different friendly units', () => {
    // Tests Rule 355.10: a target must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(a), obj(a)])).toBe(false);
    expect(spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(a), obj(foe)])).toBe(false);
  });
});

describe('scenario: "Deal 1 to up to three units at the same location" (Bellows Breath)', () => {
  const text = 'Deal 1 to up to three units at the same location.';
  const effects = parseSpellText(text) ?? [];

  it('reads up to three units that must share a location', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'DAMAGE_TARGET', amount: 1, sameLocation: true, count: { min: 0, max: 3 } },
    ]);
  });

  it('units in one Base or at one battlefield share a location; others do not', () => {
    // Tests Rule 355.10: every pick must meet the spell's requirements together
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const b = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const c = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const ok = (ids: string[]) => spellTargetsLegal(sc.state, cards, 'p0', effects, ids.map(obj));
    expect(ok([a, b])).toBe(true); // the same Base
    expect(ok([a, c])).toBe(false); // a Base and a battlefield
    expect(ok([a, mine])).toBe(false); // two different Bases
    expect(ok([c])).toBe(true);
  });

  it('damages every chosen unit', () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const b = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.state.objects[a]!.mightBonus = 9;
    sc.state.objects[b]!.mightBonus = 9;
    cast(sc, [obj(a), obj(b)]);
    expect(sc.obj(a).damage).toBe(1);
    expect(sc.obj(b).damage).toBe(1);
  });
});

describe('scenario: a second unit "at the same battlefield" / "at its location" (Facebreaker, Heroic Charge)', () => {
  const stunBoth =
    parseSpellText('Stun a friendly unit and an enemy unit at the same battlefield.') ?? [];
  const charge =
    parseSpellText(
      'Give a friendly unit +1 [M] this turn and [Stun] an enemy unit at its location.',
    ) ?? [];

  it("reads both spells with the second unit tied to the first one's battlefield", () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(stunBoth).toMatchObject([
      { op: 'STUN_TARGET', side: 'friendly', slot: 0 },
      { op: 'STUN_TARGET', side: 'enemy', slot: 1, sameBattlefieldAsSlot: 0 },
    ]);
    expect(charge).toMatchObject([
      { op: 'BUFF_TARGET', amount: 1, side: 'friendly' },
      { op: 'STUN_TARGET', side: 'enemy', slot: 1, sameBattlefieldAsSlot: 0 },
    ]);
  });

  it('the enemy must stand at the battlefield where the friendly unit is', () => {
    // Tests Rule 355.10: a target must meet the spell's requirements
    for (const effects of [stunBoth, charge]) {
      const cards = spellWith(effects);
      const sc = Scenario.start({}, cards);
      const mine = sc.putUnit('p0', 'fx-grunt', 'bf0');
      const near = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
      const far = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
      const home = sc.putUnit('p1', 'fx-tide-grunt', 'base');
      const ok = (ids: string[]) => spellTargetsLegal(sc.state, cards, 'p0', effects, ids.map(obj));
      expect(ok([mine, near])).toBe(true);
      expect(ok([mine, far])).toBe(false);
      expect(ok([mine, home])).toBe(false);
      const picks = enumerateSpellTargets(sc.state, cards, 'p0', effects) ?? [];
      expect(picks).toContainEqual([obj(mine), obj(near)]);
      expect(picks).not.toContainEqual([obj(mine), obj(far)]);
    }
  });

  it('stuns both units', () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(stunBoth);
    const sc = Scenario.start({}, cards);
    const mine = sc.putUnit('p0', 'fx-grunt', 'bf0');
    const near = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    cast(sc, [obj(mine), obj(near)]);
    expect(sc.obj(mine).stunned).toBe(true);
    expect(sc.obj(near).stunned).toBe(true);
  });
});

describe('scenario: "Kill any number of units at a battlefield with total Might 4 or less" (Fox-Fire)', () => {
  const text = 'Kill any number of units at a battlefield with total Might 4 or less.';
  const effects = parseSpellText(text) ?? [];

  it('reads a kill of any number of units at one battlefield with a total Might limit', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      {
        op: 'KILL_TARGET',
        atBattlefield: true,
        sameBattlefield: true,
        totalMaxMight: 4,
        count: { min: 0 },
      },
    ]);
  });

  it('the chosen units must share a battlefield and add up to 4 Might or less', () => {
    // Tests Rule 355.10: every pick must meet the spell's requirements together
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p1', 'fx-tide-grunt', 'bf0'); // 2 Might
    const b = sc.putUnit('p0', 'fx-grunt', 'bf0');
    const c = sc.putUnit('p0', 'fx-titan', 'bf0'); // 7 Might
    const far = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const m = (id: string) => effectiveMight(sc.state, cards, id, { role: null });
    const ok = (ids: string[]) => spellTargetsLegal(sc.state, cards, 'p0', effects, ids.map(obj));
    expect(m(a) + m(b)).toBeLessThanOrEqual(4);
    expect(ok([a, b])).toBe(true);
    expect(ok([a, c])).toBe(false); // total too high
    expect(ok([a, far])).toBe(false); // two battlefields
    expect(ok([c])).toBe(false); // a single unit above the limit
  });

  it('kills every chosen unit', () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const b = sc.putUnit('p0', 'fx-grunt', 'bf0');
    cast(sc, [obj(a), obj(b)]);
    expect(sc.obj(a).zone.kind).toBe('trash');
    expect(sc.obj(b).zone.kind).toBe('trash');
  });
});

describe('scenario: "Return any number of enemy Order units with total Might 5 or less to their owners\' hands" (Decree of Discord)', () => {
  const text =
    "Return any number of enemy Order units with total Might 5 or less to their owners' hands.";
  const effects = parseSpellText(text) ?? [];

  it('reads a return of any number of enemy Order units limited by their total Might', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      {
        op: 'RETURN_TARGET',
        side: 'enemy',
        domain: 'Order',
        totalMaxMight: 5,
        count: { min: 0 },
      },
    ]);
  });

  it('the units must be enemy Order units whose Mights add up to 5 or less', () => {
    // Tests Rule 355.10: every pick must meet the spell's requirements together
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const tank = sc.putUnit('p1', 'fx-order-tank', 'base'); // Order, 3
    const guard = sc.putUnit('p1', 'fx-order-shielder', 'base'); // Order, 2
    const colossus = sc.putUnit('p1', 'fx-order-titan', 'base'); // Order, 7
    const scholar = sc.putUnit('p1', 'fx-tide-grunt', 'base'); // Mind, 2
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const ok = (ids: string[]) => spellTargetsLegal(sc.state, cards, 'p0', effects, ids.map(obj));
    expect(ok([tank, guard])).toBe(true);
    expect(ok([tank, colossus])).toBe(false); // too much Might
    expect(ok([guard, scholar])).toBe(false); // not Order
    expect(ok([guard, mine])).toBe(false); // not an enemy
  });

  it("returns every chosen unit to its owner's hand", () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const tank = sc.putUnit('p1', 'fx-order-tank', 'base');
    const guard = sc.putUnit('p1', 'fx-order-shielder', 'base');
    cast(sc, [obj(tank), obj(guard)]);
    expect(sc.obj(tank).zone).toMatchObject({ kind: 'hand', player: 'p1' });
    expect(sc.obj(guard).zone).toMatchObject({ kind: 'hand', player: 'p1' });
  });
});

describe('scenario: "If it\'s Empowered, disempower it. Then kill it if it has 3 [M] or less" (Lacerate)', () => {
  const text =
    "Choose a unit. If it's [Empowered], disempower it. Then kill it if it has 3 [M] or less.";
  const effects = parseSpellText(text) ?? [];

  it('reads a disempower gated on Empowered, then a kill gated on Might', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'DISEMPOWER_TARGET', when: { kind: 'TARGET_EMPOWERED', slot: 0 } },
      { op: 'KILL_TARGET', when: { kind: 'TARGET_MIGHT', slot: 0, max: 3 } },
    ]);
  });

  it('disempowers an Empowered unit and kills it only when it is small enough', () => {
    // Tests Rule 355.10: the spell resolves its effects in order on the chosen unit
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const small = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.state.objects[small]!.empowered = true;
    cast(sc, [obj(small)]);
    expect(sc.obj(small).zone.kind).toBe('trash');

    const sc2 = Scenario.start({}, cards);
    const big = sc2.putUnit('p0', 'fx-titan', 'base');
    sc2.state.objects[big]!.empowered = true;
    cast(sc2, [obj(big)]);
    expect(sc2.obj(big).empowered).toBeFalsy();
    expect(sc2.obj(big).zone.kind).toBe('base'); // 7 Might: survives

    const sc3 = Scenario.start({}, cards);
    const plain = sc3.putUnit('p0', 'fx-titan', 'base');
    cast(sc3, [obj(plain)]);
    expect(sc3.obj(plain).zone.kind).toBe('base'); // nothing to disempower, too big to kill
  });
});

describe('scenario: "Swap the Mights of two units at the same battlefield this turn" (Switcheroo)', () => {
  const text = 'Swap the Mights of two units at the same battlefield this turn.';
  const effects = parseSpellText(text) ?? [];

  it('reads a swap between two different units that share a battlefield', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([{ op: 'SWAP_MIGHT', slots: [0, 1] }]);
  });

  it('needs two different units at one battlefield', () => {
    // Tests Rule 355.10: every pick must meet the spell's requirements together
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const a = sc.putUnit('p0', 'fx-grunt', 'bf0');
    const b = sc.putUnit('p1', 'fx-tide-grunt', 'bf0');
    const far = sc.putUnit('p0', 'fx-titan', 'bf1');
    const home = sc.putUnit('p0', 'fx-archer', 'base');
    const ok = (ids: string[]) => spellTargetsLegal(sc.state, cards, 'p0', effects, ids.map(obj));
    expect(ok([a, b])).toBe(true);
    expect(ok([a, a])).toBe(false);
    expect(ok([a, far])).toBe(false); // another battlefield
    expect(ok([a, home])).toBe(false); // a Base is not a battlefield
  });

  it('swaps the two Mights for the turn', () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const small = sc.putUnit('p0', 'fx-grunt', 'bf0');
    const big = sc.putUnit('p1', 'fx-order-titan', 'bf0');
    const m = (id: string) => effectiveMight(sc.state, cards, id, { role: null });
    const [ms, mb] = [m(small), m(big)];
    expect(ms).not.toBe(mb);
    cast(sc, [obj(small), obj(big)]);
    expect(m(small)).toBe(mb);
    expect(m(big)).toBe(ms);
  });
});

describe('scenario: "Recycle up to 4 cards from trashes" (Forge of the Future)', () => {
  const text = 'Recycle up to 4 cards from trashes.';
  const effects = parseSpellText(text) ?? [];

  it('reads a recycle of up to four chosen cards from any Trash', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([{ op: 'RECYCLE_FROM_TRASHES', count: { min: 0, max: 4 } }]);
  });

  /** Puts `n` cards of `player`'s deck into their Trash; returns their ids. */
  function trashSome(sc: Scenario, player: 'p0' | 'p1', n: number): string[] {
    const ps = sc.state.players[player === 'p0' ? 0 : 1] as GameState['players'][number];
    const ids = ps.mainDeck.splice(0, n);
    for (const id of ids) {
      ps.trash.push(id);
      (sc.state.objects[id] as CardInstance).zone = { kind: 'trash', player };
    }
    return ids;
  }

  it('only cards in a Trash can be chosen, at most four', () => {
    // Tests Rule 355.10: every pick must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const mine = trashSome(sc, 'p0', 3);
    const theirs = trashSome(sc, 'p1', 2);
    const inHand = sc.player('p0').hand[0] as string;
    const ok = (ids: string[]) => spellTargetsLegal(sc.state, cards, 'p0', effects, ids.map(obj));
    expect(ok([mine[0] as string, theirs[0] as string])).toBe(true);
    expect(ok([...mine, ...theirs])).toBe(false); // five cards
    expect(ok([inHand])).toBe(false); // not in a Trash
  });

  it("puts every chosen card at the bottom of its owner's Main Deck", () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const mine = trashSome(sc, 'p0', 2);
    const theirs = trashSome(sc, 'p1', 1);
    const picked = [...mine, ...theirs];
    cast(sc, picked.map(obj));
    for (const id of mine) {
      expect(sc.obj(id).zone).toMatchObject({ kind: 'mainDeck', player: 'p0' });
    }
    // both of p0's cards sit at the very bottom of p0's Main Deck
    expect(sc.player('p0').mainDeck.slice(-2).sort()).toEqual([...mine].sort());
    expect(sc.player('p1').mainDeck.at(-1)).toBe(theirs[0]);
    expect(sc.obj(theirs[0] as string).zone).toMatchObject({ kind: 'mainDeck', player: 'p1' });
    expect(sc.player('p0').trash).not.toContain(mine[0]);
    expect(sc.player('p1').trash).not.toContain(theirs[0]);
  });
});

describe('scenario: "Return up to 2 units from trashes to their owners\' hands" (Shadows of the Past)', () => {
  const text = "Return up to 2 units from trashes to their owners' hands.";
  const effects = parseSpellText(text) ?? [];

  it('reads a return of up to two units from any Trash', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'RETURN_FROM_TRASH', what: 'unit', anyTrash: true, count: { min: 0, max: 2 } },
    ]);
  });

  /** Moves a specific card of `player` into their Trash; returns its id. */
  function trashCard(sc: Scenario, player: 'p0' | 'p1', cardId: string): string {
    const id = sc.putInHand(player, cardId);
    const ps = sc.state.players[player === 'p0' ? 0 : 1] as GameState['players'][number];
    ps.hand = ps.hand.filter((x) => x !== id);
    ps.trash.push(id);
    (sc.state.objects[id] as CardInstance).zone = { kind: 'trash', player };
    return id;
  }

  it('only units in a Trash can be chosen, at most two, from either player', () => {
    // Tests Rule 355.10: every pick must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const mine = trashCard(sc, 'p0', 'fx-grunt');
    const theirs = trashCard(sc, 'p1', 'fx-tide-grunt');
    const spell = trashCard(sc, 'p0', 'fx-flare');
    const extra = trashCard(sc, 'p0', 'fx-archer');
    const ok = (ids: string[]) => spellTargetsLegal(sc.state, cards, 'p0', effects, ids.map(obj));
    expect(ok([mine, theirs])).toBe(true);
    expect(ok([spell])).toBe(false); // not a unit
    expect(ok([mine, theirs, extra])).toBe(false); // three
  });

  it("returns each chosen unit to its owner's hand", () => {
    // Tests Rule 355.10: the spell resolves its effects on the chosen targets
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const mine = trashCard(sc, 'p0', 'fx-grunt');
    const theirs = trashCard(sc, 'p1', 'fx-tide-grunt');
    cast(sc, [obj(mine), obj(theirs)]);
    expect(sc.obj(mine).zone).toMatchObject({ kind: 'hand', player: 'p0' });
    expect(sc.obj(theirs).zone).toMatchObject({ kind: 'hand', player: 'p1' });
  });
});

describe('scenario: "Choose up to 3 cards from opponents\' trashes. Their owners recycle them." (Disposal Order)', () => {
  const text = "Choose up to 3 cards from opponents' trashes. Their owners recycle them.";
  const effects = parseSpellText(text) ?? [];

  it("reads a recycle of up to three cards from the opponents' Trash only", () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'RECYCLE_FROM_TRASHES', side: 'enemy', count: { min: 0, max: 3 } },
    ]);
  });

  it("only cards in an opponent's Trash can be chosen", () => {
    // Tests Rule 355.10: a target must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const put = (player: 'p0' | 'p1', cardId: string): string => {
      const id = sc.putInHand(player, cardId);
      const ps = sc.state.players[player === 'p0' ? 0 : 1] as GameState['players'][number];
      ps.hand = ps.hand.filter((x) => x !== id);
      ps.trash.push(id);
      (sc.state.objects[id] as CardInstance).zone = { kind: 'trash', player };
      return id;
    };
    const mine = put('p0', 'fx-grunt');
    const theirs = put('p1', 'fx-tide-grunt');
    const ok = (ids: string[]) => spellTargetsLegal(sc.state, cards, 'p0', effects, ids.map(obj));
    expect(ok([theirs])).toBe(true);
    expect(ok([mine])).toBe(false);
    cast(sc, [obj(theirs)]);
    expect(sc.obj(theirs).zone).toMatchObject({ kind: 'mainDeck', player: 'p1' });
  });
});

describe('scenario: "Play a Sand Soldier for each Equipment you control. Then ready up to two of them." (Arise!)', () => {
  const text =
    'Play a 2 [M] Sand Soldier unit token for each Equipment you control. Then do this: Ready up to two of them.';
  const effects = parseSpellText(text) ?? [];

  it('reads one token per Equipment, then a ready of up to two of the new tokens', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'PLAY_TOKEN', token: 'tok-sand-soldier', count: 1, perEquipment: true },
      { op: 'READY_PLAYED_TOKENS', count: 2 },
    ]);
  });

  const sandSoldiers = (sc: Scenario): CardInstance[] =>
    Object.values(sc.state.objects).filter((o) => o.cardId === 'tok-sand-soldier');

  it('plays a token for each Equipment and readies at most two of them', () => {
    // Tests Rule 355.10: the spell resolves its effects in order
    const cards: CardDatabase = {
      ...spellWith(effects),
      ...TOKEN_CARDS,
      'fx-ember-totem': {
        ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef),
        subtypes: ['Equipment'],
      },
    };
    const sc = Scenario.start({}, cards);
    sc.putUnit('p0', 'fx-blade', 'base');
    sc.putUnit('p0', 'fx-ember-totem', 'base');
    cast(sc, []);
    const made = sandSoldiers(sc);
    expect(made).toHaveLength(2);
    expect(made.every((t) => t.ready)).toBe(true);

    const none = Scenario.start({}, cards);
    cast(none, []);
    expect(sandSoldiers(none)).toHaveLength(0);
  });
});

describe('scenario: "Banish a unit with 3 [M] or less or a gear. [Burn 2]." (Burn Away)', () => {
  const text = 'Banish a unit with 3 [M] or less or a gear. [Burn 2].';
  const effects = parseSpellText(text) ?? [];

  it('reads a banish of a small unit or any gear, then a Burn', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'BANISH_TARGET', orGear: true, maxMight: 3 },
      { op: 'BURN', amount: 2 },
    ]);
  });

  it('the Might limit applies to units only; any gear can be chosen', () => {
    // Tests Rule 355.10: a target must meet the spell's requirements
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const small = sc.putUnit('p0', 'fx-grunt', 'base');
    const big = sc.putUnit('p0', 'fx-titan', 'base');
    const gear = sc.putUnit('p0', 'fx-ember-totem', 'base');
    const ok = (id: string) => spellTargetsLegal(sc.state, cards, 'p0', effects, [obj(id)]);
    expect(ok(small)).toBe(true);
    expect(ok(big)).toBe(false);
    expect(ok(gear)).toBe(true);
  });

  it('banishes the chosen permanent and burns two cards', () => {
    // Tests Rule 355.10: the spell resolves its effects in order
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const gear = sc.putUnit('p0', 'fx-ember-totem', 'base');
    const trash = sc.player('p0').trash.length;
    cast(sc, [obj(gear)]);
    expect(sc.obj(gear).zone).toMatchObject({ kind: 'banishment', player: 'p0' });
    expect(sc.player('p0').banishment).toContain(gear);
    // the spell itself also lands in the Trash, besides the two burned cards
    expect(sc.player('p0').trash.length).toBe(trash + 3);
  });
});

describe('scenario: "When it wins a combat this turn, gain 2 XP" (Grim Resolve)', () => {
  const text = 'Give a friendly unit +3 [M] this turn. When it wins a combat this turn, gain 2 XP.';
  const effects = parseSpellText(text) ?? [];
  const toBf = (battlefieldId: string) => ({ kind: 'battlefield' as const, battlefieldId });

  it('reads the buff and a watcher on that unit winning a combat', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'BUFF_TARGET', amount: 3 },
      {
        op: 'DELAYED',
        on: 'SUBJECT_WINS_COMBAT',
        subjectSlot: 0,
        effects: [{ op: 'GAIN_XP', amount: 2 }],
      },
    ]);
  });

  /** p0 buffs `buffed`, then the Titan attacks the Order tank and wins; returns p0's XP gain. */
  function xpGain(buffTitan: boolean): number {
    const cards = spellWith(effects);
    const sc = Scenario.start({}, cards);
    const tank = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const titan = sc.putUnit('p0', 'fx-titan', 'base');
    const home = sc.putUnit('p0', 'fx-grunt', 'base');
    const xp = sc.player('p0').xp ?? 0;
    cast(sc, [obj(buffTitan ? titan : home)]);
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [titan], destination: toBf('bf1') });
    sc.pass('p0');
    sc.pass('p1');
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [{ unitId: tank, amount: buffTitan ? 10 : 7 }],
    });
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p1',
      assignments: [{ unitId: titan, amount: 3 }],
    });
    for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as PlayerId);
    }
    return (sc.player('p0').xp ?? 0) - xp;
  }

  it('gains XP when the buffed unit wins the combat, not when another unit does', () => {
    // Tests Rule 468.3: the side with units left wins the combat
    expect(xpGain(true)).toBe(2);
    expect(xpGain(false)).toBe(0);
  });
});

describe('scenario: "Kill it the next time it takes damage this turn. [Legion] — Kill it now instead." (Noxian Guillotine)', () => {
  const text =
    'Choose a unit. Kill it the next time it takes damage this turn. [Legion] — Kill it now instead.';
  const effects = parseSpellText(text) ?? [];

  it('reads a delayed kill that Legion replaces by an immediate kill', () => {
    // Tests Rule 812: Legion applies when another card was played this turn
    expect(effects).toMatchObject([
      {
        op: 'DELAYED',
        on: 'UNIT_DAMAGED',
        subjectSlot: 0,
        times: 1,
        effects: [{ op: 'KILL_TARGET' }],
        when: { kind: 'NOT', cond: { kind: 'LEGION' } },
      },
      { op: 'KILL_TARGET', when: { kind: 'LEGION' } },
    ]);
  });

  /** p0 casts the spell at a big enemy; `legion` plays another card first; `hit` then damages the enemy. */
  function enemyZone(legion: boolean, hit: boolean): string {
    const cards: CardDatabase = {
      ...spellWith(effects),
      'fx-plain-spell': {
        ...(SCENARIO_CARDS['fx-plain-spell'] as CardDef),
        supportLevel: 'partial',
        effects: [{ op: 'DAMAGE_TARGET', amount: 1 }],
      },
    };
    const sc = Scenario.start({}, cards);
    const foe = sc.putUnit('p1', 'fx-order-titan', 'base'); // big: 1 damage does not kill it
    const play = (id: string, targets: Target[]): void => {
      sc.play('p0', id, { payment: sc.exhaustPlan('p0', 2), targets });
      for (let i = 0; i < 10 && sc.state.flow.chain.length > 0; i++) {
        sc.pass(sc.state.flow.priority as PlayerId);
      }
    };
    sc.giveRunes('p0', 6);
    if (legion) play(sc.putInHand('p0', 'fx-plain-spell'), [obj(foe)]);
    play(sc.putInHand('p0', 'fx-flare'), [obj(foe)]);
    if (hit) play(sc.putInHand('p0', 'fx-plain-spell'), [obj(foe)]);
    return sc.obj(foe).zone.kind;
  }

  it('without Legion the unit dies the next time it takes damage', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(enemyZone(false, false)).toBe('base'); // nothing hurt it yet
    expect(enemyZone(false, true)).toBe('trash');
  });

  it('with Legion it is killed at once', () => {
    // Tests Rule 812: Legion applies when another card was played this turn
    expect(enemyZone(true, false)).toBe('trash');
  });
});

describe('scenario: "Give a friendly unit +1 [M] this turn, then an additional +1 [M] if it is the only unit you control there" (En Garde)', () => {
  const text =
    'Give a friendly unit +1 [M] this turn, then an additional +1 [M] this turn if it is the only unit you control there.';
  const effects = parseSpellText(text) ?? [];

  it('reads the buff and a second buff gated on the unit being alone', () => {
    // Tests Rule 355.10: a spell chooses its targets as it is played
    expect(effects).toMatchObject([
      { op: 'BUFF_TARGET', amount: 1, duration: 'TURN', side: 'friendly' },
      {
        op: 'BUFF_TARGET',
        amount: 1,
        duration: 'TURN',
        side: 'friendly',
        when: { kind: 'TARGET_ALONE', slot: 0 },
      },
    ]);
  });

  it('gives +2 to a unit alone at its location and +1 otherwise', () => {
    // Tests Rule 355.10: the spell resolves its effects in order on the chosen unit
    const cards = spellWith(effects);
    const m = (sc: Scenario, id: string) => effectiveMight(sc.state, cards, id, { role: null });

    const alone = Scenario.start({}, cards);
    const a = alone.putUnit('p0', 'fx-grunt', 'bf0');
    const before = m(alone, a);
    cast(alone, [obj(a)]);
    expect(m(alone, a)).toBe(before + 2);

    const crowded = Scenario.start({}, cards);
    const b = crowded.putUnit('p0', 'fx-grunt', 'bf0');
    crowded.putUnit('p0', 'fx-archer', 'bf0');
    const before2 = m(crowded, b);
    cast(crowded, [obj(b)]);
    expect(m(crowded, b)).toBe(before2 + 1);

    const home = Scenario.start({}, cards); // alone in the Base counts as alone there
    const c = home.putUnit('p0', 'fx-grunt', 'base');
    const before3 = m(home, c);
    cast(home, [obj(c)]);
    expect(m(home, c)).toBe(before3 + 2);
  });
});
