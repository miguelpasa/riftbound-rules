/** Saved games list (resume / watch replay / delete / import) and the replay viewer. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reduce, sanitizeEvents } from '@riftbound/engine';
import type { CardDatabase, GameEvent, PlayerId } from '@riftbound/engine';
import { GameScreen } from '../game/GameScreen';
import type { GameSummary } from '../host/persistence';
import { ReplayPlayer, downloadReplay, importReplay, type RecordedReplay } from '../host/replayLog';
import { useApp } from './context';
import { GameProvider, type GameApi } from './gameApi';
import { Panel, hostActive, type FlowProps } from './Flows';
import { resumeSavedGame } from './hostGame';
import { errorText, pushToastOnce } from './toastUtil';

// ---------------------------------------------------------------- viewer

export interface ReplayViewerProps {
  cards: CardDatabase;
  log: RecordedReplay;
  onClose: () => void;
}

/** GameScreen over a finished game: nothing is interactive, any seat can be watched. */
export function ReplayViewer({ cards, log, onClose }: ReplayViewerProps) {
  const made = useMemo<{ player: ReplayPlayer } | { error: string }>(() => {
    try {
      return { player: new ReplayPlayer(cards, log) };
    } catch (e) {
      return { error: errorText(e) };
    }
  }, [cards, log]);
  if ('error' in made) {
    return (
      <Panel title="Replay" onBack={onClose}>
        <p role="alert" className="text-rose-300">
          This replay cannot be played: {made.error}
        </p>
      </Panel>
    );
  }
  return <ReplayBody player={made.player} cards={cards} log={log} onClose={onClose} />;
}

function ReplayBody({ player, cards, log, onClose }: ReplayViewerProps & { player: ReplayPlayer }) {
  const [step, setStep] = useState(player.totalSteps);
  const [seat, setSeat] = useState<PlayerId>(log.hostSeat);
  const total = player.totalSteps;

  const frame = useMemo(() => {
    let events: GameEvent[] = [];
    if (step > 0) {
      const prev = player.stepTo(step - 1).state;
      const r = reduce(prev, cards, log.intents[step - 1]!);
      if (r.ok) events = r.events;
      player.stepTo(step);
    } else player.stepTo(0);
    return { events, step };
  }, [player, step, cards, log]);

  const api = useMemo<GameApi>(() => {
    const view = player.viewFor(seat);
    // Hide the interactive mulligan modal: this is a read-only viewer.
    const patched =
      view.mulligan && view.turn.phase === 'MULLIGAN'
        ? { ...view, mulligan: { ...view.mulligan, done: [...view.mulligan.done, seat] } }
        : view;
    return {
      cards,
      seat,
      view: patched,
      legal: [],
      recentEvents: sanitizeEvents(frame.events, seat),
      connection: 'connected',
      opponentConnected: true,
      gameOver: null,
      send: async () => ({
        ok: false,
        code: 'GAME_OVER',
        message: '[Rule Error] This is a replay; nothing can be played.',
      }),
    };
    // frame.step ties the memo to the stepped state
  }, [player, seat, cards, frame]);

  return (
    <>
      <GameProvider value={api}>
        <GameScreen
          onBackToMenu={onClose}
          headerExtra={
            <span className="rounded-full bg-indigo-900 px-2 py-1 text-xs text-indigo-100">
              Replay
            </span>
          }
        />
      </GameProvider>
      <div
        role="group"
        aria-label="Replay controls"
        className="fixed inset-x-0 bottom-0 z-[60] flex flex-wrap items-center gap-3 border-t border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100"
      >
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-slate-600 px-2 py-1"
        >
          Close
        </button>
        <button
          type="button"
          aria-label="Previous step"
          disabled={step <= 0}
          onClick={() => setStep(step - 1)}
          className="rounded bg-slate-700 px-2 py-1 disabled:opacity-40"
        >
          {'◀'}
        </button>
        <input
          type="range"
          aria-label="Replay step"
          min={0}
          max={total}
          value={step}
          onChange={(e) => setStep(Number(e.target.value))}
          className="min-w-40 flex-1"
        />
        <button
          type="button"
          aria-label="Next step"
          disabled={step >= total}
          onClick={() => setStep(step + 1)}
          className="rounded bg-slate-700 px-2 py-1 disabled:opacity-40"
        >
          {'▶'}
        </button>
        <span data-testid="replay-step">
          Step {step} / {total}
        </span>
        <label className="flex items-center gap-1">
          View as
          <select
            value={seat}
            onChange={(e) => setSeat(e.target.value as PlayerId)}
            className="rounded border border-slate-600 bg-slate-950 px-1 py-0.5"
          >
            <option value="p0">Player 1</option>
            <option value="p1">Player 2</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            if (!downloadReplay(log)) pushToastOnce('Downloads are not available in this browser.');
          }}
          className="rounded bg-slate-700 px-2 py-1"
        >
          Export replay
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- saved games

function describeGame(g: GameSummary): string {
  const when = new Date(g.createdAt).toLocaleString();
  const mode = g.mode === 'SOLO' ? 'vs AI' : `Multiplayer${g.roomCode ? ` (${g.roomCode})` : ''}`;
  const result =
    g.status === 'IN_PROGRESS'
      ? 'in progress'
      : g.winner === undefined || g.winner === null
        ? 'finished'
        : `finished, ${g.winner === 'p0' ? 'Player 1' : 'Player 2'} won`;
  return `${when} - ${mode} - ${result} - ${g.intentCount} actions`;
}

export function SavedGamesScreen({ onBack, onGame }: FlowProps) {
  const app = useApp();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [replay, setReplay] = useState<RecordedReplay | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const storage = await app.getStorage();
      setGames(await storage.listGames());
    } catch (e) {
      setGames([]);
      pushToastOnce(`Could not read saved games: ${errorText(e)}`);
    }
  }, [app]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resume = async (g: GameSummary): Promise<void> => {
    setBusy(g.gameId);
    try {
      const storage = await app.getStorage();
      const res = await resumeSavedGame(app.makeEnv(storage), g.gameId, {
        timersEnabled: g.mode === 'SOLO' ? app.settings.timerSolo : app.settings.timerMultiplayer,
      });
      if (!res.ok) {
        pushToastOnce(`Could not resume: ${res.message}`);
        setBusy(null);
        return;
      }
      onGame(hostActive(res.game, g.mode === 'SOLO' ? 'solo' : 'host'));
    } catch (e) {
      pushToastOnce(`Could not resume: ${errorText(e)}`);
      setBusy(null);
    }
  };

  const watch = async (g: GameSummary): Promise<void> => {
    setBusy(g.gameId);
    try {
      const storage = await app.getStorage();
      const loaded = await storage.loadGame(g.gameId);
      if (!loaded) throw new Error('game not found');
      const h = loaded.header;
      setReplay({
        engineVersion: h.engineVersion,
        seed: h.seed,
        decks: h.decks,
        intents: loaded.intents.map((i) => i.intent),
        finished: true,
        winner: h.winner ?? null,
        hostSeat: h.hostSeat,
      });
    } catch (e) {
      pushToastOnce(`Could not open the replay: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (g: GameSummary): Promise<void> => {
    try {
      const storage = await app.getStorage();
      await storage.deleteGame(g.gameId);
      await refresh();
    } catch (e) {
      pushToastOnce(`Could not delete the game: ${errorText(e)}`);
    }
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const res = importReplay(await file.text());
      if (res.ok) setReplay(res.log);
      else pushToastOnce(`Could not import the replay: ${res.error}`);
    } catch (e) {
      pushToastOnce(`Could not read the file: ${errorText(e)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (replay) {
    return <ReplayViewer cards={app.data.cards} log={replay} onClose={() => setReplay(null)} />;
  }

  return (
    <Panel title="Saved games and replays" onBack={onBack}>
      {games === null ? (
        <p className="text-slate-400">Loading...</p>
      ) : games.length === 0 ? (
        <p className="text-slate-400">No saved games yet.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Saved games">
          {games.map((g) => (
            <li
              key={g.gameId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
            >
              <span className="text-sm text-slate-200">{describeGame(g)}</span>
              <span className="flex gap-2">
                {g.status === 'IN_PROGRESS' ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void resume(g)}
                    className="rounded bg-amber-400 px-3 py-1 text-sm font-semibold text-slate-950 disabled:opacity-40"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void watch(g)}
                    className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-100 disabled:opacity-40"
                  >
                    Watch replay
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void remove(g)}
                  className="rounded border border-rose-700 px-3 py-1 text-sm text-rose-200 disabled:opacity-40"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="replay-file" className="text-sm text-slate-300">
          Import replay
        </label>
        <input
          id="replay-file"
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => void importFile(e.target.files?.[0])}
          className="text-sm text-slate-300"
        />
      </div>
    </Panel>
  );
}
