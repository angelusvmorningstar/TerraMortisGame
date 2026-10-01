/* v2 schema accessor functions — shared between Editor and Suite */

import { CLAN_DISCS } from './constants.js';
import { getRulesCache } from '../editor/rule_engine/load-rules.js';
import { hasAoE, findRegentTerritory, displayName } from './helpers.js';
import {
  MISS_NOT_LOADED, MISS_UNKNOWN, MISS_EMPTY_COLLECTION,
  isLoaded as bloodlinesLoaded,
  isEmpty as bloodlinesEmpty,
  bloodlineDiscs,
  recordBloodlineMiss,
  clearBloodlineMissesFor,
} from './bloodlines-cache.js';
export { meritEffectiveRating } from '../editor/domain.js';

// ── Clan/bloodline/covenant discipline helpers ──

/**
 * Return the list of in-clan disciplines for a character: the bloodline list
 * when the character has a bloodline, else the clan list.
 *
 * BL-2 (#1008) moved the bloodline half from the static `BLOODLINE_DISCS`
 * constant to the `bloodlines` collection via `bloodlines-cache.js`.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *   The miss path is the point of this function
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   This feeds the XP cost multiplier at `editor/edit.js:654` (in-clan 3 per
 *   dot, out-of-clan 4). The previous implementation was
 *
 *       BLOODLINE_DISCS[c?.bloodline] || CLAN_DISCS[c?.clan] || []
 *
 *   whose miss returned the character's CLAN list. That is well-formed,
 *   plausible and wrong, and it survives eyeballing - Ocka Keats' disciplines
 *   cost 4 instead of 3 for two weeks because of it (drift pattern #15). It is
 *   worse than "stale by one discipline": 7 of the 23 bloodlines DROP a clan
 *   discipline, so for those the clan fallback is wrong in both directions at
 *   once, granting in-clan cost to a discipline the bloodline does not have
 *   and charging out-of-clan for one it does.
 *
 *   Ruled by Angelus 2026-08-10: an unresolved bloodline returns an EMPTY
 *   list, never the clan list. Everything then costs 4 per dot - wrong HIGH,
 *   which somebody notices and complains about, rather than wrong LOW, which
 *   nobody ever does. The miss is registered so the banner can name it and the
 *   editor can refuse to commit a cost against it.
 *
 *   A character with NO bloodline is not a miss. That is the normal case for
 *   most of the roster and still returns the clan list unchanged.
 */
export function clanDiscList(c) {
  const bl = c?.bloodline;
  if (!bl) return CLAN_DISCS[c?.clan] || [];

  // Three causes, kept apart because each has a different remedy: the cache is
  // absent (transient, everyone, reload); the collection is empty (operational,
  // everyone, seed it); the name is unknown (persistent, one character, fix the
  // data). Collapsing them would point the reader at the wrong problem.
  if (!bloodlinesLoaded()) {
    recordBloodlineMiss(MISS_NOT_LOADED, bl, _missLabel(c));
    return [];
  }
  if (bloodlinesEmpty()) {
    recordBloodlineMiss(MISS_EMPTY_COLLECTION, bl, _missLabel(c));
    return [];
  }
  const discs = bloodlineDiscs(bl);
  if (!discs) {
    recordBloodlineMiss(MISS_UNKNOWN, bl, _missLabel(c));
    return [];
  }
  // Success clears any miss standing against this character, so the banner
  // self-corrects the moment an ST fixes a typo and the sheet re-renders.
  clearBloodlineMissesFor(_missLabel(c));
  return discs;
}

/** Best available human label for the banner. Never throws on a partial doc. */
function _missLabel(c) {
  try { return displayName(c) || c?.name || '(unnamed)'; }
  catch { return c?.name || '(unnamed)'; }
}

/**
 * True when this character HAS a bloodline that could not be resolved - either
 * because the cache is unavailable or because the name is unknown.
 *
 * The editor uses this to refuse discipline-cost writes: while it is true, the
 * in-clan/out-of-clan answer on screen is not trustworthy, and committing a
 * dot bought against it would bake a wrong cost into the document. A character
 * with no bloodline is never locked - that is most of the roster.
 *
 * Deliberately expressed in terms of `clanDiscList`, so the lock and the
 * costing can never disagree about what "unresolved" means, and so a call here
 * registers the miss for the banner exactly as a render would.
 */
export function bloodlineUnresolved(c) {
  if (!c?.bloodline) return false;
  return clanDiscList(c).length === 0;
}

/**
 * Cruac and Theban are always out-of-clan regardless of covenant per house rule.
 * Only clan/bloodline disciplines count as in-clan.
 */
export function isInClanDisc(c, discName) {
  if (!discName) return false;
  if (clanDiscList(c).includes(discName)) return true;
  return false;
}

// ── Physical discipline → attribute / derived-stat mapping ──
// Rules sourced from rule_disc_attr collection (seeded by seed-rules-disc-attr.js).
// TM house rule: Celerity adds to Speed + Defence only — NOT Dexterity.
// Legacy fallback (cache not loaded): Vigour→Strength, Resilience→Stamina only.

/**
 * Discipline bonus for a physical attribute.
 * Reads from rule_disc_attr where target_kind='attribute'.
 * Falls back to hardcoded map when rules are not loaded.
 */
export function discAttrBonus(c, attr) {
  const cache = getRulesCache();
  if (!cache?.rule_disc_attr) {
    const LEGACY = { Strength: 'Vigour', Stamina: 'Resilience' };
    const disc = LEGACY[attr];
    return disc ? (c.disciplines?.[disc]?.dots || 0) : 0;
  }
  const rule = cache.rule_disc_attr.find(r => r.target_kind === 'attribute' && r.target_name === attr);
  if (!rule) return 0;
  return c.disciplines?.[rule.discipline]?.dots || 0;
}

/** Discipline bonus for a derived stat (Speed, Defence). Reads from rule_disc_attr. */
function _discDerivedBonus(c, derivedStat) {
  const cache = getRulesCache();
  if (!cache?.rule_disc_attr) {
    return c.disciplines?.Celerity?.dots || 0;
  }
  return cache.rule_disc_attr
    .filter(r => r.target_kind === 'derived_stat' && r.target_name === derivedStat)
    .reduce((sum, rule) => sum + (c.disciplines?.[rule.discipline]?.dots || 0), 0);
}

// ── Attributes ──

export function getAttrVal(c, attr) {
  return c.attributes?.[attr]?.dots || 0;
}

export function getAttrBonus(c, attr) {
  return c.attributes?.[attr]?.bonus || 0;
}

/** Base dots + merit/title bonus (no discipline enhancement). */
export function getAttrTotal(c, attr) {
  return getAttrVal(c, attr) + getAttrBonus(c, attr);
}

/** Full effective value: base + bonus + discipline enhancement. Use for pools and derived stats. */
export function getAttrEffective(c, attr) {
  return getAttrVal(c, attr) + getAttrBonus(c, attr) + discAttrBonus(c, attr);
}

export function setAttrVal(c, attr, dots, bonus) {
  if (!c.attributes) c.attributes = {};
  // Preserve cp/xp/free/rule_key; only overwrite dots. tm-admin.10.5: `bonus` is a runtime-only
  // overlay slot, so a zero one is never written (a missing bonus reads as 0) and a nonzero
  // in-memory one is carried through for display. Saves strip it either way.
  const { bonus: _stored, ...rest } = c.attributes[attr] || {};
  c.attributes[attr] = bonus ? { ...rest, dots, bonus } : { ...rest, dots };
}

// ── Skills ──

export function getSkillObj(c, skill) {
  const v = c.skills?.[skill];
  if (!v) return { dots: 0, bonus: 0, specs: [], nine_again: false };
  return { dots: v.dots || 0, bonus: v.bonus || 0, specs: v.specs || [], nine_again: !!v.nine_again };
}

export function setSkillObj(c, skill, obj) {
  if (!c.skills) c.skills = {};
  if (!obj.specs?.length && !obj.nine_again && !obj.bonus && obj.dots === 0) {
    delete c.skills[skill];
  } else {
    // tm-admin.10.5: no zero `bonus` written; a nonzero in-memory (overlay) one is carried through.
    const next = { dots: obj.dots, specs: obj.specs || [], nine_again: !!obj.nine_again };
    c.skills[skill] = obj.bonus ? { ...next, bonus: obj.bonus } : next;
  }
}

/**
 * Effective discipline rating: dots + bonus. CORRECTED 2026-08-31 ("one true rating" investigation)
 * - discObj.bonus is a real, schema-declared field (added for CP/XP/Derived/Bonus edit-card parity),
 * deliberately kept separate from `dots` so it is not double-counted with the purchase channels -
 * which means a read-side total must add it back on, and this accessor never did. Dormant today
 * (every live discipline has bonus:0) but is the exact "correct until real data exercises it" bug
 * class this investigation exists to close. Every real caller (downtime-form.js, feeding-pool.js)
 * uses this for pool totals and gating checks, the same effective-rating semantics as getAttrEffective.
 */
export function discDots(c, disc) {
  const d = c.disciplines?.[disc];
  return (d?.dots || 0) + (d?.bonus || 0);
}

/**
 * Count of a character's Touchstones currently "Attached" — gdx.12,
 * rulebook p.108's touchstone modifier for Detachment rolls needs this
 * count, not the full per-touchstone Attached/Detached list. Formula
 * verified to agree with the 4 existing inline sites using this same
 * predicate: public/js/suite/sheet.js:268; public/js/editor/sheet.js:428,451;
 * public/js/admin/downtime-story.js:1698,1765,1897.
 */
export function attachedTouchstoneCount(c) {
  const hum = c.humanity || 0;
  return (c.touchstones || []).filter(t => hum >= t.humanity).length;
}

export function skDots(c, skill) { return c.skills?.[skill]?.dots || 0; }
export function skBonus(c, skill) { return c.skills?.[skill]?.bonus || 0; }
export function skTotal(c, skill) {
  const base = skDots(c, skill) + skBonus(c, skill);
  const ptBonus  = (c._pt_dot4_bonus_skills  instanceof Set && c._pt_dot4_bonus_skills.has(skill)  && base < 5) ? 1 : 0;
  const mciBonus = (c._mci_dot3_skills        instanceof Set && c._mci_dot3_skills.has(skill)        && base < 5) ? 1 : 0;
  return Math.min(base + ptBonus + mciBonus, 5);
}
export function skSpecs(c, skill) { return c.skills?.[skill]?.specs || []; }
export function skSpecStr(c, skill) { return skSpecs(c, skill).join(', '); }
export function skNineAgain(c, skill) {
  return c.skills?.[skill]?.nine_again ||
    c._pt_nine_again_skills?.has(skill) ||
    c._mci_dot3_skills?.has(skill) ||
    c._ohm_nine_again_skills?.has(skill) ||
    false;
}

// ── Merits by category ──

export function meritsByCategory(c, cat) {
  return (c.merits || []).filter(m => m.category === cat);
}
export function influenceMerits(c) { return meritsByCategory(c, 'influence'); }
export function domainMerits(c) { return meritsByCategory(c, 'domain'); }
export function standingMerits(c) { return meritsByCategory(c, 'standing'); }
export function generalMerits(c) { return meritsByCategory(c, 'general'); }
export function manoeuvres(c) { return meritsByCategory(c, 'manoeuvre'); }

// influenceTotal removed — was a thin sum-of-ratings used by two trackers
// (admin/session-tracker, suite/tracker) while game/tracker used the proper
// calcTotalInfluence (full breakdown with status + HWV + Contacts threshold +
// MCI-at-5). The trackers diverged silently. Both now use calcTotalInfluence
// from editor/domain.js so all influence-resource maxes match. (May 2026)

// ── Domain shortcuts ──

export function domainRating(c, name) {
  const matches = domainMerits(c).filter(dm => dm.name === name);
  if (!matches.length) return 0;
  // Multiple Safe Place / Feeding Grounds instances are summed into one value.
  // Individual descriptors are not exported (no column for them in the merge template).
  if (matches.length === 1) return matches[0].rating || 0;
  return matches.reduce((s, dm) => s + (dm.rating || 0), 0);
}

// ── Powers by category ──

export function discPowers(c, discName) {
  return (c.powers || []).filter(p => p.category === 'discipline' && p.discipline === discName);
}
export function devotions(c) {
  return (c.powers || []).filter(p => p.category === 'devotion');
}
export function rites(c, tradition) {
  const all = (c.powers || []).filter(p => p.category === 'rite');
  return tradition ? all.filter(r => r.tradition === tradition) : all;
}
export function pacts(c) {
  return (c.powers || []).filter(p => p.category === 'pact');
}

// ── Rite cost + skill acquisition pool string ──

export function riteCost(rite) {
  const tradition = rite.tradition || rite.parent || '';
  const level = rite.level || rite.rank || 1;
  if (tradition === 'Theban') return { vitae: 0, wp: 1, label: '1 WP' };
  if (tradition === 'Cruac') {
    const vitae = level >= 4 ? 2 : 1;
    return { vitae, wp: 0, label: vitae + ' V' };
  }
  return { vitae: 0, wp: 0, label: '' };
}

/** Build a human-readable pool expression for a skill acquisition.
 *  Per VtR 2e rules the pool is SKILL only (no attribute addend).
 *  Used by the player form's legacy blob and the ST queue construction. */
export function skillAcqPoolStr(c, { skill = '', spec = '' } = {}) {
  if (!skill) return '';
  const parts = [];
  let total = 0;
  const v = skTotal(c, skill);
  parts.push(`${skill} ${v}`);
  total += v;
  if (spec) {
    const skillSpecs = c.skills?.[skill]?.specs || [];
    if (skillSpecs.includes(spec)) {
      const bonus = (skNineAgain(c, skill) || hasAoE(c, spec)) ? 2 : 1;
      parts.push(spec);
      total += bonus;
    }
  }
  return parts.length ? `${parts.join(' + ')} — ${total}` : '';
}

// ── Derived stats ──

export function calcSize(c) {
  const rules = getRulesCache()?.rule_derived_stat_modifier;
  if (!rules) {
    const giant = (c.merits || []).find(m => m.name === 'Giant');
    return 5 + (giant ? 1 : 0);
  }
  return 5 + _derivedStatModBonus(c, 'size', rules);
}

export function calcSpeed(c) {
  const str = getAttrEffective(c, 'Strength');
  const dex = getAttrTotal(c, 'Dexterity');
  const sz = calcSize(c);
  const rules = getRulesCache()?.rule_derived_stat_modifier;
  const bonus = rules
    ? _derivedStatModBonus(c, 'speed', rules)
    : ((c.merits || []).find(m => m.name === 'Fleet of Foot')?.rating || 0);
  return str + dex + sz + _discDerivedBonus(c, 'Speed') + bonus;
}

export function calcDefence(c) {
  const dex = getAttrTotal(c, 'Dexterity');
  const wits = getAttrVal(c, 'Wits');
  const base = Math.min(dex, wits);
  const rules = getRulesCache()?.rule_derived_stat_modifier;
  const skill = rules
    ? _getDefenceSkill(c, rules)
    : (() => { const dc = (c.merits || []).find(m => m.name === 'Defensive Combat'); return dc ? skDots(c, dc.qualifier || 'Athletics') : skDots(c, 'Athletics'); })();
  return base + skill + _discDerivedBonus(c, 'Defence');
}

/** Sum flat and rating bonuses from derived_stat_modifier rules for a target stat. */
function _derivedStatModBonus(c, targetStat, rules) {
  return rules
    .filter(r => r.target_stat === targetStat && r.mode !== 'skill_swap')
    .reduce((sum, rule) => {
      const merit = (c.merits || []).find(m => m.name === rule.source);
      if (!merit) return sum;
      if (rule.mode === 'flat') return sum + (rule.flat_amount || 0);
      if (rule.mode === 'rating') return sum + (merit.rating || 0);
      return sum;
    }, 0);
}

/** Determine the skill dots for the Defence formula, respecting any skill_swap rules. */
function _getDefenceSkill(c, rules) {
  const swapRule = rules.find(r => r.target_stat === 'defence' && r.mode === 'skill_swap');
  if (!swapRule) return skDots(c, 'Athletics');
  const merit = (c.merits || []).find(m => m.name === swapRule.source);
  if (!merit) return skDots(c, swapRule.swap_from || 'Athletics');
  return skDots(c, merit.qualifier || swapRule.swap_to || swapRule.swap_from || 'Athletics');
}

export function calcHealth(c) {
  return getAttrEffective(c, 'Stamina') + calcSize(c);
}

export function calcWillpowerMax(c) {
  return getAttrVal(c, 'Resolve') + getAttrVal(c, 'Composure');
}

// ── Blood Potency table (VtR 2e core p.101) ──

const BP_TABLE = {
  0: { vitae: 5, per_turn: 1, surge: 1, mend: 1, feed: 'animal' },
  1: { vitae: 10, per_turn: 1, surge: 1, mend: 1, feed: 'animal' },
  2: { vitae: 11, per_turn: 2, surge: 1, mend: 1, feed: 'animal' },
  3: { vitae: 12, per_turn: 3, surge: 2, mend: 1, feed: 'human' },
  4: { vitae: 13, per_turn: 4, surge: 2, mend: 2, feed: 'human' },
  5: { vitae: 15, per_turn: 5, surge: 3, mend: 2, feed: 'kindred' },
  6: { vitae: 20, per_turn: 6, surge: 3, mend: 3, feed: 'kindred' },
  7: { vitae: 25, per_turn: 7, surge: 4, mend: 3, feed: 'kindred' },
  8: { vitae: 30, per_turn: 8, surge: 5, mend: 4, feed: 'kindred' },
  9: { vitae: 50, per_turn: 10, surge: 6, mend: 5, feed: 'kindred' },
  10: { vitae: 75, per_turn: 15, surge: 7, mend: 6, feed: 'kindred' },
};
export { BP_TABLE };

export function calcVitaeMax(c) {
  return (BP_TABLE[c.blood_potency || 0] || BP_TABLE[1]).vitae;
}

// ── City Status (base + title bonus) ──

import { TITLE_STATUS_BONUS } from './constants.js';
import { calcEffectiveCityStatus, regentAmbienceBonusFor } from './city-status-calc.js';

export function titleStatusBonus(c) {
  return TITLE_STATUS_BONUS[c.court_category] || 0;
}

// Module-level territories store, set by load sites via setStatusTerritories
// (or implicitly kept in sync with the apps' own caches). Used by the City
// Status calc path to recompute the regent ambience bonus from fresh data
// every call (per issue #13 Surface 2: drop the c._regentTerritory cache).
let _currentTerritories = [];

/** Update the module-level territories store. Call this whenever the app's
 *  own territories cache is loaded or mutated (load, save, ambience confirm). */
export function setStatusTerritories(territories) {
  _currentTerritories = Array.isArray(territories) ? territories : [];
}

/** Resolve a character's regent territory from the module-level store. */
export function getRegentTerritoryFor(c) {
  return findRegentTerritory(_currentTerritories, c);
}

/**
 * Read the module-level territories store. Returns the live list (loaded by
 * the app at boot via `setStatusTerritories`) or an empty array if not yet
 * populated. Single source of truth for any consumer that needs the full
 * territory list (N-4 White Ants picker, etc.) — avoids each call site
 * re-fetching `/api/territories`.
 */
export function getStoredTerritories() {
  return _currentTerritories;
}

// Lieutenants intentionally receive no ambience bonus (issue #13 Q-A, 2026-05-05).
// Bonus is regent-only by design; do not extend to lieutenant_id without an
// explicit game-rules decision.
export function regentAmienceBonus(c) {
  return regentAmbienceBonusFor(getRegentTerritoryFor(c)?.ambience);
}

// otc.2 (2026-08-12): the actual arithmetic (title bonus + regent-ambience
// bonus + the 10-cap) now lives in the pure, server-importable
// city-status-calc.js — the server's own budget check was silently using a
// different, incomplete formula. This wrapper preserves the exact
// single-argument signature every existing call site already uses.
//
// prax.0: `heldOfficeCategories` is an optional pass-through to
// `calcEffectiveCityStatus`, for the one caller that knows every office the
// character actually holds (office-tab.js's Head of State budget preview, which
// already has the seat list in hand). Every other call site keeps passing one
// argument and is completely unaffected.
export function calcCityStatus(c, heldOfficeCategories) {
  return calcEffectiveCityStatus(c, getRegentTerritoryFor(c)?.ambience, heldOfficeCategories);
}
