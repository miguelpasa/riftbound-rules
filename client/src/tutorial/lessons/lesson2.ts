import type { Domain } from '@riftbound/engine';
import { gates } from '../gates';
import type { LessonDef, StepCtx } from '../types';

/**
 * Lesson 2: Resources (Core Rules 161-168, 164.2, 356-357).
 *
 * Board: seven runes (6 Fury + 1 Calm) and a Dune Titan in hand. The Titan costs 5 Energy plus
 * 1 Calm Power, so the learner must use BOTH rune abilities: Exhaust (Energy) and Recycle (Power).
 */
const TITAN = 'fx-titan';
const FURY_RUNES = 6;
const NEED_ENERGY = 5;

const runeDomain = (ctx: StepCtx, runeId: string): string | undefined => {
  const o = ctx.state.objects[runeId];
  return o ? ctx.cards[o.cardId]?.domains[0] : undefined;
};

const pool = (ctx: StepCtx) => ctx.state.players[ctx.seat === 'p0' ? 0 : 1].runePool;

/** Runes of a domain currently in the learner's base. */
const runesOf = (ctx: StepCtx, domain: Domain): string[] =>
  ctx.state.players[ctx.seat === 'p0' ? 0 : 1].base.filter(
    (id) =>
      ctx.cards[ctx.state.objects[id]!.cardId]?.type === 'RUNE' && runeDomain(ctx, id) === domain,
  );

/**
 * Put the runes and Rune Pool where they would be after the learner exhausted `exhausted` Fury
 * runes and (optionally) recycled the Calm rune. Used by onSkip so later steps never depend on
 * earlier ones having really happened.
 */
function shape(ctx: StepCtx, exhausted: number, calmRecycled: boolean): void {
  const domains: Domain[] = [
    ...(calmRecycled ? [] : (['Calm'] as Domain[])),
    ...Array<Domain>(FURY_RUNES).fill('Fury'),
  ];
  ctx.surgery.setRunes(ctx.seat, domains);
  runesOf(ctx, 'Fury')
    .slice(0, exhausted)
    .forEach((id) => ctx.surgery.setReady(id, false));
  ctx.surgery.setPool(ctx.seat, exhausted, calmRecycled ? { Calm: 1 } : {});
}

/** ACTIVATE_RUNE gate: one mode, one domain, optionally capped by Energy already in the pool. */
const runeGate = (mode: 'EXHAUST' | 'RECYCLE', domain: Domain, message: string, maxEnergy = 99) =>
  gates.custom(
    (i, ctx) =>
      i.type === 'ACTIVATE_RUNE' &&
      i.mode === mode &&
      runeDomain(ctx, i.runeId) === domain &&
      pool(ctx).energy < maxEnergy,
    message,
  );

export const LESSON_2: LessonDef = {
  id: 'lesson2-resources',
  title: 'Resources: Energy and Power',
  summary: 'How runes become Energy and Power, and how the cost of a card is paid.',
  concept: [
    '**Runes** are not cards in your deck. You **channel** them from your Rune Deck onto the board. Each rune has two abilities.',
    "**Exhaust** the rune: add 1 **Energy** to your Rune Pool. **Recycle** the rune (it goes to the bottom of your Rune Deck): add 1 **Power** of that rune's Domain.",
    "**Energy** pays the number in a card's cost. **Power** pays the Domain symbols, and it must match the Domain. Spend what you make: the Rune Pool **empties** at the start of your Main Phase and at the end of the turn.",
  ],
  setup: ({ sb, you, kit }) => {
    sb.setRunes(you, ['Calm', ...Array<Domain>(FURY_RUNES).fill('Fury')]);
    sb.setPool(you, 0);
    sb.clearHand(you);
    sb.putInHand(you, kit.you.titan);
  },
  steps: [
    {
      id: 'read',
      title: 'Your runes and the Dune Titan',
      instruction:
        'You have seven runes in play (six **Fury**, one **Calm**) and a **Dune Titan** in hand. The Titan costs **5 Energy** and **1 Calm Power**.\n\nOpen the **Resources** panel: that is where you will work. Press **Continue** when ready.',
      highlight: ['rune-panel', 'hand-card:fx-titan'],
      gate: gates.none('read the cards, then press Continue.'),
    },
    {
      id: 'exhaust-one',
      title: 'Exhaust a rune for Energy',
      instruction:
        'In the **Resources** panel click a **Fury** rune and choose **Exhaust for 1 Energy**. Watch your **Rune Pool** gain 1 Energy.',
      highlight: ['rune-panel'],
      gate: runeGate('EXHAUST', 'Fury', 'exhaust a Fury rune in the Resources panel.', NEED_ENERGY),
      hint: 'Click one of the Fury runes, then use the Exhaust button that appears.',
      onSkip: (ctx) => shape(ctx, 1, false),
      done: (ctx) => pool(ctx).energy >= 1,
      explain:
        'An exhausted rune is turned sideways and gives 1 Energy. It stays on the board and **readies again in your next Awaken Phase**.',
    },
    {
      id: 'exhaust-more',
      title: 'Fill the Energy',
      instruction:
        'The Titan costs 5 Energy. Exhaust more **Fury** runes until your Rune Pool shows **5 Energy**.',
      highlight: ['rune-panel'],
      gate: runeGate('EXHAUST', 'Fury', 'exhaust Fury runes until you have 5 Energy.', NEED_ENERGY),
      hint: 'Keep your Calm rune untouched: you will need it for the Power.',
      onSkip: (ctx) => shape(ctx, NEED_ENERGY, false),
      done: (ctx) => pool(ctx).energy >= NEED_ENERGY,
    },
    {
      id: 'mistake',
      title: 'Energy is not enough',
      instruction:
        'You have the Energy, but the Titan also wants **Calm Power**. Click **Dune Titan** anyway and read what the engine says.',
      highlight: ['hand-card:fx-titan', 'rune-panel'],
      // Only an unpaid attempt is allowed, so the board cannot quietly recycle the Calm rune for you.
      gate: gates.custom(
        (i, ctx) =>
          i.type === 'PLAY_CARD' &&
          i.payment.length === 0 &&
          ctx.state.objects[i.cardInstanceId]?.cardId === TITAN,
        'click Dune Titan to see why it cannot be played yet.',
      ),
      onSkip: (ctx) => shape(ctx, NEED_ENERGY, false),
      expectError: { code: 'INSUFFICIENT_RESOURCES', messageIncludes: 'Power' },
      hint: 'Click Dune Titan in your hand.',
      explain:
        'Energy only pays the number. The Calm symbol must be paid with **Calm Power**, and no other Domain or Energy can stand in for it.',
    },
    {
      id: 'recycle',
      title: 'Recycle a rune for Power',
      instruction:
        'Click your **Calm** rune and choose **Recycle for 1 Calm Power**. The rune goes to the bottom of your Rune Deck and leaves the board.',
      highlight: ['rune-panel'],
      gate: runeGate('RECYCLE', 'Calm', 'recycle the Calm rune in the Resources panel.'),
      hint: 'Only the Calm rune makes Calm Power.',
      onSkip: (ctx) => shape(ctx, NEED_ENERGY, true),
      done: (ctx) => (pool(ctx).power.Calm ?? 0) >= 1,
      explain:
        'Recycling is the price for Power: the rune is gone from the board until you channel it again. Exhausting costs you nothing permanent, so keep that in mind.',
    },
    {
      id: 'play',
      title: 'Play the Titan from the pool',
      instruction:
        'Your Rune Pool now holds **5 Energy** and **1 Calm Power**: exactly the cost. Click **Dune Titan**, choose your base, then pass priority until it resolves.',
      highlight: ['hand-card:fx-titan', 'rune-panel'],
      gate: gates.custom(
        (i, ctx) =>
          i.type === 'PASS_PRIORITY' ||
          (i.type === 'PLAY_CARD' &&
            i.payment.length === 0 &&
            ctx.state.objects[i.cardInstanceId]?.cardId === TITAN),
        'play Dune Titan using the resources already in your pool.',
      ),
      onSkip: (ctx) => {
        shape(ctx, NEED_ENERGY, true);
        ctx.surgery.setPool(ctx.seat, 0);
        ctx.surgery.putUnit(ctx.seat, TITAN, 'base');
      },
      hint: 'If the Titan sits on the chain, press Pass: your opponent passes back and it resolves.',
      done: (ctx) => ctx.unitsInPlay(TITAN).length > 0,
      explain:
        'Playing a card spends from the Rune Pool first. Normally the board exhausts and recycles runes for you, but now you know what it is doing.',
    },
    {
      id: 'pool-empties',
      title: 'Unspent resources vanish',
      instruction:
        'You have one ready Fury rune left. **Exhaust** it for 1 Energy, then press **End turn** with that Energy unspent.',
      highlight: ['rune-panel', 'btn-end-turn'],
      gate: gates.custom((i, ctx) => {
        if (i.type === 'ACTIVATE_RUNE') {
          return i.mode === 'EXHAUST' && runeDomain(ctx, i.runeId) === 'Fury';
        }
        return i.type === 'END_TURN' && pool(ctx).energy > 0;
      }, 'exhaust the spare Fury rune first, then press End turn.'),
      onSkip: (ctx) => ctx.surgery.setPool(ctx.seat, 0),
      done: (ctx) => ctx.state.turn.activePlayer !== ctx.seat,
      explain:
        'Your Rune Pool is empty again: the unspent Energy was lost when the turn ended. Make resources the turn you spend them.',
    },
  ],
  completionText:
    'You exhausted runes for Energy, recycled one for Power, paid a Dune Titan from your Rune Pool, and saw the pool empty at the end of the turn.',
};
