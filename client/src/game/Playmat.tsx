import { BaseRow } from './BaseRow';
import { BattlefieldView } from './BattlefieldView';
import type { BoardUi } from './useBoardUi';

/** Opponent base, the battlefields, and the viewer's base. The hand is rendered by GameScreen below it. */
export function Playmat({ ui }: { ui: BoardUi }) {
  const { view, seat } = ui.api;
  const opp = seat === 'p0' ? 'p1' : 'p0';
  return (
    <div
      className="flex flex-col gap-3"
      onClick={() => {
        if (ui.selected.length > 0) ui.clearSelection();
      }}
    >
      <BaseRow owner={opp} ui={ui} />
      <div aria-label="Battlefields" className="flex flex-col gap-3 md:flex-row">
        {view.battlefields.map((bf) => (
          <BattlefieldView key={bf.id} battlefield={bf} ui={ui} />
        ))}
      </div>
      <BaseRow owner={seat} ui={ui} />
    </div>
  );
}
