import { describe, expect, it } from 'vitest';
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  peerIdFromRoomCode,
  ROOM_CODE_ALPHABET,
} from './roomCode.js';

// Tests: generated codes are 6 chars from the unambiguous alphabet; validation; peer id mapping.
describe('roomCode', () => {
  it('generates valid 6-char codes without ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(6);
      expect(isValidRoomCode(code)).toBe(true);
      expect(code).toMatch(/^[A-Z2-9]+$/);
      expect(code).not.toMatch(/[ILO01]/);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
  });
  it('generates varied codes', () => {
    expect(new Set(Array.from({ length: 50 }, generateRoomCode)).size).toBeGreaterThan(45);
  });
  it('validates', () => {
    expect(isValidRoomCode('abcdef')).toBe(true);
    expect(isValidRoomCode('ABCDE')).toBe(false);
    expect(isValidRoomCode('ABCDEFG')).toBe(false);
    expect(isValidRoomCode('ABCDE0')).toBe(false);
    expect(isValidRoomCode('ABCDEI')).toBe(false);
    expect(isValidRoomCode('ABC DE')).toBe(false);
    expect(isValidRoomCode('')).toBe(false);
  });
  it('normalizes user input', () => {
    expect(normalizeRoomCode(' ab-cd ef ')).toBe('ABCDEF');
  });
  it('maps to a peer id', () => {
    expect(peerIdFromRoomCode('K7QWXZ')).toBe('rbduel-k7qwxz');
  });
});
