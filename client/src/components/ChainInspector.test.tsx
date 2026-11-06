// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { CardDef } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import { GameProvider } from '../app/gameApi';
import { ChainInspector } from './ChainInspector';
import { combatShowdown } from './testing/combatScenario';
import { fakeApi, type FakeApi } from './testing/fakeApi';

afterEach(cleanup);

function mount(api: FakeApi) {
  return render(
    <GameProvider value={api}>
      <ChainInspector />
    </GameProvider>,
  );
}

/** p0 played Flare Bolt (Action); p1 holds priority with Tidal Guard (Reaction) in hand. */
function flareOnChain() {
  const sc = Scenario.start();
  const flare = sc.putInHand('p0', 'fx-flare');
  sc.giveRunes('p1', 2);
  const guard = sc.putInHand('p1', 'fx-tide-guard');
  sc.play('p0', flare, { payment: sc.exhaustPlan('p0', 1) });
  return { sc, flare, guard };
}

describe('ChainInspector', () => {
  it('shows "Chain empty" and the Neutral Open badge when nothing is happening', () => {
    const sc = Scenario.start();
    mount(fakeApi(sc, 'p0'));
    expect(screen.getByText('Chain empty')).toBeInTheDocument();
    expect(screen.getByTestId('turn-state')).toHaveTextContent('Neutral Open');
    expect(screen.getByTestId('turn-state').title).toMatch(/Neutral Open/);
    expect(screen.queryByRole('button', { name: /Pass/ })).toBeNull();
  });

  it('lists chain items newest first with controller and status', () => {
    const { sc, guard } = flareOnChain();
    sc.play('p1', guard, { payment: sc.exhaustPlan('p1', 1) });
    expect(sc.state.flow.chain).toHaveLength(2);
    mount(fakeApi(sc, 'p0'));

    const list = screen.getByRole('list', { name: 'Chain items, newest first' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Tidal Guard');
    expect(items[0]).toHaveTextContent('Opponent');
    expect(items[0]).toHaveTextContent('FINALIZED');
    expect(items[1]).toHaveTextContent('Flare Bolt');
    expect(items[1]).toHaveTextContent('You');
    expect(screen.getByTestId('turn-state')).toHaveTextContent('Neutral Closed');
    expect(screen.queryByText('Chain empty')).toBeNull();
  });

  it('highlights who holds Priority', () => {
    const { sc } = flareOnChain();
    mount(fakeApi(sc, 'p0'));
    expect(screen.getByTestId('holder-priority')).toHaveTextContent('Priority: Opponent');
    expect(screen.getByTestId('holder-focus')).toHaveTextContent('Focus: nobody');
  });

  it('Pass (resolve) sends the legal PASS_PRIORITY', async () => {
    const { sc } = flareOnChain();
    const api = fakeApi(sc, 'p1');
    mount(api);
    expect(screen.getByTestId('holder-priority')).toHaveTextContent('Priority: You');
    fireEvent.click(screen.getByRole('button', { name: 'Pass (resolve)' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    const legalPass = api.legal.find((i) => i.type === 'PASS_PRIORITY');
    expect(legalPass).toBeDefined();
    expect(api.send).toHaveBeenCalledWith(legalPass);
    expect(api.send).toHaveBeenCalledWith({ type: 'PASS_PRIORITY', playerId: 'p1' });
  });

  it('has no Pass button when the opponent has priority', () => {
    const { sc } = flareOnChain();
    mount(fakeApi(sc, 'p0'));
    expect(screen.queryByRole('button', { name: /Pass/ })).toBeNull();
  });

  it('lists Reactions you can play now and sends the legal PLAY_CARD', async () => {
    const { sc } = flareOnChain();
    const api = fakeApi(sc, 'p1');
    mount(api);
    expect(screen.getByText('Reactions you can play now')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Tidal Guard' });
    fireEvent.click(btn);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    const sent = api.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ type: 'PLAY_CARD', playerId: 'p1' });
    expect(sc.obj((sent as { cardInstanceId: string }).cardInstanceId).cardId).toBe(
      'fx-tide-guard',
    );
    expect(api.legal).toContainEqual(sent);
    // Tide Surge style Actions are not offered (only Reaction cards)
    expect(screen.queryByRole('button', { name: 'Tide Surge' })).toBeNull();
  });

  it('badges chain items whose effect is not implemented', () => {
    const { sc } = flareOnChain();
    const odd = sc.putInHand('p1', 'fx-odd-reaction');
    sc.play('p1', odd, { payment: sc.exhaustPlan('p1', 1) });
    mount(fakeApi(sc, 'p0'));
    const items = within(screen.getByRole('list', { name: /Chain items/ })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('Odd Whisper');
    expect(items[0]).toHaveTextContent('effect not implemented');
    expect(items[1]).not.toHaveTextContent('effect not implemented');
  });

  it('in a Showdown with an empty Chain: shows the battlefield, Focus and "Pass focus"', async () => {
    const { sc } = combatShowdown(['fx-ash-tank'], ['fx-order-tank']);
    const api = fakeApi(sc, 'p0');
    mount(api);
    expect(screen.getByTestId('turn-state')).toHaveTextContent('Showdown Open');
    expect(screen.getByTestId('chain-showdown')).toHaveTextContent('Showdown at Test Battlefield');
    expect(screen.getByTestId('holder-focus')).toHaveTextContent('Focus: You');
    expect(screen.getByText('Chain empty')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pass focus' }));
    await waitFor(() =>
      expect(api.send).toHaveBeenCalledWith({ type: 'PASS_PRIORITY', playerId: 'p0' }),
    );
  });

  it('shows rejections inline', async () => {
    const { sc } = flareOnChain();
    const api = fakeApi(sc, 'p1', {
      sendResult: { ok: false, code: 'NOT_YOUR_PRIORITY', message: '[Rule Error] nope' },
    });
    mount(api);
    fireEvent.click(screen.getByRole('button', { name: 'Pass (resolve)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('[Rule Error] nope');
  });

  it('names the Battlefield card for a battlefield-sourced ability (R44)', () => {
    const cards = { ...SCENARIO_CARDS };
    for (const id of ['fx-bf-1', 'fx-bf-2', 'fx-bf-3', 'fx-bf-4', 'fx-bf-5', 'fx-bf-6']) {
      cards[id] = {
        ...(SCENARIO_CARDS[id] as CardDef),
        supportLevel: 'full',
        triggers: [{ on: 'CONQUER', effects: [{ op: 'DRAW', amount: 1 }] }],
      };
    }
    const sc = Scenario.start({}, cards);
    const unit = sc.putUnit('p0', 'fx-grunt', 'base');
    sc.do({
      type: 'STANDARD_MOVE',
      playerId: 'p0',
      unitIds: [unit],
      destination: { kind: 'battlefield', battlefieldId: 'bf1' },
    });
    sc.pass('p0');
    sc.pass('p1');
    expect(sc.state.flow.chain[0]?.sourceBattlefieldId).toBe('bf1');
    const bfName = cards[sc.state.battlefields[1]!.cardId]!.name;
    mount(fakeApi(sc, 'p1'));
    const list = screen.getByRole('list', { name: 'Chain items, newest first' });
    const [item] = within(list).getAllByRole('listitem');
    expect(item).toHaveTextContent(bfName);
    expect(item).toHaveTextContent('battlefield ability');
    expect(item).not.toHaveTextContent('Unknown card');
  });
});
