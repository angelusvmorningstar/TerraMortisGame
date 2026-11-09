/**
 * XP calculations and merit rating/breakdown helpers.
 * Pure functions — no DOM side-effects.
 */

import { getRuleByKey } from '../data/loader.js';
// N-1: map-fallback shape for per-slug free reads (see rules-helpers.js).
import { freeOf } from '../data/rules-helpers.js';
// Code review (2026-08-31, "one true rating"): meritRating's own hardcoded
// 10-slug list was missing attache/carthian/fwb/retainer and never read
// free_grants at all - meritFreeSum is the canonical 14-slug + free_grants
// union (rules-helpers.js) with the Necropolis-target categorical gate
// (issue #790) layered on top, already the pattern rules-view.js uses.
import { meritFreeSum } from './domain.js';
// COLLECTIVE-2 (#1110): compound slug + source names reach the bd-row from
// rule data, so they are escaped like every other data-sourced label.
import { esc } from '../data/helpers.js';

/**
 * Convert XP spent into dot count (flat rate).
 * @param {number} xpSpent - total XP allocated
 * @param {number} baseBeforeXP - dots from CP/free (unused in flat model, kept for API)
 * @param {number} costPerDot - XP cost per single dot
 * @returns {number}
 */
export function xpToDots(xpSpent, baseBeforeXP, costPerDot) {
  return Math.floor((xpSpent || 0) / costPerDot);
}

/**
 * Convert a dot count into XP cost (flat rate).
 * @param {number} numDots
 * @param {number} baseBeforeXP - (unused in flat model, kept for API)
 * @param {number} costPerDot
 * @returns {number}
 */
export function dotsToXP(numDots, baseBeforeXP, costPerDot) {
  return (numDots || 0) * costPerDot;
}

/** Starting XP awarded on character creation: 10, unless the character carries an
 *  `xp_starting_override` (a second/replacement character opens on the average XP of the
 *  other players at creation; set in TM Admin, read here so the sheet agrees with it). */
export function xpStarting(c) {
  return Number.isFinite(c?.xp_starting_override) ? c.xp_starting_override : 10;
}

/** XP from voluntary humanity drops: 2 per dot permanently lost. */
export function xpHumanityDrop(c) {
  // Use explicit field if set; otherwise infer from stored humanity value
  const lost = c.humanity_lost !== undefined
    ? c.humanity_lost
    : Math.max(0, (c.humanity_base || 7) - (c.humanity || 0));
  return lost * 2;
}

/** XP from completed ordeals: 3 per ordeal. */
export function xpOrdeals(c) {
  return ((c.ordeals || []).filter(o => o.complete).length) * 3;
}

/** XP from game attendance. Requires loadGameXP() to have run — returns 0 if not yet loaded. */
export function xpGame(c) {
  return c._gameXP ?? 0;
}

/** XP bonus from Professional Training: 1 XP per asset skill at 5+ effective dots (requires PT ≥ 4).
 *  Effective dots = base dots + PT dot 4 bonus (+1 to chosen asset skill). */
export function xpPT5(c) {
  const ptM = (c.merits || []).find(m => m.name === 'Professional Training');
  if (!ptM || meritRating(c, ptM) < 4) return 0;
  const assets = (ptM.asset_skills || []).filter(Boolean);
  if (!assets.length) return 0;
  const ptBonus = c._pt_dot4_bonus_skills instanceof Set ? c._pt_dot4_bonus_skills : new Set();
  return assets.filter(sk => {
    const s = (c.skills || {})[sk];
    const effective = (s?.dots || 0) + (ptBonus.has(sk) ? 1 : 0);
    return effective >= 5;
  }).length;
}

/**
 * Total XP earned by a character (all sources, derived dynamically).
 * @param {object} c - character object
 * @returns {number}
 */
export function xpEarned(c) {
  return xpStarting(c) + xpHumanityDrop(c) + xpOrdeals(c) + xpGame(c) + xpPT5(c);
}

/** Sum XP from inline creation fields on an object (attributes, skills, disciplines). */
function sumInlineXP(obj) {
  if (!obj) return 0;
  return Object.values(obj).reduce((t, v) => t + (v?.xp || 0), 0);
}

/** XP spent on attributes — sum of .xp across all attribute objects. */
export function xpSpentAttrs(c) {
  return sumInlineXP(c.attributes);
}

/** XP spent on skills + specialisations beyond free allowance. */
export function xpSpentSkills(c) {
  const skillXP = sumInlineXP(c.skills);
  // PT free specs (dot 3): 2 extra, but ONLY usable on asset skills — tracked separately
  const ptM = (c.merits || []).find(m => m.name === 'Professional Training');
  const ptFree = (ptM && ptM.rating >= 3) ? 2 : 0;
  const ptAssets = new Set((ptM && ptM.rating >= 3 && ptM.asset_skills) ? (ptM.asset_skills || []).filter(Boolean) : []);
  let assetSpecs = 0, nonAssetSpecs = 0;
  Object.entries(c.skills || {}).forEach(([sk, skillObj]) => {
    const count = (skillObj && skillObj.specs) ? skillObj.specs.length : 0;
    if (ptAssets.has(sk)) assetSpecs += count;
    else nonAssetSpecs += count;
  });
  // MCI dot 1 free specs: each active MCI with dot1_choice === 'speciality' grants 1 free spec
  const mciFreeSpecs = (c._mci_free_specs || []).filter(fs =>
    fs.skill && fs.spec && (c.skills || {})[fs.skill] && ((c.skills[fs.skill].specs || []).includes(fs.spec))
  ).length;
  // Bloodline-granted specs are also exempt from XP cost
  const bloodlineFreeSpecs = (c._bloodline_free_specs || []).filter(fs =>
    fs.skill && fs.spec && (c.skills || {})[fs.skill] && ((c.skills[fs.skill].specs || []).includes(fs.spec))
  ).length;
  // PT free covers asset specs first; baseline 3 covers everything else
  const ptFreeCovered = Math.min(ptFree, assetSpecs);
  const paidSpecs = nonAssetSpecs + Math.max(0, assetSpecs - ptFreeCovered);
  const specXP = Math.max(0, paidSpecs - 3 - mciFreeSpecs - bloodlineFreeSpecs);
  return skillXP + specXP;
}

/** XP spent on all merits (general, influence, domain, standing) + fighting styles + pact oaths. */
export function xpSpentMerits(c) {
  const meritXP = (c.merits || []).reduce((t, m) => t + (m.xp || 0), 0);
  const styleXP = (c.fighting_styles || []).reduce((t, fs) => t + (fs.xp || 0), 0);
  const pactXP = (c.powers || []).filter(p => p.category === 'pact').reduce((t, p) => t + (p.xp || 0), 0);
  return meritXP + styleXP + pactXP;
}

/** XP spent on powers — disciplines + devotions. */
export function xpSpentPowers(c) {
  const discXP = sumInlineXP(c.disciplines);
  // Devotion XP: look up each devotion's cost from DEVOTIONS_DB
  const devXP = (c.powers || [])
    .filter(p => p.category === 'devotion')
    .reduce((t, p) => {
      // Try rules cache first, fallback to _devotionsDB
      const slug = 'devotion-' + p.name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const rule = getRuleByKey(slug);
      if (rule) return t + (rule.xp_fixed || 0);
      const db = _devotionsDB ? _devotionsDB.find(d => d.n === p.name) : null;
      return t + (db ? db.xp || 0 : 0);
    }, 0);
  // Rite XP: paid rites cost 1 XP (rank 1-3) or 2 XP (rank 4-5)
  const riteXP = (c.powers || [])
    .filter(p => p.category === 'rite' && !p.free)
    .reduce((t, p) => t + (p.level >= 4 ? 2 : 1), 0);
  return discXP + devXP + riteXP;
}

/** XP spent on special: Blood Potency, Humanity, lost Willpower dots. */
export function xpSpentSpecial(c) {
  // Blood Potency: tracked directly in bp_creation.xp (new model) or derived (legacy)
  const bpXP = (c.bp_creation || {}).xp !== undefined
    ? ((c.bp_creation || {}).xp || 0)
    : Math.max(0, (c.blood_potency || 1) - 1 - Math.floor(((c.bp_creation || {}).cp || 0) / 5)) * 5;
  // Humanity: XP spent raising dots (new model only; old model net is captured in xpHumanityDrop)
  const humXP = c.humanity_xp || 0;
  // Lost Willpower dots: stored in xp_log.spent.willpower
  const wpXP = ((c.xp_log || {}).spent || {}).willpower || 0;
  // Manual special: anything else tracked in xp_log
  const manualXP = ((c.xp_log || {}).spent || {}).special || 0;
  return bpXP + humXP + wpXP + manualXP;
}

// Devotions DB reference (set via setDevotionsDB)
let _devotionsDB = null;
export function setDevotionsDB(db) { _devotionsDB = db; }

/**
 * Total XP spent by a character (all categories, fully dynamic).
 * @param {object} c - character object
 * @returns {number}
 */
export function xpSpent(c) {
  return xpSpentAttrs(c) + xpSpentSkills(c) + xpSpentMerits(c) + xpSpentPowers(c) + xpSpentSpecial(c);
}

/**
 * Remaining unspent XP.
 * @param {object} c - character object
 * @returns {number}
 */
export function xpLeft(c) {
  return xpEarned(c) - xpSpent(c);
}

/**
 * Effective rating of a merit (sum of CP + free + grant pools + XP, inline on merit object).
 * Falls back to stored rating if inline fields are absent.
 * @param {object} c - character object
 * @param {object} m - merit entry
 * @returns {number}
 */
export function meritRating(c, m) {
  if (m.cp === undefined && m.xp === undefined) return m.rating || 0;
  return (m.cp || 0) + meritFreeSum(m) + (m.xp || 0);
}

/**
 * Render the merit breakdown row: Fr + CP + XP = total
 * @param {number} realIdx - index into c.merits
 * @param {object} mc - merit object with inline creation fields {cp, free, xp, free_mci, ...}
 * @param {number|null} fixedAt - if the merit has a fixed rating (e.g. 3 for VM), pass it here;
 *   null for graduated merits. When fixedAt is set, the displayed total snaps to 0 until the
 *   threshold is met, then shows fixedAt.
 */
export function meritBdRow(realIdx, mc, fixedAt, opts = {}) {
  const cp = mc.cp || 0, xp = mc.xp || 0, fbl = freeOf(mc, 'bloodline'), fret = freeOf(mc, 'pet'), fmci = freeOf(mc, 'mci'), fvm = freeOf(mc, 'vm'), flk = freeOf(mc, 'lk'), fohm = freeOf(mc, 'ohm'), finv = freeOf(mc, 'inv'), fpt = freeOf(mc, 'pt'), fmdb = freeOf(mc, 'mdb'), fsw = freeOf(mc, 'sw');
  // COLLECTIVE-2 (issue #1110): Collective Compound allocation channels are
  // data-driven — the caller passes the discovered slugs rather than this
  // function naming one. Defaults to ['necro'] so call sites that predate
  // the compound wiring keep their pre-#1110 total exactly.
  const _cmpSlugs = Array.isArray(opts.compoundSlugs) ? opts.compoundSlugs : ['necro'];
  const fcompound = _cmpSlugs.reduce((s, slug) => s + freeOf(mc, slug), 0);
  const total = cp + xp + fbl + fret + fmci + fvm + flk + fohm + finv + fpt + fmdb + fsw + fcompound + (opts.attachBonus || 0);
  // Effective display: for fixed merits, only show dots once the threshold is reached
  const effective = (fixedAt != null) ? (total >= fixedAt ? fixedAt : 0) : total;
  const needsHint = (fixedAt != null && total > 0 && total < fixedAt)
    ? '<span class="bd-needs-hint">' + total + ' / ' + fixedAt + ' needed</span>' : '';
  // N-7b (issue #768): Necropolis target merits are pool-funded only — the
  // domain-renderer call site suppresses CP / XP / MCI / Bonus on these rows
  // via opts.hideCP / opts.hideXP / opts.hideMCI (this block) + opts.hideBonus
  // (below). Same opts-flag pattern as N-9's hideBonus on standing merits.
  // The pre-N-7b shape rendered CP + XP + sep unconditionally; the guards
  // here are defaults-false so existing call sites that don't pass the
  // hide-flags get the legacy behaviour unchanged.
  let h = '<div class="merit-bd-row">';
  if (!opts.hideCP) h += '<div class="bd-grp"><span class="bd-lbl">CP</span><input class="merit-bd-input" type="number" min="0" value="' + cp + '" onchange="shEditMeritPt(' + realIdx + ',\'cp\',+this.value)"></div>';
  if (!opts.hideXP) h += '<div class="bd-grp"><span class="bd-lbl">XP</span><input class="merit-bd-input" type="number" min="0" value="' + xp + '" onchange="shEditMeritPt(' + realIdx + ',\'xp\',+this.value)"></div>';
  if (!opts.hideCP || !opts.hideXP) h += '<div class="bd-sep"></div>';
  // N-9 (issue #762, Bug 1 "adjacent finding"): MCI input writes the map-shape
  // `free_grants.mci` per the ADR-005 allocator-write-path amendment. The
  // handler (shEditMeritPt) detects the `free_grants.` prefix and routes to
  // the map. Pre-N-9 this wrote `free_mci`, creating a fresh divergence on
  // every edit after the N-2 backfill.
  // N-7b: showMCI is AND'd with !hideMCI at the call site so Necropolis
  // targets don't surface the MCI allocator even when there's pool capacity.
  // Issue #774: a11y — every stepper input carries id + name + aria-label
  // matching the NECRO precedent at line 241 (added by N-7c #771). Same
  // browser warning ("form field element should have an id or name
  // attribute / No label associated with a form field") was firing on
  // these 5 sibling steppers. Single-line additions per stepper.
  if (opts.showMCI && !opts.hideMCI) h += '<div class="bd-grp"><span class="bd-lbl bd-bonus-lbl" id="bd-mci-lbl-' + realIdx + '">MCI</span><input id="bd-mci-' + realIdx + '" name="bd-mci-' + realIdx + '" aria-label="Mystery Cult Initiation pool allocation" class="merit-bd-input bd-bonus-input" type="number" min="0" value="' + fmci + '" onchange="shEditMeritPt(' + realIdx + ',\'free_grants.mci\',+this.value)"></div>';
  if (opts.showVM) h += '<div class="bd-grp"><span class="bd-lbl bd-bonus-lbl" id="bd-vm-lbl-' + realIdx + '">VM</span><input id="bd-vm-' + realIdx + '" name="bd-vm-' + realIdx + '" aria-label="Viral Mythology pool allocation" class="merit-bd-input bd-bonus-input" type="number" min="0" value="' + fvm + '" onchange="shEditMeritPt(' + realIdx + ',\'free_vm\',+this.value)"></div>';
  if (opts.showLK) h += '<div class="bd-grp"><span class="bd-lbl bd-bonus-lbl" id="bd-lk-lbl-' + realIdx + '">LK</span><input id="bd-lk-' + realIdx + '" name="bd-lk-' + realIdx + '" aria-label="Lorekeeper pool allocation" class="merit-bd-input bd-bonus-input" type="number" min="0" value="' + flk + '" onchange="shEditMeritPt(' + realIdx + ',\'free_lk\',+this.value)"></div>';
  if (opts.showOHM) h += '<div class="bd-grp"><span class="bd-lbl bd-bonus-lbl" id="bd-ohm-lbl-' + realIdx + '">OHM</span><input id="bd-ohm-' + realIdx + '" name="bd-ohm-' + realIdx + '" aria-label="Oath of the Hard Motherfucker pool allocation" class="merit-bd-input bd-bonus-input" type="number" min="0" value="' + fohm + '" onchange="shEditMeritPt(' + realIdx + ',\'free_ohm\',+this.value)"></div>';
  if (opts.showINV) h += '<div class="bd-grp"><span class="bd-lbl bd-bonus-lbl" id="bd-inv-lbl-' + realIdx + '">INV</span><input id="bd-inv-' + realIdx + '" name="bd-inv-' + realIdx + '" aria-label="Invested pool allocation" class="merit-bd-input bd-bonus-input" type="number" min="0" value="' + finv + '" onchange="shEditMeritPt(' + realIdx + ',\'free_inv\',+this.value)"></div>';
  // N-7 (issue #760): Collective Compound allocator — writes directly to
  // m.free_grants.<slug> (map shape, no new legacy free_<slug> field) per the
  // ADR-005 allocator-write-path amendment.
  // N-7c (issue #771): id + aria-label so browsers don't flag "form field
  // element should have an id or name attribute / No label associated with a
  // form field". The 5 sibling steppers (LK/INV/VM/OHM/MCI) got the same
  // treatment in #774 — see lines above.
  // COLLECTIVE-2 (issue #1110): one stepper per compound the character
  // belongs to that claims this merit, each writing its OWN slug. Pre-#1110
  // this was a single `showNECRO` flag hardwired to free_grants.necro, which
  // would have written a Crone or Sanctified allocation into the Necropolis
  // pool. The descriptor supplies slug + source; no name literals here.
  for (const _cmp of (opts.compoundPools || [])) {
    if (!_cmp || !_cmp.slug) continue;
    h += '<div class="bd-grp"><span class="bd-lbl bd-bonus-lbl" id="bd-' + _cmp.slug + '-lbl-' + realIdx + '">' + esc(_cmp.slug.toUpperCase()) + '</span><input id="bd-' + _cmp.slug + '-' + realIdx + '" name="bd-' + _cmp.slug + '-' + realIdx + '" aria-label="' + esc(_cmp.source || _cmp.slug) + ' pool allocation" class="merit-bd-input bd-bonus-input" type="number" min="0" value="' + freeOf(mc, _cmp.slug) + '" onchange="shEditMeritPt(' + realIdx + ',\'free_grants.' + _cmp.slug + '\',+this.value)"></div>';
  }
  h += '<div class="bd-eq"><span class="bd-val">' + effective + ' dot' + (effective === 1 ? '' : 's') + '</span>' + needsHint + '</div>'
    + '</div>';
  // N-9 (issue #762, Bug 2): standing-merit render paths (MCI, PT) don't read
  // m.bonus, so the Bonus row was visible-but-no-op. Standing call sites pass
  // opts.hideBonus=true to suppress the row entirely. Default behaviour
  // (general/influence/domain/style merits) is unchanged.
  // TM Admin Story tm-admin.10.1b AC4: the ▲/▼ stepper (shAdjMeritBonus,
  // retired — it wrote c.merits[X].bonus directly, unaudited) is replaced
  // with a read-only value display, matching STM-14's own precedent for the
  // equivalent attribute/skill Bonus rows (sheet.js's attr-derived-row at
  // line ~613/707: shown only when nonzero, no controls). Ad hoc merit
  // bonuses now go through the audited st_mods apply affordance on the
  // rendered (non-edit) sheet (shRenderMeritRow / the Domain and Standing
  // view rows — see sheet.js), not this edit-mode panel.
  if (!opts.hideBonus) {
    const bon = mc.bonus || 0;
    if (bon > 0) h += '<div class="attr-derived-row"><span class="bd-lbl">Bonus</span><span class="bd-src">+' + bon + '</span></div>';
  }
  return h;
}
