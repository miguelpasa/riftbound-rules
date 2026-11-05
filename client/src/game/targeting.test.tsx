// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Intent } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import { createLocalGameApi } from '../dev/mockGame';
import { GameProvider, type GameApi } from '../app/gameApi';
import { setState } from '../store/gameStore';
import { GameScreen } from './GameScreen';

afterEach(() => {
  cleanup();
  setState({ toasts: [] });
});

type Play = Extract<Intent, { type: 'PLAY_CARD' }>;
const play = (cardInstanceId: string, ...ids: string[]): Play => ({
  type: 'PLAY_CARD',
  playerId: 'p0',
  cardInstanceId,
  payment: [],
  targets: ids.map((id) => ({ kind: 'object' as const, id })),
});

function setup() {
  const sc = Scenario.start();
  sc.giveRunes('p0', 4);
  const spell = sc.putInHand('p0', 'fx-flare');
  const mine = sc.putUnit('p0', 'fx-grunt', 'base');
  const e1 = sc.putUnit('p1', 'fx-tide-grunt', 'base');
  const e2 = sc.putUnit('p1', 'fx-tide-archer', 'base');
  const local = createLocalGameApi({ cards: SCENARIO_CARDS, state: sc.state, seat: 'p0' });
  return { sc, spell, mine, e1, e2, api: local.api, oppHand: sc.state.players[1].hand };
}

function mountWith(api: GameApi, legal: Intent[]) {
  const send = vi.fn<GameApi['send']>(() => Promise.resolve({ ok: true }));
  render(
    <GameProvider value={{ ...api, legal, send }}>
      <GameScreen />
    </GameProvider>,
  );
  return send;
}

const nameOf = (id: string) => SCENARIO_CARDS[id]!.name;
const handSpell = () =>
  within(screen.getByLabelText(/^Your hand/))
    .getAllByRole('button')
    .find((e) => e.getAttribute('data-card-id') === 'fx-flare') as HTMLElement;
const targetBtn = (cardId: string) =>
  screen.queryByRole('button', { name: `Target: ${nameOf(cardId)}` });

describe('click-to-target', () => {
  it('single target: highlights exactly the legal units, auto-submits the matching variant', async () => {
    const { spell, e1, e2, api } = setup();
    const send = mountWith(api, [play(spell, e1), play(spell, e2)]);
    fireEvent.click(handSpell());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByText(`Choose target 1 of 1: ${nameOf('fx-flare')}`)).toBeInTheDocument();
    expect(targetBtn('fx-tide-grunt')).toBeInTheDocument();
    expect(targetBtn('fx-tide-archer')).toBeInTheDocument();
    expect(targetBtn('fx-grunt')).toBeNull(); // my own unit is not a legal target
    fireEvent.click(targetBtn('fx-tide-archer')!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toEqual(play(spell, e2));
    await waitFor(() => expect(screen.queryByLabelText('Targeting')).toBeNull());
  });

  it('two targets: narrows slot 2 by the slot 1 choice, then submits', async () => {
    const { spell, mine, e1, e2, api } = setup();
    // (mine,e1) (mine,e2) (e1,e2): picking e1 first leaves only e2; picking mine first leaves e1/e2.
    const send = mountWith(api, [
      play(spell, mine, e1),
      play(spell, mine, e2),
      play(spell, e1, e2),
    ]);
    fireEvent.click(handSpell());
    expect(screen.getByText(/Choose target 1 of 2/)).toBeInTheDocument();
    expect(targetBtn('fx-tide-grunt')).toBeInTheDocument();
    fireEvent.click(targetBtn('fx-tide-grunt')!);
    expect(screen.getByText(/Choose target 2 of 2/)).toBeInTheDocument();
    expect(targetBtn('fx-tide-archer')).toBeInTheDocument();
    expect(targetBtn('fx-tide-grunt')).toBeNull(); // already chosen
    expect(targetBtn('fx-grunt')).toBeNull(); // (e1, mine) is not a legal variant
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(targetBtn('fx-tide-archer')!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toEqual(play(spell, e1, e2));
  });

  it('shows a confirm button when several variants (locations) share the same targets', async () => {
    const { spell, e1, api } = setup();
    const a: Play = { ...play(spell, e1), location: { kind: 'base' } };
    const b: Play = { ...play(spell, e1), location: { kind: 'battlefield', battlefieldId: 'bf0' } };
    const send = mountWith(api, [a, b]);
    fireEvent.click(handSpell());
    fireEvent.click(targetBtn('fx-tide-grunt')!);
    expect(send).not.toHaveBeenCalled();
    const confirms = screen.getAllByRole('button', { name: /^Confirm:/ });
    expect(confirms).toHaveLength(2);
    fireEvent.click(confirms[1]!);
    await waitFor(() => expect(send).toHaveBeenCalledWith(b));
  });

  it('Cancel button and Escape leave targeting without sending anything', () => {
    const { spell, e1, e2, api } = setup();
    const send = mountWith(api, [play(spell, e1), play(spell, e2)]);
    fireEvent.click(handSpell());
    expect(screen.getByLabelText('Targeting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Targeting')).toBeNull();
    expect(targetBtn('fx-tide-grunt')).toBeNull();
    fireEvent.click(handSpell());
    expect(screen.getByLabelText('Targeting')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByLabelText('Targeting')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('is a no-op when legal has no variants for the card (engine explains via attempt)', () => {
    const { api } = setup();
    mountWith(api, []);
    fireEvent.click(handSpell());
    expect(screen.queryByLabelText('Targeting')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Target:/ })).toBeNull();
  });

  it('never highlights hidden cards: falls back to the popover', () => {
    const { spell, oppHand, api } = setup();
    const [h1, h2] = oppHand;
    const send = mountWith(api, [play(spell, h1!), play(spell, h2!)]);
    fireEvent.click(handSpell());
    expect(screen.queryByLabelText('Targeting')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Target:/ })).toBeNull();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });
});
