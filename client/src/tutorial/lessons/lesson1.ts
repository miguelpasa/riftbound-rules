import { RUNES_PER_CHANNEL } from '@riftbound/engine';
import { KIT_YOU } from '../kit';
import { gates } from '../gates';
import type { LessonDef, StepCtx } from '../types';

/** Runes of `who` in its base (channeled or otherwise put there). */
const runesInBase = (ctx: StepCtx, who = ctx.seat): number =>
  Object.values(ctx.state.objects).filter(
    (o) => o.zone.kind === 'base' && o.zone.player === who && ctx.cards[o.cardId]?.type === 'RUNE',
  ).length;

/** Cards in the learner's hand. */
const handSize = (ctx: StepCtx): number =>
  ctx.state.players.find((p) => p.id === ctx.seat)?.hand.length ?? 0;

/** Units of the learner's Cinder Grunt that are in play, with how many are ready. */
const grunts = (ctx: StepCtx): { total: number; ready: number } => {
  const ids = ctx.unitsInPlay(KIT_YOU.grunt);
  const ready = ids.filter((id) => ctx.state.objects[id]?.ready).length;
  return { total: ids.length, ready };
};

export const LESSON_1: LessonDef = {
  id: 'lesson1-turn-structure',
  title: 'The Turn Structure',
  summary:
    'Awaken, Beginning/Scoring, Channel, Draw, Main, Ending: what happens in each phase of a turn.',
  concept: [
    'Every turn follows the same order of **phases**. The **Start of Turn** has four steps that run **by themselves**: **Awaken** readies your cards, **Beginning** scores the battlefields you Hold (in its Scoring step), **Channel** puts two runes from your Rune Deck into play, and **Draw** draws a card.',
    'Then comes your **Main Phase**, the only phase where you make decisions: play cards, move units and start showdowns. You decide when it is over, by pressing **End turn**.',
    "Last, the **Ending Phase** runs by itself: damage on units heals and unspent resources in your Rune Pool vanish. The other player's turn then starts with the same sequence.",
  ],
  setup: ({ sb, you, kit }) => {
    // Two channeled runes (Fury and Calm) in play, and a Cinder Grunt that is exhausted: Awaken readies it.
    sb.setRunes(you, ['Fury', 'Calm']);
    sb.putUnit(you, kit.you.grunt, 'base', { ready: false });
  },
  steps: [
    {
      id: 'phases',
      title: 'The phases of a turn',
      instruction:
        'The **phase tracker** at the top shows where the game is.\n\n**Start of Turn** (automatic): Awaken, Beginning (with its Scoring step), Channel and Draw.\n\n**Main Phase** (you act): play cards, move units and showdowns. You end it yourself.\n\n**Ending Phase** (automatic): damage heals and unspent Rune Pool resources vanish.\n\nRead the list, then press **Continue**.',
      highlight: ['phase-tracker'],
      gate: gates.none('read the phases, then press Continue.'),
    },
    {
      id: 'runes',
      title: 'Your channeled runes',
      instruction:
        'Your **rune panel** lists the runes in play. Channel put two of them into play at the start of your turn, and they are ready to pay for cards.\n\nNote their domains, then press **Continue**.',
      highlight: ['rune-panel'],
      gate: gates.none('look at the rune panel, then press Continue.'),
      onEnter: (ctx) => {
        ctx.say(`You have ${runesInBase(ctx)} runes in play right now.`);
      },
    },
    {
      id: 'end-turn',
      title: 'End your Main Phase',
      instruction:
        "Nothing else is left for you to do this turn. Finish your Main Phase with **End turn**.\n\nWatch what happens next: the Ending Phase runs, then your opponent's turn starts.",
      highlight: ['btn-end-turn'],
      gate: gates.types(['END_TURN'], 'press End turn to finish your Main Phase.'),
      opponentAuto: false,
      onSkip: (ctx) => {
        ctx.surgery.setMainPhase(ctx.oppSeat);
      },
      done: (ctx) => ctx.state.turn.activePlayer === ctx.oppSeat,
      explain:
        "Your **Ending Phase** ran: damage on units healed and unspent Rune Pool resources vanished. Then your opponent's turn began, with its own Awaken, Beginning, Channel and Draw, and it now sits in its Main Phase.",
    },
    {
      id: 'out-of-turn',
      title: 'Not your turn to act',
      instruction:
        'Your opponent is the turn player now, and they hold **priority** in their Main Phase. Try to **play a card** from your hand anyway.',
      highlight: ['hand', 'phase-tracker'],
      gate: gates.custom(
        (intent) => intent.type === 'PLAY_CARD',
        'play a card from your hand anyway.',
      ),
      opponentAuto: false,
      onEnter: (ctx) => {
        if (ctx.state.turn.activePlayer !== ctx.oppSeat) ctx.surgery.setMainPhase(ctx.oppSeat);
      },
      hint: 'Click any card in your hand. The engine decides what happens.',
      expectError: { code: 'NOT_YOUR_PRIORITY' },
      explain:
        "The engine refuses: during your opponent's turn they hold priority, so you cannot take an action until your own turn. Your next turn is coming up.",
    },
    {
      id: 'opponent-turn',
      title: "Watch the opponent's turn",
      instruction:
        "Your opponent's turn runs automatically. Awaken readies their cards, Beginning scores, Channel puts two runes into play and Draw gives them a card. Then they are in their Main Phase, and when they press **End turn** your turn begins.\n\nWatch the **phase tracker** and the **score** while it happens.",
      highlight: ['phase-tracker', 'score'],
      gate: gates.none("nothing to do during your opponent's turn."),
      onSkip: (ctx) => {
        ctx.opponentEndTurn();
      },
      done: (ctx) => ctx.state.turn.activePlayer === ctx.seat,
      explain:
        'Their turn is over. Your turn started with Awaken, Beginning, Channel and Draw, all automatic, and you are back in your Main Phase.',
    },
    {
      id: 'your-turn',
      title: 'What your new turn gave you',
      instruction:
        'Your turn has started. The note below reads the real game state:\n\n**Awaken** readies your exhausted units, **Channel** adds runes and **Draw** adds a card to your hand.\n\nPress **Continue** when you have read it.',
      highlight: ['phase-tracker', 'rune-panel', 'hand'],
      gate: gates.none('read the note, then press Continue.'),
      onEnter: (ctx) => {
        const g = grunts(ctx);
        const awaken =
          g.total === 0 ? 'no Cinder Grunt in play' : `${g.ready} of ${g.total} Cinder Grunt ready`;
        ctx.say(
          `Awaken: ${awaken}. Channel: ${runesInBase(ctx)} runes in play (Channel adds ${RUNES_PER_CHANNEL} each turn). Draw: your hand has ${handSize(ctx)} cards.`,
        );
      },
    },
    {
      id: 'summary',
      title: 'Summary',
      instruction:
        'Each turn runs Start of Turn (Awaken, Beginning, Channel, Draw) by itself, then your Main Phase, where you act and choose when to press **End turn**, then the Ending Phase. Rules run the same way for both players.\n\nPress **Continue** to finish the lesson.',
      gate: gates.none('press Continue to finish.'),
    },
  ],
  completionText:
    "You followed a full turn cycle on the real engine: you saw why you cannot act on your opponent's turn, watched their phases run, and read what your new turn gave you.",
};
