/**
 * Bloodline grants evaluator.
 * Reads rule_grant docs with condition:'bloodline' and applies the same
 * side-effects as the legacy BLOODLINE_GRANTS block in applyDerivedMerits.
 *
 * No imports — pure function; safe to call in Node.js test contexts.
 */

/**
 * Apply bloodline grant rules from the DB against a character.
 *
 * grant_type:'merit'     — auto-creates the target merit with free_bloodline=1;
 *                          case-insensitive qualifier dedup preserved.
 * grant_type:'speciality'— pushes target_qualifier spec onto target skill if absent.
 *
 * @param {object} c - character (mutated in place; phase-1 _bloodline_free_specs clear done by caller)
 * @param {{ grants: object[] }} bloodlineRules
 */
export function applyBloodlineRulesFromDb(c, { grants = [] } = {}) {
  // Clear stale free/free_bloodline from previous render pass.
  // Lifecycle guard: ex-bloodline characters don't carry orphaned grant dots indefinitely.
  (c.merits || []).forEach(m => {
    if (m.granted_by === 'Bloodline') { m.free = 0; m.free_bloodline = 0; }
  });

  if (!c.bloodline) return;

  const bloodline = c.bloodline;
  const relevant = grants.filter(r =>
    r.condition === 'bloodline' &&
    (r.bloodline_name || '').toLowerCase() === bloodline.toLowerCase(),
  );

  for (const rule of relevant) {
    if (rule.grant_type === 'speciality') {
      const skill = rule.target;
      const spec = rule.target_qualifier;
      if (!skill || !spec) continue;
      if (!c.skills) c.skills = {};
      if (!c.skills[skill]) c.skills[skill] = { dots: 0, specs: [], nine_again: false };
      if (!c.skills[skill].specs) c.skills[skill].specs = [];
      if (!c.skills[skill].specs.includes(spec)) c.skills[skill].specs.push(spec);
      if (!c._bloodline_free_specs) c._bloodline_free_specs = [];
      c._bloodline_free_specs.push({ skill, spec });
    } else if (rule.grant_type === 'merit') {
      const gq = (rule.target_qualifier || '').toLowerCase().trim();
      // Case-insensitive qualifier match to avoid duplicates from capitalisation drift
      const existing = (c.merits || []).find(m =>
        m.name === rule.target && m.granted_by === 'Bloodline' &&
        (m.qualifier || '').toLowerCase().trim() === gq,
      );
      if (existing) {
        // Normalise qualifier case to canonical form from rule definition
        if (rule.target_qualifier != null) existing.qualifier = rule.target_qualifier;
        existing.free_bloodline = 1;
      } else {
        if (!c.merits) c.merits = [];
        c.merits.push({
          name: rule.target,
          category: rule.target_category || 'general',
          qualifier: rule.target_qualifier || null,
          free_bloodline: 1,
          granted_by: 'Bloodline',
        });
      }
      // Remove any extra duplicates (stale case-mismatch entries already in DB)
      const canonical = existing || c.merits[c.merits.length - 1];
      const dupes = (c.merits || []).filter(m =>
        m !== canonical && m.name === rule.target && m.granted_by === 'Bloodline' &&
        (m.qualifier || '').toLowerCase().trim() === gq,
      );
      dupes.forEach(d => c.merits.splice(c.merits.indexOf(d), 1));
    }
  }
}
