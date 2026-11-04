// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { MemoryGameStorage, startPersistedHost } from './persistence.js';

describe('page lifecycle flushing', () => {
  it('flushes immediately on pagehide and when the tab becomes hidden', async () => {
    const storage = new MemoryGameStorage();
    const { session, header, persister } = startPersistedHost({
      storage,
      cards: FIXTURE_CARDS,
      hostDeck: FIXTURE_DECK_A,
      guestDeck: FIXTURE_DECK_B,
      seed: 'pagehide',
      mode: 'SOLO',
      debounceMs: 60_000, // the timer would never fire during the test
    });
    const act = () => {
      const seat = session.getActor();
      const first = session.getLegal(seat)[0]!;
      (session as unknown as { apply(s: string, i: unknown): unknown }).apply(seat, first);
    };
    act();
    act();
    expect(await storage.loadGame(header.gameId)).toBeNull();

    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 10));
    expect((await storage.loadGame(header.gameId))?.intents).toHaveLength(2);

    act();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 10));
    expect((await storage.loadGame(header.gameId))?.intents).toHaveLength(3);

    await persister.dispose();
  });
});
