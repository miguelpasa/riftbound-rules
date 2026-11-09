// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Scenario } from '../../../engine/src/testing/scenario';
import { runEffects } from '../../../engine/src/effects';
import { GameProvider } from '../app/gameApi';
import { HandChoicePrompt } from './HandChoicePrompt';
import { fakeApi } from './testing/fakeApi';

afterEach(cleanup);

/** Both players must discard 1: p0 is asked first. */
function paused(): Scenario {
  const sc = Scenario.start();
  const s = structuredClone(sc.state);
  runEffects(
    s,
    'p0',
    [{ op: 'HAND_DISCARD', who: 'EACH', count: 1 }],
    sc.cards,
    [],
    'fx-grunt',
    '',
  );
  sc.state = s;
  return sc;
}

const mount = (api: ReturnType<typeof fakeApi>) =>
  render(
    <GameProvider value={api}>
      <HandChoicePrompt />
    </GameProvider>,
  );

describe('HandChoicePrompt (X-hand)', () => {
  it('lets the chooser tick exactly the requested cards and sends the engine intent', async () => {
    // Tests Rule 598: discarding is moving a card from the hand to the Trash
    const api = fakeApi(paused(), 'p0');
    mount(api);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const confirm = screen.getByTestId('hand-choice-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getAllByTestId('hand-choice-option')[0] as HTMLElement);
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0]![0]).toMatchObject({ type: 'CHOOSE_HAND_CARDS' });
  });

  it('shows only a waiting notice to the other player', () => {
    // Tests Rule 128: a hand is private
    mount(fakeApi(paused(), 'p1'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('hand-choice-waiting')).toBeInTheDocument();
  });

  it('renders nothing when no choice is pending', () => {
    // Tests Rule 128: a hand is private
    const { container } = mount(fakeApi(Scenario.start(), 'p0'));
    expect(container).toBeEmptyDOMElement();
  });
});
