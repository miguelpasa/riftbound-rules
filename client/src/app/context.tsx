import { createContext, useContext } from 'react';
import type { CardDatabase } from '@riftbound/engine';
import { createAiBot } from '../ai/aiClient';
import { loadCards, type LoadCardsResult } from '../cards/loadCards';
import type { PresetDeck } from '../decks/presets';
import type { GameStorage } from '../host/persistence';
import { openGameStorage } from '../host/persistence';
import type { KeyValueStorage } from '../net/guestSession';
import type { PeerFactory } from '../net/peerTransport';
import type { BotFactoryOptions, BotHandle, HostEnv } from './hostGame';
import type { AppSettings } from './settings';
import { pushToastOnce } from './toastUtil';

/** Everything the app needs from the outside world; tests inject fakes. */
export interface AppDeps {
  loadCards(): Promise<LoadCardsResult>;
  /** Opens (once) the storage that persists host games. */
  openStorage(): Promise<GameStorage>;
  peerFactory?: PeerFactory | undefined;
  createBot(o: BotFactoryOptions): BotHandle;
  botDelayMs?: number | undefined;
  /** Guest seat token storage (default: sessionStorage, memory fallback). */
  guestStorage?: KeyValueStorage | undefined;
  guestSendTimeoutMs?: number | undefined;
}

function sessionStorageKv(): KeyValueStorage {
  const mem = new Map<string, string>();
  return {
    get(k) {
      try {
        return globalThis.sessionStorage?.getItem(k) ?? mem.get(k) ?? null;
      } catch {
        return mem.get(k) ?? null;
      }
    },
    set(k, v) {
      mem.set(k, v);
      try {
        globalThis.sessionStorage?.setItem(k, v);
      } catch {
        /* quota / disabled: memory only */
      }
    },
  };
}

export function defaultDeps(): AppDeps {
  return {
    loadCards,
    openStorage: async () =>
      (
        await openGameStorage((err) => {
          console.error('[storage] IndexedDB unavailable, games will not be saved', err);
          pushToastOnce('Saving is unavailable in this browser: games will not be resumable.');
        })
      ).storage,
    createBot: (o) => createAiBot(o),
    guestStorage: sessionStorageKv(),
  };
}

export interface GameData {
  cards: CardDatabase;
  presets: PresetDeck[];
  /** True when the real card data produced no presets and the built-in fixture cards are used. */
  fixture: boolean;
}

export interface AppContextValue {
  deps: AppDeps;
  data: GameData;
  /** Lazily opened, shared storage. */
  getStorage(): Promise<GameStorage>;
  /** Builds the host environment (cards, storage, bot factory, toasts, timer display). */
  makeEnv(storage: GameStorage): HostEnv;
  settings: AppSettings;
  setSettings(next: AppSettings): void;
}

const Ctx = createContext<AppContextValue | null>(null);
export const AppContextProvider = Ctx.Provider;

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp() must be used inside the app provider');
  return v;
}
