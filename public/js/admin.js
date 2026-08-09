/* Admin app entry point — auth gate, sidebar routing, API data loading, character editing */
console.log('%c[TM Admin] build 2026-04-08T1', 'color: #E0C47A; font-weight: bold');

import { apiGet, apiPut, apiPost, apiDelete } from './data/api.js';
import { loadGameXP } from './data/game-xp.js';
import { auditCharacter } from './data/audit.js';
import { initAdminArchive } from './admin/archive-admin.js';
import { sanitiseChar, loadRulesFromApi } from './data/loader.js';
import { downloadCSV } from './editor/export.js';
import { esc, clanIcon, covIcon, shortCov, cardName, displayName, sortName, redactPlayer, discordAvatarUrl, findRegentTerritory, isRedactMode } from './data/helpers.js';
import { setStatusTerritories } from './data/accessors.js';
import { ensureLoaded as loadTrackerState } from './game/tracker.js';
// ADR-009 D1: loadStMods / applyStMods / spliceCurrent / stripOverlay moved to
// data/sheet-composition.js with the sequence that used them. admin.js keeps
// only applyOverlayToAll, which refreshCharacterOverlay still calls directly
// until step 2 converges that function too.
import { applyOverlayToAll } from './data/st-mods.js';
// Issue #879 (ADR-006 D4): materialise c.derived.defence between calcDefence and
// applyStMods so STM overlay composes on top of the armour-adjusted base.
import { materialiseDerivedDefence } from './data/equipment-derivation.js';
import { renderSheetWithOverlay as composeAndRenderSheet, refreshCharacterOverlay as sharedRefreshOverlay } from './data/sheet-composition.js';
import { loadGlobalSettings, getGlobalSettings } from './data/app-settings.js';
import { installStModPopover } from './editor/st-mod-popover.js';
import { initWS } from './data/ws.js';
import { loadCatalogue as loadEquipmentCatalogue, refetchCatalogue as refetchEquipmentCatalogue } from './data/equipment-catalogue-cache.js';
import { xpLeft, xpEarned } from './editor/xp.js';
import { applyDerivedMerits, getPoolUsed, getMCIPoolUsed } from './editor/mci.js';
import { preloadRules } from './editor/rule_engine/load-rules.js';
import { ATTR_CATS, SKILL_CATS, PRI_BUDGETS, SKILL_PRI_BUDGETS } from './data/constants.js';
import { vmUsed, lorekeeperUsed, ohmUsed, investedUsed } from './editor/domain.js';
import { handleCallback, isLoggedIn, validateToken, login, logout, getUser, getPlayerInfo, localTestLogin } from './auth/discord.js';
import { initSessionLog } from './admin/session-log.js';
import { initPlayersView } from './admin/players-view.js';
import { initCityView } from './admin/city-views.js';
import { initSpheresView } from './admin/spheres-view.js';
import { initDowntimeView, renderCityOverview } from './admin/downtime-views.js';
import { initNpcRegister } from './admin/npc-register.js';
import { initAttendance } from './admin/attendance.js';
import { initDiceEngine } from './admin/dice-engine.js';
// #836: initFeedingEngine / initSessionTracker imports removed — both
// admin/feeding-engine.js and admin/session-tracker.js were dead-imported
// (init functions never called from anywhere) and their localStorage-keyed
// legacy tracker persistence was deprecated. Files deleted.
import { initDataPortabilityView } from './admin/data-portability.js';
import { initOrdealsAdminView } from './admin/ordeals-admin.js';
import { initPrimerAdmin } from './admin/primer-admin.js';
import { initTicketsView } from './admin/tickets-views.js';
import { initRulesView } from './admin/rules-view.js';
import { initRulesDataView } from './admin/rules-data-view.js';
import { initEquipmentCatalogueAdmin } from './admin/equipment-catalogue-admin.js';
import { initStModsAudit } from './admin/st-mods-audit.js';
import { initDevlogAdmin } from './admin/devlog-admin.js';
import { initStModsPanel } from './admin/st-mods-panel.js';
import { initCycleView } from './admin/cycle-views.js';
import { initDtStory } from './admin/downtime-story.js';
import { initNextSession } from './admin/next-session.js';
import { renderSheet, toggleExp, toggleDisc } from './editor/sheet.js';
import {
  editFromSheet, shEdit, shEditStatus,
  shEditBaneName, shEditBaneEffect, shRemoveBane, shAddBane,
  shTouchstoneStartAdd, shTouchstoneStartEdit, shTouchstonePickerClose, shTouchstonePickerDraft,
  shTouchstoneSaveAdd, shTouchstoneSaveEdit, shTouchstoneRemove,
  shEditBPCreation, shEditBPXP, shEditBPLost, shEditHumanityXP, shEditHumanityLost,
  shStatusUp, shStatusDown, shCovStandingUp, shCovStandingDown,
  shToggleOrdeal, shSetPriority, shSetClanAttr, shEditAttrPt,
  shSetSkillPriority, shEditSkillPt,
  shEditSpec, shRemoveSpec, shAddSpec,
  shEditDiscPt, shShowDevSelect, shAddDevotion, shRemoveDevotion,
  shEditInflMerit, shEditContactSphere, shRemoveInflMerit, shAddInflMerit, shAddVMAllies, shAddLKMerit,
  shEditDomMerit, shRemoveDomMerit, shAddDomMerit,
  shAllocateCompoundVirtual,
  shSwearOath,
  shReleaseOath,
  shSetPledgeDots,
  shCommitOath,
  shExitOath,
  shRestoreOathDots,
  shAddDomainPartner, shRemoveDomainPartner,
  shEditGenMerit, shRemoveGenMerit, shAddGenMerit,
  shEditStandMerit, shEditStandAssetSkill,
  shToggleMCI, shTogglePT, shEditMCIDot, shEditMCITierGrant, shEditMCITierQual, shRemoveStandMerit, shAddStandMCI, shAddStandPT,
  shAddStyle, shRemoveStyle, shEditStyle, shAddPick, shRemovePick,
  shAddRite, shRemoveRite, shToggleRiteFree, shRefreshRiteDropdown,
  shAddPact, shRemovePact, shEditPact,
  shEditMeritPt, shStepMeritRating, shEditXP, shAdjMeritBonus,
  shSetWhiteAntsTerritory,
  shSetTrapDoorAnchor,
  shAddEquip, shRemoveEquip, shEquipBucketFilter,
  registerCallbacks as registerEditCallbacks,
  getDirtyPartners, clearDirtyPartners
} from './editor/edit.js';
import { renderIdentityTab, updField, updStatus, registerCallbacks as registerIdentityCallbacks } from './editor/identity.js';
import {
  renderAttrsTab, clickAttrDot,
  clickSkillDot, toggleNineAgain, updSkillSpec,
  registerCallbacks as registerAttrsCallbacks
} from './editor/attrs-tab.js';
import { printSheet, printPDF, exportJSON } from './editor/print.js';
import editorState from './data/state.js';

const CLANS = ['Daeva', 'Gangrel', 'Mekhet', 'Nosferatu', 'Ventrue'];
const COVENANTS = ['Carthian Movement', 'Circle of the Crone', 'Invictus', 'Lancea et Sanctum', 'Ordo Dracul'];
const COURT_TITLES = ['', 'Head of State', 'Primogen', 'Socialite', 'Enforcer', 'Administrator'];
const REGENT_TERRITORIES = ['The Academy', 'The North Shore', 'The Dockyards', 'The Second City', 'The Harbour'];

let chars = [];
let _players = []; // cached for link icon on char cards
let selectedChar = null;

// ── Editor wiring ──

function markDirty(idx) {
  if (idx === undefined) idx = editorState.editIdx;
  if (idx < 0) return;
  editorState.dirty.add(idx);
  const badge = document.getElementById('cd-dirty-badge');
  if (badge) badge.style.display = editorState.dirty.size > 0 ? '' : 'none';
}

registerEditCallbacks(markDirty, renderSheet);
registerIdentityCallbacks(markDirty);
registerAttrsCallbacks(markDirty);

// ── ST mod overlay composition (Epic STM, issue #372) ──
//
// Single composition site per ADR-004 §D1. Sequence: load tracker_state →
// splice synthetic c.current.* (D5) → load mods → applyStMods → renderSheet.
// In edit mode, the overlay is stripped before render so the editor always
// sees canonical base values; this also defends against the silent
// fresh-fetch failure path in cd-edit-toggle leaving modded canonical
// fields visible.
// ADR-009 D1/D4 step 1: the composition sequence now lives in
// data/sheet-composition.js. This wrapper preserves admin.js's exact behaviour
// -- it supplies the tracker loader unconditionally, which is what admin.html
// did before, because every admin.html session is an authenticated ST and so
// may always read tracker_state (ADR-009 D3).
//
// app.js's equivalent is converged onto the same module in step 2; until then
// the two callers differ only in what they inject, not in what they compute.
function renderSheetWithOverlay(c) {
  return composeAndRenderSheet(c, { renderSheet, loadTrackerState });
}

// Re-apply the overlay for a single character (by id) and, if it's the
// currently-open sheet, re-render. Shared by the WS onStModUpdate handler
// and the sheet's own audited apply-bonus affordance (STM-14, issue #1034 —
// installStModPopover's onMutate callback) so both paths route through the
// same composition sequence (single composition site, ADR-004 §D1/§D8).
// ADR-009 D1 step 2: sequence lives in data/sheet-composition.js. admin.js
// supplies its own char array and its own "is this sheet open" predicate; the
// composition itself is no longer duplicated here.
function refreshCharacterOverlay(charId) {
  return sharedRefreshOverlay(charId, {
    getChars: () => chars,
    renderIfOpen: (target) => {
      const idx = editorState.editIdx;
      if (idx != null && idx >= 0 && chars[idx] === target) {
        renderSheetWithOverlay(target);
      }
    },
  });
}

// ── Auth gate ──

async function boot() {
  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('admin-app');
  const errorEl = document.getElementById('login-error');

  try {
    const wasCallback = await handleCallback();
    if (wasCallback) { /* fall through */ }
  } catch (err) {
    errorEl.textContent = err.message;
    return;
  }

  if (isLoggedIn()) {
    const valid = await validateToken();
    if (valid) {
      // Check if user was logging in from another page (index, player)
      const returnTo = localStorage.getItem('tm_auth_return');
      localStorage.removeItem('tm_auth_return');
      if (returnTo && returnTo !== '/admin' && returnTo !== '/admin.html') {
        window.location.replace(returnTo);
        return;
      }

      // Non-ST users get redirected to the game app — admin.html is ST/dev only.
      // Coordinators have their own tabs inside the game app; they never see this view.
      const info = getPlayerInfo();
      if (info && info.role !== 'st' && info.role !== 'dev') {
        window.location.replace('/');
        return;
      }

      loginScreen.style.display = 'none';
      app.style.display = 'flex';
      renderSidebarUser();
      renderSidebarFooter();
      // Prime the global settings cache before any character render
      // possibly triggers an overlay composition (STM-3 / issue #378).
      // Non-blocking — overlay treats a null cache as enabled.
      loadGlobalSettings();
      init();

      // Subscribe to remote tracker_state mutations so the active sheet
      // re-composes (splice → overlay → render) within ~1s of a write
      // from another tab / device (AC#7 / ADR-004 §D5). The WS client
      // suppresses echoes of our own writes via markLocalWrite.
      initWS({
        onTrackerUpdate: (charId) => {
          const idx = editorState.editIdx;
          if (idx == null || idx < 0) return;
          const c = chars[idx];
          if (!c || String(c._id) !== String(charId)) return;
          renderSheetWithOverlay(c);
        },
        // STM-9 (issue #416, ADR-004 Rev 3 §D11): on remote st_mod
        // create/revoke, refresh that character's cache entry by
        // re-running the full overlay helper. Re-renders the active
        // sheet only if the affected character is the open one;
        // other characters get a silent cache update for the next
        // time their sheet opens.
        onStModUpdate: refreshCharacterOverlay,
        // ECM-5 (issue #872): on remote equipment_catalogue create/update/
        // delete (broadcast by the admin catalogue UI via server/ws.js's
        // broadcastCatalogueUpdate), refetch the cache. Cache subscribers
        // (currently the edit-mode equipment dropdown via shEquipBucketFilter,
        // re-fired on next bucket change) pick up the new entries on next
        // read. Op is advisory per the server-side comment; we refetch
        // regardless rather than per-op state-machine.
        onCatalogueUpdate: () => { refetchEquipmentCatalogue(); },
      });

      // Epic STM (issue #385): install delegated click handler for the
      // ST mod marker popover. Single listener at document.body — survives
      // sheet re-renders. Markers carry data-stm-marker-path attributes;
      // the popover resolves the active character via window.__activeChar,
      // which renderSheet (editor/sheet.js) sets on every render (#1040).
      installStModPopover(document.body, refreshCharacterOverlay);
      return;
    }
  }

  loginScreen.style.display = '';
  document.getElementById('login-btn').addEventListener('click', login);

  if (location.hostname === 'localhost') {
    const devBtn = document.createElement('button');
    devBtn.textContent = 'Dev Preview (local only)';
    devBtn.style.cssText = 'margin-top:12px;padding:8px 16px;background:#333;color:#aaa;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:12px;width:100%';
    devBtn.addEventListener('click', () => { localTestLogin(); location.reload(); });
    document.querySelector('.login-box').appendChild(devBtn);
  }
}

function renderSidebarUser() {
  const user = getUser();
  if (!user) return;

  const el = document.getElementById('sidebar-user');
  const name = esc(user.global_name || user.username);
  const info = getPlayerInfo();
  const avatarUrl = info?.role === 'dev'
    ? discordAvatarUrl(null, null)
    : user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
      : user.id
        ? `https://cdn.discordapp.com/embed/avatars/${(/^\d+$/.test(user.id) ? (BigInt(user.id) >> 22n) % 6n : 0n)}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

  const playerLink = info?.is_dual_role
    ? `<a href="/" class="sidebar-player-link">My Character</a>`
    : '';
  const devBadge = info?.role === 'dev'
    ? `<span class="sidebar-dev-badge" title="Dev mode — character and player names are redacted in the UI">DEV MODE</span>`
    : '';

  el.innerHTML = `<img class="sidebar-avatar" src="${avatarUrl}" alt="">` +
    `<span class="sidebar-username">${name}</span>` +
    `${devBadge}` +
    `${playerLink}` +
    `<button class="sidebar-logout" id="logout-btn">Log out</button>`;

  document.getElementById('logout-btn').addEventListener('click', logout);
}

// ── Domain switching ──

function switchDomain(domain) {
  document.querySelectorAll('.domain').forEach(d => d.classList.remove('active'));
  document.querySelectorAll('.sidebar-btn').forEach(b => b.classList.remove('on'));

  const target = document.getElementById('d-' + domain);
  const btn = document.querySelector(`.sidebar-btn[data-domain="${domain}"]`);
  if (target) target.classList.add('active');
  if (btn) btn.classList.add('on');

  if (domain === 'players') initPlayersView(chars);
  if (domain === 'engine') { /* Engine tab removed — dice, feeding, session tracker were Engine-only tools */ }
  if (domain === 'city') initCityView();
  if (domain === 'spheres') initSpheresView();
  if (domain === 'downtime') {
    // DTUX-1: panel visibility is now driven by the phase ribbon inside
    // initDowntimeView → loadCycleById → showDtuxPhase. No bespoke sub-tab
    // setup needed here.
    initDowntimeView(chars);
  }
  if (domain === 'cycle') initCycleView(chars);
  if (domain === 'npcs') initNpcRegister(chars);
  if (domain === 'attendance') { initNextSession(); initAttendance(chars); }
  if (domain === 'data') initDataPortabilityView(chars);
  if (domain === 'ordeals') initOrdealsAdminView(chars);
  if (domain === 'documents') initPrimerAdmin(document.getElementById('documents-content'));
  if (domain === 'tickets') initTicketsView(document.getElementById('tickets-admin-content'));
  if (domain === 'rules') initRulesView(document.getElementById('rules-content'), chars);
  if (domain === 'rde') initRulesDataView(document.getElementById('rde-content'));
  if (domain === 'equipment-catalogue') initEquipmentCatalogueAdmin(document.getElementById('equipment-catalogue-content'), chars);
  if (domain === 'st-mods-audit') initStModsAudit(document.getElementById('st-mods-audit-content'), chars);
  if (domain === 'devlog') initDevlogAdmin(document.getElementById('devlog-admin-content'));
  if (domain === 'st-mods') {
    // STM-5 (issue #386): panel works on the currently-selected character.
    // editorState.editIdx tracks the open sheet; null/-1 → "select a char"
    // placeholder.
    const idx = editorState.editIdx;
    const c = (idx != null && idx >= 0) ? chars[idx] : null;
    initStModsPanel(
      document.getElementById('st-mods-panel-content'),
      c,
      // Bugfix #405: onMutate previously captured `c` in a closure at
      // sidebar-activation time. In Peter's repro, that closure pathway
      // failed to land the mutation on `chars[editIdx]` (observed:
      // chars[idx]._st_mod_overlay undefined post-POST, populated only
      // after openCharDetail re-fired). Cause was likely a reference-
      // identity gap: chars[idx] reads the LIVE array entry while the
      // closure pinned the value at activation. Reading chars[editIdx]
      // fresh inside the callback closes that gap.
      () => {
        const liveChar = chars[editorState.editIdx];
        if (liveChar) renderSheetWithOverlay(liveChar);
      },
    );
  }
}

document.getElementById('sidebar').addEventListener('click', e => {
  const btn = e.target.closest('.sidebar-btn');
  if (!btn) return;
  switchDomain(btn.dataset.domain);
  // Auto-collapse sidebar on tablet after selecting a domain
  if (window.innerWidth <= 1024) {
    document.getElementById('admin-app').classList.add('sb-collapsed');
  }
});

// ── DTUX-1: DT sub-tab switching retired ──
// Panel visibility now driven by the phase ribbon inside downtime-views.js
// (showDtuxPhase).

// ── Sidebar collapse ──

{
  const SB_KEY = 'tm_sidebar_collapsed';
  const appEl = document.getElementById('admin-app');
  if (localStorage.getItem(SB_KEY) === '1' || (window.innerWidth <= 1024 && localStorage.getItem(SB_KEY) !== '0')) {
    appEl.classList.add('sb-collapsed');
  }
  document.getElementById('sb-close').addEventListener('click', () => {
    appEl.classList.add('sb-collapsed');
    localStorage.setItem(SB_KEY, '1');
  });
  document.getElementById('sb-open').addEventListener('click', () => {
    appEl.classList.remove('sb-collapsed');
    localStorage.setItem(SB_KEY, '0');
  });
  // Click outside sidebar to close on tablet/mobile
  document.getElementById('content')?.addEventListener('click', () => {
    if (window.innerWidth <= 1024 && !appEl.classList.contains('sb-collapsed')) {
      appEl.classList.add('sb-collapsed');
      localStorage.setItem(SB_KEY, '1');
    }
  });
}

// ── Sidebar footer nav ──

function renderSidebarFooter() {
  const nav = document.getElementById('sidebar-footer-nav');
  if (!nav) return;

  const path = location.pathname.replace(/\/+$/, '') || '/';
  const html = [];

  // Single Player button — formerly two ("Game App" → /, "Player" → /player)
  // pointing at what is now effectively the same player-side experience.
  if (path !== '/player') html.push(`<a href="/" class="sb-link-btn">Player</a>`);
  // Storyteller (/admin) is always the current page here; never shown

  html.push(`<button class="sb-link-btn" id="sb-mode-btn"></button>`);
  html.push(`<button class="sb-link-btn" id="sb-profile-btn">Emergency Contact</button>`);

  nav.innerHTML = html.join('');

  const modeBtn = document.getElementById('sb-mode-btn');
  const htmlEl = document.documentElement;
  const updateMode = () => {
    modeBtn.textContent = htmlEl.getAttribute('data-theme') === 'dark' ? '☀ Light Mode' : '☾ Dark Mode';
  };
  updateMode();
  modeBtn.addEventListener('click', () => {
    const dark = htmlEl.getAttribute('data-theme') === 'dark';
    if (dark) { htmlEl.removeAttribute('data-theme'); localStorage.removeItem('tm-theme'); }
    else { htmlEl.setAttribute('data-theme', 'dark'); localStorage.setItem('tm-theme', 'dark'); }
    updateMode();
  });

  document.getElementById('sb-profile-btn').addEventListener('click', openProfileModal);
}

// ── Admin profile modal ──

async function openProfileModal() {
  document.getElementById('profile-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'profile-modal';
  overlay.className = 'plm-overlay';
  document.getElementById('admin-app').appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.innerHTML = '<div class="plm-dialog"><p class="plm-loading">Loading\u2026</p></div>';

  let player;
  try {
    player = await apiGet('/api/players/me');
  } catch (err) {
    overlay.querySelector('.plm-dialog').innerHTML = '<p class="plm-error">Failed to load profile: ' + esc(err.message) + '</p>';
    return;
  }

  const user = getUser();
  const dialog = overlay.querySelector('.plm-dialog');
  dialog.innerHTML = `
    <div class="plm-header">
      <h3>Your Profile</h3>
      <button class="cd-close" id="profile-close">&times;</button>
    </div>
    <div class="prof-readonly">
      <div class="prof-field"><span class="prof-label">Display Name</span><span>${esc(player.display_name || '')}</span></div>
      <div class="prof-field"><span class="prof-label">Discord</span><span>@${esc(player.discord_username || user?.username || '')}</span></div>
    </div>
    <div class="prof-form">
      <div class="prof-field"><label class="prof-label" for="prof-email">Email</label><input id="prof-email" type="email" class="plm-input" value="${esc(player.email || '')}" placeholder="your@email.com"></div>
      <div class="prof-field"><label class="prof-label" for="prof-mobile">Mobile</label><input id="prof-mobile" type="tel" class="plm-input" value="${esc(player.mobile || '')}" placeholder="+61 4xx xxx xxx"></div>
      <div class="prof-field"><label class="prof-label" for="prof-emergency-name">Emergency Contact</label><input id="prof-emergency-name" type="text" class="plm-input" value="${esc(player.emergency_contact_name || '')}" placeholder="Name"></div>
      <div class="prof-field"><label class="prof-label" for="prof-emergency-mobile">Emergency Mobile</label><input id="prof-emergency-mobile" type="tel" class="plm-input" value="${esc(player.emergency_contact_mobile || '')}" placeholder="+61 4xx xxx xxx"></div>
      <div class="prof-field prof-wide"><label class="prof-label" for="prof-medical">Medical Info</label><textarea id="prof-medical" class="plm-input" rows="3" placeholder="Allergies, conditions, medications...">${esc(player.medical_info || '')}</textarea></div>
    </div>
    <p class="prof-privacy">This information is only visible to Storytellers and is used for live game safety.</p>
    <div class="prof-actions">
      <button class="dt-btn" id="profile-save">Save</button>
      <button class="dt-btn" id="profile-cancel">Cancel</button>
      <span id="profile-status" class="plm-loading" style="display:none"></span>
    </div>`;

  document.getElementById('profile-close').addEventListener('click', () => overlay.remove());
  document.getElementById('profile-cancel').addEventListener('click', () => overlay.remove());
  document.getElementById('profile-save').addEventListener('click', async () => {
    const statusEl = document.getElementById('profile-status');
    statusEl.style.display = '';
    statusEl.textContent = 'Saving\u2026';
    try {
      await apiPut('/api/players/me', {
        email: document.getElementById('prof-email').value.trim() || null,
        mobile: document.getElementById('prof-mobile').value.trim() || null,
        medical_info: document.getElementById('prof-medical').value.trim() || null,
        emergency_contact_name: document.getElementById('prof-emergency-name').value.trim() || null,
        emergency_contact_mobile: document.getElementById('prof-emergency-mobile').value.trim() || null,
      });
      statusEl.textContent = 'Saved!';
      setTimeout(() => overlay.remove(), 800);
    } catch (err) {
      statusEl.textContent = 'Failed: ' + err.message;
    }
  });
}

// ── Dev-mode: hide sensitive admin panels ──
if (isRedactMode()) {
  document.querySelector('.sidebar-btn[data-domain="downtime"]')?.remove();
  document.getElementById('d-downtime')?.remove();
}

// ── Audit badges: error + warning icons with counts and hover breakdown ──

function _auditBadges(audit) {
  const errs = audit.errors.length;
  const warns = audit.warnings.length;
  if (!errs && !warns) return '';
  let h = '<div class="cc-audit">';
  if (errs) {
    const tip = audit.errors.map(e => '\u2716 ' + e.message).join('\n');
    h += `<span class="cc-audit-badge cc-audit-err" title="${esc(tip)}">\u2716${errs > 1 ? ' ' + errs : ''}</span>`;
  }
  if (warns) {
    const tip = audit.warnings.map(w => '\u26A0 ' + w.message).join('\n');
    h += `<span class="cc-audit-badge cc-audit-warn" title="${esc(tip)}">\u26A0${warns > 1 ? ' ' + warns : ''}</span>`;
  }
  h += '</div>';
  return h;
}

// ── Character alert checks ──

function charAlerts(c) {
  applyDerivedMerits(c, chars);
  let red = false, yellow = false;

  // XP overspend
  if (xpLeft(c) < 0) red = true;

  // Merit CP overspend (budget: 10)
  const meritCPUsed = (c.merits || []).reduce((s, m) => s + (m.cp || 0), 0)
    + (c.fighting_styles || []).reduce((s, fs) => s + (fs.cp || 0), 0)
    + (c.powers || []).filter(p => p.category === 'pact').reduce((s, p) => s + (p.cp || 0), 0)
    + ((c.bp_creation || {}).cp || 0);
  if (meritCPUsed > 10) red = true;
  // BP game cap (max BP 2 for this chronicle)
  if ((c.blood_potency || 0) > 2) yellow = true;

  // Attribute CP overspend (priority budgets: Primary 5, Secondary 4, Tertiary 3)
  const atPri = c.attribute_priorities || {};
  for (const cat of Object.keys(ATTR_CATS)) {
    const budget = PRI_BUDGETS[atPri[cat] || 'Tertiary'] || 3;
    const used = (ATTR_CATS[cat] || []).reduce((s, a) => s + ((c.attributes?.[a]?.cp) || 0), 0);
    if (used > budget) red = true;
  }

  // Skill CP overspend (priority budgets: Primary 11, Secondary 7, Tertiary 4)
  const skPri = c.skill_priorities || {};
  for (const cat of Object.keys(SKILL_CATS)) {
    const budget = SKILL_PRI_BUDGETS[skPri[cat] || 'Tertiary'] || 4;
    const used = (SKILL_CATS[cat] || []).reduce((s, sk) => s + ((c.skills?.[sk]?.cp) || 0), 0);
    if (used > budget) red = true;
  }

  // Grant pool overspend / unspent
  for (const p of (c._grant_pools || [])) {
    const total = p.amount;
    let used;
    if (p.category === 'any') used = getMCIPoolUsed(c);
    else if (p.category === 'vm') used = vmUsed(c);
    else if (p.category === 'lk') used = lorekeeperUsed(c);
    else if (p.category === 'ohm') used = ohmUsed(c);
    else if (p.category === 'inv') used = investedUsed(c);
    else used = getPoolUsed(c, p.names ? p.names[0] : p.name);
    if (used > total) red = true;
    else if (used < total) yellow = true;
  }
  return { red, yellow };
}

// ── Character grid rendering ──

function renderCharGrid() {
  const grid = document.getElementById('char-grid');
  const count = document.getElementById('char-count');

  // Build set of all character IDs linked to any player
  const linkedCharIds = new Set();
  for (const p of _players) {
    for (const id of (p.character_ids || [])) linkedCharIds.add(String(id));
  }

  // Sync character.player from linked player's display_name
  for (const c of chars) {
    const linked = _players.find(p => (p.character_ids || []).some(id => String(id) === String(c._id)));
    if (linked && linked.display_name && c.player !== linked.display_name) {
      c.player = linked.display_name;
    }
  }

  const sorted = [...chars].sort((a, b) => sortName(a).localeCompare(sortName(b)));
  const active = sorted.filter(c => !c.retired);
  const retired = sorted.filter(c => c.retired);

  function charCard(c) {
    charAlerts(c); // runs applyDerivedMerits so xp/audit work correctly
    const audit = auditCharacter(c);
    const auditBadges = _auditBadges(audit);

    const ordeals = c.ordeals || [];
    const ordDone = ordeals.filter(o => o.complete).length;
    const ordTotal = ordeals.length;
    const ordChip = ordTotal > 0
      ? `<span class="cc-ordeals cc-tag" onclick="event.stopPropagation(); window._openOrdealsModal('${c._id}')" title="Manage ordeals">Ord ${ordDone}/${ordTotal}</span>`
      : '';

    const unlinked = !linkedCharIds.has(String(c._id));
    return `<div class="char-card${c.retired ? ' retired' : ''}${unlinked ? ' unlinked' : ''}" data-id="${c._id}">
      <div class="cc-top">
        <span class="cc-name">${esc(cardName(c))}</span>
        <div class="cc-card-right">${auditBadges}${ordChip}</div>
      </div>
    </div>`;
  }

  let html = active.map(charCard).join('');
  if (retired.length) {
    html += `<div class="retired-divider"><span>Retired</span></div>`;
    html += retired.map(charCard).join('');
  }
  grid.innerHTML = html;

  count.textContent = active.length + ' active' + (retired.length ? ', ' + retired.length + ' retired' : '');

  grid.addEventListener('click', e => {
    const card = e.target.closest('.char-card');
    if (!card) return;
    const id = card.dataset.id;
    const c = chars.find(ch => ch._id === id);
    if (c) openCharDetail(c);
  });
}

// ── Character detail panel ──

function openCharDetail(c) {
  selectedChar = c;
  editorState.chars = chars;
  editorState.editIdx = chars.indexOf(c);
  editorState.editMode = false;
  editorState.dirty.clear();
  localStorage.setItem('tm_active_char', String(c._id));

  const panel = document.getElementById('char-detail');

  panel.innerHTML = `
    <div class="cd-header">
      <h3 class="cd-name">${esc(cardName(c))}</h3>
      <span class="cd-player">${esc(redactPlayer(c.player || ''))}</span>
      <div class="cd-header-actions">
        <span class="cd-dirty-badge" id="cd-dirty-badge" style="display:none">Unsaved</span>
        <button class="dt-btn" id="cd-emergency">Emergency</button>
        <button class="dt-btn" id="cd-edit-toggle">Edit</button>
        <button class="dt-btn" id="cd-print">PDF</button>
        <button class="dt-btn" id="cd-export-json">JSON</button>
        <button class="dt-btn" id="cd-save-api" style="display:none">Save to DB</button>
        <a class="dt-btn cd-player-view" href="/" id="cd-player-view">Player View</a>
        <button class="dt-btn" id="cd-archive">Archive</button>
        <button class="dt-btn" id="cd-link-player">Link Player</button>
        <button class="dt-btn retire-btn" id="cd-retire">${c.retired ? 'Unretire' : 'Retire'}</button>
        <button class="dt-btn cd-hard-delete-btn" id="cd-hard-delete">Hard-Delete</button>
        <button class="cd-close" id="cd-close">&times;</button>
      </div>
    </div>
    <div id="sh-content" class="cd-sheet"></div>`;

  panel.style.display = '';
  renderSheetWithOverlay(c);

  document.getElementById('cd-close').addEventListener('click', closeCharDetail);
  document.getElementById('cd-emergency').addEventListener('click', () => showEmergencyContact(c));
  document.getElementById('cd-print').addEventListener('click', () => printPDF());
  document.getElementById('cd-export-json').addEventListener('click', () => exportJSON());
  document.getElementById('cd-edit-toggle').addEventListener('click', async () => {
    editorState.editMode = !editorState.editMode;
    const btn = document.getElementById('cd-edit-toggle');
    const saveBtn = document.getElementById('cd-save-api');
    btn.textContent = editorState.editMode ? 'View' : 'Edit';
    saveBtn.style.display = editorState.editMode ? '' : 'none';

    // When entering edit mode, fetch fresh data from the server so that one
    // ST's session cannot silently overwrite another's recent saves with a
    // stale in-memory copy loaded at page open.
    if (editorState.editMode) {
      const idx = editorState.editIdx;
      const c = chars[idx];
      if (c && c._id) {
        try {
          const fresh = await apiGet('/api/characters/' + c._id);
          sanitiseChar(fresh);
          // Merge server data over cached object; _-prefixed ephemeral props
          // (e.g. _gameXP) are not on `fresh` so they survive. Note: regent-
          // territory derivation is no longer cached on the character — the
          // City Status calc recomputes from setStatusTerritories per render
          // (issue #13 Surface 2 fix).
          Object.assign(chars[idx], fresh);
          selectedChar = chars[idx];
        } catch { /* keep cached data if fetch fails — don't block editing */ }
      }
    }

    renderSheetWithOverlay(chars[editorState.editIdx]);
  });
  document.getElementById('cd-save-api').addEventListener('click', saveCharToApi);
  document.getElementById('cd-retire').addEventListener('click', toggleRetire);
  document.getElementById('cd-hard-delete').addEventListener('click', () => openHardDeleteModal(c));
  document.getElementById('cd-link-player').addEventListener('click', () => openPlayerLinkModal(c));
  document.getElementById('cd-archive').addEventListener('click', () => {
    initAdminArchive(document.getElementById('sh-content'), c);
  });

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function toggleRetire() {
  const idx = editorState.editIdx;
  const c = chars[idx];
  if (!c || !c._id) return;

  const newState = !c.retired;
  const action = newState ? 'retire' : 'unretire';
  if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} ${cardName(c)}?`)) return;

  const btn = document.getElementById('cd-retire');
  btn.textContent = 'Saving...';

  try {
    const updated = await apiPut('/api/characters/' + _id, { retired: newState });
    c.retired = newState;
    Object.assign(chars[idx], updated);
    btn.textContent = newState ? 'Unretire' : 'Retire';
    renderCharGrid();
  } catch (err) {
    btn.textContent = newState ? 'Retire' : 'Unretire';
    console.error('Retire failed:', err.message);
    alert('Retire failed: ' + err.message);
  }
}

async function showEmergencyContact(c) {
  let name = '', mobile = '', medical = '';
  try {
    const players = await apiGet('/api/players');
    const p = players.find(pl => pl.display_name === c.player || pl.character_ids?.some(id => String(id) === String(c._id)));
    if (p) {
      name    = p.emergency_contact_name   || '';
      mobile  = p.emergency_contact_mobile || '';
      medical = p.medical_info             || '';
    }
  } catch { /* show empty rather than error */ }

  const existing = document.getElementById('ec-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'ec-modal';
  modal.className = 'ec-modal-overlay';
  modal.innerHTML = `<div class="ec-modal-box panel">
    <div class="panel-label">Emergency Contact — ${esc(cardName(c))}</div>
    <div class="ec-modal-body">
      ${name   ? `<div class="ec-row"><span class="ec-lbl">Contact</span><span class="ec-val">${esc(name)}</span></div>` : ''}
      ${mobile ? `<div class="ec-row"><span class="ec-lbl">Mobile</span><span class="ec-val"><a href="tel:${esc(mobile)}">${esc(mobile)}</a></span></div>` : ''}
      ${medical ? `<div class="ec-row"><span class="ec-lbl">Medical</span><span class="ec-val">${esc(medical)}</span></div>` : ''}
      ${!name && !mobile && !medical ? '<p class="ec-empty">No emergency contact recorded for this player.</p>' : ''}
    </div>
    <button class="btn-sm ec-close-btn" id="ec-close">Close</button>
  </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  document.getElementById('ec-close').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });
}

async function openHardDeleteModal(c) {
  document.getElementById('hd-modal')?.remove();

  const charName = cardName(c);
  const overlay = document.createElement('div');
  overlay.id = 'hd-modal';
  overlay.className = 'hd-overlay';
  overlay.innerHTML = `
    <div class="hd-modal">
      <div class="hd-title">Hard-Delete Character</div>
      <div class="hd-body">
        <div>Permanently remove <strong>${esc(charName)}</strong> and all associated data. This cannot be undone.</div>
        <div class="hd-cascade-info" id="hd-cascade">Loading cascade preview…</div>
        <div>
          <label class="hd-label" for="hd-confirm-input">Type <em>${esc(charName)}</em> to confirm</label>
          <input id="hd-confirm-input" class="hd-confirm-input" type="text" autocomplete="off" placeholder="${esc(charName)}">
        </div>
        <div class="hd-error" id="hd-error"></div>
      </div>
      <div class="hd-footer">
        <button class="hd-btn-cancel" id="hd-cancel">Cancel</button>
        <button class="hd-btn-delete" id="hd-delete" disabled>Delete permanently</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  try {
    const preview = await apiGet('/api/characters/' + c._id + '/cascade-preview');
    const parts = [];
    if (preview.submissions)      parts.push(`${preview.submissions} downtime submission${preview.submissions !== 1 ? 's' : ''}`);
    if (preview.sessionsAffected) parts.push(`${preview.sessionsAffected} game session${preview.sessionsAffected !== 1 ? 's' : ''} affected`);
    if (preview.players)          parts.push(`${preview.players} player link${preview.players !== 1 ? 's' : ''}`);
    document.getElementById('hd-cascade').textContent = parts.length
      ? `Will also delete: ${parts.join(', ')}.`
      : 'No linked submissions or session data found.';
  } catch {
    document.getElementById('hd-cascade').textContent = 'Cascade preview unavailable; proceed with caution.';
  }

  const input     = document.getElementById('hd-confirm-input');
  const deleteBtn = document.getElementById('hd-delete');
  input.addEventListener('input', () => { deleteBtn.disabled = input.value !== charName; });

  const close = () => overlay.remove();
  document.getElementById('hd-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

  deleteBtn.addEventListener('click', async () => {
    if (input.value !== charName) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    document.getElementById('hd-error').textContent = '';
    try {
      await apiDelete('/api/characters/' + c._id);
      const idx = chars.findIndex(ch => String(ch._id) === String(c._id));
      if (idx !== -1) chars.splice(idx, 1);
      selectedChar = null;
      editorState.editMode = false;
      editorState.dirty.clear();
      document.getElementById('char-detail').style.display = 'none';
      renderCharGrid();
      close();
    } catch (err) {
      document.getElementById('hd-error').textContent = err.message || 'Delete failed.';
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete permanently';
    }
  });
}

function closeCharDetail() {
  if (editorState.dirty.size > 0) {
    if (!confirm('You have unsaved changes. Close anyway?')) return;
  }
  selectedChar = null;
  editorState.editMode = false;
  editorState.dirty.clear();
  document.getElementById('char-detail').style.display = 'none';
}

async function createNewCharacter() {
  // Replace browser prompt() with parchment modal
  const name = await new Promise(resolve => {
    document.getElementById('new-char-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'new-char-modal';
    overlay.className = 'plm-overlay';
    document.getElementById('admin-app').appendChild(overlay);
    overlay.innerHTML = `
      <div class="plm-dialog" style="max-width:400px">
        <div class="plm-header">
          <h3>New Character</h3>
          <button class="cd-close" id="ncm-close">&times;</button>
        </div>
        <div style="padding:16px 20px 20px">
          <label class="plm-label" for="ncm-name">Character Name</label>
          <input id="ncm-name" class="plm-input" type="text" placeholder="Enter name\u2026" autocomplete="off" style="width:100%;margin-top:6px">
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="dt-btn" id="ncm-confirm">Create</button>
            <button class="dt-btn" id="ncm-cancel">Cancel</button>
          </div>
        </div>
      </div>`;
    const close = val => { overlay.remove(); resolve(val); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    overlay.querySelector('#ncm-close').addEventListener('click', () => close(null));
    overlay.querySelector('#ncm-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('#ncm-confirm').addEventListener('click', () => {
      const val = overlay.querySelector('#ncm-name').value.trim();
      if (val) close(val);
    });
    overlay.querySelector('#ncm-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') { const val = overlay.querySelector('#ncm-name').value.trim(); if (val) close(val); }
      if (e.key === 'Escape') close(null);
    });
    setTimeout(() => overlay.querySelector('#ncm-name').focus(), 50);
  });
  if (!name) return;

  const blank = {
    name: name.trim(),
    player: '',
    honorific: null,
    moniker: null,
    concept: '',
    pronouns: '',
    clan: '',
    bloodline: null,
    covenant: '',
    humanity: 7,
    humanity_base: 7,
    blood_potency: 1,
    bp_creation: { cp: 0, xp: 0, lost: 0 },
    status: { city: 0, clan: 0, covenant: { 'Carthian Movement': 0, 'Circle of the Crone': 0, 'Invictus': 0, 'Lancea et Sanctum': 0, 'Ordo Dracul': 0 } },
    attribute_priorities: {},
    skill_priorities: {},
    attributes: Object.fromEntries(
      ['Intelligence','Wits','Resolve','Strength','Dexterity','Stamina','Presence','Manipulation','Composure']
        .map(a => [a, { dots: 1, bonus: 0, cp: 0, xp: 0, free: 0, rule_key: null }])
    ),
    skills: Object.fromEntries(
      ['Academics','Computer','Crafts','Investigation','Medicine','Occult','Politics','Science',
       'Athletics','Brawl','Drive','Firearms','Larceny','Stealth','Survival','Weaponry',
       'Animal Ken','Empathy','Expression','Intimidation','Persuasion','Socialise','Streetwise','Subterfuge']
        .map(s => [s, { dots: 0, bonus: 0, specs: [], nine_again: false, cp: 0, xp: 0, free: 0, rule_key: null }])
    ),
    disciplines: {},
    merits: [],
    powers: [],
    banes: [],
    ordeals: [],
    touchstones: [],
    fighting_styles: [],
    fighting_picks: [],
    willpower: {},
    mask: null,
    dirge: null,
    features: '',
    retired: false,
  };

  try {
    const created = await apiPost('/api/characters', blank);
    chars.push(created);
    renderCharGrid();
    editorState.editMode = true;
    openCharDetail(created);
  } catch (err) {
    alert('Failed to create character: ' + err.message);
  }
}

// Legacy parallel-array fields superseded by inline cp/xp on each object (v3 schema)
const _LEGACY_FIELDS = new Set(['attr_creation', 'skill_creation', 'disc_creation', 'merit_creation']);
// #837: xp_total / xp_spent removed from schema — derived at render time.
// Strip on save so old in-memory documents that still carry them don't fail
// schema validation on PUT.
const _DEPRECATED_FIELDS = new Set(['xp_total', 'xp_spent', 'xp_left']);

function buildSaveBody(c) {
  // Strip _id (goes in URL), all ephemeral _-prefixed runtime fields, legacy v2 fields,
  // deprecated derived fields (#837 — xp_total/xp_spent/xp_left), c.current (tracker-state
  // namespace), and c.derived (render-time materialised cache from ADR-006; never stored).
  const body = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === '_id' || k.startsWith('_') || k === 'current' || k === 'derived' || k === 'assets'
        || _LEGACY_FIELDS.has(k) || _DEPRECATED_FIELDS.has(k)) continue;
    body[k] = v;
  }
  // N-1 (ADR-005 Rev 2, Concern #3): merit-level `_`-prefixed fields
  // (e.g. `_collective_shared_with` from Collective Compound synthesis,
  // `_partner_dots` from the server-side enrichment) MUST NOT round-trip
  // back through PUT. The render-time field is rebuilt on every read; if it
  // ever persists, a stale list could survive a roster change. Shallow-clone
  // the merits array and drop `_`-prefixed keys per merit.
  if (Array.isArray(body.merits)) {
    body.merits = body.merits.map(m => {
      const cleaned = {};
      for (const [k, v] of Object.entries(m)) {
        if (k.startsWith('_')) continue;
        cleaned[k] = v;
      }
      return cleaned;
    });
  }
  return body;
}

async function saveCharToApi() {
  const idx = editorState.editIdx;
  const c = chars[idx];
  if (!c || !c._id) return;

  const saveBtn = document.getElementById('cd-save-api');
  saveBtn.textContent = 'Saving...';

  try {
    const _id = c._id;
    const updated = await apiPut('/api/characters/' + _id, buildSaveBody(c));
    Object.assign(chars[idx], updated);
    selectedChar = chars[idx];
    editorState.dirty.clear();

    const badge = document.getElementById('cd-dirty-badge');
    if (badge) badge.style.display = 'none';
    saveBtn.textContent = 'Saved \u2713';
    setTimeout(() => { saveBtn.textContent = 'Save to DB'; }, 2000);

    renderCharGrid();

    // Cascade-save any partner characters dirtied by domain sharing edits
    const partnerIds = [...getDirtyPartners()].filter(id => String(id) !== String(_id));
    clearDirtyPartners();
    if (partnerIds.length) {
      await Promise.all(partnerIds.map(pid => {
        const pc = chars.find(ch => String(ch._id) === String(pid));
        if (!pc) return Promise.resolve();
        return apiPut('/api/characters/' + pid, buildSaveBody(pc))
          .then(upd => { Object.assign(pc, upd); })
          .catch(err => console.warn('Partner save failed for', pid, err));
      }));
    }
  } catch (err) {
    saveBtn.textContent = 'Error';
    console.error('Save failed:', err.message);
    setTimeout(() => { saveBtn.textContent = 'Save to DB'; }, 2000);
  }
}

// ── Init ──

// loadGameXP imported from data/game-xp.js (shared with player portal)

// ── Player link modal ──

async function openPlayerLinkModal(c) {
  document.getElementById('player-link-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'player-link-modal';
  overlay.className = 'plm-overlay';
  overlay.innerHTML = '<div class="plm-dialog"><p class="plm-loading">Loading\u2026</p></div>';
  document.getElementById('admin-app').appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  await _renderPlmContent(c);
}

async function _renderPlmContent(c) {
  const overlay = document.getElementById('player-link-modal');
  if (!overlay) return;
  const dialog = overlay.querySelector('.plm-dialog');

  let players;
  try {
    players = await apiGet('/api/players');
  } catch (err) {
    dialog.innerHTML = `<div class="plm-header"><h3>Link Player</h3><button class="cd-close" onclick="document.getElementById('player-link-modal').remove()">&times;</button></div><p class="plm-error">Failed to load players: ${esc(err.message)}</p>`;
    return;
  }

  const charId = String(c._id);
  const charName = cardName(c);
  const linked = players.find(p => (p.character_ids || []).some(id => String(id) === charId));

  const rows = players.map(p => {
    const isLinked = linked && String(p._id) === String(linked._id);
    const pid = esc(String(p._id));
    return `<tr class="${isLinked ? 'plm-row-linked' : ''}">
      <td>${esc(p.display_name || '\u2014')}</td>
      <td class="plm-did">${esc(p.discord_id || '\u2014')}</td>
      <td class="plm-role">${esc(p.role)}</td>
      <td>${isLinked ? '<span class="plm-badge">Linked</span>' : ''}</td>
      <td>${isLinked
        ? `<button class="dt-btn plm-unlink-btn" onclick="window._plmUnlink('${pid}','${esc(charId)}')">Unlink</button>`
        : `<button class="dt-btn" onclick="window._plmLink('${pid}','${esc(charId)}')">Link</button>`
      }</td>
    </tr>`;
  }).join('');

  dialog.innerHTML = `
    <div class="plm-header">
      <h3>Link \u201c${esc(charName)}\u201d to Player</h3>
      <button class="cd-close" onclick="document.getElementById('player-link-modal').remove()">&times;</button>
    </div>
    ${players.length
      ? `<div class="plm-list"><table class="plm-table">
          <thead><tr><th>Display name</th><th>Discord ID</th><th>Role</th><th></th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : '<p class="plm-empty">No player records yet.</p>'}
    <div class="plm-create">
      <h4>New player record</h4>
      <div class="plm-form">
        <label class="plm-label">Discord ID<input id="plm-did" class="plm-input" placeholder="numeric Discord user ID" type="text"></label>
        <label class="plm-label">Display name<input id="plm-dname" class="plm-input" placeholder="Display name" type="text"></label>
        <label class="plm-label">Role<select id="plm-drole" class="plm-select"><option value="player">Player</option><option value="st">ST</option></select></label>
        <button class="dt-btn" onclick="window._plmCreate('${esc(charId)}')">Create &amp; Link</button>
      </div>
      <p id="plm-err" class="plm-error" style="display:none"></p>
    </div>`;
}

window._plmLink = async (playerId, charId) => {
  try {
    const player = await apiGet('/api/players/' + playerId);
    const ids = [...new Set([...(player.character_ids || []).map(String), charId])];
    await apiPut('/api/players/' + playerId, { character_ids: ids });
    const c = chars.find(ch => String(ch._id) === charId);
    if (c) await _renderPlmContent(c);
  } catch (err) { console.error('Link failed:', err.message); }
};

window._plmUnlink = async (playerId, charId) => {
  try {
    const player = await apiGet('/api/players/' + playerId);
    const ids = (player.character_ids || []).map(String).filter(id => id !== charId);
    await apiPut('/api/players/' + playerId, { character_ids: ids });
    const c = chars.find(ch => String(ch._id) === charId);
    if (c) await _renderPlmContent(c);
  } catch (err) { console.error('Unlink failed:', err.message); }
};

window._plmCreate = async (charId) => {
  const did = document.getElementById('plm-did')?.value.trim();
  const dname = document.getElementById('plm-dname')?.value.trim();
  const drole = document.getElementById('plm-drole')?.value;
  const errEl = document.getElementById('plm-err');
  if (errEl) errEl.style.display = 'none';

  if (!did) {
    if (errEl) { errEl.textContent = 'Discord ID is required.'; errEl.style.display = ''; }
    return;
  }
  try {
    await apiPost('/api/players', {
      discord_id: did,
      display_name: dname || '',
      role: drole || 'player',
      character_ids: [charId],
    });
    const c = chars.find(ch => String(ch._id) === charId);
    if (c) await _renderPlmContent(c);
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.style.display = ''; }
  }
};

// ── Ordeals modal (ST tooling from char card) ──

const ORDEAL_TYPES = ['questionnaire', 'rules', 'lore', 'history', 'covenant'];
const ORDEAL_LABELS = {
  questionnaire: 'Questionnaire',
  rules: 'Rules',
  lore: 'Lore',
  history: 'History',
  covenant: 'Covenant',
};

function openOrdealsModal(c) {
  document.getElementById('ordeals-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'ordeals-modal';
  overlay.className = 'plm-overlay om-overlay';
  overlay.dataset.charId = String(c._id);
  document.getElementById('admin-app').appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  _renderOrdealsModal(c);
}

function _renderOrdealsModal(c) {
  const overlay = document.getElementById('ordeals-modal');
  if (!overlay) return;
  const ordeals = c.ordeals || [];
  const done = ordeals.filter(o => o.complete).length;

  // Lookup map of existing ordeal entries by their normalised key
  const existingByKey = {};
  ordeals.forEach((o, i) => {
    const k = (o.name || '').toLowerCase();
    if (ORDEAL_TYPES.includes(k)) existingByKey[k] = i;
  });

  // Build a fixed row for each ordeal type — present or not
  const rows = ORDEAL_TYPES.map(key => {
    const idx = existingByKey[key];
    const o = idx !== undefined ? ordeals[idx] : null;
    const present = o !== null;
    const complete = present && !!o.complete;
    return `<tr class="om-row${present ? '' : ' om-row-absent'}">
      <td class="om-check">
        <input type="checkbox" ${complete ? 'checked' : ''} onclick="window._omToggleType('${esc(String(c._id))}','${key}',this.checked)" />
      </td>
      <td class="om-name">${ORDEAL_LABELS[key]}</td>
      <td class="om-xp">${complete ? '3 XP' : '\u2014'}</td>
    </tr>`;
  }).join('');

  overlay.innerHTML = `<div class="plm-dialog om-dialog">
    <div class="plm-header om-header">
      <h3>Ordeals \u2014 ${esc(cardName(c))}</h3>
      <button class="cd-close" onclick="document.getElementById('ordeals-modal').remove()">&times;</button>
    </div>
    <p class="om-summary">${done} of ${ORDEAL_TYPES.length} complete \u2014 ${done * 3} XP awarded</p>
    <div class="om-table-wrap"><table class="plm-table om-table">
      <thead><tr><th style="width:50px">Done</th><th>Ordeal</th><th style="width:70px">XP</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p id="om-err" class="plm-error" style="display:none"></p>
  </div>`;
}

async function _omSave(c) {
  const idx = chars.indexOf(c);
  if (idx < 0 || !c._id) return;
  // Recompute xp_log.earned.ordeals for consistency with sheet editor path
  if (!c.xp_log) c.xp_log = { earned: {}, spent: {} };
  if (!c.xp_log.earned) c.xp_log.earned = {};
  c.xp_log.earned.ordeals = (c.ordeals || []).reduce((s, o) => s + (o.xp || 0), 0);
  try {
    const { _id } = c;
    const updated = await apiPut('/api/characters/' + _id, buildSaveBody(c));
    Object.assign(chars[idx], updated);
    renderCharGrid();
  } catch (err) {
    const errEl = document.getElementById('om-err');
    if (errEl) { errEl.textContent = 'Save failed: ' + err.message; errEl.style.display = ''; }
  }
}

window._omToggleType = async (charId, key, checked) => {
  const c = chars.find(ch => String(ch._id) === String(charId));
  if (!c) return;
  if (!c.ordeals) c.ordeals = [];

  // Find existing entry for this ordeal type (case-insensitive)
  const idx = c.ordeals.findIndex(o => (o.name || '').toLowerCase() === key);

  if (checked) {
    // Mark complete — create entry if missing
    if (idx >= 0) {
      c.ordeals[idx].complete = true;
      c.ordeals[idx].xp = 3;
      if (!c.ordeals[idx].approved_at) c.ordeals[idx].approved_at = new Date().toISOString();
    } else {
      c.ordeals.push({ name: key, complete: true, xp: 3, approved_at: new Date().toISOString() });
    }
  } else {
    // Unticked — remove the entry entirely
    if (idx >= 0) c.ordeals.splice(idx, 1);
  }

  await _omSave(c);
  _renderOrdealsModal(c);
};

window._openOrdealsModal = (charId) => {
  const c = chars.find(ch => String(ch._id) === String(charId));
  if (c) openOrdealsModal(c);
};

async function init() {
  // Load rules data (purchasable powers) — non-blocking, cached.
  // After load completes, refresh the rite name dropdown if the editor is open.
  loadRulesFromApi().then(() => {
    // If a character is open in edit mode, re-render to replace the fallback rite input
    // with the proper dropdown now that rules are available.
    if (editorState.editIdx >= 0 && editorState.editMode) {
      renderSheetWithOverlay(chars[editorState.editIdx]);
    }
  }).catch(() => {});
  // MUST await — applyDerivedMerits below (via charAlerts in renderCharGrid)
  // calls getRulesBySource synchronously. Cache miss → engine bonuses skipped
  // → m.rating gets re-synced to (cp + xp), wiping the saved bonus on display.
  // Issue #249 (HOTFIX 2026-05-09): silent catch removed. Downstream
  // applyDerivedMerits guard now prevents Contacts-spheres data loss
  // from a null cache; explicit error surfaces the degraded state.
  try {
    await preloadRules();
  } catch (err) {
    console.error('[admin] preloadRules failed — derivations skipped until rules cache loads (issue #249):', err);
    const banner = document.getElementById('app-status-banner');
    if (banner) {
      banner.textContent = 'Rules data failed to load — some derived merit values may be unavailable. Reload the page or check your connection.';
      banner.classList.add('app-status-banner--error');
      banner.style.display = '';
    }
  }

  // ECM-5 (issue #872): warm the equipment catalogue cache once at boot so
  // the editor's equipment-bucket dropdown renders synchronously when the
  // user opens edit mode. Same non-fatal-on-failure pattern as preloadRules
  // — the dropdown degrades to an empty option list and a console warning
  // surfaces the degraded state.
  try {
    await loadEquipmentCatalogue();
  } catch (err) {
    console.error('[admin] loadEquipmentCatalogue failed — equipment dropdown will be empty until cache loads:', err);
  }

  try {
    chars = await apiGet('/api/characters');
    chars.forEach(sanitiseChar);
    await loadGameXP(chars);
    try { _players = await apiGet('/api/players'); } catch { _players = []; }
    // Derive regent status from territories (single source of truth).
    // Per issue #13 Surface 2 (audit 2026-05-05), the City Status calc
    // recomputes the regent ambience bonus from territories every render
    // via getRegentTerritoryFor; setStatusTerritories keeps the accessors
    // module-level store in sync with the live load.
    try {
      const terrs = await apiGet('/api/territories');
      setStatusTerritories(terrs);
    } catch { /* territories not available — regent display will be blank */ }
    // STM-8 (issue #415, ADR-004 Rev 3 §D8 — issue #413 admin parity):
    // boot-time overlay for the admin chars array. STM-7 wired this for
    // the suite app (app.js); admin.js was left out because at that point
    // the per-sheet renderSheetWithOverlay covered the only read site.
    // STM-8's DT resolution snapshot reads chars[i]._st_mod_overlay at
    // resolve time — without boot-time overlay here, the snapshot would
    // capture empty mods unless the ST happened to open the character
    // sheet first. Apply overlay once at admin boot so the invariant
    // holds across all admin views, mirroring app.js's pattern.
    await loadGlobalSettings();
    const globalEnabled = getGlobalSettings()?.st_mods_enabled !== false;
    // Issue #879 (ADR-006 D4): materialise armour-adjusted defence on every
    // char BEFORE applyOverlayToAll, so any 'derived.defence' STM mod
    // composes additively on top of the real mechanical base instead of
    // the pre-ADR-006 default-zero base.
    for (const c of chars) materialiseDerivedDefence(c);
    await applyOverlayToAll(chars, globalEnabled);

    renderCharGrid();
  } catch (err) {
    console.error('Failed to load characters:', err.message);
    document.getElementById('char-grid').innerHTML =
      `<p class="placeholder">Error: could not load characters from API. Check server status and try refreshing.</p>`;
  }
}

// ── Window registrations (needed by inline onclick in rendered sheet HTML) ──

Object.defineProperty(window, 'chars', { get: () => chars });
Object.defineProperty(window, 'editIdx', { get: () => editorState.editIdx });
Object.assign(window, {
  toggleExp, toggleDisc, renderSheet, editFromSheet: () => {
    editorState.editMode = true;
    document.getElementById('cd-edit-toggle').textContent = 'View';
    document.getElementById('cd-save-api').style.display = '';
    renderSheetWithOverlay(chars[editorState.editIdx]);
  },
  createNewCharacter, openPlayerLinkModal,
  downloadCSV: async () => {
    let fresh;
    try {
      fresh = await apiGet('/api/characters');
      fresh.forEach(sanitiseChar);
      await loadGameXP(fresh);
      try {
        const terrs = await apiGet('/api/territories');
        setStatusTerritories(terrs);
      } catch { /* territories unavailable — city status exports without regent ambience bonus */ }
    } catch (err) {
      alert('Export failed: could not fetch character data from API.\n\n' + err.message);
      return;
    }
    downloadCSV(fresh);
  },
  markDirty, printSheet,
  shEdit, shEditStatus,
  shEditBaneName, shEditBaneEffect, shRemoveBane, shAddBane,
  shTouchstoneStartAdd, shTouchstoneStartEdit, shTouchstonePickerClose, shTouchstonePickerDraft,
  shTouchstoneSaveAdd, shTouchstoneSaveEdit, shTouchstoneRemove,
  shEditBPCreation, shEditBPXP, shEditBPLost, shEditHumanityXP, shEditHumanityLost, shStatusUp, shStatusDown, shCovStandingUp, shCovStandingDown,
  shToggleOrdeal, shSetPriority, shSetClanAttr, shEditAttrPt,
  shSetSkillPriority, shEditSkillPt,
  shEditSpec, shRemoveSpec, shAddSpec,
  shEditDiscPt, shShowDevSelect, shAddDevotion, shRemoveDevotion,
  shEditInflMerit, shEditContactSphere, shRemoveInflMerit, shAddInflMerit, shAddVMAllies, shAddLKMerit,
  shEditDomMerit, shRemoveDomMerit, shAddDomMerit,
  shAllocateCompoundVirtual,
  shSwearOath,
  shReleaseOath,
  shSetPledgeDots,
  shCommitOath,
  shExitOath,
  shRestoreOathDots,
  shAddDomainPartner, shRemoveDomainPartner,
  shEditGenMerit, shRemoveGenMerit, shAddGenMerit,
  shEditStandMerit, shEditStandAssetSkill,
  shToggleMCI, shTogglePT, shEditMCIDot, shEditMCITierGrant, shEditMCITierQual, shRemoveStandMerit, shAddStandMCI, shAddStandPT,
  shAddStyle, shRemoveStyle, shEditStyle, shAddPick, shRemovePick,
  shAddRite, shRemoveRite, shToggleRiteFree, shRefreshRiteDropdown,
  shAddPact, shRemovePact, shEditPact,
  shEditMeritPt, shStepMeritRating, shEditXP, shAdjMeritBonus,
  shSetWhiteAntsTerritory,
  shSetTrapDoorAnchor,
  shAddEquip, shRemoveEquip, shEquipBucketFilter,
  clickAttrDot, clickSkillDot, toggleNineAgain, updSkillSpec,
  updField, updStatus,
  renderIdentityTab, renderAttrsTab,
});

boot();
