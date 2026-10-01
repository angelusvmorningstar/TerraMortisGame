/* Character creation wizard — 6-step guided flow for new players.
 * Steps: Identity → Attributes → Skills → Merits → Disciplines → Review
 * First character auto-approved; subsequent chars await ST sign-off. */

import { apiPost } from '../data/api.js';
import { esc } from '../data/helpers.js';
import { prereqLabel } from '../data/prereq.js';
import {
  CLANS, COVENANTS, MASKS_DIRGES,
  ATTR_CATS, SKILL_CATS,
  CLAN_DISCS,
  PRI_LABELS, PRI_BUDGETS, SKILL_PRI_BUDGETS,
} from '../data/constants.js';
// BL-3b (#1008). This file has zero importers and is unreachable — #1095 owns
// whether it lives at all — but it imported BLOODLINE_CLANS, which BL-3b
// deleted. A dangling import of a deleted export is a landmine for whoever
// revives it, so it is rewired to the cache exactly as `editor/edit.js` was.
// It is NOT wired into any app and does NOT prime the cache.
import { bloodlinesByClan } from '../data/bloodlines-cache.js';
import { getRulesByCategory, getRuleByKey } from '../data/loader.js';

// ── Constants ─────────────────────────────────────────────────────────────

const DISC_BUDGET    = 3;   // discipline dots at creation
const MERIT_BUDGET   = 7;   // merit dots at creation
const ALL_COVENANTS  = [...COVENANTS, 'Unaligned'];

const INFLUENCE_MERITS = new Set(['allies','contacts','herd','mentor','resources','retainer','staff','mortal status']);
const DOMAIN_MERITS    = new Set(['safe place','haven','feeding grounds','mandragora garden']);
const STANDING_MERITS  = new Set(['mystery cult initiation','professional training']);
// Skip covenant-law / invictus-oath / style merits in wizard (complex, ST-managed)
const SKIP_TYPES = new Set(['Style','Invictus Oath','Carthian Law']);

const STEP_LABELS = ['Identity','Attributes','Skills','Merits','Disciplines','Review'];

// ── State ─────────────────────────────────────────────────────────────────

let wiz = null;
let container = null;
let onComplete = null;

function initState() {
  return {
    step: 1,
    // Identity
    name: '', concept: '', pronouns: '', apparent_age: '',
    clan: '', bloodline: null, covenant: '', mask: '', dirge: '',
    humanity: 7,
    // Attributes
    attrPri: { Mental: 'Primary', Physical: 'Secondary', Social: 'Tertiary' },
    attrDots: {},  // extra dots above 1, keyed by attr name
    // Skills
    skillPri: { Mental: 'Primary', Physical: 'Secondary', Social: 'Tertiary' },
    skillDots: {}, // total creation dots, keyed by skill name
    // Merits
    merits: [],    // [{ name, key, rating, category }]
    // Disciplines
    disciplines: {}, // { DiscName: dots }
    // UI scratch
    meritSearch: '',
  };
}

export function startWizard(el, onDone) {
  container = el;
  onComplete = onDone;
  wiz = initState();
  render();
}

// ── Render ────────────────────────────────────────────────────────────────

function render() {
  let h = '<div class="wiz-wrap">';

  // Progress strip
  h += '<div class="wiz-progress">';
  for (let i = 0; i < STEP_LABELS.length; i++) {
    const n = i + 1;
    const cls = n < wiz.step ? 'done' : n === wiz.step ? 'active' : '';
    h += `<div class="wiz-step ${cls}"><span class="wiz-step-n">${n < wiz.step ? '✓' : n}</span><span class="wiz-step-lbl">${STEP_LABELS[i]}</span></div>`;
  }
  h += '</div>';

  // Step content
  h += '<div class="wiz-body" id="wiz-body">';
  h += renderStep();
  h += '</div>';

  // Error zone
  h += '<div class="wiz-error" id="wiz-error"></div>';

  // Navigation
  h += '<div class="wiz-nav">';
  if (wiz.step > 1) h += `<button class="wiz-btn wiz-back" id="wiz-back">← Back</button>`;
  if (wiz.step < STEP_LABELS.length) {
    h += `<button class="wiz-btn wiz-next" id="wiz-next">Next →</button>`;
  } else {
    h += `<button class="wiz-btn wiz-submit" id="wiz-submit">Create Character</button>`;
  }
  h += '</div>';

  h += '</div>';
  container.innerHTML = h;

  attachEvents();
}

function renderStep() {
  switch (wiz.step) {
    case 1: return stepIdentity();
    case 2: return stepAttributes();
    case 3: return stepSkills();
    case 4: return stepMerits();
    case 5: return stepDisciplines();
    case 6: return stepReview();
  }
  return '';
}

// ── Step 1: Identity ─────────────────────────────────────────────────────

function stepIdentity() {
  const bloodlines = wiz.clan ? (bloodlinesByClan()[wiz.clan] || []) : [];

  let h = '<h2 class="wiz-title">Identity</h2>';
  h += '<div class="wiz-fields">';

  // Name + concept
  h += wizField('Character Name', `<input class="wiz-input" id="w-name" value="${esc(wiz.name)}" placeholder="Required" maxlength="80">`);
  h += wizField('Concept', `<input class="wiz-input" id="w-concept" value="${esc(wiz.concept)}" placeholder="e.g. Ruined detective" maxlength="80">`);
  h += wizField('Pronouns', `<input class="wiz-input" id="w-pronouns" value="${esc(wiz.pronouns)}" placeholder="e.g. she/her" maxlength="30">`);
  h += wizField('Apparent Age', `<input class="wiz-input" id="w-age" value="${esc(wiz.apparent_age)}" placeholder="e.g. mid-30s" maxlength="40">`);

  // Clan + bloodline
  h += wizField('Clan *', `<select class="wiz-select" id="w-clan">
    <option value="">— choose —</option>
    ${CLANS.map(c => `<option value="${esc(c)}" ${wiz.clan === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
  </select>`);

  h += wizField('Bloodline', `<select class="wiz-select" id="w-bloodline" ${!wiz.clan ? 'disabled' : ''}>
    <option value="">None</option>
    ${bloodlines.map(b => `<option value="${esc(b)}" ${wiz.bloodline === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}
  </select>`);

  // Covenant
  h += wizField('Covenant *', `<select class="wiz-select" id="w-covenant">
    <option value="">— choose —</option>
    ${ALL_COVENANTS.map(c => `<option value="${esc(c)}" ${wiz.covenant === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
  </select>`);

  // Mask + Dirge
  const mdOpts = MASKS_DIRGES.map(m => `<option value="${esc(m)}" ${wiz.mask === m ? 'selected' : ''}>${esc(m)}</option>`).join('');
  const dirgeOpts = MASKS_DIRGES.map(m => `<option value="${esc(m)}" ${wiz.dirge === m ? 'selected' : ''}>${esc(m)}</option>`).join('');
  h += wizField('Mask *', `<select class="wiz-select" id="w-mask"><option value="">— choose —</option>${mdOpts}</select>`);
  h += wizField('Dirge *', `<select class="wiz-select" id="w-dirge"><option value="">— choose —</option>${dirgeOpts}</select>`);

  // Humanity
  h += wizField('Starting Humanity', `<input class="wiz-input wiz-input-sm" id="w-humanity" type="number" min="1" max="10" value="${wiz.humanity}">`);

  h += '</div>';
  return h;
}

// ── Step 2: Attributes ────────────────────────────────────────────────────

function stepAttributes() {
  const { attrPri, attrDots } = wiz;
  let h = '<h2 class="wiz-title">Attributes</h2>';
  h += '<p class="wiz-hint">Assign a priority to each category, then distribute dots. Each attribute starts at 1; all dots are additional.</p>';

  // Priority picker
  h += priorityPicker('attr', attrPri);

  // Dot allocators per category
  for (const cat of ['Mental','Physical','Social']) {
    const budget = PRI_BUDGETS[attrPri[cat]];
    const used = ATTR_CATS[cat].reduce((s, a) => s + (attrDots[a] || 0), 0);
    const rem = budget - used;
    h += `<div class="wiz-cat-block">`;
    h += `<div class="wiz-cat-head">${cat} <span class="wiz-budget ${rem < 0 ? 'over' : ''}">${rem >= 0 ? rem + ' CP remaining' : Math.abs(rem) + ' over'}</span></div>`;
    for (const attr of ATTR_CATS[cat]) {
      const extra = attrDots[attr] || 0;
      const total = 1 + extra;
      h += dotAllocRow(attr, total, 1, 5, `wiz-attr-${attr.toLowerCase().replace(/ /g,'-')}`);
    }
    h += '</div>';
  }
  return h;
}

// ── Step 3: Skills ────────────────────────────────────────────────────────

function stepSkills() {
  const { skillPri, skillDots } = wiz;
  let h = '<h2 class="wiz-title">Skills</h2>';
  h += '<p class="wiz-hint">Assign a priority to each category, then distribute dots.</p>';

  h += priorityPicker('skill', skillPri);

  for (const cat of ['Mental','Physical','Social']) {
    const budget = SKILL_PRI_BUDGETS[skillPri[cat]];
    const used = SKILL_CATS[cat].reduce((s, sk) => s + (skillDots[sk] || 0), 0);
    const rem = budget - used;
    h += `<div class="wiz-cat-block">`;
    h += `<div class="wiz-cat-head">${cat} <span class="wiz-budget ${rem < 0 ? 'over' : ''}">${rem >= 0 ? rem + ' CP remaining' : Math.abs(rem) + ' over'}</span></div>`;
    for (const skill of SKILL_CATS[cat]) {
      const dots = skillDots[skill] || 0;
      h += dotAllocRow(skill, dots, 0, 5, `wiz-skill-${skill.toLowerCase().replace(/ /g,'-')}`);
    }
    h += '</div>';
  }
  return h;
}

// ── Step 4: Merits ────────────────────────────────────────────────────────

function stepMerits() {
  const usedCP = wiz.merits.reduce((s, m) => s + m.rating, 0);
  const rem = MERIT_BUDGET - usedCP;

  let h = '<h2 class="wiz-title">Merits</h2>';
  h += `<p class="wiz-hint">Choose up to <strong>${MERIT_BUDGET} dots</strong> of merits at creation. <span class="wiz-budget ${rem < 0 ? 'over' : ''}">${rem >= 0 ? rem + ' CP remaining' : Math.abs(rem) + ' over budget'}</span></p>`;

  // Selected merits list
  if (wiz.merits.length) {
    h += '<div class="wiz-merit-list">';
    for (let i = 0; i < wiz.merits.length; i++) {
      const m = wiz.merits[i];
      const slug = m.key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const rule = getRuleByKey(slug);
      const entry = rule ? { rating: rule.rating_range ? `${rule.rating_range[0]}–${rule.rating_range[1]}` : null, desc: rule.description } : {};
      const maxR = meritMaxRating(entry);
      h += `<div class="wiz-merit-row">`;
      h += `<span class="wiz-merit-name">${esc(m.name)}</span>`;
      if (maxR > 1) {
        h += `<span class="wiz-merit-rating-adj">`;
        h += `<button class="wiz-merit-adj" data-mi="${i}" data-d="-1">−</button>`;
        h += `<span class="wiz-merit-dots">${'●'.repeat(m.rating)}</span>`;
        h += `<button class="wiz-merit-adj" data-mi="${i}" data-d="1">+</button>`;
        h += `</span>`;
      } else {
        h += `<span class="wiz-merit-dots">${'●'.repeat(m.rating)}</span>`;
      }
      h += `<button class="wiz-merit-remove" data-mi="${i}">×</button>`;
      h += `</div>`;
    }
    h += '</div>';
  } else {
    h += '<p class="wiz-merit-empty">No merits selected yet.</p>';
  }

  // Search + add
  h += '<div class="wiz-merit-search-wrap">';
  h += `<input class="wiz-input wiz-merit-search" id="wiz-merit-q" placeholder="Search merits…" value="${esc(wiz.meritSearch)}">`;
  h += '</div>';

  // Results
  if (wiz.meritSearch.length >= 2) {
    const q = wiz.meritSearch.toLowerCase();
    // Try rules cache first, fallback to MERITS_DB
    const rulesDB = getRulesByCategory('merit');
    const results = rulesDB.length
      ? rulesDB
          .filter(r => !SKIP_TYPES.has(r.parent) && r.name.toLowerCase().includes(q))
          .slice(0, 12)
          .map(r => [r.name.toLowerCase(), { desc: r.description, rating: r.rating_range ? `${r.rating_range[0]}–${r.rating_range[1]}` : null, type: r.parent, prereq: r.prereq ? prereqLabel(r.prereq) : null }])
      : [];

    if (results.length) {
      h += '<div class="wiz-merit-results">';
      for (const [key, entry] of results) {
        const alreadyHas = wiz.merits.some(m => m.key === key);
        const name = key.replace(/\b\w/g, c => c.toUpperCase());
        const ratingStr = entry.rating ? ` (${entry.rating})` : ' (1)';
        h += `<div class="wiz-merit-result ${alreadyHas ? 'wiz-merit-result-dup' : ''}" data-key="${esc(key)}">`;
        h += `<div class="wiz-merit-result-name">${esc(name)}${ratingStr}</div>`;
        h += `<div class="wiz-merit-result-desc">${esc(entry.desc || '')}</div>`;
        if (entry.prereq) h += `<div class="wiz-merit-result-req">Prereq: ${esc(entry.prereq)}</div>`;
        if (!alreadyHas) h += `<button class="wiz-merit-add" data-key="${esc(key)}">Add</button>`;
        h += '</div>';
      }
      h += '</div>';
    } else {
      h += '<p class="wiz-merit-empty">No results.</p>';
    }
  }
  return h;
}

// ── Step 5: Disciplines ───────────────────────────────────────────────────

function stepDisciplines() {
  const clanDiscs = wiz.clan ? (CLAN_DISCS[wiz.clan] || []) : [];
  const usedDots = Object.values(wiz.disciplines).reduce((s, d) => s + d, 0);
  const rem = DISC_BUDGET - usedDots;

  let h = '<h2 class="wiz-title">Disciplines</h2>';
  h += `<p class="wiz-hint">Distribute <strong>${DISC_BUDGET} dots</strong> among your clan disciplines.`;
  if (wiz.clan) h += ` ${esc(wiz.clan)} clan: ${clanDiscs.map(esc).join(', ')}.`;
  h += `</p>`;
  h += `<div class="wiz-budget-bar ${rem < 0 ? 'over' : ''}">${rem >= 0 ? rem + ' dots remaining' : Math.abs(rem) + ' over budget'}</div>`;

  if (!clanDiscs.length) {
    h += '<p class="wiz-hint">Select a clan in step 1 to see discipline options.</p>';
    return h;
  }

  h += '<div class="wiz-disc-list">';
  for (const disc of clanDiscs) {
    const dots = wiz.disciplines[disc] || 0;
    h += dotAllocRow(disc, dots, 0, 3, `wiz-disc-${disc.toLowerCase()}`);
  }
  h += '</div>';
  return h;
}

// ── Step 6: Review ────────────────────────────────────────────────────────

function stepReview() {
  let h = '<h2 class="wiz-title">Review</h2>';
  h += '<p class="wiz-hint">Check your character before submitting. Use Back to make changes.</p>';

  h += '<div class="wiz-review">';

  // Identity
  h += reviewSection('Identity', [
    ['Name', wiz.name],
    ['Concept', wiz.concept || '—'],
    ['Clan', wiz.clan + (wiz.bloodline ? ` (${wiz.bloodline})` : '')],
    ['Covenant', wiz.covenant],
    ['Mask / Dirge', `${wiz.mask} / ${wiz.dirge}`],
    ['Humanity', wiz.humanity],
  ]);

  // Attributes
  const attrRows = [];
  for (const cat of ['Mental','Physical','Social']) {
    const budget = PRI_BUDGETS[wiz.attrPri[cat]];
    const label = `${cat} (${wiz.attrPri[cat]}, ${budget} CP)`;
    const vals = ATTR_CATS[cat].map(a => `${a} ${1 + (wiz.attrDots[a] || 0)}`).join(', ');
    attrRows.push([label, vals]);
  }
  h += reviewSection('Attributes', attrRows);

  // Skills (non-zero only)
  const skillRows = [];
  for (const cat of ['Mental','Physical','Social']) {
    const skills = SKILL_CATS[cat].filter(sk => (wiz.skillDots[sk] || 0) > 0);
    if (skills.length) {
      const vals = skills.map(sk => `${sk} ${wiz.skillDots[sk]}`).join(', ');
      skillRows.push([cat, vals]);
    }
  }
  h += reviewSection('Skills', skillRows.length ? skillRows : [['', 'None selected']]);

  // Merits
  const meritRows = wiz.merits.length
    ? wiz.merits.map(m => [m.name, '●'.repeat(m.rating)])
    : [['', 'None']];
  const meritTotal = wiz.merits.reduce((s, m) => s + m.rating, 0);
  h += reviewSection(`Merits (${meritTotal}/${MERIT_BUDGET} CP used)`, meritRows);

  // Disciplines
  const discEntries = Object.entries(wiz.disciplines).filter(([,d]) => d > 0);
  const discTotal = discEntries.reduce((s, [,d]) => s + d, 0);
  const discRows = discEntries.length
    ? discEntries.map(([name, d]) => [name, '●'.repeat(d)])
    : [['', 'None']];
  h += reviewSection(`Disciplines (${discTotal}/${DISC_BUDGET} dots)`, discRows);

  // XP note
  h += '<div class="wiz-review-note">This character starts with 10 XP. Coordinate with your ST to spend any remaining creation XP.</div>';
  h += '</div>';
  return h;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function wizField(label, inputHtml) {
  return `<div class="wiz-field">
    <label class="wiz-label">${esc(label)}</label>
    ${inputHtml}
  </div>`;
}

function priorityPicker(prefix, pri) {
  // Each category gets a select for Primary/Secondary/Tertiary, constrained to unique
  let h = '<div class="wiz-pri-row">';
  for (const cat of ['Mental','Physical','Social']) {
    h += `<div class="wiz-pri-col">`;
    h += `<div class="wiz-pri-cat">${cat}</div>`;
    h += `<select class="wiz-select wiz-pri-sel" data-prefix="${prefix}" data-cat="${cat}">`;
    for (const lbl of PRI_LABELS) {
      h += `<option value="${lbl}" ${pri[cat] === lbl ? 'selected' : ''}>${lbl}</option>`;
    }
    h += `</select>`;
    h += `</div>`;
  }
  h += '</div>';
  return h;
}

function dotAllocRow(label, current, min, max, dataKey) {
  const canDec = current > min;
  const canInc = current < max;
  const filled = '●'.repeat(current);
  const empty = '○'.repeat(max - current);
  return `<div class="wiz-alloc-row">
    <span class="wiz-alloc-label">${esc(label)}</span>
    <button class="wiz-alloc-btn" data-key="${esc(dataKey)}" data-d="-1" ${canDec ? '' : 'disabled'}>−</button>
    <span class="wiz-dots">${filled}<span class="wiz-dots-empty">${empty}</span></span>
    <button class="wiz-alloc-btn" data-key="${esc(dataKey)}" data-d="1" ${canInc ? '' : 'disabled'}>+</button>
  </div>`;
}

function reviewSection(title, rows) {
  let h = `<div class="wiz-review-section">`;
  h += `<div class="wiz-review-head">${esc(title)}</div>`;
  for (const [k, v] of rows) {
    h += `<div class="wiz-review-row">`;
    if (k) h += `<span class="wiz-review-key">${esc(String(k))}</span>`;
    h += `<span class="wiz-review-val">${esc(String(v))}</span>`;
    h += `</div>`;
  }
  h += '</div>';
  return h;
}

function meritMaxRating(entry) {
  if (!entry.rating) return 1;
  const m = String(entry.rating).match(/(\d+)$/);
  return m ? parseInt(m[1]) : 1;
}

function meritMinRating(entry) {
  if (!entry.rating) return 1;
  const m = String(entry.rating).match(/^(\d+)/);
  return m ? parseInt(m[1]) : 1;
}

function meritCategory(key) {
  if (INFLUENCE_MERITS.has(key)) return 'influence';
  if (DOMAIN_MERITS.has(key)) return 'domain';
  if (STANDING_MERITS.has(key)) return 'standing';
  const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const rule = getRuleByKey(slug);
  if (rule?.parent === 'Style') return 'manoeuvre';
  return 'general';
}

// ── Events ────────────────────────────────────────────────────────────────

function attachEvents() {
  const el = id => container.querySelector(`#${id}`);
  const on = (sel, evt, fn) => container.querySelectorAll(sel).forEach(n => n.addEventListener(evt, fn));

  // Back / Next / Submit
  container.querySelector('#wiz-back')?.addEventListener('click', () => { wiz.step--; render(); });
  container.querySelector('#wiz-next')?.addEventListener('click', () => { if (validateStep()) { wiz.step++; render(); } });
  container.querySelector('#wiz-submit')?.addEventListener('click', submitWizard);

  if (wiz.step === 1) {
    bindInput('w-name', v => wiz.name = v);
    bindInput('w-concept', v => wiz.concept = v);
    bindInput('w-pronouns', v => wiz.pronouns = v);
    bindInput('w-age', v => wiz.apparent_age = v);
    bindInput('w-humanity', v => wiz.humanity = Math.min(10, Math.max(1, parseInt(v) || 7)));
    el('w-clan')?.addEventListener('change', e => {
      wiz.clan = e.target.value;
      wiz.bloodline = null;
      wiz.disciplines = {};
      render();
    });
    el('w-bloodline')?.addEventListener('change', e => { wiz.bloodline = e.target.value || null; });
    el('w-covenant')?.addEventListener('change', e => { wiz.covenant = e.target.value; });
    el('w-mask')?.addEventListener('change', e => { wiz.mask = e.target.value; });
    el('w-dirge')?.addEventListener('change', e => { wiz.dirge = e.target.value; });
  }

  if (wiz.step === 2) {
    // Priority pickers
    on('.wiz-pri-sel[data-prefix="attr"]', 'change', e => {
      const cat = e.target.dataset.cat;
      const val = e.target.value;
      // Swap if another cat already has this priority
      const other = Object.entries(wiz.attrPri).find(([k, v]) => k !== cat && v === val);
      if (other) wiz.attrPri[other[0]] = wiz.attrPri[cat];
      wiz.attrPri[cat] = val;
      render();
    });
    // Dot allocators
    on('.wiz-alloc-btn', 'click', e => {
      const key = e.currentTarget.dataset.key;
      const d = parseInt(e.currentTarget.dataset.d);
      if (!key.startsWith('wiz-attr-')) return;
      const attr = attrKeyToName(key);
      wiz.attrDots[attr] = Math.min(4, Math.max(0, (wiz.attrDots[attr] || 0) + d));
      render();
    });
  }

  if (wiz.step === 3) {
    on('.wiz-pri-sel[data-prefix="skill"]', 'change', e => {
      const cat = e.target.dataset.cat;
      const val = e.target.value;
      const other = Object.entries(wiz.skillPri).find(([k, v]) => k !== cat && v === val);
      if (other) wiz.skillPri[other[0]] = wiz.skillPri[cat];
      wiz.skillPri[cat] = val;
      render();
    });
    on('.wiz-alloc-btn', 'click', e => {
      const key = e.currentTarget.dataset.key;
      const d = parseInt(e.currentTarget.dataset.d);
      if (!key.startsWith('wiz-skill-')) return;
      const skill = skillKeyToName(key);
      wiz.skillDots[skill] = Math.min(5, Math.max(0, (wiz.skillDots[skill] || 0) + d));
      render();
    });
  }

  if (wiz.step === 4) {
    el('wiz-merit-q')?.addEventListener('input', e => {
      wiz.meritSearch = e.target.value;
      render();
    });
    on('.wiz-merit-add', 'click', e => {
      const key = e.currentTarget.dataset.key;
      if (!key || wiz.merits.some(m => m.key === key)) return;
      const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const rule = getRuleByKey(slug);
      const entry = rule ? { rating: rule.rating_range ? `${rule.rating_range[0]}–${rule.rating_range[1]}` : null } : {};
      const min = meritMinRating(entry || {});
      const name = rule ? rule.name : key.replace(/\b\w/g, c => c.toUpperCase());
      wiz.merits.push({ key, name, rating: min, category: meritCategory(key) });
      render();
    });
    on('.wiz-merit-remove', 'click', e => {
      const i = parseInt(e.currentTarget.dataset.mi);
      wiz.merits.splice(i, 1);
      render();
    });
    on('.wiz-merit-adj', 'click', e => {
      const i = parseInt(e.currentTarget.dataset.mi);
      const d = parseInt(e.currentTarget.dataset.d);
      const m = wiz.merits[i];
      const slug = m.key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const rule = getRuleByKey(slug);
      const entry = rule ? { rating: rule.rating_range ? `${rule.rating_range[0]}–${rule.rating_range[1]}` : null } : {};
      const min = meritMinRating(entry);
      const max = meritMaxRating(entry);
      m.rating = Math.min(max, Math.max(min, m.rating + d));
      render();
    });
  }

  if (wiz.step === 5) {
    on('.wiz-alloc-btn', 'click', e => {
      const key = e.currentTarget.dataset.key;
      const d = parseInt(e.currentTarget.dataset.d);
      if (!key.startsWith('wiz-disc-')) return;
      const disc = discKeyToName(key, wiz.clan);
      if (!disc) return;
      wiz.disciplines[disc] = Math.min(3, Math.max(0, (wiz.disciplines[disc] || 0) + d));
      render();
    });
  }

  function bindInput(elemId, setter) {
    const n = el(elemId);
    if (n) n.addEventListener('input', e => setter(e.target.value));
  }
}

// Key ↔ name helpers
function attrKeyToName(key) {
  const slug = key.replace('wiz-attr-', '');
  for (const cat of Object.values(ATTR_CATS)) {
    const found = cat.find(a => a.toLowerCase().replace(/ /g, '-') === slug);
    if (found) return found;
  }
  return slug;
}

function skillKeyToName(key) {
  const slug = key.replace('wiz-skill-', '');
  for (const cat of Object.values(SKILL_CATS)) {
    const found = cat.find(s => s.toLowerCase().replace(/ /g, '-') === slug);
    if (found) return found;
  }
  return slug;
}

function discKeyToName(key, clan) {
  const slug = key.replace('wiz-disc-', '');
  const discs = clan ? (CLAN_DISCS[clan] || []) : [];
  return discs.find(d => d.toLowerCase() === slug) || null;
}

// ── Validation ────────────────────────────────────────────────────────────

function showError(msg) {
  const el = container.querySelector('#wiz-error');
  if (el) el.textContent = msg;
}

function clearError() {
  const el = container.querySelector('#wiz-error');
  if (el) el.textContent = '';
}

function validateStep() {
  clearError();
  switch (wiz.step) {
    case 1: {
      if (!wiz.name.trim()) { showError('Character name is required.'); return false; }
      if (!wiz.clan) { showError('Clan is required.'); return false; }
      if (!wiz.covenant) { showError('Covenant is required.'); return false; }
      if (!wiz.mask) { showError('Mask is required.'); return false; }
      if (!wiz.dirge) { showError('Dirge is required.'); return false; }
      return true;
    }
    case 2: {
      for (const cat of ['Mental','Physical','Social']) {
        const budget = PRI_BUDGETS[wiz.attrPri[cat]];
        const used = ATTR_CATS[cat].reduce((s, a) => s + (wiz.attrDots[a] || 0), 0);
        if (used > budget) { showError(`${cat} attributes exceed budget (${used}/${budget} CP).`); return false; }
      }
      return true;
    }
    case 3: {
      for (const cat of ['Mental','Physical','Social']) {
        const budget = SKILL_PRI_BUDGETS[wiz.skillPri[cat]];
        const used = SKILL_CATS[cat].reduce((s, sk) => s + (wiz.skillDots[sk] || 0), 0);
        if (used > budget) { showError(`${cat} skills exceed budget (${used}/${budget} CP).`); return false; }
      }
      return true;
    }
    case 4: {
      const used = wiz.merits.reduce((s, m) => s + m.rating, 0);
      if (used > MERIT_BUDGET) { showError(`Merit total (${used}) exceeds creation budget (${MERIT_BUDGET}).`); return false; }
      return true;
    }
    case 5: {
      const used = Object.values(wiz.disciplines).reduce((s, d) => s + d, 0);
      if (used > DISC_BUDGET) { showError(`Discipline dots (${used}) exceed creation budget (${DISC_BUDGET}).`); return false; }
      return true;
    }
    default: return true;
  }
}

// ── Submit ────────────────────────────────────────────────────────────────

async function submitWizard() {
  clearError();
  const submitBtn = container.querySelector('#wiz-submit');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

  try {
    const doc = buildCharDoc();
    const created = await apiPost('/api/characters/wizard', doc);
    if (onComplete) onComplete(created);
  } catch (err) {
    showError(err.message || 'Failed to create character. Please try again.');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Character'; }
  }
}

function buildCharDoc() {
  const { name, concept, pronouns, apparent_age, clan, bloodline, covenant, mask, dirge, humanity } = wiz;

  // Attributes: base 1 + CP extra (inline creation tracking)
  const attributes = {};
  for (const cat of Object.values(ATTR_CATS)) {
    for (const attr of cat) {
      const extra = wiz.attrDots[attr] || 0;
      attributes[attr] = { dots: 1 + extra, cp: extra, xp: 0, free: 0, rule_key: null };
    }
  }

  // Skills: CP dots (inline creation tracking)
  const skills = {};
  for (const cat of Object.values(SKILL_CATS)) {
    for (const skill of cat) {
      const dots = wiz.skillDots[skill] || 0;
      if (dots > 0) {
        skills[skill] = { dots, specs: [], nine_again: false, cp: dots, xp: 0, free: 0, rule_key: null };
      }
    }
  }

  // Disciplines (v3: objects with inline creation tracking)
  const disciplines = {};
  for (const [disc, dots] of Object.entries(wiz.disciplines)) {
    if (dots > 0) {
      disciplines[disc] = { dots, cp: dots, xp: 0, free: 0, rule_key: null };
    }
  }

  // Merits (v3: inline creation tracking on each merit)
  const merits = wiz.merits.map(m => ({
    name: m.name, rating: m.rating, category: m.category,
    cp: m.rating, xp: 0, free: 0, free_mci: 0, free_vm: 0, free_lk: 0,
    free_ohm: 0, free_inv: 0, free_pt: 0, free_mdb: 0, rule_key: null
  }));

  return {
    name: name.trim(),
    concept: concept.trim() || null,
    pronouns: pronouns.trim() || null,
    apparent_age: apparent_age.trim() || null,
    player: null,
    clan,
    bloodline: bloodline || null,
    covenant,
    mask,
    dirge,
    court_title: null,
    blood_potency: 1,
    humanity,
    humanity_base: humanity,
    status: { city: 0, clan: 0, covenant: 0 },
    willpower: {},
    aspirations: [],
    touchstones: [],
    banes: [],
    ordeals: {},
    attributes,
    attribute_priorities: { ...wiz.attrPri },
    skills,
    skill_priorities: { ...wiz.skillPri },
    disciplines,
    merits,
    powers: [],
    // #837: xp_total / xp_spent removed — derived at render via xp.js.
    // The 10-XP starting allowance is sourced from xpStarting() in xp.js.
    xp_log: { spent: 0, entries: [] },
    notes: null,
    retired: false,
  };
}
