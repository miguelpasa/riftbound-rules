import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isHiddenCard } from '@riftbound/engine';
import type { GameEvent, Intent } from '@riftbound/engine';
import { useGame, type GameApi } from '../app/gameApi';
import { CardDetail } from '../components/CardDetail';
import { ChainInspector } from '../components/ChainInspector';
import { ChoicePrompt } from '../components/ChoicePrompt';
import { AbilityCostPrompt } from '../components/AbilityCostPrompt';
import { OptionalPrompt } from '../components/OptionalPrompt';
import { DeathReplacePrompt } from '../components/DeathReplacePrompt';
import { TriggerOrderPrompt } from '../components/TriggerOrderPrompt';
import { CombatDialog } from '../components/CombatDialog';
import { HostAwayOverlay } from '../components/HostAwayOverlay';
import { MulliganDialog } from '../components/MulliganDialog';
import { PhaseTracker } from '../components/PhaseTracker';
import { ResourcePanel } from '../components/ResourcePanel';
import { Scoreboard } from '../components/Scoreboard';
import { Toasts } from '../components/Toasts';
import { cueForEvent, pickCue, playCue } from '../app/sound';
import { describeEvent, isImportantEvent, isLoggedEvent } from './describeEvent';
import { Hand } from './Hand';
import { findMulligan, isTypingOrInteractive, primaryAction } from './interaction';
import { Playmat } from './Playmat';
import { Popover } from './Popover';
import { TargetBanner } from './TargetBanner';
import { useBoardUi } from './useBoardUi';

export interface GameScreenProps {
  /** Called from the game-over banner and the connection overlay. */
  onBackToMenu?: () => void;
  /** Solo: shown on the game-over banner as "Rematch". */
  onRematch?: () => void;
  /** Extra header content (leave button, room code, timer badge...). */
  headerExtra?: ReactNode;
  /** Tutorial: every plain unit click adds to the selection (no Ctrl/Shift needed). */
  additiveSelection?: boolean;
}

interface LogLine {
  seq: number;
  text: string;
}

interface LogState {
  source: GameEvent[] | null;
  seq: number;
  lines: LogLine[];
  announcement: string;
}

const MAX_LOG = 200;

/** Derives the game log and the aria-live announcement from `recentEvents` (deduplicated by seq). */
function useEventLog(api: GameApi): { lines: LogLine[]; announcement: string } {
  const [log, setLog] = useState<LogState>({ source: null, seq: 0, lines: [], announcement: '' });
  if (log.source !== api.recentEvents) {
    const first = log.source === null;
    const fresh = api.recentEvents.filter((e) => e.seq > log.seq);
    const added = fresh
      .filter(isLoggedEvent)
      .map((e) => ({ seq: e.seq, text: describeEvent(e, api.view, api.cards) }));
    const spoken = first
      ? []
      : fresh.filter(isImportantEvent).map((e) => describeEvent(e, api.view, api.cards));
    setLog({
      source: api.recentEvents,
      seq: fresh.length > 0 ? Math.max(log.seq, ...fresh.map((e) => e.seq)) : log.seq,
      lines: [...log.lines, ...added].slice(-MAX_LOG),
      announcement: spoken.length > 0 ? spoken.join(' ') : log.announcement,
    });
  }
  return { lines: log.lines, announcement: log.announcement };
}

/** Plays one sound cue per batch of fresh events (never for the first batch: that is history). */
function useSoundCues(api: GameApi): void {
  const lastSeq = useRef<number | null>(null);
  useEffect(() => {
    const events = api.recentEvents;
    const max = events.reduce((m, e) => Math.max(m, e.seq), 0);
    const prev = lastSeq.current;
    lastSeq.current = Math.max(prev ?? 0, max);
    if (prev === null) return;
    const fresh = events.filter((e) => e.seq > prev);
    const cue = pickCue(fresh.map((e) => cueForEvent(e, api.seat)));
    if (cue) playCue(cue);
  }, [api.recentEvents, api.seat]);
}

function ConnectionIndicators({ api }: { api: GameApi }) {
  const tone =
    api.connection === 'connected'
      ? 'bg-emerald-400'
      : api.connection === 'closed'
        ? 'bg-rose-500'
        : 'bg-amber-400';
  const label =
    api.connection === 'connected'
      ? 'Connected'
      : api.connection === 'connecting'
        ? 'Connecting'
        : api.connection === 'host-away'
          ? 'Host away'
          : 'Disconnected';
  return (
    <ul
      aria-label="Connection status"
      className="flex gap-3 text-xs text-slate-300 md:flex-col md:gap-1"
    >
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${tone}`} />
        {label}
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${api.opponentConnected ? 'bg-emerald-400' : 'bg-rose-500'}`}
        />
        {api.opponentConnected ? 'Opponent connected' : 'Opponent disconnected'}
      </li>
    </ul>
  );
}

function ShortcutHelp() {
  const id = useId();
  return (
    <span className="group relative">
      <button
        type="button"
        aria-label="Keyboard shortcuts"
        aria-describedby={id}
        className="h-7 w-7 rounded-full border border-slate-600 text-sm text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300"
      >
        ?
      </button>
      <span
        id={id}
        role="tooltip"
        className="invisible absolute right-0 z-30 mt-1 w-64 rounded-lg border border-slate-600 bg-slate-900 p-2 text-xs text-slate-200 shadow-xl group-focus-within:visible group-hover:visible"
      >
        Space or Enter: End turn / Pass (when nothing else is focused). Click a highlighted card to
        play it, select units then click a destination (or drag them) to move. Right-click a card
        for more actions.
      </span>
    </span>
  );
}

function ConcedeDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: Tab / Shift+Tab cycle through the dialog's buttons only.
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button') ?? []);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (!ref.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
    >
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900 p-5">
        <h2 id={titleId} className="text-lg font-semibold text-slate-100">
          Concede the game?
        </h2>
        <p className="text-sm text-slate-400">Your opponent will be awarded the win.</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-100 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            Keep playing
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            Concede
          </button>
        </div>
      </div>
    </div>
  );
}

function GameOverBanner({
  winner,
  seat,
  onBackToMenu,
  onRematch,
}: {
  winner: string | null;
  seat: string;
  onBackToMenu?: (() => void) | undefined;
  onRematch?: (() => void) | undefined;
}) {
  const text =
    winner === null ? 'The game ended in a draw.' : winner === seat ? 'You win!' : 'You lose.';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Game over"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-amber-300 bg-slate-900 p-6 text-center">
        <h2 className="text-2xl font-bold text-amber-300">Game over</h2>
        <p role="status" className="text-lg text-slate-100">
          {text}
        </p>
        {onRematch ? (
          <button
            type="button"
            autoFocus
            onClick={onRematch}
            className="rounded-lg bg-amber-400 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Rematch
          </button>
        ) : null}
        <button
          type="button"
          autoFocus={!onRematch}
          onClick={() => onBackToMenu?.()}
          className="rounded-lg bg-amber-400 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Back to menu
        </button>
      </div>
    </div>
  );
}

/** The whole in-game screen. Reads everything from `useGame()`; render inside a GameProvider. */
export function GameScreen({
  onBackToMenu,
  onRematch,
  headerExtra,
  additiveSelection,
}: GameScreenProps) {
  const api = useGame();
  const { view, cards, legal, seat } = api;
  const ui = useBoardUi(api, { additiveSelection: additiveSelection === true });
  const { lines, announcement } = useEventLog(api);
  useSoundCues(api);
  const [confirmConcede, setConfirmConcede] = useState(false);
  const concedeBtn = useRef<HTMLButtonElement>(null);
  const concedeWasOpen = useRef(false);
  // Closing the Concede dialog (Escape, Keep playing) returns focus to the button that opened it.
  useEffect(() => {
    if (concedeWasOpen.current && !confirmConcede) concedeBtn.current?.focus();
    concedeWasOpen.current = confirmConcede;
  }, [confirmConcede]);

  const primary = primaryAction(view, legal);
  const submit = ui.submit;
  const primaryIntent: Intent | undefined = ui.targeting ? undefined : primary?.intent;

  // Space / Enter = the primary pass/end action, only when no control has keyboard focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== ' ' && e.key !== 'Enter') return;
      if (isTypingOrInteractive(e.target)) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]')) return;
      if (!primaryIntent) return;
      e.preventDefault();
      void submit(primaryIntent);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [primaryIntent, submit]);

  const hoveredObj = ui.hovered ? view.objects[ui.hovered] : undefined;
  const hoveredDef = hoveredObj && !isHiddenCard(hoveredObj) ? cards[hoveredObj.cardId] : undefined;

  const inMulligan = view.turn.phase === 'MULLIGAN';
  const me = view.players.find((p) => p.id === seat);
  const myTurnToMulligan = inMulligan && legal.some((i) => i.type === 'MULLIGAN');
  const doneMulligan = view.mulligan?.done.includes(seat) ?? false;

  const priorityText = (() => {
    if (view.gameStatus !== 'IN_PROGRESS') return '';
    if (inMulligan) return myTurnToMulligan ? 'Your mulligan decision' : 'Waiting for the opponent';
    if (view.flow.combat?.awaitingAssignmentFrom) {
      return view.flow.combat.awaitingAssignmentFrom === seat
        ? 'Assign combat damage'
        : 'Opponent is assigning damage';
    }
    if (view.flow.priority === seat) return 'You have priority';
    if (view.flow.priority) return 'Opponent has priority';
    return '';
  })();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <a
        href="#board"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-amber-300 focus:px-3 focus:py-1 focus:text-slate-950"
      >
        Skip to the board
      </a>
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-slate-800 bg-slate-900 px-3 py-2 md:gap-y-2">
        <div className="w-full md:w-60" data-tutorial-id="score">
          <Scoreboard
            me={seat}
            players={view.players.map((p) => ({
              id: p.id,
              points: p.points,
              ...(p.xp ? { xp: p.xp } : {}),
            }))}
            victoryScore={view.victoryScore}
          />
        </div>
        <div
          className="w-full min-w-0 md:min-w-64 md:flex-1 md:w-auto"
          data-tutorial-id="phase-tracker"
        >
          <PhaseTracker
            phase={view.turn.phase}
            step={view.turn.step}
            turnNumber={view.turn.number}
            activePlayer={view.turn.activePlayer}
            me={seat}
          />
        </div>
        <ConnectionIndicators api={api} />
        {headerExtra}
        <div className="flex w-full items-center gap-2 md:ml-auto md:w-auto md:gap-3">
          <span
            className="mr-auto min-w-0 truncate text-sm text-slate-400 md:mr-0"
            data-testid="priority-text"
          >
            {priorityText}
          </span>
          {primary ? (
            <button
              type="button"
              data-tutorial-id={primary.intent.type === 'END_TURN' ? 'btn-end-turn' : 'btn-pass'}
              onClick={() => void submit(primary.intent)}
              className="min-h-11 rounded-lg bg-amber-400 px-4 py-2 font-semibold md:min-h-0 text-slate-950 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {primary.label}
            </button>
          ) : null}
          <ShortcutHelp />
          <button
            ref={concedeBtn}
            type="button"
            disabled={api.gameOver !== null}
            onClick={() => setConfirmConcede(true)}
            className="min-h-11 rounded-lg border border-rose-700 px-3 py-2 text-sm md:min-h-0 text-rose-200 hover:bg-rose-950 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:opacity-40"
          >
            Concede
          </button>
        </div>
      </header>

      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <main id="board" tabIndex={-1} className="flex min-w-0 flex-col gap-3 outline-none">
          <TargetBanner ui={ui} />
          <Playmat ui={ui} />
          <Hand ui={ui} />
        </main>
        <aside aria-label="Resources, chain and log" className="flex flex-col gap-3">
          <div data-tutorial-id="rune-panel">
            <ResourcePanel />
          </div>
          <div data-tutorial-id="chain-panel">
            <ChainInspector />
          </div>
          <details className="rounded-xl border border-slate-800 bg-slate-900 p-2">
            <summary className="cursor-pointer text-sm font-semibold text-slate-200 focus-visible:outline-2 focus-visible:outline-amber-300">
              Game log ({lines.length})
            </summary>
            <ol
              aria-label="Game log"
              className="mt-2 flex max-h-72 flex-col-reverse gap-1 overflow-y-auto text-xs text-slate-300"
            >
              {[...lines].reverse().map((l) => (
                <li key={l.seq}>{l.text}</li>
              ))}
            </ol>
          </details>
        </aside>
      </div>

      {hoveredDef ? (
        <div className="pointer-events-none fixed top-20 right-3 z-30 hidden lg:block">
          <CardDetail
            def={hoveredDef}
            {...(hoveredObj && !isHiddenCard(hoveredObj) ? { instance: hoveredObj } : {})}
          />
        </div>
      ) : null}

      <CombatDialog />
      <ChoicePrompt />
      <OptionalPrompt />
      <DeathReplacePrompt />
      <TriggerOrderPrompt />
      <AbilityCostPrompt ui={ui} />

      <div aria-live="polite" role="status" className="sr-only" data-testid="announcer">
        {announcement}
      </div>

      {ui.popover ? <Popover popover={ui.popover} onClose={ui.closePopover} /> : null}

      {inMulligan && me && !api.gameOver && !doneMulligan ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mulligan"
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-4"
        >
          <div className="w-full max-w-xl">
            <MulliganDialog
              cards={me.hand.map((id) => ({
                id,
                name: (() => {
                  const o = view.objects[id];
                  return o && !isHiddenCard(o) ? (cards[o.cardId]?.name ?? 'Card') : 'Card';
                })(),
              }))}
              waitingFor={!myTurnToMulligan}
              onConfirm={(ids) => {
                const intent = findMulligan(legal, ids);
                void submit(intent ?? { type: 'MULLIGAN', playerId: seat, cardIds: ids });
              }}
            />
          </div>
        </div>
      ) : null}
      {inMulligan && doneMulligan && !api.gameOver ? (
        <p
          role="status"
          className="fixed bottom-4 left-4 z-30 rounded-lg bg-slate-800 px-3 py-2 text-sm"
        >
          Waiting for the opponent to finish the mulligan...
        </p>
      ) : null}

      {confirmConcede ? (
        <ConcedeDialog
          onCancel={() => setConfirmConcede(false)}
          onConfirm={() => {
            setConfirmConcede(false);
            void submit({ type: 'CONCEDE', playerId: seat });
          }}
        />
      ) : null}

      {api.gameOver ? (
        <GameOverBanner
          winner={api.gameOver.winner}
          seat={seat}
          onBackToMenu={onBackToMenu}
          onRematch={onRematch}
        />
      ) : null}

      <HostAwayOverlay status={api.connection} onLeave={() => onBackToMenu?.()} />
      <Toasts />
    </div>
  );
}
