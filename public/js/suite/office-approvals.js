/* Approval Queue (oaq.3) — ST review surface for pending Status Actions.
 *
 * Lists every pending status_action record from GET /api/office_actions/pending
 * (oldest-first) with one-click Accept/Decline, backed by the existing
 * ST-only PUT /api/office_actions/:id/accept and /:id/decline routes built
 * and code-reviewed under oaq.2. This module only submits/reads — it never
 * touches the transaction, budget, or precondition logic those routes own.
 *
 * Lives in the main game app (app.js's goTab), not the ST admin app — moved
 * here from public/js/admin/office-approvals.js so it's reachable from the
 * same surface STs already run live at the table, gated stOnly in app.js's
 * MORE_APPS/NAV_ITEMS (same pattern as Territory/Tracker/Combat/Spheres).
 *
 * Delegated routing (per memory feedback_listener_routing_static_blind_spot,
 * mirroring public/js/admin/st-mods-audit.js): a single delegated click
 * listener on the container root, bound once at scaffold time. NO per-render
 * addEventListener calls.
 *
 * Refresh: 10-second poll against GET /pending, mirroring the existing
 * pattern in the contested-roll poller (the modal module this originally
 * cited was retired by crd.2; its successor is
 * public/js/game/pending-queue.js, same contested_roll_requests collection
 * family, same POLL_MS). Race safety already exists
 * server-side (both accept/decline 409 if the record is no longer pending);
 * the poll is purely so a row resolved by another ST disappears without a
 * manual reload. Polling is skipped while this tab isn't the active one —
 * app.js's goTab() never unmounts a tab, it only toggles the `.tab.active`
 * class (public/css/suite.css), so that class is the "is this tab visible"
 * signal here, same idea as the admin app's `.domain.active` this module
 * used before the move.
 */

import { apiGet, apiRaw } from '../data/api.js';
import { esc, redactCharName, redactPlayer } from '../data/helpers.js';

const POLL_MS = 10_000;

// oaq.3 decision: display layer keys off request_type so a second pending-
// item type (Epic OXP's XP-spend approvals) can add its own label later
// without restructuring this module — only 'status_action' is populated
// today.
const ACTION_TYPE_LABELS = {
  raise:       'Raise',
  lower:       'Lower',
  grant_first: 'Grant First Dot',
  strip_last:  'Strip Last Dot',
};

const state = {
  initialized: false,
  rows: [],
  loading: false,
  fetchFailed: false,   // last GET /pending attempt errored — distinct from a genuinely empty queue
  busyIds: new Set(),   // requests currently mid accept/decline — disable their buttons
  errorById: new Map(), // requestId -> last error message (e.g. "already actioned by X")
};

let _rootEl = null;
let _pollTimer = null;
let _fetchGen = 0; // review finding: guards against an in-flight poll response landing AFTER a
                    // more recent accept/decline already changed state.rows, resurrecting a
                    // just-resolved row from a stale snapshot.

/** init — called from app.js's goTab() when 'office-approvals' activates.
 *  Idempotent: subsequent calls reuse the existing DOM scaffold. */
export async function initOfficeApprovals(rootEl) {
  _rootEl = rootEl;
  if (!_rootEl) return;

  if (!state.initialized) {
    _rootEl.innerHTML = renderScaffold();
    _attachDelegatedHandlers(_rootEl);
    state.initialized = true;
  }

  await _refetchAndRender();

  if (!_pollTimer) _pollTimer = setInterval(_pollTick, POLL_MS);
}

// ── Scaffold ─────────────────────────────────────────────────────────

function renderScaffold() {
  return `
    <div class="stm-audit-root">
      <header class="stm-audit-head">
        <h2>Approval Queue</h2>
        <p class="stm-audit-sub">Pending Status Actions awaiting sign-off. Oldest first.</p>
      </header>
      <div class="oaq-queue-list" data-oaq-body>
        <p class="stm-audit-loading">Loading…</p>
      </div>
    </div>
  `;
}

// ── Poll ─────────────────────────────────────────────────────────────

function _pollTick() {
  if (!_rootEl || !_rootEl.closest('.tab')?.classList.contains('active')) return;
  _refetchAndRender();
}

// ── Delegated event handler ─────────────────────────────────────────

function _attachDelegatedHandlers(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-oaq-action]');
    if (!btn) return;
    const requestId = btn.dataset.oaqId;
    const action = btn.dataset.oaqAction;
    if (!requestId || !action) return;
    _resolve(requestId, action);
  });
}

// ── Fetch + render ───────────────────────────────────────────────────

async function _refetchAndRender() {
  if (!_rootEl) return;
  const gen = ++_fetchGen;
  state.loading = true;
  _renderBody();

  let rows, failed = false;
  try {
    rows = await apiGet('/api/office_actions/pending');
  } catch (err) {
    console.error('[office-approvals] fetch failed:', err);
    failed = true;
  }

  // A newer fetch (a poll tick, or the refetch triggered by an accept/decline
  // elsewhere) already landed while this one was in flight — applying this
  // stale response would resurrect an already-resolved row (review finding).
  if (gen !== _fetchGen) return;

  if (failed) {
    state.fetchFailed = true;
  } else {
    state.fetchFailed = false;
    state.rows = Array.isArray(rows) ? rows : [];
  }

  state.loading = false;
  _renderBody();
}

async function _resolve(requestId, action) {
  if (state.busyIds.has(requestId)) return;
  state.busyIds.add(requestId);
  state.errorById.delete(requestId);
  _renderBody();

  const res = await apiRaw('PUT', `/api/office_actions/${requestId}/${action}`, {});
  if (res.ok) {
    state.rows = state.rows.filter(r => String(r._id) !== requestId);
    // Refetch rather than trust the local removal alone — keeps the queue
    // consistent with the server after a resolve, same generation guard as
    // the poll so an even-newer response still wins.
    _refetchAndRender();
  } else {
    // review finding: the server's own 409 message may name the acting ST
    // (resolved_by/declined_by) — build the client-side message from those
    // fields directly, through redactPlayer, rather than displaying the
    // server's pre-formatted string verbatim (which would leak a raw
    // Discord username to a privacy-redacted dev-role viewer).
    const by = res.body?.resolved_by || res.body?.declined_by;
    state.errorById.set(requestId, by
      ? `Already actioned by ${redactPlayer(by)}`
      : (res.body?.message || 'Failed to resolve request.'));
  }

  state.busyIds.delete(requestId);
  _renderBody();
}

function _renderBody() {
  const body = _rootEl.querySelector('[data-oaq-body]');
  if (!body) return;

  if (state.loading && state.rows.length === 0) {
    body.innerHTML = '<p class="stm-audit-loading">Loading…</p>';
    return;
  }

  // review finding: a failed fetch must never render as "nothing pending" —
  // that reads as a false all-clear when the real queue state is simply
  // unknown right now.
  if (state.fetchFailed && state.rows.length === 0) {
    body.innerHTML = '<p class="ch-error">Could not load the queue. Retrying automatically…</p>';
    return;
  }

  if (state.rows.length === 0) {
    body.innerHTML = '<p class="stm-audit-empty">Nothing pending.</p>';
    return;
  }

  body.innerHTML = state.rows.map(_renderRow).join('');
}

function _renderRow(r) {
  const id = String(r._id);
  const busy = state.busyIds.has(id);
  const error = state.errorById.get(id);
  const label = r.request_type === 'status_action'
    ? (ACTION_TYPE_LABELS[r.action_type] || r.action_type)
    : r.request_type;
  const when = r.created_at ? r.created_at.replace('T', ' ').replace(/\..*$/, '') : '';

  return `
    <div class="oaq-queue-row-wrap" data-oaq-row="${esc(id)}">
      <div class="oaq-queue-row">
        <span class="oaq-queue-name">${esc(redactCharName(r.actor_name || 'Unknown'))} → ${esc(redactCharName(r.target_name || 'Unknown'))}</span>
        <div class="oaq-queue-actions">
          <span class="dtl-badge">${esc(label)}</span>
          <span class="derived-note">${esc(when)}</span>
          <div class="ch-modal-actions oaq-queue-btns">
            <button class="ch-btn ch-btn-accept" data-oaq-action="accept" data-oaq-id="${esc(id)}" ${busy ? 'disabled' : ''}>Accept</button>
            <button class="ch-btn ch-btn-decline" data-oaq-action="decline" data-oaq-id="${esc(id)}" ${busy ? 'disabled' : ''}>Decline</button>
          </div>
        </div>
      </div>
      ${error ? `<div class="ch-error oaq-queue-error">${esc(error)}</div>` : ''}
    </div>
  `;
}
