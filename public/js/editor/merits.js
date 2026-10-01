/**
 * Merit utilities, prerequisite system, and power/discipline helpers.
 * Depends on constants and the rules cache (purchasable_powers API).
 */

import {
  ATTR_NAMES, SKILL_NAMES, DISC_NAMES, COV_SHORT, CLAN_NAMES,
  RITUAL_DISCS, INFLUENCE_SPHERES, INFLUENCE_MERIT_TYPES
} from '../data/constants.js';
import { meetsPrereq as _meetsPrereq, prereqLabel as _prereqLabel } from '../data/prereq.js';
import { getRulesByCategory, getRuleByKey, getRulesDB } from '../data/loader.js';

// Re-export the new prereq engine for direct use by consumers
export { _meetsPrereq as meetsPrereq, _prereqLabel as prereqLabel };

/**
 * DBO.3: true for a merit gained through in-character events, not bought
 * incrementally with XP — today that is exactly Mystery Cult Initiation and
 * Professional Training, which carry `special: 'standing'` on their rule
 * document.
 *
 * Deliberately checks `special`, NOT `sub_category`. THREE of this
 * predicate's four call sites used to check `rule.sub_category ===
 * 'standing'`, intending to catch MCI/PT — but MCI/PT's real live shape is
 * `special: 'standing'`, `sub_category: null`, so that check has never once
 * excluded them. It DID, coincidentally, exclude Confessor and Pledged
 * (`sub_category: 'standing'`), two ordinary fixed-XP merits gated by a
 * real Lance Status prereq the engine already evaluates correctly — nothing
 * about their own data marks them as event-only. The FOURTH call site (the
 * sheet's own general merit-add picker, below) had no standing-merit check
 * at all before this fix — a previously-unnamed defect, not a broken check.
 * Verified against live `tm_suite` 2026-08-14; see
 * `specs/stories/dbo-3-xp-spend-standing-filter-bug.md`.
 *
 * Placed here, ahead of the dropdown-builder functions below.
 *
 * (Historical note, resolved 2026-08-31 by #1115: this function's placement
 * used to matter because `server/tests/n7-n9-allocator-readers.test.js`
 * pinned its dropdown-builder contract with a fixed-character-distance
 * regex, which this comment's own prose could silently widen past. That
 * assertion is now a real brace-matched function-body slice instead —
 * immune to unrelated source growth or comment placement anywhere in this
 * file. Placement here is no longer load-bearing; kept for readability.)
 */
export function isMeritEventGranted(rule) {
  return !!rule && rule.special === 'standing';
}

/** Check if a merit is excluded by a merit the character already owns.
 *  Issue #188 (2026-05-08): exposed as `isMeritExcluded` so the DT form's
 *  XP Spend picker can apply the same exclusion logic the sheet's Merit
 *  Add picker uses, without duplicating the rule walk. */
export function isMeritExcluded(c, meritName) {
  for (const m of (c.merits || [])) {
    const rule = getRuleByKey(m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    if (!rule || !rule.exclusive) continue;
    const excluded = rule.exclusive.split(',').map(s => s.trim().toLowerCase());
    if (excluded.includes(meritName.toLowerCase())) return rule.name;
  }
  return null;
}
// Local alias preserved so the existing internal callers (buildMeritOptions
// / buildSubCategoryMeritOptions / buildMCIGrantOptions) don't need to be
// touched.
const _isExcluded = isMeritExcluded;

/* ══════════════════════════════════════════════════════
   Merit string helpers
   ══════════════════════════════════════════════════════ */

/** Strip dot glyphs and pipe-suffix, returning the base merit name. */
export function meritBase(s) {
  return s.replace(/\s*[●○]+.*/,'').replace(/\s*\|.*/,'').trim();
}

/** Count filled-dot glyphs in a merit string. */
export function meritDotCount(s) {
  return (s.match(/●/g) || []).length;
}

/** Return the pipe-suffix portion, or null. */
export function meritSuffix(s) {
  const m = s.match(/\|\s*(.+)$/);
  return m ? m[1].trim() : null;
}

/** Lowercase key from the base name. */
export function meritKey(s) {
  return meritBase(s).toLowerCase();
}

/** Lowercase key with parenthetical qualifiers stripped. */
export function meritKeyBase(s) {
  return meritKey(s).replace(/\s*\([^)]*\)\s*/g,'').trim();
}

/**
 * If a merit has a single fixed rating (e.g. Viral Mythology = 3), returns that number.
 * Returns null for graduated/range merits (e.g. Allies 1-5).
 */
export function meritFixedRating(name) {
  // Try rules cache first
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const rule = getRuleByKey(slug);
  if (rule) {
    if (!rule.rating_range) return null;
    if (rule.rating_range[0] === rule.rating_range[1]) return rule.rating_range[0];
    return null; // range merit
  }
  return null;
}

/** Look up a merit by name string. Tries rules cache first, falls back to MERITS_DB. */
export function meritLookup(s) {
  // Try rules cache (unified schema)
  const slug = (s || '').toLowerCase().replace(/\s*[●○]+.*/,'').replace(/\s*\|.*/,'').trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const rule = getRuleByKey(slug);
  if (rule) return { desc: rule.description, prereq: rule.prereq, rating: rule.rating_range ? `${rule.rating_range[0]}–${rule.rating_range[1]}` : null, type: rule.parent, sub_category: rule.sub_category, _rule: rule };
  return null;
}

/* ══════════════════════════════════════════════════════
   Merit array helpers (operate on character objects)
   ══════════════════════════════════════════════════════ */

/**
 * Find a merit by category and filtered index, returning both the merit
 * object and its real index in c.merits.
 */
export function meritByCategory(c, category, filteredIdx) {
  const filtered = (c.merits || []).filter(m => m.category === category);
  const m = filtered[filteredIdx];
  if (!m) return { merit: null, realIdx: -1 };
  return { merit: m, realIdx: c.merits.indexOf(m) };
}

/** Ensure every merit has inline creation fields (v3). */
export function ensureMeritSync(c) {
  if (!c.merits) c.merits = [];
  for (const m of c.merits) {
    if (m.cp === undefined) m.cp = 0;
    if (m.xp === undefined) m.xp = 0;
    // Issue #834: m.free is deprecated — no longer initialised here. New
    // merits don't carry the field; existing merits that have it set retain
    // it until the Phase 3 cleanup script zeros them. See memory
    // feedback_m_free_deprecated.
    if (m.free_mci === undefined) m.free_mci = 0;
    if (m.free_vm === undefined) m.free_vm = 0;
    if (m.free_lk === undefined) m.free_lk = 0;
    if (m.free_ohm === undefined) m.free_ohm = 0;
    if (m.free_inv === undefined) m.free_inv = 0;
    if (m.free_pt === undefined) m.free_pt = 0;
    if (m.free_mdb === undefined) m.free_mdb = 0;
    if (m.free_sw === undefined) m.free_sw = 0;
    // tm-admin.10.5: `bonus` is no longer defaulted. It is a runtime-only overlay slot (ST Mods add
    // onto it in memory); a missing one reads as 0, and the save paths strip it.
  }
}

/** Append a merit with inline creation defaults. */
export function addMerit(c, merit) {
  if (!c.merits) c.merits = [];
  if (merit.cp === undefined) merit.cp = 0;
  if (merit.xp === undefined) merit.xp = 0;
  // Issue #834: m.free is deprecated — no longer initialised on new merits.
  if (merit.free_mci === undefined) merit.free_mci = 0;
  if (merit.free_vm === undefined) merit.free_vm = 0;
  if (merit.free_lk === undefined) merit.free_lk = 0;
  if (merit.free_ohm === undefined) merit.free_ohm = 0;
  if (merit.free_inv === undefined) merit.free_inv = 0;
  if (merit.free_pt === undefined) merit.free_pt = 0;
  if (merit.free_mdb === undefined) merit.free_mdb = 0;
  if (merit.free_sw === undefined) merit.free_sw = 0;
  // tm-admin.10.5: no `bonus` default (runtime-only overlay slot, never persisted).
  if (merit.rule_key === undefined) merit.rule_key = null;
  c.merits.push(merit);
}

/** Remove a merit by real index. */
export function removeMerit(c, realIdx) {
  if (realIdx < 0 || realIdx >= c.merits.length) return;
  c.merits.splice(realIdx, 1);
}

/* ══════════════════════════════════════════════════════
   Internal dot-lookup helpers (for prerequisite checks)
   ══════════════════════════════════════════════════════ */

function _getAttrDots(c, name) {
  const k = Object.keys(c.attributes || {}).find(a => a.toLowerCase() === name);
  return k ? (c.attributes[k].dots || 0) : 0;
}

function _getSkillDots(c, name) {
  const k = Object.keys(c.skills || {}).find(s => s.toLowerCase() === name);
  return k ? (c.skills[k].dots || 0) : 0;
}

function _getDiscDots(c, name) {
  const n = name.toLowerCase();
  const k = Object.keys(c.disciplines || {}).find(d => d.toLowerCase() === n);
  return k ? (c.disciplines[k]?.dots || 0) : 0;
}

function _getMeritRating(c, name) {
  const n = name.toLowerCase();
  const m = (c.merits || []).find(m => m.name.toLowerCase() === n);
  return m ? (m.rating || 1) : 0;
}

function _getCovStatus(c, covShort) {
  const fullName = COV_SHORT[covShort.toLowerCase()] || covShort;
  return c.status?.covenant?.[fullName] || 0;
}

/* ══════════════════════════════════════════════════════
   Prerequisite system
   ══════════════════════════════════════════════════════ */

/**
 * Check a single prerequisite token against a character.
 * Returns true if the character meets the requirement.
 */
export function checkSinglePrereq(c, token) {
  token = token.trim();
  if (!token || token === 'None' || token === '-') return true;

  // "No X Status"
  const noStatus = /^No\s+(\w+)\s+Status$/i.exec(token);
  if (noStatus) {
    const cov = noStatus[1];
    return _getCovStatus(c, cov) === 0;
  }

  // "City Status N"
  const cityStatus = /^City\s+Status\s+(\d+)$/i.exec(token);
  if (cityStatus) return (c.status?.city || 0) >= parseInt(cityStatus[1]);

  // "Clan Status N" or "[ClanName] Status N"
  const clanStatus = /^(?:Clan\s+)?(\w+)\s+Status\s+(\d+)$/i.exec(token);
  if (clanStatus) {
    const word = clanStatus[1].toLowerCase();
    const n = parseInt(clanStatus[2]);
    if (word === 'clan') return (c.status?.clan || 0) >= n;
    if (COV_SHORT[word]) return _getCovStatus(c, word) >= n;
    return _getCovStatus(c, word) >= n;
  }

  // "Humanity < N"
  const humLt = /^Humanity\s*<\s*(\d+)$/i.exec(token);
  if (humLt) return (c.humanity || 7) < parseInt(humLt[1]);

  // "X Bloodline" or "Bloodline X"
  if (/bloodline/i.test(token)) {
    const bl = (c.bloodline || '').toLowerCase();
    return bl && token.toLowerCase().includes(bl);
  }

  // Clan name alone
  if (CLAN_NAMES.has(token.toLowerCase())) return (c.clan || '').toLowerCase() === token.toLowerCase();

  // Specialisation references — too complex to verify, pass
  if (/speciali[sz]/i.test(token)) return true;

  // "Attribute N" / "Skill N" / "Discipline N" / "Merit N"
  const withNum = /^(.+?)\s+(\d+)$/.exec(token);
  if (withNum) {
    const name = withNum[1].trim().toLowerCase();
    const n = parseInt(withNum[2]);
    if (ATTR_NAMES.has(name)) return _getAttrDots(c, name) >= n;
    if (SKILL_NAMES.has(name)) return _getSkillDots(c, name) >= n;
    const nameNorm = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (DISC_NAMES.has(name) || DISC_NAMES.has(nameNorm)) return _getDiscDots(c, name) >= n || _getDiscDots(c, nameNorm) >= n;
    // Merit as prereq e.g. "Safe Place 1", "Contacts 2"
    return _getMeritRating(c, name) >= n;
  }

  // Token without number — presence check
  const nameLow = token.toLowerCase();
  if (ATTR_NAMES.has(nameLow)) return _getAttrDots(c, nameLow) > 0;
  if (SKILL_NAMES.has(nameLow)) return _getSkillDots(c, nameLow) > 0;
  if (DISC_NAMES.has(nameLow)) return _getDiscDots(c, nameLow) > 0;
  // Inequality operators — just pass
  if (/[≤≥<>]/.test(token)) return true;
  // Merit name without number — permissive fallback
  return _getMeritRating(c, nameLow) > 0 || true;
}

/**
 * Check a full prerequisite string (comma-separated AND, "or"-separated OR).
 * If the rules cache is available, looks up the structured prereq tree and
 * delegates to meetsPrereq(). Falls back to regex parsing if cache unavailable.
 */
export function meritQualifies(c, prereqStr, structuredPrereq) {
  if (!prereqStr || prereqStr === '-') return true;

  // If a structured prereq tree was passed directly, use the new engine
  if (structuredPrereq !== undefined) {
    return meritPrereqOK(c, { prereq: structuredPrereq });
  }

  // Fallback: regex-based parsing for legacy callers
  const andParts = prereqStr.split(/\s*,\s*/);
  return andParts.every(part => {
    const orParts = part.split(/\s+or\s+/i);
    return orParts.some(t => checkSinglePrereq(c, t.trim()));
  });
}

/**
 * N-9 (issue #762, Bug 3) — single seam for the prereq check across all
 * sub-category dropdown filters (buildMeritOptions, buildSubCategoryMeritOptions,
 * buildMCIGrantOptions). Wraps `_meetsPrereq` so future evolutions of the
 * prereq-check semantics happen in one place instead of three.
 *
 * Returns true when the character meets the rule's `prereq` tree. Empty /
 * missing prereq trees pass (existing `_meetsPrereq` semantics).
 *
 * Note: current-row passthrough — when a row's currently-selected merit name
 * fails its prereq (e.g. ST removed a prereq merit elsewhere on the sheet),
 * the picker keeps the selection visible per Ma'at's directive (legitimate
 * editing affordance). Callers handle that case inline with their `curLow`
 * check, and emit a `console.warn` so the situation surfaces in QA testing
 * instead of silently passing. The warn lives on the caller side because
 * "current row" is dropdown-builder concern, not a property of the rule.
 *
 * @param {object} c
 * @param {object} rule - merit rule doc (with optional `prereq` tree)
 * @returns {boolean}
 */
export function meritPrereqOK(c, rule) {
  return _meetsPrereq(c, rule && rule.prereq);
}

/**
 * Build <option> HTML for a merit select dropdown, filtered by prerequisites.
 * Excludes standing, domain, and influence merits (those have dedicated UI).
 */
export function buildMeritOptions(c, currentName) {
  // Try rules cache first
  const rulesDB = getRulesByCategory('merit');
  const qualified = [];

  if (rulesDB.length) {
    // Rules cache available — use structured data
    for (const rule of rulesDB) {
      // DBO.3: MCI/PT are event-granted, not directly XP-purchasable —
      // exclude here too, alongside (not replacing) the sub_category check
      // below, which independently and correctly excludes influence/domain/
      // carthian-law/oath merits from this general-only picker.
      if (isMeritEventGranted(rule)) continue;
      if (rule.sub_category && rule.sub_category !== 'general') continue;
      if (INFLUENCE_MERIT_TYPES.includes(rule.name)) continue;
      // Issue #937: 'Style'-parent merits are plain merits — surface them.
      // 2026-06-30: 'Carthian Law' also removed. Carthian Laws are merits with
      // status-based prereqs and belong in the regular picker; the Pacts UI
      // continues to list them too as an alternate path. See parallel change
      // in downtime-form.js so DT XP-spend and sheet pickers stay aligned.
      if (rule.parent && ['Invictus Oath'].includes(rule.parent)) continue;
      if (!meritPrereqOK(c, rule)) continue;
      const excl = _isExcluded(c, rule.name);
      if (excl && rule.name.toLowerCase() !== (currentName || '').toLowerCase()) continue;
      qualified.push({ key: rule.name.toLowerCase(), label: rule.name });
    }
  } else {
    return '<option value="">— rules loading —</option>';
  }
  qualified.sort((a, b) => a.label.localeCompare(b.label));
  const curLow = (currentName || '').toLowerCase();
  const esc = _esc;
  let opts = '<option value="">' + (currentName ? '' : '— select merit —') + '</option>';
  if (currentName && !qualified.some(q => q.key === curLow)) {
    opts += '<option value="' + esc(currentName) + '" selected>' + esc(currentName) + '</option>';
  }
  for (const { key, label } of qualified) {
    const sel = key === curLow || label.toLowerCase() === curLow ? ' selected' : '';
    opts += '<option value="' + esc(label) + '"' + sel + '>' + esc(label) + '</option>';
  }
  return opts;
}

/**
 * Build <option> HTML for an influence or domain merit type dropdown, driven
 * by sub_category in the catalog. Enforces prereqs and exclusive lists, with
 * the show-if-current escape hatch so an existing row whose merit no longer
 * qualifies still displays in its own dropdown.
 * @param {object} c - character
 * @param {string} subCategory - 'influence' or 'domain'
 * @param {string} currentName - name currently selected on this row
 * @param {string[]} [extraNames] - additional names to include (e.g. legacy
 *   names not yet in the catalog) so the picker stays usable during migration
 */
export function buildSubCategoryMeritOptions(c, subCategory, currentName, extraNames = []) {
  const rulesDB = getRulesByCategory('merit');
  if (!rulesDB.length) return '<option value="">— rules loading —</option>';
  const curLow = (currentName || '').toLowerCase();

  const qualified = [];
  const seen = new Set();
  for (const rule of rulesDB) {
    if (rule.sub_category !== subCategory) continue;
    // N-9 (issue #762, Bug 3): single-seam prereq check; current-row
    // passthrough preserved (legitimate editing affordance) but a
    // failing-prereq passthrough now emits a diagnostic warn so the
    // situation surfaces in QA testing instead of silently passing.
    const passes = meritPrereqOK(c, rule);
    const isCurrentRow = rule.name.toLowerCase() === curLow;
    if (!passes && !isCurrentRow) continue;
    if (!passes && isCurrentRow) {
      try {
        console.warn(`[meritPrereqOK] current selection "${rule.name}" (sub_category=${subCategory}) passes through filter but fails its prereq — investigate.`);
      } catch { /* console may be absent in test contexts */ }
    }
    if (_isExcluded(c, rule.name) && !isCurrentRow) continue;
    if (seen.has(rule.name)) continue;
    seen.add(rule.name);
    qualified.push(rule.name);
  }
  for (const n of extraNames) {
    if (!seen.has(n)) { seen.add(n); qualified.push(n); }
  }
  qualified.sort((a, b) => a.localeCompare(b));

  // Always include the current row's selected name even if filtered out.
  if (currentName && !seen.has(currentName)) qualified.push(currentName);

  return qualified.map(n => '<option value="' + _esc(n) + '"' + (n === currentName ? ' selected' : '') + '>' + _esc(n) + '</option>').join('');
}

/**
 * Build <option> HTML for MCI grant dropdown — includes influence and domain merits.
 * Filters by prerequisites and dot-level rating.
 * MCI dot ratings: dot 1-2 = 1-dot merits, dot 3 = 2-dot, dot 4-5 = 3-dot.
 * Graduated merits (rating range) appear if their min ≤ dotRating.
 * @param {object} c - character
 * @param {number} dotLevel - 0-indexed MCI dot level
 * @param {string} currentName - currently selected merit name
 */
const MCI_DOT_RATING = [1, 1, 2, 3, 3];
export function buildMCIGrantOptions(c, dotLevel, currentName) {
  const maxR = MCI_DOT_RATING[dotLevel] || 1;
  const qualified = [];

  // Try rules cache first
  const rulesDB = getRulesByCategory('merit');
  if (rulesDB.length) {
    for (const rule of rulesDB) {
      if (isMeritEventGranted(rule)) continue; // DBO.3
      if (rule.parent && ['Style', 'Invictus Oath', 'Carthian Law'].includes(rule.parent)) continue;
      if (!meritPrereqOK(c, rule)) continue;
      if (_isExcluded(c, rule.name) && rule.name.toLowerCase() !== (currentName || '').toLowerCase()) continue;
      const rr = rule.rating_range;
      if (rr) {
        if (rr[0] === rr[1]) { if (rr[0] !== maxR) continue; }
        else { if (rr[0] > maxR) continue; }
      } else { if (1 !== maxR) continue; }
      qualified.push({ key: rule.name.toLowerCase(), label: rule.name });
    }
  } else {
    return '<option value="">— rules loading —</option>';
  }
  qualified.sort((a, b) => a.label.localeCompare(b.label));
  const curLow = (currentName || '').toLowerCase();
  let opts = '<option value="">' + (currentName ? '' : '— select merit —') + '</option>';
  if (currentName && !qualified.some(q => q.key === curLow)) {
    opts += '<option value="' + _esc(currentName) + '" selected>' + _esc(currentName) + '</option>';
  }
  for (const { key, label } of qualified) {
    const sel = key === curLow || label.toLowerCase() === curLow ? ' selected' : '';
    opts += '<option value="' + _esc(label) + '"' + sel + '>' + _esc(label) + '</option>';
  }
  return opts;
}

/**
 * Walk a prereq tree and return true if every satisfying assignment requires
 * Carthian status — i.e. no non-Carthian character could legitimately have
 * the merit. `all` requires Carthian if any child does; `any` requires it
 * only if every branch does.
 */
function _everyPrereqPathRequiresCarthian(node) {
  if (!node) return false;
  if (node.all) return node.all.some(_everyPrereqPathRequiresCarthian);
  if (node.any) return node.any.every(_everyPrereqPathRequiresCarthian);
  if (node.type === 'status' && node.qualifier) return /carthian/i.test(node.qualifier);
  return false;
}

/**
 * Build <option> HTML for Fucking Thief — single-dot non-Carthian merits.
 * Excludes Carthian-locked merits (the thief is Carthian by prereq, so they
 * can only steal what a non-Carthian could plausibly hold).
 */
export function buildFThiefOptions(currentName) {
  const qualified = [];

  // Try rules cache first
  const rulesDB = getRulesByCategory('merit');
  if (rulesDB.length) {
    for (const rule of rulesDB) {
      if (isMeritEventGranted(rule)) continue; // DBO.3
      const rr = rule.rating_range;
      const minR = rr ? rr[0] : 1;
      if (minR > 1) continue;
      if (rr && rr[0] === rr[1] && rr[0] !== 1) continue;
      if (_everyPrereqPathRequiresCarthian(rule.prereq)) continue;
      qualified.push({ key: rule.name.toLowerCase(), label: rule.name });
    }
  } else {
    return '<option value="">— rules loading —</option>';
  }
  qualified.sort((a, b) => a.label.localeCompare(b.label));
  const curLow = (currentName || '').toLowerCase();
  let opts = '<option value="">' + (currentName ? '' : '— choose stolen merit —') + '</option>';
  if (currentName && !qualified.some(q => q.key === curLow)) {
    opts += '<option value="' + _esc(currentName) + '" selected>' + _esc(currentName) + '</option>';
  }
  for (const { key, label } of qualified) {
    const sel = key === curLow || label.toLowerCase() === curLow ? ' selected' : '';
    opts += '<option value="' + _esc(label) + '"' + sel + '>' + _esc(label) + '</option>';
  }
  return opts;
}

/* ── Inline HTML escape (avoids circular dependency on a helpers module) ── */
function _esc(s) {
  return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════
   Power / discipline helpers
   ══════════════════════════════════════════════════════ */

/** Filter a powers array to those belonging to a specific discipline. */
export function powersForDisc(powers, discName) {
  if (!powers) return [];
  if (RITUAL_DISCS.includes(discName)) {
    return powers.filter(p => p.name && (p.name.startsWith(discName) || p.name.includes('| ' + discName)));
  }
  return powers.filter(p => {
    if (!p.name) return false;
    const n = p.name.split('|')[0].trim().split(/\s+/);
    return n[0] === discName || (n.length > 1 && n.slice(0, -1).join(' ') === discName);
  });
}

/** Return powers not attributable to any known discipline on the character. */
export function otherPowers(c) {
  const discNames = Object.keys(c.disciplines || {});
  return (c.powers || []).filter(p => {
    if (!p.name) return false;
    const key = p.name.split('|')[0].trim().replace(/\s*[●○]+$/, '').replace(/\s+\d+$/, '');
    if (RITUAL_DISCS.some(d => p.name.startsWith(d))) return false;
    return !discNames.some(d => key === d || key.startsWith(d + ' '));
  });
}

/** Returns a Set of cult names from a character's Mystery Cult Initiation merits. */
function getCharCults(c) {
  return new Set(
    (c.merits || [])
      .filter(m => m.name === 'Mystery Cult Initiation' && m.cult_name)
      .map(m => m.cult_name)
  );
}

/** Check whether a character meets a devotion's discipline prerequisites. */
export function meetsDevPrereqs(c, dev) {
  if (dev.bl && (c.bloodline || '') !== dev.bl) return false;
  if (dev.cult && !getCharCults(c).has(dev.cult)) return false;
  const discs = c.disciplines || {};
  if (!dev.p || !dev.p.length) return true;
  if (dev.or) {
    return dev.p.some(p => (discs[p.disc]?.dots || 0) >= p.dots);
  }
  return dev.p.every(p => (discs[p.disc]?.dots || 0) >= p.dots);
}

/** Format a devotion's prerequisite list as a human-readable string. */
export function devPrereqStr(dev) {
  const parts = [];
  if (dev.bl) parts.push(dev.bl + ' only');
  if (dev.cult) parts.push(dev.cult + ' members only');
  if (dev.p && dev.p.length) parts.push(dev.p.map(p => p.disc + ' ' + p.dots).join(dev.or ? ' or ' : ', '));
  return parts.join('; ') || 'None';
}
