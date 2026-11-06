/** Saved games list (resume / watch replay / delete / import) and the replay viewer. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeEvents } from '@riftbound/engine';
import type { CardDatabase, PlayerId } from '@riftbound/engine';
import { describeEvent, isLoggedEvent } from '../game/describeEvent';
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

/** One line of the replay event list: the step it belongs to and its readable text. */
interface ReplayLogLine {
  key: string;
  step: number;
  text: string;
}

function ReplayBody({ player, cards, log, onClose }: ReplayViewerProps & { player: ReplayPlayer }) {
  const [step, setStep] = useState(player.totalSteps);
  const [seat, setSeat] = useState<PlayerId>(log.hostSeat);
  const total = player.totalSteps;
  const logRef = useRef<HTMLOListElement>(null);

  // Keep the player's cursor on `step`; the view and the state hash read from it.
  player.stepTo(step);

  const view = useMemo(() => player.viewFor(seat), [player, seat, step]);

  // Every event of every step up to the current one, seat-filtered, in order.
  const replayLines = useMemo<ReplayLogLine[]>(() => {
    const lines: ReplayLogLine[] = [];
    for (let s = 1; s <= step; s++) {
      for (const e of sanitizeEvents(player.eventsOf(s), seat)) {
        if (!isLoggedEvent(e)) continue;
        lines.push({ key: `${s}:${e.seq}`, step: s, text: describeEvent(e, view, cards) });
      }
    }
    return lines;
  }, [player, step, seat, view, cards]);

  const api = useMemo<GameApi>(() => {
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
      // The events of the current step only: GameScreen's own log is built from these.
      recentEvents: sanitizeEvents(player.eventsOf(step), seat),
      connection: 'connected',
      opponentConnected: true,
      gameOver: null,
      send: async () => ({
        ok: false,
        code: 'GAME_OVER',
        message: '[Rule Error] This is a replay; nothing can be played.',
      }),
    };
  }, [player, seat, cards, view, step]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replayLines.length]);

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
      <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-col">
        <section
          aria-label="Replay event list"
          className="max-h-40 overflow-y-auto border-t border-slate-700 bg-slate-950/95 px-4 py-2 text-xs text-slate-300"
        >
          {replayLines.length === 0 ? (
            <p className="text-slate-500">No events yet. Step forward to see what happened.</p>
          ) : (
            <ol ref={logRef} data-testid="replay-event-list" className="flex flex-col gap-0.5">
              {replayLines.map((l) => (
                <li key={l.key}>
                  <span className="mr-2 text-slate-500">Step {l.step}</span>
                  {l.text}
                </li>
              ))}
            </ol>
          )}
        </section>
        <div
          role="group"
          aria-label="Replay controls"
          className="flex flex-wrap items-center gap-3 border-t border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100"
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
              if (!downloadReplay(log))
                pushToastOnce('Downloads are not available in this browser.');
            }}
            className="rounded bg-slate-700 px-2 py-1"
          >
            Export replay
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- saved games

/** Result from the host's side ("won" / "lost"), or a neutral line when the seat is unknown. */
export function resultOf(g: GameSummary): 'won' | 'lost' | 'draw' | 'unknown' | 'playing' {
  if (g.status === 'IN_PROGRESS') return 'playing';
  if (g.winner === undefined || g.winner === null) return g.winner === null ? 'draw' : 'unknown';
  if (g.hostSeat === undefined) return 'unknown';
  return g.winner === g.hostSeat ? 'won' : 'lost';
}

/** Win/loss record over finished solo games (the human is always the host seat). */
export function soloRecord(games: GameSummary[]): { won: number; lost: number; draw: number } {
  const rec = { won: 0, lost: 0, draw: 0 };
  for (const g of games) {
    if (g.mode !== 'SOLO') continue;
    const r = resultOf(g);
    if (r === 'won') rec.won++;
    else if (r === 'lost') rec.lost++;
    else if (r === 'draw') rec.draw++;
  }
  return rec;
}

function describeGame(g: GameSummary): string {
  const when = new Date(g.createdAt).toLocaleString();
  const mode =
    g.mode === 'SOLO'
      ? `vs AI${g.difficulty ? ` (${g.difficulty})` : ''}`
      : `Multiplayer${g.roomCode ? ` (${g.roomCode})` : ''}`;
  const r = resultOf(g);
  const result =
    r === 'playing'
      ? 'in progress'
      : r === 'won'
        ? 'you won'
        : r === 'lost'
          ? 'you lost'
          : r === 'draw'
            ? 'draw'
            : g.winner
              ? `finished, ${g.winner === 'p0' ? 'Player 1' : 'Player 2'} won`
              : 'finished';
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
        <>
          {(() => {
            const rec = soloRecord(games);
            return rec.won + rec.lost + rec.draw > 0 ? (
              <p className="text-sm text-slate-300" data-testid="solo-record">
                Record vs AI: {rec.won} won, {rec.lost} lost
                {rec.draw > 0 ? `, ${rec.draw} drawn` : ''}
              </p>
            ) : null;
          })()}
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
        </>
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
