/* crd.2 — Player-facing pending contested-roll queue.
 *
 * A calm, always-present list the defending player checks on their own terms.
 * It REPLACES the blocking incoming-challenge modal this feature used to pop on
 * a background poll (that module is deleted by this story, not left dead in the
 * tree, matching how every other superseded client module in this repo has been
 * retired). Two reasons the modal had to go rather than coexist:
 *
 *   1. crd.1 made `defender_pool` legally absent on a pending contested roll,
 *      so the old modal rendered "Your pool: undefined" for any correctly
 *      created new-style request, and its Accept button hit crd.1's own 409
 *      guard every single time. It was already non-functional for the exact
 *      document shape this epic exists to produce.
 *   2. Interrupting a player mid-scene to make an irreversible dice decision is
 *      the interaction this epic exists to remove.
 *
 * STANDALONE, by an explicit epic-level decision (epic-crd Decision 3,
 * Angelus's correctness-over-speed reversal of the original "one shared
 * component" plan): refactoring the live ST-facing approval queue as a side
 * effect of shipping a new player surface is itself a downstream-impact risk,
 * for a generalisation benefit that is currently theoretical. This file
 * therefore IMPORTS NOTHING from that module. It does borrow its row grammar by
 * inspection: icon/type tag, compressed who-what, a resolved-but-recent state
 * rather than a row vanishing under the player's thumb, and a poll that only
 * runs while the tab is actually being looked at.
 *
 * Trust boundary: the server is the ONLY authority on what belongs in this
 * queue. `GET /mine` is already scoped and indexed (crd.1) to the caller's own
 * targets. This module deliberately adds NO filtering of its own, because a
 * second, client-side notion of "mine" is a thing that can silently diverge.
 *
 * Multi-character defenders are a real case, not an edge case: a player account
 * can own several characters, and each row therefore states explicitly WHICH of
 * them is being challenged. The "take the first match" shortcut used elsewhere
 * in app.js for resolving "my character" is not acceptable here, because a
 * second character's pending challenge would simply never be seen.
 *
 * Delegated routing (project convention): ONE click listener on the container
 * root, bound once at scaffold time. No per-render addEventListener calls.
 */

import { apiGet } from '../data/api.js';
import { esc, displayName, redactCharName } from '../data/helpers.js';

export const POLL_MS = 10_000;

/** Contest categories, as stored in `roll_type` on the request document.
 *  Carried over verbatim from the retired modal module so the vocabulary a
 *  player sees does not change under them. The attacker-side initiation modal
 *  keeps its own richer copy of this list (it also holds per-type pool notes);
 *  that file is out of this story's scope and is deliberately untouched. */
export const ROLL_LABELS = {
  territory:  'Territory Bid',
  social:     'Social Manoeuvre',
  resistance: 'Resistance Check',
  custom:     'Custom Roll',
};

/* A shield rather than the crossed blades the Combat tab uses: this is the
   DEFENDER's surface, and the two need to stay visually distinguishable in the
   More grid. */
const ROW_ICON = '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

const state = {
  rows:     [],   // pending requests, exactly as GET /mine returned them
  resolved: [],   // rows that left the pending set on the LAST tick, shown once
  chars:    [],   // the viewer's own characters, for the per-row target label
  loading:  false,
  fetchFailed: false,
};

let _rootEl    = null;
let _pollTimer = null;
let _fetchGen  = 0;   // guards a slow in-flight response landing after a newer one

/* Injected by the mount site (app.js's goTab), never imported. app.js already
   imports FROM this module, so reaching back for `checkMoreBadge` directly would
   make the dependency circular; a callback keeps the arrow pointing one way and
   leaves this module testable with no app.js in the picture at all. */
let _onQueueChange = null;

// ── Public API ───────────────────────────────────────────────────────────────

/** Mount the queue into a `.tab` container and start its gated poll.
 *  Idempotent for the same container (app.js's goTab re-activates a tab rather
 *  than remounting it). A DIFFERENT container means a genuine remount, so the
 *  transient state is cleared rather than carried across.
 *
 *  `onQueueChange` is an OPTIONAL callback fired after any poll that actually
 *  changes the pending set, in either direction. It exists because
 *  `hasPendingChallenges()` backs the shared `#more-badge`, whose only owner is
 *  app.js's `checkMoreBadge()` — and nothing in this module's poll path could
 *  reach that function before. Without it the badge goes stale in both
 *  directions while the player has this tab open: it stays lit after the queue
 *  empties, and stays dark after a poll discovers new pending work, until some
 *  unrelated action (visiting Feeding, a reload) happens to re-trigger it. */
export async function initPendingQueue(rootEl, chars, onQueueChange) {
  if (!rootEl) return;

  if (rootEl !== _rootEl) {
    _resetState();
    _rootEl = rootEl;
    _rootEl.innerHTML = _scaffoldHtml();
    _attachDelegatedHandler(_rootEl);
  }
  if (typeof onQueueChange === 'function') _onQueueChange = onQueueChange;
  state.chars = Array.isArray(chars) ? chars : [];

  await _refetchAndRender();

  if (!_pollTimer) _pollTimer = setInterval(_pollTick, POLL_MS);
}

/** Full teardown: stop polling AND forget the cached queue. The cache backs the
 *  nav badge, so it must not survive an account switch, or the next viewer
 *  inherits a badge for challenges that were never theirs.
 *
 *  No app-code call site today, deliberately and honestly: this app's only exit
 *  path is `logout()`, which does a full `window.location.reload()` and takes
 *  every module's state with it, so wiring this in there would be ceremony that
 *  does nothing. It exists as the real lifecycle counterpart to
 *  `initPendingQueue`, and it is what the test harness uses between cases. Wire
 *  it up the day this app grows an in-place account switch or an unmount. */
export function stopPendingQueue() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _rootEl = null;
  _onQueueChange = null;
  _resetState();
}

/** One-shot fetch that populates the badge cache without rendering anything.
 *  Called once at boot for a non-ST viewer, mirroring how the Downtime tile's
 *  badge reads a cache primed by the boot path rather than fetching from inside
 *  the badge callback itself. */
export async function refreshPendingQueueBadge() {
  try {
    const rows = await apiGet('/api/contested_roll_requests/mine');
    state.rows = Array.isArray(rows) ? rows : [];
    state.fetchFailed = false;
  } catch {
    // Leave the last known state alone. Reporting "no challenges" because the
    // network blinked is a false all-clear, which is worse than a stale badge.
    state.fetchFailed = true;
  }
}

/** Badge callback shape. renderMoreGrid()'s appIcon() only truth-tests this, so
 *  it returns a plain boolean rather than a count. */
export function hasPendingChallenges() {
  return state.rows.length > 0;
}

export function pendingChallengeCount() {
  return state.rows.length;
}

/** Lookup used by the resolution destination so it can name the challenge it
 *  was opened for without a second round trip. */
export function getPendingChallenge(id) {
  return state.rows.find(r => String(r._id) === String(id)) || null;
}

// ── Internals ────────────────────────────────────────────────────────────────

function _resetState() {
  state.rows = [];
  state.resolved = [];
  state.chars = [];
  state.loading = false;
  state.fetchFailed = false;
}

function _scaffoldHtml() {
  return `
    <div class="stm-audit-root">
      <header class="stm-audit-head">
        <h2>Challenges</h2>
        <p class="stm-audit-sub">Contested rolls waiting on you. Tap one to resolve it.</p>
      </header>
      <div class="oaq-queue-list" data-cq-body>
        <p class="stm-audit-loading">Loading…</p>
      </div>
    </div>
  `;
}

function _attachDelegatedHandler(root) {
  root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-cq-id]');
    if (!row) return;
    const id = row.dataset.cqId;
    if (!id) return;
    _openResolution(id);
  });
}

/* AC5, the routing contract. crd.3b builds the real screen behind this door;
   the door itself does not change when it does. The context id is the specific
   challenge's own `_id`, never "the defender's pending list in general". */
function _openResolution(challengeId) {
  if (typeof window !== 'undefined' && typeof window.goTab === 'function') {
    window.goTab('contested-resolve', { challengeId: String(challengeId) });
  }
}

function _pollTick() {
  // app.js's goTab() never unmounts a tab, it only toggles `.tab.active`, so
  // that class is the real "is the player looking at this?" signal.
  if (!_rootEl || !_rootEl.closest('.tab')?.classList.contains('active')) return;
  _refetchAndRender();
}

async function _refetchAndRender() {
  if (!_rootEl) return;
  const gen = ++_fetchGen;
  state.loading = true;
  _renderBody();

  let rows, failed = false;
  try {
    rows = await apiGet('/api/contested_roll_requests/mine');
  } catch (err) {
    console.error('[pending-queue] fetch failed:', err);
    failed = true;
  }

  // A newer fetch already landed while this one was in flight; applying this
  // stale snapshot would resurrect rows the newer one already knows are gone.
  if (gen !== _fetchGen) return;

  if (failed) {
    // Deliberately do NOT diff against an empty list here: a network blip must
    // never look like every outstanding challenge suddenly resolving.
    state.fetchFailed = true;
    // ...but the resolved row's "one tick" promise is specifically about the
    // tick immediately following the successful fetch that spotted the
    // departure. A failing fetch is not that tick, and carrying the entry
    // forward would hold a dimmed, untappable row through any number of
    // consecutive failures. Drop it; `state.rows` (the real pending work) is
    // what must survive a blip, and it does.
    state.resolved = [];
  } else {
    const next = Array.isArray(rows) ? rows : [];
    const changed = _pendingSetChanged(state.rows, next);
    state.resolved = _departedRows(state.rows, next);
    state.rows = next;
    state.fetchFailed = false;
    if (changed) _notifyQueueChanged();
  }

  state.loading = false;
  _renderBody();
}

/** True when the SET of pending ids differs, in either direction. Deliberately
 *  not "did anything about the response differ": the shared badge is a boolean
 *  over membership, so an unchanged set must not churn it on every 10s tick. */
function _pendingSetChanged(prev, next) {
  if (prev.length !== next.length) return true;
  const before = new Set(prev.map(r => String(r._id)));
  return next.some(r => !before.has(String(r._id)));
}

function _notifyQueueChanged() {
  if (typeof _onQueueChange !== 'function') return;
  try {
    _onQueueChange();
  } catch (err) {
    // A badge is a nicety; the queue itself is the feature. A throwing consumer
    // must never take the poll loop down with it.
    console.error('[pending-queue] queue-change callback failed:', err);
  }
}

/** AC3. Rows present last tick and absent now have left the pending set, by
 *  whatever route (a resolution, a decline, an ST void). They get one tick of a
 *  visible "resolved" state so the list does not silently rewrite itself under
 *  the player, then disappear, because the NEXT diff is computed against a
 *  `state.rows` that no longer contains them. */
function _departedRows(prev, next) {
  const stillPending = new Set(next.map(r => String(r._id)));
  return prev.filter(r => !stillPending.has(String(r._id)));
}

function _renderBody() {
  const body = _rootEl?.querySelector('[data-cq-body]');
  if (!body) return;

  if (state.loading && state.rows.length === 0 && state.resolved.length === 0 && !state.fetchFailed) {
    body.innerHTML = '<p class="stm-audit-loading">Loading…</p>';
    return;
  }

  if (state.fetchFailed && state.rows.length === 0) {
    body.innerHTML = '<p class="ch-error">Could not load your challenges. Retrying automatically…</p>';
    return;
  }

  if (state.rows.length === 0 && state.resolved.length === 0) {
    body.innerHTML = '<p class="stm-audit-empty">No pending challenges.</p>';
    return;
  }

  body.innerHTML = state.rows.map(_pendingRowHtml).join('')
    + state.resolved.map(_resolvedRowHtml).join('');
}

function _pendingRowHtml(r) {
  return `
    <button type="button" class="oaq-queue-row cq-row" data-cq-id="${esc(String(r._id))}">
      <span class="cq-row-icon">${ROW_ICON}</span>
      <span class="oaq-queue-name">${esc(redactCharName(r.challenger_character_name || 'Someone'))}</span>
      <span class="oaq-queue-actions">
        <span class="dtl-badge">${esc(_rollLabel(r))}</span>
        <span class="cq-target">Defending as ${esc(_targetLabel(r))}</span>
        <span class="derived-note">${esc(_when(r))}</span>
      </span>
    </button>
  `;
}

/* No data-cq-id: a row that has already left the pending set must not route
   anywhere, and the delegated handler keys off exactly that attribute. */
function _resolvedRowHtml(r) {
  return `
    <div class="oaq-queue-row cq-row cq-row-resolved">
      <span class="cq-row-icon">${ROW_ICON}</span>
      <span class="oaq-queue-name">${esc(redactCharName(r.challenger_character_name || 'Someone'))}</span>
      <span class="oaq-queue-actions">
        <span class="dtl-badge">Resolved</span>
        <span class="cq-target">Defending as ${esc(_targetLabel(r))}</span>
      </span>
    </div>
  `;
}

function _rollLabel(r) {
  return ROLL_LABELS[r.roll_type] || r.roll_type || 'Contested Roll';
}

/** AC2. Which of the viewer's OWN characters this challenge targets.
 *  Preferred source is the locally loaded character, so the label matches the
 *  name the player sees everywhere else in the app. The name stored on the
 *  request document is the fallback: it was written by the ATTACKER at creation
 *  time, so it is display-only and never authoritative. */
function _targetLabel(r) {
  const mine = state.chars.find(c => String(c._id) === String(r.target_character_id));
  if (mine) return redactCharName(displayName(mine));
  return redactCharName(r.target_character_name || 'your character');
}

function _when(r) {
  return r.created_at ? String(r.created_at).replace('T', ' ').replace(/\..*$/, '') : '';
}
