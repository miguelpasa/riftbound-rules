import { gates } from '../gates';
import type { LessonDef } from '../types';

/**
 * Demo lesson that proves the pipeline end to end: a read-only step, a free-gate step that plays
 * a unit through the real engine, a scripted opponent response, and a step that teaches by letting
 * the learner trigger a REAL engine refusal (expectError).
 */
export const LESSON_0_DEMO: LessonDef = {
  id: 'lesson0-demo',
  title: 'Meet the board',
  summary: 'A two-minute tour: your hand, playing a unit, and why you cannot cast just anything.',
  concept: [
    'Everything you do here goes to the **real rules engine**. The board is the same one used in a normal game.',
    'Cards in your **hand** cost **Energy**, which your **runes** produce. Most cards are played during your **Main Phase**.',
  ],
  setup: ({ sb, you, opp }) => {
    sb.giveRunes(you, 4, 'Fury').giveRunes(opp, 2, 'Order');
    sb.clearHand(you).clearHand(opp);
    sb.putInHand(you, 'fx-grunt');
    sb.putInHand(you, 'fx-flare');
    sb.putInHand(you, 'fx-plain-spell');
    sb.putInHand(opp, 'fx-tide-guard');
  },
  steps: [
    {
      id: 'look',
      title: 'Your hand',
      instruction:
        'These three cards are your **hand**. A unit (Cinder Grunt) and two spells.\n\nHover a card to read it. When you are ready, press **Continue**.',
      highlight: ['hand'],
      gate: gates.none('read the cards, then press Continue.'),
    },
    {
      id: 'play-unit',
      title: 'Play a unit',
      instruction:
        'Click **Cinder Grunt** in your hand and choose your base. It costs 2 Energy; your runes pay automatically.',
      highlight: ['hand-card:fx-grunt'],
      gate: gates.playCard('fx-grunt', 'play Cinder Grunt from your hand.', ['PASS_PRIORITY']),
      onSkip: (ctx) => {
        ctx.surgery.putUnit(ctx.seat, 'fx-grunt', 'base');
      },
      hint: 'If the unit sits on the chain, pass priority: your opponent passes back and it resolves.',
      done: (ctx) => ctx.unitsInPlay('fx-grunt').length > 0,
      explain:
        'The unit is on the board. Playing a card is an action that goes on the **Chain**, then resolves once everyone passes.',
    },
    {
      id: 'cast-spell',
      title: 'Cast a spell',
      instruction: 'Now cast **Flare Bolt** from your hand. It is an **Action** spell.',
      highlight: ['hand-card:fx-flare'],
      gate: gates.playCard('fx-flare', 'cast Flare Bolt.'),
      onSkip: (ctx) => ctx.youPlay('fx-flare'),
      done: (ctx) => ctx.state.flow.chain.length > 0,
    },
    {
      id: 'closed-state',
      title: 'The opponent responds',
      instruction:
        'Your opponent answered with a **Reaction**. The Chain is now in a **Closed State**: only Reactions may be played.\n\nTry casting **Plain Chant** anyway and read what the engine says.',
      highlight: ['chain-panel', 'hand-card:fx-plain-spell'],
      gate: gates.playCard('fx-plain-spell', 'try casting Plain Chant.'),
      opponentAuto: false,
      onEnter: (ctx) => ctx.opponentPlay('fx-tide-guard'),
      expectError: { code: 'CLOSED_STATE_REACTION_ONLY' },
      hint: 'Click Plain Chant in your hand. It is not a Reaction, so it should be refused.',
      explain:
        'That refusal is the rule, not a bug: during a Chain only Reactions may be played (Rule 309.1.a).',
    },
    {
      id: 'resolve',
      title: 'Let the chain resolve',
      instruction:
        'Press the highlighted **Pass** button to let the chain resolve. Your opponent passes too. You may need to pass more than once.',
      highlight: ['btn-pass'],
      gate: gates.types(['PASS_PRIORITY'], 'press the Pass button.'),
      opponentAuto: true,
      done: (ctx) => ctx.state.flow.chain.length === 0,
    },
    {
      id: 'end-turn',
      title: 'End your turn',
      instruction: 'Finish your Main Phase with **End turn**.',
      highlight: ['btn-end-turn'],
      gate: gates.types(['END_TURN'], 'press End turn.'),
      done: (ctx) => ctx.state.turn.activePlayer !== ctx.seat,
    },
  ],
  completionText:
    'You played a unit, saw the Chain close to everything but Reactions, and ended your turn, all on the real engine.',
};
