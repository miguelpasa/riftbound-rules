import { vi } from 'vitest';
import { reduce, sanitizeFor } from '@riftbound/engine';
import type { GameEvent, Intent, PlayerId, RuleError } from '@riftbound/engine';
import type { Scenario } from '../../../../engine/src/testing/scenario.js';
import type { GameApi } from '../../app/gameApi';
import { getUiLegalActions } from '../../host/uiLegal';

export interface FakeApi extends GameApi {
  send: ReturnType<typeof vi.fn<(intent: Intent) => Promise<{ ok: true } | RuleError>>>;
}

/**
 * A GameApi built from a REAL engine state: sanitised view, real legal actions. `send` is a spy
 * that validates the intent with the real reducer (without applying it) and resolves ok or with
 * the engine's RuleError; pass `sendResult` to force a result instead.
 */
export function fakeApi(
  sc: Scenario,
  seat: PlayerId,
  opts: { events?: GameEvent[]; sendResult?: { ok: true } | RuleError } = {},
): FakeApi {
  const state = sc.state;
  const send = vi.fn(async (intent: Intent): Promise<{ ok: true } | RuleError> => {
    if (opts.sendResult) return opts.sendResult;
    const r = reduce(state, sc.cards, intent);
    return r.ok ? { ok: true } : r;
  });
  return {
    cards: sc.cards,
    seat,
    view: sanitizeFor(state, seat),
    legal: getUiLegalActions(state, sc.cards, seat),
    recentEvents: opts.events ?? [],
    connection: 'connected',
    opponentConnected: true,
    gameOver: null,
    send,
  };
}
