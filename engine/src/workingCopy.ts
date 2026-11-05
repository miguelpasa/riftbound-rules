/**
 * Working-copy ownership for `reduce` (R37).
 *
 * The rules modules are written in the "pure" style: every exported state-returning helper clones its
 * input, mutates the clone and returns it. Inside one `reduce` that pipeline used to copy the whole
 * state 7-25 times. `fork(state)` keeps that contract for outside callers but skips the copy for a
 * state that the CURRENT reduce session already owns:
 *
 *  - `runSession(fn)` opens a session (a fresh WeakSet of private objects) around one `reduce` /
 *    `applyIntent` call. Nothing is registered up front, so a rejected intent never copies anything.
 *  - `fork(state)` inside a session: if `state` is registered it is returned as is (the caller already
 *    holds the private copy); otherwise it is copied and the copy is registered. Outside a session it
 *    is a plain copy.
 *  - The input state handed to `reduce` is never registered, so it is never mutated; the first helper
 *    that forks it makes the one private copy. The session ends in a `finally`, so the state that
 *    `reduce` returns is not owned by anyone: the next call on it copies again.
 *
 * Invariant for helper authors: inside the reduce pipeline a function may be handed a state it is
 * allowed to mutate, so never keep a reference to "the old" state and read it after calling another
 * helper with the same object. Compare via serialised snapshots or copy the few fields you need first.
 */

let owned: WeakSet<object> | null = null;

/** Run `fn` as one reduce session. Nested sessions get their own ownership set and restore the outer one. */
export function runSession<R>(fn: () => R): R {
  const outer = owned;
  owned = new WeakSet();
  try {
    return fn();
  } finally {
    owned = outer;
  }
}

/** True while a reduce session is open (used by tests). */
export function inSession(): boolean {
  return owned !== null;
}

/**
 * A copy of `state` that the caller may mutate. Inside a session, a state this session already copied
 * is returned unchanged (no copy).
 */
export function fork<T extends object>(state: T): T {
  if (owned === null) return cloneState(state);
  if (owned.has(state)) return state;
  const copy = cloneState(state);
  owned.add(copy);
  return copy;
}

/**
 * Deep copy of plain data (objects, arrays, primitives, `undefined` properties kept), about 4x faster
 * than `structuredClone` for a GameState. Anything that is not a plain object or array (Map, Set,
 * Date, class instances) is delegated to `structuredClone`, so the result equals what
 * `structuredClone` returns for tree-shaped data. Shared references inside the input are copied
 * once per path (GameState is a tree; `reducePurity.test` fuzzes equality with `structuredClone`).
 */
export function cloneState<T>(value: T): T {
  return cloneAny(value) as T;
}

function cloneAny(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const n = v.length;
    const out = new Array<unknown>(n);
    for (let i = 0; i < n; i++) out[i] = cloneAny(v[i]);
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return structuredClone(v);
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k in src) out[k] = cloneAny(src[k]);
  return out;
}
