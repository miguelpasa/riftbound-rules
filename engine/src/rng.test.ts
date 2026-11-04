import { describe, it, expect } from 'vitest';
import { nextUint32, randomInt, rngInt, rngNext, rngShuffle, seedRng, shuffle } from './rng.js';
import { makeTestGame } from './testing/fixtures.js';

describe('rng', () => {
  it('is deterministic by seed', () => {
    // Tests Rule 114: shuffling must be reproducible from the seed
    const a = seedRng('abc');
    const b = seedRng('abc');
    expect(a).toEqual(b);
    expect(nextUint32(a)[0]).toBe(nextUint32(b)[0]);
  });

  it('differs between seeds', () => {
    // Tests Rule 114: different seeds give different shuffles
    expect(seedRng('abc')).not.toEqual(seedRng('abd'));
    expect(nextUint32(seedRng('1'))[0]).not.toBe(nextUint32(seedRng('2'))[0]);
  });

  it('state survives structuredClone and JSON round trip and continues identically', () => {
    // Tests Rule 114: state is plain data so saved games replay identically
    const g = makeTestGame('rt');
    const viaClone = structuredClone(g);
    const viaJson = JSON.parse(JSON.stringify(g)) as typeof g;
    const seq = (s: typeof g): number[] => [rngNext(s), rngNext(s), rngInt(s, 100), rngNext(s)];
    const expected = seq(g);
    expect(seq(viaClone)).toEqual(expected);
    expect(seq(viaJson)).toEqual(expected);
  });

  it('pure and in-place helpers agree and pure ones do not mutate', () => {
    // Tests Rule 114: pure and in-place variants give the same sequence
    const g = makeTestGame('agree');
    const before = structuredClone(g.rng);
    const [v, next] = nextUint32(g.rng);
    expect(g.rng).toEqual(before);
    expect(next).not.toEqual(before);
    expect(rngNext(g)).toBe(v);
    expect(g.rng).toEqual(next);
  });

  it('shuffle is a permutation and is deterministic', () => {
    // Tests Rule 114: a shuffle reorders but never adds or drops cards
    const arr = Array.from({ length: 40 }, (_, i) => i);
    const [s1] = shuffle(arr, seedRng('s'));
    const [s2] = shuffle(arr, seedRng('s'));
    expect(s1).toEqual(s2);
    expect([...s1].sort((a, b) => a - b)).toEqual(arr);
    expect(s1).not.toEqual(arr);
    const g = makeTestGame();
    const out = rngShuffle(arr, g);
    expect([...out].sort((a, b) => a - b)).toEqual(arr);
  });

  it('randomInt stays in range and rejects bad bounds', () => {
    // Tests Rule 115: random choices are uniform integers in range
    let rng = seedRng('range');
    for (let i = 0; i < 200; i++) {
      const [v, n] = randomInt(rng, 3);
      rng = n;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(3);
    }
    expect(() => randomInt(rng, 0)).toThrow();
  });
});
