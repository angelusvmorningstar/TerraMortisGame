/* Sheet-mode edit handlers — all read state.editIdx and write to state.chars[state.editIdx] */

import state from '../data/state.js';
import { apiGet, apiPost, apiPut, apiDelete } from '../data/api.js';
import { isInClanDisc, bloodlineUnresolved } from '../data/accessors.js';
// BL-5 (#1008): clan and bloodline are write-once, and the refusal is shared
// with the Identity tab's `updField` so the rule has one implementation across
// both editing surfaces. This import replaces BL-3a's `bloodlinesByClan` /
// `bloodlinesResolvable` pair, which existed only to feed the clan-change
// bloodline auto-clear that BL-5 deleted below.
import { refuseLineageWrite } from '../data/write-once.js';
import {
  CLAN_BANES, CLAN_DISCS,
  SKILL_CATS, SKILL_PRI_BUDGETS, ALL_SKILLS, ATTR_CATS, PRI_BUDGETS,
  CORE_DISCS, RITUAL_DISCS
} from '../data/constants.js';
import { getRuleByKey, getRulesByCategory } from '../data/loader.js';
import { freeOf, poolAvailableFor, pledgedDots, swornOaths, meritMatchesRef } from '../data/rules-helpers.js';
// OATH-A (#1111): meritRating is the OWNED-dots helper. The pledge gate
// clamps against owned dots, never effective ones — encumbrance reduces no
// rating anywhere (ADR-010 D2).
import { xpToDots, meritRating } from './xp.js';
import { meritByCategory, addMerit, removeMerit, ensureMeritSync } from './merits.js';
import { getPoolTotal, mciPoolTotal, getMCIPoolUsed } from './mci.js';
import { vmPool, vmUsed, investedPool, investedUsed, lorekeeperPool, lorekeeperUsed, syncMeritRating, pruneContactsSpheres } from './domain.js';
// ECM-5 (issue #872): catalogue is fed from the API-backed module-level
// cache rather than the static catalogue module. The cache is loaded at
// app boot (admin.js) and refetched on `broadcastCatalogueUpdate` WS
// frames. The static module stays in place until ECM-7 deletes it
// alongside the server mirror; editor/sheet.js and suite/roll-v2.js
// (roll.js retired by rlv.2) still read from it via `getCatalogueEntry`.
import { getCatalogueByBucket } from '../data/equipment-catalogue-cache.js';
// #896: ST admin editor BYPASSES the availability filter (ST can assign any
// item to any character) but still shows the per-character effective
// availability in option labels for display consistency.
import { effectiveAvailability } from '../data/equipment-derivation.js';
import {
  shEditInflMerit, shEditContactSphere, shRemoveInflMerit, shAddInflMerit, shAddVMAllies, shAddLKMerit,
  shEditGenMerit, shRemoveGenMerit, shAddGenMerit,
  shEditStandMerit, shEditStandAssetSkill, shToggleMCI, shTogglePT, shEditMCIDot, shEditMCITierGrant, shEditMCITierQual, shRemoveStandMerit, shAddStandMCI, shAddStandPT,
  shEditDomMerit, shRemoveDomMerit, shAddDomMerit,
  shAllocateCompoundVirtual,
  shSwearOath,
  shReleaseOath,
  shSetPledgeDots,
  shCommitOath,
  shExitOath,
  shRestoreOathDots,
  shAddDomainPartner, shRemoveDomainPartner,
  shAddStyle, shRemoveStyle, shEditStyle, shAddPick, shRemovePick,
  shSetWhiteAntsTerritory,
  shSetTrapDoorAnchor,
  registerCallbacks as registerDomainCallbacks,
  getDirtyPartners, clearDirtyPartners
} from './edit-domain.js';

/* Re-export merit-category handlers so consumers can import from edit.js */
export {
  shEditInflMerit, shEditContactSphere, shRemoveInflMerit, shAddInflMerit, shAddVMAllies, shAddLKMerit,
  shEditGenMerit, shRemoveGenMerit, shAddGenMerit,
  shEditStandMerit, shEditStandAssetSkill, shToggleMCI, shTogglePT, shEditMCIDot, shEditMCITierGrant, shEditMCITierQual, shRemoveStandMerit, shAddStandMCI, shAddStandPT,
  shEditDomMerit, shRemoveDomMerit, shAddDomMerit,
  shAllocateCompoundVirtual,
  shSwearOath,
  shReleaseOath,
  shSetPledgeDots,
  shCommitOath,
  shExitOath,
  shRestoreOathDots,
  shAddDomainPartner, shRemoveDomainPartner,
  shAddStyle, shRemoveStyle, shEditStyle, shAddPick, shRemovePick,
  shSetWhiteAntsTerritory,
  shSetTrapDoorAnchor,
  getDirtyPartners, clearDirtyPartners
};

/* ── Callback registration (avoids circular deps with main.js / sheet.js) ── */
let _markDirty, _renderSheet;
export function registerCallbacks(markDirty, renderSheet) {
  _markDirty = markDirty;
  _renderSheet = renderSheet;
  registerDomainCallbacks(markDirty, renderSheet);
}

/* ══════════════════════════════════════════════════════════
   IDENTITY & BASICS
══════════════════════════════════════════════════════════ */

export function editFromSheet() {
  if (state.editIdx < 0) return;
  const el = document.getElementById('sh-content');
  const scrollEl = el ? el.closest('.sh-wrap') || el.parentElement || document.documentElement : document.documentElement;
  const savedScroll = scrollEl.scrollTop;
  state.editMode = !state.editMode;
  const btn = document.querySelector('.sheet-edit-btn');
  if (btn) {
    btn.textContent = state.editMode ? 'Done' : 'Edit';
    btn.classList.toggle('editing', state.editMode);
  }
  _renderSheet(state.chars[state.editIdx]);
  scrollEl.scrollTop = savedScroll;
}

export function shEdit(field, val) {
  if (state.editIdx < 0) return;
  // BL-5 (#1008): this guard MUST stay above the assignment on the next line,
  // which is where the field is written. Enforced at the handler, not only in
  // the markup, per data-map.md's own instruction on `characters.clan`.
  if (refuseLineageWrite(state.chars[state.editIdx], field, val)) return;
  state.chars[state.editIdx][field] = val || null;
  _markDirty();
  // Re-render for fields that affect derived display (title bonus, clan bane)
  if (field === 'court_title' || field === 'court_category') {
    _renderSheet(state.chars[state.editIdx]);
    return;
  }
  // If clan changed, update curse bane
  if (field === 'clan') {
    const c = state.chars[state.editIdx];
    const newCurse = CLAN_BANES[val];
    if (newCurse) {
      if (!c.banes) c.banes = [];
      const ci = c.banes.findIndex(b => Object.values(CLAN_BANES).some(cb => cb.name === b.name));
      if (ci >= 0) c.banes[ci] = { ...newCurse };
      else c.banes.unshift({ ...newCurse });
    }
    // BL-5 (#1008): the "clear the bloodline if it is not valid for the new
    // clan" block that used to sit here is DELETED, not guarded. Clan is
    // write-once and now enforced both here and at the API, so a clan can never
    // change after its first set and the branch could never fire. A guard is a
    // thing that can be got subtly wrong later; a deletion is not. The bane
    // assignment above stays, because it is still needed the first time a clan
    // is set on a new character.
    _renderSheet(c);
  }
}

export function shEditStatus(key, val) {
  if (state.editIdx < 0) return;
  if (!state.chars[state.editIdx].status) state.chars[state.editIdx].status = {};
  state.chars[state.editIdx].status[key] = parseInt(val) || 0;
  _markDirty();
}

/* ══════════════════════════════════════════════════════════
   BANES
══════════════════════════════════════════════════════════ */

export function shEditBaneName(i, val) {
  if (state.editIdx < 0) return;
  const banes = state.chars[state.editIdx].banes || [];
  if (banes[i]) { banes[i].name = val; _markDirty(); }
}

export function shEditBaneEffect(i, val) {
  if (state.editIdx < 0) return;
  const banes = state.chars[state.editIdx].banes || [];
  if (banes[i]) { banes[i].effect = val; _markDirty(); }
}

export function shRemoveBane(i) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.banes) return;
  // Don't remove the clan curse
  const b = c.banes[i];
  if (b && Object.values(CLAN_BANES).some(cb => cb.name === b.name)) {
    return; // can't remove clan curse
  }
  c.banes.splice(i, 1);
  _markDirty();
  _renderSheet(c);
}

export function shAddBane() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.banes) c.banes = [];
  c.banes.push({ name: '', effect: '' });
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   TOUCHSTONES (NPCR.4)
   ----------------------------------------------------------
   Model: character.touchstones[] is authoritative (cap 6).
   Slot rating descends from the anchor - 7 for Ventrue, 6 else.
   Free-text only (DBO-8, 2026-08-14): {humanity, name, desc}. An
   earlier design let an entry link to a relationships doc via
   edge_id, but issue #162 removed the only path that ever created
   one, and live data confirmed zero touchstones used it, so the
   link was retired.
   Operations round-trip atomically via PUT /api/characters/:id
   so partial state never persists without a character save.
══════════════════════════════════════════════════════════ */

export function anchorFor(c) {
  return c?.clan === 'Ventrue' ? 7 : 6;
}

function _tsCap() { return 6; }

// Issue #162 (2026-05-08): shEnsureTouchstoneData removed. The Touchstone
// editor no longer exposes the DB-relational NPC picker (broader NPC
// suppression policy, Piatra 2026-05-06), so the /api/npcs preload that
// fed `c._ts_npcs` / `c._ts_loaded` is dead. The export was previously
// imported by sheet.js to kick off the load on every render-edit pass.

export function shTouchstoneStartAdd() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  // Issue #162: draft slimmed to free-text shape only (Name + Description).
  // The legacy is_character / pick_existing / npc_id / new_npc_* fields
  // were tied to the suppressed NPC picker and are no longer initialised.
  c._ts_picker = {
    mode: 'add',
    draft: { name: '', desc: '' },
  };
  _tsClearError(c);
  _renderSheet(c);
}

export function shTouchstoneStartEdit(i) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const t = (c.touchstones || [])[i];
  if (!t) return;
  c._ts_picker = {
    mode: 'edit',
    index: +i,
    draft: { name: String(t.name || ''), desc: String(t.desc || '') },
  };
  _tsClearError(c);
  _renderSheet(c);
}

export function shTouchstonePickerClose() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  delete c._ts_picker;
  _renderSheet(c);
}

export function shTouchstonePickerDraft(field, value) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c._ts_picker) return;
  c._ts_picker.draft[field] = value;
}

// Issue #162 (2026-05-08): shTouchstonePickerToggleCharacter and
// shTouchstonePickerSetMode removed alongside the NPC picker UI they
// drove. The picker no longer has an is_character toggle or
// existing/create mode chips.

export async function shTouchstoneSaveAdd() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const picker = c._ts_picker;
  if (!picker || picker.mode !== 'add') return;
  const existing = Array.isArray(c.touchstones) ? c.touchstones : [];
  if (existing.length >= _tsCap()) { _tsSetError(c, 'Maximum of 6 touchstones reached.'); return; }

  const anchor = anchorFor(c);
  const humanity = anchor - existing.length;
  const draft = picker.draft;
  const charId = String(c._id);

  // Issue #162: NPC picker branch dropped - Touchstone is free-text only.
  // The legacy DB-relational path (POST /api/npcs + POST /api/relationships)
  // returned 4xx under the broader NPC suppression and blocked sheet save.
  // DBO-8 retired the dormant edge_id-linked shape entirely - every entry
  // is now { humanity, name, desc }.
  const name = String(draft.name || '').trim();
  if (!name) { _tsSetError(c, 'Name is required.'); return; }
  const newEntry = { humanity, name, desc: String(draft.desc || '') };

  try {
    const nextTouchstones = existing.concat([newEntry]);
    await apiPut('/api/characters/' + charId, { touchstones: nextTouchstones });
    c.touchstones = nextTouchstones;
    delete c._ts_picker;
    _renderSheet(c);
  } catch (err) {
    console.error('[touchstone] add error:', err);
    _tsSetError(c, 'Save failed: ' + (err?.message || 'unknown error'));
  }
}

export async function shTouchstoneSaveEdit() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const picker = c._ts_picker;
  if (!picker || picker.mode !== 'edit') return;
  const i = picker.index;
  const t = (c.touchstones || [])[i];
  if (!t) { delete c._ts_picker; _renderSheet(c); return; }

  const newName = String(picker.draft.name || '').trim();
  const newDesc = String(picker.draft.desc || '');
  if (!newName) { _tsSetError(c, 'Name is required.'); return; }

  const nextTouchstones = c.touchstones.map((entry, idx) =>
    idx === i ? { ...entry, name: newName, desc: newDesc } : entry
  );
  const charId = String(c._id);

  try {
    await apiPut('/api/characters/' + charId, { touchstones: nextTouchstones });
    c.touchstones = nextTouchstones;
    delete c._ts_picker;
    _renderSheet(c);
  } catch (err) {
    console.error('[touchstone] edit error:', err);
    _tsSetError(c, 'Save failed: ' + (err?.message || 'unknown error'));
  }
}

export async function shTouchstoneRemove(i) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const t = (c.touchstones || [])[i];
  if (!t) return;

  const ok = await _tsConfirmModal({
    title: 'Remove touchstone?',
    body: 'The touchstone will be removed.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  _tsClearError(c);

  const charId = String(c._id);
  const nextTouchstones = c.touchstones.filter((_, idx) => idx !== +i);

  try {
    await apiPut('/api/characters/' + charId, { touchstones: nextTouchstones });
    c.touchstones = nextTouchstones;
    _renderSheet(c);
  } catch (err) {
    console.error('[touchstone] remove error:', err);
    _tsSetError(c, 'Remove failed: ' + (err?.message || 'unknown error'));
  }
}

/* ══════════════════════════════════════════════════════════
   TOUCHSTONE SHARED HELPERS
   ----------------------------------------------------------
   All user-facing prompts use themed modals (NPCR.3 pattern)
   — never window.confirm/prompt/alert. Errors surface via an
   inline banner inside the touchstone section.
══════════════════════════════════════════════════════════ */

function _tsConfirmModal({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'npcr-modal-overlay';
    overlay.innerHTML = `
      <div class="npcr-modal" role="dialog" aria-labelledby="sh-ts-modal-title">
        <div class="npcr-modal-title" id="sh-ts-modal-title">${_esc(title)}</div>
        <div class="npcr-modal-body"><p>${_esc(body)}</p></div>
        <div class="npcr-modal-actions">
          <button class="npcr-btn muted" data-act="cancel">${_esc(cancelLabel)}</button>
          <button class="npcr-btn ${danger ? 'danger' : 'save'}" data-act="confirm">${_esc(confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const confirmBtn = overlay.querySelector('[data-act="confirm"]');
    setTimeout(() => confirmBtn?.focus(), 0);

    function close(result) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) close(true);
    }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
  });
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function _tsSetError(c, msg) {
  c._ts_err = String(msg || '');
  _renderSheet(c);
}
function _tsClearError(c) {
  if (c._ts_err) { delete c._ts_err; }
}


/* ══════════════════════════════════════════════════════════
   BLOOD POTENCY & HUMANITY
══════════════════════════════════════════════════════════ */

function _deriveBP(c) {
  const bc = c.bp_creation || {};
  return Math.max(0, 1 + Math.floor((bc.cp || 0) / 5) + Math.floor((bc.xp || 0) / 5) - (bc.lost || 0));
}

// Legacy direct setters (used by app.js player sheet)
export function shEditBP(val) {
  if (state.editIdx < 0) return;
  state.chars[state.editIdx].blood_potency = Math.max(0, Math.min(10, parseInt(val) || 0));
  _markDirty();
  _renderSheet(state.chars[state.editIdx]);
}
export function shEditHumanity(val) {
  if (state.editIdx < 0) return;
  state.chars[state.editIdx].humanity = Math.max(0, Math.min(10, parseInt(val) || 0));
  _markDirty();
  _renderSheet(state.chars[state.editIdx]);
}

function _deriveHumanity(c) {
  return Math.max(0, Math.min(10, (c.humanity_base || 7) + Math.floor((c.humanity_xp || 0) / 2) - (c.humanity_lost || 0)));
}

export function shEditBPCreation(val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.bp_creation) c.bp_creation = {};
  c.bp_creation.cp = Math.max(0, Math.min(10, val || 0));
  c.blood_potency = _deriveBP(c);
  _markDirty();
  _renderSheet(c);
}

export function shEditBPXP(val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.bp_creation) c.bp_creation = {};
  c.bp_creation.xp = Math.max(0, val || 0);
  c.blood_potency = _deriveBP(c);
  _markDirty();
  _renderSheet(c);
}

export function shEditBPLost(val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.bp_creation) c.bp_creation = {};
  c.bp_creation.lost = Math.max(0, val || 0);
  c.blood_potency = _deriveBP(c);
  _markDirty();
  _renderSheet(c);
}

export function shEditHumanityXP(val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  c.humanity_xp = Math.max(0, val || 0);
  c.humanity = _deriveHumanity(c);
  _markDirty();
  _renderSheet(c);
}

export function shEditHumanityLost(val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  c.humanity_lost = Math.max(0, val || 0);
  c.humanity = _deriveHumanity(c);
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   STATUS UP/DOWN
══════════════════════════════════════════════════════════ */

export function shStatusUp(key) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.status) c.status = {};
  // status.covenant is an object keyed by full covenant name (post-unification),
  // not an integer like status.city/clan. Writing to status[key] directly would
  // clobber the whole object → NaN on next read → "wiped + locked" UI.
  if (key === 'covenant') {
    if (c.covenant) shCovStandingUp(c.covenant);
    return;
  }
  c.status[key] = Math.min(key === 'city' ? 10 : 5, (c.status[key] || 0) + 1);
  _markDirty();
  _renderSheet(c);
}

export function shStatusDown(key) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.status) c.status = {};
  if (key === 'covenant') {
    if (c.covenant) shCovStandingDown(c.covenant);
    return;
  }
  c.status[key] = Math.max(0, (c.status[key] || 0) - 1);
  _markDirty();
  _renderSheet(c);
}

const _COV_SHORT_FULL = { 'Carthian': 'Carthian Movement', 'Crone': 'Circle of the Crone', 'Invictus': 'Invictus', 'Lance': 'Lancea et Sanctum', 'Ordo': 'Ordo Dracul' };
function _ensureCovObj(c) {
  if (!c.status) c.status = {};
  if (!c.status.covenant || typeof c.status.covenant !== 'object') {
    c.status.covenant = { 'Carthian Movement': 0, 'Circle of the Crone': 0, 'Invictus': 0, 'Lancea et Sanctum': 0, 'Ordo Dracul': 0 };
  }
}

export function shCovStandingUp(label) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  _ensureCovObj(c);
  const full = _COV_SHORT_FULL[label] || label;
  c.status.covenant[full] = Math.min(5, (c.status.covenant[full] || 0) + 1);
  _markDirty();
  _renderSheet(c);
}

export function shCovStandingDown(label) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  _ensureCovObj(c);
  const full = _COV_SHORT_FULL[label] || label;
  c.status.covenant[full] = Math.max(0, (c.status.covenant[full] || 0) - 1);
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   ATTRIBUTE PRIORITIES & CREATION POINTS
══════════════════════════════════════════════════════════ */

export function shSetPriority(cat, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.attribute_priorities) c.attribute_priorities = {};
  const old = c.attribute_priorities[cat];
  if (old === val) return;
  // Swap: find who currently has this value and give them the old one
  const cats = ['Mental', 'Physical', 'Social'];
  cats.forEach(k => {
    if (k !== cat && c.attribute_priorities[k] === val) {
      c.attribute_priorities[k] = old || 'Tertiary';
    }
  });
  c.attribute_priorities[cat] = val;
  _markDirty();
  _renderSheet(c);
}

export function shEditAttrPt(attr, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.attributes[attr]) c.attributes[attr] = { dots: 0, cp: 0, xp: 0, rule_key: null };
  const ao = c.attributes[attr];
  if (ao.cp === undefined) ao.cp = 0;
  if (ao.xp === undefined) ao.xp = 0;
  val = Math.max(0, val || 0);
  if (field === 'cp') {
    // Enforce category CP cap
    const cat = Object.entries(ATTR_CATS).find(([k, v]) => v.includes(attr));
    if (cat) {
      const pri = (c.attribute_priorities || {})[cat[0]] || 'Primary';
      const budget = PRI_BUDGETS[pri] || 5;
      const otherCP = cat[1].filter(a => a !== attr).reduce((s, a) => s + ((c.attributes?.[a]?.cp) || 0), 0);
      val = Math.min(val, budget - otherCP);
      if (val < 0) val = 0;
    }
  }
  ao[field] = val;
  const attrBase = (ao.cp || 0) + 1 + (c.clan_attribute === attr ? 1 : 0);
  ao.dots = attrBase + xpToDots(ao.xp || 0, attrBase, 4);
  // Recalculate xp_log.spent.attributes: flat sum of all attr XP costs
  if (!c.xp_log) c.xp_log = { earned: {}, spent: {} };
  let attrXpTotal = 0;
  const NINE_ATTRS = ['Intelligence', 'Wits', 'Resolve', 'Strength', 'Dexterity', 'Stamina', 'Presence', 'Manipulation', 'Composure'];
  NINE_ATTRS.forEach(a => { attrXpTotal += (c.attributes?.[a]?.xp) || 0; });
  c.xp_log.spent.attributes = attrXpTotal;
  // #837: xp_total / xp_spent no longer persisted — derived at render via xp.js.
  _markDirty();
  _renderSheet(c);
}

// STM-14 (#1034): shAdjAttrBonus / shAdjSkillBonus retired — they wrote
// c.attributes[X].bonus / c.skills[X].bonus directly, unaudited. Ad-hoc
// bonuses now go through the audited st_mods apply affordance on the
// rendered (non-edit) sheet (editor/st-mod-popover.js applyAffordance).
//
// TM Admin Story tm-admin.10.1b (AC3): shAdjMeritBonus — the merit-channel
// equivalent STM-14 deliberately left out of its own scope
// (specs/qa/gates/1034.1-stm-14-audited-adhoc-bonus.yml:106) — is retired
// here too, on the same terms. It wrote c.merits[X].bonus directly,
// unaudited (feature.333/feature.335). Ad hoc merit bonuses now go through
// the same audited st_mods apply affordance, wired into shRenderMeritRow
// and the Domain/Standing view rows (editor/sheet.js).

export function shSetClanAttr(val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const oldCA = c.clan_attribute;
  c.clan_attribute = val;
  // Recalculate dots for old and new clan attr
  [oldCA, val].forEach(attr => {
    if (!attr) return;
    if (!c.attributes[attr]) c.attributes[attr] = { dots: 0, cp: 0, xp: 0, rule_key: null };
    const ao = c.attributes[attr];
    if (ao.cp === undefined) ao.cp = 0;
    if (ao.xp === undefined) ao.xp = 0;
    const aBase = (ao.cp || 0) + 1 + (c.clan_attribute === attr ? 1 : 0);
    ao.dots = aBase + xpToDots(ao.xp || 0, aBase, 4);
  });
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   DISCIPLINES
══════════════════════════════════════════════════════════ */

export function shEditDiscPt(disc, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];

  // BL-2 (#1008): refuse the write while this character's bloodline does not
  // resolve. The in-clan answer feeding discCostMult below is untrustworthy
  // until it does, and committing a dot bought against it bakes a wrong cost
  // into the document - which is the defect this epic exists to stop. The
  // guard lives HERE rather than only on the input's `disabled` attribute
  // because there are two independent discipline-editing surfaces; enforcing
  // in one template would leave the rule true on one screen and false on the
  // other. Nothing is mutated, not even an empty disciplines map.
  if (bloodlineUnresolved(c)) {
    console.warn(`[edit] discipline edit refused: "${c.bloodline}" does not resolve for ${c.name || 'this character'}.`);
    // Re-render so the input snaps back to the stored value. Without this the
    // typed number sits in the box looking accepted, and reverts later at some
    // unrelated re-render — which is a worse lie than the one this guards.
    // The inputs also carry `disabled` (sheet.js), so this is the belt to that
    // brace: the handler is reachable from a second editing surface.
    if (_renderSheet) _renderSheet(c);
    return;
  }

  if (!c.disciplines) c.disciplines = {};
  if (!c.disciplines[disc]) c.disciplines[disc] = { dots: 0, cp: 0, free: 0, xp: 0, rule_key: null };
  val = Math.max(0, val || 0);
  if (field === 'cp') {
    // Enforce: 3 total CP, max 1 out-of-clan CP.
    // Only count valid purchasable disciplines.
    const _validDiscs = new Set([...CORE_DISCS, ...RITUAL_DISCS]);
    const isIC = isInClanDisc(c, disc);
    const otherCP = Object.entries(c.disciplines)
      .filter(([d]) => d !== disc && _validDiscs.has(d))
      .reduce((s, [, v]) => s + (v.cp || 0), 0);
    val = Math.min(val, 3 - otherCP);
    if (!isIC) {
      const otherOutCP = Object.entries(c.disciplines)
        .filter(([d]) => d !== disc && _validDiscs.has(d) && !isInClanDisc(c, d))
        .reduce((s, [, v]) => s + (v.cp || 0), 0);
      val = Math.min(val, 1 - otherOutCP);
    }
    if (val < 0) val = 0;
  }
  c.disciplines[disc][field] = val;
  const cr = c.disciplines[disc];
  // CODE REVIEW FIX (2026-08-31): discBase omitted cr.free entirely, so any discipline
  // with rules-granted free dots (a bloodline grant, etc.) had them silently dropped from
  // dots on every edit - confirmed live against 2 real characters (Charlie Ballsack's
  // Resilience, René Meyer's Majesty). free is now included in the base the same way it
  // already is for the CP/XP cap arithmetic above.
  const discBase = (cr.cp || 0) + (cr.free || 0);
  const discCostMult = isInClanDisc(c, disc) ? 3 : 4;
  cr.dots = discBase + xpToDots(cr.xp || 0, discBase, discCostMult);
  // Recalculate XP spent on disciplines
  if (!c.xp_log) c.xp_log = { earned: {}, spent: {} };
  let discXpTotal = 0;
  Object.entries(c.disciplines || {}).forEach(([d, v]) => {
    discXpTotal += v.xp || 0;
  });
  c.xp_log.spent.powers = discXpTotal;
  // #837: xp_total / xp_spent no longer persisted — derived at render via xp.js.
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   SKILLS — SPECIALISATIONS & PRIORITIES
══════════════════════════════════════════════════════════ */

export function shEditSpec(skill, idx, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const sk = c.skills?.[skill];
  if (!sk || !sk.specs) return;
  sk.specs[idx] = val;
  _markDirty();
}

export function shRemoveSpec(skill, idx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const sk = c.skills?.[skill];
  if (!sk || !sk.specs) return;
  sk.specs.splice(idx, 1);
  _markDirty();
  _renderSheet(c);
}

export function shAddSpec(skill) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.skills) c.skills = {};
  if (!c.skills[skill]) c.skills[skill] = { dots: 0, specs: [], nine_again: false };
  if (!c.skills[skill].specs) c.skills[skill].specs = [];
  c.skills[skill].specs.push('');
  _markDirty();
  _renderSheet(c);
}

export function shSetSkillPriority(cat, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.skill_priorities) c.skill_priorities = {};
  const old = c.skill_priorities[cat];
  if (old === val) return;
  const cats = ['Mental', 'Physical', 'Social'];
  cats.forEach(k => {
    if (k !== cat && c.skill_priorities[k] === val) {
      c.skill_priorities[k] = old || 'Tertiary';
    }
  });
  c.skill_priorities[cat] = val;
  _markDirty();
  _renderSheet(c);
}

export function shEditSkillPt(skill, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.skills) c.skills = {};
  if (!c.skills[skill]) c.skills[skill] = { dots: 0, specs: [], nine_again: false, cp: 0, xp: 0, rule_key: null };
  const so = c.skills[skill];
  if (so.cp === undefined) so.cp = 0;
  if (so.xp === undefined) so.xp = 0;
  val = Math.max(0, val || 0);
  if (field === 'cp') {
    const cat = Object.entries(SKILL_CATS).find(([k, v]) => v.includes(skill));
    if (cat) {
      const pri = (c.skill_priorities || {})[cat[0]] || 'Primary';
      const budget = SKILL_PRI_BUDGETS[pri] || 11;
      const otherCP = cat[1].filter(s => s !== skill).reduce((s, sk) => s + ((c.skills?.[sk]?.cp) || 0), 0);
      val = Math.min(val, budget - otherCP);
      if (val < 0) val = 0;
    }
  }
  so[field] = val;
  // REVERTED 2026-08-31 (code review): a prior pass here added `so.free` to skBase, on the
  // assumption skill free-dots follow the same "silently dropped" pattern disciplines have.
  // Confirmed wrong before shipping: unlike disciplines' `free` (genuinely read and displayed
  // by discBonusSources/discCard), skill `.free` is read NOWHERE in this app's live code -
  // grepped both repos, zero matches outside this now-reverted edit. Charlie Ballsack's
  // Weaponry `free:1` (the case that looked like a dropped grant) turned out to be stale/
  // unused data, confirmed directly by Angelus - not a real grant this formula should sum.
  const skBase = so.cp || 0;
  so.dots = skBase + xpToDots(so.xp || 0, skBase, 2);
  // Recalculate XP spent on skills
  if (!c.xp_log) c.xp_log = { earned: {}, spent: {} };
  let skXpTotal = 0;
  ALL_SKILLS.forEach(s => { skXpTotal += (c.skills?.[s]?.xp) || 0; });
  c.xp_log.spent.skills = skXpTotal;
  // #837: xp_total / xp_spent no longer persisted — derived at render via xp.js.
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   ORDEALS & XP
══════════════════════════════════════════════════════════ */

export function shToggleOrdeal(idx, checked) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.ordeals || !c.ordeals[idx]) return;
  c.ordeals[idx].complete = checked;
  c.ordeals[idx].xp = checked ? 3 : 0;
  // Recalculate ordeals total in xp_log
  if (!c.xp_log) c.xp_log = { earned: {}, spent: {} };
  c.xp_log.earned.ordeals = c.ordeals.reduce((s, o) => s + (o.xp || 0), 0);
  _markDirty();
  _renderSheet(c);
}

export function shEditXP(bucket, key, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.xp_log) c.xp_log = { earned: {}, spent: {} };
  if (!c.xp_log[bucket]) c.xp_log[bucket] = {};
  c.xp_log[bucket][key] = val || 0;
  // #837: xp_total / xp_spent no longer persisted — derived at render via xp.js.
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   DEVOTIONS
══════════════════════════════════════════════════════════ */

export function shShowDevSelect(btn) {
  const sel = document.getElementById('dev-add-select');
  if (!sel) return;
  if (sel.style.display === 'none') {
    sel.style.display = '';
    btn.textContent = 'Confirm';
  } else {
    // Actually add the devotion — sel.value is the rule's DB key, use it directly
    if (!sel.value) return;
    const c = state.chars[state.editIdx];
    const rule = getRuleByKey(sel.value);
    if (!rule) return;
    if (!c.powers) c.powers = [];
    if (c.powers.some(p => p.category === 'devotion' && p.name === rule.name)) return;
    const devStats = [rule.pool ? `Pool: ${[rule.pool.attr, rule.pool.skill, rule.pool.disc].filter(Boolean).join(' + ')}` : '', rule.action, rule.duration].filter(Boolean).join('  •  ');
    c.powers.push({ category: 'devotion', name: rule.name, stats: devStats, effect: rule.description || '' });
    _markDirty();
    _renderSheet(c);
  }
}

export function shAddDevotion() {
  shShowDevSelect(document.querySelector('.dev-add-btn'));
}

export function shRemoveDevotion(idx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const devPowers = (c.powers || []).filter(p => p.category === 'devotion');
  const target = devPowers[idx];
  if (!target) return;
  const realIdx = c.powers.indexOf(target);
  if (realIdx >= 0) c.powers.splice(realIdx, 1);
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   RITES
══════════════════════════════════════════════════════════ */

export function shAddRite(tradition, name, level) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  name = (name || '').trim();
  if (!name) return;
  level = Math.max(1, Math.min(5, parseInt(level) || 1));
  const discDots = tradition === 'Cruac' ? (c.disciplines || {}).Cruac?.dots || 0 : (c.disciplines || {}).Theban?.dots || 0;
  const pool = discDots * 2;
  const usedFree = (c.powers || []).filter(p => p.category === 'rite' && p.tradition === tradition && p.free).length;
  const free = level <= discDots && usedFree < pool;
  if (!c.powers) c.powers = [];
  c.powers.push({ category: 'rite', name, tradition, level, free });
  _markDirty();
  _renderSheet(c);
}

export function shRemoveRite(powerIdx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.powers || !c.powers[powerIdx]) return;
  c.powers.splice(powerIdx, 1);
  _markDirty();
  _renderSheet(c);
}

export function shToggleRiteFree(powerIdx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const p = (c.powers || [])[powerIdx];
  if (!p || p.category !== 'rite') return;
  const discDots = p.tradition === 'Cruac' ? (c.disciplines || {}).Cruac?.dots || 0 : (c.disciplines || {}).Theban?.dots || 0;
  if (!p.free) {
    const pool = discDots * 2;
    const usedFree = (c.powers || []).filter((q, qi) => qi !== powerIdx && q.category === 'rite' && q.tradition === p.tradition && q.free).length;
    if (usedFree >= pool || p.level > discDots) return;
    p.free = true;
  } else {
    p.free = false;
  }
  _markDirty();
  _renderSheet(c);
}

/** Rebuild the rite-add dropdown when the tradition selector changes. */
export function shRefreshRiteDropdown(tradition) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const discDots = tradition === 'Cruac' ? (c.disciplines || {}).Cruac?.dots || 0 : (c.disciplines || {}).Theban?.dots || 0;
  const allRites = getRulesByCategory('rite');
  const tradRites = allRites
    .filter(r => r.parent === tradition && r.rank != null && r.rank <= discDots)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const sel = document.getElementById('rite-add-name');
  if (!sel || sel.tagName !== 'SELECT') return;
  sel.innerHTML = '<option value="" data-rank="" disabled selected>\u2014 select rite \u2014</option>' +
    tradRites.map(r => '<option value="' + r.name.replace(/"/g, '&quot;') + '" data-rank="' + r.rank + '">' + '\u25CF'.repeat(r.rank) + ' ' + r.name + '</option>').join('');
}

/* ══════════════════════════════════════════════════════════
   PACTS
══════════════════════════════════════════════════════════ */

export function shAddPact(name) {
  if (state.editIdx < 0) return;
  // Title-case (MERITS_DB stores lowercase keys/names; stored pacts use title case)
  name = (name || '').trim().replace(/\b\w/g, ch => ch.toUpperCase());
  if (!name) return;
  const c = state.chars[state.editIdx];
  if (!c.powers) c.powers = [];
  if (c.powers.some(p => p.category === 'pact' && p.name.toLowerCase() === name.toLowerCase())) return;
  c.powers.push({ category: 'pact', name });
  _markDirty();
  _renderSheet(c);
}

export function shRemovePact(powerIdx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.powers || !c.powers[powerIdx]) return;
  c.powers.splice(powerIdx, 1);
  _markDirty();
  _renderSheet(c);
}

export function shEditPact(powerIdx, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const p = (c.powers || [])[powerIdx];
  if (!p || p.category !== 'pact') return;
  if (field === 'ohm_skill_0' || field === 'ohm_skill_1') {
    if (!p.ohm_skills) p.ohm_skills = ['', ''];
    p.ohm_skills[field === 'ohm_skill_0' ? 0 : 1] = val || '';
  } else if (field === 'cp' || field === 'xp') {
    p[field] = Math.max(0, parseInt(val) || 0);
  } else {
    p[field] = val || null;
  }
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   MERIT CREATION POINTS
══════════════════════════════════════════════════════════ */

/** Return sorted array of legal non-zero ratings for a merit. Tries rules cache, falls back to MERITS_DB. */
function _meritLegalRatings(meritName) {
  if (!meritName) return null;
  // Try rules cache
  const slug = meritName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const rule = getRuleByKey(slug);
  if (rule?.rating_range) {
    const [min, max] = rule.rating_range;
    if (min === max) return [min];
    return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  }
  return null;
}

/** Step a merit's total rating to the next/prev legal value (adjusts CP only). */
export function shStepMeritRating(realIdx, dir) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  ensureMeritSync(c);
  const m = c.merits[realIdx];
  if (!m) return;
  const current = (m.cp || 0) + (m.xp || 0);
  const legal = _meritLegalRatings(m.name); // [min..max] or [fixed], or null
  let next;
  if (!legal) {
    // Unknown merit — step by 1, clamp 0-5
    next = Math.max(0, Math.min(5, current + dir));
  } else if (legal.length === 1) {
    // Fixed merit: toggle between 0 and the fixed value
    next = current === 0 ? legal[0] : 0;
  } else {
    // Range: step within [0, min..max]
    const all = [0, ...legal];
    if (dir > 0) next = all.find(v => v > current) ?? current;
    else { const below = all.filter(v => v < current); next = below.length ? below[below.length - 1] : current; }
  }
  if (next === current) return;
  // Adjust CP by the delta, keeping fr and xp fixed
  const delta = next - current;
  let newCP = Math.max(0, (m.cp || 0) + delta);
  // Cap by budget if increasing
  if (delta > 0) {
    const otherCP = (c.merits || []).reduce((s, m2, i) => s + (i === realIdx ? 0 : (m2.cp || 0)), 0)
      + (c.fighting_styles || []).reduce((s, fs) => s + (fs.cp || 0), 0);
    newCP = Math.min(newCP, Math.max(0, 10 - otherCP));
  }
  m.cp = newCP;
  m.rating = (m.cp || 0) + (m.xp || 0);
  // Issue #39 Task 2: rating-stepper can decrease a Contacts merit; prune
  // its spheres array to match.
  pruneContactsSpheres(m);
  _markDirty();
  _renderSheet(c);
}

/**
 * A shallow copy of merit `m` with `field` zeroed, for measuring how much
 * that field contributes to the merit's owned rating. Handles both the flat
 * shape (`cp`, `xp`, `free_mci`) and the dotted allocator shape
 * (`free_grants.<slug>`). Never mutates `m`.
 */
function _meritWithFieldCleared(m, field) {
  if (field.startsWith('free_grants.')) {
    const slug = field.slice('free_grants.'.length);
    const fg = { ...(m.free_grants || {}) };
    delete fg[slug];
    return { ...m, free_grants: fg };
  }
  return { ...m, [field]: 0 };
}

export function shEditMeritPt(realIdx, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  ensureMeritSync(c);
  const m = c.merits[realIdx];
  if (!m) return;
  val = Math.max(0, parseInt(val) || 0);
  // ── OATH-A (issue #1111, ADR-010 D1/D2) — pledged-dot edit gate ──────────
  // The editor refuses to sell or reallocate dots pledged to a standing
  // Swear By oath. This is a FLOOR ON THE WRITE and nothing else: no sum
  // anywhere is altered, and the pledged dots remain fully usable
  // (encumbrance is display + edit gate, D2). Same clamp idiom as the pool
  // caps below.
  //
  // The floor is computed against what this field CONTRIBUTES, measured by
  // re-running meritRating on a copy of the merit with the field cleared.
  //
  // #1111 QA: this was previously `_ownedNow - (m[field] || 0)` behind a
  // `!field.startsWith('free_grants.')` guard, which had the bypass exactly
  // backwards. meritRating SUMS ten free_grants channels (bloodline, pet,
  // mci, vm, lk, ohm, inv, pt, mdb, sw) and pledgeableDots measures pledges
  // in meritRating terms, so the dots that CAN be pledged were precisely the
  // ones the guard exempted from the floor protecting them — and xp.js emits
  // shEditMeritPt(idx, 'free_grants.mci', ...) straight from the bd-row, so
  // it was reachable from the UI. The failure was UNDER-clamping, not the
  // over-clamping the guard was written to avoid.
  //
  // Clearing the field and re-measuring handles dotted and flat paths alike
  // with no per-slug allowlist. Channels meritRating does NOT count (e.g.
  // free_grants.necro) still measure a 0 contribution and so still never
  // clamp — that property now falls out of the measurement instead of
  // depending on a prefix guard.
  //
  // #1111 QA round 2: the floor is COMPUTED here but APPLIED after the pool
  // caps below, because each cap does `val = Math.min(val, available)` and
  // would otherwise push val straight back under the floor just computed.
  // Round 1 fixed the measurement; the enforcement was still non-uniform
  // underneath it. Several channels passed only by accident of whether their
  // pool's "used" helper counts the merit being edited, so this is a
  // class-wide ordering fix rather than a per-channel one.
  const _pledgedHere = pledgedDots(c, m);
  let _floor = 0;
  if (_pledgedHere > 0 && typeof field === 'string') {
    const _ownedWithoutField = meritRating(c, _meritWithFieldCleared(m, field));
    _floor = Math.max(0, _pledgedHere - _ownedWithoutField);
  }
  delete m._pledgeFloorNote;
  /**
   * Apply the pledge floor AFTER every cap. Floor wins on reductions (SM
   * ruling): when a cap sits below the floor the merit ALREADY holds more
   * dots than the pool can fund, that over-commitment predates this edit,
   * and a reduction does not worsen it — whereas letting the cap win would
   * silently void part of a standing pledge, invisibly, leaving the oath
   * claiming dots the merit no longer has.
   *
   * Caps still bind as UPPER bounds: this only ever raises val, never lowers
   * it, so it cannot license allocating dots a pool does not have.
   *
   * When the floor overrides a cap, `_pledgeFloorNote` records it so the
   * editor can say so. It is EDIT-TIME FEEDBACK: "the change you just made
   * was overridden, and here is why". It is set as a side effect of an edit
   * and is therefore absent on a fresh load, which is correct for what it
   * is — an override notice has nothing to report when no edit happened,
   * and has no business in the read-only renderer.
   *
   * It is NOT a standing "this character is over-committed" indicator. That
   * is a different feature: it would have to be derived at render time from
   * pledges versus pool capacity, independent of any edit, and surface in
   * both renderers. Filed as #1122; deliberately not built here, because
   * folding it in would smuggle a feature into a bug fix.
   *
   * The note is `_`-prefixed, so both save paths strip it per merit and it
   * can never persist.
   */
  const _applyPledgeFloor = (v) => {
    if (_floor <= 0 || v >= _floor) return v;
    const _oaths = swornOaths(c)
      .filter(o => o.sworn_by.attachments.some(a => meritMatchesRef(m, a)))
      .map(o => o.name);
    m._pledgeFloorNote = 'Held at ' + _floor + ' dot' + (_floor === 1 ? '' : 's')
      + ' - ' + _pledgedHere + ' pledged to ' + (_oaths.join(', ') || 'a standing oath')
      + '. The pool cannot fund what is already sworn.';
    return _floor;
  };
  // Cap CP edits by the 10-point merit creation budget
  if (field === 'cp') {
    const otherCP = (c.merits || []).reduce((s, m2, i) => s + (i === realIdx ? 0 : (m2.cp || 0)), 0)
      + (c.fighting_styles || []).reduce((s, fs) => s + (fs.cp || 0), 0);
    val = Math.min(val, Math.max(0, 10 - otherCP));
  }
  // Cap free_mci edits by remaining MCI pool
  if (field === 'free_mci') {
    const mciTotal = (c.merits || []).filter(m2 => m2.name === 'Mystery Cult Initiation' && m2.active !== false)
      .reduce((s, m2) => s + mciPoolTotal(m2), 0);
    const otherFMCI = getMCIPoolUsed(c) - freeOf(m, 'mci');
    val = Math.min(val, Math.max(0, mciTotal - otherFMCI));
  }
  // Cap free_vm edits by remaining VM pool (shared across Allies + Herd)
  if (field === 'free_vm') {
    const vmTotal = vmPool(c);
    const otherFVM = vmUsed(c) - freeOf(m, 'vm');
    val = Math.min(val, Math.max(0, vmTotal - otherFVM));
  }
  // Cap free_inv edits by remaining Invested pool
  if (field === 'free_inv') {
    const invTotal = investedPool(c);
    const otherFINV = investedUsed(c) - freeOf(m, 'inv');
    val = Math.min(val, Math.max(0, invTotal - otherFINV));
  }
  // Cap free_lk edits by remaining Lorekeeper pool (rule-driven sum across LK rule_grant docs)
  if (field === 'free_lk') {
    const lkTotal = lorekeeperPool(c);
    const otherFLK = lorekeeperUsed(c) - freeOf(m, 'lk');
    val = Math.min(val, Math.max(0, lkTotal - otherFLK));
  }
  // N-7 / N-9: post-N-1 allocator write path. Field shape `free_grants.<slug>`
  // routes to the map; cap enforced by `poolAvailableFor` (which union-reads
  // map + legacy via freeOf across all merits, then subtracts from the
  // category's _grant_pools capacity). Adding the CURRENT row's own value
  // back into the cap so editing your own slot doesn't double-count.
  //
  //   ADR-005 amendment (under D6): allocators introduced post-N-1 write
  //   `m.free_grants[slug]` directly; no new legacy flat field. MCI was
  //   migrated to the map shape in N-9 (the input still says "MCI" but the
  //   write target is now `free_grants.mci`). LK / Inv / VM retain their
  //   legacy field writes until the deferred MNEC-prerequisite audit.
  if (typeof field === 'string' && field.startsWith('free_grants.')) {
    const slug = field.slice('free_grants.'.length);
    const current = (m.free_grants && m.free_grants[slug]) || 0;
    const avail = poolAvailableFor(c, slug) + current;
    val = Math.min(val, Math.max(0, avail));
    val = _applyPledgeFloor(val);
    m.free_grants = m.free_grants || {};
    if (val > 0) m.free_grants[slug] = val;
    else delete m.free_grants[slug];
    m.rating = syncMeritRating(m);
    pruneContactsSpheres(m);
    _markDirty();
    _renderSheet(c);
    return;
  }
  val = _applyPledgeFloor(val);
  m[field] = val;
  // Sync stored rating via shared helper — never hand-roll the sum or new
  // free_* channels get silently dropped on every edit (was the case for
  // free_pt / free_mdb / free_sw / free_fwb / free_attache before this).
  m.rating = syncMeritRating(m);
  // Issue #39 Task 2: any cp/xp/free_* mutation can drop a Contacts merit's
  // effective rating; prune its spheres array to match.
  pruneContactsSpheres(m);
  _markDirty();
  _renderSheet(c);
}


// ── Equipment (EQ-4, issue #665) ─────────────────────────────────────────────

export function shEquipBucketFilter() {
  const bucket  = document.getElementById('eq-add-bucket')?.value;
  const itemSel = document.getElementById('eq-add-item');
  if (!itemSel) return;
  const entries = bucket ? getCatalogueByBucket(bucket) : [];
  // #896: append effective availability per the character being edited.
  // ST admin BYPASSES the affordability gate — every option remains enabled
  // regardless of whether the character could acquire it via DT — but the
  // label still surfaces the effective number for consistency with player
  // surfaces (sheet rows, DT dropdown).
  const c = (state.editIdx != null && state.editIdx >= 0) ? state.chars[state.editIdx] : null;
  // ECM-5: option `value` is the catalogue ObjectId in 24-hex string form.
  // ECM-3's PUT/POST coercion hydrates it back to an ObjectId on the server.
  itemSel.innerHTML = '<option value="">-- select item --</option>'
    + entries.map(e => {
      const eff = (c && e.availability != null) ? effectiveAvailability(e, c) : null;
      const availTag = eff != null ? ` (avail ${eff})` : '';
      return `<option value="${String(e._id)}">${e.name}${availTag}</option>`;
    }).join('');
}

export async function shAddEquip() {
  if (state.editIdx < 0) return;
  const c          = state.chars[state.editIdx];
  const charId     = String(c._id);
  const catalogueId = document.getElementById('eq-add-item')?.value;
  const itemState   = document.getElementById('eq-add-state')?.value;
  const notes       = document.getElementById('eq-add-notes')?.value?.trim() || null;
  if (!catalogueId || !itemState) return;
  const cycle = parseInt(document.getElementById('eq-add-cycle')?.value ?? '0', 10) || 0;
  // EQC-3 (issue #1154, epic #1038): "Place inside" — the picker only
  // renders when the character owns at least one container (see
  // editor/sheet.js's shRenderEquipment), so its absence from the DOM is the
  // normal "no containers yet" case, not an error - containerId stays null.
  const containerId = document.getElementById('eq-add-container')?.value || null;
  try {
    const result = await apiPost('/api/characters/' + charId + '/equipment', {
      catalogue_id:   catalogueId,
      state:          itemState,
      acquired_cycle: cycle,
      notes,
      container_id:   containerId,
    });
    c.equipment = result.equipment;
    _renderSheet(c);
  } catch (err) {
    console.error('[equipment] add error:', err);
  }
}

export async function shRemoveEquip(idx) {
  if (state.editIdx < 0) return;
  const c      = state.chars[state.editIdx];
  const charId = String(c._id);
  try {
    const result = await apiDelete('/api/characters/' + charId + '/equipment/' + idx);
    c.equipment = result.equipment;
    _renderSheet(c);
  } catch (err) {
    console.error('[equipment] remove error:', err);
  }
}

// shAddAsset + shRemoveAsset REMOVED 2026-06-19 — character.assets[] consolidated
// into equipment[]. Asset-bucket catalogue items now flow through shAddEquip.
