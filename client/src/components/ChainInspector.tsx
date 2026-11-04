import { useEffect, useMemo, useState } from 'react';
import type { ChainItem, Intent, PlayCardIntent, PlayerId, Target } from '@riftbound/engine';
import { useGame } from '../app/gameApi';
import { useGameStore } from '../store/gameStore';
import { useIntentSender } from './useIntentSender';
import { battlefieldName, defOf, nameOf, visibleObject } from './viewObjects';

const STATE_TOOLTIPS = {
  'NEUTRAL-true':
    'Neutral Open: no Showdown and an empty Chain. The turn player may take any action their timing allows (Rules 307-310).',
  'NEUTRAL-false':
    'Neutral Closed: a Chain is being resolved outside a Showdown. Only Reactions may be played until it empties (Rule 309.1.a).',
  'SHOWDOWN-true':
    'Showdown Open: a Showdown is running and the Chain is empty. Players with Focus may play Actions and Reactions or pass (Rule 308).',
  'SHOWDOWN-false':
    'Showdown Closed: a Showdown is running and the Chain is not empty. Only Reactions may be played until the Chain resolves (Rules 309-310).',
} as const;

const who = (p: PlayerId | null | undefined, seat: PlayerId): string | null =>
  p == null ? null : p === seat ? 'You' : 'Opponent';

function Holder({
  label,
  holder,
  seat,
  tooltip,
}: {
  label: string;
  holder: PlayerId | null;
  seat: PlayerId;
  tooltip: string;
}) {
  const name = who(holder, seat);
  const tone =
    holder === null
      ? 'border-slate-700 text-slate-500'
      : holder === seat
        ? 'border-amber-300 bg-amber-300/15 font-semibold text-amber-200'
        : 'border-rose-500 bg-rose-500/10 font-semibold text-rose-200';
  return (
    <span
      title={tooltip}
      data-testid={`holder-${label.toLowerCase()}`}
      className={`rounded-md border px-2 py-0.5 text-xs ${tone}`}
    >
      {`${label}: ${name ?? 'nobody'}`}
    </span>
  );
}

/** Whole seconds remaining until `deadline` (ms epoch), ticking once per second. */
function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <span
      data-testid="chain-countdown"
      className={`rounded-md border px-2 py-0.5 text-xs tabular-nums ${left <= 10 ? 'border-rose-500 text-rose-200' : 'border-slate-600 text-slate-300'}`}
    >
      {`${left}s`}
    </span>
  );
}

function describeTarget(
  t: Target,
  describe: { object: (id: string) => string; bf: (id: string) => string; seat: PlayerId },
): string {
  switch (t.kind) {
    case 'object':
      return describe.object(t.id);
    case 'player':
      return t.playerId === describe.seat ? 'you' : 'opponent';
    case 'battlefield':
      return describe.bf(t.battlefieldId);
  }
}

/**
 * The Chain (newest first), turn state, who holds Priority and Focus, a Pass button and the
 * Reactions that can be played now. Reads useGame(). Optional store field `deadline` (ms epoch)
 * shows a countdown; it is ignored when absent.
 */
export function ChainInspector() {
  const api = useGame();
  const { view, cards, seat, legal } = api;
  const { send, pending, error } = useIntentSender();
  // The turn-timer integration is not here yet; honour a `deadline` field if the store gains one.
  const deadline = useGameStore((s) => (s as { deadline?: number }).deadline);

  const { flow, turnState } = view;
  const chain = useMemo(() => [...flow.chain].reverse(), [flow.chain]);
  const showdown = flow.showdown;

  const pass = legal.find((i) => i.type === 'PASS_PRIORITY');
  const passLabel = flow.chain.length > 0 ? 'Pass (resolve)' : showdown ? 'Pass focus' : 'Pass';

  const reactions = useMemo(() => {
    // One entry per distinct card (copies in hand are grouped); the first legal intent is sent.
    const byCard = new Map<string, { intent: PlayCardIntent; name: string; count: number }>();
    const seenInstances = new Set<string>();
    for (const i of legal) {
      if (i.type !== 'PLAY_CARD' || seenInstances.has(i.cardInstanceId)) continue;
      const def = defOf(view, cards, i.cardInstanceId);
      if (!def?.keywords.some((k) => k.name === 'Reaction')) continue;
      seenInstances.add(i.cardInstanceId);
      const entry = byCard.get(def.cardId);
      if (entry) entry.count += 1;
      else byCard.set(def.cardId, { intent: i, name: def.name, count: 1 });
    }
    return [...byCard.values()];
  }, [legal, view, cards]);

  const describe = {
    object: (id: string) => nameOf(view, cards, id),
    bf: (id: string) => battlefieldName(view, cards, id),
    seat,
  };

  const itemTitle = (item: ChainItem): string => {
    const name = nameOf(view, cards, item.sourceObjectId);
    if (item.kind === 'ABILITY') return `${name} (ability)`;
    return visibleObject(view, item.sourceObjectId) ? name : 'Unknown card';
  };

  const sendIntent = (intent: Intent): void => {
    void send(intent);
  };

  return (
    <section
      aria-label="Chain"
      className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900/80 p-3 text-sm text-slate-100"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          tabIndex={0}
          title={STATE_TOOLTIPS[`${turnState.kind}-${turnState.open}`]}
          data-testid="turn-state"
          className="rounded-md border border-slate-500 bg-slate-800 px-2 py-0.5 text-xs font-semibold"
        >
          {`${turnState.kind === 'NEUTRAL' ? 'Neutral' : 'Showdown'} ${turnState.open ? 'Open' : 'Closed'}`}
        </span>
        <Holder
          label="Priority"
          holder={flow.priority}
          seat={seat}
          tooltip="Priority: the player who may act (play a card or pass) right now (Rule 310)."
        />
        <Holder
          label="Focus"
          holder={flow.focus}
          seat={seat}
          tooltip="Focus: the player who controls the pace of a Showdown. Focus passes when the Chain resolves (Rule 310)."
        />
        {typeof deadline === 'number' && <Countdown deadline={deadline} />}
      </div>

      {showdown && (
        <p data-testid="chain-showdown" className="text-xs text-amber-200">
          {`Showdown at ${battlefieldName(view, cards, showdown.battlefieldId)}`}
        </p>
      )}

      {chain.length === 0 ? (
        <p className="text-slate-500">Chain empty</p>
      ) : (
        <ol aria-label="Chain items, newest first" className="flex flex-col gap-1.5">
          {chain.map((item, index) => (
            <li
              key={item.id}
              data-chain-item={item.id}
              className="flex flex-col gap-0.5 rounded-md border border-slate-700 bg-slate-800/70 px-2.5 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold">{itemTitle(item)}</span>
                {index === 0 && <span className="text-[10px] uppercase text-slate-400">top</span>}
                <span
                  className={`rounded border px-1.5 text-[10px] font-semibold ${item.controller === seat ? 'border-amber-300 text-amber-200' : 'border-rose-500 text-rose-200'}`}
                >
                  {item.controller === seat ? 'You' : 'Opponent'}
                </span>
                <span
                  title={
                    item.status === 'PENDING'
                      ? 'Still being played: costs not yet paid (Rule 328).'
                      : 'Costs paid; it will resolve when both players pass.'
                  }
                  className="rounded border border-slate-600 px-1.5 text-[10px] text-slate-300"
                >
                  {item.status}
                </span>
                {item.unimplementedEffect && (
                  <span
                    title="This card's rules text is not executed in this version; it resolves with no effect."
                    className="rounded border border-orange-500 bg-orange-500/10 px-1.5 text-[10px] text-orange-200"
                  >
                    effect not implemented
                  </span>
                )}
              </div>
              {item.targets.length > 0 && (
                <span className="text-xs text-slate-400">
                  {`Targets: ${item.targets.map((t) => describeTarget(t, describe)).join(', ')}`}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {pass && (
        <button
          type="button"
          disabled={pending}
          onClick={() => sendIntent(pass)}
          className="self-start rounded-md bg-amber-400 px-4 py-1.5 font-semibold text-slate-900 hover:bg-amber-300 disabled:opacity-50"
        >
          {passLabel}
        </button>
      )}

      {reactions.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase text-slate-400">
            Reactions you can play now
          </h3>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {reactions.map((r) => (
              <li key={r.intent.cardInstanceId}>
                <button
                  type="button"
                  disabled={pending}
                  data-card-instance={r.intent.cardInstanceId}
                  aria-label={r.name}
                  onClick={() => sendIntent(r.intent)}
                  className="rounded-md border border-sky-500/70 px-2 py-1 text-xs text-sky-100 hover:bg-sky-500/20 disabled:opacity-50"
                >
                  {r.name}
                  {r.count > 1 && <span className="ml-1 text-sky-300">{`x${r.count}`}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded border border-rose-700 bg-rose-950 p-2 text-xs">
          {error}
        </p>
      )}
    </section>
  );
}
