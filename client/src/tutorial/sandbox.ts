/**
 * Tutorial runtime: a REAL local engine game (createLocalGameApi, no AI bot) wrapped in a lesson
 * state machine.
 *
 *   const session = new TutorialSession(lesson, { botDelayMs: 500 });
 *   session.subscribe(listener); session.getSnapshot();     // useSyncExternalStore-ready
 *   session.snapshot.api                                    // the GameApi to hand to <GameProvider>
 *
 * What the wrapper does on top of the plain local game:
 *  - `api.legal` is narrowed by the current step's gate; `api.send` of a gated-out intent never
 *    reaches the engine: a "Not yet: ..." toast is shown and `{ ok: true }` is returned (so the
 *    board UI does not add a second, misleading rule-error toast).
 *  - 'free' steps send straight to the engine; its refusals come back as the real RuleError and are
 *    remembered as `lastError` (what `done` / `expectError` look at).
 *  - after every state update the current step's `done` is evaluated and the lesson advances.
 *  - the scripted opponent only acts through `ctx.opponent*`; when it merely has to pass priority /
 *    end its turn to keep the game moving, an autopilot does that after a short delay (per step
 *    switchable with `opponentAuto: false`).
 *  - snapshots of the state at the start of every step make Reset step / Back exact.
 */
import {
  actorToAct,
  checkInvariants,
  getLegalActions,
  opponentOf,
  reduce,
  sanitizeEvents,
  Sandbox,
} from '@riftbound/engine';
import type {
  CardDatabase,
  GameEvent,
  GameState,
  Intent,
  PlayerId,
  RuleError,
} from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import type { GameApi } from '../app/gameApi';
import { createLocalGameApi, type LocalGame } from '../dev/mockGame';
import { pushToast } from '../store/gameStore';
import { KIT_OPP, KIT_YOU } from './kit';
import type {
  ExpectError,
  LessonDef,
  OpponentIntent,
  SessionSnapshot,
  StepCtx,
  StepDef,
  StepStatus,
  Who,
  ZoneKind,
} from './types';

export const LEARNER: PlayerId = 'p0';
export const SCRIPTED_OPPONENT: PlayerId = 'p1';

export interface SessionOptions {
  /** Pause before the autopilot opponent acts (default 500 ms; 0 in tests). */
  botDelayMs?: number;
  /** Throw out of scripts when an opponent intent is illegal (default: true in dev/test builds). */
  strict?: boolean;
  /** Start at this step (tests / resume). */
  startStep?: number;
  /** Called when the last step is completed. */
  onFinish?: (lesson: LessonDef) => void;
  /** Called whenever a step is completed (not skipped). */
  onStepComplete?: (lesson: LessonDef, stepIndex: number) => void;
}

/** The lesson's initial real GameState: real setup, mulligans kept, then `lesson.setup` surgery. */
export function buildLessonState(lesson: LessonDef): { state: GameState; cards: CardDatabase } {
  const cards = lesson.cards ?? FIXTURE_CARDS;
  const decks = lesson.decks ?? [FIXTURE_DECK_A, FIXTURE_DECK_B];
  const sb = Sandbox.create(cards, decks, { seed: lesson.seed ?? lesson.id });
  lesson.setup({
    sb,
    cards,
    you: LEARNER,
    opp: SCRIPTED_OPPONENT,
    kit: { you: KIT_YOU, opp: KIT_OPP },
  });
  sb.verify();
  return { state: sb.state, cards };
}

/** Does `err` satisfy an expectError spec? */
export function errorMatches(err: RuleError | null, expect: ExpectError): boolean {
  if (!err) return false;
  if (expect.code !== undefined && err.code !== expect.code) return false;
  if (expect.messageIncludes !== undefined && !err.message.includes(expect.messageIncludes)) {
    return false;
  }
  return true;
}

const num = (id: string): number => Number(id.slice(1));

/** First legal PLAY_CARD of `seat` for a card (instance id or definition id), optionally at a location. */
function findPlay(
  s: GameState,
  cards: CardDatabase,
  seat: PlayerId,
  card: string,
  o?: { location?: 'base' | { battlefield: number } },
): Extract<Intent, { type: 'PLAY_CARD' }> | undefined {
  return getLegalActions(s, cards, seat).find((i): i is Extract<Intent, { type: 'PLAY_CARD' }> => {
    if (i.type !== 'PLAY_CARD') return false;
    const obj = s.objects[i.cardInstanceId];
    if (!obj) return false;
    if (i.cardInstanceId !== card && obj.cardId !== card) return false;
    if (!o?.location) return true;
    if (o.location === 'base') return i.location?.kind === 'base';
    const bf = s.battlefields[o.location.battlefield];
    return i.location?.kind === 'battlefield' && i.location.battlefieldId === bf?.id;
  });
}
const MAX_EVENTS = 200;

export class TutorialSession {
  readonly lesson: LessonDef;
  readonly cards: CardDatabase;
  readonly seat: PlayerId = LEARNER;
  readonly oppSeat: PlayerId = opponentOf(LEARNER);

  private local!: LocalGame;
  private unsubLocal: (() => void) | null = null;
  private readonly initial: GameState;
  private snapshots: GameState[] = [];
  private stepIndex = 0;
  private status: StepStatus = 'active';
  private completed = new Set<number>();
  private lastError: RuleError | null = null;
  private blocked: string | null = null;
  private errorExpected = false;
  private hintShown = false;
  private notes: string[] = [];
  private stepEvents: GameEvent[] = [];
  private allEvents: GameEvent[] = [];
  private version = 0;
  private cache: SessionSnapshot | null = null;
  private listeners = new Set<() => void>();
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private advanceTimer: ReturnType<typeof setTimeout> | null = null;
  private entering = false;
  private evaluating = false;
  private disposed = false;
  private readonly delay: number;
  private readonly strict: boolean;
  private surgeryProxy: Sandbox | null = null;
  /** Errors thrown by lesson scripts in non-strict mode (so a broken lesson does not crash the UI). */
  readonly scriptErrors: string[] = [];

  constructor(
    lesson: LessonDef,
    private readonly opts: SessionOptions = {},
  ) {
    if (lesson.comingSoon) throw new Error(`lesson ${lesson.id} is marked comingSoon`);
    this.lesson = lesson;
    const built = buildLessonState(lesson);
    this.cards = built.cards;
    this.initial = structuredClone(built.state);
    this.delay = opts.botDelayMs ?? 500;
    this.strict = opts.strict ?? import.meta.env.DEV;
    this.attach(built.state);
    this.enterStep(Math.max(0, opts.startStep ?? 0));
    this.evaluate();
    this.scheduleAutopilot();
  }

  // ------------------------------------------------------------------ store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SessionSnapshot => {
    this.cache ??= this.buildSnapshot();
    return this.cache;
  };

  get snapshot(): SessionSnapshot {
    return this.getSnapshot();
  }

  /** The authoritative state (tests). */
  getState(): GameState {
    return this.local.getState();
  }

  /** Resolves once the autopilot / auto-advance timers have nothing left to do (tests). */
  async idle(): Promise<void> {
    for (let n = 0; n < 500 && (this.autoTimer || this.advanceTimer); n++) {
      await new Promise((r) => setTimeout(r, Math.max(1, this.delay)));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.unsubLocal?.();
    this.local.stop();
    this.listeners.clear();
  }

  private emit(): void {
    this.cache = null;
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  // ------------------------------------------------------------------ underlying game

  /** (Re)creates the local game around `state`; used at start, after surgery, on reset/back. */
  private attach(state: GameState): void {
    this.unsubLocal?.();
    this.local?.stop();
    this.local = createLocalGameApi({
      cards: this.cards,
      state,
      seat: this.seat,
      botDelayMs: 0,
      onCommit: (info) => {
        this.allEvents = [...this.allEvents, ...info.events].slice(-MAX_EVENTS);
        this.stepEvents = [...this.stepEvents, ...info.events];
      },
    });
    this.unsubLocal = this.local.subscribe(this.afterCommit);
  }

  private replaceState(state: GameState): void {
    this.attach(state);
    this.cache = null;
  }

  private afterCommit = (): void => {
    this.cache = null;
    if (this.entering || this.disposed) return;
    this.evaluate();
    this.scheduleAutopilot();
    this.emit();
  };

  // ------------------------------------------------------------------ context for lesson code

  private step(): StepDef | undefined {
    return this.lesson.steps[this.stepIndex];
  }

  private ctx(): StepCtx {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const who = (w: Who): PlayerId => (w === 'you' ? self.seat : self.oppSeat);
    const state = () => self.local.getState();
    const apply = (intent: OpponentIntent): void => {
      const full = { ...intent, playerId: self.oppSeat } as Intent;
      const r = reduce(state(), self.cards, full);
      if (!r.ok) {
        throw new Error(
          `tutorial script: scripted opponent intent ${full.type} is illegal: ${r.message}`,
        );
      }
      void self.local.sendAs(self.oppSeat, full); // commits synchronously
    };
    const playFor = (
      seat: PlayerId,
      card: string,
      o?: { location?: 'base' | { battlefield: number } },
    ): void => {
      const pick = findPlay(state(), self.cards, seat, card, o);
      if (!pick) {
        throw new Error(`tutorial script: ${seat} has no legal way to play ${card} now`);
      }
      apply(pick);
    };
    const ctx: StepCtx = {
      get state() {
        return state();
      },
      get view() {
        return self.local.api.view;
      },
      seat: self.seat,
      oppSeat: self.oppSeat,
      cards: self.cards,
      get legal() {
        return self.local.api.legal;
      },
      get events() {
        return self.stepEvents;
      },
      get api() {
        return self.getSnapshot().api;
      },
      get lastError() {
        return self.lastError;
      },
      get stepIndex() {
        return self.stepIndex;
      },
      lessonId: self.lesson.id,
      opponent: apply,
      opponentPlay(card, o) {
        playFor(self.oppSeat, card, o);
      },
      youPlay(card, o) {
        const s = state();
        const pick = findPlay(s, self.cards, self.seat, card, o);
        if (!pick) throw new Error(`tutorial script: you have no legal way to play ${card} now`);
        const r = reduce(s, self.cards, pick);
        if (!r.ok) throw new Error(`tutorial script: ${r.message}`);
        void self.local.sendAs(self.seat, pick);
      },
      opponentPass() {
        apply({ type: 'PASS_PRIORITY' });
      },
      opponentEndTurn() {
        apply({ type: 'END_TURN' });
      },
      get surgery() {
        return self.makeSurgery();
      },
      say(text) {
        self.notes = [...self.notes, text];
        self.cache = null;
      },
      find(cardId, w = 'you', zones?: ZoneKind[]) {
        return Object.values(state().objects)
          .filter(
            (o) =>
              o.cardId === cardId &&
              o.controller === who(w) &&
              (!zones || zones.includes(o.zone.kind)),
          )
          .sort((a, b) => num(a.id) - num(b.id))[0]?.id;
      },
      unitsAt(i, w) {
        const bf = state().battlefields[i];
        if (!bf) return [];
        return Object.values(state().objects)
          .filter(
            (o) =>
              o.zone.kind === 'battlefield' &&
              o.zone.battlefieldId === bf.id &&
              (w === undefined || o.controller === who(w)),
          )
          .sort((a, b) => num(a.id) - num(b.id))
          .map((o) => o.id);
      },
      battlefield(i) {
        const bf = state().battlefields[i];
        if (!bf) throw new Error(`no battlefield at index ${i}`);
        return bf;
      },
      points(w = 'you') {
        return state().players[who(w) === 'p0' ? 0 : 1]!.points;
      },
      unitsInPlay(cardId, w = 'you') {
        return Object.values(state().objects)
          .filter(
            (o) =>
              o.cardId === cardId &&
              o.controller === who(w) &&
              (o.zone.kind === 'base' || o.zone.kind === 'battlefield') &&
              self.cards[o.cardId]?.type === 'UNIT',
          )
          .sort((a, b) => num(a.id) - num(b.id))
          .map((o) => o.id);
      },
    };
    return ctx;
  }

  /** A Sandbox facade over the running game: every mutating call is applied (and verified) at once. */
  private makeSurgery(): Sandbox {
    if (this.surgeryProxy) return this.surgeryProxy;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const target = new Sandbox(this.local.getState(), this.cards);
    const proxy: Sandbox = new Proxy(target, {
      get(t, prop) {
        if (prop === 'state') return self.local.getState();
        const v: unknown = Reflect.get(t, prop);
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          t.state = self.local.getState();
          const before = t.state;
          const out: unknown = (v as (...a: unknown[]) => unknown).apply(t, args);
          if (t.state !== before) {
            const bad = checkInvariants(t.state, self.cards);
            if (bad.length > 0) throw new Error(`invariant violations:\n  - ${bad.join('\n  - ')}`);
            self.replaceState(t.state);
          }
          return out === t ? proxy : out;
        };
      },
    });
    this.surgeryProxy = proxy;
    return proxy;
  }

  // ------------------------------------------------------------------ gating & sending

  private gateAllows(intent: Intent, step: StepDef | undefined, ctx: StepCtx): boolean {
    const gate = step?.gate ?? 'free';
    return gate === 'free' ? true : gate.allow(intent, ctx);
  }

  private block(message: string): void {
    this.blocked = message;
    pushToast(`Not yet: ${message}`);
    this.emit();
  }

  private async send(intent: Intent): Promise<{ ok: true } | RuleError> {
    const step = this.step();
    if (this.disposed || this.status === 'finished' || !step) {
      return this.local.api.send(intent);
    }
    if (this.status === 'complete') {
      this.block('press Next to continue.');
      return { ok: true };
    }
    const gate = step.gate ?? 'free';
    if (gate !== 'free' && !gate.allow(intent, this.ctx())) {
      this.block(gate.blockedMessage ?? 'that is not part of this step.');
      return { ok: true };
    }
    this.blocked = null;
    this.lastError = null;
    const r = await this.local.api.send(intent);
    if (!r.ok) {
      this.lastError = r;
      this.evaluate();
      this.emit();
    }
    return r;
  }

  // ------------------------------------------------------------------ step machine

  private evaluate(): void {
    if (this.evaluating || this.disposed) return;
    this.evaluating = true;
    try {
      for (let guard = 0; guard < 50 && this.status === 'active'; guard++) {
        const step = this.step();
        if (!step) break;
        const ctx = this.ctx();
        if (
          step.expectError &&
          !this.errorExpected &&
          errorMatches(this.lastError, step.expectError)
        ) {
          this.errorExpected = true;
        }
        const gateOk = step.expectError ? this.errorExpected : true;
        if (!step.expectError && !step.done) break; // manual: waits for next()
        if (!(gateOk && (step.done ? this.guarded(() => step.done!(ctx), false) : true))) break;
        this.finishStep();
      }
    } finally {
      this.evaluating = false;
    }
  }

  private guarded<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      if (this.strict) throw e;
      this.scriptErrors.push(String(e));
      console.error(e);
      return fallback;
    }
  }

  /** Marks the current step completed and either pauses (Next button / timer) or moves on. */
  private finishStep(): void {
    const i = this.stepIndex;
    const step = this.lesson.steps[i];
    if (!step) return;
    this.completed.add(i);
    this.status = 'complete';
    this.opts.onStepComplete?.(this.lesson, i);
    if (step.autoAdvanceMs !== undefined) {
      this.advanceTimer = setTimeout(() => {
        this.advanceTimer = null;
        if (this.disposed || this.stepIndex !== i || this.status !== 'complete') return;
        this.enterStep(i + 1);
        this.evaluate();
        this.scheduleAutopilot();
        this.emit();
      }, step.autoAdvanceMs);
      return;
    }
    if (step.expectError || step.explain) return; // wait for the learner's Next
    this.enterStep(i + 1);
  }

  /** Makes step `i` current (i >= steps.length finishes the lesson). `restore` rewinds the game first. */
  private enterStep(i: number, restore?: GameState): void {
    this.clearTimers();
    if (restore) this.replaceState(structuredClone(restore));
    this.stepIndex = i;
    this.lastError = null;
    this.blocked = null;
    this.errorExpected = false;
    this.hintShown = false;
    this.notes = [];
    this.stepEvents = [];
    this.cache = null;
    if (i >= this.lesson.steps.length) {
      this.status = 'finished';
      this.opts.onFinish?.(this.lesson);
      return;
    }
    this.status = 'active';
    if (!restore || !this.snapshots[i]) this.snapshots[i] = structuredClone(this.local.getState());
    const step = this.lesson.steps[i]!;
    this.entering = true;
    try {
      this.guarded(() => step.onEnter?.(this.ctx()), undefined);
    } finally {
      this.entering = false;
    }
  }

  private clearTimers(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    if (this.advanceTimer) clearTimeout(this.advanceTimer);
    this.autoTimer = null;
    this.advanceTimer = null;
  }

  // ------------------------------------------------------------------ scripted opponent autopilot

  private autoWanted(): boolean {
    const s = this.local.getState();
    if (this.disposed || s.gameStatus !== 'IN_PROGRESS' || this.status === 'finished') return false;
    const step = this.step();
    const auto = step?.opponentAuto ?? this.lesson.opponentAuto ?? true;
    return auto && actorToAct(s) === this.oppSeat;
  }

  private scheduleAutopilot(): void {
    if (this.autoTimer || !this.autoWanted()) return;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null;
      if (!this.autoWanted()) return;
      const legal = getLegalActions(this.local.getState(), this.cards, this.oppSeat).filter(
        (i) => i.type !== 'CONCEDE' && i.type !== 'MULLIGAN',
      );
      const pick =
        legal.find((i) => i.type === 'PASS_PRIORITY') ??
        legal.find((i) => i.type === 'END_TURN') ??
        legal[0];
      if (pick) void this.local.sendAs(this.oppSeat, pick); // afterCommit re-schedules
    }, this.delay);
  }

  // ------------------------------------------------------------------ learner controls

  /** Continue a read-only step, or move on from a completed step ("Next"). */
  next(): void {
    if (this.disposed) return;
    if (this.status === 'complete') {
      this.enterStep(this.stepIndex + 1);
    } else if (this.status === 'active') {
      const step = this.step();
      if (!step || step.done || step.expectError) return; // must be earned
      this.finishStep();
    } else {
      return;
    }
    this.evaluate();
    this.scheduleAutopilot();
    this.emit();
  }

  /** Advance without completing the step; `onSkip` may fix up the board. */
  skip(): void {
    if (this.disposed || this.status === 'finished') return;
    const step = this.step();
    if (step && this.status === 'active') {
      this.entering = true;
      try {
        this.guarded(() => step.onSkip?.(this.ctx()), undefined);
      } finally {
        this.entering = false;
      }
    }
    this.enterStep(this.stepIndex + 1);
    this.evaluate();
    this.scheduleAutopilot();
    this.emit();
  }

  /** Go back one step, restoring the board as it was when that step began. */
  back(): void {
    if (this.disposed || this.stepIndex <= 0) return;
    const to = this.stepIndex - 1;
    const snap = this.snapshots[to];
    for (const k of [...this.completed]) if (k >= to) this.completed.delete(k);
    this.enterStep(to, snap);
    this.evaluate();
    this.scheduleAutopilot();
    this.emit();
  }

  /** Restore the board to the start of the current step and re-run its onEnter. */
  resetStep(): void {
    if (this.disposed) return;
    const i = Math.min(this.stepIndex, this.lesson.steps.length - 1);
    for (const k of [...this.completed]) if (k >= i) this.completed.delete(k);
    this.enterStep(i, this.snapshots[i]);
    this.evaluate();
    this.scheduleAutopilot();
    this.emit();
  }

  resetLesson(): void {
    if (this.disposed) return;
    this.completed.clear();
    this.snapshots = [];
    this.allEvents = [];
    this.enterStep(0, this.initial);
    this.evaluate();
    this.scheduleAutopilot();
    this.emit();
  }

  showHint(): void {
    this.hintShown = true;
    this.emit();
  }

  // ------------------------------------------------------------------ snapshot for the UI

  private highlightIds(step: StepDef | undefined): string[] {
    if (!step?.highlight) return [];
    if (this.status === 'finished') return [];
    return Array.isArray(step.highlight)
      ? step.highlight
      : this.guarded(() => (step.highlight as (c: StepCtx) => string[])(this.ctx()), []);
  }

  private buildSnapshot(): SessionSnapshot {
    const base = this.local.api;
    const step = this.step();
    const ctx = this.ctx();
    const legal =
      this.status === 'active' && step
        ? base.legal.filter((i) => this.guarded(() => this.gateAllows(i, step, ctx), false))
        : this.status === 'finished'
          ? base.legal
          : [];
    const api: GameApi = {
      ...base,
      legal,
      recentEvents: sanitizeEvents(this.allEvents.slice(-40), this.seat),
      send: (intent) => this.send(intent),
    };
    return {
      version: this.version,
      api,
      lesson: this.lesson,
      stepIndex: this.stepIndex,
      step,
      stepCount: this.lesson.steps.length,
      status: this.status,
      completedSteps: [...this.completed].sort((a, b) => a - b),
      highlight: this.status === 'complete' ? [] : this.highlightIds(step),
      lastError: this.lastError,
      blockedMessage: this.blocked,
      errorExpected: this.errorExpected,
      hintShown: this.hintShown,
      notes: this.notes,
      canBack: this.stepIndex > 0,
      manual: !!step && !step.done && !step.expectError,
    };
  }
}
