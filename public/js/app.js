/**
 * app.js — Unified entry point for the merged SPA.
 *
 * Replaces both js/main.js (editor) and js/suite/main.js (suite),
 * providing a single init, unified tab navigation, and merged
 * window registration for all inline onclick/onchange handlers.
 */

// ══════════════════════════════════════════════
//  EDITOR IMPORTS
// ══════════════════════════════════════════════

import editorState from './data/state.js';
import { ICONS } from './data/icons.js';
import { isFeedingOpen } from './downtime/db.js';
// 2026-08-29 (Angelus): FORM_RETIRED/ORDEALS_RETIRED imports removed, since
// the Downtime and Ordeals nav tiles/tabs are fully gone now, not dimmed, so
// nothing in this file reads the retirement flags any more.
// downtime/form-retirement.js and ordeals/ordeal-retirement.js stay on disk
// unrouted (server/routes/downtime.js, questionnaire.js, history.js and
// ordeal-responses.js's own POST guards still import them directly).
import { CLAN_ICON_KEY, covIcon, displayName, dropdownName, sortName, redactPlayer, discordAvatarUrl, esc, singleScrollEnabled } from './data/helpers.js';
import { renderList, filterList, setListLimit } from './editor/list.js';
import { renderSheet as editorRenderSheet, toggleExp as editorToggleExp, toggleDisc as editorToggleDisc } from './editor/sheet.js';
import { loadDB, saveDB, saveAll, syncToSuite, downloadCSV, registerCallbacks as registerExportCallbacks } from './editor/export.js';
import {
  editFromSheet, shEdit, shEditStatus,
  shEditBaneName, shEditBaneEffect, shRemoveBane, shAddBane,
  // Issue #162 (2026-05-08): shEnsureTouchstoneData / shTouchstonePickerToggleCharacter
  // / shTouchstonePickerSetMode dropped alongside the suppressed NPC picker UI.
  shTouchstoneStartAdd, shTouchstoneStartEdit, shTouchstonePickerClose, shTouchstonePickerDraft,
  shTouchstoneSaveAdd, shTouchstoneSaveEdit, shTouchstoneRemove,
  shEditBP, shEditBPCreation, shEditBPXP, shEditBPLost, shEditHumanity, shEditHumanityXP, shEditHumanityLost,
  shStatusUp, shStatusDown,
  shToggleOrdeal, shSetPriority, shSetClanAttr, shEditAttrPt,
  shSetSkillPriority, shEditSkillPt,
  shEditSpec, shRemoveSpec, shAddSpec,
  shEditDiscPt, shShowDevSelect, shAddDevotion, shRemoveDevotion,
  shEditInflMerit, shEditContactSphere, shRemoveInflMerit, shAddInflMerit,
  shEditDomMerit, shRemoveDomMerit, shAddDomMerit,
  shAddDomainPartner, shRemoveDomainPartner,
  shEditGenMerit, shRemoveGenMerit, shAddGenMerit,
  shEditStandMerit, shEditStandAssetSkill,
  shToggleMCI, shTogglePT, shEditMCIDot, shRemoveStandMerit, shAddStandMCI, shAddStandPT,
  shSetWhiteAntsTerritory,
  shSetTrapDoorAnchor,
  shEditMeritPt, shStepMeritRating, shEditXP,
  shAddEquip, shRemoveEquip, shEquipBucketFilter,
  registerCallbacks as registerEditCallbacks
} from './editor/edit.js';
import { renderIdentityTab, updField, updStatus, registerCallbacks as registerIdentityCallbacks } from './editor/identity.js';
import {
  renderAttrsTab, clickAttrDot,
  clickSkillDot, toggleNineAgain, updSkillSpec,
  registerCallbacks as registerAttrsCallbacks
} from './editor/attrs-tab.js';
import { devotions, rites, setStatusTerritories } from './data/accessors.js';
import { renderCharPools, roteEligibleFor } from './game/char-pools.js';
import { renderMapStageHtml } from './components/map-overlay.js';
import { openContestedRoll, closeContestedRoll, crSetType, crSetChar, crAdjPool, crRoll } from './game/contested-roll.js';
// crd.2: the blocking incoming-challenge modal that used to poll here is gone
// (module deleted, not left dead in the tree). Its replacement is a calm,
// always-present player queue with its own honest routing contract into the
// resolution screen crd.3b will build.
import { initPendingQueue, refreshPendingQueueBadge, hasPendingChallenges } from './game/pending-queue.js';
import { initContestedResolve } from './game/contested-resolve.js';
import { openChallengeModal } from './game/challenge-initiation.js';
import { submitHumanityCheck, checkForResolvedHumanityCheck } from './game/humanity-check.js';
import { loadDtLookup } from './game/dt-lookup.js';
import { initTracker, trackerReset, trackerAdj, trackerAddCondition, trackerRemoveCond, trackerToggle, ensureLoaded as ensureTrackerLoaded, refreshTrackerCard } from './game/tracker.js';
import { initWS } from './data/ws.js';
// ECM-4 (#871): shared catalogue cache from ECM-5 (#872). Boot-load below
// alongside preloadRules so the DT form's equipment dropdown renders
// synchronously when the section opens. Refetch is wired into initWS's
// onCatalogueUpdate so remote admin catalogue edits propagate without
// a page reload.
import { loadCatalogue as loadEquipmentCatalogue, refetchCatalogue as refetchEquipmentCatalogue } from './data/equipment-catalogue-cache.js';
// BL-2 (#1008): bloodline disciplines come from the collection, not the
// constants. Primed in the boot Promise.allSettled below so nothing is costed
// against an unloaded cache; the banner surfaces any bloodline that does not
// resolve, because an unresolved one silently mis-costs XP.
import { loadBloodlines, loadFailed as bloodlinesLoadFailed, refetchBloodlines } from './data/bloodlines-cache.js';
import { loadOfficeContent, loadFailed as officeContentLoadFailed } from './data/office-content-cache.js';
import { mountBloodlineWarnBanner } from './components/bloodline-warn-banner.js';
import { initSignIn } from './game/signin-tab.js';
import { renderEmergencyTab } from './game/emergency-tab.js';
import { initCombatTab } from './game/combat-tab.js';
// The Rules TAB was deleted with #1135; the sheet's Rules button still opens the
// overlay, so openRulesOverlay/closeRulesOverlay stay (exposed on window below).
import { openRulesOverlay, closeRulesOverlay } from './game/rules.js';
// Player portal tabs — migrated to More grid (nav-2-3 + nav-2-4)
// 2026-08-29 (Angelus): initDowntimeTab / initOrdeals imports removed
// alongside the wider Downtime + Ordeals removal, moved to TM Story, not
// just gated. renderPastOutcomes stays: it is the Info tab's read-only
// historical-outcomes display, a different surface from the filing form.
import { renderPastOutcomes } from './tabs/downtime-tab.js';
import { renderStatusTab } from './tabs/status-tab.js';
import { renderRegencyTab } from './tabs/regency-tab.js';
// prax.4b: `onPraxisResolved` is aliased the same way admin.js aliases its own
// WS callbacks, so the initWS({...}) entry below reads as a wiring line rather
// than a bare imported name.
import { renderOfficeTab, onPraxisResolved as onOfficeTabPraxisResolved } from './tabs/office-tab.js';
import { initArchiveTab } from './tabs/archive-tab.js';
import { renderFeedingTab } from './tabs/feeding-tab.js';
import { findRegentTerritory } from './data/helpers.js';
import { printSheet, printPDF, exportJSON } from './editor/print.js';
import { isLoggedIn, validateToken, login, logout, getUser, getRole, getPlayerInfo } from './auth/discord.js';

// ══════════════════════════════════════════════
//  SUITE IMPORTS
// ══════════════════════════════════════════════

import suiteState, { CHARS_DATA } from './suite/data.js';
import { mountTerr } from './suite/territory.js';
import { initOfficeApprovals } from './suite/office-approvals.js';
import {
  handleImport as _handleImport,
  handleDtImport as _handleDtImport,
  setImportCallbacks,
} from './suite/import.js';
import { loadCharsFromApi, sanitiseChar, loadRulesFromApi, getRulesByCategory } from './data/loader.js';
import { apiGet, apiPut } from './data/api.js';
import { loadGameXP } from './data/game-xp.js';
import { loadDowntimeHoldFlag } from './data/dt-hold-flag.js';
import { applyDerivedMerits } from './editor/mci.js';
import { preloadRules } from './editor/rule_engine/load-rules.js';
import { applyOverlayToAll } from './data/st-mods.js';
// Issue #879 (ADR-006 D4): armour-adjusted defence materialised before
// applyOverlayToAll so STM mods on derived.defence compose on top.
import { materialiseDerivedDefence } from './data/equipment-derivation.js';
import { loadGlobalSettings, getGlobalSettings } from './data/app-settings.js';
import { installStModPopover } from './editor/st-mod-popover.js';
// Roll tab: roll-v2.js is the sole player roller (rlv.2, 2026-08-24 — the
// old roll.js and the tm-use-new-dice-roller flag/toggle it was gated
// behind are retired outright, not soaked or dead-code-fenced). Every
// external touch-point (pickChar, shared/resist.js, contested-roll) reads
// the same DOM ids as before, unchanged by this promotion.
import { loadPool, chgPool, chgMod, updPool, setAgain, setAgainSeg, togMod, togSpec, doRoll, clrHist, effPool, togEquipChip, updWeaponRef, spendVitae, spendWillpower, addPowerChip, togPowerChip, removePowerChip, resetRollPool } from './suite/roll-v2.js';
import { onSheetChar, renderSheet as suiteRenderSheet, repaintSheetTrackers } from './suite/sheet.js';
import { toggleExp as suiteToggleExp, toggleDisc as suiteToggleDisc } from './suite/sheet-helpers.js';
import { updResist, showResistSec, DISC_ABBR, lashOutPool, bloodBondPool } from './shared/resist.js';
import { getPool, unskilledPenalty } from './shared/pools.js';
import { getAttrEffective as getAttrVal, skDots, skTotal } from './data/accessors.js';
import { SKILLS_MENTAL, ALL_ATTRS, ALL_SKILLS } from './data/constants.js';
import { AUSPEX_QUESTIONS } from './data/auspex-insight.js';
import { toast as _toast } from './suite/toast.js';
// suite/tracker-feed.js removed — feeding consolidated to More grid (nav-2-5)
import { renderSuiteStatusTab, suiteStatusOpenEdit, suiteStatusCloseEdit, suiteStatusAdjustCity } from './suite/status.js';

// ══════════════════════════════════════════════
//  FORWARD WRAPPERS (suite)
// ══════════════════════════════════════════════

function toast(msg) { _toast(msg); }

// ══════════════════════════════════════════════
//  VIEW MODE (ST player-view toggle)
// ══════════════════════════════════════════════

const VIEW_MODE_KEY = 'tm_view_mode';
let _viewMode = sessionStorage.getItem(VIEW_MODE_KEY) || 'st';

function effectiveRole() {
  const role = getRole();
  if ((role === 'st' || role === 'dev') && _viewMode === 'player') return 'player';
  return role;
}

// ══════════════════════════════════════════════
//  SURFACE STYLESHEETS (ADR-008 D9 — scope separation)
// ══════════════════════════════════════════════

// An admin surface's rules are loaded *apart* from the player sheets rather than
// reconciled with them. That option exists only because the two surfaces are
// role-exclusive and need never co-render; it edits no declarations and makes no
// design judgement, which is what separates it from reconcile and rename.
//
// Two gates, deliberately different (ADR-007 D3, authority vs visibility):
//   injection   getRole()        authority  — should this session ever fetch it?
//   application effectiveRole()  visibility — should it apply right now?
//
// The application gate is the co-render precondition: an ST who opens an admin
// surface and then toggles player preview would otherwise have admin rules
// applying to player markup. Enforced by toggling link.disabled in
// applyRoleRestrictions(), which already runs on both the toggle and on boot.

// applyRoleRestrictions() is the SOLE owner of that decision. This injector is
// deliberately presentation-agnostic: it does not read _viewMode, effectiveRole()
// or any other view state. A second site computing "should ST presentation
// apply" would agree with effectiveRole() only for as long as effectiveRole()'s
// condition stays exactly a _viewMode comparison — a third role, a dev-preview
// mode or an impersonation flag would make them disagree silently, surfacing
// only as wrongly-applied CSS.

const _surfaceSheets = new Map();   // href -> promise

function loadSurfaceSheet(href) {
  // Cache the PROMISE, not the element. A presence-check on the <link> would
  // pass a second caller while the sheet is still in flight, rendering that
  // open unstyled — and only ever the second open, which is the hard one to see.
  const cached = _surfaceSheets.get(href);
  if (cached) return cached;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.surfaceSheet = href;
  // Injected ENABLED, deliberately. `disabled` would couple application to
  // fetching — a disabled stylesheet may never be fetched, so neither load nor
  // error would fire and the promise below would never settle, leaving the
  // surface blank with no error. Enabled, the fetch always proceeds and the
  // promise always settles. applyRoleRestrictions() decides application.
  //
  // MUST stay synchronous with the applyRoleRestrictions() call at the end of
  // this function: that is the only thing preventing a brief flash of ST
  // styling in player preview, since the browser cannot paint between two
  // synchronous statements. If it ever moves behind an await/setTimeout/rAF the
  // failure is a visible flash — cosmetic, and preferred over the silent blank
  // surface `disabled` would have produced from the same refactor (D9).

  const promise = new Promise(resolve => {
    // Degrade, never fail: a bad href costs styling, not the whole surface.
    link.addEventListener('load', () => resolve(true), { once: true });
    link.addEventListener('error', () => {
      console.warn('[surface-sheet] failed to load, rendering unstyled:', href);
      resolve(false);
    }, { once: true });
  });

  _surfaceSheets.set(href, promise);
  document.head.appendChild(link);
  applyRoleRestrictions();   // single owner of the enabled/disabled decision
  return promise;
}

function applySurfaceSheetVisibility(isSTView) {
  // Queries the DOM rather than the promise cache, so this owns every surface
  // sheet however it got there. disabled, not element removal — removal makes
  // every view toggle refetch.
  document.querySelectorAll('[data-surface-sheet]')
    .forEach(l => { l.disabled = !isSTView; });
}

// ══════════════════════════════════════════════
//  DIRTY STATE MANAGEMENT (editor)
// ══════════════════════════════════════════════

function markDirty(idx) {
  if (idx === undefined) idx = editorState.editIdx;
  if (idx < 0) return;
  editorState.dirty.add(idx);
  updDirtyBadge();
}

function updDirtyBadge() {
  const el = document.getElementById('edit-dirty');
  if (el) el.classList.toggle('on', editorState.dirty.size > 0);
}

// ══════════════════════════════════════════════
//  ST MOD OVERLAY REFRESH (Epic STM)
// ══════════════════════════════════════════════

// Re-apply the overlay for a single character (by id) and re-render
// whichever of the two sheet views (suite / embedded ST editor) currently
// has it open. Shared by the WS onStModUpdate handler and the sheet's own
// audited apply-bonus affordance (STM-14, issue #1034 — installStModPopover's
// onMutate callback) so both paths route through the same composition
// sequence (single composition site, ADR-004 §D1/§D8).
async function refreshCharacterOverlay(charId) {
  const target = (suiteState.chars || []).find(c => String(c._id) === String(charId));
  if (!target) return;
  // Issue #879 (ADR-006 D4): re-materialise before re-applying so the
  // armour-adjusted base is current at composition time.
  materialiseDerivedDefence(target);
  await applyOverlayToAll([target], getGlobalSettings()?.st_mods_enabled !== false);
  if (String(suiteState.sheetChar?._id) === String(charId)) {
    suiteRenderSheet();
  }
  // editorRenderSheet only ever renders for STs (openChar gates it on
  // getRole() === 'st'); mirror that gate here so a player's WS-delivered
  // update never touches the ST-only editor sheet container.
  if (getRole() === 'st' && editorState.editIdx >= 0 && String(editorState.chars[editorState.editIdx]?._id) === String(charId)) {
    editorRenderSheet(target);
  }
}

// ══════════════════════════════════════════════
//  EDITOR VIEW HELPERS
// ══════════════════════════════════════════════

function showEditTab(t) {
  document.querySelectorAll('.edit-tab').forEach(b => b.classList.remove('on'));
  const tabBtn = document.querySelector(`.edit-tab[data-tab="${t}"]`);
  if (tabBtn) tabBtn.classList.add('on');
  document.querySelectorAll('.etab').forEach(el => el.classList.remove('active'));
  const tabEl = document.getElementById('et-' + t);
  if (tabEl) tabEl.classList.add('active');
}

function setSheetView(view) {
  const gcpEl  = document.getElementById('gcp-panel');
  const shEl   = document.getElementById('sh-content');
  const dtEl   = document.getElementById('dt-lookup');
  const printBtn = document.getElementById('btn-print');
  const isSheet = view === 'sheet';

  if (gcpEl)  gcpEl.style.display  = isSheet ? '' : 'none';
  if (shEl)   shEl.style.display   = isSheet ? '' : 'none';
  if (dtEl)   dtEl.style.display   = isSheet ? 'none' : '';
  if (printBtn) printBtn.style.display = isSheet ? '' : 'none';

  document.getElementById('svt-sheet')?.classList.toggle('on', isSheet);
  document.getElementById('svt-dt')?.classList.toggle('on', !isSheet);

  if (!isSheet && editorState.editIdx >= 0) {
    loadDtLookup(dtEl, editorState.chars[editorState.editIdx]);
  }
}

function openChar(idx) {
  editorState.editIdx = idx;
  const c = editorState.chars[idx];
  // Update edit header
  const nameEl = document.getElementById('edit-charname');
  if (nameEl) nameEl.textContent = displayName(c) || 'Unnamed';
  const hdrIcon = document.getElementById('edit-clan-icon');
  const ck = CLAN_ICON_KEY[c.clan];
  if (ck && hdrIcon) { hdrIcon.src = ICONS[ck]; hdrIcon.style.display = 'inline'; }
  else if (hdrIcon) { hdrIcon.style.display = 'none'; }
  // Editor sheet creates duplicate element IDs that break toggleDisc/toggleExp
  // in the split tabs. Only render for STs who use the editor tab.
  if (getRole() === 'st') {
    renderIdentityTab(c);
    renderAttrsTab(c);
    editorRenderSheet(c);
  }
  suiteState.sheetChar = c;
  document.getElementById('sh-empty').style.display = 'none';
  document.getElementById('sh-content-suite').style.display = '';
  suiteRenderSheet();           // suite single-column sheet for the Sheets tab

  // Render pools panel — sets rollChar so Roll tab banner shows this character
  const poolsEl = document.getElementById('gcp-panel');
  if (poolsEl) {
    suiteState.rollChar = c;
    // rlv.7 review fix: this changes rollChar without a loadPool() to
    // follow, so any stale POOL_NAME/powerChips/MOD from the previously
    // loaded character must be cleared here too (see roll-v2.js's
    // resetRollPool() — a stale chip badge left clickable after this
    // switch could otherwise persist old data into the new character's own
    // storage slot).
    resetRollPool();
    renderCharPools(poolsEl, c, (p, btn) => {
      // gdx.12: submit tiles (Humanity Check) POST-and-toast in place — no
      // panel, no roll, no tab switch (nothing is being loaded into the
      // roller). Checked first, before the goTab('roll') every other tile
      // kind below still wants.
      if (p.submitAction === 'humanity_check') { submitHumanityCheck(c, btn); return; }
      // gdx-11 (#981, Task 8): choice tiles (Lash Out, Clash of Wills, Blood
      // Bond Resistance, + Custom Pool) push {opensPanel} instead of a
      // total/pi — route to the scoped panel rather than loadPool(). Target
      // is 'roll', not the pre-rlv.2 'dice' — #t-dice no longer exists.
      goTab('roll');
      if (p.opensPanel) { openPanel(p.opensPanel); return; }
      loadPool(p.total, p.label, p.pi || { total: p.total, attr: p.attr, attrV: p.attrV, skill: p.skill, skillV: p.skillV, nineAgain: p.nineAgain, resistance: p.resistance });
    });
  }

  setSheetView('sheet');
  goTab('sheets');
}

// ══════════════════════════════════════════════
//  UNIFIED TAB NAVIGATION
// ══════════════════════════════════════════════

const TAB_SUBTITLES = {
  chars: 'Characters',
  editor: 'Character Sheet',
  edit: 'Edit Character',
  roll: 'Roll',
  sheets: 'Sheets',
  territory: 'Territory',
  tracker: 'Live Tracker',
  // Unified nav tab names
  sheet: 'Sheet',
  stats: 'Stats',
  skills: 'Skills',
  powers: 'Powers',
  info: 'Misc',
  status: 'Status',
  territory: 'Territory',
  more: 'More',
  settings: 'Settings',
  'contested-queue': 'Challenges',
  'contested-resolve': 'Resolve Challenge',
};

const EDITOR_TABS = new Set(['chars', 'editor', 'edit']);

// Maps internal tab names to the visible unified nav button ID.
// When a legacy tab name is activated, the correct new nav button is highlighted.
// Maps internal tab names to the visible unified nav button ID.
// Legacy tabs and More grid apps all resolve to the correct primary nav button.
const NAV_ALIAS = {
  // Editor sub-views highlight the Stats nav button (primary sheet view)
  chars: 'stats', editor: 'stats', edit: 'stats', sheets: 'stats', sheet: 'stats',
  // More grid still exists for desktop sidebar — alias for goTab compatibility
  more: 'more',
};

// ── Scrollable bottom nav ───────────────────────────────────────────────────
// Ordered list of all nav items. Role/condition gating mirrors MORE_APPS.
// Icons are inlined (not referencing _svg) to avoid declaration-order issues.
const NAV_ITEMS = [
  // Sheet split into Stats / Skills / Powers for phone UX
  { id: 'roll',      label: 'Roll',      icon: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="4"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/><circle cx="17" cy="7" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="7" cy="17" r="1.5" fill="currentColor"/><circle cx="17" cy="17" r="1.5" fill="currentColor"/></svg>', goTab: 'roll' },
  { id: 'stats',     label: 'Stats',     icon: '<svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>', goTab: 'stats' },
  { id: 'skills',    label: 'Skills',    icon: '<svg viewBox="0 0 24 24"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>', goTab: 'skills' },
  { id: 'powers',    label: 'Powers',    icon: '<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', goTab: 'powers' },
  { id: 'status',    label: 'Status',    icon: '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>', goTab: 'status' },
  { id: 'misc',      label: 'Info',      icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>', goTab: 'info' },
  { id: 'feeding',   label: 'Feeding',   icon: '<svg viewBox="0 0 24 24"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>', goTab: 'feeding' },
  // 'downtime' and 'ordeals' bottom-nav entries removed 2026-08-29 (Angelus):
  // both features moved to TM Story, not just gated. tabs/downtime-tab.js and
  // tabs/ordeals-view.js stay on disk, unrouted.
  // ST only
  { id: 'territory', label: 'Territory', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>', goTab: 'territory', stOnly: true },
  { id: 'office-approvals', label: 'Approvals', icon: '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>', goTab: 'office-approvals', stOnly: true },
  { id: 'tracker',   label: 'Tracker',   icon: '<svg viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/></svg>', goTab: 'tracker', stOnly: true },
  { id: 'combat',    label: 'Combat',    icon: '<svg viewBox="0 0 24 24"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M3 14l7-7"/></svg>', goTab: 'combat', stOnly: true },
  { id: 'signin',    label: 'Check-In',  icon: '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>', goTab: 'signin', coordinatorOnly: true },
  { id: 'emergency', label: 'Emergency', icon: '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.89 12 19.79 19.79 0 0 1 1.84 3.4 2 2 0 0 1 3.81 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>', goTab: 'emergency', coordinatorOnly: true },
  // Conditional
  { id: 'regency',   label: 'Regency',   icon: '<svg viewBox="0 0 24 24"><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M6 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0z"/><path d="M18 5a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg>', goTab: 'regency', condition: 'hasRegency' },
  { id: 'office',    label: 'Office',    icon: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>', goTab: 'office' },
  // Settings (always last)
  { id: 'settings',  label: 'Settings',  icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', goTab: 'settings' },
];

// gdx-9: when the single-scroll flag is on, the separate stats/skills/
// powers/misc destinations collapse into one "Sheet" entry pointing at the
// existing goTab('sheets') destination — satisfies "no duplicate nav
// layers" (there is exactly one way to reach those four sections: the new
// jump-nav chips inside the single scroll, not a second tab-switcher).
// Flag off: returns NAV_ITEMS itself, unchanged.
const GDX9_CONSOLIDATED_IDS = new Set(['stats', 'skills', 'powers', 'misc']);

function _gdx9NavItems() {
  if (!singleScrollEnabled()) return NAV_ITEMS;
  const sheetItem = {
    id: 'sheet', label: 'Sheet',
    icon: NAV_ITEMS.find(i => i.id === 'stats').icon,
    goTab: 'sheets',
  };
  const out = [];
  let inserted = false;
  for (const item of NAV_ITEMS) {
    if (GDX9_CONSOLIDATED_IDS.has(item.id)) {
      if (!inserted) { out.push(sheetItem); inserted = true; }
      continue;
    }
    out.push(item);
  }
  return out;
}

function renderBottomNav() {
  const el = document.getElementById('bnav');
  if (!el) return;
  const role = effectiveRole();
  const isST = role === 'st' || role === 'dev';
  const isCoord = role === 'st' || role === 'dev' || role === 'coordinator';

  let h = '';
  for (const item of _gdx9NavItems()) {
    if (item.stOnly && !isST) continue;
    if (item.coordinatorOnly && !isCoord) continue;
    if (item.condition && !_moreGridCondition(item)) continue;
    if (item.seasonal) {
      // Seasonal items hidden by default, shown by a per-item lifecycle hook.
      // 2026-08-29: no NAV_ITEMS entry currently sets `seasonal` (Downtime's
      // own use of it was removed with the rest of that entry); this stays
      // as general nav-rendering plumbing for whatever next uses it.
      h += `<button class="nbtn nbtn-seasonal" id="n-${item.id}" onclick="goTab('${item.goTab}')" style="display:none">${item.icon}<span>${item.label}</span></button>`;
      continue;
    }
    const dis = item.disabled ? ' nbtn-disabled' : '';
    const admin = (item.stOnly || item.coordinatorOnly) ? ' nbtn-admin-tier' : '';
    // 2026-08-29: the Ordeals dimmed-tile treatment (and the seasonal Downtime
    // button's own equivalent via _updateSeasonalNav) is removed: both items
    // are gone from NAV_ITEMS entirely now, not just dimmed.
    const click = item.disabled ? '' : ` onclick="goTab('${item.goTab}')"`;
    h += `<button class="nbtn${dis}${admin}" id="n-${item.id}"${click}>${item.icon}<span>${item.label}</span></button>`;
  }
  el.innerHTML = h;

  // Highlight the currently active tab
  const active = document.querySelector('.tab.active');
  if (active) {
    const tabId = active.id.replace('t-', '');
    // gdx-9: this bottom nav is phone-only — desktop's own sidebar
    // (renderDesktopSidebar) highlights independently via the SAME shared
    // NAV_ALIAS object, which must stay untouched for AC4 (desktop
    // unchanged). So the 'sheets' -> 'n-sheet' remap is local to this
    // function, gated on both the flag and !desktop-mode.
    const isDesktopNow = document.body.classList.contains('desktop-mode');
    const navId = (!isDesktopNow && singleScrollEnabled() && tabId === 'sheets')
      ? 'n-sheet'
      : 'n-' + (NAV_ALIAS[tabId] || tabId);
    const navEl = document.getElementById(navId);
    if (navEl) navEl.classList.add('on');
  }
}

// crd.2: `ctx` is an optional context payload for tabs that are opened ABOUT
// something specific rather than just opened. Every existing call site passes
// one argument and is unaffected; only the tabs that declare they want a
// context read it. First (and currently only) consumer: 'contested-resolve',
// which is meaningless without the id of the challenge being resolved.
function goTab(t, ctx) {
  // Challenge tile opens modal rather than navigating to a tab
  if (t === 'challenge') {
    const activeChar = editorState.chars.find(c => c === editorState.chars[editorState.editIdx]) || editorState.chars[0];
    if (activeChar) openChallengeModal(activeChar);
    return;
  }

  // Hide all tabs
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nbtn').forEach(el => el.classList.remove('on'));

  // Show target tab
  const tabEl = document.getElementById('t-' + t);
  if (tabEl) tabEl.classList.add('active');
  // Mark the nav button — use alias if the tab maps to a unified nav button
  const navId = 'n-' + (NAV_ALIAS[t] || t);
  const navEl = document.getElementById(navId);
  if (navEl) {
    navEl.classList.add('on');
    // Scroll the active button into view in the swipeable nav strip
    navEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  // Update header subtitle
  const subEl = document.getElementById('hdr-sub');
  if (subEl && TAB_SUBTITLES[t]) subEl.textContent = TAB_SUBTITLES[t];

  // Show/hide Save button (only relevant on editor tabs)
  const saveRow = document.getElementById('topbar-right');
  if (saveRow) saveRow.style.display = EDITOR_TABS.has(t) ? '' : 'none';

  // Tab-specific init
  if (t === 'territory') mountTerr();
  if (t === 'office-approvals') {
    const el = document.getElementById('t-office-approvals');
    if (el) initOfficeApprovals(el);
  }
  if (t === 'tracker') initTracker(document.getElementById('t-tracker'));
  if (t === 'status') renderSuiteStatusTab(document.getElementById('t-status'));
  if (t === 'signin') initSignIn(document.getElementById('t-signin'), suiteState.chars);

  // ── Unified nav tab init ──────────────────────────────────────────────────
  if (document.body.classList.contains('desktop-mode')) renderDesktopSidebar();
  if (t === 'roll') { _clearLifecycleCache(); renderLifecycleCards(); }
  if (t === 'more') renderMoreGrid();
  if (t === 'settings') renderSettingsTab();

  if (t === 'feeding') {
    const el = document.getElementById('t-feeding');
    const char = _activeMoreChar();
    if (el && char) renderFeedingTab(el, char);
    checkMoreBadge(); // re-check after visiting feeding (may have just rolled)
  }
  if (t === 'regency') {
    const el = document.getElementById('t-regency');
    const char = _activeMoreChar();
    const terrs = suiteState.territories || [];
    if (el && char) renderRegencyTab(el, char, terrs);
  }
  if (t === 'office') {
    const el = document.getElementById('t-office');
    const char = _activeMoreChar();
    if (el && char) renderOfficeTab(el, char, suiteState.chars || []);
  }
  if (t === 'archive') {
    const el = document.getElementById('t-archive');
    const char = _activeMoreChar();
    if (el && char) initArchiveTab(el, char, (suiteState.chars || []).filter(c => c.retired));
  }
  if (t === 'info') {
    const miscEl = document.getElementById('misc-past-outcomes');
    const char = _activeMoreChar();
    if (miscEl && char && !miscEl.innerHTML.trim()) renderPastOutcomes(miscEl, char);
    // 2026-08-29: this is NOT the only surface a published downtime outcome is
    // visible on — the "STORY" nav's Downtime Reports list (initArchiveTab,
    // archive-tab.js) shows the same data. Corrected Story storytab.5, 2026-09-19:
    // the original claim here was already false before that story (archive-tab.js
    // already showed it) and was found stale during that story's own chorus review.
    // _markSubViewed used to fire from the old Downtime tab's own dispatch; moved
    // here so the #more-badge "unread narrative" indicator can still be cleared by
    // a player actually reading it on this surface, rather than being permanently
    // stuck on.
    _markSubViewed();
  }
  // 'downtime' and 'ordeals' tab-body dispatch removed 2026-08-29 (Angelus):
  // both features moved to TM Story, not just gated. initDowntimeTab/
  // initOrdeals are no longer imported; tabs/downtime-tab.js and
  // tabs/ordeals-view.js stay on disk, unrouted. renderPastOutcomes (Info
  // tab, below) is UNCHANGED: it is a read-only historical summary on a
  // different tab, not the filing form, and downtime_submissions stays
  // mounted for exactly this kind of shared read.
  if (t === 'status') {
    // Status tab is also the primary nav #3 — handled above; this covers More grid access
  }
  // crd.2 — pending contested-roll queue, and the destination it routes into.
  // The queue is handed the viewer's own characters so each row can name WHICH
  // of them is being challenged; it never filters on them (the server's
  // GET /mine is the only authority on what belongs in this queue).
  // `checkMoreBadge` is injected rather than imported by the queue: app.js
  // already imports FROM pending-queue.js, so an import the other way would be
  // circular. Without it the shared #more-badge went stale in both directions
  // while this tab was open (lit after the queue emptied, dark after a poll
  // found new work) — the queue's own poll had no path to the badge's one owner.
  if (t === 'contested-queue') {
    const el = document.getElementById('t-contested-queue');
    if (el) initPendingQueue(el, suiteState.chars || [], checkMoreBadge);
  }
  if (t === 'contested-resolve') {
    const el = document.getElementById('t-contested-resolve');
    // crd.3b: additive third argument, mirroring goTab(t)'s own extension to
    // goTab(t, ctx) — the defending character's real merits/attributes are
    // already resident in suiteState.chars (initPendingQueue already receives
    // it above), so no new fetch is added here.
    if (el) initContestedResolve(el, ctx, suiteState.chars || []);
  }
  if (t === 'emergency') {
    const el = document.getElementById('t-emergency');
    if (el && !el.innerHTML.trim()) renderEmergencyTab(el);
  }
  if (t === 'combat') {
    const el = document.getElementById('t-combat');
    if (el) initCombatTab(el);
  }
  if (t === 'spheres') initSpheresSurface(document.getElementById('t-spheres'));
  if (t === 'praxis') initPraxisSurface(document.getElementById('t-praxis'));
  if (t === 'chars') {
    // Sheet tab: ST sees 3-col character picker; player sees their own sheet
    const role = getRole();
    if (role !== 'st') {
      showPlayerSheet();
    } else {
      renderSheetPicker(document.getElementById('t-chars'));
    }
  }
}

// ══════════════════════════════════════════════
//  UNIFIED DATA LOADING
// ══════════════════════════════════════════════

function populateSuiteDropdowns(chars) {
  const sel = document.getElementById('char-sel');
  if (sel) {
    sel.innerHTML = '<option value="">\u2014 Select character \u2014</option>';
    chars.forEach(c => {
      const o = document.createElement('option');
      o.value = c.name;
      o.textContent = displayName(c);
      sel.appendChild(o);
    });
  }
}

// Spheres surface (ADM P1 surface 2, #1096). This is now the REFERENCE
// IMPLEMENTATION of the ADR-008 D4/D9 loading pattern: the Tickets pilot
// established it, and #1135 scrapped the ticket system, so the pattern lives
// here. Its one structural quirk: initSpheresView() takes NO container argument
// and calls document.getElementById('spheres-content') itself
// (spheres-view.js:29). index.html therefore provides that id as a child of the
// tab container, which is what keeps spheres-view.js unmodified. Do not add a
// container parameter to the module.
//
// Gated on getRole(), NOT effectiveRole(): whether to fetch admin code is a
// question of authority, and effectiveRole() reports 'player' for a real ST in
// preview mode. Gating the fetch on it would strip an ST of their own admin code
// the moment they toggle preview, and inverts the ADR-007 D3 contract.
//
// Module and stylesheet are fetched CONCURRENTLY and both awaited before render:
// awaiting them in series would add a round trip, and rendering before the sheet
// resolves would flash unstyled. Neither trade is necessary.
async function initSpheresSurface(el) {
  if (!el) return;
  const role = getRole();
  if (role !== 'st' && role !== 'dev') return;

  try {
    // A surface declares the SET of sheets it needs, not one sheet (D9 Rev 13).
    // admin-shared.css holds classes two or more admin surfaces emit; Downtime
    // will inject the same sheet when it moves. loadSurfaceSheet is idempotent
    // and promise-cached, so the second injection costs nothing and there is no
    // ordering dependency between surfaces. Listed in source order for the
    // cascade, though no cross-sheet conflict exists: the only cross-bucket
    // co-occurrence is .sphere-card + .sphere-card-vacant, whose declarations
    // are disjoint (background/border/padding vs opacity).
    const [mod] = await Promise.all([
      import('./admin/spheres-view.js'),
      loadSurfaceSheet('css/admin-shared.css'),
      loadSurfaceSheet('css/admin-spheres.css'),
    ]);
    await mod.initSpheresView();          // reads #spheres-content itself
  } catch (err) {
    console.error('[spheres] surface failed to load:', err);
    // Write into the inner container, not the tab: replacing the tab would
    // destroy #spheres-content and a retry could then never find it.
    const target = el.querySelector('#spheres-content') || el;
    target.innerHTML = '<p class="placeholder-msg">Spheres failed to load. Reload the page or check your connection.</p>';
  }
}

// Epic PRAX (2026-09-01): identical shape to initSpheresSurface above, reusing
// admin/praxis-tab.js's real implementation unmodified rather than a rewrite -
// that module is already a pure consumer of shared data/*.js helpers with no
// admin.js dependency, and every rule its markup needs was extracted verbatim
// into admin-praxis.css (checked against zero name collisions with this app's
// own suite.css/components.css). `_gameAppPraxisUpdate` holds the loaded
// module's own onPraxisUpdate so the WS callback wired in the boot sequence
// below can reach it once this tab has been opened at least once this
// session - the same "no-op until the domain has been opened" guard
// admin.js's own onPraxisUpdate wiring already relies on.
let _gameAppPraxisUpdate = null;

async function initPraxisSurface(el) {
  if (!el) return;
  const role = getRole();
  if (role !== 'st' && role !== 'dev') return;

  try {
    const [mod] = await Promise.all([
      import('./admin/praxis-tab.js'),
      loadSurfaceSheet('css/admin-praxis.css'),
    ]);
    _gameAppPraxisUpdate = mod.onPraxisUpdate;
    await mod.initPraxisView(suiteState.chars || []); // reads #praxis-content itself
  } catch (err) {
    console.error('[praxis] surface failed to load:', err);
    // Write into the inner container, not the tab: replacing the tab would
    // destroy #praxis-content and a retry could then never find it.
    const target = el.querySelector('#praxis-content') || el;
    target.innerHTML = '<p class="placeholder-msg">Praxis failed to load. Reload the page or check your connection.</p>';
  }
}

async function loadAllData() {
  const isST = getRole() === 'st';

  // Issue #256 (perf, 2026-05-11): Phase 1a — every step below is
  // mutually independent (none reads another's result), so they fire in
  // parallel via Promise.allSettled. One failure (e.g. preloadRules
  // 403 for a player against the ST-only rules-engine endpoint) doesn't
  // kill the others. Wall-time is now max-of-5 instead of sum-of-5.
  //
  // applyDerivedMerits at the bottom of this function reads the rules
  // cache synchronously; the cache state is determined by the time the
  // Promise.allSettled resolves (loaded if preloadRules succeeded,
  // null otherwise — issue #249 guard handles both).
  const [_rulesFromApi, rulesEngineRes, apiCharsRes, terrRes, combatRes, _catalogueRes] = await Promise.allSettled([
    loadRulesFromApi(),
    preloadRules(),
    loadCharsFromApi(),
    apiGet('/api/territories'),
    apiGet('/api/characters/combat'),
    // ECM-4 (#871): same parallel-load pattern as the rules engine, same
    // non-fatal-on-failure shape — the DT form's equipment dropdown
    // degrades to empty options + a console warning on failure.
    loadEquipmentCatalogue(),
    // BL-2 (#1008): awaited here, before the first render, so the transient
    // "cache not loaded" miss cannot fire spuriously. loadBloodlines() never
    // rejects — a genuine failure is read from bloodlinesLoadFailed() below.
    loadBloodlines(),
    // oxp.10: same reasoning as loadBloodlines() above — office-tab.js and
    // editor/sheet.js both read office content synchronously mid-render, so
    // it must be in place before the first render, not fetched per-render.
    loadOfficeContent(),
  ]);

  // BL-2 (#1008): mount before the first sheet render so any miss registered
  // during it is already on screen. Unlike the equipment catalogue this is NOT
  // console-only: a failed load means every bloodline character is being
  // costed as fully out-of-clan, which is a wrong number, not a missing one.
  mountBloodlineWarnBanner();
  if (bloodlinesLoadFailed()) {
    console.error('[app] loadBloodlines failed — every bloodline character is being costed as out-of-clan and discipline editing is locked.');
  }
  if (officeContentLoadFailed()) {
    console.error('[app] loadOfficeContent failed — every Court Position falls back to the "pending" render until the cache loads.');
  }

  // Issue #249 (HOTFIX 2026-05-09): preloadRules failure surfaces via
  // console.error + best-effort status banner. The downstream
  // applyDerivedMerits null-cache guard prevents data loss; this is the
  // user-visible signal of the degraded state.
  if (rulesEngineRes.status === 'rejected') {
    console.error('[app] preloadRules failed — derivations skipped until rules cache loads (issue #249):', rulesEngineRes.reason);
    const banner = document.getElementById('app-status-banner');
    if (banner) {
      banner.textContent = 'Rules data failed to load — some derived merit values may be unavailable. Reload the page or check your connection.';
      banner.classList.add('app-status-banner--error');
      banner.style.display = '';
    }
  }
  // ECM-4 (#871): catalogue load is non-fatal — surface the degraded state
  // in console only. The DT form's equipment section degrades to an empty
  // dropdown rather than blocking submission.
  if (_catalogueRes.status === 'rejected') {
    console.error('[app] loadEquipmentCatalogue failed — DT-form equipment dropdown will be empty until cache loads:', _catalogueRes.reason);
  }

  // 1. Chars handling — role-filtered server-side (player sees own, ST sees all).
  const apiChars = apiCharsRes.status === 'fulfilled' ? apiCharsRes.value : null;
  if (apiChars) {
    editorState.chars = apiChars;
  } else if (isST) {
    // Only fall back to embedded data for STs
    loadDB();
  } else {
    // Player with no API — show nothing rather than leak all characters
    editorState.chars = [];
  }

  // Issue #256 Phase 1b — loadGameXP + loadDowntimeHoldFlag both depend
  // on `editorState.chars` being loaded but are mutually independent.
  await Promise.allSettled([
    loadGameXP(editorState.chars, isST),
    loadDowntimeHoldFlag(editorState.chars, { isST }),
  ]);

  // Compute derived bonus fields (PT/MCI/OHM grants, 9-Again, etc.)
  // The rules-engine cache is either loaded (Phase 1a fulfilled) or
  // null (the #249 guard bails out per-character). Safe either way.
  editorState.chars.forEach(c => applyDerivedMerits(c));

  // 2. Copy to suite state
  const sortedChars = editorState.chars.slice().sort((a, b) => sortName(a).localeCompare(sortName(b)));
  suiteState.chars = sortedChars;

  // 2b. Merge combat chars (resist target dropdown) — already fetched
  // in Phase 1a; just apply the result here. Players only have their
  // own chars in editorState, but resist calc needs opponents'
  // attributes.
  if (combatRes.status === 'fulfilled' && Array.isArray(combatRes.value) && combatRes.value.length) {
    const ownIds = new Set(sortedChars.map(c => String(c._id)));
    for (const cc of combatRes.value) {
      if (!ownIds.has(String(cc._id))) suiteState.chars.push(cc);
    }
  } else if (combatRes.status === 'rejected') {
    console.warn('Combat chars load failed:', combatRes.reason?.message);
  }

  // 2c. STM-7 (ADR-004 Rev 3 §D8/D9 — issue #413): boot-time bulk overlay.
  // Establishes the cache-entry invariant — every in-memory chars[] entry
  // has applyStMods applied before any accessor read happens. Roll calc,
  // DT pools, and any other accessor consumer pick up modded values
  // transparently (no per-callsite changes; all 213 accessor reads funnel
  // through the 6 functions in data/accessors.js, which read exactly the
  // paths applyStMods mutates).
  //
  // Single bulk fetch via the new /api/st_mods?character_ids=<csv> endpoint;
  // applied to suiteState.chars AFTER combat-only chars are merged so
  // resist-target attribute lookups also see modded values. Failure is
  // graceful: applyOverlayToAll bails per-character and stripOverlay
  // restores canonical values, so the suite stays operational without mods.
  await loadGlobalSettings();
  const globalEnabled = getGlobalSettings()?.st_mods_enabled !== false;
  // Issue #879 (ADR-006 D4): materialise armour-adjusted defence on every
  // char BEFORE applyOverlayToAll so 'derived.defence' STM mods compose
  // additively on top of the real mechanical base.
  for (const c of (suiteState.chars || [])) materialiseDerivedDefence(c);
  // Fetch the bulk CSV against the player's OWN character ids only
  // (sortedChars, pre-combat-merge) — suiteState.chars can carry non-owned
  // combat opponents (2b above), and st_mods' bulk route 403s the whole
  // batch atomically on the first id the caller doesn't own, silently
  // zeroing the overlay for the player's own characters too. STs already
  // own everything editorState.chars returns, so this is a no-op for them.
  await applyOverlayToAll(suiteState.chars, globalEnabled, sortedChars.map(c => c._id));
  // editorState.chars is the same set of references for the player-owned
  // subset (sortedChars came from editorState.chars.slice()). Combat-only
  // chars are not in editorState. Nothing more to mirror.

  window._charNames = suiteState.chars.map(c => c.name);
  window._charDisplayMap = Object.fromEntries(suiteState.chars.map(c => [c.name, displayName(c)]));

  // 3. Territories — already fetched in Phase 1a. setStatusTerritories
  // keeps the City Status calc's recompute path in sync (issue #13
  // Surface 2 — module-level store in accessors.js).
  suiteState.territories = terrRes.status === 'fulfilled' && Array.isArray(terrRes.value)
    ? terrRes.value
    : [];
  setStatusTerritories(suiteState.territories);

  // 4. Populate suite dropdowns
  populateSuiteDropdowns(sortedChars);
}

/**
 * loadChars() — suite-compatible reload.
 * Called after import or clearImport to refresh suite data.
 */
function loadChars() {
  let data = CHARS_DATA;
  try {
    const v2Stored = localStorage.getItem('tm_chars_db');
    if (v2Stored) {
      const parsed = JSON.parse(v2Stored);
      if (parsed && parsed.v === 2 && Array.isArray(parsed.chars) && parsed.chars.length) {
        data = parsed.chars;
      }
    } else {
      const stored = localStorage.getItem('tm_import_chars');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length) data = parsed;
      }
    }
  } catch (e) { /* ignore */ }
  data.forEach(sanitiseChar);
  const chars = data.slice().sort((a, b) => sortName(a).localeCompare(sortName(b)));
  suiteState.chars = chars;
  window._charNames = chars.map(c => c.name);
  window._charDisplayMap = Object.fromEntries(chars.map(c => [c.name, displayName(c)]));
  populateSuiteDropdowns(chars);
  renderImportBanner();
}

// ══════════════════════════════════════════════
//  IMPORT BANNER (suite)
// ══════════════════════════════════════════════

function renderImportBanner() {
  const el = document.getElementById('import-banner');
  if (!el) return;
  try {
    const meta = localStorage.getItem('tm_import_meta');
    if (meta) {
      const m = JSON.parse(meta);
      el.style.display = '';
      el.innerHTML = `<div class="import-banner"><span>Data imported from <b>${m.filename}</b> &mdash; ${m.count} characters &mdash; ${m.date}</span><button class="import-banner-clr" onclick="clearImport()" title="Clear import">\u00d7</button></div>`;
      return;
    }
  } catch (e) { /* ignore */ }
  el.style.display = 'none';
  el.innerHTML = '';
}

function clearImport() {
  localStorage.removeItem('tm_import_chars');
  localStorage.removeItem('tm_import_meta');
  loadChars();
  toast('Import cleared \u2014 using built-in data');
}

// ══════════════════════════════════════════════
//  PICKER PANEL (suite)
// ══════════════════════════════════════════════

const COMMON_ACTIONS = [
  { name: 'Argument',      attr: 'Intelligence', skill: 'Expression',    resist: 'Resolve' },
  { name: 'Carousing',     attr: 'Presence',     skill: 'Socialise',     resist: null },
  { name: 'Carousing',     attr: 'Presence',     skill: 'Streetwise',    resist: null },
  { name: 'Fast-Talk',     attr: 'Manipulation', skill: 'Subterfuge',    resist: 'Composure' },
  { name: 'Interrogation', attr: 'Manipulation', skill: 'Empathy',       resist: 'Resolve' },
  { name: 'Interrogation', attr: 'Manipulation', skill: 'Intimidation',  resist: 'Resolve' },
  { name: 'Intimidation',  attr: 'Strength',     skill: 'Intimidation',  resist: 'Composure' },
  { name: 'Intimidation',  attr: 'Manipulation', skill: 'Intimidation',  resist: 'Composure' },
  { name: 'Investigate',   attr: 'Intelligence', skill: 'Investigation', resist: null },
  { name: 'Jumping',       attr: 'Strength',     skill: 'Athletics',     resist: null },
  { name: 'Repair',        attr: 'Intelligence', skill: 'Crafts',        resist: null },
  { name: 'Research',      attr: 'Intelligence', skill: 'Academics',     resist: null },
  { name: 'Research',      attr: 'Intelligence', skill: 'Occult',        resist: null },
  { name: 'Shadowing',     attr: 'Wits',         skill: 'Stealth',       resist: null, note: 'vs Wits + Composure' },
  { name: 'Shadowing',     attr: 'Wits',         skill: 'Drive',         resist: null, note: 'vs Wits + Composure' },
  { name: 'Sneaking',      attr: 'Dexterity',    skill: 'Stealth',       resist: null, note: 'vs Wits + Composure' },
];

function openPanel(mode) {
  suiteState.panelMode = mode;
  const body = document.getElementById('panel-body');
  const title = document.getElementById('panel-title');
  body.innerHTML = '';

  if (mode === 'char') {
    title.textContent = 'Select Character';
    const role = getRole();
    const info = getPlayerInfo();
    const charList = role === 'st'
      ? suiteState.chars
      : suiteState.chars.filter(c => info?.character_ids?.includes(c._id));
    charList.forEach(c => {
      const el = document.createElement('div');
      el.className = 'panel-item';
      el.innerHTML = `<div><div class="pi-main">${displayName(c)}</div><div class="pi-sub">${c.clan || ''} \u00B7 ${c.covenant || ''}</div></div><div class="pi-badge">${redactPlayer(c.player || '')}</div>`;
      el.addEventListener('click', () => { pickChar(c); closePanel(); });
      body.appendChild(el);
    });
  } else if (mode === 'disc') {
    title.textContent = 'Select Discipline';
    if (!suiteState.rollChar) {
      body.innerHTML = '<div class="hempty" style="padding:24px 16px;">Select a character first</div>';
    } else {
      const c = suiteState.rollChar;
      const allRules = getRulesByCategory('discipline');

      // Derive discipline powers from the rules cache (same as the editor sheet).
      // For each discipline the character has dots in, show powers up to that rank.
      const discEntries = Object.entries(c.disciplines || {})
        .filter(([, v]) => (v?.dots || 0) > 0)
        .sort(([a], [b]) => a.localeCompare(b));

      for (const [disc, v] of discEntries) {
        const dots = v.dots || 0;
        const ruledPowers = allRules
          .filter(r => r.parent === disc && r.rank != null && r.rank <= dots)
          .sort((a, b) => a.rank - b.rank);
        // Fall back to stored c.powers if no rules exist for this discipline
        const powers = ruledPowers.length
          ? ruledPowers.map(r => ({ name: r.name, discipline: disc }))
          : (c.powers || []).filter(p => p.category === 'discipline' && p.discipline === disc);

        if (!powers.length) continue;
        const sec = document.createElement('div');
        sec.className = 'panel-section';
        sec.textContent = disc + ' (' + dots + ')';
        body.appendChild(sec);

        for (const p of powers) {
          const lookupKey = p.name || '';
          const pi = getPool(c, lookupKey);
          const hasRoll = pi && !pi.noRoll && pi.total !== undefined;
          let poolEl = '<div class="pi-pool nr">\u2014</div>';
          if (hasRoll) poolEl = '<div class="pi-pool">' + pi.total + '</div>';
          let subStr = '';
          if (hasRoll) subStr = pi.attr + ' + ' + pi.skill + (pi.resistance ? ' \u00B7 vs ' + pi.resistance : '');
          else if (pi && pi.noRoll && pi.info && pi.info.c) subStr = 'Cost: ' + pi.info.c;
          else if (pi && pi.info && pi.info.c) subStr = 'Cost: ' + pi.info.c;
          const el = document.createElement('div');
          el.className = 'panel-item';
          el.innerHTML = '<div><div class="pi-main">' + lookupKey + '</div>' + (subStr ? '<div class="pi-sub">' + subStr + '</div>' : '') + '</div>' + poolEl;
          el.addEventListener('click', () => {
            if (hasRoll) { loadPool(pi.total, lookupKey, pi); }
            else { toast(lookupKey + ' \u2014 no roll'); closePanel(); }
          });
          body.appendChild(el);
        }
      }

      // Also show devotions and rites from c.powers (these are character-specific picks)
      const otherPowers = [...devotions(c), ...rites(c)];
      if (otherPowers.length) {
        const sec = document.createElement('div');
        sec.className = 'panel-section';
        sec.textContent = 'Devotions & Rites';
        body.appendChild(sec);
        for (const p of otherPowers) {
          const lookupKey = p.name || '';
          const pi = getPool(c, lookupKey);
          const hasRoll = pi && !pi.noRoll && pi.total !== undefined;
          let poolEl = '<div class="pi-pool nr">\u2014</div>';
          if (hasRoll) poolEl = '<div class="pi-pool">' + pi.total + '</div>';
          let subStr = '';
          if (hasRoll) subStr = pi.attr + ' + ' + pi.skill + (pi.resistance ? ' \u00B7 vs ' + pi.resistance : '');
          else if (pi && pi.noRoll && pi.info && pi.info.c) subStr = 'Cost: ' + pi.info.c;
          const el = document.createElement('div');
          el.className = 'panel-item';
          el.innerHTML = '<div><div class="pi-main">' + lookupKey + '</div>' + (subStr ? '<div class="pi-sub">' + subStr + '</div>' : '') + '</div>' + poolEl;
          el.addEventListener('click', () => {
            if (hasRoll) { loadPool(pi.total, lookupKey, pi); }
            else { toast(lookupKey + ' \u2014 no roll'); closePanel(); }
          });
          body.appendChild(el);
        }
      }
    }
  } else if (mode === 'auspex') {
    title.textContent = 'Auspex Insight';
    const c = suiteState.rollChar || suiteState.sheetChar;
    const dots = c?.disciplines?.Auspex?.dots || 0;
    if (!dots) {
      body.innerHTML = '<div class="hempty" style="padding:24px 16px;">No Auspex rating detected.</div>';
    } else {
      let html = '';
      const maxTier = Math.min(dots, 3);
      for (let tier = 1; tier <= maxTier; tier++) {
        html += `<div class="panel-section">Tier ${tier} \u2014 Auspex ${'&#9679;'.repeat(tier)}</div>`;
        AUSPEX_QUESTIONS[tier].forEach(({ q, fmt }) => {
          html += `<div class="auspex-q-item">
            <div class="auspex-q-text">${q}</div>
            <div class="auspex-q-fmt">${fmt}</div>
          </div>`;
        });
      }
      body.innerHTML = html;
    }
  } else if (mode === 'common') {
    title.textContent = 'Common Actions';
    if (!suiteState.rollChar) {
      body.innerHTML = '<div class="hempty" style="padding:24px 16px;">Select a character first</div>';
    } else {
      const c = suiteState.rollChar;
      COMMON_ACTIONS.forEach(a => {
        const attrV  = getAttrVal(c, a.attr);
        const skillV = skDots(c, a.skill);
        const unskilled = skillV === 0 ? (SKILLS_MENTAL.includes(a.skill) ? -3 : -1) : 0;
        const total  = attrV + skillV + unskilled;
        const pi = { attr: a.attr, attrV, skill: a.skill, skillV, unskilled: unskilled || null, discName: null, discV: 0, resistance: a.resist, total };
        const el = document.createElement('div');
        el.className = 'panel-item';
        let sub = a.attr + ' + ' + a.skill;
        if (unskilled) sub += ' ' + unskilled + ' (unskilled)';
        if (a.resist) sub += ' \u00B7 vs ' + a.resist;
        if (a.note)   sub += ' \u00B7 ' + a.note;
        el.innerHTML = '<div><div class="pi-main">' + a.name + '</div><div class="pi-sub">' + sub + '</div></div><div class="pi-pool">' + total + '</div>';
        el.addEventListener('click', () => { loadPool(total, a.name, pi); });
        body.appendChild(el);
      });
    }
  } else if (mode === 'lashout') {
    // gdx-11 (#981, AC3): Lash Out — three aspect chips (fixed
    // Monstrous/Seductive/Competitive -> Power Attribute) + a Kindred/
    // Mortal toggle. Pool = chosen Power Attribute + Blood Potency;
    // resistance defaults to 'v ' + <same attribute> + ' + BP' (documented
    // simplification: assumes a symmetric aspect on both sides).
    title.textContent = 'Lash Out';
    if (!suiteState.rollChar) {
      body.innerHTML = '<div class="hempty" style="padding:24px 16px;">Select a character first</div>';
    } else {
      const c = suiteState.rollChar;
      const ASPECTS = [
        { label: 'Monstrous', attr: 'Strength' },
        { label: 'Seductive', attr: 'Presence' },
        { label: 'Competitive', attr: 'Intelligence' },
      ];
      let aspect = null;
      let kindred = true;
      const render = () => {
        const bp = c.blood_potency || 0;
        const attrV = aspect ? getAttrVal(c, aspect.attr) : 0;
        const total = aspect ? lashOutPool(c, aspect.attr, kindred).total : 0;
        let html = '<div class="panel-section">Aspect</div><div class="vm-chip-wrap">';
        ASPECTS.forEach(a => {
          html += `<button class="mchip la-aspect-chip${aspect === a ? ' on' : ''}" data-l="${esc(a.label)}">${esc(a.label)}</button>`;
        });
        html += '</div><div class="panel-section">Nature</div><div class="vm-chip-wrap">';
        html += `<button class="mchip la-kindred-chip${kindred ? ' on' : ''}" data-k="1">Kindred (1 WP)</button>`;
        html += `<button class="mchip la-kindred-chip${!kindred ? ' on' : ''}" data-k="0">Mortal (free)</button>`;
        html += '</div>';
        if (aspect) {
          html += `<div class="panel-total">${esc(aspect.attr)} <b>${attrV}</b> + Blood Potency <b>${bp}</b> = <b>${total}</b> dice</div>`;
          html += '<button class="pnl-confirm-btn" id="lashout-load">Load Pool</button>';
        }
        body.innerHTML = html;
        body.querySelectorAll('.la-aspect-chip').forEach(btn => btn.addEventListener('click', () => {
          aspect = ASPECTS.find(a => a.label === btn.dataset.l); render();
        }));
        body.querySelectorAll('.la-kindred-chip').forEach(btn => btn.addEventListener('click', () => {
          kindred = btn.dataset.k === '1'; render();
        }));
        document.getElementById('lashout-load')?.addEventListener('click', () => {
          const { pi } = lashOutPool(c, aspect.attr, kindred);
          loadPool(pi.total, 'Lash Out', pi);
        });
      };
      render();
    }
  } else if (mode === 'clash') {
    // gdx-11 (#981, AC2): Clash of Wills — "Your Discipline" (always
    // populatable from the loaded character) and "Their Discipline"
    // (suiteState.RESIST_CHAR's own disciplines - DISCLOSED LIMITATION, matching
    // the AC's own wording: this only populates once an opposing character
    // has already been picked via the existing resist-target dropdown, i.e.
    // after loading some other pool with a resistance string first; this
    // panel cannot pick a target itself).
    title.textContent = 'Clash of Wills';
    if (!suiteState.rollChar) {
      body.innerHTML = '<div class="hempty" style="padding:24px 16px;">Select a character first</div>';
    } else {
      const c = suiteState.rollChar;
      const myDiscs = Object.entries(c.disciplines || {}).filter(([, v]) => (v?.dots || 0) > 0).map(([name, v]) => ({ name, dots: v.dots }));
      let myDisc = null, theirDisc = null;
      const render = () => {
        const theirs = suiteState.RESIST_CHAR;
        const theirDiscs = theirs
          ? Object.entries(theirs.disciplines || {}).filter(([, v]) => (v?.dots || 0) > 0).map(([name, v]) => ({ name, dots: v.dots }))
          : [];
        let html = '<div class="panel-section">Your Discipline</div>';
        html += myDiscs.length
          ? '<div class="vm-chip-wrap">' + myDiscs.map(d =>
              `<button class="mchip cow-my-chip${myDisc === d.name ? ' on' : ''}" data-d="${esc(d.name)}">${esc(d.name)} (${d.dots})</button>`
            ).join('') + '</div>'
          : '<div class="hempty" style="padding:0 16px 8px;">No disciplines</div>';
        html += '<div class="panel-section">Their Discipline</div>';
        if (!theirs) {
          html += '<div class="hempty" style="padding:0 16px 8px;">Select an opposing character via the resist-target dropdown first</div>';
        } else {
          html += theirDiscs.length
            ? '<div class="vm-chip-wrap">' + theirDiscs.map(d =>
                `<button class="mchip cow-their-chip${theirDisc === d.name ? ' on' : ''}" data-d="${esc(d.name)}">${esc(d.name)} (${d.dots})</button>`
              ).join('') + '</div>'
            : '<div class="hempty" style="padding:0 16px 8px;">No disciplines</div>';
        }
        const bp = c.blood_potency || 0;
        const myDots = myDisc ? (myDiscs.find(d => d.name === myDisc)?.dots || 0) : 0;
        const total = bp + myDots;
        if (myDisc && theirDisc) {
          html += `<div class="panel-total">Blood Potency <b>${bp}</b> + ${esc(myDisc)} <b>${myDots}</b> = <b>${total}</b> dice</div>`;
          html += '<button class="pnl-confirm-btn" id="clash-load">Load Pool</button>';
        }
        body.innerHTML = html;
        body.querySelectorAll('.cow-my-chip').forEach(btn => btn.addEventListener('click', () => { myDisc = btn.dataset.d; render(); }));
        body.querySelectorAll('.cow-their-chip').forEach(btn => btn.addEventListener('click', () => { theirDisc = btn.dataset.d; render(); }));
        document.getElementById('clash-load')?.addEventListener('click', () => {
          const abbr = Object.entries(DISC_ABBR).find(([, full]) => full === theirDisc)?.[0] || theirDisc;
          const pi = {
            total, attr: 'Blood Potency', attrV: bp, skill: null, skillV: 0,
            discName: myDisc, discV: myDots, resistance: 'v ' + abbr + ' + BP', noWP: false,
            // rcv.3c: ported from the mockup (app.js:1303-1310), edited — dropped
            // "Toggle Contested Roll below" and the duration-bonus language, since
            // this live panel has neither; describes the rule, not an instruction
            // to a control that doesn't exist here.
            effect: 'When two Disciplines directly oppose each other and neither power\'s own system resolves it, both sides pool Blood Potency + dots in the Discipline fuelling their side and roll off. The side with more successes wins outright; the others fail. Ties reroll until someone pulls ahead.\n\nWillpower may only bolster this roll if your character is physically present and aware powers are clashing (p.126).',
            action: 'Instant · contested',
          };
          loadPool(total, 'Clash of Wills', pi);
        });
      };
      render();
    }
  } else if (mode === 'bloodbond') {
    // gdx-11 (#981, AC5): Blood Bond Resistance — two ST-entered scene-fact
    // chip rows, no new data model. Pool = max(0, BP - Vitae - Attempts).
    // pi.noWP = true: spending 1 WP is the cost of ATTEMPTING, never a dice
    // bonus (same reasoning the carved-out Humanity Check would have used).
    title.textContent = 'Blood Bond Resistance';
    if (!suiteState.rollChar) {
      body.innerHTML = '<div class="hempty" style="padding:24px 16px;">Select a character first</div>';
    } else {
      const c = suiteState.rollChar;
      const VITAE_OPTS = [1, 2, 3, 4];
      const ATTEMPT_OPTS = [0, 1, 2, 3];
      let vitae = null, attempts = null;
      const render = () => {
        let html = '<div class="panel-section">Vitae Ingested</div><div class="vm-chip-wrap">';
        VITAE_OPTS.forEach(v => {
          html += `<button class="mchip bb-vitae-chip${vitae === v ? ' on' : ''}" data-v="${v}">${v}${v === 4 ? '+' : ''}</button>`;
        });
        html += '</div><div class="panel-section">Prior Resistance Attempts vs. This Vampire</div><div class="vm-chip-wrap">';
        ATTEMPT_OPTS.forEach(a => {
          html += `<button class="mchip bb-attempt-chip${attempts === a ? ' on' : ''}" data-a="${a}">${a}${a === 3 ? '+' : ''}</button>`;
        });
        html += '</div>';
        const bp = c.blood_potency || 0;
        // Preview computed via the same pure function Load Pool itself calls,
        // so the two can never drift apart (matches Lash Out's own pattern).
        const total = (vitae != null && attempts != null) ? bloodBondPool(c, vitae, attempts).total : null;
        if (total != null) {
          html += `<div class="panel-total">Blood Potency <b>${bp}</b> − Vitae <b>${vitae}</b> − Attempts <b>${attempts}</b> = <b>${total}</b> dice</div>`;
          html += '<button class="pnl-confirm-btn" id="bloodbond-load">Load Pool</button>';
        }
        body.innerHTML = html;
        body.querySelectorAll('.bb-vitae-chip').forEach(btn => btn.addEventListener('click', () => { vitae = Number(btn.dataset.v); render(); }));
        body.querySelectorAll('.bb-attempt-chip').forEach(btn => btn.addEventListener('click', () => { attempts = Number(btn.dataset.a); render(); }));
        document.getElementById('bloodbond-load')?.addEventListener('click', () => {
          const { pi } = bloodBondPool(c, vitae, attempts);
          loadPool(pi.total, 'Blood Bond Resistance', pi);
        });
      };
      render();
    }
  } else if (mode === 'bloodsympathy') {
    // rcv.5: Detecting Blood Sympathy — two independent chip groups (Relation,
    // Approach), both visible at once, following the `lashout` branch's exact
    // structure rather than the recovered mockup's own two-screen-with-Back
    // wizard (this app has no sequential-step panel anywhere; see the story's
    // own Design source section). Pool = Wits + Blood Potency + tier mod.
    title.textContent = 'Detecting Blood Sympathy';
    if (!suiteState.rollChar) {
      body.innerHTML = '<div class="hempty" style="padding:24px 16px;">Select a character first</div>';
    } else {
      const c = suiteState.rollChar;
      // rcv.5: ported verbatim from the mockup (app.js:106-111).
      const BLOOD_SYMPATHY_TIERS = [
        { key: 'once', label: 'Once Removed', sub: 'Sire or childe', mod: 3 },
        { key: 'twice', label: 'Twice Removed', sub: 'Sibling, grandsire, or grandchilde', mod: 2 },
        { key: 'thrice', label: 'Thrice Removed', sub: "Cousin, sire's sibling, or great-grandsire/childe", mod: 1 },
        { key: 'four', label: 'Four Times Removed', sub: 'Clanmate', mod: 0 },
      ];
      let tier = null, forced = null;
      const render = () => {
        const witsV = getAttrVal(c, 'Wits');
        const bp = c.blood_potency || 0;
        let html = '<div class="panel-section">Relation</div><div class="vm-chip-wrap">';
        BLOOD_SYMPATHY_TIERS.forEach(t => {
          html += `<button class="mchip bs-tier-chip${tier === t.key ? ' on' : ''}" data-t="${esc(t.key)}">${esc(t.label)}<br><span class="bs-tier-sub">${esc(t.sub)}</span></button>`;
        });
        html += '</div><div class="panel-section">Approach</div><div class="vm-chip-wrap">';
        html += `<button class="mchip bs-force-chip${forced === false ? ' on' : ''}" data-f="0">Passive (free)</button>`;
        html += `<button class="mchip bs-force-chip${forced === true ? ' on' : ''}" data-f="1">Forced (1 WP)</button>`;
        html += '</div>';
        if (tier && forced !== null) {
          const t = BLOOD_SYMPATHY_TIERS.find(x => x.key === tier);
          const total = witsV + bp + t.mod;
          html += `<div class="panel-total">Wits <b>${witsV}</b> + Blood Potency <b>${bp}</b> + ${esc(t.label)} <b>${t.mod >= 0 ? '+' : ''}${t.mod}</b> = <b>${total}</b> dice</div>`;
          html += '<button class="pnl-confirm-btn" id="bloodsym-load">Load Pool</button>';
        }
        body.innerHTML = html;
        body.querySelectorAll('.bs-tier-chip').forEach(btn => btn.addEventListener('click', () => { tier = btn.dataset.t; render(); }));
        body.querySelectorAll('.bs-force-chip').forEach(btn => btn.addEventListener('click', () => { forced = btn.dataset.f === '1'; render(); }));
        document.getElementById('bloodsym-load')?.addEventListener('click', () => {
          const t = BLOOD_SYMPATHY_TIERS.find(x => x.key === tier);
          const total = witsV + bp + t.mod;
          const pi = {
            total, attr: 'Wits', attrV: witsV, skill: null, skillV: 0,
            discName: null, discV: 0, resistance: null, noWP: false,
            willpower_cost: forced ? 1 : 0,
            // rcv.5: ported from the mockup's own rules-summary text
            // (app.js:1256-1268), edited to describe all four tiers generally
            // rather than the mockup's own dynamic per-selection text (this
            // app's pi.effect is static per-tile, matching every other tile).
            effect: 'Detects a blood relative within the same city: sire or childe (+3), sibling, grandsire, or grandchilde (+2), cousin, a sire\'s sibling, or great-grandsire/childe (+1), or a clanmate (+0). Passive detection is free and ambient; forcing a connection to a specific target costs 1 Willpower. This roll cannot dramatically fail, regardless of pool size.\n\nSuccess: a vague impression of the relative\'s mental state and general direction. Exceptional success: also their rough distance, whether they have reached torpor or Final Death, and a single short sentence through the blood tie.',
            action: 'Instant action',
          };
          loadPool(total, 'Detecting Blood Sympathy', pi);
        });
      };
      render();
    }
  } else if (mode === 'custom') {
    // rlv.4 (#1039, D5) — free Attribute x Skill x Discipline ad-hoc pool
    // builder, for rolls with no pre-built pool button. Attribute is the
    // only mandatory chip; Skill and Discipline are each independently
    // optional and toggle off on a second tap. A 0-dot skill is a
    // deliberate, allowed choice (unskilledPenalty applies), not hidden.
    title.textContent = 'Custom Pool';
    if (!suiteState.rollChar) {
      body.innerHTML = '<div class="hempty" style="padding:24px 16px;">Select a character first</div>';
    } else {
      const c = suiteState.rollChar;
      const myDiscs = Object.entries(c.disciplines || {}).filter(([, v]) => (v?.dots || 0) > 0).map(([name, v]) => ({ name, dots: v.dots }));
      let attr = null, skill = null, disc = null, showAll = false;
      const render = () => {
        let html = '<div class="panel-section">Attribute</div><div class="vm-chip-wrap">';
        ALL_ATTRS.forEach(a => {
          html += `<button class="mchip cp-attr-chip${attr === a ? ' on' : ''}" data-a="${esc(a)}">${esc(a)}</button>`;
        });
        html += '</div>';

        const nonZero = ALL_SKILLS.filter(s => skTotal(c, s) > 0);
        const shown = showAll ? ALL_SKILLS : nonZero;
        html += `<div class="panel-section">Skill <button class="cp-showall-btn" id="cp-showall">${showAll ? 'non-zero only' : 'show all'}</button></div><div class="vm-chip-wrap">`;
        // Code review finding (Edge Case Hunter): a character with zero
        // non-zero skills rendered a bare empty row here, with nothing
        // telling the ST to tap "show all" to see any chips at all.
        if (!shown.length) {
          html += '<div class="hempty" style="padding:0 16px 8px;">No non-zero skills — tap "show all"</div>';
        }
        shown.forEach(s => {
          html += `<button class="mchip cp-skill-chip${skill === s ? ' on' : ''}" data-s="${esc(s)}">${esc(s)}</button>`;
        });
        html += '</div><div class="panel-section">Discipline</div>';
        html += myDiscs.length
          ? '<div class="vm-chip-wrap">' + myDiscs.map(d =>
              `<button class="mchip cp-disc-chip${disc === d.name ? ' on' : ''}" data-d="${esc(d.name)}">${esc(d.name)} (${d.dots})</button>`
            ).join('') + '</div>'
          : '<div class="hempty" style="padding:0 16px 8px;">No disciplines</div>';

        const attrV = attr ? getAttrVal(c, attr) : 0;
        const skillV = skill ? skTotal(c, skill) : 0;
        const unskilled = (skill && skillV === 0) ? unskilledPenalty(skill) : 0;
        const discDots = disc ? (myDiscs.find(d => d.name === disc)?.dots || 0) : 0;
        // Code review finding (Blind Hunter): a low Attribute + an unskilled
        // Mental skill (-3) can go negative (loadPool() itself clamps via
        // Math.max(0,...) on confirm, so this was never a real dice-count
        // bug, but the live preview text could show a nonsensical negative
        // number before that). Clamped here too, for display consistency.
        const total = Math.max(0, attrV + skillV + unskilled + discDots);

        if (attr) {
          const bits = [attr + ' ' + attrV];
          if (skill) bits.push(skill + ' ' + (unskilled ? unskilled : skillV) + (unskilled ? ' (unskilled)' : ''));
          if (disc) bits.push(disc + ' ' + discDots);
          html += `<div class="panel-total">${esc(bits.join(' + '))} = <b>${total}</b> dice</div>`;
          html += '<button class="pnl-confirm-btn" id="cp-load">Load Pool</button>';
        }
        body.innerHTML = html;
        body.querySelectorAll('.cp-attr-chip').forEach(btn => btn.addEventListener('click', () => { attr = attr === btn.dataset.a ? null : btn.dataset.a; render(); }));
        body.querySelectorAll('.cp-skill-chip').forEach(btn => btn.addEventListener('click', () => { skill = skill === btn.dataset.s ? null : btn.dataset.s; render(); }));
        body.querySelectorAll('.cp-disc-chip').forEach(btn => btn.addEventListener('click', () => { disc = disc === btn.dataset.d ? null : btn.dataset.d; render(); }));
        document.getElementById('cp-showall')?.addEventListener('click', () => { showAll = !showAll; render(); });
        document.getElementById('cp-load')?.addEventListener('click', () => {
          const label = [attr, skill, disc].filter(Boolean).join(' + ') || 'Custom Pool';
          // Review fix (Codex Pass 3a, AC5): the Rote badge is skill-specific
          // (PT dot-5 + asset skill), computable independent of how the pool
          // was assembled — roteEligibleFor() is the same function the
          // pre-built skill-pool tiles use, so an eligible skill picked here
          // gets the same Rote cue AC5 promises, not just named pools.
          const pi = { total, attr, attrV, skill: skill || null, skillV, unskilled: unskilled || null, discName: disc || null, discV: discDots, resistance: null, roteEligible: roteEligibleFor(c, skill), noWP: false };
          loadPool(total, label, pi);
        });
      };
      render();
    }
  }

  document.getElementById('panel-overlay').classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.getElementById('panel').style.transform = 'translateY(0)'
  ));
}

function closePanel() {
  const overlay = document.getElementById('panel-overlay');
  if (overlay) overlay.classList.remove('on');
  suiteState.panelMode = null;
}

function overlayClick(e) {
  if (e.target === document.getElementById('panel-overlay')) closePanel();
}

function pickChar(c) {
  suiteState.rollChar = c;
  const valEl = document.getElementById('sc-char-val');
  const lblEl = document.getElementById('sc-char-lbl');
  if (lblEl) lblEl.textContent = '';
  if (valEl) valEl.textContent = (c.moniker || c.name).split(' ')[0];
  // Update header character name
  const hdrName = document.getElementById('hdr-char-name');
  if (hdrName) hdrName.textContent = displayName(c);
  const scChar = document.getElementById('sc-char');
  if (scChar) scChar.classList.add('loaded');
  const discLbl = document.getElementById('sc-disc-lbl');
  if (discLbl) discLbl.textContent = 'Discipline';
  const discVal = document.getElementById('sc-disc-val');
  if (discVal) discVal.textContent = '';
  const scDisc = document.getElementById('sc-disc');
  if (scDisc) scDisc.classList.remove('loaded');
  const poolBanner = document.getElementById('pool-banner');
  if (poolBanner) poolBanner.classList.remove('on');
  suiteState.RESIST_CHAR = null;
  suiteState.RESIST_VAL = 0;
  suiteState.RESIST_MODE = null;
  const sec = document.getElementById('resist-sec');
  if (sec) sec.style.display = 'none';
  // rlv.7 review fix: resets POOL_INFO/POOL_NAME/powerChips/MOD together and
  // repaints — placed AFTER the RESIST_* resets above so its own updPool()
  // repaint doesn't briefly show a stale resistance segment. See
  // roll-v2.js's resetRollPool() for why leaving any one of these stale
  // after a character switch is a real bug, not cosmetic.
  resetRollPool();

  // Reset and re-init feeding (ST only — section hidden for players)
  // Legacy feed init removed — feeding is now in More grid (nav-2-5)

  // Render tappable pool chips in the roll tab for the selected character
  const rollPoolsEl = document.getElementById('roll-char-pools');
  if (rollPoolsEl) {
    renderCharPools(rollPoolsEl, c, (p, btn) => {
      // gdx.12: submit tiles (Humanity Check) POST-and-toast in place — no
      // panel, no roll, checked first same as the two gcp-panel call sites.
      if (p.submitAction === 'humanity_check') { submitHumanityCheck(c, btn); return; }
      // gdx-11 (#981, Task 8): see the identical routing comment at the
      // gcp-panel call site above — already on the roll tab here.
      if (p.opensPanel) { openPanel(p.opensPanel); return; }
      loadPool(p.total, p.label, p.pi || { total: p.total, attr: p.attr, attrV: p.attrV, skill: p.skill, skillV: p.skillV, nineAgain: p.nineAgain, resistance: p.resistance });
    });
    rollPoolsEl.style.display = '';
    // AC7: surfaces a "Load Pool" banner if this character has a resolved,
    // not-yet-loaded Humanity Check. Fire-and-forget — a convenience
    // surface, not blocking character load on a network round-trip.
    // Originally gated behind the (now-retired, rlv.2) new-roller flag —
    // roll-v2.js is the only player roller now, so this is unconditional.
    checkForResolvedHumanityCheck(c, rollPoolsEl);
  }

  // Show Auspex button if character has Auspex
  const auspexBtn = document.getElementById('sc-auspex');
  if (auspexBtn) auspexBtn.style.display = (c.disciplines?.Auspex?.dots || 0) > 0 ? '' : 'none';
}

// ══════════════════════════════════════════════
//  HEADER CHARACTER MENU
// ══════════════════════════════════════════════

function _visibleChars() {
  const role = effectiveRole();
  let list;
  if (role === 'st') {
    list = editorState.chars.map((c, i) => ({ c, i }));
  } else {
    const ids = getPlayerInfo()?.character_ids || [];
    list = editorState.chars
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => ids.includes(String(c._id)));
  }
  return list.sort((a, b) => sortName(a.c).localeCompare(sortName(b.c)));
}

function _buildCharMenu() {
  const wrap = document.getElementById('hdr-icon-wrap');
  const menu = document.getElementById('hdr-char-menu');
  const visible = _visibleChars();
  const hasMultiple = visible.length > 1;

  // Phone header icon dropdown
  if (wrap && menu) {
    if (!hasMultiple) {
      wrap.classList.remove('has-menu');
      wrap.onclick = null;
      menu.style.display = 'none';
    } else {
      wrap.classList.add('has-menu');
      wrap.onclick = (e) => {
        e.stopPropagation();
        const showing = menu.style.display !== 'none';
        menu.style.display = showing ? 'none' : '';
        if (!showing) _renderCharMenuItems();
      };
    }
  }

  // Desktop sidebar character selector
  const sbSel = document.getElementById('sidebar-char-sel');
  if (sbSel) {
    if (!hasMultiple) {
      sbSel.style.display = 'none';
      sbSel.innerHTML = '';
    } else {
      sbSel.style.display = '';
      const activeId = String(suiteState.sheetChar?._id || '');
      let h = '<select id="sidebar-char-select">';
      visible.forEach(({ c, i }) => {
        const sel = String(c._id) === activeId ? ' selected' : '';
        h += `<option value="${i}"${sel}>${esc(dropdownName(c))}</option>`;
      });
      h += '</select>';
      sbSel.innerHTML = h;
      sbSel.querySelector('#sidebar-char-select')?.addEventListener('change', e => {
        const idx = parseInt(e.target.value, 10);
        if (!isNaN(idx) && editorState.chars[idx]) _switchChar(idx);
      });
    }
  }
}

function _renderCharMenuItems() {
  const menu = document.getElementById('hdr-char-menu');
  if (!menu) return;
  const visible = _visibleChars();
  const activeId = String(suiteState.sheetChar?._id || '');
  let h = '';
  visible.forEach(({ c, i }) => {
    const isActive = String(c._id) === activeId;
    h += `<button class="hdr-char-menu-item${isActive ? ' active' : ''}" data-char-idx="${i}">`;
    h += `<span class="hdr-menu-check">${isActive ? '\u2713' : ''}</span>`;
    h += `<span>${esc(dropdownName(c))}</span>`;
    h += `</button>`;
  });
  menu.innerHTML = h;

  // Wire clicks
  menu.querySelectorAll('[data-char-idx]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.charIdx, 10);
      if (isNaN(idx) || !editorState.chars[idx]) return;
      _switchChar(idx);
      menu.style.display = 'none';
    });
  });
}

async function _switchChar(idx) {
  const c = editorState.chars[idx];
  if (!c) return;
  localStorage.setItem('tm_active_char', String(c._id));

  // Remember current tab so we stay on it
  const currentTab = document.querySelector('.tab.active')?.id?.replace('t-', '') || null;

  // Load tracker from API before rendering
  await ensureTrackerLoaded(c);

  // Update state without navigating
  editorState.editIdx = idx;
  suiteState.sheetChar = c;
  suiteState.rollChar = c;
  pickChar(c);

  // Editor sheet (STs only)
  if (getRole() === 'st') {
    renderIdentityTab(c);
    renderAttrsTab(c);
    editorRenderSheet(c);
  }

  // Suite sheet — renders into both desktop full sheet and phone split tabs
  document.getElementById('sh-empty').style.display = 'none';
  document.getElementById('sh-content-suite').style.display = '';
  suiteRenderSheet();

  // Pools panel
  const poolsEl = document.getElementById('gcp-panel');
  if (poolsEl) {
    renderCharPools(poolsEl, c, (p, btn) => {
      // gdx.12: see the identical submitAction check at the openChar() call
      // site above — same reasoning, checked before goTab('roll') here too.
      if (p.submitAction === 'humanity_check') { submitHumanityCheck(c, btn); return; }
      // gdx-11 (#981, Task 8): see the identical routing comment at the
      // openChar() call site above.
      goTab('roll');
      if (p.opensPanel) { openPanel(p.opensPanel); return; }
      loadPool(p.total, p.label, p.pi || { total: p.total, attr: p.attr, attrV: p.attrV, skill: p.skill, skillV: p.skillV, nineAgain: p.nineAgain, resistance: p.resistance });
    });
  }

  // Clear MISC past outcomes so they reload for the new character
  const miscEl = document.getElementById('misc-past-outcomes');
  if (miscEl) miscEl.innerHTML = '';

  // Update header name
  const hdrName = document.getElementById('hdr-char-name');
  if (hdrName) hdrName.textContent = displayName(c);

  // Re-render status tab if currently active
  if (currentTab === 'status') {
    renderSuiteStatusTab(document.getElementById('t-status'));
  }

  // Stay on current tab — don't navigate away
  if (currentTab) goTab(currentTab);
}

// Close character menu on outside click
document.addEventListener('click', () => {
  const menu = document.getElementById('hdr-char-menu');
  if (menu) menu.style.display = 'none';
});

// ══════════════════════════════════════════════
//  REGISTER CALLBACKS (editor — break circular deps)
// ══════════════════════════════════════════════

registerEditCallbacks(markDirty, editorRenderSheet);
registerExportCallbacks(renderList, updDirtyBadge);
registerIdentityCallbacks(markDirty);
registerAttrsCallbacks(markDirty);

// Wire up suite import callbacks
setImportCallbacks({
  loadChars,
  toast,
});

// ══════════════════════════════════════════════
//  WINDOW REGISTRATION (merged)
// ══════════════════════════════════════════════

Object.assign(window, {
  // Unified navigation
  goTab,
  showEditTab,
  openChar,
  filterList,

  // Editor persistence
  syncToSuite,
  saveAll,
  downloadCSV,

  // Editor sheet view (prefixed where needed)
  editFromSheet,
  printSheet,
  printPDF,
  exportJSON,
  renderSheet: editorRenderSheet,
  toggleExp: editorToggleExp,
  toggleDisc: editorToggleDisc,

  // Editor edit handlers
  shEdit,
  shEditStatus,
  shEditBaneName,
  shEditBaneEffect,
  shRemoveBane,
  shAddBane,
  shTouchstoneStartAdd,
  shTouchstoneStartEdit,
  shTouchstonePickerClose,
  shTouchstonePickerDraft,
  shTouchstoneSaveAdd,
  shTouchstoneSaveEdit,
  shTouchstoneRemove,
  shEditBP, shEditBPCreation, shEditBPXP, shEditBPLost,
  shEditHumanity, shEditHumanityXP, shEditHumanityLost,
  shStatusUp,
  shStatusDown,
  shToggleOrdeal,
  shSetPriority,
  shSetClanAttr,
  shEditAttrPt,
  shSetSkillPriority,
  shEditSkillPt,
  shEditSpec,
  shRemoveSpec,
  shAddSpec,
  shEditDiscPt,
  shShowDevSelect,
  shAddDevotion,
  shRemoveDevotion,
  shEditInflMerit,
  shEditContactSphere,
  shRemoveInflMerit,
  shAddInflMerit,
  shEditDomMerit,
  shRemoveDomMerit,
  shAddDomMerit,
  shSetWhiteAntsTerritory,
  shSetTrapDoorAnchor,
  shAddDomainPartner,
  shRemoveDomainPartner,
  shEditGenMerit,
  shRemoveGenMerit,
  shAddGenMerit,
  shEditStandMerit,
  shEditStandAssetSkill,
  shToggleMCI, shTogglePT,
  shEditMCIDot, shRemoveStandMerit, shAddStandMCI, shAddStandPT,
  shEditMeritPt, shStepMeritRating,
  shEditXP,
  shAddEquip, shRemoveEquip, shEquipBucketFilter,

  // Editor attributes & skills tab
  clickAttrDot,
  clickSkillDot,
  toggleNineAgain,
  updSkillSpec,

  // Editor identity tab
  updField,
  updStatus,

  // Editor dirty state
  markDirty,

  // Suite navigation & panels
  openPanel,
  closePanel,
  overlayClick,
  pickChar,

  // Suite data
  loadChars,
  renderImportBanner,
  clearImport,

  // Suite roll tab
  chgPool,
  chgMod,
  updPool,
  setAgain,
  setAgainSeg,
  togMod,
  togSpec,
  doRoll,
  clrHist,
  loadPool,
  effPool,
  togEquipChip,
  updWeaponRef,
  spendVitae,
  spendWillpower,
  addPowerChip,
  togPowerChip,
  removePowerChip,

  // Suite sheet tab
  onSheetChar,
  suiteRenderSheet,
  suiteToggleExp,
  suiteToggleDisc,

  // Suite resistance
  updResist,
  showResistSec,

  // Toast
  toast,

  // Suite feeding (ST only, in Roll tab)
  // feedToggle/feedInit etc removed — feeding consolidated to More grid (nav-2-5)

  // Suite import
  handleImport: _handleImport,
  handleDtImport: _handleDtImport,

  // Suite territory
  mountTerr,
  _mountTerr: mountTerr,
  toggleDesktopMode,
  renderDesktopSidebar,
  toggleTheme,
  renderMoreGrid,
  renderSheetPicker,
  openSheetChar,
  showPlayerSheet,

  // Game — live tracker
  trackerReset,
  trackerAdj,
  trackerAddCondition,
  trackerRemoveCond,
  trackerToggle,

  // Game — sheet/DT toggle
  setSheetView,

  // Game — contested roll
  openContestedRoll,
  closeContestedRoll,
  crSetType,
  crSetChar,
  crAdjPool,
  crRoll,
});

// ══════════════════════════════════════════════
//  AUTH GATE + INIT
// ══════════════════════════════════════════════

async function boot() {
  // rlv.2 (2026-08-24): confirms which roller module is active on this
  // device. Console-only, deliberately not a player-facing badge — there
  // is only one roller now, this is a dev/ST diagnostic, not a UI feature.
  console.log('[dice roller] roll-v2.js active');

  // Suppress iOS PWA edge-swipe creating blank split-view windows.
  // In standalone mode, touches starting within 20px of either edge are
  // consumed so iOS doesn't interpret them as back/forward navigation.
  if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) {
    document.addEventListener('touchstart', e => {
      const x = e.touches[0]?.clientX;
      if (x != null && (x < 20 || x > window.innerWidth - 20)) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const errorEl = document.getElementById('login-error');

  // Close profile dropdown on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#hdr-profile') && !e.target.closest('#hdr-profile-menu')) {
      const menu = document.getElementById('hdr-profile-menu');
      if (menu) menu.style.display = 'none';
    }
  });

  if (isLoggedIn()) {
    const valid = await validateToken();
    if (valid) {
      // Keep login screen visible during boot so the user never sees a
      // wrong-mode chrome flash or an empty content area. Reveal #app only
      // after _initDesktopMode() has set body classes AND goTab() has
      // painted the first tab.
      // The login-screen element ships with inline `display:none` in the HTML
      // (and the CSS rule has no !important), so we have to explicitly clear
      // the inline style here — otherwise the Loading… indicator and the
      // catch-path error message render against an invisible element.
      loginScreen.style.display = '';
      const loginBtn = document.getElementById('login-btn');
      const originalLoginHTML = loginBtn?.outerHTML;
      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Loading…';
      }

      try {
        applyRoleRestrictions();
        if (localStorage.getItem('tm_auth_token') === 'local-test-token') {
          await import('./dev-fixtures.js');
        }
        await loadAllData();
        renderList();
        renderImportBanner();
        renderUserHeader();
        _buildCharMenu();
        // Desktop mode must be initialised before rendering so sheet.js
        // knows whether to render into the full sheet or split tabs.
        _initDesktopMode();
        _updateThemeIcon();

        // Auto-open a character so split tabs and dice roller are ready.
        // Players: always (saved selection or first linked char).
        // STs: only if they have a previously saved selection (don't randomly
        // pick someone else's character for them).
        const isDesktop = DESKTOP_MQ.matches;
        const isST = getRole() === 'st';
        if (editorState.chars.length > 0) {
          const savedCharId = localStorage.getItem('tm_active_char');
          const savedIdx = savedCharId
            ? editorState.chars.findIndex(c => String(c._id) === savedCharId)
            : -1;
          const charIdx = !isST ? (savedIdx >= 0 ? savedIdx : 0) : savedIdx;
          if (charIdx >= 0) {
            await ensureTrackerLoaded(editorState.chars[charIdx]);
            openChar(charIdx);
            pickChar(editorState.chars[charIdx]);
            _buildCharMenu(); // re-render sidebar with sheetChar now set (closes #230)
          }
        }
        // Desktop: STs → character grid, players → sheet.
        // Phone: players → stats (split tab) or, gdx-9 flag on, the same
        // 'sheets' destination desktop already uses (single-scroll mode).
        // STs → dice (works without a character).
        const hasChar = !!suiteState.sheetChar;
        const gdx9SingleScroll = !isDesktop && singleScrollEnabled();
        goTab(isDesktop
          ? (!isST && hasChar ? 'sheets' : 'chars')
          : (hasChar ? (gdx9SingleScroll ? 'sheets' : 'stats') : 'roll'));

        // Atomic reveal — first paint already committed, body class already set.
        loginScreen.style.display = 'none';
        app.style.display = '';

        renderLifecycleCards(); // non-blocking
        checkMoreBadge();       // non-blocking
        // crd.2: one boot-time read so the Challenges tile can carry a live
        // badge before the player ever opens the queue. The 10s poll itself
        // only runs while the queue tab is actually being looked at.
        if (getRole() !== 'st') refreshPendingQueueBadge().then(checkMoreBadge);

        // Start WebSocket for live tracker sync
        initWS({
          onTrackerUpdate: (charId) => {
            // Patch just the affected tracker card (not full tab rebuild)
            refreshTrackerCard(charId);
            // Repaint sheet tracker boxes if this is the current sheet char
            if (String(suiteState.sheetChar?._id) === charId) repaintSheetTrackers();
          },
          // STM-9 (issue #416, ADR-004 Rev 3 §D11): on remote st_mod
          // create/revoke, re-apply the overlay for the affected
          // character and refresh the sheet tracker boxes if that
          // char is the open sheet. The roll calculator's pool
          // values come from accessor reads on the in-memory char
          // (post-#413 D8 cache-entry invariant), so just re-running
          // applyOverlayToAll on the single char is enough for all
          // downstream surfaces to see the new state on next render.
          // Issue #425 / STM-14 (#1034): shared with the sheet's own
          // apply-bonus affordance via refreshCharacterOverlay.
          onStModUpdate: refreshCharacterOverlay,
          // ECM-4 (#871): on remote equipment_catalogue create/update/delete
          // (broadcast by the admin catalogue UI via server/ws.js's
          // broadcastCatalogueUpdate), refetch the cache. Next render of
          // the DT form's equipment dropdown picks up the fresh items.
          onCatalogueUpdate: () => { refetchEquipmentCatalogue(); },
          // gdx.5 (#986): on any remote app_settings PATCH (broadcast by
          // server/ws.js's broadcastSettingsUpdate), refetch the cache so
          // an ST's game_in_progress toggle (or st_mods_enabled) reaches
          // every open tab without a reload.
          onSettingsUpdate: () => { loadGlobalSettings(); },
          // BL-4 (issue #1008): on remote bloodlines create/update/delete,
          // refetch the cache. The player app matters as much as the admin
          // one here: the DT form free-rides on this boot path's priming
          // (documented at downtime-form.js:36), so without this an ST adding
          // a bloodline mid-session would not reach an open DT form until the
          // player reloads, and there is no second chance. refetchBloodlines
          // preserves the last good index on failure by design.
          onBloodlineUpdate: () => { refetchBloodlines(); },
          // prax.4b (Epic PRAX, AC16): a Praxis resolution mass-clears every
          // Enforcer, Administrator and City Harpy seat at once, so an open
          // Office tab is showing a seat that may no longer have a holder -
          // wrong purchase controls, wrong budget preview, wrong "your office"
          // banner. Passed straight to the office-tab module, which no-ops until
          // that tab has been rendered at least once this session (same guard
          // the admin app's own roll-feed and Praxis callbacks use, for the same
          // reason: nothing to paint into before the first render).
          //
          // The frame is ST/dev-only at the transport layer (server/ws.js's
          // `_fanOutRoles`), so a player socket never receives it and this
          // callback simply never fires for them.
          onPraxisResolved: () => { onOfficeTabPraxisResolved(); },
          // Epic PRAX (2026-09-01): live board sync between multiple STs
          // working the Praxis tab at once, mirroring admin.js's own
          // onPraxisUpdate wiring. No-ops via the optional-chain call until
          // initPraxisSurface has loaded the module at least once this
          // session - nothing to repaint into before then.
          onPraxisUpdate: (sessionId) => { _gameAppPraxisUpdate?.(sessionId); },
        });

        // Issue #425: install the STM popover delegated click handler for
        // the suite app. STM-4 wired admin + player but not the suite;
        // without this, suite-sheet markers emit data-stm-marker-path but
        // nothing opens the popover on click. Single listener on
        // document.body (idempotent across re-renders).
        installStModPopover(document.body, refreshCharacterOverlay);
        return;
      } catch (err) {
        // Mid-flight failure: leave the user on the login screen with a
        // working button rather than a permanently-hidden #app.
        console.error('[boot] post-auth setup failed', err);
        // Belt-and-braces: ensure the login screen is visible even if a
        // future refactor moves or removes the unhide above.
        loginScreen.style.display = '';
        if (errorEl) errorEl.textContent = 'Could not load app. Please try again.';
        if (loginBtn && originalLoginHTML) {
          loginBtn.outerHTML = originalLoginHTML;
          const restored = document.getElementById('login-btn');
          if (restored) restored.addEventListener('click', login);
        }
        return;
      }
    }
  }

  // Show login screen
  loginScreen.style.display = '';
  app.style.display = 'none';
  document.getElementById('login-btn').addEventListener('click', login);
}

/** Apply nav and UI visibility for the current effective role. Idempotent — safe to call multiple times. */
function applyRoleRestrictions() {
  const role = effectiveRole();
  const isST = role === 'st';
  const isRealST = getRole() === 'st';

  // Tracker boxes: interactive for STs, read-only for players
  document.body.classList.toggle('tracker-readonly', !isST && getRole() !== 'dev');

  // Rebuild the scrollable bottom nav with role-appropriate items
  renderBottomNav();

  // Surface stylesheets (ADR-008 D9): applied only while the *effective* role is
  // ST, so an ST in player preview does not have admin rules apply to player
  // markup. Reuses `role` above rather than calling effectiveRole() again.
  applySurfaceSheetVisibility(role === 'st' || role === 'dev');

  // Contested Roll — ST only (Feeding is now in More grid)
  const btnContested = document.getElementById('btn-contested');
  if (btnContested) btnContested.style.display = isST ? '' : 'none';

  // ST Admin link — always visible to real STs regardless of view mode
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.style.display = isRealST ? '' : 'none';

  // Sheet topbar — hide for players
  const topbar = document.querySelector('.sheet-topbar');
  if (topbar) topbar.style.display = isST ? '' : 'none';

  // Character list — restrict to player's own characters in player mode
  if (!isST) {
    const info = getPlayerInfo();
    setListLimit(info?.character_ids || []);
    const toolbar = document.querySelector('.list-toolbar');
    if (toolbar) toolbar.style.display = 'none';
  } else {
    setListLimit([]);
    const toolbar = document.querySelector('.list-toolbar');
    if (toolbar) toolbar.style.display = '';
  }

  // Update toggle button label
  const toggleBtn = document.getElementById('btn-view-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = isST ? 'Player View' : 'ST View';
    toggleBtn.classList.toggle('view-toggle-active', !isST);
  }
}

// ── More grid app launcher (Story 1.3) ────────────────────────────────────────

// SVG icons — monochrome, stroke-based, currentColor. Consistent with bottom nav.
const _svg = {
  status:   '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
  whosWho:  '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  dtReport: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  feeding:  '<svg viewBox="0 0 24 24"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
  // dtSubmit / ordeals icons removed 2026-08-29 alongside their nav tiles.
  tracker:  '<svg viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="18" r="2" fill="currentColor"/></svg>',
  signin:   '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>',
  emergency:'<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.89 12 19.79 19.79 0 0 1 1.84 3.4 2 2 0 0 1 3.81 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  regency:  '<svg viewBox="0 0 24 24"><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M6 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0z"/><path d="M18 5a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/></svg>',
  office:   '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
};

// section: 'game' | 'player' | 'st'
// Render order: game → player (if visible) → st (if visible)
// The 'lore' section went with #1135, which deleted its only three tiles
// (Primer, Game Guide, Rules). Both render sites skip a section with no
// visible apps, so an empty section never produces a bare header.
const MORE_APPS = [
  // ── Game section ──
  // Note: Status is a primary nav tab — not duplicated here
  { id: 'feeding',      label: 'Feeding',     icon: _svg.feeding,  section: 'game' },
  { id: 'territory',    label: 'Territory',   icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>', section: 'st', stOnly: true },
  { id: 'office-approvals', label: 'Approval Queue', icon: '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>', section: 'st', stOnly: true },
  // ── Player section (player role only) ──
  // 'downtime' and 'ordeals' More-grid tiles removed 2026-08-29 (Angelus):
  // both features moved to TM Story entirely, not just gated/dimmed.
  // crd.2 — the defender's own pending contested-roll queue. Deliberately a
  // More-grid tile and NOT a bottom-nav item: it is something a player checks
  // on their own terms, which is the whole point of replacing the modal that
  // used to interrupt them. Badge follows the Downtime entry's established
  // shape exactly: a pure read of a cache the boot path primed, never a fetch
  // from inside the badge callback (renderMoreGrid calls it on every render).
  // A shield, not the Combat tab's crossed blades: this is the defence surface.
  { id: 'contested-queue', label: 'Challenges', icon: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>', section: 'player',
    badge: () => hasPendingChallenges()
  },
  // Challenge tile hidden (#1015). The click-handler + modal (openChallengeModal) remain wired for future programmatic use.
  // ── Storyteller section (ST role only) ──
  { id: 'tracker',      label: 'Tracker',     icon: _svg.tracker,  section: 'st', stOnly: true },
  { id: 'combat',       label: 'Combat',      icon: '<svg viewBox="0 0 24 24"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M2 2l20 20"/><path d="M3 14l7-7"/></svg>', section: 'st', stOnly: true },
  { id: 'spheres',      label: 'Spheres',     icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/></svg>', section: 'st', stOnly: true },
  // Epic PRAX (2026-09-01): reuses admin/praxis-tab.js unmodified, same
  // lazy-import + on-demand stylesheet pattern as 'spheres' above.
  { id: 'praxis',       label: 'Vote',        icon: '<svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.6L21 9l-5 4.4L17.4 21 12 17.3 6.6 21 8 13.4 3 9l6.4-.4z"/></svg>', section: 'st', stOnly: true },
  { id: 'signin',       label: 'Check-In',    icon: _svg.signin,   section: 'st', coordinatorOnly: true },
  { id: 'emergency',    label: 'Emergency',   icon: _svg.emergency,section: 'st', coordinatorOnly: true },
  // ── Conditional apps (section determined by context) ──
  { id: 'regency',      label: 'Regency',     icon: _svg.regency,  section: 'game', condition: 'hasRegency' },
  { id: 'office',       label: 'Office',      icon: _svg.office,   section: 'game' },
  { id: 'archive',      label: 'Story',       icon: '<svg viewBox="0 0 24 24"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>', section: 'player' },
];

const MORE_SECTIONS = [
  { id: 'game',   label: 'Game' },
  { id: 'player', label: 'Player' },
  { id: 'st',     label: 'Storyteller' },
];

function _moreGridCondition(app) {
  if (app.playerOnly && getRole() === 'st') return false;
  if (!app.condition) return true;
  // STs see all conditional apps — conditions only gate player view
  if (getRole() === 'st') return true;
  const chars = suiteState.chars || [];
  const info = getPlayerInfo();
  const myChar = chars.find(c => info?.character_ids?.includes(c._id) || info?.character_ids?.includes(String(c._id)));
  if (app.condition === 'hasRegency') {
    // Regent if their character _id matches a territory's regent_id
    const terrs = suiteState.territories || [];
    return !!(myChar && findRegentTerritory(terrs, myChar));
  }
  return true;
}

// ── Settings tab ────────────────────────────────────────────────────────────

const FONT_SIZE_KEY = 'tm-reading-font-size';
const FONT_SIZES = [
  { value: '13px', label: 'Small' },
  { value: '15px', label: 'Default' },
  { value: '17px', label: 'Large' },
  { value: '19px', label: 'X-Large' },
];

function _getReadingFontSize() {
  return localStorage.getItem(FONT_SIZE_KEY) || '15px';
}

function _applyReadingFontSize(size) {
  localStorage.setItem(FONT_SIZE_KEY, size);
  document.documentElement.style.setProperty('--reading-font-size', size);
}

// Apply saved font size on load
(function() {
  const saved = _getReadingFontSize();
  if (saved !== '15px') document.documentElement.style.setProperty('--reading-font-size', saved);
})();

function renderSettingsTab() {
  const el = document.getElementById('t-settings');
  if (!el) return;
  const user = getUser();
  const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const currentFontSize = _getReadingFontSize();

  const avatarUrl = user?.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : user?.id
      ? `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`
      : '';

  let h = '<div class="settings-wrap">';
  h += '<h3 class="settings-title">Settings</h3>';

  // Profile
  if (user) {
    h += '<div class="settings-section">';
    h += '<div class="settings-section-label">Profile</div>';
    h += '<div class="settings-profile">';
    if (avatarUrl) h += `<img class="settings-avatar" src="${avatarUrl}" alt="">`;
    h += `<div class="settings-profile-info">`;
    h += `<span class="settings-name">${esc(user.global_name || user.username)}</span>`;
    h += `<span class="settings-role">${user.role === 'st' ? 'Storyteller' : 'Player'}</span>`;
    h += `</div>`;
    h += '</div>';
    h += `<button class="settings-btn settings-logout" onclick="logout()">Log Out</button>`;
    h += '</div>';
  }

  // Player Mode toggle (ST/dev only)
  if (getRole() === 'st' || getRole() === 'dev') {
    const isPlayerMode = _viewMode === 'player';
    h += '<div class="settings-section">';
    h += '<div class="settings-section-label">View Mode</div>';
    h += '<label class="settings-checkbox-row">';
    h += `<input type="checkbox" id="settings-player-mode"${isPlayerMode ? ' checked' : ''}>`;
    h += '<span>Player Mode <span style="font-size:11px;color:var(--txt3)">\u2014 view as a player sees it</span></span>';
    h += '</label>';
    h += '</div>';
  }

  // Emergency Contact / Safety Info
  h += '<div class="settings-section">';
  h += '<div class="settings-section-label">Safety &amp; Emergency Contact</div>';
  h += '<div class="settings-section-hint">Only visible to Storytellers. Used for live game safety.</div>';
  h += '<div class="settings-safety-form" id="settings-safety-form">';
  h += '<div class="settings-safety-row"><label class="settings-safety-lbl" for="saf-email">Email</label><input class="settings-input" id="saf-email" type="email" placeholder="your@email.com"></div>';
  h += '<div class="settings-safety-row"><label class="settings-safety-lbl" for="saf-mobile">Mobile</label><input class="settings-input" id="saf-mobile" type="tel" placeholder="+61 4xx xxx xxx"></div>';
  h += '<div class="settings-safety-row"><label class="settings-safety-lbl" for="saf-ec-name">Emergency Contact</label><input class="settings-input" id="saf-ec-name" type="text" placeholder="Name"></div>';
  h += '<div class="settings-safety-row"><label class="settings-safety-lbl" for="saf-ec-mobile">Emergency Mobile</label><input class="settings-input" id="saf-ec-mobile" type="tel" placeholder="+61 4xx xxx xxx"></div>';
  h += '<div class="settings-safety-row"><label class="settings-safety-lbl" for="saf-medical">Medical Info</label><textarea class="settings-input" id="saf-medical" rows="2" placeholder="Allergies, conditions, etc."></textarea></div>';
  h += '<div class="settings-safety-actions"><button class="settings-btn" id="saf-save">Save</button><span class="settings-safety-status" id="saf-status"></span></div>';
  h += '</div>';
  h += '</div>';

  // Theme
  h += '<div class="settings-section">';
  h += '<div class="settings-section-label">Theme</div>';
  h += '<div class="settings-toggle-row">';
  h += `<button class="settings-toggle-btn${currentTheme === 'light' ? ' on' : ''}" data-theme="light">Light</button>`;
  h += `<button class="settings-toggle-btn${currentTheme === 'dark' ? ' on' : ''}" data-theme="dark">Dark</button>`;
  h += '</div>';
  h += '</div>';

  // Reading font size
  h += '<div class="settings-section">';
  h += '<div class="settings-section-label">Reading Font Size</div>';
  h += '<div class="settings-section-hint">Applies to Story, Archive and other reading panes.</div>';
  h += '<div class="settings-toggle-row">';
  for (const fs of FONT_SIZES) {
    h += `<button class="settings-toggle-btn${currentFontSize === fs.value ? ' on' : ''}" data-fontsize="${fs.value}">${fs.label}</button>`;
  }
  h += '</div>';
  h += '</div>';

  // #1135 removed the "Show Primer, Guide & Rules tabs" toggle: all three of its
  // targets were deleted, so it persisted a preference that could not change
  // anything visible. rlv.2 (2026-08-24) removed the "Use new dice roller"
  // toggle the same way — roll-v2.js is the only roller now, there is
  // nothing left to switch.

  // ST Admin link
  if (getRole() === 'st') {
    h += '<div class="settings-section">';
    h += '<a href="/admin" class="settings-btn">ST Admin Panel</a>';
    h += '</div>';
  }

  h += '</div>';
  el.innerHTML = h;

  // Wire theme toggles
  el.querySelectorAll('[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('tm-theme', 'dark');
      } else {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('tm-theme', 'light');
      }
      renderSettingsTab();
    });
  });

  // Wire font size toggles
  el.querySelectorAll('[data-fontsize]').forEach(btn => {
    btn.addEventListener('click', () => {
      _applyReadingFontSize(btn.dataset.fontsize);
      renderSettingsTab();
    });
  });

  // Load and wire safety/emergency contact form
  _loadSafetyForm(el);

  // Wire player mode toggle
  el.querySelector('#settings-player-mode')?.addEventListener('change', e => {
    _viewMode = e.target.checked ? 'player' : 'st';
    sessionStorage.setItem(VIEW_MODE_KEY, _viewMode);
    applyRoleRestrictions();
    _buildCharMenu();
    if (e.target.checked) {
      _enterPlayerView();
    } else {
      _enterSTView();
    }
    renderSettingsTab();
  });

}

async function _loadSafetyForm(container) {
  const emailEl   = container.querySelector('#saf-email');
  const mobileEl  = container.querySelector('#saf-mobile');
  const ecNameEl  = container.querySelector('#saf-ec-name');
  const ecMobEl   = container.querySelector('#saf-ec-mobile');
  const medEl     = container.querySelector('#saf-medical');
  const saveBtn   = container.querySelector('#saf-save');
  const statusEl  = container.querySelector('#saf-status');
  if (!emailEl) return;

  // Load current values
  try {
    const me = await apiGet('/api/players/me');
    if (me) {
      emailEl.value   = me.email || '';
      mobileEl.value  = me.mobile || '';
      ecNameEl.value  = me.emergency_contact_name || '';
      ecMobEl.value   = me.emergency_contact_mobile || '';
      medEl.value     = me.medical_info || '';
    }
  } catch { /* first time — fields stay empty */ }

  // Save handler
  saveBtn?.addEventListener('click', async () => {
    statusEl.textContent = 'Saving\u2026';
    statusEl.style.color = 'var(--txt3)';
    try {
      await apiPut('/api/players/me', {
        email: emailEl.value.trim() || null,
        mobile: mobileEl.value.trim() || null,
        emergency_contact_name: ecNameEl.value.trim() || null,
        emergency_contact_mobile: ecMobEl.value.trim() || null,
        medical_info: medEl.value.trim() || null,
      });
      statusEl.textContent = 'Saved';
      statusEl.style.color = 'var(--green2, #7EC8A0)';
      setTimeout(() => { statusEl.textContent = ''; }, 2500);
    } catch (err) {
      statusEl.textContent = 'Failed: ' + (err.message || 'unknown');
      statusEl.style.color = 'var(--crim)';
    }
  });
}

function renderMoreGrid() {
  const el = document.getElementById('t-more');
  if (!el) return;

  const role = effectiveRole();
  const isST = role === 'st' || role === 'dev';
  const isCoord = role === 'st' || role === 'dev' || role === 'coordinator';

  function appVisible(app) {
    if (app.stOnly && !isST) return false;
    if (app.coordinatorOnly && !isCoord) return false;
    if (app.playerOnly && isST) return false;
    if (app.condition && !_moreGridCondition(app)) return false;
    return true;
  }

  function appIcon(app) {
    const hasBadge = typeof app.badge === 'function' && app.badge();
    const badgeDot = hasBadge ? '<span class="nav-badge visible"></span>' : '';
    const admin = (app.stOnly || app.coordinatorOnly) ? ' more-app-admin-tier' : '';
    // Generic "retired but still visible, dimmed" support for a MORE_APPS
    // entry; kept as reusable plumbing. 2026-08-29: no current entry sets
    // `retired` (Downtime and Ordeals, its only past users, were removed
    // outright rather than dimmed).
    const isRetired = !isST && typeof app.retired === 'function' && app.retired();
    const retired = isRetired ? ' more-app-retired' : '';
    const titleAttr = isRetired ? ` title="${esc(app.retiredReason || '')}"` : '';
    return `<button class="more-app-icon${admin}${retired}" data-app="${app.id}" onclick="goTab('${app.id}')"${titleAttr}>` +
      `<span class="more-app-icon-svg">${app.icon}</span>` +
      `<span class="more-app-label">${app.label}</span>` +
      badgeDot +
      '</button>';
  }

  let h = '<div class="more-grid-wrap">';
  for (const section of MORE_SECTIONS) {
    const sectionApps = MORE_APPS.filter(a => a.section === section.id && appVisible(a));
    if (!sectionApps.length) continue;
    h += `<div class="more-section">`;
    h += `<div class="more-section-label">${section.label}</div>`;
    h += `<div class="more-section-grid">`;
    h += sectionApps.map(appIcon).join('');
    h += `</div></div>`;
  }
  h += '</div>';
  el.innerHTML = h;
}

// ── More tab badge (nav-3-3) ──────────────────────────────────────────────────

async function checkMoreBadge() {
  const badge = document.getElementById('more-badge');
  if (!badge) return;

  const { nextSession, activeCycle, mySubmission } = await _loadLifecycleData();
  const today = new Date().toISOString().slice(0, 10);

  let hasBadge = false;

  // Feeding phase open and player hasn't rolled
  if (nextSession?.session_date >= today && !mySubmission?.feeding_roll_player) {
    hasBadge = true;
  }

  // Unread DT narrative — published outcome the player hasn't viewed
  if (!hasBadge && mySubmission?.published_outcome) {
    const lastViewed = localStorage.getItem('tm-last-viewed-sub');
    if (String(mySubmission._id) !== lastViewed) hasBadge = true;
  }

  // crd.2: a pending contested-roll challenge still lights #more-badge. The
  // retired modal module used to write this element directly (and clobbered the
  // class-based toggle above with its own inline display, which is why the two
  // signals fought each other). Reading the queue's cache here keeps the entry
  // point players already have muscle memory for, with one owner of the element.
  if (!hasBadge && hasPendingChallenges()) hasBadge = true;

  badge.classList.toggle('visible', hasBadge);
}

function _markSubViewed() {
  const { mySubmission } = _lifecycleCache || {};
  if (mySubmission?._id) {
    localStorage.setItem('tm-last-viewed-sub', String(mySubmission._id));
    checkMoreBadge();
    renderMoreGrid();
  }
}

// ── Desktop mode toggle (nav-desktop-mode) ───────────────────────────────────

// True once the user has explicitly toggled mode this session — stops the
// DESKTOP_MQ resize listener from clobbering their choice.
let _userModeOverride = false;

function toggleDesktopMode() {
  _userModeOverride = true;
  const isDesktop = document.body.classList.toggle('desktop-mode');
  // Session-only toggle — do NOT persist to localStorage, so autodetect works on reload.
  _updateDesktopIcon();
  _syncSidebarActions();
  // Header controls are ST-only.
  const hdrNav = document.getElementById('hdr-nav');
  if (hdrNav) {
    const isST = effectiveRole() === 'st' || effectiveRole() === 'dev';
    hdrNav.style.display = isST ? '' : 'none';
  }
  if (isDesktop) {
    renderDesktopSidebar();
    _initSidebarCollapse();
    const onMore = document.getElementById('t-more')?.classList.contains('active');
    if (onMore) goTab('roll');
  } else {
    document.body.classList.remove('sidebar-collapsed');
  }
  renderBottomNav();
}

function _syncSidebarActions() {
  // ST Admin button lives in the sidebar footer (renderDesktopSidebar).
  // Nothing else to sync here.
}

function _updateDesktopIcon() {
  const isDesktop = document.body.classList.contains('desktop-mode');
  const gameIcon = document.getElementById('desktop-icon-game');
  const desktopIcon = document.getElementById('desktop-icon-desktop');
  if (gameIcon) gameIcon.style.display = isDesktop ? 'none' : '';
  if (desktopIcon) desktopIcon.style.display = isDesktop ? '' : 'none';
}

const DESKTOP_MQ = window.matchMedia('(min-width: 900px)');

function _initDesktopMode() {
  // Always autodetect on page load. User toggle is session-only and does not
  // persist across reloads. Clear any stale stored value from the buggy
  // previous version so users aren't locked into a mode.
  localStorage.removeItem('tm-mode');
  _applyDesktopMode(DESKTOP_MQ.matches);
  DESKTOP_MQ.addEventListener('change', e => {
    // Respect an in-session user toggle so resize doesn't clobber their choice.
    if (_userModeOverride) return;
    _applyDesktopMode(e.matches);
  });
}

function _applyDesktopMode(isDesktop) {
  document.body.classList.toggle('desktop-mode', isDesktop);
  _updateDesktopIcon();
  _syncSidebarActions();
  // Header controls (theme toggle, desktop toggle, ST admin) are ST-only.
  // Players and ST-in-player-view get a clean header — no chrome clutter.
  const hdrNav = document.getElementById('hdr-nav');
  if (hdrNav) {
    const isST = effectiveRole() === 'st' || effectiveRole() === 'dev';
    hdrNav.style.display = isST ? '' : 'none';
  }
  if (isDesktop) {
    renderDesktopSidebar();
    _initSidebarCollapse();
  }
  renderBottomNav();
}

function _initSidebarCollapse() {
  const collapsed = localStorage.getItem('tm-sidebar-collapsed') === 'true';
  if (collapsed) {
    document.body.classList.add('sidebar-collapsed');
    _updateCollapseIcon(true);
  }
}

function toggleSidebarCollapse() {
  if (!document.body.classList.contains('desktop-mode')) return;
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  localStorage.setItem('tm-sidebar-collapsed', collapsed ? 'true' : 'false');
  _updateCollapseIcon(collapsed);
}

function _updateCollapseIcon(collapsed) {
  const collapseIcon = document.getElementById('sb-collapse-btn')?.querySelector('.sb-icon-collapse');
  const expandIcon   = document.getElementById('sb-collapse-btn')?.querySelector('.sb-icon-expand');
  if (collapseIcon) collapseIcon.style.display = collapsed ? 'none' : '';
  if (expandIcon)   expandIcon.style.display   = collapsed ? '' : 'none';
}

function renderDesktopSidebar() {
  const nav = document.getElementById('desktop-sidebar-nav');
  if (!nav) return;

  const currentTab = document.querySelector('.tab.active')?.id?.replace('t-', '') || 'roll';
  const isActive = (id) => id === currentTab || (id === 'chars' && ['chars','sheets','editor'].includes(currentTab));
  const isSTHere = effectiveRole() === 'st' || effectiveRole() === 'dev';

  // Primary tabs prepended to Game section — Roll/Sheet/Status are first game items
  const primaryTabs = [
    { id: 'roll',   label: 'Roll',   icon: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="4"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/><circle cx="17" cy="7" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="7" cy="17" r="1.5" fill="currentColor"/><circle cx="17" cy="17" r="1.5" fill="currentColor"/></svg>' },
    { id: 'chars',  label: 'Sheet',  icon: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
    { id: 'status', label: 'Status', icon: '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>' },
  ];

  let h = '';

  // All sections — 3-column grids; Game section gets Dice/Sheet/Status prepended
  for (const section of MORE_SECTIONS) {
    const sectionApps = MORE_APPS.filter(app => {
      if (app.section !== section.id) return false;
      const r = effectiveRole();
      const isCoord = r === 'st' || r === 'dev' || r === 'coordinator';
      if (app.stOnly && r !== 'st' && r !== 'dev') return false;
      if (app.coordinatorOnly && !isCoord) return false;
      if (app.playerOnly && (r === 'st' || r === 'dev')) return false;
      if (app.condition && !_moreGridCondition(app)) return false;
      return true;
    });
    // Skip section entirely if no visible apps (and no primary tabs to prepend)
    const hasPrimary = section.id === 'game';
    if (!sectionApps.length && !hasPrimary) continue;

    h += `<div class="sidebar-section-label">${section.label}</div>`;
    h += `<div class="sidebar-app-grid">`;
    // Prepend Roll/Sheet/Status to Game section
    if (hasPrimary) {
      for (const { id, label, icon } of primaryTabs) {
        const on = isActive(id) ? ' on' : '';
        h += `<button class="sidebar-app-tile${on}" onclick="goTab('${id}')" title="${label}">`;
        h += `<span class="sidebar-app-tile-icon">${icon}</span><span class="sidebar-app-tile-label">${label}</span></button>`;
      }
    }
    for (const app of sectionApps) {
      const on = isActive(app.id) ? ' on' : '';
      const admin = (app.stOnly || app.coordinatorOnly) ? ' sidebar-app-tile-admin' : '';
      // Retired features (Downtime, Ordeals — moved to TM Story) stay visible but
      // dimmed for players; STs bypass this, same as the tab body they lead to.
      const isRetired = !isSTHere && typeof app.retired === 'function' && app.retired();
      const retired = isRetired ? ' sidebar-app-tile-retired' : '';
      const titleText = isRetired ? (app.retiredReason || app.label) : app.label;
      h += `<button class="sidebar-app-tile${on}${admin}${retired}" onclick="goTab('${app.id}')" title="${esc(titleText)}">`;
      h += `<span class="sidebar-app-tile-icon">${app.icon}</span>`;
      h += `<span class="sidebar-app-tile-label">${app.label}</span>`;
      h += `</button>`;
    }
    h += `</div>`;
  }

  nav.innerHTML = h;

  // ── Footer: cross-app switcher + density toggle + Settings, pinned to bottom ──
  const footer = document.getElementById('desktop-sidebar-footer');
  if (footer) {
    let fh = '';
    const isRealST = getRole() === 'st' || getRole() === 'dev';

    // Cross-app switcher (shared shape with TM Story's/TM Admin's own footers): only the
    // OTHER apps render here, never this app's own entry (Angelus, 2026-08-22: "the GA
    // button does not need to be shown in the game app"). AD -> TM Admin was the old
    // "ST Admin" -> /admin shortcut, repointed now that admin function lives there
    // instead, and correctly ST-gated the way that old link already was. Flat siblings,
    // not wrapped in their own row div -- the whole footer is ONE row (2026-08-22 fix).
    fh += `<a class="sidebar-app-btn" href="https://terramortisstory.netlify.app/" title="TM Story">ST</a>`;
    if (isRealST) {
      fh += `<a class="sidebar-app-btn" href="https://terramortisadmin.netlify.app/" title="TM Admin">AD</a>`;
    }

    if (isRealST) {
      const isDesktopNow = document.body.classList.contains('desktop-mode');
      const phoneIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;
      const monitorIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
      fh += `<button class="sidebar-util-btn" onclick="toggleDesktopMode()" title="${isDesktopNow ? 'Switch to phablet view' : 'Switch to desktop view'}">${isDesktopNow ? phoneIcon : monitorIcon}</button>`;
    }
    // Settings
    const settingsOn = isActive('settings') ? ' on' : '';
    fh += `<button class="sidebar-app-tile sidebar-settings-btn${settingsOn}" onclick="goTab('settings')" title="Settings">`;
    fh += `<span class="sidebar-app-tile-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>`;
    fh += `<span class="sidebar-app-tile-label">Settings</span></button>`;
    footer.innerHTML = fh;
  }
}

// ── Theme toggle (nav-3-2) ────────────────────────────────────────────────────

function toggleTheme() {
  const current = localStorage.getItem('tm-theme');
  const next = (current === 'light') ? 'dark' : 'light';
  localStorage.setItem('tm-theme', next);
  if (next === 'light') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  _updateThemeIcon();
}

function _updateThemeIcon() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
                 !document.documentElement.hasAttribute('data-theme');
  const sunEl = document.getElementById('theme-icon-dark');
  const moonEl = document.getElementById('theme-icon-parch');
  if (sunEl) sunEl.style.display = isDark ? '' : 'none';
  if (moonEl) moonEl.style.display = isDark ? 'none' : '';
}

// ── More grid helpers ─────────────────────────────────────────────────────────

/** Get the active character for More grid player tabs.
 *  ST: returns suiteState.rollChar (last selected in Sheet/Dice)
 *  Player: returns their own character */
function _activeMoreChar() {
  const role = getRole();
  const chars = suiteState.chars || [];
  // Prefer the explicitly-selected character (updated by _switchChar). This
  // makes the More-grid tabs track whatever the header / sidebar selector
  // currently shows, regardless of role.
  const selected = suiteState.sheetChar || suiteState.rollChar || null;
  if (role !== 'st') {
    const info = getPlayerInfo();
    const ids = info?.character_ids || [];
    const selectedOwned = selected && ids.some(id => String(id) === String(selected._id));
    if (selectedOwned) return selected;
    return chars.find(c => ids.includes(String(c._id)) || ids.includes(c._id)) || null;
  }
  // ST fallback: use the same alphabetically-sorted ordering the sidebar
  // dropdown shows, not suiteState.chars[0] which is API insertion order.
  // Otherwise the dropdown's visible default and _activeMoreChar disagree
  // when sheetChar is null (e.g. stale localStorage pointing at a char
  // that no longer exists).
  if (selected) return selected;
  const visible = _visibleChars();
  return visible[0]?.c || chars[0] || null;
}

// ── Sheet tab — character picker and player sheet (nav-2-1) ──────────────────

function renderSheetPicker(el) {
  if (!el) return;
  const chars = (suiteState.chars || []).filter(c => !c.retired).sort((a, b) => sortName(a).localeCompare(sortName(b)));

  let h = '<div class="sheet-picker"><div class="sheet-picker-grid">';
  for (const c of chars) {
    const name = displayName(c);
    const icon = covIcon(c.covenant, 40);
    // 2026-09-01 general audit fix: this used to shadow the already-imported
    // canonical esc() (line 22) with a local, weaker copy that never escaped
    // `<`/`>` — a real gap, not just duplication. Uses the import now.
    h += `<button class="sheet-char-chip" onclick="openSheetChar('${esc(c.name)}')" title="${esc(name)}">`;
    h += `<span class="sheet-char-chip-icon">${icon}</span>`;
    h += `<span class="sheet-char-chip-name">${esc(name)}</span>`;
    h += '</button>';
  }
  h += '</div></div>';
  el.innerHTML = h;
}

function openSheetChar(charName) {
  onSheetChar(charName);
  goTab('sheets');
}

function showPlayerSheet() {
  const info = getPlayerInfo();
  const ids = info?.character_ids || [];
  const chars = suiteState.chars || [];
  const myChar = chars.find(c => ids.includes(String(c._id)) || ids.includes(c._id));
  if (myChar) {
    onSheetChar(myChar.name);
    goTab('sheets');
  }
}

// ── Lifecycle-aware contextual cards (nav-3-1) ───────────────────────────────

let _lifecycleCache = null; // cached { nextSession, activeCycle, mySubmission }

async function _loadLifecycleData() {
  if (_lifecycleCache) return _lifecycleCache;
  try {
    const [nextSession, cycles] = await Promise.all([
      fetch('/api/game_sessions/next', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
      apiGet('/api/chapters').catch(() => []),
    ]);
    const activeCycle = Array.isArray(cycles)
      ? cycles.find(c => c.status === 'open' || c.status === 'active') || null
      : null;
    // CM-1 (#1028): the cycle players feed from (phase prep or game), highest
    // game_number first - so the feeding card can reflect the real feeding
    // window and the player's actual roll state during prep (Codex review
    // finding, 2026-08-10: the card was date-only and could keep advertising
    // "roll ready" after the player had already rolled).
    const feedingCandidates = Array.isArray(cycles)
      ? cycles.filter(c => isFeedingOpen(c)).sort((a, b) => (b.game_number || 0) - (a.game_number || 0))
      : [];
    let feedingCycle = feedingCandidates[0] || null;
    editorState.activeCycleNum = activeCycle?.game_number ?? null;
    let mySubmission = null;
    if (activeCycle || feedingCycle) {
      const subs = await apiGet('/api/downtime_submissions').catch(() => []);
      const char = _activeMoreChar();
      if (Array.isArray(subs)) {
        // 2026-08-15 (live Game 7 incident): an empty higher-game_number cycle
        // (flipped to game phase before any submissions exist against it) must
        // not shadow a lower-numbered feeding-open cycle that actually carries
        // the month's submissions - see db.js's getFeedingCycle for the
        // canonical fix and the incident this guards against.
        feedingCycle = feedingCandidates.find(c => subs.some(s => String(s.chapter_id) === String(c._id))) || feedingCycle;
        if (char) {
          mySubmission = activeCycle
            ? subs.find(s => String(s.character_id) === String(char._id)) || null
            : subs.find(s => String(s.character_id) === String(char._id)
                && String(s.chapter_id) === String(feedingCycle?._id)) || null;
        }
      }
    }
    _lifecycleCache = { nextSession, activeCycle, feedingCycle, mySubmission };
    return _lifecycleCache;
  } catch {
    return { nextSession: null, activeCycle: null, feedingCycle: null, mySubmission: null };
  }
}

function _clearLifecycleCache() { _lifecycleCache = null; }

async function renderLifecycleCards() {
  const el = document.getElementById('lifecycle-cards');
  if (!el) return;

  const { nextSession, feedingCycle, mySubmission } = await _loadLifecycleData();
  const today = new Date().toISOString().slice(0, 10);

  let h = '';

  // Feeding card: the feeding window is actually open (cycle in prep or game
  // phase) AND a session is upcoming AND the player hasn't rolled yet. The
  // cycle check is CM-1 (#1028): date-only gating advertised a roll that the
  // feeding tab would then refuse.
  const feedingOpen = !!feedingCycle && nextSession && nextSession.session_date >= today;
  const hasRolled = mySubmission?.feeding_roll_player != null;
  if (feedingOpen && !hasRolled) {
    h += `<button class="lifecycle-card lifecycle-card-feeding" onclick="goTab('feeding')">
      <span class="lifecycle-card-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/></svg></span>
      <span class="lifecycle-card-text">
        <span class="lifecycle-card-title">Your feeding roll is ready</span>
        <span class="lifecycle-card-sub">Tap to roll before game night</span>
      </span>
      <span class="lifecycle-card-arr">›</span>
    </button>`;
  }

  // 2026-08-29 (Angelus): the "Downtime due" deadline card and
  // _updateSeasonalNav (which managed the now-removed #n-downtime seasonal
  // nav button) are both removed, since Downtime moved to TM Story entirely, so a
  // deadline reminder pointing at a filing tab that no longer exists here
  // would be a dead link.

  el.innerHTML = h;
  el.style.display = h ? '' : 'none';
}

/** Show logged-in user in header (desktop mode only — mobile uses Settings tab). */
function renderUserHeader() {
  const user = getUser();
  if (!user) return;

  // Desktop sidebar shows profile; mobile header is kept clean (logo + char name only).
  // hdr-nav is ST-only — players and ST-in-player-view see a clean header.
  const hdrNav = document.getElementById('hdr-nav');
  if (hdrNav) {
    const isST = effectiveRole() === 'st' || effectiveRole() === 'dev';
    hdrNav.style.display = isST ? '' : 'none';
  }

  // Show toggle for STs, restore saved label
  const toggleBtn = document.getElementById('btn-view-toggle');
  if (toggleBtn && getRole() === 'st') {
    toggleBtn.style.display = '';
    toggleBtn.textContent = _viewMode === 'st' ? 'Player View' : 'ST View';
    toggleBtn.classList.toggle('view-toggle-active', _viewMode === 'player');
  }

  // Returning ST who last left in player mode — re-enter player view
  if (getRole() === 'st' && _viewMode === 'player') {
    applyRoleRestrictions();
    _enterPlayerView();
  }
}

function toggleProfileMenu() {
  const menu = document.getElementById('hdr-profile-menu');
  if (menu) menu.style.display = menu.style.display === 'none' ? '' : 'none';
}

function toggleViewMode() {
  _viewMode = _viewMode === 'st' ? 'player' : 'st';
  sessionStorage.setItem(VIEW_MODE_KEY, _viewMode);
  applyRoleRestrictions();
  if (_viewMode === 'player') {
    _enterPlayerView();
  } else {
    _enterSTView();
  }
}

function _enterPlayerView() {
  const info = getPlayerInfo();
  const ids = info?.character_ids || [];
  if (!ids.length) {
    goTab('editor');
    const shContent = document.getElementById('sh-content');
    if (shContent) shContent.innerHTML = '<div class="dtl-empty">No character detected — ask your Storyteller to link your Discord account.</div>';
    return;
  }
  const idx = editorState.chars.findIndex(c => ids.includes(String(c._id)));
  if (idx >= 0) openChar(idx);
  else goTab('roll');
}

function _enterSTView() {
  goTab('chars');
}

// Expose functions used in inline onclick handlers
window.goTab  = goTab;
window._getRole = getRole;
window.logout = logout;
window.openRulesOverlay  = openRulesOverlay;
window.closeRulesOverlay = closeRulesOverlay;
window.toggleViewMode    = toggleViewMode;
window.toggleProfileMenu = toggleProfileMenu;
window.toggleSidebarCollapse = toggleSidebarCollapse;
window.suiteStatusOpenEdit   = suiteStatusOpenEdit;
window.suiteStatusCloseEdit  = suiteStatusCloseEdit;
window.suiteStatusAdjustCity = suiteStatusAdjustCity;

boot();
const logo = document.getElementById('topbar-logo');
if (logo) logo.src = ICONS.TM_logo;
