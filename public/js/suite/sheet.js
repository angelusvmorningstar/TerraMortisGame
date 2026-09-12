// ══════════════════════════════════════════════
//  Sheet Tab — read-only character sheet view
// ══════════════════════════════════════════════

import state from './data.js';
import { displayName, getWillpower, redactPlayer, shDotsWithBonus, formatSpecs, hasAoE, singleScrollEnabled, esc } from '../data/helpers.js';
// rlv.7 review fix: onSheetChar() below reassigns state.rollChar without a
// loadPool() following — resetRollPool() clears the previous character's
// stale POOL_NAME/powerChips/MOD so a leftover chip badge can't persist
// data into the new character's own storage slot (Pass 2/3a/3b finding).
import { resetRollPool } from './roll-v2.js';
import { markerFor } from '../editor/st-mod-popover.js';
import {
  ICONS, COV_ICON_MAP, CITY_SVG, OTHER_SVG, BP_SVG, HUM_SVG, STAT_SVG,
  RITUAL_DISCS, CORE_DISCS,
} from './data.js';
import {
  dots, dotsWithBonus, getAttrDots, getAttrBonus,
  skillDots, skillSpec,
  powersForDisc,
  toggleExp, toggleDisc, expRow
} from './sheet-helpers.js';

import {
  standingMerits, devotions, rites, pacts,
  calcSize, calcSpeed, calcDefence, calcHealth, calcWillpowerMax, calcVitaeMax,
  calcCityStatus,
  getSkillObj
} from '../data/accessors.js';
// Issue #879 (ADR-006 D4): displayed defence reads the armour-adjusted +
// overlay-modded value from c.derived.defence (fallback to on-the-fly
// computation when unmaterialised).
import { defenceForDisplay } from '../data/equipment-derivation.js';
import { xpEarned, xpSpent, xpLeft } from '../editor/xp.js';
import { trackerRead, trackerReadRaw, trackerAdj, trackerSpend, trackerWriteField } from '../game/tracker.js';
import { calcTotalInfluence, influenceBreakdown } from '../editor/domain.js';
import { shRenderInfluenceMerits, shRenderDomainMerits, shRenderGeneralMerits, shRenderManoeuvres, shRenderEquipment, shRenderOfficeMerits, patchOfficeMerits } from '../editor/sheet.js';
import { renderRulesExpander } from '../shared/rules-text.js';
import { getRulesByCategory } from '../data/loader.js';

// ── STM display helpers (issue #425) ──
// Mirror the editor sheet's wiring (public/js/editor/sheet.js) so modded
// dots/numbers in the suite renderer get the same gold-tint + marker +
// popover treatment. STM-7's cache-entry invariant populates
// c._st_mod_overlay at suite boot; this is the consumption side that the
// suite renderer was missing.

/** Build shDotsWithBonus opts for an attribute path. autoBonus (discipline-
 *  derived) renders first in the hollow stream, then manual bonus — so the
 *  modded manual-bonus sub-range is offset by autoBonus, matching the
 *  editor convention. */
function _stmAttrOpts(c, a, autoBonus) {
  const ovDots = c._st_mod_overlay?.[`attributes.${a}.dots`];
  const ovBonus = c._st_mod_overlay?.[`attributes.${a}.bonus`];
  const opts = {};
  if (ovDots) {
    const sign = ovDots.delta >= 0 ? '+' : '';
    opts.filledMod = {
      from: ovDots.base, to: ovDots.final,
      path: `attributes.${a}.dots`,
      title: `ST adjustment: ${a} (dots) ${sign}${ovDots.delta}. Click for details.`,
    };
  }
  if (ovBonus) {
    const sign = ovBonus.delta >= 0 ? '+' : '';
    opts.hollowMod = {
      from: autoBonus + ovBonus.base, to: autoBonus + ovBonus.final,
      path: `attributes.${a}.bonus`,
      title: `ST adjustment: ${a} (bonus) ${sign}${ovBonus.delta}. Click for details.`,
    };
  }
  return opts;
}

/** Build shDotsWithBonus opts for a discipline path. Disciplines only ever
 *  carry a `.dots` overlay (no separate `.bonus` path in this schema), so
 *  only filledMod is ever populated. Issue: the discipline row previously
 *  rendered the ST-mod marker via the old standalone `markerFor()` pip
 *  (pre-#408 pattern) instead of this recolour-in-place one, so a fully
 *  mod-derived discipline (0 base dots + a +1 mod) showed a real dot plus
 *  an adjacent same-size gold marker pip — indistinguishable from 2 dots. */
function _stmDiscOpts(c, d) {
  const ovDots = c._st_mod_overlay?.[`disciplines.${d}.dots`];
  const opts = {};
  if (ovDots) {
    const sign = ovDots.delta >= 0 ? '+' : '';
    opts.filledMod = {
      from: ovDots.base, to: ovDots.final,
      path: `disciplines.${d}.dots`,
      title: `ST adjustment: ${d} (dots) ${sign}${ovDots.delta}. Click for details.`,
    };
  }
  return opts;
}

/** Build shDotsWithBonus opts for a skill path. Skill hollow stream is
 *  manual bonus first, then PT/MCI auto-bonus — so the modded skill bonus
 *  sub-range starts at hollow position ovBonus.base (no offset). */
function _stmSkillOpts(c, s) {
  const ovDots = c._st_mod_overlay?.[`skills.${s}.dots`];
  const ovBonus = c._st_mod_overlay?.[`skills.${s}.bonus`];
  const opts = {};
  if (ovDots) {
    const sign = ovDots.delta >= 0 ? '+' : '';
    opts.filledMod = {
      from: ovDots.base, to: ovDots.final,
      path: `skills.${s}.dots`,
      title: `ST adjustment: ${s} (dots) ${sign}${ovDots.delta}. Click for details.`,
    };
  }
  if (ovBonus) {
    const sign = ovBonus.delta >= 0 ? '+' : '';
    opts.hollowMod = {
      from: ovBonus.base, to: ovBonus.final,
      path: `skills.${s}.bonus`,
      title: `ST adjustment: ${s} (bonus) ${sign}${ovBonus.delta}. Click for details.`,
    };
  }
  return opts;
}

// ── Surgical tracker repaint (no full sheet rebuild) ──

export function repaintSheetTrackers() {
  const c = state.sheetChar;
  if (!c) return;
  const charId = String(c._id);
  const cs = trackerRead(charId);
  if (!cs) return;

  const maxH  = calcHealth(c);
  const maxV  = calcVitaeMax(c);
  const maxWP = calcWillpowerMax(c);
  const maxInf = calcTotalInfluence(c);

  // Health — render with damage type marks
  const agg = cs.aggravated ?? 0, leth = cs.lethal ?? 0, bash = cs.bashing ?? 0;
  const healthBoxes = document.getElementById('tb-health');
  const healthNum = document.getElementById('tn-health');
  if (healthBoxes) {
    const disp = Math.min(maxH, 15);
    let hb = '';
    for (let i = 0; i < disp; i++) {
      let cls = 'tbox', mark = '';
      if (i < agg)                    { cls += ' tbox-agg';     mark = '<svg class="tbox-mark" viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3"/><line x1="3" y1="3" x2="17" y2="17"/><line x1="10" y1="2" x2="10" y2="18"/></svg>'; }
      else if (i < agg + leth)        { cls += ' tbox-lethal';  mark = '<svg class="tbox-mark" viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3"/><line x1="3" y1="3" x2="17" y2="17"/></svg>'; }
      else if (i < agg + leth + bash) { cls += ' tbox-bashing'; mark = '<svg class="tbox-mark" viewBox="0 0 20 20"><line x1="4" y1="16" x2="16" y2="4"/></svg>'; }
      else                            { cls += ' health-filled'; }
      hb += `<div class="${cls}" data-tracker="health" data-idx="${i}" data-max="${disp}" data-filled="health-filled">${mark}</div>`;
    }
    healthBoxes.innerHTML = hb;
  }
  if (healthNum) {
    const dmgTotal = agg + leth + bash;
    const legend = dmgTotal > 0
      ? ` <span class="sh-health-legend">${agg ? `<span class="sh-hl-agg">${agg}A</span>` : ''}${leth ? `<span class="sh-hl-let">${leth}L</span>` : ''}${bash ? `<span class="sh-hl-bash">${bash}B</span>` : ''}</span>`
      : '';
    healthNum.innerHTML = `${maxH - dmgTotal}/${maxH}${legend}`;
  }
  _gdx9SyncPinnedTrack('health', maxH - (agg + leth + bash), maxH);

  // Vitae, WP, Influence — simple filled/empty
  const simple = {
    vitae:  { cur: Math.max(0, Math.min(cs.vitae ?? maxV, maxV)),       max: maxV,   cls: 'vitae-filled' },
    wp:     { cur: Math.max(0, Math.min(cs.willpower ?? maxWP, maxWP)), max: maxWP,  cls: 'wp-filled' },
    inf:    { cur: Math.max(0, Math.min(cs.inf ?? maxInf, maxInf)),     max: maxInf, cls: 'inf-filled' },
  };

  for (const [type, { cur, max, cls }] of Object.entries(simple)) {
    const boxesEl = document.getElementById('tb-' + type);
    const numEl   = document.getElementById('tn-' + type);
    if (boxesEl) {
      const disp = Math.min(max, 15);
      boxesEl.innerHTML = Array.from({ length: disp }, (_, i) =>
        `<div class="tbox${i < cur ? ' ' + cls : ''}" data-tracker="${type}" data-idx="${i}" data-max="${disp}" data-filled="${cls}"></div>`
      ).join('');
    }
    if (numEl) {
      const infoBtn = numEl.querySelector('.sh-tracker-info-btn');
      numEl.textContent = cur + '/' + max;
      if (infoBtn) numEl.appendChild(infoBtn);
    }
    // gdx-9: Influence has no pinned-strip chip (strip is Vitae/WP/Health only,
    // per the locked design) — only sync the two types that have one.
    if (type === 'vitae' || type === 'wp') _gdx9SyncPinnedTrack(type, cur, max);
  }
}

// ── gdx-9: pinned track-strip live sync (AC7) ──
// Keeps the compact strip's mini-bars in step with repaintSheetTrackers'
// own tap-box updates above. No-ops harmlessly when the strip isn't in the
// DOM (single-scroll mode off, or on desktop).
function _gdx9SyncPinnedTrack(type, cur, max) {
  const fillEl = document.getElementById('gdx9-tf-' + type);
  const numEl  = document.getElementById('gdx9-tn-' + type);
  if (!fillEl && !numEl) return;
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
  if (fillEl) fillEl.style.width = pct + '%';
  if (numEl) numEl.textContent = cur + '/' + max;
}

// ── Sheet character selection ──

export function onSheetChar(name) {
  if (!name) {
    state.sheetChar = null;
    document.getElementById('sh-empty').style.display = '';
    document.getElementById('sh-content-suite').style.display = 'none';
    return;
  }
  state.sheetChar = state.chars.find(c => c.name === name) || null;
  if (!state.sheetChar) return;
  state.rollChar = state.sheetChar;
  resetRollPool();
  document.getElementById('sh-empty').style.display = 'none';
  document.getElementById('sh-content-suite').style.display = '';
  renderSheet();
}

// ── Main render ──

export function renderSheet() {
  state.openExpId = null;
  const c = state.sheetChar;
  // Issue #425: expose the suite's active character to the STM popover's
  // delegated handler. _resolveActiveCharacter in editor/st-mod-popover.js
  // checks window.__activeChar (set by player.js too); the suite reuses
  // the same global so clicking a modded dot in the suite app resolves
  // the right character. Set on every render so it tracks sheetChar
  // changes (including clears to null).
  window.__activeChar = c || null;
  const el = document.getElementById('sh-content-suite');
  // Split-tab containers (phone UX — Stats / Skills / Powers)
  const statsEl  = document.getElementById('stats-content');
  const skillsEl = document.getElementById('skills-content');
  const powersEl = document.getElementById('powers-content');
  const infoEl   = document.getElementById('info-content');
  if (!c) {
    if (el) el.innerHTML = '';
    if (statsEl)  statsEl.innerHTML = '';
    if (skillsEl) skillsEl.innerHTML = '';
    if (powersEl) powersEl.innerHTML = '';
    if (infoEl)   infoEl.innerHTML = '';
    return;
  }

  const bl = c.bloodline && c.bloodline !== '\u00AC' ? c.bloodline : '';
  const st = c.status || {};
  const clanKey = (c.clan || '').toLowerCase().replace(/[^a-z]/g, '');
  const covKey = (c.covenant || '').toLowerCase().replace(/[^a-z]/g, '');
  const clanSvg = ICONS[clanKey] || '';
  const covSvg = ICONS[COV_ICON_MAP[covKey] || covKey] || '';
  const wp = getWillpower(c);

  // ── Separate curse from banes ──
  const allBanes = c.banes || [];
  const curseIdx = allBanes.findIndex(b => b.name.toLowerCase().includes('curse'));
  const curse = curseIdx >= 0 ? allBanes[curseIdx] : null;
  const regularBanes = allBanes.filter((_, i) => i !== curseIdx);

  let html = '';
  let infoHtml = '';

  // ── INFO (character identity, meta, covenant strip) ──
  infoHtml += `<div class="sh-char-hdr">`;

  // Name row
  // dt-form.17: red-flag the xpLeft portion if negative; annotate when the
  // active cycle's downtime credit is on hold.
  const _xpL = xpLeft(c);
  const _xpDef = _xpL < 0
    ? ' dt-xp-deficit" title="Spent XP exceeds available \u2014 restore the form to minimum-complete, or reverse the spend."'
    : '"';
  const _xpHoldFlag = !!c._dtHoldFlag;
  infoHtml += `<div class="sh-namerow">
    <div class="sh-char-name">${displayName(c)}</div>
    <div class="sh-player-row">
      <span class="sh-char-player">${redactPlayer(c.player || '')}${c.pronouns ? ' \u00B7 ' + c.pronouns : ''}</span>
      <span class="sh-xp-badge">XP <span class="sh-xp-badge-left${_xpDef}>${_xpL}</span>/${xpEarned(c)}${_xpHoldFlag ? ' <span class="dt-xp-on-hold">(downtime credit on hold)</span>' : ''}</span>
    </div>
    ${c.concept ? `<div class="sh-char-concept" style="margin-top:4px">${c.concept}</div>` : ''}
  </div>`;

  // Faction display moved to Status tab (personal status cards)

  // Meta rows: mask, dirge, curse/bane, touchstones, embrace, apparent age, features
  infoHtml += `<div class="sh-char-meta">`;

  // Mask
  if (c.mask) {
    const body = (wp.mask_1wp ? `<div><span class="exp-wp-lbl">1 WP</span> ${wp.mask_1wp}</div>` : '') +
                 (wp.mask_all ? `<div style="margin-top:5px"><span class="exp-wp-lbl">All WP</span> ${wp.mask_all}</div>` : '');
    infoHtml += expRow('mask', 'Mask', c.mask, body);
  }
  // Dirge
  if (c.dirge) {
    const body = (wp.dirge_1wp ? `<div><span class="exp-wp-lbl">1 WP</span> ${wp.dirge_1wp}</div>` : '') +
                 (wp.dirge_all ? `<div style="margin-top:5px"><span class="exp-wp-lbl">All WP</span> ${wp.dirge_all}</div>` : '');
    infoHtml += expRow('dirge', 'Dirge', c.dirge, body);
  }
  // Curse + Banes
  if (curse) infoHtml += expRow('curse', 'Curse', curse.name, `<div>${curse.effect || ''}</div>`);
  regularBanes.forEach((b, i) => {
    infoHtml += expRow('bane' + i, 'Bane', b.name, `<div>${b.effect || ''}</div>`);
  });
  // Touchstones - NPCR.4, free-text only (DBO-8): render touchstones[].
  const hum = c.humanity || 0;
  const ts = Array.isArray(c.touchstones) ? c.touchstones : [];
  if (ts.length) {
    const sorted = [...ts].sort((a, b) => (b.humanity || 0) - (a.humanity || 0));
    const tsBody = sorted.map(t => {
      const attached = hum >= t.humanity;
      const name = t.name || '(unnamed)';
      return `<div class="exp-ts-row">
        <span class="exp-ts-hum">Humanity ${t.humanity} \u2014 <span class="exp-ts-state ${attached ? 'attached' : 'detached'}">${attached ? 'Attached' : 'Detached'}</span></span>
        <span class="exp-ts-name">${name}${t.desc ? ` <span class="exp-ts-desc">(${t.desc})</span>` : ''}</span>
      </div>`;
    }).join('');
    infoHtml += expRow('touchstones', 'Touchstones', '', tsBody);
  }
  // Embrace + Apparent Age
  if (c.date_of_embrace || c.apparent_age) {
    infoHtml += `<div class="sh-meta-pair">`;
    if (c.date_of_embrace) {
      const dedDisp = new Date(c.date_of_embrace + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      infoHtml += `<div class="sh-meta-row"><span class="sh-meta-lbl">Embrace</span><span class="sh-meta-val">${dedDisp}</span></div>`;
    }
    if (c.apparent_age) {
      infoHtml += `<div class="sh-meta-row"><span class="sh-meta-lbl">App. Age</span><span class="sh-meta-val">${c.apparent_age}</span></div>`;
    }
    infoHtml += `</div>`;
  }
  // Features
  if (c.features) {
    infoHtml += `<div class="sh-meta-row"><span class="sh-meta-lbl">Features</span><span class="sh-meta-val">${c.features}</span></div>`;
  }

  infoHtml += `</div>`; // end sh-char-meta
  infoHtml += `</div>`; // end sh-char-hdr

  // Status summary — read-only copy of the player's Status tab compact block (AC-1..6)
  {
    const cityV = calcCityStatus(c);
    const covV  = st.covenant?.[c.covenant] || 0;
    const clanV = st.clan || 0;
    const COV_SHORT = {
      'Carthian Movement': 'Carthian', 'Circle of the Crone': 'Crone',
      'Invictus': 'Invictus', 'Lancea et Sanctum': 'Lance', 'Ordo Dracul': 'Ordo',
    };
    let ssHtml = `<div class="status-summary">`;
    ssHtml += `<div class="status-summary-pip"><div class="status-summary-shape">${CITY_SVG}<span class="status-summary-n">${cityV}</span></div><span class="status-summary-lbl">City</span></div>`;
    if (c.covenant) {
      ssHtml += `<div class="status-summary-pip"><div class="status-summary-shape">${OTHER_SVG}<span class="status-summary-n">${covV}</span></div><span class="status-summary-lbl">${esc(c.covenant)}</span></div>`;
    }
    if (c.clan) {
      ssHtml += `<div class="status-summary-pip"><div class="status-summary-shape">${OTHER_SVG}<span class="status-summary-n">${clanV}</span></div><span class="status-summary-lbl">${esc(c.clan)}</span></div>`;
    }
    ssHtml += `</div>`;
    const covObj    = st.covenant || {};
    const otherCovs = Object.entries(covObj)
      .filter(([cov, val]) => val && cov !== c.covenant)
      .map(([cov, val]) => [COV_SHORT[cov] || cov, val]);
    if (otherCovs.length) {
      ssHtml += `<div class="status-summary-other">${otherCovs.map(([label, val]) =>
        `<span class="status-summary-other-item">${esc(label)} <b>${val}</b></span>`
      ).join(' · ')}</div>`;
    }
    infoHtml += ssHtml;
  }

  // Covenant strip moved to Status tab

  // ── STATS STRIP ──
  // Issue #425: markerFor suffix on each derived/root stat number so modded
  // values get the gold-pip marker + tooltip + click-to-popover (mirrors
  // public/js/editor/sheet.js stats strip).
  html += `<div class="sh-stats-strip">
    <div class="sh-stat-cell"><div class="sh-stat-icon">${BP_SVG}<span class="sh-stat-n">${c.blood_potency || 1}${markerFor(c, 'blood_potency')}</span></div><div class="sh-stat-lbl">BP</div></div>
    <div class="sh-stat-cell"><div class="sh-stat-icon">${HUM_SVG}<span class="sh-stat-n">${c.humanity || 0}${markerFor(c, 'humanity')}</span></div><div class="sh-stat-lbl">Humanity</div></div>
    <div class="sh-stat-cell"><div class="sh-stat-icon">${STAT_SVG}<span class="sh-stat-n">${calcSize(c)}${markerFor(c, 'derived.size')}</span></div><div class="sh-stat-lbl">Size</div></div>
    <div class="sh-stat-cell"><div class="sh-stat-icon">${STAT_SVG}<span class="sh-stat-n">${calcSpeed(c)}${markerFor(c, 'derived.speed')}</span></div><div class="sh-stat-lbl">Speed</div></div>
    <div class="sh-stat-cell"><div class="sh-stat-icon">${STAT_SVG}<span class="sh-stat-n">${defenceForDisplay(c)}${markerFor(c, 'derived.defence')}</span></div><div class="sh-stat-lbl">Defence</div></div>
  </div>`;

  // ── TRACKERS ──
  const maxH  = calcHealth(c);
  const maxV  = calcVitaeMax(c);
  const maxWP = calcWillpowerMax(c);
  const maxInf = calcTotalInfluence(c);

  // Load from canonical tracker store (keyed by _id)
  const charId = String(c._id);

  // One-time migration: seed canonical store from old tm_tracker_{name} if not yet present
  if (!trackerReadRaw(charId)) {
    const oldKey = 'tm_tracker_' + c.name;
    try {
      const old = JSON.parse(localStorage.getItem(oldKey) || 'null');
      if (old) {
        const maxD = maxH - (old.health ?? maxH);
        trackerWriteField(charId, 'vitae',     Math.max(0, Math.min(old.vitae  ?? maxV,  maxV)));
        trackerWriteField(charId, 'willpower', Math.max(0, Math.min(old.wp     ?? maxWP, maxWP)));
        trackerWriteField(charId, 'lethal',    Math.max(0, Math.min(maxD,                maxH)));
        trackerWriteField(charId, 'inf',       Math.max(0, Math.min(old.inf    ?? maxInf, maxInf)));
      }
    } catch (e) { /* ignore */ }
  }

  const cs = trackerRead(charId);
  const tState = {
    vitae:  Math.max(0, Math.min(cs.vitae      ?? maxV,  maxV)),
    wp:     Math.max(0, Math.min(cs.willpower  ?? maxWP, maxWP)),
    health: Math.max(0, maxH - (cs.bashing ?? 0) - (cs.lethal ?? 0) - (cs.aggravated ?? 0)),
    inf:    Math.max(0, Math.min(cs.inf         ?? maxInf, maxInf)),
  };

  const TRACKER_LABELS = { health: 'Health', vitae: 'Vitae', wp: 'Willpower', inf: 'Influence' };

  // Health box row — shows bashing (/), lethal (X), aggravated (X|) marks per VtR rules
  function mkHealthRow(agg, leth, bash, max) {
    const disp = Math.min(max, 15);
    const healthy = Math.max(0, disp - agg - leth - bash);
    let boxes = '';
    for (let i = 0; i < disp; i++) {
      let cls = 'tbox', mark = '';
      if (i < agg)                    { cls += ' tbox-agg';     mark = '<svg class="tbox-mark" viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3"/><line x1="3" y1="3" x2="17" y2="17"/><line x1="10" y1="2" x2="10" y2="18"/></svg>'; }
      else if (i < agg + leth)        { cls += ' tbox-lethal';  mark = '<svg class="tbox-mark" viewBox="0 0 20 20"><line x1="3" y1="17" x2="17" y2="3"/><line x1="3" y1="3" x2="17" y2="17"/></svg>'; }
      else if (i < agg + leth + bash) { cls += ' tbox-bashing'; mark = '<svg class="tbox-mark" viewBox="0 0 20 20"><line x1="4" y1="16" x2="16" y2="4"/></svg>'; }
      else                            { cls += ' health-filled'; }
      boxes += `<div class="${cls}" data-tracker="health" data-idx="${i}" data-max="${disp}" data-filled="health-filled">${mark}</div>`;
    }
    const dmgTotal = agg + leth + bash;
    const legend = dmgTotal > 0
      ? `<span class="sh-health-legend">${agg ? `<span class="sh-hl-agg">${agg}A</span>` : ''}${leth ? `<span class="sh-hl-let">${leth}L</span>` : ''}${bash ? `<span class="sh-hl-bash">${bash}B</span>` : ''}</span>`
      : '';
    return `<div class="sh-tracker-row">
      <div class="sh-tracker-lbl">Health</div>
      <div class="sh-tracker-boxes" id="tb-health">${boxes}</div>
      <div class="sh-tracker-num" id="tn-health">${max - dmgTotal}/${max}${legend}</div>
    </div>`;
  }

  function mkBoxRow(type, current, max, filledCls, infoHtml) {
    const disp = Math.min(max, 15);
    const boxes = Array.from({ length: disp }, (_, i) => {
      const filled = i < current;
      return `<div class="tbox${filled ? ' ' + filledCls : ''}" data-tracker="${type}" data-idx="${i}" data-max="${disp}" data-filled="${filledCls}"></div>`;
    }).join('');
    const infoBtn = infoHtml
      ? `<button class="sh-tracker-info-btn" data-info-type="${type}" title="Breakdown">?</button>`
      : '';
    const infoPopover = infoHtml
      ? `<div class="sh-tracker-popover" id="popover-${type}" style="display:none">${infoHtml}</div>`
      : '';
    return `<div class="sh-tracker-row">
      <div class="sh-tracker-lbl">${TRACKER_LABELS[type] || type}</div>
      <div class="sh-tracker-boxes" id="tb-${type}">${boxes}</div>
      <div class="sh-tracker-num" id="tn-${type}">${current}/${max}${infoBtn}</div>
      ${infoPopover}
    </div>`;
  }

  const bdLines = influenceBreakdown(c);
  const infPopoverHtml = bdLines.length
    ? bdLines.map(l => `<span class="sh-inf-merit">${l}</span>`).join('')
    : '';

  html += `<div class="sh-tracker-block" id="tracker-block">
    ${mkHealthRow(cs.aggravated ?? 0, cs.lethal ?? 0, cs.bashing ?? 0, maxH)}
    ${mkBoxRow('vitae', tState.vitae, maxV, 'vitae-filled')}
    ${mkBoxRow('wp', tState.wp, maxWP, 'wp-filled')}
    ${maxInf > 0 ? mkBoxRow('inf', tState.inf, maxInf, 'inf-filled', infPopoverHtml) : ''}
  </div>`;

  // ── Split point: stats content ends here ──
  const statsHtml = html;
  html = '';

  // ── BODY ──
  html += `<div class="sh-body">`;

  // Attributes + Skills combined carousel (Mental / Physical / Social)
  const CATEGORIES = [
    { label: 'Mental',   attrs: ['Intelligence', 'Wits', 'Resolve'],
      skills: ['Academics', 'Computer', 'Crafts', 'Investigation', 'Medicine', 'Occult', 'Politics', 'Science'] },
    { label: 'Physical', attrs: ['Strength', 'Dexterity', 'Stamina'],
      skills: ['Athletics', 'Brawl', 'Drive', 'Firearms', 'Larceny', 'Stealth', 'Survival', 'Weaponry'] },
    { label: 'Social',   attrs: ['Presence', 'Manipulation', 'Composure'],
      skills: ['Animal Ken', 'Empathy', 'Expression', 'Intimidation', 'Persuasion', 'Socialise', 'Streetwise', 'Subterfuge'] },
  ];

  html += `<div class="sh-sec">`;
  // Badge indicators above carousel
  html += `<div class="attr-carousel-badges">${CATEGORIES.map((cat, i) =>
    `<span class="attr-carousel-badge${i === 0 ? ' active' : ''}" data-carousel-idx="${i}">${cat.label}</span>`
  ).join('')}</div>`;
  // Carousel container
  html += `<div class="attr-skills-carousel" id="attr-carousel">`;
  CATEGORIES.forEach(cat => {
    html += `<div class="attr-skills-card">`;
    // Attributes block
    html += `<div class="attr-cell"><div class="attr-group-hd">${cat.label} Attributes</div>`;
    cat.attrs.forEach(a => {
      const base = getAttrDots(c, a), bonus = getAttrBonus(c, a);
      // Issue #425: use shDotsWithBonus (the canonical opts-aware helper)
      // so modded attribute dots/bonus get gold-tint + marker. autoBonus is
      // the discipline-derived portion (getAttrBonus combines manual + disc);
      // manual bonus = c.attributes[a].bonus. This also aligns the suite's
      // attribute bonus-dot styling with the editor + skills (which already
      // use shDotsWithBonus) — the suite-only .dots-bonus wrapper from
      // sheet-helpers' dotsWithBonus is dropped for attributes.
      const manualBonus = c.attributes?.[a]?.bonus || 0;
      const autoBonus = Math.max(0, bonus - manualBonus);
      const opts = _stmAttrOpts(c, a, autoBonus);
      html += `<div class="attr-row-item"><span class="attr-name">${a}</span><span class="attr-dots">${shDotsWithBonus(base, bonus, opts)}</span></div>`;
    });
    html += `</div>`;
    // Skills block — matches desktop view: PT/MCI bonus dots shown hollow,
    // 9-Again labelled with source (PT/OHM), specs formatted with AoE highlight
    html += `<div class="skill-col-block"><div class="attr-group-hd">${cat.label} Skills</div>`;
    cat.skills.forEach(s => {
      const sk = getSkillObj(c, s);
      const d = sk.dots, bn = sk.bonus;
      const sp = (sk.specs || []).length ? formatSpecs(c, sk.specs) : '';
      const na = sk.nine_again;
      const ptNa = c._pt_nine_again_skills?.has(s);
      const ohmNa = c._ohm_nine_again_skills?.has(s);
      const ptBn = c._pt_dot4_bonus_skills?.has(s) ? 1 : 0;
      const mciBn = c._mci_dot3_skills?.has(s) ? 1 : 0;
      const totalBn = bn + ptBn + mciBn;
      const hasDots = d > 0 || totalBn > 0;
      // Issue #425: opts for modded skill dots/bonus.
      const dotStr = hasDots ? shDotsWithBonus(d, totalBn, _stmSkillOpts(c, s)) : '\u2013';
      const naLabel = na ? '9-Again' : ptNa ? '9-Again (PT)' : ohmNa ? '9-Again (OHM)' : '';
      html += `<div class="skill-row${hasDots ? ' has-dots' : ''}">
        <div class="skill-row-top">
          <div class="skill-name-wrap">
            <span class="skill-name">${s}</span>
            ${sp ? `<span class="skill-spec">${sp}</span>` : ''}
          </div>
          <div class="skill-dots-wrap">
            <span class="${hasDots ? 'skill-dots' : 'skill-zero'}">${dotStr}</span>
            ${naLabel ? `<span class="skill-na${ptNa || ohmNa ? ' pt-na' : ''}">${naLabel}</span>` : ''}
          </div>
        </div>
      </div>`;
    });
    html += `</div>`;
    html += `</div>`; // end card
  });
  html += `</div></div>`;

  // ── Split point: skills content ends here ──
  const skillsHtml = html;
  html = '';

  // ── Powers -- four sections ──

  function dotsMixed(purchased, bonus) {
    if (!purchased && !bonus) return '';
    return '<span class="trait-dots">'
      + '<span class="pointed"></span>'.repeat(purchased)
      + '<span class="pointed hollow"></span>'.repeat(bonus)
      + '</span>';
  }

  // Issue #994: alnum-only id fragment for the rules-text expander toggle.
  const _slugId = s => String(s || '').replace(/[^a-zA-Z0-9]/g, '');
  const _charSlug = c.name.replace(/[^a-z]/gi, '');

  if (c.disciplines && Object.keys(c.disciplines).length) {

    function renderDiscRow(d, r, nameClass) {
      const discPowers = powersForDisc(c.powers || [], d, r);
      const hasPowers = discPowers.length > 0;
      const id = 'disc-' + c.name.replace(/[^a-z]/gi, '') + d.replace(/[^a-z]/gi, '');
      let drawerHtml = '';
      discPowers.forEach(p => {
        const _pRulesExp = p.rules_text ? renderRulesExpander('rt-' + _charSlug + _slugId(p.name), p.rules_text, p.rules_source) : '';
        drawerHtml += `<div class="disc-power">
          <div class="disc-power-name">${p.name || ''}</div>
          ${p.stats ? `<div class="disc-power-stats">${p.stats}</div>` : ''}
          <div class="disc-power-effect">${p.effect || ''}</div>
          ${_pRulesExp}
        </div>`;
      });
      if (d === 'Auspex' && r >= 1) {
        drawerHtml += `<button class="auspex-insight-btn" onclick="openPanel('auspex')">Auspex Insight \u203A</button>`;
      }
      const nCls = nameClass ? `trait-name ${nameClass}` : 'trait-name';
      // Issue #425 (fixed properly here): modded discipline dots recolour
      // in place via shDotsWithBonus's filledMod, matching the #408
      // attribute/skill convention — not a standalone marker pip appended
      // after the dot run, which visually reads as an extra dot. Disciplines
      // are object-keyed (project_disciplines_object_keyed) so the path is
      // disciplines.<Name>.dots.
      const dTag = r ? `<span class="trait-dots">${shDotsWithBonus(r, 0, _stmDiscOpts(c, d))}</span>` : '';
      const isExpandable = hasPowers || (d === 'Auspex' && r >= 1);
      const inner = `<div class="trait-row"><div class="trait-main"><span class="${nCls}">${d}</span><div class="trait-right">${dTag}${isExpandable ? '<span class="disc-tap-arr">\u203A</span>' : ''}</div></div></div>`;
      if (!isExpandable) return `<div class="disc-tap-row">${inner}</div>`;
      return `<div class="disc-tap-row" id="disc-row-${id}" onclick="suiteToggleDisc('${id}')">${inner}</div>
        <div class="disc-drawer" id="disc-drawer-${id}">${drawerHtml}</div>`;
    }

    const discEntries = Object.entries(c.disciplines).filter(([, r]) => (r?.dots || 0) > 0).sort(([a], [b]) => a.localeCompare(b));
    const coreDiscs = discEntries.filter(([d]) => CORE_DISCS.includes(d));
    const ritualDiscs = discEntries.filter(([d]) => RITUAL_DISCS.includes(d));

    // 1. Disciplines
    if (coreDiscs.length) {
      html += `<div class="sh-sec"><div class="sh-sec-title">Disciplines</div><div class="disc-list">`;
      coreDiscs.forEach(([d, r]) => { html += renderDiscRow(d, r?.dots || 0, null); });
      html += `</div></div>`;
    }

    // 2. Devotions
    const devotionPowers = devotions(c);
    if (devotionPowers.length) {
      html += `<div class="sh-sec"><div class="sh-sec-title">Devotions</div><div class="disc-list">`;
      devotionPowers.forEach((p, i) => {
        const gid = 'dev' + c.name.replace(/[^a-z]/gi, '') + i;
        const _devRule = getRulesByCategory('devotion').find(r => r.name === p.name);
        const _devRulesExp = _devRule?.rules_text ? renderRulesExpander('rt-' + gid, _devRule.rules_text, _devRule.rules_source) : '';
        const inner = `<div class="trait-row"><div class="trait-main"><span class="trait-name secondary">${p.name || ''}</span><div class="trait-right"><span class="disc-tap-arr">\u203A</span></div></div></div>`;
        html += `<div class="disc-tap-row" id="disc-row-${gid}" onclick="suiteToggleDisc('${gid}')">${inner}</div>
          <div class="disc-drawer" id="disc-drawer-${gid}"><div class="disc-power">
            ${p.stats ? `<div class="disc-power-stats">${p.stats}</div>` : ''}
            <div class="disc-power-effect">${p.effect || ''}</div>
            ${_devRulesExp}
          </div></div>`;
      });
      html += `</div></div>`;
    }

    // 3. Blood Sorcery (Cruac, Theban)
    if (ritualDiscs.length) {
      html += `<div class="sh-sec"><div class="sh-sec-title">Blood Sorcery</div><div class="disc-list">`;
      ritualDiscs.forEach(([d, r]) => { html += renderDiscRow(d, r?.dots || 0, 'sorcery'); });
      html += `</div></div>`;
    }

    // 4. Rites (Cruac / Theban — stored on c.powers)
    const ritesList = rites(c);
    if (ritesList.length) {
      html += `<div class="sh-sec"><div class="sh-sec-title">Rites</div><div class="disc-list">`;
      ritesList.forEach((p, i) => {
        const gid = 'rite' + c.name.replace(/[^a-z]/gi, '') + i;
        const levelDots = p.level ? `<span class="trait-dots">${dots(p.level)}</span>` : '';
        const mgChip = p.mandragora_parked ? `<span class="rite-mg-tag" title="Permanently sustained by Mandragora Garden">MG</span>` : '';
        const tradSub = (p.tradition || mgChip) ? `<div class="trait-sub"><span class="trait-qual dim">${p.tradition || ''}</span>${mgChip}</div>` : '';
        const _riteRule = getRulesByCategory('rite').find(r => r.name === p.name);
        const _riteRulesExp = _riteRule?.rules_text ? renderRulesExpander('rt-' + gid, _riteRule.rules_text, _riteRule.rules_source) : '';
        const inner = `<div class="trait-row"><div class="trait-main"><span class="trait-name secondary">${p.name}</span><div class="trait-right">${levelDots}<span class="disc-tap-arr">\u203A</span></div></div>${tradSub}</div>`;
        html += `<div class="disc-tap-row" id="disc-row-${gid}" onclick="suiteToggleDisc('${gid}')">${inner}</div>
          <div class="disc-drawer" id="disc-drawer-${gid}"><div class="disc-power">
            ${p.stats ? `<div class="disc-power-stats">${p.stats}</div>` : ''}
            <div class="disc-power-effect">${p.effect || ''}</div>
            ${_riteRulesExp}
          </div></div>`;
      });
      html += `</div></div>`;
    }

    // 5. Pacts (Oaths of the Notary, Carthian Law)
    const pactsList = pacts(c);
    if (pactsList.length) {
      html += `<div class="sh-sec"><div class="sh-sec-title">Pacts</div><div class="disc-list">`;
      pactsList.forEach((p, i) => {
        const gid = 'pact' + c.name.replace(/[^a-z]/gi, '') + i;
        // Issue #994: pacts (Invictus Oaths / Carthian Law) live in purchasable_powers
        // as category "merit" (matches editor/sheet.js's _oathDB derivation).
        // Match case-insensitively since stored power names vary in casing.
        const _pactRule = getRulesByCategory('merit').find(r => (r.name || '').toLowerCase() === (p.name || '').toLowerCase());
        const _pactRulesExp = _pactRule?.rules_text ? renderRulesExpander('rt-' + gid, _pactRule.rules_text, _pactRule.rules_source) : '';
        const inner = `<div class="trait-row"><div class="trait-main"><span class="trait-name secondary">${p.name}</span><div class="trait-right"><span class="disc-tap-arr">\u203A</span></div></div></div>`;
        html += `<div class="disc-tap-row" id="disc-row-${gid}" onclick="suiteToggleDisc('${gid}')">${inner}</div>
          <div class="disc-drawer" id="disc-drawer-${gid}"><div class="disc-power">
            ${p.stats ? `<div class="disc-power-stats">${p.stats}</div>` : ''}
            <div class="disc-power-effect">${p.effect || ''}</div>
            ${_pactRulesExp}
          </div></div>`;
      });
      html += `</div></div>`;
    }
  }

  // ── Influence + Domain Merits ──
  // Delegated to the editor's view-mode renderers so the suite app and the
  // admin/player editor stay byte-identical for these sections. Historically
  // the suite hand-rolled its own dot math here and silently dropped each
  // new free_* field (free_attache, free_fwb, free_pt, etc.) on landing.
  // Keeping a single source of truth means new bonus fields appear in both
  // places automatically — no parallel update required.
  html += shRenderInfluenceMerits(c, false);
  html += shRenderDomainMerits(c, false);
  // oxp.7: read-only, own-office-only. Reserves an empty placeholder now
  // (synchronous); patchOfficeMerits(c) below fills it once seats + merit
  // dots resolve, or leaves it empty (AC3 — never a guessed seat).
  html += shRenderOfficeMerits(c);

  // ── Standing Merits ──
  const stndMerits = standingMerits(c).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (stndMerits.length) {
    const _pd = '<span class="pointed"></span>';
    const tierDotStr = [_pd, _pd.repeat(2), _pd.repeat(3), _pd.repeat(4), _pd.repeat(5)];
    html += `<div class="sh-sec"><div class="sh-sec-title">Standing Merits</div><div class="stand-list">`;
    stndMerits.forEach((m, mi) => {
      const sid = 'smt' + mi;
      const qualifier = m.cult_name || m.qualifier || m.role || '';
      // Build drawer content
      let drawerHtml = '';
      if (m.name === 'Mystery Cult Initiation' && m.rating > 0) {
        const tg = m.tier_grants || [];
        const d1c = m.dot1_choice || 'merits', d3c = m.dot3_choice || 'merits', d5c = m.dot5_choice || 'merits';
        drawerHtml += '<div class="mci-tier-list">';
        for (let d = 0; d < Math.min(5, m.rating); d++) {
          const tier = d + 1;
          const grant = tg.find(t => t.tier === tier);
          let label;
          if (d === 0 && d1c === 'speciality') label = 'Spec: ' + (m.dot1_spec_skill || '') + (m.dot1_spec ? ' (' + m.dot1_spec + ')' : '');
          else if (d === 2 && d3c === 'skill') label = 'Skill: ' + (m.dot3_skill || '');
          else if (d === 4 && d5c === 'advantage') label = 'Adv: ' + (m.dot5_text || '');
          else if (grant) label = grant.name + (grant.qualifier ? ' (' + grant.qualifier + ')' : '') + ' ' + dots(grant.rating);
          else label = '<span class="mci-tier-empty">(unassigned)</span>';
          drawerHtml += '<div class="mci-tier-row"><span class="mci-tier-dot">' + tierDotStr[d] + '</span><span class="mci-tier-label">' + label + '</span></div>';
        }
        drawerHtml += '</div>';
      } else if (m.name === 'Professional Training') {
        const as = (m.asset_skills || []).filter(Boolean);
        if (as.length) {
          drawerHtml += `<div class="stand-asset-row"><span class="stand-asset-lbl">Asset Skills (9-Again):</span>${as.map(s => `<span class="stand-na-chip">${s}</span>`).join('')}</div>`;
        }
        // PT tier benefits up to purchased rating
        const ptTiers = [
          '2 dots of Contacts',
          '2 Asset Skills',
          '3rd Asset Skill, +2 Specialisations on Asset Skills',
          '+1 dot in an Asset Skill',
          'Rote quality on any Asset Skill roll (spend 1 Willpower)',
        ];
        drawerHtml += '<div class="mci-tier-list">';
        for (let d = 0; d < Math.min(5, m.rating); d++) {
          drawerHtml += `<div class="mci-tier-row"><span class="mci-tier-dot">${tierDotStr[d]}</span><span class="mci-tier-label">${ptTiers[d]}</span></div>`;
        }
        drawerHtml += '</div>';
      }
      const qualSub = qualifier ? `<div class="trait-sub"><span class="trait-qual">${qualifier}</span></div>` : '';
      const standInner = `<div class="trait-row"><div class="trait-main"><span class="trait-name">${m.name}</span><div class="trait-right"><span class="trait-dots">${dots(m.rating || 0)}</span>${drawerHtml ? '<span class="disc-tap-arr">\u203A</span>' : ''}</div></div>${qualSub}</div>`;
      if (drawerHtml) {
        html += `<div class="disc-tap-row" id="disc-row-${sid}" onclick="suiteToggleDisc('${sid}')">${standInner}</div>
          <div class="disc-drawer" id="disc-drawer-${sid}">${drawerHtml}</div>`;
      } else {
        html += `<div class="disc-tap-row" style="cursor:default">${standInner}</div>`;
      }
    });
    html += `</div></div>`;
  }

  // ── General Merits + Manoeuvres ──
  // Delegated to editor renderers (same rationale as Influence/Domain above):
  // single source of truth keeps the suite app and editor in lockstep so new
  // free_* fields show up in both views without parallel updates.
  html += shRenderGeneralMerits(c, false);
  html += shRenderManoeuvres(c, false);

  // ── Active Conditions (from tracker_state) ──
  const cs2 = trackerRead(String(c._id));
  const activeConds = (cs2 && cs2.conditions) ? cs2.conditions : [];
  if (activeConds.length) {
    html += `<div class="sh-sec"><div class="sh-sec-title">Active Conditions</div><div class="cond-sheet-list">`;
    activeConds.forEach(cond => {
      const condName   = typeof cond === 'object' ? cond.name : cond;
      const condEffect = typeof cond === 'object' ? cond.effect : '';
      const condRes    = typeof cond === 'object' ? cond.resolution : '';
      html += `<div class="cond-sheet-card"><div class="cond-sheet-name">${esc(condName)}</div>`;
      if (condEffect) html += `<div class="cond-sheet-effect">${esc(condEffect)}</div>`;
      if (condRes)    html += `<div class="cond-sheet-res"><span class="cond-sheet-res-lbl">Resolution:</span> ${esc(condRes)}</div>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  }

  // ── Equipment ──
  // Delegated to editor renderer for parity with admin/player views.
  html += shRenderEquipment(c, false);

  html += `</div>`; // end sh-body
  const powersHtml = html;

  // Render to split-tab containers (phone + desktop unified).
  // Desktop mode: render to the full-sheet container so the Sheet tab works.
  // Mobile mode: render to split-tab containers only, clear the full sheet
  // to avoid duplicate IDs that break toggleExp/toggleDisc.
  // gdx-9: a third mode — phone + the single-scroll flag on — also renders
  // into the full-sheet container (reusing desktop's own concatenation
  // path, `#t-sheets`/`#sh-content-suite`, already unused on phone today)
  // instead of the four split containers, with a new pinned track-strip +
  // jump-nav block prepended. Flag off: byte-for-byte the original two-mode
  // behaviour below.
  const isDesktop = document.body.classList.contains('desktop-mode');
  const useSingleScroll = !isDesktop && singleScrollEnabled();
  if (el && (isDesktop || useSingleScroll)) {
    el.innerHTML = useSingleScroll
      ? _gdx9PinnedBlockHtml(c)
        + `<section id="gdx9-sec-info" class="gdx9-section">${infoHtml}</section>`
        + `<section id="gdx9-sec-stats" class="gdx9-section">${statsHtml}</section>`
        + `<section id="gdx9-sec-skills" class="gdx9-section">${skillsHtml}</section>`
        + `<section id="gdx9-sec-powers" class="gdx9-section"><div class="sh-powers-grid">${powersHtml}</div></section>`
      : infoHtml + statsHtml + skillsHtml + '<div class="sh-powers-grid">' + powersHtml + '</div>';
  } else if (el) {
    el.innerHTML = '';
  }
  // Always populate split tabs (used on the original 4-tab phone UX; empty
  // on desktop and in single-scroll mode, both of which render into `el`).
  const usesFullSheet = isDesktop || useSingleScroll;
  if (statsEl)  statsEl.innerHTML  = usesFullSheet ? '' : statsHtml;
  if (skillsEl) skillsEl.innerHTML = usesFullSheet ? '' : skillsHtml;
  if (powersEl) powersEl.innerHTML = usesFullSheet ? '' : powersHtml;
  if (infoEl)   infoEl.innerHTML   = usesFullSheet ? '' : infoHtml;

  // Wire attribute+skills carousel indicators — target wherever the content
  // actually landed (skillsEl is left empty, not null, when usesFullSheet).
  _wireAttrCarousel(usesFullSheet ? el : skillsEl);

  // gdx-9: pinned strip + jump-nav interactivity, phone single-scroll only.
  if (useSingleScroll) _wireGdx9Pinned(el);

  // oxp.7: un-awaited, same as status.js's own appendOfficeActionsLog call —
  // must run AFTER the innerHTML writes above, since it finds its own
  // placeholder(s) by querying the DOM they just landed in.
  patchOfficeMerits(c);
}

// ── gdx-9: pinned track strip + jump-nav (single-scroll phone sheet) ──

/** Compact Vitae/WP/Health strip HTML, seeded from live tracker state at
 *  render time. Kept in sync after tap-box writes by
 *  _gdx9SyncPinnedTrack (called from repaintSheetTrackers above). */
function _gdx9PinnedBlockHtml(c) {
  const maxH  = calcHealth(c);
  const maxV  = calcVitaeMax(c);
  const maxWP = calcWillpowerMax(c);
  const cs = trackerRead(String(c._id)) || {};
  const health = Math.max(0, maxH - (cs.bashing ?? 0) - (cs.lethal ?? 0) - (cs.aggravated ?? 0));
  const vitae  = Math.max(0, Math.min(cs.vitae ?? maxV, maxV));
  const wp     = Math.max(0, Math.min(cs.willpower ?? maxWP, maxWP));
  const pct = (cur, max) => (max > 0 ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0);
  const chip = (type, label, cur, max, cls) => `<div class="gdx9-track-chip">
    <div class="gdx9-track-head"><span class="gdx9-track-lbl">${label}</span><span class="gdx9-track-num" id="gdx9-tn-${type}">${cur}/${max}</span></div>
    <div class="gdx9-track-bar"><div class="gdx9-track-fill ${cls}" id="gdx9-tf-${type}" style="width:${pct(cur, max)}%"></div></div>
  </div>`;
  return `<div class="gdx9-pinned" id="gdx9-pinned">
    <div class="gdx9-track-strip" id="gdx9-track-strip" role="button" tabindex="0" aria-label="Jump to full tracker">
      ${chip('vitae', 'Vitae', vitae, maxV, 'vitae')}
      ${chip('wp', 'WP', wp, maxWP, 'wp')}
      ${chip('health', 'Health', health, maxH, 'health')}
      <span class="gdx9-track-arrow">&rsaquo;</span>
    </div>
    <nav class="gdx9-jump-nav" aria-label="Sheet sections">
      <button type="button" class="gdx9-jump-chip active" data-target="gdx9-sec-info">Info</button>
      <button type="button" class="gdx9-jump-chip" data-target="gdx9-sec-stats">Stats</button>
      <button type="button" class="gdx9-jump-chip" data-target="gdx9-sec-skills">Skills</button>
      <button type="button" class="gdx9-jump-chip" data-target="gdx9-sec-powers">Powers</button>
    </nav>
  </div>`;
}

/** Wires jump-chip scroll, active-chip sync, and the track-strip's own
 *  tap-through to Stats. Mirrors _wireAttrCarousel's own scroll-sync shape.
 *  container is `el` (#sh-content-suite); the actual scroll box is its
 *  ancestor `.tab` (#t-sheets, `.tab{overflow-y:auto}` in suite.css). */
function _wireGdx9Pinned(container) {
  if (!container) return;
  const pinned = container.querySelector('#gdx9-pinned');
  if (!pinned) return;
  const scrollHost = pinned.closest('.tab') || container;
  const chips = Array.from(pinned.querySelectorAll('.gdx9-jump-chip'));
  const sections = chips.map(chip => container.querySelector('#' + chip.dataset.target));

  function applyScrollMargins() {
    const px = pinned.offsetHeight + 'px';
    sections.forEach(s => { if (s) s.style.scrollMarginTop = px; });
  }
  applyScrollMargins();

  function jumpTo(targetId) {
    container.querySelector('#' + targetId)?.scrollIntoView({ block: 'start' });
  }

  chips.forEach(chip => {
    chip.addEventListener('click', () => jumpTo(chip.dataset.target));
  });

  const trackStrip = pinned.querySelector('#gdx9-track-strip');
  if (trackStrip) {
    trackStrip.addEventListener('click', () => jumpTo('gdx9-sec-stats'));
    trackStrip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpTo('gdx9-sec-stats'); }
    });
  }

  // Active-chip sync: which section's top has scrolled up to (or past) the
  // pinned block's bottom edge, picking the LAST one that qualifies. Uses
  // direct scroll-position math rather than IntersectionObserver — a
  // short final section (e.g. Powers with no disciplines/merits yet) can
  // never be scrolled far enough for its own bounding box to enter a
  // narrow top-of-viewport intersection band, which left the observer
  // approach unable to ever mark it active.
  //
  // That "too short to reach the line" problem isn't fully solved by
  // switching to distance math alone, though: once scrollTop hits its own
  // maximum (nothing left to scroll), a short trailing section's offsetTop
  // can permanently sit past the activation line with no way to close the
  // gap — the classic scrollspy last-section edge case. Fixed the standard
  // way: at max scroll, the last section wins regardless of the line math.
  const validSections = sections.map((s, i) => ({ s, i })).filter(x => x.s);
  if (validSections.length) {
    const lastIdx = validSections[validSections.length - 1].i;
    function updateActiveChip() {
      const maxScroll = scrollHost.scrollHeight - scrollHost.clientHeight;
      let activeIdx;
      // maxScroll > 0 guards a character short enough that the whole sheet
      // fits without scrolling at all (scrollHeight === clientHeight): the
      // max-scroll branch below would otherwise read scrollTop(0) >= 0-1 as
      // true and wrongly snap straight to the last section, overriding the
      // correct "Info" default before the user has scrolled anywhere.
      if (maxScroll > 0 && scrollHost.scrollTop >= maxScroll - 1) {
        activeIdx = lastIdx;
      } else {
        const line = scrollHost.scrollTop + pinned.offsetHeight;
        activeIdx = validSections[0].i;
        for (const { s, i } of validSections) {
          if (s.offsetTop <= line + 1) activeIdx = i;
        }
      }
      chips.forEach((c, i) => c.classList.toggle('active', i === activeIdx));
    }
    // Code-review finding (all 3 internal layers, independently): #t-sheets
    // is a static element never recreated between renders, so a 'scroll'
    // listener attached here on every renderSheet() call (e.g. every
    // character switch) accumulated without bound — remove any listener
    // this same scrollHost was given by a previous wiring pass first.
    if (scrollHost._gdx9ScrollHandler) {
      scrollHost.removeEventListener('scroll', scrollHost._gdx9ScrollHandler);
    }
    scrollHost._gdx9ScrollHandler = updateActiveChip;
    scrollHost.addEventListener('scroll', updateActiveChip, { passive: true });
    updateActiveChip();
  }
}

function _wireAttrCarousel(container) {
  if (!container) return;
  const carousel = container.querySelector('#attr-carousel');
  const badges = container.querySelectorAll('.attr-carousel-badge');
  if (!carousel || !badges.length) return;
  const cards = carousel.querySelectorAll('.attr-skills-card');
  if (!cards.length) return;

  // Update badges on scroll
  carousel.addEventListener('scroll', () => {
    const scrollLeft = carousel.scrollLeft;
    const cardWidth = cards[0].offsetWidth;
    const idx = Math.round(scrollLeft / cardWidth);
    badges.forEach((b, i) => b.classList.toggle('active', i === idx));
  }, { passive: true });

  // Tap badge to scroll to that card
  badges.forEach((badge, i) => {
    badge.addEventListener('click', () => {
      cards[i]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  });
}

// 2026-09-01 general audit fix: was a hand-duplicated copy of data/helpers.js's
// canonical esc() (byte-for-byte identical behaviour) — import it instead.

// ── TRACKER INFO POPOVER ──
// (?) button shows influence breakdown; click outside dismisses.
document.addEventListener('click', function(e) {
  const infoBtn = e.target.closest('.sh-tracker-info-btn');
  if (infoBtn) {
    e.stopPropagation();
    const type = infoBtn.dataset.infoType;
    const popover = document.getElementById('popover-' + type);
    if (!popover) return;
    const isVisible = popover.style.display !== 'none';
    // Close all popovers first
    document.querySelectorAll('.sh-tracker-popover').forEach(p => p.style.display = 'none');
    if (!isVisible) popover.style.display = '';
    return;
  }
  // Click outside closes all popovers
  if (!e.target.closest('.sh-tracker-popover')) {
    document.querySelectorAll('.sh-tracker-popover').forEach(p => p.style.display = 'none');
  }
});

// ── TRACKER TOGGLE ──
// Event delegation on tracker-block — writes through to the canonical tracker store.
// ST/dev can adjust any tracker in either direction. A player may adjust their OWN Vitae/
// Willpower only, and only downward (spend) — Health stays ST-tracked (combat needs ST
// oversight) and Influence keeps its own declared-spend flow through the downtime form/Feeding
// tab tally, so neither opens up here just because Vitae/Willpower now do.
document.addEventListener('click', function(e) {
  const box = e.target.closest('[data-tracker]');
  if (!box) return;
  const role = (window._getRole || (() => 'player'))();
  const isPrivileged = role === 'st' || role === 'dev';
  const block = box.closest('#tracker-block');
  if (!block) return;
  if (!state.sheetChar) return;

  const type      = box.dataset.tracker;
  const idx       = parseInt(box.dataset.idx);
  const max       = parseInt(box.dataset.max);
  const filledCls = box.dataset.filled;
  const c         = state.sheetChar;
  const charId    = String(c._id);
  const cs        = trackerRead(charId);
  if (!cs) return;

  if (!isPrivileged && type !== 'vitae' && type !== 'wp') return;

  // Compute current value in sheet terms
  const maxH = calcHealth(c);
  let currentSheet;
  if      (type === 'health') currentSheet = Math.max(0, maxH - (cs.bashing ?? 0) - (cs.lethal ?? 0) - (cs.aggravated ?? 0));
  else if (type === 'vitae')  currentSheet = cs.vitae      ?? 0;
  else if (type === 'wp')     currentSheet = cs.willpower  ?? 0;
  else if (type === 'inf')    currentSheet = cs.inf        ?? 0;
  else return;

  // Tap filled → spend down to idx; tap empty → recover up to idx+1. A non-privileged caller
  // (a player, on vitae/wp only, per the gate above) may only ever spend — tapping an empty box
  // to self-restore is a silent no-op, not an error.
  const newVal = idx < currentSheet ? idx : idx + 1;
  const delta  = newVal - currentSheet;
  if (delta === 0) return;
  if (!isPrivileged && delta > 0) return;

  if (!isPrivileged) {
    // Player self-spend — routes through trackerSpend (a narrower, decrease-only write), never
    // trackerAdj, which resends the whole persisted-fields bundle including fields a player must
    // not be able to touch.
    trackerSpend(charId, type === 'vitae' ? 'vitae' : 'willpower', -delta);
  } else if (type === 'health') {
    if (delta < 0) {
      // Taking damage — add lethal (ST reclassifies in Tracker if needed)
      trackerAdj(charId, 'lethal', -delta);
    } else {
      // Healing — remove bashing first, then lethal, then aggravated
      let rem = delta;
      const removeBash = Math.min(rem, cs.bashing    ?? 0); rem -= removeBash;
      const removeLet  = Math.min(rem, cs.lethal     ?? 0); rem -= removeLet;
      const removeAgg  = Math.min(rem, cs.aggravated ?? 0);
      if (removeBash) trackerAdj(charId, 'bashing',    -removeBash);
      if (removeLet)  trackerAdj(charId, 'lethal',     -removeLet);
      if (removeAgg)  trackerAdj(charId, 'aggravated', -removeAgg);
    }
  } else if (type === 'vitae') {
    trackerAdj(charId, 'vitae', delta);
  } else if (type === 'wp') {
    trackerAdj(charId, 'willpower', delta);
  } else if (type === 'inf') {
    trackerAdj(charId, 'inf', delta);
  }

  // Re-read updated state and repaint boxes + number
  const updated = trackerRead(charId);
  let updatedSheet;
  if      (type === 'health') updatedSheet = Math.max(0, maxH - (updated.bashing ?? 0) - (updated.lethal ?? 0) - (updated.aggravated ?? 0));
  else if (type === 'vitae')  updatedSheet = updated.vitae      ?? 0;
  else if (type === 'wp')     updatedSheet = updated.willpower  ?? 0;
  else if (type === 'inf')    updatedSheet = updated.inf        ?? 0;

  const boxesEl = document.getElementById('tb-' + type);
  const numEl   = document.getElementById('tn-' + type);
  if (boxesEl) {
    boxesEl.innerHTML = Array.from({ length: max }, (_, i) => {
      const filled = i < updatedSheet;
      return `<div class="tbox${filled ? ' ' + filledCls : ''}" data-tracker="${type}" data-idx="${i}" data-max="${max}" data-filled="${filledCls}"></div>`;
    }).join('');
  }
  if (numEl) {
    const trueMax = type === 'health' ? maxH
      : type === 'vitae'  ? calcVitaeMax(c)
      : type === 'wp'     ? calcWillpowerMax(c)
      : calcTotalInfluence(c);
    numEl.textContent = updatedSheet + '/' + trueMax;
  }
});
