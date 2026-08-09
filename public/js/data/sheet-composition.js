/* sheet-composition.js — THE overlay composition site (ADR-009 D1)
 *
 * One module owns the order in which a character's displayed stats are
 * composed before a sheet renders. Both entry points import it; neither keeps
 * a local copy.
 *
 * WHY THIS EXISTS. Before ADR-009, admin.js and app.js each defined their own
 * refreshCharacterOverlay, and BOTH carried a comment describing themselves as
 * "the same composition sequence (single composition site, ADR-004 D1/D8)".
 * The rule was not broken by anyone -- it was satisfied twice, independently,
 * and the copies drifted: admin.js spliced tracker state, app.js did not. A
 * comment could not enforce singularity, so ADR-009 D5 adds a test that can.
 *
 * ORDER IS LOAD-BEARING. ADR-006 D3/D4 fixed a real bug caused by running
 * applyStMods before the armour-adjusted defence base existed. The sequence
 * below is:
 *     splice tracker current values
 *       -> materialiseDerivedDefence  (calcDefence - armourPenalty, floored)
 *       -> applyStMods                (composes additively on that base)
 *       -> render
 * Do not reorder. Do not inline a step into a caller.
 *
 * NO ROLE LOGIC LIVES HERE (ADR-009 D2). This module must never call
 * getRole() or branch on which document it is running in. What genuinely
 * varies between entry points is injected:
 *
 *   renderSheet        (required) - what "render" means for the caller
 *   loadTrackerState   (optional) - supplied ONLY when the session may read
 *                                   tracker_state, which is ST-auth-only at the
 *                                   API level. Absent means "cannot splice",
 *                                   not "chose not to". This is ADR-009 D3:
 *                                   the gate is on capability, not on which
 *                                   file the function happens to live in.
 *
 * A conditional inside this module would recreate the divergence it exists to
 * remove -- in one file instead of two, which is harder to see, not easier.
 */

import { calcWillpowerMax, calcVitaeMax } from './accessors.js';
import { loadStMods, applyStMods, spliceCurrent, stripOverlay, applyOverlayToAll } from './st-mods.js';
import { materialiseDerivedDefence } from './equipment-derivation.js';
import { getGlobalSettings } from './app-settings.js';
import editorState from './state.js';

/**
 * Compose and render one character's sheet.
 *
 * @param {object} c        the live character entry (mutated in place, per ADR-004)
 * @param {object} deps
 * @param {function} deps.renderSheet        called with `c` once composition completes
 * @param {function} [deps.loadTrackerState] async (c) => trackerState; omit when
 *                                           the session cannot read tracker_state
 */
export async function renderSheetWithOverlay(c, { renderSheet, loadTrackerState } = {}) {
  if (!c) return;
  if (typeof renderSheet !== 'function') {
    // Failing loudly here beats composing correctly and painting nothing: a
    // silent return would look exactly like "this character has no mods".
    throw new TypeError('renderSheetWithOverlay: deps.renderSheet is required');
  }

  if (editorState.editMode) {
    stripOverlay(c);
    // Issue #879 (ADR-006 D4): re-materialise armour-adjusted defence after
    // strip so the edit-mode view shows the canonical mechanical base
    // (calcDefence - armourPenalty), not a stale STM-modded value.
    materialiseDerivedDefence(c);
    renderSheet(c);
    return;
  }

  // ADR-009 D3. No loader means the session cannot read tracker_state, so the
  // splice is skipped rather than attempted and swallowed. Current vitae /
  // willpower / health then show their canonical values.
  if (typeof loadTrackerState === 'function') {
    const tracker = await loadTrackerState(c).catch(() => null);
    spliceCurrent(c, tracker, { calcWillpowerMax, calcVitaeMax });
  }

  // Issue #879 (ADR-006 D3 + D4): composition order is
  //   calcDefence(c) -> subtract armourDefencePenalty(c) -> floor -> applyStMods.
  // materialiseDerivedDefence handles the first three steps and writes the
  // result to c.derived.defence. applyStMods then reads c.derived.defence as
  // the base for any 'derived.defence' mod and composes additively on top,
  // fixing the pre-existing ADR-004 D5 display bug where the marker appeared
  // but the value didn't update.
  materialiseDerivedDefence(c);

  const mods = await loadStMods(c._id);
  const settings = getGlobalSettings();
  const overlayEnabled = (settings?.st_mods_enabled !== false) && !c.st_mods_suppressed;
  applyStMods(c, mods, overlayEnabled);

  renderSheet(c);
}

/**
 * Re-apply the overlay for ONE character by id and re-render it if it is
 * currently on screen. ADR-009 D1 step 2.
 *
 * Shared by the WebSocket onStModUpdate handler and by installStModPopover's
 * onMutate callback in both entry points. Before this, admin.js and app.js each
 * had their own copy of this function and each described itself as the single
 * composition site.
 *
 * Note this path deliberately does NOT splice tracker state and does NOT call
 * loadStMods: applyOverlayToAll does its own bulk fetch, and a mod update is not
 * a reason to re-read tracker_state. Both former copies agreed on that, so the
 * convergence changes nothing here.
 *
 * @param {string} charId
 * @param {object} deps
 * @param {function} deps.getChars      () => the live character array to search
 * @param {function} deps.renderIfOpen  (target) => re-render iff on screen. Role
 *                                      gating belongs HERE, in the caller, never
 *                                      inside this module (ADR-009 D2).
 */
export async function refreshCharacterOverlay(charId, { getChars, renderIfOpen } = {}) {
  if (typeof getChars !== 'function' || typeof renderIfOpen !== 'function') {
    throw new TypeError('refreshCharacterOverlay: deps.getChars and deps.renderIfOpen are required');
  }
  const target = (getChars() || []).find(c => String(c?._id) === String(charId));
  if (!target) return;

  // Issue #879 (ADR-006 D4): re-materialise before re-applying so the
  // armour-adjusted base is current at composition time.
  materialiseDerivedDefence(target);
  await applyOverlayToAll([target], getGlobalSettings()?.st_mods_enabled !== false);

  renderIfOpen(target);
}
