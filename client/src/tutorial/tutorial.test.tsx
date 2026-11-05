// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { stateHash } from '@riftbound/engine';
import type { Intent } from '@riftbound/engine';
import { getState, setState } from '../store/gameStore';
import { gates } from './gates';
import { LESSONS } from './lessons';
import { LESSON_0_DEMO } from './lessons/lesson0-demo';
import { clearProgress, loadProgress, markCompleted } from './progress';
import { TutorialSession } from './sandbox';
import { findTargets, Spotlight } from './Spotlight';
import { TutorialApp } from './TutorialApp';
import type { LessonDef } from './types';
import { validateLesson } from './validate';

beforeEach(() => {
  clearProgress();
  setState({ toasts: [] });
});
afterEach(() => cleanup());

const mk = (lesson: LessonDef, startStep = 0, extra: { onFinish?: () => void } = {}) =>
  new TutorialSession(lesson, { botDelayMs: 0, startStep, ...extra });

type Play = Extract<Intent, { type: 'PLAY_CARD' }>;
const legalOf = (s: TutorialSession) => s.snapshot.api.legal;

/** The first legal PLAY_CARD for a card definition id (optionally restricted to base). */
function playOf(s: TutorialSession, cardId: string): Play | undefined {
  return legalOf(s).find(
    (i): i is Play =>
      i.type === 'PLAY_CARD' && s.getState().objects[i.cardInstanceId]?.cardId === cardId,
  );
}

async function send(s: TutorialSession, intent: Intent) {
  const r = await s.snapshot.api.send(intent);
  await s.idle();
  return r;
}

/** A tiny lesson with a free gate, an expectError step and a manual step, on the fixture board. */
const MACHINE: LessonDef = {
  id: 'test-machine',
  title: 'Machine',
  summary: 's',
  concept: ['c'],
  completionText: 'done',
  setup: ({ sb, you, opp }) => {
    sb.clearHand(you);
    sb.putInHand(you, 'fx-titan'); // costs 5: unaffordable without runes
    sb.putInHand(you, 'fx-grunt');
    sb.giveRunes(you, 3, 'Fury');
    sb.setPoints(you, 1);
    sb.putInHand(opp, 'fx-tide-grunt');
  },
  steps: [
    {
      id: 'free-error',
      title: 'Free step',
      instruction: 'Try the Titan.',
      gate: 'free',
      onEnter: (ctx) => ctx.say('entered'),
      done: (ctx) => ctx.lastError?.code === 'INSUFFICIENT_RESOURCES',
    },
    {
      id: 'expect',
      title: 'Expect',
      instruction: 'Play a card you do not own.',
      expectError: { code: 'NOT_IN_HAND' },
      gate: gates.custom(() => true),
    },
    {
      id: 'manual',
      title: 'Manual',
      instruction: 'Read.',
      gate: gates.none('just read.'),
      onSkip: (ctx) => ctx.surgery.setPoints(ctx.seat, 5),
    },
  ],
};

describe('step runner state machine', () => {
  it('free steps send to the real engine and surface its rule error, which completes the step', async () => {
    const s = mk(MACHINE);
    const titan = s
      .getState()
      .players[0].hand.find((id) => s.getState().objects[id]!.cardId === 'fx-titan')!;
    expect(s.snapshot.status).toBe('active');
    expect(s.snapshot.notes).toEqual(['entered']);
    const r = await send(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: titan,
      payment: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INSUFFICIENT_RESOURCES');
      expect(r.message).toContain('[Rule Error]');
    }
    // done() saw ctx.lastError and the lesson moved on to the expectError step
    expect(s.snapshot.stepIndex).toBe(1);
    expect(s.snapshot.completedSteps).toEqual([0]);
  });

  it('expectError completes only on the matching error, shows the engine text, then waits for Next', async () => {
    const s = mk(MACHINE, 1);
    const hand = s.getState().players[0].hand;
    const gruntId = hand.find((id) => s.getState().objects[id]!.cardId === 'fx-grunt')!;
    // a different refusal (wrong phase style): paying with a made-up rune -> not the expected code
    const first = await send(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: gruntId,
      location: { kind: 'base' },
      payment: [{ runeId: 'o99999', mode: 'EXHAUST' }],
    });
    expect(first.ok).toBe(false);
    expect(s.snapshot.lastError).not.toBeNull();
    expect(s.snapshot.lastError!.code).not.toBe('NOT_IN_HAND');
    expect(s.snapshot.status).toBe('active');
    expect(s.snapshot.errorExpected).toBe(false);

    // the opponent's card is not in YOUR hand
    const oppCard = s.getState().players[1].hand[0]!;
    const second = await send(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: oppCard,
      location: { kind: 'base' },
      payment: [],
    });
    expect(second.ok).toBe(false);
    expect(s.snapshot.status).toBe('complete');
    expect(s.snapshot.errorExpected).toBe(true);
    expect(s.snapshot.stepIndex).toBe(1); // paused for the learner to read the engine text
    expect(s.snapshot.lastError!.message).toContain('[Rule Error]');
    s.next();
    expect(s.snapshot.stepIndex).toBe(2);
    expect(s.snapshot.lastError).toBeNull();
  });

  it('a gated intent never reaches the engine, shows "Not yet:", and is hidden from legal', async () => {
    const s = mk(MACHINE, 2);
    const before = stateHash(s.getState());
    expect(legalOf(s)).toEqual([]);
    const r = await s.snapshot.api.send({ type: 'END_TURN', playerId: 'p0' });
    expect(r).toEqual({ ok: true }); // swallowed: no second rule-error toast from the board UI
    expect(stateHash(s.getState())).toBe(before);
    expect(s.snapshot.blockedMessage).toBe('just read.');
    expect(getState().toasts.some((t) => t.text === 'Not yet: just read.')).toBe(true);
  });

  it('manual steps need Continue; done steps cannot be skipped over with next()', () => {
    const s = mk(MACHINE, 2);
    expect(s.snapshot.manual).toBe(true);
    s.next();
    expect(s.snapshot.status).toBe('finished');
    const t = mk(MACHINE, 0);
    t.next(); // step 0 has a done(): must be earned
    expect(t.snapshot.stepIndex).toBe(0);
  });

  it('reset step restores the board as it was when the step began', async () => {
    const s = mk(LESSON_0_DEMO, 1);
    const start = stateHash(s.getState());
    const play = playOf(s, 'fx-grunt')!;
    expect(play).toBeDefined();
    expect((await s.snapshot.api.send(play)).ok).toBe(true);
    expect(stateHash(s.getState())).not.toBe(start);
    s.resetStep();
    expect(stateHash(s.getState())).toBe(start);
    expect(s.snapshot.stepIndex).toBe(1);
    expect(playOf(s, 'fx-grunt')).toBeDefined();
  });

  it('reset step re-runs onEnter on a restored board (the scripted opponent reply is replayed)', async () => {
    const s = mk(LESSON_0_DEMO, 2);
    await send(s, playOf(s, 'fx-flare')!);
    expect(s.snapshot.step?.id).toBe('closed-state');
    expect(s.getState().flow.chain.length).toBe(2);
    const hash = stateHash(s.getState());
    s.resetStep();
    expect(s.snapshot.step?.id).toBe('closed-state');
    expect(stateHash(s.getState())).toBe(hash);
  });

  it('skipping into later steps keeps the board consistent through onSkip', () => {
    const s = mk(LESSON_0_DEMO, 1);
    s.skip(); // play-unit skipped: onSkip puts a Grunt in play
    expect(s.snapshot.step?.id).toBe('cast-spell');
    expect(s.snapshot.completedSteps).toEqual([]);
    s.skip(); // cast-spell skipped: onSkip casts Flare Bolt, then closed-state's onEnter reacts
    expect(s.snapshot.step?.id).toBe('closed-state');
    expect(s.getState().flow.chain.length).toBe(2);
  });

  it('skip advances without completing (and runs onSkip); back restores the previous step board', () => {
    const s = mk(MACHINE, 2);
    s.skip();
    expect(s.snapshot.status).toBe('finished');
    expect(s.snapshot.completedSteps).toEqual([]);
    expect(s.getState().players[0].points).toBe(5);

    const t = mk(MACHINE, 0);
    t.skip();
    expect(t.snapshot.stepIndex).toBe(1);
    expect(t.snapshot.completedSteps).toEqual([]);
    t.back();
    expect(t.snapshot.stepIndex).toBe(0);
    expect(t.snapshot.canBack).toBe(false);
  });

  it('script errors from an illegal opponent intent throw in strict mode', () => {
    const bad: LessonDef = {
      ...MACHINE,
      id: 'bad',
      steps: [
        {
          id: 'x',
          title: 'x',
          instruction: 'x',
          onEnter: (ctx) => ctx.opponent({ type: 'END_TURN' }), // not the opponent's turn
        },
      ],
    };
    expect(() => new TutorialSession(bad, { botDelayMs: 0, strict: true })).toThrow(/illegal/);
    const lenient = new TutorialSession(bad, { botDelayMs: 0, strict: false });
    expect(lenient.scriptErrors.length).toBe(1);
  });

  it('surgery from onEnter keeps the engine invariants and is visible in the view', () => {
    const lesson: LessonDef = {
      ...MACHINE,
      id: 'surg',
      steps: [
        {
          id: 's',
          title: 's',
          instruction: 's',
          onEnter: (ctx) => {
            ctx.surgery.setPoints(ctx.seat, 3).putUnit(ctx.seat, 'fx-ash-tank', 'base');
          },
        },
      ],
    };
    const s = mk(lesson);
    expect(s.snapshot.api.view.players.find((p) => p.id === 'p0')!.points).toBe(3);
    expect(
      Object.values(s.snapshot.api.view.objects).some(
        (o) => 'cardId' in o && o.cardId === 'fx-ash-tank' && o.zone.kind === 'base',
      ),
    ).toBe(true);
  });
});

describe('demo lesson', () => {
  it('can be completed by driving the real GameApi through every step', async () => {
    const finished = vi.fn();
    const s = mk(LESSON_0_DEMO, 0, { onFinish: finished });
    const titles: string[] = [];
    const seen = () => titles.push(s.snapshot.step?.id ?? 'finished');

    // 0 look (read-only)
    seen();
    expect(s.snapshot.manual).toBe(true);
    s.next();

    // 1 play-unit: choose the base variant
    seen();
    const play = legalOf(s).find(
      (i): i is Play =>
        i.type === 'PLAY_CARD' &&
        s.getState().objects[i.cardInstanceId]!.cardId === 'fx-grunt' &&
        i.location?.kind === 'base',
    )!;
    expect(play).toBeDefined();
    expect((await send(s, play)).ok).toBe(true);
    for (let n = 0; n < 4 && s.snapshot.status === 'active'; n++) {
      if (legalOf(s).some((i) => i.type === 'PASS_PRIORITY')) {
        await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
      }
    }
    expect(s.snapshot.status).toBe('complete'); // has an explain: waits for Next
    s.next();

    // 2 cast-spell -> advances straight into 3 closed-state (scripted opponent reaction)
    seen();
    const flare = playOf(s, 'fx-flare')!;
    expect(flare).toBeDefined();
    expect((await send(s, flare)).ok).toBe(true);
    expect(s.snapshot.step?.id).toBe('closed-state');
    expect(s.getState().flow.chain.length).toBe(2);
    expect(s.getState().flow.priority).toBe('p0');

    // 3 closed-state: expectError
    seen();
    expect(playOf(s, 'fx-plain-spell')).toBeUndefined(); // not legal in a Closed State
    const plainId = s
      .getState()
      .players[0].hand.find((id) => s.getState().objects[id]!.cardId === 'fx-plain-spell')!;
    const r = await send(s, {
      type: 'PLAY_CARD',
      playerId: 'p0',
      cardInstanceId: plainId,
      payment: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CLOSED_STATE_REACTION_ONLY');
    expect(s.snapshot.status).toBe('complete');
    s.next();

    // 4 resolve
    seen();
    for (let n = 0; n < 6 && s.snapshot.step?.id === 'resolve'; n++) {
      await send(s, { type: 'PASS_PRIORITY', playerId: 'p0' });
    }
    expect(s.snapshot.step?.id).toBe('end-turn');

    // 5 end turn
    seen();
    await send(s, { type: 'END_TURN', playerId: 'p0' });
    expect(s.snapshot.status).toBe('finished');
    expect(finished).toHaveBeenCalledTimes(1);
    expect(s.snapshot.completedSteps).toEqual([0, 1, 2, 3, 4, 5]);
    expect(titles).toEqual([
      'look',
      'play-unit',
      'cast-spell',
      'closed-state',
      'resolve',
      'end-turn',
    ]);
    s.dispose();
  });

  it('is a valid lesson, as is every non-placeholder lesson in the registry', () => {
    for (const lesson of LESSONS) expect(validateLesson(lesson), lesson.id).toEqual([]);
  });
});

describe('registry and lesson list', () => {
  it('has the demo first, then the six lessons in order, all playable, with unique ids', () => {
    expect(LESSONS[0]!.id).toBe('lesson0-demo');
    expect(LESSONS.slice(1).map((l) => l.title)).toEqual([
      'The Turn Structure',
      'Resources: Energy and Power',
      'Zones and Movement',
      'The Chain: Open and Closed States',
      'Showdowns and Combat Might',
      'Victory and the Final Point Rule',
    ]);
    expect(LESSONS.filter((l) => l.comingSoon)).toEqual([]);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
  });

  it('shows comingSoon lessons disabled with a label, and playable ones with Start', () => {
    const lessons = [LESSONS[0]!, { ...LESSONS[1]!, comingSoon: true }];
    render(<TutorialApp onExit={() => undefined} lessons={lessons} />);
    const list = screen.getByRole('list', { name: 'Lessons' });
    expect(within(list).getAllByText('Coming soon')).toHaveLength(1);
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Start Meet the board' })).toBeEnabled();
    const row = list.querySelector('[data-lesson-id="lesson1-turn-structure"]')!;
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(within(row as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('persists completion in localStorage and shows Review for completed lessons', () => {
    expect(loadProgress().size).toBe(0);
    markCompleted('lesson0-demo');
    expect([...loadProgress()]).toEqual(['lesson0-demo']);
    render(<TutorialApp onExit={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Review Meet the board' })).toBeInTheDocument();
    expect(screen.getByText('(completed)')).toBeInTheDocument();
  });

  it('survives unavailable storage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadProgress().size).toBe(0);
    expect(() => markCompleted('x')).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });
});

describe('spotlight', () => {
  it('finds elements by tutorial id and raw selector, outlines them, and never blocks clicks', () => {
    const rect = {
      left: 10,
      top: 20,
      width: 100,
      height: 50,
      right: 110,
      bottom: 70,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    };
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(rect as DOMRect);
    const onClick = vi.fn();
    render(
      <div>
        <button data-tutorial-id="btn-pass" onClick={onClick}>
          Pass
        </button>
        <div data-tutorial-id="hand-card:fx-grunt" />
        <div className="plain" />
        <Spotlight ids={['btn-pass', 'hand-card:fx-grunt', '.plain', 'nope']} version={0} />
      </div>,
    );
    expect(findTargets(['btn-pass', '.plain'])).toHaveLength(2);
    expect(findTargets(['nope'])).toHaveLength(0);
    const layer = screen.getByTestId('spotlight');
    expect(layer).toHaveStyle({ pointerEvents: 'none' });
    expect(layer.className).toContain('pointer-events-none');
    expect(screen.getAllByTestId('spotlight-box')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('renders nothing without ids', () => {
    render(<Spotlight ids={[]} version={0} />);
    expect(screen.queryByTestId('spotlight')).toBeNull();
  });
});

describe('lesson runner UI', () => {
  it('walks the demo in the browser DOM: instruction card, spotlight, blocked callout, engine callout, completion', async () => {
    const rect = {
      left: 10,
      top: 20,
      width: 100,
      height: 50,
      right: 110,
      bottom: 70,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
    render(<TutorialApp onExit={() => undefined} botDelayMs={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start Meet the board' }));

    // step 1: read-only; the hand is spotlighted and tagged
    expect(await screen.findByTestId('step-title')).toHaveTextContent('Your hand');
    expect(document.querySelector('[data-tutorial-id="hand"]')).not.toBeNull();
    expect(document.querySelector('[data-tutorial-id="hand-card:fx-grunt"]')).not.toBeNull();
    expect(document.querySelector('[data-tutorial-id="score"]')).not.toBeNull();
    expect(document.querySelector('[data-tutorial-id="rune-panel"]')).not.toBeNull();
    expect(document.querySelector('[data-tutorial-id="chain-panel"]')).not.toBeNull();
    expect(document.querySelector('[data-tutorial-id="battlefield:0"]')).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId('spotlight')).toBeInTheDocument());

    // clicking a card while the read-only gate is closed: friendly message, nothing sent
    const handCard = (id: string) =>
      document.querySelector(`[aria-label^="Your hand"] [data-card-id="${id}"]`) as HTMLElement;
    fireEvent.click(handCard('fx-flare'));
    expect(await screen.findByTestId('blocked-callout')).toHaveTextContent('Not yet:');

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByTestId('step-title')).toHaveTextContent('Play a unit'));
    expect(screen.getByRole('list', { name: 'Step progress' }).querySelectorAll('li')).toHaveLength(
      6,
    );

    // wrong card for this step is blocked, the right one is accepted by the engine
    fireEvent.click(handCard('fx-flare'));
    expect(await screen.findByTestId('blocked-callout')).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();
  });
});
