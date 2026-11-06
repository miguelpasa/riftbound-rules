/** Host, Join and Solo setup screens. Each hands a running game to App through `onGame`. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { GuestSession } from '../net/guestSession';
import { connectGuestPeer } from '../net/peerTransport';
import { isValidRoomCode, normalizeRoomCode } from '../net/roomCode';
import { guestGameApi, type GuestGameAdapter } from './adapters';
import { useApp } from './context';
import { DeckPicker, type DeckChoice } from './DeckPicker';
import type { ActiveGame } from './GameView';
import {
  hashToUnit,
  newSeed,
  openHostLobby,
  startSoloGame,
  type HostGame,
  type HostLobby,
} from './hostGame';
import { errorText, pushToastOnce } from './toastUtil';
import { useStore } from './useStore';

export interface FlowProps {
  onBack: () => void;
  onGame: (g: ActiveGame) => void;
}

export function Panel({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-slate-100">{title}</h2>
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          Back
        </button>
      </div>
      {children}
    </section>
  );
}

const primaryBtn =
  'rounded-lg bg-amber-400 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white';

export function hostActive(game: HostGame, kind: 'solo' | 'host'): ActiveGame {
  const peer = game.peer;
  return {
    kind,
    adapter: game.adapter,
    dispose: () => game.dispose(),
    roomCode: game.roomCode,
    statusText: peer
      ? {
          get: () => (peer.get().detail === 'listening' ? '' : peer.get().message),
          subscribe: peer.subscribe,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------- host

export function HostFlow({ onBack, onGame }: FlowProps) {
  const app = useApp();
  const [deck, setDeck] = useState<DeckChoice | null>(null);
  const [lobby, setLobby] = useState<HostLobby | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const lobbyRef = useRef<HostLobby | null>(null);
  const state = useStore(lobby ? lobby.state : null);

  useEffect(
    () => () => {
      lobbyRef.current?.dispose();
    },
    [],
  );

  const game = state?.game ?? null;
  useEffect(() => {
    if (game) onGame(hostActive(game, 'host'));
  }, [game, onGame]);

  const create = async (): Promise<void> => {
    if (!deck) return;
    setStarting(true);
    try {
      const storage = await app.getStorage();
      const l = openHostLobby(app.makeEnv(storage), {
        deck: deck.deck,
        timersEnabled: app.settings.timerMultiplayer,
      });
      lobbyRef.current = l;
      setLobby(l);
    } catch (e) {
      pushToastOnce(`Could not open a room: ${errorText(e)}`);
    } finally {
      setStarting(false);
    }
  };

  const close = (): void => {
    lobbyRef.current?.dispose();
    lobbyRef.current = null;
    setLobby(null);
  };

  const copy = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      pushToastOnce('Could not copy to the clipboard. Select the code and copy it by hand.');
    }
  };

  if (lobby && state) {
    const failed = state.peer.detail === 'id-unavailable';
    return (
      <Panel
        title="Host game"
        onBack={() => {
          close();
          onBack();
        }}
      >
        <div className="flex flex-col items-center gap-4 rounded-xl border border-slate-700 bg-slate-900 p-6">
          <p className="text-sm text-slate-400">Share this room code with your opponent</p>
          <p
            data-testid="room-code"
            aria-label="Room code"
            className="font-mono text-5xl font-bold tracking-widest text-amber-300"
          >
            {state.roomCode}
          </p>
          <button
            type="button"
            onClick={() => void copy(state.roomCode)}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-100 hover:bg-slate-600"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <p role="status" className={failed ? 'text-rose-300' : 'text-slate-200'}>
            {state.peer.message}
          </p>
          {state.rejected ? (
            <p role="alert" className="text-sm text-rose-300">
              {state.rejected}
            </p>
          ) : null}
          {failed ? (
            <button
              type="button"
              className={primaryBtn}
              onClick={() => {
                close();
                void create();
              }}
            >
              New room code
            </button>
          ) : null}
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Host game" onBack={onBack}>
      <DeckPicker presets={app.data.presets} cards={app.data.cards} onChange={setDeck} />
      <button
        type="button"
        className={primaryBtn}
        disabled={!deck || starting}
        onClick={() => void create()}
      >
        Create room
      </button>
    </Panel>
  );
}

// ---------------------------------------------------------------- join

function GuestPending({
  adapter,
  roomCode,
  onLeave,
}: {
  adapter: GuestGameAdapter;
  roomCode: string;
  onLeave: () => void;
}) {
  const guest = adapter.session;
  const status = useSyncExternalStore(
    adapter.subscribe,
    () => guest.status,
    () => guest.status,
  );
  const refusal = guest.refusal;
  useEffect(() => {
    // A refused guest must stop the transport's reconnect loop.
    if (refusal) guest.close();
  }, [refusal, guest]);
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 bg-slate-950 p-6 text-center text-slate-100">
      <h1 className="text-2xl font-bold text-amber-300">Room {roomCode}</h1>
      {refusal ? (
        <p role="alert" className="text-rose-300">
          The host refused the connection: {refusal.message}
        </p>
      ) : (
        <p role="status">
          {status === 'host-away'
            ? 'Host disconnected, waiting for host to return...'
            : status === 'closed'
              ? 'Connection closed.'
              : 'Connecting to the host...'}
        </p>
      )}
      <button
        type="button"
        onClick={onLeave}
        className="rounded-lg bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700"
      >
        Back to menu
      </button>
    </div>
  );
}

export function JoinFlow({ onBack, onGame }: FlowProps) {
  const app = useApp();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deck, setDeck] = useState<DeckChoice | null>(null);

  const join = (): void => {
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) {
      setError('Enter the 6-character room code (letters and digits, no I, L, O, 0 or 1).');
      return;
    }
    if (!deck) {
      setError('Pick a deck first.');
      return;
    }
    setError(null);
    try {
      const transport = connectGuestPeer(
        normalized,
        app.deps.peerFactory ? { peerFactory: app.deps.peerFactory } : {},
      );
      const guest = new GuestSession({
        transport,
        storage: app.deps.guestStorage ?? { get: () => null, set: () => undefined },
        storageKey: `rb-guest:${normalized}`,
        deck: deck.deck,
      });
      const adapter = guestGameApi(guest, app.data.cards, {
        ...(app.deps.guestSendTimeoutMs !== undefined
          ? { sendTimeoutMs: app.deps.guestSendTimeoutMs }
          : {}),
      });
      onGame({
        kind: 'guest',
        adapter,
        roomCode: normalized,
        dispose: () => {
          if (guest.gameOver) guest.forgetSeat();
          adapter.dispose();
          guest.close();
        },
        pending: (onLeave) => (
          <GuestPending adapter={adapter} roomCode={normalized} onLeave={onLeave} />
        ),
      });
    } catch (e) {
      setError(`Could not connect: ${errorText(e)}`);
    }
  };

  return (
    <Panel title="Join game" onBack={onBack}>
      <div className="flex flex-col gap-1">
        <label htmlFor="room-code" className="text-sm text-slate-300">
          Room code
        </label>
        <input
          id="room-code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={9}
          autoComplete="off"
          spellCheck={false}
          className="w-48 rounded border border-slate-600 bg-slate-950 px-3 py-2 font-mono text-2xl tracking-widest text-slate-100"
        />
        {error ? (
          <p role="alert" className="text-sm text-rose-300">
            {error}
          </p>
        ) : null}
      </div>
      <DeckPicker presets={app.data.presets} cards={app.data.cards} onChange={setDeck} />
      <button type="button" className={primaryBtn} disabled={!deck} onClick={join}>
        Join
      </button>
    </Panel>
  );
}

// ---------------------------------------------------------------- solo

export type Difficulty = 'easy' | 'normal' | 'hard';

export function pickBotDeck(
  presets: { id: string; deck: DeckChoice['deck'] }[],
  chosenId: string,
  fallback: DeckChoice['deck'],
  seed: string,
): DeckChoice['deck'] {
  const others = presets.filter((p) => p.id !== chosenId);
  if (others.length === 0) return fallback;
  return (others[Math.floor(hashToUnit(`${seed}|botdeck`) * others.length)] ?? others[0]!).deck;
}

export function SoloFlow({ onBack, onGame }: FlowProps) {
  const app = useApp();
  const [deck, setDeck] = useState<DeckChoice | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [starting, setStarting] = useState(false);
  const onChange = useCallback((d: DeckChoice | null) => setDeck(d), []);

  const start = async (): Promise<void> => {
    if (!deck) return;
    setStarting(true);
    try {
      const storage = await app.getStorage();
      const seed = newSeed();
      const botDeck = pickBotDeck(app.data.presets, deck.id, deck.deck, seed);
      const game = startSoloGame(app.makeEnv(storage), {
        deck: deck.deck,
        botDeck,
        difficulty,
        seed,
        timersEnabled: app.settings.timerSolo,
      });
      onGame(hostActive(game, 'solo'));
    } catch (e) {
      pushToastOnce(`Could not start the game: ${errorText(e)}`);
      setStarting(false);
    }
  };

  return (
    <Panel title="Play vs AI" onBack={onBack}>
      <DeckPicker presets={app.data.presets} cards={app.data.cards} onChange={onChange} />
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm text-slate-300">Difficulty</legend>
        <div className="flex gap-4">
          {(['easy', 'normal', 'hard'] as const).map((d) => (
            <label key={d} className="flex items-center gap-2 text-slate-200">
              <input
                type="radio"
                name="difficulty"
                value={d}
                checked={difficulty === d}
                onChange={() => setDifficulty(d)}
                className="accent-amber-400"
              />
              {d === 'easy' ? 'Easy' : d === 'hard' ? 'Hard' : 'Normal'}
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="button"
        className={primaryBtn}
        disabled={!deck || starting}
        onClick={() => void start()}
      >
        Start game
      </button>
    </Panel>
  );
}
