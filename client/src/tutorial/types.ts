/**
 * Data model for interactive tutorial lessons. See AUTHORING.md for a worked example.
 *
 * A lesson is plain data: a `setup` recipe that builds the starting board (through the REAL engine
 * plus state surgery) and an ordered list of steps. The runtime (sandbox.ts) runs the real engine;
 * steps only decide what the learner may do, what counts as done, and what the scripted opponent does.
 */
import type {
  CardDatabase,
  ClientGameState,
  DeckList,
  GameEvent,
  GameState,
  Intent,
  PlayerId,
  RuleError,
  RuleErrorCode,
  Sandbox,
} from '@riftbound/engine';
import type { GameApi } from '../app/gameApi';
import type { Kit } from './kit';

/** An intent as authors write it for the opponent: `playerId` is filled in. */
export type OpponentIntent = Intent extends infer I
  ? I extends Intent
    ? Omit<I, 'playerId'> & { playerId?: PlayerId }
    : never
  : never;

/** Where a card instance may be looked up (zone kinds of the engine). */
export type ZoneKind =
  | 'hand'
  | 'mainDeck'
  | 'runeDeck'
  | 'trash'
  | 'banishment'
  | 'base'
  | 'battlefield'
  | 'champion'
  | 'facedown'
  | 'legend'
  | 'chain';

export type Who = 'you' | 'opp';

/** Passed to `LessonDef.setup`. Mutate `sb` (it already is a real game in MAIN phase, turn 1, learner = p0). */
export interface SetupCtx {
  /** State surgery on the initial game. `sb.state` is what the lesson starts from. */
  sb: Sandbox;
  cards: CardDatabase;
  /** The learner's seat (always 'p0', deck A: Fury/Calm). */
  you: PlayerId;
  /** The scripted opponent's seat (always 'p1', deck B: Mind/Order). */
  opp: PlayerId;
  /** Card ids available in the default fixture decks, per side. */
  kit: { you: Kit; opp: Kit };
}

/** Everything a step can read or do. Created fresh for every callback; do not keep it. */
export interface StepCtx {
  /** The FULL authoritative state (tutorial only: includes the opponent's hidden zones). */
  readonly state: GameState;
  /** What the learner's UI sees (sanitised for `seat`). */
  readonly view: ClientGameState;
  readonly seat: PlayerId;
  readonly oppSeat: PlayerId;
  readonly cards: CardDatabase;
  /** Every intent the engine would accept from the learner right now (NOT narrowed by the step gate). */
  readonly legal: Intent[];
  /** Events produced since this step was entered (includes those from this step's onEnter), unfiltered. */
  readonly events: GameEvent[];
  /** The GameApi the UI is using (gate-filtered `legal`, gated `send`). */
  readonly api: GameApi;
  /** The learner's most recent engine refusal in this step (cleared by the next accepted intent or step change). */
  readonly lastError: RuleError | null;
  readonly stepIndex: number;
  readonly lessonId: string;

  /**
   * Apply an intent for the scripted opponent through the real reducer. Validated first: throws
   * (with the engine's message) if illegal, so a broken script fails loudly. `playerId` is optional.
   */
  opponent(intent: OpponentIntent): void;
  /** Opponent plays a card from hand: pass a definition id ('fx-tide-guard') or an instance id ('o79'). Payment is auto-planned from the legal list. */
  opponentPlay(card: string, opts?: { location?: 'base' | { battlefield: number } }): void;
  /**
   * Play a card for the LEARNER through the real reducer (for onSkip / scripted demonstrations).
   * Same lookup rules as opponentPlay. Throws if there is no legal way to play it.
   */
  youPlay(card: string, opts?: { location?: 'base' | { battlefield: number } }): void;
  /** Opponent passes priority. */
  opponentPass(): void;
  /** Opponent ends their turn (their Main Phase). */
  opponentEndTurn(): void;

  /**
   * State surgery on the running game (giveRunes, putInHand, putUnit, setPoints, setBattlefield, ...).
   * Every call is applied immediately and the UI re-renders; invariants are checked.
   */
  readonly surgery: Sandbox;

  /** Append a coach note under the instruction (cleared on step change). */
  say(text: string): void;

  // ---- lookups
  /** Instance id of the first card with this definition id owned by `who`, optionally restricted to zones. */
  find(cardId: string, who?: Who, zones?: ZoneKind[]): string | undefined;
  /** Instance ids of the units at battlefield index `i` (0-based, in `state.battlefields` order). */
  unitsAt(battlefieldIndex: number, who?: Who): string[];
  /** The battlefield at index `i`. */
  battlefield(index: number): GameState['battlefields'][number];
  /** Points of a player. */
  points(who?: Who): number;
  /** Instance id of every unit `who` has in play (base or battlefield), by definition id. */
  unitsInPlay(cardId: string, who?: Who): string[];
}

/** Restrict which intents the learner may send in a step. */
export interface GateRule {
  /** Return true to let the intent through to the real engine. */
  allow: (intent: Intent, ctx: StepCtx) => boolean;
  /** Shown as "Not yet: <blockedMessage>" when an intent is blocked. */
  blockedMessage?: string;
}

export type Gate = 'free' | GateRule;

export interface ExpectError {
  /** The learner must provoke this exact RuleErrorCode... */
  code?: RuleErrorCode;
  /** ...and/or an error whose message contains this text. Both given = both must hold. */
  messageIncludes?: string;
}

export interface StepDef {
  /** Unique within the lesson. */
  id: string;
  title: string;
  /** Minimal markdown: **bold**, `code`, blank line = new paragraph. */
  instruction: string;
  /**
   * What to spotlight: tutorial ids (see AUTHORING.md: 'hand', 'hand-card:fx-grunt', 'unit:fx-grunt',
   * 'battlefield:0', 'btn-pass', ...) or raw CSS selectors (anything starting with `[`, `.` or `#`).
   * A function may compute them from the live state (e.g. by instance id).
   */
  highlight?: string[] | ((ctx: StepCtx) => string[]);
  /** Which intents the learner may send. 'free' (default) lets everything reach the real engine. */
  gate?: Gate;
  /** Runs once when the step becomes current (and again on Reset step / Back). Script the opponent, do surgery, `say()`. */
  onEnter?: (ctx: StepCtx) => void;
  /**
   * Runs when the learner presses Skip, to put the board where completing the step would have left
   * it (otherwise later steps start from whatever state exists). Optional.
   */
  onSkip?: (ctx: StepCtx) => void;
  /**
   * Evaluated after every state update. Omit it (and expectError) for a read-only step with a
   * "Continue" button.
   */
  done?: (ctx: StepCtx) => boolean;
  /**
   * Teach by refusal: the step completes when the engine rejects the learner's intent with this
   * error. The exact engine text is shown as "The engine says: ...", then the learner presses Next.
   */
  expectError?: ExpectError;
  /** Shown after the step completes; when set (or for expectError) the learner presses Next instead of advancing immediately. */
  explain?: string;
  hint?: string;
  /** After `done`, wait this long, then advance by itself (0 = next tick). Overrides the Next button. */
  autoAdvanceMs?: number;
  /**
   * The scripted opponent passes priority / ends its turn by itself whenever the engine waits for it
   * (default true, after a short delay). Set false to hold the board (e.g. keep a chain item pending).
   */
  opponentAuto?: boolean;
}

export interface LessonDef {
  id: string;
  title: string;
  summary: string;
  /** Short paragraphs shown (collapsible) above the steps. Same minimal markdown as instructions. */
  concept: string[];
  /** Build the starting board. */
  setup: (ctx: SetupCtx) => void;
  steps: StepDef[];
  completionText: string;
  /** Placeholder lessons are listed but disabled with a "Coming soon" label. */
  comingSoon?: boolean;
  /** Override the card pool / decks (defaults: the FIXTURE cards and decks A (you) / B (opponent)). */
  cards?: CardDatabase;
  decks?: [DeckList, DeckList];
  /** Seed for the initial shuffle (default: the lesson id). */
  seed?: string;
  /** Default for every step's opponentAuto (default true). */
  opponentAuto?: boolean;
}

/** Where the runner is in a lesson. */
export type StepStatus = 'active' | 'complete' | 'finished';

/** What the UI renders; referentially stable until something changes. */
export interface SessionSnapshot {
  version: number;
  api: GameApi;
  lesson: LessonDef;
  stepIndex: number;
  /** undefined once finished. */
  step: StepDef | undefined;
  stepCount: number;
  status: StepStatus;
  /** Indices of steps completed (not skipped). */
  completedSteps: number[];
  highlight: string[];
  lastError: RuleError | null;
  /** "Not yet: ..." text from the last blocked intent. */
  blockedMessage: string | null;
  /** True when the current step's expectError was satisfied. */
  errorExpected: boolean;
  hintShown: boolean;
  notes: string[];
  canBack: boolean;
  /** Manual (Continue) step: no done/expectError. */
  manual: boolean;
}
