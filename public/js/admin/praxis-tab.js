/**
 * Praxis Claim board - the ST's live tap-to-assign board for Praxis night
 * (Epic PRAX, story prax.2).
 *
 * ═══ ST-ONLY, PERMANENTLY ═══
 *
 * Reached only through admin.html's existing ST-only sidebar and auth gate,
 * the same posture as every other admin domain, and every route it calls is
 * `requireRole('st')` server-side (see server/routes/praxis-sessions.js's own
 * header). There is deliberately NO extra client-side role check here: adding
 * one would imply this module could ever be mounted somewhere player-reachable,
 * which is exactly the thing the epic's locked ruling forbids.
 *
 * ═══ PURE CONSUMER ═══
 *
 * Every route used here shipped in prax.1 and is untouched by this story. This
 * module opens and withdraws claims, assigns and unassigns supporters, and
 * refetches on the `praxis_session` WS frame. It does not resolve a winner
 * (prax.4a/prax.4b own that) and never calls a resolve route, because none
 * exists yet.
 *
 * ═══ THE TALLY IS NEVER STORED ═══
 *
 * The board document persists only claims and support assignments. Every number
 * on screen is computed at render time from live character + territory data via
 * `calcCityStatus()`, never read off the document. `setStatusTerritories()` is
 * therefore primed from `/api/territories` BEFORE any tally is computed -
 * `calcCityStatus` resolves the regent-ambience component out of that
 * module-local store, so an unprimed store silently costs claimants their
 * regency bonus rather than failing loudly.
 *
 * ═══ DUAL TALLY (prax.3) ═══
 *
 * prax.3 delivered the parameterisation this file's constant-at-the-top design
 * was built for: the tally literal became `_activeTally` module state, switched
 * by the segmented control in the header, and every accessor and write action
 * below reads it rather than a fixed string. There is deliberately no second
 * board module - one component serves both tallies.
 *
 * The two tallies are NEVER coupled. A character may hold an open claim, or a
 * support assignment, in both at once - that is a supported state, not an
 * oversight (see prax.1's own POST /claims comment). The only cross-tally read
 * anywhere is cosmetic: the summary row's two leaders and the pool chips' two
 * dots, both computed against `_board.praxis` AND `_board.harpy` on every
 * render regardless of which tally is active.
 *
 * The two weightings are genuinely different, not a shared formula with a
 * parameter. Praxis is a City Status sum (claimant's own, plus every
 * supporter's). Harpy is a plain unweighted headcount of supporters assigned to
 * the claimant, with NO baseline for the claimant themselves: the epic's locked
 * ruling is that nothing auto-adds a Harpy claimant as their own first vote.
 * They can still be assigned to themselves through the ordinary support flow,
 * which then counts as one vote like anyone else's.
 *
 * ═══ RESOLVING THE HARPY TALLY (prax.4a) ═══
 *
 * prax.4a adds the ONE action that makes a result real: "Declare Winner" per
 * claimant card, and a board-level "Dismiss vote". Both call the single new
 * route, which performs the seat handover and freezes `resolved.harpy` in one
 * transaction. Once that field is set the Harpy tab's LIVE section (the pool
 * strip and the claimant cards) is replaced by a read-only summary, and the two
 * actions stop rendering - there is nothing left to assign.
 *
 * Three things about that, all deliberate:
 *
 *   - NO CONFIRM MODAL on either action, and NO UNDO. Locked at design-lock: a
 *     mistaken resolve is corrected by hand afterwards through the existing
 *     Court panel, not through a reversal path here. A real undo would have to
 *     precisely reverse the server's destroyed-XP counter, and a half-correct
 *     one would be worse than none. The toast is pure confirmation.
 *   - The OUTGOING holder is read from `_seats` BEFORE the write, because the
 *     response deliberately carries no seat or character data and by the time
 *     the toast is composed the seat has already changed hands.
 *   - Only the HARPY tally is resolvable through that flow. The Praxis tally
 *     has its own, below.
 *
 * ═══ RESOLVING THE PRAXIS TALLY (prax.4b) ═══
 *
 * prax.4b gives the Praxis tally the same two actions and one more component:
 * a CONFIRM MODAL between "Declare Winner" and the request.
 *
 * That is a deliberate departure from the Harpy flow above, not an
 * inconsistency. A Harpy resolve hands over ONE seat, and the person losing it
 * is standing in the room. A Praxis resolve mass-clears EVERY Enforcer,
 * Administrator and City Harpy seat at once - offices belonging to people who
 * are not watching this board and did not know it was about to happen. The
 * modal names each of them before anything is written; a mass-clear is never
 * pretended to be undoable, and there is no Undo here either.
 *
 * Three more things about it, all deliberate:
 *
 *   - THE CONFIRM LIST IS THE CAS BASELINE. The exact seat ids the modal
 *     displayed are sent back on the request, and the server re-verifies them
 *     against a live query inside its own transaction. A 409 from that check
 *     re-renders THIS SAME MODAL from the fresh list the error carries, rather
 *     than closing back to the board - the ST reviews what changed and can
 *     confirm again immediately.
 *   - The two resolve flows share `showToast` and `renderResolvedSummary`,
 *     parameterised by tally rather than duplicated. Everything that differs
 *     between them is a lookup in one of the TALLY_* maps at the top of this
 *     file.
 *   - The two tallies still never influence each other's render. A resolved
 *     Praxis tab and a live Harpy tab (or the reverse) is an ordinary state.
 */

import { apiGet, apiPost, apiPut, apiDelete, apiRaw } from '../data/api.js';
import { esc, displayName } from '../data/helpers.js';
import { calcCityStatus, setStatusTerritories } from '../data/accessors.js';
import { resolveHeldSeat } from '../data/office-seat-resolve.js';

/** The two tallies this one board carries, in the order the switch renders them. */
const TALLIES = ['praxis', 'harpy'];

/** How each tally is named in UI copy (the switch, the sheet). */
const TALLY_LABELS = { praxis: 'Praxis', harpy: 'People’s Harpy' };

/**
 * The unit a tally is counted in, for the small suffix on a claim card's
 * number: "19 STATUS" for the weighted Praxis sum, "3 VOTES" for the
 * unweighted Harpy headcount.
 */
const TALLY_UNIT_LABELS = { praxis: 'status', harpy: 'votes' };

/** The board title for each tally, per the locked mockup. */
const TALLY_TITLES = { praxis: 'Praxis Claim', harpy: 'People’s Harpy Vote' };

/** The short label each tally carries in the summary row. */
const TALLY_SUMMARY_LABELS = { praxis: 'Praxis leader', harpy: 'Harpy leader' };

/**
 * The seat label that makes a claimant's win vacate their current office.
 * Matched against `office_seats.seat_label`, not against `court_category`:
 * Socialite has TWO live seats ('Harpy' and "People's Harpy") whose holders'
 * character documents are indistinguishable, which is the whole reason the
 * office_seats collection exists (see server/schemas/office_seat.schema.js).
 */
const PEOPLES_HARPY_SEAT_LABEL = "People's Harpy";

/**
 * prax.4b: the APPOINTED Socialite seat, one of the three offices a Praxis win
 * mass-clears.
 *
 * `'City Harpy'`, NOT plain `'Harpy'` - renamed by prax.4b's own precondition
 * (`server/scripts/rename-city-harpy-seat.mjs`, plus the seed literal) so that
 * the mass-clear can tell Socialite's two seats apart by `seat_label` alone.
 * A THIRD copy of a seat-label literal in this codebase, deliberately, on the
 * same reasoning `PEOPLES_HARPY_SEAT_LABEL` above records: nothing exports a
 * constant across the client/server boundary here, and inventing a shared
 * module for one string is not warranted. It must stay in step with
 * `server/routes/praxis-sessions.js`'s own copy - the modal computes the set
 * the server is about to re-verify, and a drifted label would show the ST a
 * list the server then refuses.
 */
const CITY_HARPY_SEAT_LABEL = 'City Harpy';

/** The two office categories a Praxis win clears wholesale. Primogen and Head
 *  of State are deliberately absent - see the server route's own note. */
const MASS_CLEAR_CATEGORIES = ['Enforcer', 'Administrator'];

/** What a Praxis winner becomes. Used in copy only; the server writes it. */
const HEAD_OF_STATE_LABEL = 'Head of State';

/**
 * How long the resolve/dismiss toast stays up, in milliseconds.
 *
 * Nothing else dismisses it: no close button, no click-elsewhere, no Undo
 * (locked at design-lock). A mis-tap on the board underneath while the toast is
 * showing must not silently swallow the one confirmation the ST gets.
 */
const TOAST_MS = 6000;

/**
 * A chapter's declared phase, duplicated from cycle-views.js's own
 * `declaredPhase`/`declaresPhase` pair rather than imported. Small per-view
 * selection logic is kept local in this repo (cycle-views.js, downtime-views.js
 * and roll-feed.js all carry their own); a shared import for four lines of
 * filter-and-sort would couple this board to the Cycle tab's own evolution for
 * no gain. Deliberately NARROW, matching that file: no `status` fallback.
 */
const PHASES = ['game', 'downtime', 'processing', 'prep'];

/**
 * The 24-hex lower-case character id shape. Mirrors `SEAT_ID_PATTERN` as used by
 * server/routes/praxis-sessions.js's own `attendeePool()`, which filters the
 * attendance array by exactly this test after lower-casing. The two must agree:
 * an id this board offered but the server rejected would read to the ST as the
 * app losing a tap.
 */
const CHAR_ID_PATTERN = /^[a-f0-9]{24}$/;

// ── Module state ─────────────────────────────────────────────────────────────

let _rootEl = null;
// Flips true on the first initPraxisView call and never back. Guards the WS
// callback: before the domain has been opened there is nothing to paint into,
// the same reason roll-feed.js's own `_initialized` guard exists.
let _initialised = false;
let _wired = false;

let _charsById = new Map();
let _seats = [];
let _chapter = null;
let _session = null;      // the game_sessions doc linked to _chapter, or null
let _attendees = [];      // lower-cased character ids of everyone marked attended
let _board = null;        // the praxis_sessions doc, or null when none is open
let _sheetFor = null;     // character id the bottom sheet is open for, or null
let _status = '';         // transient status line under the header
let _loadError = '';
let _busy = false;
// Which tally the board is currently being worked against. Reset to 'praxis' on
// every initPraxisView call: the tab deliberately does NOT remember the
// last-viewed tally across a full domain re-entry.
let _activeTally = 'praxis';
// The resolve/dismiss toast lives on document.body, NOT inside `_rootEl`. Every
// render rebuilds that container's innerHTML from scratch, so a toast parented
// there would be destroyed by the very re-render it exists to confirm - and the
// re-render is guaranteed, because `write()` always refetches and repaints.
let _toastEl = null;
let _toastTimer = null;
/**
 * prax.4b: the Praxis confirm modal's own state, or null when it is closed.
 *
 * `{ claimantId, seats: [<office_seats doc-ish>], stale: <bool> }`. The `seats`
 * array is the exact list the ST is looking at AND the exact list sent back on
 * the request - the two must never diverge, which is why it is captured once
 * when the modal opens rather than recomputed on each render.
 *
 * `stale` flips true only after a server 409 has replaced `seats` with the
 * fresh list from the error body. It drives the warning row, and nothing else.
 */
let _confirm = null;

// ── Pure helpers (no DOM, no fetch - kept exported for direct coverage) ───────

/** Does this chapter document declare a phase? */
export function declaresPhase(ch) {
  const p = ch?.phase || ch?.game_phase || null;
  return !!p && PHASES.includes(p);
}

/**
 * A chapter with no declared phase is closed only once its projects phase has
 * been signed off - the one branch of `deriveCycleStatus`'s own 'closed'
 * determination that can still apply after `declaresPhase` has been checked
 * first (every `game_phase`-driven branch there implies a declared phase).
 */
export function isClosedChapter(ch) {
  return !!ch?.phase_signoff?.projects;
}

const byGameNumberDesc = (a, b) => (b?.game_number || 0) - (a?.game_number || 0);

/**
 * The chapter this board belongs to: the highest-game_number chapter carrying a
 * declared phase, else the highest-game_number chapter that is not closed.
 * `game_number` is THE ordering field - never `_id`/creation order, which is
 * proven wrong for game order in this data.
 */
export function resolveChapter(chapters) {
  const list = (Array.isArray(chapters) ? chapters : []).filter(Boolean);
  const phased = list.filter(declaresPhase).sort(byGameNumberDesc)[0];
  if (phased) return phased;
  return list.filter(ch => !isClosedChapter(ch)).sort(byGameNumberDesc)[0] || null;
}

/**
 * The attendee pool for a chapter, from the linked session's attendance array.
 *
 * A deliberate mirror of server/routes/praxis-sessions.js's `attendeePool()`,
 * down to the `attended === true` strict check, the lower-casing and the 24-hex
 * filter. Read that function before changing this one: a board that offered an
 * attendee the server's own check would reject shows the ST a chip whose every
 * tap fails.
 */
export function attendeeIdsFromSession(session) {
  return (session?.attendance || [])
    .filter(a => a && a.attended === true)
    .map(a => String(a?.character_id || '').toLowerCase())
    .filter(id => CHAR_ID_PATTERN.test(id));
}

/**
 * Who is still tappable in the pool strip: every attendee who is neither
 * already supporting somebody nor standing as a claimant themselves.
 *
 * Claimants are excluded as well as supporters. The locked mockup shows the
 * pool and the claimant list as disjoint, and a claimant left in the strip would
 * render on the board twice and offer a "open a claim" tap the server answers
 * with a 409.
 */
export function unassignedPool(attendeeIds, support, claims) {
  const assigned = new Set(Object.keys(support || {}).map(k => String(k).toLowerCase()));
  const standing = new Set((claims || [])
    .filter(Boolean)
    .map(c => String(c.character_id || '').toLowerCase()));
  return (attendeeIds || []).filter(id => !assigned.has(id) && !standing.has(id));
}

// ── Board accessors ──────────────────────────────────────────────────────────

/**
 * One tally's open claims. The tally argument defaults to the active one, so
 * every existing call site reads the tally on screen; the summary row and the
 * pool chips' dots are the only callers that pass the other one explicitly.
 */
function claims(tally = _activeTally) {
  return (_board?.[tally]?.claims || []).filter(Boolean);
}

/** One tally's support map, keyed supporter id -> claimant id. */
function support(tally = _activeTally) {
  return _board?.[tally]?.support || {};
}

/**
 * One tally's frozen resolve snapshot, or null while it is still live.
 *
 * prax.4b gave `resolved.praxis` its own writer, so this is now read for BOTH
 * tallies and the call sites below pass the ACTIVE one rather than naming
 * 'harpy' explicitly the way prax.4a's did. The two halves stay independent: a
 * resolved Praxis tab and a live Harpy tab (or the reverse) is an ordinary
 * state, and nothing here reads one tally's snapshot to decide anything about
 * the other.
 */
function resolvedFor(tally) {
  return _board?.resolved?.[tally] || null;
}

/**
 * prax.4b: every seat a Praxis win would vacate, computed from the seat array
 * already loaded at boot.
 *
 * A deliberate mirror of `server/routes/praxis-sessions.js`'s own
 * `massClearFilter()`, down to the two categories, the exact `'City Harpy'`
 * label match and the occupied-only filter. Read that function before changing
 * this one: this list is what the ST confirms and what the server then
 * re-verifies against its own live query, so a difference between the two shows
 * up as a 409 on a board that looked perfectly consistent.
 *
 * The People's Harpy seat is NEVER a member of this set. It is matched on the
 * OTHER label and gets its own note row in the modal, exactly as the server
 * gives it its own branch.
 *
 * Sorted by id so the array sent to the server has a stable order and the modal
 * does not reshuffle between renders.
 */
function massClearSeats() {
  return (_seats || [])
    .filter(seat => seat && seat.holder_id != null && (
      MASS_CLEAR_CATEGORIES.includes(seat.office_category)
      || (seat.office_category === 'Socialite' && String(seat.seat_label || '') === CITY_HARPY_SEAT_LABEL)
    ))
    .sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

/** The People's Harpy seat's current holder id, or null when it is vacant. */
function peoplesHarpyHolderId() {
  const seat = peoplesHarpySeat();
  return seat && seat.holder_id != null ? String(seat.holder_id).toLowerCase() : null;
}

/**
 * The Head of State seat's current holder id, or null when it is vacant or the
 * seat does not exist. Added during this story's own review (2026-08-30):
 * `resolve-praxis` hands this seat over unconditionally (server-side step 6b),
 * so the confirm modal's own vacate-list philosophy - never hide who this
 * resolution affects - applies to the sitting Head of State too, the same
 * reasoning that already covers the mass-clear and the winner's own held
 * seats.
 */
function headOfStateHolderId() {
  const seat = (_seats || []).find(s => s && s.office_category === 'Head of State') || null;
  return seat && seat.holder_id != null ? String(seat.holder_id).toLowerCase() : null;
}

/**
 * Does this character hold a Primogen seat right now?
 *
 * Read off `office_seats`, not off `court_category`: a Praxis winner who
 * already holds Head of State somewhere else would have Primogen hidden behind
 * their headline, which is precisely the drift prax.0's own derivation exists
 * to handle. The seat is the fact.
 */
function holdsPrimogenSeat(characterId) {
  const key = String(characterId || '').toLowerCase();
  return (_seats || []).some(seat => seat
    && seat.office_category === 'Primogen'
    && seat.holder_id != null
    && String(seat.holder_id).toLowerCase() === key);
}

/**
 * The People's Harpy seat, from the office_seats array already loaded at boot.
 *
 * Matched on `seat_label`, never on `court_category` alone: Socialite has TWO
 * live seats and resolving on the category would return whichever came first.
 * Used only to name the OUTGOING holder in the toast, which has to be read
 * BEFORE the write - the resolve response deliberately carries no seat data,
 * and afterwards the seat names the winner instead.
 */
function peoplesHarpySeat() {
  return (_seats || []).find(seat => seat
    && seat.office_category === 'Socialite'
    && String(seat.seat_label || '') === PEOPLES_HARPY_SEAT_LABEL) || null;
}

function charFor(id) {
  return _charsById.get(String(id || '').toLowerCase()) || null;
}

function nameFor(id) {
  const c = charFor(id);
  return c ? displayName(c) : String(id || 'Unknown');
}

/** City Status for one character, computed live. Zero for an unknown id. */
function statusFor(id) {
  const c = charFor(id);
  return c ? (calcCityStatus(c) || 0) : 0;
}

/**
 * A claimant's live tally in one tally, derived every render and never stored.
 *
 * The two weightings are deliberately NOT a shared formula:
 *
 * - Praxis: the claimant's own City Status plus that of every character
 *   currently assigned to support them.
 * - Harpy: a plain, unweighted headcount of the supporters assigned to them.
 *   No `calcCityStatus()` call anywhere on this path (the epic's locked ruling
 *   is "1 supporter = 1 vote"), and no baseline for the claimant themselves -
 *   nothing auto-adds a Harpy claimant as their own first vote. A claimant who
 *   IS assigned to themselves through the ordinary support flow is counted by
 *   the same loop as anybody else, which is why that case needs no special
 *   casing here.
 */
function tallyFor(claimantId, tally = _activeTally) {
  const key = String(claimantId).toLowerCase();

  if (tally === 'harpy') {
    return Object.values(support('harpy'))
      .filter(assignedTo => String(assignedTo).toLowerCase() === key)
      .length;
  }

  let total = statusFor(key);
  for (const [supporterId, assignedTo] of Object.entries(support(tally))) {
    if (String(assignedTo).toLowerCase() === key) total += statusFor(supporterId);
  }
  return total;
}

/** Everyone currently supporting this claimant, in a stable name order. */
function supportersOf(claimantId, tally = _activeTally) {
  const key = String(claimantId).toLowerCase();
  return Object.entries(support(tally))
    .filter(([, assignedTo]) => String(assignedTo).toLowerCase() === key)
    .map(([supporterId]) => String(supporterId).toLowerCase())
    .sort((a, b) => nameFor(a).localeCompare(nameFor(b)));
}

/**
 * The leading claimant in one tally, or null when that tally has no claims.
 *
 * Cosmetic only: this decides nothing. prax.4a/prax.4b's own resolve routes are
 * the only place a result becomes real, so the tie-break below is for DISPLAY
 * determinism and carries no implication about how a real tie would resolve -
 * highest tally wins, and an exact tie falls to the alphabetically first name.
 */
function leaderFor(tally) {
  let best = null;
  for (const claim of claims(tally)) {
    const id = String(claim.character_id || '').toLowerCase();
    if (!id) continue;
    const value = tallyFor(id, tally);
    const beatsOnTally = !best || value > best.value;
    const beatsOnName = best && value === best.value
      && nameFor(id).localeCompare(nameFor(best.id)) < 0;
    if (beatsOnTally || beatsOnName) best = { id, value };
  }
  return best;
}

/**
 * Does this attendee have ANY assignment in the given tally - standing as a
 * claimant, or assigned as somebody's supporter? Drives the pool chips' dual
 * dots, which are read across BOTH tallies whichever one is active.
 */
function hasAssignmentIn(tally, characterId) {
  const key = String(characterId || '').toLowerCase();
  if (claims(tally).some(c => String(c.character_id || '').toLowerCase() === key)) return true;
  return Object.keys(support(tally)).some(k => String(k).toLowerCase() === key);
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Called from admin.js's switchDomain when the Praxis domain activates.
 * Idempotent: a second visit refreshes the roster and refetches everything.
 *
 * @param {Array<object>} chars the admin app's already-loaded character roster.
 *   Reused rather than refetched - this is the same array switchDomain hands
 *   initCycleView and initRollFeed, and a second characters endpoint is exactly
 *   what AC8 rules out.
 */
export async function initPraxisView(chars) {
  _rootEl = document.getElementById('praxis-content');
  if (!_rootEl) return;

  _charsById = new Map((chars || [])
    .filter(Boolean)
    .map(c => [String(c._id).toLowerCase(), c]));

  _initialised = true;
  _sheetFor = null;
  // A fresh domain entry never resumes a half-finished confirmation: the list it
  // captured could be minutes old by now, and the whole point of that list is
  // that the ST just read it.
  _confirm = null;
  _status = '';
  // A fresh domain entry always lands on Praxis, never on the tally that
  // happened to be open last time.
  _activeTally = 'praxis';
  _wire();

  _rootEl.innerHTML = '<p class="placeholder">Loading…</p>';
  await loadAll();
  render();
}

/**
 * Called from admin.js's `onPraxisUpdate` WS callback with the board's own
 * session_id. No-ops until the domain has been opened at least once this
 * session, and ignores a frame for a DIFFERENT board than the one on screen.
 *
 * A frame that arrives while no board is loaded is NOT ignored: it most likely
 * means another ST just opened the board for this chapter, so the chapter-scoped
 * GET is re-run either way and the empty state resolves itself.
 */
export async function onPraxisUpdate(sessionId) {
  if (!_initialised || !_rootEl || !_chapter) return;
  if (_board && String(_board._id) !== String(sessionId)) return;
  await refetchBoard();
  render();
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadAll() {
  _loadError = '';
  _chapter = null;
  _session = null;
  _attendees = [];
  _board = null;

  let chapters, sessions, seats, territories;
  try {
    [chapters, sessions, seats, territories] = await Promise.all([
      apiGet('/api/chapters'),
      apiGet('/api/game_sessions'),
      apiGet('/api/office_seats').catch(() => []),
      apiGet('/api/territories').catch(() => null),
    ]);
  } catch (err) {
    _loadError = err?.message || 'Failed to load Praxis data.';
    return;
  }

  // Primed BEFORE any calcCityStatus() call below. A failed territories fetch
  // deliberately leaves the existing store alone (admin.js primes it at boot)
  // rather than wiping it to an empty list, which would silently drop every
  // regent's ambience bonus from the tally.
  if (Array.isArray(territories)) setStatusTerritories(territories);

  _seats = Array.isArray(seats) ? seats : [];
  _chapter = resolveChapter(chapters);
  if (!_chapter) return;

  _session = (Array.isArray(sessions) ? sessions : [])
    .find(s => s && s.chapter_id && String(s.chapter_id) === String(_chapter._id)) || null;
  _attendees = attendeeIdsFromSession(_session);

  await refetchBoard();
}

async function refetchBoard() {
  if (!_chapter) return;
  try {
    // prax.1's GET answers `null`, not a 404, when no board has been opened for
    // this chapter - the normal state on every chapter until an ST opens one.
    const doc = await apiGet(`/api/praxis_sessions?chapter_id=${encodeURIComponent(String(_chapter._id))}`);
    // Anything that is not a single board document is treated as "no board".
    // Without this an unexpected array (a mis-mounted route, a stub) renders as
    // a truthy, permanently claim-less board the ST cannot get past.
    _board = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : null;
  } catch (err) {
    _loadError = err?.message || 'Failed to load the Praxis board.';
  }
}

// ── Write actions ────────────────────────────────────────────────────────────

/**
 * Run one write, then re-read the board from the server and re-render.
 *
 * The refetch is not optional and must never become a local DOM patch: the
 * tally is derived from server state, so a locally-moved chip would show a
 * number the server does not agree with until the next reload.
 */
async function write(fn) {
  if (_busy) return;
  _busy = true;
  _status = '';
  try {
    await fn();
  } catch (err) {
    _status = err?.message || 'That change could not be saved.';
  } finally {
    _busy = false;
  }
  await refetchBoard();
  render();
}

/**
 * Open a board for this chapter.
 *
 * A 409 is NOT an error here. Two STs opening the board in the same instant is
 * an ordinary Praxis-night race, and prax.1 names the winner's id in the
 * response body precisely so the loser can fall straight through to a read. The
 * chapter-scoped GET below resolves both outcomes identically, so the race
 * loser sees the board rather than a failure they cannot act on.
 */
async function openBoard() {
  if (_busy || !_chapter) return;
  _busy = true;
  _status = '';
  try {
    const res = await apiRaw('POST', '/api/praxis_sessions', { chapter_id: String(_chapter._id) });
    if (!res.ok && res.status !== 409) {
      _status = res.body?.message || 'The board could not be opened.';
    }
  } catch (err) {
    _status = err?.message || 'The board could not be opened.';
  } finally {
    _busy = false;
  }
  await refetchBoard();
  render();
}

function openClaim(characterId) {
  if (!_board) return;
  _sheetFor = null;
  return write(() => apiPost(
    `/api/praxis_sessions/${encodeURIComponent(String(_board._id))}/claims`,
    { tally: _activeTally, character_id: characterId },
  ));
}

function assignSupport(supporterId, claimantId) {
  if (!_board) return;
  _sheetFor = null;
  return write(() => apiPut(
    `/api/praxis_sessions/${encodeURIComponent(String(_board._id))}/support`,
    // `claimant_character_id` is always present, never omitted - prax.1 treats
    // an absent key as a 400 and an explicit null as "return to the pool", and
    // the two must not be confusable.
    { tally: _activeTally, supporter_character_id: supporterId, claimant_character_id: claimantId },
  ));
}

function unassignSupport(supporterId) {
  if (!_board) return;
  return write(async () => {
    await apiPut(
      `/api/praxis_sessions/${encodeURIComponent(String(_board._id))}/support`,
      { tally: _activeTally, supporter_character_id: supporterId, claimant_character_id: null },
    );
    _status = `${nameFor(supporterId)} returned to the pool.`;
  });
}

/**
 * Withdraw a claim. No confirm modal, deliberately: this tool's established
 * ethos is two taps and no confirm, and a mis-tap is recoverable - the claim
 * can simply be reopened. The supporter cascade is server-side (prax.1 AC6);
 * this only reports how many the server released, because after the write
 * nothing records that count any more.
 */
function withdrawClaim(claimantId) {
  if (!_board) return;
  return write(async () => {
    const res = await apiDelete(
      `/api/praxis_sessions/${encodeURIComponent(String(_board._id))}`
      + `/claims/${encodeURIComponent(claimantId)}?tally=${encodeURIComponent(_activeTally)}`,
    );
    const n = Number(res?.supporters_released) || 0;
    _status = `Claim withdrawn. ${n} supporter${n === 1 ? '' : 's'} returned to the pool.`;
  });
}

// ── The resolve toast ────────────────────────────────────────────────────────

/**
 * Show the one-off confirmation toast, one line per entry.
 *
 * Message-only, with no action button: the locked "no Undo" decision means
 * there is nothing for the ST to press. It auto-dismisses after TOAST_MS and
 * nothing else dismisses it, deliberately - see that constant's own note.
 *
 * Built with createElement/textContent rather than an innerHTML string, unlike
 * the rest of this module. The board's markup is rebuilt wholesale on every
 * render so a template there is the readable choice; the toast is a single
 * long-lived node holding character names, and building it as nodes keeps those
 * names out of an HTML parse entirely.
 */
function showToast(lines) {
  if (typeof document === 'undefined' || !document.body) return;
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    // The locked class name is kept in the MARKUP; the stylesheet selects on
    // `.praxis-toast` instead, so a word as generic as "toast" is not claimed
    // globally. Same compromise prax.2's own CSS block made for `.sheet` and
    // `.claim-card`, which it kept in the markup and scoped in the selector.
    _toastEl.className = 'praxis-toast toast';
    _toastEl.setAttribute('role', 'status');
    document.body.appendChild(_toastEl);
  }
  const msg = document.createElement('span');
  msg.className = 'msg';
  lines.filter(Boolean).forEach((line, i) => {
    if (i > 0) msg.appendChild(document.createElement('br'));
    msg.appendChild(document.createTextNode(line));
  });
  _toastEl.replaceChildren(msg);
  _toastEl.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { if (_toastEl) _toastEl.classList.remove('on'); }, TOAST_MS);
}

// ── Resolving a tally (prax.4a: Harpy · prax.4b: Praxis) ─────────────────────

/**
 * The resolve route for one tally.
 *
 * Two genuinely different endpoints, not one parameterised route: a Harpy
 * resolve is a single-seat handover and a Praxis resolve is a mass-clear with a
 * confirm-list round-trip, so they validate different bodies and can fail in
 * different ways. Only the URL is selected here.
 */
const RESOLVE_PATHS = { harpy: 'resolve-harpy', praxis: 'resolve-praxis' };

const resolveUrl = (tally) =>
  `/api/praxis_sessions/${encodeURIComponent(String(_board._id))}/${RESOLVE_PATHS[tally]}`;

/**
 * Refresh the cached seat array after a handover.
 *
 * `_seats` is otherwise loaded once per domain entry, so without this the
 * Praxis tab's "People's Harpy - vacates on win" badge would keep naming the
 * OUTGOING holder for the rest of the session. A failure here is swallowed on
 * purpose: the resolve itself has already committed, and a stale badge is not
 * worth reporting as if the write had failed.
 */
async function refreshSeats() {
  try {
    const seats = await apiGet('/api/office_seats');
    if (Array.isArray(seats)) _seats = seats;
  } catch { /* keep the seats we have */ }
}

/**
 * prax.4a: declare a Harpy winner. No confirm modal and no undo, both locked at
 * design-lock.
 *
 * The outgoing holder is captured BEFORE the write for the toast's second line,
 * because the resolve response carries no seat data (the client already holds
 * every character, so resolving names server-side would duplicate `nameFor`)
 * and by the time it returns the seat names the winner.
 */
function declareHarpyWinner(claimantId) {
  if (!_board) return;
  const id = String(claimantId || '').toLowerCase();
  const outgoingId = peoplesHarpyHolderId();
  return write(async () => {
    await apiPost(resolveUrl('harpy'), { claimant_character_id: id });
    await refreshSeats();
    showToast([
      `${nameFor(id)} is now ${TALLY_LABELS.harpy}.`,
      // Omitted when the seat was vacant, and equally when the winner is the
      // sitting holder re-elected: "X vacated" directly under "X is now
      // People's Harpy" would be plainly wrong rather than merely redundant.
      outgoingId && outgoingId !== id ? `${nameFor(outgoingId)} vacated.` : null,
    ]);
  });
}

/**
 * Dismiss a vote with no winner, on either tally.
 *
 * NO confirm modal on this path, even on Praxis where declaring a winner has
 * one - design-lock item 1. Dismissing is the low-stakes half: no seat changes
 * hands, no manoeuvre XP is destroyed, and the tally is simply closed so it does
 * not sit open forever. The modal exists for the mass-clear, not for the act of
 * resolving as such.
 */
function dismissVote(tally) {
  if (!_board) return;
  return write(async () => {
    await apiPost(resolveUrl(tally), { claimant_character_id: null });
    showToast([`${TALLY_LABELS[tally]} vote dismissed. No winner recorded.`]);
  });
}

// ── The Praxis confirm modal (prax.4b) ───────────────────────────────────────

/**
 * Open the confirmation for a Praxis winner. Sends nothing.
 *
 * The vacate list is computed HERE, once, from the seat array already in hand,
 * and then held in `_confirm.seats` for as long as the modal is open. It is
 * both what the ST reads and what is sent back on the request - capturing it
 * once is what makes "the confirm list IS the CAS baseline" true rather than
 * merely intended. Recomputing it at Confirm time from a `_seats` array that a
 * WS refetch had quietly updated underneath would send a list the ST never saw.
 */
function openPraxisConfirm(claimantId) {
  if (!_board) return;
  const id = String(claimantId || '').toLowerCase();
  if (!id) return;
  _confirm = { claimantId: id, seats: massClearSeats(), stale: false };
  _status = '';
  render();
}

function closePraxisConfirm() {
  _confirm = null;
  render();
}

/**
 * Confirm the resolution: post the winner AND the exact seat ids the modal
 * displayed.
 *
 * ═══ THE 409 IS NOT A FAILURE STATE ═══
 *
 * A mismatch between the confirmed list and the server's own live query means
 * the board moved while the ST was reading. Design-lock item 5: the modal stays
 * OPEN, re-renders from the fresh list the error carries, and the ST can
 * confirm again immediately - no hard stop back to the live board, and no blind
 * retry of a list that is already known to be wrong.
 *
 * `apiRaw` rather than `apiPost` precisely so the 409's own body is readable;
 * `apiPost` would throw the message away with the payload that makes recovery
 * possible. `_seats` is refreshed alongside, so the note rows (Primogen kept,
 * People's Harpy vacated) are recomputed against the same fresh world.
 */
function confirmPraxisResolve() {
  if (!_board || !_confirm || _busy) return;
  const { claimantId, seats } = _confirm;
  const confirmedIds = seats.map(seat => String(seat._id).toLowerCase());
  const vacatedCount = seats.length;
  // Captured BEFORE the write, same reasoning declareHarpyWinner's own
  // outgoingId capture gives: refreshSeats() below will show the WINNER on
  // this seat afterwards, so the outgoing name has to be read now or not at
  // all. Added at review (2026-08-30) alongside the server's own Head of
  // State seat handover.
  const outgoingHosId = headOfStateHolderId();

  _busy = true;
  _status = '';
  return (async () => {
    let stale = null;
    try {
      const res = await apiRaw('POST', resolveUrl('praxis'), {
        claimant_character_id: claimantId,
        confirmed_vacate_seat_ids: confirmedIds,
      });
      if (res.ok) {
        _confirm = null;
      } else if (res.status === 409 && Array.isArray(res.body?.current_vacate)) {
        // The stale-list recovery. Rebuilt from the error body rather than from
        // a second fetch: this list is the one the server has just committed to
        // re-verifying against, so anything else could be stale again by the
        // time the ST taps.
        stale = res.body.current_vacate.map(row => ({
          _id: row.seat_id,
          office_category: row.office_category,
          seat_label: row.seat_label ?? null,
          holder_id: row.holder_id ?? null,
        }));
      } else {
        _status = res.body?.message || 'That resolution could not be saved.';
        _confirm = null;
      }
    } catch (err) {
      _status = err?.message || 'That resolution could not be saved.';
      _confirm = null;
    } finally {
      _busy = false;
    }

    if (stale) {
      _confirm = { claimantId, seats: stale, stale: true };
    } else if (!_status) {
      await refreshSeats();
      showToast([
        `${nameFor(claimantId)} is now ${HEAD_OF_STATE_LABEL}.`,
        // Named individually, unlike the mass-clear count below: there is at
        // most ONE outgoing Head of State, so naming them costs nothing and
        // matches Harpy's own single-name second line. Omitted when the seat
        // was vacant or the winner already held it (server-side no-op, added
        // at review 2026-08-30).
        outgoingHosId && outgoingHosId !== claimantId ? `${nameFor(outgoingHosId)} replaced as ${HEAD_OF_STATE_LABEL}.` : null,
        // A COUNT, not a list of names: a mass-clear can affect several people
        // at once, unlike Harpy's single-name second line. Omitted entirely when
        // nothing was vacated, rather than reading "0 offices vacated".
        vacatedCount ? `${vacatedCount} office${vacatedCount === 1 ? '' : 's'} vacated.` : null,
      ]);
    }

    await refetchBoard();
    render();
  })();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  if (!_rootEl) return;

  if (_loadError && !_chapter) {
    _rootEl.innerHTML = `<div class="praxis-board"><p class="pb-note">${esc(_loadError)}</p></div>`;
    return;
  }
  if (!_chapter) {
    _rootEl.innerHTML = '<div class="praxis-board"><p class="pb-note">'
      + 'No chapter to open a Praxis board against.</p></div>';
    return;
  }

  _rootEl.innerHTML = `<div class="praxis-board">${renderHead()}${
    _board ? renderPopulated() : renderEmpty()
  }</div>`;
}

function chapterCaption() {
  const parts = [];
  parts.push(_chapter.game_number != null
    ? `Chapter ${_chapter.game_number}`
    : (_chapter.label || 'Chapter'));
  if (_session?.session_date) parts.push(`${_session.session_date} session`);
  return parts.join(' · ');
}

/**
 * The header. Once a board exists the segmented control takes the slot the
 * standalone "Live" pill used to hold; the live dot itself moves into the
 * active tally's own summary-row label, where it says which of the two
 * contests the board below is currently working. That is the locked mockup's
 * arrangement, and it keeps the header to one control rather than two.
 */
function renderHead() {
  const status = _status ? `<div class="pb-status">${esc(_status)}</div>` : '';
  return `<div class="pb-head">
      <div><span class="pb-title">${esc(TALLY_TITLES[_activeTally])}</span><span class="pb-chapter">${esc(chapterCaption())}</span></div>
      ${_board ? renderTallySwitch() : ''}
    </div>${status}`;
}

/**
 * The Praxis / People's Harpy segmented control. Rendered only once a board
 * exists: `praxis_sessions` is ONE document holding both tallies, so before it
 * is opened there is genuinely nothing to switch between.
 */
function renderTallySwitch() {
  const buttons = TALLIES.map((t) => {
    const active = t === _activeTally;
    return `<button type="button" class="tally-switch-btn${active ? ' active' : ''}"`
      + ` data-praxis-action="switch-tally" data-tally="${esc(t)}"`
      + ` aria-pressed="${active ? 'true' : 'false'}">${esc(TALLY_LABELS[t])}</button>`;
  }).join('');
  return `<div class="tally-switch" role="group" aria-label="Which tally to work">${buttons}</div>`;
}

/**
 * Both contests' current leaders, side by side, regardless of which tally is
 * active below. Each half is computed against its OWN tally's claim list, so
 * the two halves are genuinely independent readings rather than two views of
 * the claimant list on screen.
 */
function renderSummary() {
  return `<div class="tally-summary">${TALLIES.map(renderSummaryItem).join('')}</div>`;
}

function renderSummaryItem(tally) {
  const live = tally === _activeTally
    ? '<span class="pb-live"><span class="dot"></span></span> '
    : '';
  const leader = leaderFor(tally);
  const body = leader
    ? `<span class="tally-summary-leader">${esc(nameFor(leader.id))}<span class="n">${esc(leader.value)}</span></span>`
    : '<span class="tally-summary-empty">No claims yet</span>';
  return `<div class="tally-summary-item" data-tally="${esc(tally)}">
      <span class="tally-summary-label">${live}${esc(TALLY_SUMMARY_LABELS[tally])}</span>
      ${body}
    </div>`;
}

/**
 * The empty state. Its one action opens the whole board - both tallies at once,
 * since they share a single document - so the button is deliberately
 * tally-agnostic rather than naming Praxis (prax.3's own copy correction to the
 * "Open Praxis Claim" prax.2 shipped).
 */
function renderEmpty() {
  return `<div class="pb-empty">
      <p>No ${esc(TALLY_LABELS[_activeTally])} board is open for this chapter yet.</p>
      <button type="button" class="btn-open" data-praxis-action="open-board">Open Board</button>
    </div>`;
}

/**
 * Are the two resolve actions live on the tally currently on screen?
 *
 * prax.4a scoped this to Harpy because Praxis had no writer; prax.4b gave it
 * one, so BOTH tallies offer the actions now and the only remaining condition is
 * that the tally on screen is still unresolved. That still matters: a resolved
 * board must never offer them again, because the route would 409 and the summary
 * below has already replaced everything they act on.
 */
function canResolveActive() {
  return !resolvedFor(_activeTally);
}

function renderPopulated() {
  // Once the tally ON SCREEN is resolved, its LIVE section is gone entirely: no
  // pool strip, no claimant cards, and therefore no bottom-sheet trigger left to
  // tap. The replacement is structural rather than a set of disabled controls,
  // so there is nothing to reach even by accident.
  //
  // The header and the summary row above are untouched, and so is the OTHER
  // tally: switching to it renders whatever state IT is independently in, live
  // or resolved. prax.4b widened this from Harpy-only to both tallies; the two
  // halves still never influence each other's render.
  const resolved = resolvedFor(_activeTally);
  if (resolved) return `${renderSummary()}${renderResolvedSummary(resolved, _activeTally)}`;

  const pool = unassignedPool(_attendees, support(), claims());
  const noSession = !_session
    ? '<p class="pb-note">No game session is linked to this chapter yet, so there is no attendee list to claim from.</p>'
    : '';

  return `${renderSummary()}${noSession}
    <div class="pool-label">Not yet assigned (tap to support or open a claim)</div>
    <div class="pool-strip">${pool.map(renderPoolChip).join('')}</div>
    <div class="claimants-label"><span class="pool-label pool-label--inline">Claimants</span>${
      canResolveActive()
        ? '<button type="button" class="dismiss-vote" data-praxis-action="dismiss-vote">Dismiss vote (no winner)</button>'
        : ''
    }</div>
    <div class="claimants">${
      claims().length
        ? claims().map(renderClaimCard).join('')
        : '<p class="pb-note">No claims open yet. Tap anyone above to open one.</p>'
    }</div>
    ${_sheetFor ? renderSheet() : ''}
    ${_confirm ? renderConfirmModal() : ''}`;
}

/**
 * A resolve date, in the British form the rest of this app writes dates in.
 * The locale is pinned rather than left to the browser: an ST on a US-locale
 * machine must not read 8/12/2026 where their colleague reads 12 Aug 2026.
 */
function resolvedDate(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The frozen result, replacing the live section on whichever tally is resolved.
 *
 * ONE component for both tallies (prax.4b), parameterised rather than
 * duplicated: everything that differs between them is a lookup in the TALLY_*
 * maps at the top of this file. The Praxis half reads "Head of State · 9 status
 * · 12 Aug 2026" where the Harpy half reads "People's Harpy · 3 votes · …" -
 * the same three slots, different words.
 *
 * Everything shown here comes from the SNAPSHOT, not from a recount: the winner
 * is named from the stored id and the number is the stored `final_tally`. That
 * is the whole point of freezing it - a later support edit, or a character
 * whose City Status changes months afterwards, must not move a historical
 * result.
 */
function renderResolvedSummary(resolved, tally) {
  const date = resolvedDate(resolved.resolved_at);
  // What the result is called in the summary line. Praxis is named by the OFFICE
  // won rather than by the contest ("Head of State", not "Praxis"), which is
  // what an ST reading the record months later actually wants to see.
  const label = tally === 'praxis' ? HEAD_OF_STATE_LABEL : TALLY_LABELS[tally];

  if (resolved.dismissed) {
    const meta = [label, date].filter(Boolean).join(' · ');
    return `<div class="resolved-summary abandoned">
        <div class="icon">Dismissed</div>
        <div class="winner-name">No winner declared</div>
        <div class="winner-tally">${esc(meta)}</div>
      </div>`;
  }

  const winnerId = String(resolved.winner_character_id || '').toLowerCase();
  const total = Number(resolved.final_tally) || 0;
  // The unit follows the tally's own weighting: Praxis is a City Status sum,
  // Harpy an unweighted headcount, and calling either by the other's name would
  // misdescribe the number beside it.
  const unit = tally === 'praxis'
    ? TALLY_UNIT_LABELS.praxis
    : `${total === 1 ? 'vote' : 'votes'}`;
  const meta = [label, `${total} ${unit}`, date].filter(Boolean).join(' · ');
  return `<div class="resolved-summary won">
      <div class="icon">Resolved</div>
      <div class="winner-name">${esc(nameFor(winnerId))}</div>
      <div class="winner-tally">${esc(meta)}</div>
    </div>`;
}

// ── The Praxis confirm modal's markup (prax.4b) ──────────────────────────────

/**
 * One row of the vacate list: who loses what.
 *
 * The winner's own row carries a small "· his own" / "· her own" suffix rather
 * than being hidden or moved into a note (design-lock item 2). The list is
 * honest about everybody it affects, the winner included.
 *
 * The gendered suffix reads `pronoun_possessive` off the character where one is
 * recorded and falls back to "their own" otherwise - a neutral fallback is
 * always correct English here, so a missing field costs nothing.
 */
function renderVacateRow(seat, winnerId) {
  const holderId = String(seat.holder_id || '').toLowerCase();
  const office = seat.office_category === 'Socialite' && String(seat.seat_label || '')
    ? String(seat.seat_label)
    : String(seat.office_category || '');
  const own = holderId && holderId === winnerId
    ? ` · ${possessiveFor(holderId)} own`
    : '';
  return `<div class="confirm-vacate-row">
      <span class="name">${esc(nameFor(holderId))}</span>
      <span class="office">${esc(office)}${esc(own)}</span>
    </div>`;
}

/**
 * A character's possessive pronoun, derived from the `pronouns` free-text field
 * (`character.schema.js`'s own nullable string, e.g. "she/her").
 *
 * Neutral fallback, always. A missing or unrecognised value yields "their",
 * which is correct English for every character in the game, so this can never
 * be wrong in a way that matters - it can only be less specific than it could
 * have been. That is why it does not warn, log or render a placeholder.
 *
 * "she" is tested first because \bhe\b cannot match inside "she" or "her"
 * anyway (no word boundary before the 'h', none after in "her"), but ordering it
 * this way makes the intent obvious rather than depending on that reading.
 */
function possessiveFor(characterId) {
  const raw = String(charFor(characterId)?.pronouns || '').toLowerCase();
  if (/\bshe\b/.test(raw)) return 'her';
  if (/\bhe\b/.test(raw)) return 'his';
  return 'their';
}

/**
 * The confirmation. The single highest-stakes screen on this board.
 *
 * Rendered from `_confirm.seats` and NOT from a fresh `massClearSeats()` call:
 * what is on screen must be exactly what is sent, or the phrase "the confirm
 * list is the CAS baseline" stops being true. The two note rows below are the
 * only things recomputed live, because they describe the winner rather than the
 * write set.
 */
function renderConfirmModal() {
  const winnerId = _confirm.claimantId;
  const seats = _confirm.seats || [];

  const stale = _confirm.stale
    ? '<div class="confirm-stale">This board changed since you opened this confirmation. '
      + 'Review the updated list below before confirming.</div>'
    : '';

  const list = seats.length
    ? `<div class="confirm-vacate-list">${seats.map(seat => renderVacateRow(seat, winnerId)).join('')}</div>`
    // Never a bare empty list: an ST tapping Confirm on blank space would have
    // no way to tell "nothing to vacate" from "the list failed to load".
    : '<div class="confirm-vacate-empty">Nobody &mdash; Enforcer, Administrator and '
      + 'City Harpy are all currently vacant.</div>';

  // Shown only when true. Each describes a consequence the vacate list above
  // cannot express: Primogen is NOT vacated (the seat survives, only the
  // headline moves), the People's Harpy seat IS vacated but by a different
  // mechanism, and the sitting Head of State (added at review) is replaced by
  // a mechanism of its own too - none of the three is a row in that list.
  const sittingHos = headOfStateHolderId();
  const notes = [
    holdsPrimogenSeat(winnerId)
      ? `Keeps ${esc(possessiveFor(winnerId))} own Primogen seat &mdash; the title changes to `
        + `${esc(HEAD_OF_STATE_LABEL)}, the seat itself is untouched.`
      : null,
    peoplesHarpyHolderId() === winnerId
      ? `${esc(possessiveFor(winnerId).replace(/^./, ch => ch.toUpperCase()))} own `
        + `${esc(TALLY_LABELS.harpy)} seat is vacated as part of this resolution.`
      : null,
    sittingHos && sittingHos !== winnerId
      ? `${esc(nameFor(sittingHos))} is replaced as ${esc(HEAD_OF_STATE_LABEL)}.`
      : null,
  ].filter(Boolean)
    .map(text => `<div class="confirm-note-row"><span class="dot"></span>${text}</div>`)
    .join('');

  return `<div class="confirm-modal-overlay" data-praxis-action="confirm-backdrop">
      <div class="confirm-modal-box" role="dialog" aria-modal="true" aria-label="Confirm Praxis resolution">
        <div class="panel-label">Confirm Praxis Resolution</div>
        <div class="confirm-headline"><span class="winner">${esc(nameFor(winnerId))}</span> will become ${esc(HEAD_OF_STATE_LABEL)}</div>
        <div class="confirm-sub">This cannot be undone from this screen. Review carefully before confirming.</div>
        ${stale}
        <div class="confirm-section-label">Offices vacated by this resolution${_confirm.stale ? ' (updated)' : ''}</div>
        ${list}
        ${notes}
        <div class="confirm-actions">
          <button type="button" class="confirm-cancel" data-praxis-action="confirm-cancel">Cancel</button>
          <button type="button" class="confirm-go" data-praxis-action="confirm-go">Confirm Resolve</button>
        </div>
      </div>
    </div>`;
}

function renderPoolChip(id) {
  return `<button type="button" class="char-chip" data-praxis-action="pool-chip" data-char-id="${esc(id)}">${esc(nameFor(id))}${renderChipDots(id)}</button>`;
}

/**
 * The dots on a pool chip: ONE dot per point of the attendee's EFFECTIVE City
 * Status (the same `statusFor` figure the Praxis tally sums; 2026-11-21 hot
 * patch, the chips used to show a fixed pair of assignment dots that read as
 * "2 status" for everyone). Colour carries the old assignment signal, read
 * across BOTH tallies whichever is active: crimson when this attendee has an
 * assignment in Praxis, else gold when they have one in Harpy, else dim. A
 * character assigned in both shows crimson (Praxis wins the one colour).
 */
function renderChipDots(id) {
  const n = Math.max(0, Math.min(10, statusFor(id)));
  const cls = hasAssignmentIn('praxis', id) ? ' on-praxis'
    : hasAssignmentIn('harpy', id) ? ' on-harpy' : '';
  const dots = `<span class="chip-dot${cls}"></span>`.repeat(n);
  return `<span class="chip-dots" role="img" aria-label="City Status ${n}" title="City Status ${n}">${dots}</span>`;
}

/**
 * The claimant's secondary badge, checked live against office data rather than
 * read off the board document. `resolveHeldSeat` is the shared, confirmed-only
 * holder resolution (oxp.7) - no second office lookup is hand-rolled here.
 *
 * PRAXIS ONLY, by its call site below. Both badges describe what happens if the
 * character wins PRAXIS: "keeps seat" and "vacates on win" are meaningless on
 * the Harpy tally, and showing them on a Harpy card would read as a claim about
 * that contest instead.
 */
function renderBadge(claimantId) {
  const c = charFor(claimantId);
  if (!c) return '';
  const seat = resolveHeldSeat(c, _seats);
  if (seat && String(seat.seat_label || '') === PEOPLES_HARPY_SEAT_LABEL) {
    return '<div class="claim-badge amber">People&rsquo;s Harpy &middot; vacates on win</div>';
  }
  if (c.court_category === 'Primogen') {
    return '<div class="claim-badge neutral">Primogen &middot; keeps seat</div>';
  }
  return '';
}

function renderClaimCard(claim) {
  const id = String(claim.character_id).toLowerCase();
  const supporters = supportersOf(id);
  return `<div class="claim-card" data-claimant-id="${esc(id)}">
      <div class="claim-head">
        <div>
          <div class="claim-name">${esc(nameFor(id))}</div>
          ${_activeTally === 'praxis' ? renderBadge(id) : ''}
        </div>
        <div class="claim-tally">${esc(tallyFor(id))}<span class="lbl">${esc(TALLY_UNIT_LABELS[_activeTally])}</span></div>
      </div>
      ${supporters.length
        ? `<div class="claim-supporters">${supporters.map(sid => renderSupportChip(sid)).join('')}</div>`
        : '<div class="claim-empty-supporters">No supporters yet.</div>'}
      <div class="claim-actions">
        ${canResolveActive()
          // The Praxis variant carries an extra class and is crimson rather than
          // gold (design-lock): the two buttons share a name but not a weight -
          // this one mass-clears three offices, Harpy's hands over one seat. It
          // also does NOT resolve on tap; it opens the confirmation.
          ? `<button type="button" class="claim-resolve${_activeTally === 'praxis' ? ' praxis' : ''}" data-praxis-action="declare-winner" data-claimant-id="${esc(id)}">Declare Winner</button>`
          : ''}
        <button type="button" class="claim-withdraw" data-praxis-action="withdraw" data-claimant-id="${esc(id)}">Withdraw claim</button>
      </div>
    </div>`;
}

function renderSupportChip(supporterId) {
  return `<span class="support-chip">${esc(nameFor(supporterId))}<button type="button" class="withdraw-x" data-praxis-action="unassign" data-char-id="${esc(supporterId)}" title="Return ${esc(nameFor(supporterId))} to the pool" aria-label="Return ${esc(nameFor(supporterId))} to the pool">&times;</button></span>`;
}

/**
 * The bottom sheet. ONE tap target and ONE sheet for both actions: opening a
 * claim for the tapped attendee is the first row, above the claimant list. The
 * epic doc never said how a claim opens; this is the locked answer, and a second
 * gesture must not be invented alongside it.
 */
function renderSheet() {
  const id = _sheetFor;
  const name = nameFor(id);
  const rows = claims()
    .map(c => String(c.character_id).toLowerCase())
    .map(cid => `<button type="button" class="sheet-row" data-praxis-action="assign" data-claimant-id="${esc(cid)}">
        <span class="n">${esc(nameFor(cid))}</span><span class="t">${esc(tallyFor(cid))} ${esc(TALLY_UNIT_LABELS[_activeTally])}</span>
      </button>`)
    .join('');

  return `<div class="sheet-overlay open" data-praxis-action="sheet-backdrop">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-title">Assign support &middot; ${esc(TALLY_LABELS[_activeTally])}</div>
        <div class="sheet-sub">${esc(name)}</div>
        <button type="button" class="sheet-action" data-praxis-action="open-claim" data-char-id="${esc(id)}">Open a ${esc(TALLY_LABELS[_activeTally])} claim for ${esc(name)} instead</button>
        <div class="sheet-section-lbl">Support a claimant</div>
        <div class="sheet-list">${rows || '<p class="sheet-empty">No claims are open yet.</p>'}</div>
        <button type="button" class="sheet-close" data-praxis-action="close-sheet">Cancel</button>
      </div>
    </div>`;
}

// ── Event wiring ─────────────────────────────────────────────────────────────

/**
 * One delegated listener on the domain container, attached once. Every render
 * rebuilds the container's innerHTML from scratch, so per-element listeners
 * would have to be re-bound on each pass; delegation survives the rebuild and
 * keeps the markup free of inline `onclick` handlers.
 */
function _wire() {
  if (_wired || !_rootEl) return;
  _wired = true;
  _rootEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-praxis-action]');
    if (!el || !_rootEl.contains(el)) return;
    const action = el.dataset.praxisAction;

    // Only a click on the scrim itself dismisses the sheet, never a click that
    // bubbled up from a control inside it.
    if (action === 'sheet-backdrop') {
      if (e.target !== el) return;
      _sheetFor = null;
      render();
      return;
    }
    if (action === 'close-sheet') { _sheetFor = null; render(); return; }
    // Switching tally re-renders in place from the already-loaded document,
    // which carries BOTH tallies - there is nothing new to fetch. Tapping the
    // already-active segment is a no-op: unlike the Cycle tab's phase buttons
    // there is no "neutral" state to toggle back to.
    if (action === 'switch-tally') {
      const next = el.dataset.tally;
      if (!TALLIES.includes(next) || next === _activeTally) return;
      _activeTally = next;
      _sheetFor = null;
      // Leaving the tally abandons its confirmation. The modal names a Praxis
      // winner and a Praxis vacate list; carrying it onto the Harpy tab would be
      // meaningless, and carrying it back later would offer a stale list.
      _confirm = null;
      _status = '';
      render();
      return;
    }
    if (action === 'open-board') { openBoard(); return; }
    if (action === 'pool-chip') { _sheetFor = el.dataset.charId; render(); return; }
    if (action === 'open-claim') { openClaim(el.dataset.charId); return; }
    if (action === 'assign') {
      const supporterId = _sheetFor;
      if (supporterId) assignSupport(supporterId, el.dataset.claimantId);
      return;
    }
    if (action === 'unassign') { unassignSupport(el.dataset.charId); return; }
    if (action === 'withdraw') { withdrawClaim(el.dataset.claimantId); return; }
    // Declaring a winner branches by tally, and the two branches genuinely
    // differ: Harpy resolves on the tap (locked at design-lock, consistent with
    // this tool's two-taps-no-confirm ethos), while Praxis opens the
    // confirmation first because it mass-clears offices belonging to people who
    // are not watching the board.
    if (action === 'declare-winner') {
      const claimantId = el.dataset.claimantId;
      if (_activeTally === 'praxis') openPraxisConfirm(claimantId);
      else declareHarpyWinner(claimantId);
      return;
    }
    // Dismissing has no confirm step on EITHER tally - design-lock item 1. No
    // seat changes hands, so there is nothing to review.
    if (action === 'dismiss-vote') { dismissVote(_activeTally); return; }
    // Only a click on the scrim itself closes the confirmation, never one that
    // bubbled up from a control inside it - the same rule the bottom sheet's own
    // backdrop follows.
    if (action === 'confirm-backdrop') {
      if (e.target !== el) return;
      closePraxisConfirm();
      return;
    }
    if (action === 'confirm-cancel') { closePraxisConfirm(); return; }
    if (action === 'confirm-go') { confirmPraxisResolve(); return; }
  });
}
