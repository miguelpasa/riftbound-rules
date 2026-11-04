import type { PlayerId } from '@riftbound/engine';

export interface ScoreEntry {
  id: PlayerId;
  points: number;
}

export interface ScoreboardProps {
  me: PlayerId;
  players: ScoreEntry[];
  victoryScore: number;
}

function Pips({ filled, total }: { filled: number; total: number }) {
  return (
    <span aria-hidden="true" className="flex flex-wrap gap-1">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={
            i < filled
              ? 'h-3 w-3 rounded-full bg-amber-400'
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
    <ul aria-label="Scoreboard" className="flex flex-col gap-2">
      {ordered.map((player) => {
        const label = player.id === me ? 'You' : 'Opponent';
        const filled = Math.min(Math.max(player.points, 0), victoryScore);
        return (
          <li
            key={player.id}
            aria-label={`${label}: ${filled} of ${victoryScore} points`}
            className="flex items-center justify-between gap-3 rounded-lg bg-slate-900 px-3 py-2"
          >
            <span className="text-sm font-medium text-slate-200">{label}</span>
            <div className="flex items-center gap-3">
              <Pips filled={filled} total={victoryScore} />
              <span className="w-12 text-right text-sm tabular-nums text-slate-400">
                {filled}/{victoryScore}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
