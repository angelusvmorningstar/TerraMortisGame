// Cross-app decision rules for the Feeding tab (Epic 12, Story 12.7).
//
// EVERY FUNCTION IN THIS FILE IS A PORT, NOT A NEW RULE. Each one is copied from
// TM Story's own `public/js/downtime-form/feeding-reference.js` (and, for
// `conformance`, `public/js/downtime-form/pool-builder.js`), which is the single
// authority for what a feeding pool may be and when it may be rolled. The cited
// line numbers are as of 2026-09-11.
//
// WHY A COPY AT ALL, given Story 12.7's AC 12 ("not reimplemented or hand-copied
// into TM Game"): the thing AC 12 forbids duplicating is the DATA - the template
// list, which TM Game now fetches live from
// `GET /api/wiki/v1/downtime/feeding-templates` and never hardcodes - and the
// AUTHORITATIVE decision, which is the new TM Story write endpoint's own
// server-side enforcement (AC 3). The browser cannot import a module across
// origins from TM Story's service, so the client-side half of the gate has to
// exist here in some form; AC 14 asks for it to be "reproduced faithfully", which
// is what this file is. The server still refuses anything this file would wrongly
// allow, so a drift here can only ever be a worse message, never a wrong write.
//
// KEEP IN STEP. If TM Story changes any of these, change them here in the same
// pass. No function in this file may gain a TM-Game-only branch.

// feeding-reference.js:80 - the declared-custom-approach sentinel.
export const OTHER_METHOD_ID = 'other';

// feeding-reference.js:82-84.
export function isCustomApproach(methodKey) {
  return methodKey === OTHER_METHOD_ID;
}

// feeding-reference.js:109-120. One canonical in-memory shape whether a template
// came off the wire or (in TM Story's case) out of its seed constants.
function toTemplate({ key, name, desc, attrs, skills, discs, violence_default: violence }) {
  const list = (v) => (Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t) : []);
  return {
    key,
    name,
    desc: typeof desc === 'string' ? desc : '',
    attrs: list(attrs),
    skills: list(skills),
    discs: list(discs),
    violence_default: violence === 'kiss' || violence === 'violent' ? violence : null,
  };
}

/**
 * feeding-reference.js:148-157, MINUS THE SEED FALLBACK - and that omission is
 * deliberate, not an incomplete port.
 *
 * TM Story falls back to its own shipped `SEED_TEMPLATES` when the fetch gives
 * nothing, because its Feeding section is REQUIRED and may never render zero
 * methods. TM Game has the opposite obligation: Story 12.7's AC 12 says the
 * template list is read from TM Story and "never hardcoded a second time in TM
 * Game", and the new write endpoint refuses any method key that is not a live
 * template (AC 3). A local seed list here would therefore be a second copy of the
 * data AC 12 exists to prevent, and would offer cards the server would then
 * refuse. An empty list is the honest answer, and the tab says so in words.
 */
export function normaliseTemplates(fetched) {
  const rows = Array.isArray(fetched) ? fetched : [];
  return rows
    .filter((r) => r && typeof r.key === 'string' && r.key && typeof r.name === 'string' && r.name)
    .filter((r) => r.key !== OTHER_METHOD_ID)
    .map(toTemplate);
}

// feeding-reference.js:163-166. Null for the unset method, for `other`, and for a
// key no live template carries any more (a retired template a submission still
// references) - all three mean "nothing to judge this pool against".
export function templateForMethod(templates, methodKey) {
  if (!Array.isArray(templates) || !methodKey || methodKey === OTHER_METHOD_ID) return null;
  return templates.find((t) => t.key === methodKey) || null;
}

// feeding-reference.js:168-171.
export function violenceDefaultFor(templates, methodKey) {
  const t = templateForMethod(templates, methodKey);
  return t ? t.violence_default : null;
}

// pool-builder.js:43-51. 'none' when there is nothing to judge yet, 'on-template'
// when every chosen trait is in the suggestion set, else 'custom'.
export function conformance(state, suggestions) {
  if (!suggestions) return 'none';
  const has = (suggestions.attrs?.length || suggestions.skills?.length || suggestions.discs?.length);
  if (!has || !state.attr || !state.skill) return 'none';
  const onTemplate = suggestions.attrs.includes(state.attr)
    && suggestions.skills.includes(state.skill)
    && (!state.disc || suggestions.discs.includes(state.disc));
  return onTemplate ? 'on-template' : 'custom';
}

// feeding-reference.js:499-505. Which of the three pool modes the builder is in.
// The ORDER OF THESE BRANCHES IS THE WHOLE CONTRACT - see that file's own long
// header for why each one is where it is. Read defensively rather than
// destructured with a default parameter, matching the original.
export function poolLockMode(input) {
  const { recalled = false, hasTemplate = false, isCustom = false, offTemplate = false } = input || {};
  if (isCustom) return recalled ? 'recall' : 'open';
  if (!hasTemplate) return 'open';
  if (recalled) return 'recall';
  return offTemplate ? 'open' : 'template';
}

/**
 * feeding-reference.js:277-292, reproduced exactly (Story 12.7, AC 14): a player
 * must see the same block/unblock behaviour in either app for the same declared
 * pool, including the same words.
 *
 * `isCustom` is checked FIRST and unconditionally ahead of `hasMethod`, and
 * `recalled` only ever matters on the isCustom branch - both preserved from the
 * original, where they were themselves review fixes.
 */
export function feedingRollGate({ hasMethod, isCustom, recalled = false, violence }) {
  if (isCustom) {
    if (!recalled) return { available: false, reason: 'Custom pools need ST review before you can roll.' };
  } else if (!hasMethod) {
    return { available: false, reason: 'pick a method above, or use your last approved pool, to unlock it.' };
  }
  if (violence == null) return { available: false, reason: 'choose The Kiss or Assault above to unlock it.' };
  return { available: true, reason: null };
}

/**
 * feeding-reference.js:307-331, field-for-field.
 *
 * TM Game never WRITES this value - the new endpoint computes the stored
 * signature server-side with TM Story's own copy (Story 12.7's data-lock finding
 * #3 rules out a second implementation of the write). It is computed here only to
 * answer the read-side question TM Story's own renderRollStatus() asks: does the
 * stored result still describe the pool currently on screen. A mismatch here can
 * only ever hide a stale result, never save a wrong one.
 */
export function feedingRollSignature(state, { roteClaimed = false, groundsBonus = 0 } = {}) {
  return JSON.stringify({
    method: state.method, poolAttr: state.poolAttr, poolSkill: state.poolSkill,
    poolDisc: state.poolDisc,
    poolSpecChip: state.poolLocked ? null : state.poolSpecChip,
    rote: roteClaimed, groundsBonus,
  });
}

// feeding-reference.js:336-342. The real VtR harm scale for one vessel's own
// Vitae draw. TM Game's `feeding-tab.js` already carried this ladder as
// fvcConseqText/fvcConseqClass (TM Story ported it FROM there); this is the same
// ladder in TM Story's own return shape, for the ported vessel-drain markup.
export function vesselHarmTier(vitae) {
  if (!vitae || vitae <= 2) return { label: 'Safe', cls: 'vd-safe' };
  if (vitae === 3) return { label: 'Drained', cls: 'vd-drained' };
  if (vitae <= 5) return { label: 'Serious injury', cls: 'vd-serious' };
  if (vitae === 6) return { label: 'Critical', cls: 'vd-critical' };
  return { label: 'Fatal', cls: 'vd-fatal' };
}

// feeding-reference.js:351-355. 1-2 Vitae green, 3-4 amber, 5+ red - deliberately
// SEPARATE from the five-tier label scale above.
export function vitaeColourClass(vitae) {
  if (vitae <= 2) return 'vd-c-green';
  if (vitae <= 4) return 'vd-c-amber';
  return 'vd-c-red';
}

/**
 * prefill.js:159-188 - what "Same as Last Time" may offer, or null.
 *
 * `previous` is the body of `GET .../previous` (its `previous` key), exactly as
 * TM Story's own form consumes it. A method alone is not an approved pool:
 * attr AND skill are both required, never discipline ("No Discipline" is a real,
 * complete choice).
 *
 * TM Game does not carry TM Story's DEFAULT_BLOOD_TYPE constant, so the blood-type
 * default is spelled out here as the literal that constant currently holds
 * ('Human', content-shape.js) with this note attached: if TM Story changes it
 * again (it moved Animal -> Human on 2026-09-01), change it here in the same pass.
 */
export function feedingPoolRecall(previous) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const filled = (v) => str(v).trim() !== '';
  const feed = previous?.feeding;
  if (!feed || !filled(feed.method) || !filled(feed.poolAttr) || !filled(feed.poolSkill)) return null;
  const cycle = previous?.cycle || {};
  const label = filled(cycle.label) ? cycle.label : 'Last cycle';
  return {
    label,
    method: feed.method,
    poolAttr: str(feed.poolAttr), poolSkill: str(feed.poolSkill), poolDisc: str(feed.poolDisc),
    poolSpecChip: feed.poolSpecChip == null ? null : str(feed.poolSpecChip),
    bloodType: ['Animal', 'Human', 'Kindred'].includes(feed.bloodType) ? feed.bloodType : 'Human',
    violence: feed.violence === 'kiss' || feed.violence === 'violent' ? feed.violence : null,
    description: str(feed.description),
  };
}
