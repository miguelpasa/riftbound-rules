import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import {
  parseBattlefieldAbilities,
  parseCardAbilities,
  parseSpellText,
  parseStaticLines,
} from '../cardText.js';
import { scoreBattlefield } from '../scoring.js';
import { endCombatGrants, runEffects } from '../effects.js';
import { effectiveMight } from '../combat.js';
import { reduce } from '../reducer.js';
import type { CardDatabase, CardDef } from '../types/index.js';

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
