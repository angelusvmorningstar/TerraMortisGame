/**
 * Feeding tab — a pure client of TM Story's downtime store (Epic 12).
 *
 * WHAT CHANGED IN STORY 12.7. This tab used to roll its own dice and persist the
 * result to `tm_game.downtime_submissions` via `PUT /api/downtime_submissions/:id`.
 * That collection has held nothing since Epic 8 moved downtime storage to
 * `tm_story` — it has zero documents for Game 8 — so the save silently no-opped
 * and every roll vanished on refresh. The tab now owns the UI and nothing else:
 * TM Story holds the declaration, derives the real pool, rolls the dice, and
 * stores the result, and this file reads it back and draws it.
 *
 * The decision surface is a PORT of TM Story's own downtime form, not a lookalike
 * (Story 12.7 AC 11/13/14): the method cards, the locked pool display, the roll
 * gate and its exact words, the vessel-drain strip and the aggravated-healing
 * boxes all come from `TM Story/public/js/downtime-form/sections/feeding.js` and
 * `pool-builder.js`, adapted only for this app's own character accessors.
 *
 * ONE THING IS DELIBERATELY ABSENT, PERMANENTLY: there is no "Something else"
 * custom-pool card and no path to declaring one. RULED (Angelus, 2026-09-11):
 * "the only time a player is allowed to do a custom roll is during the downtime
 * form, as this allows STs to rule on it." The new write endpoint refuses a
 * custom declaration outright (AC 3); this tab simply never offers it.
 *
 * States: loading
 *       → story-feed        (TM Story holds this cycle: declare what is missing,
 *                            roll, feed, heal — whatever is still outstanding)
 *       → rolled-from-form  (the roll exists in TM Story; Story 12.2's state,
 *                            now also carrying the vessel/heal panels when those
 *                            are still outstanding)
 *       → ready | rolled | no_submission | deferred
 *                           (the residual TM-Game-sourced machine, reached only
 *                            when TM Story cannot be read at all. It still
 *                            DISPLAYS old-format data correctly; what it no
 *                            longer does is write one.)
 *
 * Story 12.3 adds one thing that belongs to no state: a standing Influence +
 * Willpower tally card, rendered in every state except loading.
 *
 * WHAT CHANGED IN STORY 12.8. Story 12.7 shipped the roll and then GATED the
 * other half: `doFeedingDeclaration()` had been wired against a
 * `POST .../feeding/declaration` route TM Story did not serve, so the Save
 * control was replaced by an "arriving in a follow-up story" placeholder
 * (`5fdf096c`). That route now exists, and this file does three things it did
 * not:
 *   1. the Save control is real and reachable again (`renderFeedDeclareControl`),
 *      WRITE-ONCE by ruling - one save per cycle, no edit affordance, TM Story's
 *      downtime form remains the only correction route;
 *   2. a recorded feed is APPLIED to the character's own `tracker_state` -
 *      Vitae as a clamped delta-add matching `trackerAdj()`'s shape, Aggravated
 *      as the same delta the ST-confirm panel already computes - as a
 *      RECONCILIATION on every tab load (`maybeReconcileFeed`), not only on the
 *      click, so a feed recorded in TM Story's own form applies too;
 *   3. one durable marker (`AGG_HEALED_MARKER`) now gates BOTH halves of that
 *      write instead of Aggravated alone, and the ST-confirm panel respects it
 *      in its handler as well as its render, closing the double-apply path.
 *
 * The healing budget rendered and applied is the SERVER'S own `fedTotal`, off
 * the declaration route's response - never a second derivation here. See
 * `renderFeedAggHealing()` for the one bounded case where a client-side floor is
 * still shown, and why closing it is deliberately out of scope.
 */

import { apiGet, apiPut, apiRaw } from '../data/api.js';
import {
  fetchStoryFeeding, fetchStoryFeedingTemplates, fetchStoryPrevious,
  postStoryFeedingRoll, postStoryFeedingDeclaration,
} from '../data/story-feeding.js';
import {
  conformance, feedingPoolRecall, feedingRollGate, isCustomApproach,
  normaliseTemplates, poolLockMode, templateForMethod, vesselHarmTier,
  violenceDefaultFor, vitaeColourClass as storyVitaeColourClass,
} from '../data/story-feeding-rules.js';
import { getFeedingCycle } from '../downtime/db.js';
import { esc, displayName, hasAoE, isSpecs } from '../data/helpers.js';
import { getAttrEffective as getAttrVal, skDots, skTotal, skSpecs, skSpecStr, skNineAgain, calcVitaeMax, calcWillpowerMax } from '../data/accessors.js';
import { FEED_METHODS, TERRITORY_DATA } from './downtime-data.js';
import { ALL_ATTRS, ALL_SKILLS, SKILLS_MENTAL } from '../data/constants.js';
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

// ── Story 12.7: THIS TAB NO LONGER ROLLS DICE ────────────────────────────────
//
// `d10`/`mkDie`/`mkChain`/`rollDice`/`cntSuc`/`rollDiceRote` and the
// `resolveSuccesses`/`formatSuccessBreakdown` import from `../shared/dice.js`
// are all gone. Verified before removal (AC 6 asks explicitly): every one of
// them was module-local to this file and reachable only from `doFeedingRoll()`.
// Nothing is exported from here but `renderFeedingTab`, `AGG_HEALED_MARKER`,
// `isUsableStoryRoll` and `normaliseStoryFeeding`, and no other module imports
// this file's dice helpers.
//
// The roll itself is TM Story's `dice-roll.js`'s `rollPool()`, invoked
// server-side by the new write endpoint. That is not tidiness: the data-lock
// (finding #3) found TM Game's own roll produced a DIFFERENT, incompatible
// result shape (`cols`/`dramaticFailure`, no `signature`/`chance`/`exceptional`),
// so a TM-Game-computed roll pushed into `content.feeding.rollResult` would
// either corrupt that shape or need a translation layer duplicating dice logic
// TM Story already owns correctly.
//
// ONE KNOWN CONSEQUENCE, stated rather than hidden: this tab's `dtlt.1` bonus
// successes (Stronger Than You and friends, `../shared/dice.js`) applied to a
// TM-Game-rolled feed and do not apply to a TM-Story-rolled one, because TM
// Story's engine has no such concept. That is a real behavioural difference,
// and it resolves in the same direction as everything else in this epic: TM
// Story owns the dice, so a rule that is to apply to a feeding roll has to
// exist there.
//
// `diceColumns()` further down is kept and is NOT a dice roller: it is a pure
// display regrouping of an already-rolled flat `dice` array, ported from TM
// Story's own `diceColumns()` by Story 12.4.

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
// Story 12.7 removed `poolTraitsTrusted`. It existed (dtlt.1) purely to decide
// whether this tab's own bonus-success predicates could be evaluated against
// `declaredMethod`'s traits when it rolled its own dice. It no longer rolls any:
// TM Story derives the pool and rolls it server-side, so there is nothing left
// for the flag to gate.
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

// ── Story 12.7: the story-sourced flow's own state ───────────────────────────
// `storyFeeding` above is the NORMALISED, display-only copy used by the
// read-only rolled view. These carry the rest of what the ported decision
// surface needs, and they are reset per render pass alongside everything else.
//
// `storyFeedRaw` is `content.feeding` as TM Story really stores it (or null).
// The declaration fields on it are what a frozen pool is read from and what a
// roll request must echo back unchanged, so it is deliberately NOT run through
// `normaliseStoryFeeding` (which keeps only the fields the rolled view draws).
// Every value taken off it still goes through `esc()` at the point of use, and
// every numeric value through the same strict coercions the rolled view uses.
let storyFeedRaw = null;
// The live template list (AC 12), and whether the fetch that produced it
// actually succeeded. An empty list with `storyTemplatesOk === false` means
// "could not reach TM Story", which is a different sentence from "TM Story
// offers no templates" and must never be shown as the same one.
let storyTemplates = [];
let storyTemplatesOk = false;
// `feedingPoolRecall()`'s offer off the previous cycle, or null.
let storyRecall = null;
// The player's in-progress picks. Mirrors the sub-document's own field names so
// a roll request is a straight projection of it, never a translation.
let feedSel = null;
// True when TM Story already holds a genuinely declared method for this cycle:
// the pool is frozen and no picker is ever rendered (Angelus, 2026-09-11 -
// "choices that have already been made remain locked, and choices not made are
// left to be completed").
let feedFrozen = false;
// A write is in flight. Every control the write could invalidate is disabled
// while it is true, and it is cleared only when the request has settled.
let feedBusy = false;
// The last thing a write said, as `{ kind: 'error' | 'ok', text }`. Rendered
// verbatim through `esc()` - TM Story's own refusal messages ("Custom pools can
// only be declared in the downtime form") are the useful half of a 400.
let feedNotice = null;
// TM Story's own two-step commit (`sections/feeding.js`'s `state.rollConfirming`):
// Roll -> irreversible warning -> Confirm/Cancel.
let feedRollConfirming = false;
// The vessel draw and the aggravated healing, while the player is still setting
// them. Null means "not being edited" (nothing declared yet, or already
// committed - `feedVesselsCommitted` below is what tells those apart).
let feedVesselDraft = null;
let feedAggDraft = 0;
let feedVesselsCommitted = false;
// ── Story 12.8 ───────────────────────────────────────────────────────────────
// "A declaration is on file for this cycle", which is NOT the same fact as
// `feedVesselsCommitted` above. That flag is sourced from `vesselVitae.length > 0`
// (:1547/:1594) and answers "is there a stored vessel array to render". A
// genuinely resolved ZERO-SUCCESS feed declares no vessels at all (TM Story's own
// vessel gate, `sections/feeding.js:689`, hides the strip entirely below one
// success) while still carrying a real healing budget off `vitaeProjection().net`
// (data-lock #6) - so for that feed `vesselVitae` is `[]` for ever and the vessel
// flag can never latch. This one is the WRITE-ONCE latch (AC 9b, RULED: "TM Game
// stays write-once"), and it latches on either half of the declaration.
let feedDeclCommitted = false;
// The server's own derived `fedTotal` for this cycle's declaration (AC 9a), as
// returned by `POST .../feeding/declaration`. null means "not obtained yet".
// NEVER re-derived here: TM Story's real total is the vessel draws PLUS
// `vitaeProjection().net` (`sections/feeding.js:892`), and porting that
// projection into a second app is the exact failure class Story 12.7's AC 2
// doctrine exists to prevent.
let feedServerFedTotal = null;
// Set for the duration of a reconciliation, so a load-triggered apply and a
// save-triggered apply cannot both write the same feed. Module state, not a DOM
// flag, for the same reason `_confirmInFlight` is (see its comment at :2586).
let _feedApplyInFlight = false;

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
  // Story 12.7: the ported flow's own state, reset with everything else so a
  // character switch can never leave one character's picks on another's card.
  storyFeedRaw = null;
  storyTemplates = [];
  storyTemplatesOk = false;
  storyRecall = null;
  feedSel = null;
  feedFrozen = false;
  feedBusy = false;
  feedNotice = null;
  feedRollConfirming = false;
  feedVesselDraft = null;
  feedAggDraft = 0;
  feedVesselsCommitted = false;
  // Story 12.8: reset with everything else. `_feedApplyInFlight` deliberately is
  // NOT reset here - an apply already in flight is keyed by character id and
  // must be allowed to finish (AC 11), and clearing its guard mid-flight would
  // let a second one start on top of it.
  feedDeclCommitted = false;
  feedServerFedTotal = null;

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
      <div class="tab-split-left" id="feeding-left-pane"><p class="placeholder-msg">Feeding rolls open once the Storyteller moves the cycle to Prep or Game.</p></div>
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
  // Story 12.7: what counts as "TM Story answered". A 2xx alone is not enough -
  // this is a cross-origin call whose response could be anything, and a body that
  // is not this route's own shape (`{ feeding, territory_influence,
  // lifecycle_state, status }`) tells us nothing about whether the character has
  // a submission. Anything else is treated exactly like an unreachable service:
  // fall through to the residual state machine rather than declare, on no
  // evidence, that the player has nothing on file.
  const storyBody = (storyRes?.ok
    && storyRes.data && typeof storyRes.data === 'object' && !Array.isArray(storyRes.data)
    && 'feeding' in storyRes.data)
    ? storyRes.data
    : null;

  if (storyBody && isUsableStoryRoll(storyBody.feeding)) {
    storyFeeding = normaliseStoryFeeding(storyBody.feeding);
    storyFeedRaw = storyBody.feeding;
    feedingState = 'rolled-from-form';
    // Story 12.7: the roll is done, but the vessel feed and the vitae heal may
    // not be. Those panels need the same reference data the pre-roll flow does
    // (the template list names the method a frozen declaration stores), so the
    // same hydration runs here too.
    await hydrateStoryFeedingRefs(String(char._id), activeCycleId);
    if (currentChar !== charSnapshot) return;
    initFeedSelection();
    mountFeedingPanes(el, char);
    render();
    // Story 12.8 (AC 9): THE RECONCILIATION. Deliberately after the first
    // render - the tab draws immediately from what TM Story holds, and the
    // tracker application (which may need a round-trip of its own) settles
    // behind it and redraws. This is the ONLY branch it runs from, because a
    // committed declaration cannot exist without a usable roll, and a usable
    // roll is exactly what puts the tab in this state.
    await maybeReconcileFeed(charSnapshot, activeCycleId, container);
    return;
  }

  // ── Story 12.7: TM Story holds this cycle, but no roll has happened yet ─────
  //
  // Three real situations, all served by the SAME ported flow, which decides
  // internally which of them it is looking at:
  //   1. a declaration is on file (the common case, e.g. Samuel Pike) - the pool
  //      is frozen, no picker is ever shown, and whatever is still outstanding
  //      opens together;
  //   2. a submission exists with no method declared (should be impossible under
  //      the current form, handled anyway) - the full flow, template + recall
  //      only;
  //   3. no submission at all for this cycle (an honest 404) - same as 2.
  //
  // A fetch that FAILED for any other reason (network, CORS, 401, 500) is NOT
  // one of these: the real state is unknown, so it falls through to the residual
  // TM-Game-sourced machine below exactly as it did before this story.
  const storyReachable = !!storyBody || storyRes?.reason === 'not-found';
  if (storyReachable) {
    storyFeedRaw = storyBody ? (storyBody.feeding ?? null) : null;
    feedingState = 'story-feed';
    await hydrateStoryFeedingRefs(String(char._id), activeCycleId);
    if (currentChar !== charSnapshot) return;
    initFeedSelection();
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
      feedingState = 'ready';
    } else {
      feedingState = 'no_submission';
    }
  } else if (declaredMethod) {
    buildPool(declaredMethod, declaredDisc, declaredSpec);
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
      // Story 12.8: `defaults()` (`../game/tracker.js:35-43`) is this app's own
      // answer for a character nothing has ever written tracker state for, and
      // its answer for Vitae is the maximum, not zero. Followed here rather than
      // invented: a delta-add onto it simply clamps back to the maximum, so an
      // undocumented character can never have a feed inflate them past full.
      vitae: calcVitaeMax(currentChar),
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
    // Story 12.8: `vitae` is read here for the same reason every other figure is
    // - the automatic feed application (AC 9) is a CLAMPED DELTA-ADD onto the
    // character's real current Vitae, so it needs the real current Vitae, from
    // the same live read everything else on this tab uses.
    vitae: num(trackerDoc.vitae, calcVitaeMax(currentChar)),
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
  // Story 12.4: recomposed onto TM Story's own "Vitae Projection" ledger
  // (downtime-form.css:833-839, rendered by its sections/feeding.js:560-566).
  // Same row/label/value SHAPE as the old .fvt-card - only the class names and
  // their treatment change; the tally computation above is untouched.
  //
  // Two faithful-port differences worth naming: TM Story colours the WHOLE ROW
  // (.feed-ledger-row.feed-ledger-pos / -cost) where .fvt-pos coloured only
  // the number, and the `.fvt-divider` element is dropped because
  // .feed-ledger-total carries its own border-top - keeping it drew two rules.
  //
  // Review fix (Codex, external, 12.4 Medium 1): the ported CLASS NAMES are
  // `.feed-ledger*`, not TM Story's own `.dt-vitae-*`. Those names were already
  // in use in THIS repo by the downtime form's unrelated Vitae Projection panel
  // (downtime-form.js:7444), and sharing them restyled that panel while denying
  // this card its own colours. Declarations are still TM Story's, verbatim; see
  // the rule block at components.css for the full reasoning.
  let h = '<div class="feed-ledger">';
  h += '<div class="feed-ledger-title">Vitae Sources</div>';
  if (vessels !== null) h += `<div class="feed-ledger-row"><span>Vessels (from roll)</span><span>${vessels}</span></div>`;
  if (tally.herd)         h += `<div class="feed-ledger-row feed-ledger-pos"><span>Herd</span><span>+${tally.herd}</span></div>`;
  if (tally.oath_of_fealty) h += `<div class="feed-ledger-row feed-ledger-pos"><span>Oath of Fealty</span><span>+${tally.oath_of_fealty}</span></div>`;
  if (tally.ambience != null && tally.ambience !== 0) {
    const lbl = tally.ambience_territory ? `Ambience (${tally.ambience_territory})` : 'Ambience';
    const cls = tally.ambience > 0 ? ' feed-ledger-pos' : ' feed-ledger-cost';
    const sign = tally.ambience > 0 ? '+' : '';
    h += `<div class="feed-ledger-row${cls}"><span>${esc(lbl)}</span><span>${sign}${tally.ambience}</span></div>`;
  }
  if (tally.ghouls)    h += `<div class="feed-ledger-row feed-ledger-cost"><span>Ghoul retainers</span><span>\u2212${tally.ghouls}</span></div>`;
  if (tally.rite_cost) h += `<div class="feed-ledger-row feed-ledger-cost"><span>Rite costs</span><span>\u2212${tally.rite_cost}</span></div>`;
  if (tally.manual)    h += `<div class="feed-ledger-row${tally.manual > 0 ? ' feed-ledger-pos' : ' feed-ledger-cost'}"><span>Adjustment</span><span>${tally.manual > 0 ? '+' : ''}${tally.manual}</span></div>`;
  h += `<div class="feed-ledger-row feed-ledger-total"><span>Bonus vitae</span><span>+${tally.total_bonus}</span></div>`;
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

  // Story 12.4: the same .feed-ledger ledger as the Vitae Sources card above,
  // so the two tally cards read as one component in two instances - the
  // form's own treatment. `feed-tally` and the three ids are behavioural
  // anchors (Story 12.3's tests read them) and are untouched.
  let h = '<div class="feed-ledger feed-tally" id="feed-tally">';
  h += '<div class="feed-ledger-title">Influence and Willpower</div>';
  h += `<div class="feed-ledger-row"><span>Willpower</span><span id="feed-tally-wp">${esc(wp)}</span></div>`;
  h += `<div class="feed-ledger-row"><span>Influence (current)</span><span id="feed-tally-inf">${esc(inf)}</span></div>`;
  if (!ts) {
    h += '<p class="feeding-state-detail">Your tracker could not be read just now, so these figures are not shown rather than guessed at. Reload to try again.</p>';
  }
  if (declared !== null) {
    const shown = declared === 'unavailable' ? 'Unavailable' : String(declared);
    h += '<div class="feed-ledger-row"><span>Influence declared this cycle (not yet processed)</span>';
    h += `<span id="feed-tally-declared" data-declared="${esc(shown)}">${esc(shown)}</span></div>`;
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

/**
 * Story 12.4: the harm-tier CLASS, now split Critical/Fatal the way TM Story's
 * own `vesselHarmTier` splits it (feeding-reference.js:336-342) instead of
 * collapsing both onto one class.
 *
 * Not a rule change: `fvcConseqText` above already returned 'Critical' at 6 and
 * 'Fatal' at 7+, and TM Story's tier ladder is itself a verbatim port OF these
 * two functions (its own header says so). The two classes render identically
 * (`.vd-tier.vd-critical, .vd-tier.vd-fatal` share one rule), so this changes
 * nothing on screen - it just stops the two apps disagreeing about the name of
 * a tier they already agree about.
 */
function fvcConseqClass(v) {
  if (v <= 2) return 'vd-safe';
  if (v === 3) return 'vd-drained';
  if (v <= 5) return 'vd-serious';
  if (v === 6) return 'vd-critical';
  return 'vd-fatal';
}

/**
 * Story 12.4 ported TM Story's `vitaeColourClass` into this file as a local
 * copy. Story 12.7 collapsed the two: it now lives beside the rest of the
 * ported decision rules in `../data/story-feeding-rules.js` and is imported at
 * the top of this file as `storyVitaeColourClass`, so the vessel strip and the
 * read-only card below cannot drift apart from each other or from TM Story.
 */

/**
 * Story 12.4: one vessel's drain, as the downtime form draws it - a card with a
 * tier badge, a strip of seven boxes filled to the drawn amount, and the count.
 * Structure and classes from TM Story's own renderVesselDrain()
 * (public/js/downtime-form/sections/feeding.js:787-800).
 *
 * READ-ONLY by construction. TM Story's boxes are `<button>`s because they are
 * its input control; here the value is already committed, so each box is a
 * `<span>` - the story spec explicitly allows this ("a read-only rendering can
 * use a non-interactive element styled identically"), and components.css's
 * `.vd-box:not(button)` rules take the pointer/hover affordance back off.
 *
 * `label` is emitted verbatim and must be caller-controlled text, never
 * anything from TM Story's payload.
 */
function renderVesselCard(label, vitae) {
  const v = Math.max(0, Math.min(7, vitae));
  let h = '<div class="vd-card">';
  h += `<div class="vd-card-head"><span>${label}</span>`;
  if (v) h += `<span class="vd-tier ${fvcConseqClass(v)}">${fvcConseqText(v)}</span>`;
  h += '</div>';
  h += '<div class="vd-boxes">';
  for (let b = 1; b <= 7; b++) {
    const filled = b <= v ? ` vd-box-filled ${storyVitaeColourClass(b)}` : '';
    h += `<span class="vd-box${filled}"></span>`;
  }
  h += '</div>';
  h += `<div class="vd-vitae-count">${vitae} vitae drawn</div>`;
  h += '</div>';
  return h;
}

/**
 * Story 12.4: a flat `dice` array regrouped into one column per BASE die, so an
 * exploded die's children render below it, connected by a stem.
 *
 * Ported verbatim from TM Story's `diceColumns`
 * (public/js/downtime-form/dice-roll.js:67-78). Pure display grouping - it
 * reads nothing but the dice it is handed and decides nothing about successes.
 * The shape it produces is TM Game's own to begin with (suite.css's
 * `.dcol`/`.xconn`, built by roll-v2.js's `mkColsEl()`); TM Story ported it
 * from here, and the flat row this replaces was the odd one out.
 */
function diceColumns(dice, again) {
  const cols = [];
  let prevExploded = false;
  for (const v of dice || []) {
    const d = { v, s: v >= 8, x: v >= again };
    if (!prevExploded) cols.push({ r: d, ch: [] });
    else cols[cols.length - 1].ch.push(d);
    prevExploded = d.x;
  }
  return cols;
}

/**
 * Story 12.4: the dice themselves, in the downtime form's own treatment
 * (downtime-form.css:850-860, rendered by its sections/feeding.js:619-627).
 *
 * `cols` is `[{ r, ch }]`, the shape both this tab's own persisted rolls and
 * `diceColumns()` above already produce. `isHit` is passed in rather than
 * assumed, because a chance die succeeds only on a 10 - TM Story fixed exactly
 * that (a Codex Medium against its own dieHtml) and the flat row this replaces
 * carried the unfixed `v >= 8` for every roll.
 *
 * TM Game's old `.fd-1` botch tint has no equivalent in the form and is dropped
 * rather than smuggled through: a 1 only carries meaning on a chance die or a
 * dramatic failure, and both already have their own explicit surfaces here
 * (`rr.chance`'s badge, `.feeding-dramatic`). Nothing is now shown in one app
 * and not the other.
 */
function renderDiceCols(cols, isHit) {
  let h = '<div class="feeding-roll-dice">';
  for (const col of cols) {
    h += '<div class="feeding-dice-col">';
    h += `<span class="feeding-die${isHit(col.r.v) ? ' feeding-die-hit' : ''}">${col.r.v}</span>`;
    for (const d of col.ch) {
      h += '<div class="feeding-die-conn"></div>';
      h += `<span class="feeding-die${isHit(d.v) ? ' feeding-die-hit' : ''}">${d.v}</span>`;
    }
    h += '</div>';
  }
  h += '</div>';
  return h;
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
  // Story 12.8 (AC 14): the marker now gates BOTH components of the write, not
  // just Aggravated (AC 10), so on a form-sourced feed a matching marker means
  // the whole feed - Vitae included - has already been applied, either by an ST
  // through this panel or automatically by `maybeReconcileFeed()`. Left as it
  // was, an ST opening the tab after a player's self-service feed would see a
  // live, pre-filled Confirm button and could double-apply Vitae on top of the
  // automatic write (data-lock #10): `_stConfirmed` is in-memory only and does
  // not survive a reload, and `aggApplied` suppressed one row, not the panel.
  //
  // Scoped to `formSourced` deliberately. The legacy tm_game-sourced roll path's
  // behaviour is explicitly out of scope for this story ("unchanged, still real,
  // still needed there"), and it is reached only when TM Story cannot be read at
  // all - where a marker left by some earlier, unrelated apply must not remove
  // the ST's only control.
  const feedApplied = formSourced && aggApplied;
  let h = `<div class="feed-st-confirm">`;
  if (feedApplied && !confirmed) {
    h += '<div class="feed-confirmed-record" id="feed-already-applied">'
      + '✓ This cycle\'s feed has already been applied to the tracker'
      + (aggHealed > 0 ? `  |  Agg −${aggHealed}` : '')
      + '</div>';
    h += '<p class="feeding-state-detail">Vitae and Aggravated were written when the feed was recorded, so there is '
      + 'nothing left to confirm. Adjust the tracker directly if a correction is needed.</p>';
    h += `</div>`;
    return h;
  }
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
        // Story 12.4: the plain number becomes TM Story's own aggravated-box
        // treatment (downtime-form.css:908-914, its sections/feeding.js:901-916)
        // - DUAL-CODED, an unhealed box red, a healed box green PLUS a tick,
        // never colour alone. Read-only here (spans, not buttons): the figure is
        // the player's committed declaration and this app has no write path back
        // to tm_story, which is exactly why the ST cannot edit it.
        //
        // Box COUNT is the character's real current Aggravated (`ts.aggravated`,
        // the live tracker read), first `aggHealed` of them shown healed. When
        // the form declared more healing than the character still carries, the
        // strip shows what is really there and the summary still names the
        // declared figure - the confirm write's own clamp is untouched.
        const aggTotal = ts ? ts.aggravated : 0;
        const shownHealed = Math.min(aggHealed, aggTotal);
        h += `<div class="feed-st-row" id="feed-agg-row">`;
        h += `<div class="feed-st-row-lbl">Aggravated Healed</div>`;
        h += `<div class="feed-st-row-ctrl">`;
        if (aggTotal > 0) {
          h += '<div class="dt-agg-boxes">';
          for (let i = 1; i <= aggTotal; i++) {
            h += `<span class="dt-agg-box${i <= shownHealed ? ' dt-agg-box-healed' : ''}"></span>`;
          }
          h += '</div>';
        }
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
 * Story 12.7 REPLACED `renderFormSourcedRoll()`.
 *
 * Story 12.2 added it as a strictly read-only view of a roll already made in TM
 * Story's downtime form, on the reasoning that "the roll and the vessel
 * allocation are both already committed". That premise is no longer true: TM Game
 * can now complete a feed itself, so a cycle can genuinely sit with the roll done
 * and the vessel feed and vitae heal still outstanding. Rendering those as an
 * unchangeable read-out would have been the same double-work in reverse.
 *
 * `renderStoryFeedFlow()` below serves BOTH states from one place and decides per
 * panel whether it is a completed choice (locked) or an outstanding one (open).
 * Everything 12.2/12.4 established is preserved inside it: the normalisation
 * boundary (`normaliseStoryFeeding`), the column-and-stem dice, the .vd-card
 * vessel strip, and the ST Confirm Feed panel with its single tracker_state write.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Story 12.7: the ported TM Story decision surface
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything from here to `render()` is a PORT of TM Story's own downtime-form
// Feeding section, adapted only for this app's character accessors and its own
// fetch plumbing. The originals, all cited as of 2026-09-11:
//
//   TM Story/public/js/downtime-form/sections/feeding.js
//     renderMethods()      :181-278   -> renderFeedMethodPicker()
//     renderPool()         :297-376   -> renderFeedPool()
//     renderBloodType()    :501-506   -> renderFeedToggles()
//     renderViolence()     :508-528   -> renderFeedToggles()
//     renderRollStatus()   :575-670   -> renderFeedRollStatus()
//     renderVesselDrain()  :682-836   -> renderFeedVesselDrain()
//     renderAggHealing()   :857-927   -> renderFeedAggHealing()
//   TM Story/public/js/downtime-form/pool-builder.js
//     renderPoolBuilder()  :84-216    -> feedPoolBuilderHtml()
//       ONLY the `lock === 'recall'` (:141-151) and `suggestions` (:152-185)
//       branches are ported. The plain three-select free builder (:186-200) is
//       deliberately absent: it is the custom-pool builder, and AC 11 rules it
//       permanently out of scope for TM Game.
//
// The design reference these were checked against is the locked mockup at
// `TM Admin/specs/mockups/tm-game-feeding-tab-parity/index.html`, whose every
// class name is a literal requirement rather than an example.

/** Effective dots for every trait the pool builder can offer. */
function feedDots(c) {
  const d = {};
  for (const a of ALL_ATTRS) d[a] = getAttrVal(c, a);
  for (const s of ALL_SKILLS) d[s] = skTotal(c, s);
  for (const [name, obj] of Object.entries(c?.disciplines || {})) d[name] = obj?.dots || 0;
  return d;
}

/**
 * Specialisations per skill, with the Interdisciplinary Specialty merit folded
 * in - the same resolve-at-the-call-site treatment TM Story's own
 * `sections/feeding.js:45-56` applies, over this app's own `isSpecs()` (which
 * TM Story's `interdisciplinarySpecs()` was itself ported from).
 */
function feedSpecsMap(c) {
  const cross = isSpecs(c).map(r => r.spec);
  const out = {};
  for (const skill of ALL_SKILLS) {
    const own = skSpecs(c, skill) || [];
    const extra = cross.filter(s => !own.some(n => String(n).toLowerCase() === String(s).toLowerCase()));
    out[skill] = extra.length ? [...own, ...extra] : own;
  }
  return out;
}

function feedDiscNames(c) {
  return Object.keys(c?.disciplines || {});
}

/**
 * The Feeding Grounds bonus, from THIS app's own merit accessor rather than a
 * reimplementation.
 *
 * KNOWN DIVERGENCE, stated rather than hidden: TM Story's `feedingGroundsBonus`
 * is TERRITORY-aware (a character may hold Feeding Grounds in more than one
 * territory at different ratings, and the bonus only applies in the one they
 * are actually hunting in). This app's `domMeritContrib` is not. The number
 * below is therefore an ESTIMATE of what the roll will use; the authoritative
 * figure is derived server-side at roll time (AC 2) and comes back on
 * `rollResult.pool`, which is what the rolled view renders. The two can disagree
 * before a roll and never after one.
 */
function feedGroundsBonus(c) {
  return domMeritContrib(c, 'Feeding Grounds');
}

/** Area of Expertise's EXTRA dot, on top of the builder's own +1 for a chip. */
function feedSpecExtraBonus(c, spec) {
  return spec && hasAoE(c, spec) ? 1 : 0;
}

/** The VtR 2e unskilled penalty, per the skill actually picked. */
function feedUnskilledPenalty(c, skill) {
  if (!skill) return 0;
  if (skTotal(c, skill) > 0) return 0;
  return SKILLS_MENTAL.includes(skill) ? -3 : -1;
}

/** The pool a roll would actually use, floored at 0 (`combinedPoolTotal`). */
function feedEffectivePool() {
  const c = currentChar;
  if (!c || !feedSel) return 0;
  const dots = feedDots(c);
  const base = (feedSel.poolAttr ? (dots[feedSel.poolAttr] || 0) : 0)
    + (feedSel.poolSkill ? (dots[feedSel.poolSkill] || 0) : 0)
    + (feedSel.poolDisc ? (dots[feedSel.poolDisc] || 0) : 0)
    + (feedSel.poolSpecChip ? 1 : 0);
  const extras = feedGroundsBonus(c)
    + feedSpecExtraBonus(c, feedSel.poolSpecChip)
    + feedUnskilledPenalty(c, feedSel.poolSkill);
  return Math.max(0, base + extras);
}

/**
 * The declaration fields off TM Story's `content.feeding`, coerced at the
 * boundary.
 *
 * Same discipline as `normaliseStoryFeeding` above and for the same Story 12.2
 * reason: TM Story is a genuinely external app, and nothing from its payload may
 * reach innerHTML except a value this file has type-checked (and then `esc()`-ed
 * at the point of use).
 */
function normaliseStoryDeclaration(f) {
  const str = v => (typeof v === 'string' ? v : '');
  const o = (f && typeof f === 'object' && !Array.isArray(f)) ? f : {};
  const terr = (o.territory && typeof o.territory === 'object' && !Array.isArray(o.territory)) ? o.territory : null;
  return {
    method: str(o.method),
    poolAttr: str(o.poolAttr),
    poolSkill: str(o.poolSkill),
    poolDisc: str(o.poolDisc),
    poolSpecChip: o.poolSpecChip == null ? null : str(o.poolSpecChip),
    bloodType: ['Animal', 'Human', 'Kindred'].includes(o.bloodType) ? o.bloodType : 'Human',
    violence: (o.violence === 'kiss' || o.violence === 'violent') ? o.violence : null,
    poolLocked: o.poolLocked === true,
    territory: terr ? { id: str(terr.id), label: str(terr.label) } : null,
    aggHealed: (Number.isInteger(o.aggHealed) && o.aggHealed > 0) ? o.aggHealed : 0,
    // A vessel declaration EXISTS the moment the key is a non-empty array, even
    // if every entry is 0 - "I drew nothing from any of them" is a real answer
    // and must lock the same way any other completed choice does.
    vesselsDeclared: Array.isArray(o.vesselVitae) && o.vesselVitae.length > 0,
  };
}

/**
 * The two reference reads the ported surface needs: the live template list
 * (AC 12) and the previous cycle's pool for the recall card (AC 11).
 *
 * Never throws: both clients resolve to a result object, and a failure leaves
 * the tab saying plainly what it could not load.
 */
async function hydrateStoryFeedingRefs(charId, cycleId) {
  const [tplRes, prevRes] = await Promise.all([
    fetchStoryFeedingTemplates(),
    fetchStoryPrevious(charId, cycleId),
  ]);
  storyTemplatesOk = !!tplRes.ok;
  storyTemplates = tplRes.ok ? normaliseTemplates(tplRes.data) : [];
  storyRecall = prevRes.ok ? feedingPoolRecall(prevRes.data) : null;
}

/**
 * Seed the working selection from what TM Story already holds.
 *
 * `feedFrozen` is the whole workflow rule in one line (Angelus, 2026-09-11): a
 * genuinely declared method means the pool is frozen and no picker is ever
 * offered - only whatever is still outstanding.
 */
function initFeedSelection() {
  const d = normaliseStoryDeclaration(storyFeedRaw);
  // A genuinely declared method freezes the pool. So does an existing roll, even
  // on the (data-damaged) submission whose method somehow reads blank: once the
  // dice are cast there is no declaration left to make, and offering a picker
  // then would invite a write the endpoint would refuse anyway (AC 4, one roll
  // only).
  feedFrozen = d.method !== '' || isUsableStoryRoll(storyFeedRaw);
  feedSel = {
    method: d.method,
    poolAttr: d.poolAttr,
    poolSkill: d.poolSkill,
    poolDisc: d.poolDisc,
    poolSpecChip: d.poolSpecChip,
    bloodType: d.bloodType,
    violence: d.violence,
    poolLocked: d.poolLocked,
    territory: d.territory,
  };
  feedVesselsCommitted = d.vesselsDeclared;
  // Story 12.8 (AC 9b): the write-once latch. Either half of the declaration
  // being on file means the player has already had their one save - see the
  // flag's own comment at the top of this file for why the vessel array alone
  // is not a sufficient test.
  feedDeclCommitted = d.vesselsDeclared || d.aggHealed > 0;
  feedVesselDraft = null;
  feedAggDraft = d.aggHealed;
  feedRollConfirming = false;
}

/** The roll gate, evaluated against the current selection (AC 14). */
function currentRollGate() {
  if (!feedSel) return { available: false, reason: 'loading your declaration.' };
  return feedingRollGate({
    hasMethod: templateForMethod(storyTemplates, feedSel.method) != null,
    isCustom: isCustomApproach(feedSel.method),
    recalled: !!feedSel.poolLocked,
    violence: feedSel.violence,
  });
}

/**
 * Trait picks only - never a total, never dice (AC 2).
 *
 * LIVE BUG FIX, 2026-09-14 (reported by a real player, Edgar Black, via Discord DM: "Unknown
 * field not permitted on this endpoint: bloodType" on every attempt to roll). `bloodType` and
 * `poolLocked` were being sent here but TM Story's own
 * `downtimeSubmissionFeedingRollRequestSchema` (`additionalProperties: false`) never allowed
 * either, and the route handler never reads `body.bloodType`/`body.poolLocked` at all -- its own
 * comment at the atomic-write guard states outright that "description, bloodType, vesselVitae,
 * aggHealed and poolLocked are the player's and are not this route's to rewrite". `poolLocked` is
 * independently re-derived server-side from the STORED submission (`storedFeeding?.poolLocked`),
 * never from the request body, so sending it here was always redundant. Neither field was being
 * persisted anywhere else in this click-to-roll flow either (the Blood Type/`data-feed-bt`
 * handler only updates local state, no separate save call) -- removing them here loses no working
 * behaviour, it only stops every roll attempt 400ing.
 */
function rollRequestBody() {
  return {
    method: feedSel.method,
    poolAttr: feedSel.poolAttr,
    poolSkill: feedSel.poolSkill,
    poolDisc: feedSel.poolDisc,
    poolSpecChip: feedSel.poolSpecChip,
    violence: feedSel.violence,
    ...(feedSel.territory ? { territory: feedSel.territory } : {}),
  };
}

/** How a stored method reads back to a human (`sections/feeding.js:96-101`). */
function feedMethodLabel(methodKey) {
  if (isCustomApproach(methodKey)) return 'My own approach';
  if (!methodKey) return 'Not recorded.';
  const t = templateForMethod(storyTemplates, methodKey);
  return t ? t.name : 'A method no longer offered';
}

// ── the pool builder (pool-builder.js:84-216, recall + suggestions branches) ──

/**
 * `lock` is 'recall' or 'template'. `frozen` additionally disables every control
 * including the chips, which is what a declaration already on file looks like -
 * TM Story never needs that mode because its own form is still editable at the
 * point it renders this.
 */
function feedPoolBuilderHtml({ lock, suggestions, frozen }) {
  const c = currentChar;
  const dots = feedDots(c);
  const specs = feedSpecsMap(c);
  const discs = feedDiscNames(c);
  const state = {
    attr: feedSel.poolAttr, skill: feedSel.poolSkill,
    disc: feedSel.poolDisc, specChip: feedSel.poolSpecChip,
  };
  const total = feedEffectivePool();
  const dotLabel = t => `${esc(t)} (${dots[t] || 0})`;
  // A stored value the current list no longer offers is PREPENDED rather than
  // silently rendering as the blank placeholder while still travelling into the
  // request (pool-builder.js's own `keepUnlisted`, which Feeding always passes).
  const withCurrent = (list, cur) => (cur && !list.includes(cur) ? [cur, ...list] : list);
  // Every select in both ported branches is disabled: 'recall' disables them by
  // definition, and 'template' disables them because the chips are the only
  // intended input (pool-builder.js:155).
  const sel = (list, cur, key, ph) => `<select class="qf-select" data-pb="${esc(key)}" disabled>`
    + `<option value="">${esc(ph)}</option>`
    + withCurrent(list, cur).map(t => `<option value="${esc(t)}" ${t === cur ? 'selected' : ''}>${dotLabel(t)}</option>`).join('')
    + '</select>';
  const specChips = () => {
    const sk = specs[state.skill] || [];
    if (!sk.length) return `<div class="dt-pool-row"><span class="dt-feed-spec-none">No specialisations on ${esc(state.skill || 'this skill')}.</span></div>`;
    return `<div class="dt-pool-row">${sk.map(sp =>
      `<button type="button" class="chip chip--suggest ${state.specChip === sp ? 'chip--on' : ''}" data-pb-spec="${esc(sp)}"${frozen ? ' disabled' : ''}>${esc(state.skill)} (${esc(sp)})</button>`
    ).join('')}</div>`;
  };

  if (lock === 'recall') {
    return '<div class="dt-pool-row">'
      + sel(ALL_ATTRS, state.attr, 'attr', 'Attribute')
      + sel(ALL_SKILLS, state.skill, 'skill', 'Skill')
      + sel(discs, state.disc, 'disc', 'No Discipline')
      + `<span class="dt-pool-total">${total}</span></div>`
      + specChips()
      + `<div class="dt-pool-row"><span class="dt-pool-valid">${esc(frozen
        ? 'Pre-approved pool, locked from your downtime form'
        : 'Pre-approved pool, reused from last cycle')}</span></div>`;
  }

  // suggestions branch (`lock === 'template'`)
  const chip = (list, cur, key, extra = '') => list.map(t =>
    `<button type="button" class="chip chip--suggest ${extra} ${cur === t ? 'chip--on' : ''}" data-pb-${esc(key)}="${esc(t)}"${frozen ? ' disabled' : ''}>${dotLabel(t)}</button>`
  ).join('');
  const conf = conformance(state, suggestions);
  const line = conf === 'on-template'
    ? '<div class="dt-pool-row"><span class="dt-pool-valid">Pool matches the template</span></div>'
    : conf === 'custom'
      ? '<div class="dt-pool-row"><span class="dt-pool-review">Custom pool, make sure your approach supports it</span></div>'
      : '';
  // An EMPTY suggestion list must not leave a dangling separator with nothing
  // either side of it (pool-builder.js:163-173) - real templates legitimately
  // carry `discs: []`.
  const suggestRow = [
    chip(suggestions.attrs, state.attr, 'attr'),
    chip(suggestions.skills, state.skill, 'skill'),
    chip(suggestions.discs, state.disc, 'disc', 'dt-suggest-chip-disc'),
  ].filter(Boolean).join('<span class="dt-suggest-sep">/</span>');
  return '<div class="dt-pool-row">'
    + sel(ALL_ATTRS, state.attr, 'attr', 'Attribute')
    + sel(ALL_SKILLS, state.skill, 'skill', 'Skill')
    + `<span class="dt-pool-total">${total}</span></div>`
    + `<div class="dt-suggest-row"><span class="dt-suggest-label">Suggestions:</span> ${suggestRow}</div>${line}`;
}

/** Which of the three modes the pool is in (`feeding-reference.js:499-505`). */
function feedPoolMode() {
  const tpl = templateForMethod(storyTemplates, feedSel.method);
  const suggestions = tpl ? { attrs: tpl.attrs, skills: tpl.skills, discs: tpl.discs } : null;
  const lockInput = {
    recalled: !!feedSel.poolLocked,
    hasTemplate: tpl != null,
    isCustom: isCustomApproach(feedSel.method),
    offTemplate: conformance(
      { attr: feedSel.poolAttr, skill: feedSel.poolSkill, disc: feedSel.poolDisc },
      suggestions,
    ) === 'custom',
  };
  return { tpl, suggestions, mode: poolLockMode(lockInput) };
}

function renderFeedPool() {
  const { suggestions, mode } = feedPoolMode();
  // Nothing chosen yet and nothing frozen: there is no pool to show, and there
  // is deliberately no free builder to fall back to (AC 11).
  if (mode === 'open' && !feedFrozen) {
    return '<p class="qf-explainer">Pick a method above for a pre-approved pool.</p>';
  }
  // THE HINT COPY. The two locked sentences are TM Story's own, verbatim
  // (`poolHintCopy`, feeding-reference.js:520-537). Its 'open' sentences are
  // NOT reproduced: every one of them offers "Something else to build freely",
  // which this tab does not have and must never imply it has.
  const hint = mode === 'recall'
    ? 'Locked to your last approved pool. No ST review needed.'
    : "Locked to this method's own suggestions, pick from the chips below. No ST review needed.";
  let h = `<p class="qf-explainer">${esc(feedFrozen ? 'Locked from your downtime form. No ST review needed.' : hint)}</p>`;
  h += feedPoolBuilderHtml({
    // A frozen pool with no live template (a retired one, or a declared custom
    // approach) still has to SHOW what will be rolled, and the recall branch is
    // the one that renders all three selects.
    lock: mode === 'template' ? 'template' : 'recall',
    suggestions,
    frozen: feedFrozen,
  });
  return h;
}

// ── the method picker (sections/feeding.js:181-278, minus the custom card) ────

function renderFeedMethodPicker() {
  const card = (key, name, desc, extraClass = '') =>
    `<button type="button" class="dt-feed-card ${extraClass} ${key === feedSel.method && !feedSel.poolLocked ? 'dt-feed-sel' : ''}" data-feed-method="${esc(key)}"${feedBusy ? ' disabled' : ''}>`
    + `<span class="dt-feed-card-name">${esc(name)}</span>`
    + `<span class="dt-feed-card-desc">${esc(desc)}</span></button>`;

  let h = '<div class="dt-vitae-title">Choose your approach</div>';
  if (!storyTemplates.length) {
    h += `<div class="feeding-warning">${esc(storyTemplatesOk
      ? 'The downtime service is offering no feeding methods at the moment. Contact your Storyteller.'
      : 'Could not load the feeding methods from the downtime service. Reload the page to try again.')}</div>`;
    return h;
  }

  const recallDesc = storyRecall
    ? `${storyRecall.poolAttr} + ${storyRecall.poolSkill}${storyRecall.poolDisc ? ` + ${storyRecall.poolDisc}` : ''} (${storyRecall.label})`
    : 'No previous cycle pool to recall';
  h += '<div class="dt-feed-card-wrap">';
  h += `<div class="dt-feed-card-grid">${storyTemplates.map(t => card(t.key, t.name, t.desc)).join('')}</div>`;
  // Always visible, never hidden, just inert when there is nothing real to
  // recall - Angelus's own 2026-09-01 ruling, ported with the card.
  h += `<button type="button" class="dt-feed-card dt-feed-card-recall ${feedSel.poolLocked ? 'dt-feed-sel' : ''}" data-feed-method-recall-use${(storyRecall && !feedBusy) ? '' : ' disabled'}>`
    + '<span class="dt-feed-card-name">Same as Last Time</span>'
    + `<span class="dt-feed-card-desc">${esc(recallDesc)}</span></button>`;
  h += '</div>';
  // AC 11's own absence, said out loud rather than left as a silent gap. Written
  // with plain punctuation: the mockup's own wording carries an em-dash, which
  // this repo forbids in any player-facing string.
  h += '<div class="feeding-warning">There is no "Something else" option here. A genuinely custom pool needs Storyteller review, which this tab has no path for, so declare one in the downtime form instead. Pick a template above, or contact your Storyteller if none of them fit.</div>';
  return h;
}

// ── blood type + kiss-or-assault (sections/feeding.js:501-528) ────────────────

function renderFeedToggles() {
  // Nothing here is answerable once the dice are cast - blood type and violence
  // both fed into a pool that has already been rolled.
  if (storyFeeding?.rollResult) return '';
  // Blood type is only offered when nothing is on file: a frozen declaration
  // already answered it, and it is shown read-only with the pool instead.
  const showBlood = !feedFrozen;
  // Violence is offered whenever it is genuinely unanswered, frozen or not - an
  // unanswered question is "a choice not made", which the workflow rule says is
  // left to be completed. Without this a frozen declaration carrying no violence
  // (Stalking, Feral Hunt and friends have no default) would sit behind the
  // gate's "choose The Kiss or Assault above" with nothing above to choose.
  const showViolence = !feedFrozen || feedSel.violence == null;
  if (!showBlood && !showViolence) return '';

  let h = '';
  if (showBlood) {
    h += '<div class="dt-vitae-title">Blood Type</div>';
    h += `<div class="dt-feed-toggle-row">${['Animal', 'Human', 'Kindred'].map(t =>
      `<button type="button" class="dt-feed-vi-btn ${feedSel.bloodType === t ? 'dt-feed-vi-on' : ''}" data-feed-bt="${esc(t)}"${feedBusy ? ' disabled' : ''}>${esc(t)}</button>`
    ).join('')}</div>`;
  }
  if (showViolence) {
    h += '<div class="dt-vitae-title">Kiss or Assault</div>';
    h += `<div class="dt-feed-toggle-row">${['kiss', 'violent'].map(v =>
      `<button type="button" class="dt-feed-vi-btn ${feedSel.violence === v ? 'dt-feed-vi-on' : ''}" data-feed-vi="${esc(v)}"${feedBusy ? ' disabled' : ''}>${v === 'kiss' ? 'The Kiss' : 'Assault'}</button>`
    ).join('')}</div>`;
    h += `<p class="dt-feed-hint">${esc(feedSel.violence == null ? 'Choose one.' : 'Explicitly chosen.')}</p>`;
  }
  return h;
}

// ── the roll itself (sections/feeding.js:575-670) ─────────────────────────────

function renderFeedRollStatus() {
  // ORDER MATTERS, and it is deliberately the reverse of TM Story's own.
  // `sections/feeding.js:587` checks the gate first because its `rollResult` is
  // LOCAL state it may legitimately clear when the gate closes. Here the result
  // is TM Story's own stored record: it is the authoritative fact, and a gate
  // that happens to read closed (a declaration whose template was later retired,
  // say) must never hide a roll that really happened.
  const rr = storyFeeding?.rollResult || null;
  if (!rr) {
    const gate = currentRollGate();
    if (!gate.available) {
      return `<div class="feeding-warning">Feeding Roll not available yet - ${esc(gate.reason)}</div>`;
    }
  }
  if (rr) {
    const rolledRoteNote = rr.rote ? ' (Rote: rolled twice, kept the better result)' : '';
    const rolledNineAgainNote = rr.again === 9 ? ' (9-Again)' : rr.again === 8 ? ' (8-Again)' : '';
    const successNote = `${rr.successes} success${rr.successes === 1 ? '' : 'es'}`;
    const exceptionalNote = rr.exceptional ? ', exceptional' : '';
    const dramaticNote = rr.dramatic_failure ? ' - dramatic failure' : '';
    // A chance die only succeeds on a 10, never on "8 or higher" - TM Story's
    // own Codex fix, carried here rather than re-broken.
    const isHit = v => (rr.chance ? v === 10 : v >= 8);
    // `rr.pool` is null only when TM Story sent something that was not a
    // non-negative integer; the dice actually rolled are then the honest count.
    const poolShown = rr.pool === null ? rr.dice.length : rr.pool;
    return '<div class="feeding-ready">'
      + `<span class="feeding-pool-display">Rolled ${rr.chance ? 'a chance die' : `${poolShown} dice`}${rolledRoteNote}${rolledNineAgainNote} - <strong>${successNote}${exceptionalNote}</strong>${dramaticNote}.</span>`
      + renderDiceCols(diceColumns(rr.dice, rr.again), isHit)
      + '<button type="button" class="feeding-roll-btn" disabled>Already Rolled - one roll only</button>'
      + '</div>';
  }

  const pool = feedEffectivePool();
  const again = skNineAgain(currentChar, feedSel.poolSkill) ? 9 : 10;
  const nineAgainNote = again === 9 ? ' (9-Again)' : '';
  const poolLabel = pool > 0 ? `${pool} dice` : 'a chance die (pool is 0)';

  if (feedRollConfirming) {
    return '<div class="feeding-warning feeding-roll-confirm">'
      + `<strong>This is irreversible.</strong> You are about to commit to a Feeding Roll of ${esc(poolLabel)}${esc(nineAgainNote)}. You only get one roll.`
      + '<div class="feeding-roll-confirm-actions">'
      + `<button type="button" class="feeding-roll-btn" data-feeding-roll-confirm${feedBusy ? ' disabled' : ''}>${feedBusy ? 'Rolling…' : 'Confirm Roll'}</button>`
      + `<button type="button" class="qf-btn-ghost" data-feeding-roll-cancel${feedBusy ? ' disabled' : ''}>Cancel</button>`
      + '</div></div>';
  }

  // The pool figure is this app's own estimate; TM Story derives the real one at
  // roll time (AC 2). "Pre-approved, no ST review needed" is the gate's own
  // guarantee and is true whichever number it turns out to be.
  return '<div class="feeding-ready">'
    + `<span class="feeding-pool-display">Pool ready: ${esc(poolLabel)}${esc(nineAgainNote)}. Pre-approved, no ST review needed.</span>`
    + `<button type="button" class="feeding-roll-btn" data-feeding-roll${feedBusy ? ' disabled' : ''}>Roll Feeding</button>`
    + '</div>';
}

// ── vessel drain (sections/feeding.js:682-836) ────────────────────────────────

/**
 * Is there a resolved feed at all?
 *
 * Story 12.8 (AC 9b, data-lock #12, RULED by Angelus 2026-09-11: "match the
 * form"): the `rr.successes <= 0` term this used to carry is GONE. It was never
 * TM Story's gate for a resolved feed - `sections/feeding.js:875` is
 * `!!r && !r.chance && !r.dramatic_failure`, with no successes term at all, and
 * `renderFeedAggHealing()` in this very file already used that gate correctly.
 * The narrowed copy here made this tab disagree with both: on a zero-success
 * roll with a positive `vitaeProjection().net` (a genuinely live-reachable case -
 * territory ambience plus Herd/Flock can carry a real healing budget off a feed
 * that secured no vessel), TM Story's own form offers a healing panel and this
 * tab rendered nothing at all, not even Story 12.7's placeholder, because
 * `renderStoryFeedFlow()`'s own branch called this same narrowed gate.
 *
 * The VESSEL strip keeps its own separate successes check - see
 * `renderFeedVesselDrain()` below, which ports TM Story's genuinely different
 * vessel gate (`sections/feeding.js:689`) rather than sharing this one.
 */
function feedResolvedRoll() {
  const rr = storyFeeding?.rollResult || null;
  if (!rr || rr.chance || rr.dramatic_failure) return null;
  return rr;
}

/** The per-vessel draw currently on screen, and whether it can be edited. */
function feedVesselView() {
  const rr = feedResolvedRoll();
  if (!rr) return null;
  const animal = (storyFeeding?.bloodType || feedSel?.bloodType) === 'Animal';
  const committed = feedVesselsCommitted;
  if (!committed && !Array.isArray(feedVesselDraft)) {
    // One 7-box track per success, or a single shared pool for an animal feed.
    // Story 12.8: a feed that secured no successes has no vessels and no animal
    // pool either (`rr.successes * 3` is 0), so the draft is an empty array in
    // both shapes rather than a one-entry pool with nothing in it. That is what
    // travels to the declaration route for such a feed, and `normaliseVesselVitae`
    // (`TM Story/public/js/downtime-form/content-shape.js:355-360`) keeps `[]`
    // verbatim.
    feedVesselDraft = animal ? (rr.successes > 0 ? [0] : []) : new Array(Math.max(0, rr.successes)).fill(0);
  }
  const drawn = committed ? (storyFeeding?.vesselVitae || []) : feedVesselDraft;
  return { rr, animal, committed, drawn, editable: !committed && !feedBusy };
}

function renderFeedVesselDrain() {
  const view = feedVesselView();
  if (!view) return '';
  const { rr, animal, committed, drawn, editable } = view;
  // Story 12.8: TM Story's VESSEL gate genuinely does exclude a zero-success
  // roll (`sections/feeding.js:689`, `r.successes <= 0` - the same line that
  // clears `state.vesselVitae` for such a feed), unlike its healing gate at :875.
  // Porting both faithfully means the two disagree here, exactly as they do
  // there: no vessel strip below one success, but a healing panel still offered.
  if (!committed && rr.successes <= 0) return '';
  const total = drawn.reduce((a, b) => a + b, 0);

  // Animal blood: ONE shared pool of 3 Vitae per success, not one vessel per
  // success, and no Breaking Point risk at any amount (Angelus, 2026-09-01).
  //
  // LIVE BUG FIX, 2026-09-14 (reported by Angelus after watching Etsy's real feed): every box
  // here was coloured via `storyVitaeColourClass(b)` — the SAME green/amber/red scale the human
  // vessel track below uses to signal rising Breaking-Point/harm risk as ONE vessel is drained
  // past 2, then 4, Vitae. That scale has no meaning here: `b` is a position in a flat, risk-free
  // shared pool, not a single vessel's harm level, so a 9-Vitae animal draw painted its last three
  // boxes red — visually claiming an escalating danger the very sentence above it (and the real
  // mechanic) says does not exist. Every filled box is now uniformly `vd-c-green` ("safe"),
  // matching the copy: there is no risk tier to signal, at any pool size.
  if (animal) {
    const poolMax = rr.successes * 3;
    const v = Math.min(drawn[0] || 0, poolMax);
    let h = '<div class="dt-vitae-title">Animal Blood Pool - shared, no Breaking Point risk</div>';
    h += `<p class="qf-explainer">Animal blood does not shake a vampire's Humanity - feeding from an animal never triggers a Breaking Point, however much of the pool you draw. This feed yielded a pool of ${poolMax} Vitae (3 per success) to draw from freely.</p>`;
    h += '<div class="feeding-vessels-grid"><div class="vd-card">';
    h += '<div class="vd-card-head"><span>Animal Blood Pool</span></div>';
    h += '<div class="vd-boxes" data-vessel-idx="0">';
    for (let b = 1; b <= poolMax; b++) {
      const filled = b <= v ? ' vd-box-filled vd-c-green' : '';
      h += editable
        ? `<button type="button" class="vd-box${filled}" data-box="${b}" aria-label="${b} vitae"></button>`
        : `<span class="vd-box${filled}"></span>`;
    }
    h += `</div><div class="vd-vitae-count">${v} vitae drawn</div></div></div>`;
    h += `<div class="vd-summary">Total vitae drawn: <strong>${v}</strong></div>`;
    if (committed) h += '<div class="fvc-alloc-badge">✓ Vessel feed recorded</div>';
    return h;
  }

  let h = '<div class="dt-vitae-title">Vessels - feed from up to 7 Vitae each</div>';
  h += '<div class="feeding-vessels-grid">';
  for (let i = 0; i < drawn.length; i++) {
    const v = Math.max(0, Math.min(7, drawn[i] || 0));
    const tier = vesselHarmTier(v);
    h += '<div class="vd-card">';
    h += `<div class="vd-card-head"><span>Vessel ${i + 1}</span>${v ? `<span class="vd-tier ${tier.cls}">${esc(tier.label)}</span>` : ''}</div>`;
    h += `<div class="vd-boxes" data-vessel-idx="${i}">`;
    for (let b = 1; b <= 7; b++) {
      const filled = b <= v ? ` vd-box-filled ${storyVitaeColourClass(b)}` : '';
      h += editable
        ? `<button type="button" class="vd-box${filled}" data-box="${b}" aria-label="${b} vitae"></button>`
        : `<span class="vd-box${filled}"></span>`;
    }
    h += '</div>';
    h += `<div class="vd-vitae-count">${v} vitae drawn</div>`;
    h += '</div>';
  }
  h += '</div>';
  h += `<div class="vd-summary">Total vitae drawn: <strong>${total}</strong></div>`;
  if (committed) h += '<div class="fvc-alloc-badge">✓ Vessel feed recorded</div>';
  return h;
}

// ── aggravated healing (sections/feeding.js:857-927) ──────────────────────────

function renderFeedAggHealing() {
  const rr = storyFeeding?.rollResult || null;
  const resolved = !!rr && !rr.chance && !rr.dramatic_failure;
  if (!resolved) return '';
  const ts = trackerFigures();
  // Fail-closed: no readable tracker document means the real Aggravated count is
  // unknown, and a fabricated zero-box state would be worse than an honest gap.
  if (!ts || ts.aggravated <= 0) return '';

  const committed = feedDeclCommitted;
  const drawn = committed ? (storyFeeding?.vesselVitae || []) : (feedVesselDraft || []);
  // Story 12.8 (AC 9a): THE SERVER'S OWN DERIVED TOTAL WINS, whenever one has
  // been obtained. TM Story's real budget is the vessel draws PLUS
  // `vitaeProjection().net` (`sections/feeding.js:892`), and the declaration
  // route returns that figure in its response - so the moment a declaration has
  // been sent (or re-sent during reconciliation, `maybeReconcileFeed()` below)
  // this panel renders the number the server actually validated against.
  //
  // KNOWN NARROWING, and it now has a bounded life: BEFORE any declaration has
  // been sent there is no server figure to render, and this tab still has no
  // projection of its own, so the pre-save budget is the vessel draws alone.
  // Data-lock #13 is explicit that this is only a FLOOR while the projection net
  // is non-negative - the Barrens carries a real `ambienceMod` of -4
  // (`sections/feeding.js:886-891`), so a Barrens feed can offer healing the
  // server will refuse. That refusal is surfaced verbatim (`feedWriteFailureText`
  // passes TM Story's own message straight through), never swallowed, and the
  // panel redraws on the server's number afterwards. Porting
  // `vitaeProjection()`/`herdFlockDots()` here to close the pre-save gap is
  // explicitly out of scope for this story: one derivation, one owner.
  //
  // THE CONCRETE CONSEQUENCE, named rather than left to be discovered. Because
  // the pre-save budget is the vessel draws alone, a feed whose whole budget
  // comes from the projection net - a genuinely resolved ZERO-SUCCESS feed, the
  // case data-lock #6 names and AC 9b's ruling re-opens - renders this panel with
  // every box disabled: the client floor is 0, and this tab never offers a
  // control that would produce a declaration the server refuses (TM Story's own
  // convention, `sections/feeding.js:904-908`). Such a feed can still be SAVED,
  // and its Vitae still reaches the tracker off the server's own total; what a
  // player cannot do from this tab is spend it on healing. The downtime form,
  // which has the projection in front of it, can. Closing that properly needs
  // either a pre-save source for the server's figure or the projection ported
  // here, and the story rules the second out.
  const clientFloor = Math.max(0, drawn.reduce((a, b) => a + b, 0));
  const fedTotal = feedServerFedTotal === null ? clientFloor : feedServerFedTotal;
  let healed = committed ? (storyFeeding?.aggHealed || 0) : feedAggDraft;
  // Clamp down if the draw fell after some healing was already committed (the
  // boxes above let the total drop at any time while this panel is open).
  if (!committed && healed * 4 > fedTotal) {
    healed = Math.max(0, Math.floor(fedTotal / 4));
    feedAggDraft = healed;
  }
  if (healed > ts.aggravated) healed = ts.aggravated;
  const spent = healed * 4;
  const remaining = Math.max(0, fedTotal - spent);
  const editable = !committed && !feedBusy;

  let h = '<div class="dt-vitae-title">Heal Aggravated Damage</div>';
  h += '<p class="qf-explainer">4 Vitae heals 1 Aggravated damage box, spent from this cycle\'s own fed total only - it never carries over between cycles.</p>';
  h += '<div class="dt-agg-boxes">';
  for (let i = 1; i <= ts.aggravated; i++) {
    const isHealed = i <= healed;
    // An already-healed box is NEVER disabled: clicking it can only reduce the
    // commitment. A not-yet-healed box disables once committing up to it would
    // exceed the fed total.
    const disabled = !isHealed && i * 4 > fedTotal;
    h += editable
      ? `<button type="button" class="dt-agg-box ${isHealed ? 'dt-agg-box-healed' : ''}" data-agg-box="${i}"${disabled ? ' disabled' : ''} aria-label="Aggravated damage box ${i}, ${isHealed ? 'committed to heal - click to un-commit' : 'click to commit 4 Vitae to heal'}"></button>`
      : `<span class="dt-agg-box ${isHealed ? 'dt-agg-box-healed' : ''}"></span>`;
  }
  h += '</div>';
  h += `<div class="dt-agg-summary">${spent} of ${fedTotal} Vitae committed to healing, ${remaining} remaining</div>`;
  return h;
}

// ── the whole surface ─────────────────────────────────────────────────────────

function renderFeedNotice() {
  if (!feedNotice) return '';
  return `<div class="feeding-warning feeding-write-notice">${esc(feedNotice.text)}</div>`;
}

/**
 * Story 12.7's flow, for both `story-feed` and `rolled-from-form`.
 *
 * Angelus's own workflow rule, applied top to bottom: choices already made
 * render locked, choices not yet made render open, and everything still
 * outstanding opens TOGETHER rather than one panel per visit.
 */
function renderStoryFeedFlow(isST) {
  if (!feedSel) return '';
  const rr = storyFeeding?.rollResult || null;
  let h = '<div class="feeding-story-flow">';

  if (feedFrozen) {
    h += '<span class="lock-tag">🔒 Locked from downtime</span>';
    h += `<div class="dt-vitae-title">Your approach: ${esc(feedMethodLabel(feedSel.method))}</div>`;
    const where = feedSel.territory?.label ? `Hunting in ${feedSel.territory.label}` : 'Hunting';
    const blood = feedSel.bloodType ? `, ${feedSel.bloodType.toLowerCase()} blood` : '';
    const viol = feedSel.violence ? `, ${feedSel.violence === 'kiss' ? 'the Kiss' : 'Assault'}` : '';
    h += `<p class="qf-explainer">${esc(`${where}${blood}${viol}.`)}</p>`;
  } else {
    h += renderFeedMethodPicker();
  }

  h += renderFeedPool();
  h += renderFeedToggles();
  h += renderFeedRollStatus();

  // UN-GATED, Story 12.8 (AC 9b). Story 12.7 shipped a placeholder here reading
  // "arriving in a follow-up story (12.8)", because `doFeedingDeclaration()` had
  // been wired against a `POST .../feeding/declaration` route TM Story did not
  // serve - a guaranteed 404 on a player's own primary action. That route now
  // exists, so the interactive draft and its Save control are real. The
  // placeholder is gone rather than left dormant: a route with no reachable
  // client is the same shape of problem, one layer up.
  h += renderFeedVesselDrain();
  h += renderFeedAggHealing();
  h += renderFeedDeclareControl();

  h += '</div>';

  // The ST's Confirm Feed panel - the same single tracker_state write, over the
  // same figures. Story 12.8 (AC 14) adds one thing to it and nothing else: an
  // already-applied feed no longer renders a live Confirm control at all, in
  // either the render or the handler (see `renderStConfirmPanel`).
  if (isST && rr) {
    const committedVessels = feedVesselsCommitted ? (storyFeeding?.vesselVitae || []) : [];
    h += renderStConfirmPanel({
      stDefault: committedVessels.reduce((a, b) => a + b, 0),
      aggHealed: feedDeclCommitted ? (storyFeeding?.aggHealed || 0) : 0,
      formSourced: true,
    });
  }
  return h;
}

/**
 * Story 12.8 (AC 9b): the Save control the round-2 gate replaced.
 *
 * THE CONTROL WAS NEVER COMMITTED. Story 12.7's own commit (`5fdf096c`) left
 * only the orphaned listener binding (`wireStoryFeedEvents()`, the
 * `[data-feeding-declare]` line) with no element for it to find, so this is
 * authored rather than un-commented. It is NOT a port of a TM Story control,
 * because TM Story has none to port: its downtime form has no per-section save
 * at all (`sections/feeding.js`'s vessel and healing panels both just mutate
 * `state` and call `onChange()`; the whole form submits as one). The markup
 * therefore follows THIS file's own established precedent for exactly this
 * action - `#fvc-confirm`'s "Confirm Allocation" button, `qf-btn qf-btn-submit`
 * (:2276) - and the locked mockup
 * (`TM Admin/specs/mockups/tm-game-feeding-tab-parity/index.html`), which draws
 * the vessel and aggravated panels this control sits under but stops short of
 * any save affordance of its own.
 *
 * WRITE-ONCE, by ruling (Angelus, 2026-09-11, Open Question 6: "TM Game stays
 * write-once"). There is no edit control and no re-save: once a declaration is
 * on file for this cycle, this returns nothing at all, for ever. A correction is
 * made in TM Story's downtime form, which is still live.
 */
function renderFeedDeclareControl() {
  if (feedDeclarationLocked()) return '';
  const rr = feedResolvedRoll();
  if (!rr) return '';
  // Nothing to declare: no vessel track to draw from (a zero-success feed) and
  // no Aggravated damage to spend on either. An empty save is not an action.
  const view = feedVesselView();
  const hasVessels = !!view && view.drawn.length > 0;
  const ts = trackerFigures();
  const hasHealing = !!ts && ts.aggravated > 0;
  if (!hasVessels && !hasHealing) return '';
  return '<div class="feed-declare-row">'
    + `<button type="button" class="qf-btn qf-btn-submit" data-feeding-declare${feedBusy ? ' disabled' : ''}>`
    + `${feedBusy ? 'Saving…' : 'Save Vessel Feed'}</button>`
    + '<p class="feeding-state-detail">Saving records this feed once and applies it to your Vitae and Aggravated '
    + 'tracker straight away. It cannot be changed here afterwards, so use your downtime form if a correction is needed.</p>'
    + '</div>';
}

/**
 * Story 12.8 (AC 9b): is this cycle's feed already recorded?
 *
 * Three independent ways to be sure, because no single one covers every real
 * case:
 *   1. a stored declaration (either half - see `feedDeclCommitted`'s own comment
 *      for why the vessel array alone is not enough);
 *   2. the durable tracker marker already naming this cycle (AC 10), which is
 *      what an ST's own Confirm, or a reconciliation that has already run, leaves
 *      behind;
 *
 * A save IN FLIGHT is deliberately not a lock: the control stays rendered and
 * goes disabled ("Saving...") the way every other write affordance in this file
 * does, and `doFeedingDeclaration()`'s own `feedBusy` guard is what actually
 * stops a second write starting.
 *
 * A FAILED tracker read is deliberately NOT treated as "locked": the real state
 * is unknown, and refusing the control on unknown state would silently strand a
 * player who has genuinely not fed yet. The write path's own fail-closed
 * behaviour (AC 12, `maybeReconcileFeed()`) is where an unreadable tracker stops
 * things, not here.
 */
function feedDeclarationLocked() {
  if (feedDeclCommitted) return true;
  const ts = trackerFigures();
  if (ts && activeCycleId && ts.marker === activeCycleId) return true;
  return false;
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

  // Story 12.7: whatever the last write said, in every state - the residual
  // TM-Game-sourced states need it too, because their own roll affordance now
  // explains why it cannot save rather than silently dropping a result.
  h += renderFeedNotice();

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

    // Story 12.4: same treatment as the form-sourced state above. This roll's
    // `cols` are ALREADY column-shaped ({ r, ch }), so no regrouping is needed -
    // the old flat loop was throwing that structure away. No chance-die concept
    // exists on this path, so the hit test is the plain one.
    h += renderDiceCols(cols, v => v >= 8);

    // ── Vitae breakdown card ──
    h += renderVitaeTallyCard(vitateTally, vessels);

    if (dramaticFailure) {
      h += '<div class="feeding-dramatic">Dramatic failure \u2014 see your Storyteller at game before feeding.</div>';
    } else if (vessels === 0) {
      h += '<p class="feeding-no-vessels">No vessels secured this hunt.</p>';
    } else {
      const bonusVitae = vitateTally?.total_bonus ?? 0;
      const allocated = vitaeAllocation && vitaeAllocation.length === vessels;
      // \u2500\u2500 Story 12.4, AC 2: THE INTERACTION-VS-STYLE DECISION \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
      // DECIDED: port the STYLE, keep the control type. The already-allocated
      // (read-only) half becomes TM Story's real box strip, because a read-out
      // has no interaction to preserve; the still-editable half keeps TM Game's
      // own <select>, recomposed onto the same .vd-card chrome.
      //
      // Why, having read TM Story's own vessel-drain JS rather than guessing
      // from its CSS (public/js/downtime-form/sections/feeding.js:793-834): its
      // .vd-box IS genuinely click-driven, and with semantics a <select> does
      // not have - seven buttons per vessel, clicking box N sets the draw to N,
      // clicking the box that is already the top of the fill sets it to N-1.
      // Porting that interaction is NOT cheap here, because TM Game's editable
      // path carries a gate TM Story's has no equivalent of: `allFilled` in
      // updateVesselUI() below only enables #fvc-confirm once EVERY vessel has a
      // value, and `doConfirmAllocation` refuses a NaN. A box strip has no
      // "unset" state distinguishable from "set to 0" - TM Story never needs
      // one, having no confirm gate at all - so porting the interaction would
      // mean inventing that distinction, i.e. changing what the control does.
      // That is precisely what [[feedback_port-faithfully-not-redesign]]
      // ("colour/type/spacing/component only, never layout or control choice")
      // and this story's own "err toward the narrower reading" rule out.
      h += `<div class="feeding-vessels-grid" id="feeding-vessels-grid">`;
      for (let i = 0; i < vessels; i++) {
        if (allocated) {
          h += renderVesselCard(`Vessel ${i + 1}`, vitaeAllocation[i]);
        } else {
          h += `<div class="vd-card" data-vessel-idx="${i}">`;
          h += `<div class="vd-card-head"><span>Vessel ${i + 1}</span><span class="vd-tier" id="fvc-con-${i}"></span></div>`;
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
          h += `<div class="vd-vitae-count" id="fvc-count-${i}">Not yet allocated</div>`;
          h += '</div>';
        }
      }
      h += '</div>';
      if (allocated) {
        const vesselTotal = vitaeAllocation.reduce((a, b) => a + b, 0);
        const grandTotal  = vesselTotal + (vitateTally?.total_bonus ?? 0);
        if (vitateTally?.total_bonus) {
          h += `<div class="vd-summary">Vessel vitae: <strong>${vesselTotal}</strong> + Bonus: <strong>+${vitateTally.total_bonus}</strong> = <strong>${grandTotal}</strong> total</div>`;
        } else {
          h += `<div class="vd-summary">Total Vitae: <strong>${vesselTotal}</strong></div>`;
        }
        h += '<div class="fvc-alloc-badge">\u2713 Allocation recorded</div>';
      } else {
        if (bonusVitae) {
          h += `<div class="vd-summary">Vessel vitae: <span id="fvc-total-val">0</span> + Bonus: <strong>+${bonusVitae}</strong> = <span id="fvc-grand-val">${bonusVitae}</span> total</div>`;
        } else {
          h += `<div class="vd-summary">Total Vitae: <span id="fvc-total-val">0</span></div>`;
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

  // ── TM STORY OWNS THIS CYCLE (Epic 12, Stories 12.2 + 12.7) ──
  // One flow for both states: `story-feed` is "nothing rolled yet", and
  // `rolled-from-form` is "the roll exists" - and in either case the flow itself
  // decides, panel by panel, what is already settled and what is outstanding.
  if (feedingState === 'story-feed' || feedingState === 'rolled-from-form') {
    h += renderStoryFeedFlow(isST);
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

/**
 * Story 12.7: the ported surface's own wiring.
 *
 * Every listener is scoped to `.feeding-story-flow`, so nothing here can reach
 * the residual TM-Game-sourced states rendered beside it - they share several
 * class and data-attribute names (`.vd-box`, `.dt-agg-box`, `[data-feed-method]`)
 * and mean different things by them.
 *
 * The click behaviours are ported from `sections/feeding.js` (the method/recall
 * cards, :218-277) and `pool-builder.js` (the chips, :210-213), including their
 * own review-fix guards, which are called out individually below.
 */
function wireStoryFeedEvents() {
  const root = container.querySelector('.feeding-story-flow');
  if (!root || !feedSel) return;
  const redraw = () => { render(); };

  root.querySelectorAll('[data-feed-method]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (feedBusy) return;
      const key = btn.dataset.feedMethod;
      // Re-clicking the already-selected card is a no-op, NOT a silent wipe of
      // the pool just built (pool-builder's own code-review fix). Under a recall
      // lock the same click releases the lock and keeps the recalled values,
      // which is what taking ownership of that pool should mean.
      if (key === feedSel.method) {
        if (feedSel.poolLocked) { feedSel.poolLocked = false; redraw(); }
        return;
      }
      feedSel.method = key;
      // A method's own violence default only applies while the player has not
      // explicitly chosen one; `violencePreset` is TM Story's own flag for that,
      // and this tab's equivalent is "violence is still unset".
      if (feedSel.violence == null) feedSel.violence = violenceDefaultFor(storyTemplates, key);
      feedSel.poolAttr = '';
      feedSel.poolSkill = '';
      feedSel.poolDisc = '';
      feedSel.poolSpecChip = null;
      // THE ONLY PLACE THE LOCK IS EVER CLEARED: picking a card is the player
      // building a pool of their own, so a recalled pool's borrowed pre-approval
      // no longer describes what is on screen.
      feedSel.poolLocked = false;
      feedNotice = null;
      redraw();
    });
  });

  root.querySelector('[data-feed-method-recall-use]')?.addEventListener('click', () => {
    if (feedBusy || !storyRecall) return;
    // Already active: idempotent, matching the no-op guard the other cards use.
    if (feedSel.poolLocked) return;
    feedSel.method = storyRecall.method;
    feedSel.poolAttr = storyRecall.poolAttr;
    feedSel.poolSkill = storyRecall.poolSkill;
    feedSel.poolDisc = storyRecall.poolDisc;
    // A recalled method that resolves to a real template puts the pool into
    // TEMPLATE mode, which renders no specialisation chip at all - restoring the
    // chip there would be an invisible, un-toggleable +1.
    feedSel.poolSpecChip = templateForMethod(storyTemplates, storyRecall.method) ? null : storyRecall.poolSpecChip;
    feedSel.bloodType = storyRecall.bloodType;
    feedSel.violence = storyRecall.violence;
    // THE ONLY PLACE THE LOCK IS EVER SET. Recall is the stricter lock: the pool
    // is an already-approved answer being reused verbatim, not one rebuilt from
    // a template's suggestions.
    feedSel.poolLocked = true;
    feedNotice = null;
    redraw();
  });

  // Pool chips. `data-pb-skill` clears the specialisation, because a spec
  // belongs to the skill it was picked under (pool-builder.js:212).
  root.querySelectorAll('[data-pb-attr]').forEach(c => c.addEventListener('click', () => {
    if (feedBusy) return; feedSel.poolAttr = c.dataset.pbAttr; redraw();
  }));
  root.querySelectorAll('[data-pb-skill]').forEach(c => c.addEventListener('click', () => {
    if (feedBusy) return; feedSel.poolSkill = c.dataset.pbSkill; feedSel.poolSpecChip = null; redraw();
  }));
  root.querySelectorAll('[data-pb-disc]').forEach(c => c.addEventListener('click', () => {
    if (feedBusy) return; feedSel.poolDisc = c.dataset.pbDisc; redraw();
  }));
  root.querySelectorAll('[data-pb-spec]').forEach(c => c.addEventListener('click', () => {
    if (feedBusy) return;
    feedSel.poolSpecChip = feedSel.poolSpecChip === c.dataset.pbSpec ? null : c.dataset.pbSpec;
    redraw();
  }));

  root.querySelectorAll('[data-feed-bt]').forEach(b => b.addEventListener('click', () => {
    if (feedBusy) return; feedSel.bloodType = b.dataset.feedBt; redraw();
  }));
  root.querySelectorAll('[data-feed-vi]').forEach(b => b.addEventListener('click', () => {
    if (feedBusy) return; feedSel.violence = b.dataset.feedVi; redraw();
  }));

  // The two-step commit: Roll -> irreversible warning -> Confirm/Cancel.
  root.querySelector('[data-feeding-roll]')?.addEventListener('click', () => {
    if (feedBusy) return;
    feedRollConfirming = true;
    redraw();
  });
  root.querySelector('[data-feeding-roll-confirm]')?.addEventListener('click', doFeedingRoll);
  root.querySelector('[data-feeding-roll-cancel]')?.addEventListener('click', () => {
    if (feedBusy) return;
    feedRollConfirming = false;
    redraw();
  });

  // Vessel boxes: click box N to fill to N; click the current top box to drop to
  // N-1 (`sections/feeding.js:825-834`).
  root.querySelectorAll('.vd-boxes button.vd-box').forEach(btn => {
    btn.addEventListener('click', () => {
      if (feedBusy || !Array.isArray(feedVesselDraft)) return;
      const idx = Number(btn.closest('.vd-boxes')?.dataset.vesselIdx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= feedVesselDraft.length) return;
      const boxNum = Number(btn.dataset.box);
      const cur = feedVesselDraft[idx] || 0;
      feedVesselDraft[idx] = cur === boxNum ? boxNum - 1 : boxNum;
      redraw();
    });
  });

  // Aggravated boxes: the same fill-level idiom, deliberately mirroring the
  // vessel strip rather than independent per-box toggles.
  root.querySelectorAll('button[data-agg-box]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (feedBusy) return;
      const boxNum = Number(btn.dataset.aggBox);
      feedAggDraft = feedAggDraft === boxNum ? boxNum - 1 : boxNum;
      redraw();
    });
  });

  root.querySelector('[data-feeding-declare]')?.addEventListener('click', doFeedingDeclaration);
}

function wireEvents() {
  if (!container) return;

  wireStoryFeedEvents();

  // Generic method selection (the residual TM-Game-sourced picker only - scoped
  // to `.feeding-no-sub` so it can never catch the Story 12.7 picker's own
  // `data-feed-method` buttons, which live under `.feeding-story-flow` and mean
  // something entirely different).
  container.querySelectorAll('.feeding-no-sub [data-feed-method]').forEach(btn => {
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
  // Story 12.7 (AC 6): the residual TM-Game-sourced roll button. It used to roll
  // dice here and PUT the result to `tm_game.downtime_submissions` - a write that
  // has silently no-opped since Epic 8, losing the roll on the next refresh. That
  // is exactly the bug this story exists to remove, so the write is gone.
  //
  // The button is still RENDERED, because these states only happen when TM Story
  // could not be reached at all, and a tab that simply omits its own primary
  // control at that moment tells the player nothing. Clicking it now says what is
  // actually wrong and where the roll really lives.
  container.querySelector('#feeding-roll-btn')?.addEventListener('click', () => {
    feedNotice = {
      kind: 'error',
      text: 'Your feeding roll is recorded by the downtime service, and this tab could not reach it just now. '
        + 'Nothing has been rolled. Reload the page to try again, or roll in your downtime form.',
    };
    render();
  });

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
    // Story 12.8 (AC 14, Architecture "Round 2 corrections" #3): THE SECOND LOCK
    // ON THE SAME DOOR. Suppressing the button's render is not sufficient if the
    // handler itself remains reachable by any other route - the same standard
    // this handler already applies for `_confirmInFlight` just above. Before
    // this, a marker match skipped only the Aggravated half of the write (the
    // `aggHealed > 0 && ts.marker !== cycleSnapshot` branch below) and still
    // wrote `vitae`/`influence` unconditionally, which is precisely the
    // double-apply this story exists to close.
    //
    // Scoped to the form-sourced state for the same reason the render guard is:
    // the legacy tm_game-sourced panel is explicitly out of scope for this story.
    if (feedingState === 'rolled-from-form' && activeCycleId && ts.marker === activeCycleId) return;
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
    // Story 12.4: the live consequence badge is now the card head's own
    // .vd-tier, and the card carries a .vd-vitae-count line the way the form's
    // read-only cards do. Same two states as before (a value, or nothing chosen
    // yet) and the same `allFilled` gate - only the elements changed.
    const conEl = container.querySelector(`#fvc-con-${idx}`);
    const cntEl = container.querySelector(`#fvc-count-${idx}`);
    if (sel.value) {
      const v = parseInt(sel.value, 10);
      total += v;
      if (conEl) { conEl.textContent = fvcConseqText(v); conEl.className = `vd-tier ${fvcConseqClass(v)}`; }
      if (cntEl) cntEl.textContent = `${v} vitae drawn`;
    } else {
      allFilled = false;
      if (conEl) { conEl.textContent = ''; conEl.className = 'vd-tier'; }
      if (cntEl) cntEl.textContent = 'Not yet allocated';
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

/**
 * Story 12.7 (AC 6/AC 7): commit the roll to TM Story, then redraw from what TM
 * Story says is stored.
 *
 * The old body of this function rolled dice locally and wrote the result to
 * `PUT /api/downtime_submissions/:id` — a collection that has held nothing since
 * Epic 8, so the write silently no-opped and the roll vanished on refresh. Both
 * halves are gone.
 *
 * WHAT TRAVELS: trait picks only. Never a pool total, never dice, never a
 * signature. AC 2 rules that the route reads the real character, the relevant
 * territory and the submission's own project slots server-side and derives the
 * effective pool itself, then calls TM Story's own `rollPool()`.
 *
 * WHAT COMES BACK IS NOT TRUSTED AS FINAL (AC 7): the response is discarded and
 * the whole sub-document is re-read through `fetchStoryFeeding()`, so the tab
 * renders what is genuinely stored rather than what it hoped it had written.
 */
async function doFeedingRoll() {
  if (feedBusy || !currentChar || !activeCycleId || !feedSel) return;
  const gate = currentRollGate();
  if (!gate.available) return;

  feedBusy = true;
  feedNotice = null;
  render();

  const charSnapshot = currentChar;
  const cycleSnapshot = activeCycleId;
  const paneSnapshot = container;
  const res = await postStoryFeedingRoll(String(charSnapshot._id), cycleSnapshot, rollRequestBody());

  // A character switch, a cycle change or a re-mount while the POST was in
  // flight: the write still happened for the right character, but it must not
  // be applied to a view it was never about (the same snapshot discipline the
  // ST confirm handler already uses).
  if (currentChar !== charSnapshot || activeCycleId !== cycleSnapshot || container !== paneSnapshot) return;

  feedRollConfirming = false;
  if (!res.ok) {
    feedNotice = { kind: 'error', text: feedWriteFailureText(res, 'roll') };
    feedBusy = false;
    render();
    return;
  }

  await reloadStoryFeeding(charSnapshot, cycleSnapshot, paneSnapshot);
}

/**
 * Story 12.7: commit the vessel feed and the vitae heal together.
 *
 * One write, one sitting — Angelus's own ruling that once the roll exists both
 * open at the same time rather than being gated one at a time across separate
 * visits. Same no-optimism discipline as the roll: re-read afterwards.
 *
 * STORY 12.8 made this reachable (AC 9b - it had no button to fire it) and gave
 * it a second half: the declaration is applied to the character's own
 * `tracker_state` immediately afterwards, through the same `applyFeedToTracker()`
 * the load-time reconciliation uses. It is WRITE-ONCE - there is no path back
 * into this function for a cycle that already has a declaration on file.
 */
async function doFeedingDeclaration() {
  if (feedBusy || _feedApplyInFlight || !currentChar || !activeCycleId || !Array.isArray(feedVesselDraft)) return;
  // AC 12, fail-closed: the tracker application that follows this write needs
  // the character's real current Vitae and Aggravated. If the live read failed,
  // those are UNKNOWN, and a declaration saved now would land with no way to
  // apply it. Refuse the write and say so, rather than record a feed the tracker
  // will never reflect.
  const figures = trackerFigures();
  if (!figures) {
    feedNotice = { kind: 'error', text: FEED_TRACKER_UNREADABLE };
    render();
    return;
  }

  feedBusy = true;
  feedNotice = null;
  render();

  const charSnapshot = currentChar;
  const cycleSnapshot = activeCycleId;
  const paneSnapshot = container;
  // SNAPSHOTTED BEFORE THE AWAIT, with everything else: `feedVesselDraft` and
  // `feedAggDraft` are view state and are nulled by a character switch, so the
  // body the tracker application is told about must be the body that was
  // actually sent, not whatever the module holds when the response lands.
  const declBody = {
    vesselVitae: feedVesselDraft.map(v => Math.max(0, Math.trunc(Number(v) || 0))),
    aggHealed: Math.max(0, Math.trunc(Number(feedAggDraft) || 0)),
  };
  const res = await postStoryFeedingDeclaration(String(charSnapshot._id), cycleSnapshot, declBody);

  const stillCurrent = () =>
    currentChar === charSnapshot && activeCycleId === cycleSnapshot && container === paneSnapshot;

  if (!res.ok) {
    // A refusal belongs to the view that asked for it; a view that has moved on
    // has nothing to show it to. The write did not happen either way.
    if (!stillCurrent()) return;
    feedNotice = { kind: 'error', text: feedWriteFailureText(res, 'feed') };
    feedBusy = false;
    render();
    return;
  }

  // AC 9a: the server's own derived total, never a client re-derivation.
  const fedTotal = _strictNum(res.data?.fedTotal);
  if (stillCurrent() && fedTotal !== null) feedServerFedTotal = fedTotal;

  // AC 9 ("apply immediately as an optimisation, using the same underlying
  // function") and AC 11 (keyed by character id, UNCONDITIONAL on view state):
  // this runs before the stale-view check below on purpose. The guard that
  // follows protects the RENDER; it must not be allowed to skip the WORK.
  await applyFeedToTracker({
    charSnapshot, cycleSnapshot, paneSnapshot,
    fedTotal, aggHealed: declBody.aggHealed, figures,
  });

  if (!stillCurrent()) return;

  await reloadStoryFeeding(charSnapshot, cycleSnapshot, paneSnapshot);
}

/** The one sentence an unreadable tracker gets, wherever it is surfaced. */
const FEED_TRACKER_UNREADABLE = 'Your tracker could not be read just now, so this feed has not been applied to your '
  + 'Vitae and Aggravated. Nothing has been guessed at. Reload the page to try again.';

/**
 * Story 12.8 (AC 9/AC 10/AC 11/AC 13): apply one committed feed to the
 * character's real tracker_state, once.
 *
 * LIVE BUG FIX, 2026-09-14 (Angelus, after a real player's -- Etsy/Edgar Black's --
 * first feed under today's prep-phase gate fix landed on Vitae 10/10 instead of the
 * correct 9, re-derived exactly from the real fedTotal formula). THIS WAS A CLAMPED
 * DELTA-ADD; IT IS NOW A CLAMPED ABSOLUTE SET, on Angelus's own explicit, repeated
 * ruling: "Vitae does not carry over from game to game... it is always 0 before
 * feeding (or should be)... when a player confirms their feeding... this overwrites
 * the CURRENT vitae amount." The delta-add's own original reasoning (protecting
 * Vitae "legitimately" present before this write) rests on a premise this rule
 * rules out outright -- there is no legitimate prior Vitae to protect, because
 * Vitae is never supposed to be nonzero before a feed is confirmed. In practice the
 * delta-add let a stray prior write (the OLD ST-confirm panel below, or a stale
 * pre-Story-12.8 value never reset) get ADDED to rather than overwritten by this
 * one, compounding instead of correcting. `figures.vitae` (the pre-write read) is
 * no longer part of the Vitae formula at all -- see the calculation below.
 *
 * THE FIGURE. `fedTotal` is the server's own figure - the vessel draws plus
 * `vitaeProjection().net`. Healing is paid out of that same total at 4 Vitae per
 * box ("4 Vitae heals 1 Aggravated damage box, spent from this cycle's own fed
 * total only", the panel's own copy and TM Story's `sections/feeding.js:892-900`),
 * so what the character actually walks away with is the panel's own `remaining`
 * line: `fedTotal - aggHealed * 4`, SET as the character's new Vitae outright, not
 * added to whatever was there. Aggravated is unaffected by this rule (it genuinely
 * persists and accumulates within a cycle) and stays relative: it moves by the
 * boxes healed, floored at 0, exactly as the ST-confirm handler already computes it.
 *
 * Clamped on BOTH sides: here against `calcVitaeMax` so the tab never offers the
 * server an impossible number, and again server-side in
 * `server/routes/tracker.js` (AC 13) so the clamp is a boundary rather than a
 * courtesy.
 *
 * Everything it needs is passed in, already snapshotted by the caller. It reads
 * no view state and therefore cannot be invalidated by a character switch, a
 * cycle change or a re-mount mid-flight (AC 11).
 */
async function applyFeedToTracker({ charSnapshot, cycleSnapshot, paneSnapshot, fedTotal, aggHealed, figures }) {
  const charId = String(charSnapshot._id);
  if (fedTotal === null || fedTotal === undefined) {
    // The route answered without its own derived total (AC 9a), so there is no
    // trustworthy number to apply and this tab will not invent one. The marker
    // is NOT written, so the next tab load retries (AC 12's own retry model).
    console.error('[feeding] declaration response carried no fedTotal; tracker not applied');
    if (currentChar === charSnapshot && activeCycleId === cycleSnapshot && container === paneSnapshot) {
      feedNotice = {
        kind: 'error',
        text: 'Your feed was recorded, but the downtime service did not say how much Vitae it came to, so your '
          + 'tracker has not been changed. Reload the page to try again.',
      };
      render();
    }
    return { ok: false };
  }

  const spent = Math.max(0, aggHealed) * 4;
  // OVERWRITE, not add (see this function's own comment above): Vitae is always 0
  // before a feed, so the character's new Vitae IS this feed's net total, full
  // stop -- `figures.vitae` (whatever the tracker read before this write) never
  // enters this calculation.
  const newVitae = Math.max(0, Math.min(calcVitaeMax(charSnapshot), fedTotal - spent));
  const newAgg = Math.max(0, figures.aggravated - Math.max(0, aggHealed));

  // The marker rides the SAME write as the values it describes (AC 10): one
  // request, so there is no window in which the tracker has moved and nothing
  // records that it has.
  const body = { vitae: newVitae, [AGG_HEALED_MARKER]: cycleSnapshot };
  if (aggHealed > 0) body.aggravated = newAgg;

  // Independent re-verification follow-up (2026-09-11): `_feedingMarkerGuard`
  // makes this write CONDITIONAL at the database itself, not only on the
  // in-memory `figures.marker` check above - two near-simultaneous callers for
  // the same character (two open tabs, a retry racing the original request)
  // each read "marker absent" before either writes without this; with it, the
  // server refuses the second one rather than both applying `gained` on top of
  // each other. See `server/routes/tracker.js`'s own PUT handler for the other
  // half. Not sent as a real tracker_state field - the route strips it before
  // storing or whitelisting anything.
  const guardedBody = { ...body, _feedingMarkerGuard: cycleSnapshot };

  try {
    await apiPut('/api/tracker_state/' + charId, guardedBody);
  } catch (err) {
    // AC 12: never silent. No marker was written, so the next tab load tries
    // again by itself.
    console.error('[feeding] tracker apply failed:', err);
    if (currentChar === charSnapshot && activeCycleId === cycleSnapshot && container === paneSnapshot) {
      feedNotice = {
        kind: 'error',
        text: 'Your feed was recorded, but your Vitae and Aggravated tracker could not be updated just now. '
          + 'It will be applied automatically next time this tab loads.',
      };
      render();
    }
    return { ok: false };
  }

  // Everything from here is GLOBAL VIEW state - the same discipline the ST
  // confirm handler already applies (:2646-2651). The write above is keyed by
  // character id and is correct either way; only what is on screen is not.
  if (currentChar === charSnapshot && activeCycleId === cycleSnapshot && container === paneSnapshot) {
    trackerDoc = { ...(trackerDoc || {}), ...body };
    trackerLoad = 'ok';
  }
  // Keep tracker.js's in-memory cache in step so the live tracker card does not
  // go on showing the pre-feed numbers (same follow-up the confirm handler does).
  const raw = trackerReadRaw(charId);
  if (raw) {
    raw.vitae = newVitae;
    if (aggHealed > 0) raw.aggravated = newAgg;
  }
  return { ok: true, body };
}

/**
 * Story 12.8 (AC 9): the RECONCILIATION, run on every load of this tab.
 *
 * The application of a feed to the tracker is not a one-shot tied to a single
 * button click. A declaration write can succeed with the tab closed, the network
 * failing, or the character switched before the tracker write fires - and, far
 * more commonly, a player can record the whole feed in TM Story's own downtime
 * form (still live, `FORM_RETIRED = false`) and never open this tab to click
 * anything at all. The durable marker (AC 10) is the source of truth for "has
 * this cycle's feed been applied yet"; if a committed declaration exists and the
 * marker is absent or names another cycle, this applies it.
 *
 * PRECONDITION (AC 9c, RULED by Angelus 2026-09-11: "seed the marker now"): an
 * absent marker means "never applied" only because a one-time migration has
 * already marked every character whose current-cycle declaration an ST had
 * hand-confirmed before this shipped. Those feeds are correct in tracker_state
 * and carry no marker of their own, because the ST-confirm handler only ever
 * attached one inside its `aggHealed > 0` branch (data-lock #9/#11). That
 * migration is a separate piece of work and is not run from here.
 *
 * AC 9a: the total applied is the SERVER'S. Nothing stores `fedTotal` - TM Story
 * derives it at render time (`sections/feeding.js:892`) and keeps no copy - so
 * for a declaration this tab did not itself just save, the only way to obtain
 * the server's own figure is to re-send the stored declaration verbatim. AC 2
 * makes that route a full-value REPLACE and AC 3 rules that a re-save accepts the
 * stored array's own length, so re-sending what is already stored is a no-op
 * write that answers with the derived total. It happens at most once per
 * character per cycle, because it only runs while the marker is absent.
 */
async function maybeReconcileFeed(charSnapshot, cycleSnapshot, paneSnapshot) {
  if (_feedApplyInFlight || feedBusy) return;
  if (!charSnapshot || !cycleSnapshot) return;

  const d = normaliseStoryDeclaration(storyFeedRaw);
  if (!d.vesselsDeclared && d.aggHealed <= 0) return; // nothing committed to apply

  // AC 12: FAIL-CLOSED AND SURFACED. A failed live read means the real Vitae and
  // Aggravated are unknown; there is no panel to withhold behind on an automatic
  // path, so the state is said out loud and retried on the next load.
  const figures = trackerFigures();
  if (!figures) {
    console.error('[feeding] tracker_state unreadable; feed not applied for', String(charSnapshot._id));
    if (currentChar === charSnapshot && activeCycleId === cycleSnapshot && container === paneSnapshot) {
      feedNotice = { kind: 'error', text: FEED_TRACKER_UNREADABLE };
      render();
    }
    return;
  }

  // AC 10: ONE marker for both components. Already applied for this cycle means
  // applied, Vitae included - not "the Aggravated half is done".
  if (figures.marker === cycleSnapshot) return;

  // The stored declaration, re-sent verbatim. Coerced through the same boundary
  // check every other TM Story value on this tab goes through, but WITHOUT
  // dropping entries: the array's own length is part of what AC 3 validates, so
  // an unreadable entry becomes 0 rather than shortening the array. Real stored
  // data cannot contain one - `normaliseVesselVitae` collapses a malformed array
  // to `[]` on the way in - so this is a boundary guarantee, not a repair.
  const vesselVitae = (Array.isArray(storyFeedRaw?.vesselVitae) ? storyFeedRaw.vesselVitae : [])
    .map(v => _vesselVitae(v) ?? 0);
  const aggHealed = d.aggHealed;

  _feedApplyInFlight = true;
  try {
    const res = await postStoryFeedingDeclaration(String(charSnapshot._id), cycleSnapshot, { vesselVitae, aggHealed });
    if (!res.ok) {
      console.error('[feeding] could not re-derive fedTotal for reconciliation:', res.reason, res.detail || '');
      if (currentChar === charSnapshot && activeCycleId === cycleSnapshot && container === paneSnapshot) {
        feedNotice = {
          kind: 'error',
          text: 'Your recorded feed has not been applied to your Vitae and Aggravated yet, because the downtime '
            + 'service could not be reached to confirm the total. It will be applied automatically next time this '
            + 'tab loads.',
        };
        render();
      }
      return;
    }
    const fedTotal = _strictNum(res.data?.fedTotal);
    if (fedTotal !== null
      && currentChar === charSnapshot && activeCycleId === cycleSnapshot && container === paneSnapshot) {
      feedServerFedTotal = fedTotal;
    }
    const applied = await applyFeedToTracker({
      charSnapshot, cycleSnapshot, paneSnapshot, fedTotal, aggHealed, figures,
    });
    if (applied.ok
      && currentChar === charSnapshot && activeCycleId === cycleSnapshot && container === paneSnapshot) {
      render();
    }
  } finally {
    _feedApplyInFlight = false;
  }
}

/**
 * Re-read the feeding sub-document and redraw from it (AC 7).
 *
 * Shared by both writes above. A failed RE-READ after a successful write is not
 * a failed write, and is not reported as one: the tab says plainly that the save
 * went through but the refreshed view could not be fetched.
 */
async function reloadStoryFeeding(charSnapshot, cycleSnapshot, paneSnapshot) {
  const fresh = await fetchStoryFeeding(String(charSnapshot._id), cycleSnapshot);
  if (currentChar !== charSnapshot || activeCycleId !== cycleSnapshot || container !== paneSnapshot) return;

  feedBusy = false;
  if (!fresh.ok) {
    feedNotice = {
      kind: 'error',
      text: 'Saved, but the tab could not read your feeding back just now. Reload the page to see it.',
    };
    render();
    return;
  }

  // Same shape guard the first read uses: a 2xx whose body is not this route's
  // own shape is not evidence of anything, and must not be allowed to wipe the
  // declaration off the screen.
  const body = (fresh.data && typeof fresh.data === 'object' && !Array.isArray(fresh.data) && 'feeding' in fresh.data)
    ? fresh.data : null;
  if (!body) {
    feedNotice = {
      kind: 'error',
      text: 'Saved, but the tab could not read your feeding back just now. Reload the page to see it.',
    };
    render();
    return;
  }
  storyFeedRaw = body.feeding ?? null;
  storyTerritoryInfluence = body.territory_influence ?? null;
  if (isUsableStoryRoll(storyFeedRaw)) {
    storyFeeding = normaliseStoryFeeding(storyFeedRaw);
    feedingState = 'rolled-from-form';
  } else {
    storyFeeding = null;
    feedingState = 'story-feed';
  }
  initFeedSelection();
  render();
}

/** One sentence per real failure mode. Never a bare "something went wrong". */
function feedWriteFailureText(res, what) {
  // TM Story's own message, when it sent one, is the useful half of a refusal.
  if (res.detail) return res.detail;
  switch (res.reason) {
    case 'conflict':
      return 'This feeding has already been rolled. Reload the page to see the result.';
    case 'refused':
      return what === 'roll'
        ? 'The downtime service refused this pool. A genuinely custom pool can only be declared in the downtime form, where a Storyteller can rule on it.'
        : 'The downtime service refused this declaration.';
    case 'unauthorised':
      return 'Your login is not accepted by the downtime service. Sign out and back in, then try again.';
    case 'not-found':
      return 'The downtime service has no record to save this against. Contact your Storyteller.';
    case 'no-token':
      return 'You are not signed in. Sign in and try again.';
    case 'network':
      return 'Could not reach the downtime service. Nothing was saved. Check your connection and try again.';
    default:
      return 'The downtime service could not save this. Nothing was recorded. Try again in a moment.';
  }
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
