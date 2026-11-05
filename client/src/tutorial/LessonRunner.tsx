import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GameProvider } from '../app/gameApi';
import { GameScreen } from '../game/GameScreen';
import { Md } from './Markdown';
import { TutorialSession, type SessionOptions } from './sandbox';
import { Spotlight } from './Spotlight';
import type { LessonDef } from './types';

export interface LessonRunnerProps {
  lesson: LessonDef;
  /** Back to the lesson list. */
  onExit: () => void;
  /** Called once when the learner completes the last step. */
  onComplete?: ((lessonId: string) => void) | undefined;
  /** Next playable lesson, if any (enables the "Next lesson" button on the completion screen). */
  onNextLesson?: (() => void) | undefined;
  /** Pause before the scripted opponent's automatic passes (ms). Tests use 0. */
  botDelayMs?: number;
}

const btn =
  'rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300 disabled:opacity-40 disabled:hover:bg-transparent';
const primaryBtn =
  'rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white';

/** Creates a TutorialSession for the lesson (disposed on unmount / lesson change; StrictMode safe). */
function useSession(lesson: LessonDef, opts: SessionOptions): TutorialSession | null {
  const [session, setSession] = useState<TutorialSession | null>(null);
  const optsRef = useRef(opts);
  useEffect(() => {
    const s = new TutorialSession(lesson, optsRef.current);
    setSession(s);
    return () => {
      s.dispose();
      setSession(null);
    };
  }, [lesson]);
  return session;
}

export function LessonRunner({
  lesson,
  onExit,
  onComplete,
  onNextLesson,
  botDelayMs,
}: LessonRunnerProps) {
  const session = useSession(lesson, botDelayMs === undefined ? {} : { botDelayMs });
  if (!session) return null;
  return (
    <RunnerBody
      session={session}
      onExit={onExit}
      onComplete={onComplete}
      onNextLesson={onNextLesson}
    />
  );
}

function RunnerBody({
  session,
  onExit,
  onComplete,
  onNextLesson,
}: {
  session: TutorialSession;
  onExit: () => void;
  onComplete: ((id: string) => void) | undefined;
  onNextLesson: (() => void) | undefined;
}) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { lesson, step } = snap;
  const [conceptOpen, setConceptOpen] = useState(true);
  // Narrow screens: the guide is a bottom sheet that can be collapsed to a single bar.
  const [collapsed, setCollapsed] = useState(false);
  const stepDone = snap.status === 'complete';
  useEffect(() => {
    // A new step or a finished step always needs the learner's attention: reopen the sheet.
    setCollapsed(false);
  }, [snap.stepIndex, stepDone]);

  useEffect(() => {
    if (snap.status === 'finished') onComplete?.(lesson.id);
  }, [snap.status, lesson.id, onComplete]);

  if (snap.status === 'finished') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-100">
        <section
          aria-label="Lesson complete"
          className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-amber-300 bg-slate-900 p-6"
        >
          <h1 className="text-2xl font-bold text-amber-300">Lesson complete: {lesson.title}</h1>
          <Md text={lesson.completionText} className="text-slate-200" />
          <div className="flex flex-wrap gap-2">
            {onNextLesson ? (
              <button type="button" autoFocus onClick={onNextLesson} className={primaryBtn}>
                Next lesson
              </button>
            ) : null}
            <button type="button" onClick={() => session.resetLesson()} className={btn}>
              Review this lesson
            </button>
            <button type="button" onClick={onExit} className={btn}>
              Back to lessons
            </button>
          </div>
        </section>
      </div>
    );
  }

  const done = snap.status === 'complete';
  const last = snap.stepIndex === snap.stepCount - 1;

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100 md:flex-row">
      <aside
        aria-label="Lesson guide"
        className="relative z-40 order-2 flex max-h-[45vh] shrink-0 flex-col gap-3 overflow-y-auto border-t border-slate-800 bg-slate-900 p-4 md:order-1 md:max-h-none md:w-[22rem] md:border-t-0 md:border-r"
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls="lesson-guide-body"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center justify-between gap-2 rounded-lg border border-slate-600 px-3 py-1.5 text-left text-sm text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300 md:hidden"
        >
          <span className="truncate">
            Step {snap.stepIndex + 1} of {snap.stepCount}
            {step ? `: ${step.title}` : ''}
          </span>
          <span className="shrink-0 font-semibold text-amber-300">
            {collapsed ? 'Show guide' : 'Hide guide'}
          </span>
        </button>
        <div
          id="lesson-guide-body"
          className={
            collapsed ? 'hidden md:flex md:flex-col md:gap-3' : 'flex flex-col gap-3'
          }
        >
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={onExit} className={btn}>
              &larr; Lessons
            </button>
            <button type="button" onClick={() => session.resetLesson()} className={btn}>
              Reset lesson
            </button>
          </div>
          <h1 className="text-lg font-bold text-amber-300">{lesson.title}</h1>

          <details
            open={conceptOpen}
            onToggle={(e) => setConceptOpen((e.currentTarget as HTMLDetailsElement).open)}
            className="rounded-lg border border-slate-700 bg-slate-950/60 p-3"
          >
            <summary className="cursor-pointer text-sm font-semibold text-slate-200 focus-visible:outline-2 focus-visible:outline-amber-300">
              The idea
            </summary>
            <div className="mt-2 flex flex-col gap-2 text-sm text-slate-300">
              {lesson.concept.map((p, i) => (
                <Md key={i} text={p} />
              ))}
            </div>
          </details>

          <ol aria-label="Step progress" className="flex flex-wrap items-center gap-1.5">
            {lesson.steps.map((s, i) => {
              const state = snap.completedSteps.includes(i)
                ? 'completed'
                : i === snap.stepIndex
                  ? 'current'
                  : 'upcoming';
              return (
                <li
                  key={s.id}
                  aria-label={`Step ${i + 1}: ${s.title} (${state})`}
                  aria-current={state === 'current' ? 'step' : undefined}
                  className={`h-2.5 w-2.5 rounded-full ${
                    state === 'completed'
                      ? 'bg-emerald-400'
                      : state === 'current'
                        ? 'bg-amber-300 ring-2 ring-amber-300/40'
                        : 'bg-slate-600'
                  }`}
                />
              );
            })}
            <span className="ml-2 text-xs text-slate-400">
              Step {snap.stepIndex + 1} of {snap.stepCount}
            </span>
          </ol>

          {step ? (
            <section
              aria-label="Current step"
              className="flex flex-col gap-3 rounded-xl border border-amber-300/60 bg-slate-950 p-3"
            >
              <div aria-live="polite" aria-atomic="true" className="flex flex-col gap-2">
                <h2 className="text-base font-semibold text-slate-50" data-testid="step-title">
                  {step.title}
                </h2>
                <Md text={step.instruction} className="text-sm text-slate-200" />
              </div>

              {snap.notes.map((n, i) => (
                <div
                  key={i}
                  role="status"
                  className="rounded-md bg-sky-950/60 p-2 text-sm text-sky-100"
                >
                  <Md text={n} />
                </div>
              ))}

              {snap.blockedMessage ? (
                <p
                  role="status"
                  data-testid="blocked-callout"
                  className="rounded-md border border-amber-500/60 bg-amber-950/50 p-2 text-sm text-amber-100"
                >
                  Not yet: {snap.blockedMessage}
                </p>
              ) : null}

              {snap.lastError ? (
                <div
                  role="status"
                  data-testid="engine-callout"
                  className="rounded-md border border-rose-600/70 bg-rose-950/50 p-2 text-sm text-rose-100"
                >
                  <div className="text-xs font-semibold tracking-wide text-rose-300 uppercase">
                    The engine says:
                  </div>
                  <div>{snap.lastError.message}</div>
                </div>
              ) : null}

              {done ? (
                <div
                  role="status"
                  data-testid="step-complete"
                  className="flex flex-col gap-2 rounded-md border border-emerald-600/60 bg-emerald-950/40 p-2 text-sm text-emerald-100"
                >
                  <strong>{step.expectError ? 'Exactly that refusal.' : 'Step complete.'}</strong>
                  {step.explain ? <Md text={step.explain} /> : null}
                  <button
                    type="button"
                    autoFocus
                    onClick={() => session.next()}
                    className={primaryBtn}
                  >
                    {last ? 'Finish lesson' : 'Next step'}
                  </button>
                </div>
              ) : snap.manual ? (
                <button type="button" onClick={() => session.next()} className={primaryBtn}>
                  Continue
                </button>
              ) : null}

              {snap.hintShown && step.hint ? (
                <p role="note" className="rounded-md bg-slate-800 p-2 text-sm text-slate-200">
                  <strong className="text-amber-200">Hint: </strong>
                  {step.hint}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {step.hint && !snap.hintShown && !done ? (
                  <button type="button" onClick={() => session.showHint()} className={btn}>
                    Show hint
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={!snap.canBack}
                  onClick={() => session.back()}
                  className={btn}
                >
                  Back
                </button>
                <button type="button" onClick={() => session.resetStep()} className={btn}>
                  Reset step
                </button>
                <button type="button" onClick={() => session.skip()} className={btn}>
                  Skip
                </button>
              </div>
            </section>
          ) : null}
        </div>
      </aside>

      {/* A transform makes this the containing block of the game's fixed overlays (combat dialog,
          game-over modal, concede dialog): they cover the board only, never the lesson guide. The
          scroller is an inner element so the overlays do not scroll away. */}
      <div className="relative order-1 min-h-0 min-w-0 flex-1 transform-gpu md:order-2">
        <div className="h-full overflow-auto">
          <GameProvider value={snap.api}>
            <GameScreen onBackToMenu={onExit} additiveSelection />
          </GameProvider>
        </div>
      </div>
      <Spotlight ids={snap.highlight} version={snap.version} />
    </div>
  );
}
