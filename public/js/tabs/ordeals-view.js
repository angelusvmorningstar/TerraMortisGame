/* Ordeals tab — shows all 5 ordeals with status and form access.
 * Character-level: Questionnaire, History (per character)
 * Player-level: Setting/Lore, Rules, Covenant (per player) */

import { apiGet, apiPatch } from '../data/api.js';
import { esc, displayName } from '../data/helpers.js';
import {
  xpStarting, xpHumanityDrop, xpOrdeals, xpGame, xpPT5, xpEarned,
  xpSpentAttrs, xpSpentSkills, xpSpentMerits, xpSpentPowers, xpSpentSpecial, xpSpent, xpLeft,
} from '../editor/xp.js';
import { renderQuestionnaire } from './questionnaire-form.js';
import { renderHistory } from './history-form.js';
import { renderOrdealForm } from './ordeal-form.js';
import { RULES_SECTIONS } from './rules-data.js';
import { LORE_SECTIONS } from './lore-data.js';
import { COVENANT_ROUTING, COVENANT_SECTIONS } from './covenant-data.js';
import { isSTRole } from '../auth/discord.js';
import { ORDEALS_RETIRED, RETIRED_NOTICE } from '../ordeals/ordeal-retirement.js';

const CHAR_ORDEALS = [
  { key: 'questionnaire', label: 'Questionnaire', hasForm: true, formType: 'questionnaire',
    desc: 'Complete the character questionnaire. 3 XP to this character.' },
  { key: 'history', label: 'History', hasForm: true, formType: 'history',
    desc: 'Write your character history. 3 XP to this character.' },
];

const PLAYER_ORDEALS = [
  { key: 'setting', label: 'Setting', altKey: 'lore', hasForm: true, formType: 'lore',
    desc: 'Demonstrate knowledge of the game setting. 3 XP to all your characters.' },
  { key: 'rules', label: 'Rules', hasForm: true, formType: 'rules',
    desc: 'Demonstrate knowledge of VtR 2e rules. 3 XP to all your characters. Unlocks dice roller in the game app.' },
  { key: 'covenant', label: 'Covenant', hasForm: true, formType: 'covenant',
    desc: 'Demonstrate knowledge of your covenant. 3 XP to characters in that covenant.' },
];

// Maps ordeal def key → ordeal_submissions ordeal_type
const KEY_TO_SUBMISSION_TYPE = {
  lore:      'lore_mastery',
  setting:   'lore_mastery',
  rules:     'rules_mastery',
  covenant:  'covenant_questionnaire',
  history:   'character_history',
  // questionnaire has its own collection (questionnaire_responses), not ordeal_submissions
};

const PLAYER_PREF_AXES = [
  { key: 'combat_action',            label: 'Combat & Action' },
  { key: 'horror_dread',             label: 'Horror & Dread' },
  { key: 'institutional_corruption', label: 'Institutional Corruption' },
  { key: 'mysticism_mystery',        label: 'Mysticism & Mystery' },
  { key: 'personal_story',           label: 'Personal Story' },
  { key: 'political_intrigue',       label: 'Political Intrigue' },
];

let playerDoc       = null;
let currentChar     = null;
let statusCache     = {}; // { questionnaire, history, rules, lore, covenant }
let submissionsMap  = {}; // { [ordeal_type]: stripped submission doc }

export async function initOrdeals(char, chars, containerEl) {
  const el = containerEl || document.getElementById('tab-xplog');
  if (!el) return;
  currentChar = char;

  // STs still get the normal tab — they still need to mark/correct Ordeal
  // submissions filed before this cutover. See ordeal-retirement.js for why.
  if (ORDEALS_RETIRED && !isSTRole()) {
    el.innerHTML = `<div class="placeholder-msg ordeal-retired-notice">
      <h3>${esc(RETIRED_NOTICE.title)}</h3>
      ${RETIRED_NOTICE.body.map(p => `<p>${esc(p)}</p>`).join('')}
    </div>`;
    return;
  }

  const [pDoc, qDoc, hDoc, rulesDoc, loreDoc, covDoc, subDocs] = await Promise.all([
    playerDoc ? Promise.resolve(playerDoc) : apiGet('/api/players/me').catch(() => ({ ordeals: {} })),
    apiGet(`/api/questionnaire?character_id=${char._id}`).catch(() => null),
    apiGet(`/api/history?character_id=${char._id}`).catch(() => null),
    apiGet('/api/ordeal-responses?type=rules').catch(() => null),
    apiGet('/api/ordeal-responses?type=lore').catch(() => null),
    apiGet('/api/ordeal-responses?type=covenant').catch(() => null),
    apiGet('/api/ordeal_submissions/mine').catch(() => []),
  ]);

  playerDoc = pDoc;
  statusCache = {
    questionnaire: qDoc?.status || null,
    history:       hDoc?.status || null,
    rules:         rulesDoc?.status || null,
    lore:          loreDoc?.status || null,
    covenant:      covDoc?.status || null,
  };

  submissionsMap = {};
  for (const s of (subDocs || [])) {
    // character_history is character-level: only store if it matches the current character
    // Other ordeal types are player-level and should always be shown
    if (s.ordeal_type === 'character_history' && s.character_id && s.character_id.toString() !== char._id.toString()) continue;
    submissionsMap[s.ordeal_type] = s;
  }

  // Issue #928: rules/lore/covenant ordeals live in `ordeal_responses` (loaded above as rulesDoc/loreDoc/
  // covDoc), whose `marking` carries a feedback round. `/api/ordeal_submissions/mine` does NOT return them,
  // so seed submissionsMap from the response docs' marking — keyed by ordeal_submissions type so
  // getOrdealStatus/renderFeedback read it through the existing path. Only seed when no real
  // ordeal_submissions entry exists for that type (a real submission always takes precedence).
  const responseMarkingByType = {
    rules_mastery:          rulesDoc?.marking,
    lore_mastery:           loreDoc?.marking,
    covenant_questionnaire: covDoc?.marking,
  };
  for (const [subType, marking] of Object.entries(responseMarkingByType)) {
    if (marking && !submissionsMap[subType]) submissionsMap[subType] = { marking };
  }

  renderOrdealsList(el, char);
}

// ── Player Preferences (#542) ────────────────────────────────────────────────

function renderPlayerPrefs(char) {
  const prefs = char.player_prefs || {};
  const updatedAt = prefs.updated_at
    ? new Date(prefs.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  let h = '<div class="xpl-panel player-prefs-panel">';
  h += '<div class="xpl-col-head">Chronicle Preferences</div>';

  h += '<p class="player-prefs-desc">Helps the ST team calibrate content — it doesn\'t affect your individual story.</p>';

  h += '<table class="pref-axes-table">';
  for (const axis of PLAYER_PREF_AXES) {
    const current = prefs[axis.key]?.rating ?? null;
    h += `<tr class="pref-axis-row" data-pref-key="${esc(axis.key)}">`;
    h += `<td class="pref-axis-lbl">${esc(axis.label)}</td>`;
    h += '<td class="pref-dots-cell"><div class="dot-stepper">';
    for (let i = 1; i <= 5; i++) {
      const filled = current !== null && i <= current;
      h += `<span class="pref-dot ${filled ? 'filled' : 'empty'}" data-value="${i}" aria-label="${esc(axis.label)} ${i} of 5">●</span>`;
    }
    h += '</div></td>';
    h += '</tr>';
  }
  if (updatedAt) {
    h += `<tr><td colspan="2" class="player-prefs-updated">Last updated ${esc(updatedAt)}</td></tr>`;
  }
  h += '</table>';
  h += '<button type="button" class="qf-btn qf-btn-submit player-prefs-save" id="player-prefs-save">Save Preferences</button>';
  h += '</div>';
  return h;
}

// ── XP breakdown ─────────────────────────────────────────────────────────────

function renderXPBreakdown(char) {
  const earnedParts = {
    starting:     xpStarting(char),
    humanityDrop: xpHumanityDrop(char),
    ordeals:      xpOrdeals(char),
    game:         xpGame(char),
    pt5:          xpPT5(char),
  };
  const totalEarned = xpEarned(char);
  const spentParts = {
    attrs:   xpSpentAttrs(char),
    skills:  xpSpentSkills(char),
    powers:  xpSpentPowers(char),
    merits:  xpSpentMerits(char),
    special: xpSpentSpecial(char),
  };
  const totalSpent = xpSpent(char);
  const remaining  = xpLeft(char);
  const over       = remaining < 0;

  // Completed ordeal names for detail rows
  const completedOrdeals = Array.isArray(char.ordeals)
    ? char.ordeals.filter(o => o.complete).map(o => o.name)
    : [];

  // Per-discipline XP for detail rows (inline on discipline objects)
  const discLines = Object.entries(char.disciplines || {})
    .filter(([, v]) => (v?.xp || 0) > 0)
    .map(([name, v]) => ({ name, xp: v.xp }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Special sub-breakdown
  const bpXP = (char.bp_creation || {}).xp !== undefined
    ? ((char.bp_creation || {}).xp || 0)
    : Math.max(0, (char.blood_potency || 1) - 1 - Math.floor(((char.bp_creation || {}).cp || 0) / 5)) * 5;
  const humXP = char.humanity_xp || 0;
  const wpXP  = ((char.xp_log || {}).spent || {}).willpower || 0;
  const manualXP = ((char.xp_log || {}).spent || {}).special || 0;

  const sub = (label, val) =>
    val > 0 ? `<tr class="xpl-sub"><td>\u00a0\u00a0\u00b7 ${esc(label)}</td><td class="xpl-n">${val}</td></tr>` : '';

  let h = '<div class="xpl-panel">';
  h += '<div class="xpl-cols">';

  // ── Earned column ────────────────────────────────────────────────
  h += '<div class="xpl-col">';
  h += '<div class="xpl-col-head">Earned</div>';
  h += '<table class="xpl-table">';
  h += `<tr><td>Starting</td><td class="xpl-n">${earnedParts.starting}</td></tr>`;
  if (earnedParts.humanityDrop > 0)
    h += `<tr><td>Humanity drops (${Math.round(earnedParts.humanityDrop / 2)}&times;2)</td><td class="xpl-n">${earnedParts.humanityDrop}</td></tr>`;
  if (earnedParts.ordeals > 0) {
    h += `<tr><td>Ordeals</td><td class="xpl-n">${earnedParts.ordeals}</td></tr>`;
    for (const name of completedOrdeals)
      h += sub(name, 3);
  }
  if (earnedParts.game > 0) {
    h += `<tr><td>Game attendance</td><td class="xpl-n">${earnedParts.game}</td></tr>`;
    for (const g of (char._gameXPDetail || [])) {
      const paid = g.paid ? ' <span class="xpl-paid">PAID</span>' : '';
      const parts = [];
      if (g.attended) parts.push('attend');
      if (g.costuming) parts.push('costume');
      if (g.downtime) parts.push('downtime');
      if (g.extra) parts.push('+' + g.extra);
      const detail = parts.length ? ' <span class="xpl-dim">(' + parts.join(', ') + ')</span>' : '';
      h += `<tr class="xpl-sub"><td>\u00a0\u00a0\u00b7 ${esc(g.title)}${paid}${detail}</td><td class="xpl-n">${g.xp}</td></tr>`;
    }
  }
  if (earnedParts.pt5 > 0) {
    const ptM = (char.merits || []).find(m => m.name === 'Professional Training');
    const ptAssets = (ptM?.asset_skills || []).filter(Boolean);
    const ptBonus = char._pt_dot4_bonus_skills instanceof Set ? char._pt_dot4_bonus_skills : new Set();
    const maxedAssets = ptAssets.filter(sk => ((char.skills?.[sk]?.dots || 0) + (ptBonus.has(sk) ? 1 : 0)) >= 5);
    h += `<tr class="xpl-bonus"><td>Professional Training (${earnedParts.pt5} asset${earnedParts.pt5 > 1 ? 's' : ''} at 5)</td><td class="xpl-n">${earnedParts.pt5}</td></tr>`;
    for (const sk of maxedAssets) h += `<tr class="xpl-sub"><td>\u00a0\u00a0\u00b7 ${esc(sk)} \u25cf\u25cf\u25cf\u25cf\u25cf</td><td class="xpl-n">1</td></tr>`;
  }
  h += `<tr class="xpl-total"><td>Total</td><td class="xpl-n">${totalEarned}</td></tr>`;
  h += '</table></div>';

  // ── Spent column ─────────────────────────────────────────────────
  h += '<div class="xpl-col">';
  h += '<div class="xpl-col-head">Spent</div>';
  h += '<table class="xpl-table">';
  const anySpent = Object.values(spentParts).some(v => v > 0);
  if (spentParts.attrs > 0)   h += `<tr><td>Attributes</td><td class="xpl-n">${spentParts.attrs}</td></tr>`;
  if (spentParts.skills > 0)  h += `<tr><td>Skills</td><td class="xpl-n">${spentParts.skills}</td></tr>`;
  if (spentParts.powers > 0) {
    h += `<tr><td>Disciplines &amp; powers</td><td class="xpl-n">${spentParts.powers}</td></tr>`;
    for (const d of discLines)
      h += sub(d.name, d.xp);
  }
  if (spentParts.merits > 0)  h += `<tr><td>Merits &amp; styles</td><td class="xpl-n">${spentParts.merits}</td></tr>`;
  if (spentParts.special > 0) {
    h += `<tr><td>Special</td><td class="xpl-n">${spentParts.special}</td></tr>`;
    h += sub('Blood Potency', bpXP);
    h += sub('Humanity', humXP);
    h += sub('Willpower', wpXP);
    h += sub('Other', manualXP);
  }
  if (!anySpent) h += '<tr><td colspan="2" class="xpl-none">None yet</td></tr>';
  h += `<tr class="xpl-total"><td>Total</td><td class="xpl-n">${totalSpent}</td></tr>`;
  h += '</table></div>';

  h += '</div>';

  const sign = remaining > 0 ? '+' : '';
  h += `<div class="xpl-balance ${over ? 'xpl-over' : 'xpl-ok'}">`;
  h += `<span class="xpl-bal-lbl">Remaining</span>`;
  h += `<span class="xpl-bal-val">${sign}${remaining} XP</span>`;
  h += '</div>';
  h += '</div>';
  return h;
}

// ── Ordeal list ───────────────────────────────────────────────────────────────

function renderOrdealsList(el, char) {
  const cOrdeals = normaliseCharOrdeals(char);

  // Single-column: ordeals first, XP breakdown below
  let h = `<div class="ordeal-col">`;

  h += '<div class="ordeals-container" id="ordeals-list">';
  h += '<div class="ordeals-section">';
  h += '<h3 class="ordeals-heading">Ordeals</h3>';
  for (const def of CHAR_ORDEALS) {
    h += ordealCard(def, getOrdealStatus(def, cOrdeals));
  }
  h += '</div>';
  h += '<div class="ordeals-section">';
  h += '<h3 class="ordeals-heading">Player Ordeals</h3>';
  for (const def of PLAYER_ORDEALS) {
    h += ordealCard(def, getOrdealStatus(def, cOrdeals));
  }
  h += '</div>';
  h += '</div>'; // ordeals-container

  h += renderPlayerPrefs(char);

  h += renderXPBreakdown(char);

  h += '</div>'; // ordeal-col

  el.innerHTML = h;

  el.querySelectorAll('.ordeal-card[data-form]').forEach(card => {
    card.addEventListener('click', () => openForm(el, card.dataset.form));
  });

  // Dot toggle — fill up to clicked value; clicking the sole filled dot deselects
  el.querySelectorAll('.pref-axis-row .pref-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const row = dot.closest('.pref-axis-row');
      const clickedVal = +dot.dataset.value;
      const filledDots = row.querySelectorAll('.pref-dot.filled');
      const newVal = (filledDots.length === 1 && filledDots[0] === dot) ? 0 : clickedVal;
      row.querySelectorAll('.pref-dot').forEach((d, idx) => {
        const fill = idx < newVal;
        d.classList.toggle('filled', fill);
        d.classList.toggle('empty', !fill);
      });
    });
  });

  // Save button
  const saveBtn = el.querySelector('#player-prefs-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const prefs = {};
      for (const axis of PLAYER_PREF_AXES) {
        const dots = el.querySelectorAll(`.pref-axis-row[data-pref-key="${axis.key}"] .pref-dot`);
        let rating = null;
        dots.forEach((d, idx) => { if (d.classList.contains('filled')) rating = idx + 1; });
        prefs[axis.key] = { rating };
      }
      try {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        await apiPatch(`/api/characters/${currentChar._id}/player_prefs`, { player_prefs: prefs });
        currentChar.player_prefs = { ...prefs, updated_at: new Date().toISOString() };
        renderOrdealsList(el, currentChar);
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Preferences';
        alert('Save failed: ' + err.message);
      }
    });
  }
}

// ── Status resolution ─────────────────────────────────────────────────────────

function getOrdealStatus(def, cOrdeals) {
  const subType    = KEY_TO_SUBMISSION_TYPE[def.key] || KEY_TO_SUBMISSION_TYPE[def.altKey];
  const sub        = subType ? submissionsMap[subType] : null;
  const subStatus  = sub?.marking?.status; // 'unmarked' | 'in_progress' | 'complete'

  const responseStatus = statusCache[def.key] || statusCache[def.altKey];

  // Issue #930: a pass requires ALL yes. Any near/no in the marking is a feedback round, even if a legacy
  // 'approved' status or a complete flag is set — the verdicts, not the status flag, decide a clean pass.
  const markFlagged = Array.isArray(sub?.marking?.answers)
    && sub.marking.answers.some(a => a.result === 'near' || a.result === 'no');

  // Approved (clean pass) from any source — but only when the verdicts are not flagged.
  const charApproved = cOrdeals[def.key]?.complete || (def.altKey && cOrdeals[def.altKey]?.complete);
  if (!markFlagged && (subStatus === 'complete' || responseStatus === 'approved' || charApproved)) {
    return { status: 'approved', submission: subStatus === 'complete' ? sub : null };
  }

  // A feedback round (a flagged marking, or an in_progress marking) the player must act on. Surface it with
  // the submission so renderFeedback runs, ahead of the bare 'submitted' (which an ordeal_responses
  // feedback round keeps at top level and would otherwise mask). Issue #930 + #928.
  if (markFlagged) return { status: 'in_review', submission: sub };
  if (subStatus === 'in_progress') return { status: 'in_review', submission: sub };

  if (responseStatus === 'submitted') return { status: 'submitted' };
  if (subStatus === 'unmarked')       return { status: 'submitted' };

  if (responseStatus === 'draft') return { status: 'draft' };

  return { status: 'not_started' };
}

// ── Card rendering ────────────────────────────────────────────────────────────

function ordealCard(def, status) {
  const s         = status.status || 'not_started';
  const done      = s === 'approved';
  const inReview  = s === 'in_review';
  const submitted = s === 'submitted';
  const draft     = s === 'draft';

  const stateClass = done ? 'done' : inReview ? 'in_review' : submitted ? 'pending' : draft ? 'draft' : 'incomplete';
  const stateLabel = done ? 'Approved' : inReview ? 'In Review' : submitted ? 'Submitted' : draft ? 'In Progress' : 'Not Started';
  const icon       = done ? '&#10003;' : (submitted || inReview) ? '&#9679;' : draft ? '&#9998;' : '&#9675;';
  const xp         = done ? '+3 XP' : '';

  // Every ordeal stays reopenable after approval so players can review their submitted
  // answers and ST feedback; STs get an Edit button inside the form to make changes.
  const formAttr  = def.hasForm ? ` data-form="${def.formType}"` : '';
  const clickHint = def.hasForm
    ? `<span class="ordeal-action">${done ? 'View' : 'Open'} &rarr;</span>`
    : '';

  const feedbackHtml = renderFeedback(status.submission);

  return `<div class="ordeal-card ${stateClass}"${formAttr}>
    <div class="ordeal-row">
      <div class="ordeal-icon">${icon}</div>
      <div class="ordeal-info">
        <div class="ordeal-label">${esc(def.label)}</div>
        <div class="ordeal-desc">${esc(def.desc)}</div>
      </div>
      <div class="ordeal-status">
        <span class="ordeal-state">${stateLabel}</span>
        ${xp ? `<span class="ordeal-xp">${xp}</span>` : ''}
        ${clickHint}
      </div>
    </div>${feedbackHtml}
  </div>`;
}

function renderFeedback(sub) {
  // Show feedback for both fully-marked ordeals and feedback rounds — a graded-but-
  // incomplete submission (in_progress) the player still has near/no answers to fix.
  if (!sub?.marking || !['complete', 'in_progress'].includes(sub.marking.status)) return '';

  const { overall_feedback, answers } = sub.marking;
  const inProgress          = sub.marking.status === 'in_progress';
  const hasOverall          = overall_feedback?.trim();
  const answersWithFeedback = (answers || []).filter(a => a.feedback?.trim());

  if (!hasOverall && !answersWithFeedback.length) return '';

  const RESULT_LABEL = { yes: 'Yes', near: 'Near', no: 'No' };

  let h = '<div class="ordeal-feedback">';

  // Feedback-round cue so the player knows this is a revision pass, not a final mark.
  if (inProgress) {
    h += '<div class="or-result-near"><span class="ordeal-fb-result">Needs revision</span></div>';
  }

  if (hasOverall) {
    h += `<div class="ordeal-fb-overall">${esc(overall_feedback)}</div>`;
  }

  if (answersWithFeedback.length) {
    h += '<div class="ordeal-fb-answers">';
    for (const a of answersWithFeedback) {
      // The ST's notes are self-contained, so each item shows just the result and the
      // note. No question pairing (the rubric holds the answer key and is ST-only).
      const resLbl = a.result ? RESULT_LABEL[a.result] : null;
      h += `<div class="ordeal-fb-item${a.result ? ` or-result-${a.result}` : ''}">`;
      if (resLbl) h += `<div class="ordeal-fb-q"><span class="ordeal-fb-result">${esc(resLbl)}</span></div>`;
      h += `<div class="ordeal-fb-text">${esc(a.feedback)}</div>`;
      h += '</div>';
    }
    h += '</div>';
  }

  h += '</div>';
  return h;
}

// ── Form navigation ───────────────────────────────────────────────────────────

function openForm(el, formType) {
  let h = '<div class="ordeals-container">';
  h += '<button class="qf-back-btn" id="qf-back">&larr; Back to XP Log</button>';
  h += '<div id="qf-target"></div>';
  h += '</div>';
  el.innerHTML = h;

  document.getElementById('qf-back').addEventListener('click', () => {
    renderOrdealsList(el, currentChar);
  });

  const target = document.getElementById('qf-target');

  switch (formType) {
    case 'questionnaire':
      renderQuestionnaire(target, currentChar);
      break;
    case 'history':
      renderHistory(target, currentChar);
      break;
    case 'rules':
      renderOrdealForm(target, 'rules', 'Rules Mastery', RULES_SECTIONS);
      break;
    case 'lore':
      renderOrdealForm(target, 'lore', 'Lore Mastery', LORE_SECTIONS);
      break;
    case 'covenant':
      renderCovenantForm(target);
      break;
  }
}

async function renderCovenantForm(target) {
  let responseDoc = null;
  try { responseDoc = await apiGet('/api/ordeal-responses?type=covenant'); } catch { /* none */ }

  let savedCovenant = null;
  if (responseDoc?.responses?.covenant_choice) {
    savedCovenant = responseDoc.responses.covenant_choice;
  } else if (currentChar.covenant && COVENANT_SECTIONS[currentChar.covenant]) {
    savedCovenant = currentChar.covenant;
  }

  if (savedCovenant && COVENANT_SECTIONS[savedCovenant]) {
    renderOrdealForm(target, 'covenant', `Covenant Ordeal \u2014 ${savedCovenant}`, COVENANT_SECTIONS[savedCovenant]);
  } else {
    target.innerHTML = `<div id="cov-picker" class="reading-pane"></div>`;
    const picker = document.getElementById('cov-picker');
    let h = '<div class="qf-header"><h3 class="qf-title">Covenant Questionnaire</h3></div>';
    h += '<div class="qf-field">';
    h += `<label class="qf-label">${esc(COVENANT_ROUTING.label)} <span class="qf-req">*</span></label>`;
    h += '<div class="qf-radio-group">';
    for (const opt of COVENANT_ROUTING.options) {
      h += `<label class="qf-radio-label"><input type="radio" name="cov-pick" value="${esc(opt.value)}"><span>${esc(opt.label)}</span></label>`;
    }
    h += '</div></div>';
    h += '<div class="qf-actions"><button class="qf-btn qf-btn-submit" id="cov-start">Start</button></div>';
    picker.innerHTML = h;

    document.getElementById('cov-start').addEventListener('click', () => {
      const checked = document.querySelector('input[name="cov-pick"]:checked');
      if (!checked) return;
      const cov = checked.value;
      if (COVENANT_SECTIONS[cov]) renderOrdealForm(target, 'covenant', `Covenant Ordeal \u2014 ${cov}`, COVENANT_SECTIONS[cov]);
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseCharOrdeals(char) {
  const ordeals = char.ordeals;
  if (!ordeals) return {};
  if (!Array.isArray(ordeals)) return ordeals;
  const out = {};
  for (const o of ordeals) {
    out[o.name] = { status: o.complete ? 'approved' : 'not_started', complete: o.complete };
  }
  return out;
}

export function resetPlayerDoc() {
  playerDoc = null;
}
