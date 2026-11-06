/**
 * Tiny synthesized sound cues (WebAudio, no asset files). Every call is a no-op when sound is off,
 * when the browser has no AudioContext (tests, old browsers) or when audio is blocked.
 */
import type { GameEvent, PlayerId } from '@riftbound/engine';

export type Cue = 'play' | 'kill' | 'point' | 'oppPoint' | 'yourTurn' | 'showdown' | 'win' | 'lose';

let enabled = true;
let ctx: AudioContext | null = null;

export function setSoundEnabled(on: boolean): void {
  enabled = on;
}

interface Note {
  freq: number;
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

const CUES: Record<Cue, Note[]> = {
  play: [{ freq: 440, at: 0, dur: 0.08, type: 'triangle' }],
  kill: [{ freq: 160, at: 0, dur: 0.18, type: 'sawtooth', gain: 0.6 }],
  point: [
    { freq: 523, at: 0, dur: 0.1 },
    { freq: 784, at: 0.1, dur: 0.18 },
  ],
  oppPoint: [
    { freq: 392, at: 0, dur: 0.1 },
    { freq: 294, at: 0.1, dur: 0.18 },
  ],
  yourTurn: [
    { freq: 660, at: 0, dur: 0.1, type: 'triangle' },
    { freq: 880, at: 0.12, dur: 0.14, type: 'triangle' },
  ],
  showdown: [{ freq: 220, at: 0, dur: 0.22, type: 'square', gain: 0.5 }],
  win: [
    { freq: 523, at: 0, dur: 0.14 },
    { freq: 659, at: 0.14, dur: 0.14 },
    { freq: 784, at: 0.28, dur: 0.14 },
    { freq: 1047, at: 0.42, dur: 0.3 },
  ],
  lose: [
    { freq: 392, at: 0, dur: 0.2 },
    { freq: 330, at: 0.2, dur: 0.2 },
    { freq: 262, at: 0.4, dur: 0.35 },
  ],
};

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

export function playCue(cue: Cue): void {
  if (!enabled) return;
  const c = context();
  if (!c) return;
  try {
    if (c.state === 'suspended') void c.resume();
    const t0 = c.currentTime;
    for (const n of CUES[cue]) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = n.type ?? 'sine';
      osc.frequency.value = n.freq;
      const peak = 0.12 * (n.gain ?? 1);
      g.gain.setValueAtTime(0.0001, t0 + n.at);
      g.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
      osc.connect(g).connect(c.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.dur + 0.02);
    }
  } catch {
    /* audio blocked or unsupported: silent */
  }
}

/** The cue a fresh event deserves for the viewer in `seat`, or null (most events are silent). */
export function cueForEvent(e: GameEvent, seat: PlayerId): Cue | null {
  switch (e.type) {
    case 'CARD_PLAYED':
      return e.player === seat ? null : 'play'; // your own plays already give click feedback
    case 'UNIT_KILLED':
      return 'kill';
    case 'POINT_GAINED':
      return e.player === seat ? 'point' : 'oppPoint';
    case 'SHOWDOWN_STARTED':
      return 'showdown';
    case 'PHASE_CHANGED':
      return e.phase === 'AWAKEN' && e.player === seat ? 'yourTurn' : null;
    case 'GAME_ENDED':
      return e.winner === seat ? 'win' : 'lose';
    default:
      return null;
  }
}

/** One cue per batch: the most significant one, so a big event burst is not a wall of noise. */
const RANK: Cue[] = ['win', 'lose', 'point', 'oppPoint', 'kill', 'showdown', 'yourTurn', 'play'];
export function pickCue(cues: (Cue | null)[]): Cue | null {
  for (const c of RANK) if (cues.includes(c)) return c;
  return null;
}
