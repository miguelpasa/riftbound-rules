/** Unambiguous alphabet: no I, L, O, 0, 1. 31 symbols, 6 chars ~ 887M codes. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const PEER_ID_PREFIX = 'rbduel-';

const VALID = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/;

export function generateRoomCode(): string {
  const n = ROOM_CODE_ALPHABET.length;
  // Rejection sampling for an unbiased pick.
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < ROOM_CODE_LENGTH) {
    const bytes = new Uint8Array(ROOM_CODE_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && out.length < ROOM_CODE_LENGTH) out += ROOM_CODE_ALPHABET[b % n];
    }
  }
  return out;
}

/** Canonicalise user input: trim, uppercase, drop spaces and dashes. */
export function normalizeRoomCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function isValidRoomCode(code: string): boolean {
  return VALID.test(code.toUpperCase());
}

export function peerIdFromRoomCode(code: string): string {
  return PEER_ID_PREFIX + code.toLowerCase();
}
