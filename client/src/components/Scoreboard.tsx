import type { PlayerId } from '@riftbound/engine';

export interface ScoreEntry {
  id: PlayerId;
  points: number;
  /** R53: XP, shown only once the player has some. */
  xp?: number;
}

export interface ScoreboardProps {
  me: PlayerId;
  players: ScoreEntry[];
  victoryScore: number;
}

function Pips({ filled, total }: { filled: number; total: number }) {
  return (
    <span aria-hidden="true" className="hidden flex-wrap gap-1 sm:flex">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={
            i < filled
              ? 'animate-pop h-3 w-3 rounded-full bg-amber-400'
              : 'h-3 w-3 rounded-full border border-slate-600 bg-slate-800'
          }
        />
      ))}
    </span>
  );
}

/** Points as pips toward victoryScore, with the viewer listed first. */
export function Scoreboard({ me, players, victoryScore }: ScoreboardProps) {
  const ordered = [...players].sort((a, b) => Number(b.id === me) - Number(a.id === me));

  return (
    <ul aria-label="Scoreboard" className="flex gap-2 md:flex-col">
      {ordered.map((player) => {
        const label = player.id === me ? 'You' : 'Opponent';
        const filled = Math.min(Math.max(player.points, 0), victoryScore);
        return (
          <li
            key={player.id}
            aria-label={`${label}: ${filled} of ${victoryScore} points`}
            className="flex flex-1 items-center justify-between gap-2 rounded-lg bg-slate-900 px-2 py-1 md:gap-3 md:px-3 md:py-2"
          >
            <span className="text-sm font-medium text-slate-200">
              {label}
              {player.xp ? (
                <span className="ml-2 text-xs text-sky-300" title="Experience (XP)">
                  {player.xp} XP
                </span>
              ) : null}
            </span>
            <div className="flex items-center gap-3">
              <Pips filled={filled} total={victoryScore} />
              <span className="w-10 text-right md:w-12 text-sm tabular-nums text-slate-400">
                {filled}/{victoryScore}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
