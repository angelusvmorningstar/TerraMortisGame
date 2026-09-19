/* Game app — character pools panel with tap-to-roll.
   Renders derived stats strip + tappable skill/discipline pool buttons
   above the read-only character sheet in t-editor. */

import {
  getAttrEffective, getAttrBonus, skTotal, skNineAgain,
  calcDefence, calcHealth, calcWillpowerMax, calcVitaeMax, calcSpeed,
} from '../data/accessors.js';
// Issue #879 (ADR-006 D4): roll calculator's derived-stats strip reads
// the armour-adjusted + overlay-modded defence.
import { defenceForDisplay } from '../data/equipment-derivation.js';
import { getPool } from '../shared/pools.js';
import { getRulesByCategory } from '../data/loader.js';
import { esc } from '../data/helpers.js';
// Game 8 live request: a fast, always-visible spend action next to the
// derived-stats strip, so a player never has to hunt the Sheet tab's
// tap-a-pip tracker mid-scene. Mirrors public/js/suite/sheet.js's own
// tracker click-handler gating (player = self-spend only, ST/dev = free
// adjust) rather than inventing a second spend path.
import { trackerRead, trackerSpend, trackerAdj } from './tracker.js';
import { getRole } from '../auth/discord.js';
import { toast } from '../suite/toast.js';

// Primary attribute for each skill (most common pool pairing)
const SKILL_ATTR = {
  Academics: 'Intelligence', 'Animal Ken': 'Presence',  Athletics:    'Strength',
  Brawl:     'Strength',    Computer:    'Intelligence', Crafts:       'Intelligence',
  Drive:     'Dexterity',   Empathy:     'Wits',         Expression:   'Presence',
  Firearms:  'Dexterity',   Intimidation:'Presence',    Investigation:'Wits',
  Larceny:   'Dexterity',   Medicine:    'Intelligence', Occult:       'Intelligence',
  Persuasion:'Manipulation', Politics:   'Intelligence', Science:      'Intelligence',
  Socialise: 'Presence',    Stealth:     'Dexterity',   Streetwise:   'Wits',
  Subterfuge:'Manipulation', Survival:   'Wits',         Weaponry:     'Strength',
};

const SKILL_ORDER = [
  'Athletics','Brawl','Firearms','Weaponry','Stealth','Drive','Larceny','Survival',
  'Academics','Investigation','Medicine','Occult','Politics','Science','Computer','Crafts',
  'Animal Ken','Empathy','Expression','Intimidation','Persuasion','Socialise','Streetwise','Subterfuge',
];

// Short abbreviations for pool breakdown sub-labels (no clashes)
const ABBR = {
  Intelligence:'Int', Wits:'Wit', Resolve:'Res',
  Strength:'Str', Dexterity:'Dex', Stamina:'Sta',
  Presence:'Pre', Manipulation:'Man', Composure:'Com',
  Academics:'Aca', 'Animal Ken':'AK', Athletics:'Ath',
  Brawl:'Bwl', Computer:'Cmp', Crafts:'Cft',
  Drive:'Drv', Empathy:'Emp', Expression:'Exp',
  Firearms:'Frm', Intimidation:'Itm', Investigation:'Inv',
  Larceny:'Lrc', Medicine:'Med', Occult:'Occ',
  Persuasion:'Per', Politics:'Pol', Science:'Sci',
  Socialise:'Soc', Stealth:'Sth', Streetwise:'Swd',
  Subterfuge:'Sub', Survival:'Srv', Weaponry:'Wpn',
};

function ab(s) { return ABBR[s] || (s || '').slice(0, 3); }

/**
 * PT dot-5 Rote eligibility for a given skill: asset skill + Professional
 * Training rating >= 5. Pure function of (character, skill name) — reused
 * by the skill-pool loop below and by app.js's Custom Pool builder (rlv.4,
 * review fix — AC5 promises the Rote badge applies to Custom Pools exactly
 * as it does to any named pool; this is what makes that literally true
 * rather than only true for pre-built skill-pool tiles).
 */
export function roteEligibleFor(char, skill) {
  if (!skill) return false;
  const ptMerit = (char.merits || []).find(m => m.name === 'Professional Training' && (m.rating || 0) >= 5);
  return !!(ptMerit && (ptMerit.asset_skills || []).includes(skill));
}

/**
 * Render the pools panel into el.
 * onTap(poolObj) is called when the ST taps a pool button.
 * poolObj: { total, label, attr, attrV, skill, skillV, resistance, pi }
 *
 * Review fix (rlv.4, Codex Pass 2): `pools` is scoped to this call, not a
 * module-level singleton. renderCharPools() is called for TWO independent,
 * simultaneously-mounted containers (#gcp-panel on the Sheets tab,
 * #roll-char-pools on the Roll tab), each potentially showing a different
 * character. A shared module-level array meant the container rendered
 * SECOND silently rewrote the array the FIRST container's already-attached
 * buttons still read from at click time — a stale button could resolve
 * against a different character's rebuilt pools (wrong pool loaded, or
 * `onTap(undefined)` if the stale index was now out of range). Confirmed
 * live before this fix: two characters with different pool counts, render
 * A into one container then B into another, click A's still-attached tile
 * — the click handler received `undefined`, not A's own pool. Closing over
 * a per-call local instead of a shared mutable makes each container's
 * buttons permanently correct regardless of what any other container
 * renders afterward.
 */
export function renderCharPools(el, char, onTap) {
  const pools = [];

  const defence = defenceForDisplay(char);
  const hp      = calcHealth(char);
  const wp      = calcWillpowerMax(char);
  const vitae   = calcVitaeMax(char);
  const speed   = calcSpeed(char);

  let h = '<div class="gcp-wrap">';

  // ── Derived stats strip ──
  h += '<div class="gcp-stats">';
  h += statChip('Defence',   defence);
  h += statChip('Health',    hp);
  h += statChip('Willpower', wp);
  h += statChip('Vitae Max', vitae);
  h += statChip('Speed',     speed);
  h += '</div>';

  // ── Quick spend (Game 8 live request) ──
  // Duplicate, fast-access controls for the same self-service Vitae/WP spend
  // the Sheet tab's tap-a-pip tracker already does — this row just makes it
  // discoverable without hunting for it. Always rendered (both roles use it:
  // player = self-spend, ST/dev = free adjust, same split as sheet.js's own
  // tracker click-handler).
  h += '<div class="gcp-quick-spend">'
     + '<button class="gcp-spend-btn" type="button" data-spend="vitae">− 1 Vitae</button>'
     + '<button class="gcp-spend-btn" type="button" data-spend="wp">− 1 WP</button>'
     + '</div>';

  // ── Vampire Mechanics (gdx-11, #981) ──
  // Originally gated behind the tm-use-new-dice-roller flag (v1's roll.js
  // never understood the pi.noWP/pi.willpower_cost fields every tile here
  // sets) — that flag and roll.js itself were both retired outright by
  // rlv.2, so roll-v2.js is now the only player roller and this section is
  // unconditional. The choice tiles push {opensPanel}, routed by app.js's
  // onTap callback to openPanel(mode).
  // rcv.2: `vmHtml`/`vmCount` are declared OUTSIDE this block now — the tiles
  // are built here exactly as before, but they are no longer emitted straight
  // into `h`; they become the Special accordion's body further down, after the
  // Skills and Disciplines bodies have also been built.
  let vmHtml = '';
  let vmCount = 0;
  {
    // rcv.1 (Epic RCV): "Riding the Wave" was wrongly modelled here as an
    // unconditional standalone roll. Per the house-ruled frenzy system
    // (public/js/game/rules.js:44-56), it is a Wits+Composure roll made
    // AFTER a character has already triggered frenzy, to direct it - never
    // a freestanding choice offered alongside Frenzy Resistance the way this
    // array presented it. The real mechanic needs frenzy-episode state this
    // app doesn't have yet (see specs/epic-frz-frenzy-system.md) - removed
    // here rather than replaced, since there is nothing shipped yet for a
    // note on this tile to point at.
    const VM_IMMEDIATE = [
      { label: 'Frenzy Resistance', a1: 'Resolve', a2: 'Composure' },
      // rcv.6: no branching choice (confirmed against the mockup's own
      // server-side comment, roller-live/server.mjs:220-225) - an immediate
      // roll like Frenzy Resistance, not a panel tile. `resistance` reuses
      // the EXISTING resist-target system unchanged (shared/resist.js's
      // parseResistance() already handles an attr+skill token combo,
      // confirmed directly before writing this story).
      {
        label: 'Surprise / Perception', a1: 'Wits', a2: 'Composure',
        resistance: 'v Dexterity + Stealth',
        // rcv.6: ported from the mockup's own rules-summary text
        // (app.js:1316-1320), edited to name the real resist-target dropdown
        // rather than the mockup's own "Toggle Contested Roll below"
        // control, which does not exist in this app.
        effect: 'A character who does not realise they are about to be on the receiving end of violence rolls Wits + Composure to notice the ambush, contested by the attacker\'s Dexterity + Stealth. Pick the attacking character from the Resistance section below to compute their pool.\n\nFailure: your character cannot take an action in the first turn of combat, and cannot apply Defence that turn. Initiative for the second turn is determined as normal.',
        action: 'Instant action',
      },
    ];
    for (const m of VM_IMMEDIATE) {
      // getAttrEffective already includes bonus dots + discipline enhancement
      // (accessors.js) - NOT added again here, unlike the pre-existing skill-
      // pool loop below (out of this story's scope to touch). AC8's own
      // Custom Pool formula uses getAttrEffective alone for the same reason.
      const v1 = getAttrEffective(char, m.a1);
      const v2 = getAttrEffective(char, m.a2);
      const total = v1 + v2;
      const idx = pools.length;
      // The second attribute is modelled via pi's generic `skill` field —
      // downstream (roll-v2.js's effline/spec/equipment-chip logic) only
      // ever reads it as a display label + a lookup key, and none of
      // Composure/Wits/Resolve resolve against any real skill's specs or
      // equipment domain, so this is a safe, zero-side-effect reuse rather
      // than inventing a second bespoke pi shape for a two-attribute pool.
      // rcv.6: `resistance`/`effect`/`action` thread through from the entry
      // when present - additive only, Frenzy Resistance's own entry carries
      // none of these and stays byte-identical to before this story.
      const pi = {
        total, attr: m.a1, attrV: v1, skill: m.a2, skillV: v2, discName: null, discV: 0,
        resistance: m.resistance || null, noWP: false,
        ...(m.effect ? { effect: m.effect } : {}),
        ...(m.action ? { action: m.action } : {}),
      };
      pools.push({ total, label: m.label, attr: m.a1, attrV: v1, skill: m.a2, skillV: v2, nineAgain: false, resistance: m.resistance || null, pi });
      vmHtml += poolBtn(m.label, total, ab(m.a1) + '+' + ab(m.a2), idx, false);
      vmCount++;
    }
    const VM_CHOICE = [
      { label: 'Lash Out', mode: 'lashout' },
      { label: 'Clash of Wills', mode: 'clash' },
      { label: 'Blood Bond Resistance', mode: 'bloodbond' },
      // rcv.5: fourth choice tile — opens app.js's own `bloodsympathy` panel
      // mode (two chip groups: Relation, Approach), same {opensPanel} contract
      // as the three above.
      { label: 'Detecting Blood Sympathy', mode: 'bloodsympathy' },
    ];
    for (const m of VM_CHOICE) {
      const idx = pools.length;
      pools.push({ opensPanel: m.mode, label: m.label });
      vmHtml += choiceBtn(m.label, idx);
      vmCount++;
    }
    // gdx.12: third tile kind — {submitAction}, routed by app.js's onTap to
    // submitHumanityCheck() instead of openPanel()/loadPool(). No panel, no
    // roll — see the story's own "What this story is NOT" for why.
    {
      const idx = pools.length;
      pools.push({ submitAction: 'humanity_check', label: 'Humanity Check' });
      vmHtml += submitBtn('Humanity Check', idx);
      vmCount++;
    }
  }

  // ── Skill pools (only non-zero skills) ──
  // Include PT dot-4 and MCI dot-3 bonus dots from applyDerivedMerits
  let skillHtml = '';
  let skillCount = 0;
  for (const sk of SKILL_ORDER) {
    const skD = skTotal(char, sk);
    if (!skD) continue;
    const attr  = SKILL_ATTR[sk];
    const attrV = getAttrEffective(char, attr) + getAttrBonus(char, attr);
    const total = attrV + skD;
    // Check 9-Again from any source
    const na = skNineAgain(char, sk)
      || char._pt_nine_again_skills?.has(sk)
      || char._mci_dot3_skills?.has(sk)
      || char._ohm_nine_again_skills?.has(sk);
    const roteEligible = roteEligibleFor(char, sk);
    // Check Air of Menace: adds Nightmare dots to Intimidation
    let meritBonus = 0, meritLabel = '';
    if (sk === 'Intimidation' && (char.merits || []).some(m => m.name === 'Air of Menace')) {
      meritBonus = char.disciplines?.Nightmare?.dots || 0;
      if (meritBonus > 0) meritLabel = 'AoM';
    }
    const poolTotal = total + meritBonus;
    const idx   = pools.length;
    pools.push({ total: poolTotal, label: sk, attr, attrV, skill: sk, skillV: skD, nineAgain: !!na, roteEligible, meritBonus, meritLabel, resistance: null, pi: null });
    const sub = ab(attr) + '+' + ab(sk) + (meritBonus ? '+' + meritLabel + '(' + meritBonus + ')' : '');
    skillHtml += poolBtn(sk, poolTotal, sub, idx, na, roteEligible);
    skillCount++;
  }
  // ── Discipline power pools (rollable only) ──
  const allRules = getRulesByCategory('discipline');
  const discEntries = Object.entries(char.disciplines || {}).filter(([, v]) => (v?.dots || 0) > 0);
  const derivedPowers = [];
  for (const [disc, v] of discEntries) {
    const ruledPowers = allRules
      .filter(r => r.parent === disc && r.rank != null && r.rank <= v.dots)
      .sort((a, b) => a.rank - b.rank);
    if (ruledPowers.length) {
      ruledPowers.forEach(r => derivedPowers.push({ name: r.name, discipline: disc }));
    }
  }
  (char.powers || []).filter(p => p.category === 'devotion' || p.category === 'rite' || p.category === 'pact')
    .forEach(p => derivedPowers.push(p));

  let discHtml = '';
  let discCount = 0;
  for (const pw of derivedPowers) {
    const pi = getPool(char, pw.name);
    if (!pi || pi.noRoll || pi.total === undefined) continue;
    const idx = pools.length;
    const discNa = pi.nineAgain || (pi.skill && skNineAgain(char, pi.skill));
    pools.push({ total: pi.total, label: pw.name, attr: pi.attr, attrV: pi.attrV, skill: pi.skill, skillV: pi.skillV, nineAgain: !!discNa, resistance: pi.resistance || null, pi });
    const sub = ab(pi.attr) + '+' + ab(pi.skill) + (pi.resistance ? ' vs ' + pi.resistance : '');
    discHtml += poolBtn(pw.name, pi.total, sub, idx, discNa);
    discCount++;
  }

  // rlv.4 (#1039, D5): "+ Custom Pool" tile — an ad-hoc entry path for rolls
  // with no pre-built pool button. Opens a scoped panel (app.js's
  // openPanel('custom')) instead of rolling immediately, so onTap receives
  // {opensPanel} rather than a total/pi. Always available, even for a
  // character with zero non-zero skills and zero disciplines — Custom Pool
  // alone is reason enough to render the Pools section.
  const customIdx = pools.length;
  pools.push({ opensPanel: 'custom', label: '+ Custom Pool' });

  // rcv.2: Skills / Disciplines / Special as three INDEPENDENT accordions,
  // replacing gdx-11's single "▸ Pools" collapse toggle (and its
  // `tm_pools_collapsed` key, retired outright — see the story's AC6: no
  // migration, a previously un-collapsed user simply gets the new
  // default-closed state on next load). Order and default-closed state are
  // ported from the recovered mockup's own `sectionOpen` shape
  // (scratchpad/roller-live-recovered/public/app.js:237,1799-1822): secSkills,
  // secDisc, secSpecial, all false. The mockup's fourth section (Queue) is
  // Epic CRD's contested-roll inbox and is deliberately not ported here.
  //
  // Skills/Disciplines still render only when they have tiles — today's own
  // `if (skillHtml)` / `if (discHtml)` behaviour, unchanged. Special always
  // has tiles (Frenzy Resistance et al are unconditional), so it always
  // renders.
  h += '<div class="gcp-accordions">';
  if (skillHtml) {
    h += accordionSection('skills', 'Skills', skillCount, `<div class="gcp-pool-grid">${skillHtml}</div>`, 'tm_pools_open_skills');
  }
  if (discHtml) {
    h += accordionSection('disc', 'Disciplines', discCount, `<div class="gcp-pool-grid">${discHtml}</div>`, 'tm_pools_open_disc');
  }
  h += accordionSection('special', 'Special', vmCount, `<div class="gcp-pool-grid">${vmHtml}</div>`, 'tm_pools_open_special');
  h += '</div>';

  // rcv.2 (AC4): "+ Custom Pool" leaves the tile grid entirely and becomes a
  // standalone full-width dashed button BELOW the accordion group, always
  // visible regardless of any section's open/closed state — the mockup's own
  // `freeBuildBtn` placement (app.js:1825, app.css:238). The label stays
  // "+ Custom Pool" rather than the mockup's "Free Build" so it keeps
  // matching the panel it opens, which is titled "Custom Pool" (rlv.4).
  // Behaviour is untouched: same `pools[]` entry, same index, same
  // `onTap({opensPanel:'custom'})` routing.
  h += '<button class="gcp-freebuild-btn" data-idx="' + customIdx + '" type="button">+ Custom Pool</button>';

  h += '</div>';
  el.innerHTML = h;

  el.querySelectorAll('.gcp-pool-btn, .gcp-freebuild-btn').forEach(btn => {
    const idx = Number(btn.dataset.idx);
    // gdx.12: second arg (the tapped button element) is new — existing
    // onTap callbacks that only declare one parameter are unaffected. Lets
    // submitAction handling disable the tile immediately to prevent a
    // double-submit, without char-pools.js itself making any network call.
    btn.addEventListener('click', () => onTap(pools[idx], btn));
  });

  // Quick-spend row: same self-service gating as sheet.js's own tracker
  // click-handler (player = decrease-only via trackerSpend, ST/dev = free
  // adjust via trackerAdj) — no new server path, just a more visible entry
  // point onto the existing one.
  const charId = String(char._id);
  el.querySelectorAll('.gcp-spend-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind    = btn.dataset.spend; // 'vitae' | 'wp'
      const field   = kind === 'vitae' ? 'vitae' : 'willpower';
      const label   = kind === 'vitae' ? 'Vitae' : 'Willpower';
      const max     = kind === 'vitae' ? vitae : wp;
      const cs      = trackerRead(charId) || {};
      const current = field === 'vitae' ? (cs.vitae ?? 0) : (cs.willpower ?? 0);
      if (current <= 0) { toast(`No ${label} left to spend`); return; }

      const role = getRole();
      if (role === 'st' || role === 'dev') trackerAdj(charId, field, -1);
      else trackerSpend(charId, field, 1);

      toast(`− 1 ${label} (${current - 1}/${max})`);
    });
  });

  // rcv.2: per-section toggle-in-place. Deliberately NOT a full
  // renderCharPools() re-run (which the mockup's own cheap `render()` could
  // afford but this one cannot — it recomputes every pool's dice math,
  // rank-gate filter and tile markup, and re-attaches every handler). This
  // extends the lightweight DOM-only toggle the retired `.gcp-collapse-btn`
  // handler already used, just applied per-section instead of once globally.
  el.querySelectorAll('[data-acc-toggle]').forEach(head => {
    head.addEventListener('click', () => {
      const section = head.closest('.gcp-acc-section');
      const key = section.dataset.storageKey;
      const nowOpen = section.dataset.open !== 'true';
      section.dataset.open = String(nowOpen);
      head.setAttribute('aria-expanded', String(nowOpen));
      localStorage.setItem(key, nowOpen ? '1' : '0');
    });
  });
}

/**
 * rcv.2: one independent accordion section. Each reads and writes its OWN
 * localStorage key, so opening one never touches another's state (AC2, AC5).
 * `stored === null` (never touched on this device) means closed, matching
 * gdx-11 AC9's own default-closed precedent for the single toggle this
 * replaces; only an explicit prior '1' opens a section on first render.
 */
function accordionSection(id, label, count, bodyHtml, storageKey) {
  const stored = localStorage.getItem(storageKey);
  const open = stored === '1';
  return `<div class="gcp-acc-section" data-open="${open}" data-storage-key="${storageKey}">` +
    `<button class="gcp-acc-head" data-acc-toggle="${id}" type="button" aria-expanded="${open}">` +
    `<span class="gcp-acc-label">${esc(label)} <span class="gcp-acc-count">${count}</span></span>` +
    `<span class="gcp-chevron"></span></button>` +
    `<div class="gcp-acc-body-wrap"><div class="gcp-acc-body"><div class="gcp-acc-body-inner">${bodyHtml}</div></div></div>` +
    `</div>`;
}

function statChip(label, value) {
  return `<div class="gcp-stat"><span class="gcp-stat-v">${value}</span><span class="gcp-stat-l">${esc(label)}</span></div>`;
}

// rlv.4 / gdx-11 — a "choice" tile: opens a scoped panel instead of rolling
// immediately, so there is no dice total to show yet. `wide` spans the full
// grid row (used for the "+ Custom Pool" tile only).
function choiceBtn(label, idx, wide) {
  const cls = 'gcp-pool-btn gcp-choice' + (wide ? ' gcp-choice-wide' : '');
  return `<button class="${cls}" data-idx="${idx}"><span class="gcp-pool-n gcp-choice-arrow">›</span><span class="gcp-pool-lbl">${esc(label)}</span><span class="gcp-pool-sub">tap to choose</span></button>`;
}

// gdx.12: a "submit" tile — posts a pending request immediately, no panel,
// no dice total. Visually the same chrome as choiceBtn (reuse .gcp-choice)
// but distinct subtitle copy so it doesn't falsely promise a choice panel.
function submitBtn(label, idx) {
  return `<button class="gcp-pool-btn gcp-choice" data-idx="${idx}"><span class="gcp-pool-n gcp-choice-arrow">✓</span><span class="gcp-pool-lbl">${esc(label)}</span><span class="gcp-pool-sub">tap to submit</span></button>`;
}

function poolBtn(label, total, sub, idx, nineAgain, roteEligible) {
  const badges = (nineAgain ? '<span class="gcp-9a-badge">9</span>' : '')
               + (roteEligible ? '<span class="gcp-rote-badge">R</span>' : '');
  const cls = 'gcp-pool-btn' + (nineAgain ? ' gcp-9a' : '') + (roteEligible ? ' gcp-rote' : '');
  return `<button class="${cls}" data-idx="${idx}"><span class="gcp-pool-n">${total}</span>${badges}<span class="gcp-pool-lbl">${esc(label)}</span><span class="gcp-pool-sub">${esc(sub)}</span></button>`;
}
