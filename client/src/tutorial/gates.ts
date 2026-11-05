/**
 * Ready-made gates for `StepDef.gate`. All return a GateRule; `blockedMessage` becomes "Not yet: <message>".
 *
 *   gate: gates.none('Read the card text, then press Continue.')
 *   gate: gates.types(['PASS_PRIORITY'], 'Pass priority with the highlighted button.')
 *   gate: gates.playCard('fx-grunt', 'Play Cinder Grunt from your hand.')
 *   gate: gates.and(gates.types(['PLAY_CARD', 'STANDARD_MOVE']), gates.custom(...))
 */
import type { Intent } from '@riftbound/engine';
import type { GateRule, StepCtx } from './types';

type IntentType = Intent['type'];

/** Nothing the learner sends is accepted (use for read-only steps). */
export const none = (blockedMessage?: string): GateRule => ({
  allow: () => false,
  ...(blockedMessage ? { blockedMessage } : {}),
});

/** Only these intent types. */
export const types = (allowed: IntentType[], blockedMessage?: string): GateRule => ({
  allow: (i) => allowed.includes(i.type),
  ...(blockedMessage ? { blockedMessage } : {}),
});

/** Everything except these intent types (e.g. forbid END_TURN while teaching something else). */
export const except = (blocked: IntentType[], blockedMessage?: string): GateRule => ({
  allow: (i) => !blocked.includes(i.type),
  ...(blockedMessage ? { blockedMessage } : {}),
});

/** Only PLAY_CARD of a card with this definition id (or one of these), plus optionally other types. */
export const playCard = (
  cardId: string | string[],
  blockedMessage?: string,
  alsoAllow: IntentType[] = [],
): GateRule => {
  const ids = Array.isArray(cardId) ? cardId : [cardId];
  return {
    allow: (i, ctx) =>
      alsoAllow.includes(i.type) ||
      (i.type === 'PLAY_CARD' && ids.includes(ctx.state.objects[i.cardInstanceId]?.cardId ?? '')),
    ...(blockedMessage ? { blockedMessage } : {}),
  };
};

/** Arbitrary predicate. */
export const custom = (
  allow: (intent: Intent, ctx: StepCtx) => boolean,
  blockedMessage?: string,
): GateRule => ({ allow, ...(blockedMessage ? { blockedMessage } : {}) });

/** Both gates must allow; the first one's message is used when blocked. */
export const and = (a: GateRule, b: GateRule): GateRule => ({
  allow: (i, ctx) => a.allow(i, ctx) && b.allow(i, ctx),
  ...((a.blockedMessage ?? b.blockedMessage)
    ? { blockedMessage: (a.blockedMessage ?? b.blockedMessage) as string }
    : {}),
});

export const gates = { none, types, except, playCard, custom, and };
