import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { GameProvider } from './gameApi';
import { GameScreen } from '../game/GameScreen';
import { useGameApi, type GameAdapter } from './adapters';
import { ErrorBoundary } from './ErrorBoundary';
import { createStore } from './store';
import type { TimerPublish } from './hostTimers';

/** What App holds while a game screen is up. */
export interface ActiveGame {
  kind: 'solo' | 'host' | 'guest';
  adapter: GameAdapter;
  dispose(): void | Promise<void>;
  /** Room code to display (multiplayer). */
  roomCode?: string | undefined;
  /** Extra status text shown in the header (host broker status). */
  statusText?: { get(): string; subscribe(l: () => void): () => void } | undefined;
  /** Shown instead of the game until the first view arrives (guest connecting / refused). */
  pending?: ((onLeave: () => void) => ReactNode) | undefined;
}

/** Timer shown in the header; fed by HostEnv.onTimer. */
export const timerStore = createStore<TimerPublish>({ deadline: null, kind: null, player: null });

const KIND_LABEL: Record<string, string> = {
  REACTION: 'Reaction',
  TURN: 'Turn',
  MULLIGAN: 'Mulligan',
  ASSIGNMENT: 'Damage assignment',
};

function TimerBadge() {
  const t = useSyncExternalStore(timerStore.subscribe, timerStore.get, timerStore.get);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (t.deadline === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [t.deadline]);
  if (t.deadline === null) return null;
  const left = Math.max(0, Math.ceil((t.deadline - now) / 1000));
  return (
    <span
      data-testid="timer-badge"
      className={`rounded-full px-2 py-1 text-xs font-semibold ${left <= 10 ? 'bg-rose-900 text-rose-100' : 'bg-slate-700 text-slate-100'}`}
    >
      {KIND_LABEL[t.kind ?? ''] ?? 'Timer'}: {left}s
    </span>
  );
}

function LeaveButton({ onLeave }: { onLeave: () => void }) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <span className="flex items-center gap-1 text-xs">
      <button
        type="button"
        onClick={onLeave}
        className="rounded-lg bg-rose-600 px-2 py-1 font-semibold text-white hover:bg-rose-500"
      >
        Leave now
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        className="rounded-lg bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700"
      >
        Stay
      </button>
    </span>
  ) : (
    <button
      type="button"
      onClick={() => setArmed(true)}
      className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
    >
      Menu
    </button>
  );
}

function StatusText({ active }: { active: ActiveGame }) {
  const s = active.statusText;
  const text = useSyncExternalStore(
    s?.subscribe ?? (() => () => undefined),
    s?.get ?? (() => ''),
    s?.get ?? (() => ''),
  );
  return (
    <>
      {active.roomCode ? (
        <span className="text-xs text-slate-400">
          Room <span className="font-mono text-slate-200">{active.roomCode}</span>
        </span>
      ) : null}
      {text ? (
        <span role="status" className="text-xs text-amber-300">
          {text}
        </span>
      ) : null}
    </>
  );
}

function GameBody({ active, onLeave }: { active: ActiveGame; onLeave: () => void }) {
  const api = useGameApi(active.adapter);
  if (!api) {
    return <>{active.pending ? active.pending(onLeave) : <p className="p-6">Connecting...</p>}</>;
  }
  return (
    <GameProvider value={api}>
      <GameScreen
        onBackToMenu={onLeave}
        headerExtra={
          <span className="flex flex-wrap items-center gap-2">
            <StatusText active={active} />
            <TimerBadge />
            <LeaveButton onLeave={onLeave} />
          </span>
        }
      />
    </GameProvider>
  );
}

/** The in-game screen with its crash guard. */
export function GameView({ active, onLeave }: { active: ActiveGame; onLeave: () => void }) {
  return (
    <ErrorBoundary onBack={onLeave}>
      <GameBody active={active} onLeave={onLeave} />
    </ErrorBoundary>
  );
}
