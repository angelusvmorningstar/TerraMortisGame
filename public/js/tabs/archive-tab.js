/* Story tab — the character's dossier (live sheet + questionnaire), their published
 * downtime narratives, and the chronicle's retired characters.
 *
 * RETIREMENT NOTE, Story 31-5 (TM Wiki), 2026-08-15. This tab used to have a fourth
 * data source: `archive_documents`, the ST-authored narrative documents (dossier
 * prose, downtime responses, character histories) that `archive-documents.js`
 * served. That collection, its reader AND its writer have all moved to TM Wiki -
 * the reader/writer/storage-together constraint from TM Wiki's deferred-work item
 * 163 - so every `archive_documents` fetch, list group, detail view and inline-edit
 * affordance is gone from this file, along with `archive-admin.js` and
 * `archive-inline-editor.js`.
 *
 * WHAT DELIBERATELY SURVIVED, because none of it was ever archive_documents data:
 *   1. the Core Info Card, live from the character sheet;
 *   2. Questionnaire Details, live from `questionnaire_responses`;
 *   3. Downtime Reports, live from `downtime_submissions.published_outcome`;
 *   4. the Retired Characters grid and its sheet view.
 *
 * (1) and (2) previously had NO entry point of their own - they were stitched into
 * the detail view of a `dossier`-type archive document, so removing that document
 * type would have taken them with it as collateral damage. They now hang off a
 * Dossier row that is always present, rendered from the live character the tab was
 * opened with. Same two sections, same renderers, same click depth; only the thing
 * that used to carry them is gone.
 *
 * (3) is NOT the same content as the migrated `downtime_response` documents even
 * though it reads similarly: `downtime_submissions` is a much larger, actively
 * mechanical collection (feeding rolls, project and merit resolution) that stays in
 * `tm_suite`, and the migrated documents were a curated player-safe excerpt an ST
 * made from its `published_outcome`. Do not "tidy" the two together.
 */

import { apiGet } from '../data/api.js';
import { esc, displayName, clanIcon, covIcon } from '../data/helpers.js';
import { renderSheet } from '../editor/sheet.js';
import { renderReadOnlyField } from '../editor/questionnaire-render.js';
import { QUESTIONNAIRE_SECTIONS } from './questionnaire-data.js';
import { renderOutcomeWithCards, fetchAndMergeStoryTabDowntimes, sortDowntimesByChapterRecency } from './story-tab.js';

let _el          = null;
let _char        = null;
let _retiredChars = [];

export async function initArchiveTab(el, char, retiredChars) {
  _el           = el;
  _char         = char;
  _retiredChars = retiredChars || [];
  await renderArchiveList();
}

// ── List view ─────────────────────────────────────────────────────────────────

// Story storytab.5, AC 2/AC 9: the fetch+merge+sort data logic, extracted into one
// DOM-free async function so it can be unit-tested directly (this repo's `vitest.config.js`
// has no jsdom environment — see that story's Story-Prep Question 2, closed) rather than
// only provable via a live-browser check. `renderArchiveList` below is left doing only DOM
// work: build the HTML, wire the click handlers.
export async function loadArchiveDowntimeData(char) {
  let subs = [], cycles = [];
  try {
    [subs, cycles] = await Promise.all([
      apiGet('/api/downtime_submissions').catch(() => []),
      apiGet('/api/chapters').catch(() => []),
    ]);
    subs.forEach(s => {
      if (!s.published_outcome && s.st_review?.outcome_visibility === 'published') {
        s.published_outcome = s.st_review.outcome_text;
      }
    });
  } catch { /* non-fatal */ }

  [subs, cycles] = await fetchAndMergeStoryTabDowntimes(char, subs, cycles);

  const cycleMap = {};
  for (const c of cycles) cycleMap[String(c._id)] = c.label || `Cycle ${String(c._id).slice(-4)}`;
  const charId = String(char._id);
  const filtered = subs.filter(s => String(s.character_id) === charId && s.published_outcome);
  const downtimeSubs = sortDowntimesByChapterRecency(filtered, cycles);

  return { downtimeSubs, cycleMap };
}

async function renderArchiveList() {
  _el.innerHTML = '<p class="placeholder-msg">Loading…</p>';

  const { downtimeSubs, cycleMap } = await loadArchiveDowntimeData(_char);

  let h = '';

  // The Dossier row is unconditional: it is rendered from the live character this
  // tab was opened with, so it always has something to show. It replaces the
  // former archive_documents-backed dossier item, which is what used to carry the
  // Core Info Card and Questionnaire Details.
  h += '<div class="arc-docs">';
  h += '<div class="arc-doc-group">';
  h += '<div class="arc-doc-group-title">Dossier</div>';
  h += '<div class="arc-doc-item" data-dossier="1">';
  h += '<span class="arc-doc-title">Dossier</span>';
  h += '<span class="arc-doc-meta">Sheet and questionnaire</span>';
  h += '<span class="arc-doc-arrow">&rsaquo;</span>';
  h += '</div>';
  h += '</div>';
  if (downtimeSubs.length) h += renderDowntimeGroup('Downtime Reports', downtimeSubs, cycleMap);
  h += '</div>';

  // ── Retired characters ──
  if (_retiredChars.length) {
    h += '<div class="arc-retired">';
    h += '<h3 class="arc-section-title">Retired Characters</h3>';
    h += '<div class="archive-grid">';
    for (const c of _retiredChars) {
      const meta = [c.clan, c.covenant].filter(Boolean).join(' · ');
      const bp   = c.blood_potency ? `BP ${c.blood_potency}` : '';
      h += `<div class="archive-card" data-char-id="${esc(String(c._id))}">`;
      h += `<div class="archive-card-name">${esc(displayName(c))}</div>`;
      if (meta) h += `<div class="archive-card-meta">${esc(meta)}</div>`;
      if (bp)   h += `<div class="archive-card-bp">${esc(bp)}</div>`;
      h += '<span class="archive-badge">Retired</span>';
      h += '</div>';
    }
    h += '</div>';
    h += '</div>';
  }

  _el.innerHTML = h;

  _el.querySelectorAll('.arc-doc-item[data-dossier]').forEach(item => {
    item.addEventListener('click', () => openDossierDetail());
  });
  _el.querySelectorAll('.arc-doc-item[data-sub-id]').forEach(item => {
    item.addEventListener('click', () => openDowntimeDetail(item.dataset.subId, downtimeSubs, cycleMap));
  });

  _el.querySelectorAll('.archive-card').forEach(card => {
    card.addEventListener('click', () => {
      const c = _retiredChars.find(r => String(r._id) === card.dataset.charId);
      if (c) openCharSheet(c);
    });
  });
}

function renderDowntimeGroup(heading, submissions, cycleMap) {
  let h = `<div class="arc-doc-group">`;
  h += `<div class="arc-doc-group-title">${esc(heading)}</div>`;
  for (const sub of submissions) {
    const cycleLabel = cycleMap[String(sub.chapter_id)] || 'Unknown Cycle';
    h += `<div class="arc-doc-item" data-sub-id="${esc(String(sub._id))}">`;
    h += `<span class="arc-doc-title">${esc(cycleLabel)}</span>`;
    h += `<span class="arc-doc-meta">Downtime narrative</span>`;
    h += '<span class="arc-doc-arrow">&rsaquo;</span>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function openDowntimeDetail(subId, allSubs, cycleMap) {
  const sub = allSubs.find(s => String(s._id) === String(subId));
  if (!sub) {
    _el.innerHTML = '<p class="placeholder-msg">Downtime narrative not found.</p>';
    return;
  }
  const cycleLabel = cycleMap[String(sub.chapter_id)] || 'Unknown Cycle';

  let h = '<div class="arc-detail">';
  h += `<button class="qf-back-btn" id="arc-back">&larr; Back to Archive</button>`;
  h += `<div class="arc-detail-header">`;
  h += `<div class="arc-detail-title">${esc(cycleLabel)} &mdash; Downtime narrative</div>`;
  h += '</div>';
  h += '<div class="arc-detail-body reading-pane">';
  h += renderOutcomeWithCards(sub);
  h += '</div>';
  h += '</div>';

  _el.innerHTML = h;
  document.getElementById('arc-back').addEventListener('click', renderArchiveList);
}

// ── Dossier detail view ───────────────────────────────────────────────────────
//
// Two LIVE sections, unchanged in content from before Story 31-5:
//   1. Core Info Card — live from the character sheet
//   2. Questionnaire Details — live from questionnaire_responses
//
// The third section this view used to render, "History Narrative"
// (archive_documents.content_html, ST-editable via the ORD-3 inline editor), is
// gone: that document now lives in TM Wiki and is read there, on the player's own
// character profile page. Nothing here fetches it, and there is no edit button,
// because this app is no longer a writer of that collection.

async function openDossierDetail() {
  _el.innerHTML = '<p class="placeholder-msg">Loading…</p>';

  // Best-effort, exactly as before: a null response just hides that section
  // rather than failing the whole view.
  let questionnaireResponses = null;
  if (_char?._id) {
    try {
      const qDoc = await apiGet(`/api/questionnaire?character_id=${_char._id}`);
      questionnaireResponses = qDoc?.responses || null;
    } catch { /* non-fatal — render without it */ }
  }

  let h = '<div class="arc-detail">';
  h += `<button class="qf-back-btn" id="arc-back">&larr; Back to Archive</button>`;
  h += `<div class="arc-detail-header">`;
  h += `<div class="arc-detail-title">Dossier</div>`;
  h += '</div>';
  h += '<div class="arc-detail-body reading-pane">';
  h += renderCoreInfoCard(_char);
  if (questionnaireResponses) h += renderQuestionnaireDetails(questionnaireResponses);
  h += '</div>';
  h += '</div>';

  _el.innerHTML = h;
  document.getElementById('arc-back').addEventListener('click', renderArchiveList);
}

// ── Core Info Card — live from character sheet ────────────────────────────────
function renderCoreInfoCard(c) {
  if (!c) return '';

  const embraceDisp = c.date_of_embrace
    ? new Date(c.date_of_embrace + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const bp = c.blood_potency;
  const bpDisp = (bp != null && bp !== '')
    ? (('●'.repeat(parseInt(bp) || 0)) || String(bp))
    : '';

  let h = '<div class="arc-core-card">';

  // Identity row — name, clan, covenant with icons (matches questionnaire char-header pattern)
  h += `<div class="arc-core-name">${esc(displayName(c))}</div>`;
  h += '<div class="arc-core-identity">';
  if (c.clan) {
    h += `<span class="arc-core-clan">${clanIcon(c.clan, 18)}<span>${esc(c.clan)}</span>`;
    if (c.bloodline) h += ` <span class="arc-core-bloodline">/ ${esc(c.bloodline)}</span>`;
    h += '</span>';
  }
  if (c.covenant) {
    h += `<span class="arc-core-cov">${covIcon(c.covenant, 18)}<span>${esc(c.covenant)}</span></span>`;
  }
  h += '</div>';

  // Grid of the remaining fields
  const rows = [];
  if (c.mask)          rows.push(['Mask',        c.mask]);
  if (c.dirge)         rows.push(['Dirge',       c.dirge]);
  if (bpDisp)          rows.push(['Blood Potency', bpDisp]);
  if (c.apparent_age)  rows.push(['Apparent Age', c.apparent_age]);
  if (c.humanity != null) rows.push(['Humanity',  String(c.humanity)]);
  if (embraceDisp)     rows.push(['Embraced',    embraceDisp]);
  if (c.city_status != null)     rows.push(['City Status',     String(c.city_status)]);
  if (c.clan_status != null)     rows.push(['Clan Status',     String(c.clan_status)]);
  if (c.covenant_status != null) rows.push(['Covenant Status', String(c.covenant_status)]);

  if (rows.length) {
    h += '<dl class="arc-core-grid">';
    for (const [label, value] of rows) {
      h += `<dt class="arc-core-label">${esc(label)}</dt>`;
      h += `<dd class="arc-core-value">${esc(value)}</dd>`;
    }
    h += '</dl>';
  }

  h += '</div>';
  return h;
}

// ── Questionnaire Details — live from questionnaire_responses ────────────────
function renderQuestionnaireDetails(responses) {
  if (!responses) return '';

  // Skip Player Info (meta, not narrative).
  const narrativeSections = QUESTIONNAIRE_SECTIONS.filter(s => s.key !== 'player_info');

  // Build per-section content; only render sections that have at least one answered field.
  let anyContent = false;
  let inner = '';

  for (const section of narrativeSections) {
    let sectionHtml = '';
    for (const q of section.questions) {
      const value = responses[q.key];
      const rendered = renderReadOnlyField(q, value === undefined ? '' : value);
      if (rendered) sectionHtml += rendered;
    }
    if (sectionHtml) {
      anyContent = true;
      inner += `<div class="arc-quest-section">`;
      inner += `<h4 class="arc-quest-section-title">${esc(section.title)}</h4>`;
      inner += sectionHtml;
      inner += '</div>';
    }
  }

  if (!anyContent) return '';

  return `<div class="arc-quest-details">${inner}</div>`;
}

// ── Retired character sheet view ──────────────────────────────────────────────

function openCharSheet(c) {
  let h = '<div class="archive-detail">';
  h += '<button class="qf-back-btn" id="arc-back">&larr; Back to Archive</button>';
  h += '<div id="archive-sheet-target"></div>';
  h += '</div>';
  _el.innerHTML = h;

  document.getElementById('arc-back').addEventListener('click', renderArchiveList);
  renderSheet(c, document.getElementById('archive-sheet-target'));
}
