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
 *
 * Story 12.3 adds one thing that belongs to no state: a standing Influence +
 * Willpower tally card, rendered in every state except loading.
 */

import { apiGet, apiPut, apiRaw } from '../data/api.js';
import { fetchStoryFeeding } from '../data/story-feeding.js';
import { getFeedingCycle } from '../downtime/db.js';
import { esc, displayName, hasAoE } from '../data/helpers.js';
import { getAttrEffective as getAttrVal, skDots, skTotal, skSpecStr, calcVitaeMax, calcWillpowerMax } from '../data/accessors.js';
import { FEED_METHODS, TERRITORY_DATA } from './downtime-data.js';
import { SKILLS_MENTAL } from '../data/constants.js';
import { isSTRole } from '../auth/discord.js';
import { domMeritContrib, effectiveInvictusStatus, calcTotalInfluence } from '../editor/domain.js';
// Review fix (Codex, external, 12.2 High + 12.3 High): `trackerRead()` is no
// longer read for either the confirm panel or the tally card. It seeds and
// returns DEFAULTS for any character nothing has loaded yet, which is
// indistinguishable from real persisted state - it showed a character on
// Willpower 1/5 as 5/5, and computed an aggravated write from `aggravated: 0`
// when the character really carried 3 boxes. Both now read the live document
// (`readTrackerState` below). `trackerReadRaw` stays, but only to keep the
// tracker card's in-memory cache in step AFTER a successful write.
import { trackerReadRaw } from '../game/tracker.js';
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
// Epic 12 (Story 12.3): the SAME fetch's fourth key, `territory_influence`
// (`content.territory_influence` verbatim, or null). Deliberately captured
// outside the rollResult precedence test below, because the tally card it
// feeds is standing information that renders in every state, not just the
// form-sourced one. Shape on a current-format submission (TM Story's own
// content-shape.js `territoryInfluence`): { spends: [{ territory, amount }] }.
let storyTerritoryInfluence = null;
// The active cycle's _id as a string. Also the value of the tracker_state
// idempotency marker written when a form-sourced roll's aggHealed is applied.
let activeCycleId = null;
// The raw tracker_state document, read live once per render pass, for both
// roles. Carries fields tracker.js's own in-memory cache does not map, notably
// the feeding_agg_healed_cycle_id marker.
let trackerDoc = null;
// How that read went: 'ok' (a real document), 'absent' (404 - this character
// genuinely has no tracker document yet, so defaults ARE the true answer), or
// 'error' (the read itself failed - the real state is UNKNOWN). null before the
// first read of a render pass. Nothing may compute a write from 'error'.
let trackerLoad = null;
// Set for the duration of a confirm write, so a second click (or a second
// handler invocation) cannot start a duplicate one.
let _confirmInFlight = false;
// The tracker_state field the aggHealed idempotency marker lives in. TM Game
// has no write path to tm_story (Story 12.2 grounding), so an "already applied"
// flag cannot be written back onto TM Story's submission — it lives here, in
// the one collection this tab already writes to.
export const AGG_HEALED_MARKER = 'feeding_agg_healed_cycle_id';
// `charId|cycleId` → {vitae, infSpent, ...} — persists within the session.
// Review fix (Codex, external, 12.2 Low): keyed by character AND cycle. Keyed by
// character alone, a confirmation recorded against the PREVIOUS cycle went on
// hiding the confirm controls after the active cycle changed without a page
// reload, silently skipping the new cycle's own aggHealed.
const _stConfirmed = {};

// `cycleId` is explicit so an in-flight write can key its own result against
// the cycle it STARTED in (review fix, Codex, external, third round, Medium),
// rather than whatever cycle happens to be active when the response lands.
function stConfirmKey(charId, cycleId = activeCycleId) {
  return String(charId) + '|' + (cycleId || '');
}

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
  storyTerritoryInfluence = null;
  activeCycleId = null;
  trackerDoc = null;
  trackerLoad = null;

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
  // Review fix (Codex, external, 12.2 High + 12.3 High): the character's LIVE
  // tracker_state, read once per render pass, for both roles, before anything
  // renders a tracker figure or computes a write from one. It used to be read
  // only inside the form-sourced branch and only for an ST, which left the
  // Story 12.3 tally card - rendered in every state, for everyone - on
  // `trackerRead()`'s seeded defaults. Both reads now share this one request.
  const [storyRes, trackerRes] = await Promise.all([
    fetchStoryFeeding(String(char._id), activeCycleId),
    readTrackerState(String(char._id)),
  ]);
  if (currentChar !== charSnapshot) return;
  trackerLoad = trackerRes.status;
  trackerDoc = trackerRes.doc;

  // Story 12.3: the tally card's declared-spend figure comes off THIS response,
  // not a second request. `fetchStoryFeeding` returns TM Story's whole body
  // verbatim, so the fourth key is already here whichever branch runs below;
  // a failed fetch (network, CORS, 404) leaves it null and the card degrades to
  // current values alone.
  storyTerritoryInfluence = storyRes?.ok ? (storyRes.data?.territory_influence ?? null) : null;

  // Review fix (Codex, external, 12.2 Medium): ANY truthy `rollResult` used to
  // win here, so `{}`, `[]`, a bare string or a historical partial object
  // activated the read-only state and rendered a fabricated "locked" result of
  // zero successes and no dice, instead of falling through to the old state
  // machine. Only a genuinely usable shape activates it now, and what it
  // activates on is the NORMALISED copy - see normaliseStoryFeeding.
  if (storyRes?.ok && isUsableStoryRoll(storyRes.data?.feeding)) {
    storyFeeding = normaliseStoryFeeding(storyRes.data.feeding);
    feedingState = 'rolled-from-form';
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
 * The character's live tracker_state document, as a tri-state result.
 *
 * tracker.js's in-memory cache is deliberately NOT consulted: it maps a fixed
 * field list (see its `ensureLoaded`) and drops anything else, so the aggHealed
 * idempotency marker cannot be read back through it at all, and - the reason
 * this function exists at all - `trackerRead()` SEEDS AND RETURNS DEFAULTS for
 * a character nothing has loaded yet. This tab never calls `ensureLoaded`, so
 * on a fresh session those defaults were the only thing it ever saw.
 *
 * Uses `apiRaw` rather than `apiGet` because the status code is the whole
 * point: `apiGet` throws identically on a 404 and on a 500 or a dropped
 * connection, and those two mean opposite things here.
 *
 *   'ok'      a real document came back; `doc` is it.
 *   'absent'  404 - this character genuinely has no tracker document yet, so
 *             defaults (full Willpower/Influence, no damage, no marker) are the
 *             true answer, not a guess.
 *   'error'   the read failed. The real state is UNKNOWN. Callers must render
 *             "Unavailable" and must not compute any write from it.
 */
async function readTrackerState(charId) {
  let res;
  try {
    res = await apiRaw('GET', '/api/tracker_state/' + charId);
  } catch {
    return { status: 'error', doc: null };
  }
  if (res.ok && res.body && typeof res.body === 'object') return { status: 'ok', doc: res.body };
  if (res.status === 404) return { status: 'absent', doc: null };
  return { status: 'error', doc: null };
}

/**
 * The three tracker figures this tab uses, or null when the read failed.
 *
 * Returns plain numbers only. `null` means "unknown", and is never silently
 * substituted with a default: that substitution is exactly the bug this
 * replaces.
 */
function trackerFigures() {
  if (!currentChar) return null;
  if (trackerLoad === 'absent') {
    // No document: the server has never been told otherwise, so the character
    // is at full Willpower and Influence with no damage and no marker.
    return {
      willpower: calcWillpowerMax(currentChar),
      inf: calcTotalInfluence(currentChar),
      aggravated: 0,
      marker: '',
    };
  }
  if (trackerLoad !== 'ok' || !trackerDoc) return null;
  // Same strict gate as the TM Story boundary below (`_strictNum`): a stored
  // `willpower: true` must fall back to the real maximum, not silently read as
  // Willpower 1.
  const num = (v, fallback) => { const n = _strictNum(v); return n === null ? fallback : n; };
  return {
    willpower: num(trackerDoc.willpower, calcWillpowerMax(currentChar)),
    inf: num(trackerDoc.influence, calcTotalInfluence(currentChar)),
    aggravated: Math.max(0, Math.trunc(num(trackerDoc.aggravated, 0))),
    marker: String(trackerDoc[AGG_HEALED_MARKER] || ''),
  };
}

// ── TM Story payload validation + normalisation ───────────────────────────────
// Review fix (Codex, external, 12.2 High/Medium). TM Story is a genuinely
// EXTERNAL app: its response is not this app's own trusted database, and its
// values were being interpolated into innerHTML raw. A single corrupted or
// hostile `dice` entry such as `</span><img src=x onerror=...>` executed in TM
// Game's own origin, where the Discord bearer token lives in localStorage.
// Nothing from that payload now reaches the DOM except numbers this file
// produced itself, and the two strings it keeps go through `esc()` as before.

/**
 * A finite number, but ONLY from a value that is genuinely numeric to begin
 * with: a JSON number, or a non-blank string that parses cleanly. Anything else
 * - a boolean, an array, an object, `null`, `undefined`, a blank string - is
 * `null`, meaning "not a number at all".
 *
 * Review fix (Codex, external, third round, Medium): `Number()` alone is not a
 * type check. `Number(true)` is 1, `Number([8])` is 8 and `Number([])` is 0, so
 * a payload such as `dice: [true, [8]]` or `vesselVitae: [true, 2]` coerced to
 * `[1, 8]` / `[1, 2]` and rendered as though those were real values - which
 * weakens the very boundary validation the previous round added. The typeof
 * gate goes BEFORE the coercion, not after it. `_spendAmount` below already
 * worked this way for exactly the same reason; this is that discipline applied
 * to every other coercion in the file.
 */
function _strictNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A die: an integer 1-10. Anything else is not a die. */
function _die(v) {
  const n = _strictNum(v);
  return (n !== null && Number.isInteger(n) && n >= 1 && n <= 10) ? n : null;
}

/** A vessel's vitae: a finite integer, floored at 0 and bounded well above any
 *  real value (a Human vessel tops out at 7; an Animal feed records one pooled
 *  total, which is larger but still small). */
function _vesselVitae(v) {
  const n = _strictNum(v);
  if (n === null) return null;
  const i = Math.trunc(n);
  return (i >= 0 && i <= 99) ? i : null;
}

/**
 * Is this a feeding sub-document carrying a roll we can actually display?
 *
 * Requires a plain object with a plain-object `rollResult`, a real `dice`
 * array, and a non-negative integer `successes`. `{}`, `[]`, a bare string and
 * a historical partial block all fail, and fall through to the old TM
 * Game-sourced state machine exactly as "no usable roll" already did.
 */
export function isUsableStoryRoll(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  const rr = f.rollResult;
  if (!rr || typeof rr !== 'object' || Array.isArray(rr)) return false;
  if (!Array.isArray(rr.dice)) return false;
  if (!Number.isInteger(rr.successes) || rr.successes < 0) return false;
  return true;
}

/**
 * A sanitised copy carrying ONLY the fields the read-only view renders, each
 * coerced to a type that view can safely produce markup from. Dice and vessel
 * values that are not real numbers are dropped rather than rendered; the two
 * remaining strings (`method`, `bloodType`) are kept as strings and stay
 * `esc()`-ed at the point of use.
 */
export function normaliseStoryFeeding(f) {
  const rr = f.rollResult;
  const again = _strictNum(rr.again);
  const pool = _strictNum(rr.pool);
  return {
    method: typeof f.method === 'string' ? f.method : '',
    bloodType: typeof f.bloodType === 'string' ? f.bloodType : '',
    aggHealed: (Number.isInteger(f.aggHealed) && f.aggHealed > 0) ? f.aggHealed : 0,
    vesselVitae: (Array.isArray(f.vesselVitae) ? f.vesselVitae : [])
      .map(_vesselVitae).filter(v => v !== null),
    rollResult: {
      pool: (pool !== null && Number.isInteger(pool) && pool >= 0) ? pool : null,
      dice: rr.dice.map(_die).filter(d => d !== null),
      successes: rr.successes,
      exceptional: rr.exceptional === true,
      dramatic_failure: rr.dramatic_failure === true,
      rote: rr.rote === true,
      chance: rr.chance === true,
      again: (again === 8 || again === 9) ? again : 10,
    },
  };
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

/**
 * Story 12.3: the Influence the player has DECLARED spending in this cycle's
 * downtime form, summed off TM Story's `territory_influence.spends[]`.
 *
 * Returns null - not 0 - when there is no `territory_influence` at all (a draft,
 * or a cycle predating TM Story's Story 11.3b), so the caller can leave the row
 * out entirely rather than print a "0 declared" that looks like real data. An
 * EMPTY `spends` array is a different thing: the section exists on the
 * submission and records no spend, so 0 is the true figure and is shown.
 *
 * Absolute value, not signed sum: `amount` is signed only because it says which
 * direction the ambience moves (positive improves, negative degrades). TM
 * Story's own budget maths (`public/js/downtime-form/influence-budget.js`,
 * `totalSpent`) charges 1 Influence per point EITHER WAY, so a signed sum would
 * under-report, and a mix of +2 and -2 would report a spend of nothing at all.
 *
 * Review fix (Codex, external, 12.3 Low): returns the string 'unavailable' -
 * not 0 - for a NON-EMPTY spends array in which no entry carries a readable
 * amount. `{ spends: [{ amount: 'lots' }] }` used to reduce to 0 and print
 * "0 declared" as though that were the player's real declaration. A mix is
 * still summed from the readable entries, which is the closest true figure
 * available.
 */
export function declaredInfluenceSpend(ti) {
  const spends = ti && Array.isArray(ti.spends) ? ti.spends : null;
  if (!spends) return null;
  if (!spends.length) return 0;        // genuinely zero: the section exists and records no spend
  let total = 0, readable = 0;
  for (const s of spends) {
    const n = _spendAmount(s?.amount);
    if (n === null) continue;
    readable += 1;
    total += Math.abs(n);
  }
  return readable ? total : 'unavailable';
}

/**
 * One `spends[].amount`, as a signed integer, or null when it is not a readable
 * amount at all. `null`, `undefined`, `''`, `true` and objects all coerce to a
 * NUMBER through `Number()` (0, 0, 0, 1, NaN) - which is how a malformed entry
 * used to pass for a real declaration of zero.
 */
function _spendAmount(v) {
  const n = _strictNum(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * Story 12.3: the standing Influence + Willpower tally.
 *
 * Rendered in every state, alongside whatever the tab is otherwise showing:
 * it is information about the character, not a step in the feeding flow.
 *
 * Both current figures come from the SAME live tracker_state read the ST
 * confirm panel uses (`readTrackerState`, once per render pass) - one source,
 * no second one invented here. Willpower is read and shown plainly: no spend
 * itemisation for it exists anywhere in either app, so there is nothing to net
 * it against.
 *
 * Review fix (Codex, external, 12.3 High): this used to read `trackerRead()`,
 * whose cache SEEDS DEFAULTS for any character nothing has loaded yet - so on a
 * fresh session a character really on Willpower 1/5 and Influence 2/5 rendered
 * as 5/5 and 5/5, with no way to tell that from real data. "The read failed"
 * (Unavailable) and "there is no document yet, so full is the true answer" are
 * now two different things, decided by the HTTP status.
 *
 * Influence is deliberately two separate, separately-labelled rows. The
 * declared figure has NOT been taken off the current total: TM Story's own
 * Story 11.3b ruled a territory-influence spend is "a declaration resolved at
 * processing", never a live decrement, so presenting one as net of the other
 * would misstate what the player has.
 */
function renderInfluenceWillpowerTally() {
  if (!currentChar) return '';
  const ts = trackerFigures();
  const declared = declaredInfluenceSpend(storyTerritoryInfluence);

  const wp  = ts ? `${ts.willpower} / ${calcWillpowerMax(currentChar)}` : 'Unavailable';
  const inf = ts ? `${ts.inf} / ${calcTotalInfluence(currentChar)}` : 'Unavailable';

  let h = '<div class="fvt-card feed-tally" id="feed-tally">';
  h += '<div class="fvt-title">Influence and Willpower</div>';
  h += `<div class="fvt-row"><span class="fvt-label">Willpower</span><span class="fvt-val" id="feed-tally-wp">${esc(wp)}</span></div>`;
  h += `<div class="fvt-row"><span class="fvt-label">Influence (current)</span><span class="fvt-val" id="feed-tally-inf">${esc(inf)}</span></div>`;
  if (!ts) {
    h += '<p class="feeding-state-detail">Your tracker could not be read just now, so these figures are not shown rather than guessed at. Reload to try again.</p>';
  }
  if (declared !== null) {
    const shown = declared === 'unavailable' ? 'Unavailable' : String(declared);
    h += '<div class="fvt-row"><span class="fvt-label">Influence declared this cycle (not yet processed)</span>';
    h += `<span class="fvt-val" id="feed-tally-declared" data-declared="${esc(shown)}">${esc(shown)}</span></div>`;
    h += '<p class="feeding-state-detail">Declared spending is not taken off the current total until your Storyteller processes the downtime.</p>';
  }
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
 * `formSourced` this is a TM Story roll, so no vitae tally was computed for it.
 *
 * Review fix (Codex, external, 12.2 High + 12.2 Medium/idempotency): the panel
 * FAILS CLOSED. Every figure it offers to write is now read from the live
 * tracker document; if that read failed, the character's real Influence and
 * Aggravated counts are unknown, and the panel renders a notice with NO confirm
 * control at all rather than a stepper pre-filled with a default that would
 * overwrite real state. In particular "the read failed" is no longer
 * indistinguishable from "no marker, healing not yet applied", which was one of
 * the two real double-application routes.
 */
function renderStConfirmPanel({ stDefault, aggHealed = 0, formSourced = false }) {
  const charId = String(currentChar._id);
  const confirmed = _stConfirmed[stConfirmKey(charId)];
  const vitaeMax = calcVitaeMax(currentChar);
  const infMax   = calcTotalInfluence(currentChar);
  const ts = trackerFigures();
  if (!ts && !confirmed) {
    return '<div class="feed-st-confirm"><p class="feeding-state-detail">'
      + 'The tracker state for this character could not be read, so confirming the feed is unavailable: '
      + 'writing Vitae, Influence or Aggravated now could overwrite real values with defaults. Reload to try again.'
      + '</p></div>';
  }
  const aggApplied = !!activeCycleId && !!ts && ts.marker === activeCycleId;
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
    const _curInf = Math.max(0, Math.min(infMax, ts.inf));
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
  // `storyFeeding` is the NORMALISED copy (normaliseStoryFeeding): dice and
  // vessel values are already integers this file produced, and the two strings
  // still go through esc() below. Nothing raw from TM Story reaches innerHTML.
  const f = storyFeeding;
  const rr = f.rollResult;
  const dice = rr.dice;
  const successes = rr.successes;
  const vessels = f.vesselVitae;
  const vesselTotal = vessels.reduce((a, b) => a + b, 0);

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
  if (rr.pool !== null) {
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
    h += renderStConfirmPanel({
      stDefault: vesselTotal,
      aggHealed: f.aggHealed,
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

  // ── STANDING TALLY (Story 12.3) ──
  // Deliberately outside every state branch below: it is standing information
  // about the character, valid whether they have declared a method, already
  // rolled here, or rolled in the downtime form. Skipped only while loading,
  // when there is nothing fetched to report against.
  if (feedingState !== 'loading') h += renderInfluenceWillpowerTally();

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
    // Review fix (Codex, external, 12.2 Medium/idempotency): the DOM `disabled`
    // flag alone does not stop a second handler invocation racing the first
    // past the check-then-set below, so the guard is module state, set before
    // anything is read and cleared only when the write has settled.
    if (_confirmInFlight) return;
    // And fail closed: if the live tracker read failed, the real Influence and
    // Aggravated counts are unknown. The panel does not render a confirm
    // control in that case; this is the second lock on the same door.
    const ts = trackerFigures();
    if (!ts) return;
    _confirmInFlight = true;
    // Review fix (Codex, external, third round, Medium): everything this write
    // belongs to is SNAPSHOTTED before the await. The ST can switch character,
    // or the active cycle can change, while the PUT is in flight; when the
    // response then landed, the handler merged character A's body into the
    // now-current `trackerDoc` and re-rendered the now-current container, so
    // character B displayed A's Influence and A's aggravated marker - and the
    // confirmation record was filed under whatever cycle was active by then,
    // hiding the new cycle's own confirm controls. The write itself is still a
    // success in that case (it reached the server for the right character); it
    // simply must not be applied to a view it was never about.
    const charSnapshot  = currentChar;
    const paneSnapshot  = container;
    const cycleSnapshot = activeCycleId;
    const isStillCurrent = () =>
      currentChar === charSnapshot && container === paneSnapshot && activeCycleId === cycleSnapshot;
    const charId = String(charSnapshot._id);
    const n = parseInt(paneSnapshot.querySelector('#feed-confirm-n')?.textContent) || 0;

    const btn = paneSnapshot.querySelector('#feed-confirm-btn');
    if (btn) { btn.textContent = 'Saving\u2026'; btn.disabled = true; }

    const infEl = paneSnapshot.querySelector('#feed-inf-spent');
    const vitaeMax = calcVitaeMax(charSnapshot);
    const infMax   = calcTotalInfluence(charSnapshot);
    // Stepper value is the NEW remaining influence (starts at max, ticked down)
    const infAfter = infEl ? Math.max(0, parseInt(infEl.textContent) || 0) : infMax;
    const infSpent = infMax - infAfter;

    // Story 12.2 (AC 3/AC 4): a downtime-form roll's own aggHealed rides THIS
    // write, not a second one. #feed-agg-n is rendered only when there is a
    // real, not-yet-applied figure for this cycle (renderStConfirmPanel), so
    // reading the amount off the DOM is also the idempotency guard: an
    // already-applied cycle, and every TM-Game-sourced roll, has no element to
    // read and takes the untouched vitae+influence path below.
    const aggEl = paneSnapshot.querySelector('#feed-agg-n');
    const aggHealed = aggEl ? Math.max(0, parseInt(aggEl.dataset.aggHealed, 10) || 0) : 0;
    const body = { vitae: n, influence: infAfter };
    let newAgg = null;
    if (aggHealed > 0 && cycleSnapshot && ts.marker !== cycleSnapshot) {
      // Review fix (Codex, external, 12.2 High): the LIVE tracker document,
      // never tracker.js's cache. That cache seeds `aggravated: 0` for any
      // character nothing has loaded, and this tab has never loaded one - so a
      // character carrying 3 Aggravated with `aggHealed: 2` computed and wrote
      // `aggravated: 0`, healing all three. `trackerFigures()` returns a figure
      // only when the live read genuinely succeeded or genuinely 404'd.
      newAgg = Math.max(0, ts.aggravated - aggHealed);
      body.aggravated = newAgg;
      body[AGG_HEALED_MARKER] = cycleSnapshot;
    }

    // Write vitae and influence to API — single source of truth for tracker state
    try {
      await apiPut('/api/tracker_state/' + charId, body);
      const stillCurrent = isStillCurrent();
      // `trackerDoc`/`trackerLoad`/`render()` are all GLOBAL VIEW state: they
      // describe whatever the tab is showing right now. Touch them only when
      // that is still this write's own character and cycle. Everything below
      // this branch is keyed by character id (or by the snapshotted cycle) and
      // is therefore correct either way - which is what stops the response
      // being lost when the ST has navigated on.
      if (stillCurrent) {
        // Bring this tab's own live copy up to what was just written -
        // including the marker, so the re-render below shows "already applied"
        // rather than re-offering the healing, and including the promotion
        // from 'absent' to 'ok' (a character with no tracker document now has
        // one).
        trackerDoc = { ...(trackerDoc || {}), ...body };
        trackerLoad = 'ok';
      }
      // Keep tracker.js in-memory cache in sync so the tracker card re-renders correctly
      const _raw = trackerReadRaw(charId);
      if (_raw) {
        _raw.inf = infAfter;
        if (newAgg != null) _raw.aggravated = newAgg;
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
      // The SNAPSHOTTED cycle, explicitly: a confirmation begun in cycle 1 is a
      // record about cycle 1 even if cycle 2 opened while it was in flight.
      // Filed under the live `activeCycleId` it hid cycle 2's own confirm
      // controls and skipped that cycle's aggHealed.
      _stConfirmed[stConfirmKey(charId, cycleSnapshot)] = record;
      if (stillCurrent) render();
    } catch (err) {
      console.error('Tracker feed confirm failed:', err);
      if (btn && isStillCurrent()) {
        btn.textContent = 'Save failed \u2014 retry';
        btn.classList.add('is-error');
        btn.disabled = false;
      }
    } finally {
      _confirmInFlight = false;
    }
  });

  container.querySelector('#feed-reconfirm-btn')?.addEventListener('click', () => {
    if (!currentChar) return;
    delete _stConfirmed[stConfirmKey(String(currentChar._id))];
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
    // Same strict gate as every other coercion in this file: a `true` in the
    // parsed spend map is not a spend of 1.
    const total = Object.values(spendObj).reduce((sum, v) => sum + Math.abs(_strictNum(v) ?? 0), 0);
    el.textContent = String(total);
  } catch {
    el.textContent = '0';
  }
}
