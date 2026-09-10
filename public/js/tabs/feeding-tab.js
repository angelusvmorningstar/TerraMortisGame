/**
 * Feeding tab — one-shot feeding roll.
 *
 * If player submitted downtime: shows their declared method + calculated pool.
 * If no downtime: shows generic method selection.
 * One roll, then locked. STs can re-run.
 *
 * States: loading → ready → rolled | no_submission (generic picker)
 *                 → rolled-from-form (Epic 12: the roll already happened in TM
 *                   Story's downtime form; read-only here, never re-rollable)
 */

import { apiGet, apiPut } from '../data/api.js';
import { fetchStoryFeeding } from '../data/story-feeding.js';
import { getFeedingCycle } from '../downtime/db.js';
import { esc, displayName, hasAoE } from '../data/helpers.js';
import { getAttrEffective as getAttrVal, skDots, skTotal, skSpecStr, calcVitaeMax } from '../data/accessors.js';
import { FEED_METHODS, TERRITORY_DATA } from './downtime-data.js';
import { SKILLS_MENTAL } from '../data/constants.js';
import { isSTRole } from '../auth/discord.js';
import { domMeritContrib, effectiveInvictusStatus, calcTotalInfluence } from '../editor/domain.js';
import { trackerAdj, trackerRead, trackerReadRaw } from '../game/tracker.js';
// dtlt.1: bonus successes (Stronger Than You). The local dice helpers below
// stay — they carry this tab's configurable again-threshold, which the shared
// engine reads from global roll state instead. Only the success RESOLUTION is
// shared, and shared cntSuc reads the same per-die `s` flag these chains carry.
import { resolveSuccesses, formatSuccessBreakdown } from '../shared/dice.js';

// Dice math (configurable again threshold: 10 = standard, 9 = 9-again, 8 = 8-again)
function d10() { return Math.floor(Math.random() * 10) + 1; }
function mkDie(v, again = 10)  { return { v, s: v >= 8, x: v >= again }; }
function mkChain(rv, again = 10) {
  const r = mkDie(rv, again); const ch = [];
  let l = r; while (l.x) { const c = mkDie(d10(), again); ch.push(c); l = c; }
  return { r, ch };
}
function rollDice(n, again = 10) { const c = []; for (let i = 0; i < n; i++) c.push(mkChain(d10(), again)); return c; }
function cntSuc(cols) { let s = 0; cols.forEach(col => { if (col.r.s) s++; col.ch.forEach(d => { if (d.s) s++; }); }); return s; }

let currentChar = null;
let container = null;
let feedingState = 'loading'; // loading | ready | rolled | no_submission | deferred | rolled-from-form
let declaredMethod = null; // FEED_METHODS entry from downtime submission
let declaredDisc = '';
let declaredSpec = '';
let selectedMethodId = ''; // for no_submission generic picker
let selectedDisc = '';
let selectedSpec = '';
let poolTotal = 0;
let poolBreakdown = '';
let stRote  = false; // rote flag confirmed by ST in downtime processing
let stAgain = 10;   // again threshold (8/9/10) confirmed by ST
// Review fix (Codex, external, dtlt.1): true only when poolTotal was actually
// built from declaredMethod's own attrs/skills (buildPool() below). An
// ST-confirmed pool (feeding_roll.params or a parsed pool_validated size)
// carries no reliable trait names — declaredMethod may be a stale/different
// method the player originally submitted, not what the ST actually
// confirmed — so bonus-success predicates must not be evaluated against it.
let poolTraitsTrusted = false;
let rollResult = null;
let vitaeAllocation = null; // array of ints after player confirms, or null
let feedingRecord = null; // persisted feeding_rolls record from DB
let responseSubId = null; // submission _id for persisting player roll
let publishedFeedingText = null; // extracted Feeding section from published_outcome
let stRollResult = null; // ST's roll from admin processing (feeding_roll)
let currentSub = null; // full submission doc for summary rendering
let vitateTally = null; // feeding_vitae_tally from ST processing
let _liveTerrDocs = []; // cached from /api/territories — used by territory-key lookups (2026-06-20)
// Epic 12 (Story 12.2): TM Story's own `content.feeding` sub-document for the
// active cycle, fetched through Story 12.1's read-only client. Non-null ONLY
// when it carries a real rollResult, which is what makes it authoritative.
let storyFeeding = null;
// The active cycle's _id as a string. Also the value of the tracker_state
// idempotency marker written when a form-sourced roll's aggHealed is applied.
let activeCycleId = null;
// The raw tracker_state document, read once per render pass (ST only). Carries
// fields tracker.js's own in-memory cache does not map, notably the
// feeding_agg_healed_cycle_id marker.
let trackerDoc = null;
// The tracker_state field the aggHealed idempotency marker lives in. TM Game
// has no write path to tm_story (Story 12.2 grounding), so an "already applied"
// flag cannot be written back onto TM Story's submission — it lives here, in
// the one collection this tab already writes to.
export const AGG_HEALED_MARKER = 'feeding_agg_healed_cycle_id';
const _stConfirmed = {}; // charId → {vitae, infSpent} — persists within session

// Resolve a feeding_territories grid key (slug OR ObjectId hex string) to a
// TERRITORY_DATA entry. After the territory-FK migration the grid keys are
// ObjectId strings; pre-migration data may still carry slugs. Tries _id first
// then slug. Returns the TERRITORY_DATA entry (slug-keyed shape) when found.
function _resolveTerrKey(tid) {
  if (!tid) return null;
  // 1) Look up live doc by _id, then map back to TERRITORY_DATA via slug.
  const live = _liveTerrDocs.find(d => String(d._id) === tid);
  if (live?.slug) {
    const t = TERRITORY_DATA.find(td => td.slug === live.slug);
    if (t) return t;
  }
  // 2) Fall back to direct slug match (pre-migration data + any string-keyed entries).
  return TERRITORY_DATA.find(td => td.slug === tid || tid.includes?.(td.slug)) || null;
}

export async function renderFeedingTab(el, char) {
  currentChar = char;
  container = el;
  if (!el || !char) {
    if (el) el.innerHTML = '<p class="placeholder-msg">Select a character to view feeding.</p>';
    return;
  }

  // Snapshot char at entry — used to detect stale async calls after character switch
  const charSnapshot = char;

  feedingState = 'loading';
  rollResult = null;
  vitaeAllocation = null;
  feedingRecord = null;
  declaredMethod = null;
  selectedMethodId = '';
  stRote  = false;
  stAgain = 10;
  poolTraitsTrusted = false;
  responseSubId = null;
  publishedFeedingText = null;
  stRollResult = null;
  currentSub = null;
  vitateTally = null;
  storyFeeding = null;
  activeCycleId = null;
  trackerDoc = null;

  // Fetch live territory ambience from DB (used by computeVitateTally)
  let liveTerrDocs = [];
  try { liveTerrDocs = await apiGet('/api/territories'); } catch { /* fall back to hardcoded */ }
  _liveTerrDocs = liveTerrDocs; // cache for the module-level _resolveTerrKey helper

  // Bail if character changed while we were fetching
  if (currentChar !== charSnapshot) return;

  // Find active cycle for feeding:
  // Primary: game phase cycle (ST has opened the session).
  // Fallback: most recent cycle where this character has a roll, published outcome,
  //   or deferred flag — covers the case where the game phase cycle has moved states
  //   but the player already rolled.
  let activeCycle = null;
  // CM-1 (#1028): feeding opens on phase prep as well as game, so players can
  // roll before the session (cycle-model.md Rev 2 section 2). Legacy cycles
  // without a phase field resolve exactly as the old game-phase lookup did.
  try { activeCycle = await getFeedingCycle(); } catch { /* offline */ }

  if (currentChar !== charSnapshot) return;

  let mySub = null;

  if (!activeCycle) {
    // Check for any submission with a roll, published outcome, or deferred flag
    try {
      const [allCycles, allSubs] = await Promise.all([
        apiGet('/api/chapters'),
        apiGet('/api/downtime_submissions'),
      ]);
      allSubs.forEach(s => {
        if (!s.published_outcome && s.st_review?.outcome_visibility === 'published') {
          s.published_outcome = s.st_review.outcome_text;
        }
      });
      const charId = String(char._id);
      const candidateSub = allSubs
        .filter(s => String(s.character_id) === charId &&
          (s.published_outcome || s.feeding_roll_player || s.feeding_deferred))
        .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1))[0] || null;
      // Guard: only use candidateSub if its cycle is the newest non-closed cycle.
      // A newer live cycle (e.g. DT4 in 'active') means we are between downtimes —
      // surfacing a previous cycle's confirmed roll would let players act on stale
      // vitae numbers before the current game session has occurred. (#537)
      const newestLiveCycle = allCycles
        .filter(c => c.status !== 'closed')
        .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1))[0] || null;
      if (candidateSub && (!newestLiveCycle || String(candidateSub.chapter_id) === String(newestLiveCycle._id))) {
        activeCycle = allCycles.find(c => String(c._id) === String(candidateSub.chapter_id)) || null;
        mySub = candidateSub;
      }
    } catch { /* ignore */ }
  }

  if (currentChar !== charSnapshot) return;

  if (!activeCycle) {
    // No game phase and no eligible submission — feeding is not yet available
    el.innerHTML = `<div class="tab-split">
      <div class="tab-split-left" id="feeding-left-pane"><p class="placeholder-msg">Feeding rolls open when the Storyteller opens the game phase.</p></div>
      <div class="tab-split-right" id="feeding-right-pane"></div>
    </div>`;
    container = document.getElementById('feeding-left-pane');
    renderFeedingHistoryPane(document.getElementById('feeding-right-pane'), char);
    return;
  }

  activeCycleId = String(activeCycle._id);

  // ── Epic 12 (Story 12.2): TM Story's own downtime form is where the roll
  // actually happens now. Epic 8 moved downtime storage to tm_story, so
  // `mySub` below is structurally absent for Game 8 and every cycle after it —
  // the cross-app read is the only place a live roll can come from.
  //
  // PRECEDENCE (AC 1): a real rollResult from TM Story is authoritative for
  // this cycle and the TM-Game-sourced lookup below is skipped entirely. Any
  // other outcome (fetch failed, no submission, historical document with no
  // rollResult) falls through to the existing state machine unchanged, which
  // still serves residual old-format data correctly.
  const storyRes = await fetchStoryFeeding(String(char._id), activeCycleId);
  if (currentChar !== charSnapshot) return;

  if (storyRes?.ok && storyRes.data?.feeding?.rollResult) {
    storyFeeding = storyRes.data.feeding;
    feedingState = 'rolled-from-form';
    // Only the ST confirm panel consumes the tracker document (current
    // Aggravated count + the aggHealed idempotency marker), so only an ST pays
    // for the request.
    if (isSTRole()) {
      trackerDoc = await readTrackerDoc(String(char._id));
      if (currentChar !== charSnapshot) return;
    }
    mountFeedingPanes(el, char);
    render();
    return;
  }

  // Load submission — skip if already loaded from fallback above
  if (!mySub) {
    try {
      const subs = await apiGet('/api/downtime_submissions?chapter_id=' + activeCycle._id);
      const charIdStr = String(char._id);
      mySub = subs.find(s => String(s.character_id) === charIdStr) || null;
    } catch { /* no submissions */ }
  }

  if (currentChar !== charSnapshot) return;

  if (mySub) {
    // Promote st_review → published_outcome for ST portal views
    if (!mySub.published_outcome && mySub.st_review?.outcome_visibility === 'published') {
      mySub.published_outcome = mySub.st_review.outcome_text;
    }
    currentSub = mySub;
    responseSubId = mySub._id;

    // Extract feeding section from published outcome if available
    if (mySub.published_outcome) {
      const feedMatch = mySub.published_outcome.match(/##\s*Feeding\s*\n([\s\S]*?)(?=\n##\s|\s*$)/);
      if (feedMatch) publishedFeedingText = feedMatch[1].trim();
    }

    // Check DB-persisted player roll first
    if (mySub.feeding_roll_player) {
      rollResult = mySub.feeding_roll_player;
      feedingState = 'rolled';
      if (mySub.feeding_vitae_allocation) {
        vitaeAllocation = mySub.feeding_vitae_allocation;
      }
      vitateTally = mySub.feeding_vitae_tally || computeVitateTally(char, mySub, liveTerrDocs);
      render();
      return;
    }

    // Check deferred flag (player chose to see STs at game)
    if (mySub.feeding_deferred) {
      feedingState = 'deferred';
      render();
      return;
    }
  }

  // Load declared method for display (used in both paths below)
  if (mySub?.responses?.['_feed_method']) {
    const methodId = mySub.responses['_feed_method'];
    declaredMethod = FEED_METHODS.find(m => m.id === methodId) || null;
    declaredDisc = mySub.responses['_feed_disc'] || '';
    declaredSpec = mySub.responses['_feed_spec'] || '';
  }

  // Custom pool fallback: handles 'other' sentinel (new submissions) and
  // legacy '' (submissions saved before this fix). If the player built a
  // custom pool without clicking a preset method card, _feed_method is
  // 'other' (or '') but _feed_custom_attr is set. Build a synthetic method
  // entry so the ready-state render fires instead of no_submission.
  if (!declaredMethod && mySub?.responses?.['_feed_custom_attr']) {
    const customAttr  = mySub.responses['_feed_custom_attr'];
    const customSkill = mySub.responses['_feed_custom_skill'] || '';
    const customDisc  = mySub.responses['_feed_custom_disc']  || '';
    declaredMethod = {
      id: 'custom',
      name: 'Custom Pool',
      desc: 'Player-declared custom combination',
      attrs: [customAttr],
      skills: customSkill ? [customSkill] : [],
      discs:  customDisc  ? [customDisc]  : [],
    };
    declaredDisc = customDisc;
    declaredSpec = mySub.responses['_feed_spec'] || '';
  }

  // Capture ST roll result and vitae tally if present
  if (mySub?.feeding_roll?.successes != null) {
    stRollResult = mySub.feeding_roll;
  }
  // Use ST-persisted tally if available; otherwise compute locally from char data
  vitateTally = mySub?.feeding_vitae_tally || computeVitateTally(char, mySub, liveTerrDocs);

  // Prefer ST-confirmed pool from downtime processing.
  // Priority 1: feeding_roll.params (ST rolled on behalf of player — has exact size)
  // Priority 2: feeding_review.pool_validated (ST validated pool — parse size from expression)
  // Fallback: buildPool() from player's declared method
  if (mySub?.feeding_roll?.params?.size) {
    poolTotal = mySub.feeding_roll.params.size;
    stRote  = mySub.feeding_roll.params.rote  || false;
    stAgain = mySub.feeding_roll.params.again ?? 10;
    const roteLabel = stRote ? ' \u2014 Rote quality' : '';
    poolBreakdown = `ST confirmed: ${poolTotal} dice${roteLabel}`;
    feedingState = 'ready';
  } else if (mySub?.feeding_review?.pool_status === 'validated' && mySub.feeding_review.pool_validated) {
    const rev = mySub.feeding_review;
    const sizeMatch = rev.pool_validated.match(/=\s*(\d+)\s*$/);
    if (sizeMatch) {
      poolTotal = parseInt(sizeMatch[1], 10);
      // Include spec bonus from ST processing — pool_mod_spec is applied at
      // roll time in the admin panel but was missing here, causing a mismatch
      // between what the ST rolls and what the player sees/rolls.
      poolTotal += (rev.pool_mod_spec || 0);
      stRote  = mySub.st_review?.feeding_rote || false;
      stAgain = rev.eight_again ? 8 : rev.nine_again ? 9 : 10;
      const specInfo = (rev.active_feed_specs?.length)
        ? ` + ${rev.active_feed_specs.join(', ')} +${rev.pool_mod_spec}`
        : '';
      const roteLabel = stRote ? ' \u2014 Rote quality' : '';
      const againLabel = stAgain === 8 ? ' \u2014 8-Again' : stAgain === 9 ? ' \u2014 9-Again' : '';
      poolBreakdown = `ST confirmed: ${rev.pool_validated}${specInfo}${roteLabel}${againLabel}`;
      feedingState = 'ready';
    } else if (declaredMethod) {
      buildPool(declaredMethod, declaredDisc, declaredSpec);
      poolTraitsTrusted = true;
      feedingState = 'ready';
    } else {
      feedingState = 'no_submission';
    }
  } else if (declaredMethod) {
    buildPool(declaredMethod, declaredDisc, declaredSpec);
    poolTraitsTrusted = true;
    feedingState = 'ready';
  } else {
    feedingState = 'no_submission';
  }

  // Set up split layout
  mountFeedingPanes(el, char);

  render();
}

/**
 * The tab's two-pane shell. Extracted verbatim (Story 12.2) so the new
 * form-sourced state mounts exactly the layout every other fall-through state
 * already does, rather than carrying a second copy of the same markup.
 */
function mountFeedingPanes(el, char) {
  el.innerHTML = `<div class="tab-split">
    <div class="tab-split-left" id="feeding-left-pane"></div>
    <div class="tab-split-right" id="feeding-right-pane"></div>
  </div>`;
  container = document.getElementById('feeding-left-pane');
  renderFeedingHistoryPane(document.getElementById('feeding-right-pane'), char);
}

/**
 * The raw tracker_state document for a character.
 *
 * tracker.js's in-memory cache maps a fixed field list (see its `ensureLoaded`)
 * and drops anything else, so the aggHealed idempotency marker cannot be read
 * back through it. A 404 simply means this character has no tracker document
 * yet: no marker, no damage, nothing to fail over.
 */
async function readTrackerDoc(charId) {
  try {
    return await apiGet('/api/tracker_state/' + charId);
  } catch {
    return null;
  }
}

async function renderFeedingHistoryPane(el, char) {
  el.innerHTML = '<p class="placeholder-msg dt-hist-loading">Loading\u2026</p>';

  let allSubs = [], cycles = [];
  try {
    [allSubs, cycles] = await Promise.all([
      apiGet('/api/downtime_submissions'),
      apiGet('/api/chapters'),
    ]);
    // Promote st_review → published_outcome for ST portal views
    allSubs.forEach(s => {
      if (!s.published_outcome && s.st_review?.outcome_visibility === 'published') {
        s.published_outcome = s.st_review.outcome_text;
      }
    });
  } catch {
    el.innerHTML = '<p class="placeholder-msg">Could not load history.</p>';
    return;
  }

  const cycleMap = {};
  for (const c of cycles) cycleMap[String(c._id)] = c;

  const charId = String(char._id);
  // Only show closed/game cycles with published outcomes
  const charSubs = allSubs
    .filter(s => String(s.character_id) === charId && s.published_outcome)
    .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1));

  let h = '<div class="dt-hist-panel">';
  h += '<div class="dt-hist-title">Feeding Results</div>';

  if (!charSubs.length) {
    h += '<p class="placeholder-msg dt-hist-empty">No published feeding results yet.</p>';
  } else {
    for (const sub of charSubs) {
      const cycle = cycleMap[String(sub.chapter_id)];
      const label = cycle?.label || `Cycle ${String(sub.chapter_id).slice(-4)}`;

      // Extract just the Feeding section from the published outcome
      const feedMatch = sub.published_outcome.match(/##\s*Feeding\s*\n([\s\S]*?)(?=\n##\s|$)/);
      const feedingText = feedMatch ? feedMatch[1].trim() : null;

      h += `<div class="dt-hist-entry">`;
      h += `<div class="dt-hist-entry-head"><span class="dt-hist-cycle">${esc(label)}</span></div>`;
      if (feedingText) {
        h += `<div class="dt-hist-outcome">`;
        feedingText.split('\n').filter(Boolean).forEach(line => {
          h += `<p>${esc(line)}</p>`;
        });
        h += `</div>`;
      } else {
        h += `<div class="dt-hist-outcome"><p class="placeholder-msg">No feeding section recorded.</p></div>`;
      }
      h += `</div>`;
    }
  }

  h += '</div>';
  el.innerHTML = h;
}

function renderFeedingSummary() {
  // Only show summary for submitted downtimes (not drafts)
  if (!currentSub || currentSub.status !== 'submitted') return '';
  const r = currentSub.responses || {};
  let h = '<div class="feeding-summary">';

  // Blood types
  let bloodTypes = [];
  try { bloodTypes = JSON.parse(r['_feed_blood_types'] || '[]'); } catch { /* ignore */ }
  if (bloodTypes.length) {
    h += `<div class="feeding-sum-row"><span class="feeding-sum-label">Blood:</span> ${bloodTypes.map(b => esc(b)).join(', ')}</div>`;
  }

  // Territories — grid keys are ObjectId strings post-migration; use the
  // _resolveTerrKey helper to look up either by _id or slug.
  let territories = {};
  try { territories = JSON.parse(r['feeding_territories'] || '{}'); } catch { /* ignore */ }
  const feedTerrs = Object.entries(territories)
    .filter(([, v]) => v === 'resident' || v === 'poach')
    .map(([k, v]) => {
      const t = _resolveTerrKey(k);
      const name = t ? t.name : k.replace(/_/g, ' ');
      return `${name} (${v})`;
    });
  if (feedTerrs.length) {
    h += `<div class="feeding-sum-row"><span class="feeding-sum-label">Territory:</span> ${feedTerrs.map(t => esc(t)).join(', ')}</div>`;
  }

  // Description
  if (r['feeding_description']) {
    h += `<div class="feeding-sum-row"><span class="feeding-sum-label">Description:</span> ${esc(r['feeding_description'])}</div>`;
  }

  // Rote + secondary hunt
  // Issue #234 — `_feed_rote` was dropped by dt-form.22; rote is now a per-slot
  // project action. Detect via project-slot scan, mirroring the admin pattern
  // at downtime-views.js:2775-2780. Match both 'rote' and 'feed': the rote-lock
  // at downtime-form.js:620 auto-writes 'feed' for the locked slot; users
  // selecting Rote Hunt manually from the dropdown write 'rote'.
  const feedRote = [1, 2, 3, 4].some(n => {
    const a = r[`project_${n}_action`];
    return a === 'rote' || a === 'feed';
  });
  if (feedRote) {
    h += '<div class="feeding-sum-rote">';
    h += '<span class="feeding-sum-label">Rote:</span> Project action dedicated to feeding';
    // Find the rote/feed project slot
    for (let n = 1; n <= 4; n++) {
      const a = r[`project_${n}_action`];
      if (a === 'rote' || a === 'feed') {
        const method2 = r[`project_${n}_feed_method2`];
        if (method2) {
          const m2 = FEED_METHODS.find(fm => fm.id === method2);
          h += ` \u2014 Secondary method: <strong>${esc(m2?.name || method2)}</strong>`;
        }
        const projTerr = r[`project_${n}_territory`];
        if (projTerr) {
          const t = TERRITORY_DATA.find(td => td.slug === projTerr);
          h += ` in <strong>${esc(t?.name || projTerr)}</strong>`;
        }
        const projDesc = r[`project_${n}_description`];
        if (projDesc) {
          h += `<div class="feeding-sum-sub">${esc(projDesc)}</div>`;
        }
        break;
      }
    }
    h += '</div>';
  }

  h += '</div>';
  return h;
}

function renderStRollResult() {
  if (!stRollResult) return '';
  const suc = stRollResult.successes ?? 0;
  const exc = stRollResult.exceptional || suc >= 5;
  const again = stRollResult.params?.again ?? 10;
  const againLabel = again === 8 ? '8-Again' : again === 9 ? '9-Again' : '';
  const rote = stRollResult.params?.rote;
  const pool = stRollResult.params?.size ?? 0;
  const cls = suc === 0 ? 'feeding-st-roll-fail' : exc ? 'feeding-st-roll-exc' : 'feeding-st-roll-suc';

  let h = `<div class="feeding-st-roll">`;
  h += `<div class="feeding-st-roll-head">ST Roll Result</div>`;
  h += `<div class="feeding-st-roll-body">`;
  h += `<span class="feeding-st-roll-dice">${pool} dice`;
  if (againLabel) h += ` \u00B7 ${againLabel}`;
  if (rote) h += ' \u00B7 Rote';
  h += '</span>';
  h += `<span class="feeding-st-roll-result ${cls}">${suc} success${suc !== 1 ? 'es' : ''}`;
  if (exc && suc > 0) h += ' (exceptional)';
  h += '</span>';

  // Show individual dice if stored
  if (stRollResult.dice_string) {
    h += `<span class="feeding-st-roll-detail">${esc(stRollResult.dice_string)}</span>`;
  }

  h += '</div></div>';
  return h;
}

/**
 * Which attribute and skill a feeding pool is actually built from: the best of
 * each of the method's candidate lists.
 *
 * Extracted from buildPool (dtlt.1) because the roll needs the trait NAMES even
 * on the two ST-confirmed paths, where the pool size comes straight off the
 * submission and buildPool never runs. Bonus-success rules such as Stronger
 * Than You are gated on the attribute in the pool, so without this the rule
 * could not fire on an ST-confirmed feeding pool.
 */
function bestTraitsFor(c, method) {
  const out = { attr: '', attrV: 0, skill: '', skillV: 0, specs: [] };
  if (!c || !method) return out;
  for (const a of method.attrs || []) {
    const v = getAttrVal(c, a);
    if (v > out.attrV) { out.attrV = v; out.attr = a; }
  }
  for (const s of method.skills || []) {
    const v = skTotal(c, s);
    if (v > out.skillV) { out.skillV = v; out.skill = s; out.specs = c.skills?.[s]?.specs || []; }
  }
  return out;
}

function buildPool(method, discName, specName) {
  const c = currentChar;
  if (!c || !method) { poolTotal = 0; poolBreakdown = ''; return; }

  const best = bestTraitsFor(c, method);
  const bestA = best.attr, bestAV = best.attrV;
  const bestS = best.skill, bestSV = best.skillV, bestSpecs = best.specs;

  const specBonus = specName && bestSpecs.includes(specName) ? (hasAoE(c, specName) ? 2 : 1) : 0;
  const discVal = (discName && c.disciplines?.[discName]?.dots) || 0;
  const unskilled = bestSV === 0
    ? (method.skills.some(s => !SKILLS_MENTAL.includes(s)) ? -1 : -3)
    : 0;
  const fgVal = domMeritContrib(c, 'Feeding Grounds');

  poolTotal = Math.max(0, bestAV + bestSV + discVal + specBonus + unskilled + fgVal);

  const parts = [`${bestAV} ${bestA}`, `${bestSV} ${bestS}`];
  if (discVal) parts.push(`${discVal} ${discName}`);
  if (specBonus) parts.push(`${specBonus} ${specName}`);
  if (unskilled) parts.push(`\u2212${Math.abs(unskilled)} (unskilled)`);
  if (fgVal) parts.push(`${fgVal} Feeding Grounds`);
  poolBreakdown = parts.join(' + ') + ` = ${poolTotal}`;
}

// ── Compute vitae tally from character + submission data ──────────────────────
// Used when feeding_vitae_tally hasn't been saved by the ST yet (ready state).
// Returns the same shape as feeding_vitae_tally.
// liveTerrDocs: array from /api/territories — overrides hardcoded TERRITORY_DATA ambienceMod
function computeVitateTally(char, sub, liveTerrDocs = []) {
  if (!char) return null;

  // Herd: effective dots (cp + free + free_mci + xp + SSJ/Flock bonuses)
  const herd = domMeritContrib(char, 'Herd');

  // Oath of Fealty: covenant status dots (only if character has the pact)
  const hasOoF = (char.powers || []).some(p => p.category === 'pact' && p.name === 'Oath of Fealty');
  const oath_of_fealty = hasOoF ? effectiveInvictusStatus(char) : 0;

  // Ghoul retainers: count Retainer merits with 'ghoul' qualifier
  const ghouls = (char.merits || []).filter(m =>
    m.name === 'Retainer' && (m.area || m.qualifier || '').toLowerCase().includes('ghoul')
  ).length;

  // Merge live territory docs over hardcoded defaults — live values take precedence.
  // Carry _id forward from liveTerrDocs so the grid-key lookup below can match
  // by ObjectId (post-migration shape) as well as slug (pre-migration fallback).
  const effectiveTerrs = TERRITORY_DATA.map(t => {
    const live = liveTerrDocs.find(d => d.slug === t.slug);
    return live
      ? { ...t, _id: String(live._id), ambience: live.ambience ?? t.ambience, ambienceMod: live.ambienceMod ?? t.ambienceMod }
      : t;
  });

  // Ambience: best territory among player-declared feeding territories.
  // 2026-06-20 hotfix: grid keys are ObjectId strings post-territory-FK migration
  // (server/scripts/archive/migrate-territory-fk.js). Match against effectiveTerrs._id
  // first, fall back to slug for any pre-migration or sentinel keys.
  let ambience = -4; // Barrens default
  let ambience_territory = 'Barrens';
  if (sub?.responses?.feeding_territories) {
    try {
      const grid = JSON.parse(sub.responses.feeding_territories);
      const ACTIVE_FEED_STATUSES = new Set(['feeding_rights', 'poaching', 'resident', 'poacher', 'poach']);
      for (const [tid, status] of Object.entries(grid)) {
        if (!ACTIVE_FEED_STATUSES.has(status)) continue;
        const td = effectiveTerrs.find(t =>
          (t._id && t._id === tid) || String(t.slug) === tid
        );
        if (td?.ambienceMod != null && td.ambienceMod > ambience) {
          ambience = td.ambienceMod;
          ambience_territory = td.name;
        }
      }
    } catch { /* ignore */ }
  }

  // Rite cost and manual adjustment from ST-saved feeding_review
  const rev = sub?.feeding_review || {};
  const rite_cost = rev.vitae_rite_cost  ?? 0;
  const manual    = rev.vitae_mod_manual ?? 0;

  const autoSum   = herd + oath_of_fealty + ambience - ghouls;
  const total_bonus = Math.max(0, autoSum + manual - rite_cost);

  return { herd, ambience, ambience_territory, oath_of_fealty, ghouls, rite_cost, manual, total_bonus };
}

// ── Render vitae breakdown card ───────────────────────────────────────────────
function renderVitaeTallyCard(tally, vessels = null) {
  if (!tally) return '';
  let h = '<div class="fvt-card">';
  h += '<div class="fvt-title">Vitae Sources</div>';
  if (vessels !== null) h += `<div class="fvt-row"><span class="fvt-label">Vessels (from roll)</span><span class="fvt-val">${vessels}</span></div>`;
  if (tally.herd)         h += `<div class="fvt-row fvt-pos"><span class="fvt-label">Herd</span><span class="fvt-val">+${tally.herd}</span></div>`;
  if (tally.oath_of_fealty) h += `<div class="fvt-row fvt-pos"><span class="fvt-label">Oath of Fealty</span><span class="fvt-val">+${tally.oath_of_fealty}</span></div>`;
  if (tally.ambience != null && tally.ambience !== 0) {
    const lbl = tally.ambience_territory ? `Ambience (${tally.ambience_territory})` : 'Ambience';
    const cls = tally.ambience > 0 ? ' fvt-pos' : ' fvt-neg';
    const sign = tally.ambience > 0 ? '+' : '';
    h += `<div class="fvt-row${cls}"><span class="fvt-label">${esc(lbl)}</span><span class="fvt-val">${sign}${tally.ambience}</span></div>`;
  }
  if (tally.ghouls)    h += `<div class="fvt-row fvt-neg"><span class="fvt-label">Ghoul retainers</span><span class="fvt-val">\u2212${tally.ghouls}</span></div>`;
  if (tally.rite_cost) h += `<div class="fvt-row fvt-neg"><span class="fvt-label">Rite costs</span><span class="fvt-val">\u2212${tally.rite_cost}</span></div>`;
  if (tally.manual)    h += `<div class="fvt-row${tally.manual > 0 ? ' fvt-pos' : ' fvt-neg'}"><span class="fvt-label">Adjustment</span><span class="fvt-val">${tally.manual > 0 ? '+' : ''}${tally.manual}</span></div>`;
  h += '<div class="fvt-divider"></div>';
  h += `<div class="fvt-row fvt-total"><span class="fvt-label">Bonus vitae</span><span class="fvt-val">+${tally.total_bonus}</span></div>`;
  h += '</div>';
  return h;
}

function fvcConseqText(v) {
  if (v <= 2) return 'Safe';
  if (v === 3) return 'Drained';
  if (v <= 5) return 'Serious injury';
  if (v === 6) return 'Critical';
  return 'Fatal';
}

function fvcConseqClass(v) {
  if (v <= 2) return 'fvc-safe';
  if (v === 3) return 'fvc-drained';
  if (v <= 5) return 'fvc-serious';
  return 'fvc-critical';
}

/**
 * The ST's "Confirm Feed" panel.
 *
 * Extracted verbatim from render()'s `rolled` branch by Story 12.2 so the new
 * form-sourced state reuses the SAME panel, and the same single tracker_state
 * write, rather than growing a second one beside it.
 *
 * `stDefault`   the vitae stepper's starting value.
 * `aggHealed`   Aggravated boxes the downtime form recorded this feed as
 *               healing. Always 0 on the existing TM-Game-sourced path, which
 *               therefore renders exactly as it did before this story.
 * `aggApplied`  the tracker_state marker already names this cycle, so the
 *               healing has been applied once and must not be offered again.
 * `formSourced` this is a TM Story roll, so no vitae tally was computed for it.
 */
function renderStConfirmPanel({ stDefault, aggHealed = 0, aggApplied = false, formSourced = false }) {
  const charId = String(currentChar._id);
  const confirmed = _stConfirmed[charId];
  const vitaeMax = calcVitaeMax(currentChar);
  const infMax   = calcTotalInfluence(currentChar);
  let h = `<div class="feed-st-confirm">`;
  if (confirmed) {
    const vitaeStr = confirmed.vitaeMax != null
      ? `Vitae ${confirmed.vitae}/${confirmed.vitaeMax}`
      : `Vitae \u2192 ${confirmed.vitae}`;
    const infStr = confirmed.infAfter != null && confirmed.infMax != null
      ? `Inf ${confirmed.infAfter}/${confirmed.infMax}`
      : confirmed.infSpent > 0 ? `Inf \u2212${confirmed.infSpent}` : null;
    let rec = vitaeStr;
    if (infStr) rec += ` \u2002|\u2002 ${infStr}`;
    if (confirmed.aggHealed) rec += ` \u2002|\u2002 Agg \u2212${confirmed.aggHealed}`;
    h += `<div class="feed-confirmed-record">\u2713 Feed confirmed \u2014 ${rec}</div>`;
    h += `<button class="feed-reconfirm-btn" id="feed-reconfirm-btn">Edit</button>`;
  } else {
    // Vitae row
    h += `<div class="feed-st-row">`;
    h += `<div class="feed-st-row-lbl">Vitae Gained</div>`;
    h += `<div class="feed-st-row-ctrl">`;
    h += `<button class="feed-adj" id="feed-confirm-adj-down">\u2212</button>`;
    h += `<span class="feed-confirm-val" id="feed-confirm-n" data-vit-max="${vitaeMax}">${stDefault}</span>`;
    h += `<button class="feed-adj" id="feed-confirm-adj-up">+</button>`;
    h += `</div>`;
    h += `<div class="feed-st-row-max">/ ${vitaeMax}</div>`;
    h += `</div>`;
    // Influence row
    h += `<div class="feed-st-row">`;
    h += `<div class="feed-st-row-lbl">Influence Remaining</div>`;
    h += `<div class="feed-st-row-ctrl">`;
    h += `<button class="feed-adj" id="feed-inf-adj-down">\u2212</button>`;
    const _curInf = trackerRead(String(currentChar._id))?.inf ?? infMax;
    h += `<span class="feed-inf-val" id="feed-inf-spent" data-inf-max="${infMax}">${_curInf}</span>`;
    h += `<button class="feed-adj" id="feed-inf-adj-up">+</button>`;
    h += `</div>`;
    h += `<div class="feed-st-row-max">/ ${infMax}</div>`;
    h += `</div>`;
    // Aggravated row (Story 12.2, AC 3/AC 4). Read-only by design: the figure
    // is the player's own committed declaration from the downtime form, and
    // this app cannot correct a TM-Story-sourced roll (see the ST override
    // note). #feed-agg-n is also the confirm handler's ONLY source for the
    // amount, so an already-applied cycle cannot be applied twice: the element
    // simply is not rendered.
    if (aggHealed > 0) {
      if (aggApplied) {
        h += `<div class="feed-st-row" id="feed-agg-applied">`;
        h += `<div class="feed-st-row-lbl">Aggravated Healed</div>`;
        h += `<div class="feed-st-row-ctrl">\u2713 ${aggHealed} already applied this cycle</div>`;
        h += `</div>`;
      } else {
        h += `<div class="feed-st-row" id="feed-agg-row">`;
        h += `<div class="feed-st-row-lbl">Aggravated Healed</div>`;
        h += `<div class="feed-st-row-ctrl">`;
        h += `<span class="feed-confirm-val" id="feed-agg-n" data-agg-healed="${aggHealed}">\u2212${aggHealed}</span>`;
        h += `</div>`;
        h += `<div class="feed-st-row-max">from the downtime form</div>`;
        h += `</div>`;
      }
    }
    if (formSourced) {
      h += `<p class="feeding-state-detail">Bonus vitae (Herd, Oath of Fealty, ambience) is not tallied for a downtime-form roll yet: add it with the stepper.</p>`;
    }
    h += `<button class="feed-confirm-btn" id="feed-confirm-btn">Confirm Feed</button>`;
  }
  h += `</div>`;
  return h;
}

/**
 * Story 12.2: the read-only view of a roll the player already made in TM
 * Story's downtime form.
 *
 * Renders nothing the player can act on. There is deliberately no roll button,
 * no vessel <select> and no allocation confirm here: the roll and the vessel
 * allocation are both already committed, and re-asking for either is the exact
 * double-work this story exists to remove. The dice/success markup and the
 * vessel-card classes are the existing `rolled` state's own (Story 12.4
 * restyles the whole tab, so nothing new is invented here).
 */
function renderFormSourcedRoll(isST) {
  const f = storyFeeding;
  const rr = f.rollResult || {};
  const dice = Array.isArray(rr.dice) ? rr.dice : [];
  const successes = Number.isInteger(rr.successes) ? rr.successes : 0;
  const vessels = Array.isArray(f.vesselVitae) ? f.vesselVitae : [];
  const vesselTotal = vessels.reduce((a, b) => a + (Number(b) || 0), 0);

  let h = '<div class="feeding-result">';
  h += '<p class="feeding-state-detail">Rolled in your downtime form. This result is final.</p>';

  if (f.method) {
    h += `<p class="feeding-method-label">Method: <strong>${esc(f.method)}</strong>`;
    if (rr.rote)      h += ' <span class="feeding-rote-badge">Rote</span>';
    if (rr.again === 9) h += ' <span class="feeding-again-badge">9-Again</span>';
    if (rr.again === 8) h += ' <span class="feeding-again-badge">8-Again</span>';
    if (rr.chance)    h += ' <span class="feeding-again-badge">Chance die</span>';
    h += '</p>';
  }
  if (Number.isInteger(rr.pool)) {
    h += '<div class="feeding-pool-display">';
    h += `<span class="feeding-pool-total">${rr.pool} dice</span>`;
    h += '</div>';
  }

  h += `<div class="feeding-suc">${successes}</div>`;
  h += `<div class="feeding-suc-label">success${successes !== 1 ? 'es' : ''}`;
  if (rr.exceptional) h += ' (exceptional)';
  h += '</div>';

  h += '<div class="feeding-dice-row">';
  for (const d of dice) {
    let cls = 'feed-die';
    if (d >= 8) cls += ' fd-s';
    if (d === 1) cls += ' fd-1';
    h += `<span class="${cls}">${d}</span>`;
  }
  h += '</div>';

  if (rr.dramatic_failure) {
    h += '<div class="feeding-dramatic">Dramatic failure \u2014 see your Storyteller at game before feeding.</div>';
  }

  if (!vessels.length) {
    h += '<p class="feeding-no-vessels">No vessels recorded this hunt.</p>';
  } else if (f.bloodType === 'Animal') {
    // An Animal feed records ONE pooled vitae total, not per-vessel harm (TM
    // Story's own normaliseVesselVitae, public/js/downtime-form/content-shape.js)
    // - the 0-7 harm scale fvcConseqText encodes does not apply to it, so no
    // consequence label is rendered for that shape.
    h += '<div class="feeding-vessels-grid">';
    h += '<div class="feeding-vessel-card">';
    h += '<span class="fvc-label">Animal vitae</span>';
    h += `<span class="fvc-val">${vesselTotal} vitae</span>`;
    h += '</div></div>';
  } else {
    h += '<div class="feeding-vessels-grid">';
    vessels.forEach((v, i) => {
      h += '<div class="feeding-vessel-card">';
      h += `<span class="fvc-label">Vessel ${i + 1}</span>`;
      h += `<span class="fvc-val">${v} vitae</span>`;
      h += `<span class="fvc-consequence ${fvcConseqClass(v)}">${fvcConseqText(v)}</span>`;
      h += '</div>';
    });
    h += '</div>';
  }
  if (vessels.length) {
    h += `<div class="fvc-total">Total Vitae: <strong>${vesselTotal}</strong></div>`;
    h += '<div class="fvc-alloc-badge">\u2713 Allocation recorded in the downtime form</div>';
  }
  h += '</div>';

  if (isST) {
    const aggHealed = Number.isInteger(f.aggHealed) && f.aggHealed > 0 ? f.aggHealed : 0;
    const aggApplied = !!activeCycleId
      && String(trackerDoc?.[AGG_HEALED_MARKER] || '') === activeCycleId;
    h += renderStConfirmPanel({
      stDefault: vesselTotal,
      aggHealed,
      aggApplied,
      formSourced: true,
    });
  }
  return h;
}

function render() {
  if (!container) return;
  const isST = isSTRole();
  let h = '<div class="feeding-wrap">';
  h += '<h3 class="feeding-title">Feeding: The Hunt</h3>';

  // ── LOADING ──
  if (feedingState === 'loading') {
    h += '<p class="placeholder-msg">Loading feeding data...</p>';
  }

  // ── READY (from downtime declaration) ──
  if (feedingState === 'ready' && declaredMethod) {
    h += '<div class="feeding-ready">';
    h += `<p class="feeding-method-label">Method: <strong>${esc(declaredMethod.name)}</strong>`;
    if (stRote)    h += ' <span class="feeding-rote-badge">Rote</span>';
    if (stAgain === 9) h += ' <span class="feeding-again-badge">9-Again</span>';
    if (stAgain === 8) h += ' <span class="feeding-again-badge">8-Again</span>';
    h += '</p>';
    h += `<p class="feeding-method-desc">${esc(declaredMethod.desc)}</p>`;
    h += `<div class="feeding-pool-display">`;
    h += `<span class="feeding-pool-breakdown">${esc(poolBreakdown)}</span>`;
    h += `<span class="feeding-pool-total">${poolTotal} dice</span>`;
    h += '</div>';
    h += renderFeedingSummary();
    h += renderVitaeTallyCard(vitateTally);
    h += renderStRollResult();
    if (!stRollResult) {
      h += '<p class="feeding-warning">You only get one roll. Once you roll, you are committed to the result.</p>';
      h += `<button id="feeding-roll-btn" class="feeding-roll-btn">Roll Feeding (${poolTotal} dice)</button>`;
    }
    h += '</div>';
  }

  // ── NO SUBMISSION (generic picker) ──
  if (feedingState === 'no_submission') {
    h += '<div class="feeding-no-sub">';
    h += '<p class="feeding-state-detail">No downtime feeding declaration found. Select a generic method below.</p>';
    h += '<div class="dt-feed-methods">';
    for (const m of FEED_METHODS) {
      if (m.id === 'other') continue; // no custom without downtime
      const sel = selectedMethodId === m.id ? ' dt-feed-sel' : '';
      h += `<button type="button" class="dt-feed-card${sel}" data-feed-method="${m.id}">`;
      h += `<div class="dt-feed-card-name">${esc(m.name)}</div>`;
      h += `<div class="dt-feed-card-desc">${esc(m.desc)}</div>`;
      h += '</button>';
    }
    h += '</div>';

    if (selectedMethodId) {
      const m = FEED_METHODS.find(fm => fm.id === selectedMethodId);
      if (m) {
        buildPool(m, selectedDisc, selectedSpec);

        // Discipline selector — show all template disciplines; template is a preset, not a gate
        if (m.discs.length) {
          h += '<div class="feeding-disc-row">';
          h += '<label>Discipline:</label>';
          h += '<select class="qf-select" id="feed-gen-disc">';
          h += '<option value="">None</option>';
          for (const d of m.discs) {
            const dv = currentChar.disciplines?.[d]?.dots ?? 0;
            const sel = selectedDisc === d ? ' selected' : '';
            h += `<option value="${esc(d)}"${sel}>${esc(d)} (${dv})</option>`;
          }
          h += '</select></div>';
        }

        h += `<div class="feeding-pool-display">`;
        h += `<span class="feeding-pool-breakdown">${esc(poolBreakdown)}</span>`;
        h += `<span class="feeding-pool-total">${poolTotal} dice</span>`;
        h += '</div>';
        h += '<p class="feeding-warning">You only get one roll. Once you roll, you are committed to the result.</p>';
        h += `<button id="feeding-roll-btn" class="feeding-roll-btn">Roll Feeding (${poolTotal} dice)</button>`;
      }
    }

    // "See Storytellers" defer path — always available until roll or defer chosen
    h += '<div class="feeding-defer-row">';
    h += '<span class="feeding-defer-or">or</span>';
    h += '<button id="feeding-defer-btn" class="feeding-defer-btn">See Storytellers at Start of Game</button>';
    h += '</div>';

    h += '</div>';
  }

  // ── DEFERRED ──
  if (feedingState === 'deferred') {
    h += '<div class="feeding-deferred-msg">See your Storytellers at the start of game.</div>';
  }

  // ── ROLLED ──
  if (feedingState === 'rolled' && rollResult) {
    const { cols, successes, vessels, safeVitae, methodName, dramaticFailure, successBreakdown } = rollResult;

    // Show ST-confirmed result if published
    if (publishedFeedingText) {
      h += `<div class="feeding-confirmed">`;
      h += `<div class="feeding-confirmed-head">&#x2713; Confirmed Result</div>`;
      h += `<p class="feeding-confirmed-body">${esc(publishedFeedingText)}</p>`;
      h += `</div>`;
    }

    // Player Feedback (player_facing_note from feeding_review — read directly,
    // as it is not embedded in the ## Feeding section of published_outcome)
    const feedingNote = currentSub?.feeding_review?.player_facing_note?.trim();
    if (feedingNote) {
      h += `<div class="proj-card-feedback"><span class="proj-card-feedback-label">ST Note</span>${esc(feedingNote)}</div>`;
    }

    h += '<div class="feeding-result">';
    if (methodName) h += `<p class="feeding-method-label">Method: <strong>${esc(methodName)}</strong></p>`;
    h += renderFeedingSummary();
    h += `<div class="feeding-suc">${successes}</div>`;
    h += `<div class="feeding-suc-label">success${successes !== 1 ? 'es' : ''}</div>`;
    // dtlt.1: only rendered when a bonus-success rule actually fired. Rolls
    // persisted before this story have no successBreakdown and are unchanged.
    if (successBreakdown) {
      h += `<span class="feeding-pool-breakdown">${esc(successBreakdown)}</span>`;
    }

    h += '<div class="feeding-dice-row">';
    for (const col of cols) {
      for (const d of [col.r, ...col.ch]) {
        let cls = 'feed-die';
        if (d.s) cls += ' fd-s';
        if (d.v === 1) cls += ' fd-1';
        h += `<span class="${cls}">${d.v}</span>`;
      }
    }
    h += '</div>';

    // ── Vitae breakdown card ──
    h += renderVitaeTallyCard(vitateTally, vessels);

    if (dramaticFailure) {
      h += '<div class="feeding-dramatic">Dramatic failure \u2014 see your Storyteller at game before feeding.</div>';
    } else if (vessels === 0) {
      h += '<p class="feeding-no-vessels">No vessels secured this hunt.</p>';
    } else {
      const bonusVitae = vitateTally?.total_bonus ?? 0;
      const allocated = vitaeAllocation && vitaeAllocation.length === vessels;
      h += `<div class="feeding-vessels-grid" id="feeding-vessels-grid">`;
      for (let i = 0; i < vessels; i++) {
        h += `<div class="feeding-vessel-card" data-vessel-idx="${i}">`;
        h += `<span class="fvc-label">Vessel ${i + 1}</span>`;
        if (allocated) {
          const sv = vitaeAllocation[i];
          h += `<span class="fvc-val">${sv} vitae</span>`;
          h += `<span class="fvc-consequence ${fvcConseqClass(sv)}">${fvcConseqText(sv)}</span>`;
        } else {
          h += `<select class="fvc-select" id="fvc-sel-${i}" data-vessel-idx="${i}">`;
          h += '<option value="">\u2014</option>';
          h += '<option value="1">1 vitae \u2014 Safe</option>';
          h += '<option value="2">2 vitae \u2014 Safe</option>';
          h += '<option value="3">3 vitae \u2014 Drained (medical care needed)</option>';
          h += '<option value="4">4 vitae \u2014 Serious injury</option>';
          h += '<option value="5">5 vitae \u2014 Serious injury</option>';
          h += '<option value="6">6 vitae \u2014 Critical (near death)</option>';
          h += '<option value="7">7 vitae \u2014 Fatal</option>';
          h += '</select>';
          h += `<span class="fvc-consequence" id="fvc-con-${i}"></span>`;
        }
        h += '</div>';
      }
      h += '</div>';
      if (allocated) {
        const vesselTotal = vitaeAllocation.reduce((a, b) => a + b, 0);
        const grandTotal  = vesselTotal + (vitateTally?.total_bonus ?? 0);
        if (vitateTally?.total_bonus) {
          h += `<div class="fvc-total">Vessel vitae: <strong>${vesselTotal}</strong> + Bonus: <strong>+${vitateTally.total_bonus}</strong> = <strong>${grandTotal}</strong> total</div>`;
        } else {
          h += `<div class="fvc-total">Total Vitae: <strong>${vesselTotal}</strong></div>`;
        }
        h += '<div class="fvc-alloc-badge">\u2713 Allocation recorded</div>';
      } else {
        if (bonusVitae) {
          h += `<div class="fvc-total">Vessel vitae: <span id="fvc-total-val">0</span> + Bonus: <strong>+${bonusVitae}</strong> = <span id="fvc-grand-val">${bonusVitae}</span> total</div>`;
        } else {
          h += `<div class="fvc-total">Total Vitae: <span id="fvc-total-val">0</span></div>`;
        }
        h += `<p class="feeding-overfeed-warn">Draining beyond safe vitae (${safeVitae}) risks a Humanity check.</p>`;
        h += '<button id="fvc-confirm" class="qf-btn qf-btn-submit" disabled>Confirm Allocation</button>';
      }
    }

    h += '</div>';

    // ── ST CONFIRM PANEL ──
    if (isST) {
      const stVesselTotal = vitaeAllocation
        ? vitaeAllocation.reduce((a, b) => a + b, 0)
        : safeVitae;
      const stBonus = vitateTally?.total_bonus ?? 0;
      h += renderStConfirmPanel({ stDefault: stVesselTotal + stBonus });
    }
  }

  // ── ROLLED IN THE DOWNTIME FORM (TM Story, Epic 12 Story 12.2) ──
  if (feedingState === 'rolled-from-form' && storyFeeding) {
    h += renderFormSourcedRoll(isST);
  }

  // ── ST OVERRIDE PANEL ──
  if (isST && feedingState !== 'loading') {
    if (feedingState === 'deferred') {
      h += '<div class="feeding-st-override">';
      h += '<span class="feeding-st-label">ST Override</span>';
      h += '<button id="feeding-release-btn" class="feeding-roll-btn">Release Roll (ST)</button>';
      h += '</div>';
    } else if (feedingState === 'rolled') {
      h += '<div class="feeding-st-override">';
      h += '<span class="feeding-st-label">ST Override</span>';
      h += '<button id="feeding-reroll-btn" class="feeding-roll-btn">Reset Roll (ST)</button>';
      h += '</div>';
    } else if (feedingState === 'rolled-from-form') {
      // Story 12.2, AC 2: deliberately NOT a Reset Roll button. Every existing
      // ST override on this tab writes to tm_game.downtime_submissions, and a
      // form-sourced roll does not live there - TM Game holds no write path to
      // tm_story at all, so a button here could only no-op or throw.
      h += '<div class="feeding-st-override">';
      h += '<span class="feeding-st-label">ST Override</span>';
      h += '<p class="feeding-state-detail">This roll was made in the downtime form and cannot be reset from here. Corrections happen in the TM Story downtime form itself, or through the downtime-processing scripts.</p>';
      h += '</div>';
    }
  }

  h += '</div>';
  container.innerHTML = h;
  wireEvents();
}

function wireEvents() {
  if (!container) return;

  // Generic method selection
  container.querySelectorAll('[data-feed-method]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedMethodId = btn.dataset.feedMethod;
      selectedDisc = '';
      selectedSpec = '';
      render();
    });
  });

  // Generic disc selector
  container.querySelector('#feed-gen-disc')?.addEventListener('change', e => {
    selectedDisc = e.target.value;
    render();
  });

  // Vessel allocation selectors
  container.querySelectorAll('.fvc-select').forEach(sel => {
    sel.addEventListener('change', updateVesselUI);
  });

  // Confirm allocation
  container.querySelector('#fvc-confirm')?.addEventListener('click', doConfirmAllocation);

  // Roll button
  container.querySelector('#feeding-roll-btn')?.addEventListener('click', doFeedingRoll);

  // ST re-roll
  container.querySelector('#feeding-reroll-btn')?.addEventListener('click', async () => {
    rollResult = null;
    vitaeAllocation = null;
    if (responseSubId) {
      try {
        await apiPut(`/api/downtime_submissions/${responseSubId}`, {
          feeding_roll_player: null,
          feeding_vitae_allocation: null,
          feeding_deferred: null,
        });
      } catch { /* ignore */ }
    }
    if (declaredMethod) {
      feedingState = 'ready';
      buildPool(declaredMethod, declaredDisc, declaredSpec);
    } else {
      feedingState = 'no_submission';
    }
    render();
  });

  // ST release (deferred → ready)
  container.querySelector('#feeding-release-btn')?.addEventListener('click', async () => {
    if (!responseSubId) return;
    try {
      await apiPut(`/api/downtime_submissions/${responseSubId}`, {
        feeding_deferred: null,
        feeding_roll_player: null,
        feeding_vitae_allocation: null,
      });
      if (declaredMethod) {
        feedingState = 'ready';
        buildPool(declaredMethod, declaredDisc, declaredSpec);
      } else {
        feedingState = 'no_submission';
      }
      render();
    } catch {
      alert('Could not release — please try again.');
    }
  });

  // ST confirm feed — vitae stepper
  container.querySelector('#feed-confirm-adj-down')?.addEventListener('click', () => {
    const el = container.querySelector('#feed-confirm-n');
    if (el) el.textContent = Math.max(0, (parseInt(el.textContent) || 0) - 1);
  });
  container.querySelector('#feed-confirm-adj-up')?.addEventListener('click', () => {
    const el = container.querySelector('#feed-confirm-n');
    if (!el) return;
    const max = parseInt(el.dataset.vitMax) || 0;
    el.textContent = String(Math.min(max, (parseInt(el.textContent) || 0) + 1));
  });
  // ST confirm feed — influence stepper
  container.querySelector('#feed-inf-adj-down')?.addEventListener('click', () => {
    const el = container.querySelector('#feed-inf-spent');
    if (el) el.textContent = String(Math.max(0, (parseInt(el.textContent) || 0) - 1));
  });
  container.querySelector('#feed-inf-adj-up')?.addEventListener('click', () => {
    const el = container.querySelector('#feed-inf-spent');
    if (!el) return;
    const max = parseInt(el.dataset.infMax) || 0;
    el.textContent = String(Math.min(max, (parseInt(el.textContent) || 0) + 1));
  });
  container.querySelector('#feed-confirm-btn')?.addEventListener('click', async () => {
    if (!currentChar) return;
    const charId = String(currentChar._id);
    const n = parseInt(container.querySelector('#feed-confirm-n')?.textContent) || 0;

    const btn = container.querySelector('#feed-confirm-btn');
    if (btn) { btn.textContent = 'Saving\u2026'; btn.disabled = true; }

    const infEl = container.querySelector('#feed-inf-spent');
    const vitaeMax = calcVitaeMax(currentChar);
    const infMax   = calcTotalInfluence(currentChar);
    // Stepper value is the NEW remaining influence (starts at max, ticked down)
    const infAfter = infEl ? Math.max(0, parseInt(infEl.textContent) || 0) : infMax;
    const infSpent = infMax - infAfter;

    // Story 12.2 (AC 3/AC 4): a downtime-form roll's own aggHealed rides THIS
    // write, not a second one. #feed-agg-n is rendered only when there is a
    // real, not-yet-applied figure for this cycle (renderStConfirmPanel), so
    // reading the amount off the DOM is also the idempotency guard: an
    // already-applied cycle, and every TM-Game-sourced roll, has no element to
    // read and takes the untouched vitae+influence path below.
    const aggEl = container.querySelector('#feed-agg-n');
    const aggHealed = aggEl ? Math.max(0, parseInt(aggEl.dataset.aggHealed, 10) || 0) : 0;
    const body = { vitae: n, influence: infAfter };
    let newAgg = null;
    if (aggHealed > 0 && activeCycleId) {
      // Cache first, matching the influence row's own precedence just above:
      // tracker.js's cache tracks manual Tracker-tab adjustments and WS frames
      // made since this tab last read the server, and falls back to the raw
      // document this render pass fetched.
      const cached = trackerReadRaw(charId);
      const curAgg = (cached && cached.aggravated != null)
        ? cached.aggravated
        : (trackerDoc && trackerDoc.aggravated != null ? trackerDoc.aggravated : 0);
      newAgg = Math.max(0, curAgg - aggHealed);
      body.aggravated = newAgg;
      body[AGG_HEALED_MARKER] = activeCycleId;
    }

    // Write vitae and influence to API — single source of truth for tracker state
    try {
      await apiPut('/api/tracker_state/' + charId, body);
      // Keep tracker.js in-memory cache in sync so the tracker card re-renders correctly
      const _raw = trackerReadRaw(charId);
      if (_raw) _raw.inf = infAfter;
      if (newAgg != null) {
        if (_raw) _raw.aggravated = newAgg;
        // Same for this tab's own copy, so the re-render below sees the marker
        // and shows "already applied" rather than re-offering the healing.
        trackerDoc = { ...(trackerDoc || {}), aggravated: newAgg, [AGG_HEALED_MARKER]: activeCycleId };
      }
      // vitae_confirmed used by trackerAdj to clear confirmed marker on manual ST override
      try {
        const key = 'tm_tracker_local_' + charId;
        const loc = JSON.parse(localStorage.getItem(key) || '{}');
        loc.vitae_confirmed = n;
        localStorage.setItem(key, JSON.stringify(loc));
      } catch { /* ignore */ }
      const record = { vitae: n, vitaeMax, infSpent, infAfter, infMax };
      if (aggHealed > 0) record.aggHealed = aggHealed;
      _stConfirmed[charId] = record;
      render();
    } catch (err) {
      console.error('Tracker feed confirm failed:', err);
      if (btn) {
        btn.textContent = 'Save failed \u2014 retry';
        btn.classList.add('is-error');
        btn.disabled = false;
      }
    }
  });

  container.querySelector('#feed-reconfirm-btn')?.addEventListener('click', () => {
    if (!currentChar) return;
    delete _stConfirmed[String(currentChar._id)];
    render();
  });

  // Defer button
  container.querySelector('#feeding-defer-btn')?.addEventListener('click', async () => {
    if (!responseSubId) return;
    try {
      await apiPut(`/api/downtime_submissions/${responseSubId}`, { feeding_deferred: true });
      feedingState = 'deferred';
      render();
    } catch {
      alert('Could not save — please try again.');
    }
  });
}

function updateVesselUI() {
  const sels = Array.from(container.querySelectorAll('.fvc-select'));
  let total = 0, allFilled = true;
  sels.forEach(sel => {
    const idx = sel.dataset.vesselIdx;
    const conEl = container.querySelector(`#fvc-con-${idx}`);
    if (sel.value) {
      const v = parseInt(sel.value, 10);
      total += v;
      if (conEl) { conEl.textContent = fvcConseqText(v); conEl.className = `fvc-consequence ${fvcConseqClass(v)}`; }
    } else {
      allFilled = false;
      if (conEl) { conEl.textContent = ''; conEl.className = 'fvc-consequence'; }
    }
  });
  const totalEl = container.querySelector('#fvc-total-val');
  if (totalEl) totalEl.textContent = total;
  const grandEl = container.querySelector('#fvc-grand-val');
  if (grandEl) grandEl.textContent = total + (vitateTally?.total_bonus ?? 0);
  const confirmBtn = container.querySelector('#fvc-confirm');
  if (confirmBtn) confirmBtn.disabled = !allFilled || sels.length === 0;
}

async function doConfirmAllocation() {
  const sels = Array.from(container.querySelectorAll('.fvc-select'));
  const alloc = sels.map(s => parseInt(s.value, 10));
  if (alloc.some(v => isNaN(v))) return;

  if (responseSubId) {
    try {
      await apiPut(`/api/downtime_submissions/${responseSubId}`, { feeding_vitae_allocation: alloc });
    } catch {
      return; // leave selectors interactive on failure
    }
  }
  vitaeAllocation = alloc;
  render();
}

function rollDiceRote(n, again = 10) {
  const r1 = rollDice(n, again), r2 = rollDice(n, again);
  return cntSuc(r1) >= cntSuc(r2) ? r1 : r2;
}

async function doFeedingRoll() {
  if (poolTotal <= 0) return;

  const cols = stRote ? rollDiceRote(poolTotal, stAgain) : rollDice(poolTotal, stAgain);
  const method = declaredMethod || FEED_METHODS.find(m => m.id === selectedMethodId) || null;
  // dtlt.1: the rote comparison inside rollDiceRote stays rolled-only (which
  // pool's dice came up better); the bonus is added once, here, to the winner.
  // Review fix (Codex, external, dtlt.1): only resolve real trait names when
  // poolTotal was actually built from this method's own attrs/skills. On an
  // ST-confirmed pool, declaredMethod may be a stale/different method than
  // what the ST actually confirmed (feeding_roll.params carries no trait
  // names at all; a parsed pool_validated size doesn't either) — passing it
  // anyway could fire (or miss) a bonus-success rule on the wrong attribute.
  // An empty context matches no roll_attr/roll_skill predicate, which is the
  // safe default: no bonus, same as before this story, rather than a wrong one.
  const traits = poolTraitsTrusted
    ? bestTraitsFor(currentChar, method)
    : { attr: '', skill: '' };
  const outcome = resolveSuccesses(cols, currentChar, {
    attr: traits.attr,
    skill: traits.skill,
    disc: poolTraitsTrusted ? (declaredDisc || selectedDisc || '') : '',
    spec: poolTraitsTrusted ? (declaredSpec || selectedSpec || '') : '',
  });
  const successes = outcome.total;
  const methodName = method?.name || 'Unknown';
  const usedDisc = !!(declaredDisc || selectedDisc);

  rollResult = {
    cols,
    successes,
    // Kept apart so a future rule that must ignore bonus successes (Merits
    // Errata:693) can read the rolled count off a persisted roll.
    rolledSuccesses: outcome.rolled,
    bonusSuccesses: outcome.bonus,
    vessels: successes,
    safeVitae: successes * 2,
    methodName,
    pool: poolTotal,
    again: stAgain,
    breakdown: poolBreakdown,
    successBreakdown: formatSuccessBreakdown(outcome),
    rolledAt: new Date().toISOString(),
    dramaticFailure: usedDisc && outcome.rolled === 0,
  };

  feedingState = 'rolled';

  // Persist to DB (sole lock source — no localStorage)
  if (responseSubId) {
    try {
      await apiPut(`/api/downtime_submissions/${responseSubId}`, { feeding_roll_player: rollResult });
    } catch {
      alert('Roll saved locally but could not be recorded to the server. Please refresh and try again, or contact your Storyteller.');
    }
  }

  render();
}

// ── ST: Influence spend pre-fill ──
async function loadInfluenceSpend(charId) {
  const el = container?.querySelector('#feed-inf-spent');
  if (!el) return;
  try {
    const subs = await apiGet('/api/downtime_submissions');
    const latest = subs
      .filter(s => String(s.character_id) === charId && s.responses?.influence_spend)
      .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1))[0];
    if (!latest) { el.textContent = '0'; return; }
    const spendObj = JSON.parse(latest.responses.influence_spend || '{}');
    const total = Object.values(spendObj).reduce((sum, v) => sum + Math.abs(Number(v) || 0), 0);
    el.textContent = String(total);
  } catch {
    el.textContent = '0';
  }
}
