import type { Phase, PhaseStep, PlayerId } from '@riftbound/engine';

export interface PhaseTrackerProps {
  phase: Phase;
  step: PhaseStep;
  turnNumber: number;
  activePlayer: PlayerId;
  me: PlayerId;
}

const SEQUENCE: { phase: Phase; label: string }[] = [
  { phase: 'AWAKEN', label: 'Awaken' },
  { phase: 'BEGINNING', label: 'Beginning (Scoring)' },
  { phase: 'CHANNEL', label: 'Channel' },
  { phase: 'DRAW', label: 'Draw' },
  { phase: 'MAIN', label: 'Main' },
  { phase: 'ENDING', label: 'Ending' },
];

/** Turn phase sequence with the current phase highlighted. */
export function PhaseTracker({ phase, step, turnNumber, activePlayer, me }: PhaseTrackerProps) {
  const isMine = activePlayer === me;

  return (
    <section aria-label="Turn phases" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-sm">
        <span className={isMine ? 'font-semibold text-amber-300' : 'font-semibold text-slate-300'}>
          {isMine ? 'Your turn' : "Opponent's turn"}
        </span>
        <span className="text-slate-400">Turn {turnNumber}</span>
      </div>

      {phase === 'MULLIGAN' ? (
        <p className="text-sm text-slate-400">Mulligan</p>
      ) : (
        <ol className="flex flex-wrap gap-1.5">
          {SEQUENCE.map((item) => {
            const current = item.phase === phase;
            const scoring = current && item.phase === 'BEGINNING' && step === 'SCORING';
            return (
              <li
                key={item.phase}
                aria-current={current ? 'step' : undefined}
                className={
                  current
                    ? 'rounded-md border border-amber-300 bg-amber-300/15 px-2.5 py-1 text-xs font-semibold text-amber-200'
                    : 'rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-400'
                }
              >
                {item.label}
                {scoring && <span className="sr-only"> (scoring now)</span>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
