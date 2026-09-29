/* ST mods overlay — client-side composition layer (Epic STM, issue #372).
 *
 * Sequence at each renderSheet call site (D1 single composition site):
 *   1. tracker = await ensureLoaded(c)               // game/tracker.js cache
 *   2. spliceCurrent(c, tracker)                     // c.current = {damage_b/l/a, willpower, vitae}
 *   3. mods = await loadStMods(c._id)                // GET /api/st_mods
 *   4. applyStMods(c, mods, overlayEnabled)          // mutate c.<path> + populate c._st_mod_overlay
 *   5. renderSheet(c)
 *
 * Per ADR-004 §D6: the overlay is read-direction only. It never writes
 * back to tracker_state or to the characters collection. The in-memory
 * mutation in step 4 is a per-frame display detail; canonical character
 * docs stay untouched on the server.
 *
 * Edit-mode safety: applyStMods snapshots base values into c._st_mod_base
 * before mutating. stripOverlay(c) restores from that snapshot, used by the
 * helper when toggling into edit mode so the user always edits canonical
 * values, never modded ones. Both _st_mod_overlay and _st_mod_base are
 * `_`-prefixed so admin.js buildSaveBody strips them before PUT.
 */

// 2026-09-01 general audit fix: was a hand-duplicated copy of api.js's
// apiBase()/headers() (three more copies of this exact pattern found this
// session besides the api.js/st-mods.js pair found earlier) — import the
// canonical versions instead.
import { apiBase, headers as authHeaders } from './api.js';

/** GET /api/st_mods?character_id=:id. Returns an array of mod docs, ordered
 *  by created_at ascending (per STM-1 AC#4). Returns [] on network failure
 *  rather than throwing — overlay is a display enhancement, not a hard dep. */
export async function loadStMods(characterId) {
  try {
    const res = await fetch(
      `${apiBase()}/api/st_mods?character_id=${encodeURIComponent(characterId)}`,
      { headers: authHeaders() },
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/** GET /api/st_mods?character_ids=<csv>. Returns { [character_id]: [...mods] }
 *  in a single round-trip. STM-7 (ADR-004 Rev 3 §D9) — boot-path bulk loader
 *  so the suite app doesn't fire N requests when populating its character cache.
 *  Returns empty object on network failure / non-OK response so the caller's
 *  overlay loop short-circuits gracefully on each character. */
export async function loadStModsBulk(characterIds) {
  if (!Array.isArray(characterIds) || characterIds.length === 0) return {};
  try {
    const csv = characterIds.map(id => encodeURIComponent(String(id))).join(',');
    const res = await fetch(
      `${apiBase()}/api/st_mods?character_ids=${csv}`,
      { headers: authHeaders() },
    );
    if (!res.ok) {
      // Fails atomically server-side on the first unauthorised id in the
      // CSV (never partial results) — a real, actionable signal that the
      // overlay silently went dark for every character in this batch, not
      // just an offline blip. Surface it rather than swallowing it.
      console.warn(`[st-mods] bulk overlay fetch failed (${res.status}) for ${characterIds.length} character(s) — overlay disabled for this batch`);
      return {};
    }
    return await res.json();
  } catch {
    return {};
  }
}

/** Splice the synthetic `current.*` namespace onto the in-memory character
 *  from tracker_state (per ADR-004 §D5). Idempotent — overwrites c.current
 *  every call. Pass a falsy tracker to write sensible defaults.
 *
 *  Defaults follow the tracker's own `defaults()` in public/js/game/tracker.js:
 *  damage tracks default 0, willpower defaults to calcWillpowerMax, vitae
 *  to calcVitaeMax. Pass calcWillpowerMax / calcVitaeMax as the third arg
 *  so this module stays decoupled from accessors. */
export function spliceCurrent(c, tracker, { calcWillpowerMax, calcVitaeMax } = {}) {
  c.current = {
    damage_bashing:    tracker?.bashing    ?? 0,
    damage_lethal:     tracker?.lethal     ?? 0,
    damage_aggravated: tracker?.aggravated ?? 0,
    willpower:         tracker?.willpower  ?? (calcWillpowerMax ? calcWillpowerMax(c) : 0),
    vitae:             tracker?.vitae      ?? (calcVitaeMax ? calcVitaeMax(c) : 0),
  };
}

// ── Path walkers ───────────────────────────────────────────────────────

// Paths are validated server-side against STATIC_WHITELIST + the
// merits/disciplines regex (per ADR-004 §Concerns Item 2), so we don't
// re-validate here. Walks dotted keys including ones with spaces ('Animal Ken').
// Returns undefined if any segment is missing.
function getByPath(obj, path) {
  if (!obj || typeof path !== 'string') return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Returns the dotted path of the OUTERMOST container this call had to create (so a caller can
 *  undo it), or null when every parent already existed. */
function setByPath(obj, path, value) {
  if (!obj || typeof path !== 'string') return null;
  const parts = path.split('.');
  let cur = obj;
  let created = null;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      cur[key] = {};
      if (created === null) created = parts.slice(0, i + 1).join('.');
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return created;
}

/** Delete the leaf at `path` without materialising anything on the way. No-op when a parent is missing. */
function deleteByPath(obj, path) {
  if (!obj || typeof path !== 'string') return;
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
    if (cur == null || typeof cur !== 'object') return;
  }
  delete cur[parts[parts.length - 1]];
}

/** True for a plain object whose every value is itself an empty tree (nothing real left in it). */
function isEmptyTree(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v).every(isEmptyTree);
}

// ── Overlay composition ────────────────────────────────────────────────

/** Apply mods to the in-memory character. Mutates c:
 *    - c.<stat_path> ← base + sum of deltas (display value for this frame)
 *    - c._st_mod_overlay[path] = { base, delta, final, mods: [...] }
 *    - c._st_mod_base[path] = base  (used by stripOverlay to restore)
 *
 *  Short-circuits when overlayEnabled is false or mods is empty — leaves
 *  c untouched (or strips a prior overlay if present so a flipped kill-switch
 *  reverts cleanly).
 *
 *  Multiple mods on the same path are additive — deltas sum, all mods are
 *  retained in the overlay row for the popover (STM-4). */
export function applyStMods(c, mods, overlayEnabled) {
  if (!overlayEnabled || !Array.isArray(mods) || mods.length === 0) {
    stripOverlay(c);
    return c;
  }

  // Group by path, summing deltas, retaining each contributing mod.
  // STM-10 (issue #434, ADR-004 Rev 4 §D16): skip INACTIVE mods. The
  // bulk/single GET returns all mods (active + inactive) so STM-11's
  // audit view and STM-12's panel can show the full set; the overlay
  // only composes active ones. `active !== false` treats a missing field
  // as active (D19 backfill-independence for pre-Rev 4 docs).
  const byPath = new Map();
  for (const m of mods) {
    if (!m || typeof m.stat_path !== 'string' || !Number.isInteger(m.delta)) continue;
    if (m.active === false) continue;
    let entry = byPath.get(m.stat_path);
    if (!entry) {
      entry = { delta: 0, mods: [] };
      byPath.set(m.stat_path, entry);
    }
    entry.delta += m.delta;
    entry.mods.push(m);
  }

  // If every mod was inactive, byPath is empty — strip any prior overlay
  // and return so a freshly-deactivated mod reverts the displayed value.
  if (byPath.size === 0) {
    stripOverlay(c);
    return c;
  }

  // Restore any prior overlay before re-applying — successive renders pile
  // up modded-on-modded otherwise, drifting away from canonical.
  stripOverlay(c);

  c._st_mod_overlay = {};
  c._st_mod_base = {};
  for (const [path, { delta, mods: contributing }] of byPath) {
    const baseRaw = getByPath(c, path);
    // Treat missing leaf as 0 — for derived.* paths that the sheet derives
    // at render time but doesn't materialise on the char doc, and for sparse
    // merit dot slots. The whitelist guarantees the path shape is valid.
    const base = typeof baseRaw === 'number' ? baseRaw : 0;
    const final = base + delta;
    c._st_mod_base[path] = baseRaw;          // preserve original (may be undefined)
    const created = setByPath(c, path, final);
    c._st_mod_overlay[path] = { base, delta, final, mods: contributing };
    // Remember a container the overlay itself materialised so stripOverlay can remove it again
    // (tm-admin.10.2a AC13). Kept on the overlay entry, not a new top-level key: the server and
    // export.js strip _st_mod_overlay / _st_mod_base by name, so nothing extra can reach the database.
    if (created) c._st_mod_overlay[path].created = created;
  }
  return c;
}

/** STM-7 (ADR-004 Rev 3 §D8/D9) — boot-time bulk overlay application.
 *  Establishes the cache-entry invariant: every chars[] entry has
 *  applyStMods applied before any accessor read happens. Roll calc, DT
 *  pools, and any consumer of the accessor chain (getAttrEffective,
 *  skTotal, discAttrBonus, calcDefence/Health/Willpower) pick up modded
 *  values transparently — no per-callsite changes needed.
 *
 *  One bulk fetch (single RTT) regardless of chars.length. Per-character
 *  st_mods_suppressed is honoured at the applyStMods call (overlayEnabled
 *  becomes globalEnabled && !c.st_mods_suppressed).
 *
 *  Mutates each char in place; returns chars for chainability. When the
 *  bulk endpoint returns nothing (network failure, no mods), each char
 *  gets stripOverlay (via applyStMods's empty-array branch) so a flipped
 *  global toggle reverts cleanly on next boot.
 *
 *  Called from public/js/app.js boot after applyDerivedMerits. */
/** `fetchIds`, when given, overrides which ids the bulk CSV is built from —
 *  `chars` itself is still what the overlay gets APPLIED to. Needed because
 *  a player's `chars` array can carry non-owned combat opponents (merged in
 *  for the resist-target dropdown); querying st_mods for ids the caller
 *  doesn't own 403s the WHOLE bulk request server-side (it's deliberately
 *  atomic, never partial), silently zeroing the overlay for every character
 *  including the player's own. Defaults to the old chars-derived behaviour
 *  when omitted, so ST call sites (already authorised for every id) are
 *  unaffected. */
export async function applyOverlayToAll(chars, globalEnabled, fetchIds) {
  if (!Array.isArray(chars) || chars.length === 0) return chars;
  const ids = Array.isArray(fetchIds) ? fetchIds.filter(Boolean) : chars.map(c => c?._id).filter(Boolean);
  const modsByChar = await loadStModsBulk(ids);
  for (const c of chars) {
    if (!c) continue;
    const overlayEnabled = !!globalEnabled && !c.st_mods_suppressed;
    const mods = modsByChar[String(c._id)] || [];
    applyStMods(c, mods, overlayEnabled);
  }
  return chars;
}

/** Restore canonical values from c._st_mod_base, then delete the overlay
 *  metadata. No-op if no prior overlay. Used by:
 *    - applyStMods itself (before each re-application, so successive renders
 *      don't compound)
 *    - the admin edit-mode helper (so editing always shows base values, and
 *      so a silent fresh-fetch failure can't leave modded canonical fields
 *      visible to the editor) */
export function stripOverlay(c) {
  if (!c || !c._st_mod_base) {
    if (c) delete c._st_mod_overlay;
    return;
  }
  for (const [path, baseRaw] of Object.entries(c._st_mod_base)) {
    if (baseRaw === undefined) {
      // The path didn't exist before overlay: delete the leaf. Assigning undefined instead would
      // leave `{ dots: undefined }` behind, which serialises as `{}` and breaks the trait schema's
      // required `dots` (tm-admin.10.2a AC13; Wan Yelong disciplines.Dominate, Yusuf skills.Brawl).
      deleteByPath(c, path);
    } else {
      setByPath(c, path, baseRaw);
    }
  }
  // Then remove any container the overlay created, but only once nothing real is left in it.
  const overlay = c._st_mod_overlay || {};
  for (const entry of Object.values(overlay)) {
    const created = entry && entry.created;
    if (!created) continue;
    const parts = created.split('.');
    let parent = c;
    for (let i = 0; i < parts.length - 1 && parent != null; i++) parent = parent[parts[i]];
    const last = parts[parts.length - 1];
    if (parent != null && isEmptyTree(parent[last])) delete parent[last];
  }
  delete c._st_mod_overlay;
  delete c._st_mod_base;
}
