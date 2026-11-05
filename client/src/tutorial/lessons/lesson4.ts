import { gates } from '../gates';
import type { LessonDef, StepCtx } from '../types';

const OPP_SPELL = 'fx-plain-spell'; // Plain Chant: the opponent's ordinary spell
const MY_REACTION = 'fx-ward'; // Quick Ward: a Reaction
const MY_UNIT = 'fx-grunt'; // Cinder Grunt: not a Reaction

/** Ids of the chain items still on the Chain, oldest first. */
const chainIds = (ctx: StepCtx): string[] => ctx.state.flow.chain.map((i) => i.id);

/**
 * Lesson 4: the Chain and the Open / Closed state (Core Rules 307-313, 325-340, 354).
 *
 * The opponent casts a spell in THEIR Main Phase; the engine then hands Priority to the learner
 * (finalizeItem gives it to the next player in turn order after the item's controller), who learns
 * the Closed State by being refused, then answers with a Reaction and watches last-in, first-out.
 */
export const LESSON_4: LessonDef = {
  id: 'lesson4-chain',
  title: 'The Chain: Open and Closed States',
  summary: 'How spells stack, who has priority, and when only Reactions are allowed.',
  concept: [
    'At any moment the game is **Neutral** or in a **Showdown**, and **Open** or **Closed**. It is **Open** when nothing is waiting to resolve and **Closed** while the **Chain** has at least one item on it.',
    'Playing a card puts it on the **Chain** and the state becomes **Closed**. While it is Closed only **Reaction** cards (and rune abilities) may be played. Ordinary spells, units and gear need an Open state on your own turn, and Action cards need an Open state during a Showdown.',
    'The player with **Priority** may respond or **pass**. When everyone passes in sequence, the **newest** item resolves first (last in, first out), then Priority comes around again. When the Chain empties, the state is Open again.',
  ],
  setup: ({ sb, you, opp }) => {
    sb.giveRunes(you, 2, 'Fury').giveRunes(you, 1, 'Calm');
    sb.clearHand(you).clearHand(opp);
    sb.putInHand(you, MY_UNIT);
    sb.putInHand(you, MY_REACTION);
    sb.giveRunes(opp, 2, 'Mind');
    sb.putInHand(opp, OPP_SPELL);
  },
  steps: [
    {
      id: 'intro',
      title: 'Open and Closed',
      instruction:
        'Right now nothing is waiting to resolve, so the game is **Neutral** and **Open**: on your own turn you may play your cards normally.\n\nLook at the **Chain** panel: it is empty. It is about to matter. You have a **Cinder Grunt** (a unit) and a **Quick Ward** (a Reaction) in hand.\n\nPress **Continue**.',
      highlight: ['chain-panel', 'hand'],
      gate: gates.none('read the step, then press Continue.'),
    },
    {
      id: 'end-turn',
      title: 'Hand over the turn',
      instruction:
        'Spells like the ones you will meet here are usually played on **your own** turn. To see the Chain from the other side, **end your turn** and let your opponent act.',
      highlight: ['btn-end-turn'],
      gate: gates.types(['END_TURN'], 'press End turn.'),
      opponentAuto: false, // hold the opponent so it does not end its own turn
      done: (ctx) => ctx.state.turn.activePlayer !== ctx.seat,
    },
    {
      id: 'opp-cast',
      title: 'The opponent casts a spell',
      instruction:
        "It is your opponent's Main Phase and they cast **Plain Chant**. The spell is now on the **Chain**, and, because you were the next player in turn order, **you have Priority**.\n\nOpen the Chain panel: the spell is waiting there, not resolved yet.",
      highlight: ['chain-panel'],
      gate: gates.none('read the step, then press Continue.'),
      opponentAuto: false,
      onEnter: (ctx) => {
        const sb = ctx.surgery;
        // Self-contained so that Skip / Back / Reset from any step lands on the same board.
        if (ctx.state.turn.activePlayer !== ctx.oppSeat || ctx.state.turn.phase !== 'MAIN') {
          sb.setMainPhase(ctx.oppSeat);
        }
        sb.setRunes(ctx.seat, ['Fury', 'Fury', 'Calm']);
        sb.setRunes(ctx.oppSeat, ['Mind', 'Mind']);
        if (!ctx.find(MY_REACTION, 'you', ['hand'])) sb.putInHand(ctx.seat, MY_REACTION);
        if (!ctx.find(MY_UNIT, 'you', ['hand'])) sb.putInHand(ctx.seat, MY_UNIT);
        if (!ctx.find(OPP_SPELL, 'opp', ['hand'])) sb.putInHand(ctx.oppSeat, OPP_SPELL);
        ctx.opponentPlay(OPP_SPELL);
      },
    },
    {
      id: 'closed',
      title: 'The Chain is Closed',
      instruction:
        'With an item on the Chain the state is **Closed**. Now you can only play a **Reaction** card, or **pass** Priority.\n\nIn a live multiplayer game this is the **priority window**: you get **30 seconds** to react, and if the timer runs out you automatically pass. (This lesson has no timer.)\n\nPress **Continue**.',
      highlight: ['chain-panel'],
      gate: gates.none('read the step, then press Continue.'),
      opponentAuto: false,
    },
    {
      id: 'try-unit',
      title: 'Try to play a unit',
      instruction:
        'Let us test it. Click **Cinder Grunt** in your hand. A unit is not a Reaction, so the engine should refuse it. Read what it says.',
      highlight: ['chain-panel', 'hand-card:fx-grunt'],
      gate: gates.playCard(MY_UNIT, 'try the Cinder Grunt.'),
      opponentAuto: false,
      expectError: { code: 'CLOSED_STATE_REACTION_ONLY' },
      hint: 'Click Cinder Grunt in your hand (choose your base if asked).',
      explain:
        'That is the Closed State rule, not a bug: while the Chain exists, only Reactions can be played (Rule 309.1.a).',
    },
    {
      id: 'react',
      title: 'Respond with a Reaction',
      instruction:
        'A **Reaction** is allowed. Click **Quick Ward** to put it on the Chain **above** Plain Chant.',
      highlight: ['chain-panel', 'hand-card:fx-ward'],
      gate: gates.playCard(MY_REACTION, 'cast Quick Ward.'),
      opponentAuto: false,
      onSkip: (ctx) => {
        if (ctx.find(MY_REACTION, 'you', ['hand']) && chainIds(ctx).length < 2) {
          ctx.youPlay(MY_REACTION);
        }
      },
      done: (ctx) => ctx.state.flow.chain.length >= 2,
      explain:
        'The Chain now has two items. Plain Chant is at the bottom and your Quick Ward is on top. The Chain is still Closed, and now your opponent holds Priority.',
    },
    {
      id: 'pass-first',
      title: 'Pass: the newest resolves first',
      instruction:
        'Press **Pass**. Your opponent passes too. When everybody has passed in a row, the **newest** item resolves: your Quick Ward, not Plain Chant.',
      highlight: ['chain-panel', 'btn-pass'],
      gate: gates.types(['PASS_PRIORITY'], 'press the Pass button.'),
      opponentAuto: true,
      done: (ctx) => ctx.state.flow.chain.length < 2,
      explain:
        'Last in, first out. Quick Ward went on the Chain last, so it resolved first and went to your **Trash**. Plain Chant is still waiting, and Priority has come back around to you.',
    },
    {
      id: 'pass-second',
      title: 'Pass again',
      instruction: 'Pass once more. When both players have passed, **Plain Chant** resolves too.',
      highlight: ['chain-panel', 'btn-pass'],
      gate: gates.types(['PASS_PRIORITY'], 'press the Pass button.'),
      opponentAuto: true,
      done: (ctx) => ctx.state.flow.chain.length === 0,
      explain:
        "The Chain is empty, so the state is **Open** again. Both spells are in their owners' Trash.",
    },
    {
      id: 'summary',
      title: 'What you learned',
      instruction:
        'Putting it together:\n\n**1.** Playing a card puts it on the Chain and makes the state **Closed**.\n\n**2.** While Closed, only **Reactions** can be played, otherwise you pass.\n\n**3.** Resolution is **last in, first out**; when the Chain is empty the state is **Open** again.\n\nOne honest note: in this early version the engine does not execute the written effect text of most cards. It shows "effect not implemented" and resolves the card as a no-op, but timing, costs, the Chain and the Trash all work for real.',
      highlight: ['chain-panel'],
      gate: gates.none('press Continue to finish.'),
    },
  ],
  completionText:
    'You watched the Chain close, were refused a non-Reaction, answered with a Reaction and saw last-in, first-out resolution empty the Chain.',
};
