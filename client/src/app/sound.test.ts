import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@riftbound/engine';
import { cueForEvent, pickCue, playCue, setSoundEnabled } from './sound';
import { DEFAULT_SETTINGS } from './settings';

const ev = (e: Partial<GameEvent> & { type: string }): GameEvent => ({ seq: 1, ...e }) as GameEvent;

describe('sound cues', () => {
  it('maps events to cues from the viewer seat', () => {
    expect(cueForEvent(ev({ type: 'POINT_GAINED', player: 'p0', amount: 1 }), 'p0')).toBe('point');
    expect(cueForEvent(ev({ type: 'POINT_GAINED', player: 'p1', amount: 1 }), 'p0')).toBe(
      'oppPoint',
    );
    expect(cueForEvent(ev({ type: 'GAME_ENDED', winner: 'p1' }), 'p0')).toBe('lose');
    expect(cueForEvent(ev({ type: 'PHASE_CHANGED', player: 'p0', phase: 'AWAKEN' }), 'p0')).toBe(
      'yourTurn',
    );
    expect(
      cueForEvent(ev({ type: 'PHASE_CHANGED', player: 'p1', phase: 'AWAKEN' }), 'p0'),
    ).toBeNull();
    expect(cueForEvent(ev({ type: 'CARD_PLAYED', player: 'p0' }), 'p0')).toBeNull();
    expect(cueForEvent(ev({ type: 'RUNE_CHANNELED' }), 'p0')).toBeNull();
  });

  it('picks the most significant cue of a batch', () => {
    expect(pickCue([null, 'play', 'kill', 'point'])).toBe('point');
    expect(pickCue([null])).toBeNull();
  });

  it('is silent and safe without an AudioContext, and on by default', () => {
    setSoundEnabled(true);
    expect(() => playCue('win')).not.toThrow();
    expect(DEFAULT_SETTINGS.sound).toBe(true);
  });
});
