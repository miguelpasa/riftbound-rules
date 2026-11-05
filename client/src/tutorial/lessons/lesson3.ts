import { gates } from '../gates';
import type { LessonDef, StepCtx } from '../types';

/**
 * Lesson 3: Zones and Movement (Core Rules 107, 143-144, 190, 345-348, 447-455).
 *
 * Board: the learner (p0, turn player) has a ready Cinder Grunt in the Base and two runes; Hollow Wisp
 * is in hand. Nothing is controlled and the opponent has no units, so a move to a Battlefield opens
 * a Showdown that nobody can contest and the learner Conquers it.
 */

const GRUNT = 'fx-grunt';
const WISP = 'fx-wisp';

interface MoveLike {
  type: string;
  unitIds?: string[];
  destination?: { kind: string; battlefieldId?: string };
}

/** Is `intent` a STANDARD_MOVE of exactly `units` to battlefield index `i`? */
const isMoveTo = (ctx: StepCtx, intent: unknown, i: number, units: string[]): boolean => {
  const m = intent as MoveLike;
  return (
    units.length > 0 &&
    m.type === 'STANDARD_MOVE' &&
    m.destination?.kind === 'battlefield' &&
    m.destination.battlefieldId === ctx.battlefield(i).id &&
    m.unitIds?.length === units.length &&
    units.every((u) => m.unitIds?.includes(u))
  );
};

export const LESSON_3: LessonDef = {
  id: 'lesson3-zones-movement',
  title: 'Zones and Movement',
  summary:
    'Base, battlefields, and how units move between them: exhaustion, Showdowns and Conquer.',
  concept: [
    'You have a **Base**: your units, gear and channeled runes live there. The board also has two **Battlefields** in the middle, which both players fight over.',
    'A unit enters play **exhausted**, so it cannot move that turn. A **Standard Move** costs exhausting the unit. You may only make one in your **Main Phase**, with nothing on the Chain and no Showdown happening.',
    'The legal moves are **Base to Battlefield** and **Battlefield back to your Base**. Going directly from one Battlefield to another needs the **Ganking** keyword.',
    'Moving a unit onto a Battlefield you do not control makes it **Contested**. If nobody opposes you there, a **Showdown** opens: players alternate playing Action or Reaction cards, and if everyone passes you take **Control** and **Conquer** it for 1 point (once per Battlefield per turn).',
  ],
  setup: ({ sb, you, opp }) => {
    sb.clearHand(you).clearHand(opp);
    sb.giveRunes(you, 2, 'Fury');
    sb.putInHand(you, WISP);
    sb.putUnit(you, GRUNT, 'base', { ready: true });
    sb.setPoints(you, 0).setPoints(opp, 0);
    for (const bf of sb.state.battlefields) {
      sb.setBattlefield(bf.id, { controller: null, contestedBy: null, scoredThisTurnBy: [] });
    }
  },
  steps: [
    {
      id: 'zones',
      title: 'Base and Battlefields',
      instruction:
        'Your **Base** holds a ready **Cinder Grunt**. Above it are the two **Battlefields**, currently controlled by nobody.\n\nUnits move between these places. Read the idea box, then press **Continue**.',
      highlight: ['base', 'battlefield:0', 'battlefield:1'],
      gate: gates.none('read the board, then press Continue.'),
    },
    {
      id: 'play-wisp',
      title: 'New units enter exhausted',
      instruction:
        'Play **Hollow Wisp** from your hand to your Base. It costs 1 Energy. If it stays on the Chain, press **Pass** until it resolves.',
      highlight: ['hand-card:fx-wisp', 'base'],
      gate: gates.playCard(WISP, 'play Hollow Wisp from your hand.', ['PASS_PRIORITY']),
      onSkip: (ctx) => {
        if (ctx.unitsInPlay(WISP).length === 0) {
          ctx.surgery.putUnit(ctx.seat, WISP, 'base', { ready: false });
        }
      },
      hint: 'Click Hollow Wisp, then choose your Base as the place to play it.',
      done: (ctx) => ctx.unitsInPlay(WISP).length > 0 && ctx.state.flow.chain.length === 0,
      explain:
        'The Wisp is in your Base, but a unit enters play **exhausted** (turned sideways). Exhausted units cannot pay the cost of a move.',
    },
    {
      id: 'exhausted',
      title: 'Exhausted units cannot move',
      instruction:
        'Try it: select the exhausted **Hollow Wisp** in your Base and move it to **Battlefield 1**. The engine will refuse.',
      highlight: ['unit:fx-wisp', 'battlefield:0'],
      gate: gates.custom(
        (intent, ctx) =>
          intent.type === 'STANDARD_MOVE' &&
          intent.unitIds.some((u) => ctx.unitsInPlay(WISP).includes(u)),
        'try to move Hollow Wisp.',
      ),
      onEnter: (ctx) => {
        const id = ctx.unitsInPlay(WISP)[0];
        if (id) ctx.surgery.setReady(id, false);
        else ctx.surgery.putUnit(ctx.seat, WISP, 'base', { ready: false });
      },
      expectError: { code: 'UNIT_EXHAUSTED' },
      hint: 'Click the Wisp in your Base to select it, then click Battlefield 1.',
      explain:
        'Moving costs exhausting the unit (Rule 144.2), and a unit that is already exhausted cannot pay that cost. It would be ready again on your next turn.',
    },
    {
      id: 'move',
      title: 'Move a ready unit',
      instruction:
        '**Cinder Grunt** is ready. Select it in your Base and move it to **Battlefield 1**.',
      highlight: ['base', 'battlefield:0', 'unit:fx-grunt'],
      gate: gates.custom(
        (intent, ctx) => isMoveTo(ctx, intent, 0, ctx.unitsInPlay(GRUNT).slice(0, 1)),
        'move Cinder Grunt from your Base to Battlefield 1.',
      ),
      onEnter: (ctx) => {
        if (ctx.unitsInPlay(GRUNT).length === 0) {
          ctx.surgery.putUnit(ctx.seat, GRUNT, 'base', { ready: true });
        }
      },
      onSkip: (ctx) => {
        // Leave the board as if the Grunt had moved, been unopposed and Conquered.
        const bf = ctx.battlefield(0).id;
        ctx.surgery.putUnit(ctx.seat, 'fx-archer', bf, { control: true, ready: false });
        ctx.surgery.setPoints(ctx.seat, 1).setBattlefield(bf, { scoredThisTurnBy: [ctx.seat] });
      },
      hint: 'Click Cinder Grunt in your Base to select it, then click Battlefield 1.',
      done: (ctx) => ctx.unitsAt(0, 'you').some((u) => ctx.state.objects[u]!.cardId === GRUNT),
      explain:
        'The Grunt moved and exhausted itself as the cost. Because you did not control that Battlefield, it became **Contested** by you.',
    },
    {
      id: 'showdown',
      title: 'Showdown and Conquer',
      instruction:
        'Nobody opposes you at Battlefield 1, so a **Showdown** opened. You and your opponent may each play Action or Reaction cards; neither has any, so just press **Pass**. When everyone has passed, you take Control and **Conquer**.',
      highlight: ['battlefield:0', 'btn-pass', 'score'],
      gate: gates.types(['PASS_PRIORITY'], 'press Pass to let the Showdown resolve.'),
      done: (ctx) => ctx.points('you') >= 1 && ctx.state.flow.showdown === undefined,
      explain:
        'You Conquered Battlefield 1 and scored **1 point**. You can only score each Battlefield once per turn, and you now control it.',
    },
    {
      id: 'no-ganking',
      title: 'Battlefield to Battlefield',
      instruction:
        'The Grunt is ready again (as it would be next turn). Try moving it straight from **Battlefield 1** to **Battlefield 2**. Only a unit with **Ganking** may do that.',
      highlight: ['unit:fx-grunt', 'battlefield:0', 'battlefield:1'],
      gate: gates.custom(
        (intent, ctx) => isMoveTo(ctx, intent, 1, ctx.unitsAt(0, 'you').slice(0, 1)),
        'try moving the unit from Battlefield 1 to Battlefield 2.',
      ),
      onEnter: (ctx) => {
        const here = ctx.unitsAt(0, 'you');
        if (here.length === 0) {
          ctx.surgery.putUnit(ctx.seat, GRUNT, ctx.battlefield(0).id, {
            control: true,
            ready: true,
          });
        } else {
          for (const u of here) ctx.surgery.setReady(u, true);
        }
      },
      expectError: { code: 'ILLEGAL_MOVE_DESTINATION', messageIncludes: 'lacks Ganking' },
      hint: 'Select the unit on Battlefield 1 and click Battlefield 2. Moving back to your Base would be allowed.',
      explain:
        'Without Ganking a unit must go back to its Base first (Rule 144.4.c). From there it can move to the other Battlefield on a later move.',
    },
    {
      id: 'summary',
      title: 'Summary',
      instruction:
        'Base and Battlefields are the places units live. New units are exhausted. A Standard Move exhausts a ready unit and goes Base to Battlefield or back. Moving onto a Battlefield you do not control makes it Contested; with no opponent there, a Showdown opens and you Conquer for 1 point. Press **Continue** to finish.',
      highlight: ['base', 'battlefield:0', 'battlefield:1', 'score'],
      gate: gates.none('press Continue to finish.'),
    },
  ],
  completionText:
    'You played a unit (which entered exhausted), met the refusal for moving an exhausted unit, moved a ready unit to a Battlefield, won the Showdown and Conquered for a point, and learned why Battlefield to Battlefield needs Ganking.',
};
