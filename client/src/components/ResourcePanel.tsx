import { useState } from 'react';
import { DOMAINS, opponentOf, playerIndex } from '@riftbound/engine';
import type {
  CardDatabase,
  CardInstance,
  ClientGameState,
  Domain,
  PlayerId,
  RunePool,
} from '@riftbound/engine';
import { useGame } from '../app/gameApi';
import { COLORLESS, domainColor } from './cardStyles';
import { useIntentSender } from './useIntentSender';
import { visibleObject } from './viewObjects';

export const RESOURCE_HELP =
  'Energy pays the number; Power pays the domain symbols. Exhaust a rune for Energy, recycle it (it returns to the bottom of your rune deck) for Power.';

interface RuneView {
  id: string;
  ready: boolean;
  domain: Domain | null;
}

/** Runes (type RUNE) in `player`'s base that they control, in base order. */
function runesOf(view: ClientGameState, cards: CardDatabase, player: PlayerId): RuneView[] {
  const out: RuneView[] = [];
  for (const id of view.players[playerIndex(player)].base) {
    const o: CardInstance | undefined = visibleObject(view, id);
    const def = o && cards[o.cardId];
    if (!o || !def || def.type !== 'RUNE' || o.controller !== player) continue;
    out.push({ id, ready: o.ready, domain: def.domains[0] ?? null });
  }
  return out;
}

function PoolDisplay({ pool, label }: { pool: RunePool; label: string }) {
  const power = DOMAINS.filter((d) => (pool.power[d] ?? 0) > 0);
  return (
    <div aria-label={label} className="flex flex-wrap items-center gap-1.5 text-xs">
      <span
        data-testid="pool-energy"
        title="Energy in the Rune Pool: pays the number on a card's cost."
        className="rounded-md border border-slate-500 bg-slate-800 px-2 py-0.5 font-semibold"
      >
        {`Energy ${pool.energy}`}
      </span>
      {power.length === 0 ? (
        <span data-testid="pool-power-none" className="text-slate-500">
          No Power
        </span>
      ) : (
        power.map((d) => (
          <span
            key={d}
            data-testid={`pool-power-${d}`}
            title={`${d} Power in the Rune Pool: pays ${d} domain symbols.`}
            className="rounded-md border px-2 py-0.5 font-semibold"
            style={{ borderColor: domainColor(d).base, color: domainColor(d).base }}
          >
            {`${d} ${pool.power[d]}`}
          </span>
        ))
      )}
    </div>
  );
}

function RuneChip({
  rune,
  selected,
  disabled,
  onClick,
}: {
  rune: RuneView;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const color = rune.domain ? domainColor(rune.domain) : COLORLESS;
  const label = `${color.label} rune, ${rune.ready ? 'ready' : 'exhausted'}`;
  return (
    <button
      type="button"
      data-rune-id={rune.id}
      aria-label={label}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      title={label}
      style={{ borderColor: color.base, background: rune.ready ? color.dark : '#0f131c' }}
      className={`h-12 w-9 rounded-md border-2 text-[10px] font-bold transition ${rune.ready ? 'opacity-100' : 'opacity-45'} ${selected ? 'ring-2 ring-amber-300' : ''} enabled:hover:brightness-125 disabled:cursor-not-allowed`}
    >
      <span style={{ color: color.base }}>{color.label.slice(0, 2)}</span>
    </button>
  );
}

/**
 * My runes (click one to exhaust it for Energy or recycle it for Power), the Rune Pool, the rune
 * deck counts and the opponent's runes (read only). Reads useGame().
 */
export function ResourcePanel() {
  const api = useGame();
  const { view, cards, seat } = api;
  const { send, pending, error, clearError } = useIntentSender();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const opp = opponentOf(seat);
  const me = view.players[playerIndex(seat)];
  const them = view.players[playerIndex(opp)];
  const mine = runesOf(view, cards, seat);
  const theirs = runesOf(view, cards, opp);
  const selected = mine.find((r) => r.id === selectedId) ?? null;
  const locked = view.turn.phase === 'MULLIGAN' || api.gameOver !== null;

  const activate = async (rune: RuneView, mode: 'EXHAUST' | 'RECYCLE'): Promise<void> => {
    const ok = await send({ type: 'ACTIVATE_RUNE', playerId: seat, runeId: rune.id, mode });
    if (ok) setSelectedId(null);
  };

  const domainName = selected?.domain ?? 'colorless';

  return (
    <section
      aria-label="Resources"
      className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-sm text-slate-100"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Your runes</h2>
        <details className="text-xs text-slate-400">
          <summary
            title={RESOURCE_HELP}
            className="cursor-pointer select-none rounded px-1 hover:text-slate-200"
          >
            How do runes work?
          </summary>
          <p className="mt-1 max-w-64 text-slate-300">{RESOURCE_HELP}</p>
        </details>
      </div>

      <PoolDisplay pool={me.runePool} label="Your Rune Pool" />

      {mine.length === 0 ? (
        <p className="text-xs text-slate-500">You have no runes in play.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Your runes in play">
          {mine.map((r) => (
            <RuneChip
              key={r.id}
              rune={r}
              selected={r.id === selected?.id}
              disabled={locked || pending}
              onClick={() => {
                clearError();
                setSelectedId((cur) => (cur === r.id ? null : r.id));
              }}
            />
          ))}
        </div>
      )}

      {selected && !locked && (
        <div className="flex flex-col gap-1.5 rounded-md border border-slate-700 bg-slate-800/60 p-2">
          <button
            type="button"
            disabled={!selected.ready || pending}
            onClick={() => void activate(selected, 'EXHAUST')}
            title="Exhaust this rune: add 1 Energy to your Rune Pool."
            className="rounded border border-slate-500 px-2 py-1 text-left text-xs hover:bg-slate-700 disabled:opacity-40"
          >
            Exhaust for 1 Energy
          </button>
          <button
            type="button"
            disabled={!selected.domain || pending}
            onClick={() => void activate(selected, 'RECYCLE')}
            title="Recycle this rune: it returns to the bottom of your rune deck and adds 1 Power of its domain."
            className="rounded border border-slate-500 px-2 py-1 text-left text-xs hover:bg-slate-700 disabled:opacity-40"
          >
            {`Recycle for 1 ${domainName} Power`}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded border border-rose-700 bg-rose-950 p-2 text-xs">
          {error}
        </p>
      )}

      <p className="text-xs text-slate-400">
        Playing a card pays for it automatically; activate runes by hand only when you want to
        choose how it is paid.
      </p>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-300">
        <dt>Your rune deck</dt>
        <dd data-testid="my-rune-deck" className="text-right tabular-nums">
          {me.runeDeckCount}
        </dd>
        <dt>Opponent rune deck</dt>
        <dd data-testid="opp-rune-deck" className="text-right tabular-nums">
          {them.runeDeckCount}
        </dd>
      </dl>

      <div
        aria-label="Opponent runes"
        className="flex flex-col gap-1.5 border-t border-slate-800 pt-2"
      >
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-300">Opponent runes</span>
          <span data-testid="opp-rune-count" className="text-slate-400">
            {`${theirs.filter((r) => r.ready).length} ready / ${theirs.length}`}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {theirs.map((r) => (
            <RuneChip key={r.id} rune={r} disabled />
          ))}
        </div>
        <PoolDisplay pool={them.runePool} label="Opponent Rune Pool" />
      </div>
    </section>
  );
}
