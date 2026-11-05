/** R36 keyword fixes: Equip cost, Quick-Draw speed, Hidden gear, Temporary gear, Deflect gear. */
import { describe, expect, it } from 'vitest';
import { passPriority } from '../chain.js';
import { runCleanup } from '../cleanup.js';
import {
  deflectExtraCost,
  equip,
  equipTotalCost,
  hideCard,
  playHiddenCard,
  temporaryOnBeginning,
} from '../keywords.js';
import { getLegalActions } from '../legalActions.js';
import { ENGINE_HOOKS, reduce } from '../reducer.js';
import { autoPlan, computeTotalCost } from '../resources.js';
import { FIXTURE_CARDS, makeTestGame } from '../testing/fixtures.js';
import type {
  CardDatabase,
  CardDef,
  CardInstance,
  EquipCost,
  GameState,
  PlayerId,
  ReduceResult,
  ZoneRef,
} from '../types/index.js';

const idx = (p: PlayerId): 0 | 1 => (p === 'p0' ? 0 : 1);
function ok(r: ReduceResult): Extract<ReduceResult, { ok: true }> {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r;
}
function code(r: ReduceResult): string {
  if (r.ok) throw new Error('expected an error');
  return r.code;
}

const gear = (
  cardId: string,
  over: Partial<CardDef> & { equipCost?: EquipCost } = {},
): CardDef => ({
  cardId,
  name: cardId,
  type: 'GEAR',
  subtypes: ['Equipment'],
  cost: { energy: 1 },
  domains: ['Fury'],
  stats: { might: 2 },
  keywords: [{ name: 'Equip' }],
  text: '',
  supportLevel: 'full',
  ...over,
});

const CARDS: CardDatabase = {
  ...FIXTURE_CARDS,
  'rx-free': gear('rx-free'),
  'rx-c': gear('rx-c', { equipCost: { energy: 0, power: 1, anyPower: 0 } }),
  'rx-c-mind': gear('rx-c-mind', {
    domains: ['Mind'],
    equipCost: { energy: 0, power: 1, anyPower: 0 },
  }),
  'rx-1c': gear('rx-1c', { equipCost: { energy: 1, power: 1, anyPower: 0 } }),
  'rx-a': gear('rx-a', { equipCost: { energy: 0, power: 0, anyPower: 1 } }),
  'rx-might': gear('rx-might', {
    equipCost: { energy: 3, power: 0, anyPower: 1, energyReducedByMight: true },
  }),
  'rx-qd': gear('rx-qd', {
    keywords: [{ name: 'QuickDraw' }],
    subtypes: ['Equipment'],
    stats: { might: 1 },
  }),
  'rx-hidden-gear': gear('rx-hidden-gear', {
    keywords: [{ name: 'Hidden' }],
    cost: { energy: 4 },
  }),
  'rx-temp-gear': gear('rx-temp-gear', { keywords: [{ name: 'Temporary' }] }),
  'rx-deflect-gear': gear('rx-deflect-gear', { keywords: [{ name: 'Deflect', value: 2 }] }),
  'rx-temp-token': {
    ...gear('rx-temp-token', { keywords: [{ name: 'Temporary' }] }),
    type: 'TOKEN',
  },
};

let counter = 0;
function spawn(
  s: GameState,
  cardId: string,
  owner: PlayerId,
  zone: ZoneRef = { kind: 'base', player: owner },
): string {
  const id = `rk${counter++}`;
  const o: CardInstance = {
    id,
    cardId,
    owner,
    controller: owner,
    zone,
    ready: true,
    damage: 0,
    mightBonus: 0,
  };
  s.objects[id] = o;
  const p = s.players[idx(owner)];
  if (zone.kind === 'base') p.base.push(id);
  if (zone.kind === 'hand') p.hand.push(id);
  return id;
}

function giveRunes(s: GameState, owner: PlayerId, runeCardId: string, n: number): void {
  const p = s.players[idx(owner)];
  const ids = p.runeDeck.filter((i) => s.objects[i]?.cardId === runeCardId).slice(0, n);
  for (const id of ids) {
    p.runeDeck = p.runeDeck.filter((i) => i !== id);
    p.base.push(id);
    const o = s.objects[id] as CardInstance;
    o.zone = { kind: 'base', player: owner };
    o.ready = true;
  }
}

function setup(rune = 'fx-rune-fury', n = 6): { s: GameState; bf: string } {
  const s = makeTestGame('kw');
  s.flow.priority = 'p0';
  const b0 = s.battlefields[0];
  if (!b0) throw new Error('battlefield');
  b0.controller = 'p0';
  giveRunes(s, 'p0', rune, n);
  return { s, bf: b0.id };
}

const runeCount = (s: GameState): number =>
  s.players[0].base.filter((i) => s.objects[i]?.cardId.startsWith('fx-rune')).length;
const readyRunes = (s: GameState): number =>
  s.players[0].base.filter((i) => s.objects[i]?.cardId.startsWith('fx-rune') && s.objects[i]?.ready)
    .length;

describe('R36 Equip cost (Rule 818)', () => {
  const doEquip = (s: GameState, eq: string, unit: string): ReduceResult =>
    equip(s, CARDS, { type: 'EQUIP', playerId: 'p0', equipmentId: eq, unitId: unit });

  it('builds Energy and Power requirements from the structured cost', () => {
    // Tests Rule 818: the Equip cost may include Energy and Power
    const { s } = setup();
    const u = spawn(s, 'fx-grunt', 'p0');
    const uo = s.objects[u] as CardInstance;
    expect(equipTotalCost(s, CARDS, CARDS['rx-free'] as CardDef)).toEqual({ energy: 0, power: [] });
    expect(equipTotalCost(s, CARDS, CARDS['rx-1c'] as CardDef)).toEqual({
      energy: 1,
      power: [{ domain: 'Fury', amount: 1 }],
    });
    expect(equipTotalCost(s, CARDS, CARDS['rx-a'] as CardDef)).toEqual({
      energy: 0,
      power: [{ domain: 'ANY', amount: 1 }],
    });
    // [3][A] reduced by the Might of the chosen unit (grunt has Might 2)
    expect(equipTotalCost(s, CARDS, CARDS['rx-might'] as CardDef, uo).energy).toBe(1);
  });

  it('pays Energy and Power through the rune machinery', () => {
    // Tests Rule 818: Equip [1][C] spends one Energy and one Fury Power
    const { s } = setup();
    const eq = spawn(s, 'rx-1c', 'p0');
    const u = spawn(s, 'fx-grunt', 'p0');
    const r = ok(doEquip(s, eq, u));
    expect(runeCount(r.state)).toBe(5); // one rune recycled for Power
    expect(readyRunes(r.state)).toBe(4); // one exhausted for Energy
    const resolved = ok(
      passPriority(
        ok(
          passPriority(
            r.state,
            CARDS,
            { type: 'PASS_PRIORITY', playerId: 'p1' },
            ENGINE_HOOKS.resolver,
          ),
        ).state,
        CARDS,
        { type: 'PASS_PRIORITY', playerId: 'p0' },
        ENGINE_HOOKS.resolver,
      ),
    ).state;
    expect(resolved.objects[eq]?.attachedTo).toBe(u);
  });

  it('refuses when the Power domain cannot be paid, accepts [A] with any domain', () => {
    // Tests Rule 818: [C] needs Power of the Equipment domain; [A] accepts any domain
    const { s } = setup(); // only Fury runes
    const c = spawn(s, 'rx-c-mind', 'p0');
    const a = spawn(s, 'rx-a', 'p0');
    const u = spawn(s, 'fx-grunt', 'p0');
    expect(code(doEquip(s, c, u))).toBe('INSUFFICIENT_RESOURCES');
    expect(doEquip(s, a, u).ok).toBe(true);
  });

  it('stays free when the card has no parsed cost', () => {
    // Tests Rule 818: Equip without a parsable cost costs nothing
    const { s } = setup();
    const eq = spawn(s, 'rx-free', 'p0');
    const u = spawn(s, 'fx-grunt', 'p0');
    const r = ok(doEquip(s, eq, u));
    expect(runeCount(r.state)).toBe(6);
    expect(readyRunes(r.state)).toBe(6);
  });
});

describe('R36 Quick-Draw Reaction speed (Rule 819)', () => {
  it('can be played in a Closed State without an explicit Reaction keyword', () => {
    // Tests Rule 819: Quick-Draw has Reaction inherently
    const { s } = setup();
    spawn(s, 'fx-grunt', 'p0');
    const u = spawn(s, 'fx-grunt', 'p0');
    const qd = spawn(s, 'rx-qd', 'p0', { kind: 'hand', player: 'p0' });
    s.flow.chain.push({
      id: 'c1',
      kind: 'CARD',
      sourceObjectId: spawn(s, 'fx-flare', 'p1', { kind: 'chain', player: 'p1' }),
      controller: 'p1',
      status: 'FINALIZED',
      targets: [],
      choices: {},
    });
    s.turnState = { ...s.turnState, open: false } as GameState['turnState'];
    s.flow.priority = 'p0';
    const plan = autoPlan(s, CARDS, 'p0', computeTotalCost(CARDS['rx-qd'] as CardDef));
    if (!plan) throw new Error('cannot pay');
    const intent = {
      type: 'PLAY_CARD' as const,
      playerId: 'p0' as const,
      cardInstanceId: qd,
      payment: plan,
      targets: [{ kind: 'object' as const, id: u }],
    };
    expect(reduce(s, CARDS, intent).ok).toBe(true);
    expect(getLegalActions(s, CARDS, 'p0').some((i) => i.type === 'PLAY_CARD')).toBe(true);
  });
});

describe('R36 Hidden gear (Rule 811)', () => {
  it('is played to the battlefield it was hidden at and is recalled by Cleanup', () => {
    // Tests Rule 811: Hidden Gear enters the battlefield where it was hidden
    const { s, bf } = setup();
    const g = spawn(s, 'rx-hidden-gear', 'p0', { kind: 'hand', player: 'p0' });
    const hidden = ok(
      hideCard(s, CARDS, {
        type: 'HIDE_CARD',
        playerId: 'p0',
        cardInstanceId: g,
        battlefieldId: bf,
      }),
    ).state;
    expect(hidden.battlefields[0]?.facedownSlotId).toBe(g);
    const later = structuredClone(hidden);
    later.turn.number += 1;
    later.flow.priority = 'p0';
    const played = ok(
      playHiddenCard(later, CARDS, {
        type: 'PLAY_CARD',
        playerId: 'p0',
        cardInstanceId: g,
        payment: [],
      }),
    ).state;
    expect(played.objects[g]?.zone).toEqual({
      kind: 'battlefield',
      player: 'p0',
      battlefieldId: bf,
    });
    expect(played.battlefields[0]?.facedownSlotId).toBeNull();
    // 323.6: Cleanup recalls the non-unit permanent to the Base
    const cleaned = ok(runCleanup(played, CARDS)).state;
    expect(cleaned.objects[g]?.zone).toEqual({ kind: 'base', player: 'p0' });
    expect(cleaned.players[0].base).toContain(g);
  });

  it('a gear played from hand still cannot target a battlefield location', () => {
    // Tests Rule 811: only Hidden permanents may enter a battlefield from the facedown zone
    const { s, bf } = setup();
    const g = spawn(s, 'rx-free', 'p0', { kind: 'hand', player: 'p0' });
    const r = reduce(s, CARDS, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: g,
      location: { kind: 'battlefield', battlefieldId: bf },
      payment: [],
    });
    expect(code(r)).toBe('ILLEGAL_LOCATION');
  });
});

describe('R36 Hide timing decision (Rule 811 / 411.1.a)', () => {
  it('stays Neutral Open only: Hide is a Discretionary Action', () => {
    // Tests Rule 411.1: Discretionary Actions are performed in a Neutral Open State on your turn
    const { s, bf } = setup();
    const g = spawn(s, 'rx-hidden-gear', 'p0', { kind: 'hand', player: 'p0' });
    s.flow.showdown = { battlefieldId: bf, passesInRow: 0 } as never;
    s.turnState = { kind: 'SHOWDOWN', open: true } as GameState['turnState'];
    expect(
      hideCard(s, CARDS, {
        type: 'HIDE_CARD',
        playerId: 'p0',
        cardInstanceId: g,
        battlefieldId: bf,
      }).ok,
    ).toBe(false);
  });
});

describe('R36 Temporary Gear (Rule 816)', () => {
  it('kills Temporary Gear at its controller Beginning phase and detaches it', () => {
    // Tests Rule 816: Temporary permanents (Gear included) are killed at the start of the Beginning Phase
    const { s } = setup();
    const u = spawn(s, 'fx-grunt', 'p0');
    const g = spawn(s, 'rx-temp-gear', 'p0');
    (s.objects[g] as CardInstance).attachedTo = u;
    const theirs = spawn(s, 'rx-temp-gear', 'p1');
    const r = temporaryOnBeginning(s, CARDS);
    expect(r.state.objects[g]?.zone).toEqual({ kind: 'trash', player: 'p0' });
    expect(r.state.objects[g]?.attachedTo).toBeUndefined();
    expect(r.state.players[0].base).not.toContain(g);
    expect(r.state.players[0].trash).toContain(g);
    expect(r.state.objects[theirs]?.zone.kind).toBe('base'); // not its controller's turn
  });

  it('removes a Temporary token from the game (186.1)', () => {
    // Tests Rule 816: a Temporary token is killed and ceases to exist
    const { s } = setup();
    const t = spawn(s, 'rx-temp-token', 'p0');
    const r = temporaryOnBeginning(s, CARDS);
    expect(r.state.objects[t]).toBeUndefined();
  });
});

describe('R36 Deflect on Gear (Rule 809)', () => {
  it('charges the extra Power when an opponent targets a Deflect Gear, once per choice', () => {
    // Tests Rule 809: Deflect applies to any permanent and is paid each time it is chosen
    const { s } = setup();
    const g = spawn(s, 'rx-deflect-gear', 'p1');
    const mine = spawn(s, 'rx-deflect-gear', 'p0');
    const t = (id: string) => ({ kind: 'object' as const, id });
    expect(deflectExtraCost(s, CARDS, 'p0', [t(g)])).toEqual({ anyPower: 2 });
    expect(deflectExtraCost(s, CARDS, 'p0', [t(g), t(g)])).toEqual({ anyPower: 4 });
    expect(deflectExtraCost(s, CARDS, 'p0', [t(mine)])).toBeNull();
  });
});
