/**
 * Downtime domain views — admin app.
 * CSV upload, cycle management, submission overview, character bridge, feeding rolls.
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../data/api.js';
// #751: writes state.activeCycleNum when the active cycle resolves so the
// editor's Add Equipment / Add Asset rows pre-fill acquired_cycle correctly.
import state from '../data/state.js';
import { parseDowntimeCSV } from '../downtime/parser.js';
import { getCycles, getActiveCycle, createCycle, updateCycle, closeCycle, openGamePhase, getSubmissionsForCycle, upsertCycle, updateSubmission, mapRawToResponses, signoffPhase, setManualOpen, isInGamePhase, zeroSubmissionFlipWarning, zeroSubmissionFlipMessage, cycleFeedsLabel, DTUX_PHASES } from '../downtime/db.js';
import { TERRITORY_DATA, AMBIENCE_FEEDING_TOLERANCE, AMBIENCE_ENTROPY, AMBIENCE_THRESHOLDS, AMBIENCE_MODS, FEEDING_TERRITORIES, FEED_METHODS as FEED_METHODS_DATA, MAINTENANCE_MERITS, normaliseSorceryTargets } from '../tabs/downtime-data.js';
import { rollPool, showRollModal, parseDiceString } from '../downtime/roller.js';
import { getAttrEffective as getAttrVal, getSkillObj, skDots, skTotal, skNineAgain, skSpecs, riteCost, skillAcqPoolStr } from '../data/accessors.js';
import { displayName, dropdownName, sortName, hasAoE, isSpecs } from '../data/helpers.js';
import { calcTotalInfluence, domMeritContrib, ssjHerdBonus, flockHerdBonus, effectiveInvictusStatus, meritEffectiveRating } from '../editor/domain.js';
import { applyDerivedMerits } from '../editor/mci.js';
import { SKILLS_MENTAL, ALL_ATTRS, ALL_SKILLS, SKILL_CATS } from '../data/constants.js';
import { getUser } from '../auth/discord.js';
import { ACTION_TYPE_LABELS as _ACTION_TYPE_LABELS_BASE, MERIT_MATRIX, INVESTIGATION_MATRIX, TERRITORY_SLUG_MAP as _TERRITORY_SLUG_MAP_BASE, AMBIENCE_STEPS as _AMBIENCE_STEPS_BASE, POOL_STATUS_LABELS } from './downtime-constants.js';
import { publishAllForCycle } from './downtime-story.js';
// ECM-4 (#871): resolve catalogue_id → display name via the shared cache
// when rendering the DT processing UI. Legacy free-text `equipment_${n}_name`
// values from pre-ECM-4 submissions still render as a fallback per Khepri's
// backcompat guidance — see the read site below in the Equipment block.
import { getCatalogueEntry } from '../data/equipment-catalogue-cache.js';

// Convert UTC ISO string to datetime-local input value (local time)
function isoToLocalInput(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let submissions = [];
let characters = [];

/** Build a pool snapshot at DT resolution time per ADR-004 Rev 3 §D10 (STM-8 / issue #415).
 *  Captures the character's active overlay state alongside the resolved
 *  pool total so the historical record survives later mod revocation.
 *
 *  Always-write convention: when the character has no overlay (no mods
 *  active), returns { base: finalPool, mods: [], final: finalPool } so
 *  downstream consumers see a consistent shape. Math invariant
 *  (enforced server-side): final === base + Σ mods[].delta — computed
 *  from finalPool − Σ delta so the invariant always holds by construction.
 *
 *  Note on scope: captures ALL active mods on the character at resolution,
 *  not action-aware filtering. Per STM-8 §scope the snapshot is a historical
 *  record of mod state, not just the contributing subset. A future story
 *  could refine to per-stat-path filtering if ST debugging surfaces a need. */
function buildPoolSnapshot(c, finalPool) {
  const total = Number.isFinite(finalPool) ? finalPool : 0;
  const overlay = c?._st_mod_overlay || {};
  const mods = [];
  for (const entry of Object.values(overlay)) {
    if (!entry || !Array.isArray(entry.mods)) continue;
    for (const m of entry.mods) {
      if (!m || !Number.isInteger(m.delta) || !m.stat_path) continue;
      mods.push({ stat_path: m.stat_path, delta: m.delta, reason: m.reason || '' });
    }
  }
  const sumDelta = mods.reduce((s, m) => s + m.delta, 0);
  return { base: total - sumDelta, mods, final: total };
}

/** Resolve the active character for a submission, returning null if not in
 *  the loaded characters array. */
function _charForSub(sub) {
  if (!sub?.character_id) return null;
  return characters.find(c => String(c._id) === String(sub.character_id)) || null;
}
let charMap = new Map();
let allCycles = [];
let activeCycle = null;
let currentCycle = null;
let selectedCycleId = null;
const procExpandedKeys = new Set(); // tracks which action rows are expanded in processing mode
let _procFilters = { statuses: new Set(), chars: new Set(), phases: new Set(), territories: new Set(), sources: new Set() };
let cycleReminders = [];       // processing_reminders from the current cycle document
let _sorcByTarget = new Map(); // built in renderProcessingMode; maps lowercased charName → [{entry, riteName, tradition, resultNote}]
let _mgPriorSubCache = new Map(); // keyed by prior cycle_id → array of submissions; cleared on each renderProcessingMode
let cachedTerritories = null;  // territories from DB (for ambience dashboard); null = not yet loaded
let _procQueueMap = null;      // Map<key, entry> built once per renderProcessingMode call; null outside render
let _procCtxMap   = null;      // Map<key, ctxObj> built once per renderProcessingMode call; proto.8-13 populate ctxObj
let _xrefIndex = new Map();   // cross-reference index built once per renderProcessingMode call
let discDashCollapsed = true;  // collapse state for the Discipline Profile Matrix panel
let matrixCollapsed = true;    // collapse state for the Feeding Matrix section in the dashboard
let ovAmbienceCollapsed = true; // City Overview: ambience section collapse state
let ovSpheresCollapsed = true;  // City Overview: spheres section collapse state
const expandedPhases = new Set(); // phaseKeys currently expanded in Processing Mode (empty = all collapsed)
const narrativeExpanded = new Set(); // subIds with narrative body expanded in processing mode
const xpReviewExpanded  = new Set(); // subIds with XP review body expanded in processing mode
const signOffExpanded   = new Set(); // subIds with sign-off body expanded in processing mode
const stActionAddExpandedSubs = new Set(); // subIds with "Add ST Action" form expanded

// ── Processing Mode constants ────────────────────────────────────────────────

// JDT-5: named phaseNum constants supplement existing magic numbers below.
// Use these in new code; existing `phaseNum: 1`-style literals can be migrated
// opportunistically.
const PHASE_TRAVEL        = -1;
const PHASE_RESOLVE_FIRST = 0;
const PHASE_FEEDING       = 1;
const PHASE_SUPPORT       = 4;
const PHASE_AMBIENCE      = 5;
const PHASE_HIDE_PROTECT  = 6;
const PHASE_INVESTIGATE   = 7;
const PHASE_ATTACK        = 8;
const PHASE_PATROL        = 9;
const PHASE_MISC          = 10;
const PHASE_CONTACTS      = 11;
const PHASE_ACQUISITION   = 12;
const PHASE_JOINT         = 13;

const PHASE_ORDER = {
  resolve_first: 0,
  feeding: 1,
  feed: 1,
  support: 4,
  ambience_increase: 5, ambience_decrease: 5, ambience_change: 5,
  hide_protect: 6,
  investigate: 7,
  attack: 8,
  patrol_scout: 9,
  misc: 10, xp_spend: 10, maintenance: 10, block: 10, rumour: 10, grow: 10,
  resources_retainers: 10,
  acquisition: 12,
};

const PHASE_LABELS = {
  travel: '1: Travel',
  resolve_first: '2: Rituals',
  feeding: '3: Feeding',
  support: '4: Support',
  ambience: '5: Ambience',
  ambience_change: '5: Ambience',
  hide_protect: '6: Defence',
  investigate: '7: Investigate',
  attack: '8: Attack',
  patrol: '9: Patrol',
  misc: '10: Miscellaneous',
  contacts: '11: Contacts',
  acquisition: '12: Acquisitions',
  joint: '13: Joint Projects',
};

// Maps phase numeric key back to display label key
const PHASE_NUM_TO_LABEL = {
  0:   'resolve_first',
  1:   'feeding',
  4:   'support',
  5:   'ambience',
  6:   'hide_protect',
  7:   'investigate',
  8:   'attack',
  9:   'patrol',
  10:  'misc',
  11:  'contacts',
  12:  'acquisition',
  13:  'joint',
};

// Maps simplified ST-created action category to phase number
const ST_ACTION_PHASE_MAP = {
  sorcery: 0,   // resolve_first
  project: 10,  // misc
  merit:   10,  // misc (category/actionType determines actual phase for merit entries)
};

// 'feed' relabelled 'Rote Feed' in processing view to distinguish from the feeding phase
const ACTION_TYPE_LABELS = { ..._ACTION_TYPE_LABELS_BASE, feed: 'Rote Feed' };

const ALL_ACTION_TYPES = [
  'ambience_change', 'feed', 'attack', 'hide_protect',
  'investigate', 'patrol_scout', 'support', 'misc', 'maintenance', 'xp_spend',
  'block', 'rumour', 'grow', 'acquisition',
];

// Issue #129 (2026-05-08): canonical ambience action dispatcher.
// The DT form (post-#79) persists `project_${n}_action === 'ambience_change'`
// + `responses.project_${n}_ambience_direction` ('improve' | 'degrade').
// Legacy CSV-imported submissions in the DB carry `'ambience_increase'` /
// `'ambience_decrease'` (pre-canonicalisation parser output). Both shapes
// must dispatch correctly here. The helper accepts any of the three action
// type strings; direction is derived from the type itself for legacy or
// from the responses bag for canonical.
const _AMBIENCE_ACTION_TYPES = new Set(['ambience_change', 'ambience_increase', 'ambience_decrease']);

const _DISCIPLINE_TERRITORIAL_EFFECTS = {
  Animalism:  'Feral edge, heightened animal activity, lower inhibitions, territoriality',
  Auspex:     'Feeling of being watched, paranoia, superstition, ghost sightings, out of body experiences',
  Dominate:   'Forgetfulness, complacency, compliance, passivity, docility, confusion, rigidity',
  Majesty:    'Salacious activity, lasciviousness, obsessive behaviour, stalking, adultery, jealousy, heightened passions',
  Nightmare:  'Fear, dread, paranoia, nightmares, delusions, insomnia, restlessness',
  Obfuscate:  'Long shadows, things seen in peripheral vision, losing things, getting lost, disconnectedness, isolation, quietude, false identity, loneliness, vagrancy',
  Protean:    'Desire for body modification, dysphoria, outlandishness, provocative fashion, counter-cultural, hyper fitness, dysmorphia, rebelliousness',
  Cruac:      'Dionysian excess, wantonness, rebelliousness, corruption, primal energy, ecstasis, frenzy, debauchery',
  Theban:     'Judgmental atmosphere, righteousness, prideful piety, rapture, guilt, sternness, rigidity, certitude',
};
function _isAmbienceAction(actionType) {
  return _AMBIENCE_ACTION_TYPES.has(actionType);
}
function _ambienceDirection(actionType, projN, responses) {
  if (actionType === 'ambience_increase') return 'increase';
  if (actionType === 'ambience_decrease') return 'decrease';
  if (actionType === 'ambience_change' && responses) {
    const dir = responses[`project_${projN}_ambience_direction`]
      || responses[`project_${projN}_ambience_dir`]
      || '';
    if (dir === 'improve' || dir === 'up') return 'increase';
    if (dir === 'degrade' || dir === 'down') return 'decrease';
  }
  return null;
}

const FEED_METHOD_LABELS_MAP = {
  seduction: 'Seduction', stalking: 'Stalking', force: 'By Force',
  familiar: 'Familiar Face', intimidation: 'Intimidation', other: 'Other',
};

// Discipline names to detect in validated pool expressions for discipline × territory recording
const KNOWN_DISCIPLINES = [
  'Animalism', 'Auspex', 'Celerity', 'Dominate', 'Majesty', 'Nightmare',
  'Obfuscate', 'Resilience', 'Vigor', 'Vigour', 'Protean', 'Cruac', 'Theban',
];

// MERIT_MATRIX and INVESTIGATION_MATRIX imported from downtime-constants.js

/**
 * Parse merit_type strings in any of these formats:
 *   "Allies 3 (Finance)"       — digit dot count, qualifier in parens
 *   "Allies (Media) ***"       — qualifier in parens, asterisk dot count after
 *   "Allies *** (Media)"       — asterisk dot count, qualifier in parens after
 *   "Allies (Media) ●●●"       — filled-circle dot count
 *   "Allies (Media)"           — qualifier only, no dot count
 * Returns { category, label, dots, qualifier }
 */
function _parseMeritType(str) {
  if (!str) return { category: 'misc', label: '—', dots: null, qualifier: '' };

  // Extract qualifier from first parenthesised group
  const qualMatch = str.match(/\(([^)]+)\)/);
  const qualifier = qualMatch ? qualMatch[1].trim() : '';

  // Strip qualifier parens, then find dot count (digit, run of *, or run of ●)
  const stripped = str.replace(/\s*\([^)]*\)/g, '').trim();
  const dotsMatch = stripped.match(/(\d+)|(\*+)|(●+)/);
  let dots = null;
  if (dotsMatch) {
    if (dotsMatch[1]) dots = parseInt(dotsMatch[1], 10);
    else              dots = (dotsMatch[2] || dotsMatch[3]).length;
  }

  // Label is the leading alphabetic/space portion before any digit or symbol run
  const label = (stripped.replace(/\s*[\d*●].*$/, '').trim()) || stripped;

  const categoryRaw = label.toLowerCase();
  let category;
  if (/allies/.test(categoryRaw))                   category = 'allies';
  else if (/status/.test(categoryRaw))              category = 'status';
  else if (/mystery cult initiate/.test(categoryRaw)) category = 'status';  // #233 — MCI grouped with Status
  else if (/retainer/.test(categoryRaw))            category = 'retainer';
  else if (/staff/.test(categoryRaw))               category = 'staff';
  else if (/contacts?/.test(categoryRaw))           category = 'contacts';
  else                                              category = 'misc';

  return { category, label, dots, qualifier };
}

/** Compute dice pool size for a merit category + dots level. Returns null for non-rolled merits. */
function _computeMeritPoolSize(category, dots) {
  if (category === 'allies' || category === 'status' || category === 'retainer') {
    return dots != null ? (dots * 2) + 2 : null;
  }
  return null; // staff = fixed; contacts = char pool (not auto-computed)
}

// POOL_STATUS_LABELS imported from downtime-constants.js

// Statuses considered fully resolved (used for phase counts and hide-done filter)
const DONE_STATUSES = new Set(['validated', 'no_roll', 'no_feed', 'maintenance', 'resolved', 'no_effect', 'skipped', 'obvious', 'neutral', 'subtle']);

/** Format a signed integer as '+N', '−N', or '±0'. */
function _fmtMod(val) {
  if (val === 0) return '\u00B10';
  return val > 0 ? `+${val}` : String(val);
}

/** Returns a stable action_key string for reminder targeting. Returns null for sorcery entries. */
function entryActionKey(entry) {
  if (entry.source === 'feeding') return 'feeding';
  if (entry.source === 'project') return `project_${entry.actionIdx}`;
  if (entry.source === 'merit')   return `merit_${entry.actionIdx}`;
  return null; // sorcery entries are sources, not targets
}

// ── DTUX-1: clickable phase-tab nav with sign-off badges ──────────────────── Replaces the previous
// read-only ribbon, the sub-tab strip, and the "Open City & Feeding Phase \u2192"
// gate button. cycle.status is auto-derived from cycle.phase_signoff by
// signoffPhase() in db.js \u2014 these helpers are display-only.

const DTUX_TAB_LABELS = {
  prep: 'DT Prep', city: 'DT City', projects: 'DT Projects',
  story: 'DT Story', ready: 'DT Ready',
};

const DTUX_TAB_TO_PANEL = {
  prep: 'dt-prep-panel',
  city: 'dt-city-panel',
  projects: 'dt-processing-panel',
  story: 'dt-story-panel',
  ready: 'dt-ready-panel',
};

let _dtuxActiveTab = null; // session-only; null until first cycle load

function _initialDtuxTab(cycle) {
  if (_dtuxActiveTab && DTUX_TAB_TO_PANEL[_dtuxActiveTab]) return _dtuxActiveTab;
  const ps = cycle?.phase_signoff || {};
  const hasSignoff = Object.keys(ps).length > 0;
  if (hasSignoff) {
    for (const p of DTUX_PHASES) if (!ps[p]) return p;
    return 'ready';
  }
  // Legacy cycle without phase_signoff: pick from existing status field.
  switch (cycle?.status) {
    case 'prep':     return 'prep';
    case 'game':     return 'city';
    case 'active':   return 'projects';
    case 'closed':   return 'story';
    case 'complete': return 'ready';
    default:         return 'prep';
  }
}

function renderPhaseRibbon(cycle, _subs) {
  const mainEl = document.getElementById('dt-phase-ribbon');
  const subEl  = document.getElementById('dt-sub-ribbon');
  if (!mainEl) return;
  // Sub-ribbon retired by DTUX-1; hide while the markup remains in admin.html.
  if (subEl) subEl.style.display = 'none';

  if (!cycle) {
    mainEl.style.display = 'none';
    return;
  }

  if (!_dtuxActiveTab) _dtuxActiveTab = _initialDtuxTab(cycle);

  const ps = cycle.phase_signoff || {};
  mainEl.style.display = '';
  mainEl.classList.add('dt-phase-ribbon-tabs');
  mainEl.innerHTML = DTUX_PHASES.map(phase => {
    const signed = !!ps[phase];
    const active = phase === _dtuxActiveTab;
    const cls = ['pr-tab', active ? 'pr-tab-active' : '', signed ? 'pr-tab-signed' : '']
      .filter(Boolean).join(' ');
    const badge = signed
      ? '<span class="pr-tab-badge pr-tab-badge-signed">\u2713</span>'
      : '<span class="pr-tab-badge pr-tab-badge-empty">\u25cb</span>';
    return `<button type="button" class="${cls}" data-phase="${phase}">${badge}<span class="pr-tab-label">${DTUX_TAB_LABELS[phase]}</span></button>`;
  }).join('');
}

function showDtuxPhase(phase) {
  if (!DTUX_TAB_TO_PANEL[phase]) phase = 'prep';
  _dtuxActiveTab = phase;
  for (const p of DTUX_PHASES) {
    const el = document.getElementById(DTUX_TAB_TO_PANEL[p]);
    if (el) el.style.display = (p === phase) ? '' : 'none';
  }
  document.querySelectorAll('#dt-phase-ribbon .pr-tab').forEach(btn => {
    btn.classList.toggle('pr-tab-active', btn.dataset.phase === phase);
  });
  // Show city export button only on the city tab
  const cityExportBtn = document.getElementById('dt-city-export-btn');
  if (cityExportBtn) cityExportBtn.style.display = phase === 'city' ? '' : 'none';

  // Lazy-init city/story tabs the first time they're shown.
  if (phase === 'city' && !_dtuxCityInited) { _dtuxCityInited = true; renderCityOverview(); }
  if (phase === 'story' && !_dtuxStoryInited) { _dtuxStoryInited = true; _initDtStoryFromRibbon(); }
}

let _dtuxCityInited = false;
let _dtuxStoryInited = false;
let _cityMatrix = null;

async function _initDtStoryFromRibbon() {
  // Lazily import to avoid a circular dep \u2014 DT Story reads characters via API
  // anyway, so the module-state coupling is fine.
  // Issue #321: pass the dropdown's current cycle so DT Story shows the cycle
  // the ST is actually viewing, not whatever the internal resolver picks.
  const { initDtStory } = await import('./downtime-story.js');
  initDtStory(currentCycle?._id || null);
}

async function _handleSignoffClick(btn) {
  if (!currentCycle) return;
  const phase = btn.dataset.signoffPhase;
  if (!phase || !DTUX_PHASES.includes(phase)) return;
  const turningOn = !(currentCycle.phase_signoff || {})[phase];
  const userId = getUser()?._id || getUser()?.user_id || null;
  await signoffPhase(currentCycle, phase, turningOn, userId);
  // Mirror into allCycles so subsequent renders see the new status/signoff.
  const idx = allCycles.findIndex(c => c._id === currentCycle._id);
  if (idx >= 0) {
    allCycles[idx].phase_signoff = currentCycle.phase_signoff;
    allCycles[idx].status = currentCycle.status;
  }
  // Refresh the full panel set so dt-cycle-status, the snapshot panel, and the
  // ambience-apply visibility (all keyed on cycle.status) reflect the new
  // derived status. Same pattern as the retired gate button handler.
  await loadCycleById(currentCycle._id);
}

// Issue #231 \u2014 Manual "open downtimes" override (DT Prep tab).
// The button's data-manual-open attribute reflects the CURRENT latched
// state ('true' if override is on, 'false' if off). Clicking flips it.
async function _handleManualOpenClick(btn) {
  if (!currentCycle) return;
  const currentlyOn = btn.dataset.manualOpen === 'true';
  const turningOn = !currentlyOn;
  const confirmMsg = turningOn
    ? 'Open downtimes for all players, overriding automation?\n\n'
      + 'This sets a latched override on the cycle. Status stays "active" '
      + 'regardless of phase sign-off \u2014 until you turn it off or the cycle is closed.'
    : 'Clear the manual override and resume automatic phase derivation?\n\n'
      + 'The cycle status will revert to whatever the current phase_signoff state derives.';
  if (!confirm(confirmMsg)) return;
  const userId = getUser()?._id || getUser()?.user_id || null;
  await setManualOpen(currentCycle, turningOn, userId);
  // Mirror into allCycles so subsequent renders see the new override state.
  const idx = allCycles.findIndex(c => c._id === currentCycle._id);
  if (idx >= 0) {
    allCycles[idx].manual_open    = currentCycle.manual_open;
    allCycles[idx].manual_open_at = currentCycle.manual_open_at;
    allCycles[idx].manual_open_by = currentCycle.manual_open_by;
    allCycles[idx].status         = currentCycle.status;
  }
  // Same fan-out as signoff: status drives ~14 sites, refresh the lot.
  await loadCycleById(currentCycle._id);
}

function renderSignoffButton(phase, cycle) {
  const signed = !!(cycle?.phase_signoff || {})[phase];
  const label = signed ? '\u2713 Signed-off \u2014 undo?' : 'Mark phase signed-off';
  const cls = signed ? 'dt-btn dt-signoff-btn dt-signoff-signed' : 'dt-btn dt-signoff-btn';
  return `<button type="button" class="${cls}" data-signoff-phase="${phase}">${label}</button>`;
}

// Issue #231 \u2014 Override toggle. data-manual-open carries the CURRENT state
// (so the click handler knows which way to flip).
function renderManualOpenButton(cycle) {
  const on = cycle?.manual_open === true;
  const label = on ? 'Resume automation' : 'Open Downtimes (override)';
  const cls = on
    ? 'dt-btn dt-signoff-btn dt-manual-open-on'
    : 'dt-btn dt-signoff-btn';
  return `<button type="button" class="${cls}" data-manual-open="${on ? 'true' : 'false'}">${label}</button>`;
}

// Issue #231 \u2014 Banner shown above the prep grid when the override is active.
function renderManualOpenBanner(cycle) {
  if (cycle?.manual_open !== true) return '';
  return '<div class="dt-manual-open-banner" role="status">'
       + '<strong>Downtimes manually open</strong> \u2014 override is active. '
       + 'Click <em>Resume automation</em> below to clear it.'
       + '</div>';
}

function renderReadyPanel(cycle, subs) {
  const panel = document.getElementById('dt-ready-panel');
  if (!panel) return;
  if (!cycle) { panel.style.display = 'none'; return; }
  if (_dtuxActiveTab && _dtuxActiveTab !== 'ready') {
    panel.style.display = 'none';
  }
  // Visibility otherwise driven by showDtuxPhase. Render content unconditionally
  // so it's ready when the tab opens.
  const subList = subs || [];
  const total = subList.length;
  const pending = subList.filter(s => !s.approval_status || s.approval_status === 'pending').length;
  const storySigned = !!(cycle.phase_signoff || {}).story;

  let resolvedNote;
  if (total === 0)        resolvedNote = 'no submissions yet';
  else if (pending === 0) resolvedNote = 'all resolved';
  else                    resolvedNote = `${pending} pending`;

  let h = '<div class="dt-ready-content">';
  h += `<h3 class="dt-ready-title">Push Cycle</h3>`;
  h += `<p class="dt-ready-summary">${total} submission${total === 1 ? '' : 's'}\u00a0\u2014\u00a0${resolvedNote}; DT Story ${storySigned ? 'signed off' : 'not yet signed off'}.</p>`;
  h += `<p class="dt-ready-hint">Use the existing Push button on each character\u2019s row in DT Story to publish their narrative. This panel is informational; sign-off below records that the cycle is fully published.</p>`;
  h += `<div class="dt-ready-actions">${renderSignoffButton('ready', cycle)}</div>`;
  h += '</div>';
  panel.innerHTML = h;
}

let _shellInited = false;

export async function initDowntimeView(passedChars) {
  const container = document.getElementById('downtime-content');
  if (!container) return;

  if (!_shellInited) {
    _shellInited = true;
    container.innerHTML = buildShell();

    document.getElementById('dt-new-cycle').addEventListener('click', handleNewCycle);
    document.getElementById('dt-close-cycle').addEventListener('click', handleCloseCycle);
    document.getElementById('dt-export-all').addEventListener('click', handleExportAll);
    document.getElementById('dt-export-json').addEventListener('click', handleExportJson);
    document.getElementById('dt-city-export-btn')?.addEventListener('click', () => {
      if (_cityMatrix) _exportCityOverview(_cityMatrix);
    });
    document.getElementById('dt-import-csv').addEventListener('click', () => {
      document.getElementById('dt-import-csv-input').click();
    });
    document.getElementById('dt-import-csv-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      e.target.value = '';
      await processDowntimeCsvFile(file);
      await renderCycle();
    });
    document.getElementById('dt-cycle-sel').addEventListener('change', e => {
      selectedCycleId = e.target.value;
      loadCycleById(selectedCycleId);
    });

    // DTUX-1: phase ribbon click delegation — drives panel visibility and
    // sign-off button clicks. Wired once on shell init.
    document.getElementById('dt-phase-ribbon')?.addEventListener('click', e => {
      const tab = e.target.closest('[data-phase]');
      if (tab) { showDtuxPhase(tab.dataset.phase); return; }
    });
    document.addEventListener('click', e => {
      const signoff = e.target.closest('[data-signoff-phase]');
      if (signoff) { _handleSignoffClick(signoff); return; }
      // Issue #231 — manual-open override toggle (DT Prep tab)
      const manualOpen = e.target.closest('[data-manual-open]');
      if (manualOpen) { _handleManualOpenClick(manualOpen); return; }
      // DTIL-1: Court Pulse copy + save buttons
      const cpCopy = e.target.closest('.dt-court-pulse-copy-btn');
      if (cpCopy) { _handleCourtPulseCopy(cpCopy); return; }
      const cpSave = e.target.closest('.dt-court-pulse-save-btn');
      if (cpSave) { _handleCourtPulseSave(cpSave); return; }
      // DTIL-2: Action Queue filter pills, char-link, expand toggle
      const aqFilter = e.target.closest('.dt-action-queue-filter-pill');
      if (aqFilter) { _handleActionQueueFilter(aqFilter); return; }
      const aqOpen = e.target.closest('.dt-action-queue-char-btn');
      if (aqOpen) { _handleActionQueueOpenSub(aqOpen); return; }
      const aqExpand = e.target.closest('.dt-action-queue-text-toggle');
      if (aqExpand) { _handleActionQueueRowExpandToggle(aqExpand); return; }
      // DTIL-4: Territory Pulse toggle/copy/save
      const tpToggle = e.target.closest('.dt-territory-pulse-toggle-btn');
      if (tpToggle) { _handleTerritoryPulseToggle(tpToggle); return; }
      const tpCopy = e.target.closest('.dt-territory-pulse-copy-btn');
      if (tpCopy) { _handleTerritoryPulseCopy(tpCopy); return; }
      const tpSave = e.target.closest('.dt-territory-pulse-save-btn');
      if (tpSave) { _handleTerritoryPulseSave(tpSave); return; }
    });
    // DTIL-2: Action Queue state dropdown change
    document.addEventListener('change', e => {
      const aqSelect = e.target.closest('.dt-action-queue-state-select');
      if (aqSelect) { _handleActionQueueStateChange(aqSelect); return; }
    });
    // DTIL-2: Action Queue note input save on blur (focusout bubbles)
    document.addEventListener('focusout', e => {
      const aqNote = e.target.closest('.dt-action-queue-note-input');
      if (aqNote) { _handleActionQueueNoteSave(aqNote); return; }
      // Issue #320 (third pass): live processing-queue description textareas.
      // The cards have Save buttons that bundle these fields with others — blur-save
      // covers the high-risk long-text fields so a re-render mid-typing can't wipe them.
      const procFeedDesc = e.target.closest('.proc-feed-desc-ta');
      if (procFeedDesc) { _handleProcFieldBlur(procFeedDesc, 'description'); return; }
      const procMeritDesc = e.target.closest('.proc-merit-desc-ta');
      if (procMeritDesc) { _handleProcFieldBlur(procMeritDesc, 'description'); return; }
      const procSorcNotes = e.target.closest('.proc-sorc-notes-input');
      if (procSorcNotes) { _handleProcFieldBlur(procSorcNotes, 'sorc_notes'); return; }
      // Issue #324: Court Pulse synthesis autosave on blur
      const cpSynthTa = e.target.closest('.dt-court-pulse-synthesis-ta');
      if (cpSynthTa) { _handleCourtPulseBlur(cpSynthTa); return; }
    });
    // Dev-only: preview CSV button (no MongoDB writes)
    if (location.hostname === 'localhost') {
      const toolbar = document.querySelector('.dt-toolbar');
      if (toolbar) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.csv';
        inp.style.display = 'none';
        inp.id = 'dt-preview-input';
        inp.addEventListener('change', e => { if (e.target.files[0]) processFilePreview(e.target.files[0]); });

        const btn = document.createElement('button');
        btn.className = 'dt-btn proc-mode-btn';
        btn.textContent = 'Preview CSV';
        btn.title = 'Load CSV for local preview — not saved to MongoDB';
        btn.addEventListener('click', () => inp.click());

        toolbar.appendChild(inp);
        toolbar.appendChild(btn);
      }
    }
  }

  if (passedChars && passedChars.length) {
    characters = passedChars;
    charMap = new Map();
    for (const c of characters) {
      if (c.name) charMap.set(c.name.toLowerCase().trim(), c);
      if (c.moniker) charMap.set(c.moniker.toLowerCase().trim(), c);
    }
    try { await loadPlayers(); } catch (e) { console.warn('loadPlayers failed (no API?):', e.message); }
  } else {
    try { await loadCharacters(); } catch (e) { console.warn('loadCharacters failed (no API?):', e.message); }
  }
  try { await loadAllCycles(); } catch (e) { console.warn('loadAllCycles failed (no API?):', e.message); }
}

function buildShell() {
  return `
    <div id="dt-snapshot"></div>
    <div id="dt-warnings" class="dt-warnings"></div>
    <div id="dt-match-summary"></div>
    <div id="dt-feeding-scene"></div>
    <div id="dt-submissions" class="dt-submissions"></div>`;
}

// ── Character + player data bridge ──────────────────────────────────────────

let players = [];

async function loadCharacters() {
  try {
    characters = await apiGet('/api/characters');
    characters.forEach(c => applyDerivedMerits(c));
    charMap = new Map();
    for (const c of characters) {
      if (c.name) charMap.set(c.name.toLowerCase().trim(), c);
      if (c.moniker) charMap.set(c.moniker.toLowerCase().trim(), c);
    }
  } catch {
    characters = [];
    charMap = new Map();
  }
  await loadPlayers();
}

async function loadPlayers() {
  try { players = await apiGet('/api/players'); } catch { players = []; }
}

// ── Fuzzy matching utilities ────────────────────────────────────────────────

function _norm(s) { return (s || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

function _wordSet(s) { return new Set(_norm(s).split(/[\s'']+/).filter(Boolean)); }

/** Word-overlap score: fraction of query words found in target (0-1). */
function _wordOverlap(query, target) {
  const qw = _wordSet(query);
  const tw = _wordSet(target);
  if (!qw.size) return 0;
  let hits = 0;
  for (const w of qw) { if (tw.has(w)) hits++; }
  return hits / qw.size;
}

/** Substring containment score: 1 if target contains query or vice versa, 0.5 for partial word overlap. */
function _containsScore(query, target) {
  const q = _norm(query), t = _norm(target);
  if (q === t) return 1;
  if (t.includes(q) || q.includes(t)) return 0.9;
  return 0;
}

/**
 * Find the best matching character for a CSV submission row.
 * Combines character name matching and player name matching for a combined score.
 *
 * Character name is compared against: c.name, c.moniker, displayName(c)
 * Player name is compared against: player.display_name, player.discord_username, player.discord_global_name, c.player
 *
 * Returns { character, score, warnings[] } or { character: null, score: 0, warnings[] }
 */
export function findCharacter(submissionCharName, submissionPlayerName) {
  if (!submissionCharName && !submissionPlayerName) return null;

  // Build player → character_ids lookup
  const playerCharIds = new Map(); // character_id string → player doc
  for (const p of players) {
    for (const cid of (p.character_ids || [])) playerCharIds.set(String(cid), p);
  }

  let bestChar = null, bestScore = 0;

  for (const c of characters) {
    // Character name score (weight: 0.7)
    const cNames = [c.name, c.moniker, c.honorific ? (c.honorific + ' ' + (c.moniker || c.name)) : null].filter(Boolean);
    let charScore = 0;
    if (submissionCharName) {
      for (const cn of cNames) {
        const exact = _containsScore(submissionCharName, cn);
        const overlap = _wordOverlap(submissionCharName, cn);
        charScore = Math.max(charScore, exact, overlap);
      }
    }

    // Player name score (weight: 0.3)
    let playerScore = 0;
    if (submissionPlayerName) {
      const p = playerCharIds.get(String(c._id));
      const pNames = [
        c.player,
        p?.display_name,
        p?.discord_username,
        p?.discord_global_name,
      ].filter(Boolean);
      for (const pn of pNames) {
        const exact = _containsScore(submissionPlayerName, pn);
        const overlap = _wordOverlap(submissionPlayerName, pn);
        playerScore = Math.max(playerScore, exact, overlap);
      }
    }

    const combined = (submissionCharName && submissionPlayerName)
      ? charScore * 0.7 + playerScore * 0.3
      : submissionCharName ? charScore : playerScore;

    if (combined > bestScore) {
      bestScore = combined;
      bestChar = c;
    }
  }

  // Require a minimum confidence threshold
  if (bestScore < 0.4) return null;
  return bestChar;
}

/**
 * Resolve a submission to its matched character and display name in one call.
 * @param {object} s - submission object with character_name and player_name
 * @param {string} [fallback='Unknown'] - name to use when no match found and character_name is blank
 * @returns {{ char: object|null, charName: string }}
 */
function resolveSubChar(s, fallback = 'Unknown') {
  const char = _findCharForSub(s);
  const charName = char ? (char.moniker || char.name) : (s.character_name || fallback);
  return { char, charName };
}

/**
 * Build a phase/character progress badge string.
 * Returns a dt-narr-badge span when all done, a proc-narr-progress span when partially done,
 * or an empty string when nothing is done yet.
 * @param {number} done
 * @param {number} total
 * @param {string} [doneLabel='Done'] - text after ✓ when complete; pass '' for checkmark only
 * @returns {string} HTML string (includes leading space when non-empty)
 */
function _progressBadge(done, total, doneLabel = 'Done') {
  if (done === total && total > 0)
    return ` <span class="dt-narr-badge">\u2713${doneLabel ? ' ' + doneLabel : ''}</span>`;
  if (done > 0)
    return ` <span class="proc-narr-progress">${done}/${total}</span>`;
  return '';
}

/**
 * Resolve the nine_again checkbox state for a reviewed action.
 * Character-derived nine_again (PT / MCI / skill flag) always wins over a
 * saved false — a false in the review only applies when the character
 * genuinely has no nine_again on the validated skill.
 * Explicit saved true always wins regardless.
 * @param {object} rev          - st_review object
 * @param {string|null} poolValidated
 * @param {object|null} char
 * @returns {boolean}
 */
function _resolveNineAgainState(rev, poolValidated, char) {
  if (rev.nine_again === true) return true;
  if (char && poolValidated) {
    const discs   = _charDiscsArray(char).filter(d => d.dots > 0).map(d => d.name);
    const parsed  = _parsePoolExpr(poolValidated, ALL_ATTRS, ALL_SKILLS, discs);
    if (parsed?.skill && skNineAgain(char, parsed.skill)) return true;
  }
  if (rev.nine_again != null) return rev.nine_again;
  return false;
}

/**
 * Augment a pool_validated expression string with active spec bonuses.
 * E.g. "Wits 3 + Stealth 2 = 5" + ['Shadowing'] → "Wits 3 + Stealth 2 + Shadowing +1 = 6"
 * Returns the original string unchanged if no active specs or no '=' found.
 * @param {string|null} poolValidated
 * @param {string[]} activeSpecs
 * @param {object|null} char
 * @returns {string|null}
 */
function _augmentPoolWithSpecs(poolValidated, activeSpecs, char) {
  if (!poolValidated || !activeSpecs.length) return poolValidated;
  const eqIdx = poolValidated.lastIndexOf('=');
  if (eqIdx === -1) return poolValidated;
  const base     = poolValidated.slice(0, eqIdx).trim();
  const tot      = parseInt(poolValidated.slice(eqIdx + 1).trim()) || 0;
  const specTotal = activeSpecs.reduce((s, sp) => s + (char && hasAoE(char, sp) ? 2 : 1), 0);
  // #590: name cross-skill (IS) specs with their source skill, e.g. "Coward Punch (Stealth)",
  // mirroring _buildSpecTogglesHtml. Native specs on the selected skill keep just their name.
  const fromSkillMap = new Map((char ? isSpecs(char) : []).map(({ spec, fromSkill }) => [spec, fromSkill]));
  const specLabel = activeSpecs.map(sp => {
    const qualified = fromSkillMap.has(sp) ? `${sp} (${fromSkillMap.get(sp)})` : sp;
    return `${qualified} +${char && hasAoE(char, sp) ? 2 : 1}`;
  }).join(', ');
  return `${base} + ${specLabel} = ${tot + specTotal}`;
}

/**
 * Render a collapsible phase header row (without the outer section wrapper).
 * @param {string} phaseKey - data-toggle-phase value
 * @param {string} label    - full label HTML (may include badge spans)
 * @param {number} count    - item count
 * @param {string} unit     - singular unit word ('submission', 'action', 'character')
 * @param {boolean} isExpanded
 * @returns {string} HTML string
 */
function _renderPhaseHeader(phaseKey, label, count, unit, isExpanded) {
  const s = count !== 1 ? 's' : '';
  const clickable = isExpanded !== undefined;
  let h = clickable
    ? `<div class="proc-phase-header" data-toggle-phase="${esc(phaseKey)}">`
    : `<div class="proc-phase-header">`;
  h += `<span class="proc-phase-label">${label}</span>`;
  h += `<span class="proc-phase-count">${count} ${unit}${s}</span>`;
  if (clickable) h += `<span class="proc-phase-toggle">${isExpanded ? '&#9650; Hide' : '&#9660; Show'}</span>`;
  h += `</div>`;
  return h;
}

// ── JDT-5: Joint Projects phase grouping ───────────────────────────────────
// Renders one wrapper per joint: shared header (description, action type,
// target, role pills), participant rows (each expandable to the standard
// project pool builder + roll card via renderActionPanel), then a single
// joint outcome textarea + save button. The participant entries are
// regular project entries with phaseNum 1.5; their `entry.key` keeps the
// existing click-handler dispatch working unchanged.
function renderJointGroup(joint, entries) {
  if (!joint) {
    return `<div class="proc-joint-group proc-joint-group-orphan">
      <p class="proc-joint-orphan-msg">A joint is referenced but its document is missing from the cycle. Investigate and reconcile.</p>
    </div>`;
  }

  const actionLabel = ACTION_TYPE_LABELS[joint.action_type] || joint.action_type;
  let targetLine = '';
  if (joint.target_value) {
    if (joint.target_type === 'character') {
      let ids = [];
      try {
        const parsed = JSON.parse(joint.target_value);
        ids = Array.isArray(parsed) ? parsed : [joint.target_value];
      } catch { ids = [joint.target_value]; }
      const names = ids.map(id => {
        const c = characters.find(ch => String(ch._id) === String(id));
        return c ? dropdownName(c) : id;
      });
      targetLine = `Target: ${names.join(', ')}`;
    } else if (joint.target_type === 'territory') {
      targetLine = `Territory: ${joint.target_value}`;
    } else {
      targetLine = `Target: ${joint.target_value}`;
    }
  }

  let h = `<div class="proc-joint-group" data-joint-id="${esc(joint._id)}">`;

  // Shared header
  h += `<div class="proc-joint-shared-header">`;
  h += `<div class="proc-joint-action-label">Joint ${esc(actionLabel)}</div>`;
  if (joint.description) {
    h += `<div class="proc-joint-description">${esc(joint.description)}</div>`;
  }
  if (targetLine) {
    h += `<div class="proc-joint-target">${esc(targetLine)}</div>`;
  }
  h += `<div class="proc-joint-participant-pills">`;
  for (const entry of entries) {
    const roleLbl = entry.joint_role === 'lead' ? 'Lead' : 'Support';
    h += `<span class="proc-joint-participant-pill proc-joint-pill-${esc(entry.joint_role || 'support')}">${esc(entry.charName)} <em>(${roleLbl})</em></span>`;
  }
  h += `</div>`;
  h += `</div>`;

  // Per-participant rows — same shape as solo project rows so the existing
  // expand/collapse + renderActionPanel handlers route through unchanged.
  for (const entry of entries) {
    const isExpanded = procExpandedKeys.has(entry.key);
    const review = getEntryReview(entry);
    const status = review?.pool_status || 'pending';
    const shortDesc = entry.projTitle || '';
    const roleBadge = entry.joint_role === 'lead' ? 'Lead' : 'Support';

    const isDoneJoint = DONE_STATUSES.has(status);
    h += `<div class="proc-action-row proc-joint-row${isExpanded ? ' expanded' : ''}${isDoneJoint ? ' proc-action-done' : ''}" data-proc-key="${esc(entry.key)}">`;
    h += `<span class="proc-row-char">${esc(entry.charName)}</span>`;
    h += `<span class="proc-row-label">${esc(entry.label)} <span class="proc-joint-role-badge proc-joint-role-${esc(entry.joint_role || 'support')}">${roleBadge}</span></span>`;
    h += `<span class="proc-row-desc">${esc(shortDesc)}</span>`;
    const _attributedName =
      (status === 'validated' && review?.pool_validated_by) ? review.pool_validated_by :
      (status === 'confirmed' && review?.pool_confirmed_by) ? review.pool_confirmed_by :
      (status === 'resolved'  && review?.pool_resolved_by)  ? review.pool_resolved_by  : '';
    const _chipState = _deriveActionRibbonState(review);
    const _chipLabels = { pending: 'Pending', valid: 'Valid', complete: 'Complete' };
    h += `<span class="proc-row-status-cell">`;
    if (_attributedName) h += `<span class="proc-row-validator">${esc(_attributedName)}</span>`;
    h += `<span class="proc-row-status ar-${_chipState}">${_chipLabels[_chipState]}</span>`;
    h += `</span>`;
    if (review?.second_opinion) h += `<span class="proc-row-second-opinion-dot" title="Flagged for second opinion">●</span>`;
    // No Dup / Del on joint participant rows — lifecycle handled via JDT-6.
    h += `<span class="proc-row-actions"></span>`;
    h += `</div>`;

    if (isExpanded) {
      h += renderActionPanel(entry, review);
    }
  }

  // Joint outcome zone
  const outcomeTxt = joint.st_joint_outcome || '';
  h += `<div class="proc-joint-outcome-zone">`;
  h += `<div class="proc-mod-panel-title">Joint outcome</div>`;
  h += `<p class="proc-joint-outcome-help">One shared narrative outcome for this joint. Replicates into each participant's published outcome at push time, with their personal contribution notes interleaved.</p>`;
  h += `<textarea class="proc-joint-outcome-ta" data-joint-id="${esc(joint._id)}" rows="6">${esc(outcomeTxt)}</textarea>`;
  h += `<div class="proc-joint-outcome-actions">`;
  h += `<button class="dt-btn proc-joint-outcome-save-btn" data-joint-id="${esc(joint._id)}">Save outcome</button>`;
  h += `<span class="proc-joint-outcome-status" data-joint-id="${esc(joint._id)}"></span>`;
  h += `</div>`;
  h += `</div>`;

  // JDT-6: ST safety-valve override. Visible regardless of participant
  // state. Cancels the joint, decouples accepted supports, clears all slots.
  h += `<div class="proc-joint-st-override-zone">`;
  h += `<button class="proc-joint-st-override-btn" data-joint-id="${esc(joint._id)}">ST override: cancel joint</button>`;
  h += `<span class="proc-joint-st-override-help">Safety valve. Use only when normal lead cancellation is impossible.</span>`;
  h += `<span class="proc-joint-st-override-status" data-joint-id="${esc(joint._id)}"></span>`;
  h += `</div>`;

  h += `</div>`;
  return h;
}

/**
 * Match a CSV submission and return match details with warnings.
 * Used by the import flow to surface unmatched/low-confidence matches.
 */
export function matchSubmission(sub) {
  const charName = sub.submission.character_name;
  const playerName = sub.submission.player_name;
  const char = findCharacter(charName, playerName);
  const warnings = [];

  if (!char) {
    warnings.push(`No match found for character "${charName}" (player: ${playerName})`);
  } else {
    const matchedName = char.moniker || char.name;
    if (_norm(charName) !== _norm(matchedName) && _norm(charName) !== _norm(char.name)) {
      warnings.push(`Fuzzy match: "${charName}" → ${matchedName} (${char.name})`);
    }
  }

  return { character: char, warnings };
}

function buildFeedingPool(char, methodId, stMod, picks = {}) {
  if (!char) return null;
  const method = FEED_METHODS_DATA.find(m => m.id === methodId);
  if (!method) return null;

  let bestAttr = 0, bestAttrName = '';
  for (const a of method.attrs) {
    const v = getAttrVal(char, a);
    if (v > bestAttr) { bestAttr = v; bestAttrName = a; }
  }

  let bestSkill = 0, bestSkillName = '';
  for (const s of method.skills) {
    const sk = getSkillObj(char, s);
    const v = sk.dots + (sk.bonus || 0);
    if (v > bestSkill) { bestSkill = v; bestSkillName = s; }
  }

  // Issue #197 — discipline contribution. Prefer the player's chosen
  // `_feed_disc` if it is in the method's allowed set; otherwise auto-pick
  // the highest-dot discipline from the method allowlist (mirrors the
  // canonical computeBestFeedingPool in data/feeding-pool.js so player /
  // ST views agree). Pre-fix, the breakdown skipped disc entirely so the
  // discipline component never surfaced in the admin pool readout.
  let bestDisc = 0, bestDiscName = '';
  const playerDisc = picks.disc || '';
  if (playerDisc && method.discs.includes(playerDisc)) {
    bestDiscName = playerDisc;
    bestDisc = char.disciplines?.[playerDisc]?.dots || 0;
  } else {
    for (const d of method.discs) {
      const v = char.disciplines?.[d]?.dots || 0;
      if (v > bestDisc) { bestDisc = v; bestDiscName = d; }
    }
  }

  // Spec bonus: +2 if Area-of-Expertise spec, +1 otherwise. Accepts native,
  // interdisciplinary, or AoE specs (mirrors feeding-pool.js post-PR #267).
  let specBonus = 0;
  const playerSpec = picks.spec || '';
  if (playerSpec && bestSkillName) {
    const sk = char.skills?.[bestSkillName];
    const interdisc = isSpecs(char).some(({ spec: s }) =>
      String(s).toLowerCase() === String(playerSpec).toLowerCase()
    );
    if (sk?.specs?.includes(playerSpec) || interdisc || hasAoE(char, playerSpec)) {
      specBonus = hasAoE(char, playerSpec) ? 2 : 1;
    }
  }

  const fg = (char.merits || []).find(m => m.name === 'Feeding Grounds');
  const fgVal = fg ? Math.min(meritEffectiveRating(char, fg), 5) : 0;
  // #248: `stMod` is the ST manual feeding modifier (st_review.feeding_modifier)
  // — a dice-pool adjustment for cover/difficulty/etc. It is NOT territory
  // ambience: ambience affects Vitae yield, not the dice pool, and is handled
  // separately (feeding-pool.js player-side + the admin 'Ambience' column). All
  // callers pass `stMod` or `0`. Renamed from the misleadingly-named
  // `ambienceMod` (Ma'at, post-#176 fix-loop-2) so the name documents the
  // semantic and removes the variable-name-vs-value foot-gun.
  const amb = stMod || 0;
  const unskilled = bestSkill === 0
    ? (method.skills.some(s => !SKILLS_MENTAL.includes(s)) ? -1 : -3)
    : 0;
  const total = Math.max(0, bestAttr + bestSkill + bestDisc + fgVal + amb + unskilled + specBonus);

  return {
    total,
    breakdown: {
      attr: bestAttrName, attrVal: bestAttr,
      skill: bestSkillName, skillVal: bestSkill,
      disc: bestDiscName, discVal: bestDisc,
      spec: playerSpec, specBonus,
      fg: fgVal, ambience: amb, unskilled,
    },
  };
}

// ── Cycle loading ───────────────────────────────────────────────────────────

// ── End-of-Cycle Snapshot (GC-4) ────────────────────────────────────────────

/**
 * Capture prestige, eminence, and ascendancy for all active characters
 * and save the snapshot to the cycle document.
 * Called by GC-5 reset wizard.
 */
export async function takeSnapshot(cycleId) {
  const activeChars = characters.filter(c => !c.retired);

  // Per-character: prestige = clan status + covenant status, plus influence budget
  const charData = activeChars.map(c => ({
    character_id: String(c._id),
    name: dropdownName(c),
    clan: c.clan || '',
    covenant: c.covenant || '',
    prestige: (c.status?.clan || 0) + (c.status?.covenant?.[c.covenant] || 0),
    influence: calcTotalInfluence(c),
  }));

  // Clan eminence: sum of all active chars' city status per clan
  const eminenceMap = {};
  for (const c of activeChars) {
    const clan = c.clan || 'Unknown';
    eminenceMap[clan] = (eminenceMap[clan] || 0) + (c.status?.city || 0);
  }
  const eminence = Object.entries(eminenceMap)
    .map(([clan, total]) => ({ clan, total }))
    .sort((a, b) => b.total - a.total);

  // Covenant ascendancy: sum of all active chars' city status per covenant
  const ascendancyMap = {};
  for (const c of activeChars) {
    const cov = c.covenant || 'Unaligned';
    ascendancyMap[cov] = (ascendancyMap[cov] || 0) + (c.status?.city || 0);
  }
  const ascendancy = Object.entries(ascendancyMap)
    .map(([covenant, total]) => ({ covenant, total }))
    .sort((a, b) => b.total - a.total);

  const snapshot = {
    taken_at: new Date().toISOString(),
    characters: charData,
    eminence,
    ascendancy,
  };

  await updateCycle(cycleId, { snapshot });
  const idx = allCycles.findIndex(c => c._id === cycleId);
  if (idx >= 0) allCycles[idx].snapshot = snapshot;
  return snapshot;
}

/**
 * Add monthly influence income to each active character's influence_balance.
 * Called by GC-5 reset wizard after takeSnapshot.
 * Returns array of { name, error } for any failures.
 */
export async function applyInfluenceIncome() {
  const activeChars = characters.filter(c => !c.retired);
  const errors = [];

  for (const c of activeChars) {
    const income = calcTotalInfluence(c);
    const newBalance = (c.influence_balance || 0) + income;
    try {
      await apiPut(`/api/characters/${c._id}`, {
        name: c.name,
        influence_balance: newBalance,
      });
      c.influence_balance = newBalance;
    } catch (err) {
      errors.push({ name: dropdownName(c), error: err.message });
    }
  }

  return errors;
}

/** Render the historical snapshot for a closed cycle. No-ops for active cycles or cycles without data. */
function renderSnapshotPanel(cycle) {
  const el = document.getElementById('dt-snapshot');
  if (!el) return;

  const snap = cycle.snapshot;
  if (!snap || cycle.status === 'active') { el.innerHTML = ''; return; }

  const takenAt = new Date(snap.taken_at).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const isOpen = el.dataset.open !== 'false';

  let h = '<div class="dt-snapshot-panel">';
  h += `<div class="dt-snapshot-toggle" id="dt-snapshot-toggle">${isOpen ? '\u25BC' : '\u25BA'} Cycle Snapshot <span class="domain-count">${esc(takenAt)}</span></div>`;

  if (isOpen) {
    const sorted = [...snap.characters].sort((a, b) => b.prestige - a.prestige || b.influence - a.influence);

    h += '<div class="dt-snapshot-body">';

    // Prestige table
    h += '<table class="dt-snapshot-table">';
    h += '<thead><tr><th>Character</th><th>Clan</th><th>Covenant</th><th>Prestige</th><th>Influence</th></tr></thead><tbody>';
    for (const c of sorted) {
      h += `<tr><td>${esc(c.name)}</td><td>${esc(c.clan)}</td><td>${esc(c.covenant)}</td>`;
      h += `<td class="dt-snap-val">${c.prestige}</td><td class="dt-snap-val">${c.influence}</td></tr>`;
    }
    h += '</tbody></table>';

    // Eminence + Ascendancy side by side
    h += '<div class="dt-snapshot-factions">';
    h += '<div class="dt-snapshot-faction-col"><div class="dt-snapshot-head">Clan Eminence</div>';
    for (const e of snap.eminence) {
      h += `<div class="dt-snap-faction-row"><span>${esc(e.clan)}</span><span class="dt-snap-val">${e.total}</span></div>`;
    }
    h += '</div>';
    h += '<div class="dt-snapshot-faction-col"><div class="dt-snapshot-head">Covenant Ascendancy</div>';
    for (const a of snap.ascendancy) {
      h += `<div class="dt-snap-faction-row"><span>${esc(a.covenant)}</span><span class="dt-snap-val">${a.total}</span></div>`;
    }
    h += '</div></div>'; // factions

    h += '</div>'; // body
  }

  h += '</div>'; // panel
  el.innerHTML = h;

  document.getElementById('dt-snapshot-toggle')?.addEventListener('click', () => {
    el.dataset.open = isOpen ? 'false' : 'true';
    renderSnapshotPanel(cycle);
  });
}


async function loadAllCycles() {
  allCycles = await getCycles();
  allCycles.sort((a, b) => (b.loaded_at || '').localeCompare(a.loaded_at || ''));

  const sel = document.getElementById('dt-cycle-sel');
  sel.innerHTML = '<option value="">\u2014 Select cycle \u2014</option>';
  allCycles.forEach(c => {
    const feeds = cycleFeedsLabel(c); // #1002: which session this cycle feeds
    const label = (c.label || 'Unnamed')
      + (feeds ? ` – ${feeds}` : '')
      + (c.status === 'active' ? ' (active)' : '');
    sel.innerHTML += `<option value="${c._id}">${esc(label)}</option>`;
  });

  // Auto-select active cycle
  activeCycle = allCycles.find(c => c.status === 'active') || null;
  // #751: plumb the cycle number into shared state for the editor's
  // Add Equipment / Add Asset pre-fill.
  state.activeCycleNum = (activeCycle && activeCycle.cycle_number) ?? null;
  if (activeCycle) {
    selectedCycleId = activeCycle._id;
    sel.value = activeCycle._id;
    await loadCycleById(activeCycle._id);
  } else if (allCycles.length) {
    selectedCycleId = allCycles[0]._id;
    sel.value = allCycles[0]._id;
    await loadCycleById(allCycles[0]._id);
  } else {
    document.getElementById('dt-submissions').innerHTML = '<p class="placeholder">No cycles. Upload a CSV or create a new cycle.</p>';
    document.getElementById('dt-match-summary').innerHTML = '';
    document.getElementById('dt-close-cycle').style.display = 'none';
    document.getElementById('dt-export-all').style.display = 'none';
    document.getElementById('dt-export-json').style.display = 'none';
  }
}

async function loadCycleById(cycleId) {
  const subEl = document.getElementById('dt-submissions');
  const statusEl = document.getElementById('dt-cycle-status');
  const closeBtn = document.getElementById('dt-close-cycle');

  const cycle = allCycles.find(c => c._id === cycleId);
  if (!cycle) {
    subEl.innerHTML = '<p class="placeholder">Cycle not found.</p>';
    return;
  }
  currentCycle = cycle;
  cycleReminders = cycle.processing_reminders || [];
  cachedTerritories = null; // refresh territory ambience on next processing render
  // Issue #321: invalidate DT Story's lazy-init cache so the next tab-show
  // re-fetches submissions for the newly-selected cycle. Without this,
  // switching the dropdown leaves DT Story showing the previous cycle's data.
  _dtuxStoryInited = false;

  const isPrep   = cycle.status === 'prep';
  const isActive = cycle.status === 'active';
  const isGame   = isInGamePhase(cycle); // #1001: game_phase wins over legacy status
  const isOpen   = cycle.status === 'open';
  const isClosed = cycle.status === 'closed';
  const isLive   = isPrep || isActive || isGame || isOpen;
  const deadlineStr = cycle.deadline_at
    ? new Date(cycle.deadline_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  const deadlinePast = cycle.deadline_at && new Date(cycle.deadline_at) < new Date();
  const statusLabel = isPrep ? 'prep' : isActive ? 'active' : isGame ? 'game' : 'closed';
  const statusCss   = isPrep ? 'prep' : isActive ? 'pending' : isGame ? 'game' : 'approved';
  let statusHtml = `<span class="dt-status-badge dt-status-${statusCss}">${statusLabel}</span>` +
    `<span class="domain-count">${cycle.submission_count || 0} submissions</span>`;
  if (deadlineStr) {
    statusHtml += `<span class="dt-deadline${deadlinePast ? ' dt-deadline-past' : ''}">Deadline: ${esc(deadlineStr)}</span>`;
  }
  if (isLive) {
    const dtVal = cycle.deadline_at ? isoToLocalInput(cycle.deadline_at) : '';
    statusHtml += `<label class="dt-deadline-edit"><span>Set deadline</span><input type="datetime-local" class="dt-deadline-input" id="dt-deadline-input" value="${esc(dtVal)}"></label>`;
  }
  if (isClosed || isGame) {
    const alreadyApplied = cycle.ambience_applied;
    statusHtml += `<button class="dt-btn${alreadyApplied ? ' dt-btn-dim' : ''}" id="dt-apply-ambience" title="${alreadyApplied ? 'Ambience already applied for this cycle' : 'Apply ambience changes from this cycle\'s resolved projects'}">
      ${alreadyApplied ? '\u2713 Ambience applied' : 'Apply Ambience Changes'}
    </button>`;
  }

  statusEl.innerHTML = statusHtml;
  closeBtn.style.display = isActive ? '' : 'none';

  // ── Snapshot panel (GC-4) ──
  renderSnapshotPanel(cycle);

  // ── DTUX-1: phase ribbon + panel set; show the chosen tab ──
  if (!_dtuxActiveTab) _dtuxActiveTab = _initialDtuxTab(cycle);
  renderPhaseRibbon(cycle, []);
  renderPrepPanel(cycle);
  renderReadyPanel(cycle, []);
  showDtuxPhase(_dtuxActiveTab);
  // Issue #321 AC2: if the story tab is already visible, drive a direct refresh
  // rather than relying solely on the lazy-init flag. The flag path is correct but
  // the async microtask chain in the rest of loadCycleById can race with it.
  if (_dtuxActiveTab === 'story') _initDtStoryFromRibbon();

  // Wire deadline input
  document.getElementById('dt-deadline-input')?.addEventListener('change', async e => {
    const val = e.target.value; // datetime-local string or empty
    await updateCycle(cycleId, { deadline_at: val ? new Date(val).toISOString() : null });
    const idx = allCycles.findIndex(c => c._id === cycleId);
    if (idx >= 0) allCycles[idx].deadline_at = val ? new Date(val).toISOString() : null;
    await loadCycleById(cycleId);
  });

  // Wire ambience apply button
  document.getElementById('dt-apply-ambience')?.addEventListener('click', () => handleApplyAmbience(cycleId, cycle));

  procExpandedKeys.clear();
  submissions = await getSubmissionsForCycle(cycleId);
  renderPhaseRibbon(currentCycle, submissions);
  renderReadyPanel(currentCycle, submissions);
  // DTIL-3: derive Action Queue defaults from mechanical_flag_N before render
  // so flagged items appear pre-triaged as Action Needed. Idempotent — only
  // writes for items without an existing entry.
  await _deriveActionQueueDefaults(currentCycle, submissions);
  // DTIL: refresh cycle-level intelligence layer now that submissions are loaded
  renderCycleIntelligence(currentCycle, submissions, characters);
  document.getElementById('dt-export-all').style.display = submissions.length ? '' : 'none';
  document.getElementById('dt-export-json').style.display = submissions.length ? '' : 'none';
  renderMatchSummary();
  renderSubmissionChecklist();
  await ensureTerritories();
  renderCityOverview();
  await loadInvestigations(cycleId);
  renderInvestigations();
  renderSubmissions();
}

// ── Match summary ───────────────────────────────────────────────────────────

function renderMatchSummary() {
  const el = document.getElementById('dt-match-summary');
  if (el) el.innerHTML = '';
}

// ── Submission rendering ────────────────────────────────────────────────────

function renderSubmissions() {
  // Stick the checklist to the top of the scroll area
  document.getElementById('dt-feeding-scene')
    ?.classList.add('dt-proc-sticky');

  renderProcessingMode(document.getElementById('dt-submissions'));
}

function renderFeedingDetail(s, raw, char) {
  const feed = raw.feeding || {};
  const territories = feed.territories || {};
  const rollResult = s.feeding_roll;

  let h = '<div class="dt-feed-detail">';
  h += '<div class="dt-feed-header">Feeding</div>';

  if (feed.method) h += `<div class="dt-feed-row"><span class="dt-feed-lbl">Submitted</span> ${esc(feed.method)}</div>`;

  // Territory feeding status
  const activeTerrs = Object.entries(territories).filter(([, v]) => v && v !== 'Not feeding here');
  if (activeTerrs.length) {
    h += '<div class="dt-feed-row"><span class="dt-feed-lbl">Territories</span>';
    h += activeTerrs.map(([t, status]) => `<span class="dt-sub-tag">${esc(t)}: ${esc(status)}</span>`).join(' ');
    h += '</div>';
  }

  // Method selection + pool building (only if character matched)
  if (char) {
    h += '<div class="dt-feed-row"><span class="dt-feed-lbl">Hunt method</span>';
    h += '<div class="dt-method-btns">';
    // Issue #197 — read from `responses`, not the doc root. Pre-fix this
    // read missed every submission's method choice (form writes to
    // responses._feed_method per downtime-form.js:407), so the method-button
    // selection never highlighted and the pool breakdown branch never fired.
    const selectedMethod = s.responses?._feed_method || '';
    FEED_METHODS_DATA.forEach(m => {
      h += `<button class="dt-method-btn${selectedMethod === m.id ? ' selected' : ''}" data-method="${m.id}" data-sub-id="${s._id}">${esc(m.name)}</button>`;
    });
    h += '</div></div>';

    // Show pool breakdown if method selected
    if (selectedMethod) {
      const stMod = s.st_review?.feeding_modifier || 0;
      const playerDisc = s.responses?._feed_disc || '';
      const playerSpec = s.responses?._feed_spec || '';
      // 'other' method: not in FEED_METHODS_DATA, so buildFeedingPool returns
      // null. Render the player's custom pool components directly, mirroring
      // the action-queue's handling of the 'other' branch.
      if (selectedMethod === 'other') {
        const customAttr  = s.responses?._feed_custom_attr  || '';
        const customSkill = s.responses?._feed_custom_skill || '';
        const customDisc  = s.responses?._feed_custom_disc  || playerDisc || '';
        const parts = [customAttr, customSkill, customDisc].filter(Boolean);
        if (parts.length) {
          h += '<div class="dt-feed-row"><span class="dt-feed-lbl">Pool</span>';
          h += `<span class="dt-pool-breakdown">${esc(parts.join(' + '))}`;
          if (playerSpec) h += ` (+${esc(playerSpec)})`;
          h += ` <span class="dt-feed-other-tag">(custom \u2014 'other' method)</span></span>`;
          h += '</div>';
        }
      } else {
        const pool = buildFeedingPool(char, selectedMethod, stMod, { disc: playerDisc, spec: playerSpec });
        if (pool) {
          const bd = pool.breakdown;
          h += '<div class="dt-feed-row"><span class="dt-feed-lbl">Pool</span>';
          h += `<span class="dt-pool-breakdown">${bd.attrVal} ${esc(bd.attr)} + ${bd.skillVal} ${esc(bd.skill)}`;
          if (bd.discVal) h += ` + ${bd.discVal} ${esc(bd.disc)}`;
          if (bd.specBonus) h += ` + ${bd.specBonus} ${esc(bd.spec)}`;
          if (bd.fg) h += ` + ${bd.fg} FG`;
          if (bd.unskilled) h += ` \u2212 ${Math.abs(bd.unskilled)} (unskilled)`;
          if (stMod) h += ` ${stMod >= 0 ? '+' : '\u2212'} ${Math.abs(stMod)} ST`;
          h += ` = <b>${pool.total}</b></span>`;
          h += `<span class="dt-pool-mod-wrap"><label class="dt-feed-lbl">Mod</label> <input type="number" class="dt-pool-mod dt-num-input-sm" data-sub-id="${esc(s._id)}" value="${stMod}" min="-20" max="20" step="1"></span>`;
          h += '</div>';
        }
      }
    }

    // Rote toggle — shown when a project action was dedicated to rote feeding.
    // dt-form.22 made ROTE a per-slot project action (`action === 'rote'`);
    // legacy `'feed'` is kept for back-compat with pre-redesign drafts.
    const hasFeedAction = [1,2,3,4].some(n => {
      const a = s.responses?.[`project_${n}_action`];
      return a === 'rote' || a === 'feed';
    });
    const isRote = s.st_review?.feeding_rote || false;
    h += `<div class="dt-feed-row"><span class="dt-feed-lbl">Rote</span>`;
    h += `<label class="dt-rote-label"><input type="checkbox" class="dt-feed-rote-chk" data-sub-id="${s._id}"${isRote ? ' checked' : ''}>`;
    h += ` Rote quality`;
    if (hasFeedAction) h += ` <span class="dt-rote-hint">(rote action detected)</span>`;
    h += `</label></div>`;

    // Issue #197 / audit #198 — surface the player's per-territory rote
    // feeding intent. Form writes `feeding_territories_rote` JSON when any
    // project slot is a rote action (downtime-form.js:446); admin previously
    // never read this key, so the player's rote-feed territory choices were
    // dropped on the floor.
    try {
      const roteTerrs = JSON.parse(s.responses?.feeding_territories_rote || '{}');
      const activeRote = Object.entries(roteTerrs).filter(([, v]) => v && v !== 'none');
      if (activeRote.length) {
        h += '<div class="dt-feed-row"><span class="dt-feed-lbl">Rote territories</span>';
        h += activeRote.map(([t, status]) => `<span class="dt-sub-tag">${esc(t.replace(/_/g, ' '))}: ${esc(status)}</span>`).join(' ');
        h += '</div>';
      }
    } catch { /* ignore malformed JSON */ }
  } else {
    // Manual pool for unmatched characters
    h += '<div class="dt-feed-row"><span class="dt-feed-lbl">Pool</span>';
    h += `<input type="number" class="dt-pool-input" min="1" max="30" value="${rollResult?.params?.size || 5}">`;
    h += '</div>';
  }

  // Roll button + result
  h += '<div class="dt-feed-roll-row">';
  h += `<button class="dt-btn dt-feed-roll-btn" data-sub-id="${s._id}">${rollResult ? 'Re-roll' : 'Roll'}</button>`;

  if (rollResult) {
    const rc = rollResult.exceptional ? 'exceptional' : rollResult.successes === 0 ? 'failure' : 'normal';
    const vessels = rollResult.successes;
    h += `<span class="dt-feed-result ${rc}">${rollResult.successes} ${rollResult.exceptional ? 'Exceptional' : rollResult.successes === 1 ? 'success' : 'successes'}</span>`;
    if (vessels > 0) h += `<span class="dt-feed-vessels">${vessels} vessel${vessels > 1 ? 's' : ''} \u00B7 ${vessels * 2} Vitae safe</span>`;
    h += `<span class="dt-feed-dice">${esc(rollResult.dice_string || '')}</span>`;
  }

  h += '</div></div>';
  return h;
}

// ── Feeding rolls — handled inline via showRollModal in event delegation ────

// ── Player Responses (new form format) ──────────────────────────────────────

function renderPlayerResponses(s) {
  const r = s.responses;
  if (!r || !Object.keys(r).length) return '';

  const SKIP_PREFIXES = ['_gate_', '_feed_blood', 'sorcery_slot_count', 'equipment_slot_count'];

  function row(label, val) {
    if (!val || (typeof val === 'string' && !val.trim())) return '';
    return `<div class="dt-resp-row"><span class="dt-resp-label">${esc(label)}</span><span class="dt-resp-val">${esc(val)}</span></div>`;
  }

  let h = '<div class="dt-panel dt-resp-panel">';
  h += '<div class="dt-panel-title">Player Submission</div>';

  // ── Feeding ──
  const feedMethod = r['_feed_method'];
  const feedDesc = r['feeding_description'];
  const feedDisc = r['_feed_disc'];
  const feedSpec = r['_feed_spec'];
  // Issue #197 / audit #198 — `_feed_rote` was dropped by dt-form.22 (legacy
  // key, no longer written). Derive rote presence from project actions
  // (`action === 'rote'` is the post-redesign indicator; `'feed'` is the
  // back-compat alias) instead of reading the orphan key.
  const feedRote = [1,2,3,4].some(n => {
    const a = r[`project_${n}_action`];
    return a === 'rote' || a === 'feed';
  });
  if (feedMethod) {
    h += '<div class="dt-resp-section"><div class="dt-resp-section-title">Feeding</div>';
    h += row('Method', FEED_METHOD_LABELS_MAP[feedMethod] || feedMethod);
    if (feedDisc) h += row('Discipline', feedDisc);
    if (feedSpec) h += row('Specialisation', feedSpec);
    if (feedRote) h += row('Rote action', 'Yes — project slot dedicated to rote feeding');
    try {
      const terrs = JSON.parse(r['feeding_territories'] || '{}');
      const active = Object.entries(terrs).filter(([, v]) => v && v !== 'none').map(([k, v]) => `${k.replace(/_/g, ' ')} (${v})`).join(', ');
      if (active) h += row('Territory', active);
    } catch { /* ignore */ }
    // Surface rote-feed territory choices (form writes `feeding_territories_rote`
    // when any project slot is a rote action; previously never read by admin).
    try {
      const roteTerrs = JSON.parse(r['feeding_territories_rote'] || '{}');
      const activeRote = Object.entries(roteTerrs).filter(([, v]) => v && v !== 'none').map(([k, v]) => `${k.replace(/_/g, ' ')} (${v})`).join(', ');
      if (activeRote) h += row('Rote territory', activeRote);
    } catch { /* ignore */ }
    if (feedDesc) h += row('Description', feedDesc);
    h += '</div>';
  }

  // ── Court ──
  // Issue #221 — read per-game `game_recount_${n}` slots first so the
  // ST sees one row per game highlight (form persists per-slot via the
  // structured highlight UI at downtime-form.js:6597; the joined
  // top-level `game_recount` mirror at line 545 is kept for back-compat
  // with legacy single-cell readers). Pre-fix the player summary read
  // only the joined string, collapsing the structured shape into a
  // single 'Game Recount' cell with numbered prefixes.
  const gameRecountSlots = [];
  for (let n = 1; n <= 5; n++) {
    const txt = (r[`game_recount_${n}`] || '').trim();
    if (txt) gameRecountSlots.push({ n, txt });
  }
  const courtKeysWithoutRecount = ['travel', 'rp_shoutout', 'correspondence'];
  const courtLabels = { travel: 'Travel', rp_shoutout: 'Shoutout', correspondence: 'Correspondence' };
  const courtVals = courtKeysWithoutRecount.filter(k => r[k] && r[k].trim());
  const aspLines = [1,2,3].map(n => {
    const t = r[`aspiration_${n}_type`]; const v = r[`aspiration_${n}_text`];
    return (t && v) ? `${t}: ${v}` : null;
  }).filter(Boolean);
  const hasJoinedRecount = !gameRecountSlots.length && r['game_recount'] && r['game_recount'].trim();
  const hasCourtContent = courtVals.length || gameRecountSlots.length || hasJoinedRecount || aspLines.length || r['aspirations'];
  if (hasCourtContent) {
    h += '<div class="dt-resp-section"><div class="dt-resp-section-title">Court</div>';
    for (const k of courtVals) {
      let val = r[k];
      if (k === 'rp_shoutout') { try { val = JSON.parse(val).filter(Boolean).map(id => { const ch = characters.find(c => String(c._id) === String(id)); return ch ? (ch.moniker || ch.name) : id; }).join(', '); } catch { /* ignore */ } }
      h += row(courtLabels[k] || k, val);
    }
    if (gameRecountSlots.length) {
      for (const { n, txt } of gameRecountSlots) h += row(`Game ${n} Recount`, txt);
    } else if (hasJoinedRecount) {
      // Legacy / migrated drafts that have only the joined string.
      h += row('Game Recount', r['game_recount']);
    }
    if (aspLines.length) {
      h += row('Aspirations', aspLines.join('\n'));
    } else if (r['aspirations']) {
      h += row('Aspirations', r['aspirations']);
    }
    h += '</div>';
  }

  // ── Personal Story ──
  // Issue #208 / audit #195 — dt-form.18's Touchstone-or-Correspondence
  // narrative was form-write-only. Form persists: personal_story_kind
  // ('touchstone' | 'correspondence'), personal_story_npc_name (free
  // text), personal_story_text (narrative body), story_moment_note
  // (additional note). All four were dropped on the admin floor — the
  // ST had no visibility into what the player wrote here.
  const psKind    = r['personal_story_kind']     || '';
  const psNpcName = r['personal_story_npc_name'] || '';
  const psText    = r['personal_story_text']     || '';
  const psMomentNote = r['story_moment_note']    || '';
  if (psKind || psText || psNpcName || psMomentNote) {
    h += '<div class="dt-resp-section"><div class="dt-resp-section-title">Personal Story</div>';
    if (psKind) {
      const kindLabel = psKind === 'touchstone' ? 'Touchstone Vignette'
                      : psKind === 'correspondence' ? 'Correspondence' : psKind;
      h += row('Kind', kindLabel);
    }
    if (psNpcName) h += row('Person involved', psNpcName);
    if (psText)    h += row('Narrative', psText);
    if (psMomentNote) h += row('Moment note', psMomentNote);
    h += '</div>';
  }

  // ── Projects ──
  const projRows = [];
  for (let n = 1; n <= 4; n++) {
    const action = r[`project_${n}_action`];
    if (!action) continue;
    const actionLabel = action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    let desc = r[`project_${n}_description`] || r[`project_${n}_xp_trait`] || '';
    if (action === 'xp_spend') {
      // Issue #219 — read multi-row `_xp_rows` JSON first; legacy
      // single-row keys remain as fallback for pre-redesign drafts.
      const rj = r[`project_${n}_xp_rows`] || '';
      let multi = '';
      if (rj) {
        try {
          const rows = JSON.parse(rj);
          if (Array.isArray(rows) && rows.length) {
            multi = rows
              .filter(x => x && (x.category || x.item))
              .map(x => {
                const dots = x.dotsBuying ? ` (${x.dotsBuying} dot${x.dotsBuying === 1 ? '' : 's'})` : '';
                return `${x.category || ''}: ${x.item || ''}${dots}`;
              })
              .join(' — ');
          }
        } catch { /* fall through */ }
      }
      if (multi) {
        desc = multi;
      } else {
        const cat = r[`project_${n}_xp_category`]; const item = r[`project_${n}_xp_item`];
        if (cat && item) desc = `${cat}: ${item}`;
      }
    }
    projRows.push(`${n}. ${actionLabel}${desc ? ': ' + desc : ''}`);
  }
  if (projRows.length) {
    h += '<div class="dt-resp-section"><div class="dt-resp-section-title">Projects</div>';
    for (const p of projRows) h += `<div class="dt-resp-row"><span class="dt-resp-val">${esc(p)}</span></div>`;
    h += '</div>';
  }

  // ── Sorcery ──
  const sorcCount = parseInt(r['sorcery_slot_count'] || '1', 10);
  const sorcRows = [];
  for (let n = 1; n <= sorcCount; n++) {
    const rite = r[`sorcery_${n}_rite`];
    if (!rite) continue;
    const targets = normaliseSorceryTargets(r[`sorcery_${n}_targets`]);
    const notes = r[`sorcery_${n}_notes`] || '';
    const mand = r[`sorcery_${n}_mandragora`] === 'yes';
    let line = rite;
    if (mand) line += ' [Parked in Mandragora Garden]';
    if (targets) line += ` — targets: ${targets}`;
    if (notes) line += ` — ${notes}`;
    sorcRows.push(line);
  }
  if (sorcRows.length) {
    h += '<div class="dt-resp-section"><div class="dt-resp-section-title">Blood Sorcery</div>';
    for (const sr of sorcRows) h += `<div class="dt-resp-row"><span class="dt-resp-val">${esc(sr)}</span></div>`;
    h += '</div>';
  }

  // ── Equipment ──
  // ECM-4 (#871): canonical persistence key is `equipment_${n}_catalogue_id`
  // (24-hex ObjectId string); display name resolves via the catalogue cache.
  // Legacy pre-ECM-4 submissions carry `equipment_${n}_name` as free-text;
  // we fall back to that when no `_catalogue_id` is present — Khepri's
  // backcompat dispatch ("if catalogue_id is present, resolve via catalogue;
  // else if name is present, render the free-text as legacy; else hide").
  const equipCount = parseInt(r['equipment_slot_count'] || '1', 10);
  const equipRows = [];
  for (let n = 1; n <= equipCount; n++) {
    const catalogueId = r[`equipment_${n}_catalogue_id`];
    const legacyName = r[`equipment_${n}_name`];
    let displayName = '';
    if (catalogueId) {
      const entry = getCatalogueEntry(catalogueId);
      displayName = entry?.name || `(catalogue item ${catalogueId})`;
    } else if (legacyName) {
      displayName = `${legacyName} (legacy free-text)`;
    } else {
      continue;
    }
    const qty = r[`equipment_${n}_qty`] || '';
    const notes = r[`equipment_${n}_notes`] || '';
    equipRows.push([qty ? `${qty}× ${displayName}` : displayName, notes].filter(Boolean).join(' — '));
  }
  if (equipRows.length) {
    h += '<div class="dt-resp-section"><div class="dt-resp-section-title">Equipment</div>';
    for (const eq of equipRows) h += `<div class="dt-resp-row"><span class="dt-resp-val">${esc(eq)}</span></div>`;
    h += '</div>';
  }

  // ── Item request (ECM-9 / #876) ──
  // Free-text escape valve for items not in the catalogue. ST adjudicates
  // inline (approve+create via admin catalogue / approve+substitute / reject).
  const itemRequest = r['item_request'];
  if (itemRequest && itemRequest.trim()) {
    h += '<div class="dt-resp-section"><div class="dt-resp-section-title">Item Request</div>';
    h += `<div class="dt-resp-row"><span class="dt-resp-val">${esc(itemRequest)}</span></div>`;
    h += '</div>';
  }

  // ── Misc sections (vamping, lore, admin) ──
  const miscFields = [
    ['vamping', 'Vamping'],
    ['lore_request', 'Lore Request'],
    ['xp_spend', 'XP Spend'],
    ['resources_acquisitions', 'Resources Acquisitions'],
    ['skill_acquisitions', 'Skill Acquisitions'],
    ['regency_action', 'Regency Action'],
    ['form_feedback', 'Form Feedback'],
  ];
  let miscH = '';
  // Issue #221 — surface the structured `regent_territory` slug
  // (downtime-form.js:377, written when gateValues.is_regent === 'yes')
  // alongside the free-text `regency_action` blob. Pre-fix the slug
  // was never read — the ST saw the regent's narrative description
  // but no structured indication of which territory they were
  // governing.
  if (r['regent_territory']) miscH += row('Regent territory', r['regent_territory']);
  for (const [key, label] of miscFields) {
    if (!r[key] || !r[key].trim?.()) continue;
    if (key === 'xp_spend') {
      try {
        const rows = JSON.parse(r[key]).filter(rw => rw.category && rw.item);
        if (rows.length) miscH += row(label, rows.map(rw => `${rw.item} (${rw.cost} XP)`).join(', '));
      } catch { /* ignore */ }
    } else if (key === 'resources_acquisitions') {
      // Issue #221 — annotate the blob with the structured slot count
      // (form persists `acq_slot_count` at downtime-form.js:920) so the
      // ST can see at a glance how many acquisitions the player split
      // their declaration into. Slot count > 1 indicates a multi-row
      // submission already structured-rendered by PR #215; this adds
      // the count summary to the player-summary panel where only the
      // blob was shown.
      const slotCount = parseInt(r['acq_slot_count'] || '1', 10) || 1;
      const labelWithCount = slotCount > 1 ? `${label} (${slotCount} slots)` : label;
      miscH += row(labelWithCount, r[key]);
    } else {
      miscH += row(label, r[key]);
    }
  }
  if (miscH) {
    h += '<div class="dt-resp-section"><div class="dt-resp-section-title">Other</div>';
    h += miscH;
    h += '</div>';
  }

  h += '</div>';
  return h;
}

// ── Expenditure Tracking (GC-3) ─────────────────────────────────────────────

function renderExpenditurePanel(s) {
  const vitae    = s.st_review?.vitae_spent    ?? '';
  const wp       = s.st_review?.willpower_spent ?? '';
  const influence = s.st_review?.influence_spent ?? '';

  let h = '<div class="dt-exp-panel">';
  h += '<div class="dt-feed-header">Expenditure</div>';
  h += '<div class="dt-exp-fields">';
  for (const [label, field, val] of [
    ['Vitae', 'vitae_spent', vitae],
    ['Willpower', 'willpower_spent', wp],
    ['Influence', 'influence_spent', influence],
  ]) {
    h += `<label class="dt-exp-field">`;
    h += `<span class="dt-exp-lbl">${label}</span>`;
    h += `<input type="number" class="dt-exp-input" data-sub-id="${s._id}" data-exp-field="st_review.${field}" min="0" max="99" value="${esc(String(val))}">`;
    h += `</label>`;
  }
  h += '</div>';
  h += '</div>';
  return h;
}

// ── File handling ───────────────────────────────────────────────────────────

/**
 * Process a downtime player CSV file.
 * Returns { created, updated, unmatched, warnings } so callers can render
 * their own result feedback.
 * Also writes human-readable feedback to #dt-warnings if it exists in the DOM.
 */
export async function processDowntimeCsvFile(file) {
  const warnEl = document.getElementById('dt-warnings');
  if (warnEl) warnEl.innerHTML = '';

  const text = await file.text();
  const { submissions: parsed, warnings } = parseDowntimeCSV(text);

  if (warnings.length && warnEl) {
    warnEl.innerHTML = warnings.map(w => `<div class="dt-warn">${esc(w)}</div>`).join('');
  }

  if (!parsed.length) {
    if (warnEl) warnEl.innerHTML += '<div class="dt-warn">No submissions found in CSV.</div>';
    return { created: 0, updated: 0, unmatched: 0, warnings: ['No submissions found in CSV.'] };
  }

  // Enrich each parsed submission with character_id via combined fuzzy matching
  const matchWarnings = [];
  for (const sub of parsed) {
    const { character, warnings: mw } = matchSubmission(sub);
    if (character) sub._character_id = character._id;
    matchWarnings.push(...mw);
  }
  if (matchWarnings.length && warnEl) {
    warnEl.innerHTML += matchWarnings.map(w => `<div class="dt-warn">${esc(w)}</div>`).join('');
  }

  const result = await upsertCycle(parsed, characters);
  const matched = parsed.filter(s => s._character_id).length;
  const unmatched = parsed.length - matched;

  let msg = `Loaded ${result.created} new, ${result.updated} updated submissions.`;
  if (unmatched) msg += ` ${unmatched} submission${unmatched > 1 ? 's' : ''} could not be linked to a character.`;
  if (warnEl) {
    warnEl.innerHTML = (matchWarnings.length ? matchWarnings.map(w => `<div class="dt-warn">${esc(w)}</div>`).join('') : '')
      + `<div class="dt-success">${esc(msg)}</div>`;
  }
  await loadAllCycles();

  return { created: result.created, updated: result.updated, unmatched, warnings: matchWarnings };
}

// ── Dev CSV Preview (localhost only — no MongoDB writes) ─────────────────────

async function processFilePreview(file) {
  const warnEl = document.getElementById('dt-warnings');
  warnEl.innerHTML = '<div class="dt-warn dt-warn-preview">&#9888; Preview mode — data is not saved to MongoDB.</div>';

  const text = await file.text();
  const { submissions: parsed, warnings } = parseDowntimeCSV(text);

  if (warnings.length) {
    warnEl.innerHTML += warnings.map(w => `<div class="dt-warn">${esc(w)}</div>`).join('');
  }
  if (!parsed.length) {
    warnEl.innerHTML += '<div class="dt-warn">No submissions found in CSV.</div>';
    return;
  }

  // Match to characters
  for (const sub of parsed) {
    const { character } = matchSubmission(sub);
    if (character) sub._character_id = character._id;
  }

  // Build synthetic submission documents (same shape as MongoDB docs)
  const devCycleId = 'dev-preview-cycle';
  const devSubs = parsed.map((sub, i) => ({
    _id: `dev-preview-${i}`,
    cycle_id: devCycleId,
    character_id: sub._character_id ? String(sub._character_id) : null,
    character_name: sub.submission.character_name,
    player_name: sub.submission.player_name,
    approval_status: 'pending',
    status: 'submitted',
    timestamp: sub.submission.timestamp,
    attended: sub.submission.attended_last_game,
    responses: mapRawToResponses(sub, characters),
    projects_resolved: [],
    merit_actions_resolved: [],
    updated_at: new Date().toISOString(),
  }));

  // Build synthetic cycle
  const devCycle = {
    _id: devCycleId,
    label: `Preview \u2014 ${file.name}`,
    game_number: 0,
    status: 'closed',
    submission_count: devSubs.length,
    loaded_at: new Date().toISOString(),
  };

  // Inject into module state (prepend so it appears first in selector)
  allCycles = [devCycle, ...allCycles.filter(c => c._id !== devCycleId)];
  activeCycle = null;
  currentCycle = devCycle;
  selectedCycleId = devCycleId;
  submissions = devSubs;

  // Rebuild cycle selector
  const sel = document.getElementById('dt-cycle-sel');
  if (sel) {
    sel.innerHTML = allCycles.map(c =>
      `<option value="${esc(c._id)}"${c._id === devCycleId ? ' selected' : ''}>${esc(c.label)}${c.status === 'active' ? ' (active)' : ''}</option>`
    ).join('');
  }

  // Render with dev data
  renderPhaseRibbon(devCycle, devSubs);
  document.getElementById('dt-export-all').style.display = devSubs.length ? '' : 'none';
  document.getElementById('dt-export-json').style.display = devSubs.length ? '' : 'none';
  document.getElementById('dt-close-cycle').style.display = 'none';
  document.getElementById('dt-cycle-status').innerHTML =
    `<span class="dt-status-badge dt-status-approved">preview</span><span class="domain-count">${devSubs.length} submissions</span>`;
  renderSnapshotPanel(devCycle);
  renderMatchSummary();
  renderSubmissionChecklist();
  renderCityOverview();
  renderInvestigations();
  renderSubmissions();
}


async function handleNewCycle() {
  const all = await import('../downtime/db.js').then(m => m.getCycles()).catch(() => []);
  const closedCount = (all || []).filter(c => c.status === 'closed').length;
  const gameNum = closedCount + 2;
  if (!confirm('Create a new prep cycle for Downtime ' + gameNum + '?')) return;
  const { createCycle } = await import('../downtime/db.js');
  await createCycle(gameNum, { status: 'prep' });
  await loadAllCycles();
}

// CHM-2: holdings detection for the maintenance audit. PT is a flat
// boolean; MCI may be multiple rows (one per cult), so collect the cult
// names for context. Mirrors the m.active !== false guard used elsewhere
// when iterating MCI merits.
function maintenanceHoldings(c) {
  const merits = c.merits || [];
  const pt = merits.some(m => m.name === 'Professional Training');
  const mciMerits = merits.filter(m => m.name === 'Mystery Cult Initiation' && m.active !== false);
  return {
    pt,
    mci: mciMerits.length > 0,
    mciCults: mciMerits.map(m => m.cult_name).filter(Boolean),
  };
}

function maintenanceEligibleChars() {
  return (characters || [])
    .filter(c => !c.retired)
    .filter(c => (c.merits || []).some(m => MAINTENANCE_MERITS.includes(m.name)))
    .sort((a, b) => sortName(a).localeCompare(sortName(b)));
}

// Patches a single audit cell ({pt|mci}) on cycle.maintenance_audit.
// Sends the whole audit object on each tick — fine at <=30 chars.
async function setMaintenanceAudit(cycle, charId, key, value) {
  const audit = { ...(cycle.maintenance_audit || {}) };
  audit[charId] = { pt: false, mci: false, ...(audit[charId] || {}), [key]: value };
  await updateCycle(cycle._id, { maintenance_audit: audit });
  cycle.maintenance_audit = audit;
  const idx = allCycles.findIndex(c => c._id === cycle._id);
  if (idx >= 0) allCycles[idx].maintenance_audit = audit;
}

function renderMaintenanceAuditPanel(cycle) {
  if (cycle.is_chapter_finale !== true) return '';
  const eligible = maintenanceEligibleChars();
  const audit = cycle.maintenance_audit || {};
  const subLabel = cycle.chapter_label ? ` <span class="dt-maintenance-sub-label">(${esc(cycle.chapter_label)})</span>` : '';

  let html = '<section class="dt-maintenance-audit">';
  html += `<h4 class="dt-maintenance-title">Chapter Finale — Maintenance Audit${subLabel}</h4>`;
  html += '<p class="dt-maintenance-sub">Tick a box once you have confirmed the player has maintained this standing merit during the chapter.</p>';

  if (eligible.length === 0) {
    html += '<p class="dt-maintenance-empty">No characters hold Professional Training or Mystery Cult Initiation.</p>';
    html += '</section>';
    return html;
  }

  html += '<table class="dt-maintenance-table"><thead><tr><th>Character</th><th>PT</th><th>MCI</th></tr></thead><tbody>';
  for (const c of eligible) {
    const id = String(c._id);
    const h = maintenanceHoldings(c);
    const row = audit[id] || {};
    const ptCell = h.pt
      ? `<input type="checkbox" class="dt-maintenance-tick" data-char-id="${esc(id)}" data-key="pt"${row.pt ? ' checked' : ''}>`
      : '';
    let mciCell = '';
    if (h.mci) {
      mciCell = `<input type="checkbox" class="dt-maintenance-tick" data-char-id="${esc(id)}" data-key="mci"${row.mci ? ' checked' : ''}>`;
      if (h.mciCults.length) {
        mciCell += `<div class="dt-maintenance-cults">${esc(h.mciCults.join(', '))}</div>`;
      }
    }
    html += `<tr><td>${esc(dropdownName(c))}</td><td class="dt-maintenance-cell">${ptCell}</td><td class="dt-maintenance-cell">${mciCell}</td></tr>`;
  }
  html += '</tbody></table></section>';
  return html;
}

// ── DT Intelligence Layer (DTIL) ─────────────────────────────────────────────
// Cycle-level synthesis surfaces mounted into #dt-cycle-intelligence (inside
// the DT Prep panel): Court Pulse (DTIL-1), Action Queue (DTIL-2/3).

function renderCycleIntelligence(cycle, subs, chars) {
  const container = document.getElementById('dt-cycle-intelligence');
  if (!container || !cycle) return;
  container.innerHTML =
    renderCourtPulsePanel(cycle, subs || [], chars || []) +
    `<div id="dt-action-queue-mount">${renderActionQueuePanel(cycle, subs || [], chars || [])}</div>`;
}

function _refreshActionQueueOnly(cycle, subs, chars) {
  const mount = document.getElementById('dt-action-queue-mount');
  if (!mount || !cycle) return;
  mount.innerHTML = renderActionQueuePanel(cycle, subs || [], chars || []);
}

function _buildCourtPulsePromptText(cycle, subs, chars) {
  const charById = new Map((chars || []).map(c => [String(c._id), c]));
  const blocks = [];
  const sorted = (subs || [])
    .filter(sub => {
      for (let n = 1; n <= 5; n++) {
        if ((sub.responses?.[`game_recount_${n}`] || '').trim()) return true;
      }
      return false;
    })
    .map(sub => ({ sub, char: charById.get(String(sub.character_id)) }))
    .sort((a, b) => sortName(a.char || {}).localeCompare(sortName(b.char || {})));

  for (const { sub, char } of sorted) {
    const lines = [];
    let count = 0;
    for (let n = 1; n <= 5; n++) {
      const txt = (sub.responses?.[`game_recount_${n}`] || '').trim();
      if (!txt) continue;
      count += 1;
      lines.push(`  ${count}. ${txt}`);
    }
    const name = (char ? dropdownName(char) : null) || sub.character_name || 'Unknown';
    blocks.push(`Highlights from ${name}:\n${lines.join('\n')}`);
  }

  if (!blocks.length) return '';

  const framing = "You are reading the game-night highlights of every player who attended the most recent game of a Vampire: The Requiem 2nd Edition LARP. Each highlight is one moment that stood out for that player. Synthesise the gestalt of the night: the dominant moods, recurring themes, social undercurrents, and any notable events that resurface across multiple players' accounts. Write a Court Pulse summary in 250 to 400 words, suitable for the Storyteller's reference. Use British English. Do not invent details not present in the highlights.";

  return `${framing}\n\n${blocks.join('\n\n')}`;
}

function renderCourtPulsePanel(cycle, subs, chars) {
  const promptText = _buildCourtPulsePromptText(cycle, subs, chars);
  const synthesis = cycle.st_court_synthesis_draft || '';
  const isEmpty = !promptText;
  const cycleId = esc(String(cycle._id));

  return `<section class="dt-court-pulse-panel" data-cycle-id="${cycleId}">
    <h3 class="dt-court-pulse-title">Court Pulse</h3>
    <p class="dt-court-pulse-hint">Build a structured prompt from every player's game-night highlights, run it through your LLM of choice, and paste the synthesis back below for cycle reference.</p>
    <div class="dt-court-pulse-prompt-block">
      <label class="dt-court-pulse-label">Prompt (copy and paste to your LLM):</label>
      ${isEmpty
        ? '<div class="dt-court-pulse-placeholder">No game highlights yet.</div>'
        : `<textarea class="dt-court-pulse-prompt-ta" readonly>${esc(promptText)}</textarea>
           <div class="dt-court-pulse-actions">
             <button type="button" class="dt-btn dt-court-pulse-copy-btn">Copy prompt</button>
             <span class="dt-court-pulse-copy-status"></span>
           </div>`
      }
    </div>
    <div class="dt-court-pulse-synthesis-block">
      <label class="dt-court-pulse-label" for="dt-court-pulse-synthesis-ta">Court Pulse synthesis (paste here):</label>
      <textarea id="dt-court-pulse-synthesis-ta" class="dt-court-pulse-synthesis-ta" placeholder="Paste the LLM's synthesis here…">${esc(synthesis)}</textarea>
      <div class="dt-court-pulse-actions">
        <button type="button" class="dt-btn dt-court-pulse-save-btn">Save synthesis</button>
        <span class="dt-court-pulse-save-status"></span>
      </div>
    </div>
  </section>`;
}

async function _handleCourtPulseCopy(btn) {
  const panel = btn.closest('.dt-court-pulse-panel');
  const ta = panel?.querySelector('.dt-court-pulse-prompt-ta');
  const status = panel?.querySelector('.dt-court-pulse-copy-status');
  if (!ta) return;
  try {
    await navigator.clipboard.writeText(ta.value);
    if (status) {
      status.textContent = 'Copied';
      setTimeout(() => { if (status) status.textContent = ''; }, 1500);
    }
  } catch {
    if (status) status.textContent = 'Copy failed';
  }
}

async function _handleCourtPulseSave(btn) {
  const panel = btn.closest('.dt-court-pulse-panel');
  const cycleId = panel?.dataset.cycleId;
  const ta = panel?.querySelector('.dt-court-pulse-synthesis-ta');
  const status = panel?.querySelector('.dt-court-pulse-save-status');
  if (!cycleId || !ta) return;
  const text = ta.value;
  if (status) status.textContent = 'Saving…';
  try {
    await updateCycle(cycleId, { st_court_synthesis_draft: text });
    if (currentCycle && String(currentCycle._id) === cycleId) {
      currentCycle.st_court_synthesis_draft = text;
    }
    const idx = allCycles.findIndex(c => String(c._id) === cycleId);
    if (idx >= 0) allCycles[idx].st_court_synthesis_draft = text;
    if (status) {
      status.textContent = 'Saved';
      setTimeout(() => { if (status) status.textContent = ''; }, 1500);
    }
  } catch {
    if (status) status.textContent = 'Save failed';
  }
}

async function _handleCourtPulseBlur(ta) {
  const panel = ta.closest('.dt-court-pulse-panel');
  const cycleId = panel?.dataset.cycleId;
  if (!cycleId) return;
  const text = ta.value;
  if (text === (currentCycle?.st_court_synthesis_draft ?? '')) return;
  const status = panel?.querySelector('.dt-court-pulse-save-status');
  _setAutosaveStatus(status, 'saving');
  try {
    await updateCycle(cycleId, { st_court_synthesis_draft: text });
    if (currentCycle && String(currentCycle._id) === cycleId) {
      currentCycle.st_court_synthesis_draft = text;
    }
    const idx = allCycles.findIndex(c => String(c._id) === cycleId);
    if (idx >= 0) allCycles[idx].st_court_synthesis_draft = text;
    _setAutosaveStatus(status, 'saved');
  } catch {
    _setAutosaveStatus(status, 'error');
  }
}

// ── DTIL-2: Action Queue ─────────────────────────────────────────────────────

const ACTION_QUEUE_STATES = ['unread', 'acknowledged', 'action_needed', 'resolved', 'ignored'];
const ACTION_QUEUE_STATE_LABELS = {
  unread:        'Unread',
  acknowledged:  'Acknowledged',
  action_needed: 'Action Needed',
  resolved:      'Resolved',
  ignored:       'Ignored',
};
let _actionQueueFilter = 'all';

function _buildActionQueueItems(cycle, subs, chars) {
  const charById = new Map((chars || []).map(c => [String(c._id), c]));
  const stateMap = cycle.action_queue_state || {};
  const items = [];
  for (const sub of subs || []) {
    for (let n = 1; n <= 5; n++) {
      const text = (sub.responses?.[`game_recount_${n}`] || '').trim();
      if (!text) continue;
      const slotIdx = n - 1;
      const key = `${sub._id}:${slotIdx}`;
      const entry = stateMap[key] || {};
      const char = charById.get(String(sub.character_id));
      items.push({
        key,
        subId: String(sub._id),
        slotIdx,
        slotN: n,
        text,
        state: ACTION_QUEUE_STATES.includes(entry.state) ? entry.state : 'unread',
        note: entry.note || '',
        charName: (char ? dropdownName(char) : null) || sub.character_name || 'Unknown',
        sortKey: char ? sortName(char) : (sub.character_name || ''),
        submittedAt: sub.submitted_at || sub.created_at || '',
      });
    }
  }
  items.sort((a, b) => {
    const t = (b.submittedAt || '').localeCompare(a.submittedAt || '');
    if (t !== 0) return t;
    const n = (a.sortKey || '').localeCompare(b.sortKey || '');
    if (n !== 0) return n;
    return a.slotIdx - b.slotIdx;
  });
  return items;
}

function _truncateForRow(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

function renderActionQueuePanel(cycle, subs, chars) {
  const items = _buildActionQueueItems(cycle, subs, chars);
  const cycleId = esc(String(cycle._id));

  const counts = { all: items.length, unread: 0, acknowledged: 0, action_needed: 0, resolved: 0, ignored: 0 };
  for (const it of items) counts[it.state] += 1;

  const filter = ACTION_QUEUE_STATES.includes(_actionQueueFilter) || _actionQueueFilter === 'all'
    ? _actionQueueFilter
    : 'all';
  const visible = filter === 'all' ? items : items.filter(it => it.state === filter);

  const filterPills = ['all', ...ACTION_QUEUE_STATES].map(f => {
    const label = f === 'all' ? 'All' : ACTION_QUEUE_STATE_LABELS[f];
    const cls = `dt-action-queue-filter-pill${filter === f ? ' active' : ''}`;
    return `<button type="button" class="${cls}" data-filter="${f}">${esc(label)} (${counts[f]})</button>`;
  }).join('');

  const rows = visible.length
    ? visible.map(it => {
        const stateOptions = ACTION_QUEUE_STATES.map(s =>
          `<option value="${s}"${s === it.state ? ' selected' : ''}>${esc(ACTION_QUEUE_STATE_LABELS[s])}</option>`
        ).join('');
        const isLong = it.text.length > 120;
        const truncated = _truncateForRow(it.text, 120);
        return `<div class="dt-action-queue-row state-${esc(it.state)}" data-key="${esc(it.key)}" data-state="${esc(it.state)}">
          <button type="button" class="dt-action-queue-char-btn" data-sub-id="${esc(it.subId)}" title="Open in DT Projects">${esc(it.charName)}</button>
          <span class="dt-action-queue-slot">Highlight ${it.slotN}</span>
          <div class="dt-action-queue-text${isLong ? ' is-long' : ''}" title="${esc(it.text)}">
            <span class="dt-action-queue-text-truncated">${esc(truncated)}</span>
            <span class="dt-action-queue-text-full">${esc(it.text)}</span>
            ${isLong ? '<button type="button" class="dt-action-queue-text-toggle">Show full</button>' : ''}
          </div>
          <select class="dt-action-queue-state-select" data-key="${esc(it.key)}">${stateOptions}</select>
          <input type="text" class="dt-action-queue-note-input" data-key="${esc(it.key)}" value="${esc(it.note)}" maxlength="140" placeholder="ST note…">
        </div>`;
      }).join('')
    : (items.length
      ? `<div class="dt-action-queue-empty">No items in this filter.</div>`
      : `<div class="dt-action-queue-empty">No highlights to triage yet.</div>`);

  return `<section class="dt-action-queue-panel" data-cycle-id="${cycleId}">
    <h3 class="dt-action-queue-title">Action Queue</h3>
    <p class="dt-action-queue-hint">One row per non-empty player highlight across the cycle. Triage each item, jot a one-line note, and filter by state to focus your processing pass.</p>
    <div class="dt-action-queue-filter-pills">${filterPills}</div>
    <div class="dt-action-queue-rows">${rows}</div>
  </section>`;
}

function _findActionQueueEntry(cycleId, key) {
  const cyc = (currentCycle && String(currentCycle._id) === cycleId)
    ? currentCycle
    : allCycles.find(c => String(c._id) === cycleId);
  return { cycle: cyc, entry: (cyc?.action_queue_state || {})[key] || { state: 'unread', note: '' } };
}

async function _persistActionQueueEntry(cycleId, key, patch) {
  const cyc = (currentCycle && String(currentCycle._id) === cycleId)
    ? currentCycle
    : allCycles.find(c => String(c._id) === cycleId);
  if (!cyc) return null;
  const map = { ...(cyc.action_queue_state || {}) };
  const existing = map[key] || { state: 'unread', note: '' };
  map[key] = { ...existing, ...patch };
  await updateCycle(cycleId, { action_queue_state: map });
  cyc.action_queue_state = map;
  if (currentCycle && String(currentCycle._id) === cycleId) currentCycle.action_queue_state = map;
  const idx = allCycles.findIndex(c => String(c._id) === cycleId);
  if (idx >= 0) allCycles[idx].action_queue_state = map;
  return map;
}

async function _handleActionQueueStateChange(select) {
  const panel = select.closest('.dt-action-queue-panel');
  const cycleId = panel?.dataset.cycleId;
  const key = select.dataset.key;
  const newState = select.value;
  if (!cycleId || !key || !ACTION_QUEUE_STATES.includes(newState)) return;
  try {
    await _persistActionQueueEntry(cycleId, key, { state: newState });
    _refreshActionQueueOnly(currentCycle, submissions, characters);
  } catch (err) {
    console.warn('Action Queue state save failed:', err);
  }
}

async function _handleActionQueueNoteSave(input) {
  const panel = input.closest('.dt-action-queue-panel');
  const cycleId = panel?.dataset.cycleId;
  const key = input.dataset.key;
  if (!cycleId || !key) return;
  const { entry } = _findActionQueueEntry(cycleId, key);
  if (entry.note === input.value) return;
  try {
    await _persistActionQueueEntry(cycleId, key, { note: input.value });
  } catch (err) {
    console.warn('Action Queue note save failed:', err);
  }
}

// ── Issue #320: Autosave ST inputs ──────────────────────────────────────────
// Four DT-Processing textareas previously had no save handler. Each blur-saves
// via partial-update merge so a Roll/approval/re-render can no longer wipe
// typed content. Status indicators reflect Saving/Saved/error state.

function _setAutosaveStatus(statusEl, state) {
  if (!statusEl) return;
  if (state === 'saving') { statusEl.dataset.state = 'saving'; statusEl.textContent = 'Saving…'; return; }
  if (state === 'saved')  { statusEl.dataset.state = 'saved';  statusEl.textContent = 'Saved ✓';
                            setTimeout(() => { if (statusEl.dataset.state === 'saved') { statusEl.textContent = ''; delete statusEl.dataset.state; } }, 1500); return; }
  if (state === 'error')  { statusEl.dataset.state = 'error';  statusEl.textContent = 'Save failed'; return; }
}

async function _handleProcFieldBlur(ta, field) {
  const key = ta.dataset.procKey;
  if (!key) return;
  const entry = _getQueueEntry(key);
  if (!entry) return;
  const newVal = ta.value.trim();
  const review = getEntryReview(entry) || {};
  if ((review[field] || '') === newVal) return;
  // Status span lives in the same .proc-proj-field wrapper as the textarea;
  // queried by proc-key + field so multiple cards on a page don't collide.
  const statusEl = document.querySelector(`.dt-autosave-status[data-proc-key="${CSS.escape(key)}"][data-field="${field}"]`);
  _setAutosaveStatus(statusEl, 'saving');
  try {
    await saveEntryReview(entry, { [field]: newVal });
    _setAutosaveStatus(statusEl, 'saved');
  } catch (err) {
    console.warn('Proc ' + field + ' autosave failed:', err);
    _setAutosaveStatus(statusEl, 'error');
  }
}
// ── /Issue #320 ──────────────────────────────────────────────────────────────

function _handleActionQueueFilter(btn) {
  const filter = btn.dataset.filter;
  if (!filter) return;
  if (filter !== 'all' && !ACTION_QUEUE_STATES.includes(filter)) return;
  _actionQueueFilter = filter;
  _refreshActionQueueOnly(currentCycle, submissions, characters);
}

function _handleActionQueueOpenSub(btn) {
  // Spec calls for navigation to the submission in DT Processing. v1: switch
  // to the projects tab; the ST scrolls to the named submission manually.
  showDtuxPhase('projects');
}

function _handleActionQueueRowExpandToggle(btn) {
  const row = btn.closest('.dt-action-queue-row');
  if (row) row.classList.toggle('expanded');
}

// DTIL-3: Auto-derive Action Queue state from responses.mechanical_flag_N on
// first read. Items with the player's mechanical flag set default to
// 'action_needed'; unflagged default to 'unread'. The derived defaults are
// written to persistence in a single batched PUT so subsequent renders read
// stable state and ST overrides remain sticky.
async function _deriveActionQueueDefaults(cycle, subs) {
  if (!cycle || !Array.isArray(subs) || !subs.length) return;
  const stateMap = cycle.action_queue_state || {};
  const updates = {};
  for (const sub of subs) {
    for (let n = 1; n <= 5; n++) {
      const text = (sub.responses?.[`game_recount_${n}`] || '').trim();
      if (!text) continue;
      const key = `${sub._id}:${n - 1}`;
      if (stateMap[key]) continue; // existing entry wins, idempotent
      const flagged = sub.responses?.[`mechanical_flag_${n}`] === true;
      updates[key] = { state: flagged ? 'action_needed' : 'unread', note: '' };
    }
  }
  if (!Object.keys(updates).length) return; // no-op
  const newMap = { ...stateMap, ...updates };
  cycle.action_queue_state = newMap;
  if (currentCycle && String(currentCycle._id) === String(cycle._id)) {
    currentCycle.action_queue_state = newMap;
  }
  const idx = allCycles.findIndex(c => String(c._id) === String(cycle._id));
  if (idx >= 0) allCycles[idx].action_queue_state = newMap;
  try {
    await updateCycle(cycle._id, { action_queue_state: newMap });
  } catch (err) {
    console.warn('Action Queue default derivation persistence failed:', err);
  }
}

// ── DTIL-4: Territory Pulse ──────────────────────────────────────────────────

function _feedTerrIdsForSub(sub) {
  if (sub?.feeding_review?.pool_status === 'no_feed') return [];
  let parsed = {};
  try { parsed = JSON.parse(sub?.responses?.feeding_territories || '{}'); } catch { return []; }
  const ids = new Set();
  for (const [slug, val] of Object.entries(parsed)) {
    if (!val || val === 'none' || val === 'Not feeding here') continue;
    ids.add(slug); // keys are already slugs; resolveTerrId(OID→slug) is wrong direction
  }
  return [...ids];
}

// Resolve a TERRITORY_DATA entry's slug to the Mongo _id-string. Returns null
// if the territory has no Mongo doc yet. Cycle object maps (confirmed_ambience,
// discipline_profile, territory_pulse) are keyed by _id-string per ADR-002.
function _terrOidForSlug(slug) {
  const cached = (cachedTerritories || []).find(t => t.slug === slug);
  return cached ? String(cached._id) : null;
}

function _territoryAmbienceLabel(territory) {
  const oid = _terrOidForSlug(territory.slug);
  const confirmed = oid ? currentCycle?.confirmed_ambience?.[oid]?.ambience : undefined;
  if (confirmed) return confirmed;
  const cached = (cachedTerritories || []).find(t => t.slug === territory.slug || t.name === territory.name);
  return cached?.ambience || territory.ambience || 'unknown';
}

function _buildTerritoryPulsePromptText(cycle, territory, subs, charById) {
  const ambience = _territoryAmbienceLabel(territory);
  const oid = _terrOidForSlug(territory.slug);
  const profile  = (oid && cycle?.discipline_profile?.[oid]) || {};

  // Task 2: threshold filter — only disciplines used 2+ times reach the prompt
  const discsUsed = Object.entries(profile)
    .filter(([, c]) => c >= 2)
    .sort(([a], [b]) => a.localeCompare(b));

  const feeders = [];
  for (const sub of subs || []) {
    // _feedTerrIdsForSub returns TERRITORY_DATA slugs; territory.slug is the
    // TERRITORY_DATA slug too. Slug-to-slug comparison is correct here.
    if (!_feedTerrIdsForSub(sub).includes(territory.slug)) continue;
    const char = charById.get(String(sub.character_id));
    const name = (char ? dropdownName(char) : null) || sub.character_name || 'Unknown';
    const method = sub.responses?._feed_method || sub.responses?.feed_method || '';
    feeders.push({ name, method, sortKey: char ? sortName(char) : (sub.character_name || '') });
  }
  feeders.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // Task 3: feeder cap / count / crowding gap
  // Cap is ambience-derived — same source as the Overfeeding column in buildAmbienceData.
  const feederCap   = AMBIENCE_FEEDING_TOLERANCE[ambience] ?? 6;
  const feederCount = feeders.length;
  const crowdingGap = feederCount - feederCap;
  const crowdingStr = crowdingGap > 0 ? `+${crowdingGap}` : String(crowdingGap);

  // Task 5: aggregate influence by covenant; suppress negative names at assembly time
  const covenantPos = {}, covenantNeg = {};
  for (const sub of subs || []) {
    let infObj = {};
    try { infObj = JSON.parse(sub.responses?.influence_spend || '{}'); } catch { infObj = {}; }
    for (const [k, v] of Object.entries(infObj)) {
      if (resolveTerrId(k) !== territory.slug) continue;
      const val = Number(v) || 0;
      if (!val) continue;
      const char = charById.get(String(sub.character_id));
      const cov = char?.covenant || 'Unknown';
      if (val > 0) {
        if (!covenantPos[cov]) covenantPos[cov] = { total: 0, named: [] };
        covenantPos[cov].total += val;
        if (val >= 10) {
          const name = (char ? dropdownName(char) : null) || sub.character_name || 'Unknown';
          covenantPos[cov].named.push(`${name}${char?.clan ? ', ' + char.clan : ''} (+${val})`);
        }
      } else {
        if (!covenantNeg[cov]) covenantNeg[cov] = { total: 0 };
        covenantNeg[cov].total += val;
      }
    }
  }

  const _influenceWeight = absTotal => absTotal >= 40 ? 'enormous' : absTotal >= 15 ? 'significant' : absTotal >= 5 ? 'modest' : 'light';

  const infPosLines = Object.entries(covenantPos).map(([cov, { total, named }]) => {
    const base = `  - ${cov}: total +${total} (weight: ${_influenceWeight(total)})`;
    return named.length ? base + '\n    Named individuals (10+): ' + named.join('; ') : base;
  });
  const infNegLines = Object.entries(covenantNeg).map(([cov, { total }]) =>
    `  - ${cov}: total ${total} (weight: ${_influenceWeight(Math.abs(total))})`
  );

  // Task 6: split exceptional ambience by direction — positive named, negative count only
  const exceptionalAmbPos = [];
  let exceptionalAmbNegCount = 0;
  for (const sub of subs || []) {
    for (const [pIdx, proj] of (sub.projects_resolved || []).entries()) {
      if (proj?.pool_status !== 'validated') continue;
      if (!proj?.roll?.exceptional) continue;
      const actionType = proj.action_type_override || proj.action_type;
      if (!_isAmbienceAction(actionType)) continue;
      if (_resolveProjectTerritory(sub, pIdx) !== territory.slug) continue;
      const direction = _ambienceDirection(actionType, pIdx + 1, sub.responses);
      if (direction === 'increase') {
        const char = charById.get(String(sub.character_id));
        const name = (char ? dropdownName(char) : null) || sub.character_name || 'Unknown';
        exceptionalAmbPos.push(`  - ${[name, char?.clan, char?.covenant].filter(Boolean).join(', ')}`);
      } else {
        exceptionalAmbNegCount++;
      }
    }
  }

  // Task 4: new framing — rumours directive removed; beat order encoded
  const framing = `You are writing a Territory Pulse for ${territory.name} in a Vampire: The Requiem 2e LARP.\n\nThe pulse is written to the vampires who fed in this territory this cycle. It gives them the lived sense of the place after a month of activity. Use British English. Do not use em-dashes. Do not invent specific characters or events not present in the inputs. 100 to 200 words.\n\nCover, in order:\n1. Blood quality and feeding pressure. Use the ambience state and the crowding gap to calibrate how the blood tastes and how crowded the hunting felt.\n2. Discipline residue in mortal behaviour, only for disciplines that crossed the threshold (used twice or more). If none crossed, skip this beat entirely.\n3. Covenant fingerprints and direct hands. Describe each contributing covenant by overall weight (enormous, significant, modest, light). Name named-positive-individuals directly as visible points of their covenant's effort. The negative side is described by covenant only, never named. Direct hands (exceptional ambience project successes) on the positive side are named openly as seen doing the work. Direct hands on the negative side are not named; the territory feels the damage without knowing the hand.`;

  const lines = [
    framing,
    '',
    `Territory: ${territory.name}`,
    `Current ambience: ${ambience}`,
    `Feeder cap:    ${feederCap}`,
    `Feeder count:  ${feederCount}`,
    `Crowding gap:  ${crowdingStr} (positive = overcrowded, negative = underfed, zero = at capacity)`,
    '',
    discsUsed.length ? 'Disciplines used twice or more this cycle:' : null,
    discsUsed.length
      ? discsUsed.map(([d, c]) => `  - ${d} (used ${c} times)`).join('\n')
      : null,
    discsUsed.length ? '' : null,
    discsUsed.length ? 'Territorial vibe effects (disciplines used twice or more — weave these into the prose; ignore disciplines used only once):' : null,
    discsUsed.length
      ? discsUsed.map(([d]) => _DISCIPLINE_TERRITORIAL_EFFECTS[d] ? `  - ${d}: ${_DISCIPLINE_TERRITORIAL_EFFECTS[d]}` : null).filter(Boolean).join('\n') || '  None with known territorial effects.'
      : null,
    '',
    'Players who fed here this cycle:',
    feeders.length
      ? feeders.map(f => `  - ${f.name}${f.method ? ` (${f.method})` : ''}`).join('\n')
      : '  None recorded this cycle.',
    '',
    'Covenant fingerprints — Positive:',
    infPosLines.length ? infPosLines.join('\n') : '  None this cycle.',
    '',
    'Covenant fingerprints — Negative (no names — covenant only):',
    infNegLines.length ? infNegLines.join('\n') : '  None this cycle.',
    '',
    'Direct hands — Positive (named):',
    exceptionalAmbPos.length ? exceptionalAmbPos.join('\n') : '  None this cycle.',
    '',
    'Direct hands — Negative (unnamed — count only):',
    exceptionalAmbNegCount > 0
      ? `  ${exceptionalAmbNegCount} negative exceptional ambience success${exceptionalAmbNegCount === 1 ? '' : 'es'} — the territory carries the damage without a visible hand.`
      : '  None this cycle.',
  ].filter(l => l != null);
  return lines.join('\n');
}

function renderTerritoryPulsePanel(cycle, subs, chars) {
  if (!cycle) return '';
  const charById = new Map((chars || []).map(c => [String(c._id), c]));
  const pulseMap = cycle.territory_pulse || {};

  let h = `<div class="proc-disc-header"><span class="proc-amb-title">Territory Pulse</span></div>`;
  h += `<div class="dt-territory-pulse-list">`;
  for (const td of TERRITORY_DATA) {
    const promptText = _buildTerritoryPulsePromptText(cycle, td, subs || [], charById);
    // Cycle pulseMap is _id-keyed per ADR-002; resolve TERRITORY_DATA slug to _id.
    const oid = _terrOidForSlug(td.slug);
    const stored = (oid && pulseMap[oid]) || {};
    const draft = stored.draft || '';
    const ambience = _territoryAmbienceLabel(td);
    const lastEdited = stored.last_edited_at
      ? new Date(stored.last_edited_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    // data-terr-id carries the _id-string so save handlers post the correct FK.
    const terrAttr = oid || td.slug;
    h += `<div class="dt-territory-pulse-row" data-terr-id="${esc(terrAttr)}" data-cycle-id="${esc(String(cycle._id))}">`;
    h += `<div class="dt-territory-pulse-row-head">`;
    h += `<span class="dt-territory-pulse-name">${esc(td.name)}</span>`;
    h += `<span class="dt-territory-pulse-ambience">Ambience: ${esc(ambience)}</span>`;
    h += `<button type="button" class="dt-territory-pulse-toggle-btn" data-terr-id="${esc(terrAttr)}">Show prompt</button>`;
    h += `</div>`;
    h += `<div class="dt-territory-pulse-prompt-block" data-terr-id="${esc(terrAttr)}" hidden>`;
    h += `<textarea class="dt-territory-pulse-prompt-ta" readonly>${esc(promptText)}</textarea>`;
    h += `<div class="dt-territory-pulse-actions">`;
    h += `<button type="button" class="dt-btn dt-territory-pulse-copy-btn" data-terr-id="${esc(terrAttr)}">Copy prompt</button>`;
    h += `<span class="dt-territory-pulse-copy-status"></span>`;
    h += `</div></div>`;
    h += `<label class="dt-territory-pulse-draft-lbl">Synthesis draft</label>`;
    h += `<textarea class="dt-territory-pulse-draft-ta" data-terr-id="${esc(terrAttr)}" placeholder="Paste the LLM's pulse here…">${esc(draft)}</textarea>`;
    h += `<div class="dt-territory-pulse-actions">`;
    h += `<button type="button" class="dt-btn dt-territory-pulse-save-btn" data-terr-id="${esc(terrAttr)}">Save</button>`;
    h += `<span class="dt-territory-pulse-save-status">${lastEdited ? 'Last saved ' + esc(lastEdited) : ''}</span>`;
    h += `</div>`;
    h += `</div>`;
  }
  h += `</div>`;
  return h;
}

function _handleTerritoryPulseToggle(btn) {
  const terrId = btn.dataset.terrId;
  if (!terrId) return;
  const block = document.querySelector(`.dt-territory-pulse-prompt-block[data-terr-id="${terrId}"]`);
  if (!block) return;
  const wasHidden = block.hasAttribute('hidden');
  if (wasHidden) block.removeAttribute('hidden');
  else block.setAttribute('hidden', '');
  btn.textContent = wasHidden ? 'Hide prompt' : 'Show prompt';
}

async function _handleTerritoryPulseCopy(btn) {
  const terrId = btn.dataset.terrId;
  const block = document.querySelector(`.dt-territory-pulse-prompt-block[data-terr-id="${terrId}"]`);
  const ta = block?.querySelector('.dt-territory-pulse-prompt-ta');
  const status = block?.querySelector('.dt-territory-pulse-copy-status');
  if (!ta) return;
  try {
    await navigator.clipboard.writeText(ta.value);
    if (status) {
      status.textContent = 'Copied';
      setTimeout(() => { if (status) status.textContent = ''; }, 1500);
    }
  } catch {
    if (status) status.textContent = 'Copy failed';
  }
}

async function _handleTerritoryPulseSave(btn) {
  const terrId = btn.dataset.terrId;
  const row = btn.closest('.dt-territory-pulse-row');
  const cycleId = row?.dataset.cycleId;
  const ta = row?.querySelector(`.dt-territory-pulse-draft-ta[data-terr-id="${terrId}"]`);
  const status = row?.querySelector('.dt-territory-pulse-save-status');
  const promptTa = row?.querySelector('.dt-territory-pulse-prompt-ta');
  if (!terrId || !cycleId || !ta) return;
  if (status) status.textContent = 'Saving…';
  try {
    const cyc = (currentCycle && String(currentCycle._id) === cycleId)
      ? currentCycle
      : allCycles.find(c => String(c._id) === cycleId);
    const map = { ...(cyc?.territory_pulse || {}) };
    map[terrId] = {
      prompt_snapshot: promptTa?.value || '',
      draft:           ta.value,
      last_edited_at:  new Date().toISOString(),
    };
    await updateCycle(cycleId, { territory_pulse: map });
    if (cyc) cyc.territory_pulse = map;
    if (currentCycle && String(currentCycle._id) === cycleId) currentCycle.territory_pulse = map;
    const idx = allCycles.findIndex(c => String(c._id) === cycleId);
    if (idx >= 0) allCycles[idx].territory_pulse = map;
    if (status) {
      status.textContent = 'Saved';
      setTimeout(() => {
        if (status) {
          const lastEdited = new Date(map[terrId].last_edited_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          status.textContent = 'Last saved ' + lastEdited;
        }
      }, 1500);
    }
  } catch {
    if (status) status.textContent = 'Save failed';
  }
}

function renderPrepPanel(cycle) {
  const panel = document.getElementById('dt-prep-panel');
  if (!panel) return;
  if (!cycle) { panel.style.display = 'none'; return; }
  // DTUX-1: visibility is now driven by the phase ribbon (showDtuxPhase),
  // not cycle.status. The panel always renders its content; show/hide is
  // handled by the ribbon's tab click.
  if (_dtuxActiveTab && _dtuxActiveTab !== 'prep') {
    panel.style.display = 'none';
  }

  const autoVal = cycle.auto_open_at ? isoToLocalInput(cycle.auto_open_at) : '';
  const deadlineVal = cycle.deadline_at ? isoToLocalInput(cycle.deadline_at) : '';
  const finaleChecked = cycle.is_chapter_finale ? ' checked' : '';


  panel.innerHTML =
    renderManualOpenBanner(cycle) +
    `<div class="dt-prep-grid">` +
    `<div class="dt-prep-field"><label class="dt-lbl">Auto-Open Date/Time</label>` +
    `<input type="datetime-local" id="dt-auto-open-input" class="dt-deadline-input" value="${esc(autoVal)}"></div>` +
    `<div class="dt-prep-field"><label class="dt-lbl">Deadline Date/Time</label>` +
    `<input type="datetime-local" id="dt-prep-deadline-input" class="dt-deadline-input" value="${esc(deadlineVal)}"></div>` +
    `<div class="dt-prep-field"><label class="dt-lbl" style="display:flex;align-items:center;gap:.5rem;cursor:pointer;">` +
    `<input type="checkbox" id="dt-chapter-finale-input"${finaleChecked}><span>Chapter Finale</span></label></div>` +
    `</div>` +
    `<div class="dt-prep-actions">` +
    renderSignoffButton('prep', cycle) +
    renderManualOpenButton(cycle) +
    `</div>` +
    renderMaintenanceAuditPanel(cycle) +
    `<div id="dt-cycle-intelligence" class="dt-cycle-intelligence"></div>`;

  // DTIL: populate Court Pulse / Action Queue intelligence layer. First call
  // (before subs load) renders empty placeholders; loadCycleById re-renders
  // after submissions arrive.
  renderCycleIntelligence(cycle, submissions, characters);

  document.getElementById('dt-auto-open-input')?.addEventListener('change', async e => {
    const val = e.target.value;
    const iso = val ? new Date(val).toISOString() : null;
    await updateCycle(cycle._id, { auto_open_at: iso });
    const idx = allCycles.findIndex(c => c._id === cycle._id);
    if (idx >= 0) allCycles[idx].auto_open_at = iso;
    cycle.auto_open_at = iso;   // mutate closure ref so a later renderPrepPanel(cycle) keeps the value (mirrors chapter-finale handler)
    renderPhaseRibbon(allCycles[idx] || cycle, []);
  });

  document.getElementById('dt-prep-deadline-input')?.addEventListener('change', async e => {
    const val = e.target.value;
    await updateCycle(cycle._id, { deadline_at: val ? new Date(val).toISOString() : null });
    const idx = allCycles.findIndex(c => c._id === cycle._id);
    if (idx >= 0) allCycles[idx].deadline_at = val ? new Date(val).toISOString() : null;
  });

  document.getElementById('dt-chapter-finale-input')?.addEventListener('change', async e => {
    const val = e.target.checked;
    await updateCycle(cycle._id, { is_chapter_finale: val });
    const idx = allCycles.findIndex(c => c._id === cycle._id);
    if (idx >= 0) allCycles[idx].is_chapter_finale = val;
    cycle.is_chapter_finale = val;
    renderPrepPanel(cycle);
  });

  panel.querySelectorAll('.dt-maintenance-tick').forEach(cb => {
    cb.addEventListener('change', async e => {
      const charId = cb.dataset.charId;
      const key = cb.dataset.key;
      if (!charId || !key) return;
      await setMaintenanceAudit(cycle, charId, key, e.target.checked);
    });
  });

  // DTUX-1: gate button "Open City & Feeding Phase →" replaced by the sign-off
  // button rendered above; the per-tab click handler in initDowntimeView
  // dispatches sign-off clicks via [data-signoff-phase].
}

async function handleCloseCycle() {
  if (!selectedCycleId) return;
  const cycle = allCycles.find(c => c._id === selectedCycleId);
  if (!cycle || cycle.status !== 'active') return;
  if (!confirm(`Close cycle "${cycle.label || 'Unnamed'}"? This cannot be undone.`)) return;
  await closeCycle(selectedCycleId);
  await loadAllCycles();
}

async function handleOpenGamePhase() {
  if (!selectedCycleId) return;
  const cycle = allCycles.find(c => c._id === selectedCycleId);
  if (!cycle || cycle.status !== 'closed') return;
  // #1003: warn if flipping an empty cycle to game while another live cycle
  // holds submissions (feeding pulls from the game-phase cycle).
  const warn = await zeroSubmissionFlipWarning(
    cycle, allCycles, async id => (await getSubmissionsForCycle(id)).length);
  if (warn && !confirm(zeroSubmissionFlipMessage(warn))) return;
  // #1002: state which session these submissions feed so the right cycle is opened.
  const feeds = cycleFeedsLabel(cycle);
  const openMsg = `Open game phase for "${cycle.label || 'Unnamed'}"${feeds ? ` (${feeds})` : ''}? `
    + `Players will run their feeding rolls against the downtimes submitted in this cycle.`;
  if (!confirm(openMsg)) return;
  await openGamePhase(selectedCycleId);
  const idx = allCycles.findIndex(c => c._id === selectedCycleId);
  if (idx >= 0) allCycles[idx].status = 'game';
  await loadCycleById(selectedCycleId);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Processing Mode (feature.43) ────────────────────────────────────────────

/**
 * Issues #210 + #217 — shared target-picker composer. Resolves the
 * structured target shape (`<prefix>_target_type` / `_target_value` /
 * `_target_terr` / `_target_other`) into a human-readable string for
 * the admin action card. Used by:
 *   - Project per-slot target (prefix = `project_${slot}`)
 *   - Sphere per-slot target (prefix = `sphere_${idx + 1}`)
 *
 * Sphere's target_value can be a JSON array (multi-select character
 * checkboxes at downtime-form.js:766-769); project's target_value is
 * single but pre-DTFP-6 drafts stored single IDs as JSON arrays.
 * Branch on the bracket prefix to disambiguate.
 *
 * Returns '' for empty / unrecognised targets so callers can use a
 * truthy check to gate the render row.
 */
function _composeTargetString(resp, prefix, chars) {
  const tType  = resp[`${prefix}_target_type`]  || '';
  const tValue = resp[`${prefix}_target_value`] || '';
  const tTerr  = resp[`${prefix}_target_terr`]  || '';
  const tOther = resp[`${prefix}_target_other`] || '';
  if (tType === 'character' && tValue) {
    let ids = [];
    if (typeof tValue === 'string' && tValue.startsWith('[')) {
      try { const a = JSON.parse(tValue); if (Array.isArray(a)) ids = a; }
      catch { ids = []; }
    } else { ids = [tValue]; }
    ids = ids.map(String).filter(Boolean);
    if (!ids.length) return '';
    const names = ids.map(id => {
      const c = chars.find(ch => String(ch._id) === String(id));
      return c ? dropdownName(c) : `${id} (unresolved)`;
    });
    return `Character${ids.length > 1 ? 's' : ''}: ${names.join(', ')}`;
  } else if (tType === 'territory' && tTerr) {
    return `Territory: ${tTerr}`;
  } else if (tType === 'own_merit' && tValue) {
    // merit_key is `'Name|qualifier'` — split for readability.
    const [mName, mQual] = String(tValue).split('|');
    return `Own merit: ${mQual ? `${mName} (${mQual})` : mName}`;
  } else if (tType === 'other' && tOther) {
    return `Other: ${tOther}`;
  }
  return '';
}

/**
 * Resolve a player-submitted CHARACTER target into typeahead keys (sortName).
 * Mirrors the `character` branch of _composeTargetString, but returns an array
 * of sortName(c) keys for seeding the processing target pickers (issue #586).
 * Returns [] for non-character targets or unresolved/retired ids — the typeahead
 * is keyed by sortName(c), so display strings / _ids would never match a chip.
 */
// Map a stored character-id value (single id, or a JSON array of ids) to typeahead
// keys (sortName), dropping unresolved/retired. Shared by the target picker (#586)
// and Connected Characters (#589).
function _composeCharKeysFromIds(rawVal, chars) {
  if (!rawVal) return [];
  let ids = [];
  if (typeof rawVal === 'string' && rawVal.startsWith('[')) {
    try { const a = JSON.parse(rawVal); if (Array.isArray(a)) ids = a; }
    catch { ids = []; }
  } else if (Array.isArray(rawVal)) {
    ids = rawVal;
  } else {
    ids = [rawVal];
  }
  ids = ids.map(String).filter(Boolean);
  const keys = [];
  for (const id of ids) {
    const c = chars.find(ch => String(ch._id) === String(id));
    if (c && !c.retired) keys.push(sortName(c));
  }
  return keys;
}

function _composeTargetCharKeys(resp, prefix, chars) {
  const tType  = resp[`${prefix}_target_type`]  || '';
  const tValue = resp[`${prefix}_target_value`] || '';
  if (tType !== 'character' || !tValue) return [];
  return _composeCharKeysFromIds(tValue, chars);
}

// #589: player Connected Characters for a project slot -> sortName keys.
function _composeConnectedCharKeys(resp, prefix, chars) {
  return _composeCharKeysFromIds(resp[`${prefix}_connected_chars`], chars);
}

/**
 * Aggregate all actions from all submissions into a flat, phase-tagged queue.
 * Each entry: { key, subId, charName, phase, phaseNum, actionType, label, description, source, actionIdx, poolPlayer }
 */
function buildProcessingQueue(subs) {
  const queue = [];
  // Per-submission set of deleted action key-parts (e.g. 'proj:0', 'feeding')
  const _deletedKeysBySub = new Map(
    subs.map(s => [s._id, new Set((s.st_review?.deleted_action_keys || []).map(k => `${s._id}:${k}`))])
  );

  // ── JDT-5: index of (subId:slot) → { joint, role } for active joints on
  // the cycle. Used in the per-submission project iteration to (a) route the
  // slot's queue entry to the Joint Projects phase, and (b) attach joint
  // metadata so the phase render can group participant entries by joint_id.
  const jointSlotPairs = new Map();
  for (const j of (currentCycle?.joint_projects || [])) {
    if (j.cancelled_at) continue;
    if (j.lead_submission_id && j.lead_project_slot) {
      jointSlotPairs.set(`${String(j.lead_submission_id)}:${j.lead_project_slot}`, { joint: j, role: 'lead' });
    }
    for (const p of (j.participants || [])) {
      if (p.decoupled_at) continue;
      if (p.submission_id && p.project_slot) {
        jointSlotPairs.set(`${String(p.submission_id)}:${p.project_slot}`, { joint: j, role: 'support' });
      }
    }
  }

  for (const sub of subs) {
    const raw = sub._raw || {};
    const resp = sub.responses || {};
    const { char: _subChar, charName } = resolveSubChar(sub, '?');

    // ── Travel Review (Step 1 — phaseNum -1 sorts before sorcery) ──
    const travelDesc = (raw.submission?.narrative?.travel_description || resp.travel || '').trim();
    if (travelDesc) {
      const shortDesc = travelDesc.length > 80 ? travelDesc.slice(0, 77) + '\u2026' : travelDesc;
      queue.push({
        key: `${sub._id}:travel`,
        subId: sub._id,
        charName,
        phase: 'travel',
        phaseNum: -1,
        actionType: 'travel',
        label: 'Travel',
        description: shortDesc,
        source: 'travel',
        actionIdx: 0,
        poolPlayer: '',
        travelDesc,
      });
    }

    // ── Sorcery (resolve_first) ──
    const sorcCount = parseInt(resp['sorcery_slot_count'] || '1', 10);
    // Tradition detection: check character disciplines for Cruac or Theban
    const sorcChar = _subChar || charMap.get((sub.character_name || '').toLowerCase().trim());
    const discs = sorcChar?.disciplines || {};
    let tradition = 'Unknown';
    if (discs.Cruac) tradition = 'Cruac';
    else if (discs.Theban) tradition = 'Theban';

    for (let n = 1; n <= sorcCount; n++) {
      const rite = resp[`sorcery_${n}_rite`];
      if (!rite) continue;
      const targetsText = normaliseSorceryTargets(resp[`sorcery_${n}_targets`]);
      const notes       = resp[`sorcery_${n}_notes`]   || '';
      let desc = rite;
      if (targetsText) desc += ` — targets: ${targetsText}`;
      if (notes)       desc += ` — ${notes}`;
      queue.push({
        key: `${sub._id}:sorcery:${n}`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[0],
        phaseNum: 0,
        actionType: 'resolve_first',
        label: `${tradition}: ${rite}`,
        description: desc,
        source: 'sorcery',
        actionIdx: n,
        poolPlayer: resp[`sorcery_${n}_pool_expr`] || '',
        riteName: rite,
        tradition,
        targetsText,
        mandragora: resp[`sorcery_${n}_mandragora`] === 'yes',
      });
    }

    // Hoist primary feed pool label so the rote queue entry can inherit it (fix.725)
    const _feedMethod      = resp['_feed_method'] || '';
    const _feedDisc        = resp['_feed_disc']   || '';
    const _feedCustomAttr  = resp['_feed_custom_attr']  || '';
    const _feedCustomSkill = resp['_feed_custom_skill'] || '';
    const _feedCustomDisc  = resp['_feed_custom_disc']  || '';
    const _feedDesc        = sub._raw?.feeding?.method || resp['feeding_description'] || '';
    const _feedTrunc       = _feedDesc.length > 40 ? _feedDesc.slice(0, 40) + '…' : _feedDesc;
    const _feedBaseLabel   = FEED_METHOD_LABELS_MAP[_feedMethod] || _feedMethod;
    const _feedMethodLabel = _feedMethod === 'other' && _feedTrunc
      ? _feedTrunc
      : (_feedTrunc && _feedTrunc !== _feedBaseLabel
          ? `${_feedBaseLabel} — ${_feedTrunc}`
          : _feedBaseLabel);
    const feedPoolLabel = _feedMethod === 'other' && (_feedCustomAttr || _feedCustomSkill)
      ? [_feedCustomAttr, _feedCustomSkill, _feedCustomDisc || _feedDisc].filter(Boolean).join(' + ')
      : [_feedMethodLabel, _feedDisc].filter(Boolean).join(' + ');

    // ── Feeding (all submissions get an entry; no-method submissions show as undeclared) ──
    {
      const feedMethod      = resp['_feed_method'] || '';
      const feedDisc        = resp['_feed_disc']   || '';
      const feedCustomAttr  = resp['_feed_custom_attr']  || '';
      const feedCustomSkill = resp['_feed_custom_skill'] || '';
      const feedCustomDisc  = resp['_feed_custom_disc']  || '';
      const feedDesc        = sub._raw?.feeding?.method || resp['feeding_description'] || '';
      const feedSpec        = resp['_feed_spec']   || '';
      // Issue #197 / audit #198 — `_feed_rote` was dropped by dt-form.22.
      // Derive rote presence from any project slot's action being `'rote'`
      // (or legacy `'feed'`) instead of reading the orphan key. ST review
      // override remains canonical (st_review.feeding_rote takes precedence
      // when explicitly set by the ST).
      const feedRote        = sub.st_review?.feeding_rote
                              || [1,2,3,4].some(n => {
                                   const a = resp[`project_${n}_action`];
                                   return a === 'rote' || a === 'feed';
                                 })
                              || false;
      let   feedTerrs   = {};
      try { feedTerrs = JSON.parse(resp['feeding_territories'] || '{}'); } catch { feedTerrs = {}; }
      const primaryTerr = Object.keys(feedTerrs).find(k => feedTerrs[k] === 'feeding_rights' || feedTerrs[k] === 'resident')
                       || Object.keys(feedTerrs).find(k => feedTerrs[k] === 'poaching' || feedTerrs[k] === 'poacher')
                       || Object.keys(feedTerrs).find(k => feedTerrs[k] && feedTerrs[k] !== 'none')
                       || '';
      const truncDesc = feedDesc.length > 40 ? feedDesc.slice(0, 40) + '\u2026' : feedDesc;
      let methodLabel = '';
      if (feedMethod) {
        const baseLabel = FEED_METHOD_LABELS_MAP[feedMethod] || feedMethod;
        if (feedMethod === 'other' && truncDesc) {
          methodLabel = truncDesc;
        } else if (truncDesc && truncDesc !== baseLabel) {
          methodLabel = `${baseLabel} \u2014 ${truncDesc}`;
        } else {
          methodLabel = baseLabel;
        }
      }
      // For "other" method, use the player's custom attr/skill/disc as the pool label
      const poolLabel = feedPoolLabel; // hoisted above the feeding block; same computation
      queue.push({
        key: `${sub._id}:feeding`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[1],
        phaseNum: 1,
        actionType: 'feeding',
        label: 'Feeding',
        description: poolLabel || 'No feeding method declared',
        source: 'feeding',
        actionIdx: 0,
        poolPlayer: poolLabel,
        feedDesc,
        feedMethod,
        feedMethodLabel: methodLabel,
        feedDisc,
        feedSpec,
        feedRote,
        feedTerrs,
        primaryTerr,
        noMethod: !feedMethod,
      });
    }

    // ── Projects ──
    let projects = raw.projects || [];
    if (!projects.length) {
      for (let n = 1; n <= 4; n++) {
        const action = resp[`project_${n}_action`];
        if (!action) continue;
        projects.push({
          action_type: action,
          desired_outcome: resp[`project_${n}_outcome`] || '',
          detail: resp[`project_${n}_description`] || '',
          primary_pool: resp[`project_${n}_pool_expr`] ? { expression: resp[`project_${n}_pool_expr`] } : null,
        });
      }
    }
    projects.forEach((proj, idx) => {
      const actionType = proj.action_type || 'misc';
      const slot = idx + 1; // 1-indexed response key

      // ── Shared field extraction (used by both rote-feed and regular projects) ──
      const projDescription = resp[`project_${slot}_description`] || '';

      let projCastResolved = '';
      try {
        const castArr = JSON.parse(resp[`project_${slot}_cast`] || '[]');
        if (Array.isArray(castArr) && castArr.length) {
          projCastResolved = castArr.map(id => {
            const c = characters.find(ch => String(ch._id) === String(id));
            return c ? dropdownName(c) : id;
          }).join(', ');
        } else {
          projCastResolved = resp[`project_${slot}_cast`] || '';
        }
      } catch {
        projCastResolved = resp[`project_${slot}_cast`] || '';
      }

      let projMeritsResolved = '';
      try {
        const meritsArr = JSON.parse(resp[`project_${slot}_merits`] || '[]');
        if (Array.isArray(meritsArr) && meritsArr.length) {
          projMeritsResolved = meritsArr.map(m => {
            const parts = m.split('|');
            const name = parts[0] || m;
            const qual = parts[1] || '';
            return qual ? `${name} (${qual})` : name;
          }).join(', ');
        } else {
          projMeritsResolved = resp[`project_${slot}_merits`] || '';
        }
      } catch {
        projMeritsResolved = resp[`project_${slot}_merits`] || '';
      }

      // ── Rote feed project — render in Feed phase (phaseNum 1), after standard feeding ──
      if (actionType === 'feed' || actionType === 'rote') {
        const feedMethod2 = resp[`project_${slot}_feed_method2`] || '';
        const method2Label = feedMethod2 ? `Secondary method: ${feedMethod2}` : '';
        const descWithMethod = [projDescription, method2Label].filter(Boolean).join(' \u2014 ');
        queue.push({
          key: `${sub._id}:proj:${idx}`,
          subId: sub._id,
          charName,
          phase: PHASE_NUM_TO_LABEL[1],
          phaseNum: 1,
          actionType: 'feed',
          originalActionType: actionType,
          label: 'Rote Feed',
          description: descWithMethod || proj.desired_outcome || '',
          source: 'project',
          actionIdx: idx,
          projSlot: slot,
          poolPlayer: proj.primary_pool?.expression || resp[`project_${slot}_pool_expr`] || feedPoolLabel,
          projTitle:       resp[`project_${slot}_title`]     || '',
          projOutcome:     proj.desired_outcome || resp[`project_${slot}_outcome`] || '',
          projDescription: descWithMethod,
          projCast:        projCastResolved,
          projMerits:      projMeritsResolved,
          projTerritory:   resp[`project_${slot}_territory`] || '',
        });
        return;
      }

      // ST recategorisation override — changes phase and label without altering player data
      const projReview = (sub.projects_resolved || [])[idx] || {};
      let effectiveActionType = projReview.action_type_override || actionType;

      // Canonical ambience normalisation: all ambience project entries use
      // actionType='ambience_change'; direction is stamped as ambienceDir.
      // Legacy DB entries stored the split types directly — normalise those too.
      let ambienceDir = null;
      if (_AMBIENCE_ACTION_TYPES.has(effectiveActionType)) {
        const projDir = resp[`project_${slot}_ambience_direction`] || resp[`project_${slot}_ambience_dir`] || '';
        if (effectiveActionType === 'ambience_increase')      ambienceDir = 'increase';
        else if (effectiveActionType === 'ambience_decrease') ambienceDir = 'decrease';
        else if (projDir === 'up'   || projDir === 'improve') ambienceDir = 'increase';
        else if (projDir === 'down' || projDir === 'degrade') ambienceDir = 'decrease';
        effectiveActionType = 'ambience_change';
      }

      let phaseNum = PHASE_ORDER[effectiveActionType] ?? PHASE_MISC;
      let phaseKey = PHASE_NUM_TO_LABEL[phaseNum];
      // JDT-5: if this slot is part of an active joint, route it to the
      // Joint Projects phase. The slot subsumes here; no solo entry is
      // created for the lead's joint slot or any accepted support's slot.
      const _jointInfo = jointSlotPairs.get(`${String(sub._id)}:${slot}`);
      if (_jointInfo) {
        phaseNum = PHASE_JOINT;
        phaseKey = PHASE_NUM_TO_LABEL[PHASE_JOINT];
      }

      // For ambience-change projects, dt-form.25 writes the territory to
      // `_ambience_target` instead of `_territory`. Prefer new key, fall back.
      const _isProjAmb = effectiveActionType === 'ambience_change';
      const _projTerritory = _isProjAmb
        ? (resp[`project_${slot}_ambience_target`] || resp[`project_${slot}_territory`] || '')
        : (resp[`project_${slot}_territory`] || '');

      // Issues #210 / #217 — resolve the player's target picker selection
      // into a human-readable string. Composer is the shared
      // `_composeTargetString` helper defined below; project + sphere
      // both consume it.
      const _projTarget = _composeTargetString(resp, `project_${slot}`, characters);
      // #586: player character target(s) as sortName keys, for seeding the
      // processing target picker (investigate/attack/block) when the ST has not
      // yet touched it. Non-character targets resolve to [] (surfaced via projTarget).
      const _projTargetCharKeys = _composeTargetCharKeys(resp, `project_${slot}`, characters);
      // #589: player Connected Characters for this project slot, as sortName keys,
      // for seeding the ST Connected Characters box (project actions only).
      const _projConnectedKeys = _composeConnectedCharKeys(resp, `project_${slot}`, characters);

      // Issue #219 — investigate-lead chip + multi-row xp_spend breakdown.
      // Form persists `project_${n}_investigate_lead` (free text, populated
      // when action === 'investigate') and `project_${n}_xp_rows` (JSON
      // array of `{category, item, dotsBuying}` from the per-slot xp grid,
      // when action === 'xp_spend'). Pre-fix neither surfaced on the
      // project card; admin's xp review table read the top-level
      // `responses.xp_spend` mirror but the per-slot card showed only the
      // legacy single-row keys.
      const _projInvestigateLead = resp[`project_${slot}_investigate_lead`] || '';
      // #601: maintenance stores the maintained asset in project_N_target_value as
      // `${m.name}_${dots}` (e.g. "Professional Training_5"), with no target_type.
      // Resolve the readable merit name by stripping the trailing _<dots> (the
      // maintainable merit names contain no underscore). Gated to maintenance so it
      // never collides with the character target_value used by attack/block/investigate.
      const _maintenanceTarget = effectiveActionType === 'maintenance'
        ? String(resp[`project_${slot}_target_value`] || '').replace(/_\d+$/, '').trim()
        : '';
      let _projXpBreakdown = '';
      let _projXpRows = [];
      let _projXpBudgetSnapshot = null;
      if (effectiveActionType === 'xp_spend') {
        const _rj = resp[`project_${slot}_xp_rows`] || '';
        if (_rj) {
          try {
            const _parsed = JSON.parse(_rj);
            if (Array.isArray(_parsed) && _parsed.length) {
              _projXpRows = _parsed.filter(r => r && (r.category || r.item));
              // Legacy flat string kept as fallback for submissions pre-dating feature.97
              _projXpBreakdown = _projXpRows
                .map(r => {
                  const _dots = r.dotsBuying ? ` (${r.dotsBuying} dot${r.dotsBuying === 1 ? '' : 's'})` : '';
                  return `${r.category || ''}: ${r.item || ''}${_dots}`;
                })
                .join(' — ');
            }
          } catch { /* malformed — fall through to legacy single-row */ }
        }
        // Single-row fallback for pre-redesign drafts that never engaged
        // the multi-row grid (legacy `_xp_category` / `_xp_item` only).
        if (!_projXpBreakdown) {
          const _cat  = resp[`project_${slot}_xp_category`] || '';
          const _item = resp[`project_${slot}_xp_item`]     || '';
          if (_cat && _item) _projXpBreakdown = `${_cat}: ${_item}`;
        }
        // feature.97: budget snapshot stored at submit time
        const _snap = resp.xp_budget_snapshot;
        if (typeof _snap === 'number') _projXpBudgetSnapshot = _snap;
      }

      queue.push({
        key: `${sub._id}:proj:${idx}`,
        subId: sub._id,
        charName,
        phase: phaseKey,
        phaseNum,
        actionType: effectiveActionType,
        originalActionType: actionType,
        label: ACTION_TYPE_LABELS[effectiveActionType] || effectiveActionType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description: projDescription || proj.desired_outcome || '',
        source: 'project',
        actionIdx: idx,
        projSlot: slot,
        poolPlayer: proj.primary_pool?.expression || resp[`project_${slot}_pool_expr`] || '',
        projTitle:       resp[`project_${slot}_title`]     || '',
        projOutcome:     proj.desired_outcome || resp[`project_${slot}_outcome`] || '',
        projDescription,
        projCast:        projCastResolved,
        projMerits:      projMeritsResolved,
        projTerritory:   _projTerritory,
        projTarget:      _projTarget,
        targetCharKeys:  _projTargetCharKeys,
        connectedCharKeys: _projConnectedKeys,
        projInvestigateLead: _projInvestigateLead,
        maintenanceTarget:   _maintenanceTarget,
        projXpBreakdown:      _projXpBreakdown,
        projXpRows:           _projXpRows,
        projXpBudgetSnapshot: _projXpBudgetSnapshot,
        ambienceDir,
        // JDT-5: joint membership — populated when the slot belongs to a joint.
        joint_id:        _jointInfo?.joint?._id || null,
        joint_role:      _jointInfo?.role || null,
        joint_doc:       _jointInfo?.joint || null,
      });
    });

    // ── Merit/Sphere actions ──
    let spheres  = raw.sphere_actions || [];
    if (!spheres.length) {
      // App-form submissions store sphere actions as flat response keys (sphere_N_merit etc.)
      // Guard: require a non-empty action. Merit label may be absent for submissions
      // made with the tabbed sphere UI (issue #713 — gate removed); derive from
      // character data in that case so existing DT4 submissions surface correctly.
      for (let n = 1; n <= 5; n++) {
        let meritType = resp[`sphere_${n}_merit`];
        const actionVal = resp[`sphere_${n}_action`];
        if (!actionVal) continue;
        if (!meritType) {
          const sphereChar = _subChar || charMap.get((sub.character_name || '').toLowerCase().trim());
          const alliesMerits = (sphereChar?.merits || [])
            .filter(m => m.category === 'influence' && m.name === 'Allies');
          const am = alliesMerits[n - 1];
          if (am) {
            const dots = (am.rating || am.dots || 0) + (am.bonus || 0);
            const area = am.area || am.qualifier || '';
            meritType = area ? `Allies ${'●'.repeat(dots)} (${area})` : `Allies ${'●'.repeat(dots)}`;
          }
        }
        if (!meritType) continue;
        spheres = [...spheres, {
          merit_type:      meritType,
          action_type:     resp[`sphere_${n}_action`]      || 'misc',
          desired_outcome: resp[`sphere_${n}_outcome`]     || '',
          description:     resp[`sphere_${n}_description`] || '',
          primary_pool:    resp[`sphere_${n}_pool_expr`] ? { expression: resp[`sphere_${n}_pool_expr`] } : null,
          // Issue #212 — surface the player's territory pick. Form writes
          // `sphere_${n}_territory` (territory slug, populated by the
          // generic suffix loop at downtime-form.js:752 — same shape as
          // the project per-slot territory). Pre-fix this key was never
          // read; sphere action cards rendered no territory cell.
          territory:       resp[`sphere_${n}_territory`]   || '',
          // Issue #217 — pull the three sphere-action data points the
          // audit flagged as MEDIUM Type A: the structured target
          // picker, the investigate-lead chip, and the cast list. The
          // target shape mirrors project's renderTargetCharOrOther
          // (downtime-form.js:5215+) but sphere's value can be a
          // JSON array of char IDs (multi-select checkboxes at
          // downtime-form.js:766-769); the shared composer handles
          // both single + array shapes.
          target_type:     resp[`sphere_${n}_target_type`]      || '',
          target_value:    resp[`sphere_${n}_target_value`]     || '',
          target_terr:     resp[`sphere_${n}_target_terr`]      || '',
          target_other:    resp[`sphere_${n}_target_other`]     || '',
          investigate_lead: resp[`sphere_${n}_investigate_lead`] || '',
          cast:            resp[`sphere_${n}_cast`]             || '',
        }];
      }
    }
    let contacts = (raw.contact_actions?.requests || []).map((req, i) => {
      const meritStr = resp[`contact_${i + 1}_merit`] || '';
      const m = meritStr.match(/\(([^)]+)\)/);
      return { req, sphere: m ? m[1] : '' };
    });
    if (!contacts.length) {
      const contactList = [];
      for (let n = 1; n <= 5; n++) {
        const req = resp[`contact_${n}_request`] || resp[`contact_${n}`];
        if (!req) continue;
        const meritStr = resp[`contact_${n}_merit`] || '';
        const m = meritStr.match(/\(([^)]+)\)/);
        contactList.push({ req, sphere: m ? m[1] : '' });
      }
      contacts = contactList;
    }
    // Issue #344 — Status merit actions write status_${n}_* keys (not sphere_${n}_*),
    // so they are never picked up by the sphere fallback above. Append them to
    // `spheres` so they flow through the same forEach with correct meritFlatIdx
    // accounting and _parseMeritType returning category:'status' automatically.
    for (let n = 1; n <= 5; n++) {
      const meritType = resp[`status_${n}_merit`];
      const actionVal = resp[`status_${n}_action`];
      if (!meritType || !actionVal) continue;
      spheres = [...spheres, {
        merit_type:       meritType,
        action_type:      resp[`status_${n}_action`]           || 'misc',
        desired_outcome:  resp[`status_${n}_outcome`]          || '',
        description:      resp[`status_${n}_description`]      || '',
        territory:        resp[`status_${n}_territory`]        || '',
        target_type:      resp[`status_${n}_target_type`]      || '',
        target_value:     resp[`status_${n}_target_value`]     || '',
        target_other:     resp[`status_${n}_target_other`]     || '',
        investigate_lead: resp[`status_${n}_investigate_lead`] || '',
        primary_pool:     null,
        cast:             '',
      }];
    }
    const retainers = raw.retainer_actions?.actions || [];

    // merit_actions_resolved uses a flat index: spheres, then contacts, then retainers
    let meritFlatIdx = 0;

    spheres.forEach((action, idx) => {
      const originalActionType = action.action_type || 'misc';
      const parsed     = _parseMeritType(action.merit_type || '');
      const { category: meritCategory, label: meritLabel, qualifier: meritQualifier } = parsed;
      // Use character's actual merit rating + bonus (catches VM bonus dots, shared merits, etc.)
      const sphereChar  = _subChar || charMap.get((sub.character_name || '').toLowerCase().trim());
      const actualMerit = sphereChar?.merits?.find(m => {
        const mName = (m.name || '').toLowerCase();
        const lName = meritLabel.toLowerCase();
        const nameMatch = mName === lName || lName.includes(mName) || mName.includes(lName);
        const qualMatch = (m.qualifier || m.area || '').toLowerCase() === meritQualifier.toLowerCase();
        return nameMatch && qualMatch;
      });
      const meritDots = actualMerit
        ? (actualMerit.rating || actualMerit.dots || parsed.dots || 0) + (actualMerit.bonus || 0)
        : (parsed.dots || 0);
      // Apply ST action-type override if present
      const meritResolved = (sub.merit_actions_resolved || [])[meritFlatIdx] || {};
      const actionType = meritResolved.action_type_override || originalActionType;
      let phaseNum;
      const isAlliesAction = meritCategory === 'allies' || meritCategory === 'status';
      if (meritCategory === 'allies') {
        phaseNum = PHASE_ORDER[actionType] ?? PHASE_MISC;
      } else if (meritCategory === 'status') {
        phaseNum = PHASE_ORDER[actionType] ?? PHASE_MISC;
      } else if (meritCategory === 'retainer') {
        phaseNum = PHASE_ORDER[actionType] ?? PHASE_MISC;
      } else if (meritCategory === 'staff') {
        phaseNum = PHASE_CONTACTS;
      } else if (meritCategory === 'contacts') {
        phaseNum = PHASE_CONTACTS;
      } else {
        phaseNum = PHASE_ORDER[actionType] ?? PHASE_MISC;
      }
      const phaseKey = PHASE_NUM_TO_LABEL[phaseNum];
      // Issue #212 — carry the player's sphere territory pick onto the
      // queue entry. `action.territory` is set by the response-keys
      // fallback above (form-shape submissions); legacy
      // `raw.sphere_actions[]` may also include it. Falls back to
      // `resp[\`sphere_${idx+1}_territory\`]` so submissions whose
      // sphere_actions array lacks a territory field still surface
      // the player's pick.
      const meritTerritory = action.territory
                          || resp[`sphere_${idx + 1}_territory`]
                          || '';

      // Issue #217 — sphere target picker / investigate lead / cast.
      // Target uses the shared `_composeTargetString` helper so any
      // future shape changes converge with the project target render.
      const meritTarget = _composeTargetString(resp, `sphere_${idx + 1}`, characters);
      const meritInvestigateLead = action.investigate_lead
                                || resp[`sphere_${idx + 1}_investigate_lead`]
                                || '';
      // Cast: form persists JSON-array of char IDs at
      // `sphere_${n}_cast` (downtime-form.js:781). Resolve to display
      // names; gracefully fall back to raw IDs for unresolved chars.
      let meritCast = '';
      const castRaw = action.cast || resp[`sphere_${idx + 1}_cast`] || '';
      if (castRaw) {
        try {
          const ids = JSON.parse(castRaw);
          if (Array.isArray(ids) && ids.length) {
            meritCast = ids.map(id => {
              const c = characters.find(ch => String(ch._id) === String(id));
              return c ? dropdownName(c) : `${id} (unresolved)`;
            }).join(', ');
          }
        } catch { meritCast = String(castRaw); }
      }

      queue.push({
        key: `${sub._id}:merit:${meritFlatIdx}`,
        subId: sub._id,
        charName,
        phase: phaseKey,
        phaseNum,
        actionType,
        originalActionType,
        label: `${action.merit_type || 'Merit'}: ${ACTION_TYPE_LABELS[actionType] || actionType}`,
        description: action.description || action.desired_outcome || '',
        source: 'merit',
        actionIdx: meritFlatIdx,
        poolPlayer: action.primary_pool?.expression || '',
        isAlliesAction,
        meritCategory,
        meritLabel,
        meritDots,
        meritQualifier,
        meritDesiredOutcome: action.desired_outcome || '',
        meritTerritory,
        meritTarget,
        meritInvestigateLead,
        meritCast,
      });
      meritFlatIdx++;
    });

    contacts.forEach((item, idx) => {
      const req    = typeof item === 'string' ? item : item.req;
      const sphere = typeof item === 'string' ? '' : (item.sphere || '');
      queue.push({
        key: `${sub._id}:merit:${meritFlatIdx}`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[11],
        phaseNum: 11,
        actionType: 'contacts',
        label: 'Contacts: Gather Info',
        description: req,
        source: 'merit',
        meritCategory: 'contacts',
        meritSphere: sphere,
        actionIdx: meritFlatIdx,
        poolPlayer: '',
      });
      meritFlatIdx++;
    });

    retainers.forEach((task, idx) => {
      const _retResolved_A = (sub.merit_actions_resolved || [])[meritFlatIdx] || {};
      const _retOrigType_A = 'resources_retainers';
      const _retActionType_A = _retResolved_A.action_type_override || _retOrigType_A;
      queue.push({
        key: `${sub._id}:merit:${meritFlatIdx}`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[PHASE_ORDER[_retActionType_A] ?? PHASE_MISC],
        phaseNum: PHASE_ORDER[_retActionType_A] ?? PHASE_MISC,
        actionType: _retActionType_A,
        originalActionType: _retOrigType_A,
        label: 'Retainer: Directed Action',
        description: task,
        source: 'merit',
        actionIdx: meritFlatIdx,
        poolPlayer: '',
      });
      meritFlatIdx++;
    });

    // Audit #198 / Issue #202 — Mentor + Staff surfaces (PR #137 / dt-form.28)
    // were entirely invisible on the admin side. Mirror the per-slot loop the
    // contacts + retainers blocks use, reading the form's mentor_${n}_* and
    // staff_${n}_* response keys. Mentor mirrors Retainer (per-merit, directed
    // action — PHASE_MISC); Staff mirrors Contacts (per-dot, tasked action —
    // PHASE_CONTACTS). Description composes the merit label + resolved target name +
    // task so the ST sees who the action is directed at without drilling into
    // the raw response. Bound to 10 / 20 slots to cover any realistic dot
    // total.
    const _resolveTargetName = (id) => {
      if (!id) return '';
      const c = characters.find(ch => String(ch._id) === String(id));
      return c ? dropdownName(c) : '';
    };
    const _composeDirectedDesc = (meritLabel, targetName, task) => {
      const head = [meritLabel, targetName].filter(Boolean).join(' — ');
      return [head, task].filter(Boolean).join(': ');
    };
    for (let n = 1; n <= 10; n++) {
      const task    = resp[`mentor_${n}_task`];
      const target  = resp[`mentor_${n}_target`];
      const meritLb = resp[`mentor_${n}_merit`];
      if (!task && !target) continue;
      const _mentResolved = (sub.merit_actions_resolved || [])[meritFlatIdx] || {};
      const _mentOrigType = 'resources_retainers';
      const _mentActionType = _mentResolved.action_type_override || _mentOrigType;
      queue.push({
        key: `${sub._id}:merit:${meritFlatIdx}`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[PHASE_ORDER[_mentActionType] ?? PHASE_MISC],
        phaseNum: PHASE_ORDER[_mentActionType] ?? PHASE_MISC,
        actionType: _mentActionType,
        originalActionType: _mentOrigType,
        label: 'Mentor: Directed Action',
        description: _composeDirectedDesc(meritLb, _resolveTargetName(target), task || ''),
        source: 'merit',
        meritCategory: 'mentor',
        actionIdx: meritFlatIdx,
        poolPlayer: '',
      });
      meritFlatIdx++;
    }
    for (let n = 1; n <= 20; n++) {
      const task    = resp[`staff_${n}_task`];
      const target  = resp[`staff_${n}_target`];
      const meritLb = resp[`staff_${n}_merit`];
      if (!task && !target) continue;
      queue.push({
        key: `${sub._id}:merit:${meritFlatIdx}`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[11],
        phaseNum: 11,
        actionType: 'contacts',
        label: 'Staff: Tasked Action',
        description: _composeDirectedDesc(meritLb, _resolveTargetName(target), task || ''),
        source: 'merit',
        meritCategory: 'staff',
        actionIdx: meritFlatIdx,
        poolPlayer: '',
      });
      meritFlatIdx++;
    }
    // Issue #344 — Retainer actions write retainer_${n}_type/task/merit for
    // app-form submissions. The block above reads raw.retainer_actions?.actions
    // which is always [] for app-form subs. Mirror the Mentor pattern.
    for (let n = 1; n <= 10; n++) {
      const task    = resp[`retainer_${n}_task`];
      const type    = resp[`retainer_${n}_type`];
      const meritLb = resp[`retainer_${n}_merit`];
      if (!task && !type) continue;
      const _retResolved_C = (sub.merit_actions_resolved || [])[meritFlatIdx] || {};
      const _retOrigType_C = 'resources_retainers';
      const _retActionType_C = _retResolved_C.action_type_override || _retOrigType_C;
      queue.push({
        key: `${sub._id}:merit:${meritFlatIdx}`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[PHASE_ORDER[_retActionType_C] ?? PHASE_MISC],
        phaseNum: PHASE_ORDER[_retActionType_C] ?? PHASE_MISC,
        actionType: _retActionType_C,
        originalActionType: _retOrigType_C,
        label: meritLb ? `${meritLb}: Directed Action` : 'Retainer: Directed Action',
        description: _composeDirectedDesc(meritLb, type || '', task || ''),
        source: 'merit',
        meritCategory: 'retainer',
        actionIdx: meritFlatIdx,
        poolPlayer: '',
      });
      meritFlatIdx++;
    }

    // ── Acquisitions (resource and skill, from raw.acquisitions form section) ──
    // Issue #214 — pre-fix this block read ONLY `raw.acquisitions?.*`,
    // which is populated by the CSV import path (server schema:478, _raw
    // is the CSV-structured-data slot). For app-form submissions `raw`
    // is `{}` and both branches were skipped — Resources and Skill
    // Acquisitions phases of the action queue were entirely empty for
    // every submission entered through the player form. Fall back to
    // the canonical response-key blobs (form writes both at
    // downtime-form.js:953 and :967 alongside the structured JSON-array
    // sources of truth at :907-908).
    const resAcq   = (raw.acquisitions?.resource_acquisitions || resp['resources_acquisitions'] || '').trim();
    const skillAcq = (raw.acquisitions?.skill_acquisitions   || resp['skill_acquisitions']    || '').trim();
    /** Extract the first "Description: ..." value from an acquisitions blob for the row summary. */
    function _acqRowSummary(text) {
      const m = text.match(/description[:\s]+([^\n]+)/i);
      if (m) return m[1].trim();
      // Fall back to first non-empty line
      return text.split('\n').map(l => l.trim()).find(l => l) || text;
    }
    /**
     * Issue #214 — compose a multi-row description from the canonical
     * `acq_resource_rows` / `acq_skill_rows` JSON arrays (form-side
     * single source of truth, downtime-form.js:907-908). Pre-fix only
     * slot 1 (via `acq_description` mirror) was visible in any
     * structured form; rows 2..N were either entirely dropped (for
     * app-form submissions, see the resp fallback above) or
     * concatenated as a free-text blob with no per-row delimiter.
     * When the JSON array is present, build a per-row summary with
     * `Row N: <description> | <merits>` so the ST sees the structure
     * the player entered. Falls back to the blob's first-line summary
     * (existing behaviour) when no JSON array is present.
     */
    function _multiRowSummary(jsonStr, blob) {
      try {
        const rows = JSON.parse(jsonStr || '[]');
        if (Array.isArray(rows) && rows.length > 1) {
          return rows.map((r, i) => {
            const merits = Array.isArray(r.merits) && r.merits.length ? ` | ${r.merits.join(', ')}` : '';
            const desc   = r.description || '';
            return `Row ${i + 1}: ${desc}${merits}`;
          }).join(' — ');
        }
        if (Array.isArray(rows) && rows.length === 1) {
          // Single row — show description directly (matches blob summary shape).
          return rows[0].description || _acqRowSummary(blob);
        }
      } catch { /* malformed JSON — fall through to blob */ }
      return _acqRowSummary(blob);
    }
    if (resAcq) {
      queue.push({
        key: `${sub._id}:acq:resources`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[PHASE_ACQUISITION],
        phaseNum: PHASE_ACQUISITION,
        actionType: 'resources_acquisitions',
        label: 'Resources Acquisitions',
        description: _multiRowSummary(resp['acq_resource_rows'], resAcq),
        acqNotes: resAcq,
        source: 'acquisition',
        actionIdx: 0,
        poolPlayer: '',
      });
    }
    if (skillAcq) {
      const _skAcqChar = _findCharForSub(sub);
      const _skPoolPlayer = _skAcqChar ? skillAcqPoolStr(_skAcqChar, {
        skill: resp.skill_acq_pool_skill || '',
        spec: resp.skill_acq_pool_spec || '',
      }) : '';
      queue.push({
        key: `${sub._id}:acq:skills`,
        subId: sub._id,
        charName,
        phase: PHASE_NUM_TO_LABEL[PHASE_ACQUISITION],
        phaseNum: PHASE_ACQUISITION,
        actionType: 'skill_acquisitions',
        label: 'Skill Acquisitions',
        description: _multiRowSummary(resp['acq_skill_rows'], skillAcq),
        acqNotes: skillAcq,
        source: 'acquisition',
        actionIdx: 1,
        poolPlayer: _skPoolPlayer,
      });
    }

    // ── ST-created actions ──
    for (let idx = 0; idx < (sub.st_actions || []).length; idx++) {
      const stAction = sub.st_actions[idx];
      if (stAction._deleted) continue;
      const phaseNum = ST_ACTION_PHASE_MAP[stAction.action_type] ?? PHASE_MISC;
      const phase = PHASE_NUM_TO_LABEL[phaseNum];
      queue.push({
        key: `${sub._id}:st:${idx}`,
        subId: sub._id,
        source: 'st_created',
        actionIdx: idx,
        charName,
        phase,
        phaseNum,
        actionType: stAction.action_type,
        label: stAction.label,
        description: stAction.description || '',
        poolPlayer: stAction.pool_player || '',
        riteName:  stAction.rite_name || stAction.label,
        tradition: stAction.tradition || '',
      });
    }
  }

  // Sort: phase first, then source type, then character name
  const SOURCE_ORDER = { project: 0, sorcery: 1, merit: 2, feeding: 3, st_created: 4 };
  queue.sort((a, b) => {
    if (a.phaseNum !== b.phaseNum) return a.phaseNum - b.phaseNum;
    const sa = SOURCE_ORDER[a.source] ?? 9;
    const sb = SOURCE_ORDER[b.source] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.charName.localeCompare(b.charName);
  });

  // Filter out any entries the ST has permanently deleted
  return queue.filter(e => {
    const del = _deletedKeysBySub.get(e.subId);
    return !del || !del.has(e.key);
  });
}


/**
 * Recompute discipline × territory profile from all currently-validated feeding reviews.
 * Called after any feeding pool_status or pool_validated change. Saves to cycle document.
 */
async function recomputeDisciplineProfile() {
  await ensureTerritories();
  // Build slug→OID by iterating cachedTerritories directly so the map is populated
  // regardless of whether MongoDB slugs exactly match TERRITORY_DATA entries.
  // TERRITORY_SLUG_MAP aliases ensure canonical slugs resolve even when the DB carries
  // a legacy variant (e.g. 'the_north_shore' → 'northshore').
  const slugToOid = new Map();
  for (const t of (cachedTerritories || [])) {
    if (!t._id) continue;
    const oid = String(t._id);
    if (t.slug) {
      slugToOid.set(t.slug, oid);
      const canonical = TERRITORY_SLUG_MAP[t.slug];
      if (canonical && !slugToOid.has(canonical)) slugToOid.set(canonical, oid);
    }
    if (t.name) {
      const byName = TERRITORY_SLUG_MAP[t.name];
      if (byName && !slugToOid.has(byName)) slugToOid.set(byName, oid);
    }
  }

  const profile = {};
  for (const sub of submissions) {
    const rev = sub.feeding_review || {};
    if (rev.pool_status !== 'validated' || !rev.pool_validated) continue;
    let feedTerrs = {};
    try { feedTerrs = JSON.parse(sub.responses?.feeding_territories || '{}'); } catch { feedTerrs = {}; }
    const active = Object.entries(feedTerrs)
      .filter(([, v]) => v && v !== 'none')
      .map(([k]) => {
        // Normalise any slug variant to the canonical TERRITORY_DATA slug before OID lookup
        const canon = Object.prototype.hasOwnProperty.call(TERRITORY_SLUG_MAP, k) ? TERRITORY_SLUG_MAP[k] : k;
        return canon ? slugToOid.get(canon) : null;
      })
      .filter(Boolean);
    if (!active.length) continue;
    const foundDiscs = KNOWN_DISCIPLINES.filter(d => rev.pool_validated.includes(d));
    for (const terrOid of active) {
      if (!profile[terrOid]) profile[terrOid] = {};
      for (const disc of foundDiscs) {
        profile[terrOid][disc] = (profile[terrOid][disc] || 0) + 1;
      }
    }
  }
  // Also scan territory-relevant project actions: ambience and rote feed
  // Rote feed (+1, or +2 exceptional) and ambience (+1, or +2 exceptional)
  // 'obvious', 'neutral', 'subtle': terminal ambience resolution statuses (shown as "Complete"
  // in the action ribbon). 'resolved': ST manually resolved without a roll outcome.
  const DISC_PROJECT_STATUSES = new Set(['validated', 'obvious', 'neutral', 'subtle', 'resolved']);
  for (const sub of submissions) {
    for (const [pIdx, proj] of (sub.projects_resolved || []).entries()) {
      if (!proj?.pool_validated) continue;
      if (!DISC_PROJECT_STATUSES.has(proj.pool_status)) continue;
      const actionType = proj.action_type_override || proj.action_type;
      // Issue #129: accept canonical 'ambience_change' alongside legacy aliases.
      const isAmbience = _isAmbienceAction(actionType);
      const isRoteFeed = actionType === 'feed';
      if (!isAmbience && !isRoteFeed) continue;
      const slug = _resolveProjectTerritory(sub, pIdx);
      const terrOid = slug ? slugToOid.get(slug) : null;
      if (!terrOid) continue;
      const foundDiscs = KNOWN_DISCIPLINES.filter(d => proj.pool_validated.includes(d));
      if (!foundDiscs.length) continue;
      const points = proj.roll?.exceptional ? 2 : 1;
      if (!profile[terrOid]) profile[terrOid] = {};
      for (const disc of foundDiscs) {
        profile[terrOid][disc] = (profile[terrOid][disc] || 0) + points;
      }
    }
  }

  try {
    await updateCycle(selectedCycleId, { discipline_profile: profile });
    const idx = allCycles.findIndex(c => c._id === selectedCycleId);
    if (idx >= 0) allCycles[idx].discipline_profile = profile;
    if (currentCycle) currentCycle.discipline_profile = profile;
  } catch (err) {
    console.error('Failed to save discipline profile:', err.message);
  }
}

/** Get the review object for a queue entry from its submission. */
function getEntryReview(entry) {
  const sub = submissions.find(s => s._id === entry.subId);
  if (!sub) return null;
  if (entry.source === 'travel')   return { pool_status: sub.st_review?.travel_discretion || 'pending' };
  if (entry.source === 'feeding') return sub.feeding_review || null;
  if (entry.source === 'project') return (sub.projects_resolved || [])[entry.actionIdx] || null;
  if (entry.source === 'merit')   return (sub.merit_actions_resolved || [])[entry.actionIdx] || null;
  if (entry.source === 'sorcery') return (sub.sorcery_review || {})[entry.actionIdx] || null;
  if (entry.source === 'st_created') return (sub.st_actions_resolved || [])[entry.actionIdx] || null;
  if (entry.source === 'acquisition') return (sub.acquisitions_resolved || [])[entry.actionIdx] || null;
  return null;
}

/** Save a partial update to a queue entry's review object. */
async function saveEntryReview(entry, patch) {
  const sub = submissions.find(s => s._id === entry.subId);
  if (!sub) return;
  // proto.16: version stamp co-saved atomically with every review write
  const ts = new Date().toISOString();

  if (entry.source === 'travel') {
    const stReview = { ...(sub.st_review || {}), travel_discretion: patch.pool_status, st_review_touched_at: ts };
    await updateSubmission(entry.subId, { st_review: stReview });
    sub.st_review = stReview;
    return;
  }

  if (entry.source === 'feeding') {
    const current = sub.feeding_review || { pool_player: entry.poolPlayer, pool_validated: '', pool_status: 'pending', notes_thread: [], story_context: '' };
    const updated = { ...current, ...patch };
    await updateSubmission(entry.subId, { feeding_review: updated, 'st_review.st_review_touched_at': ts });
    sub.feeding_review = updated;
    // Recompute discipline × territory profile when pool or status changes
    if ('pool_status' in patch || 'pool_validated' in patch) {
      recomputeDisciplineProfile(); // async, fire-and-forget
    }
  } else if (entry.source === 'project') {
    const resolved = [...(sub.projects_resolved || [])];
    while (resolved.length <= entry.actionIdx) resolved.push(null);
    const current = resolved[entry.actionIdx] || { action_type: entry.actionType, pool: null, roll: null, st_note: '', pool_player: entry.poolPlayer, pool_validated: '', pool_status: 'pending', notes_thread: [], story_context: '', resolved_at: null };
    resolved[entry.actionIdx] = { ...current, ...patch };
    await updateSubmission(entry.subId, { projects_resolved: resolved, 'st_review.st_review_touched_at': ts });
    sub.projects_resolved = resolved;
    // Recompute discipline profile when ambience actions are validated
    if (('pool_status' in patch || 'pool_validated' in patch) &&
        _isAmbienceAction(entry.actionType)) {
      recomputeDisciplineProfile(); // fire-and-forget
    }
  } else if (entry.source === 'merit') {
    const resolved = [...(sub.merit_actions_resolved || [])];
    while (resolved.length <= entry.actionIdx) resolved.push(null);
    const current = resolved[entry.actionIdx] || { pool_player: entry.poolPlayer, pool_validated: '', pool_status: 'pending', notes_thread: [], story_context: '' };
    // proto.14: co-save hide_protect_disc when pool_validated is written for hide_protect actions
    const savePatch = ('pool_validated' in patch && entry.actionType === 'hide_protect')
      ? { ...patch, hide_protect_disc: KNOWN_DISCIPLINES.find(d => (patch.pool_validated || '').includes(d)) || '' }
      : patch;
    resolved[entry.actionIdx] = { ...current, ...savePatch };
    await updateSubmission(entry.subId, { merit_actions_resolved: resolved, 'st_review.st_review_touched_at': ts });
    sub.merit_actions_resolved = resolved;
  } else if (entry.source === 'sorcery') {
    const sorcReview = { ...(sub.sorcery_review || {}) };
    const current = sorcReview[entry.actionIdx] || { pool_status: 'pending', notes_thread: [], story_context: '' };
    sorcReview[entry.actionIdx] = { ...current, ...patch };
    await updateSubmission(entry.subId, { sorcery_review: sorcReview, 'st_review.st_review_touched_at': ts });
    sub.sorcery_review = sorcReview;
  } else if (entry.source === 'st_created') {
    const resolved = [...(sub.st_actions_resolved || [])];
    while (resolved.length <= entry.actionIdx) resolved.push(null);
    const current = resolved[entry.actionIdx] || { pool_player: entry.poolPlayer, pool_validated: '', pool_status: 'pending', notes_thread: [], story_context: '' };
    resolved[entry.actionIdx] = { ...current, ...patch };
    await updateSubmission(entry.subId, { st_actions_resolved: resolved, 'st_review.st_review_touched_at': ts });
    sub.st_actions_resolved = resolved;
  } else if (entry.source === 'acquisition') {
    const resolved = [...(sub.acquisitions_resolved || [])];
    while (resolved.length <= entry.actionIdx) resolved.push(null);
    const current = resolved[entry.actionIdx] || { pool_player: '', pool_validated: '', pool_status: 'pending', notes_thread: [], story_context: '' };
    resolved[entry.actionIdx] = { ...current, ...patch };
    await updateSubmission(entry.subId, { acquisitions_resolved: resolved, 'st_review.st_review_touched_at': ts });
    sub.acquisitions_resolved = resolved;
  }
  // proto.16: update in-memory st_review timestamp for all non-travel branches
  if (!sub.st_review) sub.st_review = {};
  sub.st_review.st_review_touched_at = ts;
}

// ── Ambience Dashboard (feature.47) ─────────────────────────────────────────

const AMBIENCE_STEPS_LIST = [
  'Hostile', 'Barrens', 'Neglected', 'Untended',
  'Settled', 'Tended', 'Curated', 'Verdant', 'The Rack',
];

/** Called by city-views.js after saving an ambience override so Processing Mode refetches. */
export function invalidateCachedTerritories() {
  cachedTerritories = null;
}

/** Load (or reuse) territories from the DB, falling back to TERRITORY_DATA. */
async function ensureTerritories() {
  if (cachedTerritories) return cachedTerritories;
  let db = [];
  try { db = await apiGet('/api/territories'); } catch { /* ignore */ }
  if (db.length) {
    cachedTerritories = db;
  } else {
    cachedTerritories = TERRITORY_DATA.map(t => ({ ...t }));
  }
  return cachedTerritories;
}

// TERRITORY_SLUG_MAP imported from downtime-constants.js
const TERRITORY_SLUG_MAP = _TERRITORY_SLUG_MAP_BASE;

/** Scan free text for a territory mention; returns TERRITORY_DATA id or null. */
function extractTerritoryFromText(text) {
  if (!text) return null;
  if (/\bacademy\b/i.test(text)) return 'academy';
  if (/\bharbou?r\b/i.test(text)) return 'harbour';
  if (/\bdockyards?\b/i.test(text)) return 'dockyards';
  if (/\bsecond\s+city\b/i.test(text)) return 'secondcity';
  if (/\bnorth(?:ern)?\s*shore\b/i.test(text)) return 'northshore';
  return null;
}

/** Normalise a territory OID string to a TERRITORY_DATA id. Returns null if not found. */
function resolveTerrId(raw) {
  if (!raw) return null;
  const t = (cachedTerritories || []).find(td => String(td._id) === raw);
  return t?.slug || null;
}

// ── Ambience source gatherers ─────────────────────────────────────────────────
// Each reads the module-level `submissions` array, normalises territory keys via
// resolveTerrId, and returns id-keyed accumulators. Extracted so buildAmbienceData
// reads as a coordinator rather than a 180-line monolith.

/**
 * Single source of truth for feeder counts — used by both the feeding matrix footer
 * and the ambience Overfeeding column so the two can never diverge.
 *
 * Iterates non-retired characters (matching the matrix body), calls _getSubFedTerrs
 * for each matched submission, and returns counts in two key formats:
 *   byCsvKey  — { [MATRIX_TERRS csvKey]: count }  — for the matrix footer
 *   byTerrId  — { [TERRITORY_DATA id]: count }     — for the ambience calculation
 *   subByCharId — Map<charId, sub>                 — reusable by _buildFeedingMatrixHtml
 */
function _computeMatrixFeederCounts() {
  const byCsvKey = {};
  for (const mt of MATRIX_TERRS) byCsvKey[mt.csvKey] = 0;
  const byTerrId = {};
  const subByCharId = new Map();

  // Use _getSubFedTerrs as single source of truth — matrix cells and overfeeding counts
  // share the same feed-count Map, including ST overrides and legacy format fallback.
  for (const s of submissions) {
    const c = _findCharForSub(s);
    if (!c || c.retired) continue;
    subByCharId.set(String(c._id), s);
    const fedMap = _getSubFedTerrs(s);
    for (const [csvKey, count] of fedMap) {
      if (byCsvKey[csvKey] !== undefined) byCsvKey[csvKey] += count;
      const tid = TERRITORY_SLUG_MAP[csvKey];
      if (tid) byTerrId[tid] = (byTerrId[tid] || 0) + count;
    }
  }
  return { byCsvKey, byTerrId, subByCharId };
}

/**
 * Sum influence spend per territory.
 * influence_territories: { "The Academy": 3, "The Dockyards": -2, ... } or legacy array.
 * Returns { infPos: { [terrId]: n }, infNeg: { [terrId]: n } }
 */
function _gatherInfluence(subs) {
  const infPos = {}, infNeg = {};
  for (const sub of subs) {
    let infObj = {};
    try { infObj = JSON.parse(sub.responses?.influence_spend || '{}'); } catch { infObj = {}; }
    // Handle legacy format (array of names from old uploads) — treat each as +1
    if (Array.isArray(infObj)) {
      for (const k of infObj) {
        const tid = resolveTerrId(k);
        if (tid) infPos[tid] = (infPos[tid] || 0) + 1;
      }
    } else {
      for (const [k, v] of Object.entries(infObj)) {
        const tid = resolveTerrId(k);
        if (!tid) continue;
        const val = Number(v) || 0;
        if (val > 0) infPos[tid] = (infPos[tid] || 0) + val;
        else if (val < 0) infNeg[tid] = (infNeg[tid] || 0) + Math.abs(val);
      }
    }
  }
  console.debug('[ambience:influence] per-territory totals:', { infPos, infNeg });
  return { infPos, infNeg };
}

/**
 * Sum ambience project contributions per territory.
 * 1–4 successes = 1 point; 5+ successes = 2 points; 0 successes = 0.
 * Returns { projPos: { [terrId]: n }, projNeg: { [terrId]: n }, pendingCount: n }
 */
function _gatherProjectAmbience(subs) {
  const projPos = {}, projNeg = {};
  let pendingCount = 0;
  for (const sub of subs) {
    const raw  = sub._raw || {};
    const resp = sub.responses || {};
    // Build the project list the same way buildProcessingQueue does
    let projects = raw.projects?.length ? raw.projects : [];
    if (!projects.length) {
      for (let n = 1; n <= 4; n++) {
        const a = resp[`project_${n}_action`];
        if (a) projects.push({ action_type: a, desired_outcome: resp[`project_${n}_outcome`] || '', detail: resp[`project_${n}_description`] || '' });
      }
    }
    for (const [idx, proj] of projects.entries()) {
      const n = idx + 1;
      const resolved = (sub.projects_resolved || [])[idx] || {};
      // Effective action type: ST override takes priority over player submission
      let effectiveType = resolved.action_type_override || proj.action_type || resp[`project_${n}_action`] || '';
      if (!_AMBIENCE_ACTION_TYPES.has(effectiveType)) continue;
      const _ambiDir = _ambienceDirection(effectiveType, n, resp);
      const isIncrease = _ambiDir === 'increase';
      const isDecrease = _ambiDir === 'decrease';
      if (!isIncrease && !isDecrease) continue;
      // Pending: not yet rolled (pool_status is never updated on project roll, so use roll presence)
      if (!resolved.roll) { pendingCount++; continue; }
      // #814: overrides are stored as slugs (pill-written); resolve slug-first, OID fallback.
      const _ovrRaw = sub.st_review?.territory_overrides?.[String(idx)] || '';
      const terrOverride = TERRITORY_SLUG_MAP[_ovrRaw] ?? resolveTerrId(_ovrRaw);
      // Issue #196 — dt-form.25 writes `_ambience_target` (territory slug)
      // for ambience-change actions; the legacy `_territory` key is no
      // longer set on those rows. Prefer the new key, fall back for
      // pre-redesign drafts and non-ambience action types that still
      // carry `_territory`.
      const terrRaw = resp[`project_${n}_ambience_target`] || resp[`project_${n}_territory`] || '';
      const desc    = resp[`project_${n}_description`] || proj.detail || '';
      const outcome = proj.desired_outcome || resp[`project_${n}_outcome`] || '';
      const tid = terrOverride || (TERRITORY_SLUG_MAP[terrRaw] ?? resolveTerrId(terrRaw)) || extractTerritoryFromText(desc) || extractTerritoryFromText(outcome);
      if (!tid) continue;
      const successes = resolved.roll.successes ?? 0;
      const contrib = successes >= 5 ? 4 : successes > 0 ? 2 : 0;
      if (isIncrease) projPos[tid] = (projPos[tid] || 0) + contrib;
      else            projNeg[tid] = (projNeg[tid] || 0) + contrib;
    }
  }
  return { projPos, projNeg, pendingCount };
}

/**
 * Sum Allies / Status / Retainer automatic ambience contributions per territory.
 * Level-based: dots 3–4 = ±1, dots 5 = ±2. Territory resolved from st_review overrides.
 * Returns { alliesPos: { [terrId]: n }, alliesNeg: { [terrId]: n }, pendingCount: n }
 */
function _gatherMeritAmbience(subs) {
  const alliesPos = {}, alliesNeg = {};
  let pendingCount = 0;
  for (const sub of subs) {
    const raw       = sub._raw || {};
    const resp      = sub.responses || {};
    let spheres     = raw.sphere_actions || [];
    if (!spheres.length) {
      for (let n = 1; n <= 5; n++) {
        const meritType = resp[`sphere_${n}_merit`];
        const actionVal = resp[`sphere_${n}_action`];
        if (!meritType || !actionVal) continue;
        spheres = [...spheres, {
          merit_type:  meritType,
          action_type: actionVal,
        }];
      }
    }
    let contacts = raw.contact_actions?.requests || [];
    if (!contacts.length) {
      const cl = [];
      for (let n = 1; n <= 5; n++) { const r = resp[`contact_${n}_request`] || resp[`contact_${n}`]; if (!r) continue; cl.push(r); }
      contacts = cl;
    }
    const retainers = raw.retainer_actions?.actions || [];
    const subChar   = _findCharForSub(sub);
    let meritFlatIdx = 0;

    for (const action of spheres) {
      const resolvedAct = (sub.merit_actions_resolved || [])[meritFlatIdx];
      const rawType = resolvedAct?.action_type_override || action.action_type || 'misc';
      // Normalise raw form label to enum if not already (e.g. "Ambience Change (Increase):...")
      const isIncrease = rawType === 'ambience_increase' || /ambience.*increas/i.test(rawType);
      const isDecrease = rawType === 'ambience_decrease' || /ambience.*decreas/i.test(rawType);
      if (isIncrease || isDecrease) {
        const parsed = _parseMeritType(action.merit_type || '');
        if (parsed.category === 'allies' || parsed.category === 'status' || parsed.category === 'retainer') {
          if (resolvedAct?.pool_status === 'resolved') {
            // Prefer ST-linked qualifier over parsed submission text; used for territory fallback too
            const linkedQual = resolvedAct?.linked_merit_qualifier ?? parsed.qualifier;
            // #814: override is a slug; linkedQual may be a territory display-name or a sphere.
            // Resolve both slug-first with OID fallback; a non-territory qualifier stays null.
            const _ovrRaw = sub.st_review?.territory_overrides?.[`allies_${meritFlatIdx}`] || '';
            const tid = (TERRITORY_SLUG_MAP[_ovrRaw] ?? resolveTerrId(_ovrRaw))
                     || (TERRITORY_SLUG_MAP[linkedQual || ''] ?? resolveTerrId(linkedQual || ''));
            if (tid) {
              const actualMerit = subChar?.merits?.find(m =>
                m.name?.toLowerCase() === parsed.label.toLowerCase() &&
                (m.qualifier || m.area || '').toLowerCase() === linkedQual.toLowerCase()
              );
              const dots = actualMerit
                ? (actualMerit.rating || actualMerit.dots || parsed.dots || 0) + (actualMerit.bonus || 0)
                : (parsed.dots || 0);
              const hasHWV = (subChar?.merits || []).some(m => /honey with vinegar/i.test(m.name || ''));
              const value = hasHWV
                ? (dots >= 4 ? 2 : dots >= 2 ? 1 : 0)
                : (dots >= 5 ? 2 : dots >= 3 ? 1 : 0);
              if (value > 0) {
                if (isIncrease) alliesPos[tid] = (alliesPos[tid] || 0) + value;
                else            alliesNeg[tid] = (alliesNeg[tid] || 0) + value;
              }
            }
          }
          // Count as pending if not yet resolved
          if (!resolvedAct || resolvedAct.pool_status === 'pending') pendingCount++;
        }
      }
      meritFlatIdx++;
    }
    // contacts and retainers don't do ambience but advance the flat index
    meritFlatIdx += contacts.length + retainers.length;
  }
  return { alliesPos, alliesNeg, pendingCount };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the per-territory aggregation data for the ambience dashboard.
 * Returns { rows, pendingAmbienceCount }.
 */
function buildAmbienceData(terrs, passedFeedCounts = null) {
  // Starting ambience from DB records (fallback to TERRITORY_DATA defaults).
  // Both Mongo territories and TERRITORY_DATA key the territory slug as `slug`.
  const startingAmbience = {}, startingAmbienceMod = {};
  if (terrs?.length) {
    for (const t of terrs) {
      const td = TERRITORY_DATA.find(d => d.slug === t.slug || d.name === t.name);
      if (td) {
        startingAmbience[td.slug]    = t.ambience    || td.ambience;
        startingAmbienceMod[td.slug] = (t.ambienceMod !== undefined && t.ambienceMod !== null)
          ? t.ambienceMod : td.ambienceMod;
      }
    }
  }
  for (const td of TERRITORY_DATA) {
    if (!startingAmbience[td.slug])              startingAmbience[td.slug]    = td.ambience;
    if (startingAmbienceMod[td.slug] === undefined) startingAmbienceMod[td.slug] = td.ambienceMod;
  }

  // Aggregate each change source (all accumulators keyed by canonical territory id)
  // Use passed feed counts when available (caller uses _computeMatrixFeederCounts().byTerrId).
  const feederCounts = passedFeedCounts ?? _computeMatrixFeederCounts().byTerrId;
  const { infPos, infNeg }                                    = _gatherInfluence(submissions);
  const { projPos, projNeg, pendingCount: projPending }       = _gatherProjectAmbience(submissions);
  const { alliesPos, alliesNeg, pendingCount: alliesPending } = _gatherMeritAmbience(submissions);
  const pendingAmbienceCount = projPending + alliesPending;

  // ── Assemble rows ──
  const rows = TERRITORY_DATA.map(td => {
    const id = td.slug;
    const ambience = startingAmbience[id] || td.ambience;
    const cap = AMBIENCE_FEEDING_TOLERANCE[ambience] ?? 6;
    const feeders = feederCounts[id] || 0;
    const overfeedVal = feeders > cap ? -(feeders - cap) * 2 : feeders < cap ? (cap - feeders) : 0;
    const entropy = AMBIENCE_ENTROPY[ambience] ?? -3;
    const inf_pos = infPos[id] || 0;
    const inf_neg = infNeg[id] || 0;
    const influence = inf_pos - inf_neg;
    const proj_pos = projPos[id] || 0;
    const proj_neg = projNeg[id] || 0;
    const projects = proj_pos - proj_neg;
    const allies_pos = alliesPos[id] || 0;
    const allies_neg = alliesNeg[id] || 0;
    const allies = allies_pos - allies_neg;
    const net = entropy + overfeedVal + influence + projects + allies;
    const startIdx = AMBIENCE_STEPS_LIST.indexOf(ambience);
    let projStep = ambience;
    if (startIdx >= 0) {
      const thresh = AMBIENCE_THRESHOLDS[ambience];
      if (thresh) {
        let delta = 0;
        if (thresh.negThresh2 !== null && net <= -thresh.negThresh2)        delta = -2;
        else if (thresh.negThresh1 !== null && net <= -thresh.negThresh1)   delta = -1;
        else if (thresh.posThreshold !== null && net >= thresh.posThreshold) delta = 1;
        const newIdx = Math.max(0, Math.min(AMBIENCE_STEPS_LIST.length - 1, startIdx + delta));
        projStep = AMBIENCE_STEPS_LIST[newIdx];
      }
      // Barrens (thresh === null): projStep stays as ambience — no step calculation
    }
    const ambienceMod = startingAmbienceMod[id] ?? td.ambienceMod;
    return { id, name: td.name, ambience, ambienceMod, entropy, overfeed: overfeedVal, feeders, cap, inf_pos, inf_neg, influence, proj_pos, proj_neg, projects, allies_pos, allies_neg, allies, net, projStep };
  });
  return { rows, pendingAmbienceCount };
}

// ── Sign-off Step (Epic 4 — Stories 4.1 + 4.2 + 4.3) ────────────────────────

function _signOffStatus(s) {
  const reasons = [];
  const approval = s.approval_status || 'pending';
  if (approval !== 'approved' && approval !== 'modified') {
    reasons.push('Submission not yet approved or modified');
  }

  const NARR_LABELS = { letter_from_home: 'Letter from Home', touchstone_vignette: 'Touchstone Vignette', territory_report: 'Territory Report', intelligence_dossier: 'Intelligence Dossier' };
  const narr = s.st_review?.narrative || {};
  const unready = NARR_KEYS.filter(k => narr[k]?.status !== 'ready');
  if (unready.length) reasons.push(`Narrative not ready: ${unready.map(k => NARR_LABELS[k]).join(', ')}`);
  const flaggedXp = Object.values(s.st_review?.xp_approvals || {}).filter(a => a?.status === 'flagged').length;
  if (flaggedXp) reasons.push(`${flaggedXp} flagged XP row${flaggedXp !== 1 ? 's' : ''} outstanding`);
  return { ready: reasons.length === 0, reasons };
}

// ── Deleted Actions Recovery ─────────────────────────────────────────────────

let procDeletedOpen = false;

/**
 * Returns a flat list of all deleted actions across all subs:
 * { subId, charName, keyPart, label, description, source: 'player'|'st' }
 */
function _buildDeletedList(subs) {
  const list = [];
  for (const sub of subs) {
    const { charName } = resolveSubChar(sub, '?');
    const resp = sub.responses || {};
    const raw  = sub._raw    || {};

    // ── Player-deleted actions ──
    for (const keyPart of (sub.st_review?.deleted_action_keys || [])) {
      let label = keyPart;
      let description = '';

      if (keyPart === 'feeding') {
        label = 'Feeding';
        description = raw.feeding?.method || resp.feeding_description || '';
      } else if (keyPart === 'travel') {
        label = 'Travel';
        description = raw.submission?.narrative?.travel_description || resp.travel || '';
      } else if (keyPart === 'acq:resources') {
        label = 'Resource Acquisitions';
      } else if (keyPart === 'acq:skills') {
        label = 'Skill Acquisitions';
      } else {
        const projM    = keyPart.match(/^proj:(\d+)$/);
        const meritM   = keyPart.match(/^merit:(\d+)$/);
        const sorceryM = keyPart.match(/^sorcery:(\d+)$/);

        if (projM) {
          const idx  = parseInt(projM[1]);
          const slot = idx + 1;
          const title  = resp[`project_${slot}_title`] || `Project ${slot}`;
          const action = resp[`project_${slot}_action`] || '';
          label = `Project ${slot}: ${title}`;
          description = action ? ACTION_TYPE_LABELS?.[action] || action : '';
        } else if (meritM) {
          const idx    = parseInt(meritM[1]);
          const action = sub.merit_actions?.[idx] || {};
          label = action.merit_type ? (ACTION_TYPE_LABELS?.[action.merit_type] || action.merit_type) : `Merit action ${idx + 1}`;
          description = action.desired_outcome || action.description || '';
        } else if (sorceryM) {
          const n    = parseInt(sorceryM[1]);
          const rite = resp[`sorcery_${n}_rite`] || `Sorcery ${n}`;
          const trad = resp['sorcery_1_tradition'] || resp['sorcery_tradition'] || 'Sorcery';
          label = `${trad}: ${rite}`;
          description = normaliseSorceryTargets(resp[`sorcery_${n}_targets`]);
        }
      }

      list.push({ subId: sub._id, charName, keyPart, label, description: description.slice(0, 80), source: 'player' });
    }

    // ── ST-deleted actions ──
    for (let idx = 0; idx < (sub.st_actions || []).length; idx++) {
      const a = sub.st_actions[idx];
      if (!a._deleted) continue;
      list.push({
        subId: sub._id,
        charName,
        keyPart: `st:${idx}`,
        label: a.label || a.action_type || 'ST Action',
        description: (a.description || '').slice(0, 80),
        source: 'st',
      });
    }
  }
  return list;
}

function renderDeletedActionsSection(subs) {
  const list = _buildDeletedList(subs);
  if (!list.length) return '';

  let h = `<div class="proc-phase-section proc-deleted-section">`;
  h += `<div class="proc-phase-header proc-deleted-toggle" data-deleted-toggle>`;
  h += `<span class="proc-phase-chevron">${procDeletedOpen ? '\u25BC' : '\u25BA'}</span>`;
  h += ` Deleted Actions <span class="proc-phase-badge">${list.length}</span>`;
  h += `</div>`;

  if (procDeletedOpen) {
    h += `<div class="proc-deleted-list">`;
    for (const item of list) {
      const srcBadge = item.source === 'st' ? ' <span class="proc-row-st-badge">[ST]</span>' : '';
      const desc = item.description ? ` \u2014 ${esc(item.description)}` : '';
      h += `<div class="proc-deleted-row">`;
      h += `<span class="proc-row-char">${esc(item.charName)}</span>`;
      h += `<span class="proc-deleted-label">${esc(item.label)}${srcBadge}${desc}</span>`;
      h += `<button class="proc-restore-btn dt-btn dt-btn-sm" data-sub-id="${esc(item.subId)}" data-key-part="${esc(item.keyPart)}" data-source="${item.source}">Restore</button>`;
      h += `</div>`;
    }
    h += `</div>`;
  }

  h += `</div>`;
  return h;
}

// ── XP Review Step (Epic 3 — Stories 3.1 + 3.2 + 3.3) ───────────────────────

function renderXpReviewStep() {
  // Only include submissions that have xp_spend rows
  const xpSubs = submissions.filter(s => {
    try {
      const rows = JSON.parse(s.responses?.xp_spend || '[]');
      return rows.some(r => r.category || r.item);
    } catch { return false; }
  });

  if (!xpSubs.length) return '';

  const isExpanded = expandedPhases.has('xp_review');

  // Summary count across all subs
  let totalRows = 0, totalApproved = 0;
  for (const s of xpSubs) {
    try {
      const rows = JSON.parse(s.responses?.xp_spend || '[]').filter(r => r.category || r.item);
      totalRows += rows.length;
      totalApproved += rows.filter((_, i) => s.st_review?.xp_approvals?.[i]?.status === 'approved').length;
    } catch { /* ignore */ }
  }
  const stepBadge = _progressBadge(totalApproved, totalRows, 'All approved');

  let h = '<div class="proc-phase-section">';
  h += _renderPhaseHeader('xp_review', `Step 10 \u2014 XP Review${stepBadge}`, xpSubs.length, 'submission', isExpanded);

  if (isExpanded) {
    for (const s of xpSubs) {
      let rows = [];
      // New format: project_N_xp_category/item
      for (let n = 1; n <= 4; n++) {
        if (s.responses?.[`project_${n}_action`] !== 'xp_spend') continue;
        const cat  = s.responses?.[`project_${n}_xp_category`] || '';
        const item = s.responses?.[`project_${n}_xp_item`] || '';
        if (cat && item) {
          const costMap = { attribute: 4, skill: 2, discipline: 3, rite: 4, devotion: 2 };
          const cost = costMap[cat] || 1;
          rows.push({ category: cat, item, cost, dotsBuying: 1, _proj: n });
        } else {
          // Legacy free-text fallback
          const legacy = s.responses?.[`project_${n}_xp_trait`] || s.responses?.[`project_${n}_xp`];
          if (legacy) rows.push({ category: 'xp_spend', item: legacy, cost: null, _proj: n });
        }
      }
      // dt-form.26: top-level `responses.xp_spend` is now a mirror built
      // from the per-slot `project_N_xp_rows` (DAR-A1). The duplicate concat
      // here is harmless because the per-slot rows above were derived from
      // `project_N_xp_category`/`_xp_item` (legacy single-row keys), while
      // the top-level mirror carries the FULL multi-row breakdown across
      // all xp_spend slots. Reading both paths gives the ST every row even
      // for legacy-shaped or transitional submissions; rows from the
      // per-slot loop above are picked up here as duplicates only when a
      // slot still has both shapes (transition window).
      try {
        const adminRows = JSON.parse(s.responses?.xp_spend || '[]').filter(r => r.category || r.item);
        rows = rows.concat(adminRows);
      } catch { /* ignore */ }
      if (!rows.length) continue;

      const { char, charName } = resolveSubChar(s);
      const isBlockExpanded = xpReviewExpanded.has(s._id);
      const approvals = s.st_review?.xp_approvals || {};
      const doneHere = rows.filter((_, i) => approvals[i]?.status === 'approved').length;
      const charBadge = _progressBadge(doneHere, rows.length, 'Done');

      // Count how many project slots are xp_spend actions (sets the "action slots" budget)
      let xpActionSlots = 0;
      for (let n = 1; n <= 4; n++) {
        if (s.responses?.[`project_${n}_action`] === 'xp_spend') xpActionSlots++;
      }

      h += `<div class="proc-preread-char${isBlockExpanded ? ' expanded' : ''}" data-xp-review-id="${esc(s._id)}">`;
      h += `<span class="proc-row-char">${esc(charName)}${charBadge}</span>`;
      if (xpActionSlots) h += `<span class="proc-phase-count">${xpActionSlots} action slot${xpActionSlots !== 1 ? 's' : ''}</span>`;
      h += `<span class="proc-phase-toggle">${isBlockExpanded ? '&#9650;' : '&#9660;'}</span>`;
      h += `</div>`;

      if (isBlockExpanded) {
        h += `<div class="proc-preread-body">`;
        h += `<table class="proc-xp-table">`;
        h += `<thead><tr>`;
        h += `<th>Category</th><th>Purchase</th><th>Cost</th><th>Status</th>`;
        h += `</tr></thead><tbody>`;

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const appr = approvals[i] || {};
          const status = appr.status || '';
          const isApproved = status === 'approved';
          const isFlagged  = status === 'flagged';

          h += `<tr class="proc-xp-row${isFlagged ? ' flagged' : ''}">`;
          h += `<td class="proc-xp-cat">${esc(row.category || '—')}</td>`;
          h += `<td class="proc-xp-item">${esc(row.item || '—')}</td>`;
          h += `<td class="proc-xp-cost">${row.cost ? esc(String(row.cost)) + ' XP' : '—'}</td>`;
          h += `<td class="proc-xp-status">`;
          h += `<button class="dt-btn dt-btn-sm proc-xp-approve-btn${isApproved ? ' active' : ''}" data-sub-id="${esc(s._id)}" data-row-idx="${i}" data-status="approved">\u2713 Approve</button>`;
          h += `<button class="dt-btn dt-btn-sm proc-xp-flag-btn${isFlagged ? ' active' : ''}" data-sub-id="${esc(s._id)}" data-row-idx="${i}" data-status="flagged">\u26A0 Flag</button>`;
          h += `</td>`;
          h += `</tr>`;

          if (isFlagged) {
            h += `<tr class="proc-xp-note-row">`;
            h += `<td colspan="4">`;
            h += `<input class="proc-xp-note-input" type="text" data-sub-id="${esc(s._id)}" data-row-idx="${i}" placeholder="Flag reason..." value="${esc(appr.note || '')}">`;
            h += `</td></tr>`;
          }
        }

        h += `</tbody></table>`;
        h += `</div>`; // proc-preread-body
      }
    }
  }

  h += `</div>`; // proc-phase-section
  return h;
}

/** Compute the display state of a submission for the character strip. */
function _subChipState(sub, queue) {
  const vis = sub.st_review?.outcome_visibility || '';
  if (vis === 'published') return 'published';
  if (vis === 'ready')     return 'ready';

  const entries = queue.filter(e => e.subId === sub._id);
  const doneCt  = entries.filter(e => DONE_STATUSES.has(getEntryReview(e)?.pool_status)).length;


  const narr = sub.st_review?.narrative || {};
  const narrDone = NARR_KEYS.filter(k => narr[k]?.status === 'ready').length;

  const approval = sub.approval_status || 'pending';
  const isApproved = approval === 'approved' || approval === 'modified';

  if (doneCt === entries.length && narrDone === 4 && isApproved) return 'complete';
  if (doneCt > 0 || narrDone > 0) return 'partial';
  return 'none';
}

/** Render the compact character status strip above the processing queue. */
function renderCharacterStrip(queue) {
  if (!submissions.length) return '';


  const sorted = [...submissions].sort((a, b) => {
    const ca = _findCharForSub(a);
    const cb = _findCharForSub(b);
    const na = ca ? sortName(ca) : (a.character_name || '');
    const nb = cb ? sortName(cb) : (b.character_name || '');
    return na.localeCompare(nb);
  });

  let h = '<div class="proc-char-strip">';
  h += '<span class="proc-char-strip-label">Jump to</span>';

  for (const s of sorted) {
    const { char, charName: name } = resolveSubChar(s, '?');
    const state = _subChipState(s, queue);

    const entries = queue.filter(e => e.subId === s._id);
    const doneCt  = entries.filter(e => DONE_STATUSES.has(getEntryReview(e)?.pool_status)).length;
    const total   = entries.length;
    const narr    = s.st_review?.narrative || {};
    const narrDone = NARR_KEYS.filter(k => narr[k]?.status === 'ready').length;

    // Progress label: action fraction + narrative fraction, omit when fully done/not started
    let prog = '';
    if (state === 'partial') {
      const parts = [];
      if (total > 0) parts.push(`${doneCt}/${total}`);
      if (narrDone > 0 && narrDone < 4) parts.push(`\u270D${narrDone}/4`);
      prog = parts.join(' ');
    } else if (state === 'complete') {
      prog = '\u2713';
    } else if (state === 'ready' || state === 'published') {
      prog = state === 'published' ? 'Published' : 'Ready';
    }

    h += `<button class="proc-char-chip state-${state}" data-sub-id="${esc(s._id)}" title="${esc(name)}">`;
    h += `<span class="proc-char-chip-name">${esc(name)}</span>`;
    if (prog) h += `<span class="proc-char-chip-prog">${esc(prog)}</span>`;
    h += `</button>`;
  }

  h += '</div>';
  return h;
}

/** Render the phase-ordered processing queue into the given container. */
/**
 * Look up a queue entry by key using the map built at the start of the current
 * renderProcessingMode call. O(1); avoids rebuilding the queue on every event.
 */
function _getQueueEntry(key) { return _procQueueMap?.get(key) ?? null; }

/**
 * Build a per-card cross-action context map in two O(n) passes over the queue.
 * Phase 1a: index all entries by territory name via _entryTerritories.
 * Phase 1b: index sorcery entries by character name (proto.12).
 * Phase 2: for each entry, join across its territories → sameTerrEntries (excl self);
 *           join sorcery entries for same-territory characters → sorcEntries.
 */
function _buildProcCtxMap(queue) {
  // Phase 1a — territory → entries index
  const terrToEntries = new Map();
  for (const entry of queue) {
    for (const terr of _entryTerritories(entry)) {
      if (!terrToEntries.has(terr)) terrToEntries.set(terr, []);
      terrToEntries.get(terr).push(entry);
    }
  }
  // Phase 1b — char → sorcery entries index (proto.12)
  const sorcByChar = new Map();
  for (const entry of queue) {
    if (entry.source === 'sorcery') {
      if (!sorcByChar.has(entry.charName)) sorcByChar.set(entry.charName, []);
      sorcByChar.get(entry.charName).push(entry);
    }
  }
  // Phase 2 — assemble per-card context
  const map = new Map();
  for (const entry of queue) {
    const seen = new Set();
    const sameTerrEntries = [];
    for (const terr of _entryTerritories(entry)) {
      for (const e of (terrToEntries.get(terr) || [])) {
        if (e.key !== entry.key && !seen.has(e.key)) {
          seen.add(e.key);
          sameTerrEntries.push(e);
        }
      }
    }
    const sorcSeen = new Set();
    const sorcEntries = [];
    for (const e of sameTerrEntries) {
      for (const sorc of (sorcByChar.get(e.charName) || [])) {
        if (!sorcSeen.has(sorc.key)) {
          sorcSeen.add(sorc.key);
          sorcEntries.push(sorc);
        }
      }
    }
    map.set(entry.key, { sameTerrEntries, sorcEntries });
  }
  return map;
}

function _getProcCtx(key) { return _procCtxMap?.get(key) ?? { sameTerrEntries: [], sorcEntries: [] }; }

function _anyFilterActive() {
  return _procFilters.statuses.size > 0 || _procFilters.chars.size > 0
      || _procFilters.phases.size > 0  || _procFilters.territories.size > 0
      || _procFilters.sources.size > 0;
}

function _entryTerritories(entry) {
  const out = new Set();
  const _terrName = slug => {
    const id = resolveTerrId(slug);
    return id ? (TERRITORY_DATA.find(t => t.slug === id)?.name || null) : null;
  };
  if (entry.feedTerrs) {
    for (const [slug, val] of Object.entries(entry.feedTerrs)) {
      if (!val || val === 'none') continue;
      const name = _terrName(slug);
      if (name) out.add(name);
    }
  }
  if (entry.projTerritory) {
    const name = _terrName(entry.projTerritory);
    if (name) out.add(name);
  }
  return out;
}

function _filterQueue(queue) {
  if (!_anyFilterActive()) return queue;
  return queue.filter(e => {
    if (_procFilters.statuses.size) {
      const rev = getEntryReview(e);
      if (!_procFilters.statuses.has(_deriveActionRibbonState(rev))) return false;
    }
    if (_procFilters.chars.size && !_procFilters.chars.has(e.charName)) return false;
    if (_procFilters.phases.size && !_procFilters.phases.has(e.phase))  return false;
    if (_procFilters.territories.size) {
      const terrs = _entryTerritories(e);
      if (![...terrs].some(t => _procFilters.territories.has(t))) return false;
    }
    if (_procFilters.sources.size && !_procFilters.sources.has(_entrySourceType(e))) return false;
    return true;
  });
}

function _entrySourceType(entry) {
  const cat = entry.meritCategory;
  if (cat === 'allies') return 'allies';
  if (cat === 'status') return 'status';
  if (cat === 'contacts' || cat === 'staff') return 'contacts';
  if (cat === 'retainer' || cat === 'mentor') return 'retainers';
  return 'action';
}

/**
 * Wire ± ticker buttons (dec/inc) inside a processing-mode container.
 * All three modifier tickers share this logic; they differ only in selectors,
 * clamping, an optional secondary display, and which function runs after update.
 *
 * opts:
 *   decCls      — CSS class of the decrement button (e.g. 'proc-equip-mod-dec')
 *   incCls      — CSS class of the increment button
 *   panelCls    — CSS class of the panel that contains the input + display
 *   inputCls    — CSS class of the hidden value input inside the panel
 *   dispCls     — CSS class of the display span inside the panel
 *   clamp       — { min, max } to clamp the value, or null for free-range
 *   totalCls    — optional extra display span class (e.g. proc-proj-succ-total-val); null to skip
 *   afterUpdate — optional fn(container, key) called after the display is updated
 *   saveField   — key written to saveEntryReview (e.g. 'pool_mod_equipment')
 */
function _wireTickerHandler(container, { decCls, incCls, panelCls, inputCls, dispCls, clamp = null, totalCls = null, afterUpdate = null, saveField }) {
  container.querySelectorAll(`.${decCls}, .${incCls}`).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const panel = container.querySelector(`.${panelCls}[data-proc-key="${key}"]`);
      if (!panel) return;
      const valInp = panel.querySelector(`.${inputCls}`);
      const disp   = panel.querySelector(`.${dispCls}[data-proc-key="${key}"]`);
      let val = parseInt(valInp?.value || '0', 10);
      if (btn.classList.contains(decCls)) { if (!clamp || val > clamp.min) val--; }
      else                                { if (!clamp || val < clamp.max) val++; }
      if (valInp) valInp.value = val;
      const str = _fmtMod(val);
      if (disp) disp.textContent = str;
      if (totalCls) {
        const total = panel.querySelector(`.${totalCls}[data-proc-key="${key}"]`);
        if (total) total.textContent = str;
      }
      afterUpdate?.(container, key);
      const entry = _getQueueEntry(key);
      if (entry) await saveEntryReview(entry, { [saveField]: val });
    });
  });
}

function renderProcFilterBar(queue) {
  const chars      = [...new Set(queue.map(e => e.charName))].sort();
  const phasesSeen = [...new Set(queue.map(e => e.phase))];
  const terrsSeen  = [...new Set(queue.flatMap(e => [..._entryTerritories(e)]))].sort();
  const f          = _procFilters;

  let h = '<div class="proc-filter-bar">';

  // Status — fixed three pills
  h += '<div class="proc-filter-row">';
  h += '<div class="proc-filter-label">Status</div>';
  h += '<div class="proc-filter-pills">';
  for (const [val, label, state] of [['pending','Pending','none'],['valid','Valid','partial'],['complete','Complete','complete']]) {
    h += `<button class="proc-char-chip state-${state} proc-filter-pill${f.statuses.has(val) ? ' is-active' : ''}" data-filter-dim="statuses" data-filter-val="${esc(val)}">`;
    h += `<span class="proc-char-chip-name">${label}</span>`;
    h += `</button>`;
  }
  h += '</div></div>';

  // Character — chip style with N/M done count + state colour
  if (chars.length) {
    h += '<div class="proc-filter-row">';
    h += '<div class="proc-filter-label">Character</div>';
    h += '<div class="proc-filter-pills">';
    for (const char of chars) {
      const charEntries = queue.filter(e => e.charName === char);
      const doneCt = charEntries.filter(e => DONE_STATUSES.has(getEntryReview(e)?.pool_status)).length;
      const total  = charEntries.length;
      const state  = doneCt === 0 ? 'none' : doneCt === total ? 'complete' : 'partial';
      const firstPending = charEntries.find(e => !DONE_STATUSES.has(getEntryReview(e)?.pool_status));
      const stripPhase = firstPending?.phase || '';
      h += `<button class="proc-char-chip state-${state} proc-filter-pill${f.chars.has(char) ? ' is-active' : ''}" data-filter-dim="chars" data-filter-val="${esc(char)}" data-strip-char="${esc(char)}"${stripPhase ? ` data-strip-phase="${esc(stripPhase)}"` : ''}>`;
      h += `<span class="proc-char-chip-name">${esc(char)}</span>`;
      h += `</button>`;
    }
    h += '</div></div>';
  }

  // Phase — natural queue order, readable labels
  if (phasesSeen.length) {
    h += '<div class="proc-filter-row">';
    h += '<div class="proc-filter-label">Phase</div>';
    h += '<div class="proc-filter-pills">';
    for (const phaseKey of phasesSeen) {
      const label = PHASE_LABELS[phaseKey] || phaseKey;
      h += `<button class="proc-char-chip state-none proc-filter-pill${f.phases.has(phaseKey) ? ' is-active' : ''}" data-filter-dim="phases" data-filter-val="${esc(phaseKey)}">`;
      h += `<span class="proc-char-chip-name">${esc(label)}</span>`;
      h += `</button>`;
    }
    h += '</div></div>';
  }

  // Source — fixed pills: Action, Allies, Status, Contacts, Retainers
  h += '<div class="proc-filter-row">';
  h += '<div class="proc-filter-label">Source</div>';
  h += '<div class="proc-filter-pills">';
  for (const [val, label] of [['action','Action'],['allies','Allies'],['status','Status'],['contacts','Contacts'],['retainers','Retainers']]) {
    h += `<button class="proc-char-chip state-none proc-filter-pill${f.sources.has(val) ? ' is-active' : ''}" data-filter-dim="sources" data-filter-val="${esc(val)}">`;
    h += `<span class="proc-char-chip-name">${label}</span>`;
    h += `</button>`;
  }
  h += '</div></div>';

  // Territory
  if (terrsSeen.length) {
    h += '<div class="proc-filter-row">';
    h += '<div class="proc-filter-label">Territory</div>';
    h += '<div class="proc-filter-pills">';
    for (const terr of terrsSeen) {
      h += `<button class="proc-char-chip state-none proc-filter-pill${f.territories.has(terr) ? ' is-active' : ''}" data-filter-dim="territories" data-filter-val="${esc(terr)}">`;
      h += `<span class="proc-char-chip-name">${esc(terr)}</span>`;
      h += `</button>`;
    }
    h += '</div></div>';
  }

  // Clear all — only when filter is active
  if (_anyFilterActive()) {
    h += '<div class="proc-filter-clear-row">';
    h += '<button class="proc-filter-clear">Clear all</button>';
    h += '</div>';
  }

  h += '</div>'; // proc-filter-bar
  return h;
}

async function _hydrateMgPriorOutcomes() {
  const placeholders = document.querySelectorAll('.proc-mg-prior-outcome.mg-prior-loading');
  if (!placeholders.length) return;

  // Group by priorCycleId so we fetch each prior cycle at most once
  const byPriorCycle = new Map();
  placeholders.forEach(el => {
    const cid = el.dataset.priorCycleId;
    if (!cid) return;
    if (!byPriorCycle.has(cid)) byPriorCycle.set(cid, []);
    byPriorCycle.get(cid).push(el);
  });

  for (const [priorCycleId, els] of byPriorCycle) {
    if (!_mgPriorSubCache.has(priorCycleId)) {
      try {
        const subs = await getSubmissionsForCycle(priorCycleId);
        _mgPriorSubCache.set(priorCycleId, subs);
      } catch {
        _mgPriorSubCache.set(priorCycleId, []);
      }
    }
    const priorSubs = _mgPriorSubCache.get(priorCycleId) || [];

    els.forEach(el => {
      const charId   = el.dataset.charId;
      const riteName = el.dataset.riteName;
      const textEl   = el.querySelector('.mg-prior-text');
      if (!textEl) return;

      const priorSub = priorSubs.find(s => String(s.character_id) === String(charId));
      let resolutionText = '';

      if (priorSub && priorSub.sorcery_review) {
        const r = priorSub.responses || {};
        const slotCount = parseInt(r.sorcery_slot_count || '3', 10);
        for (let n = 1; n <= slotCount; n++) {
          if (r[`sorcery_${n}_rite`] === riteName && r[`sorcery_${n}_mandragora`] === 'yes') {
            resolutionText = (priorSub.sorcery_review[n] || {}).ritual_result_note || '';
            break;
          }
        }
      }

      textEl.innerHTML = resolutionText
        ? esc(resolutionText)
        : '<em>No prior resolution recorded</em>';
      el.classList.remove('mg-prior-loading');
    });
  }
}

function renderProcessingMode(container) {
  renderCityOverview();

  if (!submissions.length) {
    container.innerHTML = '<p class="placeholder">No submissions in this cycle.</p>';
    return;
  }

  const queue = buildProcessingQueue(submissions);
  if (!queue.length) {
    container.innerHTML = '<p class="placeholder">No actions found in this cycle.</p>';
    return;
  }
  _procQueueMap = new Map(queue.map(e => [e.key, e]));
  _procCtxMap   = _buildProcCtxMap(queue);
  const filteredQueue = _filterQueue(queue);

  // Group by phase — built from full queue so all phases appear in natural order
  const byPhase = new Map();
  for (const entry of queue) {
    if (!byPhase.has(entry.phase)) byPhase.set(entry.phase, []);
    byPhase.get(entry.phase).push(entry);
  }

  // ── Cross-reference index (single O(n) pass) ──
  // Keys: 'terr:<canonical-slug>' | 'inv-target:<charName>'
  // Values: [{ charName, label, phase }, ...] — excludes self at render time
  // 496.2 QA: territory keys are normalised through resolveTerrId so both
  // OID-keyed (post-496.2) and slug-keyed (legacy) submissions index under
  // the same canonical slug. Without normalisation, a 496.2 character feeding
  // in The Harbour would index as 'terr:69d5...' while a pre-496.2 character
  // would index as 'terr:the_harbour' — same territory, different keys, no
  // cross-reference.
  _xrefIndex = new Map();
  for (const e of queue) {
    if (e.projTerritory) {
      const canon = resolveTerrId(e.projTerritory) || e.projTerritory;
      const k = `terr:${canon}`;
      if (!_xrefIndex.has(k)) _xrefIndex.set(k, []);
      _xrefIndex.get(k).push({ charName: e.charName, label: e.label, phase: e.phase });
    }
    if (e.feedTerrs) {
      for (const terr of Object.keys(e.feedTerrs)) {
        const canon = resolveTerrId(terr) || terr;
        const k = `terr:${canon}`;
        if (!_xrefIndex.has(k)) _xrefIndex.set(k, []);
        _xrefIndex.get(k).push({ charName: e.charName, label: 'Feeding', phase: e.phase });
      }
    }
    if (e.actionType === 'investigate') {
      const eSub = submissions.find(s => String(s._id) === String(e.subId));
      const eRev = e.source === 'project'
        ? (eSub?.projects_resolved?.[e.actionIdx] || {})
        : (eSub?.merit_actions_resolved?.[e.actionIdx] || {});
      const target = eRev.investigate_target_char;
      if (target) {
        const k = `inv-target:${target}`;
        if (!_xrefIndex.has(k)) _xrefIndex.set(k, []);
        _xrefIndex.get(k).push({ charName: e.charName, label: e.label, phase: e.phase });
      }
    }
  }

  // Build sorcery-by-target index (charName key → rites with mechanical results)
  _sorcByTarget = new Map();
  for (const e of queue) {
    if (e.source !== 'sorcery') continue;
    const eSub = submissions.find(s => String(s._id) === String(e.subId));
    const eRev = (eSub?.sorcery_review || {})[e.actionIdx] || {};
    const resultNote = eRev.ritual_result_note;
    if (!resultNote) continue;
    const targets = (eRev.sorc_targets || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const tKey of targets) {
      if (!_sorcByTarget.has(tKey)) _sorcByTarget.set(tKey, []);
      _sorcByTarget.get(tKey).push({ entry: e, riteName: e.riteName, tradition: e.tradition, resultNote });
    }
  }

  let h = '<div class="proc-queue">';

  // Filter bar — replaces the character strip
  h += renderProcFilterBar(queue);

  for (const [phaseKey, entries] of byPhase) {
    const label = PHASE_LABELS[phaseKey] || phaseKey;
    // Completion count for this phase
    const doneCount = entries.filter(e => DONE_STATUSES.has(getEntryReview(e)?.pool_status)).length;
    const phaseProgressBadge = _progressBadge(doneCount, entries.length, '');

    const visibleEntries = filteredQueue.filter(e => e.phase === phaseKey);
    if (_anyFilterActive() && visibleEntries.length === 0) continue;

    // JDT-5: joint phase groups participant rows by joint_id and wraps
    // each group with a shared header + outcome textarea. Other phases
    // render entries linearly as before.
    if (phaseKey === 'joint') {
        const byJoint = new Map();
        for (const entry of visibleEntries) {
          const jid = entry.joint_id || '_orphan';
          if (!byJoint.has(jid)) byJoint.set(jid, []);
          byJoint.get(jid).push(entry);
        }
        for (const [, jointEntries] of byJoint) {
          jointEntries.sort((a, b) => {
            if (a.joint_role === 'lead' && b.joint_role !== 'lead') return -1;
            if (b.joint_role === 'lead' && a.joint_role !== 'lead') return 1;
            return (a.charName || '').localeCompare(b.charName || '');
          });
          const joint = jointEntries[0]?.joint_doc || null;
          h += renderJointGroup(joint, jointEntries);
        }
    } else {
      for (const entry of visibleEntries) {
        const isExpanded = procExpandedKeys.has(entry.key);
        const review = getEntryReview(entry);
        const status = review?.pool_status || 'pending';
        const shortDesc = entry.projTitle || '';
        const isDone = DONE_STATUSES.has(status);
        h += `<div class="proc-action-row${isExpanded ? ' expanded' : ''}${isDone ? ' proc-action-done' : ''}" data-proc-key="${esc(entry.key)}">`;
        h += `<span class="proc-row-char">${esc(entry.charName)}</span>`;
        h += `<span class="proc-row-label">${esc(entry.label)}${entry.source === 'st_created' ? ' <span class="proc-row-st-badge">[ST]</span>' : ''}</span>`;
        h += `<span class="proc-row-desc">${esc(shortDesc)}</span>`;
        const _attributedName =
          (status === 'validated' && review?.pool_validated_by) ? review.pool_validated_by :
          (status === 'confirmed' && review?.pool_confirmed_by) ? review.pool_confirmed_by :
          (status === 'resolved'  && review?.pool_resolved_by)  ? review.pool_resolved_by  : '';
        const _chipState = _deriveActionRibbonState(review);
        const _chipLabels = { pending: 'Pending', valid: 'Valid', complete: 'Complete' };
        h += `<span class="proc-row-status-cell">`;
        if (_attributedName) h += `<span class="proc-row-validator">${esc(_attributedName)}</span>`;
        h += `<span class="proc-row-status ar-${_chipState}">${_chipLabels[_chipState]}</span>`;
        h += `</span>`;
        if (review?.second_opinion) h += `<span class="proc-row-second-opinion-dot" title="Flagged for second opinion">\u25CF</span>`;
        h += `<span class="proc-row-actions">`;
        h += `<button class="proc-duplicate-btn dt-btn dt-btn-sm" data-proc-key="${esc(entry.key)}" title="Duplicate">Dup</button>`;
        h += `<button class="proc-delete-row-btn dt-btn dt-btn-sm" data-proc-key="${esc(entry.key)}" title="Delete">Del</button>`;
        h += `</span>`;
        h += '</div>';

        if (isExpanded) {
          h += renderActionPanel(entry, review);
        }
      }
      } // close JDT-5 joint-phase branch's else

      // Investigations tracker lives inside the Investigative phase
      if (phaseKey === 'investigate') {
        h += '<div id="dt-investigations"></div>';
      }

  }

  // If no investigate actions were submitted, still show the investigations tracker
  if (!byPhase.has('investigate')) {
    h += '<div id="dt-investigations"></div>';
  }

  // XP Review — Step 10
  h += renderXpReviewStep();

  // Add ST Action form
  h += _renderAddStActionForm(submissions);

  // Deleted Actions recovery
  h += renderDeletedActionsSection(submissions);

  h += '</div>'; // proc-queue
  container.innerHTML = h;

  // Render investigations into its placeholder inside the investigate phase
  renderInvestigations();

  // Wire character strip chips — expand first pending action and scroll to it
  container.querySelectorAll('.proc-char-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const subId = chip.dataset.subId;
      const q = buildProcessingQueue(submissions);
      const firstPending = q.find(e => e.subId === subId && !DONE_STATUSES.has(getEntryReview(e)?.pool_status));
      const jumpEntry = firstPending || q.find(e => e.subId === subId);
      if (!jumpEntry) return;
      procExpandedKeys.add(jumpEntry.key);
      expandedPhases.add(jumpEntry.phase);
      renderProcessingMode(container);
      requestAnimationFrame(() => {
        container.querySelector(`.proc-action-row[data-proc-key="${jumpEntry.key}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  });

  // DTFP-5: Wire feeding method override chips
  container.querySelectorAll('.proc-feed-vi-chip').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const subId = btn.dataset.subId;
      const newVal = btn.dataset.value || null;
      const sub = submissions.find(s => s._id === subId);
      if (sub) {
        if (!sub.st_review) sub.st_review = {};
        if (newVal) sub.st_review.feed_violence_st_override = newVal;
        else delete sub.st_review.feed_violence_st_override;
      }
      await updateSubmission(subId, { 'st_review.feed_violence_st_override': newVal });
      container.querySelectorAll(`.proc-feed-vi-chip[data-sub-id="${subId}"]`).forEach(b => {
        b.classList.toggle('is-active', b.dataset.value === (newVal || ''));
      });
    });
  });

  // DTFP-5: Wire blood type override chips
  container.querySelectorAll('.proc-feed-bt-chip').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const subId = btn.dataset.subId;
      const newVal = btn.dataset.value || null;
      const sub = submissions.find(s => s._id === subId);
      if (sub) {
        if (!sub.st_review) sub.st_review = {};
        if (newVal) sub.st_review.feed_blood_type_st_override = newVal;
        else delete sub.st_review.feed_blood_type_st_override;
      }
      await updateSubmission(subId, { 'st_review.feed_blood_type_st_override': newVal });
      container.querySelectorAll(`.proc-feed-bt-chip[data-sub-id="${subId}"]`).forEach(b => {
        b.classList.toggle('is-active', b.dataset.value === (newVal || ''));
      });
    });
  });

  // Wire filter pills — character chips use replace shortcut (proto.3); others toggle
  container.querySelectorAll('.proc-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const dim = btn.dataset.filterDim;
      const val = btn.dataset.filterVal;
      if (!dim || !val || !_procFilters[dim]) return;
      if (_procFilters[dim].has(val)) _procFilters[dim].delete(val);
      else _procFilters[dim].add(val);
      renderProcessingMode(container);
    });
  });

  // Wire filter clear
  container.querySelector('.proc-filter-clear')?.addEventListener('click', () => {
    _procFilters.statuses    = new Set();
    _procFilters.chars       = new Set();
    _procFilters.phases      = new Set();
    _procFilters.territories = new Set();
    _procFilters.sources     = new Set();
    renderProcessingMode(container);
  });

  // Wire action type recategorisation selects
  container.querySelectorAll('.proc-recat-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      // Skip selects that carry proc-recat-select only for styling — they have their own handlers
      if (sel.classList.contains('proc-prot-merit-sel') ||
          sel.classList.contains('proc-merit-link-sel') ||
          sel.classList.contains('proc-inv-char-sel') ||
          sel.classList.contains('proc-attack-char-sel') || // no longer rendered; kept as guard
          sel.classList.contains('proc-attack-merit-sel') ||
          sel.classList.contains('proc-inv-secrecy-sel') ||
          sel.classList.contains('proc-feed-blood-sel') ||
          sel.classList.contains('proc-sorc-tradition-sel') ||
          sel.classList.contains('proc-sorc-rite-sel')) return;
      const key = sel.dataset.procKey;
      const newType = sel.value;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      // Clear override if ST selects the original player-submitted type
      const patch = { action_type_override: (!newType || newType === entry.originalActionType) ? null : newType };
      // Maintenance auto-resolves as no-roll
      if (newType === 'maintenance') patch.pool_status = 'maintenance';
      await saveEntryReview(entry, patch);
      renderProcessingMode(container);
    });
  });

  // Wire row clicks — toggle individual rows independently
  container.querySelectorAll('.proc-action-row').forEach(row => {
    row.addEventListener('click', () => {
      const key = row.dataset.procKey;
      if (procExpandedKeys.has(key)) { procExpandedKeys.delete(key); } else { procExpandedKeys.add(key); }
      renderProcessingMode(container);
    });
  });

  // Wire territory pill buttons — save override and refresh matrix only
  container.querySelectorAll('.proc-terr-pill').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const subId   = btn.dataset.subId;
      const context = btn.dataset.terrContext; // numeric string for projects, 'feeding', 'allies_N'
      const terrId  = btn.dataset.terrId; // '' = clear/deselect
      const sub = submissions.find(s => s._id === subId);
      if (!sub) return;
      if (!sub.st_review) sub.st_review = {};
      if (!sub.st_review.territory_overrides) sub.st_review.territory_overrides = {};

      if (context === 'feeding' || context === 'feeding_rote') {
        // Multi-select: toggle id in/out of array; em-dash clears all
        let arr = Array.isArray(sub.st_review.territory_overrides[context])
          ? [...sub.st_review.territory_overrides[context]] : [];
        if (!terrId) {
          arr = []; // clear all
        } else {
          const idx = arr.indexOf(terrId);
          if (idx >= 0) arr.splice(idx, 1); else arr.push(terrId);
        }
        if (arr.length) {
          sub.st_review.territory_overrides[context] = arr;
          await updateSubmission(subId, { [`st_review.territory_overrides.${context}`]: arr });
        } else {
          delete sub.st_review.territory_overrides[context];
          await updateSubmission(subId, { [`st_review.territory_overrides.${context}`]: null });
        }
        // Update pill active states in-place
        const newSet = new Set(sub.st_review.territory_overrides?.[context] || []);
        const pillRow = container.querySelector(`.proc-terr-pill-row[data-sub-id="${subId}"][data-terr-context="${context}"]`);
        if (pillRow) {
          pillRow.querySelectorAll('.proc-terr-pill').forEach(p => {
            const pid = p.dataset.terrId;
            p.classList.toggle('is-active', pid === '' ? newSet.size === 0 : newSet.has(pid));
          });
        }
      } else {
        // Single-select: existing behaviour
        if (terrId) {
          sub.st_review.territory_overrides[context] = terrId;
          await updateSubmission(subId, { [`st_review.territory_overrides.${context}`]: terrId });
        } else {
          delete sub.st_review.territory_overrides[context];
          await updateSubmission(subId, { [`st_review.territory_overrides.${context}`]: null });
        }
        // Update pill active states in-place
        const pillRow = container.querySelector(`.proc-terr-pill-row[data-sub-id="${subId}"][data-terr-context="${context}"]`);
        if (pillRow) {
          pillRow.querySelectorAll('.proc-terr-pill').forEach(p => {
            p.classList.toggle('is-active', p.dataset.terrId === terrId);
          });
        }
      }

      // Refresh the territories matrix
      renderCityOverview();
    });
  });

  // Wire clear pool button — clears pool_validated so ST can rebuild from scratch
  container.querySelectorAll('.proc-pool-clear-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { pool_validated: '', pool_status: 'pending', pool_confirmed_by: '' });
      renderProcessingMode(container);
    });
  });

  // Wire confirm pool button — saves pool expr and advances pool_status to confirmed
  container.querySelectorAll('.proc-confirm-pool-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;

      const user   = getUser();
      const stName = user?.global_name || user?.username || 'ST';
      const patch  = { pool_status: 'confirmed', pool_confirmed_by: stName };

      let poolExpr = getEntryReview(entry)?.pool_validated || '';
      if (!poolExpr) {
        const builderEl = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
        if (builderEl) poolExpr = _readBuilderExpr(builderEl) || '';
      }
      if (poolExpr) {
        const rpanel  = container.querySelector(`.proc-feed-right[data-proc-key="${key}"]`);
        const _naV    = rpanel?.querySelector('.proc-proj-9a')?.checked  || false;
        const _8aV    = rpanel?.querySelector('.proc-proj-8a')?.checked  || false;
        patch.pool_validated = poolExpr;
        patch.nine_again     = _naV;
        patch.eight_again    = _8aV;
        if (entry.source === 'project') {
          patch.rote = rpanel?.querySelector('.proc-pool-rote')?.checked || false;
        }
      }

      if (entry.source === 'feeding') {
        const vitaePanel = container.querySelector(`.proc-feed-vitae-panel[data-proc-key="${key}"]`);
        if (vitaePanel) {
          const vitateTally = {
            herd:               parseInt(vitaePanel.dataset.herd,       10) || 0,
            ambience:           parseInt(vitaePanel.dataset.ambience,   10) || 0,
            ambience_territory: vitaePanel.dataset.terrLabel || '',
            oath_of_fealty:     parseInt(vitaePanel.dataset.oof,        10) || 0,
            ghouls:             parseInt(vitaePanel.dataset.ghouls,     10) || 0,
            rite_cost:          parseInt(vitaePanel.dataset.riteCost,   10) || 0,
            manual:             parseInt(vitaePanel.dataset.manual,     10) || 0,
            total_bonus:        parseInt(vitaePanel.dataset.totalBonus, 10) || 0,
          };
          await updateSubmission(entry.subId, { feeding_vitae_tally: vitateTally });
          const sub = submissions.find(s => s._id === entry.subId);
          if (sub) sub.feeding_vitae_tally = vitateTally;
        }
      }

      await saveEntryReview(entry, patch);
      renderProcessingMode(container);
    });
  });

  // ── Feeding description card — Edit / Save / Cancel ──
  container.querySelectorAll('.proc-feed-desc-ta, .proc-feed-name-input, .proc-feed-pool-input, .proc-feed-bonuses-input, .proc-proj-name-input, .proc-proj-title-input, .proc-proj-outcome-input, .proc-proj-merits-input, .proc-sorc-notes-input').forEach(el => {
    el.addEventListener('click',  e => e.stopPropagation());
    el.addEventListener('mousedown', e => e.stopPropagation());
  });
  container.querySelectorAll('.proc-feed-desc-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const card = btn.closest('.proc-feed-desc-card');
      card.querySelector('.proc-feed-desc-view').style.display = 'none';
      card.querySelector('.proc-feed-desc-edit').style.display = '';
      btn.style.display = 'none';
    });
  });
  container.querySelectorAll('.proc-feed-desc-cancel-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const card = btn.closest('.proc-feed-desc-card');
      card.querySelector('.proc-feed-desc-view').style.display = '';
      card.querySelector('.proc-feed-desc-edit').style.display = 'none';
      card.querySelector('.proc-feed-desc-edit-btn').style.display = '';
    });
  });
  container.querySelectorAll('.proc-feed-desc-save-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const card       = btn.closest('.proc-feed-desc-card');
      const name       = card.querySelector('.proc-feed-name-input').value.trim();
      const desc       = card.querySelector('.proc-feed-desc-ta').value.trim();
      const bloodType  = card.querySelector('.proc-feed-blood-sel').value;
      const playerPool = card.querySelector('.proc-feed-pool-input').value.trim();
      const bonuses    = card.querySelector('.proc-feed-bonuses-input').value.trim();
      await saveEntryReview(entry, { name, description: desc, blood_type: bloodType, pool_player: playerPool, bonuses });
      renderProcessingMode(container);
    });
  });
  container.querySelectorAll('.proc-proj-desc-save-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const card       = btn.closest('.proc-feed-desc-card');
      const title      = card.querySelector('.proc-proj-title-input').value.trim();
      const outcome    = card.querySelector('.proc-proj-outcome-input').value.trim();
      const desc       = card.querySelector('.proc-feed-desc-ta').value.trim();
      const playerPool = card.querySelector('.proc-feed-pool-input').value.trim();
      const merits     = card.querySelector('.proc-proj-merits-input').value.trim();
      await saveEntryReview(entry, { title, desired_outcome: outcome, description: desc, pool_player: playerPool, merits_bonuses: merits });
      renderProcessingMode(container);
    });
  });

  // Wire sorcery details card save
  container.querySelectorAll('.proc-sorc-desc-save-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const card  = btn.closest('.proc-feed-desc-card');
      const notes = card.querySelector('.proc-sorc-notes-input').value.trim();
      await saveEntryReview(entry, { sorc_notes: notes || null });
      renderProcessingMode(container);
    });
  });

  // Wire merit details card save
  container.querySelectorAll('.proc-merit-desc-save-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const card    = btn.closest('.proc-feed-desc-card');
      const outcome = card.querySelector('.proc-merit-outcome-input').value.trim();
      const desc    = card.querySelector('.proc-merit-desc-ta').value.trim();
      await saveEntryReview(entry, { desired_outcome: outcome, description: desc });
      renderProcessingMode(container);
    });
  });

  // ── JDT-5: joint outcome save ─────────────────────────────────────────
  // Persists cycle.joint_projects[i].st_joint_outcome via the existing PUT
  // /api/downtime_cycles/:id route (no new endpoint required for v1).
  container.querySelectorAll('.proc-joint-outcome-save-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const jointId = btn.dataset.jointId;
      if (!jointId || !currentCycle?._id) return;
      const ta = container.querySelector(`.proc-joint-outcome-ta[data-joint-id="${jointId}"]`);
      if (!ta) return;
      const statusEl = container.querySelector(`.proc-joint-outcome-status[data-joint-id="${jointId}"]`);
      const text = ta.value;
      try {
        const newJoints = (currentCycle.joint_projects || []).map(j =>
          String(j._id) === String(jointId) ? { ...j, st_joint_outcome: text } : j
        );
        await apiPut(`/api/downtime_cycles/${currentCycle._id}`, { joint_projects: newJoints });
        currentCycle.joint_projects = newJoints;
        if (statusEl) {
          statusEl.textContent = 'Saved';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Save failed: ' + err.message;
      }
    });
  });

  // ── JDT-6: ST override cancel button on joint group panel ─────────────
  container.querySelectorAll('.proc-joint-st-override-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const jointId = btn.dataset.jointId;
      if (!jointId || !currentCycle?._id) return;
      const ok = window.confirm('ST override: cancel this joint and free all participant slots? This cannot be undone.');
      if (!ok) return;
      const statusEl = container.querySelector(`.proc-joint-st-override-status[data-joint-id="${jointId}"]`);
      try {
        await apiPost(`/api/downtime_cycles/${currentCycle._id}/joint_projects/${jointId}/cancel`, {
          st_override: true,
        });
        if (statusEl) {
          statusEl.textContent = 'Cancelled. Reload to refresh the queue.';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = 'Override failed: ' + err.message;
      }
    });
  });

  // Wire pool_validated free-text input (non-feeding fallback — save on blur)
  container.querySelectorAll('.proc-pool-input').forEach(inp => {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('blur', async e => {
      const key   = inp.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { pool_validated: inp.value.trim() });
    });
  });

  // Wire pool builder dropdowns → live total update
  container.querySelectorAll('.proc-pool-attr, .proc-pool-skill, .proc-pool-disc').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', e => {
      e.stopPropagation();
      const procKey = sel.dataset.procKey;
      if (sel.classList.contains('proc-pool-skill')) {
        // Set nineAgain flag and render spec toggles before computing pool total
        _updateFeedBuilderMeta(container, procKey);
        // Reset spec selection when skill changes — specs from old skill no longer apply
        const skillChgEntry = _getQueueEntry(procKey);
        if (skillChgEntry && (skillChgEntry.source === 'feeding' || skillChgEntry.source === 'project')) {
          saveEntryReview(skillChgEntry, { active_feed_specs: [], pool_mod_spec: 0 });
        }
      }
      _refreshPoolBuilder(container, procKey);
      const selEntry = _getQueueEntry(procKey);
      if (selEntry) _autoSetStOverride(procKey, selEntry);
    });
  });

  // Wire modifier decrement button
  container.querySelectorAll('.proc-pool-mod-dec').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key     = btn.dataset.procKey;
      const builder = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
      if (!builder) return;
      const modInput = builder.querySelector('.proc-pool-mod-val');
      const modDisp  = builder.querySelector(`.proc-pool-mod-disp[data-proc-key="${key}"]`);
      let val = parseInt(modInput.value || '0', 10);
      if (val > -5) val--;
      modInput.value = val;
      if (modDisp) modDisp.textContent = _fmtMod(val);
      _updatePoolTotal(container, key);
    });
  });

  // Wire modifier increment button
  container.querySelectorAll('.proc-pool-mod-inc').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key     = btn.dataset.procKey;
      const builder = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
      if (!builder) return;
      const modInput = builder.querySelector('.proc-pool-mod-val');
      const modDisp  = builder.querySelector(`.proc-pool-mod-disp[data-proc-key="${key}"]`);
      let val = parseInt(modInput.value || '0', 10);
      if (val < 5) val++;
      modInput.value = val;
      if (modDisp) modDisp.textContent = _fmtMod(val);
      _updatePoolTotal(container, key);
    });
  });

  // Wire rote checkbox → save immediately to st_review.feeding_rote
  container.querySelectorAll('.proc-pool-rote').forEach(cb => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = cb.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      if (entry.source === 'project') {
        await saveEntryReview(entry, { rote: cb.checked });
        renderProcessingMode(container);
        return;
      }
      const sub = submissions.find(s => s._id === entry.subId);
      if (!sub) return;
      const stReview = { ...(sub.st_review || {}), feeding_rote: cb.checked };
      await updateSubmission(entry.subId, { st_review: stReview });
      sub.st_review = stReview;
    });
  });

  // Wire Rote chip button → sync hidden checkbox + save
  container.querySelectorAll('.proc-rote-chip').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const isActive = btn.classList.toggle('is-active');
      const hiddenCb = container.querySelector(`.proc-pool-rote[data-proc-key="${key}"]`);
      if (hiddenCb) hiddenCb.checked = isActive;
      if (entry.source === 'project') {
        await saveEntryReview(entry, { rote: isActive, roll_mode: 'st_override' });
        renderProcessingMode(container);
      } else {
        const sub = submissions.find(s => s._id === entry.subId);
        if (sub) {
          const stReview = { ...(sub.st_review || {}), feeding_rote: isActive };
          await updateSubmission(entry.subId, { st_review: stReview });
          sub.st_review = stReview;
        }
        _autoSetStOverride(key, entry);
      }
    });
  });

  // Wire Again option buttons (10/9/8) — mutually exclusive radio group
  container.querySelectorAll('.proc-again-opt').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const again = btn.dataset.again;
      container.querySelectorAll(`.proc-again-opt[data-proc-key="${key}"]`).forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const na = container.querySelector(`.proc-proj-9a[data-proc-key="${key}"]`);
      const ea = container.querySelector(`.proc-proj-8a[data-proc-key="${key}"]`);
      if (na) na.checked = (again === '9');
      if (ea) ea.checked = (again === '8');
      await saveEntryReview(entry, { nine_again: again === '9', eight_again: again === '8', roll_mode: 'st_override' });
      _autoSetStOverride(key, entry);
    });
  });

  // Roll mode toggle — Player Pool / ST Override / No Roll Needed
  // Clicking also advances pool_status: no_roll → 'no_roll'; player/st_override + roll exists → 'validated'.
  container.querySelectorAll('.proc-roll-mode-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const mode  = btn.dataset.rollMode;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      container.querySelectorAll(`.proc-roll-mode-btn[data-proc-key="${key}"]`).forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      const rev       = getEntryReview(entry) || {};
      // #595: validate on whether a POOL EXISTS to roll, not whether it has already
      // been rolled. The old `!!(rev.roll)` gated on the roll RESULT, so selecting a
      // rolling mode never validated a not-yet-rolled pool (chicken-and-egg), and the
      // `!DONE_STATUSES.has(curStatus)` guard blocked switching back from 'no_roll'.
      const hasPool   = !!(rev.pool_validated || rev.pool_player || entry.poolPlayer);
      const patch     = { roll_mode: mode };
      if (mode === 'no_roll') {
        patch.pool_status = 'no_roll';
      } else if ((mode === 'player' || mode === 'st_override') && hasPool && !rev.roll) {
        // Switching to a rolling mode validates the pool (rollable), as long as it
        // has not already been rolled (`!rev.roll` preserves a real roll result).
        patch.pool_status = 'validated';
      }
      if (mode === 'st_override') {
        const builderEl = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
        if (builderEl) {
          const expr = _readBuilderExpr(builderEl);
          if (expr) patch.pool_validated = expr;
        }
      } else if (mode === 'player') {
        patch.pool_validated = '';
      }
      await saveEntryReview(entry, patch);
      renderProcessingMode(container);
    });
  });

  function _autoSetStOverride(key, entry) {
    const active = container.querySelector(`.proc-roll-mode-btn.is-active[data-proc-key="${key}"]`);
    if (active?.dataset.rollMode === 'st_override') return;
    container.querySelectorAll(`.proc-roll-mode-btn[data-proc-key="${key}"]`).forEach(b => b.classList.remove('is-active'));
    const overrideBtn = container.querySelector(`.proc-roll-mode-btn[data-proc-key="${key}"][data-roll-mode="st_override"]`);
    if (overrideBtn) overrideBtn.classList.add('is-active');
    saveEntryReview(entry, { roll_mode: 'st_override' });
  }

  // ── feature.51: Equipment modifier ticker (pool mod panel) ──
  _wireTickerHandler(container, {
    decCls: 'proc-equip-mod-dec', incCls: 'proc-equip-mod-inc',
    panelCls: 'proc-feed-mod-panel', inputCls: 'proc-equip-mod-val', dispCls: 'proc-equip-mod-disp',
    clamp: { min: -5, max: 5 },
    afterUpdate: _refreshPoolBuilder,
    saveField: 'pool_mod_equipment',
  });

  // ── feature.51: Manual vitae adjustment ticker (vitae panel) ──
  _wireTickerHandler(container, {
    decCls: 'proc-vitae-mod-dec', incCls: 'proc-vitae-mod-inc',
    panelCls: 'proc-feed-vitae-panel', inputCls: 'proc-vitae-mod-val', dispCls: 'proc-vitae-mod-disp',
    afterUpdate: _updateVitaeTotal,
    saveField: 'vitae_mod_manual',
  });

  // ── feature.59: Success modifier ticker (project right panel) ──
  _wireTickerHandler(container, {
    decCls: 'proc-succmod-dec', incCls: 'proc-succmod-inc',
    panelCls: 'proc-proj-succ-panel', inputCls: 'proc-succmod-val', dispCls: 'proc-succmod-disp',
    totalCls: 'proc-proj-succ-total-val',
    saveField: 'succ_mod_manual',
  });

  // ── feature.51: Rite cost input (vitae panel) ──
  container.querySelectorAll('.proc-rite-cost-input').forEach(inp => {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('input', e => {
      e.stopPropagation();
      _updateVitaeTotal(container, inp.dataset.procKey);
    });
    inp.addEventListener('blur', async e => {
      e.stopPropagation();
      const key  = inp.dataset.procKey;
      const val  = Math.max(0, parseInt(inp.value || '0', 10));
      inp.value  = val;
      const entry = _getQueueEntry(key);
      if (entry) await saveEntryReview(entry, { vitae_rite_cost: val });
    });
  });

  // Wire story_context input (save on blur)
  container.querySelectorAll('.proc-feedback-input').forEach(inp => {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('blur', async e => {
      const key = inp.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { story_context: inp.value.trim() });
    });
  });

  // Wire outcome textarea (save on blur)
  container.querySelectorAll('.proc-outcome-input').forEach(ta => {
    ta.addEventListener('click', e => e.stopPropagation());
    ta.addEventListener('blur', async e => {
      const key = ta.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const review = getEntryReview(entry);
      if (review?.outcome_confirmed) return;
      await saveEntryReview(entry, { outcome: ta.value.trim() || null });
    });
  });

  // Wire confirm-outcome buttons
  container.querySelectorAll('.proc-confirm-outcome-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key = btn.dataset.procKey;
      const ta = container.querySelector(`.proc-outcome-input[data-proc-key="${key}"]`);
      const text = ta ? ta.value.trim() : '';
      if (!text) return;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const review = getEntryReview(entry) || {};
      const hasPool = !!(review.pool_validated || review.pool_player || entry.poolPlayer);
      const modeAlreadySet = review.roll_mode === 'player' || review.roll_mode === 'st_override' || review.roll_mode === 'no_roll';
      const patch = { outcome: text, outcome_confirmed: true };
      if (!modeAlreadySet && hasPool && !review.roll) {
        patch.roll_mode = 'player';
        patch.pool_status = 'validated';
      }
      await saveEntryReview(entry, patch);
      renderProcessingMode(container);
    });
  });

  // Wire player_facing_note textarea (save on blur)
  container.querySelectorAll('.proc-player-note-input').forEach(ta => {
    ta.addEventListener('click', e => e.stopPropagation());
    ta.addEventListener('blur', async e => {
      const key = ta.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { player_facing_note: ta.value.trim() });
    });
  });

  // Wire add-note buttons
  container.querySelectorAll('.proc-add-note-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key = btn.dataset.procKey;
      const ta = container.querySelector(`.proc-note-textarea[data-proc-key="${key}"]`);
      const text = ta ? ta.value.trim() : '';
      if (!text) return;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const user = getUser();
      const note = {
        author_id: user?.id || '',
        author_name: user?.global_name || user?.username || 'ST',
        text,
        created_at: new Date().toISOString(),
      };
      const review = getEntryReview(entry) || {};
      const thread = [...(review.notes_thread || []), note];
      await saveEntryReview(entry, { notes_thread: thread });
      renderProcessingMode(container);
    });
  });

  // Wire delete-note buttons
  container.querySelectorAll('.proc-note-delete-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key  = btn.dataset.procKey;
      const idx  = parseInt(btn.dataset.noteIdx, 10);
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const review = getEntryReview(entry) || {};
      const thread = [...(review.notes_thread || [])];
      thread.splice(idx, 1);
      await saveEntryReview(entry, { notes_thread: thread });
      renderProcessingMode(container);
    });
  });

  // Wire snapshot sibling jump — expand target card, scroll into view, flash
  container.querySelectorAll('[data-snap-jump]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.snapJump;
      if (!key) return;
      procExpandedKeys.add(key);
      renderProcessingMode(container);
      requestAnimationFrame(() => {
        const target = container.querySelector(`.proc-action-detail[data-proc-key="${key}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('proc-card--flash');
        setTimeout(() => target.classList.remove('proc-card--flash'), 800);
      });
    });
  });

  // Wire project / merit roll buttons
  container.querySelectorAll('.proc-action-roll-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const review = getEntryReview(entry);
      const builderEl = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
      const builtExpr = builderEl ? _readBuilderExpr(builderEl) : null;
      const poolValidated = builtExpr || review?.pool_validated || '';
      if (!poolValidated) return;
      const match = poolValidated.match(/(\d+)\s*$/);
      const diceCount = match ? parseInt(match[1], 10) : 0;
      if (!diceCount) { alert('Cannot parse dice count from validated pool expression.'); return; }
      const result = rollPool(diceCount, 10, 8, 5, false);
      await saveEntryReview(entry, { roll: result });
      renderProcessingMode(container);
    });
  });

  // Wire feeding roll buttons
  // Wire spec chip buttons (proc-spec-chip = button elements, no hidden checkbox)
  container.querySelectorAll('.proc-spec-chip').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key  = btn.dataset.procKey;
      const spec = btn.dataset.spec;
      const entry = _getQueueEntry(key);
      if (!entry || !spec) return;
      const review = getEntryReview(entry) || {};
      const isNowActive = btn.classList.toggle('is-active');

      // Snapshot current builder expression so it survives future re-renders
      const builder = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
      if (builder) {
        const expr = _readBuilderExpr(builder);
        if (expr) await saveEntryReview(entry, { pool_validated: expr });
      }

      const activeFeedSpecs = [...(review.active_feed_specs || [])];
      if (isNowActive) {
        if (!activeFeedSpecs.includes(spec)) activeFeedSpecs.push(spec);
      } else {
        const i = activeFeedSpecs.indexOf(spec);
        if (i !== -1) activeFeedSpecs.splice(i, 1);
      }
      const sub = submissions.find(s => s._id === entry.subId);
      const char = sub
        ? (characters.find(c => String(c._id) === String(sub.character_id)) || charMap.get((sub.character_name || '').toLowerCase().trim()))
        : null;
      const specBonus = activeFeedSpecs.reduce((sum, sp) => sum + (char && hasAoE(char, sp) ? 2 : 1), 0);
      await saveEntryReview(entry, { active_feed_specs: activeFeedSpecs, pool_mod_spec: specBonus });
      _updatePoolTotal(container, key);
    });
  });

  container.querySelectorAll('.proc-feed-roll-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const subId = btn.dataset.subId;
      const isRote = btn.dataset.rote === 'true';
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const review = getEntryReview(entry);
      const builderEl = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
      const builtExpr = builderEl ? _readBuilderExpr(builderEl) : null;
      if (!builtExpr) return;
      const rpanel = container.querySelector(`.proc-feed-right[data-proc-key="${key}"]`);
      const _naV = rpanel?.querySelector('.proc-proj-9a')?.checked  || false;
      const _8aV = rpanel?.querySelector('.proc-proj-8a')?.checked  || false;
      const _user = getUser();
      const _stName = _user?.global_name || _user?.username || 'ST';
      await saveEntryReview(entry, { pool_validated: builtExpr, nine_again: _naV, eight_again: _8aV, pool_confirmed_by: _stName });
      let poolValidated = builtExpr;
      const match = poolValidated.match(/(\d+)\s*$/);
      let diceCount = match ? parseInt(match[1], 10) : 0;
      if (!diceCount) { alert('Cannot parse dice count from validated pool expression.'); return; }
      diceCount += (review?.pool_mod_spec || 0);
      // Read again/rote from live DOM checkboxes — auto-detected 9-again may not be saved to DB
      const rightPanel = container.querySelector(`.proc-feed-right[data-proc-key="${key}"]`);
      const nineAgainChecked  = rightPanel?.querySelector('.proc-proj-9a')?.checked  ?? (review?.nine_again  || false);
      const eightAgainChecked = rightPanel?.querySelector('.proc-proj-8a')?.checked  ?? (review?.eight_again || false);
      const again = eightAgainChecked ? 8 : nineAgainChecked ? 9 : 10;
      const sub = submissions.find(s => s._id === subId);
      // Read vitae tally data attrs from the rendered panel
      const vitaePanel = container.querySelector(`.proc-feed-vitae-panel[data-proc-key="${key}"]`);
      const vtHerd    = vitaePanel ? (parseInt(vitaePanel.dataset.herd,   10) || 0) : 0;
      const vtOof     = vitaePanel ? (parseInt(vitaePanel.dataset.oof,    10) || 0) : 0;
      const vtAmb     = vitaePanel ? (parseInt(vitaePanel.dataset.ambience, 10) || 0) : 0;
      const vtGhouls  = vitaePanel ? (parseInt(vitaePanel.dataset.ghouls, 10) || 0) : 0;
      const vtRite    = vitaePanel ? (parseInt(vitaePanel.dataset.riteCost, 10) || 0) : 0;
      const vtManual  = vitaePanel ? (parseInt(vitaePanel.dataset.manual,  10) || 0) : 0;
      const vtTotal   = vitaePanel ? (parseInt(vitaePanel.dataset.totalBonus, 10) || 0) : 0;
      const vtTerrLbl = vitaePanel ? (vitaePanel.dataset.terrLabel || '') : '';
      const vitateTally = {
        herd:               vtHerd,
        ambience:           vtAmb,
        ambience_territory: vtTerrLbl,
        oath_of_fealty:     vtOof,
        ghouls:             vtGhouls,
        rite_cost:          vtRite,
        manual:             vtManual,
        total_bonus:        vtTotal,
      };

      showRollModal(
        { size: diceCount, expression: `Feeding: ${poolValidated}`, existingRoll: sub?.feeding_roll,
          again, rote: isRote },
        async result => {
          // STM-8 (issue #415): snapshot the active mod state alongside
          // the feeding roll so the historical record survives mod revocation.
          const c = _charForSub(sub);
          const feedingRoll = { ...result, pool_snapshot: buildPoolSnapshot(c, diceCount) };
          await updateSubmission(subId, { feeding_roll: feedingRoll, feeding_vitae_tally: vitateTally });
          if (sub) { sub.feeding_roll = feedingRoll; sub.feeding_vitae_tally = vitateTally; }
          const cur = getEntryReview(entry)?.pool_status || 'pending';
          if (cur === 'pending' || cur === 'confirmed') {
            await saveEntryReview(entry, { pool_status: 'rolled' });
          }
          renderProcessingMode(container);
        }
      );
    });
  });

  // Wire feeding roll clear button
  container.querySelectorAll('.proc-feed-clear-roll-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const subId   = btn.dataset.subId;
      const procKey = btn.dataset.procKey;
      const entry   = _getQueueEntry(procKey);
      const sub     = submissions.find(s => s._id === subId);
      await updateSubmission(subId, { feeding_roll: null, feeding_vitae_tally: null });
      if (sub) { sub.feeding_roll = null; sub.feeding_vitae_tally = null; }
      if (entry) await saveEntryReview(entry, { pool_status: 'confirmed' });
      renderProcessingMode(container);
    });
  });

  // Wire Mandragora Garden ack button
  container.querySelectorAll('.proc-mg-ack-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const procKey = btn.dataset.procKey;
      const entry   = _getQueueEntry(procKey);
      if (!entry) return;
      const sub = submissions.find(s => s._id === entry.subId);
      if (!sub) return;
      const n = entry.actionIdx;

      await saveEntryReview(entry, { pool_status: 'skipped' });
      await updateSubmission(entry.subId, { [`responses.sorcery_${n}_mg_acked`]: 'yes' });
      if (!sub.responses) sub.responses = {};
      sub.responses[`sorcery_${n}_mg_acked`] = 'yes';

      renderProcessingMode(container);
    });
  });

  // Wire project 9-Again sidebar toggle
  container.querySelectorAll('.proc-proj-9a').forEach(cb => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', async e => {
      e.stopPropagation();
      const key = cb.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { nine_again: cb.checked });
      // Update pool total annotation in-place
      const poolTotalEl = container.querySelector(`.proc-pool-total[data-proc-key="${key}"]`);
      if (poolTotalEl) {
        poolTotalEl.dataset.nineAgain = cb.checked ? '1' : '0';
        _updatePoolTotal(container, key);
      }
      renderProcessingMode(container);
    });
  });

  // Wire project 8-Again sidebar toggle
  container.querySelectorAll('.proc-proj-8a').forEach(cb => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', async e => {
      e.stopPropagation();
      const key = cb.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { eight_again: cb.checked });
      renderProcessingMode(container);
    });
  });

  // Wire project roll button (sidebar roll card)
  container.querySelectorAll('.proc-proj-roll-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const review = getEntryReview(entry);
      const builderEl = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
      const builtExpr = builderEl ? _readBuilderExpr(builderEl) : null;
      if (!builtExpr) return;
      const rpanel = container.querySelector(`.proc-feed-right[data-proc-key="${key}"]`);
      const _roteV = rpanel?.querySelector('.proc-pool-rote')?.checked  || false;
      const _naV   = rpanel?.querySelector('.proc-proj-9a')?.checked    || false;
      const _8aV   = rpanel?.querySelector('.proc-proj-8a')?.checked    || false;
      const _user = getUser();
      const _stName = _user?.global_name || _user?.username || 'ST';
      await saveEntryReview(entry, { pool_validated: builtExpr, nine_again: _naV, rote: _roteV, eight_again: _8aV, pool_confirmed_by: _stName });
      let poolValidated = builtExpr;
      const match = poolValidated.match(/(\d+)\s*$/);
      let diceCount = match ? parseInt(match[1], 10) : 0;
      if (!diceCount) { alert('Cannot parse dice count from validated pool expression.'); return; }
      const _specSub = submissions.find(s => s._id === entry.subId);
      const _specChar = _charForSub(_specSub);
      diceCount += (review?.active_feed_specs || []).reduce((sum, sp) => sum + (_specChar && hasAoE(_specChar, sp) ? 2 : 1), 0);
      // Read toggle states from sidebar
      const rightPanel = container.querySelector(`.proc-feed-right[data-proc-key="${key}"]`);
      const roteChecked      = rightPanel?.querySelector('.proc-pool-rote')?.checked  || false;
      const nineAgainChecked = rightPanel?.querySelector('.proc-proj-9a')?.checked    || false;
      const eightAgainChecked = rightPanel?.querySelector('.proc-proj-8a')?.checked   || false;
      const again = eightAgainChecked ? 8 : nineAgainChecked ? 9 : 10;
      showRollModal({
        size: diceCount, expression: poolValidated,
        existingRoll: review?.roll || null,
        again, initialRote: roteChecked,
      }, async result => {
        // Save both roll result AND pool object so the player story tab
        // can display both the expression and the outcome.
        // STM-8 (issue #415): pool_snapshot at resolution captures the
        // active mod state so the historical record survives revocation.
        const sub = submissions.find(s => s._id === entry.subId);
        const c = _charForSub(sub);
        await saveEntryReview(entry, {
          roll: result,
          pool: { expression: poolValidated, total: diceCount },
          pool_snapshot: buildPoolSnapshot(c, diceCount),
        });
        const _revAfter = getEntryReview(entry);
        const _curStat  = _revAfter?.pool_status || 'pending';
        if (_curStat === 'pending' || _curStat === 'confirmed') {
          const _curMode  = _revAfter?.roll_mode;
          const _newStat  = (_curMode === 'player' || _curMode === 'st_override') ? 'validated' : 'rolled';
          await saveEntryReview(entry, { pool_status: _newStat });
        }
        renderProcessingMode(container);
      });
    });
  });

  // Wire merit roll button (auto-computed pool from data-pool attribute)
  container.querySelectorAll('.proc-merit-roll-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const review    = getEntryReview(entry);
      const diceCount = parseInt(btn.dataset.pool, 10) || 0;
      if (!diceCount) return;
      const meritExpr = `(${entry.meritDots || '?'} \u00d7 2) + 2`;
      showRollModal({
        size: diceCount, expression: meritExpr,
        existingRoll: review?.roll || null,
        again: 10, initialRote: false,
      }, async result => {
        // STM-8 (issue #415): snapshot the mod state alongside the merit
        // resolution. Pool composition for merit rolls = (dots \u00d7 2) + 2
        // which doesn't read from attribute/skill values, so most mods
        // won't contribute \u2014 but capturing the overlay state still
        // preserves the audit record.
        const sub = submissions.find(s => s._id === entry.subId);
        const c = _charForSub(sub);
        await saveEntryReview(entry, {
          roll: result,
          pool: { expression: meritExpr, total: diceCount },
          pool_snapshot: buildPoolSnapshot(c, diceCount),
        });
        const _revAfterM = getEntryReview(entry);
        const _curStatM  = _revAfterM?.pool_status || 'pending';
        if (_curStatM === 'pending' || _curStatM === 'confirmed') {
          const _curModeM = _revAfterM?.roll_mode;
          const _newStatM = (_curModeM === 'player' || _curModeM === 'st_override') ? 'validated' : 'rolled';
          await saveEntryReview(entry, { pool_status: _newStatM });
        }
        renderProcessingMode(container);
      });
    });
  });

  // ── Investigation: Target Secrecy dropdown ──
  container.querySelectorAll('.proc-inv-secrecy-sel').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const entry = _getQueueEntry(sel.dataset.procKey);
      if (!entry) return;
      await saveEntryReview(entry, { inv_secrecy: sel.value || null });
      renderProcessingMode(container);
    });
  });

  // ── Investigation: Has Lead toggle buttons ──
  container.querySelectorAll('.proc-inv-lead-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const entry = _getQueueEntry(btn.dataset.procKey);
      if (!entry) return;
      const val = btn.dataset.lead === 'true';
      const rev = getEntryReview(entry) || {};
      // clicking the active button toggles it off (back to unset)
      const next = rev.inv_has_lead === val ? null : val;
      await saveEntryReview(entry, { inv_has_lead: next });
      renderProcessingMode(container);
    });
  });


  // Wire all character typeahead widgets (connected chars, targets, sorcery targets)
  // data-ta-save: field name to persist; data-ta-single: limits to one chip at a time
  container.querySelectorAll('.proc-conn-typeahead').forEach(wrap => {
    const key       = wrap.dataset.procKey;
    const saveField = wrap.dataset.taSave || 'connected_chars';
    const isSingle  = wrap.dataset.taSingle === '1';
    const entry     = _getQueueEntry(key);
    const selfKey   = (entry?.charName || '').toLowerCase();
    const allChars  = characters
      .filter(c => !c.retired)
      .map(c => ({ key: sortName(c), label: c.moniker || c.name || c.character_name || '?' }))
      .filter(c => c.key !== selfKey)
      .sort((a, b) => a.key.localeCompare(b.key));
    const input    = wrap.querySelector('.proc-conn-input');
    const dropdown = wrap.querySelector('.proc-conn-dropdown');
    const chipsEl  = wrap.querySelector('.proc-conn-chips');

    function getSelectedKeys() {
      return new Set([...chipsEl.querySelectorAll('.proc-conn-chip')].map(c => c.dataset.charName));
    }

    function showDropdown(query) {
      const selected = getSelectedKeys();
      const q = query.trim().toLowerCase();
      const matches = allChars.filter(c =>
        !selected.has(c.key) && (!q || c.label.toLowerCase().includes(q))
      );
      if (!matches.length) { dropdown.style.display = 'none'; return; }
      dropdown.innerHTML = '';
      for (const { key: cKey, label } of matches.slice(0, 10)) {
        const item = document.createElement('div');
        item.className = 'proc-conn-dd-item';
        item.dataset.charName = cKey;
        item.textContent = label;
        dropdown.appendChild(item);
      }
      dropdown.style.display = '';
    }

    function addChip(charKey, label) {
      if (isSingle) chipsEl.innerHTML = '';
      const chip = document.createElement('span');
      chip.className = 'proc-conn-chip';
      chip.dataset.charName = charKey;
      chip.appendChild(document.createTextNode(label));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'proc-conn-chip-x';
      btn.title = 'Remove';
      btn.textContent = '×';
      chip.appendChild(btn);
      chipsEl.appendChild(chip);
    }

    async function saveTypeahead() {
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const chips = [...chipsEl.querySelectorAll('.proc-conn-chip')].map(c => c.dataset.charName);
      let payload;
      if (saveField === 'sorc_targets') {
        payload = { sorc_targets: chips.join(', ') || null };
      } else if (isSingle) {
        payload = { [saveField]: chips[0] || null };
      } else {
        payload = { [saveField]: chips };
      }
      await saveEntryReview(entry, payload);
      // #608: Opposing Char change — recompute the resistance pool label from the
      // current trait selection against the new opposing character, then re-render
      // so the resistance-trait builder reflects the new character's stats.
      if (saveField === 'contested_char') {
        const r = getEntryReview(entry) || {};
        const oppChar = characters.find(c => sortName(c) === (chips[0] || '')) || null;
        await saveEntryReview(entry, { contested_pool_label: _computeContestedPoolLabel(r.contested_resist_traits || [], !!r.contested_resist_bp, oppChar) });
        renderProcessingMode(container);
      }
      // Investigate/attack target: re-render snapshot panel so target intel is visible immediately
      if (saveField === 'investigate_target_char' || saveField === 'attack_target_char') {
        const card   = container.querySelector(`.proc-action-detail[data-proc-key="${key}"]`);
        const snapEl = card?.querySelector('.proc-snapshot-panel');
        if (snapEl) {
          const tmp = document.createElement('div');
          tmp.innerHTML = _renderSnapshotPanel(entry);
          snapEl.replaceWith(tmp.firstElementChild);
        }
      }
      // Attack target side-effect: reset merit and repopulate merit dropdown
      if (saveField === 'attack_target_char') {
        await saveEntryReview(entry, { attack_target_merit: '' });
        const meritSel = container.querySelector(`.proc-attack-merit-sel[data-proc-key="${key}"]`);
        if (meritSel) {
          const targetChar = characters.find(c => sortName(c) === (chips[0] || '')) || null;
          meritSel.innerHTML = '<option value="">— Select merit —</option>';
          if (targetChar) {
            const merits = [...(targetChar.merits || [])].sort((a, b) => (a.name||'').localeCompare(b.name||''));
            for (const m of merits) {
              const mName   = m.name || '';
              const mRating = (m.rating || m.dots || 0) + (m.bonus || 0);
              const mQual   = m.qualifier ? ` (${m.qualifier})` : '';
              const opt     = document.createElement('option');
              opt.value       = mName;
              opt.textContent = `${mName}${mQual} ●${mRating}`;
              meritSel.appendChild(opt);
            }
          }
        }
      }
    }

    input.addEventListener('focus', () => showDropdown(input.value));
    input.addEventListener('input', () => showDropdown(input.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { dropdown.style.display = 'none'; input.value = ''; }
    });
    input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 150));

    wrap.addEventListener('click', async e => {
      const ddItem = e.target.closest('.proc-conn-dd-item');
      if (ddItem) {
        const charKey = ddItem.dataset.charName;
        const charObj = allChars.find(c => c.key === charKey);
        if (charObj && (isSingle || !getSelectedKeys().has(charKey))) {
          addChip(charKey, charObj.label);
          input.value = '';
          dropdown.style.display = 'none';
          await saveTypeahead();
        }
        return;
      }
      const chipX = e.target.closest('.proc-conn-chip-x');
      if (chipX) {
        chipX.closest('.proc-conn-chip')?.remove();
        await saveTypeahead();
      }
    });
  });

  container.querySelectorAll('.proc-attack-merit-sel').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = sel.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { attack_target_merit: sel.value });
    });
  });

  // Wire protected merit dropdown — saves which merit a hide/protect action covers
  container.querySelectorAll('.proc-prot-merit-sel').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = sel.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const [name, qual] = sel.value.split('|');
      await saveEntryReview(entry, { protected_merit_name: name || '', protected_merit_qualifier: qual || '' });
    });
  });

  // Wire merit link dropdown — saves which specific merit the action is linked to
  container.querySelectorAll('.proc-merit-link-sel').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = sel.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { linked_merit_qualifier: sel.value });
    });
  });

  // Wire contacts target text input
  container.querySelectorAll('.proc-contacts-target-input').forEach(inp => {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('blur', async e => {
      e.stopPropagation();
      const key   = inp.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { contacts_target: inp.value.trim() || null });
    });
  });

  // Wire contacts info type selector
  container.querySelectorAll('.proc-contacts-info-type-sel').forEach(sel => {
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = sel.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { contacts_info_type: sel.value || null });
    });
  });

  // Wire contacts subject text input
  container.querySelectorAll('.proc-contacts-subject-input').forEach(inp => {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('blur', async e => {
      e.stopPropagation();
      const key   = inp.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { contacts_subject: inp.value.trim() || null });
    });
  });

  // Wire patrol/scout detail level selector
  container.querySelectorAll('.proc-patrol-detail-sel').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = sel.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { patrol_detail_level: sel.value || null });
    });
  });

  // Wire patrol/scout observed textarea
  container.querySelectorAll('.proc-patrol-observed-ta').forEach(ta => {
    ta.addEventListener('click', e => e.stopPropagation());
    ta.addEventListener('blur', async e => {
      e.stopPropagation();
      const key   = ta.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { patrol_observed: ta.value.trim() || null });
    });
  });

  // Wire block confirm button
  container.querySelectorAll('.proc-block-confirm-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { pool_status: 'no_roll' });
      renderProcessingMode(container);
    });
  });

  // Wire support target selector
  container.querySelectorAll('.proc-support-target-sel').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = sel.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { support_target_key: sel.value || null });
    });
  });

  // Wire rumour detail level selector
  container.querySelectorAll('.proc-rumour-detail-sel').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = sel.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { rumour_detail_level: sel.value || null });
    });
  });

  // Wire rumour content textarea
  container.querySelectorAll('.proc-rumour-content-ta').forEach(ta => {
    ta.addEventListener('click', e => e.stopPropagation());
    ta.addEventListener('blur', async e => {
      e.stopPropagation();
      const key   = ta.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { rumour_content: ta.value.trim() || null });
    });
  });



  // Wire rite selector (sorcery) — save rite_override and re-render
  container.querySelectorAll('.proc-rite-select').forEach(sel => {
    sel.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = sel.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { rite_override: sel.value || null });
      renderProcessingMode(container);
    });
  });

  // Wire custom rite level input — save rite_custom_level on change and re-render
  container.querySelectorAll('.proc-rite-custom-level-input').forEach(inp => {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('mousedown', e => e.stopPropagation());
    inp.addEventListener('change', async e => {
      e.stopPropagation();
      const key   = inp.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const val = parseInt(inp.value, 10);
      if (val >= 1 && val <= 5) {
        await saveEntryReview(entry, { rite_custom_level: val });
        renderProcessingMode(container);
      }
    });
  });

  // Wire ritual result note (sorcery) — save on blur
  container.querySelectorAll('.proc-ritual-note-input').forEach(ta => {
    ta.addEventListener('blur', async e => {
      e.stopPropagation();
      const key   = ta.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { ritual_result_note: ta.value.trim() });
    });
  });

  // Wire ritual roll buttons (sorcery entries — single roll with DT bonus + MG)
  container.querySelectorAll('.proc-ritual-roll-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;

      const sub = submissions.find(s => s._id === entry.subId);
      if (!sub) return;

      const rev      = (sub.sorcery_review || {})[entry.actionIdx] || {};
      const riteName = rev.rite_override || entry.riteName || '';
      let ritInfo    = riteName ? _getRiteInfo(riteName) : null;
      if (!ritInfo) {
        const _isCustom = riteName === '__custom__'
          || (riteName && !(_getRulesDB() || []).some(r => r.category === 'rite' && r.name === riteName));
        if (_isCustom) {
          const _trad     = entry.tradition || rev.sorc_tradition || '';
          const _tradPool = TRADITION_POOL[_trad] || null;
          const _level    = parseInt(rev.rite_custom_level || '0', 10);
          if (!_tradPool) { alert('Select a tradition before rolling a custom rite.'); return; }
          if (!_level)    { alert('Set a rite level before rolling a custom rite.'); return; }
          ritInfo = { attr: _tradPool.attr, skill: _tradPool.skill, disc: _tradPool.disc,
                      target: _level, poolExpr: [_tradPool.attr, _tradPool.skill, _tradPool.disc].filter(Boolean).join(' + ') };
        } else {
          alert(`Rite "${riteName}" not found in the rules database.`); return;
        }
      }

      // Resolve character
      const charIdStr   = sub.character_id ? String(sub.character_id) : null;
      const charNameKey = (sub.character_name || '').toLowerCase().trim();
      const char        = (charIdStr && characters.find(c => String(c._id) === charIdStr))
                        || charMap.get(charNameKey) || null;

      // Pool = tradition stats + 3 (DT) + Mandragora (flat +3, Cruac users
      // with the merit, always-on; not gated by per-rite parked toggle)
      const base         = _computeRitePool(char, ritInfo.attr, ritInfo.skill, ritInfo.disc);
      const isCruac      = entry.tradition === 'Cruac';
      const _mgMerit6    = isCruac ? (char?.merits || []).find(m => m.name === 'Mandragora Garden') : null;
      const mgDots       = _mgMerit6 ? ((_mgMerit6.rating || _mgMerit6.dots || 0) + (_mgMerit6.bonus || 0)) : 0;
      const eqMod        = rev.pool_mod_equipment || 0;
      const total        = base + 3 + mgDots + eqMod;
      if (!total) { alert('Cannot compute pool — character stats unavailable.'); return; }

      const _rdEntry = ritInfo.disc ? _charDiscsArray(char).find(d => d.name === ritInfo.disc) : null;
      const parts = char
        ? [
            `${ritInfo.attr} ${getAttrVal(char, ritInfo.attr) || 0}`,
            `${ritInfo.skill} ${skTotal(char, ritInfo.skill) || 0}`,
            ritInfo.disc ? `${ritInfo.disc} ${_rdEntry?.dots || 0}` : null,
            '+3 (downtime)',
            mgDots ? `+${mgDots} (Mandragora)` : null,
            eqMod  ? `${eqMod > 0 ? '+' : ''}${eqMod} (equip)` : null,
          ].filter(Boolean)
        : [ritInfo.poolExpr, '+3 (downtime)'];
      const poolExpr = parts.join(' + ') + ` = ${total}`;

      showRollModal(
        { size: total, expression: `${riteName}: ${poolExpr}`, existingRoll: rev.ritual_roll || null },
        async result => {
          const hit    = result.successes >= ritInfo.target;
          const status = hit ? 'resolved' : 'no_effect';
          const sorcReview = { ...(sub.sorcery_review || {}) };
          sorcReview[entry.actionIdx] = {
            ...(sorcReview[entry.actionIdx] || {}),
            ritual_roll:   result,
            ritual_target: ritInfo.target,
            pool_status:   status,
          };
          await updateSubmission(entry.subId, { sorcery_review: sorcReview });
          sub.sorcery_review = sorcReview;
          renderProcessingMode(container);
        }
      );
    });
  });

  // Wire XP review character block toggles (Step 10)
  container.querySelectorAll('[data-xp-review-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.xpReviewId;
      if (xpReviewExpanded.has(id)) xpReviewExpanded.delete(id);
      else xpReviewExpanded.add(id);
      renderProcessingMode(container);
    });
  });

  // Wire XP approve / flag buttons (Step 10)
  container.querySelectorAll('.proc-xp-approve-btn, .proc-xp-flag-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const subId  = btn.dataset.subId;
      const idx    = parseInt(btn.dataset.rowIdx, 10);
      const status = btn.dataset.status;
      const sub    = submissions.find(s => s._id === subId);
      if (!sub) return;
      // Toggle off if already active
      const current = sub.st_review?.xp_approvals?.[idx]?.status;
      const newStatus = current === status ? '' : status;
      if (!sub.st_review) sub.st_review = {};
      if (!sub.st_review.xp_approvals) sub.st_review.xp_approvals = {};
      if (!sub.st_review.xp_approvals[idx]) sub.st_review.xp_approvals[idx] = {};
      sub.st_review.xp_approvals[idx].status = newStatus;
      await updateSubmission(subId, { [`st_review.xp_approvals.${idx}.status`]: newStatus });
      renderProcessingMode(container);
    });
  });

  // Wire XP flag note input — save on blur (Step 10)
  container.querySelectorAll('.proc-xp-note-input').forEach(inp => {
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('blur', async () => {
      const subId = inp.dataset.subId;
      const idx   = parseInt(inp.dataset.rowIdx, 10);
      const sub   = submissions.find(s => s._id === subId);
      if (!sub) return;
      if (!sub.st_review) sub.st_review = {};
      if (!sub.st_review.xp_approvals) sub.st_review.xp_approvals = {};
      if (!sub.st_review.xp_approvals[idx]) sub.st_review.xp_approvals[idx] = {};
      sub.st_review.xp_approvals[idx].note = inp.value;
      await updateSubmission(subId, { [`st_review.xp_approvals.${idx}.note`]: inp.value });
    });
  });


  // Wire second-opinion flag toggle
  container.querySelectorAll('.proc-second-opinion-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const review = getEntryReview(entry);
      await saveEntryReview(entry, { second_opinion: !review?.second_opinion });
      renderProcessingMode(container);
    });
  });

  // Wire compact merit outcome toggle
  container.querySelectorAll('.proc-merit-outcome-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { merit_outcome: btn.dataset.outcome, pool_status: 'resolved' });
      renderProcessingMode(container);
    });
  });

  // ── Outcome summary input (compact merit panel) ──
  container.querySelectorAll('.proc-outcome-summary-input').forEach(inp => {
    inp.addEventListener('blur', async () => {
      const key   = inp.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { outcome_summary: inp.value.trim() });
    });
  });

  // ── Travel discretion buttons ──
  container.querySelectorAll('.proc-travel-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      await saveEntryReview(entry, { pool_status: btn.dataset.discretion });
      renderProcessingMode(container);
    });
  });

  // ── Contested toggle ──
  container.querySelectorAll('.proc-contested-toggle').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const rev   = getEntryReview(entry) || {};
      if (rev.contested) {
        await saveEntryReview(entry, { contested: false, contested_char: '', contested_pool_label: '', contested_roll: null, contested_resist_traits: [], contested_resist_bp: false });
      } else {
        await saveEntryReview(entry, { contested: true });
      }
      renderProcessingMode(container);
    });
  });

  // ── Contested resistance-trait + Blood Potency toggles (#608) ──
  // (The Opposing Char picker is now the shared character typeahead, saveField
  // 'contested_char' — wired below in the typeahead handler.)
  container.querySelectorAll('.proc-contested-trait, .proc-contested-bp').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const rev   = getEntryReview(entry) || {};
      let traits  = [...(rev.contested_resist_traits || [])];
      let useBp   = !!rev.contested_resist_bp;
      if (btn.classList.contains('proc-contested-bp')) {
        useBp = !useBp;
      } else {
        const t = btn.dataset.trait;
        traits = traits.includes(t) ? traits.filter(x => x !== t) : [...traits, t];
      }
      const oppChar = characters.find(c => sortName(c) === (rev.contested_char || '')) || null;
      const label   = _computeContestedPoolLabel(traits, useBp, oppChar);
      await saveEntryReview(entry, { contested_resist_traits: traits, contested_resist_bp: useBp, contested_pool_label: label });
      renderProcessingMode(container);
    });
  });

  // ── Roll defence button ──
  container.querySelectorAll('.proc-contested-roll-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const rev   = getEntryReview(entry) || {};
      const poolLabel = rev.contested_pool_label || '';
      const match = poolLabel.match(/=\s*(\d+)\s*$/);
      if (!match) return;
      const poolTotal = parseInt(match[1], 10);
      if (!poolTotal || poolTotal < 1) return;
      const result = await rollPool(poolTotal, false, false, false);
      await saveEntryReview(entry, { contested_roll: result });
      renderProcessingMode(container);
    });
  });

  // ── Duplicate action (any type) ──
  container.querySelectorAll('.proc-duplicate-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      const rev       = getEntryReview(entry) || {};
      const tradition = rev.sorc_tradition || entry.tradition || '';
      const riteName  = rev.sorc_rite_name || rev.rite_override || entry.riteName || '';
      const notes     = rev.sorc_notes || entry.projDescription || entry.description || '';
      const label     = (entry.actionType === 'sorcery' && riteName) ? riteName : entry.label;
      // Player sorcery entries have actionType='resolve_first'; ST actions must use 'sorcery'
      // so ST_ACTION_PHASE_MAP maps it correctly to phase 0 (resolve_first).
      const stActionType = (entry.source === 'sorcery') ? 'sorcery' : entry.actionType;
      await addStAction(entry.subId, {
        action_type: stActionType,
        label,
        description: notes,
        pool_player: entry.poolPlayer || '',
        tradition,
        rite_name:   riteName,
      });
      const sub    = submissions.find(s => s._id === entry.subId);
      const newIdx = (sub?.st_actions || []).length - 1;
      if (newIdx >= 0) procExpandedKeys.add(`${entry.subId}:st:${newIdx}`);
      renderProcessingMode(container);
    });
  });

  // ── Delete action ──
  container.querySelectorAll('.proc-delete-row-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const key   = btn.dataset.procKey;
      const entry = _getQueueEntry(key);
      if (!entry) return;
      if (entry.source === 'st_created') {
        await deleteStAction(entry.subId, entry.actionIdx);
      } else {
        // Extract the key-part after subId: (e.g. 'proj:0', 'feeding', 'sorcery:1')
        const keyPart = key.slice(entry.subId.length + 1);
        await deletePlayerAction(entry.subId, keyPart);
      }
      renderProcessingMode(container);
    });
  });

  // Wire Delete ST action buttons (expanded panel delete, kept for backwards compat)
  container.querySelectorAll('.proc-delete-st-action').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const subId = btn.dataset.subId;
      const actionIdx = parseInt(btn.dataset.actionIdx, 10);
      await deleteStAction(subId, actionIdx);
      renderProcessingMode(container);
    });
  });

  // ── Toggle deleted actions panel ──
  container.querySelector('[data-deleted-toggle]')?.addEventListener('click', () => {
    procDeletedOpen = !procDeletedOpen;
    renderProcessingMode(container);
  });

  // ── Restore deleted action ──
  container.querySelectorAll('.proc-restore-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const subId   = btn.dataset.subId;
      const keyPart = btn.dataset.keyPart;
      const source  = btn.dataset.source;
      if (source === 'st') {
        const idx = parseInt(keyPart.slice(3), 10);
        await restoreStAction(subId, idx);
      } else {
        await restorePlayerAction(subId, keyPart);
      }
      renderProcessingMode(container);
    });
  });

  // ── Add ST Action form ──
  container.querySelector('[data-toggle-add-st-form]')?.addEventListener('click', () => {
    const form = container.querySelector('#proc-add-st-form');
    if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });

  const stTypeEl = container.querySelector('#proc-add-st-type');
  const stSorcEl = container.querySelector('#proc-add-st-sorcery');
  const stGenEl  = container.querySelector('#proc-add-st-general');
  function _updateStActionFields() {
    if (!stTypeEl || !stSorcEl || !stGenEl) return;
    const isSorc = stTypeEl.value === 'sorcery';
    stSorcEl.style.display = isSorc ? '' : 'none';
    stGenEl.style.display  = isSorc ? 'none' : '';
  }
  stTypeEl?.addEventListener('change', _updateStActionFields);
  _updateStActionFields();

  container.querySelector('#proc-add-st-submit')?.addEventListener('click', async () => {
    const subId    = container.querySelector('#proc-add-st-char')?.value;
    const type     = container.querySelector('#proc-add-st-type')?.value;
    const isSorc   = type === 'sorcery';
    const tradition = isSorc ? (container.querySelector('#proc-add-st-tradition')?.value || '') : '';
    const riteName  = isSorc ? (container.querySelector('#proc-add-st-rite')?.value || '') : '';
    const label     = isSorc
      ? (riteName || tradition || 'Sorcery')
      : (container.querySelector('#proc-add-st-label')?.value?.trim() || type);
    const desc = container.querySelector('#proc-add-st-desc')?.value?.trim() || '';

    if (!subId) { alert('Select a character first.'); return; }
    await addStAction(subId, { action_type: type, label, description: desc, tradition, rite_name: riteName });
    const sub    = submissions.find(s => s._id === subId);
    const newIdx = (sub?.st_actions || []).length - 1;
    if (newIdx >= 0) procExpandedKeys.add(`${subId}:st:${newIdx}`);
    renderProcessingMode(container);
  });

  // Async: fill parked-rite prior-outcome placeholders (Mandragora Garden, feat #741)
  _mgPriorSubCache.clear();
  _hydrateMgPriorOutcomes(); // intentionally not awaited

}

function _renderAddStActionForm(subs) {
  const activeSubs = subs.filter(s => s.status !== 'draft' || s.character_name);
  let h = '<div class="proc-phase-section proc-add-st-section">';
  h += '<div class="proc-phase-header" data-toggle-add-st-form>';
  h += '<span class="proc-phase-label">+ Add ST Action</span>';
  h += '</div>';
  h += '<div class="proc-add-st-form" id="proc-add-st-form" style="display:none;">';
  h += '<div class="proc-add-st-row">';
  // Character selector
  h += '<select class="qf-select proc-add-st-char" id="proc-add-st-char">';
  h += '<option value="">— Character —</option>';
  for (const s of activeSubs) {
    h += `<option value="${esc(s._id)}">${esc(s.character_name || s._id)}</option>`;
  }
  h += '</select>';
  // Action type selector
  h += '<select class="qf-select proc-add-st-type" id="proc-add-st-type">';
  for (const [val, label] of [
    ['sorcery', 'Sorcery'], ['project', 'Project'], ['attack', 'Attack'],
    ['investigate', 'Investigate'], ['patrol_scout', 'Patrol/Scout'],
    ['support', 'Support'], ['misc', 'Misc'],
  ]) {
    h += `<option value="${val}">${label}</option>`;
  }
  h += '</select>';
  h += '</div>';
  // Sorcery fields (shown when type=sorcery)
  h += '<div class="proc-add-st-sorcery" id="proc-add-st-sorcery">';
  h += '<select class="qf-select proc-add-st-tradition" id="proc-add-st-tradition">';
  h += '<option value="">— Tradition —</option>';
  h += '<option value="Cruac">Cruac</option>';
  h += '<option value="Theban">Theban Sorcery</option>';
  h += '</select>';
  const allRites = (_getRulesDB() || []).filter(r => r.category === 'rite');
  const byTrad = {};
  for (const r of allRites) { const t = r.parent || 'Unknown'; if (!byTrad[t]) byTrad[t] = []; byTrad[t].push(r); }
  h += '<select class="qf-select proc-add-st-rite" id="proc-add-st-rite">';
  h += '<option value="">— Rite —</option>';
  for (const trad of ['Cruac', 'Theban']) {
    if (!byTrad[trad]) continue;
    const grp = byTrad[trad].slice().sort((a, b) => (a.rank || 0) - (b.rank || 0) || a.name.localeCompare(b.name));
    h += `<optgroup label="${esc(trad)}">${grp.map(r => `<option value="${esc(r.name)}">${esc(r.name)} (Lvl ${r.rank || '?'})</option>`).join('')}</optgroup>`;
  }
  h += '</select>';
  h += '</div>';
  // Label field (shown for non-sorcery)
  h += '<div class="proc-add-st-general" id="proc-add-st-general" style="display:none;">';
  h += '<input type="text" class="qf-input proc-add-st-label" id="proc-add-st-label" placeholder="Action label...">';
  h += '</div>';
  // Description (always shown)
  h += '<textarea class="proc-note-textarea proc-add-st-desc" id="proc-add-st-desc" rows="2" placeholder="Description / notes (optional)..." style="margin-top:6px;"></textarea>';
  h += '<div style="margin-top:6px;">';
  h += '<button class="dt-btn" id="proc-add-st-submit">Add Action</button>';
  h += '</div>';
  h += '</div>';
  h += '</div>';
  return h;
}

/** Add an ST-created action to a submission's st_actions array. */
async function addStAction(subId, actionDef) {
  const sub = submissions.find(s => s._id === subId);
  if (!sub) return;
  const stActions = [...(sub.st_actions || [])];
  stActions.push({
    action_type: actionDef.action_type,
    label:       actionDef.label,
    description: actionDef.description || '',
    pool_player: actionDef.pool_player || '',
    tradition:   actionDef.tradition   || '',
    rite_name:   actionDef.rite_name   || '',
  });
  await updateSubmission(subId, { st_actions: stActions });
  sub.st_actions = stActions;
}

/** Soft-delete an ST-created action by marking _deleted: true (preserves for restore). */
async function deleteStAction(subId, actionIdx) {
  const sub = submissions.find(s => s._id === subId);
  if (!sub) return;
  const stActions = [...(sub.st_actions || [])];
  if (!stActions[actionIdx]) return;
  stActions[actionIdx] = { ...stActions[actionIdx], _deleted: true };
  await updateSubmission(subId, { st_actions: stActions });
  sub.st_actions = stActions;
  procExpandedKeys.delete(`${subId}:st:${actionIdx}`);
}

/** Restore a soft-deleted ST-created action. */
async function restoreStAction(subId, actionIdx) {
  const sub = submissions.find(s => s._id === subId);
  if (!sub) return;
  const stActions = [...(sub.st_actions || [])];
  if (!stActions[actionIdx]) return;
  const { _deleted, ...rest } = stActions[actionIdx];
  stActions[actionIdx] = rest;
  await updateSubmission(subId, { st_actions: stActions });
  sub.st_actions = stActions;
}

/** Restore a soft-deleted player action by removing its key-part from deleted_action_keys. */
async function restorePlayerAction(subId, keyPart) {
  const sub = submissions.find(s => s._id === subId);
  if (!sub) return;
  const deleted = (sub.st_review?.deleted_action_keys || []).filter(k => k !== keyPart);
  await updateSubmission(subId, { 'st_review.deleted_action_keys': deleted });
  if (!sub.st_review) sub.st_review = {};
  sub.st_review.deleted_action_keys = deleted;
}

/** Permanently delete a player-submitted action by recording its key-part in st_review. */
async function deletePlayerAction(subId, actionKeyPart) {
  const sub = submissions.find(s => s._id === subId);
  if (!sub) return;
  const deleted = [...(sub.st_review?.deleted_action_keys || [])];
  if (!deleted.includes(actionKeyPart)) deleted.push(actionKeyPart);
  await updateSubmission(subId, { 'st_review.deleted_action_keys': deleted });
  if (!sub.st_review) sub.st_review = {};
  sub.st_review.deleted_action_keys = deleted;
  // Remove from expanded keys too
  procExpandedKeys.delete(`${subId}:${actionKeyPart}`);
}

// ── Pool Builder helpers (feature.50) ───────────────────────────────────────

/**
 * Parse a pool_validated expression back into its components.
 * Format: "{Attr} {n} + {Skill} {n}[ + {Disc} {n}][± modifier] = {total}"
 * Returns { attr, skill, disc, modifier } or null on failure.
 */
function _parsePoolExpr(str, attrList, skillList, discNames) {
  if (!str) return null;
  const eqIdx = str.lastIndexOf('=');
  if (eqIdx === -1) return null;
  let lhs = str.slice(0, eqIdx).trim();

  // Extract negative modifier: ends with ' − N' (U+2212)
  let modifier = 0;
  const negModMatch = lhs.match(/\s+\u2212\s*(\d+)\s*$/);
  if (negModMatch) {
    modifier = -parseInt(negModMatch[1], 10);
    lhs = lhs.slice(0, negModMatch.index).trim();
  }

  // Split remaining by ' + '
  const parts = lhs.split(/\s+\+\s+/);

  // If last part is a lone number, it's a positive modifier
  if (!negModMatch && parts.length > 1) {
    const last = parts[parts.length - 1].trim();
    if (/^\d+$/.test(last)) {
      modifier = parseInt(last, 10);
      parts.pop();
    }
  }

  if (parts.length < 2) return null;

  function parsePart(p) {
    const m = p.trim().match(/^(.+?)\s+(\d+)$/);
    return m ? { name: m[1].trim(), dots: parseInt(m[2], 10) } : null;
  }

  const t0 = parsePart(parts[0]);
  const t1 = parsePart(parts[1]);
  const t2 = parts[2] ? parsePart(parts[2]) : null;
  if (!t0 || !t1) return null;

  const attr  = attrList.find(a => a.toLowerCase() === t0.name.toLowerCase()) || null;
  const skill = skillList.find(s => s.toLowerCase() === t1.name.toLowerCase()) || null;
  if (!attr || !skill) return null;

  let disc = 'none';
  if (t2 && discNames) {
    disc = discNames.find(d => d.toLowerCase() === t2.name.toLowerCase()) || 'none';
  }
  return { attr, skill, disc, modifier };
}

/**
 * Normalise char.disciplines to [{name, dots}] regardless of schema version.
 * v2 format: array; old format: { "Dominate": { dots: 3 } }.
 */
function _charDiscsArray(char) {
  if (!char) return [];
  const d = char.disciplines;
  if (!d) return [];
  if (Array.isArray(d)) return d;
  // Old object format: { "Dominate": { dots: 3 } }
  return Object.entries(d).map(([name, v]) => ({ name, dots: v?.dots || 0 }));
}

/**
 * Render spec-toggle checkboxes for a pool builder row.
 * Covers native specs on the selected skill + IS specs from all skills.
 * @param {object|null} char
 * @param {string} preSkill  — currently selected skill name
 * @param {string} procKey   — entry key for data-proc-key attributes
 * @param {string[]} activeSpecs — already-checked specs from review
 * @param {string} disabled  — ' disabled' or ''
 * @returns {string} HTML string
 */
function _buildSpecTogglesHtml(char, preSkill, procKey, activeSpecs, disabled) {
  if (!char || !preSkill) return '';
  let h = '';
  for (const sp of skSpecs(char, preSkill)) {
    const aoe = hasAoE(char, sp);
    h += `<button type="button" class="proc-spec-chip${activeSpecs.includes(sp) ? ' is-active' : ''}" data-proc-key="${esc(procKey)}" data-spec="${esc(sp)}"${disabled}>${esc(sp)} ${aoe ? '+2' : '+1'}</button>`;
  }
  for (const { spec: isSp, fromSkill } of isSpecs(char)) {
    if (fromSkill === preSkill) continue; // already present as a native spec on this skill
    const aoe = hasAoE(char, isSp);
    h += `<button type="button" class="proc-spec-chip${activeSpecs.includes(isSp) ? ' is-active' : ''}" data-proc-key="${esc(procKey)}" data-spec="${esc(isSp)}"${disabled}>${esc(isSp)} (${esc(fromSkill)}) ${aoe ? '+2' : '+1'}</button>`;
  }
  return h;
}

/** Return display label for the Again ticker (state = '10' | '9' | '8'). */
function _againerLabel(state) {
  if (state === '8') return '8-Again';
  if (state === '9') return '9-Again';
  return '10-Again';
}

/**
 * Return the unskilled penalty for a skill with 0 dots (-3 mental, -1 otherwise).
 */
function _unskilledPenalty(skillName, skillDots) {
  if (!skillName || skillDots > 0) return 0;
  return SKILLS_MENTAL.includes(skillName) ? -3 : -1;
}

/**
 * Re-sync a pool_validated expression string with current character effective stats.
 * Parses component names from the saved string, then rebuilds using getAttrVal / skTotal
 * so bonus dots are always included. Returns the refreshed string, or the original if
 * char is null or the expression cannot be parsed.
 */
function _refreshPoolExpr(str, char) {
  if (!str || !char) return str;
  const discNames = _charDiscsArray(char).filter(d => d.dots > 0).map(d => d.name);
  const parsed = _parsePoolExpr(str, ALL_ATTRS, ALL_SKILLS, discNames);
  if (!parsed?.attr || !parsed?.skill) return str;
  const attrDots  = getAttrVal(char, parsed.attr)  || 0;
  const skillDots = skTotal(char, parsed.skill)     || 0;
  const discDots  = parsed.disc && parsed.disc !== 'none'
    ? (_charDiscsArray(char).find(d => d.name === parsed.disc)?.dots || 0) : 0;
  return _buildPoolExpr(parsed.attr, attrDots, parsed.skill, skillDots, parsed.disc, discDots, parsed.modifier || 0);
}

/**
 * Build the human-readable pool expression string for pool_validated.
 */
function _buildPoolExpr(attr, attrDots, skill, skillDots, disc, discDots, modifier) {
  if (!attr || !skill) return '';
  let expr = `${attr} ${attrDots} + ${skill} ${skillDots}`;
  if (disc && disc !== 'none') expr += ` + ${disc} ${discDots}`;
  if (modifier !== 0) expr += ` ${modifier > 0 ? '+' : '\u2212'} ${Math.abs(modifier)}`;
  const total = attrDots + skillDots + (disc && disc !== 'none' ? discDots : 0) + modifier;
  expr += ` = ${total}`;
  return expr;
}

/**
 * Format a dice_string from rollPool into a human-readable list, marking exploded dice with !.
 * e.g. "[1,3,5,0>9>4,5]" → "[1, 3, 5, 10!, 9!, 4, 5]"
 */
function _formatDiceString(diceString) {
  if (!diceString) return '';
  const chains = parseDiceString(diceString);
  const parts = [];
  for (const chain of chains) {
    for (let i = 0; i < chain.length; i++) {
      const face = chain[i] === 0 ? 10 : chain[i];
      parts.push(i < chain.length - 1 ? `${face}!` : String(face));
    }
  }
  return '[' + parts.join(', ') + ']';
}

/**
 * Build the live display string for the pool total element.
 * skillName is optional; when provided and skillDots === 0, appends unskilled penalty note.
 * nineAgain is optional; when true, appends (9-Again).
 */
function _poolTotalDisplay(attr, attrDots, skill, skillDots, disc, discDots, modifier, skillName, nineAgain = false) {
  if (!attr || !skill) return '\u2014 + \u2014 \u00b10 = 0';
  let expr = `${attr} ${attrDots} + ${skill} ${skillDots}`;
  if (disc && disc !== 'none') expr += ` + ${disc} ${discDots}`;
  expr += ` ${_fmtMod(modifier)}`;
  const rawTotal = attrDots + skillDots + (disc && disc !== 'none' ? discDots : 0) + modifier;
  const penalty = _unskilledPenalty(skillName, skillDots);
  let result;
  if (!penalty) {
    result = `${expr} = ${rawTotal}`;
  } else {
    const corrected = rawTotal + penalty;
    result = `${expr} = ${corrected} (\u2212${Math.abs(penalty)} unskilled)`;
  }
  if (nineAgain) result += ' (9-Again)';
  return result;
}

/**
 * Render a territory pill row. Wires up via the existing proc-terr-pill click handler.
 * feedingSet: pass a Set of active territory IDs for feeding multi-select; null for single-select.
 */
function _renderInlineTerrPills(subId, terrContext, currentTerrId, feedingSet = null, noLabel = false) {
  const TERR_PILLS = [
    ...TERRITORY_DATA.map(t => ({ id: t.slug, label: t.shortLabel })),
    { id: 'barrens', label: 'Barrens' },
    { id: '',        label: 'N/A' },
  ];
  let h = `<span class="proc-terr-pill-row proc-terr-inline-pills" data-sub-id="${esc(subId)}" data-terr-context="${esc(terrContext)}">`;
  if (!noLabel) h += `<span class="proc-feed-lbl">Terr.</span>`;
  for (const t of TERR_PILLS) {
    const isActive = feedingSet
      ? (t.id === '' ? feedingSet.size === 0 : feedingSet.has(t.id))
      : currentTerrId === t.id;
    h += `<button class="proc-terr-pill proc-again-opt${isActive ? ' is-active' : ''}" data-sub-id="${esc(subId)}" data-terr-context="${esc(terrContext)}" data-terr-id="${esc(t.id)}">${esc(t.label)}</button>`;
  }
  h += `</span>`;
  return h;
}

/**
 * Read the current builder state from the DOM and return the pool expression string.
 * Returns null if attr or skill are not selected.
 */
function _readBuilderExpr(builder) {
  const attrSel  = builder.querySelector('.proc-pool-attr');
  const skillSel = builder.querySelector('.proc-pool-skill');
  const discSel  = builder.querySelector('.proc-pool-disc');
  const modInput = builder.querySelector('.proc-pool-mod-val');
  if (!attrSel || !skillSel) return null;
  const attr  = attrSel.value;
  const skill = skillSel.value;
  if (!attr || !skill) return null;
  const disc     = discSel ? discSel.value : 'none';
  const modifier = parseInt(modInput ? modInput.value : '0', 10);
  const attrDots  = parseInt(attrSel.selectedOptions[0]?.dataset.dots  || '0', 10);
  const skillDots = parseInt(skillSel.selectedOptions[0]?.dataset.dots || '0', 10);
  const discDots  = (discSel && disc !== 'none') ? parseInt(discSel.selectedOptions[0]?.dataset.dots || '0', 10) : 0;
  return _buildPoolExpr(attr, attrDots, skill, skillDots, disc, discDots, modifier);
}

/**
 * Recompute pool modifier total in the right panel for a feeding entry.
 */
function _updatePoolModTotal(container, key) {
  const modPanel = container.querySelector(`.proc-feed-mod-panel[data-proc-key="${key}"]`);
  if (!modPanel) return;
  const fgData = modPanel.dataset.fg;
  const fgDice = fgData !== '' ? parseInt(fgData || '0', 10) : 0;

  const unskilledRow = modPanel.querySelector('.proc-feed-unskilled-row');
  const unskilledVal = (unskilledRow && unskilledRow.style.display !== 'none')
    ? parseInt(modPanel.querySelector('.proc-mod-unskilled-val')?.textContent || '0', 10)
    : 0;

  const eqInput = modPanel.querySelector('.proc-equip-mod-val');
  const eqVal = parseInt(eqInput?.value || '0', 10);

  const total = fgDice + unskilledVal + eqVal;
  const totalEl = modPanel.querySelector('.proc-mod-total-val');
  if (totalEl) totalEl.textContent = _fmtMod(total);

  // Sync total to pool builder hidden modifier input so the pool total display updates
  const builderModInp = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"] .proc-pool-mod-val`);
  if (builderModInp) builderModInp.value = String(total);
}

/**
 * Recompute final vitae total in the vitae panel for a feeding entry.
 */
function _updateVitaeTotal(container, key) {
  const panel = container.querySelector(`.proc-feed-vitae-panel[data-proc-key="${key}"]`);
  if (!panel) return;
  const herd    = panel.dataset.herd     !== '' ? parseInt(panel.dataset.herd     || '0', 10) : 0;
  const oof     = parseInt(panel.dataset.oof      || '0', 10);
  const amb     = panel.dataset.ambience !== '' ? parseInt(panel.dataset.ambience || '0', 10) : 0;
  const ghouls  = parseInt(panel.dataset.ghouls   || '0', 10);
  const manVal  = parseInt(panel.querySelector('.proc-vitae-mod-val')?.value  || '0', 10);
  const riteVal = parseInt(panel.querySelector('.proc-rite-cost-input')?.value || '0', 10);
  const total   = Math.max(0, herd + oof + amb - ghouls + manVal - riteVal);
  const totalEl = panel.querySelector('.proc-vitae-total-val');
  if (totalEl) totalEl.textContent = String(total);
}

/**
 * Update the unskilled row in the right panel when the skill dropdown changes.
 */
function _updateUnskilledRow(container, key) {
  const builder = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
  if (!builder) return;
  const skillSel  = builder.querySelector('.proc-pool-skill');
  if (!skillSel) return;
  const skillName = skillSel.value;
  const skillDots = parseInt(skillSel.selectedOptions[0]?.dataset.dots || '0', 10);
  const penalty   = _unskilledPenalty(skillName, skillDots);

  const row = container.querySelector(`.proc-feed-unskilled-row[data-proc-key="${key}"]`);
  if (row) {
    if (penalty === 0) {
      row.style.display = 'none';
    } else {
      row.style.display = '';
      const valEl = row.querySelector('.proc-mod-unskilled-val');
      if (valEl) valEl.textContent = String(penalty);
    }
  }
}

/**
 * Update the 9-again badge and spec info labels in the feeding pool builder when skill changes.
 */
function _updateFeedBuilderMeta(container, key) {
  const metaEl = container.querySelector(`.dt-feed-builder-meta[data-proc-key="${key}"]`);
  if (!metaEl) return;
  const skillSel = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"] .proc-pool-skill`);
  if (!skillSel) return;
  const skillName = skillSel.value;
  if (!skillName) { metaEl.innerHTML = ''; return; }
  const sub = submissions.find(s => s._id === metaEl.dataset.subId);
  const char = sub ? _findCharForSub(sub) : null;
  if (!char) { metaEl.innerHTML = ''; return; }
  const nineA = skNineAgain(char, skillName);
  const specs = skSpecs(char, skillName);
  const entry = _getQueueEntry(key);
  const review = entry ? (getEntryReview(entry) || {}) : {};
  const activeSpecs = review.active_feed_specs || [];

  // For project entries: 9-again lives in the sidebar; only spec toggles in meta
  if (entry?.source === 'project') {
    // Sync auto-detected nine_again to sidebar checkbox and pool total annotation
    const sidebarNineA = container.querySelector(`.proc-proj-9a[data-proc-key="${key}"]`);
    if (sidebarNineA) sidebarNineA.checked = nineA;
    const poolTotalEl = container.querySelector(`.proc-pool-total[data-proc-key="${key}"]`);
    if (poolTotalEl) poolTotalEl.dataset.nineAgain = nineA ? '1' : '0';
    const cur8aProj = container.querySelector(`.proc-proj-8a[data-proc-key="${key}"]`)?.checked || false;
    const newStateProj = cur8aProj ? '8' : nineA ? '9' : '10';
    container.querySelectorAll(`.proc-again-opt[data-proc-key="${key}"]`).forEach(b => {
      b.classList.toggle('is-active', b.dataset.again === newStateProj);
      if (b.dataset.again === '9') b.classList.toggle('is-auto', nineA && !cur8aProj);
    });
    let h = '';
    for (const sp of specs) {
      const checked = activeSpecs.includes(sp);
      const bon = hasAoE(char, sp) ? 2 : 1;
      h += `<button type="button" class="proc-spec-chip${checked ? ' is-active' : ''}" data-proc-key="${key}" data-spec="${esc(sp)}">${esc(sp)} +${bon}</button>`;
    }
    for (const { spec: isSp, fromSkill } of isSpecs(char)) {
      if (fromSkill === skillName) continue; // already present as a native spec on this skill
      const checked = activeSpecs.includes(isSp);
      const bon = hasAoE(char, isSp) ? 2 : 1;
      h += `<button type="button" class="proc-spec-chip${checked ? ' is-active' : ''}" data-proc-key="${key}" data-spec="${esc(isSp)}">${esc(isSp)} (${esc(fromSkill)}) +${bon}</button>`;
    }
    metaEl.innerHTML = h;
    metaEl.querySelectorAll('.proc-spec-chip').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const entry2 = _getQueueEntry(btn.dataset.procKey);
        if (!entry2 || !btn.dataset.spec) return;
        const rev2 = getEntryReview(entry2) || {};
        const activeSpecs2 = [...(rev2.active_feed_specs || [])];
        const isNowActive = btn.classList.toggle('is-active');
        if (isNowActive) { if (!activeSpecs2.includes(btn.dataset.spec)) activeSpecs2.push(btn.dataset.spec); }
        else { const i = activeSpecs2.indexOf(btn.dataset.spec); if (i !== -1) activeSpecs2.splice(i, 1); }
        const specBonus2 = activeSpecs2.reduce((sum, sp) => sum + (hasAoE(char, sp) ? 2 : 1), 0);
        await saveEntryReview(entry2, { active_feed_specs: activeSpecs2, pool_mod_spec: specBonus2 });
        _updatePoolTotal(container, btn.dataset.procKey);
      });
    });
    return;
  }

  // Feeding: 9-again lives in the right panel; sync auto-detected state to sidebar checkbox.
  // Always sync when char has nine_again on this skill — character data takes priority over
  // a saved false (which may be stale from a commit before PT was entered).
  const sidebarNineAFeed = container.querySelector(`.proc-proj-9a[data-proc-key="${key}"]`);
  if (sidebarNineAFeed && (nineA || review.nine_again == null)) {
    sidebarNineAFeed.checked = nineA;
  }
  const cur8aFeed = container.querySelector(`.proc-proj-8a[data-proc-key="${key}"]`)?.checked || false;
  const newStateFeed = cur8aFeed ? '8' : (nineA && (nineA || review.nine_again == null)) ? '9' : '10';
  container.querySelectorAll(`.proc-again-opt[data-proc-key="${key}"]`).forEach(b => {
    b.classList.toggle('is-active', b.dataset.again === newStateFeed);
    if (b.dataset.again === '9') b.classList.toggle('is-auto', nineA && !cur8aFeed);
  });
  let h = '';
  for (const sp of specs) {
    const checked = activeSpecs.includes(sp);
    const bon = hasAoE(char, sp) ? 2 : 1;
    h += `<button type="button" class="proc-spec-chip${checked ? ' is-active' : ''}" data-proc-key="${key}" data-spec="${esc(sp)}">${esc(sp)} +${bon}</button>`;
  }
  for (const { spec: isSp, fromSkill } of isSpecs(char)) {
    if (fromSkill === skillName) continue; // already present as a native spec on this skill
    const checked = activeSpecs.includes(isSp);
    const bon = hasAoE(char, isSp) ? 2 : 1;
    h += `<button type="button" class="proc-spec-chip${checked ? ' is-active' : ''}" data-proc-key="${key}" data-spec="${esc(isSp)}">${esc(isSp)} (${esc(fromSkill)}) +${bon}</button>`;
  }
  metaEl.innerHTML = h;
  metaEl.querySelectorAll('.proc-spec-chip').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const entry2 = _getQueueEntry(btn.dataset.procKey);
      if (!entry2 || !btn.dataset.spec) return;
      const rev2 = getEntryReview(entry2) || {};
      const activeSpecs2 = [...(rev2.active_feed_specs || [])];
      const isNowActive = btn.classList.toggle('is-active');
      if (isNowActive) { if (!activeSpecs2.includes(btn.dataset.spec)) activeSpecs2.push(btn.dataset.spec); }
      else { const i = activeSpecs2.indexOf(btn.dataset.spec); if (i !== -1) activeSpecs2.splice(i, 1); }
      const specBonus2 = activeSpecs2.reduce((sum, sp) => sum + (hasAoE(char, sp) ? 2 : 1), 0);
      await saveEntryReview(entry2, { active_feed_specs: activeSpecs2, pool_mod_spec: specBonus2 });
      _updatePoolTotal(container, btn.dataset.procKey);
    });
  });
}

/**
 * Coordinator: recompute all pool builder displays for one entry in dependency order.
 * Sequence: unskilled row → mod panel total (syncs builder mod input) → pool total.
 * Call this instead of individual helpers when the skill, attr, or disc has changed.
 */
function _refreshPoolBuilder(container, key) {
  _updateUnskilledRow(container, key);
  _updatePoolModTotal(container, key);
  _updatePoolTotal(container, key);
}

/**
 * Recompute and update the total display for a pool builder in the container.
 */
function _updatePoolTotal(container, key) {
  const builder  = container.querySelector(`.proc-pool-builder[data-proc-key="${key}"]`);
  if (!builder) return;
  const attrSel  = builder.querySelector('.proc-pool-attr');
  const skillSel = builder.querySelector('.proc-pool-skill');
  const discSel  = builder.querySelector('.proc-pool-disc');
  const modInput = builder.querySelector('.proc-pool-mod-val');
  const totalEl  = builder.querySelector('.proc-pool-total');
  if (!attrSel || !skillSel || !totalEl) return;
  const attr     = attrSel.value;
  const skill    = skillSel.value;
  const disc     = discSel ? discSel.value : 'none';
  const modifier = parseInt(modInput ? modInput.value : '0', 10);
  const attrDots  = parseInt(attrSel.selectedOptions[0]?.dataset.dots  || '0', 10);
  const skillDots = parseInt(skillSel.selectedOptions[0]?.dataset.dots || '0', 10);
  const discDots  = (discSel && disc !== 'none') ? parseInt(discSel.selectedOptions[0]?.dataset.dots || '0', 10) : 0;
  const nineAgain = totalEl.dataset.nineAgain === '1';
  const baseDisplay = _poolTotalDisplay(attr, attrDots, skill, skillDots, disc, discDots, modifier, skill, nineAgain);
  const entry = _getQueueEntry(key);
  const review = entry ? (getEntryReview(entry) || {}) : {};
  const activeSpecs = review.active_feed_specs || [];
  const sub = entry ? submissions.find(s => s._id === entry.subId) : null;
  const char = sub
    ? (characters.find(c => String(c._id) === String(sub.character_id)) || charMap.get((sub.character_name || '').toLowerCase().trim()))
    : null;
  totalEl.textContent = _augmentPoolWithSpecs(baseDisplay, activeSpecs, char) || baseDisplay;
}

/**
 * Render the right-side sidebar for a sorcery entry.
 * Dice Pool Modifiers (DT bonus + Mandragora Garden + equipment) + Roll + Status.
 */

function _renderRightMechanics(entry, char, rev, { isSorcery = false, isAmbienceMerit = false } = {}) {
  const key        = entry.key;
  const actionType = entry.actionType;
  const isMerit    = entry.source === 'merit';
  let h = '';

  // ── Territory ──
  if (_isAmbienceAction(actionType) && !isMerit) {
    const _sub = submissions.find(s => s._id === entry.subId);
    const _ctx = String(entry.actionIdx);
    const _stOvr = _sub?.st_review?.territory_overrides?.[_ctx];
    let _tid;
    if (_stOvr) {
      _tid = _stOvr;
    } else {
      const _slot = entry.projSlot;
      const _resp = _sub?.responses || {};
      const _raw  = _resp[`project_${_slot}_ambience_target`] || _resp[`project_${_slot}_territory`] || '';
      _tid = resolveTerrId(_raw) || '';
    }
    h += `<div class="proc-feed-mod-panel">`;
    h += `<div class="proc-mod-panel-title">Territory</div>`;
    h += _renderInlineTerrPills(entry.subId, _ctx, _tid, null, true);
    h += `</div>`;
  } else if (actionType === 'investigate' && !isMerit) {
    const _sub = submissions.find(s => s._id === entry.subId);
    const _ctx = String(entry.actionIdx);
    const _tid = _sub?.st_review?.territory_overrides?.[_ctx] || '';
    h += `<div class="proc-feed-mod-panel">`;
    h += `<div class="proc-mod-panel-title">Territory</div>`;
    h += _renderInlineTerrPills(entry.subId, _ctx, _tid, null, true);
    h += `</div>`;
  } else if (!isMerit && !isSorcery && entry.source === 'project') {
    if (entry.originalActionType === 'rote') {
      const _rtSub = submissions.find(s => s._id === entry.subId);
      const _rtOvrArr = _rtSub?.st_review?.territory_overrides?.feeding_rote;
      let _rtPillSet;
      if (Array.isArray(_rtOvrArr)) {
        _rtPillSet = new Set(_rtOvrArr);
      } else {
        _rtPillSet = new Set();
        try {
          const _rtGrid = JSON.parse(_rtSub?.responses?.feeding_territories_rote || '{}');
          for (const [slug, status] of Object.entries(_rtGrid)) {
            if (!status || status === 'none' || status === 'Not feeding here') continue;
            let tid;
            if (/^[a-f0-9]{24}$/i.test(slug)) {
              const terrDoc = (cachedTerritories || []).find(t => String(t._id) === slug);
              tid = terrDoc?.slug || null;
            } else {
              tid = TERRITORY_SLUG_MAP[slug];
            }
            if (tid) _rtPillSet.add(tid);
          }
        } catch { /* ignore */ }
        if (_rtPillSet.size === 0 && entry.projTerritory) {
          const _rpt = entry.projTerritory;
          const _rptTid = /^[a-f0-9]{24}$/i.test(_rpt)
            ? ((cachedTerritories || []).find(t => String(t._id) === _rpt)?.slug || null)
            : (TERRITORY_SLUG_MAP[_rpt] ?? _rpt);
          if (_rptTid) _rtPillSet.add(_rptTid);
        }
      }
      h += `<div class="proc-feed-mod-panel">`;
      h += `<div class="proc-mod-panel-title">Territory</div>`;
      h += _renderInlineTerrPills(entry.subId, 'feeding_rote', '', _rtPillSet, true);
      h += `</div>`;
    } else {
      const _pCtx = String(entry.actionIdx);
      const _pSub = submissions.find(s => s._id === entry.subId);
      const _pTid = _pSub?.st_review?.territory_overrides?.[_pCtx] || '';
      h += `<div class="proc-feed-mod-panel">`;
      h += `<div class="proc-mod-panel-title">Territory</div>`;
      h += _renderInlineTerrPills(entry.subId, _pCtx, _pTid, null, true);
      h += `</div>`;
    }
  }

  // ── Target + Connected Characters (shared container) ──
  let targetH = '';
  let connH   = '';

  if (actionType === 'investigate') {
    // #586: ST value wins once touched (present in rev, even when cleared to
    // null); seed the player's submitted character target only when untouched.
    const _invT     = ('investigate_target_char' in rev)
      ? (rev.investigate_target_char || '')
      : (entry.targetCharKeys?.[0] || '');
    const _invChars = characters
      .filter(c => !c.retired)
      .map(c => ({ key: sortName(c), label: c.moniker || c.name }))
      .filter(({ key }) => key !== entry.charName.toLowerCase())
      .sort((a, b) => a.key.localeCompare(b.key));
    const _invSecrecy = rev.inv_secrecy || '';
    const _invHasLead = rev.inv_has_lead;
    const _invRow     = _invSecrecy ? (INVESTIGATION_MATRIX.find(r => r.type === _invSecrecy) || null) : null;
    const _innateMod  = _invRow ? _invRow.innate : 0;
    const _noLeadMod  = _invRow && _invHasLead === false ? _invRow.noLead : 0;
    const _innateStr  = _innateMod !== 0 ? (_innateMod > 0 ? `+${_innateMod}` : String(_innateMod)) : '';
    const _innateCls  = _innateMod > 0 ? ' proc-mod-pos' : _innateMod < 0 ? ' proc-mod-neg' : ' proc-mod-muted';
    const _noLeadStr  = _noLeadMod < 0 ? String(_noLeadMod) : '';
    targetH += `<div class="proc-feed-mod-panel">`;
    targetH += `<div class="proc-mod-panel-title">Target</div>`;
    targetH += _renderCharTypeahead(key, [_invT], _invChars, { label: '', saveField: 'investigate_target_char', single: true });
    targetH += `<div class="proc-mod-row">`;
    targetH += `<span class="proc-mod-label">Secrecy</span>`;
    targetH += `<select class="proc-recat-select proc-inv-secrecy-sel" data-proc-key="${esc(key)}">`;
    targetH += `<option value="">— Not set —</option>`;
    for (const r of INVESTIGATION_MATRIX) {
      targetH += `<option value="${esc(r.type)}"${r.type === _invSecrecy ? ' selected' : ''}>${esc(r.type)}</option>`;
    }
    targetH += `</select>`;
    if (_innateStr) targetH += `<span class="proc-mod-val${_innateCls}">${_innateStr}</span>`;
    targetH += `</div>`;
    targetH += `<div class="proc-mod-row">`;
    targetH += `<span class="proc-mod-label">Lead</span>`;
    targetH += `<div class="proc-inv-lead-btns">`;
    targetH += `<button class="proc-inv-lead-btn${_invHasLead === true ? ' active' : ''}" data-proc-key="${esc(key)}" data-lead="true">Lead</button>`;
    targetH += `<button class="proc-inv-lead-btn${_invHasLead === false ? ' active' : ''}" data-proc-key="${esc(key)}" data-lead="false">No Lead</button>`;
    targetH += `</div>`;
    if (_noLeadStr) targetH += `<span class="proc-mod-val proc-mod-neg">${_noLeadStr}</span>`;
    targetH += `</div>`;
    targetH += `</div>`;
  } else if (actionType === 'attack') {
    // #586: ST override wins once touched; otherwise seed the player's target.
    const _atkT     = ('attack_target_char' in rev)
      ? (rev.attack_target_char || '')
      : (entry.targetCharKeys?.[0] || '');
    const _atkChars = characters
      .filter(c => !c.retired)
      .map(c => ({ key: sortName(c), label: c.moniker || c.name }))
      .filter(({ key }) => key !== entry.charName.toLowerCase())
      .sort((a, b) => a.key.localeCompare(b.key));
    targetH += _renderCharTypeahead(key, [_atkT], _atkChars, { label: 'Target', saveField: 'attack_target_char', single: true });
  } else if (actionType === 'block') {
    // #586: block captures a player target_char in the form but previously
    // rendered no processing picker at all. Mirror attack: single character
    // target, ST override wins, otherwise seed the player's submitted target.
    const _blkT     = ('block_target_char' in rev)
      ? (rev.block_target_char || '')
      : (entry.targetCharKeys?.[0] || '');
    const _blkChars = characters
      .filter(c => !c.retired)
      .map(c => ({ key: sortName(c), label: c.moniker || c.name }))
      .filter(({ key }) => key !== entry.charName.toLowerCase())
      .sort((a, b) => a.key.localeCompare(b.key));
    targetH += _renderCharTypeahead(key, [_blkT], _blkChars, { label: 'Target', saveField: 'block_target_char', single: true });
  } else if (isSorcery) {
    const _sorcSub   = submissions.find(s => s._id === entry.subId);
    const _tRaw      = normaliseSorceryTargets(_sorcSub?.responses?.[`sorcery_${entry.actionIdx}_targets`]) || entry.targetsText || '';
    const _tVal      = rev.sorc_targets ?? _tRaw;
    const _tSelected = (_tVal || '').split(',').map(s => s.trim()).filter(Boolean);
    const _tChars    = characters
      .filter(c => !c.retired)
      .map(c => ({ key: sortName(c), label: c.moniker || c.name }))
      .filter(({ key }) => key !== entry.charName.toLowerCase())
      .sort((a, b) => a.key.localeCompare(b.key));
    targetH += _renderCharTypeahead(entry.key, _tSelected, _tChars, { label: 'Targets', saveField: 'sorc_targets' });
  }

  // #586: a non-character player target (territory / other) can't seed the
  // character picker — surface it read-only so it is not silently dropped.
  if (['investigate', 'attack', 'block'].includes(actionType)
      && entry.projTarget && !(entry.targetCharKeys && entry.targetCharKeys.length)) {
    targetH += `<div class="proc-mod-row"><span class="proc-mod-label">Submitted target</span> <span class="proc-mod-val proc-mod-muted">${esc(entry.projTarget)}</span></div>`;
  }

  if (!isAmbienceMerit && entry.source !== 'feeding') {
    // #589: seed from the player's submitted connected characters (project actions
    // set entry.connectedCharKeys) when the ST has not touched the box. Presence
    // check, NOT ||/?? — the typeahead saves []/null on clear, and an ST clear wins.
    const _connChars  = ('connected_chars' in rev) ? (rev.connected_chars || []) : (entry.connectedCharKeys || []);
    const _otherChars = characters
      .filter(c => !c.retired)
      .map(c => ({ key: sortName(c), label: c.moniker || c.name }))
      .filter(({ key }) => key !== entry.charName.toLowerCase())
      .sort((a, b) => a.key.localeCompare(b.key));
    if (_otherChars.length > 0) {
      connH += _renderCharTypeahead(entry.key, _connChars, _otherChars, { label: 'Connected Characters', saveField: 'connected_chars' });
    }
  }

  if (targetH || connH) {
    h += `<div class="proc-targeting-group">${targetH}${connH}</div>`;
  }

  return h;
}

function _renderCharTypeahead(key, selectedKeys, allChars, { label = 'Connected Characters', saveField = 'connected_chars', single = false } = {}) {
  const selectedSet = new Set(selectedKeys.filter(Boolean));
  let h = `<div class="proc-connected-section">`;
  if (label) h += `<div class="proc-detail-label">${label}</div>`;
  h += `<div class="proc-conn-typeahead" data-proc-key="${esc(key)}" data-ta-save="${esc(saveField)}"${single ? ' data-ta-single="1"' : ''}>`;
  h += `<div class="proc-conn-input-row">`;
  h += `<input type="text" class="proc-conn-input" data-proc-key="${esc(key)}" placeholder="Add character…" autocomplete="off">`;
  h += `<div class="proc-conn-dropdown" style="display:none"></div>`;
  h += `</div>`;
  h += `<div class="proc-conn-chips">`;
  for (const { key: cKey, label: cLabel } of allChars.filter(c => selectedSet.has(c.key))) {
    h += `<span class="proc-conn-chip" data-char-name="${esc(cKey)}">${esc(cLabel)}<button type="button" class="proc-conn-chip-x" title="Remove">×</button></span>`;
  }
  h += `</div></div></div>`;
  return h;
}

function _renderRollModeToggle(key, rollMode, disabled) {
  const modes = [['player', 'Player Pool'], ['st_override', 'ST Override'], ['no_roll', 'No Roll Needed']];
  const dis = disabled ? ' disabled' : '';
  let h = '<div class="proc-roll-mode-group">';
  for (const [val, label] of modes) {
    h += `<button class="proc-roll-mode-btn${rollMode === val ? ' is-active' : ''}" type="button" data-proc-key="${esc(key)}" data-roll-mode="${val}"${dis}>${label}</button>`;
  }
  h += '</div>';
  return h;
}

function _renderStatusRibbon(key, poolStatus) {
  const steps = [['pending', 'Pending'], ['confirmed', 'Confirmed'], ['rolled', 'Rolled']];
  const activeIdx = steps.findIndex(([val]) => val === poolStatus);
  let h = '<div class="proc-status-ribbon">';
  steps.forEach(([val, label], i) => {
    let cls = 'proc-ribbon-step';
    if (i < activeIdx)       cls += ' ribbon-past';
    else if (i === activeIdx) cls += ' ribbon-active ' + val;
    else                      cls += ' ribbon-future';
    h += `<span class="${cls}">${label}</span>`;
    if (i < steps.length - 1) h += '<span class="proc-ribbon-arrow">›</span>';
  });
  h += '</div>';
  return h;
}

/**
 * Render a ± ticker row (label, dec button, display span, hidden input, inc button).
 * cssPrefix: base CSS class (e.g. 'proc-equip-mod' → -dec / -disp / -val / -inc).
 * displayStr: pre-formatted display value (e.g. '+2', '±0', '-1').
 * storedVal: numeric value written to the hidden input.
 */
function _renderTickerRow(key, label, cssPrefix, displayStr, storedVal) {
  let h = `<div class="proc-mod-row proc-mod-ticker-row"><span class="proc-mod-label">${esc(label)}</span>`;
  h += `<span class="proc-mod-ticker">`;
  h += `<button class="${cssPrefix}-dec" type="button" data-proc-key="${esc(key)}">\u2212</button>`;
  h += `<span class="${cssPrefix}-disp" data-proc-key="${esc(key)}">${displayStr}</span>`;
  h += `<input type="hidden" class="${cssPrefix}-val" data-proc-key="${esc(key)}" value="${storedVal}">`;
  h += `<button class="${cssPrefix}-inc" type="button" data-proc-key="${esc(key)}">+</button>`;
  h += `</span></div>`;
  return h;
}

/**
 * Render the Dice Pool Modifiers panel inline inside a Dice Pool Builder card.
 * kind = 'feeding' | 'project' | 'sorcery'
 */
function _renderPoolModPanel(entry, char, rev, kind) {
  const key = entry.key;
  const eqMod = rev.pool_mod_equipment !== undefined ? rev.pool_mod_equipment : 0;
  const eqStr = _fmtMod(eqMod);

  if (kind === 'feeding') {
    const fg = (char?.merits || []).find(m => m.name === 'Feeding Grounds');
    const fgDice = fg ? Math.min(fg.rating || 0, 5) : null;
    const poolValidated = _refreshPoolExpr(rev.pool_validated || '', char);
    let initSkillName = '', initSkillDots = 0;
    if (poolValidated && char) {
      const charDiscs0 = _charDiscsArray(char).filter(d => d.dots > 0).map(d => d.name);
      const parsed0 = _parsePoolExpr(poolValidated, ALL_ATTRS, ALL_SKILLS, charDiscs0);
      if (parsed0?.skill) {
        initSkillName = parsed0.skill;
        initSkillDots = skTotal(char, initSkillName) || 0;
      }
    }
    const initUnskilled = _unskilledPenalty(initSkillName, initSkillDots);
    const poolModTotal = (fgDice ?? 0) + initUnskilled + eqMod;
    const poolModTotalStr = _fmtMod(poolModTotal);
    const fgDataAttr = fgDice !== null ? String(fgDice) : '';
    const fgDisplay  = fgDice !== null ? (fgDice > 0 ? `+${fgDice}` : String(fgDice)) : '\u2014';

    let h = `<div class="proc-feed-mod-panel proc-pool-mod-inline" data-proc-key="${esc(key)}" data-fg="${esc(fgDataAttr)}">`;
    h += `<div class="proc-mod-panel-title">Dice Pool Modifiers</div>`;
    h += `<div class="proc-mod-row"><span class="proc-mod-label">Feeding Grounds</span><span class="proc-mod-val${fgDice !== null && fgDice > 0 ? ' proc-mod-pos' : ''}">${fgDisplay}</span></div>`;
    const unskilledDisplay = initUnskilled !== 0 ? String(initUnskilled) : '0';
    h += `<div class="proc-feed-unskilled-row proc-mod-row" data-proc-key="${esc(key)}" style="${initUnskilled === 0 ? 'display:none' : ''}">`;
    h += `<span class="proc-mod-label">Unskilled penalty</span>`;
    h += `<span class="proc-mod-val proc-mod-neg proc-mod-unskilled-val">${unskilledDisplay}</span>`;
    h += `</div>`;
    h += _renderTickerRow(key, 'Equipment / other', 'proc-equip-mod', eqStr, eqMod);
    h += `<span class="proc-mod-total-val" data-proc-key="${esc(key)}" style="display:none">${poolModTotalStr}</span>`;
    h += `</div>`;
    return h;
  }

  if (kind === 'project') {
    const poolModTotalStr = eqStr;
    let h = `<div class="proc-feed-mod-panel proc-pool-mod-inline" data-proc-key="${esc(key)}" data-fg="">`;
    h += `<div class="proc-mod-panel-title">Dice Pool Modifiers</div>`;
    h += _renderTickerRow(key, 'Equipment / other', 'proc-equip-mod', eqStr, eqMod);
    h += `<span class="proc-mod-total-val" data-proc-key="${esc(key)}" style="display:none">${poolModTotalStr}</span>`;
    h += `</div>`;
    return h;
  }

  if (kind === 'sorcery') {
    const isCruac   = entry.tradition === 'Cruac';
    const _mgMerit  = isCruac ? (char?.merits || []).find(m => m.name === 'Mandragora Garden') : null;
    const mgDots    = _mgMerit ? ((_mgMerit.rating || _mgMerit.dots || 0) + (_mgMerit.bonus || 0)) : 0;
    const _sorcCommitted = (rev.pool_status || 'pending') === 'confirmed';
    let h = `<div class="proc-feed-mod-panel proc-pool-mod-inline${_sorcCommitted ? ' proc-pool-committed' : ''}" data-proc-key="${esc(key)}">`;
    h += `<div class="proc-mod-panel-title">Dice Pool Modifiers${_sorcCommitted ? ' <span class="proc-pool-committed-badge">[Confirmed]</span>' : ''}</div>`;
    h += `<div class="proc-mod-row"><span class="proc-mod-label">Downtime bonus</span><span class="proc-mod-static">+3</span></div>`;
    if (mgDots) {
      h += `<div class="proc-mod-row"><span class="proc-mod-label">Mandragora Garden</span><span class="proc-mod-static">+${mgDots}</span></div>`;
    }
    h += _renderTickerRow(key, 'Equipment / other', 'proc-equip-mod', eqStr, eqMod);
    h += `</div>`;
    return h;
  }

  return '';
}

/**
 * Returns true when a merit entry should render the compact panel instead of the full
 * pool-builder pipeline. Compact mode applies to auto/blocked/fixed-effect actions and
 * to contacts/retainer category entries which have no meaningful dice pool.
 */
function _isCompactMerit(entry, mode, formula) {
  if (entry.source !== 'merit') return false;
  if (mode === 'auto' || mode === 'blocked') return true;
  if (formula === 'none') return true;
  if (entry.meritCategory === 'contacts') return true;
  if (entry.meritCategory === 'retainer') return true;
  return false;
}

const MODE_LABELS = { instant: 'Instant', contested: 'Contested', auto: 'Automatic', blocked: 'Cannot' };

/**
 * Compact right-panel for binary/fixed-effect merit actions.
 * Renders: effect chip, auto successes (if auto), outcome toggle, ST notes textarea.
 * Omits: pool builder, roll card, success modifier, validation status buttons.
 */
/**
 * DTSR-5: Outcome zone for merit actions. Renders Approved / Partial / Failed
 * buttons + one-line outcome summary input. Suppressed for blocked actions.
 * Lives in the merit panel's left column so resolution sits with the action
 * details (four-zone canon: Action Definition -> Outcome).
 */
function _renderMeritOutcomeZone(entry, rev) {
  const category   = entry.meritCategory || 'misc';
  const actionType = entry.actionType    || 'misc';
  const matrixRow  = MERIT_MATRIX[category]?.[actionType] || null;
  const mode       = matrixRow?.mode || 'auto';
  if (mode === 'blocked') return '';

  const key            = entry.key;
  const outcomeSummary = rev.outcome_summary || '';

  // Outcome buttons live in the right column (_renderMeritOutcomeButtons); only the write-up stays here.
  let h = `<div class="proc-feed-mod-panel proc-merit-outcome-zone" data-proc-key="${esc(key)}">`;
  h += `<div class="proc-mod-panel-title">Outcome</div>`;
  h += `<input type="text" class="proc-outcome-summary-input" data-proc-key="${esc(key)}" value="${esc(outcomeSummary)}" placeholder="One-line outcome summary (shown to player)...">`;
  h += `</div>`;
  return h;
}

function _renderMeritOutcomeButtons(entry, rev) {
  const category   = entry.meritCategory || 'misc';
  const actionType = entry.actionType    || 'misc';
  const matrixRow  = MERIT_MATRIX[category]?.[actionType] || null;
  const mode       = matrixRow?.mode || 'auto';
  if (mode === 'blocked') return '';

  const key     = entry.key;
  const outcome = rev.merit_outcome || '';

  let h = `<div class="proc-feed-mod-panel proc-merit-outcome-btns-panel" data-proc-key="${esc(key)}">`;
  h += `<div class="proc-merit-outcome-btns">`;
  for (const [val, label] of [['approved', 'Approved'], ['partial', 'Partial'], ['failed', 'Failed']]) {
    h += `<button class="proc-merit-outcome-btn${outcome === val ? ' active' : ''}" data-proc-key="${esc(key)}" data-outcome="${val}">${label}</button>`;
  }
  h += `</div>`;
  h += `</div>`;
  return h;
}

function _renderCompactMeritPanel(entry, rev) {
  const key        = entry.key;
  const category   = entry.meritCategory || 'misc';
  const actionType = entry.actionType || 'misc';
  const dots       = entry.meritDots;
  const matrixRow  = MERIT_MATRIX[category]?.[actionType] || null;
  const mode       = matrixRow?.mode || 'auto';
  const effect     = matrixRow?.effect || '';
  const effectAuto = matrixRow?.effectAuto || '';
  const isAuto     = mode === 'auto';
  const autoSucc   = isAuto && dots != null ? dots : null;
  const thread     = rev.notes_thread     || [];

  let h = `<div class="proc-feed-right proc-compact-merit-panel" data-proc-key="${esc(key)}">`;

  // ── Territory pills (moved here from action type row) ──
  if (entry.isAlliesAction) {
    const _mCtx = `allies_${entry.actionIdx}`;
    const _mSub = submissions.find(s => s._id === entry.subId);
    const _mTid = _mSub?.st_review?.territory_overrides?.[_mCtx] || resolveTerrId(entry.projTerritory) || '';
    h += `<div class="proc-feed-mod-panel proc-merit-terr-panel">`;
    h += _renderInlineTerrPills(entry.subId, _mCtx, _mTid);
    h += `</div>`;
  }

  // ── Outcome buttons (Approved / Partial / Failed) ──
  h += _renderMeritOutcomeButtons(entry, rev);

  // ── Contacts: sphere / target / info type — each as its own panel to match targeting pattern ──
  if (category === 'contacts') {
    const _ciSphere   = entry.meritSphere || '';
    const _ciTarget   = rev.contacts_target    || '';
    const _ciInfoType = rev.contacts_info_type || '';

    if (_ciSphere) {
      h += `<div class="proc-feed-mod-panel">`;
      h += `<div class="proc-mod-panel-title">Sphere</div>`;
      h += `<div class="proc-contacts-spheres"><span class="proc-contacts-sphere-chip">${esc(_ciSphere)}</span></div>`;
      h += `</div>`;
    }
    h += `<div class="proc-feed-mod-panel">`;
    h += `<div class="proc-mod-panel-title">Target</div>`;
    h += `<input type="text" class="proc-detail-input proc-contacts-target-input" data-proc-key="${esc(key)}" value="${esc(_ciTarget)}" placeholder="Person or group…">`;
    h += `</div>`;
    h += `<div class="proc-feed-mod-panel">`;
    h += `<div class="proc-mod-panel-title">Info Type</div>`;
    h += `<select class="proc-recat-select proc-contacts-info-type-sel" data-proc-key="${esc(key)}"><option value="">— Select —</option>${['Public', 'Internal', 'Confidential', 'Restricted'].map(t => `<option value="${t}"${_ciInfoType === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    h += `</div>`;
  }

  // ── Effect panel ──
  h += `<div class="proc-feed-mod-panel proc-merit-effect-panel" data-proc-key="${esc(key)}">`;
  h += `<div class="proc-merit-mode-row">`;
  h += `<span class="proc-mod-label">Action Mode</span>`;
  h += `<span class="proc-merit-mode-chip proc-merit-mode-${mode}">${MODE_LABELS[mode] || mode}</span>`;
  h += `</div>`;
  if (effect) {
    h += `<div class="proc-merit-effect-row"><span class="proc-mod-label">Effect</span><span class="proc-merit-effect-text">${esc(effect)}</span></div>`;
  }
  if (effectAuto) {
    h += `<div class="proc-merit-effect-row proc-merit-effect-auto"><span class="proc-mod-label">Auto</span><span class="proc-merit-effect-text">${esc(effectAuto)}</span></div>`;
  }
  h += `</div>`; // proc-merit-effect-panel

  // ── Auto successes (auto mode only) ──
  if (isAuto && autoSucc !== null) {
    h += `<div class="proc-feed-mod-panel" data-proc-key="${esc(key)}">`;
    h += `<div class="proc-mod-panel-title">Automatic Successes</div>`;
    h += `<div class="proc-mod-row"><span class="proc-mod-label">Base successes</span><span class="proc-mod-static">${autoSucc}</span></div>`;
    h += `</div>`;
  }

  // ── ST Notes (compact) ──
  h += `<div class="proc-feed-mod-panel proc-compact-notes-panel" data-proc-key="${esc(key)}">`;
  h += `<div class="proc-mod-panel-title">ST Notes</div>`;
  if (thread.length) {
    h += `<div class="proc-notes-thread">`;
    for (let noteIdx = 0; noteIdx < thread.length; noteIdx++) {
      const note = thread[noteIdx];
      const time = note.created_at
        ? new Date(note.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '';
      h += `<div class="proc-note-entry">`;
      h += `<div class="proc-note-meta">${esc(note.author_name)}${time ? '  \u00B7  ' + esc(time) : ''}<button class="proc-note-delete-btn" data-proc-key="${esc(key)}" data-note-idx="${noteIdx}" title="Delete note">\u00D7</button></div>`;
      h += `<div class="proc-note-text">${esc(note.text)}</div>`;
      h += `</div>`;
    }
    h += `</div>`;
  }
  h += `<div class="proc-note-add">`;
  h += `<textarea class="proc-note-textarea" data-proc-key="${esc(key)}" placeholder="Add ST note..." rows="2"></textarea>`;
  h += `<button class="dt-btn proc-add-note-btn" data-proc-key="${esc(key)}">Add Note</button>`;
  h += `</div>`;
  h += `</div>`;

  // ── Outcome ── (feat.847: compact merit actions previously had no outcome box)
  const outcomeVal = rev.outcome || '';
  h += `<div class="proc-section proc-player-note-section">`;
  h += `<div class="proc-mod-panel-title">Outcome</div>`;
  h += `<div class="proc-note-add">`;
  h += `<textarea class="proc-outcome-input" data-proc-key="${esc(key)}" rows="4" placeholder="What happened — appears in the DT result...">${esc(outcomeVal)}</textarea>`;
  h += `<button class="dt-btn proc-confirm-outcome-btn" data-proc-key="${esc(key)}">Confirm</button>`;
  h += `</div>`;
  h += `</div>`;

  h += `</div>`; // proc-compact-merit-panel
  return h;
}

/**
 * Render the right-side sidebar for a sphere merit action entry.
 * Shows: action mode + effect from matrix, equipment modifier, roll card (if rolled), status buttons.
 */
function _renderMeritRightPanel(entry, rev) {
  const key        = entry.key;
  const poolStatus = rev.pool_status || 'pending';
  const category   = entry.meritCategory || 'misc';
  const actionType = entry.actionType || 'misc';
  const dots       = entry.meritDots;
  const eqMod      = rev.pool_mod_equipment || 0;
  const eqStr      = _fmtMod(eqMod);

  const matrixRow  = MERIT_MATRIX[category]?.[actionType] || null;
  const formula    = matrixRow?.poolFormula || 'none';
  const mode       = matrixRow?.mode || 'instant';
  const effect     = matrixRow?.effect || '';
  const effectAuto = matrixRow?.effectAuto || '';

  const basePool   = formula === 'dots2plus2' && dots != null ? (dots * 2) + 2 : null;
  const totalPool  = basePool != null ? basePool + eqMod : null;
  const roll       = rev.roll || null;
  const isRolled   = formula === 'dots2plus2';
  const isAuto     = mode === 'auto';
  const isBlocked  = mode === 'blocked';

  // Compact path for binary/fixed-effect actions — no pool builder needed
  if (_isCompactMerit(entry, mode, formula)) return _renderCompactMeritPanel(entry, rev);


  let h = `<div class="proc-feed-right" data-proc-key="${esc(key)}">`;

  // ── Territory pills (moved here from action type row) ──
  if (entry.isAlliesAction) {
    const _mCtx = `allies_${entry.actionIdx}`;
    const _mSub = submissions.find(s => s._id === entry.subId);
    const _mTid = _mSub?.st_review?.territory_overrides?.[_mCtx] || resolveTerrId(entry.projTerritory) || '';
    h += `<div class="proc-feed-mod-panel proc-merit-terr-panel">`;
    h += _renderInlineTerrPills(entry.subId, _mCtx, _mTid);
    h += `</div>`;
  }

  // ── Outcome buttons (Approved / Partial / Failed) ──
  h += _renderMeritOutcomeButtons(entry, rev);

  // ── Action mode + effect panel ──
  h += `<div class="proc-feed-mod-panel proc-merit-effect-panel" data-proc-key="${esc(key)}">`;
  h += `<div class="proc-merit-mode-row">`;
  h += `<span class="proc-mod-label">Action Mode</span>`;
  h += `<span class="proc-merit-mode-chip proc-merit-mode-${mode}">${MODE_LABELS[mode] || mode}</span>`;
  if (_isAmbienceAction(actionType)) {
    const mLbl = entry.meritLabel || '';
    const mQual = entry.meritQualifier || '';
    h += `<span class="proc-merit-cat-chip proc-merit-cat-${esc(category)}">${esc(mLbl.toUpperCase())}</span>`;
    if (mQual) h += `<span class="proc-merit-qualifier">${esc(mQual)}</span>`;
  }
  h += `</div>`;
  if (effect) {
    h += `<div class="proc-merit-effect-row">`;
    h += `<span class="proc-mod-label">Effect</span>`;
    h += `<span class="proc-merit-effect-text">${esc(effect)}</span>`;
    h += `</div>`;
  }
  if (effectAuto) {
    h += `<div class="proc-merit-effect-row proc-merit-effect-auto">`;
    h += `<span class="proc-mod-label">Auto</span>`;
    h += `<span class="proc-merit-effect-text">${esc(effectAuto)}</span>`;
    h += `</div>`;
  }
  h += `</div>`; // proc-merit-effect-panel
  h += _renderRightMechanics(entry, null, rev);

  if (isBlocked) {
    // Cannot perform this action at all
    h += `<div class="proc-feed-right-section"><span class="dt-dim-italic">This merit cannot perform this action type.</span></div>`;
  } else if (actionType === 'block') {
    // Block — auto-resolution display with confirm button
    const blockLevel = dots != null ? `${dots} or lower` : 'same level or lower';
    const blockConfirmed = poolStatus === 'no_roll';
    h += `<div class="proc-feed-right-section proc-proj-roll-card">`;
    h += `<div class="proc-mod-panel-title">Block Resolution</div>`;
    h += `<div class="proc-mod-row"><span class="proc-mod-label">Auto-blocks</span><span class="proc-mod-static">Merits of level ${esc(blockLevel)}</span></div>`;
    h += `<div class="proc-mod-row" style="margin-top:8px">`;
    if (blockConfirmed) {
      h += `<span class="dt-dim-italic" style="color:var(--gold2)">&#10003; Block confirmed</span>`;
    } else {
      h += `<button class="dt-btn proc-block-confirm-btn" data-proc-key="${esc(key)}">Confirm Block</button>`;
    }
    h += `</div>`;
    h += `</div>`;
  } else if (isAuto) {
    // Auto effect — no roll needed
    h += `<div class="proc-feed-right-section proc-proj-roll-card">`;
    h += `<div class="proc-mod-panel-title">Automatic</div>`;
    h += `<span class="dt-dim-italic">No roll required — effect applies automatically.</span>`;
    h += `</div>`;
  } else if (isRolled) {
    // Merit actions do not use dice pools — show automatic successes instead
    const autoSucc = dots != null ? dots : 0;
    h += `<div class="proc-feed-mod-panel" data-proc-key="${esc(key)}">`;
    h += `<div class="proc-mod-panel-title">Automatic Successes</div>`;
    h += `<div class="proc-mod-row"><span class="proc-mod-label">Base successes</span><span class="proc-mod-static">${autoSucc}</span></div>`;
    h += `</div>`; // mod panel
  } else if (formula === 'none') {
    // Staff — fixed effect, no roll
    h += `<div class="proc-feed-right-section proc-proj-roll-card">`;
    h += `<div class="proc-mod-panel-title">Fixed Effect</div>`;
    h += `<span class="dt-dim-italic">No dice pool — effect applies as stated.</span>`;
    h += `</div>`;
  }

  // ── Success Modifier ──
  if (isRolled) {
    const succMod = rev.succ_mod_manual !== undefined ? rev.succ_mod_manual : 0;
    const succStr = _fmtMod(succMod);
    h += `<div class="proc-proj-succ-panel" data-proc-key="${esc(key)}">`;
    h += `<div class="proc-mod-panel-title">Success Modifier</div>`;
    h += _renderTickerRow(key, 'Manual adj.', 'proc-succmod', succStr, succMod);
    h += `<div class="proc-mod-total-row"><span class="proc-mod-label">Net modifier</span>`;
    h += `<span class="proc-proj-succ-total-val" data-proc-key="${esc(key)}">${succStr}</span>`;
    h += `</div>`;
    h += `</div>`;
  }

  h += `</div>`; // proc-feed-right
  return h;
}

function _renderSorceryRightPanel(entry, char, sub, rev) {
  const key         = entry.key;
  const poolStatus  = rev.pool_status || 'pending';
  const selectedRite = rev.rite_override || entry.riteName || '';
  const ritInfo      = selectedRite ? _getRiteInfo(selectedRite) : null;

  const isCruac      = (rev.sorc_tradition || entry.tradition) === 'Cruac';
  const _mgMerit     = isCruac ? (char?.merits || []).find(m => m.name === 'Mandragora Garden') : null;
  const mgDots       = _mgMerit ? ((_mgMerit.rating || _mgMerit.dots || 0) + (_mgMerit.bonus || 0)) : 0;
  const eqMod        = rev.pool_mod_equipment || 0;
  const base         = ritInfo ? _computeRitePool(char, ritInfo.attr, ritInfo.skill, ritInfo.disc) : 0;
  const total        = base + 3 + mgDots + eqMod;

  let h = `<div class="proc-feed-right" data-proc-key="${esc(key)}">`;

  // ── Parked Mandragora rite — prior cycle resolution (async-filled by _hydrateMgPriorOutcomes) ──
  if (entry.mandragora) {
    const _priorCycle = currentCycle
      ? allCycles
          .filter(c => c.cycle_number < currentCycle.cycle_number)
          .sort((a, b) => b.cycle_number - a.cycle_number)[0] || null
      : null;
    const _priorCycleId = _priorCycle?._id || '';
    const _charId       = sub?.character_id || '';
    if (_priorCycleId) {
      h += `<div class="proc-mg-prior-outcome mg-prior-loading"
                  data-prior-cycle-id="${esc(String(_priorCycleId))}"
                  data-char-id="${esc(String(_charId))}"
                  data-rite-name="${esc(entry.riteName || '')}">`;
      h += `<div class="proc-mod-panel-title">Prior cycle resolution</div>`;
      h += `<div class="mg-prior-text"><em>Loading…</em></div>`;
      h += `</div>`;
    } else {
      h += `<div class="proc-mg-prior-outcome">`;
      h += `<div class="proc-mod-panel-title">Prior cycle resolution</div>`;
      h += `<div class="mg-prior-text"><em>No prior resolution recorded</em></div>`;
      h += `</div>`;
    }

    // ── Parked Mandragora rite — Acknowledge control ──────────────────────────
    const _mgAcked = sub?.responses?.[`sorcery_${entry.actionIdx}_mg_acked`] === 'yes';
    h += `<div class="proc-mg-ack">`;
    if (_mgAcked) {
      h += `<span class="proc-mg-ack-done">&#10003; Noted &#8212; still running</span>`;
    } else {
      h += `<button type="button" class="dt-btn proc-mg-ack-btn" data-proc-key="${esc(key)}">Noted &#8212; still running</button>`;
    }
    h += `</div>`;
  }

  // ── Dice Pool Builder (no attr/skill/disc dropdowns — pool is fixed by rite rules) ──
  {
    let exprParts = [];
    if (ritInfo && char) {
      const _slEntry = ritInfo.disc ? _charDiscsArray(char).find(d => d.name === ritInfo.disc) : null;
      exprParts = [
        `${ritInfo.attr} ${getAttrVal(char, ritInfo.attr) || 0}`,
        `${ritInfo.skill} ${skTotal(char, ritInfo.skill) || 0}`,
        ritInfo.disc ? `${ritInfo.disc} ${_slEntry?.dots || 0}` : null,
        '+3',
      ].filter(Boolean);
    } else if (ritInfo) {
      exprParts = [ritInfo.poolExpr, '+3'];
    }
    if (mgDots) exprParts.push(`+${mgDots}`);
    if (eqMod)  exprParts.push(eqMod > 0 ? `+${eqMod}` : String(eqMod));
    const _poolTotalStr = ritInfo
      ? `${exprParts.join(' + ')} = ${total}   TARGET   ${ritInfo.target} success${ritInfo.target !== 1 ? 'es' : ''} (Level ${ritInfo.target})`
      : 'Select a rite to compute pool';

    h += `<div class="proc-pool-builder" data-proc-key="${esc(key)}">`;
    h += `<div class="proc-mod-panel-title">Dice Pool Builder</div>`;
    h += _renderPoolModPanel(entry, char, rev, 'sorcery');
    h += `<div class="proc-pool-total" data-proc-key="${esc(key)}">${esc(_poolTotalStr)}</div>`;
    h += `</div>`;
  }

  h += _renderRightMechanics(entry, char, rev, { isSorcery: true });

  // ── Roll card ──
  const ritRoll = rev.ritual_roll || null;
  const canRoll = !!ritInfo;
  h += _renderRollCard(key, ritRoll, canRoll ? total : null, {
    btnClass:        'proc-ritual-roll-btn',
    canRoll,
    noRollMsg:       'Select a rite first',
    targetSuccesses:  ritInfo?.target ?? null,
  });

  h += `</div>`; // proc-feed-right
  return h;
}

/**
 * Render the right-side sidebar for a project/ambience entry (feature.59).
 * Dice Pool Modifiers (equipment only) + Success Modifier + Rote + Roll card.
 */
function _renderProjRightPanel(entry, char, rev, prependHtml = '') {
  const key = entry.key;
  // Always derive pool expression from current effective character stats (dots + bonus)
  const poolValidated = _refreshPoolExpr(rev.pool_validated || '', char);
  const poolStatus    = rev.pool_status    || 'pending';

  const succMod = rev.succ_mod_manual !== undefined ? rev.succ_mod_manual : 0;
  const succStr = _fmtMod(succMod);

  let h = `<div class="proc-feed-right" data-proc-key="${esc(key)}">`;
  if (prependHtml) h += prependHtml;
  h += _renderRightMechanics(entry, char, rev);

  // ── Roll card ──
  {
    const _projRoll    = rev.roll || null;
    const _showRollBtn = poolStatus === 'pending' || poolStatus === 'confirmed' || poolStatus === 'rolled' || poolStatus === 'validated' || !!_projRoll;
    h += _renderRollCard(key, _projRoll, null, {
      btnClass:        'proc-proj-roll-btn',
      btnDataAttrs:    ` data-pool-validated="${esc(poolValidated)}"`,
      canRoll:          _showRollBtn,
      // #595: a 'no_roll' action is a deliberate end state, not an un-validated pool.
      noRollMsg:       poolStatus === 'no_roll' ? 'No roll needed' : 'Validate pool first',
      successModifier:  succMod,
      contestedRoll:    rev.contested_roll || null,
      showConfirm:      poolStatus === 'pending',
      contestedData:    !rev.rote ? {
        isContested:   !!rev.contested,
        contestedChar: rev.contested_char || '',
        contestedPool: rev.contested_pool_label || '',
        contestedRoll: rev.contested_roll || null,
        resistTraits:  rev.contested_resist_traits || [],
        resistBp:      !!rev.contested_resist_bp,
      } : null,
    });
  }

  // ── Success Modifier ──
  h += `<div class="proc-proj-succ-panel" data-proc-key="${esc(key)}">`;
  h += `<div class="proc-mod-panel-title">Success Modifier</div>`;
  h += _renderTickerRow(key, 'Manual adj.', 'proc-succmod', succStr, succMod);
  h += `<div class="proc-mod-total-row"><span class="proc-mod-label">Net modifier</span>`;
  h += `<span class="proc-proj-succ-total-val" data-proc-key="${esc(key)}">${succStr}</span>`;
  h += `</div>`;
  h += `</div>`; // proc-proj-succ-panel


  // ── Roll toggles: Rote, 9-Again, 8-Again ──
  const isRote        = rev.rote        || false;
  const eightAgainState = rev.eight_again || false;
  // Auto-detect nine_again from the character's validated skill — only when not explicitly saved
  const nineAgainState = _resolveNineAgainState(rev, poolValidated, char);
  h += `<div class="proc-feed-right-section proc-feed-toggles-row" style="display:none">`;
  h += `<label class="proc-pool-rote-label proc-feed-rote-right"><input type="checkbox" class="proc-pool-rote" data-proc-key="${esc(key)}"${isRote ? ' checked' : ''}> Rote Action</label>`;
  h += `<label class="proc-pool-rote-label proc-feed-rote-right"><input type="checkbox" class="proc-proj-9a" data-proc-key="${esc(key)}"${nineAgainState ? ' checked' : ''}> 9-Again</label>`;
  h += `<label class="proc-pool-rote-label proc-feed-rote-right"><input type="checkbox" class="proc-proj-8a" data-proc-key="${esc(key)}"${eightAgainState ? ' checked' : ''}> 8-Again</label>`;
  h += `</div>`;

  h += `</div>`; // proc-feed-right
  return h;
}

/**
 * Render the right-side modifier panel for a feeding entry (Tasks 2 & 3, feature.51).
 * @param {object} entry - Processing queue entry
 * @param {object|null} char - Character document (may be null)
 * @param {object} rev - feeding_review fields
 */
function _renderFeedRightPanel(entry, char, rev, prependHtml = '') {
  const key = entry.key;

  // ── Pool modifier panel data ──
  const fg = (char?.merits || []).find(m => m.name === 'Feeding Grounds');
  const fgDice = fg ? Math.min(char ? meritEffectiveRating(char, fg) : (fg.rating || 0), 5) : null; // null = char not loaded; cap at merit max

  // Always derive pool expression from current effective character stats (dots + bonus)
  const poolValidated = _refreshPoolExpr(rev.pool_validated || '', char);
  let initSkillName = '', initSkillDots = 0;
  if (poolValidated && char) {
    const charDiscs0 = _charDiscsArray(char).filter(d => d.dots > 0).map(d => d.name);
    const parsed0 = _parsePoolExpr(poolValidated, ALL_ATTRS, ALL_SKILLS, charDiscs0);
    if (parsed0?.skill) {
      initSkillName = parsed0.skill;
      initSkillDots = skTotal(char, initSkillName) || 0;
    }
  }
  const initUnskilled = _unskilledPenalty(initSkillName, initSkillDots);

  const eqMod = rev.pool_mod_equipment !== undefined ? rev.pool_mod_equipment : 0;
  const eqStr = _fmtMod(eqMod);
  const poolModTotal = (fgDice ?? 0) + initUnskilled + eqMod;
  const poolModTotalStr = _fmtMod(poolModTotal);

  // fgDice data attr: '' when char null (so live update can detect "unknown")
  const fgDataAttr = fgDice !== null ? String(fgDice) : '';
  const fgDisplay  = fgDice !== null ? (fgDice > 0 ? `+${fgDice}` : String(fgDice)) : '\u2014';

  let h = `<div class="proc-feed-right" data-proc-key="${esc(key)}">`;
  if (prependHtml) h += prependHtml;

  // ── Roll card ──
  {
    const _feedSub      = submissions.find(s => s._id === entry.subId);
    const _poolStatus   = rev.pool_status || 'pending';
    const _isRote       = entry.feedRote || _feedSub?.st_review?.feeding_rote || false;
    const _feedRollObj  = _feedSub?.feeding_roll || null;
    const _showRollBtn  = _poolStatus === 'pending' || _poolStatus === 'confirmed' || _poolStatus === 'rolled' || _poolStatus === 'validated' || !!_feedRollObj;
    h += _renderRollCard(key, _feedRollObj, null, {
      btnClass:     'proc-feed-roll-btn',
      btnDataAttrs: ` data-sub-id="${esc(entry.subId)}" data-rote="${_isRote}"`,
      canRoll:      _showRollBtn,
      noRollMsg:    'Confirm pool first',
      showConfirm:  _poolStatus === 'pending',
      clearBtnHtml: _feedRollObj
        ? `<button class="dt-btn proc-feed-clear-roll-btn" data-sub-id="${esc(entry.subId)}" data-proc-key="${esc(key)}">Clear Roll</button>`
        : '',
    });
  }

  // ── Vitae Tally ──
  const herd = (char?.merits || []).find(m => m.name === 'Herd');
  // Include SSJ and Flock bonuses; fall back to stored rating for old-schema chars
  const herdVitae = char
    ? (domMeritContrib(char, 'Herd') || (herd ? (herd.rating || 0) : 0))
    : null;

  const hasOoF = (char?.powers || []).some(p => p.category === 'pact' && p.name === 'Oath of Fealty');
  const oofVitae = hasOoF ? effectiveInvictusStatus(char) : 0;

  // Ambience: use best (highest ambienceMod) territory the character actually fed in
  const terrList = (cachedTerritories && cachedTerritories.length) ? cachedTerritories : TERRITORY_DATA;
  const feedSub = submissions.find(s => s._id === entry.subId);
  const fedTerrKeys = feedSub ? _getSubFedTerrs(feedSub) : new Map();

  let bestTerrLabel = null;
  let ambienceVitae = null;
  for (const [csvKey] of fedTerrKeys) {
    const mt = MATRIX_TERRS.find(m => m.csvKey === csvKey);
    if (!mt || !mt.ambienceKey) continue;
    const tid = TERRITORY_SLUG_MAP[mt.csvKey] ?? null;
    // Translate slug to Mongo _id-string so cycle confirmed_ambience reads correctly (ADR-002).
    const oid = tid ? (cachedTerritories || []).find(t => t.slug === tid)?._id : null;
    const oidStr = oid ? String(oid) : null;
    const confirmedAmb = oidStr ? currentCycle?.confirmed_ambience?.[oidStr] : null;
    let mod = null;
    if (confirmedAmb != null) {
      mod = confirmedAmb.ambienceMod ?? 0;
    } else {
      // Both Mongo docs and TERRITORY_DATA key the slug as `slug` post-#3e.
      const tr = terrList.find(t =>
        t.slug === tid || t.name === mt.ambienceKey
      );
      mod = tr?.ambienceMod ?? null;
    }
    if (mod !== null && (ambienceVitae === null || mod > ambienceVitae)) {
      ambienceVitae = mod;
      bestTerrLabel = mt.label;
    }
  }
  // Fallback: if no fed territories resolved, use primaryTerr as before.
  // normalizedTerrId is a slug; translate to _id for confirmed_ambience reads.
  if (ambienceVitae === null && entry.primaryTerr) {
    // 496.2 QA: primaryTerr may now be an ObjectId (post-496.2 form). Match
    // OID against _id directly; fall through to the existing slug/name match
    // for legacy long-slug / display-name values.
    const isOid = /^[a-f0-9]{24}$/i.test(entry.primaryTerr);
    const normalizedTerrId = TERRITORY_SLUG_MAP[entry.primaryTerr] ?? entry.primaryTerr;
    const terrRec = terrList.find(t =>
      (isOid && String(t._id) === entry.primaryTerr) ||
      t.slug === normalizedTerrId ||
      t.name === entry.primaryTerr ||
      t.name?.toLowerCase() === (entry.primaryTerr || '').replace(/_/g, ' ').toLowerCase()
    );
    const fallbackOid = terrRec?._id ? String(terrRec._id) : null;
    const confirmedAmb = fallbackOid ? currentCycle?.confirmed_ambience?.[fallbackOid] : null;
    ambienceVitae = confirmedAmb != null ? (confirmedAmb.ambienceMod ?? 0) : (terrRec?.ambienceMod ?? null);
    // 496.2 QA: use the resolved territory's name when available so the UI
    // shows "The Harbour" instead of a 24-char hex OID.
    bestTerrLabel = terrRec?.name || (entry.primaryTerr ? entry.primaryTerr.replace(/_/g, ' ') : null);
  }
  // No territory resolved = Barrens: −4 ambience
  if (ambienceVitae === null) {
    ambienceVitae = -4;
    bestTerrLabel = 'Barrens';
  }

  const ghoulCount = (char?.merits || []).filter(m =>
    m.name === 'Retainer' && (m.area || m.qualifier || '').toLowerCase().includes('ghoul')
  ).length;

  const vitaeMod  = rev.vitae_mod_manual !== undefined ? rev.vitae_mod_manual : 0;
  const feedSubForRite = submissions.find(s => s._id === entry.subId);
  const computedRiteCost = feedSubForRite ? _computeRiteVitaeCost(feedSubForRite, char) : 0;
  const vitaeRite = rev.vitae_rite_cost  !== undefined ? rev.vitae_rite_cost  : computedRiteCost;
  const wpCost = feedSubForRite ? _computeRiteWpCost(feedSubForRite, char) : 0;
  const manStr    = _fmtMod(vitaeMod);

  const autoSum = (herdVitae ?? 0) + oofVitae + (ambienceVitae ?? 0) - ghoulCount;
  const finalVitae = Math.max(0, autoSum + vitaeMod - vitaeRite);

  // data attrs for live recalculation
  const herdData      = herdVitae     !== null ? String(herdVitae)    : '';
  const ambienceData  = ambienceVitae !== null ? String(ambienceVitae): '';

  h += `<div class="proc-feed-right-section proc-feed-vitae-panel" data-proc-key="${esc(key)}" data-herd="${esc(herdData)}" data-oof="${oofVitae}" data-ambience="${esc(ambienceData)}" data-ghouls="${ghoulCount}" data-terr-label="${esc(bestTerrLabel || '')}" data-rite-cost="${vitaeRite}" data-manual="${vitaeMod}" data-total-bonus="${finalVitae}">`;
  h += `<div class="proc-mod-panel-title">Vitae Tally</div>`;

  // Herd (issue #599: surface Flock-derived dots, which can exceed the +5 cap).
  // herdVitae (domMeritContrib) ALREADY includes the Flock bonus \u2014 do not re-add it.
  const flockHerd   = flockHerdBonus(char);
  const herdLabel   = (herdVitae !== null && flockHerd > 0) ? 'Herd (Flock)' : 'Herd';
  const herdDisplay = herdVitae !== null
    ? (flockHerd > 0 ? `+${herdVitae} (+${flockHerd})` : `+${herdVitae}`)
    : '\u2014';
  h += `<div class="proc-mod-row"><span class="proc-mod-label">${herdLabel}</span><span class="proc-mod-val${herdVitae !== null && herdVitae > 0 ? ' proc-mod-pos' : ''}">${herdDisplay}</span></div>`;

  // Feeding Grounds — does not contribute vitae
  h += `<div class="proc-mod-row"><span class="proc-mod-label">Feeding Grounds</span><span class="proc-mod-val proc-mod-muted">\u2014</span></div>`;

  // Oath of Fealty (only if character has it)
  if (hasOoF) {
    h += `<div class="proc-mod-row"><span class="proc-mod-label">Oath of Fealty</span><span class="proc-mod-val proc-mod-pos">+${oofVitae}</span></div>`;
  }

  // Territory ambience — always show, labelled with best fed territory name
  {
    const ambLabel = bestTerrLabel ? `Ambience (${bestTerrLabel})` : 'Ambience';
    if (ambienceVitae === null) {
      h += `<div class="proc-mod-row"><span class="proc-mod-label">${esc(ambLabel)}</span><span class="proc-mod-val proc-mod-muted">\u2014</span></div>`;
    } else {
      const ambSign = ambienceVitae > 0 ? '+' : '';
      h += `<div class="proc-mod-row"><span class="proc-mod-label">${esc(ambLabel)}</span><span class="proc-mod-val ${ambienceVitae > 0 ? 'proc-mod-pos' : ambienceVitae < 0 ? 'proc-mod-neg' : ''}">${ambSign}${ambienceVitae}</span></div>`;
    }
  }

  // Ghoul retainers (only if > 0)
  if (ghoulCount > 0) {
    h += `<div class="proc-mod-row"><span class="proc-mod-label">Ghoul retainers</span><span class="proc-mod-val proc-mod-neg">\u2212${ghoulCount}</span></div>`;
  }

  // Rite costs row (always shown with manual input)
  h += `<div class="proc-mod-row proc-mod-rite-row">`;
  h += `<span class="proc-mod-label">Rite costs</span>`;
  h += `<input type="number" class="proc-rite-cost-input dt-num-input-sm" min="0" data-proc-key="${esc(key)}" value="${vitaeRite}">`;
  h += `</div>`;

  // Theban WP cost — informational only, does not affect vitae total
  if (wpCost > 0) {
    h += `<div class="proc-mod-row">`;
    h += `<span class="proc-mod-label">Theban Sorcery <span class="proc-mod-muted">(vitae unaffected)</span></span>`;
    h += `<span class="proc-mod-val proc-mod-neg">\u2212${wpCost}\u202FWP</span>`;
    h += `</div>`;
  }

  // Manual adjustment ticker
  h += `<div class="proc-mod-row proc-mod-ticker-row"><span class="proc-mod-label">Manual adj.</span>`;
  h += `<span class="proc-mod-ticker">`;
  h += `<button class="proc-vitae-mod-dec" type="button" data-proc-key="${esc(key)}">\u2212</button>`;
  h += `<span class="proc-vitae-mod-disp" data-proc-key="${esc(key)}">${manStr}</span>`;
  h += `<input type="hidden" class="proc-vitae-mod-val" data-proc-key="${esc(key)}" value="${vitaeMod}">`;
  h += `<button class="proc-vitae-mod-inc" type="button" data-proc-key="${esc(key)}">+</button>`;
  h += `</span></div>`;

  // Final vitae total
  h += `<div class="proc-mod-total-row"><span class="proc-mod-label">Final Vitae</span>`;
  h += `<span class="proc-vitae-total-val" data-proc-key="${esc(key)}">${finalVitae}</span>`;
  h += `</div>`;

  h += `</div>`; // proc-feed-vitae-panel

  // ── Roll toggles: Rote, 9-Again, 8-Again ──
  const feedSubR = submissions.find(s => s._id === entry.subId);
  const isRote = entry.feedRote || feedSubR?.st_review?.feeding_rote || false;
  const eightAgainStateFeed = rev.eight_again || false;
  const nineAgainStateFeed = _resolveNineAgainState(rev, poolValidated, char);
  h += `<div class="proc-feed-right-section proc-feed-toggles-row" style="display:none">`;
  h += `<label class="proc-pool-rote-label proc-feed-rote-right"><input type="checkbox" class="proc-pool-rote" data-proc-key="${esc(key)}"${isRote ? ' checked' : ''}> Rote Action</label>`;
  h += `<label class="proc-pool-rote-label proc-feed-rote-right"><input type="checkbox" class="proc-proj-9a" data-proc-key="${esc(key)}"${nineAgainStateFeed ? ' checked' : ''}> 9-Again</label>`;
  h += `<label class="proc-pool-rote-label proc-feed-rote-right"><input type="checkbox" class="proc-proj-8a" data-proc-key="${esc(key)}"${eightAgainStateFeed ? ' checked' : ''}> 8-Again</label>`;
  h += `</div>`;


  // ── Territory pill ──
  {
    const _stOvrArr = feedSub?.st_review?.territory_overrides?.feeding;
    let _feedSet;
    if (Array.isArray(_stOvrArr)) {
      _feedSet = new Set(_stOvrArr);
    } else {
      _feedSet = new Set();
      try {
        const _grid = JSON.parse(feedSub?.responses?.feeding_territories || '{}');
        for (const [slug, status] of Object.entries(_grid)) {
          if (!status || status === 'none' || status === 'Not feeding here') continue;
          let tid;
          if (/^[a-f0-9]{24}$/i.test(slug)) {
            const terrDoc = (cachedTerritories || []).find(t => String(t._id) === slug);
            tid = terrDoc?.slug || null;
          } else {
            tid = TERRITORY_SLUG_MAP[slug];
          }
          if (tid) _feedSet.add(tid);
        }
      } catch { /* ignore malformed JSON */ }
      if (_feedSet.size === 0) {
        const _rawTerrs = _normTerrKeys(feedSub?._raw?.feeding?.territories || {});
        for (const [_slug, status] of Object.entries(_rawTerrs)) {
          if (!status || status === 'Not feeding here' || status === 'none') continue;
          const tid = TERRITORY_SLUG_MAP[_slug];
          if (tid) _feedSet.add(tid);
        }
      }
    }
    h += `<div class="proc-feed-mod-panel">`;
    h += `<div class="proc-mod-panel-title">Territory</div>`;
    h += _renderInlineTerrPills(entry.subId, 'feeding', '', _feedSet, true);
    h += `</div>`;
  }

  // ── DTFP-5: feed-violence + blood-type ST overrides ──
  const playerVi      = feedSub?.responses?.feed_violence || '';
  const stViOverride  = feedSub?.st_review?.feed_violence_st_override || '';
  const playerBtRaw   = feedSub?.responses?.['_feed_blood_types'] || '[]';
  let   playerBtArr   = [];
  try   { playerBtArr = JSON.parse(playerBtRaw); } catch { playerBtArr = []; }
  const playerBtLabel = playerBtArr.length
    ? playerBtArr.map(v => v.charAt(0).toUpperCase() + v.slice(1)).join(' / ')
    : '';
  const stBtOverride  = feedSub?.st_review?.feed_blood_type_st_override || '';
  const _viLabel = (v) => v === 'kiss' ? 'The Kiss (subtle)' : v === 'violent' ? 'Violent' : '';

  h += `<div class="proc-feed-mod-panel proc-feed-violence-block" data-proc-key="${esc(key)}">`;
  h += `<div class="proc-mod-panel-title">Feed declaration</div>`;

  // Blood type row
  h += `<div class="proc-mod-row"><span class="proc-mod-label">Blood type</span>`;
  h += `<span class="proc-feed-violence-val">${esc(playerBtLabel) || '<em>Not specified</em>'}</span></div>`;
  h += `<div class="proc-mod-row proc-feed-chips-row">`;
  h += `<span class="proc-mod-label">ST override</span>`;
  h += `<div class="proc-feed-chips">`;
  for (const [val, lbl] of [['', 'No override'], ['animal', 'Animal'], ['human', 'Human'], ['kindred', 'Kindred']]) {
    const active = (val === '' ? !stBtOverride : stBtOverride === val) ? ' is-active' : '';
    h += `<button type="button" class="proc-spec-chip proc-feed-bt-chip${active}" data-sub-id="${esc(entry.subId)}" data-value="${esc(val)}">${esc(lbl)}</button>`;
  }
  h += `</div></div>`;

  // Feeding method row
  h += `<div class="proc-mod-row"><span class="proc-mod-label">Player declared</span>`;
  h += `<span class="proc-feed-violence-val">${esc(_viLabel(playerVi)) || '<em>Not specified</em>'}</span></div>`;
  h += `<div class="proc-mod-row proc-feed-chips-row">`;
  h += `<span class="proc-mod-label">ST override</span>`;
  h += `<div class="proc-feed-chips">`;
  for (const [val, lbl] of [['', 'No override'], ['kiss', 'The Kiss (subtle)'], ['violent', 'Violent']]) {
    const active = (val === '' ? !stViOverride : stViOverride === val) ? ' is-active' : '';
    h += `<button type="button" class="proc-spec-chip proc-feed-vi-chip${active}" data-sub-id="${esc(entry.subId)}" data-value="${esc(val)}">${esc(lbl)}</button>`;
  }
  h += `</div></div>`;

  h += `</div>`; // proc-feed-violence-block

  h += `</div>`; // proc-feed-right
  return h;
}

/**
 * Resolve a character object from a submission.
 * Tries character_id first, then character_name via charMap.
 */
function _findCharForSub(sub) {
  if (!sub) return null;
  const charIdStr   = sub.character_id ? String(sub.character_id) : null;
  const charNameKey = (sub.character_name || '').toLowerCase().trim();
  return (charIdStr && characters.find(ch => String(ch._id) === charIdStr)) ||
         charMap.get(charNameKey) || null;
}

/**
 * Renders the standard roll card section for a right-panel.
 * @param {string} key          - proc entry key
 * @param {object|null} roll    - the roll object (rev.roll / rev.ritual_roll etc.)
 * @param {number|null} poolTotal - total dice to display in card title (null = omit)
 * @param {object} opts
 *   @param {string}  opts.btnClass        - CSS class on the Roll button
 *   @param {string}  opts.btnDataAttrs    - extra data-* attrs string for the button
 *   @param {boolean} opts.canRoll         - whether the Roll button should appear (default true)
 *   @param {string}  opts.noRollMsg       - hint shown when canRoll is false
 *   @param {number}  opts.targetSuccesses - sorcery: target for potency/fail display
 */
// #608: contested resistance pool — built from the opposing character's resistance
// traits (Resolve/Stamina/Composure) plus optional Blood Potency. Produces a label
// ending in "= N" so the existing Roll Defence parser (rollPool) works unchanged.
const CONTESTED_RESIST_TRAITS = ['Resolve', 'Stamina', 'Composure'];
function _computeContestedPoolLabel(traits, useBp, oppChar) {
  if (!oppChar) return '';
  const sel = (traits || []).filter(t => CONTESTED_RESIST_TRAITS.includes(t));
  const parts = [];
  let total = 0;
  for (const t of CONTESTED_RESIST_TRAITS) {            // stable display order
    if (!sel.includes(t)) continue;
    const v = getAttrVal(oppChar, t) || 0;
    parts.push(`${t} ${v}`);
    total += v;
  }
  if (useBp) {
    const bp = oppChar.blood_potency || 0;
    parts.push(`Blood Potency ${bp}`);
    total += bp;
  }
  return parts.length ? `${parts.join(' + ')} = ${total}` : '';
}

function _renderRollCard(key, roll, poolTotal, opts = {}) {
  const {
    btnClass        = 'proc-proj-roll-btn',
    btnDataAttrs    = '',
    canRoll         = true,
    noRollMsg       = 'No roll available',
    targetSuccesses = null,
    successModifier = 0,   // DTR-1: succ_mod_manual from rev
    contestedRoll   = null, // DTR-2: defender roll object (for net calculation)
    showConfirm     = false,
    contestedData   = null, // DTR-2: { isContested, contestedChar, contestedPool, contestedRoll } \u2014 renders toggle+controls inside roll card
    clearBtnHtml    = '',   // optional button HTML injected after Re-roll (opt-in per call site)
  } = opts;

  const poolLabel   = (poolTotal != null && canRoll) ? ` \u2014 ${poolTotal} dice` : '';
  const targetLabel = (targetSuccesses != null && canRoll) ? ` \u00b7 target ${targetSuccesses}` : '';

  let h = `<div class="proc-feed-right-section proc-proj-roll-card">`;
  h += `<div class="proc-mod-panel-title">Roll${poolLabel}${targetLabel}</div>`;

  // \u2500\u2500 Contested toggle + controls (above roll button) \u2500\u2500
  if (contestedData) {
    const { isContested, contestedChar = '', contestedPool = '', contestedRoll: cContest = null, resistTraits = [], resistBp = false } = contestedData;
    h += `<div class="proc-contested-inline">`;
    h += `<button class="proc-contested-toggle${isContested ? ' active' : ''}" data-proc-key="${esc(key)}">${isContested ? 'Contested \u2014 ON' : 'Mark as Contested'}</button>`;
    if (isContested) {
      // Opposing Char \u2014 styled typeahead chip picker (single-select; #608).
      const _oppAll = [...characters].filter(c => !c.retired).map(c => ({ key: sortName(c), label: c.moniker || c.name }));
      h += _renderCharTypeahead(key, contestedChar ? [contestedChar] : [], _oppAll, { label: 'Opposing Char', saveField: 'contested_char', single: true });
      // Resistance Pool \u2014 built from the opposing character's resistance traits + optional BP (#608).
      h += `<div class="proc-mod-row" style="margin-top:4px"><span class="proc-mod-label">Resistance Pool</span></div>`;
      const _oppChar = characters.find(c => sortName(c) === contestedChar) || null;
      if (!_oppChar) {
        h += `<div class="proc-mod-row"><span class="proc-mod-val proc-mod-muted">Select an opposing character first.</span></div>`;
      } else {
        h += `<div class="proc-contested-resist" data-proc-key="${esc(key)}">`;
        for (const t of CONTESTED_RESIST_TRAITS) {
          const on = resistTraits.includes(t);
          h += `<button type="button" class="proc-contested-trait${on ? ' is-active' : ''}" data-proc-key="${esc(key)}" data-trait="${esc(t)}">${esc(t)} ${getAttrVal(_oppChar, t) || 0}</button>`;
        }
        h += `<button type="button" class="proc-contested-bp${resistBp ? ' is-active' : ''}" data-proc-key="${esc(key)}">+ Blood Potency ${_oppChar.blood_potency || 0}</button>`;
        h += `</div>`;
        const _expr = _computeContestedPoolLabel(resistTraits, resistBp, _oppChar);
        if (_expr) h += `<div class="proc-pool-total proc-contested-total">${esc(_expr)}</div>`;
      }
      if (contestedPool) {
        const defBtnLabel = cContest ? 'Re-roll Defence' : 'Roll Defence';
        h += `<button class="dt-btn proc-contested-roll-btn" data-proc-key="${esc(key)}">${defBtnLabel}</button>`;
        if (cContest) {
          const dStr = _formatDiceString(cContest.dice_string);
          h += `<div class="proc-proj-roll-result">${esc(dStr)} ${cContest.successes} defence success${cContest.successes !== 1 ? 'es' : ''}</div>`;
        }
      }
    }
    h += `</div>`; // proc-contested-inline
  }

  if (canRoll) {
    if (showConfirm) {
      h += `<button class="dt-btn proc-confirm-pool-btn" data-proc-key="${esc(key)}">Confirm Dice Pool</button>`;
    }
    const btnLabel = roll ? 'Re-roll' : 'Roll Dice Pool';
    h += `<button class="dt-btn ${esc(btnClass)}" data-proc-key="${esc(key)}"${btnDataAttrs}>${btnLabel}</button>`;
    if (clearBtnHtml) h += clearBtnHtml;
    if (roll) {
      const dStr   = _formatDiceString(roll.dice_string);
      const suc    = roll.successes ?? 0;
      const excTag = roll.exceptional ? ' \u00b7 Exceptional' : '';
      if (targetSuccesses != null) {
        const hit     = suc >= targetSuccesses;
        const failCls = hit ? '' : ' proc-ritual-fail';
        const resText = hit ? ` \u2014 Potency ${suc}` : ' \u2014 no effect';
        h += `<div class="proc-proj-roll-result${failCls}">${esc(dStr)} ${suc} success${suc !== 1 ? 'es' : ''}${resText}${excTag}</div>`;
      } else {
        const defSuc  = contestedRoll ? (contestedRoll.successes ?? 0) : 0;
        const net     = suc - defSuc + successModifier;
        const defPart = contestedRoll ? ` \u2212 ${defSuc} def` : '';
        const manPart = successModifier !== 0 ? (successModifier > 0 ? ` +${successModifier}` : ` ${successModifier}`) : '';
        const netCls  = (contestedRoll || successModifier !== 0) && net <= 0 ? ' proc-roll-net-zero' : '';
        const netExc  = (contestedRoll || successModifier !== 0) && net >= 5 ? ' \u00b7 Exceptional' : excTag;
        if (contestedRoll || successModifier !== 0) {
          const attLabel = contestedRoll ? 'att' : `success${suc !== 1 ? 'es' : ''}`;
          h += `<div class="proc-proj-roll-result${netCls}">${esc(dStr)} ${suc} ${attLabel}${defPart}${manPart} = ${net} net${netExc}</div>`;
        } else {
          h += `<div class="proc-proj-roll-result">${esc(dStr)} ${suc} success${suc !== 1 ? 'es' : ''}${excTag}</div>`;
        }
      }
    }
  } else {
    h += `<span class="dt-dim-italic dt-hint">${esc(noRollMsg)}</span>`;
  }

  h += `</div>`;
  return h;
}

/**
 * Renders the action-type recategorisation row (dropdown + conditional target selectors).
 * Handles the full recat row content for both project and merit entries.
 *
 * For merit entries, also renders the merit-link dropdown and territory pills that appear
 * within the same row. For project entries, renders territory pills and the original-type badge.
 *
 * @param {object} entry  - queue entry
 * @param {object} rev    - review object for the entry
 * @param {object|null} char - resolved character (used for hide_protect merit list and merit-link)
 */
// feature.97: structured XP-spend breakdown table for ST processing card.
// Replaces the flat category:item string when structured row data is available.
function _renderXpSpendBreakdown(rows, budget) {
  const CAT_LABELS = {
    attribute: 'Attribute', skill: 'Skill', discipline: 'Discipline',
    merit: 'Merit', devotion: 'Devotion', rite: 'Rite',
  };

  let tbody = '';
  let totalCost = 0;
  let hasCosts = false;

  for (const r of rows) {
    const catLabel  = CAT_LABELS[r.category] || (r.category || '');
    const rawItem   = r.item || '';
    const parts     = rawItem.split('|');
    const traitName = parts[0] || rawItem;

    // Dot transition: merits encode current dots in parts[2]; others show +N dots
    let transition = '';
    if (r.dotsBuying) {
      if (r.category === 'merit' && parts[1] === 'grad' && parts[2] !== undefined) {
        const cur = parseInt(parts[2], 10) || 0;
        transition = ` (${cur} → ${cur + r.dotsBuying})`;
      } else {
        transition = ` (+${r.dotsBuying} dot${r.dotsBuying === 1 ? '' : 's'})`;
      }
    }

    const costCell = (typeof r.xpCost === 'number' && r.xpCost > 0)
      ? `${r.xpCost} XP`
      : '';
    if (typeof r.xpCost === 'number') { totalCost += r.xpCost; hasCosts = true; }

    tbody += `<tr>`;
    tbody += `<td class="proc-xp-cat">${esc(catLabel)}</td>`;
    tbody += `<td class="proc-xp-trait">${esc(traitName)}${esc(transition)}</td>`;
    tbody += `<td class="proc-xp-cost">${esc(costCell)}</td>`;
    tbody += `</tr>`;
  }

  let tfoot = '';
  if (hasCosts && typeof budget === 'number') {
    const remaining = budget - totalCost;
    const overClass = remaining < 0 ? ' proc-xp-remaining--over' : '';
    tfoot  = `<tfoot class="proc-xp-totals">`;
    tfoot += `<tr><td colspan="2">Total</td><td class="proc-xp-cost">${totalCost} XP</td></tr>`;
    tfoot += `<tr><td colspan="2">Budget</td><td class="proc-xp-cost">${budget} XP available</td></tr>`;
    tfoot += `<tr><td colspan="2">Remaining</td><td class="proc-xp-cost${overClass}">${remaining} XP</td></tr>`;
    tfoot += `</tfoot>`;
  }

  return `<div class="proc-proj-field proc-xp-breakdown">` +
    `<span class="proc-feed-lbl">XP Spend</span>` +
    `<table class="proc-xp-table"><tbody>${tbody}</tbody>${tfoot}</table>` +
    `</div>`;
}

// ── Action progress ribbon ────────────────────────────────────────────────────
// Pending → Valid → Complete, derived from review state at render time.
// Valid:    any non-pending pool_status (mechanical decisions made).
// Complete: terminal pool_status AND narrative written (player_facing_note or story_context).
function _deriveActionRibbonState(rev) {
  const ps = rev?.pool_status || 'pending';
  if (ps === 'pending') return 'pending';
  if (rev?.outcome_confirmed) return 'complete';
  // #860: merit actions complete on an outcome verdict (Approved/Partial/Failed);
  // travel actions complete on a discretion choice (obvious/neutral/subtle).
  if (rev?.merit_outcome) return 'complete';
  if (ps === 'obvious' || ps === 'neutral' || ps === 'subtle') return 'complete';
  return 'valid';
}

function _renderActionRibbon(rev) {
  const state = _deriveActionRibbonState(rev);
  const steps = [['pending', 'Pending'], ['valid', 'Valid'], ['complete', 'Complete']];
  const activeIdx = steps.findIndex(([s]) => s === state);
  let h = '<div class="proc-action-ribbon">';
  steps.forEach(([val, label], i) => {
    let cls = 'proc-ar-step';
    if (i < activeIdx)        cls += ' ar-past';
    else if (i === activeIdx) cls += ` ar-active ar-${val}`;
    else                      cls += ' ar-future';
    h += `<span class="${cls}">${label}</span>`;
    if (i < steps.length - 1) h += '<span class="proc-ar-arrow">›</span>';
  });
  h += '</div>';
  return h;
}

function _renderActionTypeRow(entry, rev, char, opts = {}) {
  const { suppressTerrPills = false } = opts;
  const key        = entry.key;
  const actionType = entry.actionType;
  const isMerit    = entry.source === 'merit';
  let h = '';

  h += `<div class="proc-recat-row${suppressTerrPills ? ' proc-recat-row-top' : ''}">`;
  h += `<span class="proc-feed-lbl">Action Type</span>`;
  if (entry.originalActionType === 'rote') {
    h += `<span class="proc-merit-cat-chip proc-action-type-rote">Rote Feed</span>`;
  } else {
    h += `<select class="proc-recat-select" data-proc-key="${esc(key)}">`;
    h += `<option value=""${!actionType ? ' selected' : ''}>— Select action type —</option>`;
    for (const [val, lbl] of Object.entries(ACTION_TYPE_LABELS)) {
      h += `<option value="${esc(val)}"${actionType === val ? ' selected' : ''}>${esc(lbl)}</option>`;
    }
    h += `</select>`;
  }

  // Project only: show original action type badge when overridden
  if (!isMerit) {
    const isOverridden = entry.originalActionType && entry.originalActionType !== actionType;
    if (isOverridden) {
      h += `<span class="proc-recat-original">Player: ${esc(ACTION_TYPE_LABELS[entry.originalActionType] || entry.originalActionType)}</span>`;
    }
  }

  if (actionType === 'hide_protect' && isMerit) {
    const _protName  = rev?.protected_merit_name      ?? '';
    const _protQual  = rev?.protected_merit_qualifier ?? '';
    const _allMerits = (char?.merits || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    h += `<span class="proc-feed-lbl">Protects</span>`;
    h += `<select class="proc-recat-select proc-prot-merit-sel" data-proc-key="${esc(key)}">`;
    h += `<option value="">\u2014 Select merit \u2014</option>`;
    for (const m of _allMerits) {
      const mQual   = m.qualifier || m.area || '';
      const mRating = (m.rating || m.dots || 0) + (m.bonus || 0);
      const mLabel  = mQual ? `${esc(m.name || '')} (${esc(mQual)})` : esc(m.name || '');
      const mDots   = '\u25CF'.repeat(mRating);
      const isSelected = (m.name || '') === _protName && mQual === _protQual;
      h += `<option value="${esc((m.name || '') + '|' + mQual)}"${isSelected ? ' selected' : ''}>${mLabel} ${mDots}</option>`;
    }
    h += `</select>`;
  } else if (_isAmbienceAction(actionType)) {
    if (!isMerit) {
      // Direction badge (increase ↑ / decrease ↓)
      if (entry.ambienceDir) {
        const _dirLabel = entry.ambienceDir === 'increase' ? '▲ Increase' : '▼ Decrease';
        h += `<span class="proc-ambience-dir-badge proc-ambience-dir-${esc(entry.ambienceDir)}">${_dirLabel}</span>`;
      }
    }
    // merit ambience: territory handled via isAlliesAction pills below
  } else if (!isMerit && !suppressTerrPills) {
    if (entry.originalActionType === 'rote') {
      // Rote feed: single row writing to feeding_rote (what the matrix reads)
      const _roteSub = submissions.find(s => s._id === entry.subId);
      const _roteOvrArr = _roteSub?.st_review?.territory_overrides?.feeding_rote;
      let _rotePillSet;
      if (Array.isArray(_roteOvrArr)) {
        _rotePillSet = new Set(_roteOvrArr);
      } else {
        _rotePillSet = new Set();
        try {
          const _roteGrid = JSON.parse(_roteSub?.responses?.feeding_territories_rote || '{}');
          for (const [slug, status] of Object.entries(_roteGrid)) {
            if (!status || status === 'none' || status === 'Not feeding here') continue;
            let tid;
            if (/^[a-f0-9]{24}$/i.test(slug)) {
              const terrDoc = (cachedTerritories || []).find(t => String(t._id) === slug);
              tid = terrDoc?.slug || null;
            } else {
              tid = TERRITORY_SLUG_MAP[slug];
            }
            if (tid) _rotePillSet.add(tid);
          }
        } catch { /* ignore */ }
        if (_rotePillSet.size === 0 && entry.projTerritory) {
          const _rptR = entry.projTerritory;
          const _rptRTid = /^[a-f0-9]{24}$/i.test(_rptR)
            ? ((cachedTerritories || []).find(t => String(t._id) === _rptR)?.slug || null)
            : (TERRITORY_SLUG_MAP[_rptR] ?? _rptR);
          if (_rptRTid) _rotePillSet.add(_rptRTid);
        }
      }
      h += _renderInlineTerrPills(entry.subId, 'feeding_rote', '', _rotePillSet);
    } else {
      const _projCtx = String(entry.actionIdx);
      const _projSub = submissions.find(s => s._id === entry.subId);
      const _projTid = _projSub?.st_review?.territory_overrides?.[_projCtx] || '';
      h += _renderInlineTerrPills(entry.subId, _projCtx, _projTid);
    }
  }

  // Merit: merit-link dropdown (allies/status/retainer/contacts/staff) + territory pills
  if (isMerit) {
    if (['allies', 'status', 'retainer', 'contacts', 'staff'].includes(entry.meritCategory)) {
      const _linkedQual   = rev?.linked_merit_qualifier ?? entry.meritQualifier ?? '';
      const _meritNameKey = (entry.meritLabel || '').toLowerCase();
      const _charMerits   = (char?.merits || [])
        .filter(m => {
          const mName = (m.name || '').toLowerCase();
          return mName === _meritNameKey || _meritNameKey.includes(mName) || mName.includes(_meritNameKey);
        })
        .sort((a, b) => (a.qualifier || a.area || '').localeCompare(b.qualifier || b.area || ''));
      const _isAmb = _isAmbienceAction(actionType);
      const _hasHWV = _isAmb && (char?.merits || []).some(m => /honey with vinegar/i.test(m.name || ''));
      h += `<span class="proc-feed-lbl">Merit</span>`;
      h += `<select class="proc-recat-select proc-merit-link-sel" data-proc-key="${esc(key)}">`;
      h += `<option value="">\u2014 Select \u2014</option>`;
      for (const m of _charMerits) {
        const mRating = (m.rating || m.dots || 0) + (m.bonus || 0);
        const mQual   = m.qualifier || m.area || '';
        const mLabel  = mQual ? `${esc(m.name || '')} (${esc(mQual)})` : esc(m.name || '');
        const mDots   = '\u25CF'.repeat(mRating);
        const sel     = mQual && mQual.toLowerCase() === _linkedQual.toLowerCase() ? ' selected' : '';
        h += `<option value="${esc(mQual)}"${sel}>${mLabel} ${mDots}</option>`;
      }
      h += `</select>`;
      if (_hasHWV) h += `<span class="proc-hwv-badge">Honey with Vinegar</span>`;
    }
    // Territory pills — allies/status/retainer actions (suppressed when rendered in right column instead)
    if (entry.isAlliesAction && !suppressTerrPills) {
      const _mCtx = `allies_${entry.actionIdx}`;
      const _mSub = submissions.find(s => s._id === entry.subId);
      const _mTid = _mSub?.st_review?.territory_overrides?.[_mCtx] || '';
      h += _renderInlineTerrPills(entry.subId, _mCtx, _mTid);
    }
  }

  h += _renderActionRibbon(rev);
  h += `</div>`;

  // Attack merit dropdown (second row, shown for both project and merit)
  if (actionType === 'attack') {
    const _atkChar  = characters.find(c => c.name === (rev.attack_target_char || '')) || null;
    const _atkMerit = rev.attack_target_merit || '';
    h += `<div class="proc-recat-row proc-recat-row-tight">`;
    h += `<span class="proc-feed-lbl">Merit</span>`;
    h += `<select class="proc-recat-select proc-attack-merit-sel" data-proc-key="${esc(key)}">`;
    h += `<option value="">\u2014 Select merit \u2014</option>`;
    if (_atkChar) {
      for (const m of [...(_atkChar.merits || [])].sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
        const mRating = (m.rating || m.dots || 0) + (m.bonus || 0);
        const mQual   = m.qualifier ? ` (${m.qualifier})` : '';
        h += `<option value="${esc(m.name || '')}"${m.name === _atkMerit ? ' selected' : ''}>${esc(m.name || '')}${esc(mQual)} \u25CF${mRating}</option>`;
      }
    }
    h += `</select>`;
    h += `</div>`;
  }

  return h;
}

/** Build sibling-action rows for the Snapshot panel.
 *  Reads from _procQueueMap (full unfiltered queue) — same source as xref callout. */
function _renderSnapshotSiblings(entry) {
  if (!_procQueueMap) return '';
  const siblings = [..._procQueueMap.values()].filter(
    e => e.charName === entry.charName && e.key !== entry.key
  );
  if (!siblings.length) {
    return '<div class="proc-snap-empty">No other actions this cycle.</div>';
  }
  return siblings.map(e => {
    const rev = getEntryReview(e) || {};
    const status = _deriveActionRibbonState(rev);
    const statusLabel = status === 'pending' ? 'Pending' : status === 'valid' ? 'Valid' : 'Complete';
    const phaseLabel = PHASE_LABELS[e.phase] || e.phase;
    return `<div class="proc-snap-row" data-snap-jump="${esc(e.key)}">` +
      `<span class="proc-snap-phase">${esc(phaseLabel)}</span>` +
      `<span class="proc-snap-action">${esc(e.label || e.actionType)}</span>` +
      `<span class="proc-snap-status proc-snap-status--${status}">${statusLabel}</span>` +
      `</div>`;
  }).join('');
}

/** Discipline ratings section for the Snapshot panel.
 *  Looks up character via submission → _findCharForSub; silent fail if not found. */
function _renderSnapshotDisciplines(entry) {
  const sub  = submissions.find(s => s._id === entry.subId);
  const char = _findCharForSub(sub);
  if (!char) return '';
  const discs = char.disciplines;
  if (!discs) return '';

  let discList;
  if (Array.isArray(discs)) {
    discList = discs.map(d => ({ name: d.name, rating: (d.dots || 0) + (d.bonus || 0) }));
  } else {
    discList = Object.entries(discs).map(([name, v]) => ({ name, rating: (v?.dots || 0) + (v?.bonus || 0) }));
  }
  const _knownSet = new Set(KNOWN_DISCIPLINES);
  discList = discList.filter(d => d.rating >= 1 && _knownSet.has(d.name));
  if (!discList.length) return '';
  discList.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));

  let h = '<div class="proc-snap-subheading">Disciplines</div>';
  for (const d of discList) {
    h += `<div class="proc-snap-disc-row">` +
      `<span class="proc-snap-disc-name">${esc(d.name)}</span>` +
      `<span class="proc-snap-disc-dots">${'●'.repeat(d.rating)}</span>` +
      `</div>`;
  }
  return h;
}

/** Snapshot panel — territory presence: other characters active in the same territory. */
function _renderSnapshotTerrPresence(entry, ctx) {
  if (!ctx.sameTerrEntries.length) return '';
  const myTerrs = _entryTerritories(entry);
  const byTerr = new Map();
  for (const terr of myTerrs) byTerr.set(terr, []);
  for (const e of ctx.sameTerrEntries) {
    for (const terr of _entryTerritories(e)) {
      if (byTerr.has(terr)) byTerr.get(terr).push(e);
    }
  }
  const populated = [...byTerr.entries()].filter(([, arr]) => arr.length > 0);
  if (!populated.length) return '';
  let h = '<div class="proc-snap-terr-section">';
  for (const [terrName, entries] of populated) {
    h += `<div class="proc-snap-terr-name">${esc(terrName)}</div>`;
    for (const e of entries) {
      const hp = e.actionType === 'hide_protect';
      h += `<div class="proc-snap-terr-entry${hp ? ' proc-snap-terr-hp' : ''}">` +
        `<span class="proc-snap-terr-char">${esc(e.charName)}</span>` +
        `<span class="proc-snap-terr-action">${esc(e.label)}</span>` +
        `</div>`;
    }
  }
  h += '</div>';
  return h;
}

/** Snapshot panel — block actions active in the same territory. */
function _renderSnapshotBlockers(entry, ctx) {
  const blockEntries = ctx.sameTerrEntries.filter(e => e.actionType === 'block');
  if (!blockEntries.length) return '';
  let h = '<div class="proc-snap-block-section">';
  h += '<div class="proc-snap-subheading">Block in Territory</div>';
  for (const e of blockEntries) {
    const level = e.meritDots ? `${'●'.repeat(e.meritDots)} or lower` : '? or lower';
    h += `<div class="proc-snap-block-entry">` +
      `<span class="proc-snap-block-char">${esc(e.charName)}</span>` +
      `<span class="proc-snap-block-level">${esc(level)}</span>` +
      `</div>`;
  }
  h += '</div>';
  return h;
}

/** Snapshot panel — hide/protect actions in the same territory with discipline extracted from pool_validated. */
function _renderSnapshotHideProtect(entry, ctx) {
  const hpEntries = ctx.sameTerrEntries.filter(e => e.actionType === 'hide_protect');
  if (!hpEntries.length) return '';
  let h = '<div class="proc-snap-hp-section">';
  h += '<div class="proc-snap-subheading">Hide / Protect</div>';
  for (const e of hpEntries) {
    const rev = getEntryReview(e);
    const poolValidated = rev?.pool_validated || '';
    const disc = rev?.hide_protect_disc || KNOWN_DISCIPLINES.find(d => poolValidated.includes(d)) || null;
    h += `<div class="proc-snap-hp-entry">` +
      `<span class="proc-snap-hp-char">${esc(e.charName)}</span>` +
      `<span class="proc-snap-hp-disc${disc ? '' : ' proc-snap-hp-unknown'}">${esc(disc || 'unconfirmed')}</span>` +
      `</div>`;
  }
  h += '</div>';
  return h;
}

/** Snapshot panel — investigate actions in the same territory: secrecy level + lead status. */
function _renderSnapshotInvestigate(entry, ctx) {
  const invEntries = ctx.sameTerrEntries.filter(e => e.actionType === 'investigate');
  if (!invEntries.length) return '';
  let h = '<div class="proc-snap-inv-section">';
  h += '<div class="proc-snap-subheading">Investigating</div>';
  for (const e of invEntries) {
    const rev = getEntryReview(e);
    const secrecy = rev?.inv_secrecy || null;
    const hasLead = rev?.inv_has_lead;
    let detail = secrecy || 'pending';
    if (secrecy && hasLead === true)  detail += ' ✓';
    if (secrecy && hasLead === false) detail += ' ✗';
    h += `<div class="proc-snap-inv-entry">` +
      `<span class="proc-snap-inv-char">${esc(e.charName)}</span>` +
      `<span class="proc-snap-inv-detail${secrecy ? '' : ' proc-snap-inv-pending'}">${esc(detail)}</span>` +
      `</div>`;
  }
  h += '</div>';
  return h;
}

/** Snapshot panel — sorcery cast by same-territory characters this cycle. */
function _renderSnapshotSorcery(entry, ctx) {
  if (!ctx.sorcEntries.length) return '';
  let h = '<div class="proc-snap-sorc-section">';
  h += '<div class="proc-snap-subheading">Sorcery This Cycle</div>';
  for (const e of ctx.sorcEntries) {
    const rev = getEntryReview(e);
    const status = rev?.pool_status || 'pending';
    const done = status === 'resolved' || status === 'no_effect';
    h += `<div class="proc-snap-sorc-entry${done ? ' proc-snap-sorc-done' : ''}">` +
      `<span class="proc-snap-sorc-char">${esc(e.charName)}</span>` +
      `<span class="proc-snap-sorc-rite">${esc(e.riteName || e.label)}</span>` +
      `</div>`;
  }
  h += '</div>';
  return h;
}

/** Snapshot panel — other characters feeding in the same territory. */
function _renderSnapshotFeeding(entry, ctx) {
  const feedEntries = ctx.sameTerrEntries.filter(e => e.source === 'feeding');
  if (!feedEntries.length) return '';
  let h = '<div class="proc-snap-feed-section">';
  h += '<div class="proc-snap-subheading">Also Feeding</div>';
  for (const e of feedEntries) {
    const rev = getEntryReview(e);
    const status = rev?.pool_status || 'pending';
    const done = status !== 'pending';
    const disc = e.feedDisc || e.feedMethodLabel || 'method unknown';
    h += `<div class="proc-snap-feed-entry${done ? ' proc-snap-feed-done' : ''}">` +
      `<span class="proc-snap-feed-char">${esc(e.charName)}</span>` +
      `<span class="proc-snap-feed-disc">${esc(disc)}</span>` +
      `</div>`;
  }
  h += '</div>';
  return h;
}

/** Snapshot panel — rites from other characters that are targeting this character. */
function _renderSnapshotRitesTargeting(entry) {
  const rites = _sorcByTarget.get((entry.charName || '').toLowerCase()) || [];
  if (!rites.length) return '';
  let h = '<div class="proc-snap-sorc-section">';
  h += '<div class="proc-snap-subheading">Rites Targeting This Character</div>';
  for (const r of rites) {
    h += `<div class="proc-snap-sorc-entry">`;
    h += `<span class="proc-snap-sorc-char">${esc(r.entry.charName)}</span>`;
    h += `<span class="proc-snap-sorc-rite">${esc(r.riteName || '—')}</span>`;
    h += `<span class="proc-snap-rite-result">${esc(r.resultNote)}</span>`;
    h += `</div>`;
  }
  h += '</div>';
  return h;
}

/** Snapshot panel — feeding-specific intelligence for feeding and rote-feeding cards.
 *  Handles both source='feeding' (regular + rote flag) and source='project' actionType='feed' (rote project slot). */
function _renderSnapshotFeedingPanel(entry, feedChar) {
  const isRoteFeed = entry.source === 'project' && entry.actionType === 'feed';
  const terrList = (cachedTerritories && cachedTerritories.length) ? cachedTerritories : TERRITORY_DATA;

  let h = '<div class="proc-snapshot-panel">';
  h += '<div class="proc-snap-heading">Feeding Intelligence</div>';

  // For rote entries, borrow territory/method data from the sibling feeding entry (same subId)
  const siblingFeed = isRoteFeed && _procQueueMap
    ? [..._procQueueMap.values()].find(r => r.source === 'feeding' && r.subId === entry.subId)
    : null;
  const feedEntry = siblingFeed || entry; // resolved feed entry for territory/method lookups

  // ── 1. Method & disciplines ──
  if (isRoteFeed) {
    const method = feedEntry.feedMethod ? FEED_METHODS_DATA.find(m => m.id === feedEntry.feedMethod) : null;
    const discs = method?.discs || [];
    h += '<div class="proc-snap-subheading">Method</div>';
    h += `<div class="proc-snap-feed-method">Rote Action`;
    if (method) h += ` <span class="proc-snap-feed-discs">(${esc(method.name)}${discs.length ? ' — ' + esc(discs.join(', ')) : ''})</span>`;
    h += '</div>';
  } else {
    const method = entry.feedMethod ? FEED_METHODS_DATA.find(m => m.id === entry.feedMethod) : null;
    if (method) {
      const discs = method.discs || [];
      h += '<div class="proc-snap-subheading">Method</div>';
      h += `<div class="proc-snap-feed-method">${esc(method.name)}`;
      if (discs.length) h += `<span class="proc-snap-feed-discs"> — ${esc(discs.join(', '))}</span>`;
      h += '</div>';
    }
  }

  // ── Helper: render one territory row + crowding ──
  function _terrRow(terrName, terrRec, statusLabel, statusMod) {
    const oid = terrRec?._id ? String(terrRec._id) : null;
    const confirmedAmb = oid ? currentCycle?.confirmed_ambience?.[oid] : null;
    const ambience = confirmedAmb?.ambience || terrRec?.ambience || '';
    const isRegent = feedChar && terrRec?.regent_id && String(terrRec.regent_id) === String(feedChar._id);
    let row = '<div class="proc-snap-terr-row">';
    row += `<span class="proc-snap-terr-name">${esc(terrName)}</span>`;
    if (statusLabel) row += `<span class="proc-snap-terr-status${statusMod || ''}">${esc(statusLabel)}</span>`;
    if (isRegent) row += `<span class="proc-snap-terr-badge">Regent</span>`;
    if (ambience) row += `<span class="proc-snap-terr-ambience">${esc(ambience)}</span>`;
    row += '</div>';
    return row;
  }

  // ── 2. Territories ──
  if (isRoteFeed) {
    // Use sibling feeding entry's territories (same logic as regular feeding)
    const activeTerrs = Object.entries(feedEntry.feedTerrs || {}).filter(([, v]) => v && v !== 'none');
    if (activeTerrs.length) {
      h += '<div class="proc-snap-subheading">Territories</div>';
      const STATUS_LABELS = { feeding_rights: 'Rights', resident: 'Resident', poaching: 'Poaching', poacher: 'Poaching' };
      for (const [slug, status] of activeTerrs) {
        const resolvedSlug = resolveTerrId(slug) || slug;
        const terrRec = terrList.find(t => t.slug === resolvedSlug || t.name?.toLowerCase().replace(/\s+/g, '_') === resolvedSlug);
        const terrName = terrRec?.name || resolvedSlug.replace(/_/g, ' ');
        const statusLabel = STATUS_LABELS[status] || status;
        const statusMod = (status === 'poaching' || status === 'poacher') ? ' proc-snap-terr-poach' : ' proc-snap-terr-claim';
        h += _terrRow(terrName, terrRec, statusLabel, statusMod);
        const others = _procQueueMap
          ? [..._procQueueMap.values()].filter(r =>
              r.charName !== entry.charName &&
              r.source === 'feeding' &&
              r.feedTerrs?.[slug] &&
              r.feedTerrs[slug] !== 'none'
            )
          : [];
        if (others.length) {
          h += `<div class="proc-snap-feed-peers">&#9656; Also feeding: ${others.map(r => esc(r.charName)).join(', ')}</div>`;
        }
      }
    }
  } else {
    const activeTerrs = Object.entries(entry.feedTerrs || {}).filter(([, v]) => v && v !== 'none');
    if (activeTerrs.length) {
      h += '<div class="proc-snap-subheading">Territories</div>';
      const STATUS_LABELS = { feeding_rights: 'Rights', resident: 'Resident', poaching: 'Poaching', poacher: 'Poaching' };
      for (const [slug, status] of activeTerrs) {
        const resolvedSlug = resolveTerrId(slug) || slug;
        const terrRec = terrList.find(t => t.slug === resolvedSlug || t.name?.toLowerCase().replace(/\s+/g, '_') === resolvedSlug);
        const terrName = terrRec?.name || resolvedSlug.replace(/_/g, ' ');
        const statusLabel = STATUS_LABELS[status] || status;
        const statusMod = (status === 'poaching' || status === 'poacher') ? ' proc-snap-terr-poach' : ' proc-snap-terr-claim';
        h += _terrRow(terrName, terrRec, statusLabel, statusMod);

        const others = _procQueueMap
          ? [..._procQueueMap.values()].filter(r =>
              r.charName !== entry.charName &&
              r.source === 'feeding' &&
              r.feedTerrs?.[slug] &&
              r.feedTerrs[slug] !== 'none'
            )
          : [];
        if (others.length) {
          h += `<div class="proc-snap-feed-peers">&#9656; Also feeding: ${others.map(r => esc(r.charName)).join(', ')}</div>`;
        }
      }
    }
  }

  // ── 3. Ritual effects targeting this character ──
  const _riteCharKey = (feedEntry.charName || entry.charName || '').toLowerCase();
  const rites = _sorcByTarget.get(_riteCharKey) || [];
  h += '<div class="proc-snap-subheading">Rites Targeting This Character</div>';
  if (rites.length) {
    for (const r of rites) {
      h += `<div class="proc-snap-sorc-entry">`;
      h += `<span class="proc-snap-sorc-rite">${esc(r.riteName || '—')}</span>`;
      h += `<span class="proc-snap-rite-result">${esc(r.resultNote)}</span>`;
      h += '</div>';
    }
  } else {
    h += '<div class="proc-snap-feed-method proc-snap-none">None recorded</div>';
  }

  h += '</div>';
  return h;
}

/** Snapshot panel — ambience-specific intelligence: others changing the same territory's ambience. */
function _renderSnapshotAmbiencePanel(entry) {
  const territory = entry.projTerritory || '';
  let h = '<div class="proc-snapshot-panel">';
  h += '<div class="proc-snap-heading">Ambience Intelligence</div>';

  if (!territory) {
    h += '<div class="proc-snap-feed-method proc-snap-none">No territory recorded</div>';
    h += '</div>';
    return h;
  }

  const others = _procQueueMap
    ? [..._procQueueMap.values()].filter(r =>
        r.charName !== entry.charName &&
        r.actionType === 'ambience_change' &&
        r.projTerritory === territory
      )
    : [];

  if (others.length) {
    for (const r of others) {
      const dirLabel = r.ambienceDir === 'increase' ? '▲ Increase' : r.ambienceDir === 'decrease' ? '▼ Decrease' : '— Unknown';
      const dirClass = r.ambienceDir === 'increase' ? 'proc-snap-amb-up' : r.ambienceDir === 'decrease' ? 'proc-snap-amb-down' : '';
      h += `<div class="proc-snap-terr-row">`;
      h += `<span class="proc-snap-terr-name">${esc(r.charName)}</span>`;
      h += `<span class="proc-snap-amb-dir ${dirClass}">${dirLabel}</span>`;
      h += '</div>';
    }
  } else {
    h += '<div class="proc-snap-feed-method proc-snap-none">No other ambience actions on this territory</div>';
  }

  h += '</div>';
  return h;
}

/**
 * Snapshot — blocked warning for merit entries.
 * Fires when a block in the same territory covers this merit's dot level.
 * Rendered before the standard sections so it's immediately visible.
 */
function _renderSnapshotMeritBlocked(entry, ctx) {
  if (entry.source !== 'merit') return '';
  const myDots = entry.meritDots ?? null;
  const blockers = ctx.sameTerrEntries.filter(e => {
    if (e.actionType !== 'block') return false;
    const bDots = e.meritDots ?? null;
    // Block covers this action if dot levels are unknown OR block dots >= my dots
    return bDots === null || myDots === null || bDots >= myDots;
  });
  if (!blockers.length) return '';

  let h = '<div class="proc-snap-merit-blocked">';
  h += '<div class="proc-snap-merit-blocked-hd">This action is Blocked</div>';
  for (const b of blockers) {
    const level = b.meritDots != null ? `Block ●${b.meritDots}` : 'Block';
    const terr  = b.projTerritory || b.meritTerritory || '';
    h += `<div class="proc-snap-merit-blocked-row">`;
    h += `<span class="proc-snap-merit-blocked-char">${esc(b.charName)}</span>`;
    h += `<span class="proc-snap-merit-blocked-level">${esc(level)}</span>`;
    if (terr) h += `<span class="proc-snap-merit-blocked-terr">${esc(terr)}</span>`;
    h += `</div>`;
  }
  h += '</div>';
  return h;
}

/**
 * Snapshot — contacts panel: sphere header + all merit actions this cycle by other characters.
 * Contacts gather information about what merits are doing — so the full merit
 * activity picture across the cycle is the relevant intelligence.
 */
function _renderSnapshotContactsPanel(entry) {
  const sphere = entry.meritSphere || '';
  const desc   = entry.description || '';

  let h = '';

  // ── Sphere chip ──
  if (sphere || desc) {
    h += '<div class="proc-snap-contacts-sphere">';
    if (sphere) {
      h += `<div class="proc-contacts-spheres"><span class="proc-contacts-sphere-chip">${esc(sphere)}</span></div>`;
    }
    if (desc) {
      h += `<div class="proc-snap-contacts-desc">${esc(desc)}</div>`;
    }
    h += '</div>';
  }

  // ── Merit actions this cycle — filtered to this sphere ──
  const allEntries   = _procQueueMap ? [..._procQueueMap.values()] : [];
  const sphereLower  = sphere.toLowerCase();
  const meritActions = allEntries.filter(e => {
    if (e.source !== 'merit') return false;
    if (e.charName === entry.charName) return false;
    if (e.actionType === 'contacts') return false;
    if (!sphere) return true;
    return (e.meritQualifier || '').toLowerCase() === sphereLower;
  });

  if (!meritActions.length) {
    const msg = sphere
      ? `No ${sphere} merit actions by other characters this cycle.`
      : 'No merit actions by other characters this cycle.';
    h += `<div class="proc-snap-contacts-empty">${esc(msg)}</div>`;
    return h;
  }

  h += '<div class="proc-snap-contacts-list">';
  for (const e of meritActions) {
    const terr = e.projTerritory || e.meritTerritory || '';
    h += '<div class="proc-snap-patrol-row">';
    h += `<span class="proc-snap-patrol-char">${esc(e.charName)}</span>`;
    h += `<span class="proc-snap-patrol-action">${esc(e.label || e.actionType)}</span>`;
    if (terr) h += `<span class="proc-snap-ti-terr">${esc(terr)}</span>`;
    h += '</div>';
  }
  h += '</div>';
  return h;
}

/** Snapshot panel — patrol/scout: every action in the territory and whether Obfuscate was used. */
function _renderSnapshotPatrolPanel(entry, ctx) {
  const entries = ctx.sameTerrEntries;
  if (!entries.length) {
    return '<div class="proc-snap-patrol-empty">No other actions in this territory this cycle.</div>';
  }

  let h = '<div class="proc-snap-patrol-list">';
  for (const e of entries) {
    const eRev   = getEntryReview(e);
    const poolStr = [eRev?.pool_validated || '', e.feedDisc || ''].join(' ');
    const usesObf = poolStr.includes('Obfuscate');

    h += '<div class="proc-snap-patrol-row">';
    h += `<span class="proc-snap-patrol-char">${esc(e.charName)}</span>`;
    h += `<span class="proc-snap-patrol-action">${esc(e.label || e.actionType)}</span>`;
    if (usesObf) h += `<span class="proc-snap-patrol-obf">Obfuscate</span>`;
    h += '</div>';
  }
  h += '</div>';
  return h;
}

/**
 * Snapshot — target intelligence for investigate/attack actions.
 * Shows what the target is doing this cycle, their movement/travel, and any
 * defensive actions (block level, hide/protect discipline + successes).
 */
function _renderSnapshotTargetIntel(entry) {
  const actionType = entry.actionType;
  if (actionType !== 'investigate' && actionType !== 'attack') return '';

  const rev = getEntryReview(entry) || {};
  // #594: mirror #586's override-aware seed — show the player's submitted target
  // until the ST touches the field (the ('field' in rev) presence check lets an ST
  // clear win, unlike `||`/`??`). entry.targetCharKeys are sortName keys, the exact
  // shape the match below expects.
  const field = actionType === 'investigate' ? 'investigate_target_char' : 'attack_target_char';
  const targetName = (field in rev) ? (rev[field] || '') : (entry.targetCharKeys?.[0] || '');

  if (!targetName) {
    return '<div class="proc-snap-ti-unset">Target not set — select a target above.</div>';
  }

  // investigate_target_char / attack_target_char are stored as sortName() = lowercase.
  // entry.charName is proper-cased. Normalise both sides for the match.
  const targetLower  = targetName.toLowerCase();
  const targetChar   = characters.find(c => (c.moniker || c.name || '').toLowerCase() === targetLower);
  const displayTarget = targetChar ? (targetChar.moniker || targetChar.name) : targetName;

  const allEntries    = _procQueueMap ? [..._procQueueMap.values()] : [];
  const targetEntries = allEntries.filter(e => (e.charName || '').toLowerCase() === targetLower);

  let h = '<div class="proc-snap-target-intel">';
  h += `<div class="proc-snap-subheading">Target: ${esc(displayTarget)}</div>`;

  if (!targetEntries.length) {
    h += '<div class="proc-snap-ti-row proc-snap-ti-empty">No submissions this cycle for this character.</div>';
    h += '</div>';
    return h;
  }

  // ── Movement / travel — show discretion label only ──
  const travelEntry       = targetEntries.find(e => e.source === 'travel');
  const travelDiscretion  = travelEntry ? (getEntryReview(travelEntry)?.pool_status || 'pending') : null;
  const DISC_LABELS = { obvious: 'Obvious', neutral: 'Neutral', subtle: 'Subtle', pending: 'Pending' };

  if (travelDiscretion) {
    const discLabel = DISC_LABELS[travelDiscretion] || travelDiscretion;
    const discClass = travelDiscretion === 'obvious' ? ' proc-snap-ti-disc--obvious'
                    : travelDiscretion === 'subtle'  ? ' proc-snap-ti-disc--subtle'
                    : '';
    h += '<div class="proc-snap-ti-section">';
    h += '<div class="proc-snap-ti-label">Movement</div>';
    h += `<div class="proc-snap-ti-row"><span class="proc-snap-ti-disc${discClass}">${esc(discLabel)}</span></div>`;
    h += '</div>';
  }

  // ── Downtime actions (excluding feeding, travel, and defensive) ──
  const actionEntries = targetEntries.filter(e =>
    e.source !== 'feeding' && e.source !== 'travel' &&
    e.actionType !== 'block' && e.actionType !== 'hide_protect'
  );
  if (actionEntries.length) {
    h += '<div class="proc-snap-ti-section">';
    h += '<div class="proc-snap-ti-label">Downtime Actions</div>';
    for (const e of actionEntries) {
      const eRev   = getEntryReview(e);
      const status = eRev?.pool_status || 'pending';
      const isDone = status === 'resolved' || status === 'no_effect' || status === 'no_roll';
      const terr   = e.projTerritory || e.primaryTerr || '';
      h += `<div class="proc-snap-ti-row${isDone ? ' proc-snap-ti-done' : ''}">`;
      h += `<span class="proc-snap-ti-badge">${esc(e.label || e.actionType)}</span>`;
      if (terr) h += `<span class="proc-snap-ti-terr">${esc(terr)}</span>`;
      h += '</div>';
    }
    h += '</div>';
  }

  // ── Defensive actions ──
  const defEntries = targetEntries.filter(e => e.actionType === 'block' || e.actionType === 'hide_protect');
  if (defEntries.length) {
    h += '<div class="proc-snap-ti-section">';
    h += '<div class="proc-snap-ti-label">Defences</div>';
    for (const e of defEntries) {
      const eRev = getEntryReview(e);
      const terr = e.projTerritory || e.primaryTerr || '';
      h += '<div class="proc-snap-ti-row">';
      if (e.actionType === 'block') {
        const level = e.meritDots != null ? `Block ●${e.meritDots}` : 'Block';
        h += `<span class="proc-snap-ti-badge proc-snap-ti-badge--def">${esc(level)}</span>`;
        if (terr) h += `<span class="proc-snap-ti-terr">${esc(terr)}</span>`;
        h += `<span class="proc-snap-ti-succ">Auto</span>`;
      } else {
        const disc = eRev?.hide_protect_disc
          || KNOWN_DISCIPLINES.find(d => (eRev?.pool_validated || '').includes(d))
          || null;
        const roll       = eRev?.roll || null;
        const successes  = roll?.successes ?? null;
        const typeLabel  = `Hide/Protect${disc ? ' (' + disc + ')' : ''}`;
        h += `<span class="proc-snap-ti-badge proc-snap-ti-badge--def">${esc(typeLabel)}</span>`;
        if (terr) h += `<span class="proc-snap-ti-terr">${esc(terr)}</span>`;
        if (successes !== null) {
          h += `<span class="proc-snap-ti-succ">${successes} succ${successes !== 1 ? 's' : ''}</span>`;
        } else {
          h += `<span class="proc-snap-ti-succ proc-snap-ti-pending">pending</span>`;
        }
      }
      h += '</div>';
    }
    h += '</div>';
  } else {
    h += '<div class="proc-snap-ti-row proc-snap-ti-none">No defensive actions this cycle.</div>';
  }

  h += '</div>'; // proc-snap-target-intel
  return h;
}

/** Snapshot panel — left-column intelligence section for normalised cards. */
function _renderSnapshotPanel(entry) {
  const ctx = _getProcCtx(entry.key);
  let h = '<div class="proc-snapshot-panel">';
  h += '<div class="proc-snap-heading">This Cycle</div>';
  if (entry.actionType === 'patrol_scout') {
    h += _renderSnapshotPatrolPanel(entry, ctx);
  } else if (entry.actionType === 'contacts') {
    h += _renderSnapshotContactsPanel(entry);
  } else {
    h += _renderSnapshotMeritBlocked(entry, ctx);
    h += _renderSnapshotTargetIntel(entry);
    // For investigate/attack the target intel is the entire relevant context; skip own-character sections.
    if (entry.actionType !== 'investigate' && entry.actionType !== 'attack') {
      h += _renderSnapshotSiblings(entry);
      h += _renderSnapshotDisciplines(entry);
      h += _renderSnapshotTerrPresence(entry, ctx);
      h += _renderSnapshotBlockers(entry, ctx);
      h += _renderSnapshotHideProtect(entry, ctx);
      h += _renderSnapshotInvestigate(entry, ctx);
      h += _renderSnapshotSorcery(entry, ctx);
      h += _renderSnapshotFeeding(entry, ctx);
      h += _renderSnapshotRitesTargeting(entry);
    }
  }
  /* Snapshot section complete — proto.14+ are write-back stories */
  h += '</div>';
  return h;
}

/**
 * Normalised project card — Step 0 template.
 * Details card: title + outcome + description + player pool (always) + merits/bonuses + XP spend.
 * Target/lead/cast are removed from Details; target is handled interactively by _renderActionTypeRow.
 */
function renderNormalisedCard(entry, review) {
  const rev               = review || {};
  const poolStatus        = rev.pool_status       || 'pending';
  const poolPlayer        = rev.pool_player       || entry.poolPlayer || '';
  const poolValidated     = rev.pool_validated    || '';
  const thread            = rev.notes_thread      || [];
  const feedback          = rev.story_context     || '';
  const playerFacingNote  = rev.player_facing_note || '';
  const outcomeVal        = rev.outcome            || '';

  const projSub  = submissions.find(s => s._id === entry.subId) || null;
  const projChar = _findCharForSub(projSub);

  const xpTrait  = projSub?.responses?.[`project_${entry.projSlot}_xp_trait`] || '';
  const xpAmount = projSub?.responses?.[`project_${entry.projSlot}_xp`]       || '';

  let h = `<div class="proc-action-detail" data-proc-key="${esc(entry.key)}">`;

  // ── Reminder badges ──
  const _sorcRitesNorm = _sorcByTarget.get((entry.charName || '').toLowerCase()) || [];
  for (const r of _sorcRitesNorm) {
    h += `<div class="proc-reminder-badge">⚑ ${esc(r.riteName || '—')}${r.tradition ? ' (' + esc(r.tradition) + ')' : ''} — ${esc(r.resultNote)}</div>`;
  }

  // ── Action Type row (at top — territory pills appear in the territory rail below) ──
  h += _renderActionTypeRow(entry, rev, projChar, { suppressTerrPills: true });

  // ── Two-column layout ──
  h += `<div class="proc-feed-layout"><div class="proc-feed-left">`;

  // ── Details card ──
  {
    const titleVal      = rev.title           ?? entry.projTitle   ?? '';
    const outcomeVal    = rev.desired_outcome ?? entry.projOutcome ?? '';
    const descVal       = rev.description     ?? entry.description ?? '';
    const _meritsRaw    = rev.merits_bonuses  ?? entry.projMerits  ?? '';
    const meritsVal     = Array.isArray(_meritsRaw) ? (_meritsRaw.length ? _meritsRaw.join(', ') : '') : String(_meritsRaw || '');
    const playerPoolVal = poolPlayer || '';
    const showOutcome   = entry.actionType === 'misc';

    h += `<div class="proc-feed-desc-card">`;
    h += `<div class="proc-feed-desc-card-hd"><span class="proc-mod-panel-title">Details</span><button class="dt-btn proc-feed-desc-edit-btn" data-proc-key="${esc(entry.key)}">Edit</button></div>`;

    // Investigate lead — player-submitted starting point, shown read-only
    // between Title and Description (issue #583). Gated to investigate actions.
    const leadVal = (entry.actionType === 'investigate' && entry.projInvestigateLead)
      ? entry.projInvestigateLead : '';
    // Maintenance target — the asset the player is maintaining, shown read-only
    // (issue #601). Gated to maintenance actions (target_value doubles as the
    // character target for other action types).
    const maintVal = (entry.actionType === 'maintenance' && entry.maintenanceTarget)
      ? entry.maintenanceTarget : '';

    // View mode
    h += `<div class="proc-feed-desc-view">`;
    if (titleVal)                  h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Title</span> ${esc(titleVal)}</div>`;
    if (leadVal)                   h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Lead</span> ${esc(leadVal)}</div>`;
    if (maintVal)                  h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Target</span> ${esc(maintVal)}</div>`;
    if (showOutcome && outcomeVal) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Desired Outcome</span> ${esc(outcomeVal)}</div>`;
    if (descVal)                   h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Description</span> ${esc(descVal)}</div>`;
    if (entry.projXpRows && entry.projXpRows.length) {
      h += _renderXpSpendBreakdown(entry.projXpRows, entry.projXpBudgetSnapshot);
    } else if (entry.projXpBreakdown) {
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">XP Spend</span> ${esc(entry.projXpBreakdown)}</div>`;
    }
    if (!titleVal && !leadVal && !maintVal && !(showOutcome && outcomeVal) && !descVal) h += `<div class="proc-proj-field proc-feed-desc-empty">— No details recorded</div>`;
    h += `</div>`;

    // Edit mode
    h += `<div class="proc-feed-desc-edit" style="display:none">`;
    h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Title</span><input type="text" class="proc-detail-input proc-proj-title-input" data-proc-key="${esc(entry.key)}" value="${esc(titleVal)}"></div>`;
    if (showOutcome) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Desired Outcome</span><input type="text" class="proc-detail-input proc-proj-outcome-input" data-proc-key="${esc(entry.key)}" value="${esc(outcomeVal)}"></div>`;
    h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Description</span><textarea class="proc-detail-ta proc-feed-desc-ta" data-proc-key="${esc(entry.key)}" rows="4">${esc(descVal)}</textarea><span class="dt-autosave-status" data-proc-key="${esc(entry.key)}" data-field="description"></span></div>`;
    h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Player’s Pool</span><input type="text" class="proc-detail-input proc-feed-pool-input" data-proc-key="${esc(entry.key)}" value="${esc(playerPoolVal)}"></div>`;
    h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Merits &amp; Bonuses</span><input type="text" class="proc-detail-input proc-proj-merits-input" data-proc-key="${esc(entry.key)}" value="${esc(meritsVal)}"></div>`;
    h += `<div class="proc-feed-desc-actions"><button class="dt-btn proc-proj-desc-save-btn" data-proc-key="${esc(entry.key)}">Save</button><button class="dt-btn proc-feed-desc-cancel-btn" data-proc-key="${esc(entry.key)}">Cancel</button></div>`;
    h += `</div>`;
    h += `</div>`; // proc-feed-desc-card

    // XP spend approval row (outside card)
    if (xpTrait) {
      const xpLabel = xpAmount ? `XP Spend (${esc(String(xpAmount))} XP)` : 'XP Spend';
      h += `<div class="proc-proj-field proc-proj-xp"><span class="proc-feed-lbl">${xpLabel}</span> ${esc(xpTrait)}</div>`;
    }
  }

  // ── Dice Pool Builder (rendered into _bh — injected at top of right column) ──
  let _bh = '';
  {
    const char = projChar;
    const charDiscs    = _charDiscsArray(char).filter(d => d.dots > 0);
    const allDiscNames = char ? charDiscs.map(d => d.name) : KNOWN_DISCIPLINES;

    let preAttr = '', preSkill = '', preDisc = 'none', showParseRef = false;
    if (poolValidated) {
      const parsed = _parsePoolExpr(poolValidated, ALL_ATTRS, ALL_SKILLS, allDiscNames);
      if (parsed) { preAttr = parsed.attr || ''; preSkill = parsed.skill || ''; preDisc = parsed.disc || 'none'; }
      else { showParseRef = true; }
    } else if (projSub) {
      const resp2 = projSub.responses || {};
      preAttr  = resp2[`project_${entry.projSlot}_pool_attr`]  || '';
      preSkill = resp2[`project_${entry.projSlot}_pool_skill`] || '';
      preDisc  = resp2[`project_${entry.projSlot}_pool_disc`]  || 'none';
    }

    const attrOptHtml = ['<option value="" data-dots="0">-- Attribute --</option>',
      ...ALL_ATTRS.map(a => {
        const dots = char ? (getAttrVal(char, a) || 0) : null;
        return `<option value="${esc(a)}" data-dots="${dots ?? 0}"${a === preAttr ? ' selected' : ''}>${dots !== null ? `${esc(a)} (${dots})` : esc(a)}</option>`;
      })
    ].join('');

    const skillOptHtml = ['<option value="" data-dots="0">-- Skill --</option>',
      ...ALL_SKILLS.map(s => {
        const dots = char ? (skTotal(char, s) || 0) : null;
        return `<option value="${esc(s)}" data-dots="${dots ?? 0}"${s === preSkill ? ' selected' : ''}>${dots !== null ? `${esc(s)} (${dots})` : esc(s)}</option>`;
      })
    ].join('');

    const discOptHtml = ['<option value="none" data-dots="0">None</option>',
      ...allDiscNames.map(name => {
        const d = charDiscs.find(cd => cd.name === name);
        const dots = d ? d.dots : null;
        return `<option value="${esc(name)}" data-dots="${dots ?? 0}"${name === preDisc ? ' selected' : ''}>${dots !== null ? `${esc(name)} (${dots})` : esc(name)}</option>`;
      })
    ].join('');

    const eqMod0        = rev.pool_mod_equipment !== undefined ? rev.pool_mod_equipment : 0;
    const initAttrDots  = preAttr  ? (char ? (getAttrVal(char, preAttr)  || 0) : 0) : 0;
    const initSkillDots = preSkill ? (char ? (skTotal(char, preSkill)     || 0) : 0) : 0;
    const initDiscDots  = (preDisc && preDisc !== 'none') ? (charDiscs.find(d => d.name === preDisc)?.dots || 0) : 0;
    const _pnA          = char && preSkill ? skNineAgain(char, preSkill) : false;
    const initTotalStr  = _poolTotalDisplay(preAttr, initAttrDots, preSkill, initSkillDots, preDisc, initDiscDots, eqMod0, preSkill, _pnA);

    const _committed = poolStatus === 'confirmed';
    const _dis = _committed ? ' disabled' : '';
    const _isRote0  = rev.rote || false;
    const _is8a0    = rev.eight_again || false;
    const _again0   = _is8a0 ? '8' : (_pnA ? '9' : (rev.nine_again ? '9' : '10'));
    const _rollMode0 = rev.roll_mode || null;
    const _bhPool   = poolPlayer || '';
    const _bhMerits = rev.merits_bonuses ?? entry.projMerits ?? '';
    _bh += `<div class="proc-pool-builder${_committed ? ' proc-pool-committed' : ''}" data-proc-key="${esc(entry.key)}">`;
    _bh += `<div class="proc-mod-panel-title">Dice Pool Builder${!char ? ' <span class="dt-hint">(dot values unavailable — character not loaded)</span>' : ''}${_committed ? ' <span class="proc-pool-committed-badge">[Confirmed]</span>' : ''}</div>`;
    if (_bhPool || _bhMerits) {
      _bh += `<div class="proc-pool-player-meta">`;
      if (_bhPool)   _bh += `<div class="proc-pool-meta-row"><span class="proc-feed-lbl">Player's Pool</span> ${esc(_bhPool)}</div>`;
      if (_bhMerits) _bh += `<div class="proc-pool-meta-row"><span class="proc-feed-lbl">Merits &amp; Bonuses</span> ${esc(_bhMerits)}</div>`;
      _bh += `</div>`;
    }
    if (showParseRef) _bh += `<div class="proc-pool-parse-ref">Could not restore selection — previous: "${esc(poolValidated)}"</div>`;
    _bh += '<div class="proc-pool-builder-selects">';
    _bh += `<select class="proc-pool-attr" data-proc-key="${esc(entry.key)}"${_dis}>${attrOptHtml}</select>`;
    _bh += `<span class="proc-pool-plus">+</span>`;
    _bh += `<select class="proc-pool-skill" data-proc-key="${esc(entry.key)}"${_dis}>${skillOptHtml}</select>`;
    _bh += `<span class="proc-pool-plus">+</span>`;
    _bh += `<select class="proc-pool-disc" data-proc-key="${esc(entry.key)}"${_dis}>${discOptHtml}</select>`;
    _bh += '</div>';
    _bh += `<input type="hidden" class="proc-pool-mod-val" data-proc-key="${esc(entry.key)}" value="${eqMod0}">`;
    _bh += `<div class="proc-pool-chips">`;
    _bh += `<div class="dt-feed-builder-meta dt-skill-meta" data-proc-key="${esc(entry.key)}" data-sub-id="${esc(entry.subId)}">`;
    _bh += _buildSpecTogglesHtml(char, preSkill, entry.key, rev.active_feed_specs || [], _dis);
    _bh += '</div>';
    _bh += `<button class="proc-rote-chip${_isRote0 ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}"${_dis ? ' disabled' : ''}>Rote</button>`;
    _bh += `<button class="proc-again-opt${_again0 === '10' ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="10"${_dis ? ' disabled' : ''}>10-Again</button>`;
    _bh += `<button class="proc-again-opt${_again0 === '9' ? ' is-active' : ''}${_pnA && !_is8a0 && _again0 === '9' ? ' is-auto' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="9"${_dis ? ' disabled' : ''}>9-Again</button>`;
    _bh += `<button class="proc-again-opt${_again0 === '8' ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="8"${_dis ? ' disabled' : ''}>8-Again</button>`;
    _bh += _renderRollModeToggle(entry.key, _rollMode0, !!_dis);
    _bh += '</div>';
    _bh += _renderPoolModPanel(entry, char, rev, 'project');
    _bh += `<div class="proc-pool-total" data-proc-key="${esc(entry.key)}" data-nine-again="${_pnA ? '1' : '0'}">${esc(_augmentPoolWithSpecs(initTotalStr, rev.active_feed_specs || [], char) || initTotalStr)}</div>`;
    _bh += '</div>'; // proc-pool-builder
  }

  // ── ST Notes thread ──
  h += '<div class="proc-section proc-notes-panel proc-notes-primary">';
  h += '<div class="proc-mod-panel-title">ST Notes</div>';
  if (thread.length) {
    h += '<div class="proc-notes-thread">';
    for (let noteIdx = 0; noteIdx < thread.length; noteIdx++) {
      const note = thread[noteIdx];
      const time = note.created_at
        ? new Date(note.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '';
      h += '<div class="proc-note-entry">';
      h += `<div class="proc-note-meta">${esc(note.author_name)}${time ? '  ·  ' + esc(time) : ''}<button class="proc-note-delete-btn" data-proc-key="${esc(entry.key)}" data-note-idx="${noteIdx}" title="Delete note">×</button></div>`;
      h += `<div class="proc-note-text">${esc(note.text)}</div>`;
      h += '</div>';
    }
    h += '</div>';
  }
  h += '<div class="proc-note-add">';
  h += `<textarea class="proc-note-textarea" data-proc-key="${esc(entry.key)}" placeholder="Add ST note..." rows="3"></textarea>`;
  h += `<button class="dt-btn proc-add-note-btn" data-proc-key="${esc(entry.key)}">Add Note</button>`;
  h += '</div>';
  h += '</div>'; // proc-notes-panel


  // ── Outcome ──
  h += '<div class="proc-section proc-player-note-section">';
  h += '<div class="proc-mod-panel-title">Outcome</div>';
  h += '<div class="proc-note-add">';
  h += `<textarea class="proc-outcome-input" data-proc-key="${esc(entry.key)}" rows="4" placeholder="What happened — appears in the DT result...">${esc(outcomeVal)}</textarea>`;
  h += `<button class="dt-btn proc-confirm-outcome-btn" data-proc-key="${esc(entry.key)}">Confirm</button>`;
  h += '</div>';
  h += '</div>';

  // ── Player Feedback ──
  h += '<div class="proc-section proc-player-note-section">';
  h += '<div class="proc-mod-panel-title">Player Feedback <span class="proc-label-sub">— sent to player</span></div>';
  h += `<textarea class="proc-player-note-input" data-proc-key="${esc(entry.key)}" rows="2" placeholder="Plain-language note included verbatim in player outcome...">${esc(playerFacingNote)}</textarea>`;
  h += '</div>';

  // ── XRef callout ──
  {
    const xrefLines = [];
    if (entry.projTerritory && entry.actionType !== 'ambience_change') {
      // fix.621: look up the CANONICAL key (matches the canonical index at :4672 / Block B :9961).
      // The raw key never matched once territories load — resolveTerrId canonicalises via
      // TERRITORY_DATA (e.g. 'North Shore' -> 'north_shore').
      const projCanon = resolveTerrId(entry.projTerritory) || entry.projTerritory;
      const projDisplay = (cachedTerritories || []).find(t => t.slug === projCanon)?.name
                       || TERRITORY_DATA.find(t => t.slug === projCanon)?.name
                       || entry.projTerritory;
      const others = (_xrefIndex.get(`terr:${projCanon}`) || []).filter(r => r.charName !== entry.charName);
      if (others.length) xrefLines.push(`Also in ${projDisplay}: ${others.map(r => `${r.charName} (${r.label})`).join(', ')}`);
    }
    if (entry.actionType === 'investigate' && rev.investigate_target_char) {
      const target = rev.investigate_target_char;
      const others = (_xrefIndex.get(`inv-target:${target}`) || []).filter(r => r.charName !== entry.charName);
      if (others.length) xrefLines.push(`Also investigating ${target}: ${others.map(r => r.charName).join(', ')}`);
      if ([..._procQueueMap.values()].some(e => e.actionType === 'hide_protect' && e.charName.toLowerCase() === target)) {
        xrefLines.push(`${target} has an active hide/protect action this cycle`);
      }
    }
    if (xrefLines.length) {
      h += `<div class="proc-xref-callout">`;
      for (const line of xrefLines) h += `<div class="proc-xref-line">${esc(line)}</div>`;
      h += `</div>`;
    }
  }

  // ── Snapshot Panel — suppressed for purely defensive actions ──
  if (entry.actionType !== 'block' && entry.actionType !== 'hide_protect') {
    h += entry.actionType === 'feed'        ? _renderSnapshotFeedingPanel(entry, projChar)
       : entry.actionType === 'ambience_change' ? _renderSnapshotAmbiencePanel(entry)
       : _renderSnapshotPanel(entry);
  }

  h += '</div>'; // proc-feed-left
  h += _renderProjRightPanel(entry, projChar, rev, _bh);
  h += '</div>'; // proc-feed-layout

  h += '</div>'; // proc-action-detail
  return h;
}

/** Render the expanded detail panel for a single action row. */
function renderActionPanel(entry, review) {
  const rev = review || {};
  const poolStatus    = rev.pool_status    || 'pending';

  // ── Travel Review — simple layout, no pool builder ──
  if (entry.source === 'travel') {
    const discretion = poolStatus; // 'obvious' | 'neutral' | 'subtle' | 'pending'
    let h = `<div class="proc-action-detail proc-travel-detail" data-proc-key="${esc(entry.key)}">`;
    h += `<div class="proc-travel-desc">${esc(entry.travelDesc || entry.description)}</div>`;
    h += `<div class="proc-travel-btns">`;
    for (const [val, lbl] of [['obvious', 'Obvious'], ['neutral', 'Neutral'], ['subtle', 'Subtle']]) {
      h += `<button class="proc-travel-btn${discretion === val ? ' active' : ''}" data-proc-key="${esc(entry.key)}" data-discretion="${val}">${lbl}</button>`;
    }
    h += `</div>`;
    h += `</div>`;
    return h;
  }

  // Project entries use the normalised card template (Step 0)
  if (entry.source === 'project') return renderNormalisedCard(entry, review);

  const poolPlayer    = rev.pool_player    || entry.poolPlayer || '';
  const poolValidated = rev.pool_validated || '';
  const thread            = rev.notes_thread        || [];
  const feedback          = rev.story_context        || '';
  const playerFacingNote  = rev.player_facing_note  || '';
  const outcomeVal        = rev.outcome              || '';
  const isSorcery        = entry.source === 'sorcery'
                        || (entry.source === 'st_created' && entry.actionType === 'sorcery');
  // Issue #129: defensive symmetry. Form sphere/status collect (downtime-form.js:717-718,761-762)
  // already normalises 'ambience_change' to legacy here, so this stays
  // legacy-only in practice — but the helper handles all three shapes.
  const isAmbienceMerit  = entry.source === 'merit' && _isAmbienceAction(entry.actionType);
  // Compact merit entries (contacts, auto-mode) have their own ST Notes/Outcome in the right panel
  const _meritMatrixRow  = entry.source === 'merit' ? (MERIT_MATRIX[entry.meritCategory]?.[entry.actionType] || null) : null;
  const _meritFormula    = _meritMatrixRow?.poolFormula || 'none';
  const _meritMode       = _meritMatrixRow?.mode || 'auto';
  const isCompactMerit   = entry.source === 'merit' && _isCompactMerit(entry, _meritMode, _meritFormula);

  // Single character lookup — resolved once for all source types
  const entrySub  = submissions.find(s => s._id === entry.subId) || null;
  const entryChar = _findCharForSub(entrySub);

  // Source-specific aliases (used by downstream renderers and pool builders)
  const feedSub      = entry.source === 'feeding' ? entrySub  : null;
  const feedChar     = entry.source === 'feeding' ? entryChar : null;
  const projSub      = entry.source === 'project' ? entrySub  : null;
  const projChar     = entry.source === 'project' ? entryChar : null;
  const sorcSub      = isSorcery               ? entrySub  : null;
  const sorcChar     = isSorcery               ? entryChar : null;
  const meritEntSub  = entry.source === 'merit' ? entrySub  : null;
  const meritEntChar = entry.source === 'merit' ? entryChar : null;

  let h = `<div class="proc-action-detail" data-proc-key="${esc(entry.key)}">`;

  // ── Rite result badges (rites targeting this character, derived from _sorcByTarget) ──
  const _sorcRites = _sorcByTarget.get((entry.charName || '').toLowerCase()) || [];
  for (const r of _sorcRites) {
    h += `<div class="proc-reminder-badge">⚑ ${esc(r.riteName || '—')}${r.tradition ? ' (' + esc(r.tradition) + ')' : ''} — ${esc(r.resultNote)}</div>`;
  }

  // Ritual result note banner (own sorcery entry — shown as reminder at top of caster's expansion)
  if (isSorcery && rev.ritual_result_note) {
    h += `<div class="proc-reminder-badge proc-ritual-note-banner">✱ ${esc(rev.ritual_result_note)}</div>`;
  }


  // ── Merit action previous roll result (suppressed for auto-mode ambience actions) ──
  if (entry.source === 'merit' && !isAmbienceMerit) {
    const meritSub  = submissions.find(s => s._id === entry.subId);
    const meritRoll = meritSub?.merit_actions_resolved?.[entry.actionIdx]?.roll;
    if (meritRoll) {
      h += `<div class="proc-feed-roll-result">\u2713 Rolled: ${esc(String(meritRoll.successes))} success${meritRoll.successes !== 1 ? 'es' : ''}${meritRoll.exceptional ? ' \u2014 exceptional' : ''}</div>`;
    }
  }

  // ── Sorcery: rite header row (mirrors action type row structure) ──
  if (isSorcery) {
    const _allRites     = (_getRulesDB() || []).filter(r => r.category === 'rite');
    const _selectedRiteRaw = rev.rite_override || entry.riteName || '';
    const _riteInDB        = _selectedRiteRaw && _selectedRiteRaw !== '__custom__'
                             && _allRites.some(r => r.name === _selectedRiteRaw);
    const _selectedRite    = _riteInDB ? _selectedRiteRaw : (_selectedRiteRaw ? '__custom__' : '');
    const _overridden      = rev.rite_override && rev.rite_override !== entry.riteName;
    const _autoCustom      = !_riteInDB && !!_selectedRiteRaw && _selectedRiteRaw !== '__custom__';
    const _shortRite       = entry.riteName && entry.riteName.length <= 60;
    const _tradOrder    = ['Cruac', 'Theban'];
    const _byTrad       = {};
    for (const r of _allRites) { const t = r.parent || 'Unknown'; if (!_byTrad[t]) _byTrad[t] = []; _byTrad[t].push(r); }
    const _tradKeys = [..._tradOrder.filter(t => _byTrad[t]), ...Object.keys(_byTrad).filter(t => !_tradOrder.includes(t))];
    let _riteOpts = `<option value="">— Select Rite —</option><option value="__custom__"${_selectedRite === '__custom__' ? ' selected' : ''}>Custom…</option>`;
    for (const trad of _tradKeys) {
      const grp = (_byTrad[trad] || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0) || a.name.localeCompare(b.name));
      _riteOpts += `<optgroup label="${esc(trad)}">${grp.map(r => `<option value="${esc(r.name)}"${_selectedRite === r.name ? ' selected' : ''}>${esc(r.name)} (Level ${r.rank || _getRiteLevel(r.name) || '?'})</option>`).join('')}</optgroup>`;
    }
    h += `<div class="proc-recat-row proc-recat-row-top">`;
    h += `<span class="proc-feed-lbl">Rite</span>`;
    h += `<select class="proc-rite-select" data-proc-key="${esc(entry.key)}">${_riteOpts}</select>`;
    if (_selectedRite === '__custom__') {
      const _lvl = rev.rite_custom_level || '';
      h += `<label class="proc-rite-custom-lbl">Level <input type="number" class="proc-rite-custom-level-input dt-num-input-sm" min="1" max="5" data-proc-key="${esc(entry.key)}" value="${esc(String(_lvl))}"></label>`;
    }
    if ((_overridden || _autoCustom) && _shortRite) h += `<span class="proc-recat-original">Player: ${esc(entry.riteName)}</span>`;
    h += _renderActionRibbon(rev);
    h += `</div>`;
  }

  // ── Merit: header chip + action type row above layout (matching sorcery/project pattern) ──
  if (entry.source === 'merit') {
    const mCat2     = entry.meritCategory || 'misc';
    const mLabel2   = entry.meritLabel    || '';
    const mDots2    = entry.meritDots;
    const mQual2    = entry.meritQualifier || '';
    const mDotsStr2 = mDots2 != null ? '●'.repeat(mDots2) : '';
    if (!isAmbienceMerit && mLabel2) {
      h += '<div class="proc-merit-header">';
      h += `<span class="proc-merit-cat-chip proc-merit-cat-${esc(mCat2)}">${esc(mLabel2.toUpperCase())}</span>`;
      if (mQual2)    h += `<span class="proc-merit-qualifier">${esc(mQual2)}</span>`;
      if (mDotsStr2) h += `<span class="proc-merit-dots">${esc(mDotsStr2)}</span>`;
      h += '</div>';
    }
    if (entry.meritCategory !== 'contacts') {
      h += _renderActionTypeRow(entry, rev, meritEntChar, { suppressTerrPills: true });
    }
  }

  // ── Two-column layout wrapper (feeding + project + sorcery + merit) ──
  if (entry.source === 'feeding' || entry.source === 'project' || isSorcery || entry.source === 'merit') {
    const _layoutStyle = entry.source === 'merit' ? ' style="margin-top:8px"' : '';
    h += `<div class="proc-feed-layout"${_layoutStyle}><div class="proc-feed-left">`;
  }

  // ── Merit-specific detail display (inside left column) ──
  if (entry.source === 'merit') {
    const mCat       = entry.meritCategory || 'misc';
    const mLabel     = entry.meritLabel    || '';
    const mDots      = entry.meritDots;
    const mQual      = entry.meritQualifier || '';
    const mOutcome   = entry.meritDesiredOutcome || '';
    const mDesc      = entry.description || '';
    const mDotsStr   = mDots != null ? '\u25CF'.repeat(mDots) : '';

    {
      const outcomeVal = rev?.desired_outcome ?? mOutcome;
      const descVal    = rev?.description     ?? mDesc;
      h += `<div class="proc-feed-desc-card">`;
      h += `<div class="proc-feed-desc-card-hd"><span class="proc-mod-panel-title">Details</span><button class="dt-btn proc-feed-desc-edit-btn" data-proc-key="${esc(entry.key)}">Edit</button></div>`;
      h += `<div class="proc-feed-desc-view">`;
      if (outcomeVal) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Desired Outcome</span> ${esc(outcomeVal)}</div>`;
      if (descVal)    h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Description</span> ${esc(descVal)}</div>`;
      if (entry.meritTerritory)       h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Territory</span> ${esc(entry.meritTerritory)}</div>`;
      if (entry.meritTarget)          h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Target</span> ${esc(entry.meritTarget)}</div>`;
      if (entry.meritInvestigateLead) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Lead</span> ${esc(entry.meritInvestigateLead)}</div>`;
      if (entry.meritCast)            h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Cast</span> ${esc(entry.meritCast)}</div>`;
      if (!outcomeVal && !descVal && !entry.meritTerritory && !entry.meritTarget && !entry.meritInvestigateLead && !entry.meritCast) h += `<div class="proc-proj-field proc-feed-desc-empty">\u2014 No details recorded</div>`;
      h += `</div>`;
      h += `<div class="proc-feed-desc-edit" style="display:none">`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Desired Outcome</span><input type="text" class="proc-detail-input proc-merit-outcome-input" data-proc-key="${esc(entry.key)}" value="${esc(outcomeVal)}"></div>`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Description</span><textarea class="proc-detail-ta proc-merit-desc-ta" data-proc-key="${esc(entry.key)}" rows="4">${esc(descVal)}</textarea><span class="dt-autosave-status" data-proc-key="${esc(entry.key)}" data-field="description"></span></div>`;
      h += `<div class="proc-feed-desc-actions"><button class="dt-btn proc-merit-desc-save-btn" data-proc-key="${esc(entry.key)}">Save</button><button class="dt-btn proc-feed-desc-cancel-btn" data-proc-key="${esc(entry.key)}">Cancel</button></div>`;
      h += `</div>`;
      h += `</div>`;
    }
  }

  // ── Project-specific detail display (inside left column) ──
  if (entry.source === 'project') {
    const projSub2 = submissions.find(s => s._id === entry.subId);
    const xpTrait  = projSub2?.responses?.[`project_${entry.projSlot}_xp_trait`] || '';
    const xpAmount = projSub2?.responses?.[`project_${entry.projSlot}_xp`] || '';

    // ── Editable Details card ──
    {
      const titleVal   = rev.title          ?? entry.projTitle   ?? '';
      const outcomeVal = rev.desired_outcome ?? entry.projOutcome ?? '';
      const descVal    = rev.description    ?? entry.description ?? '';
      const meritsVal  = rev.merits_bonuses ?? entry.projMerits  ?? '';
      const playerPoolVal = poolPlayer || '';

      h += `<div class="proc-feed-desc-card">`;
      h += `<div class="proc-feed-desc-card-hd"><span class="proc-mod-panel-title">Details</span><button class="dt-btn proc-feed-desc-edit-btn" data-proc-key="${esc(entry.key)}">Edit</button></div>`;

      // View mode
      h += `<div class="proc-feed-desc-view">`;
      if (titleVal)      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Title</span> ${esc(titleVal)}</div>`;
      if (outcomeVal)    h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Desired Outcome</span> ${esc(outcomeVal)}</div>`;
      if (descVal)       h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Description</span> ${esc(descVal)}</div>`;
      if (entry.projTarget) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Target</span> ${esc(entry.projTarget)}</div>`;
      if (entry.projInvestigateLead) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Lead</span> ${esc(entry.projInvestigateLead)}</div>`;
      // feature.97: structured table when row data available; flat string fallback for legacy submissions
      if (entry.projXpRows && entry.projXpRows.length) {
        h += _renderXpSpendBreakdown(entry.projXpRows, entry.projXpBudgetSnapshot);
      } else if (entry.projXpBreakdown) {
        h += `<div class="proc-proj-field"><span class="proc-feed-lbl">XP Spend</span> ${esc(entry.projXpBreakdown)}</div>`;
      }
      if (playerPoolVal) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Player's Pool</span> ${esc(playerPoolVal)}</div>`;
      if (meritsVal)     h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Merits &amp; Bonuses</span> ${esc(meritsVal)}</div>`;
      if (!titleVal && !outcomeVal && !descVal) h += `<div class="proc-proj-field proc-feed-desc-empty">\u2014 No details recorded</div>`;
      h += `</div>`;

      // Edit mode (hidden)
      h += `<div class="proc-feed-desc-edit" style="display:none">`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Title</span><input type="text" class="proc-detail-input proc-proj-title-input" data-proc-key="${esc(entry.key)}" value="${esc(titleVal)}"></div>`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Desired Outcome</span><input type="text" class="proc-detail-input proc-proj-outcome-input" data-proc-key="${esc(entry.key)}" value="${esc(outcomeVal)}"></div>`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Description</span><textarea class="proc-detail-ta proc-feed-desc-ta" data-proc-key="${esc(entry.key)}" rows="4">${esc(descVal)}</textarea><span class="dt-autosave-status" data-proc-key="${esc(entry.key)}" data-field="description"></span></div>`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Player's Pool</span><input type="text" class="proc-detail-input proc-feed-pool-input" data-proc-key="${esc(entry.key)}" value="${esc(playerPoolVal)}"></div>`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Merits &amp; Bonuses</span><input type="text" class="proc-detail-input proc-proj-merits-input" data-proc-key="${esc(entry.key)}" value="${esc(meritsVal)}"></div>`;
      h += `<div class="proc-feed-desc-actions"><button class="dt-btn proc-proj-desc-save-btn" data-proc-key="${esc(entry.key)}">Save</button><button class="dt-btn proc-feed-desc-cancel-btn" data-proc-key="${esc(entry.key)}">Cancel</button></div>`;
      h += `</div>`;
      h += `</div>`;

      // XP spend — kept outside the card (it's an approval item, not descriptive)
      if (xpTrait) {
        const xpLabel = xpAmount ? `XP Spend (${esc(String(xpAmount))} XP)` : 'XP Spend';
        h += `<div class="proc-proj-field proc-proj-xp"><span class="proc-feed-lbl">${xpLabel}</span> ${esc(xpTrait)}</div>`;
      }

      // Territory (read-only — set via territory pills elsewhere)
      if (entry.projTerritory) {
        const _tCanon   = resolveTerrId(entry.projTerritory) || entry.projTerritory;
        const _tDisplay = (cachedTerritories || []).find(t => t.slug === _tCanon)?.name
                       || TERRITORY_DATA.find(t => t.slug === _tCanon)?.name
                       || _tCanon;
        h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Territory</span> ${esc(_tDisplay)}</div>`;
      }
      // For feed projects, show player's nominated main feeding territories
      if (entry.actionType === 'feed') {
        const _nomText = _playerFeedTerrsText(projSub2);
        if (_nomText) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Territories</span> ${esc(_nomText)}</div>`;
      }
      // Characters Involved (read-only — structural, not editable here)
      if (entry.projCast) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Characters Involved</span> ${esc(entry.projCast)}</div>`;
    }

    // ── Action type recategorisation ──
    h += _renderActionTypeRow(entry, rev, projChar);
  }

  if (entry.source === 'merit') {
    // Contacts fields moved to right column (_renderCompactMeritPanel)
    // Patrol/Scout outcome fields
    if (entry.actionType === 'patrol_scout') {
      const _patObs   = rev.patrol_observed     || '';
      const _patLevel = rev.patrol_detail_level || '';
      const _patLevels = ['1 \u2014 Vague', '2', '3', '4', '5+ \u2014 Detailed'];
      h += `<div class="proc-recat-row proc-recat-row-spaced">`;
      h += `<span class="proc-feed-lbl">Detail Level</span>`;
      h += `<select class="proc-recat-select proc-patrol-detail-sel" data-proc-key="${esc(entry.key)}"><option value="">\u2014 Select \u2014</option>${_patLevels.map(l => `<option value="${l}"${_patLevel === l ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
      h += `</div>`;
      h += `<div class="proc-recat-row proc-recat-row-tight">`;
      h += `<span class="proc-feed-lbl">Observed</span>`;
      h += `<textarea class="proc-detail-ta proc-patrol-observed-ta" data-proc-key="${esc(entry.key)}" rows="3" placeholder="What was observed\u2026">${esc(_patObs)}</textarea>`;
      h += `</div>`;
    }
    // Support target selector
    if (entry.actionType === 'support') {
      const _supportKey = rev.support_target_key || '';
      const _queueEntries = _procQueueMap ? [..._procQueueMap.values()] : [];
      h += `<div class="proc-recat-row proc-recat-row-spaced">`;
      h += `<span class="proc-feed-lbl">Supporting</span>`;
      h += `<select class="proc-recat-select proc-support-target-sel" data-proc-key="${esc(entry.key)}">`;
      h += `<option value="">\u2014 Select action \u2014</option>`;
      for (const qe of _queueEntries) {
        if (qe.key === entry.key) continue;
        const qLabel = `${qe.charName} \u2014 ${qe.label}`;
        h += `<option value="${esc(qe.key)}"${_supportKey === qe.key ? ' selected' : ''}>${esc(qLabel)}</option>`;
      }
      h += `</select>`;
      h += `</div>`;
    }
    // Rumour outcome fields
    if (entry.actionType === 'rumour') {
      const _rumCont  = rev.rumour_content      || '';
      const _rumLevel = rev.rumour_detail_level || '';
      const _rumLevels = ['1 \u2014 Vague', '2', '3', '4', '5+ \u2014 Detailed'];
      h += `<div class="proc-recat-row proc-recat-row-spaced">`;
      h += `<span class="proc-feed-lbl">Detail Level</span>`;
      h += `<select class="proc-recat-select proc-rumour-detail-sel" data-proc-key="${esc(entry.key)}"><option value="">\u2014 Select \u2014</option>${_rumLevels.map(l => `<option value="${l}"${_rumLevel === l ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
      h += `</div>`;
      h += `<div class="proc-recat-row proc-recat-row-tight">`;
      h += `<span class="proc-feed-lbl">Rumour Surfaced</span>`;
      h += `<textarea class="proc-detail-ta proc-rumour-content-ta" data-proc-key="${esc(entry.key)}" rows="3" placeholder="What was heard\u2026">${esc(_rumCont)}</textarea>`;
      h += `</div>`;
    }
  }

  // ── Sorcery details card (editable) — above connected characters ──
  if (isSorcery) {
    const sorcRawNotes    = sorcSub?.responses?.[`sorcery_${entry.actionIdx}_notes`]   || '';
    const sorcRawTargets  = normaliseSorceryTargets(sorcSub?.responses?.[`sorcery_${entry.actionIdx}_targets`]) || entry.targetsText || '';
    const targetsVal      = rev.sorc_targets    ?? sorcRawTargets;
    const blobAsNotes     = (entry.riteName && entry.riteName.length > 60) ? entry.riteName : '';
    const notesVal        = rev.sorc_notes      ?? (sorcRawNotes || blobAsNotes);
    // ST overrides for tradition and rite name — fall back to submission values
    const traditionVal    = rev.sorc_tradition  ?? entry.tradition ?? '';
    // Rite: prefer ST-set name, then right-panel rite_override, skip blob if >60 chars
    const blobRite        = (entry.riteName && entry.riteName.length <= 60) ? entry.riteName : '';
    const riteVal         = rev.sorc_rite_name  ?? rev.rite_override ?? blobRite;
    const riteRaw         = entry.riteName || '\u2014';

    h += `<div class="proc-feed-desc-card">`;
    h += `<div class="proc-feed-desc-card-hd"><span class="proc-mod-panel-title">Details</span><button class="dt-btn proc-feed-desc-edit-btn" data-proc-key="${esc(entry.key)}">Edit</button></div>`;
    // View mode (hidden when editing)
    const _effectVal =
      (riteVal ? (_getRulesDB() || []).find(r => r.category === 'rite' && r.name === riteVal)?.description : '')
      || '';
    h += `<div class="proc-feed-desc-view">`;
    if (_effectVal)       h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Effect</span> ${esc(_effectVal)}</div>`;
    if (notesVal)         h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Notes</span> ${esc(notesVal)}</div>`;
    if (entry.poolPlayer) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Player's Pool</span> ${esc(entry.poolPlayer)}</div>`;
    h += `</div>`;
    // Edit mode (hidden by default)
    h += `<div class="proc-feed-desc-edit" style="display:none">`;
    h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Notes</span><textarea class="proc-detail-ta proc-sorc-notes-input" data-proc-key="${esc(entry.key)}" rows="3">${esc(notesVal)}</textarea><span class="dt-autosave-status" data-proc-key="${esc(entry.key)}" data-field="sorc_notes"></span></div>`;
    h += `<div class="proc-feed-desc-actions"><button class="dt-btn proc-sorc-desc-save-btn" data-proc-key="${esc(entry.key)}">Save</button><button class="dt-btn proc-feed-desc-cancel-btn" data-proc-key="${esc(entry.key)}">Cancel</button></div>`;
    h += `</div>`;
    h += `</div>`;
  }


  // ── Feeding-specific detail display ──
  if (entry.source === 'feeding') {
    if (entry.noMethod) {
      h += `<div class="proc-feed-no-method">No feeding method declared by player.</div>`;
    }
    // ── Details card: Description (editable) + Blood Type (editable) + Player's Submitted Pool ──
    {
      const resp         = feedSub?.responses || {};
      const isAppForm    = !!(resp.feed_attr);
      const nameVal      = rev.name        ?? '';
      const descVal      = rev.description ?? entry.feedDesc ?? '';
      const bloodTypeVal = rev.blood_type  ?? '';
      const bonusesVal   = rev.bonuses     ?? '';
      // Player's submitted pool string
      let playerPoolStr;
      if (isAppForm) {
        const pAttr  = resp.feed_attr || '';
        const pSkill = resp.feed_skill || '';
        const pDisc  = resp.feed_discipline || '';
        playerPoolStr = [pAttr, pSkill, pDisc].filter(Boolean).join(' + ') || '\u2014';
      } else {
        playerPoolStr = (entry.feedMethod === 'other' && (!poolPlayer || poolPlayer === 'Other') && entry.feedDesc)
          ? entry.feedDesc
          : (poolPlayer || '\u2014');
      }

      h += `<div class="proc-feed-desc-card">`;
      h += `<div class="proc-feed-desc-card-hd"><span class="proc-mod-panel-title">Details</span><button class="dt-btn proc-feed-desc-edit-btn" data-proc-key="${esc(entry.key)}">Edit</button></div>`;
      // View mode
      h += `<div class="proc-feed-desc-view">`;
      if (nameVal)      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Name</span> ${esc(nameVal)}</div>`;
      if (descVal)      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Description</span> ${esc(descVal)}</div>`;
      if (bloodTypeVal) h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Blood Type</span> ${esc(bloodTypeVal)}</div>`;
      if (!nameVal && !descVal && !bloodTypeVal) h += `<div class="proc-proj-field proc-feed-desc-empty">\u2014 No details recorded</div>`;
      h += `</div>`;
      // Edit mode (hidden)
      h += `<div class="proc-feed-desc-edit" style="display:none">`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Name</span><input type="text" class="proc-detail-input proc-feed-name-input" data-proc-key="${esc(entry.key)}" value="${esc(nameVal)}" placeholder="e.g. The Thirsty Blade, quiet back alley\u2026"></div>`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Description</span><textarea class="proc-detail-ta proc-feed-desc-ta" data-proc-key="${esc(entry.key)}" rows="3" placeholder="How does the character typically feed? What\u2019s the cover story?">${esc(descVal)}</textarea><span class="dt-autosave-status" data-proc-key="${esc(entry.key)}" data-field="description"></span></div>`;
      const _btOpts = ['Human', 'Animal', 'Kindred', 'Ghoul'];
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Blood Type</span><select class="proc-recat-select proc-feed-blood-sel" data-proc-key="${esc(entry.key)}">${_btOpts.map(o => `<option value="${o}"${bloodTypeVal === o ? ' selected' : ''}>${o}</option>`).join('')}</select></div>`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Player's Pool</span><input type="text" class="proc-detail-input proc-feed-pool-input" data-proc-key="${esc(entry.key)}" value="${esc(poolPlayer || playerPoolStr)}"></div>`;
      h += `<div class="proc-proj-field"><span class="proc-feed-lbl">Bonuses</span><input type="text" class="proc-detail-input proc-feed-bonuses-input" data-proc-key="${esc(entry.key)}" value="${esc(bonusesVal)}" placeholder="e.g. Herd +2, Rote"></div>`;
      h += `<div class="proc-feed-desc-actions"><button class="dt-btn proc-feed-desc-save-btn" data-proc-key="${esc(entry.key)}">Save</button><button class="dt-btn proc-feed-desc-cancel-btn" data-proc-key="${esc(entry.key)}">Cancel</button></div>`;
      h += `</div>`;
      h += `</div>`;
    }
    // ── Resident/poacher mismatch flag ──
    {
      const _charId = String(feedChar?._id || '');
      let _feedGrid = {};
      try { _feedGrid = JSON.parse(feedSub?.responses?.feeding_territories || '{}'); } catch { /* ignore */ }
      const _terrDocs = cachedTerritories || [];
      const _mismatches = [];
      for (const [terrKey, val] of Object.entries(_feedGrid)) {
        if (!val || val === 'none') continue;
        // Resolve territory doc by slug key (Mongo docs carry slug post-ADR-002).
        const _td = _terrDocs.find(t =>
          (t.slug && t.slug === terrKey) ||
          (t.name && t.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') === terrKey)
        );
        if (!_td) continue;
        // Rights-holders: regent, lieutenant, or anyone on the explicit list.
        // regent_id and lieutenant_id are implicit — not duplicated into feeding_rights[].
        const _hasRights = _charId && (
          String(_td.regent_id || '') === _charId ||
          String(_td.lieutenant_id || '') === _charId ||
          (Array.isArray(_td.feeding_rights) && _td.feeding_rights.some(id => String(id) === _charId))
        );
        if (val === 'feeding_rights' && !_hasRights) {
          _mismatches.push(`Claims feeding rights in ${_td.name} — not on Regent's list`);
        } else if (val === 'poaching' && _hasRights) {
          _mismatches.push(`Has feeding rights in ${_td.name} — declared as poaching`);
        }
      }
      for (const _msg of _mismatches) {
        h += `<div class="proc-mismatch-flag">\u26A0 ${esc(_msg)}</div>`;
      }
    }
    // Previous roll result (use hoisted feedSub from top of function)
    const feedRoll = feedSub?.feeding_roll;
    if (feedRoll) {
      const roteTag = feedRoll.params?.rote ? ' (rote)' : '';
      h += `<div class="proc-feed-roll-result">\u2713 Rolled: ${esc(String(feedRoll.successes))} success${feedRoll.successes !== 1 ? 'es' : ''}${feedRoll.exceptional ? ' \u2014 exceptional' : ''}${roteTag}</div>`;
    }
  }

  // Pool row — feeding gets structured pool builder (rendered into _bh → top of right column)
  let _bh = '';
  if (entry.source === 'feeding') {
    // Use hoisted feedSub / feedChar from top of function
    const resp = feedSub?.responses || {};
    const char = feedChar;

    // Dice Pool Builder — always rendered; dot values filled from char data when available
    {
      const charDiscs = _charDiscsArray(char).filter(d => d.dots > 0);
      const discNames = charDiscs.map(d => d.name);
      const allDiscNames = char ? discNames : KNOWN_DISCIPLINES;

      // Pre-populate from existing pool_validated, else from player's submitted feeding method
      let preAttr = '', preSkill = '', preDisc = 'none', preMod = 0, showParseRef = false;
      if (poolValidated) {
        const parsed = _parsePoolExpr(poolValidated, ALL_ATTRS, ALL_SKILLS, allDiscNames);
        if (parsed) {
          preAttr  = parsed.attr  || '';
          preSkill = parsed.skill || '';
          preDisc  = parsed.disc  || 'none';
          preMod   = parsed.modifier || 0;
        } else {
          showParseRef = true;
        }
      } else {
        const _method = resp._feed_method || '';
        if (_method === 'other') {
          preAttr  = resp._feed_custom_attr  || '';
          preSkill = resp._feed_custom_skill || '';
          const _cd = resp._feed_custom_disc || resp._feed_disc || '';
          preDisc  = (_cd && allDiscNames.includes(_cd)) ? _cd : 'none';
        } else if (_method && char) {
          const _pool = buildFeedingPool(char, _method, 0, { disc: resp._feed_disc || '', spec: resp._feed_spec || '' });
          if (_pool) {
            preAttr  = _pool.breakdown.attr  || '';
            preSkill = _pool.breakdown.skill || '';
            preDisc  = (_pool.breakdown.disc && allDiscNames.includes(_pool.breakdown.disc))
              ? _pool.breakdown.disc : 'none';
          }
        }
        // Disc-only fallback: old-format submissions have no _feed_method; if poolPlayer
        // is a bare discipline name, seed the disc dropdown so the ST has a starting point.
        if (preDisc === 'none' && poolPlayer) {
          const _pp = poolPlayer.trim();
          if (_pp && allDiscNames.includes(_pp)) preDisc = _pp;
        }
      }

      const attrOptHtml = ['<option value="" data-dots="0">-- Attribute --</option>',
        ...ALL_ATTRS.map(a => {
          const dots = char ? (getAttrVal(char, a) || 0) : null;
          const sel  = a === preAttr ? ' selected' : '';
          const label = dots !== null ? `${esc(a)} (${dots})` : esc(a);
          return `<option value="${esc(a)}" data-dots="${dots ?? 0}"${sel}>${label}</option>`;
        })
      ].join('');

      const skillOptHtml = ['<option value="" data-dots="0">-- Skill --</option>',
        ...ALL_SKILLS.map(s => {
          const dots = char ? (skTotal(char, s) || 0) : null;
          const sel  = s === preSkill ? ' selected' : '';
          const label = dots !== null ? `${esc(s)} (${dots})` : esc(s);
          return `<option value="${esc(s)}" data-dots="${dots ?? 0}"${sel}>${label}</option>`;
        })
      ].join('');

      const discOptHtml = ['<option value="none" data-dots="0">None</option>',
        ...allDiscNames.map(name => {
          const d    = charDiscs.find(cd => cd.name === name);
          const dots = d ? d.dots : null;
          const sel  = name === preDisc ? ' selected' : '';
          const label = dots !== null ? `${esc(name)} (${dots})` : esc(name);
          return `<option value="${esc(name)}" data-dots="${dots ?? 0}"${sel}>${label}</option>`;
        })
      ].join('');

      // Compute initial pool modifier total from right-panel values (FG + equipment)
      // This mirrors what _renderFeedRightPanel computes so the pool total reflects modifiers on open
      const fg0 = (char?.merits || []).find(m => m.name === 'Feeding Grounds');
      const fgDice0 = fg0 ? Math.min(char ? meritEffectiveRating(char, fg0) : 0, 5) : 0;
      const eqMod0 = rev.pool_mod_equipment !== undefined ? rev.pool_mod_equipment : 0;
      const initFeedPoolMod = fgDice0 + eqMod0;
      // Use right-panel total as the modifier (overrides parsed preMod for display; preMod still used
      // for expression string restoration but display uses live panel total)
      const initModForDisplay = initFeedPoolMod;

      // Initial total display (AC 12: pass skillName for unskilled penalty)
      const initAttrDots  = preAttr  ? (char ? (getAttrVal(char, preAttr) || 0) : 0) : 0;
      const initSkillDots = preSkill ? (char ? (skTotal(char, preSkill) || 0) : 0) : 0;
      const initDiscDots  = (preDisc && preDisc !== 'none') ? (charDiscs.find(d => d.name === preDisc)?.dots || 0) : 0;
      const initTotalStr  = _poolTotalDisplay(preAttr, initAttrDots, preSkill, initSkillDots, preDisc, initDiscDots, initModForDisplay, preSkill);

      const _feedCommitted = poolStatus === 'confirmed';
      const _feedDis = _feedCommitted ? ' disabled' : '';
      const _feedSubR0  = submissions.find(s => s._id === entry.subId);
      const _isRoteFeed = entry.feedRote || _feedSubR0?.st_review?.feeding_rote || false;
      const _pnAFeed    = char && preSkill ? skNineAgain(char, preSkill) : false;
      const _is8aFeed   = rev.eight_again || false;
      const _againFeed  = _is8aFeed ? '8' : (_pnAFeed ? '9' : (rev.nine_again ? '9' : '10'));
      const _rollModeFeed = rev.roll_mode || null;
      const _bhFeedPool    = poolPlayer || '';
      const _bhFeedBonuses = rev.bonuses ?? '';
      _bh += `<div class="proc-pool-builder${_feedCommitted ? ' proc-pool-committed' : ''}" data-proc-key="${esc(entry.key)}">`;
      _bh += `<div class="proc-mod-panel-title">Dice Pool Builder${!char ? ' <span class="dt-hint">(dot values unavailable \u2014 character not loaded)</span>' : ''}${_feedCommitted ? ' <span class="proc-pool-committed-badge">[Confirmed]</span>' : ''}</div>`;
      if (_bhFeedPool || _bhFeedBonuses) {
        _bh += `<div class="proc-pool-player-meta">`;
        if (_bhFeedPool)    _bh += `<div class="proc-pool-meta-row"><span class="proc-feed-lbl">Player's Pool</span> ${esc(_bhFeedPool)}</div>`;
        if (_bhFeedBonuses) _bh += `<div class="proc-pool-meta-row"><span class="proc-feed-lbl">Bonuses</span> ${esc(_bhFeedBonuses)}</div>`;
        _bh += `</div>`;
      }
      if (showParseRef) {
        _bh += `<div class="proc-pool-parse-ref">Could not restore selection \u2014 previous: "${esc(poolValidated)}"</div>`;
      }
      _bh += '<div class="proc-pool-builder-selects">';
      _bh += `<select class="proc-pool-attr" data-proc-key="${esc(entry.key)}"${_feedDis}>${attrOptHtml}</select>`;
      _bh += `<span class="proc-pool-plus">+</span>`;
      _bh += `<select class="proc-pool-skill" data-proc-key="${esc(entry.key)}"${_feedDis}>${skillOptHtml}</select>`;
      _bh += `<span class="proc-pool-plus">+</span>`;
      _bh += `<select class="proc-pool-disc" data-proc-key="${esc(entry.key)}"${_feedDis}>${discOptHtml}</select>`;
      _bh += '</div>'; // proc-pool-builder-selects
      _bh += `<input type="hidden" class="proc-pool-mod-val" data-proc-key="${esc(entry.key)}" value="${initModForDisplay}">`;
      _bh += `<div class="proc-pool-chips">`;
      _bh += `<div class="dt-feed-builder-meta dt-skill-meta" data-proc-key="${esc(entry.key)}" data-sub-id="${esc(entry.subId)}">`;
      _bh += _buildSpecTogglesHtml(char, preSkill, entry.key, rev.active_feed_specs || [], _feedDis);
      _bh += '</div>';
      _bh += `<button class="proc-rote-chip${_isRoteFeed ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}"${_feedDis ? ' disabled' : ''}>Rote</button>`;
      _bh += `<button class="proc-again-opt${_againFeed === '10' ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="10"${_feedDis ? ' disabled' : ''}>10-Again</button>`;
      _bh += `<button class="proc-again-opt${_againFeed === '9' ? ' is-active' : ''}${_pnAFeed && !_is8aFeed && _againFeed === '9' ? ' is-auto' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="9"${_feedDis ? ' disabled' : ''}>9-Again</button>`;
      _bh += `<button class="proc-again-opt${_againFeed === '8' ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="8"${_feedDis ? ' disabled' : ''}>8-Again</button>`;
      _bh += _renderRollModeToggle(entry.key, _rollModeFeed, !!_feedDis);
      _bh += '</div>'; // proc-pool-chips
      _bh += _renderPoolModPanel(entry, char, rev, 'feeding');
      _bh += `<div class="proc-pool-total" data-proc-key="${esc(entry.key)}">${esc(_augmentPoolWithSpecs(initTotalStr, rev.active_feed_specs || [], char) || initTotalStr)}</div>`;
      _bh += '</div>'; // proc-pool-builder
    }
  } else if (entry.source === 'project') {
    // Project: structured pool builder (mirrors feeding)
    const char = projChar;
    const charDiscs = _charDiscsArray(char).filter(d => d.dots > 0);
    const allDiscNames = char ? charDiscs.map(d => d.name) : KNOWN_DISCIPLINES;

    let preAttr = '', preSkill = '', preDisc = 'none', showParseRef = false;
    if (poolValidated) {
      const parsed = _parsePoolExpr(poolValidated, ALL_ATTRS, ALL_SKILLS, allDiscNames);
      if (parsed) {
        preAttr  = parsed.attr  || '';
        preSkill = parsed.skill || '';
        preDisc  = parsed.disc  || 'none';
      } else {
        showParseRef = true;
      }
    } else if (projSub) {
      // Task 4: pre-populate from player's submitted form fields on first open
      const resp2 = projSub.responses || {};
      preAttr  = resp2[`project_${entry.projSlot}_pool_attr`]  || '';
      preSkill = resp2[`project_${entry.projSlot}_pool_skill`] || '';
      preDisc  = resp2[`project_${entry.projSlot}_pool_disc`]  || 'none';
    }

    const attrOptHtml = ['<option value="" data-dots="0">-- Attribute --</option>',
      ...ALL_ATTRS.map(a => {
        const dots = char ? (getAttrVal(char, a) || 0) : null;
        const sel  = a === preAttr ? ' selected' : '';
        const label = dots !== null ? `${esc(a)} (${dots})` : esc(a);
        return `<option value="${esc(a)}" data-dots="${dots ?? 0}"${sel}>${label}</option>`;
      })
    ].join('');

    const skillOptHtml = ['<option value="" data-dots="0">-- Skill --</option>',
      ...ALL_SKILLS.map(s => {
        const dots = char ? (skTotal(char, s) || 0) : null;
        const sel  = s === preSkill ? ' selected' : '';
        const label = dots !== null ? `${esc(s)} (${dots})` : esc(s);
        return `<option value="${esc(s)}" data-dots="${dots ?? 0}"${sel}>${label}</option>`;
      })
    ].join('');

    const discOptHtml = ['<option value="none" data-dots="0">None</option>',
      ...allDiscNames.map(name => {
        const d    = charDiscs.find(cd => cd.name === name);
        const dots = d ? d.dots : null;
        const sel  = name === preDisc ? ' selected' : '';
        const label = dots !== null ? `${esc(name)} (${dots})` : esc(name);
        return `<option value="${esc(name)}" data-dots="${dots ?? 0}"${sel}>${label}</option>`;
      })
    ].join('');

    const eqMod0 = rev.pool_mod_equipment !== undefined ? rev.pool_mod_equipment : 0;
    const initModForDisplay = eqMod0;

    const initAttrDots  = preAttr  ? (char ? (getAttrVal(char, preAttr) || 0) : 0) : 0;
    const initSkillDots = preSkill ? (char ? (skTotal(char, preSkill) || 0) : 0) : 0;
    const initDiscDots  = (preDisc && preDisc !== 'none') ? (charDiscs.find(d => d.name === preDisc)?.dots || 0) : 0;
    // 9-again auto-detect (used for pool total annotation and sidebar initial state)
    const _pnA  = char && preSkill ? skNineAgain(char, preSkill) : false;
    const initTotalStr  = _poolTotalDisplay(preAttr, initAttrDots, preSkill, initSkillDots, preDisc, initDiscDots, initModForDisplay, preSkill, _pnA);

    const _projCommitted = poolStatus === 'confirmed';
    const _projDis = _projCommitted ? ' disabled' : '';
    const _isRoteProj = rev.rote || false;
    const _is8aProj   = rev.eight_again || false;
    const _againProj  = _is8aProj ? '8' : (_pnA ? '9' : (rev.nine_again ? '9' : '10'));
    const _rollModeProj = rev.roll_mode || null;
    h += `<div class="proc-pool-builder${_projCommitted ? ' proc-pool-committed' : ''}" data-proc-key="${esc(entry.key)}">`;
    h += `<div class="proc-mod-panel-title">Dice Pool Builder${!char ? ' <span class="dt-hint">(dot values unavailable \u2014 character not loaded)</span>' : ''}${_projCommitted ? ' <span class="proc-pool-committed-badge">[Confirmed]</span>' : ''}</div>`;
    if (showParseRef) {
      h += `<div class="proc-pool-parse-ref">Could not restore selection \u2014 previous: "${esc(poolValidated)}"</div>`;
    }
    h += '<div class="proc-pool-builder-selects">';
    h += `<select class="proc-pool-attr" data-proc-key="${esc(entry.key)}"${_projDis}>${attrOptHtml}</select>`;
    h += `<span class="proc-pool-plus">+</span>`;
    h += `<select class="proc-pool-skill" data-proc-key="${esc(entry.key)}"${_projDis}>${skillOptHtml}</select>`;
    h += `<span class="proc-pool-plus">+</span>`;
    h += `<select class="proc-pool-disc" data-proc-key="${esc(entry.key)}"${_projDis}>${discOptHtml}</select>`;
    h += '</div>';
    h += `<input type="hidden" class="proc-pool-mod-val" data-proc-key="${esc(entry.key)}" value="${initModForDisplay}">`;
    h += `<div class="proc-pool-chips">`;
    h += `<div class="dt-feed-builder-meta dt-skill-meta" data-proc-key="${esc(entry.key)}" data-sub-id="${esc(entry.subId)}">`;
    h += _buildSpecTogglesHtml(char, preSkill, entry.key, rev.active_feed_specs || [], _projDis);
    h += '</div>';
    h += `<button class="proc-rote-chip${_isRoteProj ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}"${_projDis ? ' disabled' : ''}>Rote</button>`;
    h += `<button class="proc-again-opt${_againProj === '10' ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="10"${_projDis ? ' disabled' : ''}>10-Again</button>`;
    h += `<button class="proc-again-opt${_againProj === '9' ? ' is-active' : ''}${_pnA && !_is8aProj && _againProj === '9' ? ' is-auto' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="9"${_projDis ? ' disabled' : ''}>9-Again</button>`;
    h += `<button class="proc-again-opt${_againProj === '8' ? ' is-active' : ''}" type="button" data-proc-key="${esc(entry.key)}" data-again="8"${_projDis ? ' disabled' : ''}>8-Again</button>`;
    h += _renderRollModeToggle(entry.key, _rollModeProj, !!_projDis);
    h += '</div>'; // proc-pool-chips
    h += _renderPoolModPanel(entry, char, rev, 'project');
    h += `<div class="proc-pool-total" data-proc-key="${esc(entry.key)}" data-nine-again="${_pnA ? '1' : '0'}">${esc(_augmentPoolWithSpecs(initTotalStr, rev.active_feed_specs || [], char) || initTotalStr)}</div>`;
    h += '</div>'; // proc-pool-builder
  } else if (isSorcery) {
    // Pool display moved to right column Dice Pool Builder
    const resultNote = rev.ritual_result_note || '';
    h += '<div class="proc-section proc-mech-result-section">';
    h += '<div class="proc-mod-panel-title">Mechanical Result</div>';
    h += `<textarea class="proc-ritual-note-input" data-proc-key="${esc(entry.key)}" rows="2" placeholder="Potency, duration, effect on target…">${esc(resultNote)}</textarea>`;
    h += '</div>';
  } else if (entry.source === 'acquisition') {
    // Acquisitions: Resources has no roll (notes only). Skill has a roll — show 2-column pool layout.
    h += '<div class="proc-section">';
    h += '<div class="proc-mod-panel-title">Player Notes</div>';
    h += `<div class="proc-acq-notes">${esc(entry.acqNotes || entry.description).replace(/\n/g, '<br>')}</div>`;
    h += '</div>';
    if (entry.actionType === 'skill_acquisitions') {
      h += '<div class="proc-detail-grid">';
      h += '<div class="proc-detail-col">';
      h += `<div class="proc-detail-label">Player's Submitted Pool</div>`;
      h += `<div class="proc-detail-value">${esc(poolPlayer || '—')}</div>`;
      h += '</div>';
      h += '<div class="proc-detail-col">';
      h += `<div class="proc-detail-label">ST Validated Pool</div>`;
      h += `<input class="proc-pool-input" type="text" data-proc-key="${esc(entry.key)}" value="${esc(poolValidated)}" placeholder="Enter validated pool...">`;
      h += '</div>';
      h += '</div>';
      h += _renderMeritOutcomeZone(entry, rev);
    }
  } else if (entry.source !== 'merit') {
    // Non-feeding, non-project, non-sorcery, non-merit: standard 2-column layout
    h += '<div class="proc-detail-grid">';
    h += '<div class="proc-detail-col">';
    h += `<div class="proc-detail-label">Player's Submitted Pool</div>`;
    h += `<div class="proc-detail-value">${esc(poolPlayer || '\u2014')}</div>`;
    h += '</div>';
    h += '<div class="proc-detail-col">';
    h += `<div class="proc-detail-label">ST Validated Pool</div>`;
    h += `<input class="proc-pool-input" type="text" data-proc-key="${esc(entry.key)}" value="${esc(poolValidated)}" placeholder="Enter validated pool...">`;
    h += '</div>';
    h += '</div>'; // proc-detail-grid
  }


  // ST Notes / Outcome / Player Feedback — suppressed for compact merit entries (right panel has its own)
  if (!isCompactMerit) {
  // ST Notes thread
  h += '<div class="proc-section proc-notes-panel proc-notes-primary">';
  h += '<div class="proc-mod-panel-title">ST Notes</div>';
  if (thread.length) {
    h += '<div class="proc-notes-thread">';
    for (let noteIdx = 0; noteIdx < thread.length; noteIdx++) {
      const note = thread[noteIdx];
      const time = note.created_at
        ? new Date(note.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : '';
      h += '<div class="proc-note-entry">';
      h += `<div class="proc-note-meta">${esc(note.author_name)}${time ? '  \u00B7  ' + esc(time) : ''}<button class="proc-note-delete-btn" data-proc-key="${esc(entry.key)}" data-note-idx="${noteIdx}" title="Delete note">\u00D7</button></div>`;
      h += `<div class="proc-note-text">${esc(note.text)}</div>`;
      h += '</div>';
    }
    h += '</div>';
  }
  h += '<div class="proc-note-add">';
  h += `<textarea class="proc-note-textarea" data-proc-key="${esc(entry.key)}" placeholder="Add ST note..." rows="3"></textarea>`;
  h += `<button class="dt-btn proc-add-note-btn" data-proc-key="${esc(entry.key)}">Add Note</button>`;
  h += '</div>';
  h += '</div>';


  // ── Outcome ──
  h += '<div class="proc-section proc-player-note-section">';
  h += '<div class="proc-mod-panel-title">Outcome</div>';
  h += '<div class="proc-note-add">';
  h += `<textarea class="proc-outcome-input" data-proc-key="${esc(entry.key)}" rows="4" placeholder="What happened — appears in the DT result...">${esc(outcomeVal)}</textarea>`;
  h += `<button class="dt-btn proc-confirm-outcome-btn" data-proc-key="${esc(entry.key)}">Confirm</button>`;
  h += '</div>';
  h += '</div>';

  // Player Feedback (player_facing_note — included verbatim in published outcome)
  h += '<div class="proc-section proc-player-note-section">';
  h += '<div class="proc-mod-panel-title">Player Feedback <span class="proc-label-sub">— sent to player</span></div>';
  h += `<textarea class="proc-player-note-input" data-proc-key="${esc(entry.key)}" rows="2" placeholder="Plain-language note included verbatim in player outcome...">${esc(playerFacingNote)}</textarea>`;
  h += '</div>';

  }
  // ── Cross-reference callout (read-only, derived from xrefIndex) ──
  {
    const xrefLines = [];

    // Project territory overlap
    if (entry.projTerritory) {
      // 496.2 QA: normalise to canonical slug for index lookup so OID-keyed
      // and slug-keyed submissions cross-reference correctly. Also resolve
      // to display name so the UI shows "The Harbour" instead of an OID.
      const projCanon = resolveTerrId(entry.projTerritory) || entry.projTerritory;
      const projDisplay = (cachedTerritories || []).find(t => t.slug === projCanon)?.name
                       || TERRITORY_DATA.find(t => t.slug === projCanon)?.name
                       || entry.projTerritory;
      const others = (_xrefIndex.get(`terr:${projCanon}`) || [])
        .filter(r => r.charName !== entry.charName);
      if (others.length) {
        const names = others.map(r => `${r.charName} (${r.label})`).join(', ');
        xrefLines.push(`Also in ${projDisplay}: ${names}`);
      }
    }

    // fix.621: feeding actions index their territory via feedTerrs (no projTerritory). Surface the
    // same "Also in <territory>" cross-reference for the feeding entry's primary territory.
    if (entry.source === 'feeding' && entry.primaryTerr) {
      const feedCanon = resolveTerrId(entry.primaryTerr) || entry.primaryTerr;
      const feedDisplay = (cachedTerritories || []).find(t => t.slug === feedCanon)?.name
                       || TERRITORY_DATA.find(t => t.slug === feedCanon)?.name
                       || entry.primaryTerr;
      const others = (_xrefIndex.get(`terr:${feedCanon}`) || [])
        .filter(r => r.charName !== entry.charName);
      if (others.length) {
        const names = others.map(r => `${r.charName} (${r.label})`).join(', ');
        xrefLines.push(`Also in ${feedDisplay}: ${names}`);
      }
    }

    // Investigate target overlap + hide/protect check
    if (entry.actionType === 'investigate' && rev.investigate_target_char) {
      const target = rev.investigate_target_char;
      const others = (_xrefIndex.get(`inv-target:${target}`) || [])
        .filter(r => r.charName !== entry.charName);
      if (others.length) {
        xrefLines.push(`Also investigating ${target}: ${others.map(r => r.charName).join(', ')}`);
      }
      // hide/protect: the target's own submission having a hide_protect action
      // charName uses display capitalisation; target (investigate_target_char) is stored as sortName (lowercase)
      if ([..._procQueueMap.values()].some(e => e.actionType === 'hide_protect' && e.charName.toLowerCase() === target)) {
        xrefLines.push(`${target} has an active hide/protect action this cycle`);
      }
    }

    if (xrefLines.length) {
      h += `<div class="proc-xref-callout">`;
      for (const line of xrefLines) h += `<div class="proc-xref-line">${esc(line)}</div>`;
      h += `</div>`;
    }
  }

  // ── Close left column; render right panel for feeding + project + sorcery + merit entries ──
  if (entry.source === 'feeding') {
    h += _renderSnapshotFeedingPanel(entry, feedChar);
    h += '</div>'; // proc-feed-left
    h += _renderFeedRightPanel(entry, feedChar, rev, _bh);
    h += '</div>'; // proc-feed-layout
  } else if (entry.source === 'project') {
    h += '</div>'; // proc-feed-left
    h += _renderProjRightPanel(entry, projChar, rev);
    h += '</div>'; // proc-feed-layout
  } else if (isSorcery) {
    h += '</div>'; // proc-feed-left
    h += _renderSorceryRightPanel(entry, sorcChar, sorcSub, rev);
    h += '</div>'; // proc-feed-layout
  } else if (entry.source === 'merit') {
    // Intelligence panel — suppressed for purely defensive actions
    if (entry.actionType !== 'block' && entry.actionType !== 'hide_protect') {
      h += entry.actionType === 'feed'            ? _renderSnapshotFeedingPanel(entry, meritEntChar)
         : entry.actionType === 'ambience_change' ? _renderSnapshotAmbiencePanel(entry)
         : _renderSnapshotPanel(entry);
    }
    h += '</div>'; // proc-feed-left
    h += _renderMeritRightPanel(entry, rev);
    h += '</div>'; // proc-feed-layout
  }

  // Delete button for ST-created actions
  if (entry.source === 'st_created') {
    h += `<div class="proc-section">`;
    h += `<button class="dt-btn proc-delete-st-action" data-proc-key="${esc(entry.key)}" data-sub-id="${esc(entry.subId)}" data-action-idx="${entry.actionIdx}">Delete action</button>`;
    h += `</div>`;
  }

  h += '</div>'; // proc-action-detail
  return h;
}

// ── Ritual helpers ────────────────────────────────────────────────────────────

/**
 * Compute the shared Mandragora Garden pool across all characters.
 * Deduplicates paired "Shared (X)" merits — a garden shared between two characters
 * counts only once (at the rating of the first partner encountered).
 */
function _mandragoraSharedPool() {
  let total = 0;
  const countedPairs = new Set();
  for (const c of characters) {
    const m = (c.merits || []).find(x => x.name === 'Mandragora Garden');
    if (!m) continue;
    const qual = (m.qualifier || '');
    const sharedMatch = qual.match(/^[Ss]hared\s*\(([^)]+)\)$/);
    if (sharedMatch) {
      const pairedName = sharedMatch[1].trim().toLowerCase();
      const pairKey = [c.name.toLowerCase(), pairedName].sort().join('::');
      if (countedPairs.has(pairKey)) continue;
      countedPairs.add(pairKey);
    }
    total += (m.rating || m.dots || 0) + (m.bonus || 0);
  }
  return total;
}

// Tradition pool formulas — all rites within a tradition use the same base pool
const TRADITION_POOL = {
  Cruac:             { attr: 'Intelligence', skill: 'Occult',    disc: 'Cruac' },
  'Theban Sorcery':  { attr: 'Resolve',     skill: 'Academics', disc: 'Theban Sorcery' },
  Theban:            { attr: 'Resolve',     skill: 'Academics', disc: 'Theban Sorcery' },
};

function _getRiteInfo(riteName) {
  const db = _getRulesDB();

  // Try rules DB first — use rank if present, derive pool from parent tradition if pool is null
  if (db) {
    const riteRule = db.find(r => r.category === 'rite' && r.name === riteName);
    if (riteRule?.rank) {
      // Pool: use stored pool object if populated, otherwise derive from parent tradition
      let attr, skill, disc;
      if (riteRule.pool?.attr || riteRule.pool?.skill) {
        attr  = riteRule.pool.attr  || '';
        skill = riteRule.pool.skill || '';
        disc  = riteRule.pool.disc  || '';
      } else {
        const trad = TRADITION_POOL[riteRule.parent] || null;
        if (trad) { attr = trad.attr; skill = trad.skill; disc = trad.disc; }
      }
      if (attr || skill) {
        return { poolExpr: [attr, skill, disc].filter(Boolean).join(' + '), target: riteRule.rank, attr, skill, disc };
      }
    }
  }

  // Fallback: scan all loaded characters' powers to find rite level + tradition
  for (const char of characters) {
    const rite = (char.powers || []).find(p => p.category === 'rite' && p.name === riteName);
    if (rite?.level && rite.tradition) {
      const pool = TRADITION_POOL[rite.tradition] || null;
      if (pool) {
        return { poolExpr: [pool.attr, pool.skill, pool.disc].filter(Boolean).join(' + '), target: rite.level, ...pool };
      }
    }
  }

  return null;
}

/**
 * Return the known level of a rite by name: checks DB first, then all character powers.
 */
/** Compute total Cruac vitae cost from a submission's sorcery slots. Theban rites cost WP, not vitae. */
function _computeRiteVitaeCost(sub, char) {
  const subChar = char || _findCharForSub(sub);
  const discs = subChar?.disciplines || {};
  if (!discs.Cruac) return 0;
  const resp = sub.responses || {};
  const count = parseInt(resp['sorcery_slot_count'] || '1', 10);
  let total = 0;
  for (let n = 1; n <= count; n++) {
    const rite = resp[`sorcery_${n}_rite`];
    if (!rite) continue;
    const level = _getRiteLevel(rite) || 0;
    if (level) total += riteCost({ tradition: 'Cruac', level }).vitae;
  }
  return total;
}

/** Compute total Theban WP cost from a submission's sorcery slots (1 WP per rite). */
function _computeRiteWpCost(sub, char) {
  const subChar = char || _findCharForSub(sub);
  const discs = subChar?.disciplines || {};
  if (!(discs['Theban Sorcery'] || discs.Theban)) return 0;
  const resp = sub.responses || {};
  const count = parseInt(resp['sorcery_slot_count'] || '1', 10);
  let total = 0;
  for (let n = 1; n <= count; n++) {
    if (resp[`sorcery_${n}_rite`]) total += riteCost({ tradition: 'Theban' }).wp;
  }
  return total;
}

function _getRiteLevel(riteName) {
  const db = _getRulesDB();
  if (db) {
    const r = db.find(r => r.category === 'rite' && r.name === riteName);
    if (r?.rank) return r.rank;
  }
  for (const char of characters) {
    const p = (char.powers || []).find(p => p.category === 'rite' && p.name === riteName);
    if (p?.level) return p.level;
  }
  return null;
}

/**
 * Compute the ritual dice pool total for a character: attr + skill + tradition disc.
 */
function _computeRitePool(char, attr, skill, disc) {
  if (!char) return 0;
  const discEntry = disc ? _charDiscsArray(char).find(d => d.name === disc) : null;
  return (getAttrVal(char, attr) || 0)
       + (skTotal(char, skill)   || 0)
       + (discEntry?.dots || 0);
}

/**
 * Read the rules DB synchronously from localStorage (key: 'tm_rules_db').
 */
function _getRulesDB() {
  try {
    const raw = localStorage.getItem('tm_rules_db');
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

// ── Narrative Output Authoring (Story 1.7) ───────────────────────────────────

const NARR_BLOCKS = [
  {
    key: 'letter_from_home',
    label: 'Letter from Home',
    hint: 'A reply from an NPC to the character. Never from the character. Character moments only, no plot hooks.',
  },
  {
    key: 'touchstone_vignette',
    label: 'Touchstone Vignette',
    hint: 'Second person, present tense. In-person contact only. Living mortal as primary. First referent cannot be a pronoun.',
  },
  {
    key: 'territory_report',
    label: 'Territory Report',
    hint: 'What the character observed in their operating territory this cycle.',
  },
  {
    key: 'intelligence_dossier',
    label: 'Intelligence Dossier',
    hint: 'General intel by sphere, Cacophony Savvy, mystical visions, rumours. Check thresholds — do not reveal beyond what was earned.',
  },
];

const NARR_KEYS = NARR_BLOCKS.map(b => b.key);

const STYLE_RULES = [
  'No success counts, discipline names, or mechanical terms in player-facing prose.',
  'No editorialising about what results mean.',
  'No stacked declaratives — fold short sentences together.',
  'No negative framing openers — start with what the character found, not what they didn\'t.',
  'Never dictate what a player has chosen, felt, or done.',
];

// ── DT-1: Downtime Export Packet ─────────────────────────────────────────────

function renderExportRow(s) {
  return `<div class="dt-export-row">
    <button class="dt-btn dt-export-btn" data-sub-id="${s._id}">Export Packet</button>
    <span class="dt-export-hint">Download this character's downtime data as Markdown for Claude</span>
  </div>`;
}

function downloadMd(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function resolveConflict(v) {
  return { Monstrous: 'Intimidation', Seductive: 'Manipulation', Competitive: 'Superiority' }[v] || v;
}

function resolveRole(v) {
  return {
    ruler: 'Ruler', primogen: 'Primogen', administrator: 'Administrator',
    regent: 'Regent', socialite: 'Socialite', enforcer: 'Enforcer', none_yet: 'None yet',
  }[v] || v;
}

async function buildExportMd(sub, char, questResp) {
  const raw = sub._raw || {};
  const resp = sub.responses || {};
  const r = questResp?.responses || {};
  const projects = raw.projects || [];
  const projResolved = sub.projects_resolved || [];
  let _exportContactReqs = raw.contact_actions?.requests || [];
  if (!_exportContactReqs.length) {
    const cl = [];
    for (let n = 1; n <= 5; n++) { const rr = resp[`contact_${n}_request`] || resp[`contact_${n}`]; if (!rr) continue; cl.push(rr); }
    _exportContactReqs = cl;
  }
  const meritActions = [
    ...(raw.sphere_actions || []),
    ..._exportContactReqs.map(req => ({ merit_type: 'Contacts', action_type: 'Gather Info', description: req })),
    ...((raw.retainer_actions?.actions || []).map(req => ({ merit_type: 'Retainer', action_type: 'Directed Action', description: req }))),
  ];
  const meritResolved = sub.merit_actions_resolved || [];
  const feed = raw.feeding || {};

  const name = char ? dropdownName(char) : (sub.character_name || 'Unknown');
  let md = `# ${name}\n`;

  // Identity
  if (char) {
    const clanParts = [char.clan, char.bloodline].filter(Boolean).join(' / ');
    const lineParts = [clanParts, char.covenant].filter(Boolean);
    if (lineParts.length) md += `*${lineParts.join(' \u00B7 ')}*`;
    if (char.blood_potency) md += ` \u00B7 Blood Potency ${char.blood_potency}`;
    md += '\n';
    const identity = [];
    if (char.mask)  identity.push(`**Mask:** ${char.mask}`);
    if (char.dirge) identity.push(`**Dirge:** ${char.dirge}`);
    if (identity.length) md += identity.join(' \u00B7 ') + '\n';
    if (char.date_of_embrace) {
      const d = new Date(char.date_of_embrace + 'T00:00:00');
      md += `**Embraced:** ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}\n`;
    }
    if (char.humanity !== undefined) md += `**Humanity:** ${char.humanity}\n`;
  }
  md += '\n';

  // Motivations (from questionnaire)
  const motivations = [
    r.court_motivation  && `**Why Court?** ${r.court_motivation}`,
    r.ambitions_sydney  && `**Goals in Sydney:** ${r.ambitions_sydney}`,
    r.conflict_approach && `**Conflict Approach:** ${resolveConflict(r.conflict_approach)}`,
    r.aspired_role_tag  && `**Aspired Role:** ${resolveRole(r.aspired_role_tag)}`,
  ].filter(Boolean);
  if (motivations.length) md += `## Motivations\n${motivations.join('\n')}\n\n`;

  // Connections (from questionnaire)
  const connBlocks = [];
  if (r.allies_characters?.length) {
    const list = Array.isArray(r.allies_characters) ? r.allies_characters.join(', ') : r.allies_characters;
    let b = `**Allied PCs:** ${list}`;
    if (r.allies) b += `\n> ${r.allies}`;
    connBlocks.push(b);
  }
  if (r.coterie_characters?.length) {
    const list = Array.isArray(r.coterie_characters) ? r.coterie_characters.join(', ') : r.coterie_characters;
    let b = `**Coterie:** ${list}`;
    if (r.coterie) b += `\n> ${r.coterie}`;
    connBlocks.push(b);
  }
  if (r.enemies_characters?.length) {
    const list = Array.isArray(r.enemies_characters) ? r.enemies_characters.join(', ') : r.enemies_characters;
    let b = `**Rivals/Enemies:** ${list}`;
    if (r.enemies) b += `\n> ${r.enemies}`;
    connBlocks.push(b);
  }
  if (connBlocks.length) md += `## Connections\n${connBlocks.join('\n\n')}\n\n`;

  // Actions
  if (projects.length) {
    md += '## Actions\n';
    projects.forEach((proj, i) => {
      const res = projResolved[i];
      md += `\n### ${i + 1}. ${proj.action_type || 'Action'}\n`;
      if (proj.territory) md += `**Territory:** ${proj.territory}\n`;
      if (proj.desired_outcome) md += `**Intent:** ${proj.desired_outcome}\n`;
      if (proj.description && proj.description !== proj.desired_outcome) md += `**Description:** ${proj.description}\n`;
      if (res?.pool) md += `**Pool:** ${res.pool.expression || String(res.pool.total)}\n`;
      if (res?.roll) {
        const roll = res.roll;
        md += `**Result:** ${roll.successes} ${roll.successes === 1 ? 'success' : 'successes'}${roll.exceptional ? ' (exceptional)' : ''}\n`;
        if (roll.dice_string) md += `**Dice:** ${roll.dice_string}\n`;
      } else {
        md += `**Result:** pending\n`;
      }
      if (res?.st_note) md += `**ST Note:** ${res.st_note}\n`;
    });
    md += '\n';
  }

  // Feeding
  {
    md += '## Feeding\n';
    const method = feed.method || sub.responses?.['_feed_method'] || 'Not declared';
    md += `**Method:** ${method}\n`;
    const activeTerrs = Object.entries(feed.territories || {}).filter(([, v]) => v && v !== 'Not feeding here');
    if (activeTerrs.length) md += `**Territories:** ${activeTerrs.map(([t, v]) => `${t} (${v})`).join(', ')}\n`;
    const feedRoll = sub.feeding_roll;
    if (feedRoll?.params?.size) {
      const isRote = sub.st_review?.feeding_rote || feedRoll.params.rote || false;
      md += `**Pool:** ${feedRoll.params.size} dice${isRote ? ' \u2014 Rote quality' : ''}\n`;
    }
    if (feedRoll) {
      md += `**Result:** ${feedRoll.successes} ${feedRoll.successes === 1 ? 'success' : 'successes'}${feedRoll.exceptional ? ' (exceptional)' : ''} \u2014 ${feedRoll.successes * 2} Vitae safe\n`;
      if (feedRoll.dice_string) md += `**Dice:** ${feedRoll.dice_string}\n`;
    } else {
      md += `**Result:** pending\n`;
    }
    md += '\n';
  }

  // Merit Actions
  if (meritActions.length) {
    md += '## Merit Actions\n';
    meritActions.forEach((action, i) => {
      const res = meritResolved[i];
      md += `\n### ${action.merit_type} \u2014 ${action.action_type}\n`;
      if (action.description) md += `**Action:** ${action.description}\n`;
      if (res?.no_roll) {
        md += `**Result:** No roll required\n`;
        if (res.st_note) md += `**ST Note:** ${res.st_note}\n`;
      } else if (res?.roll) {
        const roll = res.roll;
        if (res.pool) md += `**Pool:** ${res.pool.expression || String(res.pool.total)}\n`;
        md += `**Result:** ${roll.successes} ${roll.successes === 1 ? 'success' : 'successes'}${roll.exceptional ? ' (exceptional)' : ''}\n`;
        if (roll.dice_string) md += `**Dice:** ${roll.dice_string}\n`;
        if (res.st_note) md += `**ST Note:** ${res.st_note}\n`;
      } else {
        md += `**Result:** pending\n`;
      }
    });
    md += '\n';
  }

  // ST Notes (private — included in export for ST use in Claude)
  if (sub.st_notes) md += `## ST Notes\n${sub.st_notes}\n\n`;

  return md.trim();
}

async function handleExportSingle(subId) {
  const sub = submissions.find(s => s._id === subId);
  if (!sub) return;
  const char = _findCharForSub(sub);
  let questResp = null;
  if (char) {
    try { questResp = await apiGet(`/api/questionnaire?character_id=${char._id}`); } catch { /* none */ }
  }
  const md = await buildExportMd(sub, char, questResp);
  const safeName = (sub.character_name || 'unknown').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  downloadMd(`downtime_${safeName}.md`, md);
}

async function handleExportAll() {
  if (!submissions.length) return;
  const sorted = [...submissions].sort((a, b) => (a.character_name || '').localeCompare(b.character_name || ''));
  // Load all questionnaire responses in parallel
  const questMap = {};
  await Promise.all(sorted.map(async sub => {
    const char = _findCharForSub(sub);
    if (char) {
      try { questMap[sub._id] = await apiGet(`/api/questionnaire?character_id=${char._id}`); } catch { /* none */ }
    }
  }));
  const parts = [];
  for (const sub of sorted) {
    const char = _findCharForSub(sub);
    parts.push(await buildExportMd(sub, char, questMap[sub._id] || null));
  }
  const cycleLabel = allCycles.find(c => c._id === selectedCycleId)?.label || 'downtime';
  const safeLabel = cycleLabel.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  downloadMd(`export_${safeLabel}_all.md`, parts.join('\n\n---\n\n'));
}

async function handleExportJson() {
  if (!submissions.length) return;
  const cycleLabel = allCycles.find(c => c._id === selectedCycleId)?.label || 'downtime';
  const safeLabel = cycleLabel.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const json = JSON.stringify(submissions, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backup_${safeLabel}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Mechanical Summary (Story 1.8) ───────────────────────────────────────────

function buildMechanicalDraft(sub) {
  const raw = sub._raw || {};
  const resp = sub.responses || {};
  const projects = raw.projects || [];
  const resolved = sub.projects_resolved || [];
  let _mechContactReqs = raw.contact_actions?.requests || [];
  if (!_mechContactReqs.length) {
    const cl = [];
    for (let n = 1; n <= 5; n++) { const r = resp[`contact_${n}_request`] || resp[`contact_${n}`]; if (!r) continue; cl.push(r); }
    _mechContactReqs = cl;
  }
  const meritActions = [
    ...(raw.sphere_actions || []),
    ..._mechContactReqs.map(r => ({ merit_type: 'Contacts', action_type: 'Gather Info', description: r })),
    ...((raw.retainer_actions?.actions || []).map(r => ({ merit_type: 'Retainer', action_type: 'Directed Action', description: r }))),
  ];
  const meritResolved = sub.merit_actions_resolved || [];

  let md = '';

  if (projects.length) {
    md += '## Projects\n';
    projects.forEach((proj, i) => {
      const res = resolved[i];
      md += `\n### ${i + 1}. ${proj.action_type || 'Action'}\n`;
      if (proj.desired_outcome) md += `**Desired:** ${proj.desired_outcome}\n`;
      if (res?.pool) md += `**Pool:** ${res.pool.expression || String(res.pool.total)}\n`;
      if (res?.roll) {
        const r = res.roll;
        md += `**Result:** ${r.successes} ${r.successes === 1 ? 'success' : 'successes'}${r.exceptional ? ' (exceptional)' : ''}\n`;
      } else {
        md += '**Result:** Pending\n';
      }
      if (res?.st_note) md += `**Note:** ${res.st_note}\n`;
    });
  }

  if (meritActions.length) {
    md += '\n## Merit Actions\n';
    meritActions.forEach((action, i) => {
      const res = meritResolved[i];
      md += `\n### ${action.merit_type} — ${action.action_type}\n`;
      if (action.description) md += `**Action:** ${action.description}\n`;
      if (res?.no_roll) {
        md += '**Result:** No roll required\n';
      } else if (res?.roll) {
        const r = res.roll;
        md += `**Pool:** ${res.pool?.expression || String(res.pool?.total)}\n`;
        md += `**Result:** ${r.successes} ${r.successes === 1 ? 'success' : 'successes'}${r.exceptional ? ' (exceptional)' : ''}\n`;
      } else {
        md += '**Result:** Pending\n';
      }
      if (res?.st_note) md += `**Note:** ${res.st_note}\n`;
    });
  }

  const fed = sub.feeding_roll;
  if (fed) {
    md += `\n## Feeding\n**Result:** ${fed.successes} ${fed.successes === 1 ? 'success' : 'successes'} — ${fed.successes * 2} Vitae safe\n`;
  }

  return md.trim() || '(No resolved actions yet — resolve projects and merit actions first.)';
}

function renderMechanicalSummaryPanel(s) {
  const summary = (s.st_review?.mechanical_summary || '').trim();
  let h = '<div class="dt-mech-detail">';
  h += '<div class="dt-feed-header">Resolution Summary</div>';
  if (summary) {
    h += `<div class="dt-mech-compiled">${esc(summary)}</div>`;
  } else {
    h += '<div class="dt-mech-compiled dt-mech-empty">No summary drafted yet. Use processing mode to auto-draft from resolved rolls.</div>';
  }
  h += '</div>';
  return h;
}

// ── Publish to Players (Story 1.9) ───────────────────────────────────────────

function renderPublishPanel(s) {
  const visibility = s.st_review?.outcome_visibility;
  const isReady = visibility === 'ready';
  const isPublished = visibility === 'published';
  const canReady = ['approved', 'modified'].includes(s.approval_status || '') && (s.st_review?.mechanical_summary || '').trim().length > 0;

  let h = '<div class="dt-publish-panel">';

  if (isPublished) {
    const when = s.st_review?.published_at
      ? new Date(s.st_review.published_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    h += `<div class="dt-pub-status"><span class="dt-pub-badge">&#x2713; Published to player</span>${when ? ` <span class="dt-pub-when">${esc(when)}</span>` : ''}</div>`;
  } else if (isReady) {
    const when = s.st_review?.ready_at
      ? new Date(s.st_review.ready_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    h += `<div class="dt-pub-status">
      <span class="dt-ready-badge">&#x23F3; Ready to publish</span>${when ? ` <span class="dt-pub-when">${esc(when)}</span>` : ''}
      <span class="dt-publish-hint">Will go live when next cycle starts</span>
    </div>`;
  } else {
    const narr = s.st_review?.narrative || {};
  
    const blocksReady = NARR_KEYS.filter(k => narr[k]?.status === 'ready').length;
    h += `<div class="dt-publish-row">`;
    h += `<button class="dt-btn dt-publish-btn${canReady ? ' dt-publish-ready' : ''}" data-sub-id="${esc(s._id)}"
      ${!canReady ? 'disabled title="Requires approved status + resolution summary"' : ''}>
      Mark Ready to Publish
    </button>`;
    h += `<span class="dt-publish-status">${blocksReady}/4 narrative blocks ready &middot; ${canReady ? 'Ready to mark' : 'Needs approval + summary'}</span>`;
    h += '</div>';
  }

  h += '</div>';
  return h;
}

async function handlePublish(sub) {
  const narr = sub.st_review?.narrative || {};

  const emptyBlocks = NARR_BLOCKS.filter(b => !(narr[b.key]?.text || '').trim());

  let confirmMsg = `Mark downtime results for ${sub.character_name} as ready to publish?\n\nResults will go live for the player when the next cycle starts.`;
  if (emptyBlocks.length) {
    confirmMsg += `\n\nThe following narrative blocks are empty and will be omitted:\n${emptyBlocks.map(b => '  \u2022 ' + b.label).join('\n')}`;
  }
  if (!confirm(confirmMsg)) return;

  // Assemble outcome_text from all blocks + mechanical summary
  let outcomeText = '';
  for (const block of NARR_BLOCKS) {
    const text = (narr[block.key]?.text || '').trim();
    if (text) outcomeText += `## ${block.label}\n\n${text}\n\n`;
  }
  const mechSummary = (sub.st_review?.mechanical_summary || '').trim();
  if (mechSummary) outcomeText += `## Mechanical Outcomes\n\n${mechSummary}\n`;

  try {
    await updateSubmission(sub._id, {
      'st_review.outcome_text': outcomeText.trim(),
      'st_review.outcome_visibility': 'ready',
      'st_review.ready_at': new Date().toISOString(),
    });
    if (!sub.st_review) sub.st_review = {};
    sub.st_review.outcome_text = outcomeText.trim();
    sub.st_review.outcome_visibility = 'ready';
    sub.st_review.ready_at = new Date().toISOString();
    renderMatchSummary();
    renderSubmissions();
  } catch (err) {
    alert('Mark ready failed: ' + err.message);
  }
}

// ── Investigation Tracker (Story 1.5) ────────────────────────────────────────

const THRESHOLD_TYPES = [
  { id: 'public_identity', label: 'Public Identity', default: 5 },
  { id: 'hidden_identity', label: 'Hidden Identity', default: 10 },
  { id: 'private_activity', label: 'Private Activity', default: 10 },
  { id: 'haven', label: 'Haven (+ Security)', default: 10 },
  { id: 'touchstone', label: 'Touchstone', default: 15 },
  { id: 'bloodline', label: 'Bloodline', default: 15 },
];

let investigations = [];
let invPanelOpen = true;

async function loadInvestigations(cycleId) {
  if (!cycleId) { investigations = []; return; }
  try {
    investigations = await apiGet(`/api/downtime_investigations?cycle_id=${cycleId}`);
  } catch { investigations = []; }
}

function renderInvestigations() {
  const el = document.getElementById('dt-investigations');
  if (!el) return;

  let h = '<div class="dt-inv-panel">';
  h += `<div class="dt-matrix-toggle" id="dt-inv-toggle">${invPanelOpen ? '\u25BC' : '\u25BA'} Investigations <span class="domain-count">${investigations.length}</span></div>`;

  if (invPanelOpen) {
    h += '<div class="dt-inv-body">';

    // New investigation form
    h += `<details class="dt-inv-new-wrap"><summary class="dt-btn dt-summary-btn">+ New Investigation</summary>`;
    h += '<div class="dt-inv-form">';
    h += `<input class="dt-inv-input" id="dt-inv-target" placeholder="Target (name or description)">`;
    h += '<div class="dt-inv-row">';
    h += `<select class="dt-pool-sel" id="dt-inv-type">`;
    for (const t of THRESHOLD_TYPES) h += `<option value="${esc(t.id)}">${esc(t.label)} (${t.default})</option>`;
    h += '</select>';
    h += `<input class="dt-pool-mod" type="number" id="dt-inv-custom" placeholder="Override threshold" title="Override threshold">`;
    h += `<input class="dt-inv-input" id="dt-inv-investigator" placeholder="Investigating character" style="flex:1">`;
    h += `<button class="dt-btn" id="dt-inv-create">Create</button>`;
    h += '</div></div></details>';

    if (investigations.length === 0) {
      h += '<p class="dt-empty-msg">No active investigations.</p>';
    } else {
      for (const inv of investigations) {
        const pct = Math.min(100, Math.round((inv.successes_accumulated / inv.threshold) * 100));
        const isResolved = inv.status === 'resolved';
        h += `<div class="dt-inv-item${isResolved ? ' dt-inv-resolved' : ''}">`;
        h += `<div class="dt-inv-header">`;
        h += `<span class="dt-inv-target">${esc(inv.target_description)}</span>`;
        const tLabel = THRESHOLD_TYPES.find(t => t.id === inv.threshold_type)?.label || inv.threshold_type;
        h += ` <span class="dt-inv-type-badge">${esc(tLabel)}</span>`;
        if (isResolved) h += ' <span class="dt-proj-done-badge">\u2713 Resolved</span>';
        h += '</div>';
        if (inv.investigating_character_id) h += `<div class="dt-inv-investigator">Investigator: ${esc(inv.investigating_character_id)}</div>`;

        // Progress bar
        h += `<div class="dt-inv-progress-wrap">`;
        h += `<div class="dt-inv-progress-bar" style="width:${pct}%"></div>`;
        h += `<span class="dt-inv-progress-label">${inv.successes_accumulated} / ${inv.threshold} successes</span>`;
        h += '</div>';

        if (!isResolved) {
          h += `<div class="dt-inv-add-row">`;
          h += `<input class="dt-pool-mod" type="number" min="1" value="1" id="dt-inv-add-${esc(inv._id)}" title="Successes to add">`;
          h += `<input class="dt-inv-input" id="dt-inv-note-${esc(inv._id)}" placeholder="Note (source, roll)" style="flex:1">`;
          h += `<button class="dt-btn dt-inv-add-btn" data-inv-id="${esc(inv._id)}">Add successes</button>`;
          h += `<button class="dt-btn dt-btn-muted dt-inv-resolve-btn" data-inv-id="${esc(inv._id)}">Mark resolved</button>`;
          h += '</div>';
        }

        if (inv.notes?.length) {
          h += '<div class="dt-inv-notes">';
          for (const n of inv.notes.slice(-3)) {
            const when = n.added_at ? new Date(n.added_at).toLocaleDateString('en-GB') : '';
            h += `<div class="dt-inv-note-entry">${when ? `<span class="dt-inv-note-when">${when}</span> ` : ''}${esc(n.text)}${n.successes_added ? ` (+${n.successes_added})` : ''}</div>`;
          }
          h += '</div>';
        }

        h += '</div>';
      }
    }

    h += '</div>';
  }

  h += '</div>';
  el.innerHTML = h;

  document.getElementById('dt-inv-toggle')?.addEventListener('click', () => {
    invPanelOpen = !invPanelOpen;
    renderInvestigations();
  });

  document.getElementById('dt-inv-create')?.addEventListener('click', async () => {
    const target = document.getElementById('dt-inv-target')?.value.trim();
    const thresholdType = document.getElementById('dt-inv-type')?.value;
    const customThreshold = document.getElementById('dt-inv-custom')?.value;
    const investigator = document.getElementById('dt-inv-investigator')?.value.trim();
    if (!target) return;
    try {
      await apiPost('/api/downtime_investigations', {
        target_description: target,
        threshold_type: thresholdType,
        custom_threshold: customThreshold ? +customThreshold : undefined,
        investigating_character_id: investigator || null,
        cycle_id: selectedCycleId,
      });
      await loadInvestigations(selectedCycleId);
      renderInvestigations();
    } catch (err) { console.error('Create investigation error:', err.message); }
  });

  el.querySelectorAll('.dt-inv-add-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const invId = btn.dataset.invId;
      const successes = +document.getElementById(`dt-inv-add-${invId}`)?.value || 1;
      const note = document.getElementById(`dt-inv-note-${invId}`)?.value.trim() || '';
      try {
        const updated = await apiPut(`/api/downtime_investigations/${invId}`, { add_successes: successes, note_text: note || undefined });
        const idx = investigations.findIndex(i => i._id === invId);
        if (idx >= 0) investigations[idx] = updated;
        renderInvestigations();
      } catch (err) { console.error('Add successes error:', err.message); }
    });
  });

  el.querySelectorAll('.dt-inv-resolve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const invId = btn.dataset.invId;
      try {
        const updated = await apiPut(`/api/downtime_investigations/${invId}`, { status: 'resolved' });
        const idx = investigations.findIndex(i => i._id === invId);
        if (idx >= 0) investigations[idx] = updated;
        renderInvestigations();
      } catch (err) { console.error('Resolve investigation error:', err.message); }
    });
  });
}

// ── Submission Checklist (feature.55) ───────────────────────────────────────

const CHK_SECTIONS = [
  { key: 'travel',       label: 'Travel'   },
  { key: 'bs_1',         label: 'BS1' },
  { key: 'bs_2',         label: 'BS2' },
  { key: 'bs_3',         label: 'BS3' },
  { key: 'bs_4',         label: 'BS4' },
  { key: 'feeding',      label: 'Feed'     },
  { key: 'project_1',    label: 'P1' },
  { key: 'project_2',    label: 'P2' },
  { key: 'project_3',    label: 'P3' },
  { key: 'project_4',    label: 'P4' },
  { key: 'allies_1',     label: 'A1' },
  { key: 'allies_2',     label: 'A2' },
  { key: 'allies_3',     label: 'A3' },
  { key: 'allies_4',     label: 'A4' },
  { key: 'allies_5',     label: 'A5' },
  { key: 'status_1',     label: 'S1' },
  { key: 'status_2',     label: 'S2' },
  { key: 'status_3',     label: 'S3' },
  { key: 'retainers_1',  label: 'R1' },
  { key: 'retainers_2',  label: 'R2' },
  { key: 'retainers_3',  label: 'R3' },
  { key: 'contacts_1',   label: 'C1' },
  { key: 'contacts_2',   label: 'C2' },
  { key: 'contacts_3',   label: 'C3' },
  { key: 'contacts_4',   label: 'C4' },
  { key: 'contacts_5',   label: 'C5' },
  { key: 'resources',    label: 'Acquisitions' },
];

/**
 * Returns the flat merit_actions array for a submission.
 * Order: spheres → contacts → retainers (mirrors buildProcessingQueue).
 * Uses sub.merit_actions if already built; otherwise reconstructs from _raw / responses.
 * NFR-DS-01: no import from downtime-story.js.
 */
function _getSubMeritActions(sub) {
  if (sub.merit_actions?.length) return sub.merit_actions;
  const raw  = sub._raw    || {};
  const resp = sub.responses || {};
  const result = [];
  // spheres
  const spheres = raw.sphere_actions || [];
  if (spheres.length) {
    spheres.forEach((a, i) => result.push({ merit_type: resp[`sphere_${i + 1}_merit`] || a.merit_type || '', action_type: a.action_type || '' }));
  } else {
    for (let n = 1; n <= 5; n++) {
      const mt = resp[`sphere_${n}_merit`];
      if (mt) result.push({ merit_type: mt, action_type: resp[`sphere_${n}_action`] || '' });
    }
  }
  // contacts
  const contactRaw = raw.contact_actions?.requests || [];
  if (contactRaw.length) {
    contactRaw.forEach(() => result.push({ merit_type: 'Contacts', action_type: '' }));
  } else {
    for (let n = 1; n <= 5; n++) { if (resp[`contact_${n}_request`]) result.push({ merit_type: 'Contacts', action_type: '' }); }
  }
  // retainers
  const retainerRaw = raw.retainer_actions?.actions || [];
  if (retainerRaw.length) {
    retainerRaw.forEach(() => result.push({ merit_type: 'Retainer', action_type: '' }));
  } else {
    for (let n = 1; n <= 4; n++) { if (resp[`retainer_${n}_task`]) result.push({ merit_type: 'Retainer', action_type: '' }); }
  }
  return result;
}

/**
 * Returns a map of global merit_actions_resolved indices per category:
 *   { allies: [0, 3], status: [1], retainers: [2], contacts: [4, 5] }
 * Cached per sub._id on the sub object itself to avoid repeated iteration.
 */
function _buildMeritSlotMap(sub) {
  if (sub._chkSlotMap) return sub._chkSlotMap;
  const actions = _getSubMeritActions(sub);
  const map = { allies: [], status: [], retainers: [], contacts: [] };
  actions.forEach((a, i) => {
    const cat = _parseMeritType(a.merit_type || '').category;
    if      (cat === 'allies')                           map.allies.push(i);
    else if (cat === 'status')                           map.status.push(i);
    else if (cat === 'retainer' || cat === 'staff')      map.retainers.push(i);
    else if (cat === 'contacts')                         map.contacts.push(i);
  });
  sub._chkSlotMap = map;
  return map;
}

function _chkHasContent(sub, key) {
  if (!sub) return false;
  const raw  = sub._raw || {};
  const resp = sub.responses || {};

  const alliesM    = key.match(/^allies_(\d+)$/);
  const statusM    = key.match(/^status_(\d+)$/);
  const retainersM = key.match(/^retainers_(\d+)$/);
  const contactsM  = key.match(/^contacts_(\d+)$/);

  if (alliesM)    return _buildMeritSlotMap(sub).allies[parseInt(alliesM[1]) - 1]    !== undefined;
  if (statusM)    return _buildMeritSlotMap(sub).status[parseInt(statusM[1]) - 1]    !== undefined;
  if (retainersM) return _buildMeritSlotMap(sub).retainers[parseInt(retainersM[1]) - 1] !== undefined;
  if (contactsM)  return _buildMeritSlotMap(sub).contacts[parseInt(contactsM[1]) - 1]  !== undefined;

  const bsM = key.match(/^bs_(\d+)$/);
  if (bsM) return !!(resp[`sorcery_${bsM[1]}_rite`]);

  switch (key) {
    case 'travel':    return !!(raw.submission?.narrative?.travel_description || resp.travel);
    case 'feeding':   return !!(raw.feeding?.method || resp['_feed_method']);
    case 'project_1': return !!(resp.project_1_action || raw.projects?.[0]);
    case 'project_2': return !!(resp.project_2_action || raw.projects?.[1]);
    case 'project_3': return !!(resp.project_3_action || raw.projects?.[2]);
    case 'project_4': return !!(resp.project_4_action || raw.projects?.[3]);
    case 'resources': return !!(raw.acquisitions?.resource_acquisitions || resp.resources_acquisitions);
    default:          return false;
  }
}

/** Return tooltip text describing what a specific merit slot contains. */
function _chkTooltip(sub, key) {
  if (!sub) return '';
  const actions = _getSubMeritActions(sub);
  const map = _buildMeritSlotMap(sub);

  const alliesM    = key.match(/^allies_(\d+)$/);
  const statusM    = key.match(/^status_(\d+)$/);
  const retainersM = key.match(/^retainers_(\d+)$/);
  const contactsM  = key.match(/^contacts_(\d+)$/);

  if (alliesM || statusM || retainersM) {
    const [, n] = (alliesM || statusM || retainersM);
    const cat    = alliesM ? 'allies' : statusM ? 'status' : 'retainers';
    const gIdx   = map[cat][parseInt(n) - 1];
    if (gIdx === undefined) return '';
    const a = actions[gIdx];
    if (!a) return '';
    return a.action_type ? `${a.merit_type}: ${a.action_type}` : a.merit_type || '';
  }

  if (contactsM) {
    const n   = parseInt(contactsM[1]);
    const raw = sub._raw || {};
    const resp = sub.responses || {};
    const req = raw.contact_actions?.requests?.[n - 1] || resp[`contact_${n}_request`] || '';
    if (!req) return '';
    const typeMatch = req.match(/Contact Type:\s*([^\n]+)/i);
    return typeMatch ? `Contact: ${typeMatch[1].trim()}` : 'Contact';
  }

  return '';
}

// _chkState returns one of:
//   'empty'     — section not present in this submission
//   'unsighted' — present but ST hasn't touched it          O
//   'no_action' — reviewed; skipped / no valid action       X
//   'confirmed' — pool validated or fully signed off        ★
//   'sighted'   — manually marked in-progress              ?
const _CHK_TERMINAL_STATUSES = new Set(['no_effect', 'resolved', 'no_action', 'no_roll', 'skipped', 'maintenance']);

function _chkState(sub, key) {
  if (!_chkHasContent(sub, key)) return 'empty';

  // ── Travel ──
  if (key === 'travel') {
    if (DONE_STATUSES.has(sub.st_review?.travel_discretion)) return 'confirmed';
  }

  // ── Feeding ──
  if (key === 'feeding') {
    const fr = sub.feeding_review || {};
    const ps = fr.pool_status;
    if (ps === 'no_feed')                        return 'no_action';
    if (sub.feeding_roll || ps === 'validated')  return 'confirmed';
  }

  // ── Projects ──
  const projM = key.match(/^project_(\d+)$/);
  if (projM) {
    const slot = parseInt(projM[1]) - 1;
    const pr   = (sub.projects_resolved || [])[slot] || {};
    const ps   = pr.pool_status;
    const rawProjType = pr.action_type_override
      || (sub._raw?.projects || [])[slot]?.action_type
      || sub.responses?.[`project_${slot + 1}_action`]
      || '';
    if (_CHK_TERMINAL_STATUSES.has(ps)) return 'no_action';
    if (rawProjType === 'no_action_taken')        return 'no_action';
    if (ps === 'validated')                       return 'confirmed';
  }

  // ── Merit slots: Allies / Status / Retainers / Contacts ──
  const alliesM    = key.match(/^allies_(\d+)$/);
  const statusM    = key.match(/^status_(\d+)$/);
  const retainersM = key.match(/^retainers_(\d+)$/);
  const contactsM  = key.match(/^contacts_(\d+)$/);

  if (alliesM || statusM || retainersM || contactsM) {
    const resolved = sub.merit_actions_resolved || [];
    const map      = _buildMeritSlotMap(sub);
    let gIdx;
    if (alliesM)    gIdx = map.allies[parseInt(alliesM[1]) - 1];
    else if (statusM)    gIdx = map.status[parseInt(statusM[1]) - 1];
    else if (retainersM) gIdx = map.retainers[parseInt(retainersM[1]) - 1];
    else                 gIdx = map.contacts[parseInt(contactsM[1]) - 1];
    if (gIdx !== undefined) {
      const ps = resolved[gIdx]?.pool_status;
      if (ps === 'skipped' || ps === 'no_action' || ps === 'no_roll' || ps === 'maintenance') return 'no_action';
      if (ps === 'confirmed' || ps === 'rolled' || ps === 'resolved' || ps === 'no_effect')   return 'confirmed';
    }
  }

  // ── Blood Sorcery / Rituals ──
  const bsM = key.match(/^bs_(\d+)$/);
  if (bsM) {
    const n  = parseInt(bsM[1]);
    const ps = (sub.sorcery_review || {})[n]?.pool_status;
    if (ps === 'skipped' || ps === 'no_action') return 'no_action';
    if (DONE_STATUSES.has(ps)) return 'confirmed';
  }

  // ── Resources acquisition ──
  if (key === 'resources') {
    const ps = sub.st_review?.actions?.['acq:resources']?.pool_status;
    if (ps === 'skipped' || ps === 'no_action' || ps === 'no_roll' || ps === 'maintenance') return 'no_action';
    if (ps === 'confirmed' || ps === 'rolled' || ps === 'resolved' || ps === 'no_effect')   return 'confirmed';
  }

  if (sub?.st_review?.sighted?.[key]) return 'sighted';
  return 'unsighted';
}

/** Map a checklist section key to its processing queue entry.key, or null if no queue entry exists. */
function _chkNavKey(sub, section) {
  if (!sub) return null;
  if (section === 'feeding')   return `${sub._id}:feeding`;
  if (section === 'resources') return `${sub._id}:acq:resources`;

  const bsM = section.match(/^bs_(\d+)$/);
  if (bsM) return `${sub._id}:sorcery:${bsM[1]}`;

  const projM = section.match(/^project_(\d+)$/);
  if (projM) return `${sub._id}:proj:${parseInt(projM[1]) - 1}`;

  const alliesM    = section.match(/^allies_(\d+)$/);
  const statusM    = section.match(/^status_(\d+)$/);
  const retainersM = section.match(/^retainers_(\d+)$/);
  const contactsM  = section.match(/^contacts_(\d+)$/);

  if (alliesM || statusM || retainersM || contactsM) {
    const map = _buildMeritSlotMap(sub);
    let gIdx;
    if (alliesM)         gIdx = map.allies[parseInt(alliesM[1]) - 1];
    else if (statusM)    gIdx = map.status[parseInt(statusM[1]) - 1];
    else if (retainersM) gIdx = map.retainers[parseInt(retainersM[1]) - 1];
    else                 gIdx = map.contacts[parseInt(contactsM[1]) - 1];
    if (gIdx !== undefined) return `${sub._id}:merit:${gIdx}`;
  }

  return null;
}

function renderSubmissionChecklist() {
  const el = document.getElementById('dt-feeding-scene');
  if (!el) return;

  const activeChars = characters.filter(c => !c.retired);
  if (!activeChars.length) { el.innerHTML = ''; return; }

  const subByCharId = new Map();
  for (const s of submissions) {
    const char = _findCharForSub(s);
    if (char) subByCharId.set(String(char._id), s);
  }

  const isOpen = el.dataset.open !== 'false';
  const sorted = [...activeChars].sort((a, b) => sortName(a).localeCompare(sortName(b)));

  // Count how many chars have all present sections confirmed or skipped (no remaining O/?).
  let fullySighted = 0;
  const submittedCount = sorted.filter(c => subByCharId.has(String(c._id))).length;
  for (const char of sorted) {
    const sub = subByCharId.get(String(char._id)) || null;
    if (!sub) continue;
    const allDone = CHK_SECTIONS.every(sec => {
      const st = _chkState(sub, sec.key);
      return st === 'empty' || st === 'no_action' || st === 'confirmed';
    });
    if (allDone) fullySighted++;
  }

  // Action progress \u2014 build queue to get live done/total counts
  const _chkQueue = submissions.length ? buildProcessingQueue(submissions) : [];
  const totalActions = _chkQueue.length;
  const doneActions  = _chkQueue.filter(e => DONE_STATUSES.has(getEntryReview(e)?.pool_status)).length;

  let h = '<div class="dt-chk-panel">';
  h += `<div class="dt-chk-toggle" id="dt-chk-toggle">${isOpen ? '\u25BC' : '\u25BA'} Submission Checklist`;
  h += ` <span class="domain-count">${doneActions}\u202F/\u202F${totalActions} actions</span>`;
  h += ` <span class="domain-count">${fullySighted}\u202F/\u202F${submittedCount} players</span>`;
  h += ` <span class="dt-chk-legend">\u2605\u202Fcomplete &nbsp; O\u202Fvalid &nbsp; ?\u202Fpending &nbsp; X\u202Fskipped &nbsp; \u2014\u202Fn/a</span>`;
  h += `</div>`;

  if (isOpen) {
    h += '<div class="dt-chk-wrap"><table class="dt-chk-table"><thead><tr>';
    h += '<th class="dt-chk-name-col">Character</th>';
    for (const sec of CHK_SECTIONS) h += `<th title="${esc(sec.key)}">${esc(sec.label)}</th>`;
    h += '</tr></thead><tbody>';

    for (const char of sorted) {
      const charId = String(char._id);
      const sub = subByCharId.get(charId) || null;
      const hasSub = !!sub;
      const rowCls = hasSub ? '' : ' dt-chk-nosub';

      h += `<tr class="${rowCls}">`;
      h += `<td class="dt-chk-name">${esc(sortName(char))}`;
      if (!hasSub) h += ' <span class="dt-chk-nosub-badge">No submission</span>';
      h += '</td>';

      for (const sec of CHK_SECTIONS) {
        const state  = _chkState(sub, sec.key);
        const tip    = _chkTooltip(sub, sec.key);
        const navKey = state !== 'empty' ? _chkNavKey(sub, sec.key) : null;
        const navA   = navKey ? ` data-chk-nav-key="${esc(navKey)}"` : '';
        const navCls = navKey ? ' dt-chk-nav' : '';
        const jump   = navKey ? ' \u2014 click to jump' : '';
        const tipPfx = tip ? esc(tip) + ' \u2014 ' : '';
        if (state === 'empty') {
          h += `<td class="dt-chk-empty"${tip ? ` title="${esc(tip)}"` : ''}>\u2014</td>`;
        } else if (state === 'confirmed') {
          h += `<td class="dt-chk-confirmed${navCls}" title="${tipPfx}Done${jump}"${navA}>\u2605</td>`;
        } else if (state === 'no_action') {
          h += `<td class="dt-chk-no-action${navCls}" title="${tipPfx}Skipped${jump}"${navA}>X</td>`;
        } else if (state === 'sighted') {
          h += `<td class="dt-chk-sighted dt-chk-cell${navCls}" data-sub-id="${esc(sub._id)}" data-section="${esc(sec.key)}" title="${tipPfx}Valid${jump} \u2014 Ctrl+click to unsight"${navA}>O</td>`;
        } else {
          h += `<td class="dt-chk-unsighted dt-chk-cell${navCls}" data-sub-id="${esc(sub._id)}" data-section="${esc(sec.key)}" title="${tipPfx}Pending${jump} \u2014 Ctrl+click to mark valid"${navA}>?</td>`;
        }
      }

      h += '</tr>';
    }

    h += '</tbody></table></div>';
  }

  h += '</div>';
  el.innerHTML = h;

  document.getElementById('dt-chk-toggle')?.addEventListener('click', () => {
    el.dataset.open = isOpen ? 'false' : 'true';
    renderSubmissionChecklist();
  });

  // Navigation — click any cell that has a linked queue entry
  el.querySelectorAll('.dt-chk-nav').forEach(cell => {
    cell.addEventListener('click', e => {
      if (e.ctrlKey) return; // Ctrl+click handled by sighted toggle below
      const navKey = cell.dataset.chkNavKey;
      if (!navKey) return;
      procExpandedKeys.add(navKey);
      const procContainer = document.getElementById('dt-submissions');
      if (!procContainer) return;
      renderProcessingMode(procContainer);
      requestAnimationFrame(() => {
        const entryEl = procContainer.querySelector(`.proc-action-row[data-proc-key="${CSS.escape(navKey)}"]`);
        (entryEl || procContainer).scrollIntoView({ behavior: 'smooth', block: entryEl ? 'center' : 'start' });
      });
    });
  });

  // Sighted toggle — Ctrl+click on pending/sighted cells
  el.querySelectorAll('.dt-chk-cell').forEach(cell => {
    cell.addEventListener('click', async e => {
      if (!e.ctrlKey) return; // navigation handled above
      const subId   = cell.dataset.subId;
      const section = cell.dataset.section;
      if (!subId || !section) return;
      const sub = submissions.find(s => s._id === subId);
      if (!sub) return;
      const current = sub?.st_review?.sighted?.[section] || false;
      const next = !current;
      await updateSubmission(subId, { [`st_review.sighted.${section}`]: next });
      if (!sub.st_review) sub.st_review = {};
      if (!sub.st_review.sighted) sub.st_review.sighted = {};
      sub.st_review.sighted[section] = next;
      renderSubmissionChecklist();
    });
  });
}

// ── Feeding Scene Summary (GC-2) ────────────────────────────────────────────

/** Derive the primary feeding territory (resident > poacher) from a submission's territory grid. */
function getPrimaryTerritory(sub) {
  if (!sub?.responses?.feeding_territories) return null;
  let grid;
  try { grid = JSON.parse(sub.responses.feeding_territories); } catch { return null; }
  // Prefer feeding_rights, fall back to poaching (include legacy values)
  for (const status of ['feeding_rights', 'resident', 'poaching', 'poacher']) {
    for (const [key, val] of Object.entries(grid)) {
      if (val === status) {
        return FEEDING_TERRITORIES.find(t =>
          t.toLowerCase().replace(/[^a-z0-9]+/g, '_') === key
        ) || null;
      }
    }
  }
  return null;
}

/** Look up territory record by display name. Returns { ambience, ambienceMod } or null. */
function getTerritoryByName(terrName) {
  if (!terrName) return null;
  return TERRITORY_DATA.find(t =>
    terrName.toLowerCase().includes(t.name.toLowerCase().replace(/^the\s+/i, '')) ||
    t.name.toLowerCase().includes(terrName.toLowerCase().replace(/^the\s+/i, ''))
  ) || null;
}

/** Look up ambience string for a territory display name. */
function getTerritoryAmbienceByName(terrName) {
  return getTerritoryByName(terrName)?.ambience || null;
}

/** Build best generic pool (highest total across all methods) for a character with no submission. */
function bestGenericPool(char) {
  let best = null;
  for (const m of FEED_METHODS_DATA) {
    const p = buildFeedingPool(char, m.id, 0);
    if (p && (!best || p.total > best.total)) {
      best = { ...p, methodName: m.name };
    }
  }
  return best;
}

function renderFeedingScene() {
  const el = document.getElementById('dt-feeding-scene');
  if (!el) return;

  const activeChars = characters.filter(c => !c.retired);
  if (!activeChars.length) { el.innerHTML = ''; return; }

  // Build a map from character _id → submission for quick lookup
  const subByCharId = new Map();
  for (const s of submissions) {
    const char = _findCharForSub(s);
    if (char) subByCharId.set(String(char._id), s);
  }

  const isOpen = el.dataset.open !== 'false';
  const sorted = [...activeChars].sort((a, b) => sortName(a).localeCompare(sortName(b)));

  let h = '<div class="dt-scene-panel">';
  h += `<div class="dt-scene-toggle" id="dt-scene-toggle">${isOpen ? '\u25BC' : '\u25BA'} Feeding Scene Summary <span class="domain-count">${sorted.length} characters</span></div>`;

  if (isOpen) {
    h += '<table class="dt-scene-table">';
    h += '<thead><tr>';
    h += '<th>Character</th><th>Method</th><th>Territory</th><th>Ambience</th><th>Pool</th><th>Rote</th>';
    h += '</tr></thead><tbody>';

    for (const char of sorted) {
      const charId = String(char._id);
      const sub = subByCharId.get(charId) || null;
      const hasSub = !!sub;

      // Method
      const methodId = sub?.responses?.['_feed_method'] || null;
      const methodObj = FEED_METHODS_DATA.find(m => m.id === methodId);
      const methodName = methodObj?.name || (hasSub ? 'Other / Custom' : null);

      // Territory + ambience
      const territory = getPrimaryTerritory(sub);
      const terrRec = getTerritoryByName(territory);
      const ambience = terrRec?.ambience || null;
      const ambienceMod = terrRec?.ambienceMod ?? 0;
      const ambModStr = _fmtMod(ambienceMod);

      // Pool
      let poolTotal = '—';
      let poolNote = '';
      if (hasSub && methodId && methodObj) {
        // Issue #176 (fix loop 2 — Ma'at catch): pre-fix this passed
        // `ambienceMod` (territory ambience from `terrRec.ambienceMod`)
        // through `buildFeedingPool`'s misleadingly-named third parameter,
        // which summed it into the dice total. Per Damnation City §158
        // ambience is a Vitae yield modifier, not a dice pool component.
        // The summary table already surfaces ambience separately via
        // `ambModStr` rendered as a dedicated 'Ambience' column at line
        // 9773 + downstream, so there is no display regression — passing
        // `0` here just stops the dice double-count. Matches the
        // neutral-call pattern bestGenericPool uses at line 9716.
        const pool = buildFeedingPool(char, methodId, 0);
        poolTotal = pool ? pool.total : '?';
      } else if (!hasSub) {
        const best = bestGenericPool(char);
        if (best) { poolTotal = best.total; poolNote = best.methodName; }
      }

      // Rote flag (ST-set, stored on st_review)
      const rote = sub?.st_review?.feeding_rote || false;
      const rowClass = hasSub ? '' : ' dt-scene-nosub';

      h += `<tr class="dt-scene-row${rowClass}" data-char-id="${esc(charId)}">`;
      h += `<td class="dt-scene-name">${esc(dropdownName(char))}${!hasSub ? ' <span class="dt-scene-nosub-badge">No submission</span>' : ''}</td>`;
      h += `<td>${methodName ? esc(methodName) : '<span class="dt-scene-dim">\u2014</span>'}</td>`;
      h += `<td>${territory ? esc(territory) : '<span class="dt-scene-dim">\u2014</span>'}</td>`;
      h += `<td>${ambience ? `<span class="dt-scene-amb">${esc(ambience)} <span class="dt-scene-mod">(${ambModStr})</span></span>` : '<span class="dt-scene-dim">\u2014</span>'}</td>`;
      h += `<td class="dt-scene-pool">${poolTotal}${poolNote ? ` <span class="dt-scene-dim">(${esc(poolNote)})</span>` : ''}</td>`;
      h += `<td><label class="dt-scene-rote-lbl"><input type="checkbox" class="dt-scene-rote" data-sub-id="${esc(sub?._id || '')}" ${rote ? 'checked' : ''} ${!hasSub ? 'disabled' : ''}></label></td>`;
      h += '</tr>';
    }

    h += '</tbody></table>';
  }

  h += '</div>';
  el.innerHTML = h;

  document.getElementById('dt-scene-toggle')?.addEventListener('click', () => {
    el.dataset.open = isOpen ? 'false' : 'true';
    renderFeedingScene();
  });

  el.querySelectorAll('.dt-scene-rote').forEach(cb => {
    cb.addEventListener('change', async () => {
      const subId = cb.dataset.subId;
      if (!subId) return;
      const sub = submissions.find(s => s._id === subId);
      if (!sub) return;
      const val = cb.checked;
      await updateSubmission(subId, { 'st_review.feeding_rote': val });
      if (!sub.st_review) sub.st_review = {};
      sub.st_review.feeding_rote = val;
    });
  });
}

// ── Feeding Matrix (Story 1.4) ───────────────────────────────────────────────

// Ambience step ladder (index 0 = worst, index 8 = best)
const AMBIENCE_STEPS = ['Hostile', 'Barrens', 'Neglected', 'Untended', 'Settled', 'Tended', 'Curated', 'Verdant', 'The Rack'];

// Canonical territory columns for the matrix (CSV keys in feeding.territories)
const MATRIX_TERRS = [
  { csvKey: 'The Academy',              label: 'Academy',     ambienceKey: 'The Academy' },
  { csvKey: 'The Harbour',              label: 'Harbour',     ambienceKey: 'The Harbour' },
  { csvKey: 'The Dockyards',            label: 'Dockyards',   ambienceKey: 'The Dockyards' },
  { csvKey: 'The Second City',          label: 'Second City', ambienceKey: 'The Second City' },
  { csvKey: 'The North Shore',          label: 'North Shore', ambienceKey: 'The North Shore' },
  { csvKey: 'The Barrens (No Territory)', label: 'Barrens',   ambienceKey: null },
];

// Legacy territory name keys from old submissions stored in MongoDB
const LEGACY_TERR_KEY_MAP = {
  'The City Harbour':   'The Harbour',
  'The Northern Shore': 'The North Shore',
  'The Barrens':        'The Barrens (No Territory)',
};

function getTerritoryAmbience(ambienceKey) {
  if (!ambienceKey) return null;
  const td = TERRITORY_DATA.find(t => t.name === ambienceKey);
  if (!td) return null;
  // Prefer live DB record so matrix cap matches the ambience table (both use cachedTerritories).
  if (cachedTerritories?.length) {
    const dbRec = cachedTerritories.find(t => t.slug === td.slug || t.name === td.name);
    if (dbRec?.ambience) return dbRec.ambience;
  }
  return td.ambience;
}

/** Translate legacy territory keys in a raw territories object to canonical names. */
function _normTerrKeys(rawTerrs) {
  if (!rawTerrs) return {};
  const out = {};
  for (const [k, v] of Object.entries(rawTerrs)) {
    const canonical = LEGACY_TERR_KEY_MAP[k] ?? k;
    out[canonical] = v;
  }
  return out;
}

/** Return a display string of the player's nominated feeding territories (e.g. "Academy, Harbour").
 *  Returns null if no territories could be determined. */
function _playerFeedTerrsText(sub) {
  let terrs = null;
  if (sub?.responses?.feeding_territories) {
    try { terrs = JSON.parse(sub.responses.feeding_territories); } catch { terrs = null; }
  }
  const labels = [];
  if (terrs) {
    for (const [slug, status] of Object.entries(terrs)) {
      if (!status || status === 'none' || status === 'Not feeding here') continue;
      let tid;
      if (/^[a-f0-9]{24}$/i.test(slug)) {
        const terrDoc = (cachedTerritories || []).find(t => String(t._id) === slug);
        tid = terrDoc?.slug || null;
      } else {
        tid = Object.prototype.hasOwnProperty.call(TERRITORY_SLUG_MAP, slug) ? TERRITORY_SLUG_MAP[slug] : null;
      }
      if (!tid) continue;
      const mt = MATRIX_TERRS.find(m => TERRITORY_SLUG_MAP[m.csvKey] === tid);
      if (mt) labels.push(mt.label);
    }
  } else {
    // Legacy: _raw.feeding.territories (display-name keys)
    const rawTerrs = _normTerrKeys(sub?._raw?.feeding?.territories || {});
    for (const [csvKey, status] of Object.entries(rawTerrs)) {
      if (!status || status === 'Not feeding here' || status === 'none') continue;
      const mt = MATRIX_TERRS.find(m => m.csvKey === csvKey);
      if (mt) labels.push(mt.label);
    }
  }
  return labels.length > 0 ? labels.join(', ') : null;
}

/** Return a Map<csvKey, feedCount> for territories where this submission's character fed. */
function _getSubFedTerrs(sub) {
  const fed = new Map(); // csvKey → count (0–2; currently max 1 until Feed Action follow-up)
  let grid = null;

  // ST override takes priority: array of TERRITORY_DATA ids set via feeding pills.
  // Replaces the main feeding grid only — the rote grid still runs below.
  const overrideArr = sub.st_review?.territory_overrides?.feeding;
  const hasOverride = Array.isArray(overrideArr) && overrideArr.length > 0;
  if (hasOverride) {
    for (const tid of overrideArr) {
      if (!tid) continue;
      const mt = MATRIX_TERRS.find(m => TERRITORY_SLUG_MAP[m.csvKey] === tid);
      if (mt) fed.set(mt.csvKey, (fed.get(mt.csvKey) || 0) + 1);
    }
  }

  if (!hasOverride) {
    // Prefer responses.feeding_territories (slug keys — new form format)
    if (sub.responses?.feeding_territories) {
      try { grid = JSON.parse(sub.responses.feeding_territories); } catch { grid = null; }
    }

    if (grid) {
      for (const [slug, status] of Object.entries(grid)) {
        if (!status || status === 'none' || status === 'Not feeding here') continue;
        let tid;
        if (/^[a-f0-9]{24}$/i.test(slug)) {
          const terrDoc = (cachedTerritories || []).find(t => String(t._id) === slug);
          tid = terrDoc?.slug || null;
        } else {
          tid = Object.prototype.hasOwnProperty.call(TERRITORY_SLUG_MAP, slug) ? TERRITORY_SLUG_MAP[slug] : undefined;
        }
        if (!tid) continue;
        const mt = MATRIX_TERRS.find(m => TERRITORY_SLUG_MAP[m.csvKey] === tid);
        if (mt) fed.set(mt.csvKey, (fed.get(mt.csvKey) || 0) + 1);
      }
    } else {
      // Fallback: _raw.feeding.territories (display-name keys, legacy)
      const rawTerrs = _normTerrKeys(sub._raw?.feeding?.territories);
      for (const [csvKey, status] of Object.entries(rawTerrs)) {
        if (!status || status === 'Not feeding here' || status === 'none') continue;
        fed.set(csvKey, (fed.get(csvKey) || 0) + 1);
      }
    }
  }

  // Issue #300 + #327: count additional feeds from rote-hunt project slots.
  // ST rote-feed override takes priority over player's submitted rote territory grid.
  const hasRoteSlot = [1, 2, 3, 4].some(n => {
    const a = sub.responses?.[`project_${n}_action`];
    return a === 'rote' || a === 'feed';
  });
  if (hasRoteSlot) {
    const roteOvrArr = sub.st_review?.territory_overrides?.feeding_rote;
    if (Array.isArray(roteOvrArr) && roteOvrArr.length > 0) {
      for (const tid of roteOvrArr) {
        if (!tid) continue;
        const mt = MATRIX_TERRS.find(m => TERRITORY_SLUG_MAP[m.csvKey] === tid);
        if (!mt) continue;
        const current = fed.get(mt.csvKey) || 0;
        if (current < 2) fed.set(mt.csvKey, current + 1);
      }
    } else if (sub.responses?.feeding_territories_rote) {
      let roteGrid = null;
      try { roteGrid = JSON.parse(sub.responses.feeding_territories_rote); } catch { roteGrid = null; }
      if (roteGrid) {
        for (const [slug, status] of Object.entries(roteGrid)) {
          if (!status || status === 'none' || status === 'Not feeding here') continue;
          let tid;
          if (/^[a-f0-9]{24}$/i.test(slug)) {
            const terrDoc = (cachedTerritories || []).find(t => String(t._id) === slug);
            tid = terrDoc?.slug || null;
          } else {
            tid = Object.prototype.hasOwnProperty.call(TERRITORY_SLUG_MAP, slug) ? TERRITORY_SLUG_MAP[slug] : undefined;
          }
          if (!tid) continue;
          const mt = MATRIX_TERRS.find(m => TERRITORY_SLUG_MAP[m.csvKey] === tid);
          if (!mt) continue;
          const current = fed.get(mt.csvKey) || 0;
          if (current < 2) fed.set(mt.csvKey, current + 1);
        }
      }
    }
  }

  // Default: Barrens fallback — only when no ST override and no territory selected
  if (!hasOverride && fed.size === 0 && (sub._raw?.feeding?.method || sub.responses?.['_feed_method'] || (grid && Object.keys(grid).length > 0))) {
    fed.set('The Barrens (No Territory)', 1);
  }

  return fed;
}

/**
 * Build the feeding matrix <table> HTML only.
 * Callers handle the outer wrapper, toggle, and feeder-count footer.
 * @param {object[]} chars — sorted active characters
 * @param {Map<string,object>} subByCharId — charId → submission
 * @param {Object<string,Set<string>>} residentsByTerrKey — csvKey → Set<charId>
 * @returns {string} HTML string (<table>…</table> + note)
 */
function _buildMatrixTableHtml(chars, subByCharId, residentsByTerrKey) {
  const cols = MATRIX_TERRS;
  let h = '<table class="dt-matrix-table"><thead><tr><th>Character</th>';
  for (const t of cols) {
    const amb = getTerritoryAmbience(t.ambienceKey);
    h += `<th title="${esc(amb || 'No cap')}">${esc(t.label)}<br><span class="dt-matrix-amb">${esc(amb || 'N/A')}</span></th>`;
  }
  h += '</tr></thead><tbody>';

  const footerCounts = {};
  for (const t of cols) footerCounts[t.csvKey] = 0;

  for (const char of chars) {
    const charId = String(char._id);
    const sub = subByCharId.get(charId) || null;
    const hasSub = !!sub;
    const fedMap = hasSub ? _getSubFedTerrs(sub) : new Map();

    // Accumulate totals for tfoot
    for (const [csvKey, count] of fedMap) {
      if (csvKey in footerCounts) footerCounts[csvKey] += count;
    }

    h += `<tr class="dt-matrix-row${hasSub ? '' : ' dt-matrix-nosub'}"${hasSub ? ` data-sub-id="${esc(sub._id)}"` : ''}>`;
    h += `<td class="dt-matrix-char">${esc(dropdownName(char))}${!hasSub ? ' <span class="dt-matrix-nosub-badge">No submission</span>' : ''}</td>`;
    for (const t of cols) {
      const isBarrens = t.ambienceKey === null;
      const count = fedMap.get(t.csvKey) || 0;
      if (count === 0) {
        h += '<td class="dt-matrix-empty">\u2014</td>';
      } else if (!isBarrens && residentsByTerrKey[t.csvKey].has(charId)) {
        h += count >= 2
          ? '<td class="dt-matrix-resident">O O</td>'
          : '<td class="dt-matrix-resident">O</td>';
      } else {
        h += count >= 2
          ? '<td class="dt-matrix-poach">X X</td>'
          : '<td class="dt-matrix-poach">X</td>';
      }
    }
    h += '</tr>';
  }

  h += '</tbody><tfoot><tr><td class="dt-matrix-char">Total Feeds</td>';
  for (const t of cols) {
    const n = footerCounts[t.csvKey];
    h += n > 0 ? `<td class="dt-matrix-feed-count">${n}</td>` : '<td class="dt-matrix-empty">\u2014</td>';
  }
  h += '</tr></tfoot></table>';
  h += '<p class="dt-matrix-note">O = fed with rights. O O = fed twice with rights. X = poached. X X = poached twice. Rights set via City tab.</p>';
  return h;
}


// ── Cross-Character Conflicts (Story 1.11) ───────────────────────────────────

const COMPETING_ACTIONS = ['increase ambience', 'decrease ambience', 'ambience', 'patrol', 'scout', 'attack', 'hide', 'block', 'protect'];

/**
 * Resolve territory for a project action. Priority:
 * 1. ST override saved to st_review.territory_overrides[projIdx]
 * 2. Ambience target slug: sub.responses.project_N_ambience_target (dt-form.25+)
 * 3. App form OID field: sub.responses.project_N_territory (non-ambience since #496.2)
 * 4. Free-text scan of description
 * Returns a TERRITORY_DATA id (e.g. 'academy') or null if unknown.
 */
function _resolveProjectTerritory(sub, projIdx) {
  const overrides = sub.st_review?.territory_overrides || {};
  if (overrides[projIdx]) return overrides[projIdx];
  const n = projIdx + 1;
  const resp = sub.responses || {};
  // dt-form.25+: ambience actions write a slug to project_N_ambience_target;
  // project_N_territory is no longer set for ambience rows.
  const ambienceTarget = resp[`project_${n}_ambience_target`];
  if (ambienceTarget) {
    const id = TERRITORY_SLUG_MAP[ambienceTarget] ?? ambienceTarget;
    if (id) return id;
  }
  // Other project types write an OID to project_N_territory (since #496.2).
  const formVal = resp[`project_${n}_territory`];
  if (formVal) {
    const id = resolveTerrId(formVal) || (TERRITORY_SLUG_MAP[formVal] ?? null);
    if (id) return id;
  }
  const raw = sub._raw || {};
  const proj = raw.projects?.[projIdx];
  const text = [proj?.description, proj?.desired_outcome, proj?.title].filter(Boolean).join(' ');
  return extractTerritoryFromText(text);
}

// ── City Overview helpers ─────────────────────────────────────────

function _buildAmbienceHtml(feedCountsByTerrId = null) {
  const terrs = cachedTerritories || TERRITORY_DATA;
  const { rows } = buildAmbienceData(terrs, feedCountsByTerrId);

  let h = `<div class="dt-scroll-wrap">`;
  h += `<table class="proc-amb-table">`;
  h += `<thead><tr>
    <th>Territory</th>
    <th title="Current ambience step">Starting</th>
    <th title="Per-territory entropy (Hostile/Settled/Untended/Neglected −3; Tended −5; Curated −6; Verdant −7; The Rack −8)">Entropy</th>
    <th title="Feeders vs Feeding Tolerance (−2 per feed over tolerance)">Overfeeding</th>
    <th title="Influence spend: +positive / -negative / net">Influence</th>
    <th title="Ambience project contributions: 1–4 successes = ±2, 5+ = ±4; step thresholds are territory-specific">Projects</th>
    <th title="Allies / Status / Retainer automatic actions">Allies</th>
    <th title="Sum of all columns">Net Change</th>
    <th title="Projected new ambience step">Projected</th>
    <th title="Confirm this ambience change for cycle push">Confirm</th>
  </tr></thead><tbody>`;
  for (const r of rows) {
    const netClass = r.net > 0 ? 'proc-amb-pos' : r.net < 0 ? 'proc-amb-neg' : '';
    const projClass = r.projStep !== r.ambience ? (r.net > 0 ? 'proc-amb-pos' : 'proc-amb-neg') : '';
    const netStr = _fmtMod(r.net);
    const ovStr = r.overfeed !== 0
      ? ` | <span class="${r.overfeed > 0 ? 'proc-amb-pos' : 'proc-amb-neg'}">${_fmtMod(r.overfeed)}</span>`
      : '';
    const infNet = r.inf_pos - r.inf_neg;
    const infNetStr = _fmtMod(infNet);
    const infNetClass = infNet > 0 ? 'proc-amb-pos' : infNet < 0 ? 'proc-amb-neg' : '';
    const infNegStr = r.inf_neg > 0 ? ` | <span class="proc-amb-neg">-${r.inf_neg}</span>` : ' | 0';
    const infDisplay = `<span class="proc-amb-pos">+${r.inf_pos}</span>${infNegStr} | <span class="${infNetClass}">${infNetStr}</span>`;
    const projNet = r.proj_pos - r.proj_neg;
    const projNetStr = _fmtMod(projNet);
    const projNetClass = projNet > 0 ? 'proc-amb-pos' : projNet < 0 ? 'proc-amb-neg' : '';
    const projNegStr = r.proj_neg > 0 ? ` | <span class="proc-amb-neg">-${r.proj_neg}</span>` : ' | 0';
    const projDisplay = `<span class="proc-amb-pos">+${r.proj_pos}</span>${projNegStr} | <span class="${projNetClass}">${projNetStr}</span>`;
    const alliesNet = r.allies_pos - r.allies_neg;
    const alliesNetStr = _fmtMod(alliesNet);
    const alliesNetClass = alliesNet > 0 ? 'proc-amb-pos' : alliesNet < 0 ? 'proc-amb-neg' : '';
    const alliesNegStr = r.allies_neg > 0 ? ` | <span class="proc-amb-neg">-${r.allies_neg}</span>` : ' | 0';
    const alliesDisplay = `<span class="proc-amb-pos">+${r.allies_pos}</span>${alliesNegStr} | <span class="${alliesNetClass}">${alliesNetStr}</span>`;
    // r.id is a TERRITORY_DATA slug; cycle.confirmed_ambience is _id-keyed (ADR-002).
    const rOid = (cachedTerritories || []).find(t => t.slug === r.id)?._id;
    const rOidStr = rOid ? String(rOid) : null;
    const confirmed = rOidStr ? currentCycle?.confirmed_ambience?.[rOidStr] : null;
    const projMod = AMBIENCE_MODS[r.projStep] ?? r.ambienceMod ?? 0;
    // data-terr-id carries the _id-string so the confirm handler can write the right key.
    const dataTerrAttr = rOidStr || r.id;
    const confirmCell = confirmed
      ? `<td class="proc-amb-confirmed">\u2713 ${esc(confirmed.ambience)} <button class="city-amb-confirm-btn proc-amb-reconfirm" data-terr-id="${esc(dataTerrAttr)}" data-proj-step="${esc(r.projStep)}" data-proj-mod="${projMod}">Re-confirm</button></td>`
      : `<td><button class="city-amb-confirm-btn" data-terr-id="${esc(dataTerrAttr)}" data-proj-step="${esc(r.projStep)}" data-proj-mod="${projMod}">Confirm ${esc(r.projStep)}</button></td>`;
    h += `<tr>`;
    h += `<td class="proc-amb-terr">${esc(r.name)}</td>`;
    h += `<td>${esc(r.ambience)}</td>`;
    h += `<td class="proc-amb-neg">${r.entropy}</td>`;
    h += `<td>${r.feeders}/${r.cap}${ovStr}</td>`;
    h += `<td>${infDisplay}</td>`;
    h += `<td>${projDisplay}</td>`;
    h += `<td>${alliesDisplay}</td>`;
    h += `<td class="proc-amb-net ${netClass}">${netStr}</td>`;
    h += `<td class="${projClass}">${esc(r.projStep)}${r.projStep !== r.ambience ? (r.net > 0 ? ' \u2191' : ' \u2193') : ''}</td>`;
    h += confirmCell;
    h += `</tr>`;
  }
  h += `</tbody></table></div>`;
  h += `<p class="proc-amb-note">Step thresholds are territory-specific (hover column headers for details). Projects: 1\u20134 successes = \u00b12, 5+ = \u00b14. Overfeeding: \u22122 per feed over Feeding Tolerance.</p>`;
  return h;
}

function _buildFeedingMatrixHtml() {
  const mResidents = {};
  for (const mt of MATRIX_TERRS) {
    const tid = TERRITORY_SLUG_MAP[mt.csvKey] ?? null;
    // Both Mongo docs and TERRITORY_DATA key the slug as `slug` post-#3e.
    const td = (cachedTerritories || TERRITORY_DATA).find(t => t.slug === tid);
    const residents = new Set(td?.feeding_rights || []);
    if (td?.regent_id) residents.add(String(td.regent_id));
    if (td?.lieutenant_id) residents.add(String(td.lieutenant_id));
    mResidents[mt.csvKey] = residents;
  }
  // Share feeder counts with the ambience Overfeeding column — single source of truth
  const { subByCharId: mSubByCharId } = _computeMatrixFeederCounts();
  const mChars = characters.filter(c => !c.retired)
    .sort((a, b) => sortName(a).localeCompare(sortName(b)));

  return `<div class="dt-matrix-wrap">${_buildMatrixTableHtml(mChars, mSubByCharId, mResidents)}</div>`;
}

function _buildSpheresHtml() {
  function _normSphere(raw) {
    return raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  const active = characters.filter(c => !c.retired);
  const spheres = {};
  for (const c of active) {
    const cid = String(c._id || c.name);
    for (const m of (c.merits || [])) {
      if (m.category !== 'influence') continue;
      const dots = m.rating || 0;
      const raw = (m.area || m.qualifier || '').toString();
      if (!raw) continue;
      const ensureRow = key => {
        if (!spheres[key]) spheres[key] = {};
        if (!spheres[key][cid]) spheres[key][cid] = { name: dropdownName(c), allies: 0, status: 0, hasContacts: false };
        return spheres[key][cid];
      };
      if (m.name === 'Contacts') {
        for (const part of raw.split(',')) { const k = _normSphere(part); if (k) ensureRow(k).hasContacts = true; }
      } else if (m.name === 'Allies' || m.name === 'Status') {
        for (const part of raw.split(',')) {
          const k = _normSphere(part); if (!k) continue;
          const row = ensureRow(k);
          if (m.name === 'Allies') row.allies += dots; else row.status += dots;
        }
      }
    }
  }
  const data = Object.keys(spheres).map(sphere => {
    const rows = Object.values(spheres[sphere]).map(r => ({ ...r, total: r.allies + r.status }));
    rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return { sphere, rows, total: rows.reduce((s, r) => s + r.total, 0) };
  }).sort((a, b) => b.total - a.total || a.sphere.localeCompare(b.sphere));

  if (!data.length) return '<p class="proc-amb-empty">No sphere data. Add Allies, Status, or Contacts influence merits with sphere qualifiers.</p>';

  let h = '<div class="spheres-grid">';
  for (const { sphere, rows, total } of data) {
    h += `<div class="sphere-card">`;
    h += `<div class="sphere-head"><span class="sphere-name">${esc(sphere)}</span><span class="sphere-total">${total} dots</span></div>`;
    h += `<ol class="sphere-card-list">`;
    for (const r of rows) {
      const parts = [];
      if (r.allies)       parts.push(`${r.allies}A`);
      if (r.status)       parts.push(`${r.status}S`);
      if (r.hasContacts)  parts.push('\u2713');
      const meta = parts.join(' \u00B7 ') || '\u2014';
      h += `<li class="sphere-card-item">`
        + `<span class="sphere-char-name">${esc(r.name)}</span>`
        + `<span class="sphere-char-meta">${meta}</span>`
        + `</li>`;
    }
    h += `</ol></div>`;
  }
  h += '</div>';
  return h;
}

function _exportCityOverview(matrix) {
  const profile = currentCycle?.discipline_profile || {};
  const notes   = currentCycle?.ambience_notes    || '';

  // Feeding data
  const _mSubByCharId = new Map();
  for (const s of submissions) {
    const c = _findCharForSub(s);
    if (c) _mSubByCharId.set(String(c._id), s);
  }
  const feeding = {};
  for (const char of characters.filter(c => !c.retired)) {
    const sub = _mSubByCharId.get(String(char._id));
    if (!sub) continue;
    const fedTerrs = _getSubFedTerrs(sub);
    if (!fedTerrs.size) continue;
    const entries = [];
    for (const [csvKey] of fedTerrs) {
      const mt  = MATRIX_TERRS.find(t => t.csvKey === csvKey);
      const tid = TERRITORY_SLUG_MAP[csvKey] ?? null;
      const td  = (cachedTerritories || TERRITORY_DATA).find(t => t.slug === tid);
      const res = new Set(td?.feeding_rights || []);
      if (td?.regent_id)      res.add(String(td.regent_id));
      if (td?.lieutenant_id)  res.add(String(td.lieutenant_id));
      const resident = (!mt || mt.ambienceKey === null) ? null : res.has(String(char._id));
      entries.push({ territory: mt?.label || csvKey, resident });
    }
    feeding[dropdownName(char)] = entries;
  }

  // Actions matrix
  const PHASES = [
    { key: 'feeding', label: 'Feeding' }, { key: 'ambience', label: 'Ambience' },
    { key: 'hide_protect', label: 'Defensive' }, { key: 'investigate', label: 'Investigative' },
    { key: 'attack', label: 'Hostile' }, { key: 'support_patrol', label: 'Support/Patrol' },
    { key: 'misc', label: 'Misc' },
  ];
  const actions = {};
  for (const p of PHASES) {
    const rows = {};
    for (const t of TERRITORY_DATA) {
      const chars = (matrix?.[p.key]?.[t.slug] || []).map(e => e.charName);
      if (chars.length) rows[t.name] = chars;
    }
    if (Object.keys(rows).length) actions[p.label] = rows;
  }

  // Ambience data (per territory)
  const { rows: ambienceRows } = buildAmbienceData(cachedTerritories || TERRITORY_DATA);
  const ambience_by_territory = {};
  for (const r of ambienceRows) {
    // r.id is a slug; cycle.confirmed_ambience is _id-keyed post-ADR-002.
    const rOid = (cachedTerritories || []).find(t => t.slug === r.id)?._id;
    const confirmed = rOid ? currentCycle?.confirmed_ambience?.[String(rOid)] : null;
    ambience_by_territory[r.name] = {
      current_state:    r.ambience,
      entropy:          r.entropy,
      overfeeding_gap:  r.cap - r.feeders,
      influence_net:    r.inf_pos - r.inf_neg,
      projects_net:     r.proj_pos - r.proj_neg,
      allies_net:       r.allies_pos - r.allies_neg,
      net_change:       r.net,
      projected_state:  r.projStep,
      confirmed_state:  confirmed?.ambience || null,
    };
  }

  // Territory summary (regent, residents, poachers)
  const terrs = cachedTerritories || TERRITORY_DATA;
  const territories = {};
  for (const td of terrs) {
    if (!td.name) continue;
    const regentChar = td.regent_id ? characters.find(c => String(c._id) === String(td.regent_id)) : null;
    const residents = new Set(td.feeding_rights || []);
    if (td.regent_id)      residents.add(String(td.regent_id));
    if (td.lieutenant_id)  residents.add(String(td.lieutenant_id));
    // Count poachers: chars who fed here but are not residents.
    // Both Mongo docs and TERRITORY_DATA key the slug as `slug` post-#3e.
    const mt = MATRIX_TERRS.find(t => (TERRITORY_SLUG_MAP[t.csvKey] ?? null) === td.slug);
    let poachers = 0;
    if (mt) {
      for (const [charId, sub] of _mSubByCharId) {
        if (residents.has(charId)) continue;
        const fedTerrs = _getSubFedTerrs(sub);
        if (fedTerrs.has(mt.csvKey)) poachers++;
      }
    }
    const amb = td.ambienceKey ? getTerritoryAmbience(td.ambienceKey) : null;
    territories[td.name] = {
      ambience_state: amb || 'Unknown',
      regent:         regentChar ? dropdownName(regentChar) : null,
      residents:      residents.size,
      poachers,
    };
  }

  // Spheres — canonical only, retainers/job-status filtered out
  const CANONICAL_SPHERES = new Set([
    'Bureaucracy', 'Church', 'Finance', 'Health', 'High Society',
    'Industry', 'Legal', 'Media', 'Military', 'Occult',
    'Police', 'Politics', 'Street', 'Transportation', 'Underworld', 'University',
  ]);
  function _ns(raw) { return raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
  const spheres = {};
  for (const c of characters.filter(ch => !ch.retired)) {
    for (const m of (c.merits || [])) {
      if (m.category !== 'influence') continue;
      const raw = (m.area || m.qualifier || '').toString();
      if (!raw) continue;
      for (const part of raw.split(',')) {
        const key = _ns(part);
        if (!key || !CANONICAL_SPHERES.has(key)) continue;
        if (!spheres[key]) spheres[key] = {};
        const cn = dropdownName(c);
        if (!spheres[key][cn]) spheres[key][cn] = { allies: 0, status: 0, contacts: false };
        if (m.name === 'Allies')         spheres[key][cn].allies   += m.rating || 0;
        else if (m.name === 'Status')    spheres[key][cn].status   += m.rating || 0;
        else if (m.name === 'Contacts')  spheres[key][cn].contacts  = true;
      }
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    cycle: currentCycle?.label || 'Unknown',
    territories,
    ambience_by_territory,
    feeding_matrix: feeding,
    actions_in_territories: actions,
    discipline_profile: profile,
    spheres_of_influence: spheres,
    st_notes: notes,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `city-overview-${(currentCycle?.label || 'unknown').replace(/\s+/g, '-').toLowerCase()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function renderCityOverview() {
  const el = document.getElementById('dt-city-panel');
  if (!el) return;
  if (!submissions.length) {
    el.innerHTML = '<p class="placeholder-msg" style="padding:24px;color:var(--txt3);">No submissions yet for this cycle. The City overview populates once players submit.</p>';
    return;
  }

  const profile = currentCycle?.discipline_profile || {};
  const notes   = currentCycle?.ambience_notes    || '';

  // ── Build actions matrix data ──
  const TAAG_PHASES = [
    { key: 'feeding',        label: 'Feeding' },
    { key: 'ambience',       label: 'Ambience' },
    { key: 'hide_protect',   label: 'Defensive' },
    { key: 'investigate',    label: 'Investigative' },
    { key: 'attack',         label: 'Hostile' },
    { key: 'support_patrol', label: 'Support/Patrol' },
    { key: 'misc',           label: 'Misc' },
  ];
  const matrix = {};
  for (const p of TAAG_PHASES) matrix[p.key] = {};
  const queue = buildProcessingQueue(submissions);
  for (const entry of queue) {
    if (entry.source === 'project') {
      const phaseKey = entry.phase;
      if (!matrix[phaseKey]) continue;
      const sub = submissions.find(s => s._id === entry.subId);
      if (!sub) continue;
      const terrId = _resolveProjectTerritory(sub, entry.actionIdx);
      if (!terrId) continue;
      if (!matrix[phaseKey][terrId]) matrix[phaseKey][terrId] = [];
      matrix[phaseKey][terrId].push({ key: entry.key, charName: entry.charName, subId: entry.subId });
    } else if (entry.source === 'feeding') {
      const _feedSub = submissions.find(s => s._id === entry.subId);
      if (_feedSub) {
        const _fedMap = _getSubFedTerrs(_feedSub);
        for (const [csvKey] of _fedMap) {
          const _mt = MATRIX_TERRS.find(m => m.csvKey === csvKey);
          if (!_mt) continue;
          const terrId = TERRITORY_SLUG_MAP[_mt.csvKey];
          if (!terrId) continue;
          if (!matrix['feeding'][terrId]) matrix['feeding'][terrId] = [];
          matrix['feeding'][terrId].push({ key: entry.key, charName: entry.charName, subId: entry.subId });
        }
      }
    }
  }
  const activePhases = TAAG_PHASES.filter(p =>
    TERRITORY_DATA.some(t => (matrix[p.key][t.slug] || []).length > 0)
  );
  _cityMatrix = matrix;

  // ── HTML ──
  let h = `<div class="dt-conflict-panel">`;

  // ── 1. Feeding Matrix ─────────────────────────────────────────
    h += `<div class="proc-disc-header" data-toggle="city-feed-matrix">`;
    h += `<span class="proc-amb-title">Feeding Matrix</span>`;
    h += `<span class="proc-amb-toggle">${matrixCollapsed ? '&#9660; Show' : '&#9650; Hide'}</span>`;
    h += `</div>`;
    if (!matrixCollapsed) h += _buildFeedingMatrixHtml();

    // ── 2. Ambience ───────────────────────────────────────────────
    h += `<div class="proc-disc-header" data-toggle="city-ambience">`;
    h += `<span class="proc-amb-title">Ambience</span>`;
    h += `<button class="city-amb-recalc-btn dt-btn-sm" title="Refresh matrix from current feeding and project data">Recalculate Territories</button>`;
    h += `<span class="proc-amb-toggle">${ovAmbienceCollapsed ? '&#9660; Show' : '&#9650; Hide'}</span>`;
    h += `</div>`;
    if (!ovAmbienceCollapsed) {
      // Use _computeMatrixFeederCounts() — single source of truth for all feed types
      // (feeding_rights, poaching, rote). Shared with feeding matrix footer totals.
      const { byTerrId: feedCountsByTerrId } = _computeMatrixFeederCounts();
      h += _buildAmbienceHtml(feedCountsByTerrId);
    }

    // ── 3. Actions in Territories ─────────────────────────────────
    h += `<div class="proc-disc-header dt-city-actions-head">`;
    h += `<span class="proc-amb-title">Actions in Territories</span>`;
    if (!activePhases.length) h += ` <span class="dt-matrix-note">No territory assignments yet</span>`;
    h += `</div>`;
    h += `<div class="dt-scroll-wrap"><table class="dt-taag-table"><thead><tr><th>Action</th>`;
    for (const t of TERRITORY_DATA) h += `<th>${esc(t.name.replace(/^The\s+/i, ''))}</th>`;
    h += `</tr></thead><tbody>`;
    if (!activePhases.length) {
      h += `<tr class="dt-taag-empty-row"><td colspan="${1 + TERRITORY_DATA.length}">Assign territories to project actions using the pills in the processing queue.</td></tr>`;
    } else {
      for (const p of TAAG_PHASES) {
        const rowEntries = matrix[p.key];
        if (!TERRITORY_DATA.some(t => (rowEntries[t.slug] || []).length > 0)) continue;
        h += `<tr><td class="dt-taag-phase-lbl">${esc(p.label)}</td>`;
        for (const t of TERRITORY_DATA) {
          const chips = rowEntries[t.slug] || [];
          h += `<td class="dt-taag-cell">`;
          if (chips.length) {
            h += `<div class="dt-taag-chips">`;
            for (const c of chips) h += `<span class="dt-taag-chip" data-proc-key="${esc(c.key)}" title="${esc(c.charName)}">${esc(c.charName)}</span>`;
            h += `</div>`;
          } else {
            h += `<span class="dt-taag-empty">\u2014</span>`;
          }
          h += `</td>`;
        }
        h += `</tr>`;
      }
    }
    h += `</tbody></table></div>`;

    // ── 3. Discipline Profile Matrix ──────────────────────────────
    h += `<div class="proc-disc-header" data-toggle="city-disc-dash">`;
    h += `<span class="proc-amb-title">Discipline Profile</span>`;
    h += `<button class="dt-btn proc-disc-retally" id="disc-retally-btn">Retally</button>`;
    h += `<span class="proc-amb-toggle">${discDashCollapsed ? '&#9660; Show' : '&#9650; Hide'}</span>`;
    h += `</div>`;
    if (!discDashCollapsed) {
      // discipline_profile is _id-keyed post-ADR-002; build slug→_id resolver to
      // bridge between the cycle data (keyed by _id) and TERRITORY_DATA iteration
      // (keyed by slug). Iterates cachedTerritories directly so the map is populated
      // regardless of whether MongoDB slugs exactly match TERRITORY_DATA entries.
      const slugToOid = new Map();
      for (const t of (cachedTerritories || [])) {
        if (!t._id) continue;
        const oid = String(t._id);
        if (t.slug) {
          slugToOid.set(t.slug, oid);
          const canonical = TERRITORY_SLUG_MAP[t.slug];
          if (canonical && !slugToOid.has(canonical)) slugToOid.set(canonical, oid);
        }
        if (t.name) {
          const byName = TERRITORY_SLUG_MAP[t.name];
          if (byName && !slugToOid.has(byName)) slugToOid.set(byName, oid);
        }
      }
      const discSet = new Set(), terrOidSet = new Set();
      for (const [terrOid, discs] of Object.entries(profile)) {
        for (const [disc, count] of Object.entries(discs)) {
          if (count > 0) { discSet.add(disc); terrOidSet.add(terrOid); }
        }
      }
      const discList = [...discSet].sort();
      const terrList = TERRITORY_DATA.filter(t => terrOidSet.has(slugToOid.get(t.slug)));
      if (!discList.length) {
        h += `<p class="proc-amb-empty">No discipline uses recorded yet.</p>`;
      } else {
        h += `<div class="dt-scroll-wrap"><table class="proc-disc-table"><thead><tr><th>Discipline</th>`;
        for (const t of terrList) h += `<th>${esc(t.name.replace(/^The\s+/i, ''))}</th>`;
        h += `</tr></thead><tbody>`;
        for (const disc of discList) {
          h += `<tr><td class="proc-disc-name">${esc(disc)}</td>`;
          for (const t of terrList) {
            const tOid = slugToOid.get(t.slug);
            const count = (tOid && profile[tOid]?.[disc]) || 0;
            h += `<td class="${count >= 3 ? 'proc-disc-high' : count > 0 ? 'proc-disc-used' : ''}">${count > 0 ? count : ''}</td>`;
          }
          h += `</tr>`;
        }
        h += `</tbody></table></div>`;
      }
    }

    // ── 4. Spheres of Influence ───────────────────────────────────
    h += `<div class="proc-disc-header" data-toggle="city-spheres">`;
    h += `<span class="proc-amb-title">Spheres of Influence</span>`;
    h += `<span class="proc-amb-toggle">${ovSpheresCollapsed ? '&#9660; Show' : '&#9650; Hide'}</span>`;
    h += `</div>`;
    if (!ovSpheresCollapsed) h += _buildSpheresHtml();

    // ── 5. ST Notes ───────────────────────────────────────────────
    h += `<div class="proc-amb-notes-block">`;
    h += `<label class="proc-amb-notes-lbl">ST Notes</label>`;
    h += `<textarea class="proc-amb-notes city-ov-notes" placeholder="Working notes about the city this cycle...">${esc(notes)}</textarea>`;
    h += `</div>`;

    // ── 6. Territory Pulse (DTIL-4) ───────────────────────────────
    h += renderTerritoryPulsePanel(currentCycle, submissions, characters);
  h += `</div>`; // dt-conflict-panel
  el.innerHTML = h;

  // ── Event wiring ──


  el.querySelector('[data-toggle="city-feed-matrix"]')?.addEventListener('click', () => {
    matrixCollapsed = !matrixCollapsed;
    renderCityOverview();
  });

  el.querySelectorAll('.dt-taag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.procKey;
      if (procExpandedKeys.has(key)) { procExpandedKeys.delete(key); } else { procExpandedKeys.add(key); }
      const procContainer = document.getElementById('dt-submissions');
      if (procContainer) {
        renderProcessingMode(procContainer);
        procContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  el.querySelector('[data-toggle="city-ambience"]')?.addEventListener('click', () => {
    ovAmbienceCollapsed = !ovAmbienceCollapsed;
    renderCityOverview();
  });

  el.querySelector('.city-amb-recalc-btn')?.addEventListener('click', async e => {
    e.stopPropagation();
    try { cachedTerritories = await apiGet('/api/territories'); } catch { /* use cached */ }
    renderCityOverview();
  });

  el.querySelectorAll('.city-amb-confirm-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!currentCycle) return;
      const terrId      = btn.dataset.terrId;
      const ambience    = btn.dataset.projStep;
      const ambienceMod = parseInt(btn.dataset.projMod, 10);
      const updated = { ...(currentCycle.confirmed_ambience || {}), [terrId]: { ambience, ambienceMod } };
      try {
        await updateCycle(currentCycle._id, { confirmed_ambience: updated });
        currentCycle.confirmed_ambience = updated;
        renderCityOverview();
      } catch (err) { console.error('Failed to confirm ambience:', err.message); }
    });
  });

  el.querySelector('[data-toggle="city-disc-dash"]')?.addEventListener('click', () => {
    discDashCollapsed = !discDashCollapsed;
    renderCityOverview();
  });

  el.querySelector('#disc-retally-btn')?.addEventListener('click', async e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.textContent = 'Tallying\u2026';
    btn.disabled = true;
    await recomputeDisciplineProfile();
    renderCityOverview();
  });

  el.querySelector('[data-toggle="city-spheres"]')?.addEventListener('click', () => {
    ovSpheresCollapsed = !ovSpheresCollapsed;
    renderCityOverview();
  });

  el.querySelector('.city-ov-notes')?.addEventListener('blur', async e => {
    const val = e.target.value;
    try {
      await updateCycle(selectedCycleId, { ambience_notes: val });
      const idx = allCycles.findIndex(c => c._id === selectedCycleId);
      if (idx >= 0) allCycles[idx].ambience_notes = val;
      if (currentCycle) currentCycle.ambience_notes = val;
    } catch (err) { console.error('Failed to save city notes:', err.message); }
  });
}

// ── Ambience Update After Cycle Close (Story 1.12) ──────────────────────────

/**
 * Write projected ambience (from buildAmbienceData) to all territory records.
 * @param {boolean} markApplied — if true, sets cycle.ambience_applied = true (end-of-cycle only)
 */
async function _applyProjectedAmbience(markApplied) {
  // 1. Fetch / seed territory records
  let dbTerritories = [];
  try { dbTerritories = await apiGet('/api/territories'); } catch { /* ignore */ }
  if (!dbTerritories.length) {
    // Fallback seed (post-ADR-002: pass slug as a label, not as an FK).
    for (const td of TERRITORY_DATA) {
      try { await apiPost('/api/territories', { slug: td.slug, name: td.name, ambience: td.ambience }); } catch { /* ignore */ }
    }
    try { dbTerritories = await apiGet('/api/territories'); } catch { /* ignore */ }
  }
  // Build slug → DB record map (Mongo docs carry slug post-ADR-002).
  const terrRecMap = {};
  for (const t of dbTerritories) { if (t.slug || t.name) terrRecMap[t.slug || t.name] = t; }

  // 2. Get projected values from the dashboard calculation
  const { rows } = buildAmbienceData(dbTerritories.length ? dbTerritories : TERRITORY_DATA);

  // 3. Write ALL territories (including unchanged ones — caller requested full sync)
  for (const r of rows) {
    const rec = terrRecMap[r.id];
    try {
      if (rec?._id) {
        await apiPut(`/api/territories/${rec._id}`, { ambience: r.projStep });
      } else {
        // No matching DB record — insert (server generates _id; r.id is a slug label).
        await apiPost('/api/territories', { slug: r.id, name: r.name, ambience: r.projStep });
      }
      // Update cachedTerritories in-memory so dashboard reflects new values immediately
      if (cachedTerritories) {
        const ct = cachedTerritories.find(t => t.slug === r.id);
        if (ct) ct.ambience = r.projStep;
      }
    } catch (err) {
      console.error(`Failed to update ambience for ${r.name}:`, err.message);
    }
  }

  // 4. Optionally mark cycle as ambience-applied
  if (markApplied && currentCycle) {
    await updateCycle(currentCycle._id, { ambience_applied: true });
    const i = allCycles.findIndex(c => c._id === currentCycle._id);
    if (i >= 0) allCycles[i].ambience_applied = true;
    if (currentCycle) currentCycle.ambience_applied = true;
  }
}

async function handleApplyAmbience(cycleId, cycle) {
  if (cycle.ambience_applied) {
    alert('Ambience changes have already been applied for this cycle.');
    return;
  }
  if (!confirm('Apply projected ambience to all territories and mark this cycle as processed?')) return;
  await _applyProjectedAmbience(true);
  await loadCycleById(cycleId);
}

// ── Generic pool builder (projects + merit actions) ────────────────────────

/**
 * Build a dice pool from explicit attr/skill/disc selections.
 * Applies unskilled penalty: -3 mental at 0 dots, -1 others at 0 dots.
 * Returns { total, expression, unskilled, attrVal, skillVal, discVal, modifier }.
 */
function buildGenericPool(char, attrName, skillName, discName, modifier) {
  const attrVal = attrName ? getAttrVal(char, attrName) : 0;
  const skillVal = skillName ? skTotal(char, skillName) : 0;
  const discVal = discName ? (_charDiscsArray(char).find(d => d.name === discName)?.dots || 0) : 0;
  const mod = modifier || 0;
  const unskilled = skillName && skillVal === 0
    ? (SKILLS_MENTAL.includes(skillName) ? -3 : -1)
    : 0;
  const total = Math.max(1, attrVal + skillVal + discVal + mod + unskilled);

  const parts = [];
  if (attrName) parts.push(`${attrVal} ${attrName}`);
  if (skillName) parts.push(`${skillVal} ${skillName}`);
  if (discVal) parts.push(`${discVal} ${discName}`);
  if (mod) parts.push(`${mod > 0 ? '+' : ''}${mod}`);
  if (unskilled) parts.push(`\u2212${Math.abs(unskilled)} unskilled`);
  const expression = (parts.join(' + ') || '0') + ` = ${total}`;

  return { total, expression, unskilled, attrVal, skillVal, discVal, modifier: mod };
}

function attrOptions(char) {
  return ALL_ATTRS.map(a => {
    const v = char ? getAttrVal(char, a) : 0;
    return `<option value="${esc(a)}">${esc(a)} (${v})</option>`;
  }).join('');
}

function skillOptions(char) {
  let h = '<option value="">— Skill —</option>';
  for (const [cat, skills] of Object.entries(SKILL_CATS)) {
    h += `<optgroup label="${esc(cat)}">`;
    for (const s of skills) {
      const v = char ? skTotal(char, s) : 0;
      h += `<option value="${esc(s)}">${esc(s)} (${v})</option>`;
    }
    h += '</optgroup>';
  }
  return h;
}

function discOptions(char) {
  let h = '<option value="">— Discipline —</option>';
  if (!char?.disciplines) return h;
  for (const [d, v] of Object.entries(char.disciplines)) {
    const dv = v?.dots || 0;
    if (dv > 0) h += `<option value="${esc(d)}">${esc(d)} (${dv})</option>`;
  }
  return h;
}

/**
 * @param {string} selClass - CSS class to add to selects (e.g. 'dt-proj-sel' or 'dt-merit-sel')
 * @param {string} modClass - CSS class to add to modifier input
 */
function poolBuilderUI(subId, idxField, idxVal, char, pen, compactPool, selClass = 'dt-proj-sel', modClass = 'dt-proj-mod') {
  const selVal = (v) => v ? ` data-selected="${esc(v)}"` : '';

  let h = `<div class="dt-pool-builder">`;
  h += `<select class="${selClass} dt-pool-sel" data-sub-id="${esc(subId)}" data-${esc(idxField)}="${idxVal}" data-field="attr">`;
  h += `<option value="">— Attr —</option>${attrOptions(char)}`;
  h += '</select>';
  h += `<select class="${selClass} dt-pool-sel" data-sub-id="${esc(subId)}" data-${esc(idxField)}="${idxVal}" data-field="skill">`;
  h += skillOptions(char);
  h += '</select>';
  h += `<select class="${selClass} dt-pool-sel" data-sub-id="${esc(subId)}" data-${esc(idxField)}="${idxVal}" data-field="disc">`;
  h += discOptions(char);
  h += '</select>';
  h += `<input class="${modClass} dt-pool-mod" type="number" value="${pen.modifier || 0}" placeholder="Mod" title="Modifier"
    data-sub-id="${esc(subId)}" data-${esc(idxField)}="${idxVal}">`;

  if (pen.attr) {
    h += `<span class="dt-pool-display">${esc(compactPool.expression)}</span>`;
  }
  // Skill metadata: 9-again badge + spec toggles (feature.57)
  h += skillMetaUI(char, pen.skill, subId, idxField, idxVal, pen);
  h += '</div>';
  return h;
}

/**
 * Render skill metadata block (9-again badge + spec toggles) for pool builders.
 * Returns empty string if no metadata exists.
 */
function skillMetaUI(char, skillName, subId, idxField, idxVal, pen) {
  if (!char || !skillName) return '';
  const nineAgain = skNineAgain(char, skillName);
  const specs = skSpecs(char, skillName);
  if (!nineAgain && !specs.length) return '';
  const activeSpecs = pen.active_specs || [];
  let h = '<div class="dt-skill-meta">';
  if (nineAgain) h += '<span class="dt-pool-9a-auto">9-Again (auto)</span>';
  for (const sp of specs) {
    const checked = activeSpecs.includes(sp);
    h += `<label class="dt-spec-toggle-lbl"><input type="checkbox" class="dt-spec-toggle"
      data-sub-id="${esc(subId)}" data-${esc(idxField)}="${idxVal}" data-spec="${esc(sp)}"
      ${checked ? 'checked' : ''}>${esc(sp)} +1</label>`;
  }
  h += '</div>';
  return h;
}

// Render dice result badge for project/merit panels
function renderResolveBadge(roll) {
  if (!roll) return '';
  const rc = roll.exceptional ? 'dt-succ-exc' : roll.successes === 0 ? 'dt-succ-fail' : 'dt-succ-ok';
  return `<span class="dt-resolve-badge ${rc}">${roll.successes} ${roll.successes === 1 ? 'success' : 'successes'}${roll.exceptional ? ' (exceptional)' : ''}</span>`;
}

async function handleProjectRollSave(subId, projIdx, pool, rollResult) {
  const sub = submissions.find(s => s._id === subId);
  if (!sub) return;

  const pending = (sub._proj_pending || [])[projIdx] || {};
  const resolved = [...(sub.projects_resolved || [])];
  while (resolved.length <= projIdx) resolved.push(null);
  // Issue #320: preserve existing fields (st_note, writeup) saved via blur autosave
  // before this Roll. Prefer existing.st_note over pending.st_note since blur-save
  // writes directly to the resolved entry, not to _proj_pending.
  const existing = resolved[projIdx] || {};
  // STM-8 (issue #415): pool_snapshot at resolution captures the active
  // mod state for the historical record.
  const c = _charForSub(sub);
  const poolTotal = (pool && Number.isFinite(pool.total)) ? pool.total : 0;
  resolved[projIdx] = {
    ...existing,
    action_type: ((sub._raw || {}).projects || [])[projIdx]?.action_type || '',
    pool: { ...pool },
    pool_snapshot: buildPoolSnapshot(c, poolTotal),
    roll: rollResult,
    st_note: existing.st_note || pending.st_note || '',
    resolved_at: new Date().toISOString(),
  };

  try {
    await updateSubmission(subId, { projects_resolved: resolved });
    sub.projects_resolved = resolved;
    renderSubmissions();
  } catch (err) {
    console.error('Failed to save project roll:', err.message);
  }
}

async function handleMeritRollSave(subId, meritIdx, pool, rollResult) {
  const sub = submissions.find(s => s._id === subId);
  if (!sub) return;

  const pending = (sub._merit_pending || [])[meritIdx] || {};
  const _raw = sub._raw || {};
  const _resp = sub.responses || {};
  let _contactReqs = _raw.contact_actions?.requests || [];
  if (!_contactReqs.length) {
    const cl = [];
    for (let n = 1; n <= 5; n++) { const r = _resp[`contact_${n}_request`] || _resp[`contact_${n}`]; if (!r) continue; cl.push(r); }
    _contactReqs = cl;
  }
  const allActions = [
    ...(_raw.sphere_actions || []),
    ..._contactReqs.map(r => ({ merit_type: 'Contacts', action_type: 'Gather Info', description: r })),
    ...((_raw.retainer_actions?.actions || []).map(r => ({ merit_type: 'Retainer', action_type: 'Directed Action', description: r }))),
  ];
  const resolved = [...(sub.merit_actions_resolved || [])];
  while (resolved.length <= meritIdx) resolved.push(null);
  // Issue #320: preserve existing fields (st_note) saved via blur autosave
  // before this Roll. Prefer existing.st_note over pending.st_note since
  // blur-save writes directly to the resolved entry.
  const existing = resolved[meritIdx] || {};
  resolved[meritIdx] = {
    ...existing,
    merit_type: allActions[meritIdx]?.merit_type || '',
    action_type: allActions[meritIdx]?.action_type || '',
    pool: { ...pool },
    roll: rollResult,
    st_note: existing.st_note || pending.st_note || '',
    resolved_at: new Date().toISOString(),
  };

  try {
    await updateSubmission(subId, { merit_actions_resolved: resolved });
    sub.merit_actions_resolved = resolved;
    renderSubmissions();
  } catch (err) {
    console.error('Failed to save merit action roll:', err.message);
  }
}
