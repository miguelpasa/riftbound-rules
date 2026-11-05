/** Lesson completion marks, persisted in localStorage (every access is guarded: storage may be blocked). */
const KEY = 'riftbound.tutorial.progress.v1';

export function loadProgress(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    /* storage unavailable or corrupt: start fresh */
  }
  return new Set();
}

export function saveProgress(done: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...done]));
  } catch {
    /* ignore */
  }
}

/** Marks a lesson completed and returns the new set. */
export function markCompleted(id: string): Set<string> {
  const done = loadProgress();
  done.add(id);
  saveProgress(done);
  return done;
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
