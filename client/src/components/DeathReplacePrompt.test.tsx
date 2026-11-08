// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TOKEN_CARDS } from '@riftbound/engine';
import type { CardDatabase, CardDef } from '@riftbound/engine';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario';
import { runCleanup } from '../../../engine/src/cleanup';
import { runEffects } from '../../../engine/src/effects';
import { GameProvider } from '../app/gameApi';
import { DeathReplacePrompt } from './DeathReplacePrompt';
import { fakeApi } from './testing/fakeApi';

afterEach(cleanup);

const cards: CardDatabase = {
  ...SCENARIO_CARDS,
  ...TOKEN_CARDS,
  'fx-ember-totem': {
    ...(SCENARIO_CARDS['fx-ember-totem'] as CardDef),
    statics: [
      {
        affects: 'FRIENDLY_UNITS',
        replaceDeath: { offer: { cost: { energy: 1 }, exhaustSource: true } },
      },
    ],
  },
};

/** A unit with lethal damage and a gear that offers to save it for 1 Energy. */
function paused(): Scenario {
  const sc = Scenario.start({}, cards);
  sc.giveRunes('p0', 4);
  sc.putUnit('p0', 'fx-ember-totem', 'base');
  sc.putUnit('p0', 'fx-ash-tank', 'bf0', { control: true });
  const s = structuredClone(sc.state);
  runEffects(s, 'p0', [{ op: 'KILL_ALL_UNITS' }], sc.cards);
  const cl = runCleanup(s, sc.cards);
  if (!cl.ok) throw new Error(cl.message);
  sc.state = cl.state;
  return sc;
}

const mount = (api: ReturnType<typeof fakeApi>) =>
  render(
    <GameProvider value={api}>
      <DeathReplacePrompt />
    </GameProvider>,
  );

describe('DeathReplacePrompt (X7)', () => {
  it('offers the controller each way to save the unit, and sends the engine intents', async () => {
    const sc = paused();
    expect(sc.state.flow.pendingChoice?.kind).toBe('DEATH_REPLACE');
    const api = fakeApi(sc, 'p0');
    mount(api);
    expect(screen.getByRole('dialog', { name: /would die/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('death-replace-offer')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('death-replace-accept'));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0]![0]).toMatchObject({
      type: 'DECIDE_REPLACEMENT',
      accept: true,
    });
    fireEvent.click(screen.getByTestId('death-replace-decline'));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(api.send.mock.calls[1]![0]).toMatchObject({ type: 'DECIDE_REPLACEMENT', accept: false });
  });

  it('shows only a waiting notice to the other player', () => {
    mount(fakeApi(paused(), 'p1'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('death-replace-waiting')).toHaveTextContent(
      'Your opponent is deciding whether to save',
    );
  });

  it('renders nothing when no choice is pending', () => {
    const { container } = mount(fakeApi(Scenario.start(), 'p0'));
    expect(container).toBeEmptyDOMElement();
  });
});
