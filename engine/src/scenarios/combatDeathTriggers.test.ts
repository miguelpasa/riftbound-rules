import { describe, it, expect } from 'vitest';
import { SCENARIO_CARDS, Scenario } from '../testing/scenario.js';
import { effectiveMight } from '../combat.js';
import { parseCardAbilities } from '../cardText.js';
import type { CardDatabase, CardDef, CardTrigger } from '../types/index.js';

const toBf = (bfId: string) => ({ kind: 'battlefield' as const, battlefieldId: bfId });
const BUFF2: CardTrigger['effects'] = [{ op: 'BUFF_SELF', amount: 2 }];
const DRAW1: CardTrigger['effects'] = [{ op: 'DRAW', amount: 1 }];

const withCards = (patch: Record<string, Partial<CardDef>>): CardDatabase => {
  const out: CardDatabase = { ...SCENARIO_CARDS };
  for (const [id, p] of Object.entries(patch))
    out[id] = { ...(SCENARIO_CARDS[id] as CardDef), ...p };
  out['fx-flare'] = {
    ...(out['fx-flare'] as CardDef),
    supportLevel: 'partial',
    effects: [{ op: 'KILL_TARGET' }],
  };
  return out;
};

/** Resolve everything on the Chain (triggers included). */
function settle(sc: Scenario): void {
  for (let i = 0; i < 20 && sc.state.flow.chain.length > 0; i++) {
    sc.pass(sc.state.flow.priority as 'p0' | 'p1');
  }
}

/** p0 casts a (kill) Flare on `target` and lets it resolve with all its consequences. */
function kill(sc: Scenario, target: string): void {
  const spell = sc.putInHand('p0', 'fx-flare');
  sc.play('p0', spell, {
    payment: sc.exhaustPlan('p0', 1),
    targets: [{ kind: 'object', id: target }],
  });
  sc.pass('p1');
  sc.pass('p0');
  settle(sc);
}

const mightOf = (sc: Scenario, id: string): number =>
  effectiveMight(sc.state, sc.cards, id, { role: null });

describe('scenario: "When a unit dies" triggers (R71)', () => {
  it('fires for each friendly unit that dies, but not for the source itself', () => {
    // Tests Rule 323.4: units die in Cleanup; a triggered ability goes on the Chain (303)
    const sc = Scenario.start(
      {},
      withCards({
        'fx-ash-tank': {
          triggers: [{ on: 'UNIT_DIES', dies: { side: 'friendly' }, effects: BUFF2 }],
        },
      }),
    );
    const watcher = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const victim = sc.putUnit('p0', 'fx-grunt', 'base');
    const before = mightOf(sc, watcher);
    kill(sc, victim);
    expect(sc.obj(victim).zone.kind).toBe('trash');
    expect(mightOf(sc, watcher)).toBe(before + 2);
    sc.verify();
  });

  it('a friendly filter ignores enemy deaths and an enemy filter ignores friendly ones', () => {
    // Tests Rule 303: only the described event triggers
    const sc = Scenario.start(
      {},
      withCards({
        'fx-ash-tank': { triggers: [{ on: 'UNIT_DIES', dies: { side: 'enemy' }, effects: BUFF2 }] },
      }),
    );
    const watcher = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const mine = sc.putUnit('p0', 'fx-grunt', 'base');
    const theirs = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const before = mightOf(sc, watcher);
    kill(sc, mine);
    expect(mightOf(sc, watcher)).toBe(before);
    kill(sc, theirs);
    expect(mightOf(sc, watcher)).toBe(before + 2);
  });

  it('"here" needs the death to happen at the same battlefield as the source', () => {
    // Tests Rule 303: "here" is the source's location
    const sc = Scenario.start(
      {},
      withCards({
        'fx-ash-tank': {
          triggers: [{ on: 'UNIT_DIES', dies: { side: 'enemy', here: true }, effects: BUFF2 }],
        },
      }),
    );
    const watcher = sc.putUnit('p0', 'fx-ash-tank', 'bf1');
    const far = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const near = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const before = mightOf(sc, watcher);
    kill(sc, far);
    expect(mightOf(sc, watcher)).toBe(before);
    kill(sc, near);
    expect(mightOf(sc, watcher)).toBe(before + 2);
  });

  it('"once each turn" triggers only the first time in a turn', () => {
    // Tests Rule 303: a once-per-turn limit is part of the ability text
    const sc = Scenario.start(
      {},
      withCards({
        'fx-ash-tank': {
          triggers: [
            { on: 'UNIT_DIES', dies: { side: 'enemy' }, oncePerTurn: true, effects: BUFF2 },
          ],
        },
      }),
    );
    const watcher = sc.putUnit('p0', 'fx-ash-tank', 'base');
    const a = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const b = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const before = mightOf(sc, watcher);
    kill(sc, a);
    kill(sc, b);
    expect(mightOf(sc, watcher)).toBe(before + 2);
  });

  it('records where the unit died and whether it was alone on the death event', () => {
    // Tests Rule 323.4: the death event keeps the unit's controller and location
    const sc = Scenario.start({}, withCards({}));
    const lone = sc.putUnit('p1', 'fx-tide-grunt', 'bf1');
    const spell = sc.putInHand('p0', 'fx-flare');
    sc.play('p0', spell, {
      payment: sc.exhaustPlan('p0', 1),
      targets: [{ kind: 'object', id: lone }],
    });
    sc.pass('p1');
    const r = sc.pass('p0');
    const dead = sc.eventsOfType('UNIT_KILLED', r.events)[0];
    expect(dead).toMatchObject({ unitId: lone, controller: 'p1', at: 'bf1', alone: true });
  });
});

describe('scenario: Deathknell "if I died alone" (R71)', () => {
  const alone = (not: boolean) =>
    withCards({
      'fx-grunt': {
        triggers: [
          {
            on: 'DEATH',
            when: { kind: 'DIED_ALONE', ...(not ? { not: true } : {}) },
            effects: DRAW1,
          },
        ],
      },
    });

  it('draws only when no other friendly unit stood at its location', () => {
    // Tests Rule 323.4: death happens in Cleanup; the location is read as it died
    const sc = Scenario.start({}, alone(false));
    const lone = sc.putUnit('p0', 'fx-grunt', 'base');
    const hand = sc.player('p0').hand.length;
    kill(sc, lone);
    expect(sc.player('p0').hand.length).toBe(hand + 1);

    const sc2 = Scenario.start({}, alone(false));
    const a = sc2.putUnit('p0', 'fx-grunt', 'base');
    sc2.putUnit('p0', 'fx-ash-tank', 'base');
    const hand2 = sc2.player('p0').hand.length;
    kill(sc2, a);
    expect(sc2.player('p0').hand.length).toBe(hand2);
  });

  it('the "didn\'t die alone" form is the opposite', () => {
    // Tests Rule 323.4: the negated condition
    const sc = Scenario.start({}, alone(true));
    const a = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.putUnit('p0', 'fx-ash-tank', 'base');
    const hand = sc.player('p0').hand.length;
    kill(sc, a);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
  });
});

describe('scenario: combat end triggers (R71)', () => {
  /** p0 attacks bf1 with a Titan (7 Might); p1 defends with a lone Order Tank (3 Might). */
  function titanWins(cards: CardDatabase): { sc: Scenario; titan: string; tank: string } {
    const sc = Scenario.start({}, cards);
    const tank = sc.putUnit('p1', 'fx-order-tank', 'bf1', { control: true });
    const titan = sc.putUnit('p0', 'fx-titan', 'base');
    sc.do({ type: 'STANDARD_MOVE', playerId: 'p0', unitIds: [titan], destination: toBf('bf1') });
    sc.pass('p0');
    sc.pass('p1');
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [{ unitId: tank, amount: 7 }],
    });
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p1',
      assignments: [{ unitId: titan, amount: 3 }],
    });
    return { sc, titan, tank };
  }

  it('"When I win a combat" fires for the surviving winner', () => {
    // Tests Rule 468.3: the side with units left wins the combat
    const { sc } = titanWins(
      withCards({ 'fx-titan': { triggers: [{ on: 'WIN_COMBAT', effects: DRAW1 }] } }),
    );
    const hand = sc.player('p0').hand.length;
    settle(sc);
    expect(sc.player('p0').hand.length).toBe(hand + 1);
    expect(sc.eventsOfType('COMBAT_ENDED')).toBeDefined();
  });

  it('the loser does not trigger "win a combat", and a unit that died cannot trigger anything', () => {
    // Tests Rule 468.3: the defender's last unit died
    const { sc } = titanWins(
      withCards({ 'fx-order-tank': { triggers: [{ on: 'WIN_COMBAT', effects: DRAW1 }] } }),
    );
    const hand = sc.player('p1').hand.length;
    settle(sc);
    expect(sc.player('p1').hand.length).toBe(hand);
  });

  it('"When a combat that I was in ends" fires for survivors on either side', () => {
    // Tests Rule 468.7: the combat ends after Resolution
    const { sc, titan } = titanWins(
      withCards({ 'fx-titan': { triggers: [{ on: 'COMBAT_END', effects: BUFF2 }] } }),
    );
    const before = mightOf(sc, titan);
    settle(sc);
    expect(sc.state.flow.combat).toBeUndefined();
    expect(mightOf(sc, titan)).toBe(before + 2);
  });
});

describe('parser: combat and death triggers (R71)', () => {
  const t = (s: string) => parseCardAbilities(s)?.triggers[0];

  it('reads win / end of combat', () => {
    // Tests Rule 303: parsed trigger text
    expect(t('When I win a combat, draw 1.')).toMatchObject({ on: 'WIN_COMBAT' });
    expect(t('When a combat that I was in ends, empower me.')).toMatchObject({
      on: 'COMBAT_END',
      effects: [{ op: 'EMPOWER_SELF' }],
    });
  });

  it('reads death filters, batches and "once each turn"', () => {
    // Tests Rule 303: parsed trigger text
    expect(t('When another friendly unit dies, gain 1 XP.')).toMatchObject({
      on: 'UNIT_DIES',
      dies: { side: 'friendly' },
    });
    expect(t('When one or more friendly units die, [Buff] a friendly unit.')?.dies).toEqual({
      side: 'friendly',
      batch: true,
    });
    expect(t('Once each turn, when an enemy unit here dies, draw 1.')).toMatchObject({
      dies: { side: 'enemy', here: true },
      oncePerTurn: true,
    });
    expect(t("When an enemy unit dies while I'm at a battlefield, draw 1.")).toMatchObject({
      when: { kind: 'AT_BATTLEFIELD' },
    });
  });

  it('reads "died alone" and gear "When you play this"', () => {
    // Tests Rule 303: parsed trigger text
    expect(t('[Deathknell] — If I died alone, draw 1.')?.when).toEqual({ kind: 'DIED_ALONE' });
    expect(t("[Deathknell][>] If I didn't die alone, draw 1.")?.when).toEqual({
      kind: 'DIED_ALONE',
      not: true,
    });
    expect(t('When you play this, draw 1.')).toMatchObject({ on: 'PLAY' });
  });
});

describe('scenario: Deathknell "if I was Mighty" (Unsung Hero)', () => {
  const mighty = withCards({
    'fx-grunt': {
      triggers: [{ on: 'DEATH', when: { kind: 'DIED_MIGHTY' }, effects: DRAW1 }],
    },
  });

  it('draws only when it had 5+ Might as it died', () => {
    // Tests Rule 709: Mighty = 5+ Might, read as the unit died (it is in the Trash when the trigger resolves)
    const sc = Scenario.start({}, mighty);
    const big = sc.putUnit('p0', 'fx-grunt', 'base');
    (sc.state.objects[big] as { mightBonus: number }).mightBonus = 5;
    const hand = sc.player('p0').hand.length;
    kill(sc, big);
    expect(sc.player('p0').hand.length).toBe(hand + 1);

    const sc2 = Scenario.start({}, mighty);
    const small = sc2.putUnit('p0', 'fx-grunt', 'base');
    const hand2 = sc2.player('p0').hand.length;
    kill(sc2, small);
    expect(sc2.player('p0').hand.length).toBe(hand2);
  });

  it('parses "If I was [Mighty], draw 2."', () => {
    // Tests Rule 303: parsed trigger text
    const trig = parseCardAbilities('[Deathknell] — If I was [Mighty], draw 2.')?.triggers[0];
    expect(trig).toMatchObject({ on: 'DEATH', when: { kind: 'DIED_MIGHTY' } });
  });
});
