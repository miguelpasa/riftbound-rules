import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import {
  parseBattlefieldAbilities,
  parseCardAbilities,
  parseSpellText,
  parseStaticLines,
} from '../cardText.js';
import { scoreBattlefield } from '../scoring.js';
import { endCombatGrants, expireTurnEffects, runEffects } from '../effects.js';
import { effectiveMight } from '../combat.js';
import { reduce } from '../reducer.js';
import type { CardDatabase, CardDef, CardEffect } from '../types/index.js';

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;
const statics = (text: string) => parseStaticLines(text)?.statics ?? [];

describe('scenario: Battlefield cards with rule-changing statics', () => {
  it('reads the four static lines', () => {
    // Tests Rule 175: Battlefield cards have standing abilities
    expect(statics("Units can't be played here.")[0]).toMatchObject({ restrict: 'NO_PLAY_HERE' });
    expect(statics("Players can't score here until their third turn.")[0]).toMatchObject({
      restrict: 'NO_EARLY_SCORE',
    });
    expect(statics('Increase the points needed to win the game by 1.')[0]).toMatchObject({
      victoryBonus: 1,
    });
    expect(statics('While a unit here is defending alone, it has -2 [M].')[0]).toMatchObject({
      affects: 'UNITS_HERE',
      onlyDefendingAlone: true,
      might: -2,
    });
  });

  it('refuses to score a battlefield before the third turn (Forgotten Monument)', () => {
    // Tests Rule 472: scoring a battlefield
    const sc0 = Scenario.start({});
    const bf = sc0.state.battlefields[0];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      [bf?.cardId ?? '']: {
        ...base(bf?.cardId ?? ''),
        statics: statics("Players can't score here until their third turn."),
      },
    };
    const early = scoreBattlefield(structuredClone(sc0.state), cards, 'p0', bf?.id ?? '', 'HOLD');
    expect(early.state.players[0]?.points).toBe(0);
    const s5 = structuredClone(sc0.state);
    s5.turn.number = 5;
    const late = scoreBattlefield(s5, cards, 'p0', bf?.id ?? '', 'HOLD');
    expect(late.state.players[0]?.points).toBe(1);
  });

  it('refuses to play a unit to the battlefield (Rockfall Path)', () => {
    // Tests Rule 355.2: the location of a played card
    const sc0 = Scenario.start({});
    const bf =
      sc0.state.battlefields.find((b) => b.controller === 'p0') ?? sc0.state.battlefields[0];
    expect(bf).toBeDefined();
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      [bf?.cardId ?? '']: {
        ...base(bf?.cardId ?? ''),
        statics: statics("Units can't be played here."),
      },
    };
    const sc = Scenario.start({}, cards);
    const mine = sc.state.battlefields.find((b) => b.cardId === bf?.cardId);
    sc.setBattlefield(mine?.id ?? '', { controller: 'p0' });
    const grunt = sc.putInHand('p0', 'fx-grunt');
    const r = reduce(sc.state, cards, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: grunt,
      payment: sc.exhaustPlan('p0', 2),
      location: { kind: 'battlefield', battlefieldId: mine?.id ?? '' },
    });
    expect(r.ok).toBe(false);
  });
});

describe('scenario: "this combat" effects (Fiora, Fortified Position, Durand Memorial)', () => {
  it('reads the keyword grants and the one-on-one doubling', () => {
    // Tests Rule 468: combat
    const fort = parseBattlefieldAbilities(
      'When you defend here, choose a unit. It gains [Shield 2] this combat.',
    );
    expect(fort?.[0]?.effects[0]).toMatchObject({ op: 'GRANT_KEYWORD_TARGET', duration: 'COMBAT' });
    const durand = parseBattlefieldAbilities(
      'When you defend here, choose a unit you control here. Give it [Tank] this combat.',
    );
    expect(durand?.[0]?.effects[0]).toMatchObject({
      op: 'GRANT_KEYWORD_TARGET',
      side: 'friendly',
      here: true,
      duration: 'COMBAT',
    });
    const fiora = parseCardAbilities(
      'When I attack or defend one on one, double my Might this combat.',
    );
    expect(fiora?.triggers.map((t) => t.on)).toEqual(['ATTACK', 'DEFEND']);
    expect(fiora?.triggers[0]?.when).toMatchObject({ kind: 'COMBAT_ROLE', oneOnOne: true });
  });

  it('gives Might and keywords that end with the combat but not the turn effects around them', () => {
    // Tests Rule 468: combat
    const sc = Scenario.start({});
    const u = sc.putUnit('p0', 'fx-ash-tank', 'bf1');
    const s = structuredClone(sc.state);
    const before = effectiveMight(s, sc.cards, u, { role: null });
    runEffects(s, 'p0', [{ op: 'BUFF_SELF', amount: 1 }], sc.cards, [], '', u);
    runEffects(s, 'p0', [{ op: 'DOUBLE_MIGHT_SELF', duration: 'COMBAT' }], sc.cards, [], '', u);
    runEffects(
      s,
      'p0',
      [
        {
          op: 'GRANT_KEYWORD_TARGET',
          keywords: [{ name: 'Shield', value: 2 }],
          duration: 'COMBAT',
        },
      ],
      sc.cards,
      [{ kind: 'object', id: u }],
      '',
      u,
    );
    expect(effectiveMight(s, sc.cards, u, { role: null })).toBe((before + 1) * 2);
    endCombatGrants(s);
    expect(effectiveMight(s, sc.cards, u, { role: null })).toBe(before + 1);
    expect(s.objects[u]?.tempKeywords).toBeUndefined();
    expect(s.objects[u]?.combatGrant).toBeUndefined();
  });
});

describe('scenario: domain-filtered targets and spell flags (Decree cards)', () => {
  it('reads "an enemy Calm unit" as a domain filter on the target', () => {
    // Tests Rule 355.10: targets must be legal
    const e = parseSpellText('Deal 4 to an enemy Calm   unit.');
    expect(e?.[0]).toMatchObject({ op: 'DAMAGE_TARGET', amount: 4, side: 'enemy', domain: 'Calm' });
    const k = parseSpellText('Kill an enemy Chaos   unit or gear.');
    expect(k?.[0]).toMatchObject({ op: 'KILL_TARGET', side: 'enemy', domain: 'Chaos' });
  });

  it('only offers targets of that domain', () => {
    // Tests Rule 355.10: targets must be legal
    const e = parseSpellText('Deal 4 to an enemy Calm unit.') ?? [];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects: e },
    };
    const sc = Scenario.start({}, cards);
    const calm = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const flare = sc.putInHand('p0', 'fx-flare');
    const domainOf = (id: string): string[] => cards[sc.obj(id).cardId]?.domains ?? [];
    const tryPlay = (target: string) =>
      reduce(sc.state, cards, {
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: flare,
        payment: sc.exhaustPlan('p0', 1),
        targets: [{ kind: 'object', id: target }],
      });
    // the fixture grunt is not Calm: refused; with its domains patched to Calm: accepted
    expect(domainOf(calm)).not.toContain('Calm');
    expect(tryPlay(calm).ok).toBe(false);
    const cards2: CardDatabase = {
      ...cards,
      [sc.obj(calm).cardId]: { ...base(sc.obj(calm).cardId), domains: ['Calm'] },
    };
    const ok = reduce(sc.state, cards2, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: flare,
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: calm }],
    });
    expect(ok.ok).toBe(true);
  });
});

describe('scenario: "Discard 1, then draw 2" (Lunar Boon)', () => {
  it('discards a card of your choice and then draws', () => {
    // Tests Rule 598: discarding
    const effects = parseSpellText('Discard 1, then draw 2.') ?? [];
    expect(effects.map((e) => e.op)).toEqual(['HAND_DISCARD', 'DRAW']);
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects },
    };
    const sc = Scenario.start({}, cards);
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
    for (let i = 0; i < 6 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    const choice = sc.state.flow.pendingChoice;
    expect(choice?.kind).toBe('HAND_CHOICE');
    if (choice?.kind !== 'HAND_CHOICE') return;
    const handBefore = sc.state.players[0]?.hand.length ?? 0;
    sc.do({
      type: 'CHOOSE_HAND_CARDS',
      playerId: 'p0',
      cardIds: [choice.options[0]?.id as string],
    });
    // one discarded, two drawn
    expect(sc.state.players[0]?.hand.length).toBe(handBefore + 1);
  });
});

describe('scenario: "Disempower this" as an ability cost (Questionable Tome)', () => {
  const parsed = parseCardAbilities('[Empower] — [E]\nDisempower this, [1], [E]: Draw 1.', {
    gearLike: true,
  });
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-grunt': { ...base('fx-grunt'), abilities: parsed?.abilities ?? [] },
  };

  it('needs the source to be Empowered, and pays by ending that', () => {
    // Tests Rule 702: Empower
    const sc = Scenario.start({}, cards);
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setReady(g, true);
    const use = () =>
      reduce(sc.state, cards, {
        type: 'ACTIVATE_ABILITY',
        playerId: 'p0',
        sourceId: g,
        abilityIndex: 1,
        payment: sc.exhaustPlan('p0', 1),
      });
    expect(use().ok).toBe(false); // not Empowered yet
    (sc.state.objects[g] as { empowered?: boolean }).empowered = true;
    const r = use();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.objects[g]?.empowered).toBeUndefined();
  });
});

describe('scenario: taking control of a unit (Possession, Hostile Takeover)', () => {
  const run = (text: string, endTurn: boolean) => {
    const effects = parseSpellText(text) ?? [];
    expect(effects.length).toBeGreaterThan(0);
    const sc = Scenario.start({});
    const victim = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const s = structuredClone(sc.state);
    runEffects(s, 'p0', effects, sc.cards, [{ kind: 'object', id: victim }]);
    return { s, victim, effects, sc, endTurn };
  };

  it('Possession: the enemy unit is yours and recalled to your Base', () => {
    // Tests Rule 146: control of a permanent
    const { s, victim } = run(
      'Choose an enemy unit at a battlefield. Take control of it and recall it.',
      false,
    );
    expect(s.objects[victim]?.controller).toBe('p0');
    expect(s.objects[victim]?.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(s.players[0]?.base).toContain(victim);
    expect(s.players[1]?.base).not.toContain(victim);
  });

  it('Hostile Takeover: ready, then back to its owner at the end of the turn', () => {
    // Tests Rule 146: control of a permanent
    const { s, victim, effects } = run(
      'Take control of an enemy unit at a battlefield. Ready it. Lose control of that unit and recall it at end of turn.',
      true,
    );
    expect(effects.map((e) => e.op)).toEqual(['TAKE_CONTROL', 'READY_TARGET']);
    expect(s.objects[victim]?.controller).toBe('p0');
    expect(s.objects[victim]?.ready).toBe(true);
    expect(s.objects[victim]?.zone.kind).toBe('battlefield');
    const after = expireTurnEffects(s, SCENARIO_CARDS).state;
    expect(after.objects[victim]?.controller).toBe('p1');
    expect(after.objects[victim]?.zone).toEqual({ kind: 'base', player: 'p1' });
    expect(after.players[1]?.base).toContain(victim);
  });
});

describe('scenario: a sentence with its own condition (Back Off)', () => {
  it('draws only when the spell was played from the hand', () => {
    // Tests Rule 355: playing a card; its effects resolve in order
    const effects = parseSpellText('Stun a unit. If you played this from your hand, draw 1.') ?? [];
    expect(effects[1]).toMatchObject({
      op: 'DRAW',
      when: { kind: 'PLAYED_FROM', from: 'HAND' },
    });
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects },
    };
    const sc = Scenario.start({}, cards);
    const victim = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const flare = sc.putInHand('p0', 'fx-flare');
    const handBefore = sc.state.players[0]?.hand.length ?? 0;
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: victim }],
    });
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
    // the Flare left the hand and one card was drawn
    expect(sc.state.players[0]?.hand.length).toBe(handBefore);
    expect(sc.obj(victim).stunned).toBe(true);
  });

  it('skips the sentence while its condition is false', () => {
    // Tests Rule 355: playing a card; its effects resolve in order
    const effects = parseSpellText("If it's not your turn, draw 1.") ?? [];
    const sc = Scenario.start({});
    const s = structuredClone(sc.state);
    const before = s.players[1]?.hand.length ?? 0;
    runEffects(s, 'p1', effects, sc.cards); // it is p0's turn: p1 draws
    expect(s.players[1]?.hand.length).toBe(before + 1);
    const t = structuredClone(sc.state);
    const mine = t.players[0]?.hand.length ?? 0;
    runEffects(t, 'p0', effects, sc.cards); // p0's own turn: nothing
    expect(t.players[0]?.hand.length).toBe(mine);
  });
});

describe('scenario: Show Off (Battle Preparations)', () => {
  const effects = parseSpellText(
    'Give a unit +2 [M] this turn. If you showed off, ready up to 2 runes.',
  ) as CardEffect[];
  const cards: CardDatabase = {
    ...SCENARIO_CARDS,
    'fx-flare': {
      ...base('fx-flare'),
      supportLevel: 'full',
      effects,
      optionalAdditionalCost: { energy: 0, card: { kind: 'REVEAL', what: 'gear' } },
    },
  };

  const play = (reveal: boolean) => {
    // Tests Rule 357: additional costs are paid as the card is played
    const sc = Scenario.start({}, cards);
    const unit = sc.putUnit('p0', 'fx-ash-tank', 'bf1');
    const gear = sc.putInHand('p0', 'fx-blade');
    const flare = sc.putInHand('p0', 'fx-flare');
    const r = reduce(sc.state, cards, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: flare,
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: unit }],
      ...(reveal ? { additionalCosts: { extra: true }, costCards: [gear] } : {}),
    });
    return { sc, r, gear, flare };
  };

  it('keeps the revealed card in hand and remembers that you showed off', () => {
    // Tests Rule 357: additional costs are paid as the card is played
    const { r, gear, flare } = play(true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.objects[gear]?.zone.kind).toBe('hand');
    expect(r.state.objects[flare]?.showedOff).toBe(gear);
  });

  it('readies runes only when you showed off', () => {
    // Tests Rule 357: additional costs are paid as the card is played
    const settle = (sc: Scenario, st: Scenario['state']) => {
      sc.state = st;
      for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
        sc.pass(sc.state.flow.priority as 'p0' | 'p1');
      }
      return sc.runes('p0').filter((x) => x.ready).length;
    };
    const a = play(true);
    const b = play(false);
    if (!a.r.ok || !b.r.ok) throw new Error('play rejected');
    const ra = settle(a.sc, a.r.state);
    const rb = settle(b.sc, b.r.state);
    expect(ra).toBeGreaterThan(rb);
  });
});

describe('scenario: Action-speed activated abilities (Divining Shells)', () => {
  const parsed = parseCardAbilities('[Action][>] Kill this, [E]: Give a unit +2 [M] this turn.', {
    gearLike: true,
  });

  it('reads the [Action] label as a flag on the ability', () => {
    // Tests Rule 151: activated abilities
    expect(parsed?.abilities[0]).toMatchObject({ action: true, cost: { killSelf: true } });
  });

  it('can be used in a showdown, unlike a plain activated ability', () => {
    // Tests Rule 308.1.a: Showdown State timing
    const mk = (action: boolean): CardDatabase => ({
      ...SCENARIO_CARDS,
      'fx-blade': {
        ...base('fx-blade'),
        abilities: [
          {
            ...(parsed?.abilities[0] as NonNullable<typeof parsed>['abilities'][0]),
            ...(action ? {} : { action: undefined }),
          },
        ],
      },
    });
    const run = (cards: CardDatabase) => {
      const sc = Scenario.start({}, cards);
      const g = sc.putUnit('p0', 'fx-blade', 'base');
      const target = sc.putUnit('p0', 'fx-ash-tank', 'base');
      sc.state.flow.showdown = {
        battlefieldId: 'bf1',
        passesInRow: 0,
      } as unknown as NonNullable<typeof sc.state.flow.showdown>;
      sc.state.turnState = { kind: 'SHOWDOWN', open: true };
      return reduce(sc.state, cards, {
        type: 'ACTIVATE_ABILITY',
        playerId: 'p0',
        sourceId: g,
        abilityIndex: 0,
        payment: [],
        targets: [{ kind: 'object', id: target }],
      });
    };
    const refused = run(mk(false));
    expect(refused.ok).toBe(false);
    expect(run(mk(true)).ok).toBe(true);
  });
});

describe('scenario: small self effects (Vi, Ezreal, Jhin)', () => {
  it('doubles its own Might this turn and moves itself to the Base', () => {
    // Tests Rule 573: effects change the game state
    const sc = Scenario.start({});
    const u = sc.putUnit('p0', 'fx-ash-tank', 'bf1');
    const s = structuredClone(sc.state);
    const before = effectiveMight(s, sc.cards, u, { role: null });
    runEffects(s, 'p0', [{ op: 'DOUBLE_MIGHT_SELF' }], sc.cards, [], '', u);
    expect(effectiveMight(s, sc.cards, u, { role: null })).toBe(before * 2);
    runEffects(s, 'p0', [{ op: 'MOVE_SELF_BASE' }], sc.cards, [], '', u);
    expect(s.objects[u]?.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(s.players[0]?.base).toContain(u);
  });

  it('adds Energy and Power together', () => {
    // Tests Rule 167: Add effects put resources in the Rune Pool
    const t = parseCardAbilities('When I move, [Add] [1][A].');
    expect(t?.triggers[0]?.effects).toEqual([
      { op: 'ADD_ENERGY', amount: 1 },
      { op: 'ADD_POWER', amount: 1, domain: 'ANY' },
    ]);
  });
});

describe("scenario: Equip with an XP cost (Shepherd's Heirloom)", () => {
  it('needs the XP and spends it', () => {
    // Tests Rule 818: Equip costs
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-blade': { ...base('fx-blade'), equipCost: { energy: 0, power: 0, anyPower: 0, xp: 1 } },
    };
    const sc = Scenario.start({}, cards);
    const g = sc.putUnit('p0', 'fx-blade', 'base');
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const equip = () =>
      reduce(sc.state, cards, { type: 'EQUIP', playerId: 'p0', equipmentId: g, unitId: u });
    expect(equip().ok).toBe(false);
    (sc.state.players[0] as { xp?: number }).xp = 2;
    const r = equip();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.players[0]?.xp).toBe(1);
  });
});

describe('scenario: "If you paid the additional cost" in a spell (Rampage)', () => {
  const effects = parseSpellText(
    'Choose a friendly unit and an enemy unit. If you paid the additional cost, give the friendly unit +2 [M] this turn. They deal damage equal to their Mights to each other.',
  ) as CardEffect[];

  it('reads the buff as conditional on the paid extra and aimed at the friendly slot', () => {
    // Tests Rule 357: additional costs
    expect(effects.map((e) => e.op)).toEqual(['BUFF_TARGET', 'MUTUAL_DAMAGE']);
    expect(effects[0]).toMatchObject({
      side: 'friendly',
      when: { kind: 'PAID_ADDITIONAL', spell: true },
    });
  });

  it('buffs only when the played card remembers paying it', () => {
    // Tests Rule 357: additional costs
    const sc = Scenario.start({});
    const mine = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const spell = sc.putInHand('p0', 'fx-flare');
    const targets = [
      { kind: 'object' as const, id: mine },
      { kind: 'object' as const, id: theirs },
    ];
    const run = (paid: boolean) => {
      const s = structuredClone(sc.state);
      if (paid) (s.objects[spell] as { paidExtra?: boolean }).paidExtra = true;
      runEffects(s, 'p0', effects, sc.cards, targets, 'fx-flare', spell);
      return s.objects[mine]?.mightBonus ?? 0;
    };
    expect(run(true)).toBe(2);
    expect(run(false)).toBe(0);
  });
});

describe('scenario: "If you do ... Otherwise ..." after an optional cost (Meditation)', () => {
  it('draws 2 when the extra cost was paid and 1 when it was not', () => {
    // Tests Rule 357: additional costs
    const effects = parseSpellText('If you do, draw 2. Otherwise, draw 1.') as CardEffect[];
    const sc = Scenario.start({});
    const spell = sc.putInHand('p0', 'fx-flare');
    const draws = (paid: boolean): number => {
      const s = structuredClone(sc.state);
      if (paid) (s.objects[spell] as { paidExtra?: boolean }).paidExtra = true;
      const before = s.players[0]?.hand.length ?? 0;
      runEffects(s, 'p0', effects, sc.cards, [], 'fx-flare', spell);
      return (s.players[0]?.hand.length ?? 0) - before;
    };
    expect(draws(true)).toBe(2);
    expect(draws(false)).toBe(1);
  });
});

describe('scenario: Legends with turn and attack triggers', () => {
  it('reads Loose Cannon, Dark Child and Nine-Tailed Fox', () => {
    // Tests Rule 101: Legends have abilities
    const start = parseCardAbilities(
      'At start of your Beginning Phase, draw 1 if you have one or fewer cards in your hand.',
      { legend: true },
    );
    expect(start?.triggers[0]).toMatchObject({ on: 'TURN_START', when: { kind: 'COUNT' } });
    const end = parseCardAbilities('At the end of your turn, ready up to 2 runes.', {
      legend: true,
    });
    expect(end?.triggers[0]).toMatchObject({ on: 'TURN_END' });
    const fox = parseCardAbilities(
      'When an enemy unit attacks a battlefield you control, give it -1 [M] this turn, to a minimum of 1 [M].',
      { legend: true },
    );
    expect(fox?.triggers[0]).toMatchObject({ on: 'UNIT_ATTACKS', unitFilter: { atMine: true } });
  });
});

describe('scenario: "you may spend N XP to ..." (Kha\'Zix)', () => {
  it('asks for the XP and takes it when the player accepts', () => {
    // Tests Rule 583: optional costs of a triggered ability
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-grunt': {
        ...base('fx-grunt'),
        triggers: [{ on: 'PLAY', effects: [{ op: 'DRAW', amount: 1 }], optional: { xp: 2 } }],
      },
    };
    const sc = Scenario.start({}, cards);
    (sc.state.players[0] as { xp?: number }).xp = 3;
    const grunt = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', grunt, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    sc.pass('p1');
    sc.pass('p0');
    const pc = sc.state.flow.pendingChoice;
    expect(pc).toMatchObject({ kind: 'OPTIONAL_EFFECT', cost: { xp: 2 } });
    if (pc?.kind !== 'OPTIONAL_EFFECT') return;
    const hand = sc.state.players[0]?.hand.length ?? 0;
    sc.do({ type: 'DECIDE_OPTIONAL', playerId: 'p0', chainItemId: pc.chainItemId, accept: true });
    expect(sc.state.players[0]?.xp).toBe(1);
    expect(sc.state.players[0]?.hand.length).toBe(hand + 1);
  });
});

describe('scenario: exhausted-unit targets (Arena Bar)', () => {
  it('only offers exhausted units', () => {
    // Tests Rule 355.10: targets must be legal
    const e = parseSpellText('Buff an exhausted friendly unit.') as CardEffect[];
    expect(e[0]).toMatchObject({ op: 'BUFF_TARGET', side: 'friendly', exhausted: true });
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects: e },
    };
    const sc = Scenario.start({}, cards);
    const u = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const flare = sc.putInHand('p0', 'fx-flare');
    const tryIt = () =>
      reduce(sc.state, cards, {
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: flare,
        payment: sc.exhaustPlan('p0', 1),
        targets: [{ kind: 'object', id: u }],
      }).ok;
    sc.setReady(u, true);
    expect(tryIt()).toBe(false);
    sc.setReady(u, false);
    expect(tryIt()).toBe(true);
  });
});

describe('scenario: damage equal to the damage already marked (Morgana)', () => {
  it('doubles the damage on the target', () => {
    // Tests Rule 573: damage dealt by an effect
    const e = parseCardAbilities(
      'When you play me, deal damage to a unit equal to the damage marked on it.',
    )?.triggers[0]?.effects as CardEffect[];
    expect(e[0]).toMatchObject({ op: 'DAMAGE_TARGET', amountFrom: 'TARGET_DAMAGE' });
    const sc = Scenario.start({});
    const victim = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const s = structuredClone(sc.state);
    (s.objects[victim] as { damage: number }).damage = 2;
    runEffects(s, 'p0', e, sc.cards, [{ kind: 'object', id: victim }]);
    expect(s.objects[victim]?.damage).toBe(4);
  });

  it("moves any number of friendly units from battlefields to the Base (Emperor's Divide)", () => {
    // Tests Rule 573: effects move units
    const e = parseSpellText('Move any number of friendly units at a battlefield to their base.');
    expect(e?.[0]).toMatchObject({
      op: 'MOVE_BASE_TARGET',
      side: 'friendly',
      count: { min: 0, max: 99 },
    });
  });
});

describe('scenario: "this turn" triggers (Rally the Troops, Fanfare, Imperial Decree)', () => {
  const delayedOf = (text: string): CardEffect[] => parseSpellText(text) as CardEffect[];
  const arm = (sc: Scenario, text: string): void => {
    runEffects(sc.state, 'p0', delayedOf(text), sc.cards, [], 'fx-flare', '');
  };
  const resolve = (sc: Scenario): void => {
    for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
      sc.pass(sc.state.flow.priority as 'p0' | 'p1');
    }
  };

  it('buffs every friendly unit played afterwards, once it is on the board', () => {
    // Tests Rule 583: triggered effects
    const sc = Scenario.start({});
    arm(sc, 'When a friendly unit is played this turn, buff it.');
    const grunt = sc.putInHand('p0', 'fx-grunt');
    sc.play('p0', grunt, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    resolve(sc);
    expect(sc.obj(grunt).zone.kind).toBe('base');
    expect(sc.obj(grunt).buffed).toBe(true);
  });

  it('draws for the next N units only', () => {
    // Tests Rule 583: triggered effects
    const sc = Scenario.start({});
    arm(sc, 'The next two times you play a unit this turn, draw 1.');
    expect(sc.state.delayed?.[0]).toMatchObject({ times: 2 });
    const one = sc.putInHand('p0', 'fx-grunt');
    const before = sc.state.players[0]?.hand.length ?? 0;
    sc.play('p0', one, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    resolve(sc);
    expect(sc.state.players[0]?.hand.length).toBe(before); // one played, one drawn
    expect(sc.state.delayed?.[0]?.times).toBe(1);
  });

  it('kills a unit that takes damage, and lasts only this turn', () => {
    // Tests Rule 583: triggered effects
    const effects = parseSpellText('Deal 1 to an enemy unit.') as CardEffect[];
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-flare': { ...base('fx-flare'), supportLevel: 'full', effects },
    };
    const sc = Scenario.start({}, cards);
    arm(sc, 'When any unit takes damage this turn, kill it.');
    const victim = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const flare = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', flare, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: victim }],
    });
    resolve(sc);
    expect(['trash', 'banishment']).toContain(sc.obj(victim).zone.kind);
    const next = expireTurnEffects(sc.state, cards).state;
    expect(next.delayed).toBeUndefined();
  });
});
