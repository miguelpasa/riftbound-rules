import type { GameState, Intent } from '@riftbound/engine';
import { gates } from '../gates';
import type { LessonDef, StepCtx } from '../types';

/**
 * Lesson 6: Victory and the Final Point Rule (Core Rules 193-196, 194.2, 323.1, 470-474, 432).
 *
 * Board: two battlefields (bf0, bf1), two ready Cinder Grunts in the learner's base, the opponent has
 * nothing in play. Flow:
 *   1 two ways to score (read-only)      2 Burn Out aside (read-only)
 *   3 Conquer at 6 -> 7                  4 Conquer at 7 with bf0 unscored this turn -> denied, draw a card
 *   5 rewind to 6, end the turn: Hold bf0 in the Beginning Phase (7)
 *   6 Conquer bf1 having scored every battlefield -> 8 -> win at Cleanup     7 summary
 *
 * Hold is not restricted at 7 points in this version (docs/ASSUMPTIONS.md), which is why step 5 rewinds the
 * score to 6: Holding at 7 would simply win on the spot and would not show the "score everything" route.
 */

const GRUNT = 'fx-grunt';

type Edit = (fn: (s: GameState) => void) => unknown;

/** The learner's Grunts currently in the base, lowest id first. */
function inBase(ctx: StepCtx): string[] {
  return ctx.unitsInPlay(GRUNT).filter((id) => ctx.state.objects[id]!.zone.kind === 'base');
}

/**
 * Move one of the learner's units between the base and a battlefield by surgery (the Sandbox has no
 * public "move" helper). Goes through the sandbox's own edit hook so invariants are checked.
 */
function relocate(ctx: StepCtx, unitId: string, where: 'base' | string): void {
  const edit = (ctx.surgery as unknown as { edit: Edit }).edit.bind(ctx.surgery);
  edit((s) => {
    const o = s.objects[unitId]!;
    const ps = s.players[0]!;
    if (o.zone.kind === 'battlefield') {
      // Leaving a battlefield with no other unit there also drops control (Cleanup 323.5 would).
      const from = o.zone.battlefieldId;
      const others = Object.values(s.objects).some(
        (x) =>
          x.id !== unitId &&
          x.zone.kind === 'battlefield' &&
          x.zone.battlefieldId === from &&
          x.controller === 'p0',
      );
      const bf = s.battlefields.find((b) => b.id === from);
      if (bf && !others && bf.controller === 'p0') bf.controller = null;
    }
    ps.base = ps.base.filter((x) => x !== unitId);
    if (where === 'base') {
      o.zone = { kind: 'base', player: 'p0' };
      ps.base.push(unitId);
    } else {
      o.zone = { kind: 'battlefield', player: 'p0', battlefieldId: where };
    }
    o.controller = 'p0';
    o.ready = true;
  });
}

/** Make sure bf `i` holds one of the learner's units and is controlled by them. */
function ensureHeld(ctx: StepCtx, i: number, scored: boolean): void {
  const bfId = ctx.battlefield(i).id;
  if (ctx.unitsAt(i, 'you').length === 0) {
    const mover = inBase(ctx)[0];
    if (mover) relocate(ctx, mover, bfId);
  }
  ctx.surgery.setBattlefield(bfId, {
    controller: ctx.seat,
    contestedBy: null,
    scoredThisTurnBy: scored ? [ctx.seat] : [],
  });
}

/** Gate: a STANDARD_MOVE of exactly one unit from the base to battlefield `i`, plus PASS_PRIORITY. */
const moveTo = (i: number, blockedMessage: string) =>
  gates.custom((intent: Intent, ctx) => {
    if (intent.type === 'PASS_PRIORITY') return true;
    if (intent.type !== 'STANDARD_MOVE') return false;
    const dest = intent.destination;
    return (
      dest.kind === 'battlefield' &&
      dest.battlefieldId === ctx.state.battlefields[i]?.id &&
      intent.unitIds.length === 1 &&
      intent.unitIds.every((id) => ctx.state.objects[id]?.zone.kind === 'base')
    );
  }, blockedMessage);

export const LESSON_6: LessonDef = {
  id: 'lesson6-victory',
  title: 'Victory and the Final Point Rule',
  summary: 'Scoring points, Hold and Conquer, and the restriction on the final point.',
  concept: [
    'You win by reaching the **Victory Score of 8 points** while having **more points than your opponent**. The game checks this at **Cleanup** (Rules 194.2, 323.1).',
    'Points mostly come from **scoring a battlefield**: **Hold** it (you still control it at your Beginning Phase scoring step) or **Conquer** it (you gain control of it). Each battlefield scores for you **once per turn**, worth 1 point.',
    '**The Final Point Rule (473.1.b):** if you are one point away (7) and would gain the point by **Conquering**, you only get it if you have scored **every** battlefield this turn. Otherwise you **draw a card instead**. The engine does not refuse the move; the point is simply replaced.',
  ],
  setup: ({ sb, you, opp }) => {
    sb.clearHand(you).clearHand(opp);
    sb.giveRunes(you, 2, 'Fury');
    sb.putUnit(you, GRUNT, 'base');
    sb.putUnit(you, GRUNT, 'base');
    sb.setPoints(you, 6);
    sb.setPoints(opp, 0);
  },
  steps: [
    {
      id: 'two-ways',
      title: 'Two ways to score',
      instruction:
        'Look at the **scoreboard**: you have **6 points** and need **8**. There are two battlefields on the board.\n\n**Hold**: control a battlefield when your turn starts and you score it in your Beginning Phase.\n\n**Conquer**: gain control of a battlefield by moving a unit in and winning the Showdown.\n\nPress **Continue**.',
      highlight: ['score', 'battlefield:0', 'battlefield:1'],
      gate: gates.none('read this, then press Continue.'),
    },
    {
      id: 'burn-out',
      title: 'An aside: Burn Out',
      instruction:
        'Not every point comes from battlefields. If a player must draw from an **empty Main Deck**, they **Burn Out**: they recycle their Trash into the deck, shuffle it, and their **opponent gains 1 point** (Rule 432).\n\nPoints from Burn Out are not Conquer points, so the Final Point Rule does not restrict them. This is read-only; we will not simulate it.\n\nPress **Continue**.',
      highlight: ['score'],
      gate: gates.none('read this, then press Continue.'),
    },
    {
      id: 'conquer-normal',
      title: 'Conquer a battlefield',
      instruction:
        'Move one of your **Cinder Grunts** from your base to the **left battlefield**. Nobody else is there, so after the Showdown you **Conquer** it.\n\nPass priority when asked; your opponent passes too.',
      highlight: ['unit:fx-grunt', 'battlefield:0', 'btn-pass'],
      gate: moveTo(0, 'move one Grunt from your base to the left battlefield.'),
      onSkip: (ctx) => {
        ensureHeld(ctx, 0, true);
        ctx.surgery.setPoints(ctx.seat, 7);
      },
      hint: 'Drag a Grunt onto the left battlefield (or click it, then the battlefield). Then press Pass.',
      done: (ctx) => ctx.points() >= 7,
      explain:
        'Conquered: **7 points**. Below 7 points a Conquer always gives its point. Keep an eye on the scoreboard: you are now one point away from winning.',
    },
    {
      id: 'final-point-denied',
      title: 'The final point is denied',
      instruction:
        'Pretend this is a **later turn**: you hold the left battlefield, but you have **not scored it this turn** (as if it were still waiting for its Hold). You are at **7 points**.\n\nMove your other **Cinder Grunt** to the **right battlefield** and Conquer it. You have not scored *every* battlefield this turn, so watch what happens.',
      highlight: ['score', 'unit:fx-grunt', 'battlefield:1', 'btn-pass'],
      gate: moveTo(1, 'move your remaining Grunt from your base to the right battlefield.'),
      onEnter: (ctx) => {
        ensureHeld(ctx, 0, false);
        const bf1 = ctx.battlefield(1).id;
        ctx.surgery.setBattlefield(bf1, {
          controller: null,
          contestedBy: null,
          scoredThisTurnBy: [],
        });
        ctx.surgery.setPoints(ctx.seat, 7);
        for (const id of inBase(ctx)) ctx.surgery.setReady(id, true);
      },
      onSkip: (ctx) => {
        ctx.surgery.setPoints(ctx.seat, 7);
      },
      hint: 'Same as before: move the Grunt, then press Pass until the Showdown closes.',
      done: (ctx) => ctx.events.some((e) => e.type === 'FINAL_POINT_DENIED_DREW_CARD'),
      explain:
        'Still **7 points**, but you **drew a card**. The game log says: "could not take the final point this way and drew a card instead" (event `FINAL_POINT_DENIED_DREW_CARD`). The engine did not reject your move: you still gained control of the right battlefield, and it still counts as scored this turn.\n\n**What to do instead:** Conquer for the 8th point only after you have scored **every** battlefield that turn, for example Hold one at the start of the turn and then Conquer the other. (In this version a Hold at 7 is not restricted, so Holding a battlefield also wins by itself.)',
    },
    {
      id: 'hold-first',
      title: 'Next turn: Hold first',
      instruction:
        'We rewind the score to **6** so you can see the "score everything" route. The right battlefield is empty again and you still hold the left one.\n\nPress **End turn**. Your opponent passes, then at the start of **your** turn you will **Hold** the left battlefield in the Beginning Phase.',
      highlight: ['score', 'battlefield:0', 'btn-end-turn'],
      gate: gates.types(['END_TURN'], 'press End turn.'),
      onEnter: (ctx) => {
        // Rewind: the right battlefield is vacated and uncontrolled again; the learner is back at 6.
        for (const id of ctx.unitsAt(1, 'you')) relocate(ctx, id, 'base');
        ensureHeld(ctx, 0, false);
        ctx.surgery.setBattlefield(ctx.battlefield(1).id, {
          controller: null,
          contestedBy: null,
          scoredThisTurnBy: [],
        });
        ctx.surgery.setPoints(ctx.seat, 6);
        ctx.surgery.setMainPhase(ctx.seat);
      },
      onSkip: (ctx) => {
        ctx.surgery.setPoints(ctx.seat, 7);
        ensureHeld(ctx, 0, true);
        for (const id of inBase(ctx)) ctx.surgery.setReady(id, true);
      },
      done: (ctx) =>
        ctx.state.turn.number >= 3 &&
        ctx.state.turn.activePlayer === ctx.seat &&
        ctx.state.turn.phase === 'MAIN',
      explain:
        'Your Beginning Phase **Held** the left battlefield: **6 to 7 points**, and it is now scored for this turn. One battlefield is scored; one to go.',
    },
    {
      id: 'conquer-last',
      title: 'Conquer for the win',
      instruction:
        'You are at **7 points** and have already scored the left battlefield this turn. Move your **Cinder Grunt** to the **right battlefield** and Conquer it: that scores *every* battlefield this turn, so the 8th point is allowed.',
      highlight: ['score', 'unit:fx-grunt', 'battlefield:1', 'btn-pass'],
      gate: moveTo(1, 'move your Grunt from your base to the right battlefield.'),
      onEnter: (ctx) => {
        for (const id of inBase(ctx)) ctx.surgery.setReady(id, true);
      },
      hint: 'Move the Grunt to the right battlefield, then press Pass until the Showdown closes.',
      done: (ctx) => ctx.state.gameStatus === 'FINISHED' && ctx.state.winner === ctx.seat,
      explain:
        '**8 points and more than your opponent**: the win is checked at the next **Cleanup** (Rule 323.1), and the game ends with you as the winner.',
    },
    {
      id: 'summary',
      title: 'Summary',
      instruction:
        'You win with **8 points** and **more than your opponent**, checked at Cleanup.\n\n**Hold** scores in your Beginning Phase; **Conquer** scores when you take control. Each battlefield scores once per turn.\n\nAt **7 points**, a Conquer only gives the point if you have scored **every** battlefield this turn; otherwise you **draw a card**.\n\nBurn Out gives your opponent a point when you must draw from an empty deck.\n\nPress **Continue**.',
      gate: gates.none('press Continue.'),
    },
  ],
  completionText:
    'You scored with Conquer, met the Final Point Rule (a denied Conquer draws a card instead), and won by scoring every battlefield in one turn.',
};
