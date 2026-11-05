import { autoAssign, computeAssignmentConstraints } from '@riftbound/engine';
import type { Intent } from '@riftbound/engine';
import { gates } from '../gates';
import type { LessonDef, StepCtx } from '../types';

/**
 * Lesson 5: Showdowns and Combat Might.
 *
 * Board (all by state surgery): the learner has a Spark Raider (Assault 1) and a Cinder Grunt ready in
 * their Base. The opponent holds battlefield 1 with an Order Warden (Tank, Might 2 after a -1 modifier),
 * a Hollow Wisp (Might 0, so it deals nothing but still needs lethal damage 1) and a Tide Lookout
 * (Backline, Might 2). Numbers: attackers 3 + 2 = 5 damage = exactly the lethal needed (2 + 1 + 2), the
 * defenders deal 0 + 2 + 2 = 4, which kills the Raider (lethal 3 as an Attacker) and wounds the Grunt.
 */

const BF = 1;
/** Delay before the lesson sends the illegal split for the learner (lets the dialog render first). */
const SEND_DELAY_MS = 250;

const moveIntent = (ctx: StepCtx): Intent => ({
  type: 'STANDARD_MOVE',
  playerId: ctx.seat,
  unitIds: [...ctx.unitsInPlay('fx-raider'), ...ctx.unitsInPlay('fx-grunt')],
  destination: { kind: 'battlefield', battlefieldId: ctx.battlefield(BF).id },
});

const learnerAutoAssign = (ctx: StepCtx): Intent => ({
  type: 'ASSIGN_COMBAT_DAMAGE',
  playerId: ctx.seat,
  assignments: autoAssign(ctx.state, ctx.cards, ctx.seat),
});

/** A deliberately illegal split: 1 on the Tank, lethal on the next unit, the rest on the Backline unit. */
function wrongSplit(ctx: StepCtx): Intent | null {
  const { total, ordered } = computeAssignmentConstraints(ctx.state, ctx.cards, ctx.seat);
  const [tank, second, last] = ordered;
  if (!tank || !second || !last) return null;
  return {
    type: 'ASSIGN_COMBAT_DAMAGE',
    playerId: ctx.seat,
    assignments: [
      { unitId: tank.unitId, amount: 1 },
      { unitId: second.unitId, amount: second.lethal },
      { unitId: last.unitId, amount: total - 1 - second.lethal },
    ],
  };
}

const nameOf = (ctx: StepCtx, id: string): string =>
  ctx.cards[ctx.state.objects[id]?.cardId ?? '']?.name ?? id;

export const LESSON_5: LessonDef = {
  id: 'lesson5-combat',
  title: 'Showdowns and Combat Might',
  summary: 'Move into an enemy battlefield, pass the Showdown, and split your damage Tank first.',
  concept: [
    'When your units move into a battlefield that holds **enemy units**, **Combat** starts. First comes a **Combat Showdown**: only Action and Reaction cards may be played. You are the **Attacker**, your opponent is the **Defender**.',
    'Then comes **Combat Damage**. Each side adds up the **Might** of its units there. An Attacker adds **Assault N** to its Might, a Defender adds **Shield N**. That total is the damage the side gets to assign to the enemy units.',
    'Damage is assigned to one enemy unit at a time: a unit must get **lethal damage** (its Might, at least 1) before the next unit gets any. **Tank** units must be assigned lethal damage first, **Backline** units last.',
    'The Attacker assigns first, then the Defender, and then all damage is dealt at once. Units with lethal damage die, survivors heal. If only one side has units left it wins the combat and takes control (a **Conquer** scores a point). If both sides survive, the Attackers go back to their Base.',
  ],
  setup: ({ sb, you, opp, kit }) => {
    sb.clearHand(you).clearHand(opp);
    sb.putUnit(you, kit.you.raider, 'base');
    sb.putUnit(you, kit.you.grunt, 'base');
    const bf = sb.state.battlefields[BF]!.id;
    sb.putUnit(opp, kit.opp.tank, bf, { control: true, mightBonus: -1 });
    sb.putUnit(opp, kit.opp.wisp, bf);
    sb.putUnit(opp, kit.opp.archer, bf);
  },
  steps: [
    {
      id: 'the-board',
      title: 'Might and lethal damage',
      instruction:
        'You have two ready units in your Base: **Spark Raider** (Might 2, **Assault 1**) and **Cinder Grunt** (Might 2). The opponent holds the right-hand battlefield with three units.\n\nA unit dies when it has damage equal to its Might (at least 1). Hover the units to compare their Might, then press **Continue**.',
      highlight: ['unit:fx-raider', 'unit:fx-grunt', 'opp-unit:fx-order-tank', 'battlefield:1'],
      gate: gates.none('read the board, then press Continue.'),
    },
    {
      id: 'attack',
      title: 'Attack the battlefield',
      instruction:
        "Move **both** units to the opponent's battlefield at once (select them in your Base and click the battlefield). Moving into enemy units starts **Combat**.",
      highlight: ['unit:fx-raider', 'unit:fx-grunt', 'battlefield:1'],
      gate: gates.custom((intent, ctx) => {
        if (intent.type !== 'STANDARD_MOVE') return false;
        const want = moveIntent(ctx);
        return (
          want.type === 'STANDARD_MOVE' &&
          intent.destination.kind === 'battlefield' &&
          intent.destination.battlefieldId === ctx.battlefield(BF).id &&
          want.unitIds.every((id) => intent.unitIds.includes(id))
        );
      }, "move the Spark Raider and the Cinder Grunt together to the opponent's battlefield."),
      onSkip: (ctx) => {
        void ctx.api.send(moveIntent(ctx));
      },
      hint: 'Click one of your units, then the other (in the tutorial each click adds to the selection; click a selected unit again to unselect it), then the highlighted battlefield; or drag them there.',
      done: (ctx) => ctx.state.flow.combat !== undefined,
      explain:
        'Combat started. You are the **Attacker** and the opponent is the **Defender**. Combat always begins with a Showdown.',
    },
    {
      id: 'showdown',
      title: 'The Combat Showdown',
      instruction:
        'In the Showdown only **Action** and **Reaction** cards can be played. Neither of you has any, so press **Pass**. When both of you pass in a row, the Showdown ends and damage begins.',
      highlight: ['btn-pass'],
      gate: gates.types(['PASS_PRIORITY'], 'press the Pass button.'),
      onSkip: (ctx) => {
        void ctx.api.send({ type: 'PASS_PRIORITY', playerId: ctx.seat });
        ctx.opponentPass();
      },
      done: (ctx) => ctx.state.flow.combat?.step === 'DAMAGE',
    },
    {
      id: 'wrong-split',
      title: 'Tank units go first',
      instruction:
        'Now you assign your damage. Look at the dialog: the **Order Warden** is a **Tank**, so it must get lethal damage first, and the **Tide Lookout** is **Backline**, so it comes last.\n\nTry to put the damage on the Lookout first: the dialog greys out **Confirm** and tells you why. To show you the real rule, we send that illegal split to the engine for you.',
      highlight: ['opp-unit:fx-order-tank', 'opp-unit:fx-tide-archer', 'opp-unit:fx-wisp'],
      gate: gates.types(['ASSIGN_COMBAT_DAMAGE'], 'this step is about the damage dialog.'),
      opponentAuto: false,
      onEnter: (ctx) => {
        const c = computeAssignmentConstraints(ctx.state, ctx.cards, ctx.seat);
        const parts = ctx.unitsAt(BF, 'you').map((id) => nameOf(ctx, id));
        ctx.say(
          `Your total is **${c.total}** damage (${parts.join(' + ')}; the Raider counts **Assault 1** as an Attacker: 2 + 1).`,
        );
        const bad = wrongSplit(ctx);
        if (!bad) return;
        const idx = ctx.stepIndex;
        setTimeout(() => {
          if (ctx.stepIndex === idx) void ctx.api.send(bad);
        }, SEND_DELAY_MS);
      },
      expectError: {
        code: 'INVALID_DAMAGE_ASSIGNMENT',
        messageIncludes: '(TANK) must be assigned lethal damage before',
      },
      hint: 'The engine refuses any split that gives a Backline or normal unit damage while the Tank is short of lethal.',
    },
    {
      id: 'right-split',
      title: 'Assign your damage',
      instruction:
        'Now do it right: give each enemy unit exactly its **lethal** damage in order (Tank, then the Wisp, then the Backline Lookout). The **Lethal** buttons or **Auto assign** do it for you. Press **Confirm**.\n\nYour units deal exactly enough to kill all three.',
      highlight: ['opp-unit:fx-order-tank', 'opp-unit:fx-wisp', 'opp-unit:fx-tide-archer'],
      gate: gates.types(['ASSIGN_COMBAT_DAMAGE'], 'assign your combat damage in the dialog.'),
      opponentAuto: false,
      onEnter: (ctx) => {
        const c = computeAssignmentConstraints(ctx.state, ctx.cards, ctx.seat);
        ctx.say(
          `Lethal needed, in order: ${c.ordered.map((u) => `${nameOf(ctx, u.unitId)} ${u.lethal}`).join(', ')}. Total ${c.total}.`,
        );
      },
      onSkip: (ctx) => {
        if (ctx.state.flow.combat?.awaitingAssignmentFrom === ctx.seat) {
          void ctx.api.send(learnerAutoAssign(ctx));
        }
      },
      done: (ctx) => ctx.state.flow.combat?.awaitingAssignmentFrom === ctx.oppSeat,
      explain:
        'Assigning is not dealing: nothing has been damaged yet. The Defender assigns next, then **all damage is dealt at the same time**.',
    },
    {
      id: 'defender',
      title: 'The Defender assigns',
      instruction:
        'The Defender now assigns **its** damage to your units. Its Might is lower: the Warden has Might 2 and the Wisp has 0, so it only has 4. Press **Continue** to see the result.',
      highlight: ['unit:fx-raider', 'unit:fx-grunt'],
      gate: gates.none('press Continue.'),
      opponentAuto: false,
      onEnter: (ctx) => {
        const c = ctx.state.flow.combat;
        if (c?.step === 'DAMAGE' && c.awaitingAssignmentFrom === ctx.oppSeat) {
          // Lethal on the Spark Raider, the rest on the Cinder Grunt (the Defender's choice).
          const { total, ordered } = computeAssignmentConstraints(
            ctx.state,
            ctx.cards,
            ctx.oppSeat,
          );
          const raider = ordered.find((u) => ctx.state.objects[u.unitId]?.cardId === 'fx-raider');
          const other = ordered.find((u) => u !== raider);
          const assignments =
            raider && other
              ? [
                  { unitId: raider.unitId, amount: raider.lethal },
                  { unitId: other.unitId, amount: total - raider.lethal },
                ]
              : autoAssign(ctx.state, ctx.cards, ctx.oppSeat);
          ctx.opponent({ type: 'ASSIGN_COMBAT_DAMAGE', assignments });
          ctx.say(
            `The Defender had **${total}** damage: lethal on the Spark Raider (its Might is 2 + 1 Assault as an Attacker = 3), and the rest on the Cinder Grunt.`,
          );
        }
      },
    },
    {
      id: 'result',
      title: 'The result',
      instruction:
        'Damage was dealt and Cleanup killed every unit with lethal damage. Your **Spark Raider** and all three enemy units went to their Trash. The **Cinder Grunt** survived, **healed** back to full, and as the only side left it **won the combat** and took control of the battlefield. Taking a battlefield you did not control is a **Conquer**, worth a point.',
      highlight: ['battlefield:1', 'score'],
      gate: gates.none('look at the result, then press Next.'),
      opponentAuto: false,
      done: (ctx) => ctx.points() > 0 && ctx.state.flow.combat === undefined,
      explain:
        'If both sides had survived, your Attackers would have been returned to your Base and the Defender would have kept the battlefield.',
    },
    {
      id: 'summary',
      title: 'What you learned',
      instruction:
        'Combat in four lines: **move in**, **pass the Showdown**, **assign damage** (Attacker first, **Tank first**, **Backline last**, lethal before the next unit), and the survivors **take or keep** the battlefield.\n\nMight is the whole story: Assault adds to an Attacker, Shield to a Defender. Press **Continue** to finish.',
      highlight: ['score'],
      gate: gates.none('press Continue.'),
      opponentAuto: false,
    },
  ],
  completionText:
    'You attacked a held battlefield, passed the Combat Showdown, saw the engine insist on Tank-first damage, and Conquered the battlefield with a surviving unit.',
};
