/**
 * signin-tab.js — Live game check-in tab (ST + coordinator).
 *
 * Repurposed by fin.3 as the coordinator check-in tool.
 * Renders the full non-retired character roster against the most recent
 * game session. Ticking a character creates their attendance entry on demand
 * (upsert-on-tick). When no session exists a "+ New Session" button lets the
 * coordinator create one without leaving this tab.
 * Changes auto-save to /api/game_sessions/:id.
 */

import { apiGet, apiPut, apiPost } from '../data/api.js';
import { calcVitaeMax, calcWillpowerMax } from '../data/accessors.js';
import { calcTotalInfluence } from '../editor/domain.js';
import { displayName, esc } from '../data/helpers.js';
import { readPayment } from './payment-helpers.js';

// fin.2 schema enum. Display labels paired with stored values.
const PAYMENT_METHODS = [
  { value: '',         label: '— Not recorded' },
  { value: 'cash',     label: 'Cash' },
  { value: 'payid',    label: 'PayID' },
  { value: 'paypal',   label: 'PayPal' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'exiles',   label: 'Exiles (offset)' },
  { value: 'waived',   label: 'Waived' },
];
// FIN-7: paid methods inherit session.session_rate; everything else is $0.
const PAID_METHODS = new Set(['cash', 'payid', 'paypal', 'transfer']);
const DEFAULT_RATE = 15;

function calcEminence(session, chars) {
  const attendedIds = new Set(
    (session?.attendance || []).filter(a => a.attended).map(a => String(a.character_id))
  );
  const em = {}, asc = {};
  for (const c of chars) {
    if (!attendedIds.has(String(c._id))) continue;
    const cs = c.status?.city || 0;
    if (c.clan)     em[c.clan]      = (em[c.clan]      || 0) + cs;
    if (c.covenant) asc[c.covenant] = (asc[c.covenant] || 0) + cs;
  }
  const top2 = (obj) => Object.entries(obj)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
    .map(([name, total]) => ({ name, total }));
  return { eminence: top2(em), ascendancy: top2(asc) };
}

let _session = null;
let _sessions = [];
let _chars = [];
let _saveTimer = null;
let _el = null;
let _playerByCharId = new Map();
let _infSpentByCharId = new Map();
let _feedVitaeByCharId = new Map();
// Live tracker_state per character (vitae, willpower, influence). The check-in shows these when
// present, because the old feeding_vitae_* fields below are not written for current-format cycles.
let _trackerByCharId = new Map();

// Placeholder strings seeded by an early redacted import. Treat as missing.
const PLACEHOLDER_RE = /^Player [A-Z]{1,2}$/;

async function loadPlayerNames() {
  _playerByCharId = new Map();
  try {
    const pairs = await apiGet('/api/players/display-names');
    for (const p of (pairs || [])) {
      if (p?.character_id && p?.display_name) {
        _playerByCharId.set(String(p.character_id), p.display_name);
      }
    }
    console.info('[signin] player name lookup: %d mappings loaded', _playerByCharId.size);
  } catch (err) {
    console.warn('[signin] player name lookup failed; falling back to row.player strings', err);
  }
}

async function loadLastCycleData() {
  _infSpentByCharId = new Map();
  _feedVitaeByCharId = new Map();
  try {
    const allCycles = await apiGet('/api/chapters');
    // The cycles API sorts by _id desc, but DT1 was re-imported with a newer
    // _id than DT3 — so array order no longer tracks recency. Order on
    // game_number explicitly to pick the genuine most-recent cycle.
    const lastClosed = (allCycles || [])
      .filter(c => c.status && c.status !== 'open')
      .sort((a, b) => (b.game_number || 0) - (a.game_number || 0))[0] || null;
    if (!lastClosed) return;
    const subs = await apiGet('/api/downtime_submissions?chapter_id=' + lastClosed._id);
    for (const sub of (subs || [])) {
      const charId = String(sub.character_id);

      // Influence spend (#485) — guarded block, not an early continue, so the
      // feeding extraction below still runs for influence-less submissions.
      const raw = sub.responses?.influence_spend;
      if (raw) {
        let spendObj = null;
        try { spendObj = JSON.parse(raw); } catch { spendObj = null; }
        if (spendObj) {
          // Absolute amounts: a negative per-territory value is influence
          // moved, not refunded — it still counts against the spend total.
          const total = Object.values(spendObj).reduce((s, v) => s + Math.abs(Number(v) || 0), 0);
          if (total > 0) _infSpentByCharId.set(charId, total);
        }
      }

      // Feeding vitae from the logged feed roll (#489): vessel allocation
      // plus the saved bonus tally. No allocation means no logged feed.
      const alloc = sub.feeding_vitae_allocation;
      if (Array.isArray(alloc) && alloc.length > 0) {
        const vesselTotal = alloc.reduce((s, v) => s + (Number(v) || 0), 0);
        const bonus = Number(sub.feeding_vitae_tally?.total_bonus) || 0;
        _feedVitaeByCharId.set(charId, vesselTotal + bonus);
      }
    }
    console.info('[signin] last-cycle data loaded: %d inf, %d feed',
      _infSpentByCharId.size, _feedVitaeByCharId.size);
  } catch (err) {
    console.warn('[signin] last-cycle data load failed; defaulting to 0', err);
  }
}

async function loadTrackers() {
  _trackerByCharId = new Map();
  const results = await Promise.all((_chars || []).map(async (c) => {
    try { return [String(c._id), await apiGet('/api/tracker_state/' + c._id)]; }
    catch { return [String(c._id), null]; }
  }));
  for (const [id, t] of results) if (t && typeof t === 'object') _trackerByCharId.set(id, t);
}

const finiteOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export async function initSignIn(el, chars) {
  _el = el;
  _chars = chars || [];
  el.innerHTML = '<div class="si-loading">Loading session…</div>';

  try {
    const sessions = await apiGet('/api/game_sessions');
    _sessions = sessions.sort((a, b) => b.session_date.localeCompare(a.session_date));
    _session  = _sessions[0] || null;
  } catch {
    el.innerHTML = '<div class="si-empty">Could not load sessions. Check your connection.</div>';
    return;
  }

  if (!_session) {
    renderNoSession();
    return;
  }

  await Promise.all([loadPlayerNames(), loadLastCycleData(), loadTrackers()]);
  render();
}

function renderNoSession() {
  _el.innerHTML = `<div class="si-empty">
    No upcoming session.
    <button class="si-new-session-btn">+ New Session</button>
  </div>`;
  _el.querySelector('.si-new-session-btn').addEventListener('click', handleNewSession);
}

async function handleNewSession() {
  let sessions = [];
  try { sessions = await apiGet('/api/game_sessions'); } catch { sessions = []; }
  const maxNum = sessions.reduce((m, s) => Math.max(m, s.game_number || 0), 0);
  const gameNum = maxNum + 1;
  if (!confirm(`Create session for Game ${gameNum}?`)) return;
  const today = new Date().toISOString().slice(0, 10);
  const created = await apiPost('/api/game_sessions', {
    session_date: today,
    game_number:  gameNum,
    attendance:   [],
  });
  _session = created;
  _sessions.unshift(created);
  await Promise.all([loadPlayerNames(), loadLastCycleData(), loadTrackers()]);
  render();
}

function resolveRosterPlayerName(c) {
  const fromMap = _playerByCharId.get(String(c._id));
  if (fromMap) return fromMap;
  const raw = (c.player || '').trim();
  if (raw && !PLACEHOLDER_RE.test(raw)) return raw;
  return displayName(c);
}

function scheduleAutosave() {
  const statusEl = _el?.querySelector('.si-status');
  if (statusEl) statusEl.textContent = 'Saving…';
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(doAutosave, 800);
}

async function doAutosave() {
  if (!_session) return;
  const statusEl = _el?.querySelector('.si-status');
  try {
    const { _id, ...body } = _session;
    const updated = await apiPut('/api/game_sessions/' + _id, body);
    Object.assign(_session, updated);
    if (statusEl) statusEl.textContent = '';
  } catch {
    if (statusEl) statusEl.textContent = 'Save failed, retrying…';
    _saveTimer = setTimeout(doAutosave, 3000);
  }
}

function render() {
  if (!_el || !_session) return;

  const entryByCharId = new Map(
    (_session.attendance || []).map(a => [String(a.character_id), a])
  );

  const roster = _chars
    .filter(c => !c.retired)
    .sort((a, b) => resolveRosterPlayerName(a).localeCompare(resolveRosterPlayerName(b)));

  const attendedCount = roster.filter(c => entryByCharId.get(String(c._id))?.attended).length;

  const { eminence, ascendancy } = calcEminence(_session, _chars);
  const fmtTop = (arr) => arr.length
    ? arr.map(e => `${esc(e.name)} (${e.total})`).join(' · ')
    : '—';

  const rate = Number.isFinite(_session.session_rate) ? _session.session_rate : DEFAULT_RATE;

  const sessionOpts = _sessions.map(s => {
    const p = [];
    if (s.game_number != null) p.push(`Game ${s.game_number}`);
    if (s.session_date)        p.push(s.session_date);
    if (s.title)               p.push(s.title);
    const lbl = p.join(' · ');
    const sel = String(s._id) === String(_session._id) ? ' selected' : '';
    return `<option value="${esc(String(s._id))}"${sel}>${esc(lbl)}</option>`;
  }).join('');

  let h = `<div class="si-header">
    <select class="si-session-sel" id="si-session-sel">${sessionOpts}</select>
    <span class="si-stat">${attendedCount} / ${roster.length} attended</span>
    <span class="si-status"></span>
  </div>
  <div class="si-eminence-block">
    <span class="si-em-label">Eminence:</span><span class="si-em-val">${fmtTop(eminence)}</span>
    <span class="si-em-label">Ascendancy:</span><span class="si-em-val">${fmtTop(ascendancy)}</span>
  </div>
  <div class="si-rate-block">
    <label class="si-rate-label">Session rate ($)
      <input type="number" id="si-session-rate" class="si-rate-input" min="0" step="1" value="${rate}">
    </label>
  </div>`;

  h += '<div class="si-list">';
  roster.forEach(c => {
    const a = entryByCharId.get(String(c._id)) || null;
    const attended = a?.attended || false;
    const charName = displayName(c);
    const playerName = resolveRosterPlayerName(c);

    const vMax  = calcVitaeMax(c);
    const wpMax = calcWillpowerMax(c);
    const infMax = calcTotalInfluence(c);
    const infSpent = _infSpentByCharId.get(String(c._id)) || 0;
    const tracker = _trackerByCharId.get(String(c._id)) || null;
    const infRemaining = finiteOr(tracker?.influence, Math.max(0, infMax - infSpent));
    const feedVitae = _feedVitaeByCharId.get(String(c._id)) ?? 0;
    const vitaeShown = finiteOr(tracker?.vitae, Math.min(feedVitae, vMax));
    const wpShown = finiteOr(tracker?.willpower, wpMax);
    const resourceRow = `<div class="si-resources">
      <span class="si-res-item"><span class="si-res-lbl">V</span> ${vitaeShown}/${vMax}</span>
      <span class="si-res-item"><span class="si-res-lbl">WP</span> ${wpShown}/${wpMax}</span>
      ${infMax > 0 ? `<span class="si-res-item"><span class="si-res-lbl">Inf</span> ${infRemaining}/${infMax}</span>` : ''}
    </div>`;

    const { method: currentMethod } = a ? readPayment(a) : { method: '' };
    const rowAmount = PAID_METHODS.has(currentMethod) ? rate : 0;
    const payOpts = PAYMENT_METHODS.map(m =>
      `<option value="${esc(m.value)}"${currentMethod === m.value ? ' selected' : ''}>${esc(m.label)}</option>`
    ).join('');

    h += `<div class="si-row${attended ? ' si-attended' : ''}" data-char-id="${esc(String(c._id))}">
      <label class="si-attended-wrap">
        <input type="checkbox" class="si-att-chk" data-char-id="${esc(String(c._id))}"${attended ? ' checked' : ''}>
      </label>
      <div class="si-info">
        <div class="si-player">${esc(playerName)}</div>
        <div class="si-char">${esc(charName)}</div>
        ${resourceRow}
      </div>
      <select class="si-pay-sel" data-char-id="${esc(String(c._id))}">
        ${payOpts}
      </select>
      <span class="si-pay-amt-display">$${rowAmount}</span>
    </div>`;
  });
  h += '</div>';

  // Footer: attended count + collected total.
  const paidCount = roster.reduce((n, c) => {
    const a = entryByCharId.get(String(c._id));
    if (!a) return n;
    const { method } = readPayment(a);
    return PAID_METHODS.has(method) ? n + 1 : n;
  }, 0);
  const collected = paidCount * rate;
  h += `<div class="si-footer"><strong>${attendedCount}</strong> attended · <strong>$${collected}</strong> collected</div>`;

  _el.innerHTML = h;
  wireEvents();
}

function wireEvents() {
  _el.querySelectorAll('.si-att-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const charId = String(chk.dataset.charId);
      let entry = (_session.attendance || []).find(a => String(a.character_id) === charId);
      if (!entry) {
        const c = _chars.find(ch => String(ch._id) === charId);
        if (!c) return;
        entry = {
          character_id:      c._id,
          character_name:    c.name,
          character_display: displayName(c),
          player:            c.player || '',
          attended:          false,
          costuming:         false,
          downtime:          false,
          extra:             0,
          paid:              false,
          payment:           {},
          payment_method:    '',
        };
        if (!_session.attendance) _session.attendance = [];
        _session.attendance.push(entry);
      }
      entry.attended = chk.checked;
      scheduleAutosave();
      render();
    });
  });

  _el.querySelectorAll('.si-pay-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const charId = String(sel.dataset.charId);
      let entry = (_session.attendance || []).find(a => String(a.character_id) === charId);
      if (!entry) {
        const c = _chars.find(ch => String(ch._id) === charId);
        if (!c) return;
        entry = {
          character_id:      c._id,
          character_name:    c.name,
          character_display: displayName(c),
          player:            c.player || '',
          attended:          false,
          costuming:         false,
          downtime:          false,
          extra:             0,
          paid:              false,
          payment:           {},
          payment_method:    '',
        };
        if (!_session.attendance) _session.attendance = [];
        _session.attendance.push(entry);
      }
      const method = sel.value;
      const rate = Number.isFinite(_session.session_rate) ? _session.session_rate : DEFAULT_RATE;
      const amount = PAID_METHODS.has(method) ? rate : 0;
      entry.payment = { ...(entry.payment || {}), method, amount };
      entry.payment_method = method;
      entry.paid = PAID_METHODS.has(method);
      scheduleAutosave();
      render();
    });
  });

  const sessSel = _el.querySelector('#si-session-sel');
  if (sessSel) {
    sessSel.addEventListener('change', () => {
      const chosen = _sessions.find(s => String(s._id) === sessSel.value);
      if (chosen) {
        _session = chosen;
        render();
      }
    });
  }

  const rateInput = _el.querySelector('#si-session-rate');
  if (rateInput) {
    rateInput.addEventListener('change', () => {
      const v = parseFloat(rateInput.value);
      if (!Number.isFinite(v) || v < 0) {
        rateInput.value = Number.isFinite(_session.session_rate) ? _session.session_rate : DEFAULT_RATE;
        return;
      }
      _session.session_rate = v;
      for (const a of (_session.attendance || [])) {
        const m = a.payment?.method;
        if (PAID_METHODS.has(m)) {
          a.payment = { ...(a.payment || {}), method: m, amount: v };
        }
      }
      scheduleAutosave();
      render();
    });
  }
}
