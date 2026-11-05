import { useCallback, useState, type ReactNode } from 'react';
import { LessonRunner } from './LessonRunner';
import { LESSONS } from './lessons';
import { loadProgress, markCompleted } from './progress';
import type { LessonDef } from './types';

export interface TutorialAppProps {
  onExit: () => void;
  /** Override the lesson list (tests). */
  lessons?: LessonDef[];
  /** Pause before the scripted opponent's automatic passes in ms (tests use 0). */
  botDelayMs?: number;
}

/** Covers the viewport whatever width-limited container the host mounts us in. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="tutorial-shell"
      className="fixed inset-0 z-20 overflow-auto bg-slate-950 text-slate-100"
    >
      {children}
    </div>
  );
}

/** Lesson list (with persisted progress) and the lesson runner. */
export function TutorialApp({ onExit, lessons = LESSONS, botDelayMs }: TutorialAppProps) {
  const [done, setDone] = useState<Set<string>>(() => loadProgress());
  const [activeId, setActiveId] = useState<string | null>(null);

  const onComplete = useCallback((id: string) => setDone(markCompleted(id)), []);

  const active = lessons.find((l) => l.id === activeId);
  if (active) {
    const idx = lessons.indexOf(active);
    const next = lessons.slice(idx + 1).find((l) => !l.comingSoon);
    return (
      <Shell>
        <LessonRunner
          key={active.id}
          lesson={active}
          onExit={() => setActiveId(null)}
          onComplete={onComplete}
          onNextLesson={next ? () => setActiveId(next.id) : undefined}
          {...(botDelayMs !== undefined ? { botDelayMs } : {})}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-amber-300">Tutorial</h1>
            <p className="mt-1 text-sm text-slate-400">
              Short hands-on lessons on a real game board, with the real rules engine.
            </p>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300"
          >
            Back
          </button>
        </header>
        <ol aria-label="Lessons" className="flex flex-col gap-3">
          {lessons.map((lesson, i) => {
            const completed = done.has(lesson.id);
            const soon = lesson.comingSoon === true;
            return (
              <li
                key={lesson.id}
                aria-disabled={soon || undefined}
                data-lesson-id={lesson.id}
                className={`flex items-center gap-4 rounded-xl border p-4 ${
                  soon
                    ? 'border-slate-800 bg-slate-900/40 opacity-60'
                    : 'border-slate-700 bg-slate-900'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                    completed ? 'bg-emerald-500 text-slate-950' : 'bg-slate-700 text-slate-200'
                  }`}
                >
                  {completed ? '✓' : i}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold text-slate-100">
                    {lesson.title}
                    {completed ? <span className="sr-only"> (completed)</span> : null}
                  </h2>
                  <p className="text-sm text-slate-400">{lesson.summary}</p>
                </div>
                {soon ? (
                  <span className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-400">
                    Coming soon
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveId(lesson.id)}
                    aria-label={`${completed ? 'Review' : 'Start'} ${lesson.title}`}
                    className={
                      completed
                        ? 'rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-amber-300'
                        : 'rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'
                    }
                  >
                    {completed ? 'Review' : 'Start'}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </main>
    </Shell>
  );
}
