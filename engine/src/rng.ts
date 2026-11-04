/**
 * Deterministic PRNG (sfc32) whose state is plain data (`RngState`) stored in `GameState.rng`.
 *
 * Convention: reducers `structuredClone` the incoming state first and then mutate the clone.
 * Use the in-place helpers (`rngNext`, `rngInt`, `rngShuffle`) on that working clone; use the
 * pure helpers (`nextUint32`, `randomInt`, `shuffle`) when you only hold a bare `RngState`.
 * Both families produce identical sequences for the same starting state.
 */
import type { GameState, RngState } from './types/index.js';

/** Advance `rng` in place; returns a uint32. */
function step(rng: RngState): number {
  let [a, b, c, d] = rng.s;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 11);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  rng.s = [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
  return t >>> 0;
}

/** Hash a string into 4 uint32 words (xmur3-style mixing). */
function hashSeed(seed: string): [number, number, number, number] {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    out.push(h >>> 0);
  }
  return out as [number, number, number, number];
}

/** Create an RngState from a seed string (hashed, then warmed up). */
export function seedRng(seed: string): RngState {
  const rng: RngState = { s: hashSeed(seed) };
  for (let i = 0; i < 15; i++) step(rng);
  return rng;
}

/** Pure: next uint32 and the advanced state. */
export function nextUint32(rng: RngState): [number, RngState] {
  const copy: RngState = { s: [...rng.s] };
  const v = step(copy);
  return [v, copy];
}

/** Pure: uniform integer in [0, n). */
export function randomInt(rng: RngState, n: number): [number, RngState] {
  const copy: RngState = { s: [...rng.s] };
  return [intFrom(copy, n), copy];
}

/** Pure: Fisher-Yates shuffle; returns a new array and the advanced state. */
export function shuffle<T>(arr: readonly T[], rng: RngState): [T[], RngState] {
  const copy: RngState = { s: [...rng.s] };
  return [shuffleFrom(arr, copy), copy];
}

function intFrom(rng: RngState, n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 0x100000000) {
    throw new Error(`randomInt: n must be an integer in [1, 2^32], got ${n}`);
  }
  // Rejection sampling to avoid modulo bias.
  const limit = Math.floor(0x100000000 / n) * n;
  let v = step(rng);
  while (v >= limit) v = step(rng);
  return v % n;
}

function shuffleFrom<T>(arr: readonly T[], rng: RngState): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = intFrom(rng, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** In place on a working (already cloned) state: next uint32. */
export function rngNext(state: GameState): number {
  return step(state.rng);
}

/** In place on a working state: uniform integer in [0, n). */
export function rngInt(state: GameState, n: number): number {
  return intFrom(state.rng, n);
}

/** In place on a working state: returns a shuffled copy of `arr`, advancing `state.rng`. */
export function rngShuffle<T>(arr: readonly T[], state: GameState): T[] {
  return shuffleFrom(arr, state.rng);
}
