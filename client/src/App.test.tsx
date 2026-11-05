// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FIXTURE_CARDS } from './decks/fixtureDecks';
import { FIXTURE_DECK_A, FIXTURE_DECK_B } from '../../engine/src/testing/fixtures.js';
import { MemoryGameStorage } from './host/persistence';
import { FakeBroker } from './net/fakePeer';
import type { KeyValueStorage } from './net/guestSession';
import { App, LICENSE_NOTE } from './App';
import { startSoloGame, type HostEnv } from './app/hostGame';
import type { AppDeps } from './app/context';
import { setState } from './store/gameStore';

afterEach(() => {
  cleanup();
  setState({ toasts: [], deadline: null });
  localStorage.clear();
});

function memStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
}

function makeDeps(over: Partial<AppDeps> = {}): Partial<AppDeps> {
  const storage = new MemoryGameStorage();
  return {
    loadCards: async () => ({ ok: true, cards: FIXTURE_CARDS }),
    openStorage: async () => storage,
    createBot: () => ({ decide: () => null }),
    botDelayMs: 0,
    guestStorage: memStorage(),
    ...over,
  };
}

const click = (name: RegExp | string) => fireEvent.click(screen.getByRole('button', { name }));

async function menuReady(container: HTMLElement) {
  await waitFor(() =>
    expect(within(container).getByRole('button', { name: 'Host Game' })).toBeEnabled(),
  );
}

describe('menu', () => {
  it('shows the card count and license note, and enables the actions', async () => {
    const { container } = render(<App deps={makeDeps()} />);
    await menuReady(container);
    expect(screen.getByText(LICENSE_NOTE)).toBeInTheDocument();
    expect(screen.getAllByText(/Loaded \d+ cards/).length).toBeGreaterThan(0);
    for (const label of [
      'Join Game',
      'Play vs AI',
      'Tutorial',
      'Saved games / Replays',
      'Settings',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
  });

  it('shows the exact load error and disables everything else', async () => {
    const message = 'cards.json not found. Run `npm run cards` first.';
    render(<App deps={makeDeps({ loadCards: async () => ({ ok: false, message }) })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    for (const b of within(screen.getByRole('navigation')).getAllByRole('button')) {
      expect(b).toBeDisabled();
    }
  });

  it('persists the timer settings', async () => {
    const { container } = render(<App deps={makeDeps()} />);
    await menuReady(container);
    click('Settings');
    const box = screen.getByLabelText(/Reaction timer in games vs the AI/);
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(localStorage.getItem('riftbound.timerSolo')).toBe('true');
  });
});

describe('host and join', () => {
  it('goes menu -> host -> guest joins with its own deck -> both game screens render', async () => {
    const broker = new FakeBroker();
    const hostDeps = makeDeps({ peerFactory: broker.factory });
    const guestDeps = makeDeps({ peerFactory: broker.factory });
    const host = render(<App deps={hostDeps} />);
    const hostView = within(host.container);
    await menuReady(host.container);
    fireEvent.click(hostView.getByRole('button', { name: 'Host Game' }));
    // Deck list with the implementation badge and warning tooltip.
    expect(hostView.getAllByText(/cards fully implemented/).length).toBeGreaterThan(0);
    fireEvent.click(hostView.getByRole('button', { name: 'Create room' }));
    const codeEl = await hostView.findByTestId('room-code');
    const code = codeEl.textContent!;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    await waitFor(() =>
      expect(hostView.getByRole('status')).toHaveTextContent('Waiting for opponent...'),
    );

    const guest = render(<App deps={guestDeps} />);
    const guestView = within(guest.container);
    await menuReady(guest.container);
    fireEvent.click(guestView.getByRole('button', { name: 'Join Game' }));
    fireEvent.change(guestView.getByLabelText('Room code'), {
      target: { value: code.toLowerCase() },
    });
    fireEvent.click(guestView.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(hostView.getByTestId('priority-text')).toBeInTheDocument(), {
      timeout: 4000,
    });
    await waitFor(() => expect(guestView.getByTestId('priority-text')).toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(hostView.getByText(code)).toBeInTheDocument(); // room code stays visible in the header
    await waitFor(() => expect(hostView.getByText('Opponent connected')).toBeInTheDocument());
  });

  it('rejects an invalid room code before connecting', async () => {
    const { container } = render(
      <App deps={makeDeps({ peerFactory: new FakeBroker().factory })} />,
    );
    await menuReady(container);
    click('Join Game');
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'ab1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/6-character/);
  });
});

describe('solo', () => {
  it('starts a game against the bot and the bot acts', async () => {
    const decide = vi.fn(() => null);
    const { container } = render(
      <App deps={makeDeps({ createBot: () => ({ decide, dispose: () => undefined }) })} />,
    );
    await menuReady(container);
    click('Play vs AI');
    click('Start game');
    await screen.findByTestId('priority-text');
    // If the human has to decide first, keep the hand; then the bot must be asked to act.
    await waitFor(
      () => {
        const keep = screen.queryByRole('button', { name: /keep hand/i });
        if (keep) fireEvent.click(keep);
        expect(decide).toHaveBeenCalled();
      },
      { timeout: 4000 },
    );
  });
});

describe('saved games', () => {
  async function seedStorage(finish: boolean) {
    const storage = new MemoryGameStorage();
    const env: HostEnv = {
      cards: FIXTURE_CARDS,
      storage,
      createBot: () => ({ decide: () => null }),
      botDelayMs: 0,
      onError: () => undefined,
    };
    const game = startSoloGame(env, {
      deck: FIXTURE_DECK_A,
      botDeck: FIXTURE_DECK_B,
      difficulty: 'normal',
      seed: 'resume-seed',
      timersEnabled: false,
    });
    if (finish) {
      game.session.forceIntent(game.session.hostSeat, {
        type: 'CONCEDE',
        playerId: game.session.hostSeat,
      });
    }
    await game.dispose();
    return storage;
  }

  it('resumes an in-progress game and re-attaches the bot', async () => {
    const storage = await seedStorage(false);
    const createBot = vi.fn(() => ({ decide: () => null }));
    const { container } = render(
      <App deps={makeDeps({ openStorage: async () => storage, createBot })} />,
    );
    await menuReady(container);
    click('Saved games / Replays');
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await screen.findByTestId('priority-text');
    expect(createBot).toHaveBeenCalledTimes(1);
  });

  it('watches the replay of a finished game and steps through it', async () => {
    const storage = await seedStorage(true);
    const { container } = render(<App deps={makeDeps({ openStorage: async () => storage })} />);
    await menuReady(container);
    click('Saved games / Replays');
    fireEvent.click(await screen.findByRole('button', { name: 'Watch replay' }));
    const step = await screen.findByTestId('replay-step');
    expect(step).toHaveTextContent(/Step 1 \/ 1/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    });
    expect(screen.getByTestId('replay-step')).toHaveTextContent(/Step 0 \/ 1/);
    expect(screen.getByRole('button', { name: 'Export replay' })).toBeInTheDocument();
  });

  it('deletes a saved game', async () => {
    const storage = await seedStorage(false);
    const { container } = render(<App deps={makeDeps({ openStorage: async () => storage })} />);
    await menuReady(container);
    click('Saved games / Replays');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await screen.findByText('No saved games yet.');
  });
});
