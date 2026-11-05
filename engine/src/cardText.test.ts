import { describe, it, expect } from 'vitest';
import { parseSpellText } from './cardText.js';

describe('parseSpellText', () => {
  it('parses draw, damage and buff sentences', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText('Draw 4.')).toEqual([{ op: 'DRAW', amount: 4 }]);
    expect(
      parseSpellText(
        '[Action] (Play on your turn or in showdowns.) Deal 4 to a unit at a battlefield. Draw 1.',
      ),
    ).toEqual([
      { op: 'DAMAGE_TARGET', amount: 4, atBattlefield: true },
      { op: 'DRAW', amount: 1 },
    ]);
    expect(parseSpellText('[Reaction] Give a friendly unit +2 [M] this turn. Draw 1.')).toEqual([
      { op: 'BUFF_TARGET', amount: 2, duration: 'TURN', side: 'friendly' },
      { op: 'DRAW', amount: 1 },
    ]);
  });

  it('parses kill, ready and mass-buff sentences', () => {
    // Tests Rule 359.3: a spell's effects resolve in printed order
    expect(parseSpellText('Kill a unit at a battlefield with 3 [M] or less.')).toEqual([
      { op: 'KILL_TARGET', atBattlefield: true, maxMight: 3 },
    ]);
    expect(parseSpellText('Ready a friendly unit.')).toEqual([
      { op: 'READY_TARGET', side: 'friendly' },
    ]);
    expect(parseSpellText('Give friendly units +1 [M] this turn.')).toEqual([
      { op: 'BUFF_ALL', amount: 1, side: 'friendly', duration: 'TURN' },
    ]);
  });

  it('refuses anything it only partly understands', () => {
    // Tests Rule 359.3: never half-execute a spell
    expect(parseSpellText('Deal 3 to a unit. If this kills it, draw 1.')).toBeNull();
    expect(parseSpellText('Kill all gear.')).toBeNull();
    expect(parseSpellText('Deal 1 to a unit. Deal 2 to a unit.')).toBeNull();
    expect(parseSpellText('')).toBeNull();
  });
});
