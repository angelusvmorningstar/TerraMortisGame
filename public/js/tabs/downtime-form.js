/* Downtime submission form — character-aware, section-gated, auto-saving.
 * Uses existing /api/downtime_submissions API.
 * Lifecycle: draft → submitted (player can edit until deadline)
 *
 * Auto-detected sections:
 *  - Court: from game_sessions attendance
 *  - Regency action: inlined in Vamping section for Regents
 *  - Spheres/Contacts/Retainers: from character merits
 *  - Blood Sorcery: from disciplines (Cruac/Theban)
 */

import { apiGet, apiPost, apiPut, apiPatch } from '../data/api.js';
import { saveDraft as saveLocalDraft, loadDraft as loadLocalDraft, clearDraft as clearLocalDraft, pickFreshestDraft } from './draft-persist.js';
import { esc, displayName, parseOutcomeSections, redactPlayer, redactCharName, hasAoE, isSpecs, findRegentTerritory } from '../data/helpers.js';
import { applyDerivedMerits } from '../editor/mci.js';
import { DOWNTIME_SECTIONS, DOWNTIME_GATES, SPHERE_ACTIONS, TERRITORY_DATA, FEEDING_TERRITORIES, PROJECT_ACTIONS, FEED_METHODS, MAINTENANCE_MERITS, FEED_VIOLENCE_DEFAULTS, ACTION_DESCRIPTIONS, ACTION_APPROACH_PROMPTS, SUBMIT_FINAL_MODAL_QUESTIONS } from './downtime-data.js';
import { actionSpentSummary, formatActionSpentSummary } from '../data/dt-action-summary.js';
import { computeBestFeedingPool } from '../data/feeding-pool.js';
import { ALL_ATTRS, ALL_SKILLS, CLAN_DISCS, BLOODLINE_DISCS, CORE_DISCS, RITUAL_DISCS, INFLUENCE_SPHERES } from '../data/constants.js';
import { freeOf, normaliseAttachedTo } from '../data/rules-helpers.js';
import { calcTotalInfluence, domMeritTotal, attacheBonusDots, effectiveInvictusStatus, ssjHerdBonus, flockHerdBonus, meritEffectiveRating, influenceBreakdown, domKey, canAllocateCarthianPull } from '../editor/domain.js';
import { calcVitaeMax, skTotal, riteCost, skillAcqPoolStr, getAttrEffective, getAttrTotal, discDots } from '../data/accessors.js';
import { xpLeft } from '../editor/xp.js';
import { meetsPrereq, isMeritExcluded } from '../editor/merits.js';
import { getRuleByKey, getRulesByCategory } from '../data/loader.js';
import { getRole, isSTRole } from '../auth/discord.js';
import { FAMILIES, kindByCode } from '../data/relationship-kinds.js';
// dt-form.33: removed `promptForKind` import — last consumer was the
// dt-story_moment_relationship_id change handler, deleted with the
// other NPC-picker-driven UI under the suppression policy.
import { charPicker, setCharPickerSources } from '../components/character-picker.js';
import { isMinimalComplete, missingMinimumPieces } from '../data/dt-completeness.js';
// #1001: canonical in-game-phase test (game_phase wins over legacy status)
// #1002: cycleSpanLabel - which session this downtime feeds (derived)
import { isInGamePhase, cycleSpanLabel, cycleFeedsLabel } from '../downtime/db.js';
// ECM-4 (#871): catalogue dropdown sources from the shared cache module
// ECM-5 (#872) introduced. App boot in app.js calls loadCatalogue; we read
// synchronously here at render time. getCatalogueEntry resolves a
// 24-hex catalogue_id → display name for the legacy-fallback path.
import { getCatalogue, getCatalogueEntry } from '../data/equipment-catalogue-cache.js';
// #896: availability filter + Fixer errata. Helpers gate which catalogue
// items appear as enabled options for the active character; unaffordable
// items render disabled with a tooltip explaining why. Item-request
// textarea (ECM-9) is the escape valve.
import { availabilityCap, fixerReduction, effectiveAvailability, isAffordable } from '../data/equipment-derivation.js';

// Influence merit names that generate monthly influence
const INFLUENCE_MERIT_NAMES = ['Allies', 'Retainer', 'Mentor', 'Resources', 'Staff', 'Contacts', 'Status'];
// Only 5 territories can receive influence (not The Barrens)
const INFLUENCE_TERRITORIES = FEEDING_TERRITORIES.filter(t => !t.includes('Barrens'));

// DTFP-2: render-time alphabetical sort for chip lists. Returns a new array;
// never mutates the source (chip data often comes from shared modules like
// FEED_METHODS that must not be reordered).
function sortChips(items, keyFn = x => x) {
  return items.slice().sort((a, b) =>
    String(keyFn(a)).localeCompare(String(keyFn(b)), undefined, { sensitivity: 'base' })
  );
}

// STs receive raw docs from the API (stripStReview not applied server-side for their role).
// Promote st_review.outcome_text → published_outcome client-side so ST player-portal views
// behave identically to player views.
function _promotePublishedOutcome(sub) {
  if (!sub.published_outcome && sub.st_review?.outcome_visibility === 'published') {
    sub.published_outcome = sub.st_review.outcome_text;
  }
}

// dt-form.22: one-shot migration of legacy ROTE state into the new
// project-action shape. Reads `_feed_rote` / `_feed_rote_slot` (plus the
// pool-builder `_rote_*` companions) and translates to:
//   responses.project_N_action      = 'rote'
//   responses.project_N_feed_method2 = <primary method, if known>
// Drops the legacy keys. `feeding_territories_rote` is left in place — it's
// the canonical doc-level territory map per the 2026-05-06 HALT-DAR.
//
// Idempotent: the function returns early if there are no legacy fields to
// migrate. Called from renderDowntimeTab after responseDoc loads, and as
// a defensive prelude inside collectResponses so a stray legacy save can't
// re-introduce the old shape.
function _migrateLegacyRoteState(responses) {
  if (!responses || typeof responses !== 'object') return;
  const isLegacy = responses._feed_rote === 'yes' || responses._feed_rote_slot
    || responses._rote_disc || responses._rote_spec
    || responses._rote_custom_attr || responses._rote_custom_skill;
  if (!isLegacy) return;

  const rawSlot = parseInt(responses._feed_rote_slot, 10);
  const slot = Number.isInteger(rawSlot) && rawSlot >= 1 && rawSlot <= 4 ? rawSlot : 1;
  const wasOn = responses._feed_rote === 'yes';
  if (wasOn) {
    // The slot may have been auto-locked to action='feed' by the legacy
    // applyRoteToProjectSlot path. Flip it to the new 'rote' action type.
    if (responses[`project_${slot}_action`] === 'feed' || !responses[`project_${slot}_action`]) {
      responses[`project_${slot}_action`] = 'rote';
    }
    // Persist the primary method into the per-slot `_method2` field if
    // available. The pool itself is no longer separately stored — derived
    // at render time from the primary feeding inputs.
    const primaryMethod = responses._feed_method;
    if (primaryMethod && !responses[`project_${slot}_feed_method2`]) {
      responses[`project_${slot}_feed_method2`] = primaryMethod;
    }
  }

  // Drop legacy keys so subsequent saves don't re-introduce them.
  delete responses._feed_rote;
  delete responses._feed_rote_slot;
  delete responses._rote_disc;
  delete responses._rote_spec;
  delete responses._rote_custom_attr;
  delete responses._rote_custom_skill;
}

let responseDoc = null;
let currentChar = null;
let currentCycle = null;
let _territories = [];
let gateValues = {};

// Issue #496 / story 496.2: build a name+slug → ObjectId lookup from the
// cached territories list. Used at the save boundary in collectResponses() to
// rewrite legacy long-slug / short-slug territory keys into canonical OIDs.
// Returns a Map keyed by BOTH display name ("The Harbour") and short slug
// ("harbour") so JSON-key sites (which iterate FEEDING_TERRITORIES display
// names) and enum-value sites (which read short slugs from the pill widget)
// can share one map. Barrens has no _id and is excluded; callers fall back
// to the legacy key when this map returns null (server resolver maps both
// Barrens variants to null correctly).
function _buildTerritoryOidMap() {
  const m = new Map();
  for (const t of _territories || []) {
    if (!t || !t._id) continue;
    const oid = String(t._id);
    if (t.name) m.set(t.name, oid);
    if (t.slug) m.set(t.slug, oid);
  }
  return m;
}

// Issue #496 / story 496.2: O(n) lookup of a territory's OID by display name,
// for use in render functions that don't have a pre-built map in scope. n is
// always <=5 in practice; no need for a cached module-level map.
function _terrOidForName(name) {
  const t = (_territories || []).find(t => t?.name === name);
  return t?._id ? String(t._id) : null;
}

// Issue #496 / #816: the REVERSE of _buildTerritoryOidMap. collectResponses()
// remaps territory slugs to OIDs at the save boundary, so any renderer or
// click handler that compares a saved value against TERRITORY_DATA's `slug`
// must normalise first — otherwise it compares an OID to a slug and silently
// never matches. Pass-through for values that are already slugs (or unknown).
function _terrSlugFromSaved(val) {
  if (!val || !/^[a-f0-9]{24}$/i.test(String(val))) return val || '';
  const t = (_territories || []).find(t => String(t._id) === String(val));
  return t?.slug || val;
}

function _terrGridVal(grid, displayName, legacyKey) {
  if (!grid) return undefined;
  const oid = _terrOidForName(displayName);
  if (oid && grid[oid] !== undefined) return grid[oid];
  if (legacyKey && grid[legacyKey] !== undefined) return grid[legacyKey];
  return undefined;
}
let saveTimer = null;
let localSaveTimer = null; // DTU-2: localStorage mirror fires faster than server save
let restoredFromLocal = false; // DTU-2: banner flag set when form mounts from localStorage
let priorPublishedLabel = null; // label of most recent published cycle other than current
// dt-form.33: removed `_linkedNpcs` and `_myRelationships` module vars
// + their data loads. Both fed DB-relational NPC pickers (the legacy
// _legacyRenderPersonalStorySection NPC card grid and the story-moment
// relationship picker) that this story prunes under the NPC-interaction
// suppression policy. No live consumer remained after dt-form.18.
let _allSubmissions = []; // DTUI-13: all submissions for the current cycle, for free-slot detection

// Merits detected from the character sheet, grouped by type
let detectedMerits = { spheres: [], contacts: [], retainers: [], status: [], mentors: [], staff: [] };


// Characters who attended last game (for shoutout picks)
let lastGameAttendees = [];
// dt-form.17: game_session id matching the active cycle, for the soft-submit
// lifecycle PATCH on attendance.downtime.
let _activeGameSessionId = null;
// All active characters (for cast picker modal)
let allCharacters = [];

// Feeding method state (for feeding_method widget)
let feedMethodId = '';
let feedDiscName = '';
let feedSpecName = '';
let feedCustomAttr = '';
let feedCustomSkill = '';
let feedCustomDisc = '';
let feedRoteAction = false;
let feedRoteSlot = 1;
let feedRoteDisc = '';
let feedRoteSpec = '';
let feedRoteCustomAttr = '';
let feedRoteCustomSkill = '';

// Project tab state
let activeProjectTab = 1;
// Sphere tab state
let activeSphereTab = 1;


const ACTION_ICONS = {
  '': '\u2298', 'ambience_increase': '\u25B2', 'ambience_decrease': '\u25BC',
  'attack': '\u2694', 'feed': '\u2666', 'hide_protect': '\u25C6',
  'investigate': '\u25CE', 'patrol_scout': '\u25C8', 'support': '\u2605',
  'xp_spend': '\u2726', 'misc': '\u25CF', 'maintenance': '\u2699',
  'rote': '\u2666', // dt-form.22: same diamond as feed; ROTE is a feed variant
};
const ACTION_SHORT = {
  '': 'No Action', 'ambience_increase': 'Ambience +', 'ambience_decrease': 'Ambience \u2212',
  'attack': 'Attack', 'feed': 'Feed (Rote)', 'hide_protect': 'Hide/Protect',
  'investigate': 'Investigate', 'patrol_scout': 'Patrol/Scout', 'support': 'Support',
  'xp_spend': 'XP Spend', 'misc': 'Misc', 'maintenance': 'Maintenance',
  'rote': 'Rote Hunt', // dt-form.22
};
// Which fields each action type shows
const ACTION_FIELDS = {
  '': [],
  'feed': [],
  'xp_spend': ['xp_picker'],
  // dt-form.25: 'target' dropped — the row-table inline below IS the
  // (territory + direction) picker. Renders alongside title/outcome/pools/description.
  'ambience_change':   ['title', 'outcome', 'pools', 'description'],
  'attack':            ['title', 'outcome', 'target', 'pools', 'description'],
  'investigate':       ['title', 'outcome', 'target', 'investigate_lead', 'pools', 'description'],
  'hide_protect':      ['title', 'outcome', 'target', 'pools', 'description'],
  'patrol_scout':      ['title', 'outcome', 'target', 'pools', 'description'],
  'misc':              ['title', 'outcome', 'target', 'pools', 'description'],
  'maintenance':       ['target', 'description'],
  // dt-form.22: ROTE renders only the territory + description; pool is
  // inherited from primary feeding (read-only annotation). The handler
  // below renders rote-specific UI, so this list is intentionally just
  // 'description' — the territory + pool annotation are emitted inline.
  'rote':              ['description'],
};

const SPHERE_ACTION_FIELDS = {
  '': [],
  'ambience_change':   ['territory', 'ambience_dir', 'outcome'],
  'ambience_increase': ['territory', 'ambience_dir', 'outcome'],  // legacy alias
  'ambience_decrease': ['territory', 'ambience_dir', 'outcome'],  // legacy alias
  'attack':            ['target_char', 'outcome'],
  'block':             ['target_char', 'block_merit', 'outcome'],
  'hide_protect':      ['target_own_merit', 'outcome'],
  'investigate':       ['target_flex', 'investigate_lead', 'outcome'],
  'patrol_scout':      ['territory', 'outcome'],
  'grow':              ['grow_xp'],
  'misc':              ['outcome'],
  'maintenance':       ['maintenance_target'],
};

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDraft(), 2000);
  // DTU-2: localStorage mirror runs at 800ms so a tab close between
  // keystrokes and the 2s server save doesn't wipe in-progress work.
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(_saveLocalSnapshot, 800);
}

function _saveLocalSnapshot() {
  if (!currentChar?._id || !currentCycle?._id) return;
  if (currentCycle._id === 'dev-stub') return;
  try {
    const responses = collectResponses();
    saveLocalDraft(String(currentChar._id), String(currentCycle._id), responses);
  } catch {
    // Never block rendering on a storage failure.
  }
}

function _clearLocalSnapshot() {
  if (!currentChar?._id || !currentCycle?._id) return;
  clearLocalDraft(String(currentChar._id), String(currentCycle._id));
}

/** Build a stable key for a merit (used as field prefix and toggle key). */
function meritKey(merit) {
  const area = merit.area || merit.qualifier || '';
  return `${merit.name}_${merit.rating}_${area}`.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/** Format a merit for display: "Allies ●●● (Health)" using effective rating. */
function meritLabel(merit) {
  const area = merit.area || merit.qualifier || '';
  const dots = '●'.repeat(meritEffectiveRating(currentChar, merit));
  return area ? `${merit.name} ${dots} (${area})` : `${merit.name} ${dots}`;
}

/** Deduplicate merits by meritKey — keeps the first occurrence only. */
function deduplicateMerits(list) {
  const seen = new Set();
  return list.filter(m => {
    const key = meritKey(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Scan character merits and disciplines to populate detectedMerits and auto-gates. */
function detectMerits() {
  const merits = (currentChar.merits || []).filter(m => m.category);
  const discs = currentChar.disciplines || {};

  // Expand benefit_grants from standing merits (MCI) into the influence pool.
  // Skip grants whose name is already represented by a direct influence merit
  // — by convention the MCI's contribution has been absorbed into the player's
  // direct merit's rating/spheres, so re-adding the grant here would double-
  // count (issue #90, Yusuf's MCI Contacts already in his direct Contacts
  // spheres). Charlie Ballsack's Retainer-via-Attaché pattern (hotfix #45)
  // is preserved because Charlie has no direct Retainer merit — the grant
  // still surfaces.
  const directInfluenceNames = new Set(
    merits.filter(m => m.category === 'influence').map(m => m.name)
  );
  const expandedInfluence = [...merits];
  for (const m of merits) {
    if (m.category !== 'standing') continue;
    const grants = Array.isArray(m.tier_grants) ? m.tier_grants
                 : Array.isArray(m.benefit_grants) ? m.benefit_grants
                 : [];
    for (const g of grants) {
      if (g.category !== 'influence') continue;
      if (directInfluenceNames.has(g.name)) continue;
      expandedInfluence.push({ ...g, _from_mci: m.cult_name || m.name });
    }
  }

  // #510: Allies + Contacts action lists come from the shared derivation so the
  // init detection and the live Carthian re-render cannot diverge.
  const _ia = deriveInfluenceActionMerits(merits);
  detectedMerits.spheres = _ia.spheres;
  // Issue #194 (2026-05-08): the standing-merit name is canonically
  // 'Mystery Cult Initiation' across the codebase (sheet, editor, admin,
  // audit). Filtering on 'MCI' here meant any character whose MCI was
  // stored under the canonical name (i.e. all of them) had an empty
  // detectedMerits.status array, so the Status block never rendered and
  // the 'Grow' action — required to raise Status above 3 dots — was
  // unreachable. Reproduced for Keeper.
  detectedMerits.status = deduplicateMerits(merits.filter(m =>
    m.category === 'influence' && m.name === 'Status'
  )).concat(merits.filter(m => m.category === 'standing' && m.name === 'Mystery Cult Initiation'));
  detectedMerits.contacts = _ia.contacts;
  // Attaché (*) merits are functionally Retainers (per sheet.js:900); also walk
  // expandedInfluence so any benefit_grants-sourced Retainer is picked up.
  detectedMerits.retainers = deduplicateMerits(expandedInfluence.filter(m =>
    m.category === 'influence' && (m.name === 'Retainer' || m.name?.startsWith('Attaché ('))
  ));
  // dt-form.28: Mentor (per-merit, like Retainer) and Staff (per-dot, like
  // Contacts) — same expandedInfluence walk so granted instances surface
  // (hotfix #45 pattern).
  detectedMerits.mentors = deduplicateMerits(expandedInfluence.filter(m =>
    m.category === 'influence' && m.name === 'Mentor'
  ));
  detectedMerits.staff = deduplicateMerits(expandedInfluence.filter(m =>
    m.category === 'influence' && m.name === 'Staff'
  ));

  gateValues.has_sorcery = (discDots(currentChar, 'Cruac') > 0 || discDots(currentChar, 'Theban') > 0) ? 'yes' : 'no';
}

/** Calculate monthly influence budget from character data. */
function getInfluenceBudget() {
  return calcTotalInfluence(currentChar);
}

/**
/** Convenience: effective rating for a domain merit by name.
 *  SP/FG are multi-instance — sums all instances.
 *  Haven/MG delegate to meritEffectiveRating which applies the SP cap.
 */
function effectiveDomainDots(c, name) {
  if (name === 'Safe Place' || name === 'Feeding Grounds') {
    return (c.merits || [])
      .filter(merit => merit.category === 'domain' && merit.name === name)
      .reduce((s, m) => s + meritEffectiveRating(c, m), 0);
  }
  const m = (c.merits || []).find(merit => merit.category === 'domain' && merit.name === name);
  return meritEffectiveRating(c, m);
}

/** Get the feeding cap for the regent's territory based on its ambience. */
function collectResponses() {
  // dt-form.17 (ADR-003 §Q1 Resolutions): preserve previously-entered fields
  // for sections hidden by the current mode. Spread the prior responses as a
  // base, then specific section blocks below either overwrite (when their UI
  // is rendered) or are skipped (when hidden by MINIMAL).
  // dt-form.22: defensive prelude — translate any stragglers from the legacy
  // ROTE state into the new project-action shape before the spread, so a
  // load → save round-trip can never re-introduce the old keys.
  if (responseDoc?.responses) _migrateLegacyRoteState(responseDoc.responses);
  const _prior = responseDoc?.responses || {};
  const responses = { ..._prior };
  // Carry the existing mode flag forward; the toggle handler updates it
  // explicitly before triggering a save/render.
  if (_prior._mode === 'minimal' || _prior._mode === 'advanced') {
    responses._mode = _prior._mode;
  }
  const _mode = _formMode(_prior);
  const _isMinimal = _mode === 'minimal';

  // Issue #496 / story 496.2: build the territory display-name+slug → OID
  // lookup once per save call. Used at the save boundary to rewrite legacy
  // territory keys (long slugs, short slugs) into canonical ObjectId strings
  // for every territory-typed response field. Server tolerates both formats
  // per story 496.1 (dual-read tolerance) until story 496.4 tightens.
  const _terrOidMap = _buildTerritoryOidMap();

  // Persist auto-detected gates
  responses['_gate_attended'] = gateValues.attended || '';
  responses['_gate_is_regent'] = gateValues.is_regent || '';
  responses['_gate_has_sorcery'] = gateValues.has_sorcery || '';
  if (gateValues.is_regent === 'yes' && findRegentTerritory(_territories, currentChar)?.territory) {
    responses['regent_territory'] = findRegentTerritory(_territories, currentChar)?.territory;
  }

  // Collect manual gate values
  for (const gate of DOWNTIME_GATES) {
    const checked = document.querySelector(`input[name="gate-${gate.key}"]:checked`);
    responses[`_gate_${gate.key}`] = checked ? checked.value : '';
  }

  // Collect static section responses
  for (const section of DOWNTIME_SECTIONS) {
    if (section.gate && gateValues[section.gate] !== 'yes') continue;
    // dt-form.17: skip hidden sections in MINIMAL so we don't clobber prior
    // values with empty strings when the DOM isn't rendered.
    if (_isMinimal && !MINIMAL_SECTIONS.has(section.key)) continue;

    for (const q of section.questions) {
      if (q.type === 'shoutout_picks') {
        // dt-form.16: charPicker writes JSON array directly to the hidden input.
        const hiddenEl = document.getElementById(`dt-${q.key}`);
        const raw = hiddenEl ? hiddenEl.value : '';
        let picks = [];
        try {
          const parsed = JSON.parse(raw || '[]');
          if (Array.isArray(parsed)) picks = parsed.map(String).filter(Boolean);
        } catch { picks = []; }
        responses[q.key] = JSON.stringify(picks);
        continue;
      }
      if (q.type === 'feeding_method') {
        // dt-form.20 fix-up (Ma'at PR #98 review, bug 1): persist `_feed_method`
        // again. DTFP-4 dropped it because the manual pool builder was the
        // canonical method-set signal in ADVANCED, but MINIMAL has no pool
        // builder — without this the simplified form's method choice is
        // invisible to isMinimalComplete and the hard-mirror lifecycle never
        // unlocks. ADVANCED still falls back to `_feed_disc` / `_feed_custom_*`
        // so this is additive, not a regression of the original DTFP-4 case.
        responses['_feed_method'] = feedMethodId || (feedCustomAttr ? 'other' : '');
        // dt-form.35: include method-default violence so visual highlight matches
        // what collectResponses writes. Explicit player click overrides the default.
        const _explicitViolence = responseDoc?.responses?.feed_violence;
        const _defaultViolence = feedMethodId ? (FEED_VIOLENCE_DEFAULTS[feedMethodId] || null) : null;
        const _violence = _explicitViolence || _defaultViolence;
        if (_violence) responses.feed_violence = _violence;
        responses['_feed_disc'] = feedDiscName;
        responses['_feed_spec'] = feedSpecName;
        responses['_feed_custom_attr'] = feedCustomAttr;
        responses['_feed_custom_skill'] = feedCustomSkill;
        responses['_feed_custom_disc'] = feedCustomDisc;
        // dt-form.22: legacy `_feed_rote*` and `_rote_*` writes removed.
        // ROTE is now a per-slot project action; method persists per-slot
        // as `project_N_feed_method2`, territory persists at the document
        // level as `feeding_territories_rote` (existing field, kept).
        // Blood type
        const bloodChecked = [];
        document.querySelectorAll('[data-blood-type].dt-feed-vi-on').forEach(btn => bloodChecked.push(btn.dataset.bloodType));
        responses['_feed_blood_types'] = JSON.stringify(bloodChecked);
        const descEl = document.getElementById('dt-feeding_description');
        responses['feeding_description'] = descEl ? descEl.value : '';
        // dt-form.22 fix-up (Ma'at PR #98 review round 2, bug-2 rework):
        // read the action selectors from the DOM, not from `responses`.
        // The feeding_method branch runs BEFORE the project-slot collect
        // loop at :532, so `responses[project_N_action]` here is still the
        // spread base from the prior responseDoc — it doesn't yet reflect
        // the user's current slot selection. The DOM does.
        const _hasRoteSlotForCollect = [1, 2, 3, 4].some(n => {
          const el = document.getElementById(`dt-project_${n}_action`);
          return el && el.value === 'rote';
        });
        if (_hasRoteSlotForCollect) {
          const roteGridVals = {};
          for (const terr of FEEDING_TERRITORIES) {
            const terrKey = terr.toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const el = document.getElementById(`feed-rote-val-${terrKey}`);
            // 496.2: write OID key; Barrens has no _id and falls back to legacy slug
            const outKey = _terrOidMap.get(terr) || terrKey;
            roteGridVals[outKey] = el ? el.value : 'none';
          }
          responses['feeding_territories_rote'] = JSON.stringify(roteGridVals);
        }
        continue;
      }
      if (q.type === 'xp_grid') {
        // dt-form.26: legacy Admin-section xp_grid collector pruned. The
        // Admin section was removed in #31, so no DOWNTIME_SECTIONS question
        // has type='xp_grid' anymore — the iteration that lands here is dead.
        // Keeping a defensive `continue` so a re-introduced legacy question
        // wouldn't accidentally clobber the new top-level mirror.
        continue;
      }
      if (q.type === 'influence_grid') {
        const infVals = {};
        for (const terr of INFLUENCE_TERRITORIES) {
          const tk = terr.toLowerCase().replace(/[^a-z0-9]+/g, '_');
          const el = document.getElementById(`inf-val-${tk}`);
          // 496.2: write OID key; INFLUENCE_TERRITORIES excludes Barrens so the
          // fallback never fires in practice, but keep it for defensive symmetry.
          const outKey = _terrOidMap.get(terr) || tk;
          infVals[outKey] = el ? parseInt(el.textContent, 10) || 0 : 0;
        }
        responses[q.key] = JSON.stringify(infVals);
        continue;
      }
      if (q.type === 'territory_grid') {
        const gridVals = {};
        for (const terr of FEEDING_TERRITORIES) {
          const terrKey = terr.toLowerCase().replace(/[^a-z0-9]+/g, '_');
          const el = document.getElementById(`feed-val-${terrKey}`);
          // 496.2: write OID key; Barrens has no _id and falls back to legacy slug
          const outKey = _terrOidMap.get(terr) || terrKey;
          gridVals[outKey] = el ? el.value : 'none';
        }
        responses[q.key] = JSON.stringify(gridVals);
        continue;
      }
      const el = document.getElementById('dt-' + q.key);
      if (!el) continue;
      if (q.type === 'radio') {
        const checked = document.querySelector(`input[name="dt-${q.key}"]:checked`);
        responses[q.key] = checked ? checked.value : '';
      } else {
        responses[q.key] = el.value;
      }
    }
  }

  // Personal story fields (legacy keys kept for back-compat with ST admin views)
  // dt-form.18 (option Y locked 2026-05-06): Personal Story collapsed to
  // Touchstone-or-Correspondence binary plus an optional free-text NPC
  // name. Collect writes `_kind` + `_text` + `_npc_name`. Does NOT write
  // `_npc_id` (no picker = no DB ID) nor legacy `_note` / `_direction`
  // (the new `_text` replaces the note; the rich-UI direction radios are
  // gone). Pre-redesign drafts retain the old keys via the spread base for
  // ST admin views. (Issue #939: Personal Story no longer gates
  // minimum-complete — it is optional.)
  const psKindEl = document.querySelector('input[name="dt-personal_story_kind"]:checked');
  const psNpcEl  = document.getElementById('dt-personal_story_npc_name');
  const psTextEl = document.getElementById('dt-personal_story_text');
  if (psKindEl) responses['personal_story_kind'] = psKindEl.value;
  if (psNpcEl)  responses['personal_story_npc_name'] = psNpcEl.value;
  if (psTextEl) responses['personal_story_text'] = psTextEl.value;

  // #504: Safe Places and Havens locations. Recompute the Safe Place list the
  // same way the renderer does so indices align, then read each input. Gate on
  // element presence (silent-leave) so a save when the section isn't rendered
  // (zero safe places) leaves any pre-existing keys on the spread base intact.
  const _safePlaces = (currentChar?.merits || [])
    .filter(m => m.category === 'domain' && m.name === 'Safe Place');
  _safePlaces.forEach((sp, i) => {
    const spEl = document.getElementById('dt-safe_place_location_' + i);
    if (spEl) responses['safe_place_location_' + i] = spEl.value;
  });

  // #508: Carthian Pull allocation — record the choice in the submission too
  // (the canonical state is the free_carthian bonus on the character; this is a
  // per-cycle audit copy, presence-gated like the safe-place collector).
  const cpTargetEl = document.getElementById('dt-carthian_target');
  if (cpTargetEl) responses['carthian_pull_target'] = cpTargetEl.value;
  const cpSphereEl = document.getElementById('dt-carthian_sphere');
  if (cpSphereEl) responses['carthian_pull_sphere'] = cpSphereEl.value;

  // NPCR.12: Personal Story target + moment note. Legacy osl_* / correspondence
  // fields are no longer written from new submissions; legacy submissions in
  // the DB are read by downstream renderers via fallback lookups.
  // Issue #105 (2026-05-08): gate writes on element presence so any
  // pre-existing legacy `story_moment_*` data on the spread base survives a
  // save when the legacy DOM elements are absent (the redesigned Personal
  // Story renderer no longer emits them). Drop-the-iteration / silent-leave
  // correctness — matches Lesson #105 discipline.
  const relIdEl = document.getElementById('dt-story_moment_relationship_id');
  const noteEl  = document.getElementById('dt-story_moment_note');
  if (relIdEl) responses['story_moment_relationship_id'] = relIdEl.value;
  if (noteEl)  responses['story_moment_note']            = noteEl.value;

  // Aspiration structured slots — admin section, ADVANCED only.
  if (!_isMinimal) {
    for (let n = 1; n <= 3; n++) {
      const typeEl = document.getElementById(`dt-aspiration_${n}_type`);
      const textEl = document.getElementById(`dt-aspiration_${n}_text`);
      responses[`aspiration_${n}_type`] = typeEl ? typeEl.value : '';
      responses[`aspiration_${n}_text`] = textEl ? textEl.value : '';
    }
  }

  // DTR.1: Game recount structured highlight slots (game_recount_1…5).
  // We also maintain a joined `game_recount` string (one highlight per line)
  // so ST admin views that still read the legacy key keep working, and so
  // the required-field validator has something to check.
  const highlights = [];
  for (let n = 1; n <= 5; n++) {
    const el = document.getElementById(`dt-game_recount_${n}`);
    const val = el ? el.value : '';
    responses[`game_recount_${n}`] = val;
    if (val.trim()) highlights.push(val.trim());
    // DTFP-7: per-slot mechanical-flag boolean
    const flagEl = document.getElementById(`dt-mechanical_flag_${n}`);
    if (flagEl) responses[`mechanical_flag_${n}`] = flagEl.checked;
  }
  if (highlights.length > 0) {
    responses['game_recount'] = highlights.map((h, i) => `${i + 1}. ${h}`).join('\n\n');
  }

  // Collect project slots
  // dt-form.17: in MINIMAL only the first slot is rendered; iterate just slot
  // 1 so slots 2-4 retain their prior values from the spread base.
  const projectSection = DOWNTIME_SECTIONS.find(s => s.key === 'projects');
  const projectSlotCount = _isMinimal ? 1 : (projectSection?.projectSlots || 4);
  for (let n = 1; n <= projectSlotCount; n++) {
    const actionEl = document.getElementById(`dt-project_${n}_action`);
    responses[`project_${n}_action`] = actionEl ? actionEl.value : '';
    // dt-form.24: secondary pool ('pool2') stripped per ADR §Audit-baseline.
    // Single-vs-dual roll selector removed; only the primary pool collects.
    // Legacy `_pool2_*` keys persist in `responses` via the spread base if a
    // pre-redesign draft had them — we don't unconditionally overwrite them
    // with empty strings (lesson from #105).
    for (const poolKey of ['pool']) {
      const prefix = `project_${n}_${poolKey}`;
      const attrEl = document.getElementById(`dt-${prefix}_attr`);
      const skillEl = document.getElementById(`dt-${prefix}_skill`);
      const discEl = document.getElementById(`dt-${prefix}_disc`);
      const specEl = document.getElementById(`dt-${prefix}_spec`);
      const attrName  = attrEl  ? attrEl.value  : '';
      const skillName = skillEl ? skillEl.value : '';
      const discName  = discEl  ? discEl.value  : '';
      const specName  = specEl  ? specEl.value  : '';
      responses[`${prefix}_attr`]  = attrName;
      responses[`${prefix}_skill`] = skillName;
      responses[`${prefix}_disc`]  = discName;
      responses[`${prefix}_spec`]  = specName;
      // Audit #198 — compose the human-readable pool expression admin's
      // action-queue renderer reads (downtime-views.js:2524, 2585, 2624,
      // 10240). Form previously wrote only the components; admin's
      // `_pool_expr` reads always fell back to '' so the project's
      // Player's Pool column rendered empty. Mirror the components into a
      // single expression string + numeric total so ST sees what the
      // player picked at a glance. Skipped silently when no component is
      // selected, so empty rows don't pollute the queue.
      if (attrName || skillName || discName) {
        const validSpec = !!(specName && skillName
          && (currentChar.skills?.[skillName]?.specs || []).includes(specName));
        const specBonus = validSpec ? (hasAoE(currentChar, specName) ? 2 : 1) : 0;
        let total = 0;
        if (attrName)  total += getAttrEffective(currentChar, attrName);
        if (skillName) total += skTotal(currentChar, skillName);
        if (discName)  total += discDots(currentChar, discName);
        total += specBonus;
        const parts = [attrName, skillName, discName].filter(Boolean);
        let expr = parts.join(' + ');
        if (validSpec) expr += ` (+${specBonus} ${specName})`;
        if (expr) expr += ` = ${total}`;
        responses[`${prefix}_expr`] = expr;
      } else {
        responses[`${prefix}_expr`] = '';
      }
    }
    const outcomeEl = document.getElementById(`dt-project_${n}_outcome`);
    const outcomeRadio = document.querySelector(`input[name="dt-project_${n}_outcome"]:checked`);
    const descEl = document.getElementById(`dt-project_${n}_description`);
    const titleEl = document.getElementById(`dt-project_${n}_title`);
    const terrEl = document.getElementById(`dt-project_${n}_territory`);
    const xpEl = document.getElementById(`dt-project_${n}_xp`);
    responses[`project_${n}_outcome`] = outcomeEl ? outcomeEl.value : (outcomeRadio ? outcomeRadio.value : '');
    responses[`project_${n}_description`] = descEl ? descEl.value : '';
    // Rote-locked slot: pull description from rote textarea
    if (feedRoteAction && n === feedRoteSlot) {
      const roteDescEl = document.getElementById('dt-rote-description');
      if (roteDescEl) responses[`project_${n}_description`] = roteDescEl.value;
      responses[`project_${n}_action`] = 'feed';
    }
    responses[`project_${n}_title`] = titleEl ? titleEl.value : '';
    // 496.2: remap territory slug (from pill widget) to OID; empty/unmapped pass through
    {
      const v = terrEl ? terrEl.value : '';
      responses[`project_${n}_territory`] = v ? (_terrOidMap.get(v) || v) : '';
    }
    responses[`project_${n}_xp`] = xpEl ? xpEl.value : '';
    const xpTraitEl = document.getElementById(`dt-project_${n}_xp_trait`);
    responses[`project_${n}_xp_trait`] = xpTraitEl ? xpTraitEl.value : '';
    // Issue #102 (2026-05-08): the legacy `_xp_category` / `_xp_item`
    // collect path was deleted alongside the dead-code-wrapped renderer.
    // Pre-existing legacy values on the spread base survive untouched
    // (silent-leave); the redesigned grid persists via `_xp_rows`.
    // dt-form.26: collect this slot's multi-row XP-Spend grid. Read row
    // values directly from the slot-scoped grid container; legacy single-row
    // placeholder fields (`_xp_dots`, `_xp_category`, `_xp_item`) are no
    // longer written here. Backward-compat fallback: if the slot has no
    // grid mounted (action just flipped to xp_spend, render hasn't fired
    // yet) preserve any prior `_xp_rows` from the spread base.
    if (responses[`project_${n}_action`] === 'xp_spend') {
      const slotGrid = document.querySelector(`[data-proj-xp-grid="${n}"]`);
      if (slotGrid) {
        const rows = [];
        slotGrid.querySelectorAll('[data-xp-row]').forEach(rowEl => {
          const catEl  = rowEl.querySelector('[data-xp-cat]');
          const itemEl = rowEl.querySelector('[data-xp-item]');
          const dotsEl = rowEl.querySelector('[data-xp-dots]');
          const category = catEl ? catEl.value : '';
          const item     = itemEl ? itemEl.value : '';
          const dotsBuying = dotsEl ? (parseInt(dotsEl.value, 10) || 0) : 0;
          if (category) rows.push({ category, item, dotsBuying, xpCost: getRowCost({ category, item, dotsBuying }) });
        });
        responses[`project_${n}_xp_rows`] = JSON.stringify(rows);
      }
      // Drop the legacy `_xp_dots` placeholder; persist '0' so legacy ST
      // readers see "no dots" rather than the stale "1" sentinel.
      responses[`project_${n}_xp_dots`] = '0';
    } else {
      // Slot is no longer xp_spend; clear the rows JSON so stale data doesn't
      // contaminate the top-level mirror.
      if (responses[`project_${n}_xp_rows`]) responses[`project_${n}_xp_rows`] = '';
    }
    // dt-form.22 fix-up (Ma'at PR #98 review, bug 3): write
    // `project_N_feed_method2` whenever the slot's action is `rote`. Migration
    // helper handles legacy submissions; this covers fresh ROTE saves so ST
    // consumers (feeding-tab.js:350, admin/downtime-views.js:2569) read the
    // method directly rather than seeing undefined.
    if (responses[`project_${n}_action`] === 'rote' && feedMethodId) {
      responses[`project_${n}_feed_method2`] = feedMethodId;
    }
    // Target zone (unified: attack, hide_protect, investigate, patrol_scout, misc)
    const targetTypeRadio = document.querySelector(`input[name="dt-project_${n}_target_type"]:checked`);
    if (targetTypeRadio) responses[`project_${n}_target_type`] = targetTypeRadio.value;
    // Issue #170 (2026-05-08): gate target_* writes on element presence
    // (Lesson #105 silent-leave). When a slot's action doesn't render the
    // target_* hidden inputs (e.g. action changed away from maintenance),
    // the prior value persists on the spread base instead of being clobbered
    // with empty. Action-change handlers that DO need to clear targets can
    // do so explicitly via the canonical-first state write pattern.
    const targetValueEl = document.getElementById(`dt-project_${n}_target_value`);
    if (targetValueEl) responses[`project_${n}_target_value`] = targetValueEl.value;
    const targetTerrEl = document.getElementById(`dt-project_${n}_target_terr`);
    if (targetTerrEl) {
      // 496.2: remap territory slug to OID; empty/unmapped pass through
      const v = targetTerrEl.value;
      responses[`project_${n}_target_terr`] = v ? (_terrOidMap.get(v) || v) : '';
    }
    const targetOtherEl = document.getElementById(`dt-project_${n}_target_other`);
    if (targetOtherEl) responses[`project_${n}_target_other`] = targetOtherEl.value;
    // dt-form.25: legacy `_ambience_dir` radio collect dropped (drop-the-
    // iteration shape per Ma'at #127 praise). The new row-table writes
    // `_ambience_target` + `_ambience_direction` directly via the hidden
    // inputs below. Pre-existing legacy `_ambience_dir` values persist on
    // the doc via the spread base (silent-leave per A1).
    const ambTargetEl = document.getElementById(`dt-project_${n}_ambience_target`);
    const ambDirEl    = document.getElementById(`dt-project_${n}_ambience_direction`);
    if (ambTargetEl) {
      // 496.2: remap territory slug to OID; empty/unmapped pass through
      const v = ambTargetEl.value;
      responses[`project_${n}_ambience_target`] = v ? (_terrOidMap.get(v) || v) : '';
    }
    if (ambDirEl)    responses[`project_${n}_ambience_direction`] = ambDirEl.value;
    const leadEl = document.getElementById(`dt-project_${n}_investigate_lead`);
    responses[`project_${n}_investigate_lead`] = leadEl ? leadEl.value : '';

    // Cast checkboxes (inline grid)
    const castCbs = document.querySelectorAll(`.dt-cast-proj-cb[data-cast-slot="${n}"]:checked`);
    const castIds = [];
    castCbs.forEach(cb => { if (cb.value) castIds.push(cb.value); });
    responses[`project_${n}_cast`] = JSON.stringify(castIds);

    // Merit checkboxes
    const meritCbs = document.querySelectorAll(`[data-proj-merit-cb="${n}"]:checked`);
    const meritKeys = [];
    meritCbs.forEach(cb => meritKeys.push(cb.value));
    responses[`project_${n}_merits`] = JSON.stringify(meritKeys);

  }

  // dt-form.17: collection of ADVANCED-only sections (sorcery, spheres,
  // status, contacts, retainers, acquisitions, equipment, skill acq) is
  // skipped in MINIMAL mode. Their prior values stay intact via the spread.
  if (!_isMinimal) {

  // Collect sorcery slots (dynamic count)
  const sorceryCountEl = document.getElementById('dt-sorcery-slot-count');
  const sorcerySlotCount = sorceryCountEl ? parseInt(sorceryCountEl.value, 10) || 1 : 1;
  responses['sorcery_slot_count'] = String(sorcerySlotCount);
  for (let n = 1; n <= sorcerySlotCount; n++) {
    const riteEl = document.getElementById(`dt-sorcery_${n}_rite`);
    // When the sorcery section is not rendered (e.g. minimal mode), preserve the
    // prior value rather than overwriting with '' — this keeps seeded/locked rites
    // intact across a minimal→advanced mode switch.
    responses[`sorcery_${n}_rite`] = riteEl ? riteEl.value : (_prior[`sorcery_${n}_rite`] ?? '');
    // DTFP-6: collect structured target rows for this sorcery slot.
    // Persisted shape: array of {type, value} objects, omitting empty rows.
    const targetsBlock = document.querySelector(`[data-sorcery-slot-targets="${n}"]`);
    if (targetsBlock) {
      const arr = [];
      targetsBlock.querySelectorAll('.dt-sorcery-target-row').forEach((row, ti) => {
        const typeEl = row.querySelector(`input[name="dt-sorcery_${n}_targets_${ti}_type"]:checked`);
        const valEl  = row.querySelector(`#dt-sorcery_${n}_targets_${ti}_value`);
        const type = typeEl ? typeEl.value : '';
        const value = valEl ? (valEl.value || '').trim() : '';
        if (type) arr.push({ type, value });
      });
      responses[`sorcery_${n}_targets`] = JSON.stringify(arr);
    } else {
      // No DOM block (slot not currently rendered) — preserve any previously-saved value
      const prior = responseDoc?.responses?.[`sorcery_${n}_targets`];
      if (prior !== undefined) responses[`sorcery_${n}_targets`] = prior;
    }
    const notesEl = document.getElementById(`dt-sorcery_${n}_notes`);
    responses[`sorcery_${n}_notes`] = notesEl ? notesEl.value : '';
    const mandEl = document.getElementById(`dt-sorcery_${n}_mandragora`);
    // Same preserve-prior logic: when section is absent, keep the prior value.
    responses[`sorcery_${n}_mandragora`] = mandEl ? (mandEl.checked ? 'yes' : 'no') : (_prior[`sorcery_${n}_mandragora`] ?? 'no');
  }

  // Residency is now managed in the Regency tab (regency-tab.js)

  // Collect merit toggle states and dynamic section responses
  const allMerits = [...detectedMerits.spheres, ...detectedMerits.contacts, ...detectedMerits.retainers];
  for (const m of allMerits) {
    const key = meritKey(m);
    responses[`_merit_${key}`] = gateValues[`merit_${key}`] || 'no';
  }

  // Sphere action fields (tabbed — up to 5 slots)
  const maxSpheres = Math.min(detectedMerits.spheres.length, 5);
  for (let n = 1; n <= maxSpheres; n++) {
    for (const suffix of ['action', 'outcome', 'description', 'territory', 'block_merit', 'project_support', 'investigate_lead', 'grow_target']) {
      const el = document.getElementById(`dt-sphere_${n}_${suffix}`);
      if (!el) continue;
      if (suffix === 'territory') {
        // 496.2: remap territory slug to OID; empty/unmapped pass through
        const v = el.value;
        responses[`sphere_${n}_${suffix}`] = v ? (_terrOidMap.get(v) || v) : '';
      } else {
        responses[`sphere_${n}_${suffix}`] = el.value;
      }
    }
    // Ambience direction (radio) — when sphere action is ambience_change, resolve
    // to legacy ambience_increase/ambience_decrease so downstream code is untouched.
    const dirEl = document.querySelector(`input[name="dt-sphere_${n}_ambience_dir"]:checked`);
    const ambienceDir = dirEl ? dirEl.value : '';
    responses[`sphere_${n}_ambience_dir`] = ambienceDir;
    if (responses[`sphere_${n}_action`] === 'ambience_change') {
      responses[`sphere_${n}_action`] = ambienceDir === 'degrade' ? 'ambience_decrease' : 'ambience_increase';
    }
    const flexRadio = document.querySelector(`input[name="dt-sphere_${n}_target_type"]:checked`);
    responses[`sphere_${n}_target_type`] = flexRadio ? flexRadio.value : '';
    const sphTargetCbs = document.querySelectorAll(`.dt-target-char-sphere-cb[data-target-slot="sphere_${n}"]:checked`);
    if (sphTargetCbs.length) {
      const ids = []; sphTargetCbs.forEach(cb => ids.push(cb.value));
      responses[`sphere_${n}_target_value`] = JSON.stringify(ids);
    } else {
      const el = document.getElementById(`dt-sphere_${n}_target_value`);
      if (el) responses[`sphere_${n}_target_value`] = el.value;
    }
    // Merit label — written whenever the player has picked an action.
    // Issue #713: old form had a merit-toggle gate ('yes'/'no') that set
    // gateValues; the tabbed sphere UI removed that toggle, so the gate is
    // never 'yes'. Match the Status pattern (line ~885): write when action set.
    const m = detectedMerits.spheres[n - 1];
    if (m && responses[`sphere_${n}_action`]) {
      responses[`sphere_${n}_merit`] = meritLabel(m);
    }
    // Cast hidden inputs (legacy — kept for backwards compat)
    const castHidden = document.querySelectorAll(`input[type="hidden"][data-sphere-cast-cb="${n}"]`);
    const castIds = [];
    castHidden.forEach(el => { if (el.value) castIds.push(el.value); });
    responses[`sphere_${n}_cast`] = JSON.stringify(castIds);
  }

  // Status action fields
  const maxStatus = Math.min(detectedMerits.status.length, 5);
  for (let n = 1; n <= maxStatus; n++) {
    for (const suffix of ['action', 'outcome', 'description', 'territory', 'investigate_lead']) {
      const el = document.getElementById(`dt-status_${n}_${suffix}`);
      if (el) responses[`status_${n}_${suffix}`] = el.value;
    }
    const stTargetCbs = document.querySelectorAll(`.dt-target-char-sphere-cb[data-target-slot="status_${n}"]:checked`);
    if (stTargetCbs.length) {
      const ids = []; stTargetCbs.forEach(cb => ids.push(cb.value));
      responses[`status_${n}_target_value`] = JSON.stringify(ids);
    } else {
      const el = document.getElementById(`dt-status_${n}_target_value`);
      if (el) responses[`status_${n}_target_value`] = el.value;
    }
    const flexRadio = document.querySelector(`input[name="dt-status_${n}_target_type"]:checked`);
    responses[`status_${n}_target_type`] = flexRadio ? flexRadio.value : '';
    // Ambience direction (radio) — resolve ambience_change to legacy values
    const stDirEl = document.querySelector(`input[name="dt-status_${n}_ambience_dir"]:checked`);
    const stAmbienceDir = stDirEl ? stDirEl.value : '';
    responses[`status_${n}_ambience_dir`] = stAmbienceDir;
    if (responses[`status_${n}_action`] === 'ambience_change') {
      responses[`status_${n}_action`] = stAmbienceDir === 'degrade' ? 'ambience_decrease' : 'ambience_increase';
    }
    // Merit label — only written when player picked an action.
    // Absent label means admin queue builder skips this slot entirely.
    const sm = detectedMerits.status[n - 1];
    if (sm && responses[`status_${n}_action`]) {
      responses[`status_${n}_merit`] = meritLabel(sm);
    }
  }

  // Contact fields (expandable table — up to 5)
  const maxContacts = Math.min(detectedMerits.contacts.length, 5);
  for (let n = 1; n <= maxContacts; n++) {
    const infoEl = document.getElementById(`dt-contact_${n}_info`);
    const reqEl = document.getElementById(`dt-contact_${n}_request`);
    const meritEl = document.getElementById(`dt-contact_${n}_merit`);
    responses[`contact_${n}_info`] = infoEl ? infoEl.value : '';
    responses[`contact_${n}_request`] = reqEl ? reqEl.value : '';
    responses[`contact_${n}_merit`] = meritEl ? meritEl.value : '';
    // Backwards compat: also store combined value in old key
    const combined = [responses[`contact_${n}_info`], responses[`contact_${n}_request`]].filter(Boolean).join('\n');
    responses[`contact_${n}`] = combined;
  }

  // Retainer fields (expandable table)
  const maxRetainers = detectedMerits.retainers.length;
  for (let n = 1; n <= maxRetainers; n++) {
    const typeEl = document.getElementById(`dt-retainer_${n}_type`);
    const taskEl = document.getElementById(`dt-retainer_${n}_task`);
    const meritEl = document.getElementById(`dt-retainer_${n}_merit`);
    // Preserve prior task data when the retainer row is locked into support
    // mode (its inputs are not rendered, so reading them would wipe the data).
    const priorType = responseDoc?.responses?.[`retainer_${n}_type`] || '';
    const priorTask = responseDoc?.responses?.[`retainer_${n}_task`] || '';
    responses[`retainer_${n}_type`] = typeEl ? typeEl.value : priorType;
    responses[`retainer_${n}_task`] = taskEl ? taskEl.value : priorTask;
    responses[`retainer_${n}_merit`] = meritEl ? meritEl.value : '';
    // Backwards compat: combined value in old key
    const combined = [responses[`retainer_${n}_type`], responses[`retainer_${n}_task`]].filter(Boolean).join('\n');
    responses[`retainer_${n}`] = combined;
  }

  // dt-form.28: Mentor fields (per-merit, mirrors Retainer pattern).
  // Hidden charPicker target id is auto-written by the picker's onChange;
  // we read it here for canonical persistence on collect.
  const maxMentors = detectedMerits.mentors.length;
  for (let n = 1; n <= maxMentors; n++) {
    const targetEl = document.getElementById(`dt-mentor_${n}_target`);
    const taskEl = document.getElementById(`dt-mentor_${n}_task`);
    const meritEl = document.getElementById(`dt-mentor_${n}_merit`);
    responses[`mentor_${n}_target`] = targetEl ? targetEl.value : '';
    responses[`mentor_${n}_task`] = taskEl ? taskEl.value : '';
    responses[`mentor_${n}_merit`] = meritEl ? meritEl.value : '';
  }

  // dt-form.28: Staff fields (per-dot, mirrors Contacts per-slot pattern).
  // Total slots = sum of effective ratings across all detected Staff merits.
  const totalStaffDots = detectedMerits.staff.reduce(
    (s, m) => s + (meritEffectiveRating(currentChar, m) || 0), 0
  );
  for (let n = 1; n <= totalStaffDots; n++) {
    const targetEl = document.getElementById(`dt-staff_${n}_target`);
    const taskEl = document.getElementById(`dt-staff_${n}_task`);
    const meritEl = document.getElementById(`dt-staff_${n}_merit`);
    responses[`staff_${n}_target`] = targetEl ? targetEl.value : '';
    responses[`staff_${n}_task`] = taskEl ? taskEl.value : '';
    responses[`staff_${n}_merit`] = meritEl ? meritEl.value : '';
  }

  // dt-form.29: structured-row collect for the redesigned Acquisitions
  // section. Reads `data-acq-row="resource_${i}"` / `="skill_${i}"` row
  // containers and extracts the canonical row arrays. Then the mirror
  // builder rebuilds every legacy key in the consumer→key map (see PR
  // body for the inventory) so existing admin/parser/db readers keep
  // working unchanged. Idempotent both ways: re-running on the same DOM
  // produces the same output.
  const _collectAcqRows = (rowKey) => {
    const out = [];
    document.querySelectorAll(`[data-acq-row-key="${rowKey}"][data-acq-row]`).forEach(rowEl => {
      const idx = rowEl.dataset.acqRowIdx;
      const descEl = rowEl.querySelector(`[data-acq-desc="${rowKey}_${idx}"]`);
      const availEl = rowEl.querySelector(`[data-acq-avail-hidden="${rowKey}_${idx}"]`);
      const merits = [];
      rowEl.querySelectorAll(`[data-acq-merit-cb][data-acq-row-key="${rowKey}"][data-acq-row-idx="${idx}"]:checked`)
        .forEach(cb => { if (cb.value) merits.push(cb.value); });
      const description = descEl ? descEl.value : '';
      const availability = availEl ? availEl.value : '';
      const row = { description, availability, merits };
      if (rowKey === 'skill') {
        const skillEl = rowEl.querySelector(`[data-acq-skill="${idx}"]`);
        const specEl  = rowEl.querySelector(`[data-acq-skill-spec-hidden="${idx}"]`);
        row.skill = skillEl ? skillEl.value : '';
        row.spec  = specEl  ? specEl.value  : '';
      }
      out.push(row);
    });
    return out;
  };

  const resourceRows = _collectAcqRows('resource');
  const skillRows = _collectAcqRows('skill');

  // Persist canonical rows. If the DOM didn't render any rows (section
  // collapsed off-screen or load timing edge), preserve prior arrays via
  // the spread base — don't clobber with empty.
  if (resourceRows.length) responses['acq_resource_rows'] = JSON.stringify(resourceRows);
  if (skillRows.length)    responses['acq_skill_rows']    = JSON.stringify(skillRows);

  // ── Mirror builder: rebuild legacy keys for back-compat consumers ──
  // Consumer→key map (see PR body for the inventory):
  //   acq_slot_count, acq_${N}_description, acq_${N}_availability, acq_${N}_merits
  //   acq_description, acq_availability, acq_merits      (legacy single = row 0)
  //   resources_acquisitions                             (blob, downtime-views/story-tab)
  //   skill_acq_description, skill_acq_pool_skill, skill_acq_pool_spec,
  //   skill_acq_availability, skill_acq_merits           (legacy single skill = row 0)
  //   skill_acquisitions                                 (blob, downtime-views/parser)
  // skill_acq_pool_attr is intentionally NOT mirrored — post-#42 dropped.
  // Issue #120 (2026-05-08): defensive symmetry with the canonical writes
  // above — when the DOM has no rows (section never rendered, or a future
  // pure-API caller bypasses the form), don't overwrite legacy keys with
  // empty values. Any existing legacy data on the spread base passes
  // through unchanged.
  if (resourceRows.length || skillRows.length) {
  const _rrows = resourceRows.length ? resourceRows : [];
  responses['acq_slot_count'] = String(Math.max(1, _rrows.length));
  // Per-slot keys (1-indexed). Always write at least slot 1.
  const _maxSlot = Math.max(1, _rrows.length);
  for (let n = 1; n <= _maxSlot; n++) {
    const r = _rrows[n - 1] || { description: '', availability: '', merits: [] };
    responses[`acq_${n}_description`]  = r.description || '';
    responses[`acq_${n}_availability`] = r.availability || '';
    responses[`acq_${n}_merits`]       = JSON.stringify(r.merits || []);
  }
  // Legacy single-row mirror = row 0.
  const _r0 = _rrows[0] || { description: '', availability: '', merits: [] };
  responses['acq_description']  = _r0.description || '';
  responses['acq_availability'] = _r0.availability || '';
  responses['acq_merits']       = JSON.stringify(_r0.merits || []);
  // Composite blob (resources_acquisitions). Same format as the legacy builder.
  const _resourcesM = (currentChar.merits || []).find(m => m.name === 'Resources');
  const _resourcesRating = meritEffectiveRating(currentChar, _resourcesM);
  const _blobLines = [];
  if (_resourcesRating) _blobLines.push(`Resources ${_resourcesRating}`);
  if (_rrows.length === 1) {
    const s = _rrows[0];
    if (s.merits && s.merits.length) _blobLines.push(`Merits: ${s.merits.join(', ')}`);
    if (s.description)   _blobLines.push(s.description);
    if (s.availability)  _blobLines.push(`Availability: ${s.availability === 'unknown' ? 'Unknown' : s.availability + '/5'}`);
  } else if (_rrows.length > 1) {
    _rrows.forEach((s, i) => {
      _blobLines.push('');
      _blobLines.push(`--- Item ${i + 1} ---`);
      if (s.merits && s.merits.length) _blobLines.push(`Merits: ${s.merits.join(', ')}`);
      if (s.description)   _blobLines.push(s.description);
      if (s.availability)  _blobLines.push(`Availability: ${s.availability === 'unknown' ? 'Unknown' : s.availability + '/5'}`);
    });
  }
  responses['resources_acquisitions'] = _blobLines.join('\n').replace(/^\n/, '').trim();

  // Skill mirror = row 0 of acq_skill_rows.
  const _s0 = skillRows[0] || { skill: '', spec: '', description: '', availability: '', merits: [] };
  responses['skill_acq_description']  = _s0.description || '';
  responses['skill_acq_pool_skill']   = _s0.skill || '';
  responses['skill_acq_pool_spec']    = _s0.spec || '';
  responses['skill_acq_availability'] = _s0.availability || '';
  responses['skill_acq_merits']       = JSON.stringify(_s0.merits || []);
  // skill_acquisitions blob — same composition as the legacy builder.
  const _skPoolStr = skillAcqPoolStr(currentChar, {
    skill: responses['skill_acq_pool_skill'],
    spec:  responses['skill_acq_pool_spec'],
  });
  responses['skill_acquisitions'] = [
    responses['skill_acq_description'],
    _skPoolStr ? `Pool: ${_skPoolStr}` : '',
    responses['skill_acq_availability']
      ? `Availability: ${responses['skill_acq_availability'] === 'unknown' ? 'Unknown' : responses['skill_acq_availability'] + '/5'}`
      : '',
  ].filter(Boolean).join('\n');
  } // end if (resourceRows.length || skillRows.length) — issue #120

  // Collect equipment slots (skipped when hidden — prior values preserved via _prior spread).
  // ECM-4 (#871): the canonical persistence key is `equipment_${n}_catalogue_id` (24-hex
  // ObjectId string). The legacy `equipment_${n}_name` key is no longer written by the
  // form. Pre-ECM-4 submissions in the responses spread base still carry that key; we
  // leave it intact (silent-leave) so the admin DT processing UI can fall back to it
  // for in-flight submissions per Khepri's backcompat guidance.
  if (!DOWNTIME_SECTIONS.find(s => s.key === 'equipment')?.hidden) {
    const equipCountEl = document.getElementById('dt-equipment-slot-count');
    const equipSlotCount = equipCountEl ? parseInt(equipCountEl.value, 10) || 1 : 1;
    responses['equipment_slot_count'] = String(equipSlotCount);
    for (let n = 1; n <= equipSlotCount; n++) {
      const catSelectEl = document.getElementById(`dt-equipment_${n}_catalogue_id`);
      const qtyEl = document.getElementById(`dt-equipment_${n}_qty`);
      const notesEl = document.getElementById(`dt-equipment_${n}_notes`);
      responses[`equipment_${n}_catalogue_id`] = catSelectEl ? catSelectEl.value : '';
      responses[`equipment_${n}_qty`] = qtyEl ? qtyEl.value : '';
      responses[`equipment_${n}_notes`] = notesEl ? notesEl.value : '';
    }
    // ECM-9 (#876): item_request — optional free-text escape valve.
    const itemReqEl = document.getElementById('dt-item-request');
    responses['item_request'] = itemReqEl ? itemReqEl.value : '';
  }

  } // end if (!_isMinimal) — ADVANCED-only collection

  // dt-form.26 (DAR-A1): mirror per-slot XP-spend rows into the legacy
  // top-level `responses.xp_spend` JSON array so existing readers
  // (player-side budget validator at submitForm:1263, ST review at
  // admin/downtime-views.js:3637) keep working unchanged. The per-slot
  // shape is canonical post-redesign; this rebuilds top-level on every
  // save. If no slot has xp_spend rows, the legacy top-level value (from
  // the spread base) passes through untouched — preserves any in-flight
  // legacy data until the player engages the redesigned UI.
  let _hasAnyXpRows = false;
  const _topLevelMirror = [];
  for (let s = 1; s <= 4; s++) {
    if (responses[`project_${s}_action`] !== 'xp_spend') continue;
    let slotRows = [];
    const rj = responses[`project_${s}_xp_rows`] || '';
    if (rj) {
      try { slotRows = JSON.parse(rj); } catch { slotRows = []; }
    }
    if (slotRows.length) {
      _hasAnyXpRows = true;
      for (const r of slotRows) {
        if (!r || !r.category) continue;
        _topLevelMirror.push(r);
      }
    }
  }
  if (_hasAnyXpRows) {
    responses['xp_spend'] = JSON.stringify(_topLevelMirror);
    responses['xp_budget_snapshot'] = xpLeft(currentChar);
  }

  return responses;
}

function _saveTimestamp() {
  const now = new Date();
  return now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
}

async function saveDraft() {
  const statusEl = document.getElementById('dt-save-status');
  if (!currentCycle) {
    if (statusEl) statusEl.textContent = 'No active cycle — contact your ST';
    return;
  }
  if (currentCycle._id === 'dev-stub') {
    if (statusEl) statusEl.textContent = '[Dev] Save skipped';
    return;
  }
  if (statusEl) statusEl.textContent = 'Saving…';
  const responses = collectResponses();

  // dt-form.17 (ADR-003 §Q3, §Q4): hard-mirror lifecycle. Compute the
  // derived bool, persist on responses, and on transition mirror to
  // submission.status + attendance.downtime.
  const completenessCtx = _completenessCtx();
  const hasMinimum = isMinimalComplete(responses, completenessCtx);
  responses._has_minimum = hasMinimum;
  const priorHasMinimum = !!responseDoc?.responses?._has_minimum;
  const flipped = priorHasMinimum !== hasMinimum;
  const nextStatus = hasMinimum ? 'submitted' : 'draft';

  try {
    if (!responseDoc?._id) {
      responseDoc = await apiPost('/api/downtime_submissions', {
        character_id: currentChar._id,
        character_name: currentChar.name,
        cycle_id: currentCycle._id,
        status: nextStatus,
        responses,
      });
    } else {
      // Include status in the body so a status flip and the responses write
      // land in the same PUT — saves a round-trip and keeps the two fields
      // consistent on retry.
      const body = flipped ? { responses, status: nextStatus } : { responses };
      responseDoc = await apiPut(`/api/downtime_submissions/${responseDoc._id}`, body);
    }
    // Residency is now saved in the Regency tab
    if (statusEl) statusEl.textContent = 'Saved ' + _saveTimestamp();
    // DTU-2: server now has the truth, drop the local mirror.
    _clearLocalSnapshot();

    // dt-form.17: mirror to attendance.downtime on transition. Idempotent —
    // we still send the PATCH on flip, even if the bool is the same as last
    // time (e.g. on a fresh form load with no prior state).
    if (flipped && _activeGameSessionId && currentChar?._id) {
      try {
        await apiPatch(
          `/api/attendance/${encodeURIComponent(_activeGameSessionId)}/${encodeURIComponent(String(currentChar._id))}`,
          { downtime: hasMinimum }
        );
        // Local cache for XP-Available annotation; also flips the player
        // sheet's _gameXP on the next loadGameXP call.
        currentChar._dtHoldFlag = !hasMinimum;
      } catch {
        // Non-fatal — the bool can be reconciled at cycle-close. The 423
        // gate handler logs to status if cycle is closed.
      }
    } else if (currentChar) {
      currentChar._dtHoldFlag = !hasMinimum;
    }

  } catch (err) {
    // dt-form.17 §Q11: surface the cycle-close 423 with a stable message.
    if (err && /CYCLE_CLOSED|423|Cycle is closed/i.test(err.message || '')) {
      if (statusEl) statusEl.textContent = 'Cycle closed; submission locked';
    } else if (statusEl) {
      statusEl.textContent = 'Save failed: ' + err.message;
    }
  }
}

async function submitForm() {
  const responses = collectResponses();
  const btn = document.getElementById('dt-btn-submit');

  // Validate required fields
  const missing = [];
  for (const section of DOWNTIME_SECTIONS) {
    if (section.gate && gateValues[section.gate] !== 'yes') continue;
    for (const q of (section.questions || [])) {
      if (!q.required) continue;
      // DTR.1: highlight_slots validates to "at least one slot has content"
      if (q.type === 'highlight_slots') {
        const hasAny = [1, 2, 3, 4, 5].some(n => (responses[`${q.key}_${n}`] || '').trim());
        if (!hasAny) missing.push(q.label || q.key);
        continue;
      }
      const val = responses[q.key];
      if (!val || (typeof val === 'string' && !val.trim())) {
        missing.push(q.label || q.key);
      }
    }
  }
  // DTFP-4: feeding-method requirement dropped — pool components are the gate now
  // (the existing pool-validation logic already flags incomplete attr/skill/disc).
  // Feeding territory is required
  const territories = (() => { try { return JSON.parse(responses['feeding_territories'] || '{}'); } catch { return {}; } })();
  if (!Object.values(territories).some(v => v && v !== 'none')) missing.push('Feeding Territory');

  if (missing.length) {
    showToast(`Please complete required fields before submitting: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ''}.`, 'error');
    return;
  }

  // AC2: Validate XP spend against available budget before submitting
  const xpRows = JSON.parse(responses.xp_spend || '[]');
  const xpSpent = xpRows.reduce((sum, r) => sum + getRowCost(r), 0);
  const xpBudget = xpLeft(currentChar);
  if (xpSpent > xpBudget) {
    showToast(`XP over budget: spending ${xpSpent} XP but only ${xpBudget} available.`, 'error');
    return;
  }

  // Visual feedback — disable button, show loading
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting\u2026'; }

  try {
    if (!responseDoc?._id) {
      responseDoc = await apiPost('/api/downtime_submissions', {
        character_id: currentChar._id,
        character_name: currentChar.name,
        cycle_id: currentCycle?._id || null,
        status: 'submitted',
        responses,
        submitted_at: new Date().toISOString(),
      });
    } else {
      responseDoc = await apiPut(`/api/downtime_submissions/${responseDoc._id}`, {
        responses,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
      });
    }
    // #506: write-through Safe Place locations to the character so they persist
    // across cycles. Submit-time only (not autosave). Soft-fail in its own
    // try/catch — a location write error must never undo or block the
    // already-saved submission. Values come from `responses` (collected at
    // collectResponses), falling back to the merit's stored location.
    try {
      const _safePlaces = (currentChar?.merits || [])
        .filter(m => m.category === 'domain' && m.name === 'Safe Place');
      if (_safePlaces.length && currentChar?._id) {
        const locations = _safePlaces.map((sp, i) => {
          const v = responses['safe_place_location_' + i];
          return (v !== undefined && v !== null) ? v : (sp.location || '');
        });
        const updated = await apiPatch(
          `/api/characters/${encodeURIComponent(String(currentChar._id))}/safe_place_locations`,
          { locations },
        );
        // Refresh in-memory merits so a same-session re-render shows stored values.
        if (updated && Array.isArray(updated.merits)) currentChar.merits = updated.merits;
      }
    } catch (locErr) {
      console.warn('Safe-place location persist failed (submission still saved):', locErr);
    }
    showToast('Downtime submitted successfully!', 'success');
    // DTU-2: submission completed, local mirror no longer needed.
    _clearLocalSnapshot();
    renderForm(document.getElementById('dt-container'));
  } catch (err) {
    showToast('Submit failed: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Submit Downtime'; }
  }
}

function showToast(message, type) {
  // Remove any existing toast
  document.getElementById('dt-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'dt-toast';
  toast.className = `dt-toast dt-toast-${type || 'info'}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('dt-toast-show'));
  setTimeout(() => {
    toast.classList.remove('dt-toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Story 1.10: Player-facing results view ────────────────────────────────────

/**
 * Render published downtime results for the player.
 * outcome_text is a markdown-style string with ## section headers.
 */
function renderDowntimeResults(outcomeText, sub) {
  const sections = parseOutcomeSections(outcomeText);

  let h = '<div class="qf-results">';
  h += '<h3 class="qf-results-title">Downtime Results</h3>';

  for (const sec of sections) {
    if (!sec.heading) {
      h += `<div class="qf-results-body"><p>${esc(sec.lines.join('\n').trim())}</p></div>`;
    } else {
      const isMech = sec.heading === 'Mechanical Outcomes';
      h += `<div class="qf-results-section${isMech ? ' qf-results-mech' : ''}">`;
      h += `<h4 class="qf-results-section-head">${esc(sec.heading)}</h4>`;
      const body = sec.lines.join('\n').trim();
      if (isMech) {
        h += `<pre class="qf-results-pre">${esc(body)}</pre>`;
      } else {
        const paras = body.split(/\n{2,}/).filter(Boolean);
        h += paras.map(p => `<p>${esc(p.replace(/\n/g, ' '))}</p>`).join('');
      }
      h += '</div>';
    }
  }

  h += '</div>';
  return h;
}

export async function renderDowntimeTab(targetEl, char, territories, options = {}) {
  currentChar = char;
  // Issue #259 (perf, 2026-05-11): the two fresh-fetches below cost an
  // /api/characters/<id> + /api/territories round-trip per call. Callers
  // that already loaded both seconds ago (selectCharacter in player.js,
  // and the More-grid tab init in downtime-tab.js) can opt out by
  // passing `options.skipFreshFetch: true`. Default stays `false` so
  // any future caller without pre-loaded data (e.g. page-reload-into-
  // DT-tab via a direct deep link) keeps the existing fresh-load
  // behaviour and the #184 _gameXP-preservation merge.
  if (!options.skipFreshFetch) {
    try {
      const fresh = await apiGet(`/api/characters/${encodeURIComponent(String(char._id))}`);
      // Issue #184 (2026-05-08): merge server data over the cached `char`
      // object instead of replacing the reference wholesale. `_gameXP` (set
      // by loadGameXP() before the form opens) and any other underscore-
      // prefixed ephemeral state are NOT persisted to MongoDB, so the fresh
      // API response doesn't carry them — wholesale `currentChar = fresh`
      // would silently zero out xpGame() and short xpEarned()/xpLeft() by
      // the full game-XP total. Mirrors the existing admin.js:548 pattern.
      Object.assign(char, fresh);
      currentChar = char;
    } catch { /* silent — stale char is better than a broken form */ }
  }
  if (currentChar) applyDerivedMerits(currentChar);
  // Issue #259: when callers pre-load territories (the common path from
  // selectCharacter + More-grid), skip the redundant /api/territories
  // fetch and reuse the supplied list directly. The `|| []` guard
  // preserves the existing fallback behaviour for callers that pass
  // `null` or omit the arg.
  if (options.skipFreshFetch) {
    _territories = territories || [];
  } else {
    try {
      _territories = await apiGet('/api/territories');
    } catch {
      _territories = territories || [];
    }
  }
  responseDoc = null;
  currentCycle = null;
  gateValues = {};

  // Load current cycle — priority: active > game > prep > closed > anything
  try {
    const cycles = await apiGet('/api/downtime_cycles');
    const sorted = cycles.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const LIVE_STATUSES = ['active', 'game', 'prep'];
    currentCycle = sorted.find(c => LIVE_STATUSES.includes(c.status))
      || sorted.find(c => c.status === 'closed')
      || sorted[0]
      || null;
  } catch { /* no cycles */ }

  // Dev bypass: on localhost, coerce non-active cycles to 'active' for the
  // form's other status gates, but preserve the underlying cycle's data
  // (is_chapter_finale, maintenance_audit, etc.) so dev-time testing of
  // those features works. Stub fallback still applies when no cycle exists.
  if (currentCycle && currentCycle.status !== 'active' && location.hostname === 'localhost') {
    currentCycle = { ...currentCycle, status: 'active' };
  }
  if (!currentCycle && location.hostname === 'localhost') {
    currentCycle = { _id: 'dev-stub', status: 'active', label: '[Dev Preview]', feeding_rights_confirmed: true };
  }

  // dt-form.33: removed two NPC-DB data loads. The legacy
  // `/api/npcs/for-character/...` fetch fed `_linkedNpcs` for the legacy
  // renderer (deleted), and `/api/relationships/for-character/...` fed
  // `_myRelationships` for the story-moment relationship picker (deleted).
  // Saves two API round-trips per form load.

  // Load existing submission for this character + cycle
  priorPublishedLabel = null;
  if (currentCycle) {
    try {
      const subs = await apiGet(`/api/downtime_submissions?cycle_id=${currentCycle._id}`);
      _allSubmissions = subs || [];
      responseDoc = subs.find(s =>
        s.character_id === currentChar._id || s.character_id?.toString() === currentChar._id?.toString()
      ) || null;
      if (responseDoc) _promotePublishedOutcome(responseDoc);
      // dt-form.22: translate legacy ROTE state on first read. Once any
      // save fires, the document persists in the new shape.
      if (responseDoc?.responses) _migrateLegacyRoteState(responseDoc.responses);
    } catch { /* no submission */ }
  }

  // DTU-2: if a localStorage draft is newer than the server copy, restore
  // from it. Handles the "tab close between keystroke and 2s server save"
  // case. Never overrides a submitted doc — only pre-submit draft state.
  restoredFromLocal = false;
  if (currentChar?._id && currentCycle?._id && currentCycle._id !== 'dev-stub') {
    const local = loadLocalDraft(String(currentChar._id), String(currentCycle._id));
    if (local && (!responseDoc || responseDoc.status !== 'submitted')) {
      const picked = pickFreshestDraft(local, responseDoc);
      if (picked.from === 'local') {
        if (!responseDoc) {
          responseDoc = { responses: picked.responses };
        } else {
          responseDoc.responses = picked.responses;
        }
        restoredFromLocal = true;
      }
    }
  }

  // Mandragora 2b: when there's no existing submission for this cycle, seed
  // sorcery slots from any rites the character has parked in their Mandragora
  // Garden (powers[].mandragora_parked === true). Parked rites are sustained
  // from the previous downtime — pre-filling avoids the player re-entering
  // them every cycle. Only fires when responseDoc is fully null (no server
  // doc, no local draft); existing drafts are respected.
  if (!responseDoc && currentChar?.powers && currentCycle && currentCycle._id !== 'dev-stub') {
    const parked = currentChar.powers.filter(
      p => p.category === 'rite' && p.mandragora_parked === true,
    );
    if (parked.length > 0) {
      // Cap uses stored dots/rating (not effectiveDomainDots which requires
      // attached_to → Safe Place to compute the haven-cap override).
      const mgMerit = currentChar.merits?.find(m => m.category === 'domain' && m.name === 'Mandragora Garden');
      const mgCap = mgMerit ? (mgMerit.dots || mgMerit.rating || parked.length) : parked.length;
      const toSeed = parked.slice(0, mgCap);
      const seeded = { sorcery_slot_count: String(toSeed.length) };
      toSeed.forEach((rite, i) => {
        const n = i + 1;
        seeded[`sorcery_${n}_rite`]      = rite.name;
        seeded[`sorcery_${n}_mandragora`] = 'yes';
        seeded[`sorcery_${n}_mg_locked`]  = 'yes';
      });
      responseDoc = { responses: seeded };
    }
  }

  // Check for published outcomes from previous cycles (for "results available" banner)
  if (currentCycle?.status === 'active' && !responseDoc?.published_outcome) {
    try {
      const allSubs = await apiGet('/api/downtime_submissions');
      allSubs.forEach(_promotePublishedOutcome);
      const charId = String(currentChar._id);
      const currentCycleId = String(currentCycle._id);
      const priorPublished = allSubs
        .filter(s => String(s.character_id) === charId && s.published_outcome && String(s.cycle_id) !== currentCycleId)
        .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1));
      if (priorPublished.length) {
        // Try to find cycle label
        try {
          const cycles = await apiGet('/api/downtime_cycles');
          const priorCycle = cycles.find(c => String(c._id) === String(priorPublished[0].cycle_id));
          priorPublishedLabel = priorCycle?.label || 'previous cycle';
        } catch { priorPublishedLabel = 'previous cycle'; }
      }
    } catch { /* ignore */ }
  }

  // Auto-detect attendance from the game session matching this downtime cycle
  lastGameAttendees = [];
  _activeGameSessionId = null;
  try {
    let attUrl = '/api/attendance?character_id=' + encodeURIComponent(String(currentChar._id));
    if (currentCycle?.game_number) attUrl += '&game_number=' + currentCycle.game_number;
    const att = await apiGet(attUrl);
    gateValues.attended = att.attended ? 'yes' : 'no';
    lastGameAttendees = att.attendees || [];
    _activeGameSessionId = att.session_id || null;
  } catch { /* fall back — leave gateValues.attended unset */ }

  // Load all character names for cast picker
  try {
    const names = await apiGet('/api/characters/names');
    const others = names.filter(c => c._id !== currentChar._id && c._id?.toString() !== currentChar._id?.toString());
    allCharacters = others.map(c => ({
      id: c._id,
      name: c.moniker || c.name,
      fullName: c.name,
      player: c.player || '',
    })).sort((a, b) => a.name.localeCompare(b.name));
    // If attendee list empty, fall back to full list
    if (!lastGameAttendees.length) {
      lastGameAttendees = others.map(c => ({ id: c._id, name: c.moniker || c.name }));
    }
  } catch { /* ignore */ }

  // Publish character data to the universal picker (ADR-003 §Q6).
  setCharPickerSources({
    all: allCharacters.map(c => ({ id: String(c.id), name: c.name })),
    attendees: lastGameAttendees.map(a => ({ id: String(a.id), name: a.name })),
  });

  // Auto-detect regent status from character data
  gateValues.is_regent = findRegentTerritory(_territories, currentChar)?.territory ? 'yes' : 'no';

  // Restore feeding state from saved responses
  if (responseDoc?.responses) {
    feedMethodId = responseDoc.responses['_feed_method'] || '';
    feedDiscName = responseDoc.responses['_feed_disc'] || '';
    feedSpecName = responseDoc.responses['_feed_spec'] || '';
    feedCustomAttr = responseDoc.responses['_feed_custom_attr'] || '';
    feedCustomSkill = responseDoc.responses['_feed_custom_skill'] || '';
    feedCustomDisc = responseDoc.responses['_feed_custom_disc'] || '';
    // fix.48: sync violence default so the render-path completeness check
    // (isMinimalComplete(saved, ctx) line 1719) agrees with the visual pre-select.
    // Only backfills when feed_violence is absent and the method has a default;
    // stalking/other have null defaults and are intentionally left for explicit pick.
    if (!responseDoc.responses.feed_violence && feedMethodId && FEED_VIOLENCE_DEFAULTS[feedMethodId]) {
      responseDoc.responses.feed_violence = FEED_VIOLENCE_DEFAULTS[feedMethodId];
    }
  } else {
    feedMethodId = ''; feedDiscName = ''; feedSpecName = ''; feedCustomAttr = ''; feedCustomSkill = ''; feedCustomDisc = '';
  }

  // Detect merits and auto-gate sorcery
  detectMerits();

  // Restore saved states
  if (responseDoc?.responses) {
    const saved = responseDoc.responses;
    for (const gate of DOWNTIME_GATES) {
      gateValues[gate.key] = saved[`_gate_${gate.key}`] || '';
    }
    const allMerits = [...detectedMerits.spheres, ...detectedMerits.contacts, ...detectedMerits.retainers];
    for (const m of allMerits) {
      const key = meritKey(m);
      if (saved[`_merit_${key}`]) {
        gateValues[`merit_${key}`] = saved[`_merit_${key}`];
      }
    }
  }

  const devPreview = location.hostname === 'localhost';

  // STs can preview the form for active or prep cycles; players only for active
  const _isST = isSTRole();
  const _formStatuses = _isST ? ['active', 'prep'] : ['active'];
  const _hasWindowAccess = (currentCycle?.out_of_window_player_ids || [])
    .map(String).includes(String(currentChar._id));
  const _deadlinePast = !!(currentCycle?.deadline_at && new Date(currentCycle.deadline_at) < new Date());
  const _manualOpen   = currentCycle?.manual_open === true;
  // Scheduled auto-open: once auto_open_at has passed, players reach the form even while the
  // cycle is still 'prep' (mirrors downtime-tab.js autoOpenPassed). Kept OUT of the deadline
  // clause below — a passed auto-open must never reopen a window whose deadline has passed.
  const _autoOpenPassed = !!(currentCycle?.auto_open_at && new Date(currentCycle.auto_open_at) <= new Date());
  const _gateBlocks = !currentCycle
    || (!_formStatuses.includes(currentCycle.status) && !_hasWindowAccess && !_autoOpenPassed)
    || (_deadlinePast && !_hasWindowAccess && !_manualOpen);

  if (options.singleColumn) {
    // Game app context: render form directly, no split, no right-panel history
    // (downtime-tab.js handles the history accordion separately)
    if (!devPreview && !_isST && _gateBlocks) {
      targetEl.innerHTML = renderCycleGatePage();
    } else {
      targetEl.innerHTML = `<div id="dt-container" class="reading-pane"></div>`;
      renderForm(document.getElementById('dt-container'));
    }
    return;
  }

  // Set up two-pane layout (player portal)
  targetEl.innerHTML = `
    <div class="dt-split">
      <div class="dt-split-left" id="dt-left-pane"></div>
      <div class="dt-split-right" id="dt-right-pane"></div>
    </div>`;

  const leftEl  = document.getElementById('dt-left-pane');
  const rightEl = document.getElementById('dt-right-pane');

  // Left: form or gate message
  if (!devPreview && !_isST && _gateBlocks) {
    leftEl.innerHTML = renderCycleGatePage();
  } else {
    leftEl.innerHTML = `<div id="dt-container" class="reading-pane"></div>`;
    renderForm(document.getElementById('dt-container'));
  }

  // Right: history panel (fire-and-forget, loads independently)
  renderHistoryPanel(rightEl, char);
}

async function renderHistoryPanel(el, char) {
  el.innerHTML = '<p class="placeholder-msg dt-hist-loading">Loading history\u2026</p>';

  let allSubs = [], cycles = [];
  try {
    [allSubs, cycles] = await Promise.all([
      apiGet('/api/downtime_submissions'),
      apiGet('/api/downtime_cycles'),
    ]);
  } catch {
    el.innerHTML = '<p class="placeholder-msg">Could not load history.</p>';
    return;
  }

  const cycleMap = {};
  for (const c of cycles) cycleMap[String(c._id)] = c;

  const charId = String(char._id);
  const charSubs = allSubs
    .filter(s => String(s.character_id) === charId)
    .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1));

  let h = '<div class="dt-hist-panel">';
  h += '<div class="dt-hist-title">Submission History</div>';

  if (!charSubs.length) {
    h += '<p class="placeholder-msg dt-hist-empty">No previous submissions.</p>';
  } else {
    for (const sub of charSubs) {
      const cycle   = cycleMap[String(sub.cycle_id)];
      const label   = cycle?.label || `Cycle ${String(sub.cycle_id).slice(-4)}`;
      const status  = sub.approval_status || 'pending';
      const statusCss = status === 'approved' ? 'approved' : status === 'modified' ? 'modified' : status === 'rejected' ? 'rejected' : 'pending';
      const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
      const hasOutcome  = !!sub.published_outcome;

      h += `<div class="dt-hist-entry">`;
      h += `<div class="dt-hist-entry-head">`;
      h += `<span class="dt-hist-cycle">${esc(label)}</span>`;
      h += `<span class="dt-status-badge dt-status-${statusCss}">${esc(statusLabel)}</span>`;
      if (hasOutcome) h += `<span class="dt-hist-has-outcome">\u2665 Outcome</span>`;
      h += `</div>`;

      if (hasOutcome) {
        const sections = parseOutcomeSections(sub.published_outcome);
        h += '<div class="dt-hist-outcome">';
        for (const sec of sections) {
          if (sec.heading) {
            const isMech = sec.heading === 'Mechanical Outcomes';
            h += `<div class="dt-hist-section${isMech ? ' dt-hist-mech' : ''}">`;
            h += `<div class="dt-hist-section-head">${esc(sec.heading)}</div>`;
            const body = sec.lines.join('\n').trim();
            if (isMech) {
              h += `<pre class="dt-hist-pre">${esc(body)}</pre>`;
            } else {
              h += sec.lines.filter(Boolean).map(l => `<p>${esc(l)}</p>`).join('');
            }
            h += '</div>';
          } else {
            h += sec.lines.filter(Boolean).map(l => `<p>${esc(l)}</p>`).join('');
          }
        }
        h += '</div>';
      }

      h += '</div>';
    }
  }

  h += '</div>';
  el.innerHTML = h;
}

function renderCycleGatePage() {
  if (!currentCycle) {
    return `<div class="reading-pane qf-gate-page">
      <p class="placeholder-msg">No active downtime cycle right now. Your ST will open submissions before the next game.</p>
    </div>`;
  }
  const label = esc(currentCycle.label || 'This cycle');
  const isPrep         = currentCycle.status === 'prep';
  const isGame         = isInGamePhase(currentCycle); // #1001: game_phase wins over legacy status
  const isClosed       = currentCycle.status === 'closed';
  const isDeadlinePast = !!(currentCycle.deadline_at && new Date(currentCycle.deadline_at) < new Date());
  const isPublished    = !!(responseDoc?.published_outcome);

  let h = `<div class="reading-pane qf-gate-page">`;
  h += `<h3 class="qf-title">${label}</h3>`;
  // #1002: which game session this downtime feeds (derived from game_number)
  const _spanGate = cycleSpanLabel(currentCycle);
  if (_spanGate) h += `<p class="qf-section-intro">${esc(_spanGate)}</p>`;

  if (isPrep) {
    const _openAt = currentCycle.auto_open_at ? new Date(currentCycle.auto_open_at) : null;
    if (_openAt && _openAt > new Date()) {
      // Scheduled to open later: show when, not "being prepared". data-open-at is emitted so a
      // live ticker can be wired later without markup change (gate page is rebuilt on each load).
      const openLabel = _openAt.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      h += `<p class="qf-gate-msg" data-open-at="${esc(currentCycle.auto_open_at)}">Downtimes opening soon. Opens <strong>${esc(openLabel)}</strong>.</p>`;
    } else {
      h += `<p class="qf-gate-msg">Downtime is being prepared \u2014 your ST will open submissions shortly.</p>`;
    }
  } else if (isGame) {
    h += `<p class="qf-gate-msg">Submissions for this cycle are locked \u2014 the game is on. Check the <strong>Feeding</strong> tab for your feeding roll.</p>`;
  } else if (isClosed) {
    h += `<p class="qf-gate-msg">Your ST is processing downtime results. Published outcomes will appear in the <strong>Archive</strong> tab once ready.</p>`;
  } else if (isDeadlinePast && isPublished) {
    h += `<p class="qf-gate-msg">Your results for this cycle have been published \u2014 see the <strong>Archive</strong> tab.</p>`;
  } else if (isDeadlinePast) {
    h += `<p class="qf-gate-msg">Submissions are closed. Your ST is processing the results \u2014 published outcomes will appear in the <strong>Archive</strong> tab.</p>`;
  } else {
    h += `<p class="qf-gate-msg">Downtime submissions are currently closed.</p>`;
  }

  // If the player already has a submission for this cycle, show its status
  if (responseDoc) {
    const statusLabel = responseDoc.status === 'submitted' ? 'Submitted' : 'Draft saved';
    h += `<p class="qf-gate-sub-status"><span class="qf-badge qf-badge-submitted">${statusLabel}</span> Your ${label} submission is on file.</p>`;
  }

  h += `</div>`;
  return h;
}

// ── Universal character picker plumbing (ADR-003 §Q6) ────────────────────
// Picker render sites emit a placeholder element marked with [data-cp-mount];
// after innerHTML assignment, mountCharPickers() replaces each placeholder
// with a live charPicker instance whose onChange writes back to a hidden
// input (so existing collection paths keep working) and triggers scheduleSave.

function mountCharPickers(container) {
  const placeholders = container.querySelectorAll('[data-cp-mount]');
  placeholders.forEach(ph => {
    const site = ph.dataset.cpSite || '';
    const scope = ph.dataset.cpScope === 'attendees' ? 'attendees' : 'all';
    const cardinality = ph.dataset.cpCardinality === 'multi' ? 'multi' : 'single';
    const placeholderText = ph.dataset.cpPlaceholder || '';
    let initial;
    try { initial = JSON.parse(ph.dataset.cpInitial || (cardinality === 'multi' ? '[]' : '""')); }
    catch { initial = (cardinality === 'multi' ? [] : ''); }
    let excludeIds = [];
    try { excludeIds = JSON.parse(ph.dataset.cpExclude || '[]'); } catch { excludeIds = []; }

    const hiddenId = ph.dataset.cpHidden || '';
    const onChange = _makeCharPickerOnChange(site, hiddenId, cardinality);
    const el = charPicker({ scope, cardinality, initial, onChange, placeholder: placeholderText, excludeIds });
    el.dataset.cpMountedSite = site;
    if (hiddenId) el.dataset.cpMountedHidden = hiddenId;
    if (placeholderText) el.dataset.cpMountedPlaceholder = placeholderText;
    if (ph.className) el.classList.add(...ph.className.split(/\s+/).filter(Boolean));
    ph.replaceWith(el);
  });
}

function _writeHidden(hiddenId, value) {
  if (!hiddenId) return;
  const el = document.getElementById(hiddenId);
  if (el) el.value = value;
}

function _makeCharPickerOnChange(site, hiddenId, cardinality) {
  if (site === 'shoutout') {
    // 3-pick cap preserved from prior behaviour. Locked picker signature has
    // no max-N parameter, so over-cap selections are reverted by remounting
    // the picker with the trimmed list.
    return (next) => {
      const arr = Array.isArray(next) ? next : [];
      if (arr.length > 3) {
        const trimmed = arr.slice(0, 3);
        _writeHidden(hiddenId, JSON.stringify(trimmed));
        scheduleSave();
        _remountShoutoutPicker(trimmed);
        return;
      }
      _writeHidden(hiddenId, JSON.stringify(arr));
      scheduleSave();
    };
  }
  if (cardinality === 'multi') {
    return (next) => {
      const arr = Array.isArray(next) ? next : [];
      _writeHidden(hiddenId, JSON.stringify(arr));
      scheduleSave();
    };
  }
  return (next) => {
    _writeHidden(hiddenId, typeof next === 'string' ? next : '');
    scheduleSave();
  };
}

function _remountShoutoutPicker(trimmed) {
  const cur = document.querySelector('[data-cp-mounted-site="shoutout"]');
  if (!cur) return;
  const hiddenId = cur.dataset.cpMountedHidden || '';
  const placeholderText = cur.dataset.cpMountedPlaceholder || '';
  const fresh = charPicker({
    scope: 'attendees',
    cardinality: 'multi',
    initial: trimmed,
    onChange: _makeCharPickerOnChange('shoutout', hiddenId, 'multi'),
    placeholder: placeholderText,
    excludeIds: [],
  });
  fresh.dataset.cpMountedSite = 'shoutout';
  if (hiddenId) fresh.dataset.cpMountedHidden = hiddenId;
  if (placeholderText) fresh.dataset.cpMountedPlaceholder = placeholderText;
  cur.replaceWith(fresh);
}

// dt-form.17 (ADR-003 §Q1, §Q2): MINIMAL vs ADVANCED mode gate.
// Sections in MINIMAL_SECTIONS render in both modes; everything else is
// hidden in MINIMAL (per ADR §Q2 lock — "not rendered, not just display:none").
const MINIMAL_SECTIONS = new Set(['court', 'personal_story', 'feeding', 'projects', 'regency']);

function _formMode(saved) {
  return saved?._mode === 'advanced' ? 'advanced' : 'minimal';
}

function _isSectionVisibleInMode(sectionKey, mode) {
  if (mode === 'advanced') return true;
  return MINIMAL_SECTIONS.has(sectionKey);
}

function _completenessCtx() {
  return {
    isRegent: gateValues.is_regent === 'yes',
    regencyConfirmed: _isRegencyConfirmedThisCycle(),
    attended: gateValues.attended === 'yes',
  };
}

function _isRegencyConfirmedThisCycle() {
  if (!currentCycle?.regent_confirmations) return false;
  const ri = findRegentTerritory(_territories, currentChar);
  if (!ri?.territoryId) return false;
  return (currentCycle.regent_confirmations || []).some(
    c => String(c.territory_id) === String(ri.territoryId)
  );
}

// dt-form.31 (ADR-003 §Q5): Submit Final modal. ADVANCED-only affordance
// that lets a player declare "I am done editing" via responses._final_submitted_at.
// Mirrors the existing .npcr-modal pattern (admin-layout.css) but lives in
// components.css under .dt-modal-* so the player surface picks it up.
function openSubmitFinalModal(container) {
  // Render fresh markup each time so the action-spent counts reflect the
  // current responses (per §Q9, ADVANCED + MINIMAL-filled shows zeros).
  closeSubmitFinalModal();
  const saved = responseDoc?.responses || {};
  const totals = {
    projectSlots:     DOWNTIME_SECTIONS.find(s => s.key === 'projects')?.projectSlots || 4,
    sphereSlots:      Math.min((detectedMerits.spheres || []).length, 5),
    statusSlots:      Math.min((detectedMerits.status || []).length, 5),
    contactSlots:     Math.min((detectedMerits.contacts || []).length, 5),
    retainerSlots:    (detectedMerits.retainers || []).length,
    mentorSlots:      (detectedMerits.mentors || []).length,
    staffSlots:       (detectedMerits.staff || []).reduce(
                        (s, m) => s + (meritEffectiveRating(currentChar, m) || 0), 0
                      ),
    acquisitionSlots: parseInt(saved.acq_slot_count || '1', 10) || 1,
    sorcerySlots:     parseInt(saved.sorcery_slot_count || '0', 10) || 0,
    equipmentSlots:   parseInt(saved.equipment_slot_count || '0', 10) || 0,
  };
  const summary = actionSpentSummary(saved, totals);
  const lines = formatActionSpentSummary(summary);

  const overlay = document.createElement('div');
  overlay.className = 'dt-modal-overlay';
  overlay.id = 'dt-submit-final-overlay';
  overlay.setAttribute('role', 'presentation');

  const titleId = 'dt-submit-final-title';
  let h = '';
  h += `<div class="dt-modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}">`;
  h += `<h3 class="dt-modal-title" id="${titleId}">Submit Final</h3>`;
  h += '<div class="dt-modal-body">';
  h += '<p class="qf-section-intro">Use this when you are done editing. Your downtime will continue auto-saving until the cycle deadline; this just records the moment you stopped.</p>';

  // Action-spent summary
  h += '<h4 class="dt-modal-subhead">This cycle so far</h4>';
  if (lines.length) {
    h += '<ul class="dt-modal-summary-list">';
    for (const line of lines) {
      h += `<li>${esc(line)}</li>`;
    }
    h += '</ul>';
  } else {
    h += '<p class="qf-desc">No actions filled in yet.</p>';
  }

  // Optional rate-the-form widget — lifted from the removed Admin section
  // (SUBMIT_FINAL_MODAL_QUESTIONS in downtime-data.js) so the existing
  // star_rating + textarea widgets render via renderQuestion(), unchanged.
  h += '<h4 class="dt-modal-subhead">Rate the form (optional)</h4>';
  for (const q of SUBMIT_FINAL_MODAL_QUESTIONS) {
    h += renderQuestion(q, saved[q.key] || '');
  }
  h += '</div>'; // dt-modal-body

  // Actions
  h += '<div class="dt-modal-actions">';
  h += '<button type="button" class="qf-btn qf-btn-save" data-dt-final-cancel>Cancel</button>';
  h += '<button type="button" class="qf-btn qf-btn-submit-final" data-dt-final-confirm>Submit Final</button>';
  h += '</div>';

  h += '</div>'; // dt-modal
  overlay.innerHTML = h;
  document.body.appendChild(overlay);

  // Focus management: send focus to the dialog so screen readers announce it.
  overlay.querySelector('.dt-modal')?.focus({ preventScroll: true });

  // Escape closes the modal.
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSubmitFinalModal(); }
  });

  // Click delegation MUST live on the overlay, not on the form container,
  // because document.body.appendChild(overlay) above puts the modal outside
  // the container's DOM subtree. Clicks here would not bubble to a
  // container-scoped listener (caused issue #89).
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-dt-final-cancel]')) {
      e.preventDefault();
      closeSubmitFinalModal();
      return;
    }
    if (e.target.closest('[data-dt-final-confirm]')) {
      e.preventDefault();
      handleSubmitFinalConfirm(container);
      return;
    }
    // Click on the overlay backdrop itself (not on a modal child) dismisses.
    if (e.target === overlay) {
      closeSubmitFinalModal();
    }
  });
}

function closeSubmitFinalModal() {
  const el = document.getElementById('dt-submit-final-overlay');
  if (el) el.remove();
}

async function handleSubmitFinalConfirm(container) {
  // Collect the rating widget values from the modal so they round-trip on
  // the next save. Star rating writes to a hidden input; textarea writes
  // straight to its DOM node. We seed them onto responseDoc so collectResponses
  // (which iterates over rendered form fields, not the modal) keeps the values.
  if (!responseDoc) responseDoc = { responses: {} };
  if (!responseDoc.responses) responseDoc.responses = {};
  for (const q of SUBMIT_FINAL_MODAL_QUESTIONS) {
    const el = document.getElementById('dt-' + q.key);
    if (el) responseDoc.responses[q.key] = el.value;
  }
  responseDoc.responses._final_submitted_at = new Date().toISOString();
  closeSubmitFinalModal();
  // Re-render the form so the button label flips to "Update Final Submission",
  // then save so the new field reaches the server. Save handles the toast
  // status banner via the auto-mirror lifecycle.
  renderForm(container);
  scheduleSave();
  const statusEl = document.getElementById('dt-save-status');
  if (statusEl) {
    statusEl.textContent = 'Final submission recorded; keep editing until the deadline.';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
  }
}

function renderForm(container) {
  // Guard against a detached/missing container: renderDowntimeTab renders into
  // `document.getElementById('dt-container')`, which is briefly null if the tab
  // is re-rendered while a prior async render is still in flight. No container
  // means nothing to draw (a newer render owns the live DOM); bail rather than
  // throw an uncaught TypeError on container.querySelectorAll.
  if (!container) return;
  const saved = responseDoc?.responses || {};
  const status = responseDoc?.status || 'new';
  const isST = isSTRole();
  const isSubmitted = status === 'submitted';

  // dt-form.17: derive _mode + _has_minimum on every render so the gate and
  // banner reflect the latest state. The persistent fields are written by
  // the lifecycle hook in scheduleSave; this is read-only here.
  const mode = _formMode(saved);
  const ctx = _completenessCtx();
  const hasMinimum = isMinimalComplete(saved, ctx);
  const missing = hasMinimum ? [] : missingMinimumPieces(saved, ctx);

  // Re-publish picker sources every render — guards against another module
  // (regency-tab) overwriting them between navigations.
  setCharPickerSources({
    all: allCharacters.map(c => ({ id: String(c.id), name: c.name })),
    attendees: lastGameAttendees.map(a => ({ id: String(a.id), name: a.name })),
  });

  let h = '';

  // DTU-2: show a one-shot banner when the form was restored from a local
  // draft (i.e., server copy was older than localStorage snapshot).
  if (restoredFromLocal) {
    h += `<div class="qf-results-banner qf-local-restore-banner">&#x2139; Restored unsaved edits from this browser. They will save to the server as you continue typing.</div>`;
    restoredFromLocal = false; // only show once per mount
  }

  // Status banner — results live in the Archive tab, not here
  const published = responseDoc?.published_outcome;
  const pending = responseDoc && !published && status === 'submitted';
  if (published) {
    h += `<div class="qf-results-banner">&#x2713; Your results for this cycle are published &mdash; see the <strong>Archive</strong> tab.</div>`;
  } else if (pending) {
    h += '<div class="qf-results-pending"><p class="qf-results-pending-msg">Your downtime is submitted. You can keep editing until the deadline — changes auto-save and update your submission.</p></div>';
  } else if (!published && priorPublishedLabel) {
    h += `<div class="qf-results-banner">&#x2713; Your <strong>${esc(priorPublishedLabel)}</strong> results are published &mdash; see the <strong>Archive</strong> tab.</div>`;
  }

  // dt-form.17 (ADR-003 §Q1): mode selector at top of form.
  h += '<div class="dt-mode-selector" role="group" aria-label="Form mode">';
  h += `<button type="button" class="dt-mode-pill${mode === 'minimal' ? ' dt-mode-pill--active' : ''}" data-dt-mode="minimal" aria-pressed="${mode === 'minimal'}">Minimal</button>`;
  h += `<button type="button" class="dt-mode-pill${mode === 'advanced' ? ' dt-mode-pill--active' : ''}" data-dt-mode="advanced" aria-pressed="${mode === 'advanced'}">Advanced</button>`;
  h += '<span class="dt-mode-desc">';
  h += mode === 'minimal'
    ? 'Just the essentials. Switch to Advanced for the full form — your data is preserved either way.'
    : 'All sections shown. Switch back to Minimal at any time without losing what you have entered.';
  h += '</span>';
  h += '</div>';

  // dt-form.17 (ADR-003 §Q3): persistent below-minimum banner with the
  // missing-pieces list. Locked copy per story §Banner copy.
  if (!hasMinimum) {
    h += '<div class="dt-min-banner" role="status" aria-live="polite">';
    h += '<p class="dt-min-banner__lead"><strong>Your form is below minimum-complete.</strong> Your downtime XP credit is on hold. Add the missing pieces to restore it:</p>';
    if (missing.length) {
      h += '<ul class="dt-min-banner__list">';
      for (const item of missing) {
        h += `<li>${esc(item.label)}</li>`;
      }
      h += '</ul>';
    }
    h += '</div>';
  } else if (mode === 'minimal') {
    // dt-form.31 (ADR-003 §Q5): MINIMAL auto-submit confirmation toast.
    // Locked copy. Persistent — stays as long as the form is above minimum
    // in MINIMAL mode. ADVANCED uses the Submit Final modal instead.
    h += '<div class="dt-min-toast" role="status" aria-live="polite">';
    h += '<p class="dt-min-toast__lead"><strong>Submitted</strong> — keep editing until the deadline.</p>';
    h += '</div>';
  }

  // Header
  h += '<div class="qf-header">';
  h += `<h3 class="qf-title">Downtime Submission</h3>`;
  if (currentCycle) {
    // #1002: append the feeds-into span so players see which session this feeds
    const _feeds = cycleFeedsLabel(currentCycle);
    const _base = esc(currentCycle.label || currentCycle.title || 'Current Cycle');
    h += `<p class="qf-section-intro">${_feeds ? `${_base} – ${esc(_feeds)}` : _base}</p>`;
    if (currentCycle.deadline_at) {
      const dl = new Date(currentCycle.deadline_at);
      const past = dl < new Date();
      const dlStr = dl.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const _overrideOpen = currentCycle.manual_open === true;
      const _showClosed = past && !_overrideOpen;
      h += `<p class="qf-deadline${_showClosed ? ' qf-deadline-closed' : ''}">${_showClosed ? 'Submissions closed' : _overrideOpen && past ? 'Open — ST override active' : 'Open until ' + dlStr}</p>`;
    }
  }
  h += '<div class="qf-meta">';
  if (isSubmitted) {
    h += '<span class="qf-badge qf-badge-submitted">Submitted</span>';
  } else if (status === 'draft') {
    h += '<span class="qf-badge qf-badge-draft">Draft</span>';
  } else {
    h += '<span class="qf-badge qf-badge-draft">Not Started</span>';
  }
  h += '<span id="dt-save-status" class="qf-save-status"></span>';
  h += '</div>';

  // Status badges
  h += '<div class="dt-status-badges">';
  if (gateValues.attended === 'yes') {
    h += '<span class="dt-badge dt-badge-on">Attended</span>';
  } else {
    h += '<span class="dt-badge dt-badge-off">Absent</span>';
  }
  if (gateValues.is_regent === 'yes') {
    h += `<span class="dt-badge dt-badge-on">Regent \u2014 ${esc(findRegentTerritory(_territories, currentChar)?.territory)}</span>`;
  }
  if (gateValues.has_sorcery === 'yes') {
    const traditions = [];
    if (discDots(currentChar, 'Cruac') > 0) traditions.push('Cruac');
    if (discDots(currentChar, 'Theban') > 0) traditions.push('Theban');
    h += `<span class="dt-badge dt-badge-on">${traditions.join(' / ')}</span>`;
  }
  const bp = currentChar.blood_potency || 0;
  if (bp) h += `<span class="dt-badge dt-badge-info">BP ${bp}</span>`;
  h += '</div>';
  h += '</div>';

  // Static sections: Court only — territory/feeding/regency rendered explicitly below in game-logic order
  // RFR.3: territory + feeding sections render regardless of cycle's
  // feeding_rights_confirmed state. Regents manage feeding_rights on the
  // Regency tab; players are never blocked from filing downtime.
  for (const section of DOWNTIME_SECTIONS) {
    if (section.key === 'projects') continue;
    if (section.key === 'acquisitions') continue;
    if (section.key === 'blood_sorcery') continue;
    if (section.key === 'equipment') continue;
    if (section.key === 'vamping') continue;
    // dt-form.31: admin section removed from DOWNTIME_SECTIONS. Defensive skip
    // kept in case legacy data or imports re-introduce the key.
    if (section.key === 'admin') continue;
    if (section.key === 'territory') continue;
    if (section.key === 'feeding') continue;
    if (section.key === 'regency') continue;
    if (section.key === 'personal_story') continue; // rendered explicitly below
    if (section.key === 'safe_place_locations') continue; // #504: rendered explicitly below (custom per-merit inputs)
    if (section.key === 'carthian_pull') continue; // #508: rendered explicitly below (custom allocation control)
    // dt-form.17: hide non-minimal sections when in MINIMAL mode (court is in
    // MINIMAL so it falls through; trust/harm/aspirations live in admin).
    if (!_isSectionVisibleInMode(section.key, mode)) continue;

    const isGated = section.gate && gateValues[section.gate] !== 'yes';
    const sectionClass = isGated ? 'qf-section dt-gated-hidden' : 'qf-section collapsed';

    h += `<div class="${sectionClass}" data-gate-section="${section.gate || ''}" data-section-key="${section.key}">`;
    h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">✔</span></h4>`;
    h += '<div class="qf-section-body">';
    if (section.intro) {
      h += `<p class="qf-section-intro">${esc(section.intro)}</p>`;
    }
    for (const q of section.questions) {
      const val = saved[q.key] || '';
      h += renderQuestion(q, val);
    }
    h += '</div></div>';
  }

  // ── Safe Places and Havens — ungated; renders after Court regardless of attendance (#504) ──
  h += renderSafePlaceLocationsSection(saved);

  // ── Personal Story — Touchstone-or-Correspondence binary (dt-form.18, both modes) ──
  h += renderPersonalStorySection(saved);

  // ── Carthian Pull — single-dot bonus allocation; ungated, before Feeding (#508) ──
  h += renderCarthianPullSection(saved);

  // ── Territory then Feeding — players see ambience/cap before choosing hunt method ──
  for (const key of ['territory', 'feeding']) {
    if (!_isSectionVisibleInMode(key, mode)) continue;
    const section = DOWNTIME_SECTIONS.find(s => s.key === key);
    if (!section) continue;
    h += `<div class="qf-section collapsed" data-gate-section="" data-section-key="${key}">`;
    h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">✔</span></h4>`;
    h += '<div class="qf-section-body">';
    if (section.intro) h += `<p class="qf-section-intro">${esc(section.intro)}</p>`;
    for (const q of section.questions) {
      // territory_grid in the feeding section is rendered inside dt-feed-card-wrap
      if (key === 'feeding' && q.type === 'territory_grid') continue;
      h += renderQuestion(q, saved[q.key] || '');
    }
    h += '</div></div>';
  }

  // ── Projects section with dynamic slots ──
  // dt-form.17: in MINIMAL only the first project slot renders.
  h += renderProjectSlots(saved, mode);

  // ── Regency confirmation (regent-only, both modes) ──
  // dt-form.23 (ADR-003 §Q2): confirmation UI for regents; writes to
  // cycle.regent_confirmations via the existing /confirm-feeding endpoint.
  // Non-regents see nothing (renderRegencySection returns '' on is_regent !== 'yes').
  if (_isSectionVisibleInMode('regency', mode)) h += renderRegencySection();

  // dt-form.17: ADVANCED-only sections below the projects.
  if (mode === 'advanced') {
    // ── Blood Sorcery — between Personal Actions and Sphere Actions (dt-form.27) ──
    if (gateValues.has_sorcery === 'yes') h += renderSorcerySection(saved);

    // ── Dynamic merit sections ──
    h += renderMeritToggles(saved);

    // ── Acquisitions (custom render) ──
    h += renderAcquisitionsSection(saved);

    // ── Equipment (dynamic rows) ──
    h += renderEquipmentSection(saved);
  }

  // dt-form.31: 'admin' removed from DOWNTIME_SECTIONS — find() returns
  // undefined for it and the body is skipped. Loop kept for vamping.
  for (const key of ['vamping']) {
    if (!_isSectionVisibleInMode(key, mode)) continue;
    const section = DOWNTIME_SECTIONS.find(s => s.key === key);
    if (!section) continue;
    const isGated = section.gate && gateValues[section.gate] !== 'yes';
    const sectionClass = isGated ? 'qf-section dt-gated-hidden' : 'qf-section collapsed';

    h += `<div class="${sectionClass}" data-gate-section="${section.gate || ''}" data-section-key="${section.key}">`;
    h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">✔</span></h4>`;
    h += '<div class="qf-section-body">';
    if (section.intro) {
      h += `<p class="qf-section-intro">${esc(section.intro)}</p>`;
    }
    for (const q of section.questions) {
      const val = saved[q.key] || '';
      h += renderQuestion(q, val);
    }
    if (key === 'vamping' && gateValues.is_regent === 'yes') {
      const terrName = findRegentTerritory(_territories, currentChar)?.territory || 'your territory';
      h += `<div class="qf-field dt-regency-sub">`;
      h += `<label class="qf-label">As Regent of ${esc(terrName)}: what do you want to make known about your domain this month?</label>`;
      h += `<p class="qf-desc">Proclamations, policies, enforcement, or any public stance you wish to communicate to other Kindred about your territory.</p>`;
      h += `<textarea id="dt-regency_action" class="qf-textarea" rows="4">${esc(saved['regency_action'] || '')}</textarea>`;
      h += `</div>`;
    }
    h += '</div></div>';
  }

  // dt-form.31: form-rating hide hack removed — the rating widget now lives
  // in the Submit Final modal (ADVANCED only); not in the form body.

  // Actions
  const submitLabel = responseDoc?.status === 'submitted' ? 'Update Submission' : 'Submit Downtime';
  h += '<div class="qf-actions">';
  h += `<button class="qf-btn qf-btn-submit" id="dt-btn-submit">${esc(submitLabel)}</button>`;
  // dt-form.31 (ADR-003 §Q5): ADVANCED-only Submit Final affordance. Opens
  // the modal; the modal sets responses._final_submitted_at on confirm.
  // Per §Q9 the button is mode-conditional, not state-conditional — an
  // ADVANCED player who only filled MINIMAL still sees it (the modal
  // shows zeros in that case).
  if (mode === 'advanced') {
    const finalAt = saved._final_submitted_at;
    const finalLabel = finalAt ? 'Update Final Submission' : 'Submit Final';
    h += `<button type="button" class="qf-btn qf-btn-submit-final" id="dt-btn-submit-final">${esc(finalLabel)}</button>`;
  }
  h += '</div>';

  // Capture expanded sections before re-render
  const expandedSections = new Set();
  container.querySelectorAll('.qf-section[data-section-key]:not(.collapsed)').forEach(el => {
    expandedSections.add(el.dataset.sectionKey);
  });

  container.innerHTML = h;

  // T5: hydrate prior-outcome placeholders for Mandragora-locked sorcery slots.
  const mgLockedSlots = [];
  container.querySelectorAll('.dt-sorcery-slot[data-mg-locked="yes"]').forEach(el => {
    const n = parseInt(el.id.replace('dt-sorcery-slot-', ''), 10);
    const riteName = el.dataset.riteName;
    if (n && riteName) mgLockedSlots.push({ n, riteName });
  });
  if (mgLockedSlots.length) _hydrateMgPriorOutcomesForm(mgLockedSlots).catch(() => {
    mgLockedSlots.forEach(({ n }) => {
      const el = document.getElementById(`dt-mg-prior-${n}`);
      if (el) { el.textContent = 'No prior resolution recorded.'; el.classList.remove('dt-mg-prior-loading'); }
    });
  });

  // Restore expanded state
  expandedSections.forEach(key => {
    const el = container.querySelector(`.qf-section[data-section-key="${key}"]`);
    if (el) el.classList.remove('collapsed');
  });

  // Mount universal character pickers in place of their placeholders.
  // Re-runs on every renderForm because innerHTML wipes prior mounts.
  mountCharPickers(container);

  // Update section completion ticks on initial render
  updateSectionTicks(container);

  // Wire Connected Characters typeahead widgets — must re-run after every
  // renderForm because innerHTML wipes prior mounts (issue #727).
  initConnectedCharsTypeaheads(container);

  // Ensure rote feeding data is set in saved responses (no re-render)
  if (feedRoteAction && feedMethodId) {
    const s = responseDoc?.responses;
    if (s && s[`project_${feedRoteSlot}_action`] !== 'feed') {
      s[`project_${feedRoteSlot}_action`] = 'feed';
    }
  }

  // Wire events — skip if already wired (prevent listener stacking on re-render)
  if (container._dtWired) return;
  container._dtWired = true;

  // Section collapse/expand toggle
  container.addEventListener('click', (e) => {
    // #522: remove an applied Carthian Pull dot, then re-render.
    const cpRemove = e.target.closest('[data-carthian-remove]');
    if (cpRemove) {
      e.preventDefault();
      _onCarthianRemove(container, Number(cpRemove.getAttribute('data-carthian-remove')));
      return;
    }
    // dt-form.17: Mode pill toggle. Persist on responses._mode and re-render.
    // Switching preserves entered data (per ADR §Q1 Resolutions): non-MINIMAL
    // fields stay in responses; only their UI is hidden.
    const modePill = e.target.closest('[data-dt-mode]');
    if (modePill) {
      const next = modePill.dataset.dtMode === 'advanced' ? 'advanced' : 'minimal';
      const cur = collectResponses();
      cur._mode = next;
      if (responseDoc) responseDoc.responses = cur;
      else responseDoc = { responses: cur };
      renderForm(container);
      scheduleSave();
      return;
    }
    // dt-form.34: delegated submit — survives re-renders; direct listener below was lost
    // after any inline renderForm() call (sorcery rite change, feed pool, mode toggle).
    if (e.target.closest('#dt-btn-submit')) {
      submitForm();
      return;
    }
    // dt-form.18: Personal Story kind radio — re-render so the textarea
    // label and placeholder reflect the chosen kind (touchstone vs
    // correspondence). The radio's `value` is set by the browser before
    // this handler fires, so collectResponses captures it.
    if (e.target.matches('[data-personal-story-kind]')) {
      const cur = collectResponses();
      if (responseDoc) responseDoc.responses = cur;
      else responseDoc = { responses: cur };
      renderForm(container);
      scheduleSave();
      return;
    }
    // dt-form.31: Submit Final button (ADVANCED only) opens the modal.
    if (e.target.closest('#dt-btn-submit-final')) {
      e.preventDefault();
      openSubmitFinalModal(container);
      return;
    }
    // dt-form.23 (ADR-003 §Q2): regent confirmation. POSTs to the same
    // /confirm-feeding endpoint regency-tab uses; rights[] is a snapshot
    // of the territory's current feeding_rights. After success, replace
    // currentCycle with the server response so the predicate sees the new
    // entry on re-render.

    // Issue #161 (2026-05-08): "Open Regency tab" link from the Regency
    // section. Navigates the player suite to the Regency tab via the
    // existing window.goTab dispatcher (set up in app.js:2200).
    const openRegencyTabBtn = e.target.closest('[data-open-regency-tab]');
    if (openRegencyTabBtn) {
      e.preventDefault();
      if (typeof window.goTab === 'function') window.goTab('regency');
      return;
    }

    const regencyConfirmBtn = e.target.closest('#dt-btn-confirm-regency');
    if (regencyConfirmBtn) {
      e.preventDefault();
      const ri = findRegentTerritory(_territories, currentChar);
      const statusEl = container.querySelector('#dt-regency-confirm-status');
      if (!ri?.territoryId || !currentCycle?._id) return;
      if (currentCycle._id === 'dev-stub') {
        if (statusEl) statusEl.textContent = 'Dev preview — confirmation requires a live cycle.';
        return;
      }
      const terr = (_territories || []).find(t => String(t._id) === String(ri.territoryId));
      const rights = Array.isArray(terr?.feeding_rights) ? terr.feeding_rights : [];
      regencyConfirmBtn.disabled = true;
      regencyConfirmBtn.textContent = 'Confirming…';
      if (statusEl) statusEl.textContent = '';
      apiPost(`/api/downtime_cycles/${currentCycle._id}/confirm-feeding`, {
        territory_id: ri.territoryId,
        rights,
      }).then(updated => {
        currentCycle = updated;
        renderForm(container);
      }).catch(err => {
        regencyConfirmBtn.disabled = false;
        regencyConfirmBtn.textContent = 'Confirm regency this cycle';
        if (statusEl) statusEl.textContent = 'Confirm failed: ' + (err?.message || 'unknown error');
      });
      return;
    }
    // dt-form.31 modal click delegations moved to the overlay element in
    // openSubmitFinalModal() — see issue #89. The overlay is appended to
    // document.body, not to container, so its clicks never reach this
    // listener.
    // DTOSL.2 choice chip handler — removed in NPCR.12 (replaced by the
    // single relationships picker in renderPersonalStorySection).

    // Skill acquisition spec chip toggle
    const skAcqSpec = e.target.closest('[data-skill-acq-spec]');
    if (skAcqSpec) {
      const sp = skAcqSpec.dataset.skillAcqSpec;
      const input = document.getElementById('dt-skill_acq_pool_spec');
      // Toggle: click same spec to deselect
      if (input) input.value = input.value === sp ? '' : sp;
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      scheduleSave();
      return;
    }

    // dt-form.29: Acquisitions row handlers (Add / Remove / Avail dots /
    // Avail unknown / Skill spec chip). Row state is canonical in
    // `responses.acq_resource_rows` / `acq_skill_rows`; click handlers
    // mutate the spread base then re-render. Saves the cycle of
    // legacy-input mutation + DOM dot-class toggles by going straight
    // through collectResponses → mutate → renderForm.
    const acqAddBtn = e.target.closest('[data-acq-add-row]');
    if (acqAddBtn) {
      const rowKey = acqAddBtn.dataset.acqAddRow;
      const cur = collectResponses();
      const arrKey = rowKey === 'skill' ? 'acq_skill_rows' : 'acq_resource_rows';
      let arr = [];
      try { arr = JSON.parse(cur[arrKey] || '[]'); } catch { arr = []; }
      if (!Array.isArray(arr)) arr = [];
      const empty = rowKey === 'skill'
        ? { skill: '', spec: '', description: '', availability: '', merits: [] }
        : { description: '', availability: '', merits: [] };
      arr.push(empty);
      cur[arrKey] = JSON.stringify(arr);
      if (responseDoc) responseDoc.responses = cur;
      else responseDoc = { responses: cur };
      renderForm(container);
      scheduleSave();
      return;
    }
    const acqRemoveBtn = e.target.closest('[data-acq-row-remove]');
    if (acqRemoveBtn) {
      const rowKey = acqRemoveBtn.dataset.acqRowRemove;
      const idx = parseInt(acqRemoveBtn.dataset.acqRowIdx, 10);
      const cur = collectResponses();
      const arrKey = rowKey === 'skill' ? 'acq_skill_rows' : 'acq_resource_rows';
      let arr = [];
      try { arr = JSON.parse(cur[arrKey] || '[]'); } catch { arr = []; }
      if (Array.isArray(arr) && idx >= 0 && idx < arr.length) {
        arr.splice(idx, 1);
        cur[arrKey] = JSON.stringify(arr);
        if (responseDoc) responseDoc.responses = cur;
        else responseDoc = { responses: cur };
        renderForm(container);
        scheduleSave();
      }
      return;
    }
    const acqUnknown = e.target.closest('[data-acq-unknown]');
    if (acqUnknown) {
      const rowKey = acqUnknown.dataset.acqRowKey;
      const idx = acqUnknown.dataset.acqRowIdx;
      const hidden = container.querySelector(`[data-acq-avail-hidden="${rowKey}_${idx}"]`);
      if (hidden) hidden.value = hidden.value === 'unknown' ? '' : 'unknown';
      const cur = collectResponses();
      if (responseDoc) responseDoc.responses = cur;
      else responseDoc = { responses: cur };
      renderForm(container);
      scheduleSave();
      return;
    }
    const acqDot = e.target.closest('[data-acq-dot]');
    if (acqDot) {
      const rowKey = acqDot.dataset.acqRowKey;
      const idx = acqDot.dataset.acqRowIdx;
      const val = String(parseInt(acqDot.dataset.acqDot, 10) || 0);
      const hidden = container.querySelector(`[data-acq-avail-hidden="${rowKey}_${idx}"]`);
      if (hidden) hidden.value = val;
      const cur = collectResponses();
      if (responseDoc) responseDoc.responses = cur;
      else responseDoc = { responses: cur };
      renderForm(container);
      scheduleSave();
      return;
    }
    const acqSkillSpec = e.target.closest('[data-acq-skill-spec]');
    if (acqSkillSpec) {
      const idx = acqSkillSpec.dataset.acqRowIdx;
      const sp = acqSkillSpec.dataset.acqSkillSpec;
      const hidden = container.querySelector(`[data-acq-skill-spec-hidden="${idx}"]`);
      if (hidden) hidden.value = hidden.value === sp ? '' : sp;
      const cur = collectResponses();
      if (responseDoc) responseDoc.responses = cur;
      else responseDoc = { responses: cur };
      renderForm(container);
      scheduleSave();
      return;
    }
    // Contact row toggle
    const contactToggle = e.target.closest('[data-contact-toggle]');
    if (contactToggle && !e.target.closest('[data-contact-clear]')) {
      const n = contactToggle.dataset.contactToggle;
      const panel = container.querySelector(`[data-contact-panel="${n}"]`);
      if (panel) panel.classList.toggle('dt-contact-panel-hidden');
      return;
    }
    // Contact clear button
    const contactClear = e.target.closest('[data-contact-clear]');
    if (contactClear) {
      const n = contactClear.dataset.contactClear;
      const infoEl = document.getElementById(`dt-contact_${n}_info`);
      const reqEl = document.getElementById(`dt-contact_${n}_request`);
      if (infoEl) infoEl.value = '';
      if (reqEl) reqEl.value = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      scheduleSave();
      return;
    }
    // Retainer row toggle
    const retainerToggle = e.target.closest('[data-retainer-toggle]');
    if (retainerToggle && !e.target.closest('[data-retainer-clear]')) {
      const n = retainerToggle.dataset.retainerToggle;
      const panel = container.querySelector(`[data-retainer-panel="${n}"]`);
      if (panel) panel.classList.toggle('dt-contact-panel-hidden');
      return;
    }
    // Retainer clear button
    const retainerClear = e.target.closest('[data-retainer-clear]');
    if (retainerClear) {
      const n = retainerClear.dataset.retainerClear;
      const typeEl = document.getElementById(`dt-retainer_${n}_type`);
      const taskEl = document.getElementById(`dt-retainer_${n}_task`);
      if (typeEl) typeEl.value = '';
      if (taskEl) taskEl.value = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      scheduleSave();
      return;
    }
    // dt-form.28: Mentor row toggle
    const mentorToggle = e.target.closest('[data-mentor-toggle]');
    if (mentorToggle && !e.target.closest('[data-mentor-clear]')) {
      const n = mentorToggle.dataset.mentorToggle;
      const panel = container.querySelector(`[data-mentor-panel="${n}"]`);
      if (panel) panel.classList.toggle('dt-contact-panel-hidden');
      return;
    }
    // dt-form.28: Mentor clear button
    const mentorClear = e.target.closest('[data-mentor-clear]');
    if (mentorClear) {
      const n = mentorClear.dataset.mentorClear;
      const targetEl = document.getElementById(`dt-mentor_${n}_target`);
      const taskEl = document.getElementById(`dt-mentor_${n}_task`);
      if (targetEl) targetEl.value = '';
      if (taskEl) taskEl.value = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      scheduleSave();
      return;
    }
    // dt-form.28: Staff row toggle
    const staffToggle = e.target.closest('[data-staff-toggle]');
    if (staffToggle && !e.target.closest('[data-staff-clear]')) {
      const n = staffToggle.dataset.staffToggle;
      const panel = container.querySelector(`[data-staff-panel="${n}"]`);
      if (panel) panel.classList.toggle('dt-contact-panel-hidden');
      return;
    }
    // dt-form.28: Staff clear button
    const staffClear = e.target.closest('[data-staff-clear]');
    if (staffClear) {
      const n = staffClear.dataset.staffClear;
      const targetEl = document.getElementById(`dt-staff_${n}_target`);
      const taskEl = document.getElementById(`dt-staff_${n}_task`);
      if (targetEl) targetEl.value = '';
      if (taskEl) taskEl.value = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      scheduleSave();
      return;
    }
    // Cast picker modal
    const castBtn = e.target.closest('[data-cast-open]');
    if (castBtn) {
      openCastModal(castBtn.dataset.castOpen, container);
      return;
    }
    // Sphere tab switching
    const sphereTab = e.target.closest('[data-sphere-tab]');
    if (sphereTab) {
      const n = parseInt(sphereTab.dataset.sphereTab, 10);
      activeSphereTab = n;
      container.querySelectorAll('[data-sphere-tab]').forEach(t =>
        t.classList.toggle('dt-proj-tab-active', parseInt(t.dataset.sphereTab, 10) === n)
      );
      container.querySelectorAll('[data-sphere-pane]').forEach(p =>
        p.classList.toggle('dt-proj-pane-hidden', parseInt(p.dataset.spherePane, 10) !== n)
      );
      return;
    }
    // Status tab switching
    const statusTab = e.target.closest('[data-status-tab]');
    if (statusTab) {
      const n = parseInt(statusTab.dataset.statusTab, 10);
      container.querySelectorAll('[data-status-tab]').forEach(t =>
        t.classList.toggle('dt-proj-tab-active', parseInt(t.dataset.statusTab, 10) === n)
      );
      container.querySelectorAll('[data-status-pane]').forEach(p =>
        p.classList.toggle('dt-proj-pane-hidden', parseInt(p.dataset.statusPane, 10) !== n)
      );
      return;
    }
    // Project tab switching
    const tab = e.target.closest('[data-proj-tab]');
    if (tab) {
      const n = parseInt(tab.dataset.projTab, 10);
      activeProjectTab = n;
      container.querySelectorAll('.dt-proj-tab').forEach(t =>
        t.classList.toggle('dt-proj-tab-active', parseInt(t.dataset.projTab, 10) === n)
      );
      container.querySelectorAll('[data-proj-pane]').forEach(p =>
        p.classList.toggle('dt-proj-pane-hidden', parseInt(p.dataset.projPane, 10) !== n)
      );
      return;
    }
    // Section collapse/expand
    const title = e.target.closest('.qf-section-title');
    if (!title) return;
    if (e.target.closest('[data-star-val]')) return;
    const section = title.closest('.qf-section');
    if (section) section.classList.toggle('collapsed');
  });

  container.addEventListener('input', (e) => {
    scheduleSave();
    updateSectionTicks(container);

    // DTR.1: reveal the next highlight slot when the current one gets content.
    const hl = e.target.closest('.dt-highlight-input');
    if (hl) {
      const hasText = hl.value.trim().length > 0;
      const n = Number(hl.dataset.highlightN);
      if (hasText && n >= 3 && n < 5) {
        const next = container.querySelector(`.dt-highlight-slot[data-highlight-n="${n + 1}"]`);
        if (next && next.style.display === 'none') next.style.display = '';
      }
    }

    // Live update contact/retainer row status badges
    const contactPanel = e.target.closest('[data-contact-panel]');
    if (contactPanel) {
      const n = contactPanel.dataset.contactPanel;
      const row = container.querySelector(`[data-contact-row="${n}"]`);
      if (row) {
        const info = document.getElementById(`dt-contact_${n}_info`);
        const req = document.getElementById(`dt-contact_${n}_request`);
        const hasContent = (info && info.value.trim()) || (req && req.value.trim());
        row.classList.toggle('dt-contact-used', !!hasContent);
        const badge = row.querySelector('.dt-contact-status');
        if (badge) badge.textContent = hasContent ? 'Used' : 'Unused';
      }
    }
    const retainerPanel = e.target.closest('[data-retainer-panel]');
    if (retainerPanel) {
      const n = retainerPanel.dataset.retainerPanel;
      const row = container.querySelector(`[data-retainer-row="${n}"]`);
      if (row) {
        const typeEl = document.getElementById(`dt-retainer_${n}_type`);
        const taskEl = document.getElementById(`dt-retainer_${n}_task`);
        const hasContent = (typeEl && typeEl.value.trim()) || (taskEl && taskEl.value.trim());
        row.classList.toggle('dt-contact-used', !!hasContent);
        const badge = row.querySelector('.dt-contact-status');
        if (badge) badge.textContent = hasContent ? 'Tasked' : 'Idle';
      }
    }
    // dt-form.28: live status update for Mentor / Staff rows.
    const mentorPanel = e.target.closest('[data-mentor-panel]');
    if (mentorPanel) {
      const n = mentorPanel.dataset.mentorPanel;
      const row = container.querySelector(`[data-mentor-row="${n}"]`);
      if (row) {
        const targetEl = document.getElementById(`dt-mentor_${n}_target`);
        const taskEl = document.getElementById(`dt-mentor_${n}_task`);
        const hasContent = (targetEl && targetEl.value.trim()) || (taskEl && taskEl.value.trim());
        row.classList.toggle('dt-contact-used', !!hasContent);
        const badge = row.querySelector('.dt-contact-status');
        if (badge) badge.textContent = hasContent ? 'Asked' : 'Idle';
      }
    }
    const staffPanel = e.target.closest('[data-staff-panel]');
    if (staffPanel) {
      const n = staffPanel.dataset.staffPanel;
      const row = container.querySelector(`[data-staff-row="${n}"]`);
      if (row) {
        const targetEl = document.getElementById(`dt-staff_${n}_target`);
        const taskEl = document.getElementById(`dt-staff_${n}_task`);
        const hasContent = (targetEl && targetEl.value.trim()) || (taskEl && taskEl.value.trim());
        row.classList.toggle('dt-contact-used', !!hasContent);
        const badge = row.querySelector('.dt-contact-status');
        if (badge) badge.textContent = hasContent ? 'Tasked' : 'Idle';
      }
    }
  });
  container.addEventListener('change', (e) => {
    // #508/#522: Carthian Pull — a change on the "new dot" row's target/sphere
    // writes the full allocation set to the character, then re-renders.
    if (e.target.id === 'dt-carthian_target' || e.target.id === 'dt-carthian_sphere') {
      _onCarthianNewRowChange(container);
      return;
    }
    // dt-form.33: NPCR.12/13 relationship-picker change handler removed.
    // The story-moment relationship picker (a DB-relational element) was
    // suppressed under the broader NPC-interaction policy alongside the
    // legacy renderer deletion. No DOM element with id
    // `dt-story_moment_relationship_id` is rendered anywhere now.

    // dt-form.33: legacy free-text NPC name `_free` change handler removed.
    // The legacy renderer that emitted `dt-personal_story_npc_name_free` is
    // gone; dt-form.18's option Y uses `dt-personal_story_npc_name` directly
    // as a typed-string input, no `_free` mirror needed.
    if (['dt-rote-disc', 'dt-rote-custom-attr', 'dt-rote-custom-skill'].includes(e.target.id)) {
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Territory radio change — re-render to update vitae projection (legacy path, kept for safety)
    if (e.target.closest('[data-feed-terr]')) {
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    const gateInput = e.target.closest('[data-gate]');
    if (gateInput) {
      gateValues[gateInput.dataset.gate] = gateInput.value;
      updateGatedSections(container);
    }
    // Merit toggle
    const meritToggle = e.target.closest('[data-merit-toggle]');
    if (meritToggle) {
      const mk = meritToggle.dataset.meritToggle;
      gateValues[`merit_${mk}`] = meritToggle.value;
      updateMeritSections(container);
    }
    // Issue #102 (2026-05-08): legacy XP category/item picker click handler
    // deleted — the data-xp-pick-cat / data-xp-pick-item attributes were
    // emitted only by the dead-code-wrapped legacy block. The redesigned
    // multi-row grid uses [data-xp-row] / [data-xp-cat] / [data-xp-item].
    // Project action change — re-render to show correct fields for action type
    const projectAction = e.target.closest('[data-project-action]');
    if (projectAction) {
      activeProjectTab = parseInt(projectAction.dataset.projectAction, 10);
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // dt-form.24: Single/Dual roll toggle handler removed alongside
    // renderSecondaryDicePool. No DOM emits `[data-project-pool-count]`
    // anymore; defensive delegation harmless if a stale element somehow
    // survives.
    // Sphere action change — re-render for action-specific fields
    const sphereAction = e.target.closest('[data-sphere-action]');
    if (sphereAction) {
      activeSphereTab = parseInt(sphereAction.dataset.sphereAction, 10);
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Grow target dots — re-render to update XP cost display
    if (e.target.dataset.growTarget !== undefined) {
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Status action change — re-render for action-specific fields
    const statusAction = e.target.closest('[data-status-action]');
    if (statusAction) {
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Flex target type radio — re-render to show correct input
    const flexType = e.target.closest('[data-flex-type]');
    if (flexType) {
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Attack outcome ticker radio
    const projOutcome = e.target.closest('[data-proj-outcome]');
    if (projOutcome) {
      scheduleSave();
      return;
    }
    // Issue #165 (2026-05-08): the dt-form.25 ambience-arrow handler used
    // to live here in the `change` listener — but `<button>` clicks fire
    // `click`, not `change`, so this never executed. Moved to the click
    // listener below, where the maintenance-chip / feeding-card / blood-type
    // button handlers live.
    // dt-form.25: legacy improve/degrade ticker handler retained for
    // sphere-side ambience_change (sphere keeps the legacy radio). Project
    // side no longer emits `[data-proj-ambience-dir]` after the row-table
    // redesign; this branch is unreachable for projects but kept defensively.
    const projAmbienceDir = e.target.closest('[data-proj-ambience-dir]');
    if (projAmbienceDir) {
      activeProjectTab = parseInt(projAmbienceDir.dataset.projAmbienceDir, 10);
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Sphere/Status ambience direction ticker — re-render so resolved action reflects direction
    const sphereAmbienceDir = e.target.closest('[data-sphere-ambience-dir]');
    if (sphereAmbienceDir) {
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Dice pool dropdown — update total, then re-render so spec chips appear
    // (or disappear) for the newly-selected skill. Skill change clears any
    // stale spec from the prior skill.
    const poolSelect = e.target.closest('[data-pool-prefix]');
    if (poolSelect) {
      const prefix = poolSelect.dataset.poolPrefix;
      updatePoolTotal(prefix);
      // If the changed dropdown is the skill picker, clear any stale spec.
      if (poolSelect.id === `dt-${prefix}_skill`) {
        const specHidden = document.getElementById(`dt-${prefix}_spec`);
        if (specHidden) specHidden.value = '';
      }
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Issue #165 (2026-05-08): the spec-chip handler used to live here in
    // the `change` listener — same root cause as the ambience-arrow bug.
    // `<button>` clicks fire `click`, not `change`. Moved to the click
    // listener below. (My earlier #164 fix landed the canonical-first
    // writes correctly but the handler itself was never firing — only
    // the dropdown-label cleanup actually shipped a user-visible change.
    // This PR restores the chip toggle behaviour the issue spec asked for.)
    // XP category/item change — collect current state and re-render
    const xpCat = e.target.closest('[data-xp-cat]');
    const xpItem = e.target.closest('[data-xp-item]');
    const xpDots = e.target.closest('[data-xp-dots]');
    if (xpCat || xpItem || xpDots) {
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // dt-form.29: Skill row select change — re-render so the spec-chip
    // strip rebuilds for the new skill and the read-only pool annotation
    // updates. Spec is cleared on skill change to avoid carrying a spec
    // that doesn't apply to the newly-selected skill.
    if (e.target.matches('[data-acq-skill]')) {
      const idx = e.target.dataset.acqSkill;
      const specHidden = container.querySelector(`[data-acq-skill-spec-hidden="${idx}"]`);
      if (specHidden) specHidden.value = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Sorcery rite selection — re-render to show details
    const sorcerySelect = e.target.closest('[data-sorcery-slot]');
    if (sorcerySelect) {
      // Save current responses before re-render
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Main feed pool selector changes
    const feedPoolSel = e.target.closest('#dt-feed-custom-attr, #dt-feed-custom-skill, #dt-feed-disc');
    if (feedPoolSel) {
      const prevSkill = feedCustomSkill;
      feedCustomAttr = document.getElementById('dt-feed-custom-attr')?.value || feedCustomAttr;
      feedCustomSkill = document.getElementById('dt-feed-custom-skill')?.value || feedCustomSkill;
      feedDiscName = document.getElementById('dt-feed-disc')?.value || feedDiscName;
      if (feedCustomSkill !== prevSkill) feedSpecName = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    scheduleSave();
    updateSectionTicks(container);
  });

  // Click handler (feeding cards, spec chips, influence +/-)
  container.addEventListener('click', (e) => {
    // Feeding method cards
    const feedCard = e.target.closest('[data-feed-method]');
    if (feedCard) {
      feedMethodId = feedCard.dataset.feedMethod;
      feedDiscName = ''; feedSpecName = '';
      feedCustomAttr = ''; feedCustomSkill = ''; feedCustomDisc = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }

    // Issue #165 (2026-05-08): dt-form.25 Ambience row-table arrow click.
    // Single-target state machine per the dt-form.25 ACs:
    //   - new row click           → switch to (newRow, clickedDir)
    //   - opposite arrow same row → switch direction, retain row
    //   - same arrow same row     → toggle off (clear both)
    // Originally placed in the `change` listener which never fires for
    // `<button>` clicks; moved here so the chip click actually executes
    // the state machine. Uses canonical-first state pattern (writes
    // `responseDoc.responses` first, mirrors to DOM, then renders).
    const ambArrow = e.target.closest('[data-amb-arrow]');
    if (ambArrow) {
      e.preventDefault();
      const slot     = ambArrow.dataset.ambSlot;
      const target   = ambArrow.dataset.ambTarget;
      const dirClick = ambArrow.dataset.ambArrow; // 'up' | 'down'
      const targetKey = `project_${slot}_ambience_target`;
      const dirKey    = `project_${slot}_ambience_direction`;
      const baseResponses = (responseDoc && responseDoc.responses) || {};
      // Issue #496 / #816: normalise before comparing. `data-amb-target` is a
      // slug, but after a collect the stored value is an OID — without this the
      // same-arrow-twice case read as "new row" and re-set instead of toggling
      // off, so the selection could never be cleared.
      const curTarget = _terrSlugFromSaved(baseResponses[targetKey]);
      const curDir    = baseResponses[dirKey]    || '';
      let nextTarget;
      let nextDir;
      if (curTarget === target && curDir === dirClick) {
        // same arrow same row → toggle off
        nextTarget = '';
        nextDir    = '';
      } else {
        // new row OR opposite arrow same row → set to clicked
        nextTarget = target;
        nextDir    = dirClick;
      }
      // Canonical-first: spread + write to responseDoc.responses BEFORE
      // mirroring to DOM, so renderForm reads the new state cleanly.
      const nextResponses = { ...baseResponses, [targetKey]: nextTarget, [dirKey]: nextDir };
      const targetEl = document.getElementById(`dt-project_${slot}_ambience_target`);
      const dirEl    = document.getElementById(`dt-project_${slot}_ambience_direction`);
      if (targetEl) targetEl.value = nextTarget;
      if (dirEl)    dirEl.value    = nextDir;
      activeProjectTab = parseInt(slot, 10) || activeProjectTab;
      if (responseDoc) responseDoc.responses = nextResponses;
      else responseDoc = { responses: nextResponses };
      renderForm(container);
      scheduleSave();
      return;
    }

    // Issue #165 (2026-05-08): Project dice pool spec chip — toggle selection
    // and re-render. Same root-cause story as ambience-arrow above: the
    // handler was misplaced in the `change` listener and never fired for
    // button clicks. Moved here. Canonical-first state pattern.
    const poolSpecChip = e.target.closest('[data-pool-spec]');
    if (poolSpecChip) {
      const prefix = poolSpecChip.dataset.poolSpec;
      const specName = poolSpecChip.dataset.specName || '';
      const key = `${prefix}_spec`;
      const baseResponses = (responseDoc && responseDoc.responses) || {};
      const cur = baseResponses[key] || '';
      const next = cur === specName ? '' : specName;
      const nextResponses = { ...baseResponses, [key]: next };
      const hidden = document.getElementById(`dt-${prefix}_spec`);
      if (hidden) hidden.value = next;
      if (responseDoc) responseDoc.responses = nextResponses;
      else responseDoc = { responses: nextResponses };
      renderForm(container);
      scheduleSave();
      return;
    }
    // Blood type toggle — single-select pill buttons
    const bloodBtn = e.target.closest('[data-blood-type]');
    if (bloodBtn) {
      const wasOn = bloodBtn.classList.contains('dt-feed-vi-on');
      document.querySelectorAll('[data-blood-type]').forEach(b => b.classList.remove('dt-feed-vi-on'));
      if (!wasOn) bloodBtn.classList.add('dt-feed-vi-on');
      scheduleSave();
      return;
    }
    // Rote hunt toggle (Standard / Rote pill pair)
    const roteBtn = e.target.closest('[data-feed-rote]');
    if (roteBtn) {
      feedRoteAction = roteBtn.dataset.feedRote === 'on';
      applyRoteToProjectSlot(container);
      return;
    }
    // DTFP-5: Kiss / Violent toggle
    const viBtn = e.target.closest('[data-feed-violence]');
    if (viBtn) {
      if (!responseDoc) responseDoc = { responses: {} };
      if (!responseDoc.responses) responseDoc.responses = {};
      responseDoc.responses.feed_violence = viBtn.dataset.feedViolence;
      renderForm(container);
      scheduleSave();
      return;
    }
    // DTFP-6: sorcery target row add / remove
    const addTargetBtn = e.target.closest('.dt-sorcery-target-add-btn');
    if (addTargetBtn) {
      const responses = collectResponses();
      const slot = addTargetBtn.dataset.sorcerySlot;
      const key = `sorcery_${slot}_targets`;
      const arr = Array.isArray(responses[key]) ? responses[key] : [];
      arr.push({ type: '', value: '' });
      responses[key] = arr;
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    const removeTargetBtn = e.target.closest('.dt-sorcery-target-remove-btn');
    if (removeTargetBtn) {
      const responses = collectResponses();
      const slot = removeTargetBtn.dataset.sorcerySlot;
      const idx = Number(removeTargetBtn.dataset.targetIdx);
      const key = `sorcery_${slot}_targets`;
      const arr = Array.isArray(responses[key]) ? responses[key] : [];
      arr.splice(idx, 1);
      if (arr.length === 0) arr.push({ type: '', value: '' }); // keep one empty row
      responses[key] = arr;
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      scheduleSave();
      return;
    }
    // XP row: add a new empty row immediately (no debounce)
    const addXpRowBtn = e.target.closest('[data-xp-add-slot]');
    if (addXpRowBtn) {
      const responses = collectResponses();
      const slot = addXpRowBtn.dataset.xpAddSlot;
      const key = `project_${slot}_xp_rows`;
      let rows = [];
      try { rows = JSON.parse(responses[key] || '[]'); } catch { rows = []; }
      rows.push({ category: '', item: '', dotsBuying: 0 });
      responses[key] = JSON.stringify(rows);
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // XP row: remove a row immediately and save
    const removeXpRowBtn = e.target.closest('[data-xp-remove-slot]');
    if (removeXpRowBtn) {
      const responses = collectResponses();
      const slot = removeXpRowBtn.dataset.xpRemoveSlot;
      const idx = Number(removeXpRowBtn.dataset.xpRemoveIdx);
      const key = `project_${slot}_xp_rows`;
      let rows = [];
      try { rows = JSON.parse(responses[key] || '[]'); } catch { rows = []; }
      rows.splice(idx, 1);
      responses[key] = JSON.stringify(rows);
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      scheduleSave();
      return;
    }
    // dt-form.33: NPC card click handler removed alongside the
    // _legacyRenderPersonalStorySection deletion. No DOM element with
    // [data-npc-pick] is rendered anywhere now.
    // dt-form.16: target character chip handler removed — universal charPicker
    // mounted in renderTargetCharOrOther handles its own selection lifecycle.
    // Maintenance merit chip — single-select, writes to hidden target_value input.
    // Issue #170 (2026-05-08): hardened with canonical-first state writes +
    // re-render so SIBLING slots' chip availability re-evaluates immediately.
    // Previously the handler only mutated the local DOM; sibling slots couldn't
    // see the new selection until something else triggered a render, leaving
    // their disabled-chip state stale across add/remove/re-add cycles.
    const maintChip = e.target.closest('[data-maintenance-target]');
    if (maintChip && !maintChip.disabled) {
      const slotNum = maintChip.dataset.maintenanceTarget;
      const mPrefix = maintChip.dataset.maintenancePrefix || 'project';
      const targetId = maintChip.dataset.targetId;
      const key = `${mPrefix}_${slotNum}_target_value`;
      const baseResponses = (responseDoc && responseDoc.responses) || {};
      const wasSelected = baseResponses[key] === targetId;
      const next = wasSelected ? '' : targetId;
      // Canonical-first write — mirrors the spec-chip pattern (#164) and
      // mode-pill / ambience-arrow handlers. Sibling slots reading
      // `responses.project_*_target_value` see the new state on re-render.
      const nextResponses = { ...baseResponses, [key]: next };
      const hidden = document.getElementById(`dt-${mPrefix}_${slotNum}_target_value`);
      if (hidden) hidden.value = next;
      if (responseDoc) responseDoc.responses = nextResponses;
      else responseDoc = { responses: nextResponses };
      renderForm(container);
      scheduleSave();
      return;
    }
    // dt-form.16: shoutout chip handler removed — universal charPicker mounted
    // in the shoutout_picks case handles selection and 3-pick cap via remount.

    const sphereCharChip = e.target.closest('[data-sphere-char-target]');
    if (sphereCharChip && !sphereCharChip.disabled) {
      const prefixN = sphereCharChip.dataset.sphereCharTarget; // e.g. 'sphere_2'
      const charId = sphereCharChip.dataset.charId;
      const wasSelected = sphereCharChip.classList.contains('dt-chip--selected');
      container.querySelectorAll(`[data-sphere-char-target="${prefixN}"]`).forEach(el => el.classList.remove('dt-chip--selected'));
      const hidden = document.getElementById(`dt-${prefixN}_target_value`);
      if (!wasSelected) {
        sphereCharChip.classList.add('dt-chip--selected');
        saved[`${prefixN}_target_value`] = charId;
        if (hidden) hidden.value = charId;
      } else {
        saved[`${prefixN}_target_value`] = '';
        if (hidden) hidden.value = '';
      }
      scheduleSave();
      return;
    }
    // Single-select territory pills
    const terrPill = e.target.closest('[data-terr-single][data-terr-val]');
    if (terrPill) {
      const fieldId = terrPill.dataset.terrSingle;
      const val = terrPill.dataset.terrVal;
      const hidden = document.getElementById(fieldId);
      const currentVal = hidden ? hidden.value : '';
      const newVal = currentVal === val ? '' : val; // toggle off if same
      if (hidden) hidden.value = newVal;
      // Update pill active states without full re-render
      container.querySelectorAll(`[data-terr-single="${fieldId}"]`).forEach(p => {
        p.classList.toggle('dt-chip--selected', p.dataset.terrVal === newVal);
      });
      scheduleSave();
      updateSectionTicks(container);
      return;
    }
    // Single-select feeding territory pills (main)
    const feedTerrPill = e.target.closest('[data-feed-terr-key]');
    if (feedTerrPill) {
      const terrKey = feedTerrPill.dataset.feedTerrKey;
      const statusVal = feedTerrPill.dataset.feedStatus;
      const isActive = feedTerrPill.dataset.feedActive === '1';
      container.querySelectorAll('[data-feed-terr-key]').forEach(pill => {
        const key = pill.dataset.feedTerrKey;
        if (key !== terrKey) {
          const h = document.getElementById(`feed-val-${key}`);
          if (h) h.value = 'none';
        }
      });
      const hidden = document.getElementById(`feed-val-${terrKey}`);
      if (hidden) hidden.value = isActive ? 'none' : statusVal;
      // Sync rote selection: clear it if the new main selection makes it invalid.
      // A rote pick is invalid when (main=Barrens AND rote!=Barrens) or
      // (main!=Barrens AND rote=Barrens).
      const newMainIsBarrens = !isActive && statusVal === 'barrens';
      container.querySelectorAll('[data-feed-rote-terr-key]').forEach(rotePill => {
        const rk = rotePill.dataset.feedRoteTerrKey;
        const rh = document.getElementById(`feed-rote-val-${rk}`);
        if (!rh || rh.value === 'none') return;
        const roteIsBarrens = rotePill.dataset.feedRoteStatus === 'barrens';
        if (newMainIsBarrens !== roteIsBarrens) rh.value = 'none';
      });
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Single-select rote territory pills
    const feedRoteTerrPill = e.target.closest('[data-feed-rote-terr-key]');
    if (feedRoteTerrPill) {
      const terrKey = feedRoteTerrPill.dataset.feedRoteTerrKey;
      const statusVal = feedRoteTerrPill.dataset.feedRoteStatus;
      const isActive = feedRoteTerrPill.dataset.feedRoteActive === '1';
      container.querySelectorAll('[data-feed-rote-terr-key]').forEach(pill => {
        const key = pill.dataset.feedRoteTerrKey;
        if (key !== terrKey) {
          const h = document.getElementById(`feed-rote-val-${key}`);
          if (h) h.value = 'none';
        }
      });
      const hidden = document.getElementById(`feed-rote-val-${terrKey}`);
      if (hidden) hidden.value = isActive ? 'none' : statusVal;
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Feed suggestion chips (quick-fill attr or skill)
    const feedChipAttr = e.target.closest('[data-feed-chip-attr]');
    if (feedChipAttr) {
      feedCustomAttr = feedChipAttr.dataset.feedChipAttr;
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    const feedChipSkill = e.target.closest('[data-feed-chip-skill]');
    if (feedChipSkill) {
      feedCustomSkill = feedChipSkill.dataset.feedChipSkill;
      feedSpecName = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Rote suggestion chips
    const feedChipDisc = e.target.closest('[data-feed-chip-disc]');
    if (feedChipDisc) {
      feedDiscName = feedChipDisc.dataset.feedChipDisc;
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    const roteChipDisc = e.target.closest('[data-rote-chip-disc]');
    if (roteChipDisc) {
      feedRoteDisc = roteChipDisc.dataset.roteChipDisc;
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    const roteChipAttr = e.target.closest('[data-rote-chip-attr]');
    if (roteChipAttr) {
      feedRoteCustomAttr = roteChipAttr.dataset.roteChipAttr;
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    const roteChipSkill = e.target.closest('[data-rote-chip-skill]');
    if (roteChipSkill) {
      feedRoteCustomSkill = roteChipSkill.dataset.roteChipSkill;
      feedRoteSpec = '';
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Feeding spec chips
    const specChip = e.target.closest('[data-feed-spec]');
    if (specChip) {
      if (specChip.dataset.roteSpec !== undefined) {
        feedRoteSpec = feedRoteSpec === specChip.dataset.feedSpec ? '' : specChip.dataset.feedSpec;
      } else {
        feedSpecName = feedSpecName === specChip.dataset.feedSpec ? '' : specChip.dataset.feedSpec;
      }
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Mandragora Garden checkbox — re-render so the capacity counter and
    // disabled state on other slots' Park toggles update (2c).
    const mandCb = e.target.closest('.dt-mand-cb[id$="_mandragora"]');
    if (mandCb) {
      const responses = collectResponses();
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Add Rite button
    if (e.target.closest('#dt-add-rite')) {
      const responses = collectResponses();
      const countEl = document.getElementById('dt-sorcery-slot-count');
      const current = countEl ? parseInt(countEl.value, 10) || 1 : 1;
      responses['sorcery_slot_count'] = String(current + 1);
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Remove Rite button
    const removeRiteBtn = e.target.closest('[data-remove-rite]');
    if (removeRiteBtn) {
      const removeN = parseInt(removeRiteBtn.dataset.removeRite, 10);
      const responses = collectResponses();
      const countEl = document.getElementById('dt-sorcery-slot-count');
      const current = countEl ? parseInt(countEl.value, 10) || 1 : 1;
      // Shift slots down
      for (let n = removeN; n < current; n++) {
        responses[`sorcery_${n}_rite`] = responses[`sorcery_${n + 1}_rite`] || '';
        responses[`sorcery_${n}_targets`] = responses[`sorcery_${n + 1}_targets`] || '';
        responses[`sorcery_${n}_notes`] = responses[`sorcery_${n + 1}_notes`] || '';
        responses[`sorcery_${n}_mandragora`] = responses[`sorcery_${n + 1}_mandragora`] || 'no';
      }
      // Clear last slot
      delete responses[`sorcery_${current}_rite`];
      delete responses[`sorcery_${current}_targets`];
      delete responses[`sorcery_${current}_notes`];
      delete responses[`sorcery_${current}_mandragora`];
      responses['sorcery_slot_count'] = String(Math.max(1, current - 1));
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // dt-form.29: legacy `#dt-add-acquisition` and `[data-remove-acq]`
    // handlers removed. Add/Remove now goes through the structured-row
    // path at `[data-acq-add-row]` / `[data-acq-row-remove]` which mutates
    // `responses.acq_resource_rows` / `acq_skill_rows` directly. Mirror
    // builder rebuilds the legacy `acq_slot_count` + per-slot keys on save.
    // Add Equipment button
    if (e.target.closest('#dt-add-equipment')) {
      const responses = collectResponses();
      const countEl = document.getElementById('dt-equipment-slot-count');
      const current = countEl ? parseInt(countEl.value, 10) || 1 : 1;
      responses['equipment_slot_count'] = String(current + 1);
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    // Remove Equipment button
    const removeEquipBtn = e.target.closest('[data-remove-equipment]');
    if (removeEquipBtn) {
      const removeN = parseInt(removeEquipBtn.dataset.removeEquipment, 10);
      const responses = collectResponses();
      const countEl = document.getElementById('dt-equipment-slot-count');
      const current = countEl ? parseInt(countEl.value, 10) || 1 : 1;
      // Shift slots down. ECM-4 (#871): canonical key is `_catalogue_id`;
      // the legacy `_name` key is shifted alongside for in-flight
      // submissions whose pre-ECM-4 free-text values still ride on the
      // response doc (silent-leave per Khepri's backcompat dispatch).
      for (let n = removeN; n < current; n++) {
        responses[`equipment_${n}_catalogue_id`] = responses[`equipment_${n + 1}_catalogue_id`] || '';
        responses[`equipment_${n}_name`] = responses[`equipment_${n + 1}_name`] || '';
        responses[`equipment_${n}_qty`] = responses[`equipment_${n + 1}_qty`] || '1';
        responses[`equipment_${n}_notes`] = responses[`equipment_${n + 1}_notes`] || '';
      }
      // Clear last slot
      delete responses[`equipment_${current}_catalogue_id`];
      delete responses[`equipment_${current}_name`];
      delete responses[`equipment_${current}_qty`];
      delete responses[`equipment_${current}_notes`];
      responses['equipment_slot_count'] = String(Math.max(1, current - 1));
      if (responseDoc) responseDoc.responses = responses;
      else responseDoc = { responses };
      renderForm(container);
      return;
    }
    const btn = e.target.closest('[data-inf-terr]');
    if (!btn) return;
    const tk = btn.dataset.infTerr;
    const dir = parseInt(btn.dataset.infDir, 10);
    const valEl = document.getElementById(`inf-val-${tk}`);
    if (!valEl) return;

    const budget = getInfluenceBudget();
    let currentVal = parseInt(valEl.textContent, 10) || 0;
    const newVal = currentVal + dir;

    // Calculate what total spent would be with this change
    let totalSpent = Math.abs(newVal);
    for (const terr of INFLUENCE_TERRITORIES) {
      const otherTk = terr.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (otherTk === tk) continue;
      const otherEl = document.getElementById(`inf-val-${otherTk}`);
      totalSpent += Math.abs(otherEl ? parseInt(otherEl.textContent, 10) || 0 : 0);
    }

    // Block if over budget
    if (totalSpent > budget) return;

    valEl.textContent = newVal;
    // Colour negative values
    valEl.classList.toggle('dt-inf-negative', newVal < 0);
    valEl.classList.toggle('dt-inf-positive', newVal > 0);

    // Sync ambience-direction labels around the stepper (DTFP-1).
    // Both label spans are always in the DOM; just update text so the
    // stepper column doesn't shift horizontally between rows.
    const controlEl = valEl.closest('.dt-influence-control');
    if (controlEl) {
      const leftEl  = controlEl.querySelector('.dt-influence-label-left');
      const rightEl = controlEl.querySelector('.dt-influence-label-right');
      if (leftEl)  leftEl.textContent  = newVal < 0 ? 'decreasing ambience' : '';
      if (rightEl) rightEl.textContent = newVal > 0 ? 'increasing ambience' : '';
    }

    // Update budget display
    const remaining = budget - totalSpent;
    const budgetEl = document.getElementById('dt-influence-budget');
    if (budgetEl) {
      const remSpan = budgetEl.querySelector('.dt-influence-remaining');
      if (remSpan) {
        remSpan.textContent = remaining;
        remSpan.classList.toggle('dt-influence-over', remaining < 0);
      }
    }

    // Refresh disabled states so buttons reflect the new remaining value.
    for (const t of INFLUENCE_TERRITORIES) {
      const otherTk = t.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const otherEl = document.getElementById(`inf-val-${otherTk}`);
      const v = otherEl ? parseInt(otherEl.textContent, 10) || 0 : 0;
      const mBtn = document.querySelector(`[data-inf-terr="${otherTk}"][data-inf-dir="-1"]`);
      const pBtn = document.querySelector(`[data-inf-terr="${otherTk}"][data-inf-dir="1"]`);
      if (mBtn) mBtn.disabled = v <= 0 && remaining <= 0;
      if (pBtn) pBtn.disabled = v >= 0 && remaining <= 0;
    }

    scheduleSave();
  });

  // ── Star rating hover + click ──
  container.addEventListener('mouseover', (e) => {
    const half = e.target.closest('[data-star-val]');
    if (!half) return;
    const row = half.closest('.dt-star-row');
    if (!row) return;
    const hoverVal = parseInt(half.dataset.starVal, 10);
    row.querySelectorAll('[data-star-val]').forEach(el => {
      const v = parseInt(el.dataset.starVal, 10);
      el.classList.toggle('dt-star-hover', v <= hoverVal);
    });
    const label = row.querySelector('.dt-star-label');
    if (label) label.textContent = hoverVal + '/10';
  });

  container.addEventListener('mouseout', (e) => {
    const half = e.target.closest('[data-star-val]');
    if (!half) return;
    const row = half.closest('.dt-star-row');
    if (!row) return;
    const input = document.getElementById(row.dataset.starInput);
    const cur = parseInt(input?.value, 10) || 0;
    row.querySelectorAll('[data-star-val]').forEach(el => {
      el.classList.remove('dt-star-hover');
    });
    const label = row.querySelector('.dt-star-label');
    if (label) label.textContent = cur ? cur + '/10' : '';
  });

  container.addEventListener('click', (e) => {
    const half = e.target.closest('[data-star-val]');
    if (!half) return;
    const row = half.closest('.dt-star-row');
    if (!row) return;
    const val = parseInt(half.dataset.starVal, 10);
    const input = document.getElementById(row.dataset.starInput);
    if (input) {
      input.value = val;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Update filled state
    row.querySelectorAll('[data-star-val]').forEach(el => {
      const v = parseInt(el.dataset.starVal, 10);
      el.classList.toggle('dt-star-filled', v <= val);
    });
    const label = row.querySelector('.dt-star-label');
    if (label) label.textContent = val + '/10';
    // Reveal feedback field
    const fb = container.querySelector('.dt-feedback-field');
    if (fb) fb.classList.remove('dt-feedback-hidden');
    scheduleSave();
    updateSectionTicks(container);
  });

  // dt-form.34: submit handled via delegated click listener above (survives re-renders).
}

// ── Cast picker modal ──

function openCastModal(slotId, container) {
  // slotId is either a number (project slot) or "sphere_N" string
  const castKey = typeof slotId === 'number' || /^\d+$/.test(slotId)
    ? `project_${slotId}_cast`
    : `${slotId}_cast`;
  const saved = responseDoc?.responses || {};
  let castPicks = [];
  try { castPicks = JSON.parse(saved[castKey] || '[]'); } catch { /* ignore */ }
  const attendeeIds = new Set(lastGameAttendees.map(a => String(a.id)));

  // Build modal HTML
  let h = '<div class="plm-overlay" id="dt-cast-overlay">';
  h += '<div class="plm-dialog dt-cast-modal">';
  h += '<div class="plm-header">';
  const modalTitle = typeof slotId === 'number' || /^\d+$/.test(slotId)
    ? `Select Characters — Action ${slotId}`
    : `Select Characters — Sphere ${slotId.replace('sphere_', '')}`;
  h += `<h3>${modalTitle}</h3>`;
  h += '<button type="button" class="cd-close" id="dt-cast-close">\u00D7</button>';
  h += '</div>';

  // Filter toggle
  h += '<div class="dt-cast-filter">';
  h += '<label class="dt-cast-filter-label"><input type="checkbox" id="dt-cast-filter-att"> Show only last game attendees</label>';
  h += '</div>';

  h += '<div class="dt-cast-list" id="dt-cast-list">';
  for (const c of allCharacters) {
    const isAtt = attendeeIds.has(String(c.id));
    const checked = castPicks.includes(c.id) || castPicks.includes(String(c.id)) ? ' checked' : '';
    const initials = (c.name || '?').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
    h += `<label class="dt-cast-item${isAtt ? ' dt-cast-att' : ''}" data-att="${isAtt ? '1' : '0'}">`;
    h += `<div class="dt-cast-avatar">${initials}</div>`;
    h += '<div class="dt-cast-info">';
    h += `<div class="dt-cast-charname">${esc(redactCharName(c.name))}</div>`;
    if (c.player) h += `<div class="dt-cast-player">${esc(redactPlayer(c.player))}</div>`;
    h += '</div>';
    h += `<input type="checkbox" class="dt-cast-check" value="${esc(String(c.id))}"${checked}>`;
    h += '</label>';
  }
  if (!allCharacters.length) {
    h += '<p class="dt-cast-empty">No characters available.</p>';
  }
  h += '</div>';

  h += '<div class="dt-cast-modal-footer">';
  h += '<button type="button" class="qf-btn qf-btn-save" id="dt-cast-confirm">Confirm</button>';
  h += '</div>';
  h += '</div></div>';

  // Insert into DOM
  const overlay = document.createElement('div');
  overlay.innerHTML = h;
  document.body.appendChild(overlay.firstElementChild);

  // Filter toggle
  document.getElementById('dt-cast-filter-att')?.addEventListener('change', (e) => {
    const onlyAtt = e.target.checked;
    document.querySelectorAll('.dt-cast-item').forEach(item => {
      if (onlyAtt && item.dataset.att === '0') {
        item.style.display = 'none';
      } else {
        item.style.display = '';
      }
    });
  });

  // Close
  const closeModal = () => {
    document.getElementById('dt-cast-overlay')?.remove();
  };
  document.getElementById('dt-cast-close')?.addEventListener('click', closeModal);
  document.getElementById('dt-cast-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'dt-cast-overlay') closeModal();
  });

  // Confirm
  document.getElementById('dt-cast-confirm')?.addEventListener('click', () => {
    const selected = [];
    document.querySelectorAll('.dt-cast-check:checked').forEach(cb => selected.push(cb.value));
    const responses = collectResponses();
    responses[castKey] = JSON.stringify(selected);
    if (responseDoc) responseDoc.responses = responses;
    else responseDoc = { responses };
    closeModal();
    renderForm(container);
    scheduleSave();
  });
}

// ── Rote feeding → Project 1 ──

function applyRoteToProjectSlot(container) {
  const responses = collectResponses();
  if (feedRoteAction) {
    // Auto-find first available slot
    feedRoteSlot = [1,2,3,4].find(n => {
      const act = responses[`project_${n}_action`];
      return !act || act === 'feed';
    }) || 1;
    responses[`project_${feedRoteSlot}_action`] = 'feed';
    responses['_feed_rote_slot'] = String(feedRoteSlot);
    activeProjectTab = feedRoteSlot;
  } else {
    // Clear all feed slots
    for (let n = 1; n <= 4; n++) {
      if (responses[`project_${n}_action`] === 'feed') {
        responses[`project_${n}_action`] = '';
        responses[`project_${n}_description`] = '';
      }
    }
  }
  if (responseDoc) responseDoc.responses = responses;
  else responseDoc = { responses };
  renderForm(container);
  scheduleSave();
}

// ── Project slots (tabbed UI) ──

// CHM-3: chapter-finale at-risk reminder for PT/MCI standing merits.
// Renders zero, one, or two warning strips at the top of the Personal
// Projects section. Gated on cycle.is_chapter_finale === true; cleared
// per-merit by the ST ticking the matching box on CHM-2's audit panel
// (cycle.maintenance_audit[char_id].{pt,mci}). MAINTENANCE_MERITS is
// the source of truth for the gate set; PT and MCI need different
// strawman copy so they're branched explicitly here.
function maintenanceWarningHtml(meritName, cultNames) {
  const label = cultNames && cultNames.length
    ? `${meritName} (${cultNames.join(', ')})`
    : meritName;
  return `<div class="dt-maintenance-warning">`
    + `<strong>Maintenance reminder.</strong> `
    + `Your <strong>${esc(label)}</strong> has not been logged as maintained this chapter. `
    + `This is the last cycle of the chapter, so use one of your projects below to maintain it, or it will lapse.`
    + `</div>`;
}

function renderMaintenanceWarnings(char, cycle) {
  if (!cycle || cycle.is_chapter_finale !== true) return '';
  if (!char) return '';
  const audit = cycle.maintenance_audit?.[String(char._id)] || {};
  const merits = char.merits || [];
  const out = [];

  const hasPT = merits.some(m => m.name === 'Professional Training');
  if (hasPT && audit.pt !== true) {
    out.push(maintenanceWarningHtml('Professional Training', null));
  }

  const mciMerits = merits.filter(m => m.name === 'Mystery Cult Initiation' && m.active !== false);
  if (mciMerits.length && audit.mci !== true) {
    const cults = mciMerits.map(m => m.cult_name).filter(Boolean);
    out.push(maintenanceWarningHtml('Mystery Cult Initiation', cults));
  }

  return out.join('');
}

function renderProjectSlots(saved, mode = 'advanced') {
  const section = DOWNTIME_SECTIONS.find(s => s.key === 'projects');
  // dt-form.17 (ADR-003 §Q2): MINIMAL renders one project slot only.
  const slotCount = mode === 'minimal' ? 1 : (section?.projectSlots || 4);

  // Build attribute/skill/discipline option lists from character data
  const attrs = ALL_ATTRS.filter(a => getAttrTotal(currentChar, a) > 0);
  const skills = ALL_SKILLS.filter(s => skTotal(currentChar, s) > 0);
  const discs = Object.keys(currentChar.disciplines || {}).filter(d => discDots(currentChar, d) > 0);

  // Character merits for the merit picker and own-merit target
  const charMerits = (currentChar.merits || []).filter(m =>
    m.category === 'general' || m.category === 'influence' || m.category === 'standing'
  );

  const hasMaintenance = (currentChar.merits || []).some(m =>
    MAINTENANCE_MERITS.includes(m.name)
  );
  const availableActions = PROJECT_ACTIONS.filter(opt =>
    opt.value !== 'maintenance' || hasMaintenance
  );

  let h = '<div class="qf-section collapsed" data-section-key="projects">';
  h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">✔</span></h4>`;
  h += '<div class="qf-section-body">';
  h += renderMaintenanceWarnings(currentChar, currentCycle);
  if (section.intro) h += `<p class="qf-section-intro">${esc(section.intro)}</p>`;

  // ── Tab bar ──
  h += '<div class="dt-proj-tabs">';
  for (let n = 1; n <= slotCount; n++) {
    const actionVal = saved[`project_${n}_action`] || '';
    let icon, label;
    if (actionVal === 'ambience_change') {
      const dir = saved[`project_${n}_ambience_dir`] || 'improve';
      icon = dir === 'improve' ? '▲' : '▼';
      label = dir === 'improve' ? 'Ambience +' : 'Ambience −';
    } else {
      icon = ACTION_ICONS[actionVal] || ACTION_ICONS[''];
      label = ACTION_SHORT[actionVal] || 'No Action';
    }
    const active = n === activeProjectTab ? ' dt-proj-tab-active' : '';
    const noAction = !actionVal ? ' dt-proj-tab-empty' : '';
    h += `<button type="button" class="dt-proj-tab${active}${noAction}" data-proj-tab="${n}">`;
    h += `<span class="dt-proj-tab-icon">${icon}</span>`;
    h += `<span class="dt-proj-tab-num">Action ${n}</span>`;
    h += `<span class="dt-proj-tab-label">${esc(label)}</span>`;
    h += '</button>';
  }
  h += '</div>';

  // ── Tab panes ──
  for (let n = 1; n <= slotCount; n++) {
    let actionVal = saved[`project_${n}_action`] || '';
    const visible = n === activeProjectTab;
    // Legacy backward-compat: normalise old ambience action types to ambience_change (dtui-10)
    if (actionVal === 'ambience_increase' || actionVal === 'ambience_decrease') {
      const legacyDir = actionVal === 'ambience_increase' ? 'improve' : 'degrade';
      if (!saved[`project_${n}_ambience_dir`]) saved[`project_${n}_ambience_dir`] = legacyDir;
      actionVal = 'ambience_change';
    }
    let fields = ACTION_FIELDS[actionVal] || [];

    h += `<div class="dt-proj-pane${visible ? '' : ' dt-proj-pane-hidden'}" data-proj-pane="${n}">`;

    // ── Rote-locked slot ──
    const isRoteLocked = feedRoteAction && n === feedRoteSlot;
    if (isRoteLocked) {
      const roteDesc = saved[`project_${n}_description`] || '';
      h += '<div class="dt-proj-rote-locked">';
      h += '<span class="dt-proj-rote-badge">Committed to Feeding (Rote)</span>';
      if (roteDesc) h += `<p class="dt-proj-rote-desc">${esc(roteDesc)}</p>`;
      h += '</div>';
      h += `<input type="hidden" id="dt-project_${n}_action" value="feed">`;
      h += '</div>';
      continue;
    }

    h += '<div class="dt-action-block">';

    // Action type selector — always visible
    // Issue #167 (2026-05-08): ROTE is single-instance per cycle. If any
    // sibling slot already holds 'rote', filter it out of THIS slot's
    // dropdown (unless this slot itself is currently 'rote', so the user
    // can still see + change/clear their existing selection). Legacy
    // submissions with multiple ROTE entries continue to load — each slot
    // showing 'rote' keeps it as a selectable option, but no new slot can
    // pick a fresh 'rote' while one already exists.
    const slotActions = siblingHasAction(saved, n, 'rote') && actionVal !== 'rote'
      ? availableActions.filter(opt => opt.value !== 'rote')
      : availableActions;
    h += '<div class="qf-field">';
    h += `<label class="qf-label" for="dt-project_${n}_action">Action Type ${n === 1 ? '<span class="qf-req">*</span>' : ''}</label>`;
    h += `<select id="dt-project_${n}_action" class="qf-select" data-project-action="${n}">`;
    for (const opt of slotActions) {
      const sel = actionVal === opt.value ? ' selected' : '';
      h += `<option value="${esc(opt.value)}"${sel}>${esc(opt.label)}</option>`;
    }
    h += '</select>';
    h += '</div>';

    // .dt-action-desc — descriptive copy for the selected action type
    const ambienceDir = saved[`project_${n}_ambience_dir`] || 'improve';
    const descKey = actionVal === 'ambience_change' ? `ambience_change_${ambienceDir}` : actionVal;
    const actionDesc = ACTION_DESCRIPTIONS[descKey] || '';
    h += `<p class="dt-action-desc" aria-live="polite">${esc(actionDesc)}</p>`;

    // Backward-compat: saved support actions are no longer a valid action type
    if (actionVal === 'support') {
      h += '<p class="qf-desc dt-action-legacy-notice">This action type is no longer available. Please select a new action type.</p>';
    }

    // ── XP Spend picker (structured) ──
    if (fields.includes('xp_picker')) {
      // dt-form.26: in-slot multi-row XP-Spend grid. Reuses renderXpRow which
      // already encodes hotfix #44's merit-eligibility logic
      // (getItemsForCategory('merit') -> getRulesByCategory + meetsPrereq).
      // Per-slot rows persist as `responses.project_N_xp_rows` (JSON);
      // top-level `responses.xp_spend` mirror-built in collectResponses (DAR-A1).
      h += _renderProjectXpRows(n, saved);
    }

    if (fields.includes('title')) {
      h += renderQuestion({
        key: `project_${n}_title`, label: 'Project Title',
        type: 'text', required: false,
        placeholder: 'A short name for this project.',
      }, saved[`project_${n}_title`] || '');
    }

    // ── Territory picker ──
    if (fields.includes('territory')) {
      const savedTerr = saved[`project_${n}_territory`] || '';
      h += '<div class="qf-field">';
      h += '<label class="qf-label">Territory</label>';
      h += renderTerritoryPills(`dt-project_${n}_territory`, savedTerr);
      h += '</div>';
    }

    // ── Desired outcome ──
    if (fields.includes('outcome')) {
      h += renderOutcomeZone(n, actionVal, saved);
    }

    // ── Target zone ──
    if (fields.includes('target')) {
      h += renderTargetZone(n, actionVal, saved, allCharacters);
    }

    // ── Connected characters (issue #589) — other PCs linked to this action.
    // Shown for all project actions (rote-locked feed slots already `continue`
    // above, matching the ST side which excludes feeding entries).
    h += renderConnectedCharsZone(n, saved, allCharacters);

    // ── Investigate lead (mandatory for investigate) ──
    if (fields.includes('investigate_lead')) {
      h += renderQuestion({
        key: `project_${n}_investigate_lead`, label: 'What is your lead on this investigation? ✱',
        type: 'textarea', required: true,
        desc: 'Provide a specific starting point, source, or known fact. Investigations without a lead cannot proceed.',
      }, saved[`project_${n}_investigate_lead`] || '');
    }

    // ── Dice pool (single, primary) ──
    // dt-form.24: secondary pool + Single/Dual roll selector stripped per
    // ADR §Audit-baseline. Personal Action slots emit one dice pool only.
    if (fields.includes('pools')) {
      h += renderDicePool(n, 'pool', 'Dice Pool', attrs, skills, discs, saved);
    }

    // ── XP note ──
    if (fields.includes('xp')) {
      h += renderQuestion({
        key: `project_${n}_xp`, label: 'XP Expenditure',
        type: 'textarea', required: false, rows: 2,
        placeholder: 'Describe what you are spending XP on in this action.',
      }, saved[`project_${n}_xp`] || '');
    }

    // ── dt-form.25: Ambience row-table (single-target by design) ──
    // Replaces the legacy target-zone (territory pills + improve/degrade
    // radios) for `ambience_change` actions. Each row has a RED DOWN arrow
    // and a GREEN UP arrow; at most one row holds a selection at any time.
    // Persists single (target, direction) pair as
    // responses.project_N_ambience_target + project_N_ambience_direction.
    if (actionVal === 'ambience_change') {
      // Read selection. Backward-compat seed: if new fields are empty but
      // legacy `_target_terr` + `_ambience_dir` exist, derive selection
      // from those so pre-redesign drafts surface correctly on first render.
      // Issue #496 / #816: normalise to a SLUG before the row-match below.
      // collectResponses() OID-remaps `_ambience_target` at the save boundary
      // (line ~770), so on every render after the first collect this value is
      // a 24-hex OID while `t.slug` is a slug — the comparison never matched
      // and every arrow rendered off. The hidden input keeps the normalised
      // slug so the next collect remaps it cleanly.
      let savedTarget = _terrSlugFromSaved(saved[`project_${n}_ambience_target`]);
      let savedDir    = saved[`project_${n}_ambience_direction`] || '';
      if (!savedTarget) {
        const legacyTerr = _terrSlugFromSaved(saved[`project_${n}_target_terr`]);
        if (legacyTerr) savedTarget = legacyTerr;
      }
      if (!savedDir) {
        const legacyDir = saved[`project_${n}_ambience_dir`] || '';
        if (legacyDir === 'improve') savedDir = 'up';
        else if (legacyDir === 'degrade') savedDir = 'down';
      }

      h += '<div class="qf-field dt-amb-table-wrap">';
      h += '<label class="qf-label">Territory + Direction</label>';
      // Issue #174 — pre-fix the rule text described a non-existent
      // '+/-2 per success / +/-4 exceptional' mechanic. Per Damnation
      // City §102 the Ambience Change personal project is a dice-roll
      // action (Attribute + Skill + Discipline pool, rendered below):
      // each success on that roll shifts the territory's ambience by
      // ±1 in the chosen direction. Player UI exposes only the dice
      // pool — there is no influence-spend channel on this action in
      // the current form, so language stays focused on the roll.
      h += '<p class="qf-desc">Pick one direction on one territory. Each success on the dice pool below shifts that territory’s ambience by ±1 in the chosen direction.</p>';
      h += `<div class="dt-amb-table" data-amb-table="${n}">`;
      for (const t of TERRITORY_DATA) {
        const isRow = String(savedTarget) === String(t.slug);
        const upOn   = isRow && savedDir === 'up'   ? ' dt-amb-arrow--on'  : '';
        const downOn = isRow && savedDir === 'down' ? ' dt-amb-arrow--on' : '';
        h += `<div class="dt-amb-row" data-amb-row="${esc(t.slug)}">`;
        h += `<span class="dt-amb-row-name">${esc(t.name)}</span>`;
        h += `<button type="button" class="dt-amb-arrow dt-amb-arrow--down${downOn}" data-amb-arrow="down" data-amb-target="${esc(t.slug)}" data-amb-slot="${n}" aria-label="Decrease ambience of ${esc(t.name)}" aria-pressed="${downOn ? 'true' : 'false'}">▼</button>`;
        h += `<button type="button" class="dt-amb-arrow dt-amb-arrow--up${upOn}" data-amb-arrow="up" data-amb-target="${esc(t.slug)}" data-amb-slot="${n}" aria-label="Increase ambience of ${esc(t.name)}" aria-pressed="${upOn ? 'true' : 'false'}">▲</button>`;
        h += '</div>';
      }
      h += '</div>';
      h += `<input type="hidden" id="dt-project_${n}_ambience_target" value="${esc(savedTarget)}">`;
      h += `<input type="hidden" id="dt-project_${n}_ambience_direction" value="${esc(savedDir)}">`;
      h += '</div>';
    }

    // ── dt-form.22: ROTE territory + read-only inherited pool ──
    if (actionVal === 'rote') {
      h += '<div class="qf-field dt-proj-rote-territory">';
      h += '<label class="qf-label">Where does this second hunt happen?</label>';
      const roteTerrSaved = saved.feeding_territories_rote || '';
      let roteTerrGridVals = {};
      try { roteTerrGridVals = JSON.parse(roteTerrSaved); } catch { /* ignore */ }
      const mainTerrSaved = saved.feeding_territories || '';
      let mainTerrGridVals = {};
      try { mainTerrGridVals = JSON.parse(mainTerrSaved); } catch { /* ignore */ }
      h += '<p class="qf-desc" style="margin:0 0 6px;font-size:.85em;opacity:.8">Rote feed must use the same territory type as your main feed. Barrens locks both.</p>';
      h += renderFeedingTerritoryPills(roteTerrGridVals, true, mainTerrGridVals);
      h += '</div>';

      // Read-only inherited pool. Derive from the same primary-feed inputs
      // the simplified MINIMAL form uses, plus the chosen rote territory's
      // ambience modifier.
      const slugFromGrid = (gridStr) => {
        let grid = {};
        try { grid = JSON.parse(gridStr || '{}'); } catch { return ''; }
        const key = Object.keys(grid).find(k => grid[k] && grid[k] !== 'none');
        if (!key) return '';
        const t = (_territories || []).find(t => String(t._id) === key);
        return t?.slug || '';
      };
      const roteSlug = slugFromGrid(saved.feeding_territories_rote || '');
      // Issue #166 (2026-05-08): pass the primary feeding's active spec
      // so the inherited ROTE pool matches the ADVANCED primary readout
      // 1:1. Without this, ROTE under-counted by the +1 / +2 speciality
      // bonus.
      // Issue #189 (2026-05-08): pass the player's customised feeding skill
      // (`feedCustomSkill`) as `skillOverride` so the spec-bonus validation
      // matches against the player's actual skill rather than the auto-
      // picked best. Without this, ROTE under-counted by the spec bonus
      // whenever the player's customised skill differed from the method's
      // auto-pick (e.g. picked a lower-dot skill that owns the spec).
      const inheritedPool = computeBestFeedingPool({
        char: currentChar,
        methodId: feedMethodId,
        territorySlug: roteSlug || slugFromGrid(saved.feeding_territories || ''),
        spec: feedSpecName || '',
        skillOverride: feedCustomSkill || '',
      });
      h += '<div class="qf-field dt-proj-rote-pool">';
      if (!feedMethodId) {
        h += '<p class="qf-desc">Pool will be derived from primary feeding once you pick a method in the Feeding section.</p>';
      } else if (!inheritedPool) {
        h += '<p class="qf-desc">Pool will be derived from primary feeding once you pick a method in the Feeding section.</p>';
      } else {
        const parts = [];
        if (inheritedPool.attr.name) parts.push(`${inheritedPool.attr.val} ${esc(inheritedPool.attr.name)}`);
        if (inheritedPool.skill.name) parts.push(`${inheritedPool.skill.val} ${esc(inheritedPool.skill.name)}`);
        else if (inheritedPool.unskilled) parts.push(`${inheritedPool.unskilled} unskilled`);
        if (inheritedPool.disc.name) parts.push(`${inheritedPool.disc.val} ${esc(inheritedPool.disc.name)}`);
        if (inheritedPool.spec?.bonus) parts.push(`+${inheritedPool.spec.bonus} ${esc(inheritedPool.spec.name)}`);
        // Issue #176: ambience is a Vitae yield modifier (Damnation City
        // §158), not a dice pool component. Removed from the dice
        // breakdown above; surfaced as a separate annotation line below
        // so the player still sees the territory's ambience contribution
        // — just labelled correctly.
        h += `<label class="qf-label">Pool: <strong>${inheritedPool.total}</strong> <span class="qf-desc" style="font-weight:normal">(inherited from primary hunt)</span></label>`;
        h += `<p class="qf-desc">${parts.join(' &middot; ')}</p>`;
        if (inheritedPool.ambience.mod) {
          const ambSign = inheritedPool.ambience.mod > 0 ? '+' : '−';
          const ambLabel = inheritedPool.ambience.label ? ` (${esc(inheritedPool.ambience.label)})` : '';
          h += `<p class="qf-desc dt-feed-dim">${ambSign}${Math.abs(inheritedPool.ambience.mod)} Vitae from territory ambience${ambLabel}</p>`;
        }
      }
      h += '</div>';
    }

    // ── Approach ──
    if (fields.includes('description')) {
      const approachText = saved[`project_${n}_description`] || '';
      const promptKey = actionVal === 'ambience_change' ? `ambience_change_${ambienceDir}` : actionVal;
      const approachPrompt = ACTION_APPROACH_PROMPTS[promptKey] || 'Describe your approach in narrative terms.';
      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-project_${n}_description">Approach</label>`;
      h += `<textarea id="dt-project_${n}_description" class="qf-textarea" rows="4" placeholder="${esc(approachPrompt)}">${esc(approachText)}</textarea>`;
      h += '</div>';
    }

    h += '</div>'; // dt-action-block
    h += '</div>'; // proj-pane
  }

  h += '</div>'; // section-body
  h += '</div>'; // section
  return h;
}

function renderDicePool(slotNum, poolKey, label, attrs, skills, discs, saved) {
  const prefix = `project_${slotNum}_${poolKey}`;
  const savedAttr  = saved[`${prefix}_attr`]  || '';
  const savedSkill = saved[`${prefix}_skill`] || '';
  const savedDisc  = saved[`${prefix}_disc`]  || '';
  const savedSpec  = saved[`${prefix}_spec`]  || '';
  const nativeSpecs = savedSkill ? (currentChar.skills?.[savedSkill]?.specs || []) : [];
  const isSpecsList  = savedSkill ? isSpecs(currentChar).filter(({ spec }) => !nativeSpecs.includes(spec)) : [];
  const bestSpecs    = [...nativeSpecs, ...isSpecsList.map(s => s.spec)];

  // Calculate total from saved selections
  let total = 0;
  if (savedAttr) total += getAttrEffective(currentChar, savedAttr);
  if (savedSkill) total += skTotal(currentChar, savedSkill);
  if (savedDisc) total += discDots(currentChar, savedDisc);
  if (savedSpec && bestSpecs.includes(savedSpec)) {
    total += hasAoE(currentChar, savedSpec) ? 2 : 1;
  }

  let h = '<div class="qf-field">';
  h += `<label class="qf-label">${esc(label)}</label>`;
  h += '<div class="dt-dice-pool-row">';

  // Attribute dropdown
  h += `<select id="dt-${prefix}_attr" class="qf-select dt-pool-select" data-pool-prefix="${prefix}">`;
  h += '<option value="">Attribute</option>';
  for (const a of attrs) {
    const dots = getAttrEffective(currentChar, a);
    const sel = savedAttr === a ? ' selected' : '';
    h += `<option value="${esc(a)}"${sel}>${esc(a)} (${dots})</option>`;
  }
  h += '</select>';

  // Skill dropdown
  // Issue #164 (2026-05-08): dropdown label is plain `Skill (dots)`. The
  // `[spec1, spec2]` suffix was redundant with the speciality chip strip
  // below and made the label noisy. The chips ARE the speciality affordance
  // — clicking one toggles the +1 / +2 bonus into the pool total.
  h += `<select id="dt-${prefix}_skill" class="qf-select dt-pool-select" data-pool-prefix="${prefix}">`;
  h += '<option value="">Skill</option>';
  for (const s of skills) {
    const dots = skTotal(currentChar, s);
    const sel = savedSkill === s ? ' selected' : '';
    h += `<option value="${esc(s)}"${sel}>${esc(s)} (${dots})</option>`;
  }
  h += '</select>';

  // Discipline dropdown (optional)
  h += `<select id="dt-${prefix}_disc" class="qf-select dt-pool-select" data-pool-prefix="${prefix}">`;
  h += '<option value="">Discipline</option>';
  for (const d of discs) {
    const dots = discDots(currentChar, d);
    const sel = savedDisc === d ? ' selected' : '';
    h += `<option value="${esc(d)}"${sel}>${esc(d)} (${dots})</option>`;
  }
  h += '</select>';

  // Total
  h += `<span class="dt-pool-total" id="${prefix}_total">${total || '—'}</span>`;
  h += '</div>';

  // Spec chip row
  h += `<input type="hidden" id="dt-${prefix}_spec" value="${esc(savedSpec)}">`;
  if (savedSkill && bestSpecs.length > 0) {
    h += '<div class="dt-feed-spec-row">';
    h += '<label class="dt-feed-disc-lbl">Specialisation:</label>';
    for (const sp of bestSpecs) {
      const on = savedSpec === sp ? ' dt-feed-spec-on' : '';
      const bonus = hasAoE(currentChar, sp) ? 2 : 1;
      h += `<button type="button" class="dt-feed-spec-chip${on}" data-pool-spec="${esc(prefix)}" data-spec-name="${esc(sp)}">${esc(sp)} <span class="dt-feed-spec-bonus">+${bonus}</span></button>`;
    }
    h += '</div>';
  }

  h += '</div>';
  return h;
}

// ── XP Spend Grid ──

const XP_CATEGORIES = [
  { value: '', label: '— Select Category —' },
  { value: 'attribute', label: 'Attribute' },
  { value: 'skill', label: 'Skill' },
  { value: 'discipline', label: 'Discipline' },
  { value: 'merit', label: 'Merit' },
  { value: 'devotion', label: 'Devotion' },
  { value: 'rite', label: 'Rite' },
];

function isClanDisc(discName) {
  const bl = currentChar.bloodline;
  const clan = currentChar.clan;
  if (bl && BLOODLINE_DISCS[bl]) return BLOODLINE_DISCS[bl].includes(discName);
  if (clan && CLAN_DISCS[clan]) return CLAN_DISCS[clan].includes(discName);
  return false;
}

/** Parse merit rating string: "2" → { flat: true, min: 2, max: 2 }, "1–5" → { flat: false, min: 1, max: 5 } */
function parseMeritRating(ratingStr) {
  if (!ratingStr) return { flat: true, min: 1, max: 1 };
  const match = ratingStr.match(/(\d+)\s*[–\-]\s*(\d+)/);
  if (match) return { flat: false, min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
  const single = parseInt(ratingStr, 10);
  return { flat: true, min: single || 1, max: single || 1 };
}

function getXpCost(category, item) {
  switch (category) {
    case 'attribute': return 4;
    case 'skill': return 2;
    case 'discipline': return isClanDisc(item) ? 3 : 4;
    case 'merit': {
      // Item format: "Name|flat|rating|0" or "Name|grad|currentDots|maxTarget"
      // For graduated, the actual dots purchased comes from the dots selector
      const parts = item.split('|');
      if (parts[1] === 'flat') return parseInt(parts[2], 10) || 1;
      // Graduated: cost comes from the row's dotsBuying field
      return 0; // calculated dynamically via row.dotsBuying
    }
    case 'devotion': {
      // Try rules cache first
      const slug = 'devotion-' + item.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const rule = getRuleByKey(slug);
      return rule ? (rule.xp_fixed || 2) : 2;
    }
    case 'rite': {
      const rule = (getRulesByCategory('rite') || []).find(r => r.name === item);
      const rank = rule?.rank || 1;
      return rank >= 4 ? 2 : 1;
    }
    default: return 0;
  }
}

function getItemsForCategory(category) {
  const c = currentChar;
  switch (category) {
    case 'attribute':
      return ALL_ATTRS.map(a => {
        const dots = getAttrEffective(c, a);
        if (dots >= 5) return null;
        return { value: a, label: `${a} (${dots} → ${dots + 1})` };
      }).filter(Boolean);
    case 'skill':
      return ALL_SKILLS.map(s => {
        const dots = skTotal(c, s);
        if (dots >= 5) return null;
        return { value: s, label: `${s} (${dots} → ${dots + 1})` };
      }).filter(Boolean);
    case 'discipline': {
      // Character's current disciplines + all core clan discs they might learn.
      // Filter against canonical discipline names — defence-in-depth against legacy
      // data leaks (e.g. retired themes; see specs/stories/dtlt.3.*).
      const owned = Object.keys(c.disciplines || {});
      const clanDiscs = (c.bloodline && BLOODLINE_DISCS[c.bloodline])
        || (c.clan && CLAN_DISCS[c.clan]) || [];
      const bloodlineDiscs = (c.bloodline && BLOODLINE_DISCS[c.bloodline]) || [];
      const validDiscs = new Set([...CORE_DISCS, ...RITUAL_DISCS, ...bloodlineDiscs]);
      const all = [...new Set([...clanDiscs, ...CORE_DISCS, ...owned])]
        .filter(d => validDiscs.has(d))
        .sort();
      return all.map(d => {
        const dots = discDots(c, d);
        if (dots >= 5) return null;
        const cost = isClanDisc(d) ? 3 : 4;
        const tag = isClanDisc(d) ? 'clan' : 'out';
        return { value: d, label: `${d} (${dots} → ${dots + 1}) [${tag}, ${cost} XP]` };
      }).filter(Boolean);
    }
    case 'merit': {
      const items = [];
      const charMerits = c.merits || [];

      // Try rules cache first, fallback to MERITS_DB.
      // Issue #188 (2026-05-08): harmonised with the sheet's Merit Add
      // picker (`buildMeritOptions` in editor/merits.js:271). The XP Spend
      // picker previously called `meetsPrereq` only — the prereq filter
      // was honoured but the picker still surfaced merits the player
      // can't directly XP-purchase:
      //   - Standing-subcategory merits (MCI / PT — gained via IC events,
      //     not XP per dot)
      //   - Structural sub-system merits (Style / Invictus Oath /
      //     Carthian Law parents — bought via the fighting-style pool /
      //     sub-system enrollment paths)
      //   - Clan/covenant-excluded merits (via `isMeritExcluded`)
      // Influence and domain merits ARE XP-purchasable directly per
      // VtR 2e, so they REMAIN in the picker (they were correctly there).
      // Already-owned merits that are now clan/covenant-excluded continue
      // to surface for raising existing dots — silent-leave on legacy
      // owned data, parallels `buildMeritOptions`'s allow-current escape.
      const meritRules = getRulesByCategory('merit');
      if (meritRules.length) {
        for (const rule of meritRules) {
          // Issue #937: 'Style'-parent merits (Body As Weapon, Survivalist, etc.)
          // are ordinary 1 XP/dot merits — surface them. Fighting STYLES proper
          // (Street Fighting etc.) are injected after this loop.
          // 2026-06-30: 'Carthian Law' also removed from this exclusion list.
          // Carthian Laws are merits with status-based prereqs (per VtR 2e) and
          // belong in the regular XP-purchase picker. The Pacts UI in sheet
          // edit-mode still lists them too, but DT XP-spend has no Pacts category
          // — without this fix Carthian Laws were entirely unreachable via XP.
          // Invictus Oath stays excluded (pact UI handles its mutual-bond mechanics).
          if (rule.parent && ['Invictus Oath'].includes(rule.parent)) continue;
          if (rule.sub_category === 'standing') continue;
          if (!meetsPrereq(c, rule.prereq)) continue;
          const name = rule.name;
          const rr = rule.rating_range;
          const min = rr ? rr[0] : 1;
          const max = rr ? rr[1] : 1;

          // Issue #347: find all owned instances to handle multi-qualifier merits
          // (Allies, Status, Contacts etc. where a character may own Finance + Media etc.)
          const ownedInstances = charMerits.filter(m =>
            m.name && m.name.toLowerCase() === name.toLowerCase()
          );
          const isMultiInstance = ownedInstances.length > 1 ||
            (ownedInstances.length === 1 && !!(ownedInstances[0].qualifier || ownedInstances[0].area));

          if (isMultiInstance) {
            for (const m of ownedInstances) {
              const qual = m.qualifier || m.area || '';
              const dots = meritEffectiveRating(c, m);
              if (dots >= max) continue;
              const encodedName = qual ? `${name} (${qual})` : name;
              const maxTarget = dots < 3 ? Math.min(3, max) : Math.min(dots + 1, max);
              items.push({
                value: `${encodedName}|grad|${dots}|${maxTarget}`,
                label: `${name}${qual ? ` — ${qual}` : ''} (currently ${dots} dot${dots !== 1 ? 's' : ''})`,
              });
            }
            if (!isMeritExcluded(c, name)) {
              items.push({
                value: `${name} (new qualifier)|grad|0|${Math.min(3, max)}`,
                label: `${name} — new qualifier (purchase new instance)`,
              });
            }
          } else {
            const currentDots = ownedInstances.length ? meritEffectiveRating(c, ownedInstances[0]) : 0;
            if (currentDots >= max) continue;
            // Skip clan/covenant-excluded merits UNLESS the character already
            // owns the merit (allow raising existing legacy dots).
            if (isMeritExcluded(c, name) && currentDots === 0) continue;

            if (min === max) {
              items.push({
                value: `${name}|flat|${max}|0`,
                label: `${name} (${max} dots, ${max} XP) — all at once`,
              });
            } else {
              const maxTarget = currentDots < 3
                ? Math.min(3, max)
                : Math.min(currentDots + 1, max);
              items.push({
                value: `${name}|grad|${currentDots}|${maxTarget}`,
                label: `${name} (currently ${currentDots} dot${currentDots !== 1 ? 's' : ''})`,
              });
            }
          }
        }
      }
      // Issue #937: fighting styles ARE merits (1 XP/dot in this model — see
      // xpSpentMerits, which sums fs.xp directly). Surface them under the Merit
      // category, encoded as graduated items so the existing dot-selector and
      // getRowCost path apply unchanged (styles go to 5 dots). The form records
      // the purchase as intent like every other XP spend; the ST applies it to
      // c.fighting_styles via the now-style-capable sheet Merit dropdown (Task 2).
      // Non-combat "styles" (Fast-Talking, Cacophony Savvy, Etiquette, Three
      // Heads of Kerberos) live as ordinary merits — excluded here (mirror of
      // sheet.js NON_COMBAT_STYLES). Manoeuvres are NOT listed here: they are
      // 0-XP picks granted by style dots, not an XP spend (issue #937 follow-up).
      const NON_COMBAT_STYLES_DT = new Set(['Fast-Talking', 'Cacophony Savvy', 'Etiquette', 'Three Heads of Kerberos']);
      const styleNames = [...new Set((getRulesByCategory('manoeuvre') || [])
        .map(r => r.parent)
        .filter(p => p && p !== 'Regular' && !NON_COMBAT_STYLES_DT.has(p)))].sort();
      for (const styleName of styleNames) {
        const cur = (c.fighting_styles || [])
          .filter(fs => fs.name === styleName)
          .reduce((s, fs) => s + (fs.cp || 0) + (fs.xp || 0) + (fs.free_mci || 0) + (fs.free_ots || 0), 0);
        if (cur >= 5) continue;
        items.push({
          value: `${styleName}|grad|${cur}|5`,
          label: `${styleName} (Fighting Style${cur ? `, currently ${cur} dot${cur !== 1 ? 's' : ''}` : ''})`,
        });
      }
      items.sort((a, b) => a.label.localeCompare(b.label));
      return items;
    }
    case 'devotion': {
      const discs = c.disciplines || {};
      // Try rules cache first
      const devRules = getRulesByCategory('devotion');
      return devRules
        .filter(rule => {
          if (rule.bloodline && rule.bloodline !== c.bloodline) return false;
          if (!rule.prereq) return true;
          return meetsPrereq(c, rule.prereq);
        })
        .map(rule => ({ value: rule.name, label: `${rule.name} (${rule.xp_fixed || '?'} XP)` }));
    }
    case 'rite': {
      const cruacLevel = discDots(c, 'Cruac');
      const thebanLevel = discDots(c, 'Theban');
      if (cruacLevel === 0 && thebanLevel === 0) return [];
      const ownedRiteNames = new Set(
        (c.powers || []).filter(p => p.category === 'rite').map(p => p.name)
      );
      const allRites = getRulesByCategory('rite') || [];
      const items = [];
      for (const rule of allRites) {
        if (ownedRiteNames.has(rule.name)) continue;
        const tradition = rule.parent;
        const charRank = tradition === 'Cruac' ? cruacLevel
                       : tradition === 'Theban' ? thebanLevel
                       : 0;
        if (charRank === 0) continue;
        const rank = rule.rank || 1;
        if (rank > charRank) continue;
        items.push({ value: rule.name, label: `${rule.name} (${tradition} Rank ${rank})` });
      }
      items.sort((a, b) => a.label.localeCompare(b.label));
      return items;
    }
    default: return [];
  }
}

function renderXpRow(idx, row, xpActions, dotsRemaining, slotN) {
  let h = `<div class="dt-xp-row" data-xp-row="${idx}">`;

  // Filter categories based on action budget
  const filteredCats = XP_CATEGORIES.filter(opt => {
    if (!opt.value) return true; // "Select" placeholder always shown
    if (opt.value === 'merit') return true; // merits 1-3 always available
    return xpActions > 0; // all others need at least 1 XP action
  });

  // Category dropdown
  h += `<select class="qf-select dt-xp-cat" data-xp-cat="${idx}">`;
  for (const opt of filteredCats) {
    const sel = row.category === opt.value ? ' selected' : '';
    h += `<option value="${esc(opt.value)}"${sel}>${esc(opt.label)}</option>`;
  }
  h += '</select>';

  // Item dropdown (populated based on category, filtered by action budget)
  if (row.category) {
    let items = getItemsForCategory(row.category);
    // If no XP actions and category is merit, filter to merits <= 3 dots only
    if (row.category === 'merit' && xpActions === 0) {
      items = items.filter(item => {
        const parts = item.value.split('|');
        if (parts[1] === 'flat') return parseInt(parts[2], 10) <= 3;
        if (parts[1] === 'grad') return parseInt(parts[2], 10) < 3; // currentDots < 3
        return true;
      });
    }
    h += `<select class="qf-select dt-xp-item" data-xp-item="${idx}">`;
    h += '<option value="">— Select —</option>';
    for (const item of items) {
      const sel = row.item === item.value ? ' selected' : '';
      h += `<option value="${esc(item.value)}"${sel}>${esc(item.label)}</option>`;
    }
    h += '</select>';
  }

  // For graduated merits: dots selector
  if (row.item && row.category === 'merit') {
    const parts = row.item.split('|');
    if (parts[1] === 'grad') {
      const currentDots = parseInt(parts[2], 10) || 0;
      const maxTarget = parseInt(parts[3], 10) || currentDots + 1;
      const selectedTarget = row.dotsBuying
        ? currentDots + row.dotsBuying
        : 0;

      h += `<select class="qf-select dt-xp-dots" data-xp-dots="${idx}">`;
      h += '<option value="">Buy to...</option>';
      for (let target = currentDots + 1; target <= maxTarget; target++) {
        const dotsBuying = target - currentDots;
        const sel = selectedTarget === target ? ' selected' : '';
        h += `<option value="${dotsBuying}"${sel}>${'●'.repeat(target)} (dot ${target}, ${dotsBuying} XP)</option>`;
      }
      h += '</select>';
    }
  }

  // Cost display
  const cost = getRowCost(row);
  if (cost > 0) {
    h += `<span class="dt-xp-cost">${cost} XP</span>`;
  }

  if (slotN != null && row.category) {
    h += `<button type="button" class="dt-xp-row-remove" data-xp-remove-slot="${slotN}" data-xp-remove-idx="${idx}" title="Remove this row">×</button>`;
  }

  h += '</div>';
  return h;
}

/**
 * dt-form.26: per-slot multi-row XP-Spend grid. Replaces the legacy single-row
 * placeholder when a project slot's action is `xp_spend`. Reuses renderXpRow
 * for each row (which carries hotfix #44's merit-eligibility logic). Read from
 * `responses.project_${n}_xp_rows` (JSON-stringified array); backward-compat
 * seeds rows[0] from the legacy `project_${n}_xp_category` / `_xp_item` /
 * `_xp_dots` triple when no `_xp_rows` is present yet.
 *
 * Per CLAUDE.md XP rules: 1 dot of non-merit growth per xp_spend slot, plus
 * unlimited free 1-3 dot merits. The dotsRemaining tracker spans all xp_spend
 * slots' rows so the player sees a single global budget.
 */
function _renderProjectXpRows(n, saved) {
  // Read this slot's rows (JSON), or seed from legacy single-row fields.
  let xpRows = [];
  const savedRowsJson = saved[`project_${n}_xp_rows`] || '';
  if (savedRowsJson) {
    try { xpRows = JSON.parse(savedRowsJson); } catch { xpRows = []; }
  }
  if (!xpRows.length) {
    const legacyCat  = saved[`project_${n}_xp_category`] || '';
    const legacyItem = saved[`project_${n}_xp_item`] || '';
    const legacyDots = parseInt(saved[`project_${n}_xp_dots`] || '0', 10) || 0;
    if (legacyCat && legacyItem) {
      xpRows.push({ category: legacyCat, item: legacyItem, dotsBuying: legacyDots || 1 });
    }
  }
  // Always render a trailing empty row so the player can add another purchase
  // without an extra click. Mirrors the legacy admin xp_grid behaviour.
  if (!xpRows.length || xpRows[xpRows.length - 1].category) {
    xpRows.push({ category: '', item: '', dotsBuying: 0 });
  }

  // Cross-slot accounting. xp_spend slot count drives the non-merit dot budget;
  // merits 1-3 are free per CLAUDE.md.
  let xpActions = 0;
  for (let s = 1; s <= 4; s++) {
    if (saved[`project_${s}_action`] === 'xp_spend') xpActions++;
  }
  // Sum non-merit dots across ALL xp_spend slots' rows so the dotsRemaining
  // displayed on this slot reflects the true cross-slot budget.
  let dotsUsed = 0;
  for (let s = 1; s <= 4; s++) {
    if (saved[`project_${s}_action`] !== 'xp_spend') continue;
    let slotRows = [];
    const rj = saved[`project_${s}_xp_rows`] || '';
    if (rj) { try { slotRows = JSON.parse(rj); } catch { slotRows = []; } }
    if (!slotRows.length) {
      const lc = saved[`project_${s}_xp_category`] || '';
      const li = saved[`project_${s}_xp_item`]     || '';
      if (lc && li) slotRows = [{ category: lc, item: li, dotsBuying: 1 }];
    }
    for (const r of slotRows) {
      if (!r.category || !r.item) continue;
      if (r.category === 'merit') continue; // free 1-3 dot merits
      if (r.category === 'devotion') dotsUsed++; // 1 action per devotion
      else dotsUsed += (r.dotsBuying || 1);
    }
  }
  const dotsRemaining = xpActions - dotsUsed;

  // Slot total + global budget
  const slotCost = xpRows.reduce((sum, r) => sum + getRowCost(r), 0);
  const budget = xpLeft(currentChar);

  let h = `<div class="dt-xp-picker dt-xp-grid" data-proj-xp-grid="${n}">`;
  h += `<p class="qf-desc">XP-spend declarations for this action. Add as many traits as your XP budget allows; merits at 1-3 dots are free, other categories require an XP-Spend action per dot.</p>`;
  h += `<div class="dt-xp-budget" id="dt-proj_${n}_xp_budget">`;
  h += `<span>Slot total: <strong>${slotCost}</strong> XP</span>`;
  h += `<span style="margin-left:14px">Cycle budget: <strong>${budget}</strong> XP available</span>`;
  if (xpActions > 0) {
    h += `<span style="margin-left:14px">${xpActions} XP-Spend action${xpActions > 1 ? 's' : ''} — <span class="${dotsRemaining < 0 ? 'dt-influence-over' : ''}">${dotsRemaining} dot${dotsRemaining !== 1 ? 's' : ''} remaining</span></span>`;
  }
  h += '</div>';

  for (let i = 0; i < xpRows.length; i++) {
    h += renderXpRow(i, xpRows[i], xpActions, dotsRemaining, n);
  }
  h += `<button type="button" class="dt-xp-row-add" data-xp-add-slot="${n}">+ Add row</button>`;
  h += '</div>'; // dt-xp-grid

  // In-character justification stays per-slot, single textarea. Carries the
  // narrative for the entire xp-spend action regardless of row count.
  h += renderQuestion({
    key: `project_${n}_xp_trait`,
    label: 'In-character justification',
    type: 'textarea',
    required: false,
    placeholder: 'Describe the activity or events that justify this growth.',
  }, saved[`project_${n}_xp_trait`] || '');

  return h;
}

function getRowCost(row) {
  if (!row.item || !row.category) return 0;
  if (row.category === 'merit') {
    const parts = row.item.split('|');
    if (parts[1] === 'flat') return parseInt(parts[2], 10) || 1;
    if (parts[1] === 'grad') return row.dotsBuying || 0;
    return 0;
  }
  return getXpCost(row.category, row.item);
}

// ── Blood Sorcery ──

// Issue #24: Personal Story — free-text NPC name + interaction note.
// Replaces the NPCR.12 relationships picker. Players name any NPC they know
// and describe the interaction; no registered relationship required.

function renderPersonalStorySection(saved) {
  const section = DOWNTIME_SECTIONS.find(s => s.key === 'personal_story');
  if (!section) return '';

  // dt-form.18 (ADR-003 §Q2, option Y locked 2026-05-06): single binary
  // render in BOTH modes — pick Touchstone or Correspondence, optionally
  // name a person involved (free-text only, NOT a DB-backed picker), then
  // describe the beat in one textarea. The legacy NPC card picker (DB-
  // relational, suppressed under the broader NPC-interaction policy) is
  // removed; the free-text NPC name input is RETAINED because a typed
  // string is categorically different from an "NPC interaction." Legacy
  // `personal_story_note` / `_npc_id` / `_direction` fields remain in
  // `responses` on existing drafts (silent-leave per the no-real-
  // submissions migration window) but no UI emits them anymore.
  const savedKind = saved['personal_story_kind'] === 'correspondence'
    ? 'correspondence'
    : (saved['personal_story_kind'] === 'touchstone' ? 'touchstone' : '');
  const savedText = saved['personal_story_text'] || '';
  const savedNpcName = saved['personal_story_npc_name'] || '';
  const placeholder = savedKind === 'correspondence'
    ? 'Describe the correspondence — to whom, about what, what tone you want it to strike.'
    : savedKind === 'touchstone'
      ? 'Describe the touchstone moment — a scene with someone or something that anchors your humanity this cycle.'
      : 'Pick Touchstone or Correspondence above to focus your description.';

  let h = '<div class="qf-section collapsed" data-section-key="personal_story">';
  h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">✔</span></h4>`;
  h += '<div class="qf-section-body">';
  h += '<p class="qf-section-intro">Optional. If you like, add one personal-story beat for this cycle: a touchstone moment that anchors your humanity, or a correspondence with someone off-screen. You can leave this blank and still submit your downtime.</p>';

  h += '<div class="qf-field">';
  h += '<div class="qf-radio-group" role="radiogroup" aria-label="Personal Story kind">';
  h += '<label class="qf-radio-label">';
  h += `<input type="radio" name="dt-personal_story_kind" value="touchstone"${savedKind === 'touchstone' ? ' checked' : ''} data-personal-story-kind>`;
  h += '<span>Touchstone moment</span>';
  h += '</label>';
  h += '<label class="qf-radio-label">';
  h += `<input type="radio" name="dt-personal_story_kind" value="correspondence"${savedKind === 'correspondence' ? ' checked' : ''} data-personal-story-kind>`;
  h += '<span>Correspondence</span>';
  h += '</label>';
  h += '</div>';
  h += '</div>';

  // Optional free-text NPC name. Typed string only — no picker, no DB
  // lookup. Does not affect isMinimalComplete's gate; metadata only.
  h += '<div class="qf-field" style="margin-top:12px;">';
  h += '<label class="qf-label" for="dt-personal_story_npc_name">Person involved (optional)</label>';
  h += `<input type="text" id="dt-personal_story_npc_name" class="qf-input" value="${esc(savedNpcName)}" placeholder="Optional — name a person you want involved">`;
  h += '</div>';

  h += '<div class="qf-field" style="margin-top:12px;">';
  h += '<label class="qf-label" for="dt-personal_story_text">';
  h += savedKind === 'correspondence' ? 'Describe the correspondence' : 'Describe the touchstone moment';
  h += '</label>';
  h += `<textarea id="dt-personal_story_text" class="qf-textarea" rows="4" placeholder="${esc(placeholder)}">${esc(savedText)}</textarea>`;
  h += '</div>';

  h += '</div></div>';
  return h;
}

// #508: Carthian Pull — single-dot allocation to a one-cycle bonus dot on
// Allies/Contacts/Haven/Herd. The dot is written LIVE to the character (the
// `free_carthian` channel) so it shows on the sheet via the existing bonus-dot
// model, and is read back here. Returns '' unless the character holds Carthian
// Pull. Allies/Contacts require a sphere; the choice is disabled at the 5-action
// cap. Because the bonus is a real merit, the existing detection produces the
// action slot — no synthetic slot is injected (no double-up).
function renderCarthianPullSection(saved) {
  const section = DOWNTIME_SECTIONS.find(s => s.key === 'carthian_pull');
  if (!section) return '';
  const hasCP = (currentChar?.merits || []).some(m => m.name === 'Carthian Pull');
  if (!hasCP) return '';
  // #522: the pool is the character's Carthian (Covenant) Status (0–5).
  const pool = Number(currentChar?.status?.covenant?.['Carthian Movement']) || 0;
  if (pool < 1) return '';

  const allocs = _carthianCurrentAllocations(); // applied dots, derived from the character
  const used = allocs.length;
  // One in-progress "new dot" row, driven by the pending target/sphere in
  // responses so a target chosen before its sphere survives the re-render.
  const pendTarget = (used < pool) ? (saved['carthian_pull_target'] || '') : '';
  const pendSphere = saved['carthian_pull_sphere'] || '';

  let h = '<div class="qf-section collapsed" data-section-key="carthian_pull">';
  h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">✔</span></h4>`;
  h += '<div class="qf-section-body">';
  if (section.intro) h += `<p class="qf-section-intro">${esc(section.intro)}</p>`;
  h += `<p class="qf-carthian-pool"><strong>${used} of ${pool}</strong> dot${pool === 1 ? '' : 's'} allocated (Carthian Status ${pool}).</p>`;

  // Applied dots — display + remove.
  if (used) {
    h += '<div class="qf-carthian-applied">';
    allocs.forEach((a, i) => {
      h += `<div class="qf-carthian-chip" data-carthian-idx="${i}">`;
      h += `<span>${esc(_carthianLabel(a))}</span>`;
      h += `<button type="button" class="qf-carthian-remove" data-carthian-remove="${i}" title="Remove this dot">✕</button>`;
      h += '</div>';
    });
    h += '</div>';
  }

  // New-dot row — only while there is pool left.
  if (used < pool) {
    const opt = (val, label) => `<option value="${val}"${pendTarget === val ? ' selected' : ''}>${esc(label)}</option>`;
    h += '<div class="qf-carthian-new" style="margin-top:12px;">';
    h += '<div class="qf-field"><label class="qf-label" for="dt-carthian_target">Allocate a dot to</label>';
    h += '<select id="dt-carthian_target" class="qf-input" data-carthian-target>';
    h += opt('', '— select —');
    h += opt('allies', 'Allies');
    h += opt('contacts', 'Contacts');
    // #844: only offer Haven if the merit is below cap or has no anchor.
    const havenMerit = (currentChar?.merits || [])
      .find(m => m.category === 'domain' && m.name === 'Haven');
    const havenAllocatable = !havenMerit || canAllocateCarthianPull(currentChar, havenMerit);
    if (havenAllocatable) h += opt('haven', 'Haven');
    h += opt('herd', 'Herd');
    h += '</select></div>';
    if (pendTarget === 'allies' || pendTarget === 'contacts') {
      // #510: sphere is a fixed-enum dropdown, filtered for the target.
      h += '<div class="qf-field" style="margin-top:8px;"><label class="qf-label" for="dt-carthian_sphere">Sphere</label>';
      h += `<select id="dt-carthian_sphere" class="qf-input" data-carthian-sphere>${_carthianSphereOptions(pendTarget, pendSphere)}</select></div>`;
    }
    h += '</div>';
  }

  h += '</div></div>';
  return h;
}

// #522: derive the applied Carthian Pull dots from the character's
// free_carthian-bearing merits. Returns an ordered list of {target, sphere}.
// Allies stacks (free_carthian dots on one area); Contacts tracks pushed
// spheres via carthian_spheres[] (plural #522) / carthian_sphere (legacy
// single #510) / a bonus-only Contacts' own spheres[] (pre-marker #508).
function _carthianCurrentAllocations() {
  const out = [];
  for (const m of (currentChar?.merits || [])) {
    const fc = freeOf(m, 'carthian');
    if (m.category === 'influence' && m.name === 'Allies') {
      for (let i = 0; i < fc; i++) out.push({ target: 'allies', sphere: m.area || '' });
    } else if (m.category === 'influence' && m.name === 'Contacts') {
      let cs = Array.isArray(m.carthian_spheres) ? m.carthian_spheres.slice()
             : (m.carthian_sphere ? [m.carthian_sphere] : []);
      if (!cs.length && m.granted_by === 'Carthian Pull' && Array.isArray(m.spheres)) cs = m.spheres.slice();
      for (const sp of cs) out.push({ target: 'contacts', sphere: sp });
    } else if (m.category === 'domain' && m.name === 'Haven') {
      for (let i = 0; i < fc; i++) out.push({ target: 'haven', sphere: '' });
    } else if (m.category === 'domain' && m.name === 'Herd') {
      for (let i = 0; i < fc; i++) out.push({ target: 'herd', sphere: '' });
    }
  }
  return out;
}

function _carthianLabel(a) {
  const names = { allies: 'Allies', contacts: 'Contacts', haven: 'Haven', herd: 'Herd' };
  const n = names[a.target] || a.target;
  return a.sphere ? `${n} (${a.sphere})` : n;
}

// #510: options for the Carthian sphere <select>, filtered by target.
//  - Allies: all INFLUENCE_SPHERES; a sphere whose existing Allies merit is at
//    5 dots is disabled, and (when at the 5-Allies-slot cap) a NEW sphere that
//    would create a 6th slot is disabled. The current selection stays selectable.
//  - Contacts: exclude spheres already in the character's Contacts spheres[]
//    (mirrors the sheet editor's exclusion), except the current selection.
function _carthianSphereOptions(target, curSphere) {
  const merits = currentChar?.merits || [];
  let avail = INFLUENCE_SPHERES.slice();
  const disabled = new Set();
  if (target === 'contacts') {
    const cm = merits.find(m => m.category === 'influence' && m.name === 'Contacts');
    const held = new Set((cm?.spheres || []).filter(s => s !== curSphere));
    avail = avail.filter(sp => !held.has(sp));
  } else if (target === 'allies') {
    const alliesMerits = merits.filter(m => m.category === 'influence' && m.name === 'Allies');
    const slotCount = alliesMerits.filter(m => (m.area || '') !== curSphere).length;
    for (const sp of avail) {
      if (sp === curSphere) continue;
      const ex = alliesMerits.find(m => (m.area || '') === sp);
      if (ex && meritEffectiveRating(currentChar, ex) >= 5) disabled.add(sp);      // sphere already at 5 dots
      else if (!ex && slotCount >= 5) disabled.add(sp);                            // new sphere would exceed 5 Allies slots
    }
  }
  let h = '<option value="">— select sphere —</option>';
  for (const sp of avail) {
    const dis = disabled.has(sp);
    h += `<option value="${esc(sp)}"${sp === curSphere ? ' selected' : ''}${dis ? ' disabled' : ''}>${esc(sp)}${dis ? ' (at 5)' : ''}</option>`;
  }
  return h;
}

// Derive the Allies (spheres) + Contacts action-merit lists from a merits array,
// using the same expansion/dedup as detectMerits. Shared so the init detection
// and the live Carthian re-render cannot diverge (#510).
function deriveInfluenceActionMerits(merits) {
  const list = (merits || []).filter(m => m.category);
  const directInfluenceNames = new Set(list.filter(m => m.category === 'influence').map(m => m.name));
  const exp = [...list];
  for (const m of list) {
    if (m.category !== 'standing') continue;
    const grants = Array.isArray(m.tier_grants) ? m.tier_grants
                 : Array.isArray(m.benefit_grants) ? m.benefit_grants
                 : [];
    for (const g of grants) {
      if (g.category !== 'influence') continue;
      if (directInfluenceNames.has(g.name)) continue;
      exp.push({ ...g, _from_mci: m.cult_name || m.name });
    }
  }
  const spheres = deduplicateMerits(exp.filter(m => m.category === 'influence' && m.name === 'Allies'));
  const rawContacts = deduplicateMerits(exp.filter(m => m.category === 'influence' && m.name === 'Contacts'));
  const contacts = [];
  for (const m of rawContacts) {
    if (m.spheres && m.spheres.length) {
      for (const sp of m.spheres) contacts.push({ ...m, area: sp, rating: 1 });
    } else {
      const areas = (m.area || m.qualifier || '').split(/,\s*/).filter(Boolean);
      if (areas.length > 1) { for (const a of areas) contacts.push({ ...m, area: a.trim(), rating: 1 }); }
      else if (areas.length === 1) contacts.push({ ...m, area: areas[0] });
      else contacts.push(m);
    }
  }
  return { spheres, contacts };
}

// #510: after a live Carthian write, re-derive the Allies/Contacts action lists
// from the (possibly augmented) character. detectMerits() is init-only and has
// side effects, so we re-derive ONLY these two arrays here. This replaces the
// #508 strip-and-push, which broke once augmented merits (no granted_by) became
// possible. One merit -> one slot, no double-up.
function _syncCarthianDetected() {
  const ia = deriveInfluenceActionMerits(currentChar?.merits || []);
  detectedMerits.spheres = ia.spheres;
  detectedMerits.contacts = ia.contacts;
}

// #522: apply a full Carthian Pull allocation SET to the character (live), then
// re-render. Soft-fail with a toast (#512). Clears the pending new-row markers
// after any attempt so the section reflects the character's actual saved state.
async function _applyCarthianSet(container, allocations) {
  try {
    const updated = await apiPatch(
      `/api/characters/${encodeURIComponent(String(currentChar._id))}/carthian_pull`,
      { allocations },
    );
    if (updated && Array.isArray(updated.merits)) currentChar.merits = updated.merits;
    _syncCarthianDetected();
  } catch (err) {
    // #512: surface the failure instead of silently reverting; the section
    // derives its rows from the character, so a failed write must not be left
    // to fall back to a stale pending choice.
    console.warn('Carthian Pull allocation write failed:', err);
    showToast('Could not save your Carthian Pull allocation. Please try again.', 'error');
  }
  if (responseDoc?.responses) {
    delete responseDoc.responses.carthian_pull_target;
    delete responseDoc.responses.carthian_pull_sphere;
  }
  renderForm(container);
}

// #522: handle a change on the "new dot" row. Builds the full set = the applied
// dots plus this new one, and writes it. Allies/Contacts defer until a sphere
// is chosen (persisting the pending target so the re-render reveals the sphere
// select). Selecting "— select —" just drops the pending row.
function _onCarthianNewRowChange(container) {
  const tEl = document.getElementById('dt-carthian_target');
  const sEl = document.getElementById('dt-carthian_sphere');
  const target = tEl ? tEl.value : '';
  const sphere = sEl ? sEl.value.trim() : '';
  if (target === '') {
    if (responseDoc?.responses) {
      delete responseDoc.responses.carthian_pull_target;
      delete responseDoc.responses.carthian_pull_sphere;
    }
    renderForm(container);
    return;
  }
  if ((target === 'allies' || target === 'contacts') && !sphere) {
    // Need a sphere first — persist the pending target so the re-render keeps it.
    const responses = collectResponses();
    responses.carthian_pull_target = target;
    if (responseDoc) responseDoc.responses = responses;
    else responseDoc = { responses };
    renderForm(container);
    return;
  }
  // #844: single-target semantics — picking haven (a cap-bound merit) vacates
  // any prior haven allocation so free_carthian cannot stack on the same target.
  // The server route does a full strip-then-apply, so this client-side filter
  // ensures the submitted set is already deduplicated before transmission.
  const SINGLE_TARGET = new Set(['haven']);
  const prior = _carthianCurrentAllocations().filter(a => !SINGLE_TARGET.has(target) || a.target !== target);
  _applyCarthianSet(container, [...prior, { target, sphere }]);
}

// #522: remove one applied dot (by index into the derived allocation list) and
// write the reduced set.
function _onCarthianRemove(container, idx) {
  const applied = _carthianCurrentAllocations();
  if (!Number.isInteger(idx) || idx < 0 || idx >= applied.length) return;
  _applyCarthianSet(container, applied.filter((_, i) => i !== idx));
}

// #504: Safe Places and Havens — one street+suburb text input per Safe Place
// merit instance. A Haven is always built on a Safe Place (its rating is
// capped by the attached Safe Place via `attached_to` === domKey(safePlace)),
// so it is NOT a separate input: the safe place hosting the haven is marked
// "(Haven)" in its label. With zero safe places the whole section is omitted
// (a haven cannot exist without one). Locations are optional and deliberately
// NOT wired into the completeness gate. Custom renderer + manual collector
// mirror renderPersonalStorySection; index-keyed responses
// (safe_place_location_${i}) match the form's slot convention.
function renderSafePlaceLocationsSection(saved) {
  const section = DOWNTIME_SECTIONS.find(s => s.key === 'safe_place_locations');
  if (!section) return '';

  const safePlaces = (currentChar?.merits || [])
    .filter(m => m.category === 'domain' && m.name === 'Safe Place');
  if (safePlaces.length === 0) return ''; // AC#4 — nothing to ask about

  const haven = (currentChar?.merits || [])
    .find(m => m.category === 'domain' && m.name === 'Haven');
  // N-1 (Concern #11): normaliser pinpoints the destination Safe Place key.
  const _havenAt = haven ? normaliseAttachedTo(haven.attached_to) : null;
  const havenKey = _havenAt ? _havenAt.destination : null;

  let h = '<div class="qf-section collapsed" data-section-key="safe_place_locations">';
  h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">✔</span></h4>`;
  h += '<div class="qf-section-body">';
  if (section.intro) h += `<p class="qf-section-intro">${esc(section.intro)}</p>`;

  safePlaces.forEach((sp, i) => {
    const key = domKey(sp);
    const isHaven = havenKey !== null && havenKey === key;
    const label = esc(key) + (isHaven ? ' <span class="qf-haven-tag">(Haven)</span>' : '');
    // #506: prefer an in-progress submission edit, then the persisted character
    // value (sp.location, carried across cycles), then blank. An explicit
    // null/undefined check (not `||`) so a deliberately-cleared ('') in-cycle
    // edit is not overridden by the stored sp.location.
    const _saved = saved['safe_place_location_' + i];
    const val = (_saved !== undefined && _saved !== null) ? _saved : (sp.location || '');
    h += '<div class="qf-field" style="margin-top:12px;">';
    h += `<label class="qf-label" for="dt-safe_place_location_${i}">${label}</label>`;
    h += `<input type="text" id="dt-safe_place_location_${i}" class="qf-input" data-safe-place-location="${i}" value="${esc(val)}" placeholder="Street and suburb">`;
    h += '</div>';
  });

  h += '</div></div>';
  return h;
}

// dt-form.33: legacy `_legacyRenderPersonalStorySection` deleted. The
// function rendered the DB-relational `dt-npc-cards` picker driven by
// `currentChar.npcs`; suppressed under the broader NPC-interaction
// release-cycle policy. dt-form.18 already replaced the live render
// with the Touchstone-or-Correspondence binary; this story prunes the
// orphan plus its associated click handler and the now-unused
// `_linkedNpcs` / `_myRelationships` data loads.

// dt-form.23 (ADR-003 §Q2): regent-only confirmation section. Canonical
// store is `cycle.regent_confirmations[]` (same as the regency tab);
// this surface POSTs to /api/downtime_cycles/:id/confirm-feeding with
// the territory's current `feeding_rights[]` as the rights snapshot,
// and the predicate `_isRegencyConfirmedThisCycle()` reads it back.
// Multi-territory regents are not modelled — `findRegentTerritory()`
// returns a single territory by design (helpers.js:153).
function renderRegencySection() {
  if (gateValues.is_regent !== 'yes') return '';
  const ri = findRegentTerritory(_territories, currentChar);
  if (!ri?.territoryId) return '';
  const terrName = ri.territory || 'your territory';

  const myConfirmation = (currentCycle?.regent_confirmations || [])
    .find(c => String(c.territory_id) === String(ri.territoryId));

  let h = '<div class="qf-section" data-section-key="regency">';
  h += '<h4 class="qf-section-title">Regency<span class="qf-section-tick">✔</span></h4>';
  h += '<div class="qf-section-body">';

  // Issue #161 (2026-05-08): explain WHY the regent is being asked to confirm
  // and WHERE residency rights are managed. Option B from the issue body — an
  // explicit redirect to the Regency tab, rather than duplicating the
  // residency-rights summary inline (which would mean re-implementing
  // regency-tab logic inside the DT form).
  if (myConfirmation) {
    const at = myConfirmation.confirmed_at ? new Date(myConfirmation.confirmed_at) : null;
    const atStr = at && !isNaN(at) ? at.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    h += `<p class="qf-section-intro">Confirmed as Regent of <strong>${esc(terrName)}</strong> for this cycle${atStr ? ` — ${esc(atStr)}` : ''}.</p>`;
    h += `<p class="qf-desc">Your feeding-rights selections for ${esc(terrName)} are locked in for this downtime. To review or update them, use the Regency tab.</p>`;
    h += '<div class="qf-actions">';
    h += '<button type="button" class="qf-btn qf-btn-secondary" data-open-regency-tab>Open Regency tab</button>';
    h += '</div>';
  } else {
    h += `<p class="qf-section-intro">I am acting as Regent of <strong>${esc(terrName)}</strong> for this cycle.</p>`;
    h += `<p class="qf-desc">As regent, you must confirm <strong>this downtime</strong> who has feeding rights in ${esc(terrName)}. Manage your feeding-rights slots in the Regency tab; once your selections are set, return here and confirm to lock them in for the cycle.</p>`;
    h += '<div class="qf-actions">';
    h += '<button type="button" class="qf-btn qf-btn-secondary" data-open-regency-tab>Open Regency tab</button>';
    const _cycleIsEffectivelyOpen = currentCycle?.status === 'active'
      || !!(currentCycle?.auto_open_at && new Date(currentCycle.auto_open_at) <= new Date());
    if (_cycleIsEffectivelyOpen) {
      h += '<button type="button" class="qf-btn qf-btn-submit" id="dt-btn-confirm-regency">Confirm regency this cycle</button>';
      h += '<span id="dt-regency-confirm-status" class="qf-save-status"></span>';
    } else {
      h += '<p class="qf-desc">Downtimes are not yet open - use the Regency tab to prepare your feeding-rights selections.</p>';
    }
    h += '</div>';
  }

  h += '</div></div>';
  return h;
}

function renderSorcerySection(saved) {
  const section = DOWNTIME_SECTIONS.find(s => s.key === 'blood_sorcery');
  const hasMandragora = (currentChar.merits || []).some(m => m.name === 'Mandragora Garden');

  // Augmented rite list: known rites + castable-but-unlearned rites at
  // level ≤ (Cruac/Theban rating − 2). House rule per VtR2: any sorcerer
  // can attempt a rite two ranks below their discipline rating without
  // having learned it. Cruac 3 → level-1 rites are open; Cruac 5 → 1-3.
  const knownRites = (currentChar.powers || []).filter(p => p.category === 'rite');
  const knownNames = new Set(knownRites.map(r => r.name));
  const cruacDots = discDots(currentChar, 'Cruac');
  const thebanDots = discDots(currentChar, 'Theban');
  const ruleRites = getRulesByCategory('rite') || [];
  const unlearnedRites = [];
  for (const rule of ruleRites) {
    if (knownNames.has(rule.name)) continue;
    const trad = rule.parent;
    const rank = rule.rank || 1;
    const limit = trad === 'Cruac' ? cruacDots - 2
               : trad === 'Theban' ? thebanDots - 2
               : -1;
    if (rank <= limit) {
      unlearnedRites.push({ category: 'rite', name: rule.name, tradition: trad, level: rank, _unlearned: true });
    }
  }
  const rites = [...knownRites, ...unlearnedRites];
  rites.sort((a, b) => a.tradition.localeCompare(b.tradition) || a.level - b.level || a.name.localeCompare(b.name));
  const cruacRites = rites.filter(r => r.tradition === 'Cruac');

  const savedCount = parseInt(saved['sorcery_slot_count'] || '1', 10);
  const slotCount = Math.max(1, savedCount);

  // Mandragora 2c: capacity = Mandragora Garden effective dots. Count
  // currently-parked rites from `saved` so the cap can disable the Park
  // toggle on additional slots once full.
  const mandragoraCap = hasMandragora ? effectiveDomainDots(currentChar, 'Mandragora Garden') : 0;
  let parkedCount = 0;
  for (let i = 1; i <= slotCount; i++) {
    if (saved[`sorcery_${i}_mandragora`] === 'yes') parkedCount++;
  }
  const capacityReached = mandragoraCap > 0 && parkedCount >= mandragoraCap;

  let h = '<div class="qf-section collapsed" data-section-key="blood_sorcery">';
  h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">\u2714</span></h4>`;
  h += '<div class="qf-section-body">';
  if (section.intro) h += `<p class="qf-section-intro">${esc(section.intro)}</p>`;

  // Mandragora Garden +3 dice — flat, always-on for Cruac users with the merit
  if (hasMandragora && cruacDots > 0) {
    h += `<p class="qf-desc" style="margin:4px 0 10px;font-style:italic">Mandragora Garden grants +3 dice to every Cruac rite cast this downtime.</p>`;
    if (mandragoraCap > 0) {
      h += `<p class="qf-desc" style="margin:4px 0 10px;font-style:italic">Garden capacity: <strong>${parkedCount} / ${mandragoraCap}</strong> rite${mandragoraCap !== 1 ? 's' : ''} parked.</p>`;
    }
  }

  // Hidden field tracking slot count
  h += `<input type="hidden" id="dt-sorcery-slot-count" value="${slotCount}">`;

  if (!rites.length) {
    h += '<p class="qf-desc" style="color:var(--txt3);font-style:italic">No rites on your character sheet. Add rites in the character editor first.</p>';
    h += '</div></div>';
    return h;
  }

  for (let n = 1; n <= slotCount; n++) {
    const selectedRite = saved[`sorcery_${n}_rite`] || '';
    const rite = rites.find(r => r.name === selectedRite);
    const isCruac = rite?.tradition === 'Cruac';
    const mandSaved = saved[`sorcery_${n}_mandragora`] === 'yes';
    const mgLocked  = saved[`sorcery_${n}_mg_locked`]  === 'yes';

    h += `<div class="dt-sorcery-slot" id="dt-sorcery-slot-${n}" data-mg-locked="${mgLocked ? 'yes' : ''}" data-rite-name="${esc(selectedRite)}">`;
    h += `<div class="dt-sorcery-slot-hd"><span class="dt-sorcery-slot-num">Rite ${n}</span>`;
    if (n > 1 && !mgLocked) h += `<button type="button" class="dt-sorcery-remove" data-remove-rite="${n}" title="Remove this rite">\u00D7 Remove</button>`;
    h += '</div>';

    h += '<div class="qf-field">';
    if (mgLocked && selectedRite) {
      // T2: locked slot — show rite name as text; hidden input preserves the
      // value so the existing save path reads .value identically to a select.
      h += `<p class="qf-mg-locked-rite">${esc(selectedRite)}<span class="rite-mg-tag" title="Permanently sustained by Mandragora Garden">MG</span></p>`;
      h += `<input type="hidden" id="dt-sorcery_${n}_rite" value="${esc(selectedRite)}">`;
      h += `<div class="dt-mg-prior-outcome"><span class="dt-sorcery-label">Prior outcome:</span> <span id="dt-mg-prior-${n}" class="dt-mg-prior-loading">Loading…</span></div>`;
    } else {
    h += `<select id="dt-sorcery_${n}_rite" class="qf-select" data-sorcery-slot="${n}">`;
    h += '<option value="">\u2014 No Rite \u2014</option>';
    let lastTradition = '';
    for (const r of rites) {
      if (r.tradition !== lastTradition) {
        if (lastTradition) h += '</optgroup>';
        h += `<optgroup label="${esc(r.tradition)}">`;
        lastTradition = r.tradition;
      }
      const sel = selectedRite === r.name ? ' selected' : '';
      const suffix = r._unlearned ? ' — unlearned' : '';
      h += `<option value="${esc(r.name)}"${sel}>${esc(r.name)} (Level ${r.level})${suffix}</option>`;
    }
    if (lastTradition) h += '</optgroup>';
    h += '</select>';
    } // end else (not mgLocked)

    // Mandragora Garden checkbox — Cruac rites only, when character has the merit.
    // Storage only: the +3 dice bonus is automatic (shown above the slots) and
    // applies whether or not this rite is parked. Parking the rite means it
    // costs no vitae for this casting and is sustained by the garden.
    if (hasMandragora && cruacRites.length) {
      const mandChecked = isCruac && mandSaved ? ' checked' : '';
      // 2c: disable when not Cruac, OR when capacity is full and this rite
      // isn't already parked (so unticking remains possible to free a slot).
      const overCap = capacityReached && !mandSaved;
      const mandDisabled = (mgLocked || !isCruac || overCap) ? ' disabled' : '';
      const mandTitle = mgLocked
        ? 'This rite is permanently parked in your Mandragora Garden and cannot be removed via the form.'
        : overCap
          ? `Garden capacity reached (${mandragoraCap}). Untick another parked rite to free a slot.`
          : `If ticked, this rite is parked in your Mandragora Garden: it costs no vitae for this casting and is sustained by the garden until next month.`;
      h += `<label class="dt-mand-label" title="${esc(mandTitle)}">`;
      h += `<input type="checkbox" id="dt-sorcery_${n}_mandragora" class="dt-mand-cb"${mandChecked}${mandDisabled}>`;
      h += ` Park in Mandragora Garden (sustained, no vitae cost)`;
      h += '</label>';
    }

    h += '</div>';

    if (rite) {
      h += '<div class="dt-sorcery-details">';
      h += `<div class="dt-sorcery-stat"><span class="dt-sorcery-label">Tradition/Level:</span> ${esc(rite.tradition)} ${rite.level}</div>`;
      const costLabel = riteCost(rite).label;
      if (costLabel) h += `<div class="dt-sorcery-stat"><span class="dt-sorcery-label">Cost:</span> ${esc(costLabel)}</div>`;
      if (rite.effect) h += `<div class="dt-sorcery-stat"><span class="dt-sorcery-label">Effect:</span> ${esc(rite.effect)}</div>`;

      // DTFP-6: structured multi-target picker. Persisted shape is an array of
      // {type, value} objects on responses[`sorcery_N_targets`]. Legacy string
      // values render as a single 'other' row; the next save converts to array.
      const rawTargets = saved[`sorcery_${n}_targets`];
      let targets;
      if (Array.isArray(rawTargets)) {
        targets = rawTargets;
      } else if (rawTargets && rawTargets.startsWith('[')) {
        try { targets = JSON.parse(rawTargets); } catch { targets = [{ type: '', value: '' }]; }
      } else if (rawTargets) {
        targets = [{ type: 'other', value: String(rawTargets) }];
      } else {
        targets = [{ type: '', value: '' }];
      }
      h += `<div class="qf-field dt-sorcery-targets-block" data-sorcery-slot-targets="${n}">`;
      h += `<label class="qf-label">Target/s</label>`;
      h += `<p class="qf-desc" style="margin:0 0 8px;font-size:.85em;opacity:.8">Not all target types are valid for every rite — check the rite's description for valid targets. The ST will reject any mismatched targeting at processing.</p>`;
      for (let ti = 0; ti < targets.length; ti++) {
        const t = targets[ti] || { type: '', value: '' };
        h += `<div class="dt-sorcery-target-row" data-sorcery-target-row="${n}-${ti}">`;
        h += renderTargetPicker(`sorcery_${n}_targets_${ti}`, {
          savedType: t.type || '',
          savedValue: t.value || '',
          allCharacters,
        });
        if (targets.length > 1 || (t.type || t.value)) {
          h += `<button type="button" class="dt-sorcery-target-remove-btn" data-sorcery-slot="${n}" data-target-idx="${ti}" title="Remove target">×</button>`;
        }
        h += `</div>`;
      }
      h += `<button type="button" class="dt-sorcery-target-add-btn" data-sorcery-slot="${n}">+ Add target</button>`;
      h += `</div>`;

      h += renderQuestion({
        key: `sorcery_${n}_notes`, label: 'Additional Notes',
        type: 'textarea', required: false,
        desc: 'Any extra context: co-casters, specific intentions, location, etc.',
      }, saved[`sorcery_${n}_notes`] || '');

      h += '</div>';
    }
    h += '</div>';
  }

  h += `<button type="button" class="dt-add-rite-btn" id="dt-add-rite">\u002B Add Rite</button>`;
  h += '</div></div>';
  return h;
}

// Async hydration for Mandragora-locked sorcery slots: fetches the prior cycle's
// submission and populates each locked slot's "Prior outcome" placeholder.
// Fire-and-forget — caller must .catch(() => {}) to swallow network failures.
async function _hydrateMgPriorOutcomesForm(lockedSlots) {
  if (!lockedSlots.length || !currentCycle) return;

  const allCycles = await apiGet('/api/downtime_cycles');
  const sortedCycles = allCycles
    .filter(c => c.cycle_number < currentCycle.cycle_number)
    .sort((a, b) => b.cycle_number - a.cycle_number);
  const priorCycle = sortedCycles[0];
  if (!priorCycle) {
    lockedSlots.forEach(({ n }) => {
      const el = document.getElementById(`dt-mg-prior-${n}`);
      if (el) { el.textContent = 'No prior resolution recorded.'; el.classList.remove('dt-mg-prior-loading'); }
    });
    return;
  }

  const priorSubs = await apiGet(
    `/api/downtime_submissions?cycle_id=${priorCycle._id}&character_id=${currentChar._id}`,
  );
  const priorSub = priorSubs[0];

  for (const { n, riteName } of lockedSlots) {
    let priorNote = null;
    if (priorSub) {
      const priorSlotCount = parseInt(priorSub.responses?.sorcery_slot_count || '0', 10);
      for (let pn = 1; pn <= priorSlotCount; pn++) {
        if (priorSub.responses?.[`sorcery_${pn}_rite`] === riteName) {
          priorNote = priorSub.sorcery_review?.[pn]?.ritual_result_note || null;
          break;
        }
      }
    }
    const el = document.getElementById(`dt-mg-prior-${n}`);
    if (el) {
      el.textContent = priorNote || 'No prior resolution recorded.';
      el.classList.remove('dt-mg-prior-loading');
    }
  }
}

// ── Acquisitions (custom render) ──

// dt-form.29 (story #87, ADR-003 §Audit-baseline). Two distinct sub-tables —
// Resources rows + Skill rows — both using the locked 3-col condensed shape
// (Description / Availability dots / Merit multi-select). Skill rows carry
// extra inline sub-fields (skill + spec) above the row + a read-only pool
// annotation derived via `skillAcqPoolStr` (the post-#42 source of truth).
//
// Persistence: `responses.acq_resource_rows` + `responses.acq_skill_rows`
// (JSON-stringified arrays). Mirror builder in collectResponses rebuilds the
// full legacy surface (acq_slot_count + acq_${N}_* + acq_* + resources_acquisitions
// blob + skill_acq_* + skill_acquisitions blob) on every save so existing
// admin/parser/db consumers keep working unchanged.
//
// Backward-compat seed: when `_rows` is empty, _readResourceRows /
// _readSkillRows seed rows[0] from the legacy single-row + multi-slot keys
// so pre-redesign drafts surface in the new UI on first render. Silent-leave
// for legacy keys per dt-form.26 A1 precedent — no migration script.

function _readResourceRows(saved) {
  let rows = [];
  const json = saved.acq_resource_rows || '';
  if (json) { try { rows = JSON.parse(json); } catch { rows = []; } }
  if (!Array.isArray(rows)) rows = [];
  if (rows.length) return rows;
  // Seed from legacy multi-slot keys.
  const slotCount = parseInt(saved.acq_slot_count || '0', 10);
  if (slotCount > 0) {
    for (let n = 1; n <= slotCount; n++) {
      const desc = saved[`acq_${n}_description`] || '';
      const avail = saved[`acq_${n}_availability`] || '';
      let merits = [];
      try { merits = JSON.parse(saved[`acq_${n}_merits`] || '[]'); } catch { merits = []; }
      if (desc || avail || merits.length) {
        rows.push({ description: desc, availability: avail, merits });
      }
    }
  }
  // Seed from legacy single-row if multi-slot was empty.
  if (!rows.length) {
    const desc = saved.acq_description || '';
    const avail = saved.acq_availability || '';
    let merits = [];
    try { merits = JSON.parse(saved.acq_merits || '[]'); } catch { merits = []; }
    if (desc || avail || merits.length) {
      rows.push({ description: desc, availability: avail, merits });
    }
  }
  if (!rows.length) rows.push({ description: '', availability: '', merits: [] });
  return rows;
}

function _readSkillRows(saved) {
  let rows = [];
  const json = saved.acq_skill_rows || '';
  if (json) { try { rows = JSON.parse(json); } catch { rows = []; } }
  if (!Array.isArray(rows)) rows = [];
  if (rows.length) return rows;
  // Seed from legacy single-row keys (skills was 1-per-cycle pre-redesign).
  const skill = saved.skill_acq_pool_skill || '';
  const spec  = saved.skill_acq_pool_spec  || '';
  const desc  = saved.skill_acq_description || '';
  const avail = saved.skill_acq_availability || '';
  let merits = [];
  try { merits = JSON.parse(saved.skill_acq_merits || '[]'); } catch { merits = []; }
  if (skill || spec || desc || avail || merits.length) {
    rows.push({ skill, spec, description: desc, availability: avail, merits });
  }
  if (!rows.length) rows.push({ skill: '', spec: '', description: '', availability: '', merits: [] });
  return rows;
}

function _renderAcqAvailabilityDots(rowKey, idx, savedAvail) {
  const isUnknown = savedAvail === 'unknown';
  const numAvail = isUnknown ? 0 : (parseInt(savedAvail, 10) || 0);
  let h = `<div class="dt-acq-avail-row" data-acq-avail="${rowKey}_${idx}">`;
  for (let d = 1; d <= 5; d++) {
    const filled = !isUnknown && d <= numAvail ? ' dt-acq-dot-filled' : '';
    h += `<span class="dt-acq-dot${filled}" data-acq-dot="${d}" data-acq-row-key="${rowKey}" data-acq-row-idx="${idx}">●</span>`;
  }
  h += `<span class="dt-acq-unknown${isUnknown ? ' dt-acq-dot-filled' : ''}" data-acq-unknown data-acq-row-key="${rowKey}" data-acq-row-idx="${idx}">Unknown</span>`;
  if (numAvail) {
    const labels = ['', 'Common', 'Uncommon', 'Rare', 'Very Rare', 'Unique'];
    const lbl = labels[numAvail] || '';
    if (lbl) h += `<span class="dt-acq-avail-label">${lbl}</span>`;
  }
  h += `<input type="hidden" data-acq-avail-hidden="${rowKey}_${idx}" value="${esc(String(savedAvail || ''))}">`;
  h += '</div>';
  return h;
}

function _renderAcqMeritsCheckboxes(rowKey, idx, charMerits, savedMerits) {
  let h = `<div class="dt-proj-merits" data-acq-merits="${rowKey}_${idx}">`;
  if (!charMerits.length) {
    h += '<p class="qf-desc">No applicable merits.</p>';
  } else {
    for (const m of charMerits) {
      const mName = m.area ? `${m.name} (${m.area})` : (m.qualifier ? `${m.name} (${m.qualifier})` : m.name);
      const dots = '●'.repeat(meritEffectiveRating(currentChar, m));
      const mKey = `${m.name}|${m.area || m.qualifier || ''}`;
      const checked = (savedMerits || []).includes(mKey) ? ' checked' : '';
      h += `<label class="dt-proj-merit-label">`;
      h += `<input type="checkbox" value="${esc(mKey)}" data-acq-merit-cb data-acq-row-key="${rowKey}" data-acq-row-idx="${idx}"${checked}>`;
      h += `<span>${esc(mName)} ${dots}</span>`;
      h += `</label>`;
    }
  }
  h += '</div>';
  return h;
}

function _renderResourceRow(idx, row, charMerits, isOnly) {
  let h = `<div class="dt-acq-card" data-acq-row="resource_${idx}" data-acq-row-key="resource" data-acq-row-idx="${idx}">`;
  h += '<div class="dt-acq-card-hd">';
  h += `<div class="dt-acq-card-title">Item ${idx + 1}</div>`;
  if (!isOnly) {
    h += `<button type="button" class="dt-sorcery-remove dt-acq-remove" data-acq-row-remove="resource" data-acq-row-idx="${idx}" title="Remove this item">\xD7 Remove</button>`;
  }
  h += '</div>';

  h += '<div class="qf-field">';
  h += '<label class="qf-label">Description</label>';
  h += `<textarea class="qf-textarea" rows="2" data-acq-desc="resource_${idx}" placeholder="What are you attempting to acquire? Include context and purpose.">${esc(row.description || '')}</textarea>`;
  h += '</div>';

  h += '<div class="qf-field">';
  h += '<label class="qf-label">Availability</label>';
  h += '<p class="qf-desc">How rare is this item? 1 = Common, 5 = Unique.</p>';
  h += _renderAcqAvailabilityDots('resource', idx, row.availability);
  h += '</div>';

  h += '<div class="qf-field">';
  h += '<label class="qf-label">Relevant Merits</label>';
  h += '<p class="qf-desc">Select merits that support this acquisition.</p>';
  h += _renderAcqMeritsCheckboxes('resource', idx, charMerits, row.merits);
  h += '</div>';

  h += '</div>';
  return h;
}

function _renderSkillRow(idx, row, charMerits, c, skSkills, isOnly) {
  let h = `<div class="dt-acq-card" data-acq-row="skill_${idx}" data-acq-row-key="skill" data-acq-row-idx="${idx}">`;
  h += '<div class="dt-acq-card-hd">';
  h += `<div class="dt-acq-card-title">Skill ${idx + 1}</div>`;
  if (!isOnly) {
    h += `<button type="button" class="dt-sorcery-remove dt-acq-remove" data-acq-row-remove="skill" data-acq-row-idx="${idx}" title="Remove this skill">\xD7 Remove</button>`;
  }
  h += '</div>';

  const savedSkill = row.skill || '';
  const savedSpec  = row.spec  || '';
  h += '<div class="qf-field">';
  h += '<label class="qf-label">Skill</label>';
  h += `<select class="qf-select" data-acq-skill="${idx}">`;
  h += '<option value="">— Select skill —</option>';
  for (const s of skSkills) {
    const dots = skTotal(c, s);
    const sel = savedSkill === s ? ' selected' : '';
    h += `<option value="${esc(s)}"${sel}>${esc(s)} (${dots})</option>`;
  }
  h += '</select>';
  h += '</div>';

  const skNativeSpecs = savedSkill ? (c.skills?.[savedSkill]?.specs || []) : [];
  const skIsSpecs = isSpecs(c).filter(({ spec }) => !skNativeSpecs.includes(spec));
  const allSpecs = [
    ...skNativeSpecs.map(sp => ({ sp, fromSkill: null, native: true })),
    ...skIsSpecs.map(({ spec, fromSkill }) => ({ sp: spec, fromSkill, native: false })),
  ];
  if (allSpecs.length) {
    h += '<div class="qf-field">';
    h += '<label class="qf-label">Specialisation</label>';
    h += '<div class="dt-feed-spec-row">';
    for (const { sp, fromSkill, native } of sortChips(allSpecs, item => item.sp)) {
      const on = savedSpec === sp ? ' dt-feed-spec-on' : '';
      const label = native ? esc(sp) : `${esc(sp)} (${esc(fromSkill)})`;
      h += `<button type="button" class="dt-feed-spec-chip${on}" data-acq-skill-spec="${esc(sp)}" data-acq-row-idx="${idx}">${label} <span class="dt-feed-spec-bonus">+${hasAoE(c, sp) ? 2 : 1}</span></button>`;
    }
    h += '</div>';
    h += `<input type="hidden" data-acq-skill-spec-hidden="${idx}" value="${esc(savedSpec)}">`;
    h += '</div>';
  } else {
    h += `<input type="hidden" data-acq-skill-spec-hidden="${idx}" value="${esc(savedSpec)}">`;
  }

  // Read-only pool annotation. Post-#42: SKILL only via skillAcqPoolStr.
  // This is the only pool-rendering site after dt-form.29 (the inline
  // duplicate at the legacy renderer is gone).
  h += '<div class="qf-field">';
  h += '<label class="qf-label">Acquisition Pool</label>';
  if (savedSkill) {
    const poolStr = skillAcqPoolStr(c, { skill: savedSkill, spec: savedSpec });
    if (poolStr) {
      h += `<p class="qf-desc dt-acq-pool-readout">${esc(poolStr)}</p>`;
    } else {
      h += '<p class="qf-desc">Pool unavailable for this skill.</p>';
    }
  } else {
    h += '<p class="qf-desc">Pick a skill above to see the auto-derived pool.</p>';
  }
  h += '</div>';

  h += '<div class="qf-field">';
  h += '<label class="qf-label">Description</label>';
  h += `<textarea class="qf-textarea" rows="2" data-acq-desc="skill_${idx}" placeholder="What are you attempting to obtain, and how?">${esc(row.description || '')}</textarea>`;
  h += '</div>';

  h += '<div class="qf-field">';
  h += '<label class="qf-label">Availability</label>';
  h += '<p class="qf-desc">How rare is this skill source? 1 = Common, 5 = Unique.</p>';
  h += _renderAcqAvailabilityDots('skill', idx, row.availability);
  h += '</div>';

  h += '<div class="qf-field">';
  h += '<label class="qf-label">Relevant Merits</label>';
  h += '<p class="qf-desc">Select merits that support this acquisition.</p>';
  h += _renderAcqMeritsCheckboxes('skill', idx, charMerits, row.merits);
  h += '</div>';

  h += '</div>';
  return h;
}

function renderAcquisitionsSection(saved) {
  const c = currentChar;
  const resourcesMerit = (c.merits || []).find(m => m.name === 'Resources');
  const resourcesRating = meritEffectiveRating(c, resourcesMerit);

  const charMerits = (c.merits || []).filter(m =>
    m.category === 'general' || m.category === 'influence' || m.category === 'standing'
  );
  const skSkills = ALL_SKILLS.filter(s => skTotal(c, s) > 0);

  const resourceRows = _readResourceRows(saved);
  const skillRows = _readSkillRows(saved);

  let h = '<div class="qf-section collapsed" data-section-key="acquisitions">';
  h += '<h4 class="qf-section-title">Asset Acquisitions<span class="qf-section-tick">✔</span></h4>';
  h += '<div class="qf-section-body">';

  // ── Resources sub-table ──
  h += '<div class="dt-acq-subtable" data-acq-subtable="resource">';
  h += '<h5 class="dt-acq-subtitle">Resource-Based Asset Acquisition</h5>';
  h += '<div class="dt-acq-resources-row dt-acq-resources-header">';
  h += `<span class="dt-acq-label">Resources Level:</span>`;
  h += `<span class="dt-acq-dots">${resourcesRating ? '●'.repeat(resourcesRating) : 'None'}</span>`;
  h += '</div>';
  for (let i = 0; i < resourceRows.length; i++) {
    h += _renderResourceRow(i, resourceRows[i], charMerits, resourceRows.length === 1);
  }
  h += '<button type="button" class="dt-add-rite-btn dt-acq-add" data-acq-add-row="resource">+ Add Resource Item</button>';
  h += '</div>';

  // ── Skills sub-table ──
  // Issue #187 (2026-05-08): Skill Acquisitions is a fixed single-row
  // section per the rules (only one skill can be acquired per cycle this
  // way). The repeating-row affordance was misleading. Render row 0 only;
  // no Add button, no Remove button (the `isOnly=true` flag suppresses
  // the per-row remove already). Resources Acquisitions above keeps its
  // Add affordance (resources can have multiple).
  // Persistence shape unchanged: `responses.acq_skill_rows` is still a
  // JSON array (now always length 1). Mirror keys (skill_acq_*) read
  // from row 0 (line 919-923) — no change required there. Multi-row
  // legacy data on the spread base prunes to row 0 on next save (per
  // A1 silent-leave; no real users have submitted skill multi-rows).
  h += '<div class="dt-acq-subtable" data-acq-subtable="skill" style="margin-top:18px;">';
  h += '<h5 class="dt-acq-subtitle">Skill-Based Asset Acquisition</h5>';
  h += '<p class="qf-section-intro">Use this section if you are using a skill to make, create, or directly obtain an asset or piece of equipment.</p>';
  const skillRow0 = skillRows[0] || { skill: '', spec: '', description: '', availability: '', merits: [] };
  h += _renderSkillRow(0, skillRow0, charMerits, c, skSkills, true);
  h += '</div>';

  h += '</div></div>'; // section-body, section
  return h;
}

// ── Equipment ──

function renderEquipmentSection(saved) {
  const section = DOWNTIME_SECTIONS.find(s => s.key === 'equipment');
  if (!section || section.hidden) return '';  // dt-form.30: hidden for this cycle

  const savedCount = parseInt(saved['equipment_slot_count'] || '1', 10);
  const slotCount = Math.max(1, savedCount);

  let h = '<div class="qf-section collapsed" data-section-key="equipment">';
  h += `<h4 class="qf-section-title">${esc(section.title)}<span class="qf-section-tick">\u2714</span></h4>`;
  h += '<div class="qf-section-body">';
  if (section.intro) h += `<p class="qf-section-intro">${esc(section.intro)}</p>`;

  h += `<input type="hidden" id="dt-equipment-slot-count" value="${slotCount}">`;

  h += '<div id="dt-equipment-rows">';
  for (let n = 1; n <= slotCount; n++) {
    h += renderEquipmentRow(n, saved);
  }
  h += '</div>';

  h += `<button type="button" class="dt-add-rite-btn" id="dt-add-equipment">\u002B Add Item</button>`;

  // ECM-9 (#876) — item_request escape valve. Players who want an item
  // not in the catalogue describe it in free-text; ST adjudicates inline
  // during DT processing (approve+create via the catalogue admin UI /
  // approve+substitute / reject with counter-note). Per epic D6 the field
  // is optional and lives on the existing DT submission shape — no new
  // collection, no new gate state.
  const itemRequestSaved = saved['item_request'] || '';
  h += '<div class="qf-field dt-item-request" style="margin-top:14px;">';
  h += '<label class="qf-label" for="dt-item-request">Item request <span class="qf-label-hint">(optional)</span></label>';
  h += `<textarea id="dt-item-request" class="qf-input dt-item-request-input" rows="3" placeholder="Describe an item you would like that is not in the catalogue. ST will adjudicate.">${esc(itemRequestSaved)}</textarea>`;
  h += '</div>';

  h += '</div></div>';
  return h;
}

// ECM-4 (#871) + epic D8: catalogue dropdown is the only way to assign an
// item; free-text catalogue entry is gone. The escape valve for items not
// in the catalogue is ECM-9's `item_request` textarea (rendered at the
// bottom of the equipment section).
//
// Legacy-compat: in-flight DT submissions from before this cycle carry
// `equipment_${n}_name` as a free-text string with no `_catalogue_id`.
// Per Khepri's dispatch + epic backcompat, we render those as a disabled
// placeholder option in the dropdown so the player sees what they had
// and can reselect from the catalogue (or leave it; the row stays
// uncommitted and the legacy name survives until the player edits).
function renderEquipmentRow(n, saved) {
  const items = getCatalogue();
  const byBucket = new Map();
  for (const it of items) {
    if (!byBucket.has(it.bucket)) byBucket.set(it.bucket, []);
    byBucket.get(it.bucket).push(it);
  }
  for (const arr of byBucket.values()) {
    arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  const selectedId = saved[`equipment_${n}_catalogue_id`] || '';
  const legacyName = saved[`equipment_${n}_name`] || '';

  // #896: per-character affordability gate. Resources rating is the cap
  // for effective availability (raw - fixer reduction). The raw-availability
  // max a character can afford is `cap + fixer` — that's the number we
  // show in the tooltip + footnote (matches the dispatch's wording).
  const cap   = availabilityCap(currentChar);
  const fixer = fixerReduction(currentChar);
  const rawMax = cap + fixer;

  let h = `<div class="dt-equipment-row" id="dt-equipment-row-${n}">`;
  h += `<div class="dt-equipment-row-fields">`;
  h += `<select id="dt-equipment_${n}_catalogue_id" class="qf-input dt-equip-cat">`;
  h += `<option value="">\u2014 select item \u2014</option>`;
  if (legacyName && !selectedId) {
    h += `<option value="" disabled>(legacy: ${esc(legacyName)} \u2014 please reselect)</option>`;
  }
  for (const bucket of ['weapon', 'armour', 'equipment', 'asset']) {
    const arr = byBucket.get(bucket);
    if (!arr || !arr.length) continue;
    h += `<optgroup label="${esc(bucket)}">`;
    for (const it of arr) {
      const sel       = String(it._id) === selectedId ? ' selected' : '';
      const eff       = effectiveAvailability(it, currentChar);
      const aff       = isAffordable(it, currentChar);
      const disabled  = (!aff && !sel) ? ' disabled' : '';
      const tooltip   = !aff
        ? ` title="Above your effective availability (Resources ${cap} + Fixer ${fixer} = max ${rawMax}). Use the item request field below to ask the ST for it."`
        : '';
      const availTag  = (it.availability == null) ? '' : ` (avail ${eff})`;
      h += `<option value="${esc(String(it._id))}"${sel}${disabled}${tooltip}>${esc(it.name || '')}${availTag}</option>`;
    }
    h += `</optgroup>`;
  }
  h += `</select>`;
  // #896: footnote under the dropdown \u2014 surfaces the cap math so players
  // see why some options are disabled without hovering each.
  h += `<div class="dt-equipment-cap-note" style="font-size:0.8em;opacity:0.7;margin-top:2px;">Showing items you can acquire. Resources ${cap} + Fixer reduction ${fixer} = effective availability cap ${rawMax}.</div>`;
  h += `<input type="number" id="dt-equipment_${n}_qty" class="qf-input dt-equip-qty" placeholder="Qty" min="1" value="${esc(saved[`equipment_${n}_qty`] || '1')}">`;
  h += `<input type="text" id="dt-equipment_${n}_notes" class="qf-input dt-equip-notes" placeholder="Notes (optional)" value="${esc(saved[`equipment_${n}_notes`] || '')}">`;
  if (n > 1) h += `<button type="button" class="dt-sorcery-remove" data-remove-equipment="${n}" title="Remove">\u00D7</button>`;
  h += '</div>';
  h += '</div>';
  return h;
}

/** Recalculate and display the dice pool total for a given pool prefix. */
function updatePoolTotal(prefix) {
  const attrEl  = document.getElementById(`dt-${prefix}_attr`);
  const skillEl = document.getElementById(`dt-${prefix}_skill`);
  const discEl  = document.getElementById(`dt-${prefix}_disc`);
  const specEl  = document.getElementById(`dt-${prefix}_spec`);
  const totalEl = document.getElementById(`${prefix}_total`);
  if (!totalEl) return;

  let total = 0;
  if (attrEl?.value) total += getAttrEffective(currentChar, attrEl.value);
  if (skillEl?.value) total += skTotal(currentChar, skillEl.value);
  if (discEl?.value) total += discDots(currentChar, discEl.value);
  if (specEl?.value && skillEl?.value) {
    const specs = currentChar.skills?.[skillEl.value]?.specs || [];
    if (specs.includes(specEl.value)) {
      total += hasAoE(currentChar, specEl.value) ? 2 : 1;
    }
  }

  totalEl.textContent = total || '—';
}

// ── Merit toggles ──

/** Render a merit toggle with its form inlined directly below. */
function renderMeritToggle(m, saved, formHtml) {
  const key = meritKey(m);
  const val = gateValues[`merit_${key}`] || saved[`_merit_${key}`] || '';
  const active = val === 'yes';

  let h = `<div class="qf-field">`;
  h += `<label class="qf-label">${meritLabel(m)} — use this Downtime?</label>`;
  h += `<div class="qf-radio-group">`;
  for (const opt of [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]) {
    const checked = val === opt.value ? ' checked' : '';
    h += `<label class="qf-radio-label">`;
    h += `<input type="radio" name="merit-${key}" value="${opt.value}"${checked} data-merit-toggle="${key}">`;
    h += `<span>${opt.label}</span>`;
    h += `</label>`;
  }
  h += '</div>';
  // Inline form — shown only when active
  if (active && formHtml) {
    h += `<div class="dt-merit-inline" data-merit-section="${key}">${formHtml}</div>`;
  }
  h += '</div>';
  return h;
}

/** Render merit toggle radios with inline form sections. */
// ── Unified feeding pool selector ──
// scope: 'feed' (main) or 'rote' — determines element IDs and data attributes
function renderFeedPoolSelector(c, methodId, selAttr, selSkill, selDisc, selSpec, scope) {
  const isOther = methodId === 'other';
  const isOpen  = !methodId; // DTFP-4: no method picked — show all char discs in dropdown
  const m = isOther ? null : FEED_METHODS.find(fm => fm.id === methodId);
  const pfx = scope === 'rote' ? 'rote' : 'feed';

  // All attrs/skills the char has dots in
  const allAttrs = ALL_ATTRS.filter(a => getAttrTotal(c, a) > 0);
  const allSkills = ALL_SKILLS.filter(s => skTotal(c, s) > 0);
  const allDiscs = (isOther || isOpen)
    ? Object.keys(c.disciplines || {}).filter(d => discDots(c, d) > 0)
    : (m?.discs || []).filter(d => discDots(c, d) > 0);

  // Calculate total from current selections
  let total = 0;
  if (selAttr) total += getAttrEffective(c, selAttr);
  if (selSkill) total += skTotal(c, selSkill);
  if (selDisc) total += discDots(c, selDisc);
  const fgVal = effectiveDomainDots(c, 'Feeding Grounds');
  total += fgVal;
  const specBonus = selSpec ? (hasAoE(c, selSpec) ? 2 : 1) : 0;
  total += specBonus;

  let h = '<div class="dt-feed-pool">';

  // ── Pool dropdowns ──
  h += '<div class="dt-feed-custom-row">';
  h += `<select class="qf-select" id="dt-${pfx}-custom-attr"><option value="">Attribute</option>`;
  for (const a of allAttrs) {
    const dots = getAttrEffective(c, a);
    h += `<option value="${esc(a)}"${selAttr===a?' selected':''}>${esc(a)} (${dots})</option>`;
  }
  h += '</select>';
  h += `<select class="qf-select" id="dt-${pfx}-custom-skill"><option value="">Skill</option>`;
  for (const s of allSkills) {
    const dots = skTotal(c, s);
    h += `<option value="${esc(s)}"${selSkill===s?' selected':''}>${esc(s)} (${dots})</option>`;
  }
  h += '</select>';
  if (allDiscs.length) {
    h += `<select class="qf-select" id="dt-${pfx}-disc"><option value="">Discipline</option>`;
    for (const d of allDiscs) {
      const dv = discDots(c, d);
      h += `<option value="${esc(d)}"${selDisc===d?' selected':''}>${esc(d)} (${dv})</option>`;
    }
    h += '</select>';
  }
  if (total > 0) h += `<span class="dt-feed-total">= ${total} dice</span>`;
  h += '</div>';
  if (selDisc) {
    h += '<p class="qf-desc" style="margin-top:6px">By adding a Discipline, if this roll fails, it will count as a dramatic failure.</p>';
  }

  // ── Suggestion chips (non-Other only) ──
  if (m && (m.attrs.length || m.skills.length || m.discs.length)) {
    h += '<div class="dt-feed-suggest">';
    h += '<span class="dt-feed-suggest-lbl">Suggestions:</span>';
    for (const a of sortChips(m.attrs)) {
      const val = getAttrEffective(c, a);
      const active = selAttr === a ? ' dt-feed-chip-on' : '';
      h += `<button type="button" class="dt-feed-chip dt-feed-chip-attr${active}" data-${pfx}-chip-attr="${esc(a)}">${esc(a)} (${val})</button>`;
    }
    h += '<span class="dt-feed-suggest-sep">/</span>';
    for (const s of sortChips(m.skills)) {
      const val = skTotal(c, s);
      const active = selSkill === s ? ' dt-feed-chip-on' : '';
      h += `<button type="button" class="dt-feed-chip dt-feed-chip-skill${active}" data-${pfx}-chip-skill="${esc(s)}">${esc(s)} (${val})</button>`;
    }
    if (m.discs.length) {
      h += '<span class="dt-feed-suggest-sep">/</span>';
      for (const d of sortChips(m.discs)) {
        const val = discDots(c, d);
        const active = selDisc === d ? ' dt-feed-chip-on' : '';
        h += `<button type="button" class="dt-feed-chip dt-feed-chip-disc${active}" data-${pfx}-chip-disc="${esc(d)}">${esc(d)} (${val})</button>`;
      }
    }
    h += '</div>';
    // DTFP-3: By Force teaching note when a brawl/weaponry-boosting discipline is picked
    if (m.id === 'force' && (selDisc === 'Vigour' || selDisc === 'Celerity')) {
      h += `<div class="dt-feed-teaching-note">Vigour and Celerity add bonus dice to Brawl and Weaponry pools. Confirm with your ST if your roll relies on this.</div>`;
    }
  }

  // ── Spec chips (for selected skill) ──
  const nativeSpecs = selSkill ? (c.skills?.[selSkill]?.specs || []) : [];
  const isSpecsList = selSkill ? isSpecs(c).filter(({ spec }) => !nativeSpecs.includes(spec)) : [];
  if (nativeSpecs.length || isSpecsList.length) {
    h += '<div class="dt-feed-spec-row"><label class="dt-feed-disc-lbl">Specialisation:</label>';
    const allSpecs = [
      ...nativeSpecs.map(sp => ({ sp, fromSkill: null, native: true })),
      ...isSpecsList.map(({ spec, fromSkill }) => ({ sp: spec, fromSkill, native: false })),
    ];
    for (const { sp, fromSkill, native } of sortChips(allSpecs, item => item.sp)) {
      const on = selSpec===sp?' dt-feed-spec-on':'';
      const label = native ? esc(sp) : `${esc(sp)} (${esc(fromSkill)})`;
      h += `<button type="button" class="dt-feed-spec-chip${on}" data-feed-spec="${esc(sp)}"${scope==='rote'?' data-rote-spec="1"':''}>${label} <span class="dt-feed-spec-bonus">+${hasAoE(c,sp)?2:1}</span></button>`;
    }
    h += '</div>';
  }

  if (fgVal) h += `<div class="dt-feed-dim" style="font-size:12px;margin-top:4px">+${fgVal} Feeding Grounds included in total</div>`;

  h += '</div>';
  return h;
}

// ── Territory pill switcher helpers ──

/**
 * DTFP-6: shared structured target picker. Renders a Character / Territory /
 * Other radio group plus the appropriate value control for the chosen type.
 *
 * `prefix` is used for ids and field names — e.g. 'project_2_target' produces
 * radio name 'dt-project_2_target_type' and value-field id 'dt-project_2_target_value'.
 * Used by project target_flex (single picker per slot) and sorcery targets
 * (multi-target via repeated picker rows; prefix becomes 'sorcery_N_targets_TI').
 */
function renderTargetPicker(prefix, opts) {
  const {
    savedType = '',
    savedValue = '',
    allCharacters = [],
    includeOptions = ['character', 'territory', 'other'],
    multiCharacter = false,
  } = opts || {};
  const labelMap = { character: 'Character', territory: 'Territory', other: 'Other' };

  let h = `<div class="dt-target-picker" data-target-prefix="${esc(prefix)}">`;
  h += `<div class="dt-target-flex-radios">`;
  for (const opt of includeOptions) {
    const chk = savedType === opt ? ' checked' : '';
    h += `<label class="dt-flex-radio-label"><input type="radio" name="dt-${esc(prefix)}_type" value="${esc(opt)}"${chk} data-flex-type="${esc(prefix)}"> ${esc(labelMap[opt] || opt)}</label>`;
  }
  h += `</div>`;

  if (savedType === 'character') {
    if (multiCharacter) {
      // Universal char picker (ADR-003 §Q6) — site #3a (joint target multi)
      let initialIds = [];
      try {
        const parsed = JSON.parse(savedValue || '[]');
        if (Array.isArray(parsed)) initialIds = parsed.map(String).filter(Boolean);
        else if (savedValue) initialIds = [String(savedValue)];
      } catch {
        if (savedValue) initialIds = [String(savedValue)];
      }
      const initialJson = esc(JSON.stringify(initialIds));
      h += `<input type="hidden" id="dt-${esc(prefix)}_value" value="${esc(JSON.stringify(initialIds))}">`;
      h += `<div data-cp-mount data-cp-site="target-flex-multi"`
         + ` data-cp-scope="all" data-cp-cardinality="multi"`
         + ` data-cp-hidden="dt-${esc(prefix)}_value"`
         + ` data-cp-initial="${initialJson}"`
         + ` data-cp-placeholder="Pick characters"></div>`;
    } else {
      // Universal char picker (ADR-003 §Q6) — site #1
      const initialJson = esc(JSON.stringify(savedValue ? String(savedValue) : ''));
      h += `<input type="hidden" id="dt-${esc(prefix)}_value" value="${esc(savedValue || '')}">`;
      h += `<div data-cp-mount data-cp-site="target-flex-single"`
         + ` data-cp-scope="all" data-cp-cardinality="single"`
         + ` data-cp-hidden="dt-${esc(prefix)}_value"`
         + ` data-cp-initial="${initialJson}"`
         + ` data-cp-placeholder="Pick a character"></div>`;
    }
  } else if (savedType === 'territory') {
    h += renderTerritoryPills(`dt-${prefix}_value`, savedValue);
  } else if (savedType === 'other') {
    h += `<input type="text" id="dt-${esc(prefix)}_value" class="qf-input" value="${esc(savedValue)}" placeholder="Describe the target">`;
  }
  h += `</div>`;
  return h;
}

/** Returns a Set of target_value identifiers already claimed by other maintenance slots (dtui-11). */
function getAlreadyMaintainedTargets(n, saved, maxSlots) {
  const maintained = new Set();
  for (let k = 1; k <= maxSlots; k++) {
    if (k === n) continue;
    if (saved[`project_${k}_action`] === 'maintenance' && saved[`project_${k}_target_value`]) {
      maintained.add(saved[`project_${k}_target_value`]);
    }
  }
  return maintained;
}

/**
 * Issue #167 + #170 (2026-05-08): walk sibling project slots and report
 * which actions are claimed elsewhere. Used by:
 *   - #167 ROTE single-instance — `siblingHasAction(saved, n, 'rote')`
 *     filters 'rote' out of the action-type dropdown
 *   - #170 Maintenance pill exclusion — `getAlreadyMaintainedTargets`
 *     above already does this for maintenance specifically; this helper
 *     gives consumers a general way to ask "does any sibling slot have
 *     action X?" without re-walking the slot map.
 *
 * Reads from the canonical `responses` object — no DOM dependency.
 */
function siblingHasAction(saved, currentSlot, action, maxSlots = 4) {
  for (let k = 1; k <= maxSlots; k++) {
    if (k === currentSlot) continue;
    if (saved[`project_${k}_action`] === action) return true;
  }
  return false;
}

/** Returns a Set of chip ids that maintenance_audit says are already done this chapter (dtui-50). */
function getAuditMaintained(cycle, char) {
  if (!cycle || !char) return new Set();
  const audit = cycle.maintenance_audit?.[String(char._id)] || {};
  const set = new Set();
  for (const m of (char.merits || [])) {
    if (m.name === 'Professional Training' && audit.pt === true) {
      set.add(`Professional Training_${meritEffectiveRating(char, m)}`);
    }
    if (m.name === 'Mystery Cult Initiation' && audit.mci === true && m.active !== false) {
      set.add(`Mystery Cult Initiation_${meritEffectiveRating(char, m)}`);
    }
  }
  return set;
}

/** Chip grid of the character's own maintenance-eligible merits (dtui-11).
 *  prefix defaults to 'project'; pass 'sphere' for Allies maintenance (dtui-16). */
function renderMaintenanceChips(n, saved, charData, alreadyMaintained, prefix = 'project', auditMaintained = new Set()) {
  const maintMerits = (charData?.merits || [])
    .filter(m => MAINTENANCE_MERITS.includes(m.name));

  const savedTarget = saved[`${prefix}_${n}_target_value`] || '';
  let h = `<input type="hidden" id="dt-${prefix}_${n}_target_value" value="${esc(savedTarget)}">`;

  if (maintMerits.length === 0) {
    h += '<p class="qf-desc">No merits requiring maintenance found for this character.</p>';
    return h;
  }

  h += `<div class="dt-chip-grid" role="group" aria-label="Select merit to maintain">`;
  for (const m of maintMerits) {
    const dots = meritEffectiveRating(currentChar, m);
    const id = `${m.name}_${dots}`;
    const dotStr = '●'.repeat(dots);
    const isSelected = savedTarget === id;
    const isDisabled = alreadyMaintained.has(id) || auditMaintained.has(id);
    const disabledAttr = isDisabled ? ' disabled aria-disabled="true"' : '';
    const titleAttr = auditMaintained.has(id)
      ? ' title="Maintained this chapter — no action needed."'
      : isDisabled
        ? ' title="Already chosen as a target in another project slot."'
        : '';
    const selectedClass = isSelected ? ' dt-chip--selected' : '';
    h += `<button type="button" class="dt-chip${selectedClass}"${disabledAttr}${titleAttr} ` +
         `data-maintenance-target="${n}" data-maintenance-prefix="${esc(prefix)}" data-target-id="${esc(id)}">` +
         `${esc(m.name)}${dotStr ? ` <span class="dt-chip__suffix">${dotStr}</span>` : ''}` +
         `</button>`;
  }
  h += '</div>';
  return h;
}

/** Returns a Set of target_value ids already claimed by other sphere/status maintenance slots (dtui-16). */
function getSphereAlreadyMaintainedTargets(prefix, n, saved, maxSlots) {
  const maintained = new Set();
  for (let k = 1; k <= maxSlots; k++) {
    if (k === n) continue;
    if (saved[`${prefix}_${k}_action`] === 'maintenance' && saved[`${prefix}_${k}_target_value`]) {
      maintained.add(saved[`${prefix}_${k}_target_value`]);
    }
  }
  return maintained;
}

/** Per-action outcome zone (dtui-9). */
function renderOutcomeZone(n, actionVal, saved) {
  const savedOutcome = saved[`project_${n}_outcome`] || '';

  // ambience_change, hide_protect, investigate, patrol_scout have no
  // interactive outcome — their goal is already covered by ACTION_DESCRIPTIONS
  // shown above the project title. Static readonly outcome lines were dropped
  // as redundant (2026-04-29).

  if (actionVal === 'attack') {
    const pills = ['destroy', 'degrade', 'disrupt'];
    const sel = savedOutcome || 'destroy';
    let h = `<fieldset class="dt-ticker" id="dt-project_${n}_outcome_group">`;
    h += '<legend class="dt-ticker__legend">Desired Outcome</legend>';
    for (const p of pills) {
      const label = p[0].toUpperCase() + p.slice(1);
      h += `<label class="dt-ticker__pill"><input type="radio" name="dt-project_${n}_outcome" value="${p}"${sel === p ? ' checked' : ''} data-proj-outcome="${n}"> ${label}</label>`;
    }
    h += '</fieldset>';
    return h;
  }

  if (actionVal === 'misc') {
    // Issue #186 (2026-05-08): Desired Outcome was a single-line input —
    // converted to textarea so the player can break their goal across
    // multiple paragraphs / returns. Persistence key unchanged
    // (`responses.project_${n}_outcome`); the existing collect path at
    // line 565-571 reads `outcomeEl.value` regardless of element type.
    return `<div class="qf-field">` +
      `<label class="qf-label" for="dt-project_${n}_outcome">Desired Outcome</label>` +
      `<textarea id="dt-project_${n}_outcome" class="qf-textarea" rows="3" data-proj-outcome="${n}" ` +
      `placeholder="${esc('State the goal of this project, aiming to achieve one clear thing.')}">` +
      `${esc(savedOutcome)}</textarea>` +
      `</div>`;
  }

  return '';
}

/** Unified target zone dispatcher (dtui-8). */
function renderTargetZone(n, actionVal, saved, chars) {
  let savedCharId = saved[`project_${n}_target_value`] || '';
  // backward compat: old submissions stored char IDs as JSON array string
  if (savedCharId.startsWith('[')) {
    try {
      const arr = JSON.parse(savedCharId);
      savedCharId = Array.isArray(arr) && arr.length > 0 ? String(arr[0]) : '';
    } catch { savedCharId = ''; }
  }
  const savedType   = saved[`project_${n}_target_type`] || '';
  const savedTerrId = saved[`project_${n}_target_terr`] || '';
  const savedOther  = saved[`project_${n}_target_other`] || '';

  let h = '<div class="qf-field dt-target-zone">';
  h += '<label class="qf-label">Target</label>';

  // Issue #132 (2026-05-08): dropped 'ambience_change' from this includes-list
  // and the orphan ambience_dir radio block that followed. After dt-form.25
  // (PR #130), 'target' is no longer in ACTION_FIELDS['ambience_change'], so
  // renderTargetZone is never called for ambience actions — the inner radio
  // render was unreachable dead code superseded by the row-table from #79.
  if (actionVal === 'patrol_scout') {
    h += renderTerritoryPills(`dt-project_${n}_target_terr`, savedTerrId);
  } else if (actionVal === 'attack') {
    h += renderTargetCharOrOther(n, savedType, savedCharId, savedTerrId, savedOther, chars, { includeTerritory: false });
  } else if (actionVal === 'hide_protect') {
    h += renderTargetCharOrOther(n, savedType, savedCharId, savedTerrId, savedOther, chars, { includeTerritory: false, includeOwnMerit: true });
  } else if (['investigate', 'misc'].includes(actionVal)) {
    h += renderTargetCharOrOther(n, savedType, savedCharId, savedTerrId, savedOther, chars, { includeTerritory: true });
  } else if (actionVal === 'maintenance') {
    const formDedup = getAlreadyMaintainedTargets(n, saved, 5);
    const auditMaint = getAuditMaintained(currentCycle, currentChar);
    h += renderMaintenanceChips(n, saved, currentChar, formDedup, 'project', auditMaint);
  }

  h += '</div>';
  return h;
}

/**
 * Connected Characters multi-select for a project action (issue #589 / #727).
 * Other PCs the player links to this action; flows to the ST Connected Characters
 * box. Stores selected character _ids as a JSON array in
 * `project_${n}_connected_chars`. Add via typeahead, remove via chip ✕.
 */
function renderConnectedCharsZone(n, saved, chars) {
  const key = `project_${n}_connected_chars`;
  const raw = saved[key];
  let ids = [];
  if (raw) {
    if (typeof raw === 'string' && raw.startsWith('[')) {
      try { const a = JSON.parse(raw); if (Array.isArray(a)) ids = a.map(String); } catch { ids = []; }
    } else if (Array.isArray(raw)) { ids = raw.map(String); }
    else { ids = [String(raw)]; }
  }
  // `chars` is the form's allCharacters: { id, name } (already self-excluded, name = moniker||name).
  const others = chars || [];
  const labelOf = (id) => {
    const c = others.find(ch => String(ch.id) === String(id));
    return c ? c.name : null; // unresolved -> dropped
  };
  const selected = ids.filter(Boolean).filter((id, i, a) => a.indexOf(id) === i);

  let h = '<div class="qf-field dt-connected-zone">';
  h += '<label class="qf-label">Connected Characters</label>';
  h += '<p class="qf-desc">Other player characters involved in or linked to this action (optional).</p>';
  h += `<div class="dt-conn-typeahead" data-conn-slot="${n}">`;
  h += '<div class="dt-conn-input-row">';
  h += `<input type="text" class="dt-conn-input" data-conn-slot="${n}" placeholder="Add a character…" autocomplete="off">`;
  h += '<div class="dt-conn-dropdown" style="display:none"></div>';
  h += '</div>';
  h += '<div class="dt-conn-chips">';
  for (const id of selected) {
    const nm = labelOf(id);
    if (!nm) continue;
    h += `<span class="dt-conn-chip" data-conn-id="${esc(id)}">${esc(nm)} `
       + `<button type="button" class="dt-conn-remove" data-conn-slot="${n}" data-conn-id="${esc(id)}" title="Remove">×</button></span>`;
  }
  h += '</div>';
  h += '</div>';
  h += '</div>';
  return h;
}

/**
 * Wire typeahead behaviour on all .dt-conn-typeahead widgets in container.
 * Must be called after every renderForm() because innerHTML wipes prior mounts.
 */
function initConnectedCharsTypeaheads(container) {
  container.querySelectorAll('.dt-conn-typeahead').forEach(wrap => {
    const slot     = wrap.dataset.connSlot;
    const key      = `project_${slot}_connected_chars`;
    const input    = wrap.querySelector('.dt-conn-input');
    const dropdown = wrap.querySelector('.dt-conn-dropdown');
    const chipsEl  = wrap.querySelector('.dt-conn-chips');
    if (!input || !dropdown || !chipsEl) return;

    const others = (allCharacters || []).slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    function getSelectedIds() {
      return new Set([...chipsEl.querySelectorAll('.dt-conn-chip')].map(c => c.dataset.connId));
    }

    function showDropdown(query) {
      const selected = getSelectedIds();
      const q = query.trim().toLowerCase();
      const matches = others.filter(c =>
        !selected.has(String(c.id)) && (!q ||
          String(c.name).toLowerCase().includes(q) ||
          String(c.fullName).toLowerCase().includes(q) ||
          String(c.player).toLowerCase().includes(q))
      );
      if (!matches.length) { dropdown.style.display = 'none'; return; }
      dropdown.innerHTML = '';
      for (const c of matches) {
        const item = document.createElement('div');
        item.className = 'dt-conn-dd-item';
        item.dataset.connId = String(c.id);
        item.textContent = c.name;
        dropdown.appendChild(item);
      }
      dropdown.style.display = '';
    }

    function addChip(id, name) {
      const chip = document.createElement('span');
      chip.className = 'dt-conn-chip';
      chip.dataset.connId = id;
      chip.appendChild(document.createTextNode(name + ' '));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dt-conn-remove';
      btn.dataset.connSlot = slot;
      btn.dataset.connId = id;
      btn.title = 'Remove';
      btn.textContent = '×';
      chip.appendChild(btn);
      chipsEl.appendChild(chip);
    }

    function saveToResponseDoc() {
      const ids = [...chipsEl.querySelectorAll('.dt-conn-chip')].map(c => c.dataset.connId);
      const base = (responseDoc && responseDoc.responses) || {};
      const next = { ...base, [key]: JSON.stringify(ids) };
      if (responseDoc) responseDoc.responses = next;
      else responseDoc = { responses: next };
      scheduleSave();
    }

    input.addEventListener('focus', () => showDropdown(input.value));
    input.addEventListener('input', () => showDropdown(input.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { dropdown.style.display = 'none'; input.value = ''; }
    });
    input.addEventListener('blur', () =>
      setTimeout(() => { dropdown.style.display = 'none'; }, 150)
    );

    wrap.addEventListener('click', e => {
      const ddItem = e.target.closest('.dt-conn-dd-item');
      if (ddItem) {
        const id   = ddItem.dataset.connId;
        const char = others.find(c => String(c.id) === id);
        if (char && !getSelectedIds().has(id)) {
          addChip(id, char.name);
          input.value = '';
          dropdown.style.display = 'none';
          saveToResponseDoc();
        }
        return;
      }
      const removeBtn = e.target.closest('.dt-conn-remove');
      if (removeBtn) {
        removeBtn.closest('.dt-conn-chip')?.remove();
        saveToResponseDoc();
      }
    });
  });
}

/** Character-or-Other (or Character/Territory/Other) target sub-widget. */
function renderTargetCharOrOther(n, savedType, savedCharId, savedTerrId, savedOther, chars, opts = {}) {
  const { includeTerritory = false, includeOwnMerit = false } = opts;
  const options = [];
  if (includeOwnMerit) options.push('own_merit');
  options.push('character');
  if (includeTerritory) options.push('territory');
  options.push('other');
  const labelMap = { own_merit: 'Own Merit', character: 'Character', territory: 'Territory', other: 'Other' };
  const effectiveType = savedType || (includeOwnMerit ? 'own_merit' : (includeTerritory ? '' : 'character'));

  let h = `<fieldset class="dt-ticker" aria-label="Target type">`;
  for (const opt of options) {
    const chk = effectiveType === opt ? ' checked' : '';
    h += `<label class="dt-ticker__pill"><input type="radio" name="dt-project_${n}_target_type" value="${esc(opt)}"${chk} data-flex-type="project_${n}_target"> ${esc(labelMap[opt])}</label>`;
  }
  h += '</fieldset>';

  if (effectiveType === 'own_merit') {
    h += `<select id="dt-project_${n}_target_value" class="qf-select">`;
    h += '<option value="">— Select Merit / Asset —</option>';
    for (const m of (currentChar.merits || [])) {
      const mLabel = m.area ? `${m.name} (${m.area})` : (m.qualifier ? `${m.name} (${m.qualifier})` : m.name);
      const mKey = `${m.name}|${m.area || m.qualifier || ''}`;
      const sel = mKey === savedCharId ? ' selected' : '';
      h += `<option value="${esc(mKey)}"${sel}>${esc(mLabel)}</option>`;
    }
    h += '</select>';
  } else if (effectiveType === 'character') {
    // Universal char picker (ADR-003 §Q6) — site #2
    const initialJson = esc(JSON.stringify(savedCharId ? String(savedCharId) : ''));
    h += `<input type="hidden" id="dt-project_${n}_target_value" value="${esc(savedCharId)}">`;
    h += `<div data-cp-mount data-cp-site="project-target-char"`
       + ` data-cp-scope="all" data-cp-cardinality="single"`
       + ` data-cp-hidden="dt-project_${n}_target_value"`
       + ` data-cp-initial="${initialJson}"`
       + ` data-cp-placeholder="Pick a target character"></div>`;
  } else if (effectiveType === 'territory') {
    h += renderTerritoryPills(`dt-project_${n}_target_terr`, savedTerrId);
    h += `<input type="hidden" id="dt-project_${n}_target_value" value="">`;
  } else if (effectiveType === 'other') {
    h += `<div class="dt-target-other-input">`;
    h += `<input type="text" id="dt-project_${n}_target_other" class="qf-input" value="${esc(savedOther)}" placeholder="Describe the target">`;
    h += `</div>`;
    h += `<input type="hidden" id="dt-project_${n}_target_value" value="">`;
  }

  return h;
}

/** Single-select territory pills. fieldId = the hidden input ID (same as old select ID).
 *  Uses the canonical .dt-chip-grid / .dt-chip styling so target-zone territory chips
 *  match the character roster visually. */
function renderTerritoryPills(fieldId, savedVal) {
  // 496.2: savedVal may be an ObjectId string (new format) or a short slug
  // (legacy). Normalise to slug for the pill-match check. The hidden input
  // keeps the saved value as-is so collectResponses() can remap on next save.
  let pillMatchSlug = savedVal;
  if (savedVal && /^[a-f0-9]{24}$/i.test(savedVal)) {
    const td = (_territories || []).find(t => String(t._id) === savedVal);
    if (td?.slug) pillMatchSlug = td.slug;
  }
  let h = `<div class="dt-chip-grid" data-terr-single="${fieldId}">`;
  for (const t of TERRITORY_DATA) {
    const selected = pillMatchSlug === t.slug ? ' dt-chip--selected' : '';
    h += `<button type="button" class="dt-chip${selected}" data-terr-single="${fieldId}" data-terr-val="${esc(t.slug)}">${esc(t.name)}</button>`;
  }
  h += '</div>';
  h += `<input type="hidden" id="${fieldId}" value="${esc(savedVal || '')}">`;
  return h;
}

/** Feeding territory pills. Pass rote=true for the rote-hunt variant (separate IDs/data-attrs).
 *  When rote=true, supply mainGridVals so rote pills can disable invalid pairings:
 *  - rote-Barrens is only enabled when main feed is Barrens
 *  - non-Barrens rote pills are disabled when main feed is Barrens
 */
function renderFeedingTerritoryPills(gridVals, rote = false, mainGridVals = null) {
  const idPfx = rote ? 'feed-rote-val' : 'feed-val';
  const keyAttr = rote ? 'data-feed-rote-terr-key' : 'data-feed-terr-key';
  const statusAttr = rote ? 'data-feed-rote-status' : 'data-feed-status';
  const activeAttr = rote ? 'data-feed-rote-active' : 'data-feed-active';
  // Determine main-feed Barrens state for rote-pill gating
  let mainIsBarrens = false;
  if (rote && mainGridVals) {
    for (const t of FEEDING_TERRITORIES) {
      const k = t.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      // 496.2: tolerant read across OID and legacy-slug keys
      const v = _terrGridVal(mainGridVals, t, k);
      if (v && v !== 'none' && t.includes('Barrens')) {
        mainIsBarrens = true;
      }
    }
  }
  let h = '<div class="dt-terr-pills dt-feed-terr-pills">';
  for (const terr of FEEDING_TERRITORIES) {
    const terrKey = terr.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const isBarrens = terr.includes('Barrens');
    const terrData = (_territories || []).find(t => t.name === terr) || TERRITORY_DATA.find(t => t.name === terr);
    const ambience = terrData ? terrData.ambience : '';

    // A character has feeding rights on a territory if they are:
    //   - the regent (territory.regent_id matches) — implicit, not in feeding_rights[]
    //   - the lieutenant (territory.lieutenant_id matches) — implicit
    //   - explicitly listed in territory.feeding_rights[]
    // Regent and lieutenant are stored on their own fields; the regency tab
    // deliberately strips them from feeding_rights[] to avoid duplication.
    const myId = String(currentChar._id);
    const hasFeedingRights = !isBarrens && (_territories || []).some(t => {
      if (t.name !== terr) return false;
      if (String(t.regent_id || '') === myId) return true;
      if (String(t.lieutenant_id || '') === myId) return true;
      return Array.isArray(t.feeding_rights) && t.feeding_rights.some(id => String(id) === myId);
    });

    // 496.2: tolerant read across OID (new) and legacy-slug (existing drafts) keys
    const rawSaved = _terrGridVal(gridVals, terr, terrKey);
    let savedVal = rawSaved || 'none';
    if (savedVal === 'resident') savedVal = 'feeding_rights';
    if (savedVal === 'poacher') savedVal = 'poaching';
    if (rawSaved === undefined && !isBarrens) {
      savedVal = hasFeedingRights ? 'feeding_rights' : 'none';
    }
    if (savedVal === 'poaching' && hasFeedingRights && !isBarrens) savedVal = 'feeding_rights';

    const isActive = savedVal !== 'none';
    const statusVal = isBarrens ? 'barrens' : (hasFeedingRights ? 'feeding_rights' : 'poaching');
    const statusLabel = isBarrens ? 'The Barrens' : (hasFeedingRights ? 'Feeding Rights' : 'Poaching');

    const tintClass = (isBarrens || !hasFeedingRights) ? ' dt-terr-pill-barrens' : ' dt-terr-pill-rights';
    const selectedClass = isActive ? ' dt-terr-pill--selected' : '';

    // Rote-feed Barrens lock: if main is Barrens, only Barrens-rote is allowed;
    // if main is non-Barrens, Barrens-rote is disallowed. Also disable Barrens
    // rote when no main territory is picked yet (you can't rote without main).
    let disabled = false;
    if (rote) {
      if (isBarrens) {
        if (!mainIsBarrens) disabled = true;
      } else {
        if (mainIsBarrens) disabled = true;
      }
    }
    const disabledAttrs = disabled ? ' disabled aria-disabled="true" title="Rote territory must match main feed territory"' : '';
    const disabledClass = disabled ? ' dt-terr-pill-disabled' : '';

    h += `<button type="button" class="dt-terr-pill${tintClass}${selectedClass}${disabledClass}"${disabledAttrs}`;
    h += ` ${keyAttr}="${terrKey}" ${statusAttr}="${statusVal}" ${activeAttr}="${isActive ? '1' : '0'}">`;
    h += `<span class="dt-terr-pill-name">${esc(isBarrens ? 'The Barrens' : terr)}</span>`;
    if (isBarrens) {
      if (isActive) h += `<span class="dt-terr-pill-amb">Barrens (-4)</span>`;
    } else if (ambience) {
      const mod = terrData?.ambienceMod;
      const modStr = mod !== undefined ? ` (${mod >= 0 ? '+' : ''}${mod})` : '';
      h += `<span class="dt-terr-pill-amb">${esc(ambience)}${modStr}</span>`;
    }
    if (isActive && !isBarrens) h += `<span class="dt-terr-pill-status">${statusLabel}</span>`;
    h += '</button>';
    h += `<input type="hidden" id="${idPfx}-${terrKey}" value="${savedVal}">`;
  }
  h += '</div>';
  return h;
}

// DTUI-17: Allies Ambience eligibility — effective dots ≥ 3 without HwV, ≥ 2 with
function getAlliesAmbienceEligible(m) {
  const effectiveDots = meritEffectiveRating(currentChar, m);
  const hwv = (currentChar.merits || []).some(
    merit => merit.name === 'Honey With Vinegar' || merit.name === 'Honey with Vinegar'
  );
  if (hwv) return effectiveDots >= 2;
  return effectiveDots >= 3;
}

// DTUI-19: Grow XP block — scoped to a specific Allies merit instance
function renderAlliesGrowXp(n, prefix, m, saved) {
  const currentDots = meritEffectiveRating(currentChar, m);
  const savedTarget = parseInt(saved[`${prefix}_${n}_grow_target`] || '0') || 0;
  const baseName = m.name || 'Merit';
  const meritName = m.area ? `${baseName} (${m.area})` : (m.qualifier ? `${baseName} (${m.qualifier})` : baseName);

  let h = '<div class="qf-field">';
  h += `<p class="qf-desc">Growing: <strong>${esc(meritName)}</strong> — currently ${currentDots} dot${currentDots !== 1 ? 's' : ''}.</p>`;
  h += `<label class="qf-label" for="dt-${prefix}_${n}_grow_target">Target dots</label>`;
  h += `<select id="dt-${prefix}_${n}_grow_target" class="qf-select" data-grow-target="${prefix}_${n}">`;
  h += '<option value="">— Select target —</option>';
  const maxTarget = currentDots < 3 ? 3 : Math.min(currentDots + 1, 5);
  for (let d = currentDots + 1; d <= maxTarget; d++) {
    const sel = savedTarget === d ? ' selected' : '';
    h += `<option value="${d}"${sel}>${d} dot${d !== 1 ? 's' : ''}</option>`;
  }
  h += '</select>';
  if (savedTarget > currentDots) {
    const xpCost = (savedTarget - currentDots) * 1;
    h += `<p class="qf-desc dt-grow-xp-cost">${xpCost} XP to reach ${savedTarget} dots.</p>`;
  }
  h += '</div>';
  return h;
}

// DTUI-18: Allies Ambience contribution magnitude
function getAlliesAmbienceContribution(m) {
  const effectiveDots = meritEffectiveRating(currentChar, m);
  const hwv = (currentChar.merits || []).some(
    merit => merit.name === 'Honey With Vinegar' || merit.name === 'Honey with Vinegar'
  );
  if (hwv) {
    if (effectiveDots >= 4) return 2;
    if (effectiveDots >= 2) return 1;
    return 0;
  }
  if (effectiveDots >= 5) return 2;
  if (effectiveDots >= 3) return 1;
  return 0;
}

// DTUI-18: read-only contribution notice for Ambience actions
function renderAlliesAmbienceDisplay(m, actionVal) {
  const contribution = getAlliesAmbienceContribution(m);
  if (contribution === 0) return '';
  const sign = actionVal === 'ambience_increase' ? '+' : '-';
  const copy = `You are exhausting these allies for the next game. These allies will count ${sign}${contribution} towards the targeted territory's ambience.`;
  return `<div class="dt-action-desc" aria-live="polite">${esc(copy)}</div>`;
}

// DTUI-15: map sphere action values to ACTION_DESCRIPTIONS keys
function sphereActionDescKey(val) {
  if (val === 'ambience_increase') return 'ambience_change_improve';
  if (val === 'ambience_decrease') return 'ambience_change_degrade';
  return val;
}

function renderSphereFields(n, prefix, fields, saved, charMerits, sphereMerit = null) {
  let h = '';

  if (fields.includes('territory')) {
    const savedTerr = saved[`${prefix}_${n}_territory`] || '';
    h += '<div class="qf-field">';
    h += '<label class="qf-label">Territory</label>';
    h += renderTerritoryPills(`dt-${prefix}_${n}_territory`, savedTerr);
    h += '</div>';
    // DTUI-18: Allies Ambience contribution display (after territory picker)
    const actionVal = saved[`${prefix}_${n}_action`] || '';
    if (sphereMerit && (actionVal === 'ambience_increase' || actionVal === 'ambience_decrease')) {
      h += renderAlliesAmbienceDisplay(sphereMerit, actionVal);
    }
  }

  if (fields.includes('ambience_dir')) {
    // Direction toggle for ambience_change. Mirrors the project pattern.
    // Default 'improve' if no saved direction yet. Reads legacy
    // ambience_increase/_decrease as improve/degrade for back-compat.
    const actionVal = saved[`${prefix}_${n}_action`] || '';
    let savedDir = saved[`${prefix}_${n}_ambience_dir`] || '';
    if (!savedDir) {
      if (actionVal === 'ambience_decrease') savedDir = 'degrade';
      else savedDir = 'improve';
    }
    h += '<div class="qf-field">';
    h += '<label class="qf-label">Direction</label>';
    h += `<fieldset class="dt-ticker" aria-label="Ambience direction">`;
    for (const [d, dLabel] of [['improve', 'Increase (+)'], ['degrade', 'Decrease (−)']]) {
      h += `<label class="dt-ticker__pill"><input type="radio" name="dt-${prefix}_${n}_ambience_dir" value="${d}"${savedDir === d ? ' checked' : ''} data-sphere-ambience-dir="${n}"> ${dLabel}</label>`;
    }
    h += `</fieldset>`;
    h += '</div>';
  }

  if (fields.includes('target_char')) {
    // DTUI-16: replaced dt-shoutout-grid checkboxes with .dt-chip-grid--single
    let savedTarget = saved[`${prefix}_${n}_target_value`] || '';
    // Handle legacy JSON array saved values from old checkbox approach
    try {
      const parsed = JSON.parse(savedTarget);
      if (Array.isArray(parsed) && parsed.length) savedTarget = String(parsed[0]);
    } catch { /* plain string */ }
    h += '<div class="qf-field">';
    h += '<label class="qf-label">Target Character</label>';
    h += `<input type="hidden" id="dt-${prefix}_${n}_target_value" value="${esc(savedTarget)}">`;
    h += `<div class="dt-chip-grid dt-chip-grid--single" data-sphere-char-grid="${prefix}_${n}">`;
    for (const c of allCharacters) {
      const id = String(c.id);
      const isSelected = savedTarget === id;
      const selectedClass = isSelected ? ' dt-chip--selected' : '';
      h += `<button type="button" class="dt-chip${selectedClass}"`;
      h += ` data-sphere-char-target="${prefix}_${n}" data-char-id="${esc(id)}">${esc(c.name)}</button>`;
    }
    h += '</div></div>';
  }

  if (fields.includes('block_merit')) {
    const savedMerit = saved[`${prefix}_${n}_block_merit`] || '';
    h += '<div class="qf-field">';
    h += `<label class="qf-label" for="dt-${prefix}_${n}_block_merit">Which merit are you targeting?</label>`;
    h += `<p class="qf-desc">Name your best guess — you may not know exactly what they have.</p>`;
    h += `<input type="text" id="dt-${prefix}_${n}_block_merit" class="qf-input" value="${esc(savedMerit)}" placeholder="e.g. Allies (Police), Status (Lancea)">`;
    h += '</div>';
  }

  if (fields.includes('target_own_merit')) {
    const savedVal = saved[`${prefix}_${n}_target_value`] || '';
    h += '<div class="qf-field">';
    h += `<label class="qf-label" for="dt-${prefix}_${n}_target_value">What are you protecting?</label>`;
    h += `<select id="dt-${prefix}_${n}_target_value" class="qf-select">`;
    h += '<option value="">— Select Merit / Asset —</option>';
    for (const m of charMerits) {
      const mLabel = m.area ? `${m.name} (${m.area})` : (m.qualifier ? `${m.name} (${m.qualifier})` : m.name);
      const mKey = `${m.name}|${m.area || m.qualifier || ''}`;
      const sel = mKey === savedVal ? ' selected' : '';
      h += `<option value="${esc(mKey)}"${sel}>${esc(mLabel)}</option>`;
    }
    h += '</select></div>';
  }

  if (fields.includes('target_flex')) {
    const savedType = saved[`${prefix}_${n}_target_type`] || '';
    const savedVal = saved[`${prefix}_${n}_target_value`] || '';
    h += '<div class="qf-field dt-target-flex">';
    h += '<label class="qf-label">What are you investigating?</label>';
    // DTFP-6: shared target picker; field id pattern preserved for save/handlers.
    h += renderTargetPicker(`${prefix}_${n}_target`, {
      savedType,
      savedValue: savedVal,
      allCharacters,
    });
    h += '</div>';
  }

  if (fields.includes('investigate_lead')) {
    h += renderQuestion({
      key: `${prefix}_${n}_investigate_lead`, label: 'What is your lead on this investigation? \u2731',
      type: 'textarea', required: true,
      desc: 'Provide a specific starting point, source, or known fact.',
    }, saved[`${prefix}_${n}_investigate_lead`] || '');
  }

  if (fields.includes('project_support')) {
    const savedVal = saved[`${prefix}_${n}_project_support`] || '';
    const activeProjects = [];
    const projectSection = DOWNTIME_SECTIONS.find(s => s.key === 'projects');
    const slotCount = projectSection?.projectSlots || 4;
    for (let p = 1; p <= slotCount; p++) {
      const act = saved[`project_${p}_action`] || '';
      if (act && act !== '') {
        const title = saved[`project_${p}_title`] || `Action ${p}`;
        activeProjects.push({ value: String(p), label: `${title} (${act})` });
      }
    }
    h += '<div class="qf-field">';
    h += `<label class="qf-label" for="dt-${prefix}_${n}_project_support">Which project are you supporting?</label>`;
    h += `<select id="dt-${prefix}_${n}_project_support" class="qf-select">`;
    h += '<option value="">— Select Project —</option>';
    for (const p of activeProjects) {
      const sel = p.value === savedVal ? ' selected' : '';
      h += `<option value="${esc(p.value)}"${sel}>${esc(p.label)}</option>`;
    }
    h += '</select></div>';
  }

  if (fields.includes('outcome')) {
    h += renderQuestion({
      key: `${prefix}_${n}_outcome`, label: 'Desired Outcome',
      type: 'text', required: false, desc: null,
    }, saved[`${prefix}_${n}_outcome`] || '');
  }

  if (fields.includes('description')) {
    h += renderQuestion({
      key: `${prefix}_${n}_description`, label: 'Description',
      type: 'textarea', required: false, desc: null,
    }, saved[`${prefix}_${n}_description`] || '');
  }

  if (fields.includes('maintenance_target')) {
    // DTUI-16: sphere maintenance — reuse renderMaintenanceChips with sphere prefix
    const maxSphereSlots = detectedMerits.spheres.length;
    const alreadyMaint = getSphereAlreadyMaintainedTargets(prefix, n, saved, maxSphereSlots);
    h += '<div class="qf-field">';
    h += '<label class="qf-label">What are you maintaining?</label>';
    h += renderMaintenanceChips(n, saved, currentChar, alreadyMaint, prefix);
    h += '</div>';
  }

  if (fields.includes('grow_xp')) {
    h += renderAlliesGrowXp(n, prefix, sphereMerit || {}, saved);
  }

  return h;
}

function renderMeritToggles(saved) {
  let h = '';
  const hasSpheres = detectedMerits.spheres.length > 0;
  const hasContacts = detectedMerits.contacts.length > 0;
  const hasRetainers = detectedMerits.retainers.length > 0;
  const hasStatus = detectedMerits.status.length > 0;
  const hasMentors = detectedMerits.mentors.length > 0;
  const totalStaffDots = detectedMerits.staff.reduce(
    (s, m) => s + (meritEffectiveRating(currentChar, m) || 0), 0
  );
  const hasStaff = totalStaffDots > 0;
  const charMerits = (currentChar.merits || []).filter(m =>
    m.category === 'general' || m.category === 'influence' || m.category === 'standing'
  );
  // Status-scoped list: only Status influence merits and standing merits (MCI etc.)
  // Used in renderSphereFields for Status tabs to prevent Allies/Contacts bleeding into
  // the hide_protect "What are you protecting?" dropdown.
  const statusMerits = (currentChar.merits || []).filter(m =>
    m.category === 'standing' || (m.category === 'influence' && m.name === 'Status')
  );

  if (!hasSpheres && !hasContacts && !hasRetainers && !hasStatus && !hasMentors && !hasStaff) return '';

  // ── Spheres of Influence (tabbed, max 5) ──
  if (hasSpheres) {
    const maxSpheres = Math.min(detectedMerits.spheres.length, 5);
    h += '<div class="qf-section collapsed" data-section-key="spheres">';
    h += '<h4 class="qf-section-title">Allies: Spheres of Influence<span class="qf-section-tick">✔</span></h4>';
    h += '<div class="qf-section-body">';
    h += '<p class="qf-section-intro">Your character has the following Allies merits. Use the tabs to configure up to 5 sphere actions this Downtime.</p>';

    // ── Tab bar ──
    h += '<div class="dt-proj-tabs">';
    for (let n = 1; n <= maxSpheres; n++) {
      const m = detectedMerits.spheres[n - 1];
      const actionVal = saved[`sphere_${n}_action`] || '';
      const icon = ACTION_ICONS[actionVal] || ACTION_ICONS[''];
      const label = actionVal ? (ACTION_SHORT[actionVal] || actionVal) : 'No Action';
      const active = n === activeSphereTab ? ' dt-proj-tab-active' : '';
      const noAction = !actionVal ? ' dt-proj-tab-empty' : '';
      h += `<button type="button" class="dt-proj-tab${active}${noAction}" data-sphere-tab="${n}">`;
      h += `<span class="dt-proj-tab-icon">${icon}</span>`;
      h += `<span class="dt-proj-tab-num">${esc(meritLabel(m))}</span>`;
      h += `<span class="dt-proj-tab-label">${esc(label)}</span>`;
      h += '</button>';
    }
    h += '</div>';

    // ── Tab panes ──
    for (let n = 1; n <= maxSpheres; n++) {
      const m = detectedMerits.spheres[n - 1];
      const actionVal = saved[`sphere_${n}_action`] || '';
      const visible = n === activeSphereTab;
      const fields = SPHERE_ACTION_FIELDS[actionVal] || [];

      h += `<div class="dt-proj-pane${visible ? '' : ' dt-proj-pane-hidden'}" data-sphere-pane="${n}">`;

      // Merit info header
      h += `<div class="dt-sphere-merit-info">${esc(meritLabel(m))}</div>`;

      // Store which merit this slot references
      h += `<input type="hidden" id="dt-sphere_${n}_merit_key" value="${esc(meritKey(m))}">`;

      // Action type selector
      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-sphere_${n}_action">Action Type</label>`;
      h += `<select id="dt-sphere_${n}_action" class="qf-select" data-sphere-action="${n}">`;
      // DTUI-17/19: filter per-merit eligibility; Grow now included
      const ambienceEligible = getAlliesAmbienceEligible(m);
      const filteredActions = SPHERE_ACTIONS.filter(o => {
        if (!ambienceEligible && o.value === 'ambience_change') return false;
        return true;
      });
      // Legacy actionVals 'ambience_increase'/'ambience_decrease' map to 'ambience_change' for the dropdown
      const dropdownVal = (actionVal === 'ambience_increase' || actionVal === 'ambience_decrease') ? 'ambience_change' : actionVal;
      for (const opt of filteredActions) {
        const sel = dropdownVal === opt.value ? ' selected' : '';
        h += `<option value="${esc(opt.value)}"${sel}>${esc(opt.label)}</option>`;
      }
      h += '</select></div>';

      // DTUI-15: action description below dropdown
      const descKey = sphereActionDescKey(actionVal);
      if (actionVal && ACTION_DESCRIPTIONS[descKey]) {
        h += `<div class="dt-action-desc" aria-live="polite">${esc(ACTION_DESCRIPTIONS[descKey])}</div>`;
      }

      h += renderSphereFields(n, 'sphere', fields, saved, charMerits, m);

      h += '</div>'; // pane
    }

    h += '</div></div>';
  }

  // ── Status (Broad / Narrow / MCI) ──
  if (detectedMerits.status.length > 0) {
    const maxStatus = Math.min(detectedMerits.status.length, 5);
    h += '<div class="qf-section collapsed" data-section-key="status">';
    h += '<h4 class="qf-section-title">Status: Social Standing<span class="qf-section-tick">✔</span></h4>';
    h += '<div class="qf-section-body">';
    h += '<p class="qf-section-intro">Use your Status merits to take social actions this Downtime.</p>';

    h += '<div class="dt-proj-tabs">';
    for (let n = 1; n <= maxStatus; n++) {
      const m = detectedMerits.status[n - 1];
      const actionVal = saved[`status_${n}_action`] || '';
      const icon = ACTION_ICONS[actionVal] || ACTION_ICONS[''];
      const label = actionVal ? (ACTION_SHORT[actionVal] || actionVal) : 'No Action';
      const active = n === 1 ? ' dt-proj-tab-active' : '';
      const noAction = !actionVal ? ' dt-proj-tab-empty' : '';
      const baseLabel = m.name === 'Mystery Cult Initiation' ? `MCI${m.cult_name ? ` (${m.cult_name})` : ''}` :
        (m.qualifier || m.area ? `Status (${m.qualifier || m.area})` : 'Broad Status');
      // Issue #190 (2026-05-08): append the character's dot rating so the
      // tab title reads "MCI ●●●" / "Status (Police) ●●●●". Uses the
      // canonical `meritEffectiveRating` so derived bonuses (PT, MCI
      // grants, etc.) are reflected. Tab is only rendered when the
      // character has the merit (existing detection at maxStatus loop
      // bound), so dots > 0 by construction.
      const statusDots = meritEffectiveRating(currentChar, m);
      const statusLabel = statusDots ? `${baseLabel} ${'●'.repeat(statusDots)}` : baseLabel;
      h += `<button type="button" class="dt-proj-tab${active}${noAction}" data-status-tab="${n}">`;
      h += `<span class="dt-proj-tab-icon">${icon}</span>`;
      h += `<span class="dt-proj-tab-num">${esc(statusLabel)}</span>`;
      h += `<span class="dt-proj-tab-label">${esc(label)}</span>`;
      h += '</button>';
    }
    h += '</div>';

    for (let n = 1; n <= maxStatus; n++) {
      const m = detectedMerits.status[n - 1];
      const actionVal = saved[`status_${n}_action`] || '';
      const visible = n === 1;
      const fields = SPHERE_ACTION_FIELDS[actionVal] || [];

      h += `<div class="dt-proj-pane${visible ? '' : ' dt-proj-pane-hidden'}" data-status-pane="${n}">`;
      h += `<input type="hidden" id="dt-status_${n}_merit_key" value="${esc(meritKey(m))}">`;

      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-status_${n}_action">Action Type</label>`;
      h += `<select id="dt-status_${n}_action" class="qf-select" data-status-action="${n}">`;
      // ambience_change is an Allies/sphere-only action; exclude from Status dropdown.
      // Legacy ambience_increase/decrease values in saved data are cleared gracefully
      // (no matching option → falls back to blank/"No Action").
      const stDropdownVal = actionVal;
      for (const opt of SPHERE_ACTIONS.filter(o => o.value !== 'ambience_change')) {
        const sel = stDropdownVal === opt.value ? ' selected' : '';
        h += `<option value="${esc(opt.value)}"${sel}>${esc(opt.label)}</option>`;
      }
      h += '</select></div>';

      h += renderSphereFields(n, 'status', fields, saved, statusMerits, m);

      h += '</div>';
    }

    h += '</div></div>';
  }

  // ── Contacts (expandable table) ──
  if (hasContacts) {
    const maxContacts = Math.min(detectedMerits.contacts.length, 5);
    h += '<div class="qf-section collapsed" data-section-key="contacts">';
    h += '<h4 class="qf-section-title">Contacts: Requests for Information<span class="qf-section-tick">✔</span></h4>';
    h += '<div class="qf-section-body">';
    h += '<p class="qf-section-intro">Click a contact to expand and submit an information request. Maximum 5 requests per Downtime.</p>';

    h += '<div class="dt-contacts-table">';
    for (let n = 1; n <= maxContacts; n++) {
      const m = detectedMerits.contacts[n - 1];
      const area = m.area || m.qualifier || '— sphere unset —';
      const dots = '\u25CF'.repeat(m.rating || 1);
      const savedInfo = saved[`contact_${n}_info`] || '';
      const savedReq = saved[`contact_${n}_request`] || '';
      const isUsed = savedInfo || savedReq;
      const expanded = isUsed;

      h += `<div class="dt-contact-row${isUsed ? ' dt-contact-used' : ''}" data-contact-row="${n}">`;
      // Header (clickable)
      h += `<div class="dt-contact-header" data-contact-toggle="${n}">`;
      h += `<span class="dt-contact-area">${esc(area)}</span>`;
      h += `<span class="dt-contact-dots">${dots}</span>`;
      h += `<span class="dt-contact-status">${isUsed ? 'Used' : 'Unused'}</span>`;
      if (isUsed) {
        h += `<button type="button" class="dt-contact-clear" data-contact-clear="${n}" title="Clear and close">\u2715</button>`;
      }
      h += '</div>';

      // Expandable panel
      h += `<div class="dt-contact-panel${expanded ? '' : ' dt-contact-panel-hidden'}" data-contact-panel="${n}">`;
      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-contact_${n}_info">Supporting Info</label>`;
      h += `<input type="text" id="dt-contact_${n}_info" class="qf-input" value="${esc(savedInfo)}" placeholder="Context, leverage, or relevant details">`;
      h += '</div>';
      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-contact_${n}_request">What specific information are you requesting?</label>`;
      h += `<p class="qf-desc">Name a person, event, or piece of information your contact would plausibly know. Vague requests (\u201Canything useful about X\u201D) will be resolved at ST discretion.</p>`;
      h += `<textarea id="dt-contact_${n}_request" class="qf-textarea" rows="3" placeholder="e.g. \u201CWhat does Marcus Reilly know about the missing shipment from March?\u201D">${esc(savedReq)}</textarea>`;
      h += '</div>';
      // Store merit label
      h += `<input type="hidden" id="dt-contact_${n}_merit" value="${esc(meritLabel(m))}">`;
      h += '</div>'; // panel
      h += '</div>'; // row
    }
    h += '</div>';

    h += '</div></div>';
  }

  // ── Retainers (expandable table) ──
  if (hasRetainers) {
    const maxRetainers = detectedMerits.retainers.length;
    h += '<div class="qf-section collapsed" data-section-key="retainers">';
    h += '<h4 class="qf-section-title">Retainers: Task Delegation<span class="qf-section-tick">✔</span></h4>';
    h += '<div class="qf-section-body">';
    h += '<p class="qf-section-intro">Click a retainer to expand and assign a task for this Downtime.</p>';

    h += '<div class="dt-contacts-table">';
    for (let n = 1; n <= maxRetainers; n++) {
      const m = detectedMerits.retainers[n - 1];
      const area = m.area || m.qualifier || 'Retainer';
      const dots = '\u25CF'.repeat(meritEffectiveRating(currentChar, m) || 1);
      const ghoulTag = m.ghoul ? ' (Ghoul)' : '';
      const savedType = saved[`retainer_${n}_type`] || '';
      const savedTask = saved[`retainer_${n}_task`] || '';

      const isUsed = savedType || savedTask;
      const expanded = isUsed;

      h += `<div class="dt-contact-row${isUsed ? ' dt-contact-used' : ''}" data-retainer-row="${n}">`;
      // Header
      h += `<div class="dt-contact-header" data-retainer-toggle="${n}">`;
      h += `<span class="dt-contact-area">${esc(area)}${esc(ghoulTag)}</span>`;
      h += `<span class="dt-contact-dots">${dots}</span>`;
      h += `<span class="dt-contact-status">${isUsed ? 'Tasked' : 'Idle'}</span>`;
      if (isUsed) {
        h += `<button type="button" class="dt-contact-clear" data-retainer-clear="${n}" title="Clear and close">\u2715</button>`;
      }
      h += '</div>';

      // Expandable panel
      h += `<div class="dt-contact-panel${expanded ? '' : ' dt-contact-panel-hidden'}" data-retainer-panel="${n}">`;
      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-retainer_${n}_type">Task Type</label>`;
      h += `<input type="text" id="dt-retainer_${n}_type" class="qf-input" value="${esc(savedType)}" placeholder="e.g. Guard, Investigate, Deliver, Procure">`;
      h += '</div>';
      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-retainer_${n}_task">Task Description</label>`;
      h += `<textarea id="dt-retainer_${n}_task" class="qf-textarea" rows="3" placeholder="What do you want them to do?">${esc(savedTask)}</textarea>`;
      h += '</div>';
      h += `<input type="hidden" id="dt-retainer_${n}_merit" value="${esc(meritLabel(m))}">`;
      h += '</div>'; // panel
      h += '</div>'; // row
    }
    h += '</div>';

    h += '</div></div>';
  }

  // ── Mentor (per-merit, mirrors Retainer pattern) ──
  // dt-form.28: one row per Mentor merit on the character (granted instances
  // included via the expandedInfluence walk in detectMerits — same pattern as
  // hotfix #45). Each row carries a free-text query type, a description
  // textarea, and an optional universal char picker for a target person.
  if (hasMentors) {
    const maxMentors = detectedMerits.mentors.length;
    h += '<div class="qf-section collapsed" data-section-key="mentors">';
    h += '<h4 class="qf-section-title">Mentor: Counsel<span class="qf-section-tick">✔</span></h4>';
    h += '<div class="qf-section-body">';
    h += '<p class="qf-section-intro">Click a mentor to expand and ask a question or request guidance for this Downtime.</p>';

    h += '<div class="dt-contacts-table">';
    for (let n = 1; n <= maxMentors; n++) {
      const m = detectedMerits.mentors[n - 1];
      const area = m.area || m.qualifier || 'Mentor';
      const dots = '●'.repeat(meritEffectiveRating(currentChar, m) || 1);
      const savedTarget = saved[`mentor_${n}_target`] || '';
      const savedTask = saved[`mentor_${n}_task`] || '';

      const isUsed = !!(savedTarget || savedTask);
      const expanded = isUsed;

      h += `<div class="dt-contact-row${isUsed ? ' dt-contact-used' : ''}" data-mentor-row="${n}">`;
      h += `<div class="dt-contact-header" data-mentor-toggle="${n}">`;
      h += `<span class="dt-contact-area">${esc(area)}</span>`;
      h += `<span class="dt-contact-dots">${dots}</span>`;
      h += `<span class="dt-contact-status">${isUsed ? 'Asked' : 'Idle'}</span>`;
      if (isUsed) {
        h += `<button type="button" class="dt-contact-clear" data-mentor-clear="${n}" title="Clear and close">✕</button>`;
      }
      h += '</div>';

      h += `<div class="dt-contact-panel${expanded ? '' : ' dt-contact-panel-hidden'}" data-mentor-panel="${n}">`;
      // Optional target — universal char picker (ADR-003 §Q6); excludes self.
      const initialJson = esc(JSON.stringify(savedTarget ? String(savedTarget) : ''));
      const excludeJson = esc(JSON.stringify(currentChar?._id ? [String(currentChar._id)] : []));
      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-mentor_${n}_target">Person involved (optional)</label>`;
      h += `<input type="hidden" id="dt-mentor_${n}_target" value="${esc(savedTarget)}">`;
      h += `<div data-cp-mount data-cp-site="mentor-target"`
         + ` data-cp-scope="all" data-cp-cardinality="single"`
         + ` data-cp-hidden="dt-mentor_${n}_target"`
         + ` data-cp-initial="${initialJson}"`
         + ` data-cp-exclude="${excludeJson}"`
         + ` data-cp-placeholder="Pick a target character"></div>`;
      h += '</div>';
      h += '<div class="qf-field">';
      h += `<label class="qf-label" for="dt-mentor_${n}_task">What are you asking your mentor?</label>`;
      h += `<textarea id="dt-mentor_${n}_task" class="qf-textarea" rows="3" placeholder="Question, advice sought, or guidance you want from this mentor.">${esc(savedTask)}</textarea>`;
      h += '</div>';
      h += `<input type="hidden" id="dt-mentor_${n}_merit" value="${esc(meritLabel(m))}">`;
      h += '</div>'; // panel
      h += '</div>'; // row
    }
    h += '</div>';

    h += '</div></div>';
  }

  // ── Staff (per-dot, mirrors Contacts per-slot pattern) ──
  // dt-form.28: one row per dot of Staff (summed across all Staff merits;
  // granted instances included via the expandedInfluence walk). Each row
  // carries an optional target char picker and a task-description textarea.
  if (hasStaff) {
    h += '<div class="qf-section collapsed" data-section-key="staff">';
    h += '<h4 class="qf-section-title">Staff: Tasks<span class="qf-section-tick">✔</span></h4>';
    h += '<div class="qf-section-body">';
    h += '<p class="qf-section-intro">Click a staff slot to expand and assign a task. One slot per dot of Staff.</p>';

    h += '<div class="dt-contacts-table">';
    // Issue #138 (2026-05-08): per-merit slot grouping. The persistence
    // shape stays sequential (`staff_${n}_*` 1..totalStaffDots) so legacy
    // submissions and the collect path are unchanged, but each row's
    // displayed label and `_merit` hidden field reflect its actual source
    // merit instead of the primary Staff merit. A character with
    // Staff 2 (Hospital) + Staff 1 (Police) now sees "Hospital — Slot 1/2"
    // for the first two rows and "Police — Slot 3/3" for the third.
    let n = 0;
    for (const m of detectedMerits.staff) {
      const dots = meritEffectiveRating(currentChar, m) || 0;
      if (!dots) continue;
      const meritLabelText = m.area || m.qualifier || 'Staff';
      for (let d = 0; d < dots; d++) {
        n += 1;
        const savedTarget = saved[`staff_${n}_target`] || '';
        const savedTask = saved[`staff_${n}_task`] || '';
        const isUsed = !!(savedTarget || savedTask);
        const expanded = isUsed;

        h += `<div class="dt-contact-row${isUsed ? ' dt-contact-used' : ''}" data-staff-row="${n}">`;
        h += `<div class="dt-contact-header" data-staff-toggle="${n}">`;
        h += `<span class="dt-contact-area">${esc(meritLabelText)} — Slot ${n}</span>`;
        h += `<span class="dt-contact-dots">●</span>`;
        h += `<span class="dt-contact-status">${isUsed ? 'Tasked' : 'Idle'}</span>`;
        if (isUsed) {
          h += `<button type="button" class="dt-contact-clear" data-staff-clear="${n}" title="Clear and close">✕</button>`;
        }
        h += '</div>';

        h += `<div class="dt-contact-panel${expanded ? '' : ' dt-contact-panel-hidden'}" data-staff-panel="${n}">`;
        const initialJson = esc(JSON.stringify(savedTarget ? String(savedTarget) : ''));
        const excludeJson = esc(JSON.stringify(currentChar?._id ? [String(currentChar._id)] : []));
        h += '<div class="qf-field">';
        h += `<label class="qf-label" for="dt-staff_${n}_target">Person involved (optional)</label>`;
        h += `<input type="hidden" id="dt-staff_${n}_target" value="${esc(savedTarget)}">`;
        h += `<div data-cp-mount data-cp-site="staff-target"`
           + ` data-cp-scope="all" data-cp-cardinality="single"`
           + ` data-cp-hidden="dt-staff_${n}_target"`
           + ` data-cp-initial="${initialJson}"`
           + ` data-cp-exclude="${excludeJson}"`
           + ` data-cp-placeholder="Pick a target character"></div>`;
        h += '</div>';
        h += '<div class="qf-field">';
        h += `<label class="qf-label" for="dt-staff_${n}_task">Task description</label>`;
        h += `<textarea id="dt-staff_${n}_task" class="qf-textarea" rows="3" placeholder="What do you want this staff slot to do?">${esc(savedTask)}</textarea>`;
        h += '</div>';
        h += `<input type="hidden" id="dt-staff_${n}_merit" value="${esc(meritLabel(m))}">`;
        h += '</div>'; // panel
        h += '</div>'; // row
      }
    }
    h += '</div>';

    h += '</div></div>';
  }

  return h;
}

// ── Section completion ticks ──

function updateSectionTicks(container) {
  container.querySelectorAll('.qf-section[data-section-key]').forEach(section => {
    const tick = section.querySelector('.qf-section-tick');
    if (!tick) return;
    const body = section.querySelector('.qf-section-body');
    if (!body) return;

    const key = section.dataset.sectionKey;

    // Projects: tick when project 1 has an action selected
    if (key === 'projects') {
      const p1Action = document.getElementById('dt-project_1_action');
      tick.classList.toggle('visible', !!(p1Action && p1Action.value));
      return;
    }

    // #637 / #939: personal_story tick is cosmetic only — Personal Story is now
    // OPTIONAL and no longer gates submission. The tick still lights when kind +
    // text are filled; the generic "all qf-fields filled" fallback would wrongly
    // require the OPTIONAL NPC name too, so this explicit rule stays.
    if (key === 'personal_story') {
      const kindChecked = !!body.querySelector('input[name="dt-personal_story_kind"]:checked');
      const textEl = document.getElementById('dt-personal_story_text');
      tick.classList.toggle('visible', kindChecked && !!(textEl && textEl.value.trim()));
      return;
    }

    // Issue #163 (2026-05-08): Court > Last Game Session tick rule. Min reqs:
    //   - travel description present
    //   - at least one game_recount highlight slot populated
    //   - at least one rp_shoutout pick (hidden input is JSON; '[]' counts as empty)
    // The fallback "all qf-fields filled" rule below was producing false
    // positives because the rp_shoutout hidden input always contained '[]'
    // when no picks were made — non-zero string length but empty payload.
    // Explicit rule reads the JSON payload to compute presence accurately.
    if (key === 'court') {
      const travelEl = document.getElementById('dt-travel');
      const travelOk = !!(travelEl && travelEl.value.trim());
      let highlightOk = false;
      for (let n = 1; n <= 5; n++) {
        const el = document.getElementById(`dt-game_recount_${n}`);
        if (el && el.value.trim()) { highlightOk = true; break; }
      }
      const shoutoutEl = document.getElementById('dt-rp_shoutout');
      let shoutoutOk = false;
      if (shoutoutEl) {
        try {
          const arr = JSON.parse(shoutoutEl.value || '[]');
          shoutoutOk = Array.isArray(arr) && arr.length > 0;
        } catch { shoutoutOk = false; }
      }
      tick.classList.toggle('visible', travelOk && highlightOk && shoutoutOk);
      return;
    }

    // Retainers: tick when any retainer has a task
    if (key === 'retainers') {
      const maxR = detectedMerits.retainers.length;
      let anyUsed = false;
      for (let n = 1; n <= maxR; n++) {
        const t = document.getElementById(`dt-retainer_${n}_type`);
        const d = document.getElementById(`dt-retainer_${n}_task`);
        if ((t && t.value.trim()) || (d && d.value.trim())) { anyUsed = true; break; }
      }
      tick.classList.toggle('visible', anyUsed);
      return;
    }

    // Contacts: tick when any contact has content
    if (key === 'contacts') {
      const maxC = Math.min(detectedMerits.contacts.length, 5);
      let anyUsed = false;
      for (let n = 1; n <= maxC; n++) {
        const info = document.getElementById(`dt-contact_${n}_info`);
        const req = document.getElementById(`dt-contact_${n}_request`);
        if ((info && info.value.trim()) || (req && req.value.trim())) { anyUsed = true; break; }
      }
      tick.classList.toggle('visible', anyUsed);
      return;
    }

    // dt-form.28: Mentors tick when any mentor row has target or task
    if (key === 'mentors') {
      const maxM = detectedMerits.mentors.length;
      let anyUsed = false;
      for (let n = 1; n <= maxM; n++) {
        const tg = document.getElementById(`dt-mentor_${n}_target`);
        const tk = document.getElementById(`dt-mentor_${n}_task`);
        if ((tg && tg.value.trim()) || (tk && tk.value.trim())) { anyUsed = true; break; }
      }
      tick.classList.toggle('visible', anyUsed);
      return;
    }

    // dt-form.28: Staff tick when any staff slot has target or task
    if (key === 'staff') {
      const maxS = detectedMerits.staff.reduce(
        (s, m) => s + (meritEffectiveRating(currentChar, m) || 0), 0
      );
      let anyUsed = false;
      for (let n = 1; n <= maxS; n++) {
        const tg = document.getElementById(`dt-staff_${n}_target`);
        const tk = document.getElementById(`dt-staff_${n}_task`);
        if ((tg && tg.value.trim()) || (tk && tk.value.trim())) { anyUsed = true; break; }
      }
      tick.classList.toggle('visible', anyUsed);
      return;
    }

    // Spheres: tick when any sphere slot has an action selected
    if (key === 'spheres') {
      const maxS = Math.min(detectedMerits.spheres.length, 5);
      let anyAction = false;
      for (let n = 1; n <= maxS; n++) {
        const el = document.getElementById(`dt-sphere_${n}_action`);
        if (el && el.value) { anyAction = true; break; }
      }
      tick.classList.toggle('visible', anyAction);
      return;
    }

    // dt-form.23: Regency tick reflects the cycle.regent_confirmations entry,
    // not a form field — predicate is the source of truth.
    if (key === 'regency') {
      tick.classList.toggle('visible', _isRegencyConfirmedThisCycle());
      return;
    }

    // Territory: tick when any feeding territory has a feeding_rights or poaching selection
    if (key === 'territory') {
      const feedRadios = body.querySelectorAll('input[type="radio"]:checked');
      const activeVals = new Set(['feeding_rights', 'poaching', 'resident', 'poach']);
      const hasSelection = Array.from(feedRadios).some(r => activeVals.has(r.value));
      tick.classList.toggle('visible', hasSelection);
      return;
    }

    // For all other sections: tick only when ALL visible fields are filled.
    // Skip fields inside hidden (gated) sub-sections.
    const fields = body.querySelectorAll('.qf-field:not(.dt-feedback-hidden)');
    let totalFields = 0;
    let filledFields = 0;

    fields.forEach(field => {
      // Skip if inside a hidden gated section
      if (field.closest('.dt-gated-hidden')) return;
      // Skip if the field itself is hidden (e.g. feedback before rating)
      if (field.classList.contains('dt-feedback-hidden')) return;

      // Find the input element(s) in this field
      const textarea = field.querySelector('textarea');
      const input = field.querySelector('input:not([type="hidden"]):not([type="radio"])');
      const select = field.querySelector('select');
      const hiddenInput = field.querySelector('input[type="hidden"]');
      const radioGroup = field.querySelectorAll('input[type="radio"]');
      const meritToggle = field.querySelector('[data-merit-toggle]');

      // Merit toggle fields: skip (they're action selectors, not content)
      if (meritToggle) return;

      let hasField = false;
      let isFilled = false;

      if (textarea) {
        hasField = true;
        isFilled = textarea.value.trim().length > 0;
      } else if (select) {
        hasField = true;
        isFilled = select.value.trim().length > 0;
      } else if (input) {
        hasField = true;
        isFilled = input.value.trim().length > 0;
      } else if (hiddenInput) {
        hasField = true;
        isFilled = hiddenInput.value.trim().length > 0;
      } else if (radioGroup.length > 0) {
        hasField = true;
        isFilled = !!field.querySelector('input[type="radio"]:checked');
      }

      if (hasField) {
        totalFields++;
        if (isFilled) filledFields++;
      }
    });

    const complete = totalFields > 0 && filledFields === totalFields;
    tick.classList.toggle('visible', complete);
  });
}

// ── Utilities ──

function updateGatedSections(container) {
  container.querySelectorAll('[data-gate-section]').forEach(section => {
    const gate = section.dataset.gateSection;
    if (!gate) return;
    if (gateValues[gate] === 'yes') {
      section.classList.remove('dt-gated-hidden');
    } else {
      section.classList.add('dt-gated-hidden');
    }
  });
}

function updateMeritSections(container) {
  renderForm(container);
}

function renderQuestion(q, value) {
  const reqMark = q.required ? ' <span class="qf-req">*</span>' : '';
  const extraClass = q.key === 'form_feedback' ? ' dt-feedback-field' : '';
  let h = `<div class="qf-field${extraClass}">`;
  // feeding_method renders its own label inside the container
  if (q.type !== 'feeding_method') {
    h += `<label class="qf-label" for="dt-${q.key}">${esc(q.label)}${reqMark}</label>`;
  }

  if (q.desc) {
    let descHtml = esc(q.desc).replace(/\n/g, '<br>');
    descHtml = descHtml.replace(/(Example:\s*.*)$/i, '<em>$1</em>');
    h += `<p class="qf-desc">${descHtml}</p>`;
  }

  switch (q.type) {
    case 'text':
      h += `<input type="text" id="dt-${q.key}" class="qf-input" value="${esc(value)}"${q.placeholder ? ` placeholder="${esc(q.placeholder)}"` : ''}>`;
      break;

    case 'textarea':
      h += `<textarea id="dt-${q.key}" class="qf-textarea" rows="${q.rows || 4}"${q.placeholder ? ` placeholder="${esc(q.placeholder)}"` : ''}>${esc(value)}</textarea>`;
      break;

    case 'select':
      h += `<select id="dt-${q.key}" class="qf-select">`;
      for (const opt of q.options) {
        const sel = value === String(opt.value) ? ' selected' : '';
        h += `<option value="${esc(String(opt.value))}"${sel}>${esc(opt.label)}</option>`;
      }
      h += '</select>';
      break;

    case 'star_rating': {
      const cur = parseInt(value, 10) || 0;
      h += `<input type="hidden" id="dt-${q.key}" value="${cur ? cur : ''}">`;
      h += '<div class="dt-star-row" data-star-input="dt-' + q.key + '">';
      for (let s = 1; s <= 5; s++) {
        const leftVal = s * 2 - 1;
        const rightVal = s * 2;
        const leftFill = cur >= leftVal ? ' dt-star-filled' : '';
        const rightFill = cur >= rightVal ? ' dt-star-filled' : '';
        h += `<span class="dt-star" data-star="${s}">`;
        h += `<span class="dt-star-half dt-star-left${leftFill}" data-star-val="${leftVal}">★</span>`;
        h += `<span class="dt-star-half dt-star-right${rightFill}" data-star-val="${rightVal}">★</span>`;
        h += '</span>';
      }
      if (cur) h += `<span class="dt-star-label">${cur}/10</span>`;
      else h += '<span class="dt-star-label"></span>';
      h += '</div>';
      break;
    }

    case 'radio':
      h += `<div class="qf-radio-group" id="dt-${q.key}">`;
      for (const opt of q.options) {
        const checked = value === opt.value ? ' checked' : '';
        h += `<label class="qf-radio-label">`;
        h += `<input type="radio" name="dt-${q.key}" value="${esc(opt.value)}"${checked}>`;
        h += `<span>${esc(opt.label)}</span>`;
        h += `</label>`;
      }
      h += '</div>';
      break;

    case 'shoutout_picks': {
      // Universal char picker (ADR-003 §Q6) — site #4 (attendees scope, multi).
      // Max-3 cap preserved via consumer-side onChange (see _makeCharPickerOnChange).
      let picks = [];
      if (value) { try { picks = JSON.parse(value); } catch { /* ignore */ } }
      const initialIds = picks.map(String).filter(Boolean);
      const initialJson = esc(JSON.stringify(initialIds));
      const savedJson = esc(JSON.stringify(initialIds));
      h += `<input type="hidden" id="dt-${esc(q.key)}" value="${savedJson}">`;
      h += `<div data-cp-mount data-cp-site="shoutout"`
         + ` data-cp-scope="attendees" data-cp-cardinality="multi"`
         + ` data-cp-hidden="dt-${esc(q.key)}"`
         + ` data-cp-initial="${initialJson}"`
         + ` data-cp-placeholder="Pick up to 3 attendees"></div>`;
      h += '<p class="qf-desc dt-shoutout-limit-hint">Up to 3 picks. A 4th will be ignored.</p>';
      break;
    }

    case 'feeding_method': {
      const c = currentChar;
      const savedDesc = responseDoc?.responses?.['feeding_description'] || '';

      // ── Container 1: Main hunt ──
      h += '<div class="dt-feed-card-wrap">';
      // Territory picker embedded at top of this container
      {
        const feedingSect = DOWNTIME_SECTIONS.find(s => s.key === 'feeding');
        const terrQ = feedingSect?.questions.find(q => q.type === 'territory_grid');
        if (terrQ) {
          const terrVal = (responseDoc?.responses || {})[terrQ.key] || '';
          let terrGridVals = {};
          try { terrGridVals = JSON.parse(terrVal); } catch { /* ignore */ }
          h += '<label class="qf-label">Where does your character hunt? <span class="qf-req">*</span></label>';
          h += `<div id="dt-${terrQ.key}" style="margin-top:10px">${renderFeedingTerritoryPills(terrGridVals)}</div>`;
          h += '<p class="qf-desc" style="margin-top:10px">Ambience shown is current. Actual feeding ambience is calculated after Downtime processing and may shift based on how many Kindred feed in each territory.</p>';
        }
      }
      h += `<label class="qf-label" style="margin-top:10px;display:block">How does your character hunt? <span class="qf-req">*</span></label>`;
      h += '<div class="dt-feed-methods">';
      for (const m of FEED_METHODS) {
        const sel = feedMethodId === m.id ? ' dt-feed-sel' : '';
        h += `<button type="button" class="dt-feed-card${sel}" data-feed-method="${m.id}">`;
        h += `<div class="dt-feed-card-name">${esc(m.name)}</div>`;
        h += `<div class="dt-feed-card-desc">${esc(m.desc)}</div>`;
        h += '</button>';
      }
      h += '</div>';

      // dt-form.20 (ADR-003 §Q2): MINIMAL renders a read-only auto-derived
      // pool annotation in place of the manual pool selectors. ADVANCED keeps
      // the existing chrome (DTFP-4: always visible, method optional).
      if (_formMode(responseDoc?.responses) === 'minimal') {
        const slugFromGrid = (gridStr) => {
          let grid = {};
          try { grid = JSON.parse(gridStr || '{}'); } catch { return ''; }
          const key = Object.keys(grid).find(k => grid[k] && grid[k] !== 'none');
          if (!key) return '';
          const t = (_territories || []).find(t => String(t._id) === key);
          return t?.slug || '';
        };
        const territorySlug = slugFromGrid(responseDoc?.responses?.feeding_territories);
        // Issue #166: pass the active speciality so the MINIMAL primary
        // readout includes the bonus when one is set (e.g. carried over
        // from a prior ADVANCED-mode toggle).
        // Issue #189: also pass skillOverride so the spec validation
        // matches the player's customised skill, mirroring the ROTE call.
        const pool = computeBestFeedingPool({
          char: c,
          methodId: feedMethodId,
          territorySlug,
          spec: feedSpecName || '',
          skillOverride: feedCustomSkill || '',
        });
        h += '<div class="qf-field dt-feed-min-pool">';
        if (!feedMethodId) {
          h += '<p class="qf-desc">Pick a method above to see your auto-derived hunt pool.</p>';
        } else if (!pool) {
          h += '<p class="qf-desc">Pool unavailable for this method.</p>';
        } else {
          const parts = [];
          if (pool.attr.name) parts.push(`${pool.attr.val} ${esc(pool.attr.name)}`);
          if (pool.skill.name) parts.push(`${pool.skill.val} ${esc(pool.skill.name)}`);
          else if (pool.unskilled) parts.push(`${pool.unskilled} unskilled`);
          if (pool.disc.name) parts.push(`${pool.disc.val} ${esc(pool.disc.name)}`);
          if (pool.spec?.bonus) parts.push(`+${pool.spec.bonus} ${esc(pool.spec.name)}`);
          h += `<label class="qf-label">Pool: <strong>${pool.total}</strong></label>`;
          h += `<p class="qf-desc">${parts.join(' &middot; ')} (auto-picked from your sheet)</p>`;
          // Issue #176: ambience is a Vitae yield modifier (Damnation
          // City §158), not a dice pool component. Surfaced separately
          // so the player still sees the territory's contribution.
          if (pool.ambience.mod) {
            const ambSign = pool.ambience.mod > 0 ? '+' : '−';
            const ambLabel = pool.ambience.label ? ` (${esc(pool.ambience.label)})` : '';
            h += `<p class="qf-desc dt-feed-dim">${ambSign}${Math.abs(pool.ambience.mod)} Vitae from territory ambience${ambLabel}</p>`;
          }
        }
        h += '</div>';
        h += '<p class="qf-desc dt-feed-min-pool__advanced-hint">Want to customise your pool? Switch to <strong>Advanced</strong> mode at the top of the form.</p>';
      } else {
        // ── Unified pool builder (DTFP-4: always visible, method optional) ──
        h += renderFeedPoolSelector(c, feedMethodId, feedCustomAttr, feedCustomSkill, feedDiscName, feedSpecName, 'feed');
      }

      // Blood type selection — single-select (legacy multi-array reads first item)
      const BLOOD_TYPES = ['Animal', 'Human', 'Kindred'];
      let savedBlood = [];
      try { savedBlood = JSON.parse(responseDoc?.responses?.['_feed_blood_types'] || '[]'); } catch { /* ignore */ }
      const selectedBlood = Array.isArray(savedBlood) && savedBlood.length ? savedBlood[0] : '';
      h += '<div class="qf-field">';
      h += '<label class="qf-label">Blood Type</label>';
      h += '<div class="dt-feed-violence-toggle">';
      for (const bt of BLOOD_TYPES) {
        const on = selectedBlood === bt ? ' dt-feed-vi-on' : '';
        h += `<button type="button" class="dt-feed-vi-btn${on}" data-blood-type="${esc(bt)}">${esc(bt)}</button>`;
      }
      h += '</div></div>';

      // ── DTFP-5: Kiss / Violent toggle ──
      const persistedViolence = responseDoc?.responses?.feed_violence || '';
      const preselect = persistedViolence || (FEED_VIOLENCE_DEFAULTS[feedMethodId] || '');
      h += '<div class="qf-field">';
      h += '<label class="qf-label">How loud was the feeding?</label>';
      h += '<div class="dt-feed-violence-toggle">';
      h += `<button type="button" class="dt-feed-vi-btn${preselect === 'kiss' ? ' dt-feed-vi-on' : ''}" data-feed-violence="kiss">The Kiss (subtle)</button>`;
      h += `<button type="button" class="dt-feed-vi-btn${preselect === 'violent' ? ' dt-feed-vi-on' : ''}" data-feed-violence="violent">The Assault (violent)</button>`;
      h += '</div>';
      if (!persistedViolence && !preselect) {
        h += '<p class="qf-desc dt-feed-vi-hint">Pick one. Your method does not pre-select for you.</p>';
      } else if (!persistedViolence && preselect) {
        h += '<p class="qf-desc dt-feed-vi-hint">Pre-selected based on your method. Click to confirm or change.</p>';
      }
      h += '</div>';

      h += '<div class="qf-field">';
      h += `<textarea id="dt-feeding_description" class="qf-textarea" rows="4" placeholder="Describe how your character hunts">${esc(savedDesc)}</textarea>`;
      h += '</div>';
      h += '</div>'; // dt-feed-card-wrap

      // dt-form.22: ROTE block removed from the feeding section. ROTE is now
      // a personal-project-action variant (see PROJECT_ACTIONS in
      // downtime-data.js). The legacy `_feed_rote_*` state is migrated on
      // the next save in collectResponses; territory continues to write to
      // the document-level `feeding_territories_rote` map for ambience
      // resolution by the Vitae Projection container below.

      // ── Container 3: Vitae Projection ──
      {
        const allResp = responseDoc?.responses || {};
        const vitaeMax = calcVitaeMax(c);

        // Monthly costs
        // Ghoul Retainer: 1 vitae per ghoul retainer merit (not per dot)
        const ghoulCost = (c.merits || [])
          .filter(m => m.name === 'Retainer' && (m.ghoul || m.type === 'ghoul'))
          .length;
        // Cruac Rites: 1 vitae for level 1-3, 2 vitae for level 4-5.
        // Mandragora 3: parked rites (sorcery_N_mandragora === 'yes') are
        // sustained by the garden and cost no vitae for this casting — skip
        // their cost from the projection.
        const rites = (c.powers || []).filter(p => p.category === 'rite');
        const sorcCount = parseInt(allResp['sorcery_slot_count'] || '1', 10);
        let riteVitaeCost = 0;
        for (let sn = 1; sn <= sorcCount; sn++) {
          const riteName = allResp[`sorcery_${sn}_rite`];
          if (!riteName) continue;
          if (allResp[`sorcery_${sn}_mandragora`] === 'yes') continue;
          const rite = rites.find(r => r.name === riteName);
          if (rite) riteVitaeCost += riteCost(rite).vitae;
        }
        // Mandragora Garden — effective dots across all bonus channels
        const mandDots = effectiveDomainDots(c, 'Mandragora Garden');
        // Each effective dot produces 1 Blood Fruit (worth 2 vitae if consumed; not on the vitae track)
        const bloodFruit = mandDots;
        // Herd: TM errata — 1 vitae per effective dot per month, all bonus channels included.
        const herdDots = effectiveDomainDots(c, 'Herd');
        // Oath of Fealty: stored as a power (category 'pact'), not a merit.
        // +vitae equal to effective Invictus Status when present.
        //
        // Effective Invictus Status = max(stored covenant status, OTS floor).
        // OTS (Oath of the Scapegoat) provides a covenant-status floor equal to
        // its dot rating, which lets characters whose stored status is otherwise
        // depressed (negative reputation in fiction) still benefit mechanically.
        // We compute the OTS floor inline as a fallback in case the cached
        // c._ots_covenant_bonus hasn't been refreshed for this character.
        const otsPact = (c.powers || []).find(p =>
          p.category === 'pact' && (p.name || '').toLowerCase() === 'oath of the scapegoat'
        );
        const otsFloor = Math.max(
          c._ots_covenant_bonus || 0,
          otsPact ? ((otsPact.cp || 0) + (otsPact.xp || 0)) : 0
        );
        const hasOathOfFealty = (c.powers || []).some(p =>
          p.category === 'pact' && (p.name || '').toLowerCase() === 'oath of fealty'
        );
        const invStatusForOath = Math.max(c.status?.covenant?.['Invictus'] || 0, otsFloor);
        const oathBonus = hasOathOfFealty ? invStatusForOath : 0;

        // Resolve ambienceMod from a territory grid — returns {mod, label} or null
        const resolveTerrAmbience = (gridJson) => {
          let grid = {};
          try { grid = JSON.parse(gridJson || '{}'); } catch { /* ignore */ }
          const key = Object.keys(grid).find(k =>
            grid[k] === 'feeding_rights' || grid[k] === 'poaching' ||
            grid[k] === 'resident' || grid[k] === 'poacher' || grid[k] === 'barrens'
          );
          if (!key) return null;
          if (grid[key] === 'barrens') return { mod: -4, label: 'Barrens (The Barrens)' };
          const tDoc = (_territories || []).find(t => String(t._id) === key);
          const name = tDoc?.name;
          if (!name) return null;
          const td = TERRITORY_DATA.find(t => t.name === name);
          if (!td) return null;
          return { mod: td.ambienceMod || 0, label: `${td.ambience} (${name})` };
        };

        // dt-form.22: rote-active is derived from the new project-action
        // shape — any slot whose action is 'rote' counts. Replaces the
        // legacy module-scoped `feedRoteAction` flag.
        const _hasRoteSlot = [1, 2, 3, 4].some(n => allResp[`project_${n}_action`] === 'rote');
        const mainAmb = resolveTerrAmbience(allResp['feeding_territories']);
        const roteAmb = _hasRoteSlot ? resolveTerrAmbience(allResp['feeding_territories_rote']) : null;

        // Best of the two territories (highest mod wins)
        let bestAmb = null;
        if (mainAmb !== null && roteAmb !== null) {
          const useRote = roteAmb.mod > mainAmb.mod;
          bestAmb = { ...(useRote ? roteAmb : mainAmb), fromRote: useRote };
        } else {
          bestAmb = mainAmb ?? roteAmb ?? null;
        }

        // Compute main hunt dice pool (used for average vitae yield)
        let mainPool = 0;
        if (feedCustomAttr) mainPool += getAttrEffective(c, feedCustomAttr);
        if (feedCustomSkill) mainPool += skTotal(c, feedCustomSkill);
        if (feedDiscName) mainPool += discDots(c, feedDiscName);
        const fgVal = effectiveDomainDots(c, 'Feeding Grounds');
        mainPool += fgVal;
        if (feedSpecName) mainPool += hasAoE(c, feedSpecName) ? 2 : 1;
        // Average vitae: base = floor(2N/3); rote = floor(5N/6) (max of two rolls)
        const avgGathered = _hasRoteSlot
          ? Math.floor((mainPool * 5) / 6)
          : Math.floor((mainPool * 2) / 3);

        // Group mods into positives and negatives
        const posMods = [];
        const negMods = [];
        if (bestAmb !== null) {
          const fromNote = bestAmb.fromRote ? ' (rote territory)' : '';
          const lbl = `Ambience: ${bestAmb.label}${fromNote}`;
          if (bestAmb.mod >= 0) posMods.push({ label: lbl, val: bestAmb.mod });
          else negMods.push({ label: lbl, val: bestAmb.mod });
        }
        // #609: effectiveDomainDots('Herd') (via meritEffectiveRating, domain.js:265)
        // ALREADY includes the SSJ and Flock bonuses, so herdDots is the true total and
        // matches the ST (domMeritContrib). #599 erroneously re-added flock here, which
        // double-counted it (Flock chars showed +8 not +5); do NOT add ssj/flock to the
        // total. flockHerd is used only for the "(Flock)" label + "(+x)" breakdown.
        const flockHerd = flockHerdBonus(c);
        const herdTotal = herdDots;
        if (herdTotal > 0) {
          posMods.push({
            label: flockHerd > 0 ? 'Herd (Flock)' : `Herd (${'●'.repeat(herdDots)})`,
            val: herdTotal,
            valSuffix: flockHerd > 0 ? ` (+${flockHerd})` : '',
          });
        }
        if (oathBonus > 0) posMods.push({ label: `Oath of Fealty (Invictus Status ${invStatusForOath})`, val: oathBonus });
        if (ghoulCost > 0) negMods.push({ label: 'Ghoul Retainers', val: -ghoulCost });
        if (riteVitaeCost > 0) negMods.push({ label: 'Cruac Rites', val: -riteVitaeCost });
        if (mandDots > 0) negMods.push({ label: `Mandragora Garden (${'●'.repeat(mandDots)})`, val: -mandDots });

        const netStarting = posMods.reduce((s, m) => s + m.val, 0) + negMods.reduce((s, m) => s + m.val, 0);
        const projected = Math.max(0, Math.min(vitaeMax, netStarting + avgGathered));

        h += '<div class="dt-vitae-budget">';
        h += '<div class="dt-vitae-budget-title">Vitae Projection</div>';
        h += '<div class="dt-vitae-row"><span>Starting Vitae</span><span>0</span></div>';
        for (const mod of posMods) {
          h += `<div class="dt-vitae-row dt-vitae-pos"><span>${esc(mod.label)}</span><span>+${mod.val}${esc(mod.valSuffix || '')}</span></div>`;
        }
        for (const mod of negMods) {
          h += `<div class="dt-vitae-row dt-vitae-cost"><span>${esc(mod.label)}</span><span>−${Math.abs(mod.val)}</span></div>`;
        }
        const netSign = netStarting >= 0 ? '+' : '−';
        h += `<div class="dt-vitae-row dt-vitae-subtotal"><span>Net starting Vitae</span><span>${netSign}${Math.abs(netStarting)}</span></div>`;
        if (mainPool > 0) {
          const yieldLabel = _hasRoteSlot ? 'Projected average gathered (rote)' : 'Projected average gathered';
          h += `<div class="dt-vitae-row dt-vitae-pos"><span>${yieldLabel}</span><span>+${avgGathered}</span></div>`;
        } else {
          h += '<div class="dt-vitae-row dt-vitae-note"><span style="font-style:italic;color:var(--txt3)">Build your hunt pool above to see expected yield.</span><span></span></div>';
        }
        h += `<div class="dt-vitae-row dt-vitae-total"><span>Projected Vitae after feeding</span><span class="${projected === 0 ? 'dt-vitae-over' : ''}">${projected} / ${vitaeMax}</span></div>`;
        if (bloodFruit > 0) h += `<div class="dt-vitae-row dt-vitae-note"><span>Blood Fruit produced (worth 2 vitae each if consumed)</span><span>${bloodFruit}</span></div>`;
        h += '</div>';
      }

      break;
    }

    case 'aspiration_slots': {
      const saved = responseDoc?.responses || {};
      h += '<div class="dt-aspiration-slots">';
      for (let n = 1; n <= 3; n++) {
        const savedType = saved[`aspiration_${n}_type`] || '';
        const savedText = saved[`aspiration_${n}_text`] || '';
        h += '<div class="dt-aspiration-slot">';
        h += `<select id="dt-aspiration_${n}_type" class="qf-select dt-aspiration-type">`;
        h += '<option value="">\u2014 Type \u2014</option>';
        for (const t of ['Short', 'Medium', 'Long']) {
          h += `<option value="${t}"${savedType === t ? ' selected' : ''}>${t}</option>`;
        }
        h += '</select>';
        h += `<input type="text" id="dt-aspiration_${n}_text" class="qf-input dt-aspiration-text" value="${esc(savedText)}" placeholder="Aspiration ${n}">`;
        h += '</div>';
      }
      h += '</div>';
      break;
    }

    case 'highlight_slots': {
      // DTR.1: 3 fields minimum, expanding to 4 and 5 as each is filled.
      // Legacy game_recount (single blob) imports into slot 1 on first load
      // if no numbered slots exist yet — player can then redistribute.
      const saved = responseDoc?.responses || {};
      const legacy = saved['game_recount'];
      const slotVals = [];
      for (let n = 1; n <= 5; n++) slotVals.push(saved[`game_recount_${n}`] || '');
      if (legacy && !slotVals.some(v => v)) slotVals[0] = legacy;

      // Visible count: always >=3; reveal 4 if slot 3 has text; reveal 5 if slot 4 has text.
      let visibleCount = 3;
      for (let n = 4; n <= 5; n++) {
        if (slotVals[n - 2].trim() || slotVals[n - 1].trim()) visibleCount = Math.max(visibleCount, n);
      }

      h += '<div class="dt-highlight-slots" data-highlight-root>';
      for (let n = 1; n <= 5; n++) {
        const hidden = n > visibleCount ? ' style="display:none"' : '';
        const flagChecked = saved[`mechanical_flag_${n}`] === true;
        h += `<div class="dt-highlight-slot" data-highlight-n="${n}"${hidden}>`;
        h += `<label class="qf-label">Highlight ${n}${n > 3 ? ' (optional)' : ''}</label>`;
        h += `<textarea id="dt-game_recount_${n}" class="qf-textarea dt-highlight-input" data-highlight-n="${n}" rows="2" placeholder="One highlight…">${esc(slotVals[n - 1])}</textarea>`;
        // DTFP-7: per-slot mechanical-flag checkbox
        h += `<label class="dt-highlight-flag">`;
        h += `<input type="checkbox" id="dt-mechanical_flag_${n}" data-mechanical-flag-n="${n}"${flagChecked ? ' checked' : ''}>`;
        h += `<span class="dt-highlight-flag-text">This involved a mechanical effect on another character or the world (flags this for your ST).</span>`;
        h += `</label>`;
        h += '</div>';
      }
      h += '</div>';
      break;
    }

    case 'xp_grid': {
      // Parse saved XP spend rows: JSON array of { category, item, cost }
      let xpRows = [];
      if (value) {
        try { xpRows = JSON.parse(value); } catch { /* ignore */ }
      }
      // Ensure at least one empty row
      if (!xpRows.length || xpRows[xpRows.length - 1].category) {
        xpRows.push({ category: '', item: '', cost: 0 });
      }

      // Count XP Spend project actions → dot budget for non-merit purchases
      const saved = responseDoc?.responses || {};
      let xpActions = 0;
      for (let n = 1; n <= 4; n++) {
        if (saved[`project_${n}_action`] === 'xp_spend') xpActions++;
      }

      // ── Project XP Commitments (read-only carry-forward) ──
      const projCommits = [];
      for (let n = 1; n <= 4; n++) {
        if (saved[`project_${n}_action`] !== 'xp_spend') continue;
        const cat  = saved[`project_${n}_xp_category`] || '';
        const item = saved[`project_${n}_xp_item`] || '';
        if (!cat || !item) { projCommits.push({ n, cat: '', item: '', cost: 0, label: '(not yet selected)' }); continue; }
        const cost = getRowCost({ category: cat, item, dotsBuying: 1 });
        const catLabel = XP_CATEGORIES.find(o => o.value === cat)?.label || cat;
        const itemLabel = getItemsForCategory(cat).find(i => i.value === item)?.label || item;
        projCommits.push({ n, cat, item, cost, label: `${catLabel} \u2014 ${itemLabel}` });
      }

      // Count dots already allocated to non-merit categories
      let dotsUsed = 0;
      for (const r of xpRows) {
        if (!r.category || !r.item) continue;
        if (r.category === 'merit') continue; // merits 1-3 are free
        if (r.category === 'devotion') {
          dotsUsed++; // devotions count as 1 action each
        } else {
          dotsUsed += (r.dotsBuying || 1);
        }
      }
      const dotsRemaining = xpActions - dotsUsed;

      const budget = xpLeft(currentChar);
      const projCommitCost = projCommits.reduce((s, p) => s + p.cost, 0);
      const totalSpent = xpRows.reduce((sum, r) => sum + getRowCost(r), 0) + projCommitCost;
      const remaining = budget - totalSpent;

      h += `<div class="dt-xp-grid" id="dt-${q.key}">`;
      h += `<div class="dt-xp-budget" id="dt-xp-budget">`;
      h += `<span class="dt-influence-remaining${remaining < 0 ? ' dt-influence-over' : ''}">${remaining}</span>`;
      h += ` / ${budget} XP remaining`;
      h += '</div>';

      // ── Project XP Commitments (read-only) ──
      if (projCommits.length) {
        h += '<div class="dt-xp-proj-commits">';
        h += '<div class="dt-xp-proj-commits-title">Project XP Commitments</div>';
        for (const p of projCommits) {
          h += `<div class="dt-xp-proj-row">`;
          h += `<span class="dt-xp-proj-num">Action ${p.n}</span>`;
          h += `<span class="dt-xp-proj-label">${esc(p.label)}</span>`;
          h += p.cost > 0 ? `<span class="dt-xp-cost">${p.cost} XP</span>` : '';
          h += '</div>';
        }
        h += '</div>';
      }

      // Action budget indicator
      h += '<div class="dt-xp-action-budget">';
      if (xpActions > 0) {
        h += `<span class="dt-xp-action-count">${xpActions} XP Spend action${xpActions > 1 ? 's' : ''}</span>`;
        h += ` \u2014 <span class="${dotsRemaining < 0 ? 'dt-influence-over' : ''}">${dotsRemaining} dot${dotsRemaining !== 1 ? 's' : ''} remaining</span>`;
      } else {
        h += '<span class="dt-xp-action-none">No XP Spend actions allocated \u2014 only Merits (1\u20133 dots) available</span>';
      }
      h += '</div>';

      for (let i = 0; i < xpRows.length; i++) {
        h += renderXpRow(i, xpRows[i], xpActions, dotsRemaining);
      }
      h += '</div>';
      break;
    }

    case 'influence_grid': {
      // Parse saved value: JSON object { territory_key: number } or empty
      let infVals = {};
      if (value) {
        try { infVals = JSON.parse(value); } catch { /* ignore */ }
      }
      const budget = getInfluenceBudget();
      // Calculate total spent (absolute values)
      let totalSpent = 0;
      for (const terr of INFLUENCE_TERRITORIES) {
        const tk = terr.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        // 496.2: tolerant read across OID (new) and legacy-slug keys
        totalSpent += Math.abs(_terrGridVal(infVals, terr, tk) || 0);
      }
      const remaining = budget - totalSpent;

      const infBreakdown = influenceBreakdown(currentChar);
      const infTitle = infBreakdown.length ? infBreakdown.join('\n') : 'No influence sources';
      h += `<div class="dt-influence-grid" id="dt-${q.key}">`;
      h += `<div class="dt-influence-budget" id="dt-influence-budget">`;
      h += `<span class="dt-influence-remaining${remaining < 0 ? ' dt-influence-over' : ''}">${remaining}</span>`;
      h += ` / <span class="dt-influence-budget-label" title="${esc(infTitle)}">${budget} Influence remaining</span>`;
      h += '</div>';

      for (const terr of INFLUENCE_TERRITORIES) {
        const tk = terr.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        // 496.2: tolerant read across OID (new) and legacy-slug keys
        const val = _terrGridVal(infVals, terr, tk) || 0;
        // DTFP-1: both label slots always present so the stepper column stays
        // vertically aligned across rows; text content is value-driven.
        const leftText  = val < 0 ? 'decreasing ambience' : '';
        const rightText = val > 0 ? 'increasing ambience' : '';
        const minusDis  = val <= 0 && remaining <= 0 ? ' disabled' : '';
        const plusDis   = val >= 0 && remaining <= 0 ? ' disabled' : '';
        h += '<div class="dt-influence-row">';
        h += `<span class="dt-influence-terr">${esc(terr)}</span>`;
        h += '<span class="dt-influence-control">';
        h += `<span class="dt-influence-label dt-influence-label-left">${leftText}</span>`;
        h += `<button type="button" class="dt-inf-btn"${minusDis} data-inf-terr="${tk}" data-inf-dir="-1">−</button>`;
        h += `<span class="dt-inf-val" id="inf-val-${tk}">${val}</span>`;
        h += `<button type="button" class="dt-inf-btn"${plusDis} data-inf-terr="${tk}" data-inf-dir="1">+</button>`;
        h += `<span class="dt-influence-label dt-influence-label-right">${rightText}</span>`;
        h += '</span>';
        h += '</div>';
      }
      h += '</div>';
      break;
    }

    case 'territory_grid': {
      let gridVals = {};
      if (value) { try { gridVals = JSON.parse(value); } catch { /* ignore */ } }
      h += '<p class="qf-desc">Ambience shown is current. Actual feeding ambience is calculated after Downtime processing and may shift based on how many Kindred feed in each territory.</p>';
      h += `<div id="dt-${q.key}">`;
      h += renderFeedingTerritoryPills(gridVals);
      h += '</div>';
      break;
    }
  }

  h += '</div>';
  return h;
}
