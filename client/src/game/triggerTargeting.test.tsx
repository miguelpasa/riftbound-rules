// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { getLegalActions } from '@riftbound/engine';
import type { CardDatabase, CardDef, Intent, PlayerId } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import { createLocalGameApi } from '../dev/mockGame';
import { GameProvider, type GameApi } from '../app/gameApi';
import { setState } from '../store/gameStore';
import { GameScreen } from './GameScreen';

afterEach(() => {
  cleanup();
  setState({ toasts: [] });
});

const BUFF = { op: 'BUFF_TARGET', amount: 2, duration: 'TURN' } as const;
const withGrunt = (patch: Partial<CardDef>): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...(SCENARIO_CARDS['fx-grunt'] as CardDef), ...patch },
});

function mount(sc: Scenario, seat: PlayerId) {
  const local = createLocalGameApi({ cards: sc.cards, state: sc.state, seat });
  const legal = getLegalActions(sc.state, sc.cards, seat);
  const send = vi.fn<GameApi['send']>(() => Promise.resolve({ ok: true }));
  render(
    <GameProvider value={{ ...local.api, legal, send }}>
      <GameScreen />
    </GameProvider>,
  );
  return send;
}

/** p0 just played a Grunt whose "When you play me" gives a unit +2; an enemy Scholar is on the board. */
function pendingTrigger() {
  const sc = Scenario.start({}, withGrunt({ triggers: [{ on: 'PLAY', effects: [BUFF] }] }));
  sc.putUnit('p1', 'fx-tide-grunt', 'base');
  const unit = sc.putInHand('p0', 'fx-grunt');
  sc.play('p0', unit, { payment: sc.exhaustPlan('p0', 2), location: { kind: 'base' } });
  return sc;
}

const name = (id: string) => SCENARIO_CARDS[id]!.name;
const targetBtn = (cardId: string) =>
  screen.queryAllByRole('button', { name: new RegExp(`^Target: ${name(cardId)}`) })[0];

describe('triggered ability targets (R41)', () => {
  it('prompts the controller with click-to-target and sends CHOOSE_TRIGGER_TARGET', async () => {
    const sc = pendingTrigger();
    const send = mount(sc, 'p0');
    expect(
      screen.getByText(`Choose target 1 of 1: ${name('fx-grunt')} (triggered ability)`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull(); // mandatory
    fireEvent.click(targetBtn('fx-tide-grunt')!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const sent = send.mock.calls[0]![0];
    expect(sent).toMatchObject({ type: 'CHOOSE_TRIGGER_TARGET', playerId: 'p0' });
    expect(sent.type === 'CHOOSE_TRIGGER_TARGET' && sent.targets).toHaveLength(1);
  });

  it('Escape does not cancel a mandatory trigger choice', () => {
    const sc = pendingTrigger();
    mount(sc, 'p0');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByLabelText('Targeting')).toBeInTheDocument();
  });

  it('shows the opponent a waiting notice and no target buttons', () => {
    const sc = pendingTrigger();
    mount(sc, 'p1');
    expect(screen.getByTestId('trigger-waiting')).toHaveTextContent(/opponent is choosing/);
    expect(screen.queryByRole('button', { name: /^Target:/ })).toBeNull();
  });
});

describe('targeted activated abilities (R41)', () => {
  it('Activate starts click-to-target and submits ACTIVATE_ABILITY with the target', async () => {
    const sc = Scenario.start(
      {},
      withGrunt({ abilities: [{ cost: { exhaust: true }, effects: [BUFF] }] }),
    );
    const src = sc.putUnit('p0', 'fx-grunt', 'base');
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const send = mount(sc, 'p0');
    fireEvent.click(screen.getAllByRole('button', { name: /^Activate/ })[0]!);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText(/Choose target 1 of 1: .* \(ability\)/)).toBeInTheDocument();
    fireEvent.click(targetBtn('fx-tide-grunt')!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const expected: Partial<Intent> = {
      type: 'ACTIVATE_ABILITY',
      sourceId: src,
      abilityIndex: 0,
      targets: [{ kind: 'object', id: foe }],
    };
    expect(send.mock.calls[0]![0]).toMatchObject(expected);
  });
});
