// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { CardDatabase, CardDef } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import { GameProvider } from '../app/gameApi';
import { fakeApi } from '../components/testing/fakeApi';
import { setState } from '../store/gameStore';
import { GameScreen } from './GameScreen';
import { describeAbility } from './abilities';

afterEach(() => {
  cleanup();
  setState({ toasts: [] });
});

const grunt = SCENARIO_CARDS['fx-grunt'] as CardDef;
const cardsWith = (abilities: NonNullable<CardDef['abilities']>): CardDatabase => ({
  ...SCENARIO_CARDS,
  'fx-grunt': { ...grunt, abilities },
});

const DISCARD_GEAR: NonNullable<CardDef['abilities']> = [
  {
    cost: { exhaust: true, card: { kind: 'DISCARD', what: 'gear' } },
    effects: [{ op: 'BUFF_SELF', amount: 2 }],
  },
];

/** A Cinder Grunt in the base, two gear in hand (the cost) and a spare enemy unit. */
function setup(abilities: NonNullable<CardDef['abilities']>) {
  const sc = Scenario.start({}, cardsWith(abilities));
  const unit = sc.putUnit('p0', 'fx-grunt', 'base');
  const gearA = sc.putInHand('p0', 'fx-blade');
  const gearB = sc.putInHand('p0', 'fx-blade');
  sc.setMainPhase('p0');
  return { sc, unit, gearA, gearB };
}

const mount = (sc: Scenario) => {
  const api = fakeApi(sc, 'p0');
  render(
    <GameProvider value={api}>
      <GameScreen />
    </GameProvider>,
  );
  return api;
};

describe('activated ability with a card-choice cost (R46)', () => {
  it('Activate opens the cost picker; the chosen cards go into the activation', async () => {
    const { sc, unit, gearA, gearB } = setup(DISCARD_GEAR);
    const api = mount(sc);
    fireEvent.click(screen.getByRole('button', { name: /^Activate Cinder Grunt/ }));
    expect(api.send).not.toHaveBeenCalled(); // nothing is paid until the cards are chosen
    expect(screen.getByTestId('ability-cost-prompt')).toBeInTheDocument();
    expect(screen.getByTestId('ability-cost-text')).toHaveTextContent('Cost: Discard 1 gear.');
    expect(screen.getByTestId(`cost-card-${gearA}`)).toBeInTheDocument();
    expect(screen.getByTestId(`cost-card-${gearB}`)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^cost-card-/)).toHaveLength(2); // only gear, not the other hand cards
    expect(screen.getByTestId('cost-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId(`cost-card-${gearB}`));
    fireEvent.click(screen.getByTestId('cost-confirm'));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0]![0]).toMatchObject({
      type: 'ACTIVATE_ABILITY',
      sourceId: unit,
      abilityIndex: 0,
      costCards: [gearB],
    });
    await waitFor(() => expect(screen.queryByTestId('ability-cost-prompt')).toBeNull());
  });

  it('Cancel (and Escape) close the picker without sending anything', () => {
    const { sc } = setup(DISCARD_GEAR);
    const api = mount(sc);
    fireEvent.click(screen.getByRole('button', { name: /^Activate Cinder Grunt/ }));
    fireEvent.click(screen.getByTestId('ability-cost-cancel'));
    expect(screen.queryByTestId('ability-cost-prompt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Activate Cinder Grunt/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('ability-cost-prompt')).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('a targeted ability picks the cost first, then the target on the board', async () => {
    const { sc, unit, gearA } = setup([
      {
        cost: { exhaust: true, card: { kind: 'DISCARD', what: 'gear' } },
        effects: [{ op: 'DAMAGE_TARGET', amount: 2, side: 'enemy' }],
      },
    ]);
    const foe = sc.putUnit('p1', 'fx-tide-grunt', 'base');
    const api = mount(sc);
    fireEvent.click(screen.getByRole('button', { name: /^Activate Cinder Grunt/ }));
    fireEvent.click(screen.getByTestId(`cost-card-${gearA}`));
    fireEvent.click(screen.getByTestId('cost-confirm'));
    expect(api.send).not.toHaveBeenCalled(); // still needs a target
    await waitFor(() => expect(screen.getByText(/Choose target 1 of 1/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Target: / }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0]![0]).toMatchObject({
      type: 'ACTIVATE_ABILITY',
      sourceId: unit,
      costCards: [gearA],
      targets: [{ kind: 'object', id: foe }],
    });
  });

  it('shows the card cost in the ability description', () => {
    const d = describeAbility(grunt, {
      cost: { exhaust: true, energy: 1, power: 1, card: { kind: 'RECYCLE', count: 3 } },
      effects: [{ op: 'DRAW', amount: 1 }],
    });
    expect(d.cost).toBe('Exhaust, 1 Energy, 1 Power (Fury), Recycle 3 cards from your Trash');
  });

  it('is not offered when nothing can pay (no Activate button)', () => {
    const sc = Scenario.start({}, cardsWith(DISCARD_GEAR));
    sc.putUnit('p0', 'fx-grunt', 'base');
    sc.setMainPhase('p0');
    mount(sc);
    expect(screen.queryByRole('button', { name: /^Activate Cinder Grunt/ })).toBeNull();
  });
});
