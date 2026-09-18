/* Unified Downtime tab — current cycle zone + past outcomes accordion. */

import { apiGet } from '../data/api.js';
import { esc } from '../data/helpers.js';
import { renderDowntimeTab } from './downtime-form.js';
import { renderOutcomeWithCards, fetchAndMergeStoryTabDowntimes, sortDowntimesByChapterRecency } from './story-tab.js';
import { isSTRole, getUser } from '../auth/discord.js';
import { FORM_RETIRED, RETIRED_NOTICE } from '../downtime/form-retirement.js';

export async function initDowntimeTab(el, char, territories = []) {
  // STs still get the normal tab \u2014 they need it to review/correct existing
  // submissions filed before this cutover. See form-retirement.js for why.
  if (FORM_RETIRED && !isSTRole()) {
    el.innerHTML = `<div class="placeholder-msg dt-retired-notice">
      <h3>${esc(RETIRED_NOTICE.title)}</h3>
      ${RETIRED_NOTICE.body.map(p => `<p>${esc(p)}</p>`).join('')}
      <p><a class="dt-mobile-show-anyway" href="${esc(RETIRED_NOTICE.ctaHref)}" target="_blank" rel="noopener">${esc(RETIRED_NOTICE.ctaLabel)}</a></p>
      <p class="dt-retired-notice-footnote">${esc(RETIRED_NOTICE.footnote)}</p>
    </div>`;
    return;
  }

  el.innerHTML = '<p class="placeholder-msg">Loading\u2026</p>';

  let cycles = [], subs = [];
  try {
    [cycles, subs] = await Promise.all([
      apiGet('/api/chapters'),
      apiGet('/api/downtime_submissions'),
    ]);
    subs.forEach(s => {
      if (!s.published_outcome && s.st_review?.outcome_visibility === 'published') {
        s.published_outcome = s.st_review.outcome_text;
      }
    });
  } catch (err) {
    el.innerHTML = `<p class="placeholder-msg">Failed to load: ${esc(err.message)}</p>`;
    return;
  }

  const charId = String(char._id);
  const isST = isSTRole();
  const playerId = getUser()?.player_id ? String(getUser().player_id) : null;

  // Find the most relevant non-closed cycle (priority: active > game > prep > open)
  const LIVE_STATUSES = ['active', 'game', 'prep', 'open'];
  const activeCycle = cycles
    .filter(c => LIVE_STATUSES.includes(c.status))
    .sort((a, b) => LIVE_STATUSES.indexOf(a.status) - LIVE_STATUSES.indexOf(b.status))[0] || null;

  // Most recently closed cycle — used for out-of-window access check when no live cycle exists
  const recentClosedCycle = cycles
    .filter(c => c.status === 'closed')
    .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1))[0] || null;

  // Access gate: STs always pass; players need out-of-window access flag, auto_open_at reached, or cycle open.
  // Use one cycle for the access check: the live cycle if one exists, otherwise the most recently
  // closed one. This prevents membership in a previous cycle's out-of-window list from granting
  // unintended access to a new cycle that's in prep.
  const cycleForAccessCheck = activeCycle || recentClosedCycle;
  const hasWindowAccess = charId && (cycleForAccessCheck?.out_of_window_player_ids || []).includes(charId);
  const autoOpenPassed = activeCycle?.auto_open_at && new Date(activeCycle.auto_open_at) <= new Date();
  const cycleIsOpen = ['open', 'active'].includes(activeCycle?.status);
  const canAccess = isST || hasWindowAccess || autoOpenPassed || cycleIsOpen;
  const mySubs = subs.filter(s => String(s.character_id) === charId);

  const cycleMap = {};
  for (const c of cycles) cycleMap[String(c._id)] = c.label || `Cycle ${String(c._id).slice(-4)}`;

  const publishedSubs = mySubs
    .filter(s => s.published_outcome)
    .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1));

  el.innerHTML = '';

  // ── Zone 1: Current Cycle ────────────────────────────────────────
  const currentZone = document.createElement('div');
  currentZone.className = 'dt-current-zone';

  if (activeCycle && !canAccess) {
    // DT not yet open for this player — show countdown or locked message
    if (activeCycle.auto_open_at) {
      const openDate = new Date(activeCycle.auto_open_at);
      const label = openDate.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      currentZone.innerHTML = `<div class="dt-state-card">
        <p class="dt-state-title">Downtimes opening soon</p>
        <p class="dt-state-body">Opens <strong>${esc(label)}</strong></p>
        <p class="dt-countdown" data-open-at="${esc(activeCycle.auto_open_at)}"></p>
      </div>`;
      _startCountdown(currentZone.querySelector('.dt-countdown'), openDate);
    } else {
      currentZone.innerHTML = `<div class="dt-state-card">
        <p class="dt-state-title">Downtimes are not yet open</p>
        <p class="dt-state-body">Your ST will open downtime submissions soon.</p>
      </div>`;
    }
  } else if (activeCycle || hasWindowAccess) {
    // Always render the form when there is a live cycle or the player has out-of-window access.
    // For the closed-cycle case (activeCycle null, hasWindowAccess true), downtime-form.js falls
    // back to the most recently closed cycle internally; the server gate is bypassed for ticked
    // characters. A submitted record is editable until the deadline; the form itself surfaces the
    // submitted/draft state via in-form badges and changes its submit button to "Update Submission".
    // The mobile notice still applies for non-ST, non-localhost on small screens.
    const forceForm = location.hostname === 'localhost' || isST;
    if (!forceForm && window.innerWidth <= 600) {
      // Small-screen heads-up. The previous "Open Player Portal" link pointed
      // at /player, which is now a legacy stub that redirects back to / — so
      // mobile players were bounced in a loop with no way to reach the form.
      // Offer an explicit escape hatch instead: render the form in place.
      currentZone.innerHTML = `<div class="dt-mobile-notice">
        <p class="dt-mobile-notice-text">This form is designed for desktop and may be awkward on a small screen.</p>
        <button type="button" class="dt-mobile-show-anyway" data-dt-show-form>Show the form anyway</button>
      </div>`;
      const showBtn = currentZone.querySelector('[data-dt-show-form]');
      if (showBtn) {
        showBtn.addEventListener('click', () => {
          renderDowntimeTab(currentZone, char, territories, { singleColumn: true, skipFreshFetch: true });
        });
      }
    } else {
      // Issue #259 (perf): char + territories come from suiteState which
      // was loaded at boot — skip the redundant fresh-fetch pair.
      renderDowntimeTab(currentZone, char, territories, { singleColumn: true, skipFreshFetch: true });
    }
  } else if (isST) {
    renderDowntimeTab(currentZone, char, territories, { singleColumn: true, skipFreshFetch: true });
  } else {
    const closedCycles = cycles
      .filter(c => c.status === 'closed' || c.status === 'complete')
      .sort((a, b) => (String(b._id) > String(a._id) ? 1 : -1));
    const recentClosed = closedCycles[0] || null;
    const myRecentSub = recentClosed
      ? mySubs.find(s => String(s.chapter_id) === String(recentClosed._id))
      : null;

    if (recentClosed && myRecentSub && !myRecentSub.published_outcome) {
      const label = recentClosed.label || `Cycle ${String(recentClosed._id).slice(-4)}`;
      currentZone.innerHTML = `<div class="dt-state-card">
        <p class="dt-state-title">${esc(label)}</p>
        <p class="dt-state-body">Your Storyteller is processing your actions. Check back soon.</p>
      </div>`;
    } else {
      currentZone.innerHTML = `<div class="dt-state-card dt-state-card--neutral">
        <p class="dt-state-body">No active downtime cycle. Check with your Storyteller.</p>
      </div>`;
    }
  }

  el.appendChild(currentZone);
}

// Story storytab.5, AC 3/AC 9: the fetch+merge+sort data logic, extracted into one
// DOM-free async function so it can be unit-tested directly (this repo's `vitest.config.js`
// has no jsdom environment, see that story's Story-Prep Question 2, closed) rather than
// only provable via a live-browser check. `renderPastOutcomes` below is left doing only
// DOM work: build the accordion HTML, wire the raw-toggle handlers.
export async function loadPastOutcomesData(char) {
  let cycles = [], subs = [];
  try {
    [cycles, subs] = await Promise.all([
      apiGet('/api/chapters'),
      apiGet('/api/downtime_submissions'),
    ]);
    subs.forEach(s => {
      if (!s.published_outcome && s.st_review?.outcome_visibility === 'published') {
        s.published_outcome = s.st_review.outcome_text;
      }
    });
  } catch {
    return { publishedSubs: [], cycles: [] };
  }

  [subs, cycles] = await fetchAndMergeStoryTabDowntimes(char, subs, cycles);

  const charId = String(char._id);
  const filtered = subs.filter(s => String(s.character_id) === charId && s.published_outcome);
  const publishedSubs = sortDowntimesByChapterRecency(filtered, cycles);

  return { publishedSubs, cycles };
}

/** Render past outcomes accordion into a target element. Standalone — can be
 *  called independently of the downtime form tab. */
export async function renderPastOutcomes(el, char) {
  if (!el || !char) return;
  el.innerHTML = '';

  const { publishedSubs, cycles } = await loadPastOutcomesData(char);
  if (!publishedSubs.length) return;

  const cycleMap = {};
  for (const c of cycles) cycleMap[String(c._id)] = c.label || `Cycle ${String(c._id).slice(-4)}`;

  let h = '<h3 class="dt-history-heading">Past Outcomes</h3>';
  for (const sub of publishedSubs) {
    const label = cycleMap[String(sub.chapter_id)] || 'Unknown Cycle';
    const dateStr = _cycleDate(sub, cycles);
    const hasResponses = sub.responses && Object.keys(sub.responses).length > 0;
    h += `<details class="dt-history-row">`;
    h += `<summary class="dt-history-summary">`;
    h += `<span class="dt-history-label">${esc(label)}</span>`;
    if (dateStr) h += `<span class="dt-history-date">${esc(dateStr)}</span>`;
    h += `<span class="dt-history-status">Outcome published</span>`;
    h += `</summary>`;
    h += `<div class="dt-history-body">`;
    if (hasResponses) {
      h += `<div class="raw-toggle-row"><button class="raw-toggle-btn">View my submission</button></div>`;
    }
    h += `<div class="dt-narrative-panel">${renderOutcomeWithCards(sub)}</div>`;
    if (hasResponses) {
      h += `<div class="dt-raw-panel raw-submission" hidden>`;
      h += `<div class="raw-banner">Read-only — your original submission</div>`;
      h += renderRawSubmission(sub);
      h += `</div>`;
    }
    h += `</div></details>`;
  }
  el.innerHTML = h;

  el.querySelectorAll('.raw-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.closest('.dt-history-body');
      const rawPanel = body.querySelector('.dt-raw-panel');
      const narPanel = body.querySelector('.dt-narrative-panel');
      const showingNar = !narPanel.hidden;
      narPanel.hidden = showingNar;
      rawPanel.hidden = !showingNar;
      btn.textContent = showingNar ? 'View ST narrative' : 'View my submission';
    });
  });
}

function renderRawSubmission(sub) {
  const r = sub.responses || {};
  let h = '';

  // Court & Aspirations
  const shortTerms = Array.isArray(r.aspirations_short_term) ? r.aspirations_short_term : [];
  const longTerms  = Array.isArray(r.aspirations_long_term)  ? r.aspirations_long_term  : [];
  if (r.court_present || shortTerms.length || longTerms.length) {
    h += '<div class="raw-section"><div class="raw-section-head">Court &amp; Aspirations</div>';
    if (r.court_present) h += `<div class="raw-field"><span class="raw-lbl">Court presence:</span> ${esc(r.court_present)}</div>`;
    if (shortTerms.length) h += `<div class="raw-field"><span class="raw-lbl">Short-term:</span> ${shortTerms.map(a => esc(a)).join(' / ')}</div>`;
    if (longTerms.length)  h += `<div class="raw-field"><span class="raw-lbl">Long-term:</span> ${longTerms.map(a => esc(a)).join(' / ')}</div>`;
    h += '</div>';
  }

  // Feeding
  if (r.feeding_method || r.feeding_pool) {
    h += '<div class="raw-section"><div class="raw-section-head">Feeding</div>';
    if (r.feeding_method) h += `<div class="raw-field"><span class="raw-lbl">Method:</span> ${esc(r.feeding_method)}</div>`;
    if (r.feeding_pool)   h += `<div class="raw-field"><span class="raw-lbl">Pool:</span> ${esc(String(r.feeding_pool))}</div>`;
    if (r.feeding_narrative) h += `<div class="raw-field raw-narrative">${esc(r.feeding_narrative)}</div>`;
    h += '</div>';
  }

  // Projects
  let projH = '';
  for (let n = 1; n <= 5; n++) {
    const title  = r[`project_${n}_title`] || r[`proj_${n}_title`];
    const action = r[`project_${n}_action`] || r[`proj_${n}_action`];
    const desc   = r[`project_${n}_description`] || r[`proj_${n}_description`];
    if (!title && !action && !desc) continue;
    projH += '<div class="raw-project">';
    if (title)  projH += `<div class="raw-proj-title">${esc(title)}</div>`;
    if (action) projH += `<div class="raw-field"><span class="raw-lbl">Action:</span> ${esc(action)}</div>`;
    if (desc)   projH += `<div class="raw-field">${esc(desc)}</div>`;
    projH += '</div>';
  }
  if (projH) h += `<div class="raw-section"><div class="raw-section-head">Projects</div>${projH}</div>`;

  // Sorcery
  let sorH = '';
  for (let n = 1; n <= 5; n++) {
    const rite   = r[`sorcery_${n}_rite`];
    const target = r[`sorcery_${n}_target`];
    if (!rite) continue;
    sorH += `<div class="raw-field"><span class="raw-lbl">Rite:</span> ${esc(rite)}${target ? ` — Target: ${esc(target)}` : ''}</div>`;
  }
  if (sorH) h += `<div class="raw-section"><div class="raw-section-head">Sorcery</div>${sorH}</div>`;

  // Merit actions
  let merH = '';
  for (let n = 1; n <= 5; n++) {
    const merit = r[`sphere_${n}_merit`];
    const desc  = r[`sphere_${n}_description`] || r[`sphere_${n}_outcome`];
    if (merit) merH += `<div class="raw-field"><span class="raw-lbl">${esc(merit)}:</span> ${esc(desc || '')}</div>`;
  }
  for (let n = 1; n <= 5; n++) {
    const req   = r[`contact_${n}_request`];
    const merit = r[`contact_${n}_merit`] || 'Contacts';
    if (req) merH += `<div class="raw-field"><span class="raw-lbl">${esc(merit)}:</span> ${esc(req)}</div>`;
  }
  for (let n = 1; n <= 4; n++) {
    const task = r[`retainer_${n}_task`];
    if (task) merH += `<div class="raw-field"><span class="raw-lbl">Retainer:</span> ${esc(task)}</div>`;
  }
  if (merH) h += `<div class="raw-section"><div class="raw-section-head">Merit Actions</div>${merH}</div>`;

  // Game Highlights
  let hiH = '';
  for (let n = 1; n <= 5; n++) {
    const txt = r[`game_recount_${n}`]?.trim();
    if (txt) hiH += `<div class="raw-field"><span class="raw-lbl">Highlight ${n}:</span> ${esc(txt)}</div>`;
  }
  if (hiH) h += `<div class="raw-section"><div class="raw-section-head">Game Highlights</div>${hiH}</div>`;

  // XP Spends
  let xpH = '';
  for (let n = 1; n <= 5; n++) {
    const trait = r[`xp_spend_${n}_trait`];
    const dots  = r[`xp_spend_${n}_dots`];
    if (trait) xpH += `<div class="raw-field">${esc(trait)}${dots ? ` (${esc(String(dots))} dots)` : ''}</div>`;
  }
  if (xpH) h += `<div class="raw-section"><div class="raw-section-head">XP Spends</div>${xpH}</div>`;

  return h || '<p class="raw-empty">No submission content recorded for this cycle.</p>';
}

function _cycleDate(sub, cycles) {
  const cycle = cycles.find(c => String(c._id) === String(sub.chapter_id));
  if (!cycle) return '';
  const raw = cycle.closed_at || cycle.deadline_at;
  if (!raw) return '';
  return new Date(raw).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
}

let _countdownInterval = null;
function _startCountdown(el, openDate) {
  if (_countdownInterval) clearInterval(_countdownInterval);
  const update = () => {
    if (!el || !el.isConnected) { clearInterval(_countdownInterval); return; }
    const diff = openDate - new Date();
    if (diff <= 0) { el.textContent = 'Opening now — refresh the page.'; clearInterval(_countdownInterval); return; }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = (d > 0 ? d + 'd ' : '') + h + 'h ' + m + 'm ' + s + 's';
  };
  update();
  _countdownInterval = setInterval(update, 1000);
}
