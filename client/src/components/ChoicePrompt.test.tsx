// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { runCleanup } from '../../../engine/src/cleanup';
import { Scenario } from '../../../engine/src/testing/scenario';
import { GameProvider } from '../app/gameApi';
import { ChoicePrompt } from './ChoicePrompt';
import { fakeApi, type FakeApi } from './testing/fakeApi';

afterEach(cleanup);

/** The turn player (p0) contests two battlefields: the Cleanup pauses on a staged-order choice. */
function paused(): Scenario {
  const sc = Scenario.start();
  const [a, b] = sc.state.battlefields.map((x) => x.id) as [string, string];
  sc.putUnit('p0', 'fx-grunt', a);
  sc.putUnit('p0', 'fx-grunt', b);
  sc.setBattlefield(a, { contestedBy: 'p0' });
  sc.setBattlefield(b, { contestedBy: 'p0' });
  const r = runCleanup(sc.state, sc.cards);
  if (!r.ok) throw new Error(r.message);
  sc.state = r.state;
  return sc;
}

function mount(api: FakeApi) {
  return render(
    <GameProvider value={api}>
      <ChoicePrompt />
    </GameProvider>,
  );
}

describe('ChoicePrompt', () => {
  it('shows one labelled button per staged battlefield to the turn player', () => {
    const sc = paused();
    mount(fakeApi(sc, 'p0'));
    const dialog = screen.getByRole('dialog', { name: 'Choose which battlefield resolves first' });
    expect(dialog).toBeInTheDocument();
    const ids = sc.state.flow.pendingChoice?.options ?? [];
    expect(ids).toHaveLength(2);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(
      screen.getAllByRole('button', { name: /^Resolve Test Battlefield \d first$/ }),
    ).toHaveLength(2);
  });

  it('sends CHOOSE_STAGED for the clicked battlefield', async () => {
    const sc = paused();
    const api = fakeApi(sc, 'p0');
    mount(api);
    const [, second] = sc.state.flow.pendingChoice?.options as [string, string];
    const btn = document.querySelector(`[data-battlefield-id="${second}"]`) as HTMLElement;
    fireEvent.click(btn);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send).toHaveBeenCalledWith({
      type: 'CHOOSE_STAGED',
      playerId: 'p0',
      battlefieldId: second,
    });
  });

  it('shows only a waiting notice (no buttons) to the other player', () => {
    mount(fakeApi(paused(), 'p1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('choice-waiting')).toHaveTextContent(
      "Waiting for your opponent to choose which battlefield's Showdown begins first.",
    );
  });

  it('renders nothing when no choice is pending', () => {
    const sc = Scenario.start();
    const { container } = mount(fakeApi(sc, 'p0'));
    expect(container).toBeEmptyDOMElement();
  });
});
