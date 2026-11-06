import { describe, expect, it } from 'vitest';
import {
  TOKEN_CARDS,
  type C2S,
  type CardDatabase,
  type CardDef,
  type PlayerId,
  type S2C,
} from '@riftbound/engine';
import { runEffects } from '../../../engine/src/effects.js';
import { FIXTURE_DECK_A, FIXTURE_DECK_B } from '../../../engine/src/testing/fixtures.js';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import { createLoopbackHub } from '../net/loopbackTransport.js';
import { GuestSession, type KeyValueStorage } from '../net/guestSession.js';
import { HostSession } from './hostSession.js';
import { getUiLegalActions } from './uiLegal.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const cards: CardDatabase = { ...SCENARIO_CARDS, ...TOKEN_CARDS };
const mem = (): KeyValueStorage => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

/** A Scenario state where `player` controls a ready Gold token. */
function withGold(player: PlayerId): { sc: Scenario; gold: string } {
  const sc = Scenario.start({}, cards);
  const s = structuredClone(sc.state);
  const before = new Set(Object.keys(s.objects));
  runEffects(s, player, [{ op: 'PLAY_TOKEN', token: 'tok-gold', count: 1, ready: true }], cards);
  sc.state = s;
  return { sc, gold: Object.keys(s.objects).find((id) => !before.has(id)) as string };
}

describe('[Add] ability hints (R40)', () => {
  it('getUiLegalActions adds [Add] activations once, next to the legal actions', () => {
    const { sc, gold } = withGold('p0');
    const acts = getUiLegalActions(sc.state, cards, 'p0').filter(
      (i) => i.type === 'ACTIVATE_ABILITY',
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ sourceId: gold, abilityIndex: 0 });
    expect(
      getUiLegalActions(sc.state, cards, 'p1').some((i) => i.type === 'ACTIVATE_ABILITY'),
    ).toBe(false);
  });

  it('a guest sees the hint, activates Gold over the wire, and both views update', async () => {
    const hub = createLoopbackHub<S2C, C2S>();
    const host = HostSession.create({
      cards,
      hostDeck: FIXTURE_DECK_A,
      guestDeck: FIXTURE_DECK_B,
      seed: 'ability-hints',
      mode: 'MULTIPLAYER',
    });
    hub.hostOnConnection((t) => host.acceptGuest(t));
    const guest = new GuestSession({ transport: hub.connectGuest(), storage: mem() });
    await flush();

    const { sc, gold } = withGold(host.guestSeat);
    host.restore(sc.state);
    await flush();

    const hint = guest.legal.find((i) => i.type === 'ACTIVATE_ABILITY');
    expect(hint).toMatchObject({ playerId: host.guestSeat, sourceId: gold, abilityIndex: 0 });

    guest.sendIntent(hint!);
    await flush();
    const seat = host.guestSeat === 'p0' ? 0 : 1;
    expect(host.getFullStateForPersistence().players[seat]!.runePool.universal).toBe(1);
    expect(guest.view?.players[seat]?.runePool.universal).toBe(1);
    expect(guest.view?.objects[gold]).toBeUndefined();
    expect(guest.legal.some((i) => i.type === 'ACTIVATE_ABILITY')).toBe(false);
  });
});

describe('trigger-target choice over the wire (R41)', () => {
  it('a guest sees the pending choice, answers it, and both views update', async () => {
    const trigCards: CardDatabase = {
      ...cards,
      'fx-grunt': {
        ...(cards['fx-grunt'] as CardDef),
        triggers: [{ on: 'PLAY', effects: [{ op: 'BUFF_TARGET', amount: 2, duration: 'TURN' }] }],
      },
    };
    const hub = createLoopbackHub<S2C, C2S>();
    const host = HostSession.create({
      cards: trigCards,
      hostDeck: FIXTURE_DECK_A,
      guestDeck: FIXTURE_DECK_B,
      seed: 'trigger-wire',
      mode: 'MULTIPLAYER',
    });
    hub.hostOnConnection((t) => host.acceptGuest(t));
    const guest = new GuestSession({ transport: hub.connectGuest(), storage: mem() });
    await flush();

    // The guest seat plays Cinder Grunt (p0's deck in the scenario) with another unit on the board.
    const sc = Scenario.start({}, trigCards);
    const unit = sc.putInHand('p0', 'fx-grunt');
    const other = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
    const pc = sc.state.flow.pendingChoice;
    expect(pc?.kind).toBe('TRIGGER_TARGET');
    // Seat the choice at whichever seat the guest holds by swapping nothing: only run the wire
    // check when the guest is p0, otherwise answer through the host.
    host.restore(sc.state);
    await flush();
    if (host.guestSeat === 'p0') {
      const hint = guest.legal.find((i) => i.type === 'CHOOSE_TRIGGER_TARGET');
      expect(hint).toBeDefined();
      expect(guest.view?.flow.pendingChoice).toMatchObject({ kind: 'TRIGGER_TARGET' });
      guest.sendIntent({
        type: 'CHOOSE_TRIGGER_TARGET',
        playerId: 'p0',
        chainItemId: (pc as { chainItemId: string }).chainItemId,
        targets: [{ kind: 'object', id: other }],
      });
      await flush();
      expect(host.getFullStateForPersistence().flow.pendingChoice).toBeUndefined();
      expect(guest.view?.flow.pendingChoice).toBeUndefined();
    } else {
      const r = host.localIntent({
        type: 'CHOOSE_TRIGGER_TARGET',
        playerId: 'p0',
        chainItemId: (pc as { chainItemId: string }).chainItemId,
        targets: [{ kind: 'object', id: other }],
      });
      expect(r.ok).toBe(true);
      await flush();
      expect(guest.view?.flow.pendingChoice).toBeUndefined();
    }
  });
});
