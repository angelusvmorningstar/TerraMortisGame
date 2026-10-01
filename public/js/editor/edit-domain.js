/* Merit-category edit handlers — split from edit.js to stay under 500 lines */

import state from '../data/state.js';
import { meritByCategory, addMerit, removeMerit } from './merits.js';
import { mciPoolTotal } from './mci.js';
import { getRuleByKey } from '../data/loader.js';
import { DOMAIN_MERIT_TYPES } from '../data/constants.js';
import { pruneContactsSpheres, domKey } from './domain.js';
// OATH-A (#1111, ADR-010 D1/D1b/D4): pledge validation + the sworn_by
// builder are pure helpers; meritRating is the OWNED-dots formula they
// take injected, so no second copy of merit-dot arithmetic is created.
import { freeOf, normaliseAttachedTo, validatePledge, buildSwornBy, resolveRatingBasis, OATH_EXIT_REASONS, buildOathExitEvent, buildOathRestoredEvent, oathSuspendedDots } from '../data/rules-helpers.js';
import { meritRating } from './xp.js';
import { resolveSharedWithMember as _resolveSharedWithMember } from '../data/helpers.js';
import { stripOverlay } from '../data/st-mods.js';

function ruleKeyFor(name) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return getRuleByKey(slug)?.key || null;
}

function stolenMeritCategory(name) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const rule = getRuleByKey(slug);
  if (rule?.sub_category === 'domain') return 'domain';
  return DOMAIN_MERIT_TYPES.includes(name) ? 'domain' : 'general';
}

/* ── Callback registration (same pattern as edit.js) ── */
let _markDirty, _renderSheet;
export function registerCallbacks(markDirty, renderSheet) {
  _markDirty = markDirty;
  _renderSheet = renderSheet;
}

/* ── Partner dirty tracking — populated by domain sharing edits ── */
const _dirtyPartners = new Set(); // character _id strings
// tm-admin.10.6 AC2: partners whose ST Mods overlay was stripped before this flow mutated them, so the
// admin can re-overlay them after the cascade save, or when the edit is abandoned (character _id strings).
const _strippedPartners = new Set();
/** Strip a partner's overlay BEFORE it is mutated. The overlay remembers merit originals by INDEX, so a
 *  merit added to or removed from a still-overlaid partner would leave a later strip restoring base into
 *  the wrong merit. The character open in the editor is already stripped and is never touched here. */
function _stripPartnerBeforeMutation(ch) {
  if (!ch || !ch._id || ch === state.chars[state.editIdx]) return;
  stripOverlay(ch);
  _strippedPartners.add(String(ch._id));
}
function _markPartnerDirty(ch) {
  if (!ch || !ch._id) return;
  _stripPartnerBeforeMutation(ch); // idempotent: the mutation sites below strip first
  _dirtyPartners.add(String(ch._id));
}
export function getDirtyPartners() { return new Set(_dirtyPartners); }
export function clearDirtyPartners() { _dirtyPartners.clear(); }
export function getStrippedPartners() { return new Set(_strippedPartners); }
export function clearStrippedPartners() { _strippedPartners.clear(); }

/* ══════════════════════════════════════════════════════════
   INFLUENCE MERITS
══════════════════════════════════════════════════════════ */

export function shEditInflMerit(idx, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'influence', idx);
  if (!m) return;
  if (field === 'name') { m.name = val; m.rule_key = ruleKeyFor(val); m.area = ''; delete m.ghoul; }
  else if (field === 'area') m.area = val;
  else if (field === 'rating') m.rating = Math.max(0, Math.min(5, parseInt(val) || 0));
  else if (field === 'ghoul') m.ghoul = val === true || val === 'true' || val === 1;
  else if (field === 'narrow') m.narrow = val;
  else if (field === 'attached_to') { if (val) m.attached_to = val; else delete m.attached_to; }
  // Issue #39 Task 2: Contacts spheres prune on rating decrease.
  pruneContactsSpheres(m);
  _markDirty();
  _renderSheet(c);
}

export function shEditContactSphere(meritIdx, dotIdx, sphere) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const m = c.merits[meritIdx];
  if (!m || m.name !== 'Contacts') return;
  if (!m.spheres) m.spheres = [];
  m.spheres[dotIdx] = sphere;
  _markDirty();
  _renderSheet(c);
}

export function shRemoveInflMerit(idx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { realIdx } = meritByCategory(c, 'influence', idx);
  if (realIdx >= 0) removeMerit(c, realIdx);
  _markDirty();
  _renderSheet(c);
}

export function shAddLKMerit(type) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  addMerit(c, { category: 'domain', name: type || 'Herd', rating: 0, granted_by: 'Lorekeeper' });
  _markDirty();
  _renderSheet(c);
}

export function shAddVMAllies() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  // 2026-08-26 Sway merge: this is a WRITE path (Viral Mythology grants a fresh merit), so it
  // must write the new name outright, not straddle both shapes the way a read path can — every
  // day this stayed 'Allies' it would mint another merit the migration would then have to catch.
  // Function name kept unchanged (blast radius: every call site that references it by name).
  addMerit(c, { category: 'influence', name: 'Sway', rating: 0, area: '', granted_by: 'VM' });
  _markDirty();
  _renderSheet(c);
}

export function shAddInflMerit(type) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const name = type || 'Allies';
  const entry = { category: 'influence', name: name, rating: 1, area: '' };
  if (name === 'Retainer') entry.ghoul = false;
  addMerit(c, entry);
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   GENERAL MERITS
══════════════════════════════════════════════════════════ */

export function shEditGenMerit(idx, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'general', idx);
  if (!m) return;
  if (field === 'name') {
    // Issue #937: the general Merit dropdown also offers fighting styles and
    // manoeuvres (sentinel-prefixed values). These do not belong in c.merits \u2014
    // route them to the fighting sub-system and drop the placeholder merit row.
    if (val.startsWith('__style__:') || val.startsWith('__man__:')) {
      const isStyle = val.startsWith('__style__:');
      const name = val.slice((isStyle ? '__style__:' : '__man__:').length);
      const { realIdx } = meritByCategory(c, 'general', idx);
      if (realIdx >= 0) removeMerit(c, realIdx);
      if (isStyle) shAddStyle(name, 'style'); else shAddPick(name);
      return; // shAddStyle/shAddPick mark dirty and re-render
    }
    m.name = val; m.rule_key = ruleKeyFor(val);
    if (val === 'Attach\u00e9') { m.category = 'influence'; m.rating = 1; }
  }
  else if (field === 'qualifier') {
    const prevQualifier = m.qualifier;
    if (val) m.qualifier = val; else delete m.qualifier;
    if (m.name === 'Fucking Thief') {
      if (prevQualifier && prevQualifier !== val) {
        // Category-agnostic removal — handles legacy 'general' and new 'domain' entries
        const oldIdx = (c.merits || []).findIndex(x => x.name === prevQualifier && x.granted_by === 'Fucking Thief');
        if (oldIdx >= 0) removeMerit(c, oldIdx);
      }
      if (val) {
        const newCat = stolenMeritCategory(val);
        const alreadyExists = (c.merits || []).some(x => x.name === val && x.granted_by === 'Fucking Thief');
        if (!alreadyExists) {
          addMerit(c, { category: newCat, name: val, rating: 0, granted_by: 'Fucking Thief' });
        }
      }
    }
  }
  _markDirty();
  _renderSheet(c);
}

export function shRemoveGenMerit(idx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { realIdx } = meritByCategory(c, 'general', idx);
  if (realIdx >= 0) removeMerit(c, realIdx);
  _markDirty();
  _renderSheet(c);
}

export function shAddGenMerit() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  addMerit(c, { category: 'general', name: '', rating: 0 });
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   STANDING MERITS (MCI + PT)
══════════════════════════════════════════════════════════ */

export function shAddStandMCI() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  addMerit(c, { category: 'standing', name: 'Mystery Cult Initiation', rating: 0, cult_name: '', dot1_choice: 'merits', dot3_choice: 'merits', dot5_choice: 'merits' });
  _markDirty();
  _renderSheet(c);
}

export function shAddStandPT() {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  addMerit(c, { category: 'standing', name: 'Professional Training', rating: 0, role: '', asset_skills: [] });
  _markDirty();
  _renderSheet(c);
}

export function shEditStandMerit(idx, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'standing', idx);
  if (!m) return;
  if (field === 'cult_name') m.cult_name = val;
  else if (field === 'role') m.role = val;
  else if (field === 'dot4_skill') m.dot4_skill = val || null;
  _markDirty();
  _renderSheet(c);
}

export function shEditStandAssetSkill(standIdx, slotIdx, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'standing', standIdx);
  if (!m) return;
  if (!m.asset_skills) m.asset_skills = [];
  m.asset_skills[slotIdx] = val;
  _markDirty();
  _renderSheet(c);
}

export function shToggleMCI(standIdx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'standing', standIdx);
  if (!m || m.name !== 'Mystery Cult Initiation') return;
  m.active = m.active === false ? true : false;
  _markDirty();
  _renderSheet(c);
}

export function shTogglePT(standIdx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'standing', standIdx);
  if (!m || m.name !== 'Professional Training') return;
  m.active = m.active === false ? true : false;
  _markDirty();
  _renderSheet(c);
}

export function shRemoveStandMerit(idx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { realIdx, merit: m } = meritByCategory(c, 'standing', idx);
  if (realIdx < 0) return;
  // For MCI: clear all free_mci allocations across the character
  if (m && m.name === 'Mystery Cult Initiation') {
    (c.merits || []).forEach(m2 => { m2.free_mci = 0; });
    (c.fighting_styles || []).forEach(fs => { fs.free_mci = 0; });
  }
  removeMerit(c, realIdx);
  _markDirty();
  _renderSheet(c);
}

export function shEditMCIDot(standIdx, dotKey, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'standing', standIdx);
  if (!m || m.name !== 'Mystery Cult Initiation') return;
  m[dotKey] = val;
  // Clear tier_grants for affected tier when choice changes away from merits
  if (dotKey === 'dot1_choice' && val === 'speciality' && m.tier_grants) m.tier_grants = m.tier_grants.filter(t => t.tier !== 1);
  if (dotKey === 'dot3_choice' && val === 'skill' && m.tier_grants) m.tier_grants = m.tier_grants.filter(t => t.tier !== 3);
  if (dotKey === 'dot5_choice' && val === 'advantage' && m.tier_grants) m.tier_grants = m.tier_grants.filter(t => t.tier !== 5);
  _markDirty();
  _renderSheet(c);
}

const _MCI_TIER_BUDGET = [0, 1, 1, 2, 3, 3];

function _meritCategory(name) {
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const rule = getRuleByKey(slug);
  return rule?.sub_category || 'general';
}

export function shEditMCITierGrant(standIdx, tier, meritName) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'standing', standIdx);
  if (!m || m.name !== 'Mystery Cult Initiation') return;
  if (!m.tier_grants) m.tier_grants = [];
  // Remove existing grant for this tier
  m.tier_grants = m.tier_grants.filter(t => t.tier !== tier);
  if (meritName) {
    const cat = _meritCategory(meritName);
    const budget = _MCI_TIER_BUDGET[tier] || 0;
    m.tier_grants.push({ tier, name: meritName, category: cat, rating: budget, qualifier: null });
  }
  _markDirty();
  _renderSheet(c);
}

export function shEditMCITierQual(standIdx, tier, qualifier) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'standing', standIdx);
  if (!m || m.name !== 'Mystery Cult Initiation' || !m.tier_grants) return;
  const tg = m.tier_grants.find(t => t.tier === tier);
  if (tg) tg.qualifier = qualifier || null;
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   DOMAIN MERIT EDITING
══════════════════════════════════════════════════════════ */

export function shEditDomMerit(idx, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m, realIdx } = meritByCategory(c, 'domain', idx);
  if (!m) return;
  // Clear any prior qualifier error on each edit
  delete c._domQualError;
  if (field === 'name') { m.name = val; m.rule_key = ruleKeyFor(val); delete m.qualifier; delete m.attached_to; }
  else if (field === 'rating') m.rating = Math.max(1, Math.min(5, parseInt(val) || 1));
  else if (field === 'qualifier') {
    if (['Safe Place', 'Feeding Grounds'].includes(m.name)) {
      const dupExists = (c.merits || []).some((other, i2) =>
        i2 !== realIdx &&
        other.category === 'domain' &&
        other.name === m.name &&
        (other.qualifier || '').toLowerCase() === (val || '').toLowerCase()
      );
      if (dupExists) {
        c._domQualError = 'A ' + m.name + ' with this descriptor already exists.';
        _renderSheet(c);
        return;
      }
    }
    if (val) m.qualifier = val; else delete m.qualifier;
  }
  else if (field === 'attached_to') { if (val) m.attached_to = val; else delete m.attached_to; }
  _markDirty();
  _renderSheet(c);
}

/**
 * N-4 (MNEC, issue #696) — White Ants Territory picker handler.
 *
 * Bound to `<select>` `onchange` for each per-dot picker on a White Ants merit.
 * Writes the picked Territory slug into `m.territories[dotIdx]`, trims any
 * tail beyond the merit's current effective rating (covers the case where the
 * player dropped a Sepulcher dot and the rating shrank), and re-renders.
 *
 * Duplicate detection lives in the renderer (`sheet.js#_whiteAntsTerritoriesBlock`):
 * a duplicate slug renders the row with a warning + disables Save via the
 * existing dirty-state path. Save backstop is the server middleware
 * `validateWhiteAntsTerritoriesMiddleware`.
 *
 * @param {number} realIdx - index into c.merits
 * @param {number} dotIdx  - which dot's picker fired (0-indexed)
 * @param {string} value   - selected Territory slug, or '' for the placeholder
 */
export function shSetWhiteAntsTerritory(realIdx, dotIdx, value) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const m = (c.merits || [])[realIdx];
  if (!m || m.name !== 'White Ants') return;

  if (!Array.isArray(m.territories)) m.territories = [];
  // Grow the array to dotIdx with empty slots if the picker is for a slot we
  // haven't created yet (just added a dot, etc.).
  while (m.territories.length <= dotIdx) m.territories.push('');
  m.territories[dotIdx] = value || '';

  // Trim trailing slots if rating shrank (e.g. Sepulcher dropped) — keeps the
  // territories length aligned with rating without losing user picks.
  const rating = (m.cp || 0) + (m.xp || 0) + _whiteAntsFreeSum(m);
  if (m.territories.length > rating) m.territories.length = rating;

  _markDirty();
  _renderSheet(c);
}

// Inline sum mirroring `meritFreeSum` (rules-helpers.js) — kept here to avoid
// a cross-import dance just for one merit's rating calc. Union of new map
// + 14 legacy flat fields per N-1.
function _whiteAntsFreeSum(m) {
  const fromMap = m.free_grants && typeof m.free_grants === 'object'
    ? Object.values(m.free_grants).reduce((s, n) => s + (n || 0), 0)
    : 0;
  const legacy = (m.free_attache || 0) + (m.free_bloodline || 0) + (m.free_carthian || 0)
    + (m.free_fwb || 0) + (m.free_inv || 0) + (m.free_lk || 0) + (m.free_mci || 0)
    + (m.free_mdb || 0) + (m.free_ohm || 0) + (m.free_pet || 0) + (m.free_pt || 0)
    + (m.free_retainer || 0) + (m.free_sw || 0) + (m.free_vm || 0);
  return fromMap + legacy;
}

/**
 * N-5 (MNEC, issue #697) — Trap Door triple-anchor picker handler.
 *
 * Bound to `<select>` `onchange` for each of the three Trap Door pickers
 * (origin / destination / territory) in `sheet.js#_trapDoorAnchorBlock`.
 *
 * Origin is auto-resolved + locked to 'Necropolis Sepulcher' — the picker
 * displays it as a read-only label and never fires this handler with
 * `field === 'origin'`, but the case is handled defensively.
 *
 * Auto-initialises `m.attached_to` to the object form on first edit if it's
 * absent or in legacy string form. The save-path middleware
 * (`validateTrapDoorAnchorMiddleware`) requires the object form with all
 * three fields populated.
 *
 * @param {number} realIdx
 * @param {'origin'|'destination'|'territory'} field
 * @param {string} value
 */
export function shSetTrapDoorAnchor(realIdx, field, value) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const m = (c.merits || [])[realIdx];
  if (!m || m.name !== 'Trap Door') return;
  if (!['origin', 'destination', 'territory'].includes(field)) return;

  // Upgrade attached_to to the object form on first edit. Legacy string-form
  // attached_to (Haven/Mandragora) is N-1 D7 coexistence shape; Trap Door
  // requires the object form for the triple anchor.
  if (!m.attached_to || typeof m.attached_to !== 'object' || Array.isArray(m.attached_to)) {
    m.attached_to = { origin: 'Necropolis Sepulcher', destination: '', territory: '' };
  }
  // Origin is locked but write defensively in case a future picker wants it.
  if (field === 'origin') {
    m.attached_to.origin = value || 'Necropolis Sepulcher';
  } else {
    m.attached_to[field] = value || '';
  }
  _markDirty();
  _renderSheet(c);
}

export function shRemoveDomMerit(idx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { realIdx, merit: removed } = meritByCategory(c, 'domain', idx);
  if (realIdx >= 0) {
    // Auto-detach any Haven / Mandragora Garden that reference this Safe Place.
    if (removed && removed.name === 'Safe Place') {
      const key = domKey(removed);
      (c.merits || []).forEach(m2 => {
        // N-1 (Concern #11): normaliser comparison so cascade-detach works
        // even when m2.attached_to has been migrated to object form.
        const _at = normaliseAttachedTo(m2.attached_to);
        if (['Haven', 'Mandragora Garden'].includes(m2.name) && _at && _at.destination === key) {
          delete m2.attached_to;
        }
      });
    }
    removeMerit(c, realIdx);
  }
  _markDirty();
  _renderSheet(c);
}

export function shAddDomMerit(name = 'Safe Place') {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  addMerit(c, { category: 'domain', name, rating: 0 });
  _markDirty();
  _renderSheet(c);
}

/**
 * COLLECTIVE-1 (issue #800) — allocator handler for virtual Collective
 * Compound target rows. When the player allocates a pool dot to a target
 * merit they don't yet own (the row exists virtually because OTHER members
 * of the compound have it), this handler ensures the merit is materialised
 * on c.merits and routes the allocation through the standard
 * `free_grants.<slug>` write path.
 *
 * Why a wrapper handler: virtual rows by definition have no realIdx into
 * c.merits. The existing `shEditMeritPt(realIdx, 'free_grants.<slug>', val)`
 * write path requires the index. This handler adds the merit if absent
 * (idempotent — does nothing if it's already there), then resolves the now-
 * present index and writes via the standard path. No new write target; same
 * `m.free_grants` map destination per ADR-005 D6 (allocator write-path).
 *
 * COLLECTIVE-2 (issue #1110): `slug` is now a parameter. Pre-#1110 this was
 * `shAllocateNecroVirtual(meritName, value)` writing a hardcoded
 * `free_grants.necro` — a Crone or Sanctified virtual row wired to it would
 * have silently credited the Necropolis pool.
 *
 * `value=0` on a previously-empty virtual row is a no-op (nothing to do).
 * `value=0` on a materialised row drops the slug's allocation to 0 but keeps
 * the (now-empty) merit on c.merits — render-time synthesis will keep it
 * visible if it still appears on another member's sheet.
 */
export function shAllocateCompoundVirtual(meritName, slug, value) {
  if (state.editIdx < 0) return;
  if (!slug) return;
  const c = state.chars[state.editIdx];
  if (!c) return;
  const val = Math.max(0, parseInt(value) || 0);
  let existing = (c.merits || []).find(m => m && m.name === meritName && m.category === 'domain');
  if (!existing) {
    if (val === 0) return; // no-op: don't materialise a zero-allocation row
    addMerit(c, { category: 'domain', name: meritName, rating: 0 });
    existing = (c.merits || []).find(m => m && m.name === meritName && m.category === 'domain');
    if (!existing) return; // defensive — addMerit failed
  }
  if (!existing.free_grants) existing.free_grants = {};
  existing.free_grants[slug] = val;
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   DOMAIN PARTNER SHARING
══════════════════════════════════════════════════════════ */

export function shAddDomainPartner(domIdx, partnerName) {
  // Link partnerName (_id string) to the domain merit at domIdx on the current char
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'domain', domIdx);
  if (!m) return;
  const meritName = m.name;
  const meritQualifier = m.qualifier || undefined;
  const meritKey = domKey(m);
  if (!m.shared_with) m.shared_with = [];
  if (m.shared_with.includes(partnerName)) return; // already linked

  const cId = String(c._id);
  // partnerName is now a String(_id) from the updated picker
  const partner = state.chars.find(ch => String(ch._id) === partnerName);

  // The full new group = current char _id + existing partners + new partner _id
  const fullGroup = [cId, ...(m.shared_with || []), partnerName];

  // Update all existing group members to include new partner (keyed by _id)
  for (const memberEntry of [cId, ...(m.shared_with || [])]) {
    const member = _resolveSharedWithMember(state.chars, memberEntry);
    if (!member) continue;
    const memberId = String(member._id);
    const mm = (member.merits || []).find(x =>
      x.category === 'domain' && x.name === meritName && (x.qualifier || undefined) === meritQualifier
    );
    if (mm) {
      if (memberId !== cId) _stripPartnerBeforeMutation(member);
      mm.shared_with = fullGroup.filter(n => n !== memberId);
      if (memberId !== cId) _markPartnerDirty(member);
    }
  }

  // Ensure the new partner has this domain merit (add at 0 if missing, with same qualifier)
  if (partner) {
    _stripPartnerBeforeMutation(partner); // tm-admin.10.6 AC2: before addMerit can shift anything
    const partnerId = String(partner._id);
    let pm = (partner.merits || []).find(x =>
      x.category === 'domain' && x.name === meritName && (x.qualifier || undefined) === meritQualifier
    );
    if (!pm) {
      const newEntry = { category: 'domain', name: meritName, rating: 0, shared_with: fullGroup.filter(n => n !== partnerId) };
      if (meritQualifier) newEntry.qualifier = meritQualifier;
      addMerit(partner, newEntry);
    } else {
      pm.shared_with = fullGroup.filter(n => n !== partnerId);
    }
    _markPartnerDirty(partner);
  }

  _markDirty();
  _renderSheet(c);
}

export function shRemoveDomainPartner(domIdx, partnerName) {
  // partnerName is the stored shared_with entry (_id string or legacy name)
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const { merit: m } = meritByCategory(c, 'domain', domIdx);
  if (!m) return;
  const meritName = m.name;
  const meritQualifier = m.qualifier || undefined;

  const cId = String(c._id);
  const partner = state.chars.find(ch => String(ch._id) === partnerName);
  const partnerId = partner ? String(partner._id) : partnerName;

  // Remove partnerName from all remaining group members' shared_with (keyed by _id)
  const remainingGroup = [cId, ...(m.shared_with || [])].filter(n => n !== partnerName);
  for (const memberEntry of remainingGroup) {
    const member = _resolveSharedWithMember(state.chars, memberEntry);
    if (!member) continue;
    const memberId = String(member._id);
    const mm = (member.merits || []).find(x =>
      x.category === 'domain' && x.name === meritName && (x.qualifier || undefined) === meritQualifier
    );
    if (mm) {
      if (memberId !== cId) _stripPartnerBeforeMutation(member);
      mm.shared_with = remainingGroup.filter(n => n !== memberId);
      if (memberId !== cId) _markPartnerDirty(member);
    }
  }

  // On the partner: remove this char from their shared_with
  if (partner) {
    _stripPartnerBeforeMutation(partner); // tm-admin.10.6 AC2: before removeMerit shifts the indices

    const pm = (partner.merits || []).find(x =>
      x.category === 'domain' && x.name === meritName && (x.qualifier || undefined) === meritQualifier
    );
    if (pm) {
      pm.shared_with = (pm.shared_with || []).filter(n => n !== cId && n !== partnerId);
      // If partner has 0 contribution and no remaining partners, remove the merit
      const pRealIdx = partner.merits.indexOf(pm);
      const pContrib = (pm.cp || 0) + (pm.xp || 0);
      if (pContrib === 0 && pm.shared_with.length === 0) {
        removeMerit(partner, pRealIdx);
      }
    }
    _markPartnerDirty(partner);
  }

  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   FIGHTING STYLES
══════════════════════════════════════════════════════════ */

export function shAddStyle(styleName, type = 'style') {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.fighting_styles) c.fighting_styles = [];
  if (c.fighting_styles.some(fs => fs.name === styleName)) return;
  c.fighting_styles.push({ name: styleName, type, cp: 0, free_mci: 0, free_ots: 0, xp: 0 });
  _markDirty();
  _renderSheet(c);
}

export function shRemoveStyle(idx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.fighting_styles || !c.fighting_styles[idx]) return;
  c.fighting_styles.splice(idx, 1);
  _markDirty();
  _renderSheet(c);
}

export function shEditStyle(idx, field, val) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const fs = (c.fighting_styles || [])[idx];
  if (!fs) return;
  val = Math.max(0, parseInt(val) || 0);
  if (field === 'cp') {
    const otherCP = (c.merits || []).reduce((s, m) => s + (m.cp || 0), 0)
      + (c.fighting_styles || []).reduce((s, fs2, i2) => s + (i2 === idx ? 0 : (fs2.cp || 0)), 0);
    val = Math.min(val, Math.max(0, 10 - otherCP));
  }
  if (field === 'free_mci') {
    const mciTotal = (c.merits || []).filter(m => m.name === 'Mystery Cult Initiation' && m.active !== false)
      .reduce((s, m) => s + mciPoolTotal(m), 0);
    const otherMCI = (c.merits || []).reduce((s, m) => s + freeOf(m, 'mci'), 0)
      + (c.fighting_styles || []).reduce((s, fs2, i2) => s + (i2 === idx ? 0 : freeOf(fs2, 'mci')), 0);
    val = Math.min(val, Math.max(0, mciTotal - otherMCI));
  }
  if (field === 'free_ots') {
    const otsTotal = c._ots_free_dots || 0;
    const otherOTS = (c.fighting_styles || []).reduce((s, fs2, i2) => s + (i2 === idx ? 0 : (fs2.free_ots || 0)), 0);
    val = Math.min(val, Math.max(0, otsTotal - otherOTS));
  }
  fs[field] = val;
  _markDirty();
  _renderSheet(c);
}

export function shAddPick(manName) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.fighting_picks) c.fighting_picks = [];
  const totalDots = (c.fighting_styles || [])
    .reduce((s, fs) => s + (fs.cp||0) + freeOf(fs, 'mci') + freeOf(fs, 'ots') + (fs.xp||0), 0);
  const maxPicks = totalDots;
  if (c.fighting_picks.length >= maxPicks) return;
  const already = c.fighting_picks.some(pk =>
    (typeof pk === 'string' ? pk : pk.manoeuvre).toLowerCase() === manName.toLowerCase()
  );
  if (already) return;
  c.fighting_picks.push({ manoeuvre: manName });
  _markDirty();
  _renderSheet(c);
}

export function shRemovePick(pickIdx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  if (!c.fighting_picks || !c.fighting_picks[pickIdx]) return;
  c.fighting_picks.splice(pickIdx, 1);
  _markDirty();
  _renderSheet(c);
}

/* ══════════════════════════════════════════════════════════
   OATH-A (issue #1111, ADR-010 D1 / D1b / D4) — Swear By oaths
══════════════════════════════════════════════════════════ */

/**
 * The dots a Swear By oath requires, for the merit row at `realIdx`.
 *
 * ADR-010 D4: a derived `rating_basis` on the rule wins; otherwise the fixed
 * `rating_range` low bound. Resolved at RENDER time and never stored — what
 * gets stored is the snapshot taken at swear time (D1b).
 */
export function oathDotsRequired(c, m) {
  const rule = meritRuleFor(m && m.name);
  if (!rule) return 0;
  const derived = resolveRatingBasis(c, rule);
  if (derived != null) return derived;
  return Array.isArray(rule.rating_range) ? (rule.rating_range[0] || 0) : 0;
}

/** True when the merit's rule is a Swear By oath (cost_model). */
export function isSwearByOath(m) {
  const rule = meritRuleFor(m && m.name);
  return !!rule && rule.cost_model === 'swear_by';
}

/** Rule doc for a merit name, via the rules cache. */
function meritRuleFor(name) {
  if (!name) return null;
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return getRuleByKey(slug) || null;
}

/**
 * ADR-010 D1 — swear the oath at `realIdx` against `attachments`.
 *
 * `attachments` is `[{ name, qualifier, dots }]`, referencing merits by
 * NAME + QUALIFIER — never by array index, because `c.merits` indices move
 * under splice.
 *
 * Parity (D1b) is validated BEFORE anything is written: a pledge that does
 * not total the requirement is rejected with a message naming the shortfall
 * or excess, and nothing is persisted. The requirement is SNAPSHOTTED into
 * `sworn_by.dots_required` at this moment and never recomputed — otherwise a
 * rising Blood Potency would silently invalidate a standing Oath of
 * Abstinence every time it moved.
 *
 * No XP is charged: that is what `cost_model: 'swear_by'` means.
 *
 * @returns {{ok: boolean, message: string|null}}
 */
export function shSwearOath(realIdx, attachments) {
  if (state.editIdx < 0) return { ok: false, message: 'No character in edit.' };
  const c = state.chars[state.editIdx];
  if (!c) return { ok: false, message: 'No character in edit.' };
  const m = c.merits[realIdx];
  if (!m) return { ok: false, message: 'Merit not found.' };

  const required = oathDotsRequired(c, m);
  // `m` itself is excluded so re-swearing an existing pledge does not read
  // its own dots as already spoken for.
  const check = validatePledge(c, attachments, required, meritRating, m);
  if (!check.valid) return { ok: false, message: check.message };

  m.sworn_by = buildSwornBy(required, attachments, {
    chapter_number: currentChapterNumber(),
    iso: new Date().toISOString().slice(0, 10),
  });
  _markDirty();
  _renderSheet(c);
  return { ok: true, message: null };
}

/**
 * Release the pledge on the oath at `realIdx`, leaving the merit itself in
 * place.
 *
 * This is the swear-flow's undo, NOT the D6 exit event: it removes the
 * pledge outright rather than recording a breach. Breaking an oath, its
 * consequences and its history are OATH-B, and nothing here appends to
 * `sworn_by.history`.
 */
export function shReleaseOath(realIdx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const m = c && c.merits[realIdx];
  if (!m) return;
  delete m.sworn_by;
  _markDirty();
  _renderSheet(c);
}

/**
 * The current Chapter ordinal, for `sworn_by.sworn_at.chapter_number`.
 *
 * ADR-010 D3a anchors the mechanic on `game_sessions.chapter_number`.
 * Nothing in OATH-A reads this value back — which is precisely why it is
 * captured now: it is unrecoverable after the fact, and OATH-B's deferred
 * restoration work is uncomputable without it (Risk 2).
 *
 * Returns null when no chapter context is loaded, rather than inventing a
 * number. A wrong ordinal is worse than an absent one.
 */
function currentChapterNumber() {
  const n = state.currentChapterNumber;
  return Number.isInteger(n) ? n : null;
}

/**
 * OATH-A — stage one merit's pledged dots on the oath at `realIdx`.
 *
 * Writes to a TRANSIENT `m._pledge_draft`, never to `m.sworn_by`. The draft
 * is underscore-prefixed, so both existing save paths strip it
 * (`buildSaveBody` for API writes, `charsForSave` for the localStorage
 * mirror) and a half-built pledge can never reach a persisted document or a
 * stale cache entry. Only `shCommitOath` promotes a draft to `sworn_by`, and
 * only after `validatePledge` passes.
 *
 * `dots: 0` removes the entry rather than storing a zero, so the draft and
 * the persisted shape agree (attachments carry `minimum: 1`).
 */
export function shSetPledgeDots(realIdx, name, qualifier, dots) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const m = c && c.merits[realIdx];
  if (!m) return;
  const q = qualifier == null || qualifier === '' ? null : qualifier;
  const val = Math.max(0, parseInt(dots) || 0);

  const draft = Array.isArray(m._pledge_draft)
    ? m._pledge_draft.slice()
    : ((m.sworn_by && m.sworn_by.attachments) || []).map(a => ({ ...a }));

  const i = draft.findIndex(a => a.name === name && (a.qualifier ?? null) === q);
  if (val === 0) { if (i >= 0) draft.splice(i, 1); }
  else if (i >= 0) draft[i].dots = val;
  else draft.push({ name, qualifier: q, dots: val });

  m._pledge_draft = draft;
  delete m._oathError;
  _markDirty();
  _renderSheet(c);
}

/**
 * OATH-A — commit the staged draft on the oath at `realIdx`.
 *
 * Parity is validated inside `shSwearOath`; a failure leaves the draft in
 * place and surfaces the message on the row, so the player can correct it
 * rather than losing what they had entered. Nothing is persisted on failure.
 */
export function shCommitOath(realIdx) {
  if (state.editIdx < 0) return;
  const c = state.chars[state.editIdx];
  const m = c && c.merits[realIdx];
  if (!m) return;
  const draft = Array.isArray(m._pledge_draft)
    ? m._pledge_draft
    : ((m.sworn_by && m.sworn_by.attachments) || []);
  const res = shSwearOath(realIdx, draft);
  if (!res.ok) {
    m._oathError = res.message;
    _markDirty();
    _renderSheet(c);
    return;
  }
  delete m._pledge_draft;
  delete m._oathError;
  _renderSheet(c);
}

/**
 * OATH-B (issue #1111, ADR-010 D6) — record an exit on the oath at `realIdx`.
 *
 * APPENDS to `sworn_by.history`; never mutates or replaces an earlier event.
 * An oath can be sworn, broken, partly restored and re-sworn, and a single
 * mutable status field would lose that — the forfeiture clock the deferred
 * restoration work needs is reconstructed from this log.
 *
 * Only `broken` and `abandoned` forfeit. The other three end the oath with no
 * suspension: `released_by_liege` is the explicit no-forfeiture exit from the
 * source text, `fulfilled` is Oath of Action completing successfully, and
 * `st_void` is the adjudication-error escape hatch — without it the only way
 * to undo a mis-recorded breach would be to edit history.
 *
 * `chapter_number` is captured here even though NOTHING in this story reads
 * it. It is unrecoverable after the fact: without it the deferred restoration
 * work has no anchor and the remedy is ST archaeology across session logs.
 *
 * @returns {{ok: boolean, message: string|null}}
 */
export function shExitOath(realIdx, reason) {
  if (state.editIdx < 0) return { ok: false, message: 'No character in edit.' };
  const c = state.chars[state.editIdx];
  const m = c && c.merits[realIdx];
  if (!m) return { ok: false, message: 'Merit not found.' };
  if (!m.sworn_by) return { ok: false, message: 'That oath has not been sworn.' };
  if (!OATH_EXIT_REASONS.includes(reason)) {
    return { ok: false, message: 'Unknown exit reason: ' + reason };
  }
  m.sworn_by.history = Array.isArray(m.sworn_by.history) ? m.sworn_by.history : [];
  m.sworn_by.history.push(buildOathExitEvent(
    reason,
    currentChapterNumber(),
    new Date().toISOString().slice(0, 10),
  ));
  _markDirty();
  _renderSheet(c);
  return { ok: true, message: null };
}

/**
 * OATH-B (ADR-010 D6) — restore `dots` to a suspended oath.
 *
 * Restoration TIMING is deferred; the restoration EVENT is not, and the
 * distinction is load-bearing. Suspension is a DERIVED value recomputed per
 * render from this history, so it cannot be hand-cleared — appending this
 * event is the only way an ST lifts a suspension. Without it, dots go dark at
 * breach with no route back short of hand-editing a character document, which
 * is exactly what an append-only log exists to prevent.
 *
 * Nothing computes WHEN restoration is due; the ST decides and records it.
 *
 * @returns {{ok: boolean, message: string|null}}
 */
export function shRestoreOathDots(realIdx, dots) {
  if (state.editIdx < 0) return { ok: false, message: 'No character in edit.' };
  const c = state.chars[state.editIdx];
  const m = c && c.merits[realIdx];
  if (!m) return { ok: false, message: 'Merit not found.' };
  if (!m.sworn_by) return { ok: false, message: 'That oath has not been sworn.' };
  const n = Math.max(0, parseInt(dots) || 0);
  if (n < 1) return { ok: false, message: 'Restore at least 1 dot.' };
  const outstanding = oathSuspendedDots(m);
  if (outstanding <= 0) return { ok: false, message: 'Nothing is suspended on that oath.' };
  if (n > outstanding) {
    return { ok: false, message: 'Only ' + outstanding + ' dot' + (outstanding === 1 ? '' : 's') + ' suspended.' };
  }
  m.sworn_by.history = Array.isArray(m.sworn_by.history) ? m.sworn_by.history : [];
  m.sworn_by.history.push(buildOathRestoredEvent(
    n,
    currentChapterNumber(),
    new Date().toISOString().slice(0, 10),
  ));
  _markDirty();
  _renderSheet(c);
  return { ok: true, message: null };
}
