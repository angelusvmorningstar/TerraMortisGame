/**
 * Sheet rendering module — all read-only and edit-mode sheet HTML generation.
 * Extracted from tm_editor.html lines 315–1310.
 */
import state from '../data/state.js';
import { CLAN_DISCS, CORE_DISCS, RITUAL_DISCS, CLAN_ATTR_OPTIONS, ATTR_CATS, PRI_LABELS, PRI_BUDGETS, SKILL_PRI_BUDGETS, SKILLS_MENTAL, SKILLS_PHYSICAL, SKILLS_SOCIAL, SKILL_CATS, CLANS, COVENANTS, MASKS_DIRGES, COURT_TITLES, BANE_LIST, INFLUENCE_SPHERES, ALL_SKILLS, CITY_SVG, OTHER_SVG, BP_SVG, HUM_SVG, HEALTH_SVG, WP_SVG, STAT_SVG, STYLE_TAGS, DOMAIN_MERIT_TYPES, NON_COMBAT_STYLES } from '../data/constants.js';
import { ICONS } from '../data/icons.js';
import { CLAN_ICON_KEY, COV_ICON_KEY, clanIcon, covIcon, shDots, shDotsWithBonus, esc, formatSpecs, hasAoE, displayName, cardName, dropdownName, sortName, getWillpower, redactPlayer, redactCharName, isRedactMode, resolveSharedWithMember } from '../data/helpers.js';
import { getAttrVal, getAttrBonus, getSkillObj, calcCityStatus, titleStatusBonus, regentAmienceBonus, getRegentTerritoryFor, isInClanDisc, bloodlineUnresolved, riteCost } from '../data/accessors.js';
import { calcHealth, calcWillpowerMax, calcSize, calcSpeed, calcDefence } from '../data/derived.js';
// Issue #879 (ADR-006 D4): displayed defence reads the armour-adjusted +
// overlay-modded value from c.derived.defence (with on-the-fly fallback for
// unmaterialised contexts). The per-item armour annotation below intentionally
// still reads raw calcDefence(c) per ADR-006 Concern #2 (the "if you wore only
// this item, defence would be X" hypothetical baseline).
//
// wornArmourCount drives the >1 worn armour editor hint (ADR-006 D2 + Concern
// #8, wording locked).
import { defenceForDisplay, wornArmourCount, effectiveAvailability, isCombatGearWeaponShaped, isCombatGearArmourShaped, equipmentLocationLabel, equipmentContainerLabel } from '../data/equipment-derivation.js';
import { xpToDots, xpEarned, xpSpent, xpLeft, xpStarting, xpHumanityDrop, xpOrdeals, xpGame, xpPT5, xpSpentAttrs, xpSpentSkills, xpSpentMerits, xpSpentPowers, xpSpentSpecial, setDevotionsDB, meritBdRow, meritRating } from './xp.js';
// OATH-A (#1111): the pledge editor needs to know whether a merit is a
// Swear By oath and what its requirement resolves to. edit-domain.js owns
// both (it owns the write path); no cycle - edit-domain does not import
// sheet.js.
import { isSwearByOath, oathDotsRequired } from './edit-domain.js';
import { meritBase, meritDotCount, meritLookup, meritFixedRating, buildMeritOptions, buildSubCategoryMeritOptions, buildMCIGrantOptions, buildFThiefOptions, ensureMeritSync, meetsDevPrereqs, devPrereqStr, meetsPrereq, prereqLabel } from './merits.js';
// N-1 (Concern #11): every read of m.attached_to goes through this normaliser.
// N-4: getNecropolisInfectedTerritories drives the Trap Door Territory picker.
// N-5: validateTrapDoorAnchor reports the render-time non-functional state.
// COLLECTIVE-2 (#1110): getCollectiveCompounds + ownsCompound drive the
// allocator stepper and the virtual-row synthesis for EVERY compound.
// OATH-A (#1111, ADR-010 D1): buildPledgeIndex is the RENDER-TIME reverse
// index (merit -> the oaths holding it). Never persisted; rebuilt per render.
import { normaliseAttachedTo, getNecropolisInfectedTerritories, validateTrapDoorAnchor, getCollectiveCompounds, ownsCompound, freeOf, collectiveCompoundDots, synthesiseCollectiveCompoundNames, buildPledgeIndex, pledgeKeyFor, pledgeableDots, meritMatchesRef } from '../data/rules-helpers.js';
import { getRulesCache } from './rule_engine/load-rules.js';
// N-4 (MNEC, issue #696): White Ants Territory picker reads the live list.
import { getStoredTerritories } from '../data/accessors.js';
// BL-3a (#1008): clan-filtered bloodline options come from the collection.
import { bloodlinesByClan } from '../data/bloodlines-cache.js';
// BL-5 (#1008): the sheet header carries the SECOND clan/bloodline dropdown
// pair. It locks from the same shared module the Identity tab does, keyed off
// the character's own stored value and never off the cache.
import { isLineageLocked, lineageLockAttr, lineageLockNoteHtml } from '../data/write-once.js';

// BL-3a review: names are DB-sourced (BL-4 lets an ST write them), so they are
// escaped; and the character's OWN value is always present and matched
// case-insensitively, so an unloaded/empty cache or a spelling slip can never
// render a bloodline-bearing character as "(no bloodline)" and then commit it.
const _blKey = s => String(s).trim().toLowerCase();
function _blOptionNames(c) {
  const names = (bloodlinesByClan()[c.clan] || []).slice();
  if (c.bloodline && !names.some(b => _blKey(b) === _blKey(c.bloodline))) names.push(c.bloodline);
  return names.sort((a, b) => a.localeCompare(b));
}
import { getRulesByCategory, getRuleByKey } from '../data/loader.js';
import { applyDerivedMerits, getPoolTotal, getPoolUsed, getPoolsForCategory, mciPoolTotal, getMCIPoolUsed } from './mci.js';
import { domMeritTotal, domMeritAccess, domMeritContrib, domMeritShareable, calcTotalInfluence, influenceBreakdown, calcContactsInfluence, calcMeritInfluence, hasHoneyWithVinegar, hasViralMythology, vmUsed, ssjHerdBonus, flockHerdBonus, hasLorekeeper, lorekeeperUsed, hasOHM, ohmUsed, hasInvested, investedPool, investedUsed, effectiveInvictusStatus, attacheBonusDots, meritFreeSum, syncMeritRating, meritEffectiveRating, domKey } from './domain.js';
import { auditCharacter } from '../data/audit.js';
// oxp.7: the read-only Office Merits section's own data. apiGet is not
// otherwise used in this file (every other section reads off the character
// object synchronously) — office merit dots are the one thing on this sheet
// that live in a separate seat-keyed collection, fetched over the API.
import { apiGet } from '../data/api.js';
import { officeEntry, meritCap } from '../data/office-content-cache.js';
import { resolveHeldSeat } from '../data/office-seat-resolve.js';
// Issue #162 (2026-05-08): shEnsureTouchstoneData import dropped — the
// Touchstone editor no longer needs the NPC list (DB-relational picker
// removed; free-text Name + Description only).
import { powersForDisc } from '../suite/sheet-helpers.js';
import { markerFor, applyAffordance } from './st-mod-popover.js';
import { getCatalogueEntry } from '../data/equipment-catalogue-cache.js';
import { renderRulesExpander } from '../shared/rules-text.js';

// Build legacy-format shims from rules cache for remaining deep consumers.
// These produce arrays/objects in the old DEVOTIONS_DB/MERITS_DB/MAN_DB shape.
function _devDB() {
  return getRulesByCategory('devotion').map(r => ({
    n: r.name, key: r.key,
    p: r.prereq?.all?.map(n => ({ disc: n.name, dots: n.dots })) || (r.prereq?.type === 'discipline' ? [{ disc: r.prereq.name, dots: r.prereq.dots }] : []),
    xp: r.xp_fixed || 0, cost: r.cost || '', effect: r.description || '',
    stats: r.pool ? `Pool: ${[r.pool.attr, r.pool.skill, r.pool.disc].filter(Boolean).join(' + ')}` + (r.action ? `  •  ${r.action}` : '') + (r.duration ? `  •  ${r.duration}` : '') : '',
    bl: r.bloodline,
  }));
}
function _meritDB() {
  const db = {};
  for (const r of getRulesByCategory('merit')) {
    // Issue #994: carry rules_text/rules_source through so pact/oath drawers
    // (the only consumer of this map for power-style rules-text display)
    // can offer a "Full rules" expander.
    db[r.name.toLowerCase()] = { desc: r.description, prereq: r.prereq, prereqStr: r.prereq ? prereqLabel(r.prereq) : null, rating: r.rating_range ? `${r.rating_range[0]}–${r.rating_range[1]}` : null, type: r.parent, sub_category: r.sub_category, rules_text: r.rules_text || null, rules_source: r.rules_source || null };
  }
  return db;
}
function _manDB() {
  const db = {};
  for (const r of getRulesByCategory('manoeuvre')) {
    db[r.name.toLowerCase()] = { name: r.name, style: r.parent, rank: String(r.rank || ''), effect: r.description, prereq: r.prereq, prereqStr: r.prereq ? prereqLabel(r.prereq) : null };
  }
  return db;
}
// Module-level aliases rebuilt on each render (rules cache is fast, already in memory)
let DEVOTIONS_DB = [];
let MERITS_DB = {};
let MAN_DB = {};
function _refreshLegacyDBs() {
  DEVOTIONS_DB = _devDB();
  MERITS_DB = _meritDB();
  MAN_DB = _manDB();
  if (DEVOTIONS_DB.length) setDevotionsDB(DEVOTIONS_DB);
}
_refreshLegacyDBs();

/** Render audit badges — separate error and warning indicators with counts and hover breakdown. */
function _auditBadge(c) {
  const audit = auditCharacter(c);
  if (audit.valid && audit.warnings.length === 0) {
    return '<span class="audit-badge audit-ok" title="All checks passed">\u2714</span>';
  }
  let h = '';
  if (audit.errors.length) {
    const tip = audit.errors.map(e => '\u2716 ' + e.message).join('\n');
    h += `<span class="audit-badge audit-err" title="${esc(tip)}">\u2716${audit.errors.length > 1 ? ' ' + audit.errors.length : ''}</span>`;
  }
  if (audit.warnings.length) {
    const tip = audit.warnings.map(w => {
      let line = '\u26A0 ' + w.message;
      if (w.detail?.items?.length) line += '\n  \u2022 ' + w.detail.items.join('\n  \u2022 ');
      return line;
    }).join('\n');
    h += `<span class="audit-badge audit-warn" title="${esc(tip)}">\u26A0${audit.warnings.length > 1 ? ' ' + audit.warnings.length : ''}</span>`;
  }
  return h;
}

/** Render a prereq warning showing only the terms the character actually fails. */
function _prereqWarn(c, meritName, m) {
  if (m && m.granted_by) return '';
  const rule = getRuleByKey(meritName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  if (!rule || !rule.prereq) return '';
  if (meetsPrereq(c, rule.prereq, { domTotal: (name) => domMeritAccess(c, name) })) return '';
  const label = prereqLabel(rule.prereq);
  return '<div class="merit-prereq-warn">\u26A0 Prerequisites not met: <span class="merit-prereq-txt">' + esc(label) + '</span></div>';
}

/** Render grant pool counters for a merit category. Handles single and multi-target pools. */
function _renderPoolCounters(c, category) {
  const pools = getPoolsForCategory(c, category);
  // Include 'any' category pools (MCI pool) only in the general section — it applies everywhere
  // but repeating it in every category is redundant noise
  const anyPools = category === 'general' ? (c._grant_pools || []).filter(p => p.category === 'any') : [];
  // Also include 'vm' category pools (VM Allies bonus) in the influence section
  const vmPools = category === 'influence' ? (c._grant_pools || []).filter(p => p.category === 'vm') : [];
  // Also include 'ohm' category pools (OHM grants) in the influence section
  const ohmPools = category === 'influence' ? (c._grant_pools || []).filter(p => p.category === 'ohm') : [];
  // Also include 'inv' pools (Invested) in both domain and influence sections
  const invPools = (category === 'domain' || category === 'influence') ? (c._grant_pools || []).filter(p => p.category === 'inv') : [];
  // Lorekeeper pools target Herd/Retainer — show in the domain section (Herd lives there;
  // Retainer is influence but pool is unified). One row keeps the summary uncluttered.
  const lkPools = category === 'domain' ? (c._grant_pools || []).filter(p => p.category === 'lk') : [];
  // N-7 (issue #760): Necropolis pool targets sit in the general merit
  // section — surface the counter in 'general' so the read-side summary
  // matches the per-target allocator stepper below.
  // N-7a (issue #766): Necropolis targets are sub_category='domain' — surface
  // the pool counter in the domain section, matching where the per-target
  // steppers actually render. Pre-N-7a this filtered on 'general' (the
  // mistake that surfaced as part of the broader showNECRO-in-wrong-renderer
  // bug — the original N-7 wiring went into the general renderer too).
  // COLLECTIVE-2 (issue #1110): every Collective Compound's pool, not just
  // the Necropolis. Slugs come from the rules cache, so a fourth compound's
  // counter appears without touching this filter.
  const _poolCompoundSlugs = new Set(getCollectiveCompounds(getRulesCache()).map(cmp => cmp.slug));
  const compoundPools = category === 'domain' ? (c._grant_pools || []).filter(p => _poolCompoundSlugs.has(p.category)) : [];
  const allPools = [...pools, ...anyPools, ...vmPools, ...ohmPools, ...invPools, ...lkPools, ...compoundPools];
  if (!allPools.length) return '';
  let h = '<div class="grant-pools">';
  const seen = new Set();
  allPools.forEach(p => {
    const label = p.names ? p.names.join('/') : (p.category === 'any' ? 'any merit' : p.category === 'vm' ? 'Allies (VM bonus)' : p.category === 'ohm' ? 'OHM: auto Contacts+Resources, pick Allies sphere' : p.category === 'inv' ? 'Herd/Mentor/Resources/Retainer (Invested)' : p.category === 'necro' ? 'Necropolis targets (Catacombs/Caldarium/Garbage Pit/Labyrinth Guardians/Dark Temple/White Ants)' : p.name);
    const key = p.source + '|' + label;
    if (seen.has(key)) return;
    seen.add(key);
    let pTotal, pUsed;
    if (p.category === 'any') { pTotal = p.amount; pUsed = getMCIPoolUsed(c); }
    else if (p.category === 'vm') { pTotal = p.amount; pUsed = vmUsed(c); }
    else if (p.category === 'lk') { pTotal = p.amount; pUsed = lorekeeperUsed(c); }
    else if (p.category === 'ohm') { pTotal = p.amount; pUsed = ohmUsed(c); }
    else if (p.category === 'inv') { pTotal = p.amount; pUsed = investedUsed(c); }
    // N-7 (issue #760): compound pool — sum freeOf(m, <slug>) across all
    // merits. COLLECTIVE-2: the slug is the pool's own category.
    else if (_poolCompoundSlugs.has(p.category)) { pTotal = p.amount; pUsed = (c.merits || []).reduce((s, m) => s + freeOf(m, p.category), 0); }
    else { const lookupName = p.names ? p.names[0] : p.name; pTotal = getPoolTotal(c, lookupName); pUsed = getPoolUsed(c, lookupName); }
    const cls = pUsed > pTotal ? 'sc-over' : pUsed === pTotal ? 'sc-full' : 'sc-val';
    h += '<div class="grant-pool-row"><span class="grant-pool-tag">' + esc(p.source) + '</span>: ' + esc(label) + ' free dots <span class="' + cls + '">' + pUsed + '/' + pTotal + '</span></div>';
  });
  h += '</div>'; return h;
}

/** Render a small red or yellow alert badge for a section title (edit mode only). */
function _alertBadge(lvl) {
  if (!lvl) return '';
  return lvl === 'red' ? '<span class="sh-sec-alert red" title="Data error">!</span>' : '<span class="sh-sec-alert yellow" title="Unspent pool dots">&#9679;</span>';
}

/**
 * OATH-B (#1111) — how an oath suspension renders. Peter's ruling, 2026-08-07.
 *
 * SUSPENDED DOTS VANISH FROM THE SOLID BAND.
 *
 *     Resources  ●●●●    owned 4, nothing suspended
 *     Resources  ●       owned 4, suspended 3   + badge "Pledged 3 to ..."
 *
 * The dot row means WHAT YOU CAN USE RIGHT NOW, and nothing else. The
 * "still yours" half is the badge's job, and the badge already exists from
 * OATH-A — so no glyph carries two meanings and no new convention is
 * invented.
 *
 * WHY NOT RENDER THEM HOLLOW — the obvious future question. `○` currently
 * means "bonus" and nothing else. Reusing it for "suspended" would make it
 * mean "bonus OR suspended" with nothing distinguishing the two at a glance.
 * That is the same overloading objection that rejected the self-referential
 * `exclusive` shim in ADR-010 D5: one glyph, one meaning.
 *
 * ONLY THE SOLID BAND SHRINKS. Bonus dots are not pledgeable — pledges are
 * measured in `meritRating` terms, which counts owned dots — so they are not
 * suspendable either. If a call site ever pushes a suspension into the
 * hollow band, that is not a display question: it means something upstream
 * is treating bonus dots as pledgeable, which is a bug. The floor below
 * makes that impossible here, but the invariant is asserted in the suite so
 * it fails loudly rather than silently absorbing into the hollow count.
 *
 * Every merit-dot display funnels its suspended COUNT through this one
 * function rather than each learning a rendering rule, so the presentation
 * lives in a single place.
 *
 * WRAPPED VS PLAIN (issue #1128). The suspension seam above is right, but it
 * originally carried a PRESENTATION wrapper that only some of its callers
 * want: `shDotsMixed` wraps its glyphs in `<span class="trait-dots">`, which
 * is `.trait-right`'s full-size trait-row styling. Six call sites sit inside
 * small-type containers that style their own dots (`.infl-dots-derived`,
 * `.contacts-edit-hdr`, `.dom-contrib-lbl`); inheriting the wrapper made
 * their dots oversized and overflowed the fixed 60px influence column. So
 * there are two entry points, not one:
 *
 *     shDotsSuspended(...)        wrapped, for `.trait-right`-style rows
 *     shDotsSuspendedPlain(...)   bare glyphs, for containers that style
 *                                 their own dots
 *
 * DO NOT re-merge them, and do not inline the arithmetic into either. The
 * suspension maths lives once in `_shSuspendBands` and the glyph run lives
 * once in `_shDotGlyphs`, precisely so the wrapped and plain paths can never
 * disagree about what a suspension looks like. A second copy of
 * `Math.max(0, purchased - n)` anywhere is the regression, not the fix.
 */

/** The glyph run alone: solid purchased band, then hollow bonus band.
 *
 *  2026-09-01 general audit (display-rendering dimension, verified): merit
 *  dot-runs baked an active st_mod's bonus directly into the hollow-dot
 *  COUNT with no per-dot distinction \u2014 the same "invisible mod" shape #408
 *  fixed for attributes/skills/disciplines via shDotsWithBonus's
 *  filledMod/hollowMod opts, just reintroduced for merits. Merits render
 *  literal Unicode glyph characters as text (not the empty `.pointed` spans
 *  attributes/skills/disciplines use), so the existing `.stm-modded-dot`
 *  CSS class (background-color + outline \u2014 inert behind a text glyph) can't
 *  be reused as-is; `.merit-modded-dot` below recolours the glyph's text
 *  colour instead. Same opts shape as shDotsWithBonus (filledMod/hollowMod
 *  each `{from, to, path, title}`, zero-based indices into their own band)
 *  so callers can reuse the same offset-computation convention. */
function _shDotGlyphs(purchased, bonus, opts) {
  if (!purchased && !bonus) return '';
  if (!opts || (!opts.filledMod && !opts.hollowMod)) {
    return '\u25CF'.repeat(purchased) + '\u25CB'.repeat(bonus);
  }
  const fm = opts.filledMod, hm = opts.hollowMod;
  let out = '';
  for (let i = 0; i < purchased; i++) {
    if (fm && i >= fm.from && i < fm.to) {
      out += `<span class="merit-modded-dot" data-stm-marker-path="${esc(fm.path || '')}" title="${esc(fm.title || '')}">\u25CF</span>`;
    } else out += '\u25CF';
  }
  for (let i = 0; i < bonus; i++) {
    if (hm && i >= hm.from && i < hm.to) {
      out += `<span class="merit-modded-dot" data-stm-marker-path="${esc(hm.path || '')}" title="${esc(hm.title || '')}">\u25CB</span>`;
    } else out += '\u25CB';
  }
  return out;
}

/** The one place a suspension changes the bands. Solid shrinks; bonus never does. */
function _shSuspendBands(purchased, bonus, suspended) {
  const n = Math.max(0, suspended || 0);
  return n ? [Math.max(0, purchased - n), bonus] : [purchased, bonus];
}

/** Suspended merit dots, wrapped in `.trait-dots` (for `.trait-right` rows).
 *  Optional `opts` (filledMod/hollowMod) — see _shDotGlyphs. Note a
 *  suspension shrinks the SOLID band (see _shSuspendBands), which does not
 *  shift the hollow band's own indices, so a hollowMod sub-range computed
 *  against the un-suspended bonus count stays valid here. */
function shDotsSuspended(purchased, bonus, suspended, opts) {
  const [p, b] = _shSuspendBands(purchased, bonus, suspended);
  return shDotsMixed(p, b, opts);
}

/**
 * Suspended merit dots as bare glyphs, for containers that style their own
 * dots. Byte-identical to what those rows emitted before OATH-B (#1111).
 */
function shDotsSuspendedPlain(purchased, bonus, suspended) {
  const [p, b] = _shSuspendBands(purchased, bonus, suspended);
  return _shDotGlyphs(p, b);
}

/** The suspended-dot count for a merit row, or 0. */
function shSuspendedOf(m) {
  return (m && m._suspended_dots) || 0;
}

/** Render merit dots split into purchased (full gold) and bonus (empty circle).
 *  Optional `opts` (filledMod/hollowMod) — see _shDotGlyphs. */
function shDotsMixed(purchased, bonus, opts) {
  const g = _shDotGlyphs(purchased, bonus, opts);
  return g ? '<span class="trait-dots">' + g + '</span>' : '';
}

/** Three-tier domain merit dot rendering: inherent (\u25CF), bonus (\u25CB), shared/underlined (\u25CB). */
function shDotsThreeTier(inherent, bonus, shared) {
  let h = '';
  for (let i = 0; i < inherent; i++) h += '\u25CF';
  for (let i = 0; i < bonus; i++)    h += '\u25CB';
  for (let i = 0; i < shared; i++)   h += '<span class="dot-shared">\u25CB</span>';
  return '<span class="trait-dots">' + h + '</span>';
}

/** Derived dot source notes on a merit. Only emits lines where the field > 0. */
function _derivedNotes(m) {
  const _n = (v, lbl, why) => v ? '<div class="derived-note">' + lbl + ': +' + v + ' dot' + (v !== 1 ? 's' : '') + ' (auto) \u2014 ' + why + '</div>' : '';
  let h = _n(m.free_mci,       'MCI',        'removed if MCI drops')
       + _n(m.free_vm,        'VM',         'removed if VM removed')
       + _n(m.free_ohm,       'OHM',        'removed if oath is removed')
       + _n(m.free_lk,        'Lorekeeper', 'removed if Lorekeeper removed')
       + _n(m.free_inv,       'Invested',   'removed if Invested removed')
       + _n(m.free_bloodline, 'Bloodline',  'removed if bloodline changes')
       + _n(m.free_pet,        'Pet (K-9/Falconry)', 'removed if style removed')
       + _n(m.free_pt,        'PT Bonus',   'removed if PT is removed')
       + _n(m.free_mdb,       'MDB Bonus',  'equals Mentor rating')
       + _n(m.free_sw,        'Safe Word',  'removed if oath is removed')
       + _n(m.free_fwb,       'FwB Bonus',  'equals MCI + Status dots, removed if FwB removed')
       + _n(m.free_attache,   'Attaché',    'equals Invictus status, removed if Attaché variant removed');
  // Issue #39 Task 1: rating-vs-sum invariant guard. syncMeritRating(m) is the
  // canonical persisted-rating formula (cp + xp + sum of free_* channels).
  // If m.rating diverges, render a visible warning and log so the next editor
  // pass can correct the drift. Defensive guard at the bad-edit moment rather
  // than at audit time.
  if (m && m.rating != null) {
    const expected = syncMeritRating(m);
    if (m.rating !== expected) {
      const tt = 'Rating ' + m.rating + ' ≠ cp(' + (m.cp || 0) + ') + xp(' + (m.xp || 0) + ') + free-sum(' + meritFreeSum(m) + ') = ' + expected;
      h += '<div class="derived-note merit-rating-warn" title="' + esc(tt) + '">⚠ Rating mismatch — stored ' + m.rating + ', expected ' + expected + '</div>';
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[merit-rating-mismatch]', m.name, m.area || m.qualifier || '', { stored: m.rating, expected });
      }
    }
  }
  return h;
}
function _statusTrack(base, bonus, bonusColor, maxDots = 5) {
  const dot = i => {
    if (i <= base) return '<span class="sh-track-dot sh-track-base">\u25CF</span>';
    if (i <= base + bonus) return '<span class="sh-track-dot" style="color:' + bonusColor + '">\u25CB</span>';
    return '<span class="sh-track-dot sh-track-empty">\u25CB</span>';
  };
  if (maxDots > 5) {
    let row1 = '', row2 = '';
    for (let i = 1; i <= 5; i++) row1 += dot(i);
    for (let i = 6; i <= maxDots; i++) row2 += dot(i);
    return '<div class="sh-status-track sh-status-track-rows">'
      + '<div class="sh-track-row">' + row1 + '</div>'
      + '<div class="sh-track-row">' + row2 + '</div>'
      + '</div>';
  }
  let h = '<div class="sh-status-track">';
  for (let i = 1; i <= maxDots; i++) h += dot(i);
  return h + '</div>';
}
function _statusEditBtns(downFn, upFn) {
  return '<div class="sh-status-btns"><button class="sh-stat-lr" onclick="' + downFn + '">&#9664;</button><button class="sh-stat-lr" onclick="' + upFn + '">&#9654;</button></div>';
}
/* Render only the dots that exist — inherent full, bonus hollow, nothing beyond total.
   maxDots caps the scale (10 for city, 5 for cov/clan). */
function _statusDots(base, bonus, maxDots) {
  const total = Math.min(base + bonus, maxDots);
  if (!total) return '';
  const cappedBase = Math.min(base, maxDots);
  const dot = i => i <= cappedBase
    ? '<span class="sh-sdot sh-sdot-base">\u25CF</span>'
    : '<span class="sh-sdot sh-sdot-bonus">\u25CB</span>';
  if (total > 5) {
    let h = '<div class="sh-sdot-track sh-sdot-rows">';
    h += '<div class="sh-sdot-row">'; for (let i = 1; i <= 5; i++) h += dot(i); h += '</div>';
    h += '<div class="sh-sdot-row">'; for (let i = 6; i <= total; i++) h += dot(i); h += '</div>';
    return h + '</div>';
  }
  let h = '<div class="sh-sdot-track">';
  for (let i = 1; i <= total; i++) h += dot(i);
  return h + '</div>';
}
function _statusPip(svg, val, lbl) {
  return '<div class="sh-stat-pip"><div class="sh-status-shape">' + svg + '<span class="sh-status-n">' + val + '</span></div><div class="sh-status-lbl">' + lbl + '</div></div>';
}

/* ── Auto-detected notable features ── */
function derivedFeatures(c) {
  const out = [];
  // Attributes at 5 (dots + bonus) — visible to others
  const attrNames = ['Intelligence', 'Wits', 'Resolve', 'Strength', 'Dexterity', 'Stamina', 'Presence', 'Manipulation', 'Composure'];
  for (const a of attrNames) {
    const obj = (c.attributes || {})[a] || {};
    if ((obj.dots || 0) + (obj.bonus || 0) >= 5) out.push('Inhumanly high ' + a);
  }
  // Giant merit
  if ((c.merits || []).some(m => m.name === 'Giant')) out.push('Giant');
  // Striking Looks
  const sl = (c.merits || []).find(m => m.name === 'Striking Looks');
  if (sl && (sl.rating || 0) > 0) out.push('Striking Looks ' + '\u25CF'.repeat(sl.rating));
  return out;
}

export function toggleExp(id) {
  const row = document.getElementById('exp-row-' + id), body = document.getElementById('exp-body-' + id);
  if (!row || !body) return;
  if (state.openExpId && state.openExpId !== id) {
    const pr = document.getElementById('exp-row-' + state.openExpId), pb = document.getElementById('exp-body-' + state.openExpId);
    if (pr) pr.classList.remove('open'); if (pb) pb.classList.remove('visible');
  }
  const isOpen = body.classList.contains('visible');
  row.classList.toggle('open', !isOpen); body.classList.toggle('visible', !isOpen);
  state.openExpId = isOpen ? null : id;
}
export function toggleDisc(id) {
  const row = document.getElementById('disc-row-' + id), drawer = document.getElementById('disc-drawer-' + id);
  if (!row || !drawer) return;
  const isOpen = drawer.classList.contains('visible');
  row.classList.toggle('open', !isOpen); drawer.classList.toggle('visible', !isOpen);
}
/**
 * NPCR.4 touchstone section — character.touchstones[] is authoritative (cap 6),
 * free-text only (DBO-8, 2026-08-14): {humanity, name, desc}.
 * Slot rating descends from the clan anchor (Ventrue=7, else=6).
 */
export function renderTouchstones(c, editMode) {
  const ts = Array.isArray(c.touchstones) ? c.touchstones : [];
  const hum = c.humanity || 0;
  const anchor = c?.clan === 'Ventrue' ? 7 : 6;
  const sorted = [...ts].sort((a, b) => (b.humanity || 0) - (a.humanity || 0));

  if (!editMode) {
    if (sorted.length === 0) return '';
    const rows = sorted.map(t => {
      const att = hum >= t.humanity;
      const name = t.name || '(unnamed)';
      return '<div class="exp-ts-row"><span class="exp-ts-hum">Humanity ' + t.humanity
        + ' — <span class="exp-ts-state ' + (att ? 'attached' : 'detached') + '">' + (att ? 'Attached' : 'Detached') + '</span></span>'
        + '<span class="exp-ts-name">' + esc(name)
        + (t.desc ? ' <span class="exp-ts-desc">(' + esc(t.desc) + ')</span>' : '') + '</span></div>';
    }).join('');
    return expRow('touchstones', 'Touchstones', '', rows);
  }

  // Issue #162: NPC pre-load dropped — Touchstone editor no longer
  // exposes the DB-relational NPC picker. Free-text Name + Description
  // only.

  const picker = c._ts_picker;
  let h = '<div class="sh-touchstones-edit">';
  h += '<div class="sh-sec-title" style="font-size:11px;margin:8px 0 4px">Touchstones</div>';
  if (c._ts_err) {
    h += '<div class="sh-touchstones-error" role="alert">' + esc(c._ts_err) + '</div>';
  }

  sorted.forEach(t => {
    const actualIdx = ts.indexOf(t);
    const att = hum >= t.humanity;
    const name = t.name || '(unnamed)';
    const isEditing = picker && picker.mode === 'edit' && picker.index === actualIdx;
    h += '<div class="sh-ts-slot">';
    h += '<div class="sh-ts-slot-head"><span class="sh-ts-slot-hum">Humanity ' + t.humanity
      + '</span> · <span class="sh-ts-slot-att" style="color:'
      + (att ? 'rgba(140,200,140,.9)' : 'var(--txt3)') + '">'
      + (att ? 'Attached' : 'Detached') + '</span>'
      + '</div>';
    h += '<div class="sh-ts-slot-body">';
    if (isEditing) {
      h += renderTouchstoneEditForm(c, actualIdx);
    } else {
      h += '<div class="sh-ts-slot-filled-row">';
      h += '<span class="sh-ts-slot-name">' + esc(name) + '</span>';
      if (t.desc) h += '<span class="sh-ts-slot-state">' + esc(t.desc) + '</span>';
      h += '<div class="sh-ts-slot-actions">';
      h += '<button class="sh-ts-slot-btn" onclick="shTouchstoneStartEdit(' + actualIdx + ')" title="Edit">edit</button>';
      h += '<button class="sh-ts-slot-btn danger" onclick="shTouchstoneRemove(' + actualIdx + ')" title="Remove">remove</button>';
      h += '</div></div>';
    }
    h += '</div></div>';
  });

  if (picker && picker.mode === 'add') {
    h += renderTouchstoneAddForm(c, anchor, ts.length);
  } else {
    const atCap = ts.length >= 6;
    const nextHum = anchor - ts.length;
    const btnLabel = atCap
      ? 'Maximum of 6 touchstones reached'
      : '+ Add touchstone (Humanity ' + nextHum + ')';
    h += '<button class="sh-ts-slot-add"'
      + (atCap ? ' disabled style="opacity:.5;cursor:not-allowed"' : ' onclick="shTouchstoneStartAdd()"')
      + '>' + btnLabel + '</button>';
  }

  h += '</div>';
  return h;
}

function renderTouchstoneAddForm(c, anchor, existingCount) {
  const draft = c._ts_picker.draft;
  const humanity = anchor - existingCount;

  // Issue #162 (2026-05-08): NPC selector removed from the Touchstone editor
  // per the broader NPC-suppression policy (Piatra 2026-05-06). The
  // 'is_character' branch (Pick existing NPC / Create new NPC) was a
  // DB-relational picker that POSTed to /api/relationships to create an
  // edge - that endpoint flow no longer round-trips cleanly under the
  // suppression sweep, returning 4xx and blocking sheet save. Touchstone
  // is free-text only (Name + optional Description), categorically a
  // typed-string input - same shape dt-form.18 used for the Personal
  // Story person field. DBO-8 (2026-08-14) retired the dormant edge_id
  // link entirely; every touchstone is this shape.
  let h = '<div class="sh-ts-picker">';
  h += '<div class="sh-ts-picker-head">New touchstone · Humanity ' + humanity + '</div>';
  h += '<label class="sh-ts-picker-field"><span>Name *</span>'
    + '<input class="sh-edit-input" placeholder="e.g., Grandfather&#39;s pocket watch or person&#39;s name" value="'
    + esc(draft.name || '') + '" oninput="shTouchstonePickerDraft(&#39;name&#39;, this.value)"></label>';
  h += '<label class="sh-ts-picker-field"><span>Description (optional)</span>'
    + '<input class="sh-edit-input" placeholder="Why it matters" value="'
    + esc(draft.desc || '') + '" oninput="shTouchstonePickerDraft(&#39;desc&#39;, this.value)"></label>';

  h += '<div class="sh-ts-picker-actions">';
  h += '<button class="sh-ts-slot-btn primary" onclick="shTouchstoneSaveAdd()">Save</button>';
  h += '<button class="sh-ts-slot-btn" onclick="shTouchstonePickerClose()">Cancel</button>';
  h += '</div></div>';
  return h;
}

function renderTouchstoneEditForm(c, idx) {
  const draft = c._ts_picker.draft;
  let h = '<div class="sh-ts-picker">';
  h += '<label class="sh-ts-picker-field"><span>Name *</span>'
    + '<input class="sh-edit-input" value="' + esc(draft.name || '') + '"'
    + ' oninput="shTouchstonePickerDraft(&#39;name&#39;, this.value)"></label>';
  h += '<label class="sh-ts-picker-field"><span>Description</span>'
    + '<textarea class="sh-ts-picker-textarea" oninput="shTouchstonePickerDraft(&#39;desc&#39;, this.value)">'
    + esc(draft.desc || '') + '</textarea></label>';
  h += '<div class="sh-ts-picker-actions">';
  h += '<button class="sh-ts-slot-btn primary" onclick="shTouchstoneSaveEdit()">Save</button>';
  h += '<button class="sh-ts-slot-btn" onclick="shTouchstonePickerClose()">Cancel</button>';
  h += '</div></div>';
  return h;
}

export function expRow(id, lbl, val, bodyHtml) {
  return '<div class="exp-row" id="exp-row-' + id + '" onclick="toggleExp(\'' + id + '\')"><span class="exp-lbl labeled">' + lbl + '</span><span class="exp-val">' + (val || '') + '</span><span class="exp-arr">\u203A</span></div><div class="exp-body" id="exp-body-' + id + '">' + bodyHtml + '</div>';
}

export function shRenderStatsStrip(c) {
  const { editMode } = state;
  const s = (i, v, l) => '<div class="sh-stat-cell"><div class="sh-stat-icon">' + i + '<span class="sh-stat-n">' + v + '</span></div><div class="sh-stat-lbl">' + l + '</div></div>';
  const sEdit = (i, v, l, fnDown, fnUp) => '<div class="sh-stat-cell sh-stat-editable"><div class="sh-stat-icon">' + i + '<span class="sh-stat-n">' + v + '</span></div><div class="sh-stat-edit-row"><button class="sh-stat-adj" onclick="' + fnDown + '">&#x25BC;</button><div class="sh-stat-lbl">' + l + '</div><button class="sh-stat-adj" onclick="' + fnUp + '">&#x25B2;</button></div></div>';
  const bp = c.blood_potency || 0, hm = c.humanity || 0;
  // Epic STM (issue #385): per-stat markers for the ST mod overlay.
  // Each value renders with a trailing marker if c._st_mod_overlay[path]
  // exists. Markers are click-targets for the popover; data-stm-marker-path
  // identifies which overlay entry to show. Empty when overlay disabled.
  const bpCell = s(BP_SVG, `${bp || 1}${markerFor(c, 'blood_potency')}`, 'BP');
  const humCell = s(HUM_SVG, `${hm}${markerFor(c, 'humanity')}`, 'Humanity');
  // Safe Word: combined WP when mutually linked (both have the oath pointing to each other)
  const _swPact = (c.powers || []).find(p => p.category === 'pact' && (p.name || '').toLowerCase() === 'oath of the safe word');
  const _swPartner = _swPact && _swPact.partner ? (state.chars || []).find(ch => ch.name === _swPact.partner) : null;
  const _swActive = _swPartner && ((_swPartner.powers || []).some(p => p.category === 'pact' && (p.name || '').toLowerCase() === 'oath of the safe word' && p.partner === c.name));
  const _wpBase = calcWillpowerMax(c);
  const _wpVal = _swActive ? _wpBase + calcWillpowerMax(_swPartner) : _wpBase;
  const _wpLbl = _swActive ? 'WP (shared)' : 'Willpower';
  // Epic STM (issue #385): if c.current.* has been spliced by STM-2, show
  // current/max for willpower and vitae. Markers attach to both the current
  // value (current.willpower / current.vitae from tracker_state) and the
  // max value (derived.willpower_max etc.) so an ST can mod either side.
  const hasCurrent = c.current && typeof c.current.willpower === 'number';
  const wpDisplay = hasCurrent
    ? `${c.current.willpower}${markerFor(c, 'current.willpower')}/${_wpVal}${markerFor(c, 'derived.willpower_max')}`
    : `${_wpVal}${markerFor(c, 'derived.willpower_max')}`;
  const healthDisplay = `${calcHealth(c)}${markerFor(c, 'derived.health_max')}`;
  const sizeDisplay = `${calcSize(c)}${markerFor(c, 'derived.size')}`;
  const speedDisplay = `${calcSpeed(c)}${markerFor(c, 'derived.speed')}`;
  const defDisplay = `${defenceForDisplay(c)}${markerFor(c, 'derived.defence')}`;
  return '<div class="sh-stats-strip">' + bpCell + humCell + s(HEALTH_SVG, healthDisplay, 'Health') + s(WP_SVG, wpDisplay, _wpLbl) + s(STAT_SVG, sizeDisplay, 'Size') + s(STAT_SVG, speedDisplay, 'Speed') + s(STAT_SVG, defDisplay, 'Defence') + '</div>';
}

export function shRenderAttributes(c, editMode) {
  const ATTR_ROWS = [['Intelligence', 'Strength', 'Presence'], ['Wits', 'Dexterity', 'Manipulation'], ['Resolve', 'Stamina', 'Composure']];
  const catOrder = ['Mental', 'Physical', 'Social'], BONUS_SOURCE = { Strength: 'Vigour', Stamina: 'Resilience' };
  // Normalise clan_attribute from attribute free field if missing
  if (!c.clan_attribute && c.attributes) { const ca = Object.entries(c.attributes).find(([, ao]) => (ao.free || 0) === 2); if (ca) c.clan_attribute = ca[0]; }
  const _attrAlert = editMode ? (catOrder.some(cat => { const budget = PRI_BUDGETS[(c.attribute_priorities || {})[cat] || 'Tertiary'] || 3, usedCP = (ATTR_CATS[cat] || []).reduce((s, a) => s + ((c.attributes?.[a]?.cp) || 0), 0); return budget - usedCP < 0; }) ? 'red' : null) : null;
  let h = '<div class="sh-sec"><div class="sh-sec-title">Attributes' + _alertBadge(_attrAlert) + '</div>';
  if (editMode) {
    const caList = CLAN_ATTR_OPTIONS[c.clan] || [];
    const caPills = caList.map(a => '<button class="cap-btn' + (c.clan_attribute === a ? ' active' : '') + '" onclick="shSetClanAttr(\'' + a.replace(/'/g, "\\'") + '\')">' + esc(a) + '</button>').join('');
    h += '<div class="sh-clan-attr-row"><span>Favoured Attribute</span><div class="clan-attr-pill">' + caPills + '</div></div>';
    const pri = c.attribute_priorities || {};
    if (!pri.Mental && !pri.Physical && !pri.Social) { pri.Mental = 'Primary'; pri.Physical = 'Secondary'; pri.Social = 'Tertiary'; }
    h += '<div class="sh-attr-col-hdr">';
    catOrder.forEach(cat => {
      const curPri = pri[cat] || 'Tertiary', budget = PRI_BUDGETS[curPri] || 3, usedCP = (ATTR_CATS[cat] || []).reduce((s, a) => s + ((c.attributes?.[a]?.cp) || 0), 0), rem = budget - usedCP;
      h += '<div class="sh-attr-pri"><select onchange="shSetPriority(\'' + cat + '\',this.value)">' + PRI_LABELS.map(p => '<option' + (curPri === p ? ' selected' : '') + '>' + p + '</option>').join('') + '</select><span class="sh-cp-remaining' + (rem < 0 ? ' over' : rem === 0 ? ' full' : '') + '">' + rem + ' CP</span></div>';
    });
    h += '</div>';
  }
  h += '<div class="sh-attr-grid">';
  if (editMode) {
    const ATTR_COLS = [ATTR_CATS.Mental, ATTR_CATS.Physical, ATTR_CATS.Social];
    ATTR_COLS.forEach(col => {
      h += '<div>'; col.forEach(a => {
        const base = getAttrVal(c, a), bonus = getAttrBonus(c, a), isClan = c.clan_attribute === a;
        const autoBonus = (c.disciplines?.[BONUS_SOURCE[a]]?.dots || 0);
        const ao = c.attributes[a] || {}, aE = a.replace(/'/g, "\\'"), baseDots = 1 + (isClan ? 1 : 0), ab = baseDots + (ao.cp || 0), xd = xpToDots(ao.xp || 0, ab, 4), tot = ab + xd;
        h += '<div><div class="attr-cell attr-cell-edit"><div class="attr-name-sh">' + a + (isClan ? '<span class="attr-clan-star">\u2605</span>' : '') + '</div><div class="attr-dots-sh">' + shDotsWithBonus(base, autoBonus + bonus) + '</div></div>';
        h += '<div class="attr-bd-panel"><div class="attr-bd-row"><div class="bd-grp"><span class="bd-lbl">Base</span> <span class="attr-bd-ro">' + baseDots + '</span></div><div class="bd-grp"><span class="bd-lbl">CP</span> <input class="attr-bd-input" type="number" min="0" value="' + (ao.cp || 0) + '" onchange="shEditAttrPt(\'' + aE + '\',\'cp\',+this.value)"></div><div class="bd-grp"><span class="bd-lbl">XP</span> <input class="attr-bd-input" type="number" min="0" value="' + (ao.xp || 0) + '" onchange="shEditAttrPt(\'' + aE + '\',\'xp\',+this.value)"></div><div class="bd-eq"><span class="bd-val">' + (tot + autoBonus + bonus) + '</span></div></div>';
        { const src = BONUS_SOURCE[a] || '';
          if (autoBonus > 0) h += '<div class="attr-derived-row"><span class="bd-lbl">' + src + '</span><span class="bd-src">+' + autoBonus + '</span></div>';
          // STM-14 (#1034): the manual +○/−○ bonus controls are retired — a
          // direct unaudited write to c.attributes[X].bonus. Ad-hoc bonuses
          // now go through the audited st_mods apply affordance on the
          // rendered (non-edit) sheet below; this row is read-only and shown
          // ONLY when a non-zero legacy persisted value exists (pending the
          // 1034.2 migration) — suppressed at 0 to avoid functionless clutter.
          if (bonus > 0) h += '<div class="attr-derived-row"><span class="bd-lbl">Bonus</span><span class="bd-src">+' + bonus + '</span></div>'; }
        h += '</div></div>';
      }); h += '</div>';
    });
  } else {
    ATTR_ROWS.forEach(row => row.forEach(a => {
      const base = getAttrVal(c, a), bonus = getAttrBonus(c, a);
      const autoBonus = (c.disciplines?.[BONUS_SOURCE[a]]?.dots || 0);
      // Epic STM #408: modded sub-ranges tagged on the dots themselves via
      // shDotsWithBonus opts (replaces the standalone .stm-marker pip that
      // visually collided with the dot run). Hollow-stream layout convention:
      // autoBonus first, then manual bonus — so the modded bonus sub-range
      // is offset by autoBonus. Edit mode strips _st_mod_overlay (STM-2
      // stripOverlay) so opts is empty there → backwards-compatible.
      const ovDots = c._st_mod_overlay?.[`attributes.${a}.dots`];
      const ovBonus = c._st_mod_overlay?.[`attributes.${a}.bonus`];
      const opts = {};
      if (ovDots) {
        const sign = ovDots.delta >= 0 ? '+' : '';
        opts.filledMod = {
          from: ovDots.base, to: ovDots.final,
          path: `attributes.${a}.dots`,
          title: `ST adjustment: ${a} (dots) ${sign}${ovDots.delta}. Click for details.`,
        };
      }
      if (ovBonus) {
        const sign = ovBonus.delta >= 0 ? '+' : '';
        opts.hollowMod = {
          from: autoBonus + ovBonus.base, to: autoBonus + ovBonus.final,
          path: `attributes.${a}.bonus`,
          title: `ST adjustment: ${a} (bonus) ${sign}${ovBonus.delta}. Click for details.`,
        };
      }
      h += '<div class="attr-cell"><div class="attr-name-sh">' + a + applyAffordance(c, `attributes.${a}.bonus`, a) + '</div><div class="attr-dots-sh">' + shDotsWithBonus(base, autoBonus + bonus, opts) + '</div></div>';
    }));
  }
  h += '</div></div>';
  return h;
}

export function shRenderSkills(c, editMode) {
  const SKILL_COLS = [SKILLS_MENTAL, SKILLS_PHYSICAL, SKILLS_SOCIAL], skillCatOrder = ['Mental', 'Physical', 'Social'];
  const _skillAlert = editMode ? (skillCatOrder.some(cat => { const budget = SKILL_PRI_BUDGETS[(c.skill_priorities || {})[cat] || 'Tertiary'] || 4, usedCP = (SKILL_CATS[cat] || []).reduce((s, sk) => s + ((c.skills?.[sk]?.cp) || 0), 0); return budget - usedCP < 0; }) ? 'red' : null) : null;
  let h = '<div class="sh-sec"><div class="sh-sec-title">Skills' + _alertBadge(_skillAlert) + '</div>';
  if (editMode) {
    const sPri = c.skill_priorities || {};
    if (!sPri.Mental && !sPri.Physical && !sPri.Social) { sPri.Mental = 'Primary'; sPri.Physical = 'Secondary'; sPri.Social = 'Tertiary'; }
    h += '<div class="sh-attr-col-hdr">';
    skillCatOrder.forEach(cat => {
      const curPri = sPri[cat] || 'Tertiary', budget = SKILL_PRI_BUDGETS[curPri] || 4, usedCP = (SKILL_CATS[cat] || []).reduce((s, sk) => s + ((c.skills?.[sk]?.cp) || 0), 0), rem = budget - usedCP;
      h += '<div class="sh-attr-pri"><select onchange="shSetSkillPriority(\'' + cat + '\',this.value)">' + PRI_LABELS.map(p => '<option' + (curPri === p ? ' selected' : '') + '>' + p + '</option>').join('') + '</select><span class="sh-cp-remaining' + (rem < 0 ? ' over' : rem === 0 ? ' full' : '') + '">' + rem + ' CP</span></div>';
    });
    h += '</div>';
    const ptMSpec = (c.merits || []).find(m => m.name === 'Professional Training');
    const ptFreeSpec = (ptMSpec && ptMSpec.rating >= 3) ? 2 : 0;
    const ptAssetSet = new Set((ptMSpec && ptMSpec.rating >= 3 && ptMSpec.asset_skills) ? (ptMSpec.asset_skills || []).filter(Boolean) : []);
    // Bloodline free specs — excluded from paid count
    const blFreeSpecs = c._bloodline_free_specs || [];
    const blBySkill = {};
    blFreeSpecs.forEach(({ skill }) => { blBySkill[skill] = (blBySkill[skill] || 0) + 1; });
    const blTotal = blFreeSpecs.length;
    let _assetSp = 0, _nonAssetSp = 0;
    Object.entries(c.skills || {}).forEach(([sk, skillObj]) => {
      const allCnt = (skillObj && skillObj.specs) ? skillObj.specs.length : 0;
      const paid = Math.max(0, allCnt - (blBySkill[sk] || 0));
      if (ptAssetSet.has(sk)) _assetSp += paid; else _nonAssetSp += paid;
    });
    const ptFreeCov = Math.min(ptFreeSpec, _assetSp), paidSp = _nonAssetSp + Math.max(0, _assetSp - ptFreeCov);
    const specXP = Math.max(0, paidSp - 3), cpSp = Math.min(paidSp, 3), cpCls = cpSp === 3 ? 'sc-full' : 'sc-val';
    const bonusTotal = ptFreeSpec + blTotal, bonusUsed = ptFreeCov + blTotal;
    const bonusParts = [];
    if (ptFreeSpec) bonusParts.push('PT: ' + ptFreeCov + '/' + ptFreeSpec + ' (asset skills)');
    if (blTotal) bonusParts.push('Bloodline: ' + blTotal);
    h += '<div class="sh-spec-counter">Specialisations <span class="' + cpCls + '">' + cpSp + ' / 3 CP</span>'
      + (specXP ? ' + <span class="sc-xp">' + specXP + ' XP</span>' : '')
      + (bonusTotal ? ' + <span class="sc-bonus">Bonus: ' + bonusUsed + '/' + bonusTotal + '</span>' : '')
      + (bonusParts.length ? '<div class="sc-parts">' + bonusParts.join(' \u00B7 ') + '</div>' : '')
      + '</div>';
  }
  h += '<div class="skills-3col">';
  if (editMode) {
    for (let ri = 0; ri < 8; ri++) {
      SKILL_COLS.forEach(col => {
        const s = col[ri];
        const sk = getSkillObj(c, s), d = sk.dots, bn = sk.bonus, sp = (sk.specs || []).join(', '), na = sk.nine_again, ptNa = c._pt_nine_again_skills && c._pt_nine_again_skills.has(s), ohmNa = c._ohm_nine_again_skills && c._ohm_nine_again_skills.has(s), ptBn = c._pt_dot4_bonus_skills && c._pt_dot4_bonus_skills.has(s) && (d + bn) < 5 ? 1 : 0, mciBn = c._mci_dot3_skills && c._mci_dot3_skills.has(s) && (d + bn) < 5 ? 1 : 0, hasDots = d > 0 || bn > 0 || ptBn > 0 || mciBn > 0, dotStr = hasDots ? shDotsWithBonus(d, bn + ptBn + mciBn) : '\u2013';
        h += '<div class="sk-edit-cell"><div class="sh-skill-row sk-edit' + (hasDots ? ' has-dots' : '') + '"><div class="skill-name-wrap"><span class="sh-skill-name">' + s + '</span>' + (sp ? '<span class="sh-skill-spec">' + formatSpecs(c, sk.specs) + '</span>' : '') + '</div><div class="skill-dots-wrap"><span class="' + (hasDots ? 'sh-skill-dots' : 'sh-skill-zero') + '">' + dotStr + '</span>' + (na ? '<span class="sh-skill-na">9-Again</span>' : ptNa ? '<span class="sh-skill-na pt-na">9-Again (PT)</span>' : ohmNa ? '<span class="sh-skill-na pt-na">9-Again (OHM)</span>' : '') + '</div></div>';
        const so2 = (c.skills || {})[s] || {}, sE = s.replace(/'/g, "\\'"), sb = so2.cp || 0, sxd = xpToDots(so2.xp || 0, sb, 2), st2 = sb + sxd, skEff = st2 + bn + ptBn + mciBn;
        h += '<div class="sk-bd-panel"><div class="sk-bd-row"><div class="bd-grp"><span class="bd-lbl">CP</span> <input class="attr-bd-input" type="number" min="0" value="' + (so2.cp || 0) + '" onchange="shEditSkillPt(\'' + sE + '\',\'cp\',+this.value)"></div><div class="bd-grp"><span class="bd-lbl">XP</span> <input class="attr-bd-input" type="number" min="0" value="' + (so2.xp || 0) + '" onchange="shEditSkillPt(\'' + sE + '\',\'xp\',+this.value)"></div><div class="bd-eq"><span class="bd-val">' + skEff + '</span></div></div>'
          // STM-14 (#1034): +○/−○ bonus controls retired — a direct
          // unaudited write to c.skills[X].bonus. Ad-hoc bonuses now go
          // through the audited st_mods apply affordance on the rendered
          // (non-edit) sheet below; this row is read-only and shown ONLY when a
          // non-zero legacy persisted value exists (pending the 1034.2
          // migration) — suppressed at 0 to avoid functionless clutter.
          + (bn > 0 ? '<div class="attr-derived-row"><span class="bd-lbl">Bonus</span><span class="bd-src">+' + bn + '</span></div>' : '');
        const specs = sk.specs || [];
        h += '<div class="sk-spec-list">';
        specs.forEach((sp2, si) => { h += '<div class="sk-spec-row"><input class="sk-spec-input" value="' + esc(sp2) + '" onchange="shEditSpec(\'' + sE + '\',' + si + ',this.value)" placeholder="Specialisation">' + (hasAoE(c, sp2) ? '<span class="sk-spec-aoe">+2</span>' : '') + '<button class="sk-spec-rm" onclick="shRemoveSpec(\'' + sE + '\',' + si + ')" title="Remove">&times;</button></div>'; });
        h += '<button class="sk-spec-add" onclick="shAddSpec(\'' + sE + '\')">+ spec</button></div></div></div>';
      });
    }
  } else {
    for (let ri = 0; ri < 8; ri++) {
      SKILL_COLS.forEach(col => {
        const s = col[ri], sk = getSkillObj(c, s), d = sk.dots, bn = sk.bonus, sp = (sk.specs || []).join(', '), na = sk.nine_again, ptNa = c._pt_nine_again_skills && c._pt_nine_again_skills.has(s), ohmNa = c._ohm_nine_again_skills && c._ohm_nine_again_skills.has(s), ptBn = c._pt_dot4_bonus_skills && c._pt_dot4_bonus_skills.has(s) && (d + bn) < 5 ? 1 : 0, mciBn = c._mci_dot3_skills && c._mci_dot3_skills.has(s) && (d + bn) < 5 ? 1 : 0, hasDots = d > 0 || bn > 0 || ptBn > 0 || mciBn > 0;
        // Epic STM #408: modded sub-ranges tagged on the dots themselves.
        // Skill hollow-stream layout: bn first, then ptBn / mciBn \u2014 so modded
        // skills.X.bonus sub-range starts at hollow position ovBonus.base
        // (no offset; bn is at the head of the hollow stream).
        const ovDots = c._st_mod_overlay?.[`skills.${s}.dots`];
        const ovBonus = c._st_mod_overlay?.[`skills.${s}.bonus`];
        const opts = {};
        if (ovDots) {
          const sign = ovDots.delta >= 0 ? '+' : '';
          opts.filledMod = {
            from: ovDots.base, to: ovDots.final,
            path: `skills.${s}.dots`,
            title: `ST adjustment: ${s} (dots) ${sign}${ovDots.delta}. Click for details.`,
          };
        }
        if (ovBonus) {
          const sign = ovBonus.delta >= 0 ? '+' : '';
          opts.hollowMod = {
            from: ovBonus.base, to: ovBonus.final,
            path: `skills.${s}.bonus`,
            title: `ST adjustment: ${s} (bonus) ${sign}${ovBonus.delta}. Click for details.`,
          };
        }
        const dotStr = hasDots ? shDotsWithBonus(d, bn + ptBn + mciBn, opts) : '\u2013';
        h += '<div class="sh-skill-row' + (hasDots ? ' has-dots' : '') + '"><div class="skill-name-wrap"><span class="sh-skill-name">' + s + '</span>' + applyAffordance(c, `skills.${s}.bonus`, s) + (sp ? '<span class="sh-skill-spec">' + formatSpecs(c, sk.specs) + '</span>' : '') + '</div><div class="skill-dots-wrap"><span class="' + (hasDots ? 'sh-skill-dots' : 'sh-skill-zero') + '">' + dotStr + '</span>' + (na ? '<span class="sh-skill-na">9-Again</span>' : ptNa ? '<span class="sh-skill-na pt-na">9-Again (PT)</span>' : ohmNa ? '<span class="sh-skill-na pt-na">9-Again (OHM)</span>' : '') + '</div></div>';
      });
    }
  }
  h += '</div></div>';
  return h;
}

export function shRenderDisciplines(c, editMode) {
  let h = '';

  // Derive discipline powers via the shared powersForDisc helper —
  // single source of truth (was triple-duplicated locally + in suite/sheet-helpers.js +
  // editor/export-character.js). Returns {name, stats, effect, rank} objects
  // whether the source is the rules cache or stored c.powers fallback.
  function _discPowers(discName, dots) {
    return powersForDisc(c.powers || [], discName, dots);
  }

  // 2026-09-01 general audit (display-rendering dimension, verified): this
  // view-mode row rendered discipline dots via a bare shDots(r) with no
  // c._st_mod_overlay awareness at all \u2014 not even the pre-#408 markerFor()
  // pip disciplines got elsewhere, ZERO indication an ST mod was applied.
  // Attributes (line ~627) and Skills (line ~722) in this same file already
  // build filledMod opts from the overlay for the identical recolour-in-place
  // + click-to-audit treatment; disciplines only ever carry a `.dots` overlay
  // path (server/routes/st_mods.js's dynamic whitelist \u2014 no `.bonus` field
  // exists on the discipline schema), so only filledMod applies here.
  function _stmDiscOpts(d) {
    const ovDots = c._st_mod_overlay?.[`disciplines.${d}.dots`];
    const opts = {};
    if (ovDots) {
      const sign = ovDots.delta >= 0 ? '+' : '';
      opts.filledMod = {
        from: ovDots.base, to: ovDots.final,
        path: `disciplines.${d}.dots`,
        title: `ST adjustment: ${d} (dots) ${sign}${ovDots.delta}. Click for details.`,
      };
    }
    return opts;
  }

  function renderDiscRow(d, r, nameClass) {
    const dp = _discPowers(d, r || 0), hasPow = dp.length > 0, id = 'disc-' + c.name.replace(/[^a-z]/gi, '') + d.replace(/[^a-z]/gi, '');
    let dr = ''; dp.forEach(p => { dr += '<div class="disc-power"><div class="disc-power-name">' + esc(p.name) + '</div>' + (p.stats ? '<div class="disc-power-stats">' + esc(p.stats) + '</div>' : '') + '<div class="disc-power-effect">' + esc(p.effect || '') + '</div></div>'; });
    const nTag = '<span class="trait-name' + (nameClass ? ' ' + nameClass : '') + '">' + esc(d) + applyAffordance(c, `disciplines.${d}.dots`, d) + '</span>', dTag = r ? '<span class="trait-dots' + (nameClass ? ' ' + nameClass : '') + '">' + shDotsWithBonus(r, 0, _stmDiscOpts(d)) + '</span>' : '';
    const _trInner = '<div class="trait-row"><div class="trait-main">' + nTag + '<div class="trait-right">' + dTag + (hasPow ? '<span class="disc-tap-arr">\u203A</span>' : '') + '</div></div></div>';
    if (!hasPow) return '<div class="disc-tap-row">' + _trInner + '</div>';
    return '<div class="disc-tap-row" id="disc-row-' + id + '" onclick="toggleDisc(\'' + id + '\')">' + _trInner + '</div><div class="disc-drawer" id="disc-drawer-' + id + '">' + dr + '</div>';
  }
  function renderDiscEditRow(d, r, isIC, nameClass) {
    // CODE REVIEW FIX (2026-08-31): db2 omitted dObj.free, understating the CP+XP subtotal
    // box by any rules-granted free dots (matches the shEditDiscPt fix in editor/edit.js).
    const dObj = (c.disciplines || {})[d] || {}, dE = d.replace(/'/g, "\\'"), cm = isIC ? 3 : 4, db2 = (dObj.cp || 0) + (dObj.free || 0), xd = xpToDots(dObj.xp || 0, db2, cm), dt = db2 + xd;
    const id = 'disc-' + c.name.replace(/[^a-z]/gi, '') + d.replace(/[^a-z]/gi, '');
    // Derive powers from rules cache (same as view mode)
    const dp = _discPowers(d, dt);
    let dr = ''; dp.forEach(p => { dr += '<div class="disc-power"><div class="disc-power-name">' + esc(p.name) + '</div>' + (p.stats ? '<div class="disc-power-stats">' + esc(p.stats) + '</div>' : '') + '<div class="disc-power-effect">' + esc(p.effect || '') + '</div></div>'; });
    const _eR = '<div class="trait-right">' + (r > 0 ? '<span class="trait-dots' + (nameClass ? ' ' + nameClass : '') + '">' + shDots(r) + '</span>' : '') + (dp.length ? '<span class="disc-tap-arr">\u203A</span>' : '') + '</div>';
    let h2 = '<div class="disc-tap-row disc-edit"' + (dp.length ? ' id="disc-row-' + id + '" onclick="toggleDisc(\'' + id + '\')"' : '') + '><div class="trait-row"><div class="trait-main"><span class="trait-name' + (nameClass ? ' ' + nameClass : '') + '">' + esc(d) + '</span>' + _eR + '</div>' + (isIC ? '<div class="trait-sub"><span class="disc-clan-tag">in-clan</span></div>' : '') + '</div></div>';
    const _discLockAttr = bloodlineUnresolved(c) ? ' disabled title="Locked: this character&apos;s bloodline could not be resolved"' : '';
    h2 += '<div class="disc-bd-panel"><div class="disc-bd-row"><div class="bd-grp"><span class="bd-lbl">CP</span> <input class="attr-bd-input" type="number" min="0"' + _discLockAttr + ' value="' + (dObj.cp || 0) + '" onchange="shEditDiscPt(\'' + dE + '\',\'cp\',+this.value)"></div><div class="bd-grp"><span class="bd-lbl">XP</span> <input class="attr-bd-input" type="number" min="0"' + _discLockAttr + ' value="' + (dObj.xp || 0) + '" onchange="shEditDiscPt(\'' + dE + '\',\'xp\',+this.value)"></div><div class="bd-eq"><span class="bd-val">' + dt + '</span></div></div></div>';
    if (dp.length) h2 += '<div class="disc-drawer" id="disc-drawer-' + id + '">' + dr + '</div>';
    return h2;
  }
  if (editMode) {
    const dd = c.disciplines || {};
    const _validDiscs = new Set([...CORE_DISCS, ...RITUAL_DISCS]);
    const iCP = Object.entries(dd)
      .filter(([d]) => _validDiscs.has(d) && isInClanDisc(c, d))
      .reduce((s, [, v]) => s + (v.cp || 0), 0);
    const oCP = Object.entries(dd)
      .filter(([d]) => _validDiscs.has(d) && !isInClanDisc(c, d))
      .reduce((s, [, v]) => s + (v.cp || 0), 0);
    const rem = 3 - iCP - oCP;
    // BL-2 (#1008): when the bloodline does not resolve, in-clan is unknown,
    // so every cost on this panel is untrustworthy. shEditDiscPt refuses the
    // write regardless; this is the half that tells the ST why, rather than
    // leaving them to wonder why their input bounced back.
    const _blLocked = bloodlineUnresolved(c);
    const _blLockNote = _blLocked
      ? '<div class="bl-disc-locked">Discipline editing is locked: the bloodline "' + esc(c.bloodline)
        + '" could not be resolved, so in-clan cost cannot be determined. Every discipline below is'
        + ' being shown as out-of-clan.</div>'
      : '';
    h += '<div class="sh-sec"><div class="sh-sec-title">Disciplines' + _alertBadge(iCP < 2 || oCP > 1 || rem !== 0 || _blLocked ? 'red' : null) + '</div>' + _blLockNote + '<div class="disc-cp-counter"><span class="sh-cp-remaining' + (rem < 0 ? ' over' : rem === 0 ? ' full' : '') + '">' + rem + ' CP</span><span class="' + (iCP < 2 ? 'sh-cp-remaining over' : '') + '">In-clan: ' + iCP + ' (min 2)</span><span class="' + (oCP > 1 ? 'sh-cp-remaining over' : '') + '">Out-of-clan: ' + oCP + ' (max 1)</span></div><div class="disc-list">';
    CORE_DISCS.forEach(d => { h += renderDiscEditRow(d, (c.disciplines || {})[d]?.dots || 0, isInClanDisc(c, d), null); });
    h += '</div></div>';
    const cn = (c.covenant || '').toLowerCase(), showCr = cn.includes('crone') || (c.disciplines || {}).Cruac?.dots > 0, showTh = cn.includes('lancea') || (c.disciplines || {}).Theban?.dots > 0;
    if (showCr || showTh) {
      h += '<div class="sh-sec"><div class="sh-sec-title">Blood Sorcery</div><div class="disc-list">';
      // Cruac and Theban are always out-of-clan (4 XP/dot) regardless of covenant.
      if (showCr) h += renderDiscEditRow('Cruac', (c.disciplines || {}).Cruac?.dots || 0, false, 'sorcery');
      if (showTh) h += renderDiscEditRow('Theban', (c.disciplines || {}).Theban?.dots || 0, false, 'sorcery');
      h += '</div></div>';
    }
  } else if (c.disciplines && Object.keys(c.disciplines).length) {
    const de = Object.entries(c.disciplines).filter(([, r]) => (r?.dots || 0) > 0).sort(([a], [b]) => a.localeCompare(b)),
          core = de.filter(([d]) => CORE_DISCS.includes(d)),
          rit = de.filter(([d]) => RITUAL_DISCS.includes(d));
    if (core.length) { h += '<div class="sh-sec"><div class="sh-sec-title">Disciplines</div><div class="disc-list">'; core.forEach(([d, r]) => { h += renderDiscRow(d, r?.dots || 0, null); }); h += '</div></div>'; }
    if (rit.length) {
      h += '<div class="sh-sec"><div class="sh-sec-title">Blood Sorcery</div><div class="disc-list">';
      rit.forEach(([d, r]) => { h += renderDiscRow(d, r?.dots || 0, 'sorcery'); });
      h += '</div></div>';
    }
  }
  // Devotions
  const devP = (c.powers || []).filter(p => p.category === 'devotion');
  if (editMode || devP.length) {
    h += '<div class="sh-sec"><div class="sh-sec-title">Devotions</div><div class="disc-list">';
    devP.forEach((p, i) => {
      const gid = 'dev' + c.name.replace(/[^a-z]/gi, '') + i, db = DEVOTIONS_DB.find(d => d.n === p.name);
      if (editMode) { h += '<div class="disc-tap-row disc-edit" id="disc-row-' + gid + '" onclick="toggleDisc(\'' + gid + '\')">' + '<div class="trait-row"><div class="trait-main"><span class="trait-name secondary">' + esc(p.name) + '</span><div class="trait-right">' + (db ? '<span class="dev-xp-tag">' + db.xp + ' XP</span>' : '') + '<span class="disc-tap-arr">\u203A</span><button class="dev-rm-btn" onclick="event.stopPropagation();shRemoveDevotion(' + i + ')" title="Remove">&times;</button></div></div></div></div>' + '<div class="disc-drawer" id="disc-drawer-' + gid + '"><div class="disc-power">' + (db ? '<div class="dev-prereq">Requires: ' + devPrereqStr(db) + '</div>' : '') + (p.stats ? '<div class="disc-power-stats">' + esc(p.stats) + '</div>' : '') + '<div class="disc-power-effect">' + esc(p.effect || '') + '</div></div></div>'; }
      else { h += '<div class="disc-tap-row" id="disc-row-' + gid + '" onclick="toggleDisc(\'' + gid + '\')">' + '<div class="trait-row"><div class="trait-main"><span class="trait-name secondary">' + esc(p.name) + '</span><div class="trait-right">' + (db && db.xp ? '<span class="trait-dots">' + '\u25CF'.repeat(db.xp) + '</span>' : '') + '<span class="disc-tap-arr">\u203A</span></div></div></div></div>' + '<div class="disc-drawer" id="disc-drawer-' + gid + '"><div class="disc-power">' + (p.stats ? '<div class="disc-power-stats">' + esc(p.stats) + '</div>' : '') + '<div class="disc-power-effect">' + esc(p.effect || '') + '</div></div></div>'; }
    });
    if (editMode) {
      const owned = new Set(devP.map(p => p.name)), avail = DEVOTIONS_DB.filter(d => !owned.has(d.n) && meetsDevPrereqs(c, d));
      h += '<div class="dev-add-row"><select id="dev-add-select" class="dev-add-sel" style="display:none">'; if (avail.length) avail.forEach(d => { h += '<option value="' + esc(d.key) + '">' + esc(d.n) + ' (' + devPrereqStr(d) + ') \u2014 ' + d.xp + ' XP</option>'; });
      h += '</select><button class="dev-add-btn"' + (avail.length ? ' onclick="shShowDevSelect(this)"' : ' disabled style="opacity:.4;cursor:default"') + '>' + (avail.length ? '+ Add Devotion (' + avail.length + ')' : 'No devotions available') + '</button></div>';
    }
    h += '</div></div>';
  }
  // Rites
  const ritP = (c.powers || []).filter(p => p.category === 'rite');
  const cruacDots = (c.disciplines || {}).Cruac?.dots || 0, thebanDots = (c.disciplines || {}).Theban?.dots || 0;
  const hasSorcery = cruacDots > 0 || thebanDots > 0;
  if (editMode ? hasSorcery : ritP.length) {
    const cruacPool = cruacDots * 2, thebanPool = thebanDots * 2;
    const cruacFreeUsed = ritP.filter(p => p.tradition === 'Cruac' && p.free).length;
    const thebanFreeUsed = ritP.filter(p => p.tradition === 'Theban' && p.free).length;
    const _riteOver = cruacFreeUsed > cruacPool || thebanFreeUsed > thebanPool;
    const _riteBadge = editMode ? _alertBadge(_riteOver ? 'red' : cruacFreeUsed < cruacPool || thebanFreeUsed < thebanPool ? 'yellow' : null) : '';
    h += '<div class="sh-sec"><div class="sh-sec-title">Rites' + _riteBadge + '</div>';
    if (editMode) {
      h += '<div class="grant-pools">';
      if (cruacDots > 0) { const cls = cruacFreeUsed > cruacPool ? ' sc-over' : cruacFreeUsed === cruacPool ? ' sc-full' : ' sc-val'; h += '<div class="grant-pool-row"><span class="grant-pool-tag">Cruac</span> free rites <span class="' + cls + '">' + cruacFreeUsed + '/' + cruacPool + '</span><span class="grant-pool-rank">rank \u2264 ' + cruacDots + '</span></div>'; }
      if (thebanDots > 0) { const cls = thebanFreeUsed > thebanPool ? ' sc-over' : thebanFreeUsed === thebanPool ? ' sc-full' : ' sc-val'; h += '<div class="grant-pool-row"><span class="grant-pool-tag">Theban</span> free rites <span class="' + cls + '">' + thebanFreeUsed + '/' + thebanPool + '</span><span class="grant-pool-rank">rank \u2264 ' + thebanDots + '</span></div>'; }
      h += '</div>';
    }
    h += '<div class="disc-list">';
    const allPw = c.powers || [];
    ritP.forEach(p => {
      const pi = allPw.indexOf(p);
      const gid = 'rite' + c.name.replace(/[^a-z]/gi, '') + pi;
      const xpCost = p.free ? 0 : (p.level >= 4 ? 2 : 1);
      const ruleEntry = getRulesByCategory('rite')?.find(r => r.name === p.name);
      const baseCost = riteCost(p).label || null;
      const riteOffering = ruleEntry?.offering ?? null;
      const costLine = baseCost ? (riteOffering ? baseCost + ' & ' + riteOffering : baseCost) : null;
      if (editMode) {
        const discDots = p.tradition === 'Cruac' ? cruacDots : thebanDots;
        const usedFree = p.tradition === 'Cruac' ? cruacFreeUsed : thebanFreeUsed;
        const freePool = p.tradition === 'Cruac' ? cruacPool : thebanPool;
        const canFree = !p.free && p.level <= discDots && usedFree < freePool;
        const freeLbl = p.free ? 'Free' : (xpCost + ' XP');
        const freeCls = p.free ? 'rite-free-badge' : 'rite-xp-badge';
        h += '<div class="disc-tap-row disc-edit" id="disc-row-' + gid + '" onclick="toggleDisc(\'' + gid + '\')">' + '<div class="trait-row"><div class="trait-main"><span class="trait-name secondary">' + esc(p.name) + '</span><div class="trait-right"><span class="trait-dots">' + shDots(p.level) + '</span><button class="' + freeCls + '" onclick="event.stopPropagation();shToggleRiteFree(' + pi + ')"' + (p.free || canFree ? '' : ' disabled title="rank exceeds ' + p.tradition + ' dots or pool full"') + '>' + freeLbl + '</button><span class="disc-tap-arr">\u203A</span><button class="dev-rm-btn" onclick="event.stopPropagation();shRemoveRite(' + pi + ')" title="Remove">&times;</button></div></div><div class="trait-sub"><span class="trait-qual dim">' + esc(p.tradition) + '</span>' + (p.mandragora_parked ? '<span class="rite-mg-tag" title="Permanently sustained by Mandragora Garden">MG</span>' : '') + '</div></div></div>' + '<div class="disc-drawer" id="disc-drawer-' + gid + '"><div class="disc-power">' + (costLine ? '<div class="disc-power-stats">Cost: ' + esc(costLine) + '</div>' : '') + (p.stats ? '<div class="disc-power-stats">' + esc(p.stats) + '</div>' : '') + '<div class="disc-power-effect">' + esc(ruleEntry?.description || p.effect || '') + '</div></div></div>';
      } else {
        h += '<div class="disc-tap-row" id="disc-row-' + gid + '" onclick="toggleDisc(\'' + gid + '\')">' + '<div class="trait-row"><div class="trait-main"><span class="trait-name secondary">' + esc(p.name) + '</span><div class="trait-right"><span class="trait-dots">' + shDots(p.level) + '</span><span class="disc-tap-arr">\u203A</span></div></div><div class="trait-sub"><span class="trait-qual dim">' + esc(p.tradition) + '</span>' + (p.free === false ? '<span class="trait-chip">' + xpCost + ' XP</span>' : '') + (p.mandragora_parked ? '<span class="rite-mg-tag" title="Permanently sustained by Mandragora Garden">MG</span>' : '') + '</div></div></div>' + '<div class="disc-drawer" id="disc-drawer-' + gid + '"><div class="disc-power">' + (costLine ? '<div class="disc-power-stats">Cost: ' + esc(costLine) + '</div>' : '') + (p.stats ? '<div class="disc-power-stats">' + esc(p.stats) + '</div>' : '') + '<div class="disc-power-effect">' + esc(ruleEntry?.description || p.effect || '') + '</div></div></div>';
      }
    });
    if (editMode) {
      const trads = [];
      if (cruacDots > 0) trads.push('Cruac');
      if (thebanDots > 0) trads.push('Theban');
      if (trads.length) {
        const defaultTrad = trads[0];
        const defaultDots = defaultTrad === 'Cruac' ? cruacDots : thebanDots;
        const allRites = getRulesByCategory('rite');
        const availRites = allRites
          .filter(r => r.parent === defaultTrad && r.rank != null && r.rank <= defaultDots)
          .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
        const tradSel = trads.length > 1
          ? '<select id="rite-add-trad" class="gen-qual-input" style="width:90px" onchange="shRefreshRiteDropdown(this.value)">' + trads.map(t => '<option>' + t + '</option>').join('') + '</select>'
          : '<span class="rite-trad-single">' + trads[0] + '</span><input type="hidden" id="rite-add-trad" value="' + trads[0] + '">';
        let nameSel, addOnclick;
        if (availRites.length) {
          nameSel = '<select id="rite-add-name" class="gen-qual-input" style="flex:1;min-width:140px">'
            + '<option value="" data-rank="" disabled selected>\u2014 select rite \u2014</option>'
            + availRites.map(r => '<option value="' + esc(r.name) + '" data-rank="' + r.rank + '">' + '\u25CF'.repeat(r.rank) + ' ' + esc(r.name) + '</option>').join('')
            + '</select>';
          addOnclick = '(function(){var s=document.getElementById(\'rite-add-name\');var n=s.value;var lv=+(s.options[s.selectedIndex]?.dataset?.rank||1);if(n)shAddRite(document.getElementById(\'rite-add-trad\').value,n,lv);})()';
        } else {
          // Rites DB not loaded or empty — fall back to free-text + level selector
          nameSel = '<input type="text" id="rite-add-name" class="gen-qual-input" style="flex:1;min-width:140px" placeholder="Rite name">'
            + '<select id="rite-add-level" class="gen-qual-input" style="width:50px">'
            + [1,2,3,4,5].map(n => '<option value="' + n + '">' + n + '</option>').join('')
            + '</select>';
          addOnclick = '(function(){var n=document.getElementById(\'rite-add-name\').value.trim();var lv=+document.getElementById(\'rite-add-level\').value;if(n)shAddRite(document.getElementById(\'rite-add-trad\').value,n,lv);})()';
        }
        h += '<div class="dev-add-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' + nameSel + tradSel + '<button class="dev-add-btn" onclick="' + addOnclick + '">+ Add</button></div>';
      }
    }
    h += '</div></div>';
  }
  // Pacts
  const pctP = (c.powers || []).filter(p => p.category === 'pact');
  if (pctP.length || editMode) {
    const _oathDB = Object.fromEntries(Object.entries(MERITS_DB || {}).filter(([, v]) => v.type === 'Invictus Oath' || v.type === 'Carthian Law'));
    const _toTitle = s => s.replace(/\b\w/g, ch => ch.toUpperCase());
    const _allSkillOpts = ALL_SKILLS.map(s => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
    const _charNames = [...(state.chars || [])].filter(ch => ch.name && ch.name !== c.name).sort((a, b) => sortName(a).localeCompare(sortName(b))).map(ch => '<option value="' + esc(ch.name) + '">' + esc(dropdownName(ch)) + '</option>').join('');
    h += '<div class="sh-sec"><div class="sh-sec-title">Pacts</div><div class="disc-list">';
    pctP.forEach((p, i) => {
      const realPi = (c.powers || []).indexOf(p);
      const gid = 'pact' + c.name.replace(/[^a-z]/gi, '') + i;
      const isOHM = (p.name || '').toLowerCase() === 'oath of the hard motherfucker';
      const isSW = (p.name || '').toLowerCase() === 'oath of the safe word';
      const dbEntry = _oathDB[(p.name || '').toLowerCase()];
      const effect = p.effect || (dbEntry && dbEntry.desc) || '';
      const reqDots = dbEntry && dbEntry.rating ? parseInt(dbEntry.rating) || 0 : 0;
      if (editMode) {
        const pcp = p.cp || 0, pxp = p.xp || 0, ptotal = pcp + pxp;
        const ptCls = ptotal >= reqDots && (reqDots === 0 || ptotal === reqDots) ? ' met' : ptotal > 0 ? ' over' : '';
        h += '<div class="pact-edit-block">'
          + '<div class="pact-edit-hdr">'
          + '<span class="trait-name secondary">' + esc(_toTitle(p.name)) + '</span>'
          + '<div class="trait-right">'
          + (reqDots ? '<span class="trait-dots">' + '\u25CF'.repeat(reqDots) + '</span>' : '')
          + '</div>'
          + '</div>'
          + '<div class="pact-cp-xp">'
          + '<span class="bd-lbl">CP</span><input class="merit-bd-input" type="number" min="0" value="' + pcp + '" onchange="shEditPact(' + realPi + ',\'cp\',+this.value)" style="width:36px">'
          + '<span class="bd-lbl">XP</span><input class="merit-bd-input" type="number" min="0" value="' + pxp + '" onchange="shEditPact(' + realPi + ',\'xp\',+this.value)" style="width:36px">'
          + '<span class="pact-total' + ptCls + '">= ' + ptotal + ' dot' + (ptotal === 1 ? '' : 's') + '</span>'
          + '<button class="dev-rm-btn" onclick="shRemovePact(' + realPi + ')" title="Remove oath">&times;</button>'
          + '</div>';
        // OHM-specific controls
        if (isOHM) {
          const sk0 = (p.ohm_skills && p.ohm_skills[0]) || '';
          const sk1 = (p.ohm_skills && p.ohm_skills[1]) || '';
          const ohmSphere = p.ohm_allies_sphere || '';
          // 2026-08-26 Sway merge: 'Allies' becoming 'Sway' — check both, tolerant of either side of the migration.
          const _alliesMerits = (c.merits || []).filter(m => m.category === 'influence' && (m.name === 'Allies' || m.name === 'Sway') && m.area);
          const _alliesOpts = _alliesMerits.map(m => '<option value="' + esc(m.area) + '"' + ((m.area || '').toLowerCase() === ohmSphere.toLowerCase() ? ' selected' : '') + '>' + esc(m.area) + '</option>').join('');
          h += '<div class="pact-controls">'
            + '<div class="pact-ctrl-row"><span class="pact-ctrl-lbl">Auto grants:</span><span class="grant-pool-tag">+1 Contacts, +1 Resources</span></div>'
            + '<div class="pact-ctrl-row"><span class="pact-ctrl-lbl">+1 Allies:</span>'
            + (_alliesMerits.length
              ? '<select class="gen-qual-input" style="width:180px" onchange="shEditPact(' + realPi + ',\'ohm_allies_sphere\',this.value)"><option value="">-- pick Allies merit --</option>' + _alliesOpts + '</select>'
              : '<span class="pact-hint">Add an Allies merit first</span>')
            + '</div>'
            + '<div class="pact-ctrl-row"><span class="pact-ctrl-lbl">9-Again skills:</span>'
            + '<select class="gen-qual-input" style="width:120px" onchange="shEditPact(' + realPi + ',\'ohm_skill_0\',this.value)"><option value="">-- skill 1 --</option>' + _allSkillOpts.replace('value="' + esc(sk0) + '"', 'value="' + esc(sk0) + '" selected') + '</select>'
            + '<select class="gen-qual-input" style="width:120px" onchange="shEditPact(' + realPi + ',\'ohm_skill_1\',this.value)"><option value="">-- skill 2 --</option>' + _allSkillOpts.replace('value="' + esc(sk1) + '"', 'value="' + esc(sk1) + '" selected') + '</select>'
            + '</div>'
            + '</div>';
        }
        // Safe Word-specific controls
        if (isSW) {
          const partner = p.partner || '';
          const sharedMerit = p.shared_merit || '';
          const partnerChar = partner ? (state.chars || []).find(ch => ch.name === partner) : null;
          const partnerHasSW = partnerChar && (partnerChar.powers || []).some(pp => pp.category === 'pact' && (pp.name || '').toLowerCase() === 'oath of the safe word' && pp.partner === c.name);
          h += '<div class="pact-controls">'
            + '<div class="pact-ctrl-row"><span class="pact-ctrl-lbl">Partner:</span>'
            + '<select class="gen-qual-input" style="width:160px" onchange="shEditPact(' + realPi + ',\'partner\',this.value)"><option value="">-- select character --</option>' + _charNames.replace('value="' + esc(partner) + '"', 'value="' + esc(partner) + '" selected') + '</select>'
            + (partner && !partnerHasSW ? '<span class="pact-hint">partner must also take this oath</span>' : '')
            + (partnerHasSW ? '<span class="pact-linked">\u2713 mutually linked</span>' : '')
            + '</div>'
            + (() => { const _sm = (c.merits || []).filter(m => m.category === 'influence'); const _smOpts = _sm.map(m => { const _lbl = m.name + (m.qualifier ? ' (' + m.qualifier + ')' : m.area ? ' (' + m.area + ')' : ''); return '<option value="' + esc(_lbl) + '"' + (sharedMerit === _lbl ? ' selected' : '') + '>' + esc(_lbl) + '</option>'; }).join(''); return '<div class="pact-ctrl-row"><span class="pact-ctrl-lbl">Shared Social Merit:</span>' + (_sm.length ? '<select class="gen-qual-input" style="width:180px" onchange="shEditPact(' + realPi + ',\'shared_merit\',this.value)"><option value="">\u2014 pick Social Merit \u2014</option>' + _smOpts + '</select>' : '<span class="pact-hint">No Social Merits on sheet</span>') + '</div>'; })()

            + '</div>';
        }
        h += '</div>';
      } else {
        const _pNotes = [isOHM && p.ohm_allies_sphere ? 'Allies: ' + esc(p.ohm_allies_sphere) : '', isOHM && p.ohm_skills && p.ohm_skills.filter(Boolean).length ? '9-again: ' + p.ohm_skills.filter(Boolean).map(esc).join(', ') : '', isSW && p.partner ? 'w/ ' + esc(p.partner) + (p.shared_merit ? ' \u00B7 ' + esc(p.shared_merit) : '') : ''].filter(Boolean).join(' \u00B7 ');
        const _pvTotal = (p.cp || 0) + (p.xp || 0);
        h += '<div class="disc-tap-row" id="disc-row-' + gid + '" onclick="toggleDisc(\'' + gid + '\')">'
          + '<div class="trait-row"><div class="trait-main"><span class="trait-name secondary">' + esc(_toTitle(p.name)) + '</span><div class="trait-right">' + (_pvTotal ? '<span class="trait-dots">' + '\u25CF'.repeat(_pvTotal) + '</span>' : '') + '<span class="disc-tap-arr">\u203A</span></div></div>'
          + (_pNotes ? '<div class="trait-sub"><span class="trait-qual">' + _pNotes + '</span></div>' : '')
          + '</div></div>'
          + '<div class="disc-drawer" id="disc-drawer-' + gid + '"><div class="disc-power">'
          + (p.stats ? '<div class="disc-power-stats">' + esc(p.stats) + '</div>' : '')
          + '<div class="disc-power-effect">' + esc(effect) + '</div>'
          // Issue #994: "Full rules" expander from the oath/law rules doc.
          + (dbEntry && dbEntry.rules_text ? renderRulesExpander('rte-' + gid, dbEntry.rules_text, dbEntry.rules_source) : '')
          + '</div></div>';
      }
    });
    if (editMode) {
      const _takenOaths = new Set(pctP.map(p => (p.name || '').toLowerCase()));
      const _addableOaths = Object.keys(_oathDB).filter(k => !_takenOaths.has(k));
      h += '<div class="dev-add-row" style="display:flex;gap:6px;align-items:center">'
        + '<select id="pact-add-sel" class="gen-qual-input" style="flex:1;min-width:200px">'
        + '<option value="">-- select oath or law to add --</option>'
        + _addableOaths.map(k => { const db = _oathDB[k]; const dots = db && db.rating ? parseInt(db.rating) || 0 : 0; return '<option value="' + esc(k) + '">' + esc(_toTitle(k)) + (dots ? ' (' + '\u25CF'.repeat(dots) + ')' : '') + '</option>'; }).join('')
        + '</select>'
        + '<button class="dev-add-btn" onclick="shAddPact(document.getElementById(\'pact-add-sel\').value)">+ Add Pact</button>'
        + '</div>';
    }
    h += '</div></div>';
  }
  return h;
}

export function shRenderInfluenceMerits(c, editMode) {
  const inflM = (c.merits || []).filter(m => m.category === 'influence');
  if (!editMode && !inflM.length) return '';
  const totalInfl = calcTotalInfluence(c);
  const _inflTip = influenceBreakdown(c).map(l => esc(l)).join('\n');
  const _inflVmPools = (c._grant_pools || []).filter(p => p.category === 'vm');
  const _inflOhmPools = (c._grant_pools || []).filter(p => p.category === 'ohm');
  const _inflInvPools = (c._grant_pools || []).filter(p => p.category === 'inv');
  let _inflAlert = null;
  _inflVmPools.forEach(p => { const u = vmUsed(c); if (u > p.amount) _inflAlert = 'red'; else if (u < p.amount && _inflAlert !== 'red') _inflAlert = 'yellow'; });
  _inflOhmPools.forEach(p => { const u = ohmUsed(c); if (u > p.amount) _inflAlert = 'red'; else if (u < p.amount && _inflAlert !== 'red') _inflAlert = 'yellow'; });
  _inflInvPools.forEach(p => { const u = investedUsed(c); if (u > p.amount) _inflAlert = 'red'; else if (u < p.amount && _inflAlert !== 'red') _inflAlert = 'yellow'; });
  const _inflBadge = editMode ? _alertBadge(_inflAlert) : '';
  let h = '<div class="sh-sec"><div class="sh-sec-title">Influence Merits' + _inflBadge + '</div><div class="merit-list">';
  if (editMode) {
    // All non-Contacts influence merits
    const _inflMciPool = (c.merits || []).filter(m => m.name === 'Mystery Cult Initiation' && m.active !== false).reduce((s, m) => s + mciPoolTotal(m), 0);
    const _inflHasVM = hasViralMythology(c);
    const _inflHasLK = hasLorekeeper(c);
    const _inflHasINV = hasInvested(c);
    const _invMerits = new Set(['Herd', 'Mentor', 'Resources', 'Retainer']);
    const nonContacts = inflM.filter(m => m.name !== 'Contacts');
    const _inflHWV = hasHoneyWithVinegar(c);
    nonContacts.forEach(m => {
      const idx = inflM.indexOf(m), inf = calcMeritInfluence(c, m, _inflHWV), tOpts = buildSubCategoryMeritOptions(c, 'influence', m.name), rIdx = c.merits.indexOf(m), dd = (m.cp || 0) + (m.xp || 0) + meritFreeSum(m) + attacheBonusDots(c, m.area ? m.name + ' (' + m.area + ')' : m.name);
      const _iPurch = (m.cp || 0) + (m.xp || 0);
      let _areaHtml;
      if (m.name === 'Attach\u00e9') {
        const _attEligible = (c.merits || []).filter(m2 => ['Contacts', 'Resources', 'Safe Place'].includes(m2.name));
        const _attKey = m2 => m2.name + (m2.area ? ' (' + m2.area + ')' : '');
        const _attOpts = ['<option value="">(select target)</option>']
          .concat(_attEligible.map(m2 => { const _at = normaliseAttachedTo(m.attached_to); return '<option value="' + esc(_attKey(m2)) + '"' + (_at && _at.destination === _attKey(m2) ? ' selected' : '') + '>' + esc(_attKey(m2)) + '</option>'; }))
          .join('');
        _areaHtml = '<select class="infl-area" onchange="shEditInflMerit(' + idx + ',\'attached_to\',this.value||null)">' + _attOpts + '</select>'
          + '<label class="infl-ghoul-lbl"><input type="checkbox"' + (m.ghoul ? ' checked' : '') + ' onchange="shEditInflMerit(' + idx + ',\'ghoul\',this.checked)"> Ghoul</label>';
      } else {
        _areaHtml = _inflArea(m, idx, false);
      }
      h += '<div class="infl-edit-row"><select class="infl-type" onchange="shEditInflMerit(' + idx + ',\'name\',this.value);renderSheet(chars[editIdx])">' + tOpts + '</select>' + _areaHtml + '<span class="infl-dots-derived">' + shDotsSuspendedPlain(_iPurch, Math.max(0, dd + (m.bonus || 0) - _iPurch), shSuspendedOf(m)) + '</span><span class="infl-inf">' + (inf ? '<span class="infl-tier-chip">' + inf + ' Inf</span>' : '') + '</span>';
      if (m.granted_by) h += '<span class="gen-granted-tag">' + esc(m.granted_by) + '</span>';
      h += '<button class="dev-rm-btn" onclick="shRemoveInflMerit(' + idx + ')" title="Remove">&times;</button></div>';
      const _isAttacheVariant = m.name?.startsWith('Attach\u00e9 (');
      h += meritBdRow(rIdx, m, m.name === 'Attach\u00e9' || _isAttacheVariant ? null : meritFixedRating(m.name), { showMCI: _inflMciPool > 0, showVM: _inflHasVM && (m.name === 'Allies' || m.name === 'Sway'), showLK: _inflHasLK && m.name === 'Retainer', showINV: _inflHasINV && (_invMerits.has(m.name) || _isAttacheVariant || (m.name === 'Attach\u00e9' && (m.cp || 0) + (m.xp || 0) >= 1)), attachBonus: attacheBonusDots(c, m.area ? m.name + ' (' + m.area + ')' : m.name) }); h += _prereqWarn(c, m.name);
      h += _derivedNotes(m);
      const _attBonus = attacheBonusDots(c, m.area ? m.name + ' (' + m.area + ')' : m.name);
      if (_attBonus > 0) h += '<div class="derived-note">Attach\u00e9: +' + _attBonus + ' dot' + (_attBonus !== 1 ? 's' : '') + ' (Invictus Status ' + effectiveInvictusStatus(c) + ')</div>';
    });
    // Contacts: single entry with sphere-per-dot
    const contactsEntry = inflM.find(m => m.name === 'Contacts');
    const cInf = calcContactsInfluence(c);
    if (contactsEntry) {
      const cIdx = c.merits.indexOf(contactsEntry), rating = contactsEntry.rating || 0, spheres = contactsEntry.spheres || [], baseDots = (contactsEntry.cp || 0) + (contactsEntry.xp || 0);
      // Per-dot sphere picker: exclude spheres in use by *other* dots so a
      // single Contacts entry cannot collapse to one sphere across all its dots.
      const spOpts = (currentSel, dotIdx) => {
        const used = new Set(spheres.filter((s, i) => i !== dotIdx && s));
        return INFLUENCE_SPHERES.filter(sp => !used.has(sp) || sp === currentSel)
          .map(sp => '<option' + (currentSel === sp ? ' selected' : '') + '>' + sp + '</option>').join('');
      };
      h += '<div class="contacts-edit-block"><div class="contacts-edit-hdr">Contacts ' + shDotsSuspendedPlain(baseDots, Math.max(0, rating - baseDots), shSuspendedOf(contactsEntry)) + (cInf ? ' \u2014 <span class="inf-val">' + cInf + '</span> inf' : '') + '</div>';
      const _cKey = contactsEntry.area ? 'Contacts (' + contactsEntry.area + ')' : 'Contacts';
      h += meritBdRow(cIdx, contactsEntry, meritFixedRating(contactsEntry.name), { showMCI: _inflMciPool > 0, attachBonus: attacheBonusDots(c, _cKey) });
      const _cAttBonus = attacheBonusDots(c, _cKey);
      if (_cAttBonus > 0) h += '<div class="derived-note">Attach\u00e9: +' + _cAttBonus + ' dot' + (_cAttBonus !== 1 ? 's' : '') + ' (Invictus Status ' + effectiveInvictusStatus(c) + ')</div>';
      h += _derivedNotes(contactsEntry);
      for (let d = 0; d < rating; d++) {
        const sp = spheres[d] || '';
        let src = '';
        if (d < baseDots) src = 'base';
        else src = 'granted';
        h += '<div class="contacts-dot-row"><span class="contacts-dot-num">\u25CF ' + (d + 1) + '</span><select class="contacts-sphere-sel" onchange="shEditContactSphere(' + cIdx + ',' + d + ',this.value)"><option value="">\u2014 sphere \u2014</option>' + spOpts(sp, d) + '</select>' + (src !== 'base' ? '<span class="contacts-dot-src">' + src + '</span>' : '') + '</div>';
      }
      h += '</div>';
    }
    h += '<div class="dev-add-row"><button class="dev-add-btn" onclick="shAddInflMerit(\'Allies\')">+ Add Allies / Other</button></div>';
    h += '<div class="infl-total" title="' + _inflTip + '">Total Influence: <span class="inf-n">' + totalInfl + '</span></div>';
  } else {
    inflM.filter(m => m.name !== 'Contacts').slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach((m, idx) => {
      const area = (m.area || '').trim() || null, gt = m.name === 'Retainer' && m.ghoul ? ' (ghoul)' : '', tags = m._grant_sources || [], gb = tags.length ? (' <span class="gen-granted-tag-view">' + tags.join(', ') + '</span>') : '';
      // 2026-08-26 Sway merge: Sway inherits Status's own narrow-descriptor capability (the
      // richer of the two predecessors' UIs), not just Allies' plain-sphere one — see the
      // matching edit-mode change in _inflArea() below.
      const narrow = (m.name === 'Status' || m.name === 'Sway') && m.narrow && typeof m.narrow === 'string' ? m.narrow.trim() : '';
      const displayArea = narrow ? (area ? area + ' — ' + narrow : narrow) : area;
      const iRIdx = c.merits.indexOf(m);
      const iFreeAndAttache = meritFreeSum(m) + attacheBonusDots(c, displayArea ? m.name + ' (' + displayArea + ')' : m.name);
      const iPurch = (m.cp || 0) + (m.xp || 0), iBon = iFreeAndAttache + (m.bonus || 0);
      // 2026-09-01 general audit (display-rendering dimension, verified):
      // same "invisible mod" gap as the Domain merit row above — m.bonus
      // baked into iBon with no per-dot distinction. It sits at the tail of
      // the hollow band, after iFreeAndAttache.
      const _ovInflBonus = c._st_mod_overlay?.[`merits.${iRIdx}.bonus`];
      const _inflOpts = {};
      if (_ovInflBonus) {
        const sign = _ovInflBonus.delta >= 0 ? '+' : '';
        _inflOpts.hollowMod = {
          from: iFreeAndAttache + _ovInflBonus.base, to: iFreeAndAttache + _ovInflBonus.final,
          path: `merits.${iRIdx}.bonus`,
          title: `ST adjustment: ${m.name} (bonus) ${sign}${_ovInflBonus.delta}. Click for details.`,
        };
      }
      h += shRenderMeritRow((displayArea ? m.name + ' (' + displayArea + gt + ')' : m.name + gt) + gb, 'infl', idx, shDotsSuspended(iPurch, iBon, shSuspendedOf(m), _inflOpts), undefined, c, iRIdx, !!_inflOpts.hollowMod);
    });
    const ce = inflM.filter(m => m.name === 'Contacts');
    if (ce.length) {
      // OATH-B (#1111): Contacts is displayed as ONE aggregate row summed
      // across every instance, while a suspension is per-instance. So the
      // suspension is summed over THE SAME instance set rather than applied
      // to the aggregate afterwards — applying it to the total would be
      // correct only when a single instance is pledged.
      let totalPurch = 0, totalRating = 0, totalSusp = 0;
      ce.forEach(m => {
        totalPurch += (m.cp || 0) + (m.xp || 0);
        totalRating += (m.rating || 0);
        totalSusp += shSuspendedOf(m);
      });
      // No 5-cap: engine bonuses (Attaché variant, OHM, PT, etc.) can lift
      // the effective Contacts rating past 5 and the renderer should show it.
      const cPurch = Math.min(totalPurch, totalRating);
      const cBon = Math.max(0, totalRating - cPurch);
      const allSp = [];
      ce.forEach(m => {
        if (m.spheres && m.spheres.length) allSp.push(...m.spheres);
        else if (m.area) allSp.push(m.area.trim());
        else if (m.qualifier) allSp.push(...m.qualifier.split(/,\s*/).filter(Boolean));
      });
      const sp = [...new Set(allSp)].join(', ');
      h += shRenderMeritRow('Contacts' + (sp ? ' (' + sp + ')' : ''), 'infl', 'contacts', shDotsSuspended(cPurch, cBon, totalSusp));
    }
    h += '<div class="infl-total" title="' + _inflTip + '">Total Influence: <span class="inf-n">' + totalInfl + '</span></div>';
  }
  h += '</div></div>'; return h;
}
function _inflArea(m, idx, isC) {
  const spOpts = s => INFLUENCE_SPHERES.map(sp => '<option' + (s === sp ? ' selected' : '') + '>' + sp + '</option>').join('');
  if (m.name === 'Allies') return '<select class="infl-area" onchange="shEditInflMerit(' + idx + ',\'area\',this.value)"><option value="">\u2014 sphere \u2014</option>' + spOpts(m.area) + '</select>';
  if (isC) return '<span class="infl-area-fixed">' + esc(m.area || '\u2014') + '</span>';
  if (m.name === 'Resources') return '<span class="infl-area-none"></span>';
  if (m.name === 'Mentor') return '<input type="text" class="infl-area" value="' + esc(m.area || '') + '" placeholder="Mentor name" onchange="shEditInflMerit(' + idx + ',\'area\',this.value)">';
  // Retainer + Attaché variants share the same row affordances — Attachés are
  // functionally Retainers (description text + Ghoul flag) per game-rule.
  if (m.name === 'Retainer' || m.name?.startsWith('Attaché (')) return '<input type="text" class="infl-area" value="' + esc(m.area || '') + '" placeholder="Description" onchange="shEditInflMerit(' + idx + ',\'area\',this.value)"><label class="infl-ghoul-lbl"><input type="checkbox"' + (m.ghoul ? ' checked' : '') + ' onchange="shEditInflMerit(' + idx + ',\'ghoul\',this.checked)"> Ghoul</label>';
  if (m.name === 'Staff') return '<input type="text" class="infl-area" value="' + esc(m.area || '') + '" placeholder="Area of expertise" onchange="shEditInflMerit(' + idx + ',\'area\',this.value)">';
  // 2026-08-26 Sway merge: Sway routes here (the richer of the two predecessor UIs \u2014 sphere +
  // narrow descriptor), not to the plain Allies branch above, so the narrow-descriptor
  // capability Status had isn't silently lost for the merged merit.
  if (m.name === 'Status' || m.name === 'Sway') {
    return '<select class="infl-area infl-area-sphere" onchange="shEditInflMerit(' + idx + ',\'area\',this.value)"><option value="">\u2014 sphere \u2014</option>' + spOpts(m.area) + '</select>' +
           '<input type="text" class="infl-area infl-area-narrow" value="' + esc(typeof m.narrow === 'string' ? m.narrow : '') + '" placeholder="Narrow descriptor" onchange="shEditInflMerit(' + idx + ',\'narrow\',this.value)">';
  }
  return '<input type="text" class="infl-area" value="' + esc(m.area || '') + '" placeholder="Sphere / scope" onchange="shEditInflMerit(' + idx + ',\'area\',this.value)">';
}

export function shRenderDomainMerits(c, editMode) {
  const chars = state.chars, domM = (c.merits || []).filter(m => m.category === 'domain');
  if (!editMode && !domM.length) return '';
  const _domLkPools = (c._grant_pools || []).filter(p => p.category === 'lk');
  const _domInvPools = (c._grant_pools || []).filter(p => p.category === 'inv');
  let _domAlert = null;
  _domLkPools.forEach(p => { const u = lorekeeperUsed(c); if (u > p.amount) _domAlert = 'red'; else if (u < p.amount && _domAlert !== 'red') _domAlert = 'yellow'; });
  _domInvPools.forEach(p => { const u = investedUsed(c); if (u > p.amount) _domAlert = 'red'; else if (u < p.amount && _domAlert !== 'red') _domAlert = 'yellow'; });
  const _domBadge = editMode ? _alertBadge(_domAlert) : '';
  let h = '<div class="sh-sec"><div class="sh-sec-title">Domain Merits' + _domBadge + '</div><div class="merit-list">';
  if (editMode) {
    const _domMciPool = (c.merits || []).filter(m => m.name === 'Mystery Cult Initiation' && m.active !== false).reduce((s, m) => s + mciPoolTotal(m), 0);
    const _hasLK = hasLorekeeper(c); const _hasINV = hasInvested(c); const _hasVM = hasViralMythology(c);
    // N-7a (issue #766): Necropolis target merits are sub_category='domain'
    // and render through THIS function — the general-renderer wiring at
    // sheet.js:1325/1342 from N-7 (PR #765) doesn't reach them. Mirrors the
    // LK/Inv/VM precedent which threads the same flags into both the domain
    // renderer (here) AND the influence renderer (line 887). All six
    // Necropolis targets (Catacombs / Caldarium / Garbage Pit / Labyrinth
    // Guardians / Dark Temple / White Ants) live in the domain section, so
    // domain-only wiring is sufficient.
    // COLLECTIVE-2 (issue #1110): every Collective Compound seeded in the
    // rules cache, discovered by sharing_scope.type — no merit-name literal,
    // no slug literal. A fourth compound is data-only.
    const _compounds = getCollectiveCompounds(getRulesCache());
    const _ownedCompounds = _compounds.filter(cmp => ownsCompound(c, cmp));
    // N-7b (issue #768): the target-name set must populate UNCONDITIONALLY —
    // option 3 suppression is "categorically by merit name, regardless of
    // compound membership." The stepper render is still gated on membership
    // below (compoundPools carries only OWNED compounds), but the hide-*
    // flags fire even for non-members who somehow have a compound target
    // merit on their sheet.
    const _targetNames = new Set(_compounds.flatMap(cmp => cmp.targets));
    // Every compound allocation channel — passed to meritBdRow so a target
    // merit's bd-row total counts pool dots from ANY compound, not just the
    // one whose stepper is showing.
    const _compoundSlugs = _compounds.map(cmp => cmp.slug);
    // Compounds that list `name` as a target. Ownership-independent, so a
    // stray target on a non-member still renders its own dots (pre-#1110
    // behaviour). Multi-compound (AC 6): a name claimed by two compounds
    // returns both, and the row sums across them.
    const _compoundsFor = (name) => _compounds.filter(cmp => cmp.targets.includes(name));
    // COLLECTIVE-1 (issue #800): synthesise the union of target merit names
    // ANY member of each owned compound allocates dots to. Used below to
    // (a) augment the dot display on owned target rows with cumulative
    // cross-owner dots, and (b) render virtual rows after the owned-merit
    // loop for targets the current character doesn't own but another member
    // does. Empty for non-members — they never see virtual rows (membership
    // boundary per ADR-005 §D3 amendment).
    const _collectiveNamesBy = new Map(
      _ownedCompounds.map(cmp => [cmp, synthesiseCollectiveCompoundNames(c, chars, cmp)])
    );
    const _ownedTargetSet = new Set(domM.filter(m => _targetNames.has(m.name)).map(m => m.name));
    // COLLECTIVE-1: territory union string for White Ants. Reuses N-4's
    // getNecropolisInfectedTerritories. Flat union, no attribution (Peter
    // decision (a), 2026-06-16).
    const _necroTerritoryUnion = (() => {
      const slugs = getNecropolisInfectedTerritories(chars);
      if (!slugs.length) return '';
      const all = getStoredTerritories() || [];
      const names = slugs.map(slug => {
        const t = all.find(x => x && x.slug === slug);
        return (t && (t.name || t.slug)) || slug;
      });
      return names.join(', ');
    })();
    // Issue #793: alphabetical sort + Necropolis inherited-card grouping.
    // Preserve handler semantics by mapping each merit object back to its
    // ORIGINAL domain-filtered index (the `di` parameter that
    // shEditDomMerit / shRemoveDomMerit / shAddDomainPartner /
    // shRemoveDomainPartner all consume via meritByCategory). Sorting only
    // affects render order, not c.merits or its filtered view.
    const _domIdxByMerit = new Map();
    domM.forEach((m, i) => _domIdxByMerit.set(m, i));
    const _sortedDom = [...domM].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    // Stray-target degradation: target merit present on a character who is
    // not a member of the compound that claims it (legacy/unexpected state).
    // Render in alphabetical position and console.warn for QA visibility per
    // the issue spec.
    {
      const _strays = _sortedDom.filter(m =>
        _targetNames.has(m.name) && !_ownedCompounds.some(cmp => cmp.targets.includes(m.name))
      );
      if (_strays.length) {
        console.warn('[#793] Collective Compound target merits present on a non-member character:',
          _strays.map(m => m.name).join(', '),
          '— rendering in alphabetical position (no inherited-card parent).');
      }
    }
    // Per-row emitter — extracted closure so the inherited-card pass can
    // reuse the exact same row HTML for grouped Necro target merits without
    // duplicating the 130-line body. Appends to outer-scope `h`.
    const _emitDomRow = (m, di) => {
      const hTk = domM.some((dm, dj) => dm.name === 'Herd' && dj !== di);
      // Catalog-driven options (sub_category='domain'), with the Herd-once-per-character
      // rule layered on top. Mandragora Garden's prereq is enforced by the helper.
      let tOpts = buildSubCategoryMeritOptions(c, 'domain', m.name, DOMAIN_MERIT_TYPES);
      if (hTk && m.name !== 'Herd') {
        // Strip Herd from this row's options if another row already has Herd
        tOpts = tOpts.replace(/<option value="Herd"[^>]*>Herd<\/option>/g, '');
      }
      const rIdx = c.merits.indexOf(m), dd = (m.cp || 0) + (m.xp || 0) + meritFreeSum(m) + attacheBonusDots(c, m.area ? m.name + ' (' + m.area + ')' : m.name), parts = m.shared_with || [], eT = domMeritTotal(c, m.name), avP = [...chars].filter(ch => String(ch._id) !== String(c._id) && !parts.some(e => resolveSharedWithMember(chars, e) === ch)).sort((a, b) => sortName(a).localeCompare(sortName(b)));
      // Total display: own dots filled + partner contribution hollow.
      // Cap own at the total so a single character can't double-paint dots
      // beyond the merit's effective rating.
      const _dPurch = (m.cp || 0) + (m.xp || 0);
      // Total display: solid = purchased (cp + xp), hollow = everything else
      // (free_* bonuses + partner contributions). Conflating own-with-bonuses
      // and purchased made auto-bonus dots render solid.
      const _ownCapped = Math.min(dd, eT);
      const _partnerDots = Math.max(0, eT - _ownCapped);
      const _totalSolid = Math.min(eT, _dPurch);
      const _totalHollow = Math.max(0, eT - _totalSolid);
      const _totalDots = shDotsMixed(_totalSolid, _totalHollow);
      // Cap-aware dot display for Haven / Mandragora Garden
      const _isCapped = ['Haven', 'Mandragora Garden'].includes(m.name);
      const _capEff = _isCapped ? meritEffectiveRating(c, m) : null;
      const _capStored = _isCapped ? ((m.cp || 0) + (m.xp || 0) + meritFreeSum(m)) : null;
      // N-1 (Concern #11): normaliser pinpoints the `.destination` for cap-target lookup.
      const _mAt = normaliseAttachedTo(m.attached_to);
      const _spM = _isCapped && _mAt ? (c.merits || []).find(sp => sp.category === 'domain' && sp.name === 'Safe Place' && domKey(sp) === _mAt.destination) : null;
      const _spCap = _spM ? meritEffectiveRating(c, _spM) : 0;
      const _capSharedEff = (parts.length > 0 && _spCap > 0) ? Math.min(eT, _spCap) : null;
      const _capTotalDots = _isCapped
        ? (_capSharedEff !== null
            ? shDotsMixed(Math.min(_capSharedEff, _dPurch), Math.max(0, _capSharedEff - Math.min(_capSharedEff, _dPurch)))
            : shDotsMixed(Math.min(_capEff, _dPurch), Math.max(0, (_capStored || 0) - Math.min(_capEff, _dPurch))))
        : _totalDots;
      // COLLECTIVE-1 (issue #800): compound target rows show own (solid)
      // + cumulative cross-owner (hollow) dots. NOT capped at 5 \u2014 the spec
      // explicitly allows cumulative to exceed the per-instance rating_range.
      // Falls through to the default display for non-target merits.
      // COLLECTIVE-2 (issue #1110): summed across every compound claiming
      // this merit name, each through its own free_grants slug (AC 6).
      const _rowCompounds = _compoundsFor(m.name);
      const _isCompoundTargetHere = _rowCompounds.length > 0;
      const _cmpOwn = _rowCompounds.reduce((s, cmp) => s + freeOf(m, cmp.slug), 0);
      const _cmpCumulative = _rowCompounds.reduce((s, cmp) => s + collectiveCompoundDots(chars, m.name, cmp), 0);
      const _cmpPartner = Math.max(0, _cmpCumulative - _cmpOwn);
      const _cmpDotsHtml = shDotsSuspended(_cmpOwn, _cmpPartner, shSuspendedOf(m));
      const _cmpGateLbl = _rowCompounds.map(cmp => cmp.gateMerit).join(' + ');
      // Issue #827: subtitle for Haven / Mandragora Garden / White Ants
      // renders BEFORE the dots column inside the main row (LHS-justified),
      // keeping dots rightmost. Pre-#827 these subtitles emitted as sibling
      // sub-rows AFTER the dot row, breaking the consistent rightmost-dots
      // rule that every other domain merit follows.
      let _subtitleInline = '';
      if (m.name === 'Haven' || m.name === 'Mandragora Garden') {
        const _viewAt = normaliseAttachedTo(m.attached_to);
        const _dest = _viewAt && _viewAt.destination ? _viewAt.destination : '(not attached)';
        _subtitleInline = '<span class="dom-row-subtitle">Attached: ' + esc(_dest) + '</span>';
      } else if (m.name === 'White Ants' && _necroTerritoryUnion) {
        _subtitleInline = '<span class="dom-row-subtitle">Territories: ' + esc(_necroTerritoryUnion) + '</span>';
      }
      // Issue #832: expand-on-click for domain merits \u2014 same exp-row /
      // exp-body shell as shRenderMeritRow uses for general + influence
      // merits. The click is on the infl-edit-row (the visual row containing
      // name + dots); the rest of the dom-edit-block (qualifier / attach /
      // bd-row pickers / partners) is below and does not toggle. Interactive
      // controls inside the infl-edit-row (select.infl-type + remove button)
      // get event.stopPropagation() so changing the merit type or removing
      // it doesn't accidentally toggle the description.
      const _expId = 'dom-' + rIdx;
      const _expDb = meritLookup(m.name);
      const _expDesc = _expDb && _expDb.desc ? esc(_expDb.desc) : '';
      const _expPrereq = _expDb && _expDb.prereq ? prereqLabel(_expDb.prereq) : '';
      const _hasExpBody = !!_expDesc;
      const _expClass = _hasExpBody ? ' exp-row' : '';
      const _expArr = _hasExpBody ? '<span class="exp-arr">\u203A</span>' : '';
      const _expOnclick = _hasExpBody ? ' onclick="toggleExp(\'' + _expId + '\')"' : '';
      const _expIdAttr = _hasExpBody ? ' id="exp-row-' + _expId + '"' : '';
      // stopPropagation prefix for interactive controls (avoids double-event
      // when the row click also fires from the bubble).
      const _sp = _hasExpBody ? 'event.stopPropagation();' : '';
      // #843: grant-source tag \u2014 same gen-granted-tag treatment as influence rows (line 906).
      // granted_by wins; free_grants map-fallback pattern mirrors line 1389 (ADR-005 forward compat).
      const _fg843 = m.free_grants || {};
      const _grantSource843 = m.granted_by
        || ((_fg843.carthian ?? m.free_carthian ?? 0) > 0 ? 'Carthian Pull' : null)
        || ((_fg843.lk      ?? m.free_lk      ?? 0) > 0 ? 'Lorekeeper'   : null)
        || ((_fg843.inv     ?? m.free_inv     ?? 0) > 0 ? 'Invested'     : null)
        || ((_fg843.vm      ?? m.free_vm      ?? 0) > 0 ? 'VM'           : null)
        || ((_fg843.mci     ?? m.free_mci     ?? 0) > 0 ? 'MCI'          : null)
        || ((_fg843.fwb     ?? m.free_fwb     ?? 0) > 0 ? 'FwB Bonus'    : null)
        || ((_fg843.attache ?? m.free_attache ?? 0) > 0 ? 'Attach\u00E9' : null)
        || null;
      const _grantTag843 = _grantSource843
        ? '<span class="gen-granted-tag">' + esc(_grantSource843) + '</span>'
        : '';
      if (_isCompoundTargetHere) {
        h += '<div class="dom-edit-block"><div class="infl-edit-row' + _expClass + '"' + _expIdAttr + _expOnclick + '><select class="infl-type" onclick="' + _sp + '" onchange="shEditDomMerit(' + di + ',\'name\',this.value)">' + tOpts + '</select>' + _subtitleInline + '<span class="dom-contrib-lbl">My dots: ' + '\u25CF'.repeat(_cmpOwn) + '</span><span class="dom-total-lbl" title="Cumulative across all ' + esc(_cmpGateLbl) + ' owners (\u25CF own, \u25CB partners)">Total: ' + _cmpDotsHtml + '</span>' + _grantTag843 + _expArr + '<button class="dev-rm-btn" onclick="' + _sp + 'shRemoveDomMerit(' + di + ')" title="Remove">&times;</button></div>';
      } else {
        h += '<div class="dom-edit-block"><div class="infl-edit-row' + _expClass + '"' + _expIdAttr + _expOnclick + '><select class="infl-type" onclick="' + _sp + '" onchange="shEditDomMerit(' + di + ',\'name\',this.value)">' + tOpts + '</select>' + _subtitleInline + '<span class="dom-contrib-lbl">My dots: ' + shDotsSuspendedPlain(_dPurch, Math.max(0, dd + (m.bonus || 0) - _dPurch), shSuspendedOf(m)) + '</span><span class="dom-total-lbl" title="Total across all contributors (\u25CF own, \u25CB partners)">Total: ' + (_isCapped ? _capTotalDots : _totalDots) + '</span>' + _grantTag843 + _expArr + '<button class="dev-rm-btn" onclick="' + _sp + 'shRemoveDomMerit(' + di + ')" title="Remove">&times;</button></div>';
      }
      // Qualifier input for Safe Place / Feeding Grounds
      if (['Safe Place', 'Feeding Grounds'].includes(m.name)) {
        const _qErr = c._domQualError && !m.qualifier ? '<span class="dom-qual-error">' + esc(c._domQualError) + '</span>' : (c._domQualError && m.qualifier ? '<span class="dom-qual-error">' + esc(c._domQualError) + '</span>' : '');
        h += '<div class="dom-qual-row"><input type="text" class="dom-qual-input" value="' + esc(m.qualifier || '') + '" placeholder="Descriptor (e.g. Penthouse, Brothels)" onchange="shEditDomMerit(' + di + ',\'qualifier\',this.value.trim())">' + _qErr + '</div>';
        if (!m.qualifier) h += '<div class="dom-qual-hint">Add a descriptor to support multiple instances of this merit</div>';
      }
      // Attached-to selector for Haven / Mandragora Garden
      if (_isCapped) {
        // N-8 (issue #761, Peter decision B 2026-06-15): Mandragora Garden's
        // attached_to picker accepts Necropolis Sepulcher as an alternative
        // destination alongside Safe Place. Single-picker option-set \u2014 NOT
        // dual-anchor (Sepulcher's purchase prereq carries the clan check;
        // there's no second anchor field to populate). Haven stays
        // Safe-Place-only \u2014 only Mandragora gets the expansion.
        const _isMandragora = m.name === 'Mandragora Garden';
        const _spInstances = (c.merits || []).filter(sp =>
          (sp.category === 'domain' && sp.name === 'Safe Place')
          || (_isMandragora && sp.name === 'Necropolis Sepulcher')
        );
        const _placeholderLabel = _isMandragora ? '(select Safe Place or Sepulcher)' : '(select Safe Place)';
        const _spOpts = ['<option value="">' + _placeholderLabel + '</option>']
          .concat(_spInstances.map(sp => { const k = domKey(sp); const _at = normaliseAttachedTo(m.attached_to); return '<option value="' + esc(k) + '"' + (_at && _at.destination === k ? ' selected' : '') + '>' + esc(k) + '</option>'; }))
          .join('');
        h += '<div class="dom-attach-row"><label class="dom-attach-lbl">Attached to:</label><select class="dom-attach-sel" onchange="shEditDomMerit(' + di + ',\'attached_to\',this.value||null)">' + _spOpts + '</select></div>';
        if (!normaliseAttachedTo(m.attached_to) || _spInstances.length === 0) {
          h += '<div class="dom-cap-warn">\u26A0 Needs an attached ' + (_isMandragora ? 'Safe Place or Sepulcher' : 'Safe Place') + ' \u2014 contributes 0 dots until linked.</div>';
        } else if (_capStored > _capEff) {
          h += '<div class="dom-cap-warn">\u26A0 Capped at ' + _capEff + ' (attached ' + (_isMandragora ? 'anchor' : 'Safe Place') + ' is ' + _capEff + ' \u2014 ' + (_capStored - _capEff) + ' dot' + (_capStored - _capEff !== 1 ? 's' : '') + ' over-allocated, will count if upgraded)</div>';
        }
      }
      const _isLKMerit = m.name === 'Herd' || m.name === 'Retainer'; const _isINVMerit = m.name === 'Herd'; const _isVMMerit = m.name === 'Herd';
      // N-7b (issue #768, Peter decision option 3, 2026-06-16): compound
      // target merits are pool-funded only. Suppress CP / XP / MCI / Bonus
      // categorically by merit name (regardless of membership — the row
      // exists because the merit is on the sheet, but it must NEVER be
      // hand-funded). The pool stepper is the only allocation surface.
      const _isCompoundTarget = _targetNames.has(m.name);
      // COLLECTIVE-2: one stepper per OWNED compound claiming this merit,
      // each writing its own free_grants slug. Non-members get none.
      const _rowPools = _rowCompounds.filter(cmp => _ownedCompounds.includes(cmp));
      h += meritBdRow(rIdx, m, meritFixedRating(m.name), { showMCI: _domMciPool > 0 && !_isCompoundTarget, showVM: _hasVM && _isVMMerit, showLK: _hasLK && _isLKMerit, showINV: _hasINV && _isINVMerit, compoundPools: _rowPools, compoundSlugs: _compoundSlugs, hideCP: _isCompoundTarget, hideXP: _isCompoundTarget, hideMCI: _isCompoundTarget, hideBonus: _isCompoundTarget, attachBonus: attacheBonusDots(c, m.area ? m.name + ' (' + m.area + ')' : m.name) }); h += _prereqWarn(c, m.name);
      // N-4a (issue #781): White Ants Territory picker + Trap Door triple-anchor
      // picker. Both target merits are sub_category='domain', so the pickers
      // must render in the domain loop here — not in shRenderGeneralMerits.
      // The N-4 / N-5 wiring originally lifted the integration point from a
      // general-merit precedent; same blind spot as N-7a (NECRO stepper in
      // wrong renderer) and N-7c (orchestrator dispatch missing). Production
      // symptom pre-fix: ST cannot pick territories → save fails 400.
      h += _whiteAntsTerritoriesBlock(m, rIdx);
      // Issue #827: territory union no longer rendered here as a sibling
      // sub-row — moved INLINE into the infl-edit-row above (LHS-justified,
      // before the dots column). Keeps dots as the rightmost element per
      // Peter 2026-06-16 ("Dots should be last and rightmost thing in the
      // row always for all domain merits"). The COLLECTIVE-1 union helper
      // (_necroTerritoryUnion) still computes the same value; only the
      // emission site moved.
      h += _trapDoorAnchorBlock(c, m, rIdx);
      h += _derivedNotes(m);
      if (m.name === 'Herd') { const ssjB = ssjHerdBonus(c); if (ssjB) h += '<div class="derived-note">SSJ Bonus: +' + ssjB + ' dots (' + shDots(ssjB) + ') \u2014 equals MCI dots</div>'; }
      if (m.name === 'Herd') { const flockB = flockHerdBonus(c); if (flockB) h += '<div class="derived-note">Flock Bonus: +' + flockB + ' dots (' + shDots(flockB) + ') \u2014 equals Flock rating, can exceed 5</div>'; }
      // Issue #782 (Peter decision (a), 2026-06-16): partner_explicit shared_with
      // picker is restricted to Safe Place and Haven only. Inverted from the
      // previous negative `_noShare` exclusion (['Herd', 'Feeding Grounds']) to
      // a positive include list — every other domain merit (Mandragora Garden,
      // Necropolis Sepulcher, all 6 Necropolis targets, Trap Door, future
      // additions) defaults to NOT shareable via this picker.
      //
      // Audit trail of prior decisions reversed/preserved:
      // - Issue #160 (2026-05-08): added Mandragora Garden to shareable per
      //   published errata. REVERSED by #782 — Peter's framing returns the
      //   game to "only Safe Place and Haven share".
      // - Issue #313 (2026-05-15): added Haven to shareable. PRESERVED.
      // - Necropolis family auto-shares via _collective_shared_with synthesis
      //   (ADR-005 Rev 2 §D3) — that's the correct mechanism, orthogonal to
      //   this partner_explicit picker UI.
      //
      // Existing `m.shared_with` data on non-shareable merits is preserved in
      // the DB as inert (no destructive migration in this scope); the gate
      // below suppresses display + add-partner UI on the editor surface.
      const _canShare = ['Safe Place', 'Haven'];
      // Kurtis W bug report (2026-09): same ID-leak shape as the view-mode
      // _viewSharedSub row above \u2014 falls back to the server's _partner_names
      // enrichment rather than the raw shared_with entry.
      if (_canShare.includes(m.name) && parts.length) { h += '<div class="dom-partners-row">'; parts.forEach(pEntry => { const p = resolveSharedWithMember(chars, pEntry); const remote = !p && m._partner_names && m._partner_names[pEntry]; const pN = p ? displayName(p) : (remote ? displayName(remote) : pEntry); const pD = p ? domMeritShareable(p, m.name) : 0; h += '<span class="dom-partner-tag">' + esc(pN) + (pD ? ' ' + shDots(pD) : ' \u25CB') + '<button class="dom-partner-rm" onclick="shRemoveDomainPartner(' + di + ',\'' + pEntry.replace(/'/g, "\\'") + '\')">\u00D7</button></span>'; }); h += '</div>'; }
      if (_canShare.includes(m.name) && avP.length) h += '<div class="dom-add-partner-row"><select class="dom-partner-sel" onchange="if(this.value){shAddDomainPartner(' + di + ',this.value);this.value=\'\';}"><option value="">+ Add shared partner\u2026</option>' + avP.map(p => '<option value="' + esc(String(p._id)) + '">' + esc(dropdownName(p)) + '</option>').join('') + '</select></div>';
      // Issue #832: exp-body sibling at the end of dom-edit-block holds the
      // collapsible description + prereq. Only emitted when the merit has a
      // description in the rules cache (matches shRenderMeritRow's gate).
      if (_hasExpBody) {
        h += '<div class="exp-body" id="exp-body-' + _expId + '"><div>' + _expDesc + '</div>'
          + (_expPrereq ? '<div style="margin-top:5px;font-style:italic;color:var(--txt3)">Prerequisite: ' + esc(_expPrereq) + '</div>' : '')
          + '</div>';
      }
      h += '</div>';
    };
    // Virtual-row emitter \u2014 same pattern as _emitDomRow but for synthesised
    // partner-only compound target rows that the current character doesn't
    // own. Materialisation routes through shAllocateCompoundVirtual, which
    // takes the compound's slug because no realIdx exists.
    const _emitVirtualCompoundRow = (vName, compound) => {
      const _vPartner = collectiveCompoundDots(chars, vName, compound);
      const _vOwn = 0;
      const _vDots = shDotsMixed(_vOwn, _vPartner);
      const _vSlug = vName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      // Issue #827: territory subtitle inline before the dots (rightmost).
      const _vSubtitle = (vName === 'White Ants' && _necroTerritoryUnion)
        ? '<span class="dom-row-subtitle">Territories: ' + esc(_necroTerritoryUnion) + '</span>'
        : '';
      // Issue #832: virtual rows get the same expand-on-click affordance as
      // owned rows. Look up the merit's description by name (the merit isn't
      // on c.merits yet, but the rules cache has the doc keyed by name slug).
      // The NECRO stepper inside the bd-row gets stopPropagation so clicking
      // the input doesn't toggle the expand.
      const _vExpId = 'dom-v-' + _vSlug;
      const _vDb = meritLookup(vName);
      const _vDesc = _vDb && _vDb.desc ? esc(_vDb.desc) : '';
      const _vPrereq = _vDb && _vDb.prereq ? prereqLabel(_vDb.prereq) : '';
      const _vHasExp = !!_vDesc;
      const _vExpClass = _vHasExp ? ' exp-row' : '';
      const _vExpArr = _vHasExp ? '<span class="exp-arr">\u203A</span>' : '';
      const _vExpOnclick = _vHasExp ? ' onclick="toggleExp(\'' + _vExpId + '\')"' : '';
      const _vExpIdAttr = _vHasExp ? ' id="exp-row-' + _vExpId + '"' : '';
      const _vSp = _vHasExp ? 'event.stopPropagation();' : '';
      h += '<div class="dom-edit-block dom-edit-block--virtual">'
        + '<div class="infl-edit-row' + _vExpClass + '"' + _vExpIdAttr + _vExpOnclick + '>'
        + '<span class="infl-type infl-type--virtual" title="Partner-only \u2014 click NECRO to allocate your own dots">' + esc(vName) + '</span>'
        + _vSubtitle
        + '<span class="dom-contrib-lbl">My dots: </span>'
        + '<span class="dom-total-lbl" title="Cumulative across all ' + esc(compound.gateMerit) + ' owners (\u25CF own, \u25CB partners)">Total: ' + _vDots + '</span>'
        + _vExpArr
        + '</div>'
        + '<div class="merit-bd-row">'
        + '<div class="bd-grp">'
        + '<span class="bd-lbl bd-bonus-lbl" id="bd-' + compound.slug + '-vlbl-' + _vSlug + '">' + esc(compound.slug.toUpperCase()) + '</span>'
        + '<input id="bd-' + compound.slug + '-v-' + _vSlug + '" name="bd-' + compound.slug + '-v-' + _vSlug + '" aria-label="' + esc(compound.source) + ' pool allocation" class="merit-bd-input bd-bonus-input" type="number" min="0" value="0" onclick="' + _vSp + '" onchange="shAllocateCompoundVirtual(\'' + vName.replace(/'/g, "\\'") + '\',\'' + compound.slug + '\',+this.value)">'
        + '</div>'
        + '<div class="bd-eq"><span class="bd-val">' + _vPartner + ' partner dot' + (_vPartner === 1 ? '' : 's') + '</span></div>'
        + '</div>';
      if (_vHasExp) {
        h += '<div class="exp-body" id="exp-body-' + _vExpId + '"><div>' + _vDesc + '</div>'
          + (_vPrereq ? '<div style="margin-top:5px;font-style:italic;color:var(--txt3)">Prerequisite: ' + esc(_vPrereq) + '</div>' : '')
          + '</div>';
      }
      h += '</div>';
    };
    // Issue #793: sorted iteration with inherited-card grouping.
    // - Target merits skip the main pass when the char is a member of the
    //   claiming compound (they render inside that compound's inherited card
    //   after the source merit's row).
    // - Target merits on a non-member render in alphabetical position (no
    //   parent to anchor under; degrades gracefully).
    // - The source merit's row triggers its inherited card if there's
    //   anything to show (owned target merits + COLLECTIVE-1 virtual rows).
    // COLLECTIVE-2 (issue #1110): one card per owned compound. A target name
    // claimed by two owned compounds is placed in the FIRST one only, so it
    // renders once; its row still sums dots across both (AC 6).
    const _cardPlacement = new Map(); // merit name \u2192 owning compound
    for (const cmp of _ownedCompounds) {
      for (const n of cmp.targets) {
        if (!_cardPlacement.has(n)) _cardPlacement.set(n, cmp);
      }
    }
    const _cardsByCompound = new Map(_ownedCompounds.map(cmp => {
      const _virtualNames = (_collectiveNamesBy.get(cmp) || [])
        .filter(n => !_ownedTargetSet.has(n) && _cardPlacement.get(n) === cmp);
      const _ownedTargets = _sortedDom.filter(mm => _cardPlacement.get(mm.name) === cmp);
      return [cmp, { virtualNames: _virtualNames, ownedTargets: _ownedTargets }];
    }));
    const _hasCardContentFor = (cmp) => {
      const card = _cardsByCompound.get(cmp);
      return !!card && (card.ownedTargets.length > 0 || card.virtualNames.length > 0);
    };
    const _emitInheritedCard = (cmp) => {
      const card = _cardsByCompound.get(cmp);
      h += '<div class="dom-inherited-card">';
      h += '<div class="dom-inherited-card-title">Inherited from ' + esc(cmp.source) + '</div>';
      // Combined alphabetical: owned target names + virtual names. Owned
      // rows render via _emitDomRow (full editor row with stepper); virtual
      // rows render via _emitVirtualCompoundRow (no realIdx).
      const _cardEntries = [
        ...card.ownedTargets.map(mm => ({ kind: 'owned', name: mm.name, m: mm })),
        ...card.virtualNames.map(n => ({ kind: 'virtual', name: n })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of _cardEntries) {
        if (entry.kind === 'owned') {
          _emitDomRow(entry.m, _domIdxByMerit.get(entry.m));
        } else {
          _emitVirtualCompoundRow(entry.name, cmp);
        }
      }
      h += '</div>';
    };
    const _cardsRendered = new Set();
    for (const m of _sortedDom) {
      const di = _domIdxByMerit.get(m);
      if (_cardPlacement.has(m.name)) {
        // Skip \u2014 will render inside the claiming compound's inherited card.
        continue;
      }
      // Source merit OR non-target OR stray target on a non-member: emit normally.
      _emitDomRow(m, di);
      // If we just rendered a compound's source merit AND the character is a
      // member AND there's anything to show, emit its card immediately after.
      for (const cmp of _ownedCompounds) {
        if (m.name !== cmp.source || _cardsRendered.has(cmp)) continue;
        if (!_hasCardContentFor(cmp)) continue;
        _emitInheritedCard(cmp);
        _cardsRendered.add(cmp);
      }
    }
    // Edge case: character owns the source merit (anywhere \u2014 possibly
    // mis-categorised as general on a legacy merit doc) but its instance
    // isn't in domM, so the loop above never anchored the card. Emit at end
    // so target merits + virtual rows still render. Production data should
    // have the source merit in domM post-#770 (seed sub_category='domain'),
    // but the editor must degrade gracefully on legacy / test-fixture shapes.
    for (const cmp of _ownedCompounds) {
      if (_cardsRendered.has(cmp) || !_hasCardContentFor(cmp)) continue;
      _emitInheritedCard(cmp);
      _cardsRendered.add(cmp);
    }
    // Issue #793: virtual rows now render inside the inherited card above.
    // The pre-#793 standalone virtual-row loop has been removed \u2014 it would
    // double-render targets already placed in the card. Sepulcher-owner
    // gates the synthesis (COLLECTIVE-1) and the card consumes both owned
    // + virtual names in one alphabetical pass.
    h += '<div class="dev-add-row"><button class="dev-add-btn" onclick="shAddDomMerit()">+ Add Domain Merit</button></div>';
  } else {
    // Issue #782: read-only view shares the same partner-display gate as the
    // editor surface — only Safe Place and Haven render the "Shared · ..." line.
    // Stored `m.shared_with` on other merits is treated as inert data and
    // suppressed from display (no destructive migration; future cleanup is a
    // separate story).
    const _canShareView = ['Safe Place', 'Haven'];
    // COLLECTIVE-1 (issue #800): view-mode synthesis mirrors edit-mode logic.
    // Computed once outside the per-row loop.
    // COLLECTIVE-2 (issue #1110): both renderers walk the SAME compound
    // descriptors from getCollectiveCompounds. Wiring only one of the two is
    // the silent failure mode this story exists to avoid — see the
    // render-wiring-placement precedent in the story Dev Notes.
    const _compoundsView = getCollectiveCompounds(getRulesCache());
    const _ownedCompoundsView = _compoundsView.filter(cmp => ownsCompound(c, cmp));
    const _targetNamesView = new Set(_compoundsView.flatMap(cmp => cmp.targets));
    const _compoundsForView = (name) => _compoundsView.filter(cmp => cmp.targets.includes(name));
    const _collectiveNamesByView = new Map(
      _ownedCompoundsView.map(cmp => [cmp, synthesiseCollectiveCompoundNames(c, chars, cmp)])
    );
    const _ownedTargetSetView = new Set(domM.filter(m => _targetNamesView.has(m.name)).map(m => m.name));
    const _necroTerritoryUnionView = (() => {
      const slugs = getNecropolisInfectedTerritories(chars);
      if (!slugs.length) return '';
      const all = getStoredTerritories() || [];
      return slugs.map(slug => {
        const t = all.find(x => x && x.slug === slug);
        return (t && (t.name || t.slug)) || slug;
      }).join(', ');
    })();
    // Issue #793: view-mode inherited-card grouping. Same pattern as
    // edit-mode: sort alphabetically; skip Necro target merits when char
    // owns Sepulcher; emit Sepulcher row + inherited card containing the
    // target rows + virtual rows. Non-Sepulcher chars render any stray
    // target merits in alphabetical position (no card, no warn — read-only
    // path; the edit-mode warn is the appropriate surface for QA).
    const _sortedDomView = domM.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const _emitViewRow = (m) => {
      const dp = _canShareView.includes(m.name) && m.shared_with && m.shared_with.length ? m.shared_with : null;
      // de: per-instance effective rating (handles cap for Haven/MG, multi-instance for SP/FG)
      const de = meritEffectiveRating(c, m);
      const mBon = m.bonus || 0;
      // N-1: per-slug reads inline the map-fallback shape `m.free_grants?.<slug> ?? m.free_<slug> ?? 0` so N-2 backfill (legacy → map) doesn't drop dots on the read-only sheet path.
      const _fg = m.free_grants || {};
      const _dRaw = (m.cp || 0) + (_fg.bloodline ?? m.free_bloodline ?? 0) + (_fg.pet ?? m.free_pet ?? 0) + (_fg.mci ?? m.free_mci ?? 0) + (_fg.vm ?? m.free_vm ?? 0) + (_fg.lk ?? m.free_lk ?? 0) + (_fg.inv ?? m.free_inv ?? 0) + attacheBonusDots(c, m.area ? m.name + ' (' + m.area + ')' : m.name) + (m.xp || 0), ssjB = !dp && m.name === 'Herd' ? ssjHerdBonus(c) : 0, flockB = !dp && m.name === 'Herd' ? flockHerdBonus(c) : 0, fwbB = !dp ? (_fg.fwb ?? m.free_fwb ?? 0) : 0, attB = !dp ? (_fg.attache ?? m.free_attache ?? 0) : 0, carthB = !dp ? (_fg.carthian ?? m.free_carthian ?? 0) : 0; // #508 carthB
      const _viewStored = (m.cp || 0) + (m.xp || 0) + meritFreeSum(m) + mBon;
      const _isCappedView = ['Haven', 'Mandragora Garden'].includes(m.name);
      // Dot display: for capped merits show solid up to eff, hollow for over-cap stored dots
      let dotHtml;
      // Set true only by the branch below that already marks the modded dot
      // in place — suppresses the redundant standalone markerFor() pip at
      // _viewAfford so an active bonus mod isn't signalled twice. Stays
      // false (pip keeps showing) for the other branches (_isCappedView,
      // compound-target rows), which don't yet carry per-dot marking.
      let _bonusMarkedOnDot = false;
      // COLLECTIVE-1 (issue #800): compound target rows take precedence —
      // own (the compound's free_grants slug) solid + cumulative-other
      // hollow. Bypasses _isCappedView / ssjB / etc. since target merits
      // have none of those.
      // COLLECTIVE-2 (issue #1110): summed across every compound claiming
      // this merit name — same arithmetic as the edit-mode row, routed
      // through the same primitive so the two views cannot drift.
      const _rowCompoundsView = _compoundsForView(m.name);
      if (_rowCompoundsView.length > 0) {
        const _own = _rowCompoundsView.reduce((s, cmp) => s + freeOf(m, cmp.slug), 0);
        const _cumul = _rowCompoundsView.reduce((s, cmp) => s + collectiveCompoundDots(chars, m.name, cmp), 0);
        const _partner = Math.max(0, _cumul - _own);
        dotHtml = shDotsSuspended(_own, _partner, shSuspendedOf(m));
      } else if (_isCappedView) {
        const _cPurch = Math.min(de, (m.cp || 0) + (m.xp || 0));
        dotHtml = shDotsMixed(_cPurch, Math.max(0, _viewStored - _cPurch));
      } else if (ssjB > 0 || flockB > 0 || fwbB > 0 || attB > 0 || mBon > 0 || carthB > 0) {
        const dPurch = _dRaw;
        // 2026-09-01 general audit (display-rendering dimension, verified):
        // mBon (m.bonus, an st_mod-overlayable path via merits.N.bonus) was
        // baked directly into the hollow-dot count with no per-dot
        // distinction — the same "invisible mod" shape #408 fixed for
        // attributes/skills. hollowMod's sub-range sits at the tail of the
        // hollow band (after the ssjB/flockB/fwbB/attB/carthB contribution
        // already folded into `de`), offset by the overlay's own pre-mod
        // base within that band — same convention as _stmAttrOpts's
        // autoBonus offset.
        const _meritIdx = c.merits.indexOf(m);
        const _ovMeritBonus = c._st_mod_overlay?.[`merits.${_meritIdx}.bonus`];
        const _meritOpts = {};
        if (_ovMeritBonus) {
          const sign = _ovMeritBonus.delta >= 0 ? '+' : '';
          const hollowBase = Math.max(0, de - dPurch);
          _meritOpts.hollowMod = {
            from: hollowBase + _ovMeritBonus.base, to: hollowBase + _ovMeritBonus.final,
            path: `merits.${_meritIdx}.bonus`,
            title: `ST adjustment: ${m.name} (bonus) ${sign}${_ovMeritBonus.delta}. Click for details.`,
          };
          _bonusMarkedOnDot = true;
        }
        dotHtml = shDotsMixed(dPurch, Math.max(0, de - dPurch) + mBon, _meritOpts);
      } else {
        dotHtml = '<span class="trait-dots">' + shDots(de) + '</span>';
      }
      // Shared display: three tiers \u2014 filled \u25CF inherent (cp+xp), hollow \u25CB bonus (free_*), underlined \u25CB shared (partner).
      const _sh3Inherent = Math.min(de, (m.cp || 0) + (m.xp || 0));
      const _sh3OwnAll   = Math.min(de, (m.cp || 0) + (m.xp || 0) + meritFreeSum(m));
      const _sh3Bonus    = _sh3OwnAll - _sh3Inherent;
      const _sh3Shared   = Math.max(0, de - _sh3OwnAll);
      const _shHtml      = '<div class="dom-total-view" title="\u25CF inherent, \u25CB bonus, \u25CB\u0332 shared">' + shDotsThreeTier(_sh3Inherent, _sh3Bonus, _sh3Shared) + '</div>';
      // Display name includes qualifier when present
      const _dispName = m.name + (m.qualifier ? ' <span class="trait-qual">(' + esc(m.qualifier) + ')</span>' : '');
      // Issue #827: subtitle inline before dots (rightmost). Haven /
      // Mandragora "Attached: X" + White Ants "Territories: ..." move from
      // sibling sub-rows into the main row.
      let _subtitleInlineView = '';
      if (_isCappedView) {
        const _viewAt = normaliseAttachedTo(m.attached_to);
        if (_viewAt && _viewAt.destination) {
          _subtitleInlineView = '<span class="trait-qual dom-row-subtitle">Attached: ' + esc(_viewAt.destination) + '</span>';
        }
      } else if (m.name === 'White Ants' && _necroTerritoryUnionView) {
        _subtitleInlineView = '<span class="trait-qual dom-row-subtitle">Territories: ' + esc(_necroTerritoryUnionView) + '</span>';
      }
      // Issue #832: view-mode expand-on-click. Mirrors shRenderMeritRow's
      // exp-row { trait-row + trait-sub } + sibling exp-body shell. Read-
      // only path has no interactive controls so no stopPropagation needed.
      // Derived-note warnings (Capped / Needs attached) emit as further
      // siblings after the exp-body \u2014 same visual intent as the existing
      // pattern (cap warning sits beneath the row).
      const _viewRealIdx = c.merits.indexOf(m);
      const _viewExpId = 'dom-' + _viewRealIdx;
      const _viewDb = meritLookup(m.name);
      const _viewDesc = _viewDb && _viewDb.desc ? esc(_viewDb.desc) : '';
      const _viewPrereq = _viewDb && _viewDb.prereq ? prereqLabel(_viewDb.prereq) : '';
      const _viewHasExp = !!_viewDesc;
      // Kurtis W bug report (2026-09): resolveSharedWithMember only searches
      // `chars` (this viewer's own role-scoped roster), which never contains
      // a shared merit's partner for a player's own view \u2014 the raw 24-hex
      // shared_with entry rendered instead of a name, long enough to
      // overflow the row and overlap the one below. Falls back to the
      // server's own _partner_names enrichment (server/routes/characters.js)
      // when local resolution fails; that enrichment has no per-partner dot
      // breakdown (only the merit's own summed _partner_dots, used
      // elsewhere), so a server-resolved partner's own dot count is omitted
      // here rather than guessed at.
      const _viewSharedSub = dp
        ? '<div class="trait-sub"><span class="trait-qual dom-shared-lbl">Shared \u00B7 ' + dp.map(entry => {
            const p = resolveSharedWithMember(chars, entry);
            if (p) {
              const pd = domMeritShareable(p, m.name);
              return esc(displayName(p)) + (pd ? ' ' + shDots(pd) : '');
            }
            const remote = m._partner_names && m._partner_names[entry];
            return esc(remote ? displayName(remote) : entry);
          }).join(', ') + '</span></div>'
        : '';
      const _viewArr = _viewHasExp ? '<span class="exp-arr">\u203A</span>' : '';
      // TM Admin Story tm-admin.10.1b AC2 (extended): shRenderDomainMerits'
      // own view-mode row (_emitViewRow) never routed through
      // shRenderMeritRow (it builds _viewInner inline) \u2014 so the story's
      // literal "wire it into shRenderMeritRow, one call site" instruction
      // would silently leave Domain merits with NO audited bonus-grant path
      // at all once AC4 removes the edit-mode stepper below. Wiring the same
      // applyAffordance/markerFor pair directly here closes that gap.
      // Compound-target rows (_rowCompoundsView.length > 0, e.g. Necropolis
      // targets) are pool-funded only and never read m.bonus (mirrors the
      // edit-mode hideBonus: _isCompoundTarget suppression at meritBdRow's
      // own call site below) \u2014 no affordance on those rows either.
      const _viewStatPath = 'merits.' + _viewRealIdx + '.bonus';
      // 2026-09-01 general audit: markerFor()'s standalone pip is redundant
      // (and was the audit's own "signalled twice" finding) once
      // _bonusMarkedOnDot is true — the active mod is already marked on the
      // dot itself. Keep applyAffordance either way (it's the "+ apply a
      // new bonus" control, unrelated to marking an existing one).
      const _viewAfford = _rowCompoundsView.length === 0
        ? applyAffordance(c, _viewStatPath, m.name) + (_bonusMarkedOnDot ? '' : markerFor(c, _viewStatPath))
        : '';
      // Inner row body \u2014 trait-row + trait-main + trait-right + optional
      // shared trait-sub. Self-contained: opens 3 divs (trait-row,
      // trait-main, trait-right) and closes them all inline.
      const _viewInner = '<div class="trait-row"><div class="trait-main"><span class="trait-name">' + _dispName + '</span>' + _viewAfford + _subtitleInlineView + '<div class="trait-right">' + (dp ? _shHtml : dotHtml) + _viewArr + '</div></div></div>' + _viewSharedSub;
      // Capped-view warnings (Needs Attached / Capped at N) \u2014 derived-note
      // siblings after the exp-body. Hoisted out so both branches share.
      let _viewCappedNote = '';
      if (_isCappedView) {
        // Kurtis W bug report (2026-09, "Safe Place capped by Safe Place"
        // confusing message): the underlying cap logic is correct (Haven/
        // Mandragora Garden really is capped by its attached anchor) \u2014 the
        // wording was the problem, on two counts:
        //   1. Neither message named the merit it was describing, so a
        //      Haven row's own note read as a bare "Safe Place limits..."
        //      sitting directly under a subtitle that ALSO reads "Attached
        //      to: Safe Place (...)" \u2014 easy to misread as self-referential.
        //   2. This view-mode copy hardcoded "Safe Place" even for
        //      Mandragora Garden, which (N-8, issue #761) can anchor to a
        //      Necropolis Sepulcher instead \u2014 genuinely wrong wording in
        //      that case, not just unclear. Edit-mode already generalised
        //      this correctly (line ~1433 above); view-mode had not.
        const _isMandragoraView = m.name === 'Mandragora Garden';
        const _viewAnchorLabel = _isMandragoraView ? 'Safe Place or Sepulcher' : 'Safe Place';
        const _viewAt = normaliseAttachedTo(m.attached_to);
        if (!_viewAt) {
          _viewCappedNote = '<div class="derived-note dom-cap-warn">' + esc(m.name) + ' needs an attached ' + _viewAnchorLabel + ' (0 effective dots)</div>';
        } else if (_viewStored > de) {
          _viewCappedNote = '<div class="derived-note">' + esc(m.name) + ' capped at ' + de + ' by its attached ' + (_isMandragoraView ? 'anchor' : 'Safe Place') + '</div>';
        }
      }
      if (_viewHasExp) {
        h += '<div class="exp-row" id="exp-row-' + _viewExpId + '" onclick="toggleExp(\'' + _viewExpId + '\')">' + _viewInner + '</div>';
        h += '<div class="exp-body" id="exp-body-' + _viewExpId + '"><div>' + _viewDesc + '</div>'
          + (_viewPrereq ? '<div style="margin-top:5px;font-style:italic;color:var(--txt3)">Prerequisite: ' + esc(_viewPrereq) + '</div>' : '')
          + '</div>';
        h += _viewCappedNote;
      } else {
        h += '<div class="merit-plain">' + _viewInner + _viewCappedNote + '</div>';
      }
    };
    const _emitVirtualViewRow = (vName, compound) => {
      const _vPartner = collectiveCompoundDots(chars, vName, compound);
      const _vDots = shDotsMixed(0, _vPartner);
      // Issue #827: territory subtitle inline before dots on White Ants
      // virtual row too.
      const _vSubtitle = (vName === 'White Ants' && _necroTerritoryUnionView)
        ? '<span class="trait-qual dom-row-subtitle">Territories: ' + esc(_necroTerritoryUnionView) + '</span>'
        : '';
      // Issue #832: virtual view row also gets expand-on-click. ID prefix
      // matches the edit-mode virtual row pattern (`dom-v-<slug>`); merit
      // looked up by name from the rules cache.
      const _vSlug = vName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const _vViewExpId = 'dom-v-' + _vSlug;
      const _vViewDb = meritLookup(vName);
      const _vViewDesc = _vViewDb && _vViewDb.desc ? esc(_vViewDb.desc) : '';
      const _vViewPrereq = _vViewDb && _vViewDb.prereq ? prereqLabel(_vViewDb.prereq) : '';
      const _vViewHasExp = !!_vViewDesc;
      const _vViewArr = _vViewHasExp ? '<span class="exp-arr">›</span>' : '';
      const _vViewInner = '<div class="trait-row"><div class="trait-main">'
        + '<span class="trait-name">' + esc(vName) + '</span>'
        + _vSubtitle
        + '<div class="trait-right">' + _vDots + _vViewArr + '</div>'
        + '</div></div>';
      if (_vViewHasExp) {
        h += '<div class="exp-row merit-plain--virtual" id="exp-row-' + _vViewExpId + '" onclick="toggleExp(\'' + _vViewExpId + '\')">' + _vViewInner + '</div>';
        h += '<div class="exp-body" id="exp-body-' + _vViewExpId + '"><div>' + _vViewDesc + '</div>'
          + (_vViewPrereq ? '<div style="margin-top:5px;font-style:italic;color:var(--txt3)">Prerequisite: ' + esc(_vViewPrereq) + '</div>' : '')
          + '</div>';
      } else {
        h += '<div class="merit-plain merit-plain--virtual">' + _vViewInner + '</div>';
      }
    };
    // COLLECTIVE-2 (issue #1110): one card per owned compound, same
    // first-claim placement rule as edit mode.
    const _cardPlacementView = new Map();
    for (const cmp of _ownedCompoundsView) {
      for (const n of cmp.targets) {
        if (!_cardPlacementView.has(n)) _cardPlacementView.set(n, cmp);
      }
    }
    const _cardsByCompoundView = new Map(_ownedCompoundsView.map(cmp => {
      const virtualNames = (_collectiveNamesByView.get(cmp) || [])
        .filter(n => !_ownedTargetSetView.has(n) && _cardPlacementView.get(n) === cmp);
      const ownedTargets = _sortedDomView.filter(mm => _cardPlacementView.get(mm.name) === cmp);
      return [cmp, { virtualNames, ownedTargets }];
    }));
    const _hasCardContentViewFor = (cmp) => {
      const card = _cardsByCompoundView.get(cmp);
      return !!card && (card.ownedTargets.length > 0 || card.virtualNames.length > 0);
    };
    const _emitInheritedCardView = (cmp) => {
      const card = _cardsByCompoundView.get(cmp);
      h += '<div class="dom-inherited-card">';
      h += '<div class="dom-inherited-card-title">Inherited from ' + esc(cmp.source) + '</div>';
      const _cardEntries = [
        ...card.ownedTargets.map(mm => ({ kind: 'owned', name: mm.name, m: mm })),
        ...card.virtualNames.map(n => ({ kind: 'virtual', name: n })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of _cardEntries) {
        if (entry.kind === 'owned') {
          _emitViewRow(entry.m);
        } else {
          _emitVirtualViewRow(entry.name, cmp);
        }
      }
      h += '</div>';
    };
    const _cardsRenderedView = new Set();
    for (const m of _sortedDomView) {
      if (_cardPlacementView.has(m.name)) continue; // rendered in a card below
      _emitViewRow(m);
      for (const cmp of _ownedCompoundsView) {
        if (m.name !== cmp.source || _cardsRenderedView.has(cmp)) continue;
        if (!_hasCardContentViewFor(cmp)) continue;
        _emitInheritedCardView(cmp);
        _cardsRenderedView.add(cmp);
      }
    }
    // Edge-case fallback (mirror of edit mode): if a compound's source merit
    // isn't in domM but the character owns it (legacy mis-categorisation or
    // test fixtures), still emit the card so target merits don't disappear.
    for (const cmp of _ownedCompoundsView) {
      if (_cardsRenderedView.has(cmp) || !_hasCardContentViewFor(cmp)) continue;
      _emitInheritedCardView(cmp);
      _cardsRenderedView.add(cmp);
    }
  }
  h += '</div></div>'; return h;
}

// oxp.7: read-only Office Merits section, mirroring status.js's own
// appendOfficeActionsLog pattern (reserve a slot synchronously, patch it from
// a separate un-awaited async function) rather than shRenderDomainMerits's
// own synchronous-because-c.merits-is-local shape — office merit dots live in
// a seat-keyed collection fetched over the API, not read off `c` directly.
let _officeMeritsGen = 0;

/**
 * oxp.7 AC1/AC3/AC6: the synchronous shell. Returns an EMPTY, invisible
 * placeholder (no `sh-sec`/title chrome at all) when this character could
 * possibly hold a real office merit suite; returns '' outright when they
 * provably cannot (no court_category, or Administrator, which has no
 * office_content entry yet — oxp.8, not app code).
 *
 * The placeholder carries NO visible content of its own specifically so
 * "renders nothing at all" (AC3) is genuinely true for the unconfirmed-seat
 * case too — that case cannot be known synchronously (seats/dots are fetched
 * async by `patchOfficeMerits`), so the section title/wrapper is never
 * written until a CONFIRMED seat with merits is actually found; an
 * unconfirmed match leaves this placeholder permanently empty rather than
 * flashing a title that then has nothing under it. AC3's literal "return ''"
 * wording is satisfied exactly by the two cases this function itself can
 * decide synchronously (no `court_category`, no `office_content` entry) — the
 * remaining AC3 cases (unconfirmed seat, failed fetch, zero-merit office)
 * are visually-equivalent-but-mechanically-different: this function still
 * returns the reserved (invisible) placeholder markup, and
 * `patchOfficeMerits` simply never fills it. Codex review, oxp.7, flagged
 * this distinction as worth spelling out explicitly rather than leaving the
 * two contracts to read as identical.
 *
 * Never editable — office-tab.js stays the one write path for
 * `office_merit_dots` (see this story's own "What this story is NOT"), so
 * unlike `shRenderDomainMerits` there is no `editMode` parameter at all.
 */
export function shRenderOfficeMerits(c) {
  if (!c || !c.court_category || !officeEntry(c.court_category)) return '';
  return '<div data-office-merits-char="' + esc(String(c._id)) + '"></div>';
}

/**
 * oxp.7 AC7: fetches seats + office merit dots, resolves this character's
 * OWN confirmed seat (never a guess — see `resolveHeldSeat`'s own doc
 * comment), and fills in every placeholder `shRenderOfficeMerits` reserved
 * for this character. `querySelectorAll` (not `getElementById`) is still
 * used for the lookup even though `suite/sheet.js`'s own `renderSheet` only
 * ever writes into ONE of its desktop/mobile-split containers per call (the
 * other is explicitly cleared, never both at once) — this is forward-safety
 * for a data-attribute-keyed slot, not evidence multiple copies are live
 * today; correcting an earlier draft of this comment that overstated it.
 *
 * Call this UN-AWAITED immediately after the innerHTML write(s) that placed
 * `shRenderOfficeMerits`'s placeholder into the DOM — mirrors
 * `status.js`'s own `appendOfficeActionsLog(slotEl)` call site exactly.
 *
 * Render-generation guard: `_officeMeritsGen` is a MODULE-scoped counter, not
 * per-element like `office-tab.js`'s own `el._officeManoeuvreGen` — there is
 * no single stable root element here (the sheet can be re-rendered for an
 * entirely different character, or the same one again, into any of several
 * containers). Bumped once per call, captured before the first `await`,
 * checked before the DOM write — a late-resolving fetch from a PREVIOUS
 * sheet view can never paint into whatever character is on screen by the
 * time it resolves. This exact failure shape (a stale async write repainting
 * the wrong view after the viewer moved on) is not hypothetical: two
 * separate prior review rounds on `office-tab.js` (oxp.3, oxp.6) found and
 * fixed real bugs in precisely this shape.
 *
 * The ENTIRE body past the guard clauses is wrapped in one try/catch, not
 * just the `Promise.all` fetch — this function is called un-awaited with no
 * `.catch()` at its call site (matching `status.js`'s own precedent), so any
 * throw anywhere past a successful fetch (a DOM API rejecting an unexpected
 * character, malformed response data) would otherwise become an unhandled
 * promise rejection rather than the same silent AC3 empty-render outcome a
 * fetch failure already produces. Codex review, oxp.7: found and closed.
 */
export async function patchOfficeMerits(c) {
  const gen = ++_officeMeritsGen;
  if (!c || !c.court_category) return;
  const data = officeEntry(c.court_category);
  if (!data) return; // Administrator — no merit suite exists yet (oxp.8)

  try {
    const [seats, dotsBySeat] = await Promise.all([
      apiGet('/api/office_seats'),
      apiGet('/api/office_merit_dots'),
    ]);
    if (gen !== _officeMeritsGen) return;

    // prax.0: the category is now passed EXPLICITLY, though it is also
    // `resolveHeldSeat`'s own default, so this call is unchanged in behaviour.
    // Stating it makes the deliberate scope boundary legible at the call site:
    // the sheet renders exactly ONE Office Merits section, for the holder's
    // HEADLINE office, even for a character who holds two seats. Their second
    // office's merit suite is already browsable in office-tab.js's category
    // picker; a second sheet section is a future story, not an oversight here.
    const seat = resolveHeldSeat(c, seats, c.court_category);
    if (!seat) return; // AC3: no confirmed seat — never guess, never disclose.

    const dots = (dotsBySeat && dotsBySeat[String(seat._id)]) || {};
    const meritNames = data.merits || [];
    if (!meritNames.length) return; // AC3: an office with no merit suite at all

    const rowsHtml = meritNames.map((merit, i) => {
      const n = Math.max(0, Math.min(meritCap(merit), dots[merit] || 0));
      return shRenderMeritRow(merit, 'office', i, '<span class="trait-dots">' + shDots(n) + '</span>');
    }).join('');

    const sectionHtml = '<div class="sh-sec"><div class="sh-sec-title">Office Merits</div>' +
      '<div class="merit-list">' + rowsHtml + '</div></div>';

    const slots = document.querySelectorAll('[data-office-merits-char="' + CSS.escape(String(c._id)) + '"]');
    slots.forEach(slot => { slot.innerHTML = sectionHtml; });
  } catch {
    return; // AC3: a failed fetch — or any later throw — renders nothing,
    // not an error message. This section has no "Could not load" state.
  }
}

// xpl.1: ST-only, edit-mode-only read view of xp_ledger rows for the open
// character. Reserve-slot-then-patch shape and module-scoped generation
// guard both follow patchOfficeMerits directly above — see that function's
// own doc comment for the reasoning (stale-view race prevention). Unlike
// patchOfficeMerits this DOES show a "could not load" state on failure: it
// is ST-facing audit tooling, not player-facing content that should stay
// invisible rather than error, so a load failure is worth surfacing.
let _xpLedgerGen = 0;

// Code-review (2026-08-15): covers Attributes/Skills/Disciplines/Merits
// only, not Blood Potency, Humanity, Willpower or the powers[] categories
// (devotions/pacts/fighting styles) - rendered directly under the full XP
// Spent breakdown, which sums all of those, so an unqualified "XP History"
// label reads as a complete account when it is not. Named explicitly rather
// than silently narrower.
const XP_LEDGER_TITLE = 'XP History (Attributes / Skills / Disciplines / Merits)';

export async function patchXpLedger(c) {
  // Code-review (2026-08-15, Low): guard BEFORE bumping the counter - the
  // original order let a no-op call (missing c/_id) cancel a real in-flight
  // fetch's generation check.
  if (!c || !c._id) return;
  const gen = ++_xpLedgerGen;
  const slotSel = '[data-xp-ledger-char="' + CSS.escape(String(c._id)) + '"]';

  try {
    const rows = await apiGet('/api/characters/' + c._id + '/xp_ledger');
    if (gen !== _xpLedgerGen) return;

    let bodyHtml;
    if (!Array.isArray(rows) || !rows.length) {
      bodyHtml = '<div class="sh-track-empty">No XP history recorded yet.</div>';
    } else {
      const rowsHtml = rows.map(r => {
        const when = r.at ? new Date(r.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        const sign = r.delta > 0 ? '+' : '';
        return '<tr><td>' + esc(when) + '</td><td>' + esc(r.category || '') + '</td><td>' + esc(r.trait_name || '') +
          '</td><td>' + esc(sign + r.delta) + ' XP</td><td>' + esc(r.reason || '') + '</td></tr>';
      }).join('');
      bodyHtml = '<table class="sh-xp-ledger-table"><tr><th>Date</th><th>Category</th><th>Trait</th><th>Δ</th><th>Reason</th></tr>' + rowsHtml + '</table>';
    }

    const sectionHtml = '<div class="sh-xp-breakdown"><div class="sh-sec-title">' + esc(XP_LEDGER_TITLE) + '</div>' + bodyHtml + '</div>';
    document.querySelectorAll(slotSel).forEach(slot => { slot.innerHTML = sectionHtml; });
  } catch {
    if (gen !== _xpLedgerGen) return;
    const failHtml = '<div class="sh-xp-breakdown"><div class="sh-sec-title">' + esc(XP_LEDGER_TITLE) + '</div><div class="sh-track-empty">Could not load XP history.</div></div>';
    document.querySelectorAll(slotSel).forEach(slot => { slot.innerHTML = failHtml; });
  }
}

export function shRenderStandingMerits(c, editMode) {
  const standM = (c.merits || []).filter(m => m.category === 'standing');
  if (!editMode && !standM.length) return '';
  let h = '<div class="sh-sec"><div class="sh-sec-title">Standing Merits</div><div class="merit-list">';
  const _standMciPool = (c.merits || []).filter(m => m.name === 'Mystery Cult Initiation' && m.active !== false).reduce((s, m) => s + mciPoolTotal(m), 0);
  const _standSorted = editMode ? standM : standM.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  _standSorted.forEach((m, si) => {
    const rIdx = c.merits.indexOf(m), dd = (m.cp || 0) + (m.free_bloodline || 0) + (m.free_pet || 0) + (m.free_mci || 0) + (m.free_vm || 0) + (m.xp || 0);
    const _stPurch = (m.cp || 0) + (m.xp || 0);
    if (m.name === 'Mystery Cult Initiation') h += _renderMCI(c, m, si, rIdx, m, dd, editMode);
    else if (m.name === 'Professional Training') h += _renderPT(c, m, si, rIdx, m, dd, editMode, _standMciPool);
    else if (editMode) {
      h += '<div class="infl-edit-row"><input type="text" class="gen-name-input" value="' + esc(m.name) + '" placeholder="Merit name" onchange="shEditStandMerit(' + si + ',\'name\',this.value)"><span class="infl-dots-derived">' + shDotsSuspendedPlain(_stPurch, Math.max(0, dd - _stPurch), shSuspendedOf(m)) + '</span></div>';
      h += meritBdRow(rIdx, m, meritFixedRating(m.name), { showMCI: _standMciPool > 0 });
      h += _prereqWarn(c, m.name);
      h += _derivedNotes(m);
      if (m.name === 'Oath of the Scapegoat' && dd > 0) {
        if (c.covenant === 'Invictus') h += '<div class="derived-note">OTS: grants +' + dd + ' Invictus Covenant Status (no normal purchase) ' + shDots(dd) + '</div>';
        h += '<div class="derived-note">OTS: +' + (dd * 2) + ' free style/merit dots (' + (c._ots_free_dots || 0) + ' pool)</div>';
      }
    }
    // TM Admin Story tm-admin.10.1b AC2 (extended): this plain-name view row
    // (any Standing merit other than MCI/PT) never routed through
    // shRenderMeritRow either \u2014 same gap as Domain's own view row above.
    // MCI/PT are excluded (N-9: m.bonus is a documented no-op for them,
    // hideBonus:true on their own meritBdRow call) \u2014 this branch is only
    // reached for the arbitrary-named Standing merits that DO read m.bonus
    // in edit mode (line 1988, no hideBonus flag).
    else { const sub = m.cult_name || m.role || '', assets = m.asset_skills && m.asset_skills.length ? m.asset_skills.join(', ') : ''; const _sSub = [sub ? esc(sub) : '', assets ? 'Asset Skills: ' + esc(assets) : ''].filter(Boolean).join(' \u00B7 '); const _standStatPath = 'merits.' + rIdx + '.bonus'; const _standAfford = applyAffordance(c, _standStatPath, m.name) + markerFor(c, _standStatPath); h += '<div class="merit-plain"><div class="trait-row"><div class="trait-main"><span class="trait-name">' + esc(m.name) + '</span>' + _standAfford + '<div class="trait-right">' + shDotsSuspended(_stPurch, Math.max(0, (m.rating || 0) - _stPurch), shSuspendedOf(m)) + '</div></div>' + (_sSub ? '<div class="trait-sub"><span class="trait-qual">' + _sSub + '</span></div>' : '') + '</div></div>'; }
  });
  if (editMode) {
    const hasMCI = standM.some(m => m.name === 'Mystery Cult Initiation');
    const hasPT = standM.some(m => m.name === 'Professional Training');
    h += '<div class="dev-add-row">';
    if (!hasMCI) h += '<button class="dev-add-btn" onclick="shAddStandMCI()">+ Add MCI</button>';
    if (!hasPT) h += '<button class="dev-add-btn" onclick="shAddStandPT()">+ Add Prof. Training</button>';
    h += '</div>';
  }
  h += '</div></div>'; return h;
}
function _renderMCI(c, m, si, rIdx, mc, dd, editMode) {
  const inactive = m.active === false, eDots = editMode ? dd : m.rating;
  const dots = ['\u25CF', '\u25CF\u25CF', '\u25CF\u25CF\u25CF', '\u25CF\u25CF\u25CF\u25CF', '\u25CF\u25CF\u25CF\u25CF\u25CF'];
  let h = '<div class="mci-block' + (inactive ? ' mci-inactive' : '') + '"><div class="mci-header"><div class="mci-title"><span class="merit-name-sh">' + esc(m.name) + '</span>';
  if (editMode) h += '<input type="text" class="stand-name-input" value="' + esc(m.cult_name || '') + '" placeholder="Cult name" onchange="shEditStandMerit(' + si + ',\'cult_name\',this.value)">';
  else if (m.cult_name) h += '<span class="trait-qual">' + esc(m.cult_name) + '</span>';
  h += '</div><div class="mci-header-right">';
  if (editMode) { h += '<button class="mci-toggle-btn" onclick="shToggleMCI(' + si + ')" title="' + (inactive ? 'Activate cult' : 'Suspend cult') + '">' + (inactive ? 'Suspended' : 'Active') + '</button>'; h += '<button class="dev-rm-btn" onclick="shRemoveStandMerit(' + si + ')" title="Remove MCI">\u00D7</button>'; }
  else if (inactive) h += '<span class="mci-toggle-btn" style="opacity:0.5">Suspended</span>';
  h += '<span class="trait-dots">' + shDots(eDots) + '</span></div></div>';
  if (editMode) {
    // N-9 (issue #762, Bug 2): standing merits (MCI/PT) don't read m.bonus,
    // so the Bonus row is no-op clutter; hideBonus suppresses it.
    h += meritBdRow(rIdx, m, meritFixedRating(m.name), { hideBonus: true }); h += _prereqWarn(c, m.name);
    const d1c = m.dot1_choice || 'merits', d3c = m.dot3_choice || 'merits', d5c = m.dot5_choice || 'merits';
    for (let d = 0; d < 5 && d < eDots; d++) {
      h += '<div class="mci-benefit-row"><span class="mci-dot-lbl">' + dots[d] + '</span><div class="mci-dot-content">';
      if (d === 0) {
        h += '<button class="mci-choice-btn' + (d1c === 'speciality' ? ' mci-choice-active' : '') + '" onclick="shEditMCIDot(' + si + ',\'dot1_choice\',\'speciality\')">Specialisation</button>';
        h += '<button class="mci-choice-btn' + (d1c === 'merits' ? ' mci-choice-active' : '') + '" onclick="shEditMCIDot(' + si + ',\'dot1_choice\',\'merits\')">1 Merit</button>';
        if (d1c === 'speciality') {
          const _spcMissing = !m.dot1_spec_skill || !m.dot1_spec;
          h += '<span class="mci-spec-pick' + (_spcMissing ? ' has-unfilled' : '') + '">';
          h += '<select class="pt-skill-sel" onchange="shEditMCIDot(' + si + ',\'dot1_spec_skill\',this.value)"><option value="">' + (m.dot1_spec_skill || '\u2014 skill \u2014') + '</option>' + ALL_SKILLS.map(sk => '<option' + (m.dot1_spec_skill === sk ? ' selected' : '') + '>' + esc(sk) + '</option>').join('') + '</select>';
          h += '<input type="text" class="stand-name-input" value="' + esc(m.dot1_spec || '') + '" placeholder="Specialisation" onchange="shEditMCIDot(' + si + ',\'dot1_spec\',this.value)">';
          h += '</span>';
        }
      } else if (d === 1) {
        h += '<span class="mci-benefit-text">1 merit dot</span>';
      } else if (d === 2) {
        h += '<button class="mci-choice-btn' + (d3c === 'skill' ? ' mci-choice-active' : '') + '" onclick="shEditMCIDot(' + si + ',\'dot3_choice\',\'skill\')">Skill Dot</button>';
        h += '<button class="mci-choice-btn' + (d3c === 'merits' ? ' mci-choice-active' : '') + '" onclick="shEditMCIDot(' + si + ',\'dot3_choice\',\'merits\')">2 Merits</button>';
        if (d3c === 'skill') {
          const _d3Missing = !m.dot3_skill;
          const _d3Skills = ALL_SKILLS.filter(sk => { const s = c.skills?.[sk]; return (s?.dots || 0) < 5; });
          h += '<span class="mci-spec-pick' + (_d3Missing ? ' has-unfilled' : '') + '"><select class="pt-skill-sel" onchange="shEditMCIDot(' + si + ',\'dot3_skill\',this.value)"><option value="">' + (m.dot3_skill || '\u2014 skill \u2014') + '</option>' + _d3Skills.map(sk => '<option' + (m.dot3_skill === sk ? ' selected' : '') + '>' + esc(sk) + '</option>').join('') + '</select></span>';
        }
      } else if (d === 3) {
        h += '<span class="mci-benefit-text">3 merit dots</span>';
      } else if (d === 4) {
        h += '<button class="mci-choice-btn' + (d5c === 'advantage' ? ' mci-choice-active' : '') + '" onclick="shEditMCIDot(' + si + ',\'dot5_choice\',\'advantage\')">Advantage</button>';
        h += '<button class="mci-choice-btn' + (d5c === 'merits' ? ' mci-choice-active' : '') + '" onclick="shEditMCIDot(' + si + ',\'dot5_choice\',\'merits\')">3 Merits</button>';
        if (d5c === 'advantage') {
          const _d5Missing = !m.dot5_text;
          h += '<span class="mci-spec-pick' + (_d5Missing ? ' has-unfilled' : '') + '"><input type="text" class="stand-name-input" value="' + esc(m.dot5_text || '') + '" placeholder="Advantage description" onchange="shEditMCIDot(' + si + ',\'dot5_text\',this.value)"></span>';
        }
      }
      h += '</div></div>';
    }
    const pool = mciPoolTotal(m);
    if (pool > 0) h += '<div class="mci-pool-row"><span class="mci-pool-lbl">Merit Pool</span><span class="mci-pool-val">' + pool + ' dot' + (pool === 1 ? '' : 's') + ' \u2014 allocate via MCI field on each merit</span></div>';
  } else if (!inactive) {
    const d1c = m.dot1_choice || 'merits', d3c = m.dot3_choice || 'merits', d5c = m.dot5_choice || 'merits';
    for (let d = 0; d < 5 && d < m.rating; d++) {
      let txt;
      if (d === 0) {
        if (d1c === 'speciality') txt = 'Spec: ' + (m.dot1_spec_skill ? esc(m.dot1_spec_skill) + (m.dot1_spec ? ' (' + esc(m.dot1_spec) + ')' : '') : '<span class="mci-unset">(unset)</span>');
        else txt = '1 merit dot';
      } else if (d === 1) {
        txt = '1 merit dot';
      } else if (d === 2) {
        if (d3c === 'skill') txt = 'Skill: ' + (m.dot3_skill ? esc(m.dot3_skill) + ' +1' : '<span class="mci-unset">(unset)</span>');
        else txt = '2 merit dots';
      } else if (d === 3) {
        txt = '3 merit dots';
      } else if (d === 4) {
        if (d5c === 'advantage') txt = 'Advantage: ' + (m.dot5_text ? esc(m.dot5_text) : '<span class="mci-unset">(unset)</span>');
        else txt = '3 merit dots';
      }
      h += '<div class="mci-benefit-row"><span class="mci-dot-lbl">' + dots[d] + '</span><span class="mci-benefit-text">' + (txt || '') + '</span></div>';
    }
  }
  h += '</div>'; return h;
}
function _renderPT(c, m, si, rIdx, mc, dd, editMode, mciPool = 0) {
  const inactive = m.active === false;
  const as = m.asset_skills || [], eDots = editMode ? dd : m.rating;
  const dots = ['\u25CF', '\u25CF\u25CF', '\u25CF\u25CF\u25CF', '\u25CF\u25CF\u25CF\u25CF', '\u25CF\u25CF\u25CF\u25CF\u25CF'];
  const _skSel = (slotIdx, label) => { const cur = as[slotIdx] || ''; return '<select class="pt-skill-sel" onchange="shEditStandAssetSkill(' + si + ',' + slotIdx + ',this.value)"><option value="">' + (cur || label) + '</option>' + ALL_SKILLS.map(sk => '<option' + (cur === sk ? ' selected' : '') + '>' + esc(sk) + '</option>').join('') + '</select>'; };
  let h = '<div class="pt-block' + (inactive ? ' mci-inactive' : '') + '"><div class="pt-header"><div class="mci-title"><span class="merit-name-sh">' + esc(m.name) + '</span>';
  if (editMode) h += '<input type="text" class="stand-name-input" value="' + esc(m.role || '') + '" placeholder="Role" onchange="shEditStandMerit(' + si + ',\'role\',this.value)">';
  else if (m.role) h += '<span class="trait-qual">' + esc(m.role) + '</span>';
  h += '</div><div class="mci-header-right">';
  if (editMode) { h += '<button class="mci-toggle-btn" onclick="shTogglePT(' + si + ')" title="' + (inactive ? 'Activate PT' : 'Suspend PT') + '">' + (inactive ? 'Suspended' : 'Active') + '</button>'; h += '<button class="dev-rm-btn" onclick="shRemoveStandMerit(' + si + ')" title="Remove PT">\u00D7</button>'; }
  else if (inactive) h += '<span class="mci-toggle-btn" style="opacity:0.5">Suspended</span>';
  h += '<span class="trait-dots">' + shDots(eDots) + '</span></div></div>';
  if (editMode) {
    // N-9 (issue #762, Bug 2): PT standing — hideBonus.
    h += meritBdRow(rIdx, m, meritFixedRating(m.name), { showMCI: mciPool > 0, hideBonus: true });
    h += _prereqWarn(c, m.name);
    h += '<div class="pt-skills-edit">';
    if (eDots >= 1) h += '<div class="mci-benefit-row"><span class="mci-dot-lbl">\u25CF</span><span class="mci-benefit-text">Networking: 2 free Contacts' + (m.role ? ' (' + esc(m.role) + ')' : '') + '</span></div>';
    if (eDots >= 2) {
      const _pt2Missing = !as[0] || !as[1];
      h += '<div class="mci-benefit-row"><span class="mci-dot-lbl">\u25CF\u25CF</span><div><span class="mci-benefit-text">Continuing Education: 9-Again on Asset Skills</span><div class="pt-skill-pick' + (_pt2Missing ? ' has-unfilled' : '') + '" style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">' + _skSel(0, '\u2014 skill 1 \u2014') + _skSel(1, '\u2014 skill 2 \u2014') + '</div></div></div>';
    }
    if (eDots >= 3) {
      const ptAssetSet3 = new Set(as.filter(Boolean));
      const _assetSp3 = Object.entries(c.skills || {}).filter(([sk]) => ptAssetSet3.has(sk)).reduce((s, [, sk]) => s + (sk.specs ? sk.specs.length : 0), 0);
      const ptFreeCov3 = Math.min(2, _assetSp3);
      const _pt3Missing = !as[2];
      h += '<div class="mci-benefit-row"><span class="mci-dot-lbl">\u25CF\u25CF\u25CF</span><div><span class="mci-benefit-text">Breadth of Knowledge: 3rd Asset Skill + 2 PT Specialisations (Asset Skills only)</span><div class="pt-skill-pick' + (_pt3Missing ? ' has-unfilled' : '') + '" style="display:flex;gap:6px;margin-top:4px;align-items:center">' + _skSel(2, '\u2014 3rd skill \u2014') + '<span style="font-size:10px;color:var(--accent)">PT specs: ' + ptFreeCov3 + ' / 2 used</span></div></div></div>';
    }
    if (eDots >= 4) {
      const dot4 = m.dot4_skill || '', validAs = as.filter(Boolean);
      // CODE REVIEW FIX (2026-08-31): this re-derived cp+xpToDots from scratch, omitting
      // so.free (same class of bug as shEditSkillPt) - read the already-correct stored
      // dots directly instead of a second, independent (and incomplete) recompute.
      const _skEffDots = sk => (c.skills || {})[sk]?.dots || 0;
      const eligibleAs = validAs.filter(sk => _skEffDots(sk) < 5);
      const _pt4Missing = !dot4 || !validAs.includes(dot4);
      h += '<div class="mci-benefit-row"><span class="mci-dot-lbl">\u25CF\u25CF\u25CF\u25CF</span><div><span class="mci-benefit-text">On the Job Training: +1 dot in an Asset Skill</span><div class="pt-skill-pick' + (_pt4Missing ? ' has-unfilled' : '') + '" style="display:flex;gap:4px;margin-top:4px"><select class="pt-skill-sel" onchange="shEditStandMerit(' + si + ',\'dot4_skill\',this.value)"><option value="">' + (dot4 || '\u2014 choose \u2014') + '</option>' + eligibleAs.map(sk => '<option' + (dot4 === sk ? ' selected' : '') + '>' + esc(sk) + '</option>').join('') + '</select></div></div></div>';
    }
    if (eDots >= 5) h += '<div class="mci-benefit-row"><span class="mci-dot-lbl">\u25CF\u25CF\u25CF\u25CF\u25CF</span><span class="mci-benefit-text">The Routine: spend 1 WP for Rote quality on any Asset Skill action. Adds +3 to roll</span></div>';
    h += '</div>';
  } else {
    if (as.filter(Boolean).length) h += '<div class="pt-assets"><span class="mci-benefit-text" style="flex-shrink:0">Asset Skills (9-Again):</span>' + as.filter(Boolean).map(s => '<span class="pt-skill-tag">' + esc(s) + '</span>').join('') + '</div>';
    const PT_BENEFITS = [
      '2 dots of Contacts',
      '2 Asset Skills',
      '3rd Asset Skill, +2 Specialisations on Asset Skills',
      '+1 dot in ' + (m.dot4_skill ? esc(m.dot4_skill) : 'an Asset Skill'),
      '1WP for Rote quality on any Asset Skill action'
    ];
    for (let d = 0; d < eDots && d < 5; d++) h += '<div class="mci-benefit-row"><span class="mci-dot-lbl">' + dots[d] + '</span><span class="mci-benefit-text">' + PT_BENEFITS[d] + '</span></div>';
  }
  h += '</div>'; return h;
}

/**
 * OATH-A (issue #1111, ADR-010 D1/D1b) — the pledge editor.
 *
 * Rendered under a Swear By oath's row in EDIT MODE only. Lists every merit
 * the character owns that has dots free to pledge, plus the ones already
 * pledged to THIS oath, each with a dot stepper. A running total against the
 * requirement makes the parity rule visible before the player commits, and
 * the Swear button re-validates server-side of the UI in `shSwearOath` — the
 * display total is a convenience, never the check.
 *
 * Returns '' for any merit that is not a Swear By oath, so the oath family is
 * the only thing that grows a pledge editor.
 */
/**
 * OATH-A (#1111) — report that the edit just made was overridden by a
 * pledge floor.
 *
 * EDIT-TIME FEEDBACK, not a status indicator. It renders only after an edit
 * has set `_pledgeFloorNote`, so a freshly loaded over-committed character
 * shows nothing — correct for an override notice, which has nothing to
 * report when no edit happened. Its absence from the read-only renderer is
 * likewise correct rather than the dual-renderer blind spot: there are no
 * edits to override there.
 *
 * A standing "this character is over-committed" indicator is a different
 * feature — render-time derived from pledges versus pool capacity, in both
 * renderers, independent of any edit. Filed as #1122.
 *
 * `_pledgeFloorNote` is transient and `_`-prefixed, so both save paths strip
 * it per merit and it never persists.
 */
function _pledgeFloorNote(m) {
  if (!m || !m._pledgeFloorNote) return '';
  return '<div class="dom-cap-warn">\u26A0 ' + esc(m._pledgeFloorNote) + '</div>';
}

function _oathPledgeEditor(c, m, rIdx) {
  if (!isSwearByOath(m)) return '';
  const required = oathDotsRequired(c, m);
  const sb = m.sworn_by || null;
  const current = sb && Array.isArray(sb.attachments) ? sb.attachments : [];
  const currentOf = (cand) => {
    const hit = current.find(a => meritMatchesRef(cand, a));
    return hit ? (hit.dots || 0) : 0;
  };

  // Candidates: anything with spare dots, plus anything already pledged here
  // (so an existing pledge can be reduced rather than only increased).
  const candidates = (c.merits || []).filter(cand => {
    if (cand === m) return false;               // an oath cannot pledge itself
    if (cand.sworn_by) return false;            // nor can another oath be pledged
    return pledgeableDots(c, cand, meritRating, m) > 0 || currentOf(cand) > 0;
  });

  const total = current.reduce((s, a) => s + (a.dots || 0), 0);
  const parityCls = total === required ? 'sc-full' : total > required ? 'sc-over' : 'sc-val';

  let h = '<div class="dom-edit-block oath-pledge-editor">';
  h += '<div class="dom-inherited-card-title">Sworn by — pledge '
     + required + ' dot' + (required === 1 ? '' : 's')
     + ' <span class="' + parityCls + '">' + total + '/' + required + '</span></div>';

  if (!candidates.length) {
    h += '<div class="dom-cap-warn">⚠ No merits with dots free to pledge.</div>';
  }

  for (const cand of candidates) {
    const label = cand.name + (cand.qualifier ? ' (' + cand.qualifier + ')' : '');
    const spare = pledgeableDots(c, cand, meritRating, m);
    const now = currentOf(cand);
    const slug = (cand.name + '-' + (cand.qualifier || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    h += '<div class="merit-bd-row"><div class="bd-grp">'
      + '<span class="bd-lbl bd-bonus-lbl" id="bd-pledge-lbl-' + slug + '">' + esc(label) + '</span>'
      + '<input id="bd-pledge-' + slug + '" name="bd-pledge-' + slug + '"'
      + ' aria-label="Dots of ' + esc(label) + ' pledged to ' + esc(m.name) + '"'
      + ' class="merit-bd-input bd-bonus-input" type="number" min="0" max="' + (spare + now) + '"'
      + ' value="' + now + '"'
      + ' onchange="shSetPledgeDots(' + rIdx + ',\'' + esc(cand.name).replace(/'/g, "\\'") + '\','
      + (cand.qualifier ? '\'' + esc(cand.qualifier).replace(/'/g, "\\'") + '\'' : 'null')
      + ',+this.value)">'
      + '</div><div class="bd-eq"><span class="bd-val">' + (spare + now) + ' free</span></div></div>';
  }

  h += '<div class="dev-add-row">'
    + '<button class="dev-add-btn" onclick="shCommitOath(' + rIdx + ')">'
    + (sb ? 'Re-swear' : 'Swear') + '</button>';
  if (sb) h += '<button class="dev-rm-btn" onclick="shReleaseOath(' + rIdx + ')" title="Release the pledge">&times;</button>';
  h += '</div>';
  if (m._oathError) h += '<div class="dom-cap-warn">⚠ ' + esc(m._oathError) + '</div>';
  h += '</div>';
  return h;
}

export function shRenderGeneralMerits(c, editMode, showOvercommitIndicator = false) {
  const oM = (c.merits || []).filter(m => m.category === 'general');
  if (!editMode && !oM.length) return '';
  const bpCP = (c.bp_creation && c.bp_creation.cp) || 0;
  const meritCPUsed = (c.merits || []).reduce((s, m) => s + (m.cp || 0), 0) + (c.fighting_styles || []).reduce((s, fs) => s + (fs.cp || 0), 0) + (c.powers || []).filter(p => p.category === 'pact').reduce((s, p) => s + (p.cp || 0), 0) + bpCP;
  const meritCPRem = 10 - meritCPUsed;
  const meritCPCls = meritCPRem < 0 ? ' over' : meritCPRem === 0 ? ' full' : '';
  let _meritAlert = meritCPRem < 0 ? 'red' : null;
  for (const _p of (c._grant_pools || []).filter(_p2 => _p2.category === 'any')) { const _u = getMCIPoolUsed(c); if (_u > _p.amount) { _meritAlert = 'red'; break; } else if (_u < _p.amount && _meritAlert !== 'red') _meritAlert = 'yellow'; }
  const _meritBadge = editMode ? _alertBadge(_meritAlert) : '';
  // -- OATH-A (issue #1111, ADR-010 D1/D2) -----------------------------
  // Encumbrance is DISPLAY + EDIT GATE with zero accessor changes: the
  // badge reports what is pledged and NOTHING here alters a dot sum. The
  // pledged dots remain fully usable.
  //
  // Computed once for the whole renderer so BOTH the edit-mode branch and
  // the view-mode branch read the same index. Wiring one and not the other
  // is the silent failure mode this codebase has hit before.
  const _pledgeIdx = buildPledgeIndex(c);
  // "This merit is pledged" - shown on the ENCUMBERED merit.
  const _pledgeBadge = (m) => {
    const e = _pledgeIdx.get(pledgeKeyFor(m));
    if (!e || !e.dots) return '';
    const by = e.oaths.map(o => o.oath + ' (' + o.dots + ')').join(', ');
    return '<span class="gen-granted-tag" title="Pledged to ' + esc(by)
      + ' - still fully usable, but cannot be sold while the oath stands">Pledged '
      + e.dots + '</span>';
  };
  // "This oath holds a pledge" - shown on the OATH row itself.
  const _oathPledgeNote = (m) => {
    const sb = m && m.sworn_by;
    if (!sb || !Array.isArray(sb.attachments) || !sb.attachments.length) return '';
    const what = sb.attachments
      .map(a => a.name + (a.qualifier ? ' (' + a.qualifier + ')' : '') + ' ' + a.dots)
      .join(', ');
    return '<span class="gen-granted-tag" title="Sworn against ' + esc(what)
      + '">Sworn ' + sb.dots_required + '</span>';
  };
  /**
   * #1122 — the STANDING over-commitment indicator: "this merit currently
   * holds fewer dots than a standing oath has pledged against it".
   *
   * RENDER-TIME DERIVED, in BOTH renderers, independent of any edit. That is
   * the whole point, and it is what makes this a different feature from
   * `_pledgeFloorNote` above rather than a second view of it:
   *
   *   - `_pledgeFloorNote` is EDIT-TIME feedback ("the change you just made
   *     was overridden"). It exists only after an edit set it, so a freshly
   *     loaded character shows nothing, correctly.
   *   - This one is derived from current state every render, so an
   *     over-commitment produced by one of the six merit-write paths that do
   *     NOT route through `_applyPledgeFloor` (#1128's finding) is visible on
   *     load, with nobody having touched the merit.
   *
   * The two are NOT mutually exclusive and must not be merged. Immediately
   * after the floor fires, `owned === pledged` (edit.js:1099-1108 raises the
   * value to exactly the floor, never past it), so this returns '' in that
   * instant. But `m._pledgeFloorNote` survives in memory until the next edit
   * on that merit or a fresh load, so a later ungated write dropping the
   * merit below its pledge legitimately renders both at once.
   *
   * TONE: warning, not error (ST ruling on #1122). The data is legal — the
   * pledge floor exists precisely so an oath's dots are never silently
   * voided, and pledging beyond a shrunk pool is a sanctioned game state.
   * So this reuses `.dom-cap-warn`/`--warn-dk`, the class `_pledgeFloorNote`
   * already renders with, and must never reach for `--err`/`.rel-error`.
   *
   * `meritRating` is deliberately the OWNED measure, not the OATH-B
   * suspension-adjusted effective one — matching `pledgeableDots`'s own
   * documented choice (ADR-010 D1b: "pledging is about what you bought") so
   * the whole pledge family reads "owned" the same way.
   *
   * Pure: sets nothing on `m`, so unlike `_pledgeFloorNote` there is nothing
   * for a save path to strip.
   *
   * ADMIN-ONLY (Angelus's ruling, Codex review, issue #1122): `shRenderGeneralMerits`
   * is shared with the player-facing Suite app (`public/js/suite/sheet.js`,
   * always view mode, `showOvercommitIndicator` omitted so it defaults false).
   * The pre-existing `_pledgeBadge`/`_oathPledgeNote` badges are fine for a
   * player to see (they already reassure "still fully usable"); THIS
   * indicator's "short against..." wording reads as a problem needing fixing,
   * which is a call for an ST, not a player. Gated on the caller-supplied
   * `showOvercommitIndicator` flag rather than on `editMode`, because Suite's
   * OWN view-mode call is indistinguishable from admin's view-mode call by
   * `editMode` alone (both pass `false`) - a genuinely separate signal is
   * needed to tell the two callers apart.
   */
  const _pledgeOvercommitNote = (m) => {
    if (!m || !showOvercommitIndicator) return '';
    const e = _pledgeIdx.get(pledgeKeyFor(m));
    if (!e || !e.dots) return '';
    const owned = meritRating(c, m) || 0;
    const short = e.dots - owned;
    if (short <= 0) return '';
    // Codex review (issue #1122, Medium, Pass 1): name each oath's OWN
    // contribution, matching _pledgeBadge's format above, rather than a bare
    // name list a reader cannot use to see which oath owes what.
    const by = e.oaths.map(o => o.oath + ' (' + o.dots + ')').join(', ');
    return '<div class="dom-cap-warn">⚠ Pledged ' + e.dots + ', pool funds ' + owned
      + ' - ' + short + ' dot' + (short === 1 ? '' : 's') + ' short against '
      + esc(by || 'a standing oath') + '.</div>';
  };
  let h = '<div class="sh-sec"><div class="sh-sec-title">Merits' + _meritBadge + '</div><div class="merit-list">';
  if (editMode) {
    const _bpXP = (c.bp_creation && c.bp_creation.xp) || 0, _bpLost = (c.bp_creation && c.bp_creation.lost) || 0;
    const _bpDerived = Math.max(0, 1 + Math.floor(bpCP / 5) + Math.floor(_bpXP / 5) - _bpLost);
    // If humanity_lost not yet set, infer it from the stored drop so Lost input matches XP
    const _humLost = c.humanity_lost !== undefined ? c.humanity_lost : Math.max(0, (c.humanity_base || 7) - (c.humanity || 0));
    const _humXP = c.humanity_xp || 0;
    const _humDerived = Math.max(0, Math.min(10, (c.humanity_base || 7) + Math.floor(_humXP / 2) - _humLost));
    h += '<div class="sh-merit-cp-row"><span class="sh-cp-remaining' + meritCPCls + '">' + meritCPUsed + ' / 10 CP</span><span class="sh-merit-cp-lbl"> creation points used</span></div>';
    h += '<div class="sh-bh-grid">'
      + '<span class="sh-bh-lbl">BP</span>'
      + '<label class="sh-bh-field"><span class="sh-bh-flbl">CP</span><input class="attr-bd-input" type="number" min="0" max="10" value="' + bpCP + '" onchange="shEditBPCreation(+this.value)"></label>'
      + '<label class="sh-bh-field"><span class="sh-bh-flbl">XP</span><input class="attr-bd-input" type="number" min="0" value="' + _bpXP + '" onchange="shEditBPXP(+this.value)"></label>'
      + '<label class="sh-bh-field"><span class="sh-bh-flbl">Lost</span><input class="attr-bd-input" type="number" min="0" value="' + _bpLost + '" onchange="shEditBPLost(+this.value)"></label>'
      + '<span class="sh-bh-total">= BP ' + _bpDerived + (_bpDerived > 2 ? ' <span class="sh-bh-alert">\u26A0 cap</span>' : '') + '</span>'
      + '<span class="sh-bh-lbl">Humanity</span>'
      + '<span class="sh-bh-field"></span>'
      + '<label class="sh-bh-field"><span class="sh-bh-flbl">XP</span><input class="attr-bd-input" type="number" min="0" value="' + _humXP + '" onchange="shEditHumanityXP(+this.value)"></label>'
      + '<label class="sh-bh-field"><span class="sh-bh-flbl">Lost</span><input class="attr-bd-input" type="number" min="0" value="' + _humLost + '" onchange="shEditHumanityLost(+this.value)"></label>'
      + '<span class="sh-bh-total">= Humanity ' + _humDerived + '</span>'
      + '</div>';
    h += _renderPoolCounters(c, 'general') + _renderPoolCounters(c, 'influence') + _renderPoolCounters(c, 'domain');
    const _genMciPool = (c.merits || []).filter(m => m.name === 'Mystery Cult Initiation' && m.active !== false).reduce((s, m) => s + mciPoolTotal(m), 0);
    // N-7 (issue #760): Collective Compound allocator wiring — membership
    // gates the stepper render; the target merit list comes off each
    // compound's rule_grant doc (NOT hardcoded — picks up future
    // pool_targets edits).
    // COLLECTIVE-2 (issue #1110): all compounds, not just the Necropolis.
    const _genCompounds = getCollectiveCompounds(getRulesCache());
    const _genOwnedCompounds = _genCompounds.filter(cmp => ownsCompound(c, cmp));
    const _genCompoundSlugs = _genCompounds.map(cmp => cmp.slug);
    const _genPoolsFor = (name) => _genOwnedCompounds.filter(cmp => cmp.targets.includes(name));
    const _KERBEROS_ASPECTS = ['Monstrous', 'Competitive', 'Seductive'];
    const _CRUAC_STYLES = ['Opening the Void', 'Primal Creation', 'Unbridled Chaos'];
    const _mdbMerit = oM.find(m => m.name === 'The Mother-Daughter Bond');
    const _mdbChosenStyle = _mdbMerit && _mdbMerit.qualifier;
    const _mdbMentorRating = (() => { const mentorM = (c.merits || []).find(m => m.category === 'influence' && m.name === 'Mentor'); if (!mentorM) return 0; return (mentorM.cp || 0) + (mentorM.free_mci || 0) + (mentorM.xp || 0); })();
    oM.forEach((m, gi) => {
      const rIdx = c.merits.indexOf(m), dd = (m.cp || 0) + (m.xp || 0) + meritFreeSum(m), isAoE = m.name?.toLowerCase() === 'area of expertise', isIS = m.name?.toLowerCase() === 'interdisciplinary specialty', isFT = m.name === 'Fucking Thief', isKerberos = m.name === 'Three Heads of Kerberos', isDC = m.name === 'Defensive Combat', isFF = m.name === 'Fighting Finesse', isMDB = m.name === 'The Mother-Daughter Bond', nSp = isAoE || isIS, cSp = Object.values(c.skills || {}).flatMap(sk => sk.specs || []);
      // Merits that accept a free-text qualifier (all others show no qualifier input unless one is already set)
      const _FREE_TEXT_QUAL = new Set(['Language','Multilingual','Library','Quick Draw','Mandragora Garden']);
      const _gPurch = (m.cp || 0) + (m.xp || 0);
      if (m.granted_by) { h += '<div class="gen-edit-row gen-granted-row"><span class="gen-granted-name">' + esc(m.name) + (m.qualifier ? ' (' + esc(m.qualifier) + ')' : '') + '</span><span class="infl-dots-derived">' + shDotsSuspendedPlain(_gPurch, Math.max(0, dd - _gPurch), shSuspendedOf(m)) + '</span><span class="gen-granted-tag" title="Granted by ' + esc(m.granted_by) + '">' + esc(m.granted_by) + '</span>' + _pledgeBadge(m) + _oathPledgeNote(m) + '</div>'; h += meritBdRow(rIdx, m, meritFixedRating(m.name), { showMCI: _genMciPool > 0, compoundPools: _genPoolsFor(m.name), compoundSlugs: _genCompoundSlugs }); h += _pledgeFloorNote(m); h += _pledgeOvercommitNote(m); h += _oathPledgeEditor(c, m, rIdx); h += _derivedNotes(m); h += _prereqWarn(c, m.name, m); }
      else {
        h += '<div class="gen-edit-row"><select class="gen-name-select" onchange="shEditGenMerit(' + gi + ',\'name\',this.value)">' + buildMeritOptions(c, m.name || '') + shFightingMeritOptions(c) + '</select>';
        if (isFT) h += '<select class="gen-qual-input" onchange="shEditGenMerit(' + gi + ',\'qualifier\',this.value)">' + buildFThiefOptions(m.qualifier || '') + '</select>';
        else if (isDC || isFF) h += '<select class="gen-qual-input" onchange="shEditGenMerit(' + gi + ',\'qualifier\',this.value)"><option value="">' + (m.qualifier || '\u2014 skill \u2014') + '</option>' + ['Brawl', 'Weaponry'].map(s => '<option' + (m.qualifier === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>';
        else if (isMDB) h += '<select class="gen-qual-input" onchange="shEditGenMerit(' + gi + ',\'qualifier\',this.value)"><option value="">' + (m.qualifier || '\u2014 Cr\u00FAac Style \u2014') + '</option>' + _CRUAC_STYLES.map(s => '<option' + (m.qualifier === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>';
        else if (isKerberos) h += '<select class="gen-qual-input" onchange="shEditGenMerit(' + gi + ',\'qualifier\',this.value)"><option value="">' + (m.qualifier || '\u2014 Aspect \u2014') + '</option>' + _KERBEROS_ASPECTS.map(a => '<option' + (m.qualifier === a ? ' selected' : '') + '>' + a + '</option>').join('') + '</select>';
        else if (nSp) {
          if (cSp.length) {
            h += '<select class="gen-qual-input" onchange="shEditGenMerit(' + gi + ',\'qualifier\',this.value)"><option value="">\u2014 spec \u2014</option>' + cSp.map(sp => '<option value="' + esc(sp) + '"' + (m.qualifier === sp ? ' selected' : '') + '>' + esc(sp) + '</option>').join('') + '</select>';
          } else {
            h += '<select class="gen-qual-input" disabled><option value="">\u2014 add a specialisation first \u2014</option></select>';
          }
        } else if (_FREE_TEXT_QUAL.has(m.name) || m.qualifier) h += '<input type="text" class="gen-qual-input" value="' + esc(m.qualifier || '') + '" placeholder="Qualifier" onchange="shEditGenMerit(' + gi + ',\'qualifier\',this.value)">';
        const _mBonus = m.bonus || 0;
        h += '<span class="infl-dots-derived">' + shDotsSuspendedPlain(_gPurch, Math.max(0, dd + _mBonus - _gPurch), shSuspendedOf(m)) + '</span>'
          + _pledgeBadge(m) + _oathPledgeNote(m)
          + '<button class="dev-rm-btn" onclick="shRemoveGenMerit(' + gi + ')" title="Remove">&times;</button></div>';
        h += meritBdRow(rIdx, m, meritFixedRating(m.name), { showMCI: _genMciPool > 0, compoundPools: _genPoolsFor(m.name), compoundSlugs: _genCompoundSlugs });
        h += _pledgeFloorNote(m);
        h += _pledgeOvercommitNote(m);
        h += _oathPledgeEditor(c, m, rIdx);
        // N-4a (issue #781): White Ants + Trap Door pickers moved to
        // shRenderDomainMerits (their merits are sub_category='domain').
        // Calls removed here — would never have fired in the general renderer
        // since both merits route to the domain branch by sub_category.
        h += _derivedNotes(m);
        h += _prereqWarn(c, m.name, m);
      }
    });
    h += '<div class="dev-add-row"><button class="dev-add-btn" onclick="shAddGenMerit()">+ Add Merit</button></div>';
  } else {
    oM.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach((m, i) => {
      const qual = m.qualifier ? ' (' + m.qualifier + ')' : '';
      const pw = _prereqWarn(c, m.name, m);
      const rIdx = c.merits.indexOf(m);
      const purch = (m.cp || 0) + (m.xp || 0), _gFree = meritFreeSum(m), bon = _gFree + (m.bonus || 0);
      // 2026-09-01 general audit (display-rendering dimension, verified):
      // same "invisible mod" gap as Domain/Influence above — m.bonus baked
      // into `bon` with no per-dot distinction. Tail of the hollow band,
      // after _gFree.
      const _ovGenBonus = c._st_mod_overlay?.[`merits.${rIdx}.bonus`];
      const _genOpts = {};
      if (_ovGenBonus) {
        const sign = _ovGenBonus.delta >= 0 ? '+' : '';
        _genOpts.hollowMod = {
          from: _gFree + _ovGenBonus.base, to: _gFree + _ovGenBonus.final,
          path: `merits.${rIdx}.bonus`,
          title: `ST adjustment: ${m.name} (bonus) ${sign}${_ovGenBonus.delta}. Click for details.`,
        };
      }
      const dotH = shDotsSuspended(purch, bon, shSuspendedOf(m), _genOpts);
      if (m.granted_by) {
        const gb = m.granted_by === 'Mystery Cult Initiation' ? 'MCI' : m.granted_by === 'Professional Training' ? 'PT' : m.granted_by;
        const grantTag = '<span class="gen-granted-tag-view" title="Granted by ' + esc(m.granted_by) + '">' + esc(gb) + '</span>';
        h += shRenderMeritRow(m.name + qual, 'gmerit', i, dotH, grantTag + _pledgeBadge(m) + _oathPledgeNote(m), c, rIdx, !!_genOpts.hollowMod);
        h += _pledgeOvercommitNote(m);
        if (pw) h += pw;
      } else { h += shRenderMeritRow(m.name + qual, 'merit', i, dotH, _pledgeBadge(m) + _oathPledgeNote(m), c, rIdx, !!_genOpts.hollowMod); h += _pledgeOvercommitNote(m); if (pw) h += pw; }
    });
  }
  h += '</div></div>'; return h;
}

/** Compute tag counts from all fighting styles (includes free_mci dots). */
function _tagCounts(c) {
  const counts = {};
  (c.fighting_styles || []).forEach(fs => {
    const dots = (fs.cp || 0) + (fs.free_mci || 0) + (fs.free_ots || 0) + (fs.xp || 0);
    const tags = STYLE_TAGS[fs.name] || [];
    tags.forEach(t => { counts[t] = (counts[t] || 0) + dots; });
  });
  return counts;
}

/** Max accessible rank for a style = max(own dots, highest relevant tag count). */
function _maxRank(c, styleName, dots) {
  const tags = STYLE_TAGS[styleName] || [];
  const tc = _tagCounts(c);
  let maxTag = 0;
  tags.forEach(t => { if ((tc[t] || 0) > maxTag) maxTag = tc[t]; });
  return Math.max(dots, maxTag);
}

// ── Prereq checking ───────────────────────────────────────────────────────────

const _ATTR_MAP = {
  'Dex': 'Dexterity', 'Dexterity': 'Dexterity',
  'Str': 'Strength', 'Strength': 'Strength',
  'Sta': 'Stamina', 'Stamina': 'Stamina',
  'Wits': 'Wits', 'Composure': 'Composure', 'Resolve': 'Resolve',
  'Manipulation': 'Manipulation', 'Intelligence': 'Intelligence', 'Presence': 'Presence'
};

const _SKILL_SET = new Set([
  'Athletics', 'Brawl', 'Drive', 'Firearms', 'Larceny', 'Stealth', 'Survival', 'Weaponry',
  'Animal Ken', 'Empathy', 'Expression', 'Intimidation', 'Persuasion', 'Socialise', 'Streetwise', 'Subterfuge',
  'Academics', 'Computer', 'Crafts', 'Investigation', 'Medicine', 'Occult', 'Politics', 'Science'
]);

const _COV_STATUS_MAP = {
  'crone': 'Circle of the Crone', 'invictus': 'Invictus',
  'sanctum': 'Ordo Dracul', 'carthian': 'Carthian Movement',
  'lancea': 'Lancea et Sanctum'
};

function _attrDots(c, fullName) {
  const obj = (c.attributes || {})[fullName];
  return obj ? (obj.dots || 0) + (obj.bonus || 0) : 0;
}

function _skillDots(c, name) {
  const obj = (c.skills || {})[name];
  return obj ? (obj.dots || 0) + (obj.bonus || 0) : 0;
}

function _checkSingleTerm(c, term) {
  term = term.trim();
  if (!term) return true;

  // Term with a trailing number: "Name N" (greedy name, last word is digit)
  const numM = term.match(/^(.+?)\s+(\d+)$/);
  if (numM) {
    const name = numM[1].trim();
    const req = parseInt(numM[2]);

    if (_ATTR_MAP[name]) return _attrDots(c, _ATTR_MAP[name]) >= req;
    if (_SKILL_SET.has(name)) return _skillDots(c, name) >= req;

    if (name.endsWith(' Status')) {
      const type = name.slice(0, -7).trim().toLowerCase();
      if (type === 'city') return ((c.status || {}).city || 0) >= req;
      if (type === 'clan') return ((c.status || {}).clan || 0) >= req;
      if (type === 'covenant') return (c.status?.covenant?.[c.covenant] || 0) >= req;
      const cov = _COV_STATUS_MAP[type];
      if (!cov) return true;
      // Unified: all covenant standings keyed by full name in status.covenant
      return (c.status?.covenant?.[cov] || 0) >= req;
    }

    if (name === 'Willpower')
      return (_attrDots(c, 'Resolve') + _attrDots(c, 'Composure')) >= req;

    // Fighting style by name
    if ((c.fighting_styles || []).some(fs => fs.name === name)) {
      return (c.fighting_styles || [])
        .filter(fs => fs.name === name)
        .reduce((s, fs) => s + (fs.cp || 0) + (fs.free_mci || 0) + (fs.xp || 0), 0) >= req;
    }

    // Discipline
    if ((c.disciplines || {})[name] !== undefined) return (c.disciplines[name]?.dots || 0) >= req;

    // Merit with rating
    return (c.merits || []).some(m => m.name === name && (m.rating || 0) >= req);
  }

  // Term with qualifier: "Name (Qualifier)"
  const qualM = term.match(/^(.+?)\s*\((.+)\)$/);
  if (qualM) {
    const name = qualM[1].trim(), qual = qualM[2].trim();
    return (c.merits || []).some(m =>
      m.name === name && (m.qualifier || '').toLowerCase() === qual.toLowerCase()
    );
  }

  // Bare term
  if (term === 'Kerberos Bloodline') return (c.bloodline || '').toLowerCase().includes('kerberos');
  if (term === 'Bonded Condition') return true; // game-world condition — optimistic
  return (c.merits || []).some(m => m.name === term) || true; // optimistic for unknowns
}

/**
 * Returns true if all prereqs in the prereqStr are met.
 * Format: "Term, Term, ...; ManoeuvrePrereq"
 * Terms may contain 'or': "Wits 3 or Fighting Finesse"
 */
function _prereqsMet(c, prereqStr) {
  if (!prereqStr) return true;
  // Structured prereq tree from rules cache — use meetsPrereq engine
  if (typeof prereqStr === 'object') return meetsPrereq(c, prereqStr);
  const [statPart, manPart] = prereqStr.split(';').map(s => s.trim());

  if (manPart) {
    const picked = new Set((c.fighting_picks || []).map(pk =>
      (typeof pk === 'string' ? pk : pk.manoeuvre).toLowerCase()
    ));
    if (!picked.has(manPart.toLowerCase())) return false;
  }

  for (const term of statPart.split(',').map(t => t.trim()).filter(Boolean)) {
    const ok = term.includes(' or ')
      ? term.split(' or ').some(t => _checkSingleTerm(c, t.trim()))
      : _checkSingleTerm(c, term);
    if (!ok) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Get all MAN_DB manoeuvres for a style, sorted by rank. */
function _styleManoeuvres(styleName) {
  const results = [];
  for (const [key, entry] of Object.entries(MAN_DB)) {
    if (entry.style === styleName) results.push({ key, ...entry });
  }
  results.sort((a, b) => parseInt(a.rank) - parseInt(b.rank));
  return results;
}

/**
 * Returns true if the character qualifies for a manoeuvre (orthodox or unorthodox).
 * Pass pre-computed tc = _tagCounts(c) for efficiency when calling in a loop.
 * Orthodox: has a type:'style' entry for man.style with dots >= man.rank.
 * Unorthodox: any shared tag total >= man.rank.
 */
function _qualifiesForManoeuvre(c, man, tc) {
  const rank = parseInt(man.rank) || 1;
  // Regular-style manoeuvres: qualify via Fighting Merit dots
  if (man.style === 'Regular') {
    const fmDots = (c.fighting_styles || [])
      .filter(fs => fs.type === 'merit' && fs.name === 'Fighting Merit')
      .reduce((s, fs) => s + (fs.cp || 0) + (fs.free_mci || 0) + (fs.free_ots || 0) + (fs.xp || 0), 0);
    return fmDots >= rank;
  }
  const styleDots = (c.fighting_styles || [])
    .filter(fs => fs.type !== 'merit' && fs.name === man.style)
    .reduce((s, fs) => s + (fs.cp || 0) + (fs.free_mci || 0) + (fs.free_ots || 0) + (fs.xp || 0), 0);
  if (styleDots >= rank) return true;
  const manTags = STYLE_TAGS[man.style] || [];
  return manTags.some(t => (tc[t] || 0) >= rank);
}

/**
 * Returns all MAN_DB manoeuvres the character qualifies for but hasn't yet picked,
 * excluding non-combat styles. Sorted by rank then name.
 */
function _availablePicks(c) {
  const picked = new Set((c.fighting_picks || []).map(pk =>
    (typeof pk === 'string' ? pk : pk.manoeuvre).toLowerCase()
  ));
  const tc = _tagCounts(c);
  const results = [];
  for (const [key, man] of Object.entries(MAN_DB)) {
    if (NON_COMBAT_STYLES.includes(man.style)) continue;
    if (picked.has(key)) continue;
    if (!_qualifiesForManoeuvre(c, man, tc)) continue;
    if (!_prereqsMet(c, man.prereq)) continue;
    results.push({ key, ...man });
  }
  results.sort((a, b) => (parseInt(a.rank) - parseInt(b.rank)) || a.name.localeCompare(b.name));
  return results;
}

/** Get all unique style names from MAN_DB, excluding Regular (handled via Fighting Merit). */
function _allStyles() {
  const s = new Set();
  for (const entry of Object.values(MAN_DB)) {
    if (entry.style !== 'Regular') s.add(entry.style);
  }
  return [...s].sort();
}

/**
 * Issue #937: extra <optgroup>s appended to the general Merit dropdown so a
 * Fighting Style is selectable as a merit (each style dot grants a manoeuvre),
 * and eligible manoeuvres can be picked from the same control. The option
 * values carry a sentinel prefix (`__style__:` / `__man__:`) so shEditGenMerit
 * routes the selection to c.fighting_styles / c.fighting_picks instead of
 * creating a c.merits row. Styles already owned, non-combat styles, and
 * manoeuvres the character doesn't yet qualify for are excluded (the latter via
 * _availablePicks, which only surfaces picks unlocked by current style dots).
 */
export function shFightingMeritOptions(c) {
  let h = '';
  const ownedStyles = new Set((c.fighting_styles || []).map(fs => fs.name));
  const styles = _allStyles().filter(s => !ownedStyles.has(s) && !NON_COMBAT_STYLES.includes(s));
  if (styles.length) {
    h += '<optgroup label="Fighting Styles">';
    styles.forEach(s => { h += '<option value="__style__:' + esc(s) + '">' + esc(s) + ' (Fighting Style)</option>'; });
    h += '</optgroup>';
  }
  const picks = _availablePicks(c);
  if (picks.length) {
    h += '<optgroup label="Manoeuvres">';
    picks.forEach(m => { h += '<option value="__man__:' + esc(m.name) + '">' + esc(m.name) + ' (' + esc(m.style) + ', rank ' + m.rank + ')</option>'; });
    h += '</optgroup>';
  }
  return h;
}

export function shRenderManoeuvres(c, editMode) {
  const styles = c.fighting_styles || [];
  const allPicks = c.fighting_picks || [];
  if (!editMode && !styles.length && !allPicks.length) return '';

  const mciPool = (c.merits || []).filter(m => m.name === 'Mystery Cult Initiation' && m.active !== false)
    .reduce((s, m) => s + mciPoolTotal(m), 0);
  const otsExtraPicks = c._ots_free_dots || 0;

  let h = '<div class="sh-sec"><div class="sh-sec-title">Manoeuvres</div>';

  if (editMode) {
    const tc = _tagCounts(c);
    const fStyles = styles.filter(fs => fs.type !== 'merit');
    const fMerits = styles.filter(fs => fs.type === 'merit');
    const totalDots = styles.reduce((s, fs) => s + (fs.cp || 0) + (fs.free_mci || 0) + (fs.free_ots || 0) + (fs.xp || 0), 0);
    const totalPicks = allPicks.length;
    const otsFreeDots = c._ots_free_dots || 0;
    const fmEntry0 = styles.find(fs => fs.type === 'merit' && fs.name === 'Fighting Merit');
    const otsUsed = (c.fighting_styles || []).reduce((s, fs) => s + (fs.free_ots || 0), 0)
                  + (fmEntry0 ? (fmEntry0.free_ots || 0) : 0);

    const maxPicks = totalDots;
    h += '<div class="sh-merit-cp-row" style="margin-bottom:6px"><span style="color:var(--txt2)">' + totalDots + ' dot' + (totalDots === 1 ? '' : 's') + ', ' + totalPicks + ' pick' + (totalPicks === 1 ? '' : 's') + '</span></div>';
    if (otsFreeDots > 0) {
      const otsCls = otsUsed > otsFreeDots ? ' sc-over' : otsUsed === otsFreeDots ? ' sc-full' : ' sc-val';
      h += '<div class="grant-pool-row"><span class="grant-pool-tag">Oath of the Scapegoat</span> free style/merit dots <span class="' + otsCls + '">' + otsUsed + '/' + otsFreeDots + '</span></div>';
    }

    // Style Points — tag totals for unorthodox access
    const tagEntries = Object.entries(tc).filter(([, v]) => v > 0);
    if (tagEntries.length) {
      h += '<div class="grant-pools">';
      h += '<div class="sh-sub-title">STYLE POINTS (unorthodox access)</div>';
      tagEntries.sort((a, b) => a[0].localeCompare(b[0])).forEach(([tag, count]) => {
        h += '<div class="grant-pool-row"><span class="grant-pool-tag">' + esc(tag) + '</span>'
          + '<span style="margin-left:6px">' + shDots(Math.min(count, 5)) + '</span>'
          + '<span class="grant-pool-rank">rank 1\u2013' + count + '</span></div>';
      });
      h += '</div>';
    }

    // ── Fighting Styles ──────────────────────────────────────
    h += '<div class="sh-sub-title">Fighting Styles</div>';
    h += '<div class="man-list">';
    fStyles.forEach(fs => {
      const si = styles.indexOf(fs);
      const dots = (fs.cp || 0) + (fs.free_mci || 0) + (fs.free_ots || 0) + (fs.xp || 0);
      const _fsPurch = (fs.cp || 0) + (fs.xp || 0);
      const _fsDerived = (fs.free_mci || 0) + (fs.free_ots || 0);
      const tags = STYLE_TAGS[fs.name] || [];
      const fsUp = fs.up || 0;

      h += '<div class="mci-block"><div class="mci-header"><div class="mci-title"><span class="merit-name-sh">' + esc(fs.name) + '</span>';
      if (tags.length) h += '<span style="font-size:9px;color:var(--txt3);margin-left:6px">' + tags.map(t => esc(t)).join(', ') + '</span>';
      h += '</div><span class="merit-dots-sh">' + '\u25CF'.repeat(_fsPurch) + '\u25CB'.repeat(_fsDerived) + '</span></div>';

      h += '<div class="merit-bd-row">'
        + '<div class="bd-grp"><span class="bd-lbl">CP</span><input class="merit-bd-input" type="number" min="0" value="' + (fs.cp || 0) + '" onchange="shEditStyle(' + si + ',\'cp\',+this.value)"></div>'
        + '<div class="bd-grp"><span class="bd-lbl">XP</span><input class="merit-bd-input" type="number" min="0" value="' + (fs.xp || 0) + '" onchange="shEditStyle(' + si + ',\'xp\',+this.value)"></div>'
        + (mciPool > 0 ? '<div class="bd-grp"><span class="bd-lbl" style="color:var(--accent)">MCI</span><input class="merit-bd-input" style="color:var(--accent)" type="number" min="0" value="' + (fs.free_mci || 0) + '" onchange="shEditStyle(' + si + ',\'free_mci\',+this.value)"></div>' : '')
        + (otsFreeDots > 0 ? '<div class="bd-grp"><span class="bd-lbl" style="color:var(--accent)">OTS</span><input class="merit-bd-input" style="color:var(--accent)" type="number" min="0" value="' + (fs.free_ots || 0) + '" onchange="shEditStyle(' + si + ',\'free_ots\',+this.value)"></div>' : '')
        + '<div class="bd-eq"><span class="bd-val">' + dots + ' dot' + (dots === 1 ? '' : 's') + '</span>'
        + (dots > 0 ? '<span style="font-size:9px;color:var(--txt3);margin-left:4px">orthodox rank 1\u2013' + dots + '</span>' : '')
        + (fsUp ? '<span class="bd-up-warn">+' + fsUp + ' unaccounted</span>' : '') + '</div></div>';
      if (fs.free_mci) h += '<div class="derived-note">MCI: +' + fs.free_mci + ' dot' + (fs.free_mci !== 1 ? 's' : '') + ' (auto) \u2014 removed if MCI drops</div>';
      if (fs.free_ots) h += '<div class="derived-note">OTS: +' + fs.free_ots + ' dot' + (fs.free_ots !== 1 ? 's' : '') + ' (auto) \u2014 removed if oath is removed</div>';

      h += '<button class="sk-spec-rm" style="float:right;margin:4px" onclick="shRemoveStyle(' + si + ')" title="Remove">&times; Remove</button>';
      h += '<div style="clear:both"></div></div>';
    });

    const existingNames = new Set(styles.map(s => s.name));
    h += '<div class="dev-add-row"><select class="dev-add-btn" style="font-size:11px" onchange="if(this.value){shAddStyle(this.value,\'style\');this.value=\'\'}">';
    h += '<option value="">+ Add Fighting Style\u2026</option>';
    _allStyles().filter(s => !existingNames.has(s) && !NON_COMBAT_STYLES.includes(s)).forEach(s => {
      h += '<option value="' + esc(s) + '">' + esc(s) + '</option>';
    });
    h += '</select></div></div>';

    // ── Fighting Merits ──────────────────────────────────────
    h += '<div class="sh-sub-title">Fighting Merits</div>';
    h += '<div class="man-list">';
    const fmEntry = fMerits.find(fs => fs.name === 'Fighting Merit');
    if (fmEntry) {
      const si = styles.indexOf(fmEntry);
      const dots = (fmEntry.cp || 0) + (fmEntry.free_mci || 0) + (fmEntry.free_ots || 0) + (fmEntry.xp || 0);
      const _fmPurch = (fmEntry.cp || 0) + (fmEntry.xp || 0);
      const _fmDerived = (fmEntry.free_mci || 0) + (fmEntry.free_ots || 0);
      const fsUp = fmEntry.up || 0;
      h += '<div class="mci-block"><div class="mci-header"><div class="mci-title"><span class="merit-name-sh">Fighting Merit</span></div>'
        + '<span class="merit-dots-sh">' + '\u25CF'.repeat(_fmPurch) + '\u25CB'.repeat(_fmDerived) + '</span></div>';
      h += '<div class="merit-bd-row">'
        + '<div class="bd-grp"><span class="bd-lbl">CP</span><input class="merit-bd-input" type="number" min="0" value="' + (fmEntry.cp || 0) + '" onchange="shEditStyle(' + si + ',\'cp\',+this.value)"></div>'
        + '<div class="bd-grp"><span class="bd-lbl">XP</span><input class="merit-bd-input" type="number" min="0" value="' + (fmEntry.xp || 0) + '" onchange="shEditStyle(' + si + ',\'xp\',+this.value)"></div>'
        + (mciPool > 0 ? '<div class="bd-grp"><span class="bd-lbl" style="color:var(--accent)">MCI</span><input class="merit-bd-input" style="color:var(--accent)" type="number" min="0" value="' + (fmEntry.free_mci || 0) + '" onchange="shEditStyle(' + si + ',\'free_mci\',+this.value)"></div>' : '')
        + (otsFreeDots > 0 ? '<div class="bd-grp"><span class="bd-lbl" style="color:var(--accent)">OTS</span><input class="merit-bd-input" style="color:var(--accent)" type="number" min="0" value="' + (fmEntry.free_ots || 0) + '" onchange="shEditStyle(' + si + ',\'free_ots\',+this.value)"></div>' : '')
        + '<div class="bd-eq"><span class="bd-val">' + dots + ' dot' + (dots === 1 ? '' : 's') + '</span>'
        + (dots > 0 ? '<span style="font-size:9px;color:var(--txt3);margin-left:4px">1 pick / dot</span>' : '')
        + (fsUp ? '<span class="bd-up-warn">+' + fsUp + ' unaccounted</span>' : '') + '</div></div>';
      if (fmEntry.free_mci) h += '<div class="derived-note">MCI: +' + fmEntry.free_mci + ' dot' + (fmEntry.free_mci !== 1 ? 's' : '') + ' (auto) \u2014 removed if MCI drops</div>';
      if (fmEntry.free_ots) h += '<div class="derived-note">OTS: +' + fmEntry.free_ots + ' dot' + (fmEntry.free_ots !== 1 ? 's' : '') + ' (auto) \u2014 removed if oath is removed</div>';
      h += '<button class="sk-spec-rm" style="float:right;margin:4px" onclick="shRemoveStyle(' + si + ')" title="Remove">&times; Remove</button>';
      h += '<div style="clear:both"></div></div>';
    } else {
      h += '<div class="dev-add-row"><button class="dev-add-btn" style="font-size:11px" onclick="shAddStyle(\'Fighting Merit\',\'merit\')">+ Add Fighting Merit</button></div>';
    }
    h += '</div>';

    // ── Picks editor ─────────────────────────────────────────
    const remaining = maxPicks - totalPicks;
    h += '<div class="sh-sub-title">Manoeuvres Picked'
      + '<span style="font-weight:normal;color:var(--txt2);margin-left:8px">' + totalPicks + ' / ' + maxPicks + '</span></div>';
    h += '<div class="man-list">';

    allPicks.forEach((pk, pi) => {
      const manName = typeof pk === 'string' ? pk : pk.manoeuvre;
      const db = MAN_DB[manName.toLowerCase()];
      const prereqOk = !db || !db.prereq || meetsPrereq(c, db.prereq);
      h += '<div class="mci-benefit-row">'
        + '<span class="mci-dot-lbl">' + (db ? '\u25CF'.repeat(parseInt(db.rank) || 1) : '\u25CF') + '</span>'
        + '<span style="flex:1;font-size:11px' + (prereqOk ? '' : ';color:var(--crim)') + '">' + esc(manName) + '</span>'
        + (db ? '<span style="font-size:9px;color:var(--txt3);margin-right:6px">' + esc(db.style) + '</span>' : '')
        + (!prereqOk ? '<span style="font-size:9px;color:var(--crim);margin-right:4px" title="' + esc(db.prereqStr || '') + '">prereq</span>' : '')
        + '<button class="sk-spec-rm" onclick="shRemovePick(' + pi + ')" title="Remove">&times;</button></div>';
    });

    if (remaining > 0) {
      const available = _availablePicks(c);
      if (available.length) {
        h += '<div style="padding:2px 0"><select class="gen-name-select" style="font-size:10px" onchange="if(this.value){shAddPick(this.value);this.value=\'\'}">';
        h += '<option value="">+ Add manoeuvre (' + remaining + ' remaining)\u2026</option>';
        available.forEach(m => {
          h += '<option value="' + esc(m.name) + '">' + esc(m.name) + ' (' + esc(m.style) + ', rank ' + m.rank + ')</option>';
        });
        h += '</select></div>';
      } else {
        h += '<div style="font-size:10px;color:var(--txt3);padding:4px 0">' + remaining + ' slot' + (remaining === 1 ? '' : 's') + ' available \u2014 no qualifying manoeuvres yet</div>';
      }
    }

    h += '</div>'; // closes man-list (picks)

  } else {
    // ── View mode ────────────────────────────────────────────
    const fStyles = styles.filter(fs => fs.type !== 'merit');
    const fMerits = styles.filter(fs => fs.type === 'merit');

    // Style Points summary
    const tc = _tagCounts(c);
    const tagEntries = Object.entries(tc).filter(([, v]) => v > 0);
    if (tagEntries.length) {
      h += '<div class="grant-pools">';
      h += '<div class="sh-sub-title">STYLE POINTS</div>';
      tagEntries.sort((a, b) => a[0].localeCompare(b[0])).forEach(([tag, count]) => {
        h += '<div class="grant-pool-row"><span class="grant-pool-tag">' + esc(tag) + '</span>'
          + '<span style="margin-left:6px">' + shDots(Math.min(count, 5)) + '</span>'
          + '<span class="grant-pool-rank">rank 1\u2013' + count + '</span></div>';
      });
      h += '</div>';
    }

    if (fStyles.length) {
      h += '<div class="sh-sub-title">FIGHTING STYLES</div>';
      h += '<div class="man-list">';
      fStyles.forEach(fs => {
        const _vPurch = (fs.cp || 0) + (fs.xp || 0), _vDerived = (fs.free_mci || 0) + (fs.free_ots || 0);
        const tags = STYLE_TAGS[fs.name] || [];
        h += '<div class="merit-plain"><div class="trait-row"><div class="trait-main"><span class="trait-name">' + esc(fs.name) + '</span><div class="trait-right">' + shDotsMixed(_vPurch, _vDerived) + '</div></div>' + (tags.length ? '<div class="trait-sub"><span class="trait-qual">' + tags.map(t => esc(t)).join(', ') + '</span></div>' : '') + '</div></div>';
      });
      h += '</div>';
    }

    if (fMerits.length) {
      h += '<div class="sh-sub-title">FIGHTING MERITS</div>';
      h += '<div class="man-list">';
      fMerits.forEach(fs => {
        const _vPurch = (fs.cp || 0) + (fs.xp || 0), _vDerived = (fs.free_mci || 0) + (fs.free_ots || 0);
        const tags = STYLE_TAGS[fs.name] || [];
        h += '<div class="merit-plain"><div class="trait-row"><div class="trait-main"><span class="trait-name">' + esc(fs.name) + '</span><div class="trait-right">' + shDotsMixed(_vPurch, _vDerived) + '</div></div>' + (tags.length ? '<div class="trait-sub"><span class="trait-qual">' + tags.map(t => esc(t)).join(', ') + '</span></div>' : '') + '</div></div>';
      });
      h += '</div>';
    }

    if (allPicks.length) {
      h += '<div class="sh-sub-title">MANOEUVRES</div>';
      h += '<div class="man-list">';
      allPicks.forEach((pk, pi) => {
        const manName = typeof pk === 'string' ? pk : pk.manoeuvre;
        const db = MAN_DB[manName.toLowerCase()];
        const prereqOk = !db || !db.prereq || meetsPrereq(c, db.prereq);
        const id2 = 'man' + pi;
        const body = db
          ? '<div class="man-exp-body"><div class="man-style">' + esc(db.style) + ' \u2014 Rank ' + esc(db.rank) + '</div><div>' + esc(db.effect || '') + '</div>' + (db.prereqStr ? '<div class="man-prereq">Prerequisite: ' + esc(db.prereqStr) + '</div>' : '') + '</div>'
          : '<div>' + esc(manName) + '</div>';
        h += '<div class="exp-row' + (prereqOk ? '' : ' merit-prereq-fail') + '" id="exp-row-' + id2 + '" onclick="toggleExp(\'' + id2 + '\')">' + '<div class="trait-row"><div class="trait-main"><span class="trait-name">' + esc(manName) + '</span><div class="trait-right"><span class="exp-arr">\u203A</span></div></div>' + (db ? '<div class="trait-sub"><span class="trait-qual">' + esc(db.style) + ' \u2014 Rank ' + db.rank + (prereqOk ? '' : ' \u2014 prereq not met') + '</span></div>' : '') + '</div></div><div class="exp-body" id="exp-body-' + id2 + '">' + body + '</div>';
      });
      h += '</div>';
    }
  }

  h += '</div>';
  return h;
}

// ── Equipment renderer (EQ-2, issue #656) ────────────────────────────────────
// Renders catalogue-ref equipment[]. All buckets flow through the same array
// as of 2026-06-19 (character.assets[] retired).
// Edit mode shows the same view -- equipment is managed via the ST CRUD API (EQ-1).
//
// EQC-1 (issue #1152, epic #1038, 2026-08-13): re-partitioned from the old
// four buckets (weapon/armour/equipment/asset) to five (combat_gear/
// skill_gear/tool_utility/narrative/container). combat_gear merges the old
// weapon+armour buckets -- the Weapons/Armour section split below is now
// driven by which stat fields are POPULATED on the item (weapon_type/
// damage_mod = weapon-shaped; armour_value/defence_penalty = armour-shaped),
// not by a bucket comparison, since both shapes now share one bucket value.
// An item with neither shape populated (an ST entry with no stats filled in
// yet) falls to "Other Combat Gear" rather than being silently dropped.
export function shRenderEquipment(c, editMode) {
  const equip  = c.equipment || [];
  if (!editMode && !equip.length) return '';

  const STATE_LABELS = { carried: 'Carried', worn: 'Worn', stashed: 'Stashed', lost: 'Lost', active: 'Active' };
  const DMGTYPE      = { lethal: 'Lethal', bashing: 'Bashing', aggravated: 'Aggravated' };
  const WPNTYPE      = { melee: 'Melee', ranged: 'Ranged', thrown: 'Thrown' };
  const cycleLabel   = n  => n === 0 ? 'Pre-campaign' : `Cycle ${n}`;
  const stateChip    = st => `<span class="gen-granted-tag-view">${STATE_LABELS[st] || st}</span>`;
  // EQC-2 (issue #1153, epic #1038): "on me" (bonus applies in game) vs
  // "owned but elsewhere" (available in downtime only) — the epic's own
  // display distinction. Rendered as a muted trait-qual fragment (this
  // renderer's existing convention for secondary info, e.g. item.notes)
  // rather than a second competing pill beside the state chip.
  // EQC-2 review patch (#1153, Codex external review Low finding): the
  // label logic itself now lives in equipmentLocationLabel
  // (equipment-derivation.js), not a local closure here, so it's directly
  // unit-testable — this alias just keeps the call sites below unchanged.
  const locationLabel = equipmentLocationLabel;
  // EQC-3 (issue #1154, epic #1038): "(in: <container name>)" for a
  // contained item. Logic lives in equipmentContainerLabel
  // (equipment-derivation.js), not a local closure here, so it's directly
  // unit-testable - this alias just keeps the call sites below unchanged.
  const containedLabel = item => equipmentContainerLabel(item, equip);

  let h = '<div class="sh-sec"><div class="sh-sec-title">Equipment</div><div class="merit-list">';

  // Group equipment items by bucket, preserving flat-array index for remove buttons
  const byBucket = { combat_gear: [], skill_gear: [], tool_utility: [], narrative: [], container: [] };
  for (let i = 0; i < equip.length; i++) {
    const item   = equip[i];
    const entry  = getCatalogueEntry(item.catalogue_id) || {};
    const bucket = (entry.bucket && byBucket[entry.bucket]) ? entry.bucket : 'skill_gear';
    byBucket[bucket].push({ item, entry, idx: i });
  }

  // combat_gear sub-split by populated stat fields, not bucket (both shapes
  // now share the combat_gear bucket). An item matching neither shape (no
  // stats filled in) still renders, under "Other Combat Gear".
  // EQC-1 review patch (#1152): use the shared predicates from
  // equipment-derivation.js rather than a locally re-derived copy, so the
  // weapon/armour discriminator can never drift out of sync between this
  // renderer and armourDefencePenalty/the roll calculators again.
  const combatWeapons = byBucket.combat_gear.filter(x => isCombatGearWeaponShaped(x.entry));
  const combatArmour  = byBucket.combat_gear.filter(x => !isCombatGearWeaponShaped(x.entry) && isCombatGearArmourShaped(x.entry));
  const combatOther   = byBucket.combat_gear.filter(x => !isCombatGearWeaponShaped(x.entry) && !isCombatGearArmourShaped(x.entry));

  // ── Weapons ──
  if (combatWeapons.length) {
    h += '<div class="sh-sub-title">Weapons</div>';
    for (const { item, entry, idx } of combatWeapons) {
      const name  = entry.name || item.catalogue_id;
      // #896: per-character effective availability (raw - Fixer reduction).
      const eff = entry.availability != null ? effectiveAvailability(entry, c) : null;
      const parts = [
        entry.damage_mod != null ? `+${entry.damage_mod}` : null,
        DMGTYPE[entry.damage_type] || entry.damage_type || null,
        WPNTYPE[entry.weapon_type] || entry.weapon_type || null,
        eff != null ? `avail ${eff}` : null,
        locationLabel(item),
        containedLabel(item),
      ].filter(Boolean);
      const qual   = parts.join(' · ');
      const rmBtn  = editMode ? `<button class="sk-spec-rm" style="float:right;margin-top:2px" onclick="shRemoveEquip(${idx})" title="Remove">× Remove</button>` : '';
      h += `<div class="merit-plain"><div class="trait-row">` +
        `<div class="trait-main"><span class="trait-name">${esc(name)}</span><div class="trait-right">${stateChip(item.state)}${rmBtn}</div></div>` +
        `<div class="trait-sub">${qual ? `<span class="trait-qual">${esc(qual)}</span>` : ''}${item.notes ? `<span class="trait-qual dim">${esc(item.notes)}</span>` : ''}</div>` +
        `</div></div>`;
    }
  }

  // ── Armour ──
  if (combatArmour.length) {
    h += '<div class="sh-sub-title">Armour</div>';
    // Issue #879 (ADR-006 D2 + Concern #8): soft non-blocking hint when
    // multiple armour items are in state==='worn'. Stacking rule is
    // worst-case (Math.max of all defence_penalties); the hint exists so
    // an ST hitting a multi-worn debug case doesn't misinterpret the math.
    // Wording locked verbatim per Concern #8 — must not drift.
    if (wornArmourCount(c) > 1) {
      h += '<div class="sh-armour-hint" style="font-size:0.85em;opacity:0.75;margin-bottom:6px;">Only one armour applies; highest defence_penalty wins.</div>';
    }
    const baseDefence = calcDefence(c);
    for (const { item, entry, idx } of combatArmour) {
      const name  = entry.name || item.catalogue_id;
      // #896: per-character effective availability (raw - Fixer reduction).
      const eff = entry.availability != null ? effectiveAvailability(entry, c) : null;
      const parts = [
        entry.armour_value    != null ? `AR ${entry.armour_value}` : null,
        entry.defence_penalty != null ? `Defence ${baseDefence}(${baseDefence - entry.defence_penalty})` : null,
        eff != null ? `avail ${eff}` : null,
        locationLabel(item),
        containedLabel(item),
      ].filter(Boolean);
      const qual  = parts.join(' · ');
      const rmBtn = editMode ? `<button class="sk-spec-rm" style="float:right;margin-top:2px" onclick="shRemoveEquip(${idx})" title="Remove">× Remove</button>` : '';
      h += `<div class="merit-plain"><div class="trait-row">` +
        `<div class="trait-main"><span class="trait-name">${esc(name)}</span><div class="trait-right">${stateChip(item.state)}${rmBtn}</div></div>` +
        (qual || item.notes ? `<div class="trait-sub">${qual ? `<span class="trait-qual">${esc(qual)}</span>` : ''}${item.notes ? `<span class="trait-qual dim">${esc(item.notes)}</span>` : ''}</div>` : '') +
        `</div></div>`;
    }
  }

  // ── Other Combat Gear (combat_gear bucket, neither weapon- nor armour-shaped
  // — e.g. an ST entry with no stat fields filled in yet) ──
  if (combatOther.length) {
    h += '<div class="sh-sub-title">Other Combat Gear</div>';
    for (const { item, entry, idx } of combatOther) {
      const name  = entry.name || item.catalogue_id;
      const eff   = entry.availability != null ? effectiveAvailability(entry, c) : null;
      const qual  = [eff != null ? `avail ${eff}` : null, locationLabel(item), containedLabel(item)].filter(Boolean).join(' · ');
      const rmBtn = editMode ? `<button class="sk-spec-rm" style="float:right;margin-top:2px" onclick="shRemoveEquip(${idx})" title="Remove">× Remove</button>` : '';
      h += `<div class="merit-plain"><div class="trait-row">` +
        `<div class="trait-main"><span class="trait-name">${esc(name)}</span><div class="trait-right">${stateChip(item.state)}${rmBtn}</div></div>` +
        (qual || item.notes ? `<div class="trait-sub">${qual ? `<span class="trait-qual">${esc(qual)}</span>` : ''}${item.notes ? `<span class="trait-qual dim">${esc(item.notes)}</span>` : ''}</div>` : '') +
        `</div></div>`;
    }
  }

  // ── Skill Gear (old "Equipment" bucket, unchanged meaning) ──
  if (byBucket.skill_gear.length) {
    h += '<div class="sh-sub-title">Skill Gear</div>';
    for (const { item, entry, idx } of byBucket.skill_gear) {
      const name  = entry.name || item.catalogue_id;
      const pool  = (entry.skill_domain && entry.bonus_dice != null)
        ? `${entry.skill_domain} +${entry.bonus_dice} dice` : '';
      // #896: per-character effective availability (raw - Fixer reduction).
      const eff = entry.availability != null ? effectiveAvailability(entry, c) : null;
      const qualParts = [
        pool || null,
        eff != null ? `avail ${eff}` : null,
        locationLabel(item),
        containedLabel(item),
      ].filter(Boolean);
      const qual = qualParts.join(' · ');
      const rmBtn = editMode ? `<button class="sk-spec-rm" style="float:right;margin-top:2px" onclick="shRemoveEquip(${idx})" title="Remove">× Remove</button>` : '';
      h += `<div class="merit-plain"><div class="trait-row">` +
        `<div class="trait-main"><span class="trait-name">${esc(name)}</span><div class="trait-right">${stateChip(item.state)}${rmBtn}</div></div>` +
        (qual || item.notes ? `<div class="trait-sub">${qual ? `<span class="trait-qual">${esc(qual)}</span>` : ''}${item.notes ? `<span class="trait-qual dim">${esc(item.notes)}</span>` : ''}</div>` : '') +
        `</div></div>`;
    }
  }

  // ── Tools / Utility (NEW bucket — "does a thing, no bonus") ──
  if (byBucket.tool_utility.length) {
    h += '<div class="sh-sub-title">Tools / Utility</div>';
    for (const { item, entry, idx } of byBucket.tool_utility) {
      const name  = entry.name || item.catalogue_id;
      const eff   = entry.availability != null ? effectiveAvailability(entry, c) : null;
      const parts = [entry.mechanical_effect || null, eff != null ? `avail ${eff}` : null, locationLabel(item), containedLabel(item)].filter(Boolean);
      const qual  = parts.join(' · ');
      const rmBtn = editMode ? `<button class="sk-spec-rm" style="float:right;margin-top:2px" onclick="shRemoveEquip(${idx})" title="Remove">× Remove</button>` : '';
      h += `<div class="merit-plain"><div class="trait-row">` +
        `<div class="trait-main"><span class="trait-name">${esc(name)}</span><div class="trait-right">${stateChip(item.state)}${rmBtn}</div></div>` +
        (qual || item.notes ? `<div class="trait-sub">${qual ? `<span class="trait-qual">${esc(qual)}</span>` : ''}${item.notes ? `<span class="trait-qual dim">${esc(item.notes)}</span>` : ''}</div>` : '') +
        `</div></div>`;
    }
  }

  // ── Narrative (NEW bucket — purely descriptive, no stat fields) ──
  if (byBucket.narrative.length) {
    h += '<div class="sh-sub-title">Narrative</div>';
    for (const { item, entry, idx } of byBucket.narrative) {
      const name  = entry.name || item.catalogue_id;
      const loc   = [locationLabel(item), containedLabel(item)].filter(Boolean).join(' · ') || null;
      const rmBtn = editMode ? `<button class="sk-spec-rm" style="float:right;margin-top:2px" onclick="shRemoveEquip(${idx})" title="Remove">× Remove</button>` : '';
      h += `<div class="merit-plain"><div class="trait-row">` +
        `<div class="trait-main"><span class="trait-name">${esc(name)}</span><div class="trait-right">${stateChip(item.state)}${rmBtn}</div></div>` +
        (entry.description ? `<div class="trait-sub"><span class="trait-qual">${esc(entry.description)}</span></div>` : '') +
        (loc || item.notes ? `<div class="trait-sub">${loc ? `<span class="trait-qual">${esc(loc)}</span>` : ''}${item.notes ? `<span class="trait-qual dim">${esc(item.notes)}</span>` : ''}</div>` : '') +
        `</div></div>`;
    }
  }

  // ── Containers (old "Assets" bucket — catalogue-backed since 2026-06-19) ──
  if (byBucket.container.length) {
    h += '<div class="sh-sub-title">Containers</div>';
    for (const { item, entry, idx } of byBucket.container) {
      const name  = entry.name || item.catalogue_id;
      const eff   = entry.availability != null ? effectiveAvailability(entry, c) : null;
      const parts = [
        entry.mechanical_effect || null,
        eff != null ? `avail ${eff}` : null,
        cycleLabel(item.acquired_cycle),
        // EQC-3 review patch (#1154, Codex external review Medium finding):
        // a container-bucket item can itself be placed inside ANOTHER
        // container (a Safe inside a Haven — the epic's own example).
        // Single-level containment forbids a container's CONTENTS from
        // themselves holding further items, but says nothing against a
        // container being contained — the write path now enforces that
        // distinction (validateEquipmentContainerRefs). This section had
        // never called containedLabel at all, so a real, stored, ST-visible
        // nesting relationship was invisible here — the only one of the
        // seven render sections missing it.
        containedLabel(item),
      ].filter(Boolean);
      const qual  = parts.join(' · ');
      const rmBtn = editMode ? `<button class="sk-spec-rm" style="float:right;margin-top:2px" onclick="shRemoveEquip(${idx})" title="Remove">× Remove</button>` : '';
      h += `<div class="merit-plain"><div class="trait-row">` +
        `<div class="trait-main"><span class="trait-name">${esc(name)}</span><div class="trait-right">${stateChip(item.state)}${rmBtn}</div></div>` +
        (entry.description ? `<div class="trait-sub"><span class="trait-qual">${esc(entry.description)}</span></div>` : '') +
        (qual || item.notes ? `<div class="trait-sub">${qual ? `<span class="trait-qual dim">${esc(qual)}</span>` : ''}${item.notes ? `<span class="trait-qual dim">${esc(item.notes)}</span>` : ''}</div>` : '') +
        `</div></div>`;
    }
  }

  // ── Edit-mode add form ──
  // 2026-06-19: single add form covers all buckets. Asset (now "container") is
  // in the bucket dropdown; the separate free-text "Add Asset" form is gone
  // along with character.assets[] — catalogue-ref is the single canonical
  // storage shape. EQC-1 (#1152, 2026-08-13): dropdown values updated to the
  // new five-bucket taxonomy; labels use BUCKET_LABELS rather than a bare
  // capitalise (combat_gear/skill_gear/tool_utility need real spacing).
  if (editMode) {
    const STATES   = ['carried', 'worn', 'stashed', 'active', 'lost'];
    const BUCKETS  = ['combat_gear', 'skill_gear', 'tool_utility', 'narrative', 'container'];
    const BUCKET_LABELS = {
      combat_gear: 'Combat Gear', skill_gear: 'Skill Gear', tool_utility: 'Tools / Utility',
      narrative: 'Narrative', container: 'Container',
    };
    const defCycle = state.activeCycleNum ?? 0;

    h += '<div class="sh-sub-title" style="margin-top:10px">Add Equipment Item</div>';
    // EQC-3 (issue #1154, epic #1038): "Place inside" — sourced from the
    // character's OWN current container-bucket rows (byBucket.container,
    // already computed above for the Containers section). Default is no
    // selection (loose item, unchanged behaviour). Not offered at all if the
    // character owns no containers yet — an empty-but-present dropdown with
    // only "— none —" would be a confusing no-op affordance.
    const containerOptions = byBucket.container.map(({ item: ci, entry: ce }) =>
      `<option value="${esc(ci.catalogue_id)}">${esc(ce.name || ci.catalogue_id)}</option>`
    ).join('');

    h += '<div class="dev-add-row" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;padding:4px 0">'
      + '<select id="eq-add-bucket" class="dev-add-btn" onchange="shEquipBucketFilter()">'
      + '<option value="">Bucket…</option>'
      + BUCKETS.map(b => `<option value="${b}">${BUCKET_LABELS[b]}</option>`).join('')
      + '</select>'
      + '<select id="eq-add-item" class="dev-add-btn"><option value="">-- select bucket first --</option></select>'
      + '<select id="eq-add-state" class="dev-add-btn">'
      + STATES.map(s => `<option value="${s}">${STATE_LABELS[s] || s}</option>`).join('')
      + '</select>'
      + (containerOptions
          ? '<select id="eq-add-container" class="dev-add-btn" title="Place inside a container you already own">'
            + '<option value="">— none —</option>' + containerOptions + '</select>'
          : '')
      + `<input id="eq-add-cycle" type="number" min="0" value="${defCycle}" style="width:60px" class="attr-bd-input" title="Acquired cycle">`
      + '<input id="eq-add-notes" type="text" placeholder="Notes (optional)" style="width:130px" class="spec-input">'
      + '<button class="sk-spec-add" onclick="shAddEquip()">Add</button>'
      + '</div>';
  }

  h += '</div></div>';
  return h;
}

export function shRenderMeritRow(m, idPrefix, i, dotHtml, chipHtml, c, realIdx, bonusMarkedOnDot) {
  // Name parser: greedy prefix + final-paren-group capture that disallows
  // nested parens. Handles variant merit names that already contain parens
  // (e.g. "Attaché (Resources) (Nicole)") — splits to main "Attaché (Resources)"
  // + sub "Nicole" instead of leaving a stray ')' in the subtitle.
  const b2 = meritBase(m), dc = meritDotCount(m), ds = dc ? shDots(dc) : '', pm = b2.match(/^(.+?)\s*\(([^()]+)\)$/), mn = pm ? pm[1].trim() : b2, sn = pm ? pm[2].trim() : null;
  const db = meritLookup(m), dt = dotHtml !== undefined ? dotHtml : (ds ? '<span class="trait-dots">' + ds + '</span>' : '');
  // TM Admin Story tm-admin.10.1b AC2: audited apply-bonus affordance,
  // reused verbatim from the attribute/skill channel (STM-14). Only
  // rendered when the caller supplies BOTH `c` and a real integer index
  // into `c.merits` \u2014 i.e. this row represents exactly one live merit
  // instance with its own `bonus` field. Callers that pass a synthesised
  // display row spanning multiple instances (Contacts, aggregated across
  // every Contacts entry) or no live c.merits backing at all (Office
  // Merits, sourced from a seat-keyed API collection, not `c.merits`)
  // intentionally omit `c`/`realIdx` and get no affordance \u2014 matching the
  // real per-instance scope AC2 asks for, not a blanket addition.
  const _statPath = (c && Number.isInteger(realIdx)) ? `merits.${realIdx}.bonus` : null;
  // 2026-09-01 general audit: suppress the redundant standalone markerFor()
  // pip when the caller's own dotHtml already marks the modded dot in
  // place (bonusMarkedOnDot) — matches the same suppression in the Domain
  // merit view row above. applyAffordance stays either way (it's the
  // "+ apply a new bonus" control, unrelated to marking an existing one).
  const _afford = _statPath ? applyAffordance(c, _statPath, mn) + (bonusMarkedOnDot ? '' : markerFor(c, _statPath)) : '';
  const _inner = (hasArr) => '<div class="trait-row"><div class="trait-main"><span class="trait-name">' + esc(mn) + '</span>' + _afford + '<div class="trait-right">' + (dt || '') + '<span class="exp-arr' + (hasArr ? '' : ' trait-arr-hidden') + '">\u203A</span></div></div>' + ((sn || chipHtml) ? '<div class="trait-sub">' + (chipHtml || '') + (sn ? '<span class="trait-qual">' + esc(sn) + '</span>' : '') + '</div>' : '') + '</div>';
  if (db && db.desc) {
    const id2 = idPrefix + i, pqStr = db.prereq ? prereqLabel(db.prereq) : '', body = '<div>' + esc(db.desc) + '</div>' + (pqStr ? '<div style="margin-top:5px;font-style:italic;color:var(--txt3)">Prerequisite: ' + esc(pqStr) + '</div>' : '');
    // Issue #994: "Full rules" expander from the merit's rules doc (meritLookup
    // carries the full rule via db._rule). Reused by both the editor sheet and
    // the suite sheet (shRenderInfluenceMerits/shRenderGeneralMerits etc. delegate here).
    const _ruleDoc = db._rule || null;
    const rulesExp = _ruleDoc && _ruleDoc.rules_text ? renderRulesExpander('rte-' + id2, _ruleDoc.rules_text, _ruleDoc.rules_source) : '';
    return '<div class="exp-row" id="exp-row-' + id2 + '" onclick="toggleExp(\'' + id2 + '\')">' + _inner(true) + '</div><div class="exp-body" id="exp-body-' + id2 + '">' + body + rulesExp + '</div>';
  }
  return '<div class="merit-plain">' + _inner(false) + '</div>';
}

/**
 * N-4 (MNEC, issue #696) — White Ants Territory picker block.
 *
 * Renders one `<select>` per dot of effective rating, each populated from the
 * live territories store (`getStoredTerritories()`). Empty slots show a
 * "Pick a Territory" warning; duplicate selections within the same merit show
 * a duplicate warning. Returns '' for any non-White-Ants merit.
 *
 * The handler `shSetWhiteAntsTerritory(realIdx, dotIdx, value)` lives in
 * edit-domain.js and is exposed on `window` by admin.js / app.js — see N-1's
 * delegated-routing memory for why these inline-onchange handlers are safe
 * when the global is reliably bound at module-load time.
 */
function _whiteAntsTerritoriesBlock(m, realIdx) {
  if (!m || m.name !== 'White Ants') return '';
  // Effective rating mirrors the meritFreeSum sum: cp + xp + sum(free_grants) + sum(legacy free_<slug>).
  const fg = m.free_grants || {};
  const fromMap = Object.values(fg).reduce((s, n) => s + (n || 0), 0);
  const legacy = (m.free_attache || 0) + (m.free_bloodline || 0) + (m.free_carthian || 0)
    + (m.free_fwb || 0) + (m.free_inv || 0) + (m.free_lk || 0) + (m.free_mci || 0)
    + (m.free_mdb || 0) + (m.free_ohm || 0) + (m.free_pet || 0) + (m.free_pt || 0)
    + (m.free_retainer || 0) + (m.free_sw || 0) + (m.free_vm || 0);
  const rating = (m.cp || 0) + (m.xp || 0) + fromMap + legacy;
  if (rating <= 0) return '';

  const territories = getStoredTerritories();
  const picked = Array.isArray(m.territories) ? m.territories : [];

  // Empty store → placeholder only. The admin/suite apps load territories at
  // boot via setStatusTerritories, so this branch is mostly a defensive
  // fallback for a render that fires before the boot fetch resolves.
  if (!territories || territories.length === 0) {
    return '<div class="wa-picker-block"><label class="wa-picker-lbl">White Ants &mdash; Territories:</label><p class="wa-picker-empty">Loading territories…</p></div>';
  }

  // Pre-build option markup once; per-row mark which one is "selected".
  const optsBare = '<option value="">(pick a Territory)</option>'
    + territories.map(t => {
      const slug = (t && t.slug) || '';
      if (!slug) return '';
      return `<option value="${esc(slug)}">${esc(t.name || slug)}</option>`;
    }).join('');

  let h = '<div class="wa-picker-block"><label class="wa-picker-lbl">White Ants &mdash; Territories the Necropolis has infected:</label>';
  for (let i = 0; i < rating; i++) {
    const current = picked[i] || '';
    // Duplicate detection: this slug also appears at some other index in the same array.
    const isDup = !!current && picked.some((s, j) => s === current && j !== i);
    // Re-emit options with `selected` on the current pick.
    const opts = current
      ? optsBare.replace(`<option value="${esc(current)}">`, `<option value="${esc(current)}" selected>`)
      : optsBare.replace('<option value="">', '<option value="" selected>');
    const rowCls = !current ? 'wa-picker-row wa-picker-row--empty' : (isDup ? 'wa-picker-row wa-picker-row--dup' : 'wa-picker-row');
    h += `<div class="${rowCls}">`
      + `<span class="wa-picker-dot">${i + 1}.</span>`
      + `<select class="wa-picker-sel" onchange="shSetWhiteAntsTerritory(${realIdx}, ${i}, this.value)">${opts}</select>`;
    if (!current) h += '<span class="wa-picker-warn">Pick a Territory</span>';
    else if (isDup) h += '<span class="wa-picker-warn">Duplicate</span>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}

/**
 * N-5 (MNEC, issue #697) — Trap Door triple-anchor picker block.
 *
 * Renders three controls:
 *   • Origin       — read-only "Necropolis Sepulcher" label. Always locked;
 *                    the merit's purchase prereq guarantees the character
 *                    owns Sepulcher, so origin is invariant per character.
 *   • Destination  — single-select from the character's existing Safe Place
 *                    merit instances (uses `domKey` as the value, mirroring
 *                    Haven's existing attached_to UX).
 *   • Territory    — single-select FILTERED to currently-infected Territories
 *                    (per Khepri 2026-06-11: filter at pick-time, prevents
 *                    invalid selection upfront; if the union shrinks later
 *                    and the picked slug drops out, the render-time validator
 *                    flags it).
 *
 * Shows the persisted-not-removed warning when `validateTrapDoorAnchor`
 * reports invalid. The merit stays in the merit list; only this block
 * renders the non-functional state.
 */
function _trapDoorAnchorBlock(c, m, realIdx) {
  if (!m || m.name !== 'Trap Door') return '';
  const at = normaliseAttachedTo(m.attached_to);
  const raw = (m.attached_to && typeof m.attached_to === 'object' && !Array.isArray(m.attached_to))
    ? m.attached_to
    : {};
  const dest = (raw.destination || (at && at.destination) || '');
  const terr = raw.territory || '';

  // Destination options: character's existing Safe Place merits.
  const _spInstances = (c.merits || []).filter(sp => sp.category === 'domain' && sp.name === 'Safe Place');
  const destOpts = ['<option value="">(pick a Safe Place)</option>']
    .concat(_spInstances.map(sp => {
      const k = domKey(sp);
      return `<option value="${esc(k)}"${k === dest ? ' selected' : ''}>${esc(k)}</option>`;
    }))
    .join('');

  // Territory options: only currently-infected Territories. Map to live names
  // via `getStoredTerritories()` for display; value is the slug. If the picked
  // slug is no longer in the union (post-shrink edge), keep it as an option
  // with a "(no longer covered)" suffix so the user can see what was set.
  const infected = getNecropolisInfectedTerritories(state.chars || []);
  const allTerritories = getStoredTerritories() || [];
  const tName = (slug) => {
    const t = allTerritories.find(x => x && x.slug === slug);
    return (t && (t.name || t.slug)) || slug;
  };
  let terrOpts = '<option value="">(pick a Territory)</option>';
  for (const slug of infected) {
    terrOpts += `<option value="${esc(slug)}"${slug === terr ? ' selected' : ''}>${esc(tName(slug))}</option>`;
  }
  if (terr && !infected.includes(terr)) {
    terrOpts += `<option value="${esc(terr)}" selected>${esc(tName(terr))} (no longer covered)</option>`;
  }
  const noInfected = infected.length === 0;

  // Render-time validation drives the non-functional indicator.
  const v = validateTrapDoorAnchor(c, m, state.chars || []);

  let h = '<div class="td-anchor-block">';
  if (!v.valid) {
    h += `<div class="td-anchor-warn">&#9888; Non-functional: ${esc(v.reason || 'anchor incomplete')}</div>`;
  }
  h += '<div class="td-anchor-row">'
    + '<span class="td-anchor-lbl">Origin</span>'
    + '<span class="td-anchor-locked">Necropolis Sepulcher</span>'
    + '</div>';
  h += '<div class="td-anchor-row">'
    + '<span class="td-anchor-lbl">Destination</span>'
    + `<select class="td-anchor-sel" onchange="shSetTrapDoorAnchor(${realIdx}, 'destination', this.value)">${destOpts}</select>`
    + '</div>';
  h += '<div class="td-anchor-row">'
    + '<span class="td-anchor-lbl">Territory</span>'
    + (noInfected
        ? '<span class="td-anchor-empty">No Necropolis Territories yet &mdash; add a White Ants pick on any Sepulcher owner.</span>'
        : `<select class="td-anchor-sel" onchange="shSetTrapDoorAnchor(${realIdx}, 'territory', this.value)">${terrOpts}</select>`)
    + '</div>';
  h += '</div>';
  return h;
}

/* ── renderSheet orchestrator ── */

export function renderSheet(c, target = null) {
  _refreshLegacyDBs();
  // STM (#1040): expose the rendered character for the st-mod popover's
  // _resolveActiveCharacter fallback. The admin/editor sheet reads chars/editIdx
  // from `state` (not window), so without this the popover no-ops on a fresh
  // admin session. Mirrors suite/sheet.js and player.js.
  window.__activeChar = c || null;
  const { editMode, chars, editIdx } = state;
  state.openExpId = null;
  const el = target || document.getElementById('sh-content');
  if (!c) { el.innerHTML = ''; return; }
  applyDerivedMerits(c, chars); ensureMeritSync(c);
  const bl = c.bloodline && c.bloodline !== '\u00AC' ? c.bloodline : '', st = c.status || {}, wp = getWillpower(c);
  const clanIconHtml = clanIcon(c.clan, 48), covIconHtml = covIcon(c.covenant, 48);
  const allB = c.banes || [], curseIdx = allB.findIndex(b => b.name.toLowerCase().includes('curse')), curse = curseIdx >= 0 ? allB[curseIdx] : null, regB = allB.filter((_, i) => i !== curseIdx);
  let h = '';
  // Desktop layout hint — admin CSS uses this for 2-col grid
  const isDesktop = el.closest('.cd-sheet');
  if (isDesktop) h += '<div class="sh-desktop' + (editMode ? ' sh-editing' : '') + '"><div class="sh-dcol sh-dcol-left">';
  // Header
  const _rd = editMode && isRedactMode();
  h += '<div class="sh-char-hdr"><div class="sh-namerow"><div class="sh-char-name">' + (editMode ? (_rd ? '<input class="sh-edit-input redact-input" value="' + esc(redactCharName(c.name)) + '" disabled>' : '<input class="sh-edit-input" value="' + esc(c.name) + '" onchange="shEdit(\'name\',this.value);document.getElementById(\'edit-charname\').textContent=this.value">') : esc(cardName(c))) + '</div>' + _auditBadge(c);
  if (editMode) {
    if (_rd) {
      h += '<div style="display:flex;gap:8px;margin-top:2px"><div style="flex:1"><input class="sh-edit-input redact-input" value="' + esc(redactCharName(c.honorific || '')) + '" disabled style="font-size:12px"></div><div style="flex:1"><input class="sh-edit-input redact-input" value="' + esc(redactCharName(c.moniker || '')) + '" disabled style="font-size:12px"></div></div>';
    } else {
      h += '<div style="display:flex;gap:8px;margin-top:2px"><div style="flex:1"><input class="sh-edit-input" value="' + esc(c.honorific || '') + '" onchange="shEdit(\'honorific\',this.value||null)" placeholder="Honorific (e.g. Lord, Lady)" style="font-size:12px"></div><div style="flex:1"><input class="sh-edit-input" value="' + esc(c.moniker || '') + '" onchange="shEdit(\'moniker\',this.value||null)" placeholder="Moniker (overrides display name)" style="font-size:12px"></div></div>';
    }
  }
  h += '<div class="sh-player-row"><span class="sh-char-player">' + (editMode ? (_rd ? '<input class="sh-edit-input redact-input" value="' + esc(redactPlayer(c.player || '')) + '" disabled placeholder="Player">' : '<input class="sh-edit-input" value="' + esc(c.player || '') + '" onchange="shEdit(\'player\',this.value)" placeholder="Player">') : esc(redactPlayer(c.player || ''))) + '</span><span class="sh-xp-badge' + (xpLeft(c) < 0 ? ' xp-over' : xpLeft(c) > 0 ? ' xp-under' : '') + '">XP ' + xpLeft(c) + '/' + xpEarned(c) + '</span></div></div>';
  if (editMode) {
    const eT = xpEarned(c), sT = xpSpent(c);
    const _pt5 = xpPT5(c);
    h += '<div class="sh-xp-breakdown"><table><tr><th colspan="2">XP Earned</th><th colspan="2">XP Spent</th></tr><tr><td>Starting</td><td>' + xpStarting(c) + '</td><td>Attributes</td><td>' + xpSpentAttrs(c) + '</td></tr><tr><td>Humanity Drop</td><td>' + xpHumanityDrop(c) + '</td><td>Skills + Specs</td><td>' + xpSpentSkills(c) + '</td></tr><tr><td>Ordeals</td><td>' + xpOrdeals(c) + '</td><td>Merits</td><td>' + xpSpentMerits(c) + '</td></tr><tr><td>Game</td><td>' + xpGame(c) + '</td><td>Powers</td><td>' + xpSpentPowers(c) + '</td></tr>' + (_pt5 ? '<tr><td>PT \u25cf\u25cf\u25cf\u25cf\u25cf</td><td>' + _pt5 + '</td>' : '<tr><td></td><td></td>') + '<td>Special</td><td>' + xpSpentSpecial(c) + '</td></tr><tr class="xp-total-row"><td>Total Earned</td><td>' + eT + '</td><td>Total Spent</td><td>' + sT + '</td></tr><tr class="xp-total-row"><td colspan="3" style="text-align:right;padding-right:8px">Available</td><td>' + (eT - sT) + '</td></tr></table></div>';
    // xpl.1: reserved slot, filled async by patchXpLedger (mirrors
    // shRenderOfficeMerits/patchOfficeMerits's reserve-then-patch pattern).
    h += '<div data-xp-ledger-char="' + esc(String(c._id)) + '"></div>';
    const ords = c.ordeals || []; if (ords.length) { h += '<div class="sh-ordeals">'; ords.forEach(o => { h += '<span class="sh-ordeal' + (o.complete ? ' done' : '') + '"><span class="sh-ordeal-dot">' + (o.complete ? '\u25CF' : '\u25CB') + '</span><span class="sh-ordeal-label">' + esc(o.name) + '</span></span>'; }); h += '</div>'; }
  }
  h += '<div class="sh-char-body"><div class="sh-char-left">';
  if (editMode) {
    h += '<div class="sh-char-concept"><input class="sh-edit-input" value="' + esc(c.concept || '') + '" onchange="shEdit(\'concept\',this.value)" placeholder="Concept"></div>';
    h += '<div class="sh-char-concept"><input class="sh-edit-input" value="' + esc(c.pronouns || '') + '" onchange="shEdit(\'pronouns\',this.value)" placeholder="Pronouns"></div>';
  } else if (c.concept || c.pronouns) {
    h += '<div class="sh-concept-row"><span class="sh-char-concept">' + esc(c.concept || '') + '</span><span class="sh-char-pronoun">' + esc(c.pronouns || '') + '</span></div>';
  }
  if (editMode) { h += '<div class="exp-row"><span class="exp-lbl labeled">Mask</span><select class="sh-edit-select" style="flex:1;margin:0 6px" onchange="shEdit(\'mask\',this.value)"><option value="">(none)</option>' + MASKS_DIRGES.map(m2 => '<option' + (c.mask === m2 ? ' selected' : '') + '>' + esc(m2) + '</option>').join('') + '</select></div>'; }
  else if (c.mask) { h += expRow('mask', 'Mask', esc(c.mask), (wp.mask_1wp ? '<div><span class="exp-wp-lbl">1 WP</span> ' + esc(wp.mask_1wp) + '</div>' : '') + (wp.mask_all ? '<div style="margin-top:5px"><span class="exp-wp-lbl">All WP</span> ' + esc(wp.mask_all) + '</div>' : '')); }
  if (editMode) { h += '<div class="exp-row"><span class="exp-lbl labeled">Dirge</span><select class="sh-edit-select" style="flex:1;margin:0 6px" onchange="shEdit(\'dirge\',this.value)"><option value="">(none)</option>' + MASKS_DIRGES.map(m2 => '<option' + (c.dirge === m2 ? ' selected' : '') + '>' + esc(m2) + '</option>').join('') + '</select></div>'; }
  else if (c.dirge) { h += expRow('dirge', 'Dirge', esc(c.dirge), (wp.dirge_1wp ? '<div><span class="exp-wp-lbl">1 WP</span> ' + esc(wp.dirge_1wp) + '</div>' : '') + (wp.dirge_all ? '<div style="margin-top:5px"><span class="exp-wp-lbl">All WP</span> ' + esc(wp.dirge_all) + '</div>' : '')); }
  if (curse) h += expRow('curse', 'Curse', esc(curse.name), '<div>' + esc(curse.effect || '') + '</div>');
  if (editMode) { regB.forEach((b, bi) => { const ri = allB.indexOf(b); h += '<div class="exp-row" style="flex-direction:column;align-items:stretch;padding:8px 10px"><div class="sh-bane-edit-row"><span class="exp-lbl" style="min-width:36px">Bane</span><select class="sh-edit-select" style="flex:1" onchange="shEditBaneName(' + ri + ',this.value)"><option value="">(select)</option>' + BANE_LIST.map(bn => '<option' + (b.name === bn ? ' selected' : '') + '>' + esc(bn) + '</option>').join('') + '</select><button class="sh-bane-rm" onclick="shRemoveBane(' + ri + ')" title="Remove">&times;</button></div><input class="sh-edit-input" value="' + esc(b.effect || '') + '" onchange="shEditBaneEffect(' + ri + ',this.value)" placeholder="Effect text" style="margin-top:4px;font-size:11px"></div>'; }); h += '<button class="sh-bane-add" onclick="shAddBane()">+ Add Bane</button>'; }
  else regB.forEach((b, i) => { h += expRow('bane' + i, 'Bane', esc(b.name), '<div>' + esc(b.effect || '') + '</div>'); });
  // Touchstones - NPCR.4, free-text only (DBO-8).
  h += renderTouchstones(c, editMode);
  // Date of Embrace + Apparent Age
  if (editMode || c.date_of_embrace) { const _ded = c.date_of_embrace || ''; const _dedDisp = _ded ? new Date(_ded + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''; h += '<div class="exp-row"><span class="exp-lbl labeled">Embrace</span>' + (editMode ? '<input type="date" class="sh-edit-input" value="' + esc(_ded) + '" onchange="shEdit(\'date_of_embrace\',this.value)">' : '<span class="exp-val">' + esc(_dedDisp) + '</span>') + '</div>'; }
  if (editMode || c.apparent_age) h += '<div class="exp-row"><span class="exp-lbl labeled">App. Age</span>' + (editMode ? '<input class="sh-edit-input" value="' + esc(c.apparent_age || '') + '" onchange="shEdit(\'apparent_age\',this.value)" placeholder="Apparent Age">' : '<span class="exp-val">' + esc(c.apparent_age) + '</span>') + '</div>';
  // Features: auto-detected stats + manual notes — single card
  const _autoFeat = derivedFeatures(c);
  if (editMode || _autoFeat.length || c.features) {
    h += '<div class="sh-features-card">';
    h += '<div class="sh-features-top"><span class="exp-lbl labeled">Features</span><span class="exp-val sh-features-auto">' + (_autoFeat.length ? _autoFeat.join(', ') : '<span class="sh-feat-none">None detected</span>') + '</span></div>';
    if (editMode) {
      h += '<div class="sh-features-top"><span class="exp-lbl labeled"></span><input class="sh-edit-input" style="flex:1" value="' + esc(c.features || '') + '" onchange="shEdit(\'features\',this.value)" placeholder="Additional features\u2026"></div>';
    } else if (c.features) {
      h += '<div class="sh-features-top"><span class="exp-lbl labeled"></span><span class="exp-val">' + esc(c.features) + '</span></div>';
    }
    h += '</div>';
  }
  h += '</div>'; // end left
  // Right panel
  h += '<div class="sh-hdr-right">';
  const tOpts = COURT_TITLES.map(t => '<option value="' + esc(t) + '"' + (c.court_category === t ? ' selected' : '') + '>' + esc(t || '(none)') + '</option>').join('');
  // Regent territory is derived from territories collection, not stored on character.
  // Resolved fresh per-render via the accessors module-level store
  // (issue #13 Surface 2 — drop the c._regentTerritory cache).
  const _regTerr = getRegentTerritoryFor(c);
  const _regTerrName = _regTerr?.territory || null;
  const _courtLabel = c.court_category ? (c.court_title ? c.court_category + ' \u2014 ' + c.court_title : c.court_category) : '\u2014';
  h += '<div class="sh-hdr-row"><div class="sh-icon-slot"></div><div class="sh-faction-text">';
  if (editMode) { h += '<select class="sh-edit-select" onchange="shEdit(\'court_category\',this.value||null)">' + tOpts + '</select>'; if (_regTerrName) h += '<div style="margin-top:3px;font-size:10px;color:var(--accent)">Regent \u2014 ' + esc(_regTerrName) + '</div>'; }
  else { h += '<div class="sh-faction-label">' + esc(_courtLabel) + '</div>'; if (_regTerrName) h += '<div class="sh-faction-bloodline">Regent \u2014 ' + esc(_regTerrName) + '</div>'; }
  const cityBase = st.city || 0, titleBonus = titleStatusBonus(c), regentBonus = regentAmienceBonus(c), cityTotal = Math.min(cityBase + titleBonus + regentBonus, 10);
  h += '<div class="sh-faction-sub">Title</div>'
    + _statusDots(cityBase, titleBonus + regentBonus, 10)
    + (editMode ? _statusEditBtns('shStatusDown(\'city\')', 'shStatusUp(\'city\')') : '');
  // Derived notes mirror the Attaché pattern at sheet.js:830 — surface the
  // bonus origin so the user can see *why* their City Status is what it is.
  if (titleBonus > 0) {
    h += '<div class="derived-note">Title: +' + titleBonus + ' dot' + (titleBonus !== 1 ? 's' : '') + ' (' + esc(c.court_category || '') + ')</div>';
  }
  if (regentBonus > 0) {
    const _regAmb = _regTerr?.ambience || '';
    h += '<div class="derived-note">Regency: +' + regentBonus + ' dot' + (regentBonus !== 1 ? 's' : '') + ' from ' + esc(_regTerrName || '') + ' (' + esc(_regAmb) + ')</div>';
  }
  h += '</div>' + _statusPip(CITY_SVG, cityTotal, 'City') + '</div>';
  // covRow: dots + arrows live in the text column; pip is just diamond + number + label
  const covRow = (iconHtml, editH, viewH, sub, svg, sVal, sLbl, sKey, tBase, tBonus) => {
    h += '<div class="sh-hdr-row">'
      + (iconHtml ? '<div class="sh-faction-icon">' + iconHtml + '</div>' : '<div class="sh-icon-slot"></div>')
      + '<div class="sh-faction-text">'
      + (editMode ? editH : viewH)
      + '<div class="sh-faction-sub">' + sub + '</div>'
      + _statusDots(tBase, tBonus, 5)
      + (editMode ? _statusEditBtns('shStatusDown(\'' + sKey + '\')', 'shStatusUp(\'' + sKey + '\')') : '')
      + '</div>'
      + _statusPip(svg, sVal, sLbl)
      + '</div>';
  };
  const _covBase = st.covenant?.[c.covenant] || 0;
  covRow(covIconHtml, '<select class="sh-edit-select" onchange="shEdit(\'covenant\',this.value);renderSheet(chars[editIdx])">' + COVENANTS.map(cv => '<option' + (c.covenant === cv ? ' selected' : '') + '>' + cv + '</option>').join('') + '</select>', '<div class="sh-faction-label">' + esc(c.covenant || '\u2014') + '</div>', 'Covenant', OTHER_SVG, _covBase, 'Cov.', 'covenant', _covBase, 0);
  if (editMode) {
    // BL-5 (#1008): both selects are locked once the character holds a value,
    // and the clan select gains the "not set" placeholder it never had on the
    // one path where it still matters. Two selects are built on the line below;
    // locking one and missing the other is the exact failure this epic exists
    // to stop, so both lock attributes are applied there and the reasons are
    // rendered under them.
    const _clanPlaceholder = isLineageLocked(c, 'clan') ? '' : '<option value=""' + (c.clan ? '' : ' selected') + '>(not set)</option>';
    const cOpts = _clanPlaceholder + CLANS.map(cl => '<option' + (c.clan === cl ? ' selected' : '') + '>' + cl + '</option>').join(''), bls = _blOptionNames(c), blO = bls.map(b => '<option' + (c.bloodline && _blKey(c.bloodline) === _blKey(b) ? ' selected' : '') + '>' + esc(b) + '</option>').join('');
    covRow(clanIconHtml, '<select class="sh-edit-select" onchange="shEdit(\'clan\',this.value)"' + lineageLockAttr(c, 'clan') + '>' + cOpts + '</select><select class="sh-edit-select sh-edit-select-sub" onchange="shEdit(\'bloodline\',this.value||null);renderSheet(chars[editIdx])"' + lineageLockAttr(c, 'bloodline') + '><option value="">(no bloodline)</option>' + blO + '</select>' + lineageLockNoteHtml(c, 'clan') + lineageLockNoteHtml(c, 'bloodline'), '', 'Clan / Bloodline', OTHER_SVG, st.clan || 0, 'Clan', 'clan', st.clan || 0, 0);
  }
  else covRow(clanIconHtml, '', '<div class="sh-faction-label">' + esc(c.clan || '\u2014') + '</div>' + (bl ? '<div class="sh-faction-bloodline">' + esc(bl) + '</div>' : ''), 'Clan', OTHER_SVG, st.clan || 0, 'Clan', 'clan', st.clan || 0, 0);
  h += '</div></div></div>'; // end right, body, hdr
  // Covenant strip
  const _covFull = [['Carthian Movement','Carthian'],['Circle of the Crone','Crone'],['Invictus','Invictus'],['Lancea et Sanctum','Lance']];
  const covS = _covFull.filter(([full]) => full !== c.covenant).map(([full, short]) => ({ label: short, fullName: full, status: c.status?.covenant?.[full] || 0 }));
  if (covS.length) { h += '<div class="cov-strip">'; covS.forEach(cs => { const a = cs.status > 0, lq = cs.label.replace(/'/g, "\\'"); if (editMode) { h += '<div class="cov-strip-cell cov-strip-cell-edit"><span class="cov-strip-name' + (a ? ' active' : '') + '">' + esc(cs.label) + '</span>' + _statusTrack(cs.status, 0, '') + _statusEditBtns('shCovStandingDown(\'' + lq + '\')', 'shCovStandingUp(\'' + lq + '\')') + '</div>'; } else { h += '<div class="cov-strip-cell"><span class="cov-strip-name' + (a ? ' active' : '') + '">' + esc(cs.label) + '</span>' + _statusTrack(cs.status, 0, '') + '</div>'; } }); h += '</div>'; }
  h += shRenderStatsStrip(c);
  if (isDesktop) {
    h += '<div class="sh-body">' + shRenderAttributes(c, editMode) + shRenderSkills(c, editMode) + '</div>';
    h += '</div>'; // end sh-dcol-left
    // showOvercommitIndicator=true: this is the ADMIN renderer (issue #1122,
    // Angelus's ruling) - Suite's own call (public/js/suite/sheet.js:739)
    // omits the argument and stays false.
    h += '<div class="sh-dcol sh-dcol-right"><div class="sh-body">' + shRenderGeneralMerits(c, editMode, true) + shRenderInfluenceMerits(c, editMode) + shRenderDomainMerits(c, editMode) + shRenderStandingMerits(c, editMode) + shRenderManoeuvres(c, editMode) + shRenderEquipment(c, editMode) + shRenderDisciplines(c, editMode) + '</div></div>';
    h += '</div>'; // end sh-desktop
  } else {
    h += '<div class="sh-body">' + shRenderAttributes(c, editMode) + shRenderSkills(c, editMode) + shRenderDisciplines(c, editMode) + shRenderGeneralMerits(c, editMode, true) + shRenderInfluenceMerits(c, editMode) + shRenderDomainMerits(c, editMode) + shRenderStandingMerits(c, editMode) + shRenderManoeuvres(c, editMode) + shRenderEquipment(c, editMode) + '</div>';
  }
  const _scrollEl = el.closest('.sh-wrap') || el.parentElement || document.documentElement, _scrollTop = _scrollEl.scrollTop;
  el.innerHTML = h; _scrollEl.scrollTop = _scrollTop;
  if (editMode) patchXpLedger(c); // un-awaited, mirrors patchOfficeMerits's own call shape
}
