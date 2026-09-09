/**
 * cap_at fix — auto-bonus evaluator (live bug report, 2026-09-09).
 *
 * Friends with Benefits grants free Feeding Grounds dots equal to the sum of a character's
 * Sway + Mystery Cult Initiation cp+xp. Pre-2026-08-26 (the Sway merge), a character held at
 * most one or two matching instances, so the sum stayed small. Post-merge, "Sway" is a broad
 * umbrella a character can hold many separate instances of, so the same formula over-grants —
 * live: Eve Lockridge computed 17 (four Sway instances summing to 12, plus MCI's 5), reported
 * in-session as visibly wrong. cap_at is the ST's own explicit ceiling on this one rule's
 * output; it is optional and does not affect any auto_bonus rule that doesn't set it.
 *
 * Pure-function test — no DB, no mocks, matching the evaluator's own header ("No external
 * imports — pure function; safe in Node.js test contexts").
 */
import { describe, it, expect } from 'vitest';
import { applyAutoBonusRulesFromDb } from '../../public/js/editor/rule_engine/auto-bonus-evaluator.js';

function fwbRule(overrides = {}) {
  return {
    source: 'Friends with Benefits',
    grant_type: 'auto_bonus',
    amount_basis: 'rating_of_partner_merit',
    target: 'Feeding Grounds',
    target_field: 'free_fwb',
    partner_merit_names: ['Mystery Cult Initiation', 'Sway'],
    ...overrides,
  };
}

// Eve Lockridge's real live shape (2026-09-09): four Sway instances (cp+xp: 4, 2, 1, 5 -> 12)
// plus one Mystery Cult Initiation (cp+xp: 5) -> 17 uncapped.
function eveShapedCharacter() {
  return {
    merits: [
      { name: 'Friends with Benefits', cp: 0, xp: 1 },
      { name: 'Sway', cp: 0, xp: 4 },
      { name: 'Sway', cp: 0, xp: 2 },
      { name: 'Sway', cp: 0, xp: 1 },
      { name: 'Sway', cp: 5, xp: 0 },
      { name: 'Mystery Cult Initiation', cp: 5, xp: 0 },
      { name: 'Feeding Grounds', rating: 0, cp: 0, xp: 0, free_fwb: 0 },
    ],
  };
}

describe('applyAutoBonusRulesFromDb — cap_at (2026-09-09 fix)', () => {
  it('clamps the computed amount to cap_at when the uncapped sum exceeds it', () => {
    const c = eveShapedCharacter();
    applyAutoBonusRulesFromDb(c, { grants: [fwbRule({ cap_at: 5 })] });
    expect(c.merits.find((m) => m.name === 'Feeding Grounds').free_fwb).toBe(5);
  });

  it('reproduces the real pre-fix bug value when cap_at is absent (regression guard)', () => {
    const c = eveShapedCharacter();
    applyAutoBonusRulesFromDb(c, { grants: [fwbRule()] }); // no cap_at
    expect(c.merits.find((m) => m.name === 'Feeding Grounds').free_fwb).toBe(17);
  });

  it('does not raise an amount that is already below cap_at', () => {
    const c = {
      merits: [
        { name: 'Friends with Benefits', cp: 0, xp: 1 },
        { name: 'Sway', cp: 3, xp: 0 },
        { name: 'Feeding Grounds', rating: 0, cp: 0, xp: 0, free_fwb: 0 },
      ],
    };
    applyAutoBonusRulesFromDb(c, { grants: [fwbRule({ cap_at: 5 })] });
    expect(c.merits.find((m) => m.name === 'Feeding Grounds').free_fwb).toBe(3);
  });

  it('leaves an unrelated auto_bonus rule with no cap_at fully unaffected', () => {
    const c = {
      merits: [
        { name: 'Attaché (Safe Place)', cp: 0, xp: 6 },
        { name: 'Safe Place', rating: 0, cp: 0, xp: 0, free_attache: 0 },
      ],
    };
    const attacheRule = {
      source: 'Attaché (Safe Place)', grant_type: 'auto_bonus', amount_basis: 'rating_of_partner_merit',
      target: 'Safe Place', target_field: 'free_attache', partner_merit_names: ['Attaché (Safe Place)'],
    };
    applyAutoBonusRulesFromDb(c, { grants: [attacheRule] });
    expect(c.merits.find((m) => m.name === 'Safe Place').free_attache).toBe(6);
  });
});
