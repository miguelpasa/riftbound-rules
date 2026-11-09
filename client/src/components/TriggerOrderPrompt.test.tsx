// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TOKEN_CARDS } from '@riftbound/engine';
import type { CardDatabase, CardDef } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario';
import { GameProvider } from '../app/gameApi';
import { TriggerOrderPrompt } from './TriggerOrderPrompt';
import { fakeApi } from './testing/fakeApi';

afterEach(cleanup);

const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  ...TOKEN_CARDS,
  'fx-grunt': {
    ...(SCENARIO_CARDS['fx-grunt'] as CardDef),
    triggers: [{ on: 'HOLD', effects: [{ op: 'DRAW', amount: 1 }] }],
  },
  'fx-ash-tank': {
    ...(SCENARIO_CARDS['fx-ash-tank'] as CardDef),
    triggers: [{ on: 'HOLD', effects: [{ op: 'CHANNEL', amount: 1 }] }],
  },
};

function paused(): Scenario {
  const sc = Scenario.start({}, cards);
  const bf = sc.state.battlefields[0]!.id;
  sc.putUnit('p0', 'fx-grunt', bf, { control: true });
  sc.putUnit('p0', 'fx-ash-tank', bf);
  sc.endTurn('p0');
  sc.endTurn('p1');
  return sc;
}

const mount = (api: ReturnType<typeof fakeApi>) =>
  render(
    <GameProvider value={api}>
      <TriggerOrderPrompt />
    </GameProvider>,
  );

describe('TriggerOrderPrompt (X6)', () => {
  it('lists each order and sends the engine intent', async () => {
    const sc = paused();
    const api = fakeApi(sc, 'p0');
    mount(api);
    expect(screen.getByRole('dialog', { name: /choose the order/ })).toBeInTheDocument();
    const options = screen.getAllByTestId('trigger-order-option');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent(', then ');
    fireEvent.click(options[1]!);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0]![0]).toMatchObject({ type: 'CHOOSE_TRIGGER_ORDER' });
  });

  it('shows only a waiting notice to the other player', () => {
    mount(fakeApi(paused(), 'p1'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('trigger-order-waiting')).toBeInTheDocument();
  });
});
