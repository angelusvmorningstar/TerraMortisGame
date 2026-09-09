/**
 * Auto-bonus evaluator — processes rule_grant docs with grant_type='auto_bonus'.
 *
 * Models the SSJ/Flock pattern: a source merit grants a derived bonus on a
 * specific target merit, with no user allocation step. The bonus amount is
 * computed at render time from partner merit ratings (rating_of_partner_merit
 * basis) and written to target_field on the target merit instance — read back
 * by meritEffectiveRating like any other free_* field.
 *
 * Called once with all auto_bonus rules from the cache (no per-source
 * iteration needed). Each rule clears its own target_field on the target
 * merit before re-applying so removing the source merit also removes the
 * bonus on the next render pass.
 *
 * No external imports — pure function; safe in Node.js test contexts.
 */

export function applyAutoBonusRulesFromDb(c, { grants = [] } = {}) {
  const autoGrants = grants.filter(r => r.grant_type === 'auto_bonus');
  if (!autoGrants.length) return;

  // Stale-clear: zero every (target merit, target_field) tuple this evaluator
  // owns. Done up front so a removed source merit doesn't leave the bonus
  // stuck on the target.
  for (const rule of autoGrants) {
    if (!rule.target || !rule.target_field) continue;
    (c.merits || []).forEach(m => {
      if (m.name === rule.target) m[rule.target_field] = 0;
    });
  }

  for (const rule of autoGrants) {
    if (!rule.target || !rule.target_field) continue;

    // Source merit must be present on the character
    const hasMerit = (c.merits || []).some(m => m.name === rule.source);
    if (!hasMerit) continue;

    let amount = _computeAmount(c, rule);
    if (amount <= 0) continue;
    // Fix (live bug report, 2026-09-09): rating_of_partner_merit sums cp+xp across EVERY
    // instance of each partner merit name. That was fine pre-Sway-merge (a character held one
    // or two matching instances); post-merge "Sway" is a broad umbrella a character can hold
    // many separate instances of (Legal/Police/Underworld/Transportation...), so the same
    // formula now over-grants. cap_at is the ST's own explicit ceiling on this specific rule's
    // output, not a general clamp — most auto_bonus rules have no cap_at and are unaffected.
    if (typeof rule.cap_at === 'number' && amount > rule.cap_at) amount = rule.cap_at;

    // Apply to the target merit instance (first match — auto-bonus targets a
    // single merit by name; if multiple instances exist, pick the first).
    const target = (c.merits || []).find(m => m.name === rule.target);
    if (target) target[rule.target_field] = amount;
  }
}

// ── Amount computation ────────────────────────────────────────────────────────

function _computeAmount(c, rule) {
  switch (rule.amount_basis) {
    case 'rating_of_partner_merit': {
      const names = Array.isArray(rule.partner_merit_names)
        ? rule.partner_merit_names
        : (rule.partner_merit_name ? [rule.partner_merit_name] : []);
      return names.reduce((sum, n) => sum + _ratingOfPartner(c, n), 0);
    }
    case 'rating_of_status': {
      // amount = sum of named statuses (covenant/clan/city). Status name may
      // be a covenant short form ('invictus', 'carthian') or full name; the
      // helper normalises. Use partner_status_names (array) or _name (singular).
      const names = Array.isArray(rule.partner_status_names)
        ? rule.partner_status_names
        : (rule.partner_status_name ? [rule.partner_status_name] : []);
      return names.reduce((sum, n) => sum + _statusValue(c, n), 0);
    }
    case 'flat':
      return rule.amount ?? 0;
    default:
      return 0;
  }
}

/**
 * Sum of (cp + xp) across all merits with the given name. Mirrors
 * pool-evaluator's _ratingOfPartner — purchased dots only, not free grants.
 */
function _ratingOfPartner(c, partnerMeritName) {
  if (!partnerMeritName) return 0;
  let total = 0;
  (c.merits || []).forEach(m => {
    if (m.name !== partnerMeritName) return;
    // inherent-intentional: partner-rating sum must use purchased dots only (cp+xp); engine-derived bonuses (m.bonus) are excluded by design.
    total += (m.cp || 0) + (m.xp || 0);
  });
  return total;
}

/**
 * Resolve a status qualifier (covenant short/full name, or 'city'/'clan')
 * against the unified status shape on the character. Inline duplicate of
 * data/prereq.js:_getStatus — evaluators must be import-free.
 */
const _COV_FULL = {
  carthian: 'Carthian Movement', crone: 'Circle of the Crone',
  invictus: 'Invictus', lance: 'Lancea et Sanctum',
  sanctified: 'Lancea et Sanctum', ordo: 'Ordo Dracul',
};
function _statusValue(c, qualifier) {
  if (!qualifier) return 0;
  const q = String(qualifier).toLowerCase();
  if (q === 'city') return c.status?.city || 0;
  if (q === 'clan') return c.status?.clan || 0;
  const fullName = _COV_FULL[q] || qualifier;
  return c.status?.covenant?.[fullName] || 0;
}
