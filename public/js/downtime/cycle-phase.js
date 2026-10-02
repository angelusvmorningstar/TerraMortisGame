/**
 * cycle-phase.js — CM-1 (issue #1028): the cycle phase model as data.
 *
 * PURE MODULE: no imports, no I/O, no browser globals. Deliberately importable
 * by the client (db.js), the server (routes/downtime.js), and the test suite
 * directly, so there is exactly one implementation of the phase contract and
 * no mirror copies to drift (the mirror-in-test convention exists only because
 * db.js imports api.js, which touches `location` at module load; this module
 * sidesteps that). Twin on the reader side: TM Wiki's
 * server/downtime-cycle-phase.js (the 11-1 stub contract).
 *
 * Ruling document: D:/Terra Mortis/cycle-model.md Rev 2, sections 7 and 11.
 *
 * THE THREE MEANINGS OF "prep" (do not conflate):
 *   - status: 'prep'        legacy enum value, "ST is setting the cycle up,
 *                           downtime not yet open" (the START of the cycle).
 *   - phase_signoff.prep    the first DTUX-1 sign-off checkbox.
 *   - phase: 'prep'         THIS module's value: the game-prep window between
 *                           processing and game (near the END of the cycle).
 *                           Feeding is open during it.
 * statusToPhase maps legacy status 'prep' to null, never to 'prep'.
 */

// The canonical phase order. A cycle's own phase_sequence wins when present.
export const CYCLE_PHASE_SEQUENCE = Object.freeze(['downtime', 'processing', 'prep', 'game']);

const PHASE_VALUES = new Set(CYCLE_PHASE_SEQUENCE);

// Rev 2 section 7 mirror table: what the legacy fields say for each new phase,
// so every pre-CM-1 reader (including a stale browser tab reading the API)
// sees a coherent old-model state. prep mirrors to the PROCESSING pair, never
// the game pair: nothing keyed to game-start may fire early (the vetoed
// contamination), and the server's closed-cycle write gate stays closed to
// everything except feeding fields (see openCycleVerdict).
export const PHASE_MIRROR = Object.freeze({
  downtime:   Object.freeze({ game_phase: 'downtime',   status: 'active' }),
  processing: Object.freeze({ game_phase: 'processing', status: 'closed' }),
  prep:       Object.freeze({ game_phase: 'processing', status: 'closed' }),
  game:       Object.freeze({ game_phase: 'game',       status: 'game' }),
});

/**
 * Map a legacy effective status to the new phase vocabulary.
 * 'open' folds to 'downtime' (both mean the downtime window is open, matching
 * the Wiki stub's treatment). Legacy 'prep' and anything unrecognised map to
 * null: no phase, form closed, the safe default.
 */
export function statusToPhase(status) {
  switch (status) {
    case 'active':
    case 'open':   return 'downtime';
    case 'game':   return 'game';
    case 'closed': return 'processing';
    default:       return null;
  }
}

/**
 * The canonical phase read. `cycle.phase` wins when it is a known phase value;
 * otherwise fall back to the legacy fields via `deriveStatus`.
 *
 * `deriveStatus` defaults to reading the raw `status` field. Client callers
 * should pass db.js's deriveCycleStatus for full legacy fidelity (the #708
 * game_phase override, the #231 manual_open latch, the sign-off ladder).
 * Server callers only enter phase-aware branches when `phase` is a known
 * value, so the fallback fidelity does not matter there.
 */
export function cyclePhase(cycle, deriveStatus) {
  if (cycle && PHASE_VALUES.has(cycle.phase)) return cycle.phase;
  const status = typeof deriveStatus === 'function' ? deriveStatus(cycle) : cycle?.status;
  return statusToPhase(status);
}

/**
 * CM-4a: the ONE reader of the phase a transition moves FROM, shared verbatim
 * by the admin Cycle tab (cycle-views.js's uiPhase) and by the server route
 * that enforces the wipe rule (routes/downtime.js's cycles PUT).
 *
 * It exists because the two tiers used to disagree. The client read
 * `phase || game_phase`; the server's `cyclePhase` falls back to
 * `statusToPhase(status)` instead. On the real legacy shape
 * `{game_phase:'game', status:'closed'}` the client said 'game' (so entering
 * prep showed no dialog) and the server said 'processing' (so entering prep
 * WOULD wipe) - a tracker wipe on a transition the ST was never warned about.
 * The `from` side of a transition is exactly where a legacy document gets
 * read, so the two answers have to be one answer.
 *
 * Resolution order: a known `phase`, else a known legacy `game_phase`, else
 * `statusToPhase(status)`, else null. Unknown values never leak - a
 * hand-edited `phase: 'feeding'` falls through to the legacy fields rather
 * than being handed to the transition matrix.
 *
 * Distinct from `cyclePhase` above, deliberately: that one takes an injected
 * `deriveStatus` and is the general "what phase is this cycle in" read.
 */
export function transitionFromPhase(cycle) {
  if (!cycle) return null;
  if (PHASE_VALUES.has(cycle.phase)) return cycle.phase;
  if (PHASE_VALUES.has(cycle.game_phase)) return cycle.game_phase;
  return statusToPhase(cycle.status);
}

/**
 * The single current cycle: highest game_number wins, never API/_id/array
 * order (creation order is proven wrong for game order in this data - see
 * db.js's getFeedingCycle doc comment for the same rule applied elsewhere).
 * Returns null for an empty/missing list.
 */
export function currentCycle(cycles) {
  if (!Array.isArray(cycles) || !cycles.length) return null;
  return cycles.reduce((best, c) => (!best || (c.game_number || 0) > (best.game_number || 0) ? c : best), null);
}

/**
 * Is the CURRENT cycle (not just any cycle anywhere in the list) in game
 * phase right now? otc.2 (2026-08-12) finding: filtering all cycles for
 * phase 'game' and then taking the highest game_number AMONG THOSE MATCHES
 * is wrong - a stale historical cycle left in game phase outranks a newer
 * cycle that has since moved to prep/processing/downtime, because the newer
 * cycle was never in the filtered set to begin with. Identify the current
 * cycle FIRST, then test its phase.
 */
export function currentCycleInGamePhase(cycles, deriveStatus) {
  const current = currentCycle(cycles);
  return current && cyclePhase(current, deriveStatus) === 'game' ? current : null;
}

/** Index of a phase in this cycle's sequence (its own phase_sequence wins). */
export function phaseIndex(cycle, phase) {
  const seq = Array.isArray(cycle?.phase_sequence) && cycle.phase_sequence.length
    ? cycle.phase_sequence
    : CYCLE_PHASE_SEQUENCE;
  return seq.indexOf(phase);
}

/** Is feeding open? Rev 2 section 7: feeding opens on prep and stays open in game. */
export function isFeedingOpen(cycle, deriveStatus) {
  const p = cyclePhase(cycle, deriveStatus);
  return p === 'prep' || p === 'game';
}

/**
 * CM-5a: does entering `toPhase` from `fromPhase` reset the live tracker?
 *
 * The slate-wipe belongs at PREP entry - prep is the loading of game-starting
 * state (Rev 2 section 2), so the wipe happens before carry-over lands, and
 * feed rolls made during the prep week survive into the game. Entering game
 * FROM prep is therefore non-destructive ("prep and game are deliberately
 * seamless"). Entering game from anywhere else keeps the legacy reset, which
 * is also the fallback path: skip prep and today's exact behaviour returns.
 */
export function resetOnTransition(fromPhase, toPhase) {
  // Entering prep wipes the slate ONCE per chapter, and only from a phase
  // that precedes it. Re-entering prep (toggled off and on, or corrected via
  // another phase and back) would discard feeds already confirmed this prep
  // week; entering prep FROM game would wipe live state mid-session. Both are
  // reachable by one misclick on a button that sits beside Game, so they fail
  // safe here rather than relying on the confirm dialog (review, 2026-08-10).
  if (toPhase === 'prep') return fromPhase !== 'prep' && fromPhase !== 'game';
  if (toPhase === 'game') return fromPhase !== 'prep';
  return false;
}

/**
 * The update object for a non-null phase write: the new `phase` field plus its
 * legacy mirror pair, written together in ONE update so the representations
 * cannot desync (the 16 July 2026 failure mode).
 */
export function phaseWrites(phase) {
  const mirror = PHASE_MIRROR[phase];
  if (!mirror) throw new Error('phaseWrites: unknown phase "' + phase + '"');
  return { phase, ...mirror };
}

/**
 * The three fields that TOGETHER represent a cycle's phase: the CM-1 canonical
 * `phase` plus its legacy mirror pair. Named once, because more than one caller
 * now needs to say "these fields describe live game-night state, and I must not
 * write them here" (buildPhaseUpdate defends them against caller extras; the
 * Data Portability importer strips them from a restore body - see
 * withoutPhaseFields below).
 */
export const PHASE_FIELDS = Object.freeze(['phase', 'game_phase', 'status']);

/**
 * A shallow copy of `doc` with the mirror trio removed.
 *
 * STORY 27.1 NOTE (2026-10-02): the server no longer wipes tracker_state on any transition and TM Game no
 * longer writes a phase at all, so the hazard described below is gone; this helper now only keeps
 * `buildPhaseUpdate`'s `extra` free of the trio. The history below explains why it exists.
 *
 * CM-4a review (P1, 2026-08-16): the phase write now carries a destructive
 * consequence (the server wipes tracker_state on a resetting transition), so a
 * body that merely RESTORES data must not carry phase fields at all. Note that
 * "same phase in, no transition, therefore safe" is FALSE for one row of the
 * matrix: resetOnTransition('game', 'game') is true, because entering game from
 * anywhere except prep is the legacy reset. Re-importing a backup of a cycle
 * that is currently in game phase would therefore have wiped every character's
 * live tracker, silently, with no dialog on that path.
 */
export function withoutPhaseFields(doc) {
  const { phase: _p, game_phase: _g, status: _s, ...rest } = doc || {};
  return rest;
}

/**
 * The COMPLETE update object for any phase transition, including the null
 * (clear-to-neutral) row and any caller extras. Extracted pure (Codex review
 * finding, 2026-08-10) so the full five-row table is directly testable and so
 * the mirror trio is defended: extras may add fields (closed_at,
 * game_phase_at) but can NEVER override phase, game_phase or status - a
 * caller-supplied conflict is silently discarded in favour of the mirror,
 * because one canonical writer that can be argued with is no canonical writer
 * at all. The null row derives status through `deriveStatus` (db.js injects
 * deriveCycleStatus), preserving #918 clear semantics.
 */
export function buildPhaseUpdate(cycle, phaseOrNull, extra, deriveStatus) {
  const safeExtra = withoutPhaseFields(extra);
  const writes = phaseOrNull === null
    ? {
        phase: null,
        game_phase: null,
        status: typeof deriveStatus === 'function'
          ? deriveStatus({ ...cycle, game_phase: null })
          : cycle?.status,
      }
    : phaseWrites(phaseOrNull);
  return { ...safeExtra, ...writes };
}

// Fields a player may write to a submission outside the downtime window,
// because the feed roll happens at game time (and, from CM-1 on, during prep).
// Shared by the submissions PUT deadline check and openCycleVerdict.
export const FEEDING_ONLY_FIELDS = Object.freeze([
  'feeding_roll_player',
  'feeding_vitae_allocation',
  'feeding_deferred',
]);

/**
 * The requireOpenCycle decision, extracted pure so the matrix is unit-testable
 * without a database. Returns 'allow' or 'locked'.
 *
 * Phase-aware lane (cycle carries ANY string `phase`, resolved through the
 * canonical reader - so a malformed value like 'feeding' falls back to the
 * legacy-derived phase and is judged by phase rules, failing CLOSED rather
 * than slipping into the permissive legacy lane; Codex review finding,
 * 2026-08-10):
 *   - ST/dev: always allowed. The processing phase IS the ST writing
 *     resolutions to submissions (cycle-model.md Rev 2 section 2); a
 *     phase-aware gate that locked the ST out of processing would break the
 *     model it implements. (Deviation from the story's AC 5 literal text,
 *     resolved in favour of the ruling document; recorded in the Dev Agent
 *     Record.)
 *   - Player, phase 'downtime': allowed (the downtime window).
 *   - Player, phase 'prep' or 'game', body touches ONLY feeding fields:
 *     allowed (this is what opens feeding during prep).
 *   - Player, anything else: out-of-window exception, else locked.
 *
 * Legacy lane (no `phase` field at all): byte-identical to the pre-CM-1 gate -
 * locked only when raw status is 'closed', with the out-of-window exception.
 */
export function openCycleVerdict({ cycle, role, bodyKeys, oowMatch, deriveStatus }) {
  const keys = Array.isArray(bodyKeys) ? bodyKeys : [];
  const feedingOnly = keys.length > 0 && keys.every(k => FEEDING_ONLY_FIELDS.includes(k));

  if (cycle && typeof cycle.phase === 'string' && cycle.phase !== '') {
    if (role === 'st' || role === 'dev') return 'allow';
    const p = cyclePhase(cycle, deriveStatus);
    if (p === 'downtime') return 'allow';
    if ((p === 'prep' || p === 'game') && feedingOnly) return 'allow';
    return oowMatch ? 'allow' : 'locked';
  }

  if (cycle?.status === 'closed') {
    return oowMatch ? 'allow' : 'locked';
  }
  return 'allow';
}
