/* Persistence and export — localStorage I/O */

import state from '../data/state.js';
import { CHARS_DATA } from '../data/chars-data.js';
import { stripOverlay } from '../data/st-mods.js';
import { withoutTraitBonus } from '../data/strip-trait-bonus.js';

let _renderList, _updDirtyBadge;

/**
 * Register callback functions from main.js to avoid circular imports.
 * @param {Function} renderList - re-renders the character grid
 * @param {Function} updDirtyBadge - updates the dirty indicator badge
 */
export function registerCallbacks(renderList, updDirtyBadge) {
  _renderList = renderList;
  _updDirtyBadge = updDirtyBadge;
}

/**
 * Load character data from localStorage, falling back to embedded CHARS_DATA.
 * Writes to state.chars.
 */
export function loadDB() {
  try {
    const raw = localStorage.getItem('tm_chars_db');
    if (raw) { state.chars = JSON.parse(raw); return; }
  } catch (e) { /* ignore */ }
  try {
    const imp = localStorage.getItem('tm_import_chars');
    if (imp) { state.chars = JSON.parse(imp); return; }
  } catch (e) { /* ignore */ }
  // Fall back to built-in data
  state.chars = JSON.parse(JSON.stringify(CHARS_DATA));
}

/**
 * Produce a clean deep copy of state.chars with derived merits stripped.
 *
 * STM-7 (ADR-004 Rev 3 §D13 — issue #413): the cache-entry invariant
 * means in-memory chars carry an STM overlay (modded `.dots`/`.bonus`
 * etc. + `_st_mod_overlay` + `_st_mod_base`). localStorage must stay
 * base-only — otherwise on next session boot the overlay would be
 * applied on top of an already-modded "canonical", drifting away from
 * the real base each cycle. Strip the overlay from each clone before
 * persisting; stripOverlay walks `_st_mod_base` and restores canonical
 * values, then deletes the transient `_`-prefixed fields.
 *
 * @returns {Array} cleaned character array (base values, no STM overlay)
 */
export function charsForSave() {
  return state.chars.map(c => {
    // tm-admin.10.6 AC4: the same safe clone as admin.js buildSaveBody. structuredClone keeps the
    // `undefined` entries in _st_mod_base that a JSON round trip drops, so stripOverlay can delete an
    // overlay-created leaf or container instead of stashing it. The JSON round trip afterwards keeps the
    // stash exactly as JSON-shaped as before. A clone or strip failure throws: never the raw object.
    let copy = structuredClone(c);
    // Restore base values from the cloned _st_mod_base snapshot, then
    // delete _st_mod_overlay + _st_mod_base. Pre-overlay characters
    // have no _st_mod_base; stripOverlay no-ops cleanly in that case.
    stripOverlay(copy);
    copy = JSON.parse(JSON.stringify(copy));
    // ADR-006: c.derived is the render-time materialised defence cache,
    // never stored. Strip before localStorage stash so a fresh boot
    // recomputes from base values without carrying stale derived state.
    delete copy.derived;
    // PR #902 (2026-06-19): character.assets[] removed from the schema,
    // consolidated into equipment[]. Existing prod docs may still carry
    // an assets field — strip it on save so a stale field doesn't fail
    // additionalProperties: false on the next PUT round-trip.
    delete copy.assets;
    if (copy.merits) {
      for (let i = copy.merits.length - 1; i >= 0; i--) {
        if (copy.merits[i].derived) {
          copy.merits.splice(i, 1);
        }
      }
      // N-1 (ADR-005 Rev 2, Concern #3): drop merit-level `_`-prefixed
      // transient fields (e.g. `_collective_shared_with`) before persisting
      // to localStorage. Mirrors the buildSaveBody strip on the API path so
      // a localStorage round-trip + boot doesn't reload stale synthesised
      // sharing data — applyDerivedMerits rebuilds it on each render anyway.
      for (const m of copy.merits) {
        for (const k of Object.keys(m)) {
          if (k.startsWith('_')) delete m[k];
        }
      }
    }
    // tm-admin.10.5: never stash a trait-level `bonus` (runtime-only overlay slot). Mirrors the
    // buildSaveBody strip on the API path.
    return withoutTraitBonus(copy);
  });
}

/**
 * Save characters to localStorage, clear dirty set, refresh UI.
 */
export function saveDB() {
  localStorage.setItem('tm_chars_db', JSON.stringify(charsForSave()));
  state.dirty.clear();
  if (_renderList) _renderList();
  if (_updDirtyBadge) _updDirtyBadge();
}

/**
 * Save all characters and flash the save button confirmation.
 */
export function saveAll() {
  saveDB();
  document.getElementById('btn-save').textContent = 'Saved \u2713';
  setTimeout(() => { document.getElementById('btn-save').textContent = 'Save All'; }, 1500);
}

/**
 * Sync characters to ST Suite via localStorage keys.
 */
export function syncToSuite() {
  const clean = charsForSave();
  localStorage.setItem('tm_chars_db', JSON.stringify(clean));
  localStorage.setItem('tm_import_chars', JSON.stringify(clean));
  localStorage.setItem('tm_import_meta', JSON.stringify({
    filename: 'tm_editor',
    count: clean.length,
    date: new Date().toISOString()
  }));
  state.dirty.clear();
  if (_renderList) _renderList();
  if (_updDirtyBadge) _updDirtyBadge();
  alert('Synced ' + clean.length + ' characters to ST Suite (tm_import_chars).');
}

/**
 * CSV export — generates Affinity Publisher data merge format and triggers download.
 * @param {Array} [charArray] - optional character array (used by admin app). Falls back to state.chars.
 */
export async function downloadCSV(charArray) {
  const { buildCSV } = await import('./csv-format.js');
  const chars = charArray || state.chars;
  if (!chars || !chars.length) {
    alert('No character data to export.');
    return;
  }
  const csv = buildCSV(chars);
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }); // BOM for Excel UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `TM_Character_Export_${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
