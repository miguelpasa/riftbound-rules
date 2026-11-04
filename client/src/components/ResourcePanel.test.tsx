// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ruleError } from '@riftbound/engine';
import { Scenario } from '../../../engine/src/testing/scenario.js';
import { GameProvider } from '../app/gameApi';
import { ResourcePanel } from './ResourcePanel';
import { fakeApi } from './testing/fakeApi';

afterEach(cleanup);

function setup(configure: (sc: Scenario) => void = () => {}, opts?: Parameters<typeof fakeApi>[2]) {
  const sc = Scenario.start();
  sc.setRunes('p0', ['Calm', 'Fury', 'Fury']);
  configure(sc);
  const api = fakeApi(sc, 'p0', opts);
  render(
    <GameProvider value={api}>
      <ResourcePanel />
    </GameProvider>,
  );
  const mine = screen.getByRole('group', { name: 'Your runes in play' });
  return { sc, api, mine };
}

describe('ResourcePanel', () => {
  it('shows my runes with domain and ready/exhausted state', () => {
    const { sc, mine } = setup((s) => s.setReady(s.runes('p0')[2]!.id, false));
    const chips = within(mine).getAllByRole('button');
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Calm rune, ready',
      'Fury rune, ready',
      'Fury rune, exhausted',
    ]);
    expect(chips[0]).toHaveAttribute('data-rune-id', sc.runes('p0')[0]!.id);
  });

  it('shows the Rune Pool: Energy and Power per Domain', () => {
    setup((s) => s.setPool('p0', 2, { Fury: 1, Calm: 3 }));
    const pool = within(screen.getByLabelText('Your Rune Pool'));
    expect(pool.getByTestId('pool-energy')).toHaveTextContent('Energy 2');
    expect(pool.getByTestId('pool-power-Fury')).toHaveTextContent('Fury 1');
    expect(pool.getByTestId('pool-power-Calm')).toHaveTextContent('Calm 3');
    expect(pool.queryByTestId('pool-power-Mind')).toBeNull();
  });

  it('shows "No Power" for an empty pool', () => {
    setup();
    const mine = screen.getByLabelText('Your Rune Pool');
    expect(within(mine).getByTestId('pool-power-none')).toBeInTheDocument();
  });

  it('exhausting a rune sends the ACTIVATE_RUNE EXHAUST intent', async () => {
    const { sc, api, mine } = setup();
    const rune = sc.runes('p0')[1]!;
    fireEvent.click(within(mine).getAllByRole('button')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Exhaust for 1 Energy' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send).toHaveBeenCalledWith({
      type: 'ACTIVATE_RUNE',
      playerId: 'p0',
      runeId: rune.id,
      mode: 'EXHAUST',
    });
  });

  it('recycling names the rune domain and sends RECYCLE', async () => {
    const { sc, api, mine } = setup();
    const calm = sc.runes('p0')[0]!;
    fireEvent.click(within(mine).getAllByRole('button')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Recycle for 1 Calm Power' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send).toHaveBeenCalledWith({
      type: 'ACTIVATE_RUNE',
      playerId: 'p0',
      runeId: calm.id,
      mode: 'RECYCLE',
    });
  });

  it('an exhausted rune cannot be exhausted again but can be recycled', () => {
    const { mine } = setup((s) => s.setReady(s.runes('p0')[1]!.id, false));
    fireEvent.click(within(mine).getAllByRole('button')[1]!);
    expect(screen.getByRole('button', { name: 'Exhaust for 1 Energy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Recycle for 1 Fury Power' })).toBeEnabled();
  });

  it('shows an engine rejection inline', async () => {
    const err = ruleError('UNIT_EXHAUSTED', 'rune o1 is exhausted');
    const { mine } = setup(undefined, { sendResult: err });
    fireEvent.click(within(mine).getAllByRole('button')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Exhaust for 1 Energy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That unit is exhausted');
  });

  it('really is accepted by the engine (the intents are legal)', async () => {
    const { mine, api } = setup();
    fireEvent.click(within(mine).getAllByRole('button')[2]!);
    fireEvent.click(screen.getByRole('button', { name: 'Recycle for 1 Fury Power' }));
    await waitFor(() => expect(api.send).toHaveBeenCalled());
    await expect(api.send.mock.results[0]!.value).resolves.toEqual({ ok: true });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains Energy and Power', () => {
    setup();
    expect(
      screen.getByText(
        'Energy pays the number; Power pays the domain symbols. Exhaust a rune for Energy, recycle it (it returns to the bottom of your rune deck) for Power.',
      ),
    ).toBeInTheDocument();
  });

  it('shows rune deck counts and the opponent runes read-only', () => {
    const { sc } = setup((s) => {
      s.setRunes('p1', ['Mind', 'Order']);
      s.setReady(s.runes('p1')[1]!.id, false);
    });
    expect(screen.getByTestId('my-rune-deck')).toHaveTextContent(
      String(sc.player('p0').runeDeck.length),
    );
    expect(screen.getByTestId('opp-rune-deck')).toHaveTextContent(
      String(sc.player('p1').runeDeck.length),
    );
    expect(screen.getByTestId('opp-rune-count')).toHaveTextContent('1 ready / 2');
    const opp = screen.getByLabelText('Opponent runes');
    for (const b of within(opp).getAllByRole('button')) expect(b).toBeDisabled();
  });
});
