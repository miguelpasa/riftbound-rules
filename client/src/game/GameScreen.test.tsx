// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { isHiddenCard, ruleError, sanitizeFor } from '@riftbound/engine';
import type { Intent } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import { createLocalGameApi } from '../dev/mockGame';
import { GameProvider, type GameApi } from '../app/gameApi';
import { getState, setState } from '../store/gameStore';
import { GameScreen } from './GameScreen';

afterEach(() => {
  cleanup();
  setState({ toasts: [] });
});

function build(setup: (sc: Scenario) => Record<string, string>) {
  const sc = Scenario.start();
  sc.giveRunes('p0', 4);
  const ids = setup(sc);
  const local = createLocalGameApi({ cards: SCENARIO_CARDS, state: sc.state, seat: 'p0' });
  return { sc, ids, local };
}

function mount(api: GameApi, onBack?: () => void) {
  return render(
    <GameProvider value={api}>
      <GameScreen {...(onBack ? { onBackToMenu: onBack } : {})} />
    </GameProvider>,
  );
}

const card = (cardId: string) =>
  document.querySelector(`[data-card-id="${cardId}"]`) as HTMLElement;
const handCard = (cardId: string) =>
  within(screen.getByLabelText(/^Your hand/))
    .getAllByRole('button')
    .find((e) => e.getAttribute('data-card-id') === cardId) as HTMLElement;
const firstArg = <T,>(fn: { mock: { calls: unknown[][] } }): T => fn.mock.calls[0]![0] as T;

describe('GameScreen', () => {
  it('renders the board, top bar and primary action from a GameApi', () => {
    const { local } = build(() => ({}));
    mount(local.api);
    expect(screen.getByLabelText('Scoreboard')).toBeInTheDocument();
    expect(screen.getByLabelText('Turn phases')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End turn' })).toBeInTheDocument();
    expect(screen.getByLabelText('Your base')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^Battlefield:/)).toHaveLength(2);
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('highlights playable hand cards from legal and plays with the exact legal intent', async () => {
    const { local } = build((sc) => {
      sc.setRunes('p0', ['Fury']);
      return {
        wisp: sc.putInHand('p0', 'fx-wisp'),
        titan: sc.putInHand('p0', 'fx-titan'),
      };
    });
    const api = local.api;
    const send = vi.fn<GameApi['send']>(() => Promise.resolve({ ok: true }));
    mount({ ...api, send });
    const wisp = handCard('fx-wisp');
    expect(wisp.className).toContain('ring-amber-300');
    expect(handCard('fx-titan').className).not.toContain('ring-amber-300');
    fireEvent.click(wisp);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = firstArg<Intent>(send);
    expect(sent.type).toBe('PLAY_CARD');
    expect(api.legal).toContainEqual(sent);
  });

  it('offers a location chooser when several legal variants exist', async () => {
    const { local } = build((sc) => {
      sc.setBattlefield('bf0', { controller: 'p0' });
      return { grunt: sc.putInHand('p0', 'fx-grunt') };
    });
    const api = local.api;
    const send = vi.fn<GameApi['send']>(() => Promise.resolve({ ok: true }));
    mount({ ...api, send });
    fireEvent.click(handCard('fx-grunt'));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toContain('Play to Base');
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(items.find((i) => i.textContent !== 'Play to Base') as HTMLElement);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = firstArg<Extract<Intent, { type: 'PLAY_CARD' }>>(send);
    expect(sent.location?.kind).toBe('battlefield');
    expect(api.legal).toContainEqual(sent);
  });

  it('move flow: select a unit, click a highlighted destination, sends the exact STANDARD_MOVE', async () => {
    const { local, ids } = build((sc) => ({ unit: sc.putUnit('p0', 'fx-grunt', 'base') }));
    const api = local.api;
    const send = vi.fn<GameApi['send']>(() => Promise.resolve({ ok: true }));
    mount({ ...api, send });
    const unit = card('fx-grunt');
    expect(unit.className).toContain('ring-amber-300'); // movable
    fireEvent.click(unit);
    expect(unit).toHaveAttribute('aria-pressed', 'true');
    const dest = await screen.findAllByRole('button', { name: /^Move to Test Battlefield/ });
    fireEvent.click(dest[0]!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = firstArg<Extract<Intent, { type: 'STANDARD_MOVE' }>>(send);
    expect(sent.unitIds).toEqual([ids.unit]);
    expect(api.legal).toContainEqual(sent);
  });

  it('shows the engine rule error as a toast when an unplayable card is clicked', async () => {
    const { local } = build((sc) => {
      sc.setRunes('p0', []);
      return { titan: sc.putInHand('p0', 'fx-titan') };
    });
    const err = ruleError('INSUFFICIENT_RESOURCES');
    const send = vi.fn<GameApi['send']>(() => Promise.resolve(err));
    mount({ ...local.api, send });
    fireEvent.click(handCard('fx-titan'));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(await screen.findByText(err.message)).toBeInTheDocument();
    expect(getState().toasts.some((t) => t.text === err.message)).toBe(true);
  });

  it('Space triggers the primary action only when no control is focused', async () => {
    const { local } = build(() => ({}));
    const send = vi.fn<GameApi['send']>(() => Promise.resolve({ ok: true }));
    mount({ ...local.api, send });
    const btn = screen.getByRole('button', { name: 'End turn' });
    btn.focus();
    fireEvent.keyDown(btn, { key: ' ' });
    expect(send).not.toHaveBeenCalled();
    btn.blur();
    fireEvent.keyDown(document.body, { key: ' ' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(firstArg<Intent>(send).type).toBe('END_TURN');
  });

  it('concede asks for confirmation then sends CONCEDE', async () => {
    const { local } = build(() => ({}));
    const send = vi.fn<GameApi['send']>(() => Promise.resolve({ ok: true }));
    mount({ ...local.api, send });
    fireEvent.click(screen.getByRole('button', { name: 'Concede' }));
    expect(send).not.toHaveBeenCalled();
    const dlg = screen.getByRole('alertdialog');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Concede' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'CONCEDE', playerId: 'p0' }));
  });

  it('concede dialog: Escape closes it and returns focus to Concede; Tab stays inside', () => {
    const { local } = build(() => ({}));
    mount(local.api);
    const opener = screen.getByRole('button', { name: 'Concede' });
    opener.focus();
    fireEvent.click(opener);
    const dlg = screen.getByRole('alertdialog');
    const keep = within(dlg).getByRole('button', { name: 'Keep playing' });
    const concede = within(dlg).getByRole('button', { name: 'Concede' });
    expect(keep).toHaveFocus();
    concede.focus();
    fireEvent.keyDown(concede, { key: 'Tab' });
    expect(keep).toHaveFocus();
    fireEvent.keyDown(keep, { key: 'Tab', shiftKey: true });
    expect(concede).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('additiveSelection: plain clicks add units to the selection; default replaces it', () => {
    const { local } = build((sc) => {
      sc.putUnit('p0', 'fx-grunt', 'base');
      sc.putUnit('p0', 'fx-raider', 'base');
      return {};
    });
    const { unmount } = render(
      <GameProvider value={local.api}>
        <GameScreen additiveSelection />
      </GameProvider>,
    );
    fireEvent.click(card('fx-grunt'));
    fireEvent.click(card('fx-raider'));
    expect(card('fx-grunt')).toHaveAttribute('aria-pressed', 'true');
    expect(card('fx-raider')).toHaveAttribute('aria-pressed', 'true');
    unmount();
    mount(local.api);
    fireEvent.click(card('fx-grunt'));
    fireEvent.click(card('fx-raider'));
    expect(card('fx-grunt')).toHaveAttribute('aria-pressed', 'false');
    expect(card('fx-raider')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders opponent hidden cards only as card backs (no names)', () => {
    const { sc, local } = build(() => ({}));
    mount(local.api);
    const oppNames = Object.values(sc.state.objects)
      .filter((o) => o.zone.kind === 'hand' && o.zone.player === 'p1')
      .map((o) => SCENARIO_CARDS[o.cardId]!.name);
    const hand = screen.getByLabelText(/^Opponent hand/);
    expect(hand.querySelectorAll('[data-card-back]').length).toBeGreaterThan(0);
    expect(hand.querySelectorAll('[data-card-id]')).toHaveLength(0);
    for (const n of oppNames) expect(hand.textContent).not.toContain(n);
    // The sanitised view itself holds only HiddenCard placeholders for the opponent hand.
    const view = sanitizeFor(sc.state, 'p0');
    for (const id of view.players[1].hand) expect(isHiddenCard(view.objects[id]!)).toBe(true);
  });

  it('shows the game-over banner and calls onBackToMenu', () => {
    const { local } = build(() => ({}));
    const onBack = vi.fn();
    mount({ ...local.api, gameOver: { winner: 'p0' } }, onBack);
    expect(screen.getByText('You win!')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to menu' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('announces important events and lists them in the game log', () => {
    const { local } = build(() => ({}));
    const api = local.api;
    const view = mount(api);
    const next: GameApi = {
      ...api,
      recentEvents: [{ seq: 9999, type: 'POINT_GAINED', player: 'p0', amount: 1, source: 'HOLD' }],
    };
    act(() => {
      view.rerender(
        <GameProvider value={next}>
          <GameScreen />
        </GameProvider>,
      );
    });
    expect(screen.getByTestId('announcer')).toHaveTextContent(
      'You gained 1 point from holding a battlefield.',
    );
    expect(screen.getByLabelText('Game log').textContent).toContain('holding a battlefield');
  });
});
