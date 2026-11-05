# Writing a tutorial lesson

A lesson is **one file** in `lessons/` exporting a `LessonDef` (plain data, no React). Register it in
`lessons/index.ts`. Replace a placeholder (`lesson1.ts` ... `lesson6.ts`) by keeping its export name and
`id` and removing `comingSoon`.

The lesson runs on a **real engine game** (`createLocalGameApi`, no AI). You never fake rules: you set up
the board, decide what the learner may click, and say when a step is done. The engine does the rest, so
rule errors the learner sees are the real `[Rule Error] ...` strings.

Pieces you write:

| Field                    | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `id`, `title`, `summary` | list entry (`id` is the progress key: never change it) |
| `concept: string[]`      | short paragraphs in the collapsible "The idea" box     |
| `setup(ctx)`             | builds the starting board with state surgery           |
| `steps: StepDef[]`       | the guided steps                                       |
| `completionText`         | shown on the completion screen                         |

Text fields support minimal markdown: `**bold**`, `` `code` `` and blank lines for paragraphs. Nothing else
(no HTML, no lists).

## The board you start from

`setup({ sb, cards, you, opp, kit })` receives a `Sandbox` (`engine/src/sandbox.ts`) that is already a real
game in the **Main Phase, turn 1, learner = `'p0'` to act, opponent = `'p1'`**, mulligans kept, using the
fixture cards: you = deck A (Fury/Calm), the opponent = deck B (Mind/Order). Both start with a normal
4-card hand and no runes in play. Rearrange it with chainable surgery (each call keeps zone arrays and
invariants consistent; `sb.verify()` runs automatically after setup):

```ts
sb.giveRunes(you, 3, 'Fury'); // move runes from the Rune Deck to the base, ready
sb.setRunes(you, ['Fury', 'Calm']); // exactly these runes in play
sb.setPool(you, 2, { Fury: 1 }); // overwrite the Rune Pool (energy, power by domain)
sb.clearHand(you); // hand cards go back on top of the deck
const id = sb.putInHand(you, 'fx-grunt'); // returns the instance id (NOT chainable)
sb.putUnit(opp, 'fx-order-tank', 'base'); // second argument: 'base' or a battlefield id
sb.putUnit(you, 'fx-grunt', sb.state.battlefields[0]!.id, { control: true, ready: true });
sb.setPoints(you, 6);
sb.setDeckSize(you, 3);
sb.setBattlefield(bfId, { controller: you, contestedBy: null });
sb.setMightBonus(id, 2);
sb.setReady(id, false);
sb.setMainPhase(); // normalise flow to a plain Main Phase of the turn player
```

`kit.you` / `kit.opp` name the fixture cards per side so you do not hard-code deck membership
(`kit.you.grunt`, `.tank`, `.archer`, `.raider`, `.shielder`, `.ganker`, `.wisp`, `.titan`, `.action`,
`.reaction`, `.plainSpell`, `.equipment`, `.rune`; see `kit.ts` for the card behind each). A card can only
be put in play / hand if a spare copy of the right owner exists in their deck, trash or champion zone.

Other decks/cards: set `cards` and `decks` (a `[DeckList, DeckList]` whose first deck is the learner's) on
the `LessonDef`. `seed` (default: the lesson id) makes the shuffle stable.

## Steps

```ts
interface StepDef {
  id: string; // unique in the lesson
  title: string;
  instruction: string; // **bold**, `code`
  highlight?: string[] | ((ctx) => string[]); // spotlight (see "Highlight ids")
  gate?: 'free' | GateRule; // what the learner may send (default 'free')
  onEnter?(ctx): void; // runs on entry AND on Reset step / Back
  onSkip?(ctx): void; // fix up the board when the learner presses Skip
  done?(ctx): boolean; // evaluated after EVERY state update
  expectError?: { code?: RuleErrorCode; messageIncludes?: string };
  explain?: string; // shown after completion; learner presses "Next step"
  hint?: string; // behind a "Show hint" button
  autoAdvanceMs?: number; // advance by itself this long after done
  opponentAuto?: boolean; // default true (see "Scripted opponent")
}
```

- **No `done` and no `expectError`** = read-only step: the learner presses **Continue**.
- **`done`** completes the step when it returns true. Without `explain` the lesson moves on at once;
  with `explain` (or `autoAdvanceMs`) it pauses so the learner can read.
- **`expectError`** teaches by refusal: the step completes when the engine rejects the learner's intent
  with the matching code (and/or message substring; both must match if both given). Other refusals do not
  complete it. The exact engine text appears as **"The engine says: ..."**, then the learner presses Next.
  The gate must still allow the attempt.
- Because learners can **Skip**, a step must not assume its predecessors really happened. Either keep
  `onEnter` self-contained (do the surgery it needs) or provide `onSkip` that produces the board the step
  would have produced (`ctx.surgery.putUnit(...)`, `ctx.youPlay('fx-flare')`, ...).
- **Reset step / Back** restore the exact state from the start of the step (before `onEnter`) and run
  `onEnter` again, so `onEnter` must be repeatable.

## Gates

`gate: 'free'` sends everything to the real engine. A `GateRule` is `{ allow(intent, ctx), blockedMessage? }`.
Intents that `allow` rejects never reach the engine: the learner gets a toast and sidebar callout
**"Not yet: <blockedMessage>"**, and `api.legal` (which drives highlights and the primary button) is
filtered with the same predicate. Handy builders in `gates.ts`:

```ts
gates.none('read the card first')                         // nothing allowed
gates.types(['PASS_PRIORITY'], 'press Pass')              // only these intent types
gates.except(['END_TURN'], 'not yet')                     // everything but these
gates.playCard('fx-grunt', 'play the Grunt', ['PASS_PRIORITY'])  // only PLAY_CARD of that card (+ extra types)
gates.custom((intent, ctx) => ..., 'message')             // anything
gates.and(a, b)
```

Note: clicking a card the gate forbids still _attempts_ the play (that is how the UI shows real rule
errors), so a blocked click shows your `blockedMessage`. After a step completes and before the learner
presses Next everything is blocked ("press Next to continue").

## The step context (`ctx`)

Everything is a getter on the live game; do not store `ctx` across callbacks.

| Member                                | Meaning                                                                                                                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                               | full authoritative `GameState` (includes the opponent's hidden zones; tutorial only)                                                                                                                  |
| `view`                                | what the learner's UI sees (sanitised for `seat`)                                                                                                                                                     |
| `seat`, `oppSeat`                     | `'p0'`, `'p1'`                                                                                                                                                                                        |
| `cards`                               | the card database                                                                                                                                                                                     |
| `legal`                               | every intent the engine would accept from the learner now (NOT narrowed by the gate; `ctx.api.legal` is)                                                                                              |
| `events`                              | events since this step was entered (including those from its `onEnter`)                                                                                                                               |
| `api`                                 | the `GameApi` the UI uses                                                                                                                                                                             |
| `lastError`                           | the learner's latest engine refusal in this step (`RuleError`: `.code`, `.message`); cleared by the next accepted intent or a step change                                                             |
| `stepIndex`, `lessonId`               |                                                                                                                                                                                                       |
| `opponent(intent)`                    | apply an intent for the scripted opponent through the real reducer; **throws** if illegal (in dev/test, so a bad script fails loudly; in production it is logged and skipped). `playerId` is optional |
| `opponentPlay(card, {location?})`     | opponent plays a card from hand; `card` = definition id or instance id; payment is chosen from the legal list. `location: 'base'` or `{ battlefield: 0 }`                                             |
| `opponentPass()`, `opponentEndTurn()` |                                                                                                                                                                                                       |
| `youPlay(card, {location?})`          | the same for the **learner** (for `onSkip` / demonstrations)                                                                                                                                          |
| `surgery`                             | the `Sandbox` helpers above, applied live (UI re-renders, invariants checked)                                                                                                                         |
| `say(text)`                           | add a coach note under the instruction (cleared on step change)                                                                                                                                       |
| `find(cardId, who?, zones?)`          | instance id of a card by definition id (`who`: `'you'` default, `'opp'`)                                                                                                                              |
| `unitsAt(bfIndex, who?)`              | unit instance ids at battlefield `bfIndex` (0-based)                                                                                                                                                  |
| `unitsInPlay(cardId, who?)`           | unit instance ids in base or a battlefield                                                                                                                                                            |
| `battlefield(i)`, `points(who?)`      | convenience reads                                                                                                                                                                                     |

### Scripted opponent

There is no AI. The opponent acts only through `ctx.opponent*` calls (usually in `onEnter`). When it is
_waiting_ (it must pass priority or end its turn for the game to move on) an autopilot passes / ends the
turn after a short delay. Set `opponentAuto: false` on a step (or on the lesson) to make it hold: that is
how you keep a chain item pending or the opponent's priority frozen. Remember the engine's real rules:
after the learner plays a card, the **opponent gets priority** first.

### Highlight ids

`highlight` entries are `data-tutorial-id` values, or raw CSS selectors (anything starting with `[`, `.`
or `#`). Every matching element is outlined; the rest of the page is dimmed; clicks always pass through.

| id                                    | element                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `hand`                                | the hand section                                                            |
| `hand-card:<cardId>`                  | a card in the hand, by **definition id** (`hand-card:fx-grunt`; every copy) |
| `unit:<cardId>` / `opp-unit:<cardId>` | your / the opponent's unit in play (base or battlefield)                    |
| `battlefield:<index>`                 | the battlefield at that index in `state.battlefields`                       |
| `base`, `opp-base`                    | the two bases                                                               |
| `btn-pass`                            | the primary button when it is _Pass_                                        |
| `btn-end-turn`                        | the primary button when it is _End turn_                                    |
| `rune-panel`, `chain-panel`           | the Resources / Chain side panels                                           |
| `score`, `phase-tracker`              | scoreboard / phase tracker                                                  |

The primary button only exists while the gate keeps its intent legal, so highlight it only in steps whose
gate allows `PASS_PRIORITY` / `END_TURN`. A function form computes ids from the live state: `highlight: (ctx) => ['battlefield:0', 'unit:fx-grunt']`.

## Complete worked example

```ts
import { gates } from '../gates';
import type { LessonDef } from '../types';

export const LESSON_X: LessonDef = {
  id: 'lessonX-example',
  title: 'Spells need Reactions during a chain',
  summary: 'Cast a spell, see the opponent respond, and meet the Closed State.',
  concept: [
    'A spell goes on the **Chain**. While the Chain is not empty only **Reactions** may be played.',
  ],
  setup: ({ sb, you, opp }) => {
    sb.giveRunes(you, 4, 'Fury').giveRunes(opp, 2, 'Order');
    sb.clearHand(you).clearHand(opp);
    sb.putInHand(you, 'fx-flare'); // Action spell
    sb.putInHand(you, 'fx-plain-spell'); // not a Reaction
    sb.putInHand(opp, 'fx-tide-guard'); // the opponent's Reaction
  },
  steps: [
    {
      id: 'cast',
      title: 'Cast Flare Bolt',
      instruction: 'Click **Flare Bolt** in your hand.',
      highlight: ['hand-card:fx-flare'],
      gate: gates.playCard('fx-flare', 'cast Flare Bolt.'),
      onSkip: (ctx) => ctx.youPlay('fx-flare'),
      done: (ctx) => ctx.state.flow.chain.length > 0,
    },
    {
      id: 'closed',
      title: 'The opponent answers',
      instruction: 'The opponent played a **Reaction**. Now try casting **Plain Chant**.',
      highlight: ['chain-panel', 'hand-card:fx-plain-spell'],
      gate: gates.playCard('fx-plain-spell', 'try Plain Chant.'),
      opponentAuto: false, // hold the chain open
      onEnter: (ctx) => ctx.opponentPlay('fx-tide-guard'),
      expectError: { code: 'CLOSED_STATE_REACTION_ONLY' },
      hint: 'Plain Chant is not a Reaction, so the engine should refuse it.',
      explain: 'Only Reactions may be played while a Chain is active (Rule 309.1.a).',
    },
    {
      id: 'resolve',
      title: 'Resolve the chain',
      instruction: 'Press the highlighted **Pass** button until the chain is empty.',
      highlight: ['btn-pass'],
      gate: gates.types(['PASS_PRIORITY'], 'press Pass.'),
      opponentAuto: true,
      done: (ctx) => ctx.state.flow.chain.length === 0,
    },
  ],
  completionText: 'You saw the Closed State and resolved the Chain.',
};
```

(`lessons/lesson0-demo.ts` is the real, tested version of this.)

## Checklist before you finish

- `validateLesson(lesson)` (in `validate.ts`, run by the test suite for every registered lesson) returns `[]`.
- Add a test that **plays the lesson through the real `GameApi`** (see `tutorial.test.tsx`, "demo lesson"):
  create `new TutorialSession(lesson, { botDelayMs: 0 })`, drive `session.snapshot.api.send(...)`, call
  `await session.idle()` after sends, and assert `session.snapshot.status === 'finished'`.
- Try Skip and Reset step on every step in the browser (or in a test with `startStep`) to make sure the
  board stays consistent.
- Use `data-tutorial-id` ids only from the table above; need a new one? Add it to `client/src/game/**`
  (attribute only) and to `validate.ts` and this file.
