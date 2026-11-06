// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TOKEN_CARDS } from '@riftbound/engine';
import type { CardDatabase, CardDef, CardTrigger, S2C, C2S } from '@riftbound/engine';
import { FIXTURE_DECK_A, FIXTURE_DECK_B } from '../../../engine/src/testing/fixtures';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario';
import { GameProvider } from '../app/gameApi';
import { HostSession } from '../host/hostSession';
import { HostTimers } from '../app/hostTimers';
import { createHostBridge } from '../app/adapters';
import { createLoopbackHub } from '../net/loopbackTransport';
import { GuestSession, type KeyValueStorage } from '../net/guestSession';
import { describeOptionalCost, describePlan, OptionalPrompt } from './OptionalPrompt';
import { fakeApi, type FakeApi } from './testing/fakeApi';

afterEach(cleanup);

const PAY_ONE_TO_DRAW: CardTrigger = {
  on: 'PLAY',
  optional: { energy: 1 },
  effects: [{ op: 'DRAW', amount: 1 }],
};
const cardsWith = (trigger: CardTrigger): CardDatabase => ({
  ...SCENARIO_CARDS,
  ...TOKEN_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), triggers: [trigger] },
});

/** p0 played Cinder Grunt and both passed: the optional ability waits for p0. */
function paused(trigger: CardTrigger = PAY_ONE_TO_DRAW): Scenario {
  const sc = Scenario.start({}, cardsWith(trigger));
  sc.giveRunes('p0', 4);
  const unit = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
  sc.pass('p1');
  sc.pass('p0');
  return sc;
}

const mount = (api: FakeApi) =>
  render(
    <GameProvider value={api}>
      <OptionalPrompt />
    </GameProvider>,
  );

describe('OptionalPrompt (R45)', () => {
  it('shows the card, its cost and the automatic payment to the controller', () => {
    const sc = paused();
    expect(sc.state.flow.pendingChoice?.kind).toBe('OPTIONAL_EFFECT');
    mount(fakeApi(sc, 'p0'));
    expect(screen.getByRole('dialog', { name: /Cinder Grunt/ })).toBeInTheDocument();
    expect(screen.getByTestId('optional-cost')).toHaveTextContent('Cost: Pay 1 Energy.');
    expect(screen.getByTestId('optional-cost')).toHaveTextContent('Payment exhausts 1 rune.');
    expect(screen.getByTestId('optional-accept')).toHaveTextContent('Pay and do it');
    expect(screen.getByTestId('optional-decline')).toBeEnabled();
  });

  it('sends the engine accept intent (with its payment plan) or the decline intent', async () => {
    const sc = paused();
    const api = fakeApi(sc, 'p0');
    mount(api);
    fireEvent.click(screen.getByTestId('optional-accept'));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    const sent = api.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ type: 'DECIDE_OPTIONAL', playerId: 'p0', accept: true });
    expect((sent as { payment?: unknown[] }).payment).toHaveLength(1);
    fireEvent.click(screen.getByTestId('optional-decline'));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send.mock.calls[1]![0]).toMatchObject({ type: 'DECIDE_OPTIONAL', accept: false });
  });

  it('a free "you may" says so and has no payment line', () => {
    mount(
      fakeApi(paused({ on: 'PLAY', optional: {}, effects: [{ op: 'DRAW', amount: 1 }] }), 'p0'),
    );
    expect(screen.getByTestId('optional-cost')).toHaveTextContent('No cost.');
    expect(screen.getByTestId('optional-accept')).toHaveTextContent('Yes, do it');
  });

  it('shows only a waiting notice (no buttons) to the other player', () => {
    mount(fakeApi(paused(), 'p1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('optional-waiting')).toHaveTextContent(
      'Your opponent is deciding whether to use Cinder Grunt.',
    );
  });

  it('renders nothing when no optional ability is pending', () => {
    const { container } = mount(fakeApi(Scenario.start(), 'p0'));
    expect(container).toBeEmptyDOMElement();
  });

  it('words costs and plans', () => {
    expect(describeOptionalCost({ energy: 1, power: 1 }, ['Fury'])).toBe(
      'Pay 1 Energy and 1 Power (Fury)',
    );
    expect(describeOptionalCost({ anyPower: 4 }, [])).toBe('Pay 4 Power (any Domain)');
    expect(describeOptionalCost({ burn: 1 }, [])).toContain('Burn 1 card ');
    expect(describeOptionalCost({}, [])).toBe('Free');
    expect(describePlan([])).toBe('Paid from your Rune Pool.');
    expect(
      describePlan([
        { runeId: 'a', mode: 'EXHAUST' },
        { runeId: 'b', mode: 'RECYCLE' },
      ]),
    ).toBe('Payment exhausts 1 rune and recycles 1 rune.');
  });
});

describe('optional ability: host timeout and the wire (R45)', () => {
  it('the host timeout declines and never pays on the players behalf', () => {
    vi.useFakeTimers();
    try {
      const sc = paused();
      const cards = sc.cards;
      const bridge = createHostBridge();
      const session = new HostSession({
        cards,
        state: sc.state,
        hostSeat: 'p0',
        ...bridge.callbacks,
      });
      const timers = new HostTimers({
        session,
        cards,
        bridge,
        humanSeats: ['p0', 'p1'],
        reactionWindowMs: 1000,
      });
      const hand = sc.player('p0').hand.length;
      vi.advanceTimersByTime(1001);
      const after = session.getFullStateForPersistence();
      expect(after.flow.pendingChoice).toBeUndefined();
      expect(after.flow.chain).toHaveLength(0);
      expect(after.players[0]!.hand).toHaveLength(hand); // no draw: declined, nothing paid
      timers.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a guest sees the pending choice and answers it over the wire', async () => {
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    const mem = (): KeyValueStorage => {
      const m = new Map<string, string>();
      return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
    };
    const cards = cardsWith(PAY_ONE_TO_DRAW);
    const hub = createLoopbackHub<S2C, C2S>();
    const host = HostSession.create({
      cards,
      hostDeck: FIXTURE_DECK_A,
      guestDeck: FIXTURE_DECK_B,
      seed: 'optional-wire',
      mode: 'MULTIPLAYER',
    });
    hub.hostOnConnection((t) => host.acceptGuest(t));
    const guest = new GuestSession({ transport: hub.connectGuest(), storage: mem() });
    await flush();
    const sc = paused();
    host.restore(sc.state);
    await flush();
    const pc = sc.state.flow.pendingChoice as { chainItemId: string };
    if (host.guestSeat === 'p0') {
      expect(guest.view?.flow.pendingChoice).toMatchObject({
        kind: 'OPTIONAL_EFFECT',
        player: 'p0',
      });
      const hint = guest.legal.find((i) => i.type === 'DECIDE_OPTIONAL' && i.accept);
      expect(hint).toBeDefined();
      guest.sendIntent(hint!);
      await flush();
    } else {
      const r = host.localIntent({
        type: 'DECIDE_OPTIONAL',
        playerId: 'p0',
        chainItemId: pc.chainItemId,
        accept: true,
      });
      expect(r.ok).toBe(true);
      await flush();
    }
    expect(host.getFullStateForPersistence().flow.pendingChoice).toBeUndefined();
    expect(guest.view?.flow.pendingChoice).toBeUndefined();
  });
});
