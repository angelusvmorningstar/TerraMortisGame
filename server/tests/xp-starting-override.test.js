/**
 * Starting XP honours the per-character `xp_starting_override` (set in TM Admin for a second or
 * replacement character, who opens on the average XP of the other players). Pure module import:
 * no database. Without an override the flat default of 10 applies, so every other sheet is
 * unchanged.
 */
import { describe, it, expect } from 'vitest';
import { xpStarting, xpEarned } from '../../public/js/editor/xp.js';

const base = { humanity: 7, humanity_base: 7, ordeals: [], merits: [], _gameXP: 0 };

describe('xpStarting', () => {
  it('defaults to 10 with no override', () => {
    expect(xpStarting({})).toBe(10);
    expect(xpStarting({ xp_starting_override: null })).toBe(10);
    expect(xpStarting(undefined)).toBe(10);
  });

  it('uses the override when it is a finite number', () => {
    expect(xpStarting({ xp_starting_override: 23 })).toBe(23);
    expect(xpStarting({ xp_starting_override: 0 })).toBe(0);
  });

  it('ignores a non-numeric override', () => {
    expect(xpStarting({ xp_starting_override: '23' })).toBe(10);
    expect(xpStarting({ xp_starting_override: NaN })).toBe(10);
  });

  it('flows into xpEarned (23 is 13 more than the default)', () => {
    expect(xpEarned({ ...base, xp_starting_override: 23 })).toBe(xpEarned(base) + 13);
  });
});
