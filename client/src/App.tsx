import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardDatabase } from '@riftbound/engine';
import { buildPresetDecks } from './decks/presets';
import { FIXTURE_CARDS, FIXTURE_PRESETS } from './decks/fixtureDecks';
import { CardImagesProvider, ImageToggle } from './components/CardImages';
import { Toasts } from './components/Toasts';
import { CardGallery } from './dev/CardGallery';
import { MockGameScreen } from './dev/mockGame';
import type { GameStorage } from './host/persistence';
import { TutorialApp } from './tutorial/TutorialApp';
import {
  AppContextProvider,
  defaultDeps,
  type AppContextValue,
  type AppDeps,
  type GameData,
} from './app/context';
import { HostFlow, JoinFlow, Panel, SoloFlow } from './app/Flows';
import { GameView, timerStore, type ActiveGame } from './app/GameView';
import type { HostEnv } from './app/hostGame';
import { SavedGamesScreen } from './app/Replays';
import { loadSettings, saveSettings, type AppSettings } from './app/settings';
import { errorText, pushToastOnce } from './app/toastUtil';
import { setState, useGameStore } from './store/gameStore';

type Screen = 'menu' | 'host' | 'join' | 'solo' | 'tutorial' | 'replays' | 'game' | 'settings';

export const LICENSE_NOTE = 'Card data (c) Riot Games. Personal, non-commercial use.';

export interface AppProps {
  /** Test/embedding hook: replaces the real card loader, storage, peer broker and bot factory. */
  deps?: Partial<AppDeps>;
}

export function App({ deps }: AppProps = {}) {
  const params = new URLSearchParams(location.search);
  if (params.has('gallery')) return <CardGallery />;
  if (params.has('mock')) return <MockGameScreen />;
  return <MainApp deps={deps} />;
}

type CardsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; data: GameData; count: number };

function computeData(cards: CardDatabase): GameData {
  const presets = buildPresetDecks(cards, { count: 8 });
  if (presets.length > 0) return { cards, presets, fixture: false };
  return { cards: FIXTURE_CARDS, presets: FIXTURE_PRESETS, fixture: true };
}

function MainApp({ deps: override }: AppProps) {
  const deps = useMemo<AppDeps>(() => ({ ...defaultDeps(), ...override }), [override]);
  const [cardsState, setCardsState] = useState<CardsState>({ phase: 'loading' });
  const [screen, setScreen] = useState<Screen>('menu');
  const [active, setActive] = useState<ActiveGame | null>(null);
  const activeRef = useRef<ActiveGame | null>(null);
  const [settings, setSettingsState] = useState<AppSettings>(loadSettings);
  const status = useGameStore((s) => s.status);
  const storageRef = useRef<Promise<GameStorage> | null>(null);

  useEffect(() => {
    let alive = true;
    deps
      .loadCards()
      .then((result) => {
        if (!alive) return;
        if (result.ok) {
          const count = Object.keys(result.cards).length;
          setState({ cards: result.cards, status: `Loaded ${count} cards` });
          setCardsState({ phase: 'ready', data: computeData(result.cards), count });
        } else {
          setState({ status: result.message });
          setCardsState({ phase: 'error', message: result.message });
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const message = errorText(e);
        setCardsState({ phase: 'error', message });
      });
    return () => {
      alive = false;
    };
  }, [deps]);

  const getStorage = useCallback((): Promise<GameStorage> => {
    storageRef.current ??= deps.openStorage().catch((e: unknown) => {
      storageRef.current = null;
      throw e;
    });
    return storageRef.current;
  }, [deps]);

  const data = cardsState.phase === 'ready' ? cardsState.data : null;

  const makeEnv = useCallback(
    (storage: GameStorage): HostEnv => {
      if (!data) throw new Error('cards are not loaded');
      return {
        cards: data.cards,
        storage,
        ...(deps.peerFactory ? { peerFactory: deps.peerFactory } : {}),
        createBot: deps.createBot,
        ...(deps.botDelayMs !== undefined ? { botDelayMs: deps.botDelayMs } : {}),
        onError: pushToastOnce,
        onTimer: (p) => {
          timerStore.set(p);
          setState({ deadline: p.deadline });
        },
      };
    },
    [data, deps],
  );

  const setSettings = useCallback((next: AppSettings) => {
    setSettingsState(next);
    saveSettings(next);
  }, []);

  const leave = useCallback(() => {
    const a = activeRef.current;
    activeRef.current = null;
    setActive(null);
    setScreen('menu');
    setState({ toasts: [], deadline: null });
    if (a) {
      Promise.resolve()
        .then(() => a.dispose())
        .catch((e: unknown) => console.error('[app] dispose failed', e));
    }
  }, []);

  const onGame = useCallback((g: ActiveGame) => {
    activeRef.current = g;
    setActive(g);
    setScreen('game');
  }, []);

  useEffect(
    () => () => {
      const a = activeRef.current;
      activeRef.current = null;
      if (a) void Promise.resolve(a.dispose()).catch(() => undefined);
    },
    [],
  );

  const ctx = useMemo<AppContextValue | null>(
    () => (data ? { deps, data, getStorage, makeEnv, settings, setSettings } : null),
    [data, deps, getStorage, makeEnv, settings, setSettings],
  );

  const toMenu = useCallback(() => setScreen('menu'), []);

  let body;
  if (screen === 'game' && active && ctx) {
    body = <GameView active={active} onLeave={leave} />;
  } else if (screen === 'tutorial') {
    body = <TutorialApp onExit={toMenu} />;
  } else if (ctx && screen === 'host') {
    body = <HostFlow onBack={toMenu} onGame={onGame} />;
  } else if (ctx && screen === 'join') {
    body = <JoinFlow onBack={toMenu} onGame={onGame} />;
  } else if (ctx && screen === 'solo') {
    body = <SoloFlow onBack={toMenu} onGame={onGame} />;
  } else if (ctx && screen === 'replays') {
    body = <SavedGamesScreen onBack={toMenu} onGame={onGame} />;
  } else if (screen === 'settings') {
    body = <SettingsPanel settings={settings} onChange={setSettings} onBack={toMenu} />;
  } else {
    body = (
      <MenuScreen
        cardsState={cardsState}
        status={status}
        go={setScreen}
        fixture={data?.fixture ?? false}
      />
    );
  }

  const fullScreen = screen === 'game' || screen === 'replays' || screen === 'tutorial';

  return (
    <CardImagesProvider>
      <AppContextProvider value={ctx as AppContextValue}>
        <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
          {fullScreen ? (
            body
          ) : (
            <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8">
              {body}
            </main>
          )}
          {screen !== 'game' && screen !== 'tutorial' ? <Toasts /> : null}
        </div>
      </AppContextProvider>
    </CardImagesProvider>
  );
}

// ---------------------------------------------------------------- menu

function MenuScreen({
  cardsState,
  status,
  go,
  fixture,
}: {
  cardsState: CardsState;
  status: string;
  go: (s: Screen) => void;
  fixture: boolean;
}) {
  const ready = cardsState.phase === 'ready';
  const items: { label: string; screen: Screen }[] = [
    { label: 'Host Game', screen: 'host' },
    { label: 'Join Game', screen: 'join' },
    { label: 'Play vs AI', screen: 'solo' },
    { label: 'Tutorial', screen: 'tutorial' },
    { label: 'Saved games / Replays', screen: 'replays' },
    { label: 'Settings', screen: 'settings' },
  ];
  return (
    <>
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-amber-300">
          Riftbound Local Duelist
        </h1>
        <p className="mt-1 text-sm text-slate-400">{status}</p>
      </header>

      {cardsState.phase === 'error' ? (
        <div
          role="alert"
          className="rounded-lg border border-rose-700 bg-rose-950/60 px-4 py-3 text-sm text-rose-200"
        >
          {cardsState.message}
        </div>
      ) : cardsState.phase === 'ready' ? (
        <div
          role="status"
          className="rounded-lg border border-emerald-700 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200"
        >
          {`Loaded ${cardsState.count} cards`}
          {fixture ? ' (no presets could be built from them: using built-in fixture cards)' : ''}
        </div>
      ) : null}

      <nav aria-label="Main menu" className="flex flex-col gap-3">
        {items.map(({ label, screen }) => (
          <button
            key={label}
            type="button"
            disabled={!ready}
            onClick={() => go(screen)}
            className="w-full rounded-lg bg-slate-800 px-4 py-3 text-left font-medium text-slate-100 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {label}
          </button>
        ))}
      </nav>

      {cardsState.phase === 'error' ? (
        <p className="text-xs text-slate-500">
          Dev routes:{' '}
          <a className="underline" href="?gallery">
            ?gallery
          </a>{' '}
          <a className="underline" href="?mock">
            ?mock
          </a>
        </p>
      ) : null}

      <footer className="mt-auto text-xs text-slate-500">{LICENSE_NOTE}</footer>
    </>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onBack,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onBack: () => void;
}) {
  return (
    <Panel title="Settings" onBack={onBack}>
      <div className="flex flex-col gap-4">
        <ImageToggle />
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={settings.timerMultiplayer}
            onChange={(e) => onChange({ ...settings, timerMultiplayer: e.target.checked })}
            className="h-4 w-4 accent-indigo-500"
          />
          Reaction timer in multiplayer (30 s to respond, auto-pass on timeout)
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={settings.timerSolo}
            onChange={(e) => onChange({ ...settings, timerSolo: e.target.checked })}
            className="h-4 w-4 accent-indigo-500"
          />
          Reaction timer in games vs the AI
        </label>
      </div>
    </Panel>
  );
}
