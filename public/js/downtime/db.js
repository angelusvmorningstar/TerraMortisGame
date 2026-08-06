/**
 * Downtime data access — API-backed.
 * Replaces Peter's IndexedDB layer with HTTP calls to the Express API.
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../data/api.js';

// ── Cycles ──────────────────────────────────────────────────────────────────

export async function getCycles() {
  return apiGet('/api/downtime_cycles');
}

export async function getActiveCycle() {
  const cycles = await getCycles();
  return cycles.find(c => c.status === 'active') || null;
}

export async function createCycle(gameNumber, { status = 'prep', deadlineAt = null, label = null, chapterId = null } = {}) {
  const body = {
    label: label || ('Downtime ' + gameNumber),
    game_number: gameNumber,
    status,
    loaded_at: new Date().toISOString(),
    submission_count: 0,
    out_of_window_player_ids: [],
  };
  if (deadlineAt) body.deadline_at = deadlineAt;
  if (chapterId) body.chapter_id = chapterId;
  return apiPost('/api/downtime_cycles', body);
}

export async function deleteCycle(id) {
  return apiDelete('/api/downtime_cycles/' + id);
}

/** Derive the game number for a new cycle: closed cycle count + 1 for current, +1 for next. */
async function nextGameNumber() {
  const all = await getCycles();
  const closedCount = all.filter(c => c.status === 'closed').length;
  const active = all.find(c => c.status === 'active');
  if (active?.game_number) return active.game_number + 1;
  // Fallback: closed cycles = past games, active = one more → next is one more again
  return closedCount + 2;
}

export async function updateCycle(id, updates) {
  return apiPut('/api/downtime_cycles/' + id, updates);
}

export async function closeCycle(id) {
  return updateCycle(id, { status: 'closed', closed_at: new Date().toISOString() });
}

export async function openGamePhase(id) {
  return updateCycle(id, { status: 'game', game_phase_at: new Date().toISOString() });
}

// ── DTUX-1 sign-off model ────────────────────────────────────────────────
// Each cycle carries cycle.phase_signoff = { prep, city, projects, story, ready }
// where each entry is { at: ISO, by: user_id } when signed-off, absent when not.
// cycle.status remains in the schema (~14 reads across the codebase) but is
// auto-derived from sign-off state on every write.
//
// Issue #231 — Manual override: cycle.manual_open (boolean) is a latched flag
// that forces effective status to 'active' regardless of phase_signoff state.
// The closed gate (projects signed) wins over the override; everything else
// is dominated by it. setManualOpen() below is the single write path.

export const DTUX_PHASES = ['prep', 'city', 'projects', 'story', 'ready'];

export function deriveCycleStatus(cycle) {
  // CYCLE epic (#708): manual game_phase overrides legacy derivation when set.
  if (cycle?.game_phase === 'game')        return 'game';
  if (cycle?.game_phase === 'downtime')    return 'active';
  if (cycle?.game_phase === 'processing')  return 'closed';
  // Legacy derivation — covers cycles predating #708.
  const ps = cycle?.phase_signoff || {};
  // Closed wins regardless of override (issue #231 AC-4): once projects
  // are signed off the ST is processing; no late submissions.
  if (ps.projects) return 'closed';
  // Manual override (issue #231): latched flag forces 'active' for any
  // non-closed state. Strict equality so stale string/numeric values
  // from hand-edited docs don't accidentally activate the override.
  if (cycle?.manual_open === true) return 'active';
  if (!ps.prep) return 'prep';
  if (!ps.city) return 'game';
  return 'active';
}

export async function signoffPhase(cycle, phase, signedOff, userId) {
  if (!cycle?._id) return null;
  const ps = { ...(cycle.phase_signoff || {}) };
  if (signedOff) {
    ps[phase] = { at: new Date().toISOString(), by: userId || null };
  } else {
    delete ps[phase];
  }
  const newStatus = deriveCycleStatus({ ...cycle, phase_signoff: ps });
  await updateCycle(cycle._id, { phase_signoff: ps, status: newStatus });
  cycle.phase_signoff = ps;
  cycle.status = newStatus;
  return cycle;
}

// Issue #231 — Manual "open downtimes" override (DT Prep tab).
// Latches `manual_open` on the currently-loaded cycle and re-derives status.
// Mirrors signoffPhase's mutate-in-place pattern so callers see new values
// without re-fetching. Setting `on=true` when the cycle has no closed gate
// forces effective status to 'active'; setting `on=false` reverts the cycle
// to whatever phase_signoff alone derives.
export async function setManualOpen(cycle, on, userId) {
  if (!cycle?._id) return null;
  const updates = on
    ? { manual_open: true,  manual_open_at: new Date().toISOString(), manual_open_by: userId || null }
    : { manual_open: false, manual_open_at: null,                     manual_open_by: null };
  // Re-derive status against the projected next state (closed-wins /
  // override-active / phase fallback — see deriveCycleStatus).
  updates.status = deriveCycleStatus({ ...cycle, ...updates });
  await updateCycle(cycle._id, updates);
  Object.assign(cycle, updates);
  return cycle;
}

/**
 * Canonical test: is this cycle in game phase? (#1001)
 * Resolves through deriveCycleStatus so manual game_phase (#708) wins over the
 * legacy `status` field. Every "which cycle is live for the game" reader must go
 * through this — reading raw `status === 'game'` misses game_phase divergence and
 * broke feeding night (game_phase='game' while status still pointed elsewhere).
 */
export function isInGamePhase(cycle) {
  return deriveCycleStatus(cycle) === 'game';
}

/** Get the cycle currently in game phase (game_phase wins over legacy status). */
export async function getGamePhaseCycle() {
  const cycles = await getCycles();
  return cycles.find(isInGamePhase) || null;
}

/** Human-readable cycle name for dialogs. Label if set, else "Game N". */
export function cycleDisplayName(cycle) {
  return cycle?.label || (cycle?.game_number != null ? 'Game ' + cycle.game_number : 'this cycle');
}

/**
 * #1002: derive a cycle's feeds-into span. Downtimes are collected after game N
 * and consumed at the following session, so a cycle for game N feeds game N+1.
 * Derived from game_number - never stored. Empty string when game_number is unknown.
 *   cycleSpanLabel  → "Downtime after Game 5, feeds Game 6"  (full, for chips/headers)
 *   cycleFeedsLabel → "feeds Game 6"                          (short, for pickers/copy)
 */
export function cycleSpanLabel(cycle) {
  const n = cycle?.game_number;
  return n == null ? '' : `Downtime after Game ${n}, feeds Game ${n + 1}`;
}

export function cycleFeedsLabel(cycle) {
  const n = cycle?.game_number;
  return n == null ? '' : `feeds Game ${n + 1}`;
}

/**
 * #1003 flip guard: deciding whether flipping `targetCycle` to game phase should
 * warn the ST. Fires only when the target has zero downtime submissions AND another
 * non-closed cycle has some — the 2026-07-16 mistake was flipping empty "Game 6"
 * to game while "Game 5" (27 submissions) sat live, silently defaulting every
 * feeding roll to Barrens -4. Pure decision (submission counts injected via
 * `countSubs(cycleId) => Promise<number>`) so it is unit-testable. Returns null
 * when no warning is warranted, else { target, targetCount, rival, rivalCount }.
 */
export async function zeroSubmissionFlipWarning(targetCycle, cycles, countSubs) {
  if (!targetCycle) return null;
  const targetCount = await countSubs(targetCycle._id);
  if (targetCount > 0) return null;
  // "Closed" via either signal: closeCycle() sets raw status='closed' without
  // touching phase_signoff, so deriveCycleStatus alone would miss legacy closed
  // cycles (it derives from game_phase/phase_signoff, not the raw status field).
  const isClosed = (c) => c.status === 'closed' || deriveCycleStatus(c) === 'closed';
  for (const c of cycles || []) {
    if (!c || String(c._id) === String(targetCycle._id)) continue;
    if (isClosed(c)) continue;
    const n = await countSubs(c._id);
    if (n > 0) return { target: targetCycle, targetCount, rival: c, rivalCount: n };
  }
  return null;
}

/** Confirm-dialog copy for the #1003 flip guard. British English, no em-dashes. */
export function zeroSubmissionFlipMessage(warn) {
  const t = cycleDisplayName(warn.target);
  const r = cycleDisplayName(warn.rival);
  return `${t} has no downtime submissions; ${r} has ${warn.rivalCount}. `
    + `Players' feeding pulls from the game-phase cycle. Flip ${t} to game phase anyway?`;
}

// ── Submissions ─────────────────────────────────────────────────────────────

export async function getSubmissionsForCycle(cycleId) {
  return apiGet('/api/downtime_submissions?cycle_id=' + cycleId);
}

export async function updateSubmission(id, updates) {
  return apiPut('/api/downtime_submissions/' + id, updates);
}

/**
 * Upsert parsed submissions into a cycle.
 * Creates the cycle if none active, then posts each submission.
 */
export async function upsertCycle(parsedSubmissions, characters) {
  let cycle = await getActiveCycle();
  if (!cycle) {
    const all = await getCycles();
    const gameNum = all.filter(c => c.status === 'closed').length + 1;
    cycle = await createCycle(gameNum);
  }

  const existing = await getSubmissionsForCycle(cycle._id);
  // Index by character_name AND character_id so portal submissions (which lack character_name)
  // are still found when a CSV row matches the same character.
  const byName = new Map(existing.filter(s => s.character_name).map(s => [s.character_name, s]));
  const byId   = new Map(existing.filter(s => s.character_id).map(s => [String(s.character_id), s]));

  let created = 0, updated = 0, unchanged = 0;

  for (const parsed of parsedSubmissions) {
    const charName = parsed.submission.character_name;
    const charId   = parsed._character_id ? String(parsed._character_id) : null;
    const doc = {
      cycle_id: cycle._id,
      character_id: parsed._character_id ? String(parsed._character_id) : null,
      character_name: charName,
      player_name: parsed.submission.player_name,
      status: 'submitted',
      timestamp: parsed.submission.timestamp,
      attended: parsed.submission.attended_last_game,
      _raw: parsed,
      responses: mapRawToResponses(parsed, characters || null),
      updated_at: new Date().toISOString(),
    };

    // Match by name first (CSV-sourced), then by character_id (portal-sourced)
    const prev = byName.get(charName) || (charId ? byId.get(charId) : null);
    if (prev) {
      await apiPut('/api/downtime_submissions/' + prev._id, doc);
      updated++;
    } else {
      await apiPost('/api/downtime_submissions', doc);
      created++;
    }
  }

  // Update cycle submission count
  await apiPut('/api/downtime_cycles/' + cycle._id, {
    submission_count: (existing.length - updated) + updated + created,
  });

  return { cycle, created, updated, unchanged };
}

// ── CSV → responses mapping ────────────────────────────────────────────────

/**
 * Normalise a free-text feeding method to the form's enum ID.
 */
function normaliseFeedMethod(raw) {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/seduc/i.test(s)) return 'seduction';
  if (/stalk|hunt/i.test(s)) return 'stalking';
  if (/force|attack/i.test(s)) return 'force';
  if (/familiar|animal|beast/i.test(s)) return 'familiar';
  if (/intimid/i.test(s)) return 'intimidation';
  return 'other';
}

/**
 * Normalise a CSV sphere action string to the schema enum.
 */
function normaliseSphereAction(raw) {
  if (!raw) return '';
  const s = raw.trim().toLowerCase();
  if (/ambience.*increase|make.*delicious/i.test(s)) return 'ambience_increase';
  if (/ambience.*decrease/i.test(s)) return 'ambience_decrease';
  if (/attack/i.test(s)) return 'attack';
  if (/block/i.test(s)) return 'block';
  if (/hide|protect/i.test(s)) return 'hide_protect';
  if (/investigat/i.test(s)) return 'investigate';
  if (/patrol|scout/i.test(s)) return 'patrol_scout';
  if (/rumour|rumor/i.test(s)) return 'rumour';
  if (/support/i.test(s)) return 'support';
  if (/grow/i.test(s)) return 'grow';
  if (/acqui/i.test(s)) return 'acquisition';
  if (/misc/i.test(s)) return 'misc';
  return '';
}

/**
 * Normalise CSV territory grid to the form's { slug: status } JSON format.
 */
function normaliseTerritoryGrid(rawTerrs) {
  if (!rawTerrs || typeof rawTerrs !== 'object') return null;
  const nameToSlug = {
    'The Academy':              'the_academy',
    'The Harbour':              'the_harbour',
    'The City Harbour':         'the_harbour',         // legacy
    'The Dockyards':            'the_dockyards',
    'The Second City':          'the_second_city',
    'The North Shore':          'the_north_shore',
    'The Northern Shore':       'the_north_shore',     // legacy
    'The Barrens (No Territory)': 'the_barrens__no_territory_',
    'The Barrens':              'the_barrens__no_territory_', // legacy
  };
  const statusMap = { 'Resident': 'resident', 'Poaching': 'poach', 'Feeding': 'feed', 'Not feeding here': 'none' };
  const result = {};
  for (const [name, val] of Object.entries(rawTerrs)) {
    const slug = nameToSlug[name];
    if (!slug) continue;
    result[slug] = statusMap[val] || 'none';
  }
  return JSON.stringify(result);
}

/**
 * Map a parsed CSV submission object into flat responses matching the player
 * portal form format. Characters array is optional — used for name→ID
 * resolution in shoutout picks.
 */
export function mapRawToResponses(parsed, characters) {
  const r = {};

  // Court / narrative
  const n = parsed.narrative || {};
  if (n.travel_description) r.travel = n.travel_description;
  if (n.game_recount) r.game_recount = n.game_recount;
  if (n.ic_correspondence) r.correspondence = n.ic_correspondence;
  if (n.most_trusted_pc) r.trust = n.most_trusted_pc;
  if (n.actively_harming_pc) r.harm = n.actively_harming_pc;
  if (n.aspirations) r.aspirations = n.aspirations;
  // Shoutout: resolve names to IDs when possible
  if (n.standout_rp) {
    const names = n.standout_rp.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    const resolved = names.map(name => {
      if (!characters) return name;
      const c = characters.find(ch =>
        ch.name === name || ch.moniker === name ||
        (ch.name || '').toLowerCase() === name.toLowerCase()
      );
      return c ? String(c._id) : name;
    });
    r.rp_shoutout = JSON.stringify(resolved);
  }

  // Regency
  const reg = parsed.regency || {};
  r._gate_is_regent = reg.is_regent ? 'yes' : 'no';
  if (reg.territory) r.regent_territory = reg.territory;
  if (reg.regency_action) r.regency_action = reg.regency_action;

  // Feeding
  const f = parsed.feeding || {};
  if (f.method) {
    r._feed_method = normaliseFeedMethod(f.method);
    if (r._feed_method === 'other') r.feeding_description = f.method;
  }
  if (f.territories) r.feeding_territories = normaliseTerritoryGrid(f.territories);

  // Influence territory amounts — numeric values (positive = increase, negative = decrease)
  const inf = parsed.influence || {};
  const infNonZero = Object.fromEntries(Object.entries(inf).filter(([, v]) => v !== 0));
  if (Object.keys(infNonZero).length) r.influence_territories = JSON.stringify(infNonZero);

  // Projects (up to 4)
  const projects = parsed.projects || [];
  projects.forEach((p, i) => {
    const n = i + 1;
    if (p.action_type) r[`project_${n}_action`] = p.action_type;
    // Issue #129: canonicalise CSV-imported ambience actions. Parser now
    // emits `action_type: 'ambience_change'` + `ambience_direction:
    // 'improve' | 'degrade'`. Write the direction into the canonical
    // responses key the live form uses so the admin tally sees one shape.
    if (p.ambience_direction) r[`project_${n}_ambience_direction`] = p.ambience_direction;
    if (p.project_name) r[`project_${n}_title`] = p.project_name;
    if (p.desired_outcome) r[`project_${n}_outcome`] = p.desired_outcome;
    if (p.detail || p.description) r[`project_${n}_description`] = p.detail || p.description;
    if (p.primary_pool?.expression) r[`project_${n}_pool_expr`] = p.primary_pool.expression;
    if (p.secondary_pool?.expression) r[`project_${n}_pool2_expr`] = p.secondary_pool.expression;
    if (p.characters) r[`project_${n}_cast`] = typeof p.characters === 'string' ? p.characters : JSON.stringify(p.characters);
    if (p.merits) r[`project_${n}_merits`] = p.merits;
    if (p.xp_spend != null) r[`project_${n}_xp`] = String(p.xp_spend);
  });

  // Sphere actions (up to 5)
  (parsed.sphere_actions || []).forEach((s, i) => {
    const n = i + 1;
    if (s.merit_type) r[`sphere_${n}_merit`] = s.merit_type;
    if (s.action_type) r[`sphere_${n}_action`] = normaliseSphereAction(s.action_type);
    if (s.desired_outcome) r[`sphere_${n}_outcome`] = s.desired_outcome;
    if (s.description) r[`sphere_${n}_description`] = s.description;
  });

  // Contacts
  (parsed.contact_actions?.requests || []).forEach((req, i) => {
    r[`contact_${i + 1}_request`] = req;
  });

  // Retainers
  (parsed.retainer_actions?.actions || []).forEach((task, i) => {
    r[`retainer_${i + 1}_task`] = task;
  });

  // Sorcery
  if (parsed.ritual_casting?.casting) r.sorcery_1_rite = parsed.ritual_casting.casting;

  // Meta
  const m = parsed.meta || {};
  if (m.xp_spend) r.xp_spend = m.xp_spend;
  if (m.lore_questions) r.lore_request = m.lore_questions;
  if (m.st_notes) r.vamping = m.st_notes;
  if (m.form_comments) r.form_feedback = m.form_comments;

  return r;
}

// ── Rolls ───────────────────────────────────────────────────────────────────

export async function saveRoll(submissionId, source, index, rollFields) {
  const sub = await apiGet('/api/downtime_submissions?cycle_id=').catch(() => null);
  // Simplified: update the submission's _raw with the roll data
  // Full implementation in Story 4.3 (Feeding Roll Resolution)
  return apiPut('/api/downtime_submissions/' + submissionId, {
    [`_raw.${source}.${index}.roll`]: rollFields,
    updated_at: new Date().toISOString(),
  });
}
