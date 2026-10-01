/**
 * TM Admin Story tm-admin.10.6: an ST Mods overlay value can never be saved into a character.
 *
 * TM Game's admin applies the ST Mods overlay to every character in memory at boot. Four routes let an
 * overlaid value reach a save: the partner cascade-save, the index shift on a partner mutated while
 * overlaid, the edit-click race in renderSheetWithOverlay, and charsForSave's JSON clone. These tests
 * drive the REAL functions:
 *   - admin.js is a browser entry module, so its file-local functions (buildSaveBody, saveCharToApi,
 *     renderSheetWithOverlay, openCharDetail, closeCharDetail and the 10.6 helpers) are sliced out of the
 *     real source text and evaluated together, with their imports injected (the 10.5 approach);
 *   - the domain-partner flow is the real edit-domain.js shAddDomainPartner / shRemoveDomainPartner,
 *     which call the real merits.js addMerit / removeMerit;
 *   - the overlay is the real st-mods.js applyStMods / applyOverlayToAll / loadStMods, fed by a fetch
 *     stub that answers GET /api/st_mods the way the server does.
 * The runner has no jsdom: document, localStorage and fetch are small stubs.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const u = (...p) => pathToFileURL(path.resolve(REPO_ROOT, ...p)).href;

// ── Browser stubs ────────────────────────────────────────────────────────────

/** st_mods rows by character id, served by the fetch stub. */
let MODS = {};
/** When set, single-character GET /api/st_mods waits on this promise (the cold-start race). */
let singleGate = null;

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.fetch = vi.fn(async (url) => {
  const s = String(url);
  let m = /character_ids=([^&]*)/.exec(s);
  if (m) {
    const out = {};
    for (const id of decodeURIComponent(m[1]).split(',')) if (MODS[id]) out[id] = MODS[id];
    return { ok: true, json: async () => structuredClone(out) };
  }
  m = /character_id=([^&]*)/.exec(s);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (singleGate) await singleGate;
    return { ok: true, json: async () => structuredClone(MODS[id] || []) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

function makeDocument() {
  const els = new Map();
  return {
    _els: els,
    getElementById(id) {
      if (!els.has(id)) {
        els.set(id, {
          id, textContent: '', value: '', innerHTML: '', style: {}, handlers: {},
          addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
          scrollIntoView() {},
        });
      }
      return els.get(id);
    },
  };
}

// ── Real modules ─────────────────────────────────────────────────────────────

let st, withoutTraitBonus, dom, stateMod, exportMod, helpers;

beforeAll(async () => {
  st = await import(u('public', 'js', 'data', 'st-mods.js'));
  ({ withoutTraitBonus } = await import(u('public', 'js', 'data', 'strip-trait-bonus.js')));
  const loadRulesMod = await import(u('public', 'js', 'editor', 'rule_engine', 'load-rules.js'));
  vi.spyOn(loadRulesMod, 'getRulesCache').mockReturnValue({
    rule_grant: [], rule_nine_again: [], rule_skill_bonus: [], rule_speciality_grant: [],
    rule_tier_budget: [], rule_disc_attr: [], rule_derived_stat_modifier: [],
  });
  dom = await import(u('public', 'js', 'editor', 'edit-domain.js'));
  dom.registerCallbacks(() => {}, () => {});
  stateMod = (await import(u('public', 'js', 'data', 'state.js'))).default;
  exportMod = await import(u('public', 'js', 'editor', 'export.js'));
  helpers = await import(u('public', 'js', 'data', 'helpers.js'));
});

beforeEach(() => {
  MODS = {};
  singleGate = null;
  dom.clearDirtyPartners();
  if (typeof dom.clearStrippedPartners === 'function') dom.clearStrippedPartners();
  stateMod.editMode = false;
  stateMod.editIdx = -1;
  stateMod.dirty.clear();
});

// ── Slicing the real admin.js ────────────────────────────────────────────────

/** Slice a brace-balanced block starting at `declRe`'s match; '' when the declaration is absent. */
function sliceBlock(src, declRe) {
  const m = declRe.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error(`unbalanced braces scanning ${declRe}`);
}

const SLICED = [
  'buildSaveBody', 'saveCharToApi', 'savePartnerCascade', 'reoverlayCharacters',
  'releaseAbandonedPartners', 'renderSheetWithOverlay', 'openCharDetail', 'closeCharDetail',
];

/**
 * The real admin.js functions above, evaluated together in one scope with their imports injected.
 * `chars` and `selectedChar` are shared module state, exactly as in admin.js.
 */
function loadAdmin({ chars = [], apiPut, apiGet, settings = { st_mods_enabled: true }, document = makeDocument(), alert = vi.fn(), confirm = () => true } = {}) {
  const src = read('public/js/admin.js');
  const legacy = /const _LEGACY_FIELDS = new Set\([^;]*\);/.exec(src)[0];
  const deprecated = /const _DEPRECATED_FIELDS = new Set\([^;]*\);/.exec(src)[0];
  const fns = SLICED.map(n => sliceBlock(src, new RegExp(`(?:async\\s+)?function ${n}\\(`))).filter(Boolean).join('\n\n');
  const deps = {
    chars,
    editorState: stateMod,
    apiPut: apiPut || vi.fn(async () => ({})),
    apiGet: apiGet || vi.fn(async () => ({})),
    sanitiseChar: () => {},
    withoutTraitBonus,
    stripOverlay: st.stripOverlay,
    applyStMods: st.applyStMods,
    applyOverlayToAll: st.applyOverlayToAll,
    loadStMods: st.loadStMods,
    spliceCurrent: st.spliceCurrent,
    loadTrackerState: async () => null,
    calcWillpowerMax: () => 0,
    calcVitaeMax: () => 0,
    materialiseDerivedDefence: () => {},   // stub: armour-adjusted defence is not under test here
    getGlobalSettings: () => settings,
    renderSheet: vi.fn(),
    renderCharGrid: () => {},
    getDirtyPartners: dom.getDirtyPartners,
    clearDirtyPartners: dom.clearDirtyPartners,
    getStrippedPartners: dom.getStrippedPartners || (() => new Set()),
    clearStrippedPartners: dom.clearStrippedPartners || (() => {}),
    document,
    localStorage: globalThis.localStorage,
    alert,
    confirm,
    esc: helpers.esc,
    cardName: helpers.cardName,
    redactPlayer: (s) => s,
    showEmergencyContact: () => {}, printPDF: () => {}, exportJSON: () => {},
    toggleRetire: () => {}, openHardDeleteModal: () => {}, openPlayerLinkModal: () => {},
  };
  const names = Object.keys(deps);
  const exportsObj = SLICED.map(n => `${n}: typeof ${n} === 'function' ? ${n} : undefined`).join(', ');
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `let selectedChar = null;\n${legacy}\n${deprecated}\n${fns}\nreturn { ${exportsObj}, getSelected: () => selectedChar };`);
  const api = factory(...names.map(n => deps[n]));
  return { ...api, deps, document };
}

// ── Frozen oracle for the no-regression assertion ────────────────────────────

/**
 * FROZEN REFERENCE COPY of buildSaveBody as it stood before Story 10.6 (origin/main at PR #1257),
 * kept ONLY as the oracle for "a character with no overlay produces a byte-identical body". It is not
 * the code under test.
 */
const PRE_10_6_BUILD_SAVE_BODY = `
const _LEGACY_FIELDS = new Set(['attr_creation', 'skill_creation', 'disc_creation', 'merit_creation']);
const _DEPRECATED_FIELDS = new Set(['xp_total', 'xp_spent', 'xp_left']);
function buildSaveBody(c) {
  const body = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === '_id' || k.startsWith('_') || k === 'current' || k === 'derived' || k === 'assets'
        || k === 'ordeals' || _LEGACY_FIELDS.has(k) || _DEPRECATED_FIELDS.has(k)) continue;
    body[k] = v;
  }
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
  return withoutTraitBonus(body);
}
return buildSaveBody;`;
// eslint-disable-next-line no-new-func
const preBuild = () => new Function('withoutTraitBonus', PRE_10_6_BUILD_SAVE_BODY)(withoutTraitBonus);

// ── Fixtures (live-shaped; ids are 24-hex so resolveSharedWithMember keys by _id) ──

const IVANA = '0000000000000000000000a1';
const HENRY = '0000000000000000000000b2';
const CHARLIE = '0000000000000000000000c3';
const WAN = '0000000000000000000000d4';

function generalMerits(n, who) {
  return Array.from({ length: n }, (_, i) => ({ category: 'general', name: `${who} Merit ${i}`, rating: 1, cp: 1, xp: 0, rule_key: null }));
}

/** Henry St. John shape: BP 2, a shared Safe Place at index 3, Mantle mods on merits 16 and 17. */
function henryBase({ sharedWith = [IVANA] } = {}) {
  const merits = generalMerits(18, 'Henry');
  merits[3] = { category: 'domain', name: 'Safe Place', rating: 0, cp: 0, xp: 0, rule_key: null, shared_with: [...sharedWith] };
  return {
    _id: HENRY, name: 'Henry St. John', clan: 'Ventrue', covenant: 'Invictus',
    blood_potency: 2, humanity: 6,
    attributes: { Strength: { dots: 2, cp: 1, xp: 0 }, Wits: { dots: 3, cp: 2, xp: 0 } },
    skills: { Brawl: { dots: 1, specs: [], nine_again: false, cp: 1, xp: 0 } },
    disciplines: { Resilience: { dots: 1, cp: 1, xp: 0 } },
    merits,
  };
}
const HENRY_MODS = [
  { _id: 'm1', character_id: HENRY, stat_path: 'blood_potency', delta: 1, active: true, reason: 'Blood Potency +1' },
  { _id: 'm2', character_id: HENRY, stat_path: 'merits.16.dots', delta: 1, active: true, reason: 'Mantle' },
  { _id: 'm3', character_id: HENRY, stat_path: 'merits.17.dots', delta: 1, active: true, reason: 'Mantle' },
];

/** Ivana Horvat shape: a Safe Place shared with Henry at index 5, a mod on merits.11.dots. */
function ivanaBase({ sharedWith = [HENRY] } = {}) {
  const merits = generalMerits(12, 'Ivana');
  merits[5] = { category: 'domain', name: 'Safe Place', rating: 2, cp: 2, xp: 0, rule_key: null, shared_with: [...sharedWith] };
  return {
    _id: IVANA, name: 'Ivana Horvat', clan: 'Mekhet', covenant: 'Circle of the Crone',
    blood_potency: 2, humanity: 7,
    attributes: { Wits: { dots: 3, cp: 2, xp: 0 } },
    skills: { Occult: { dots: 2, specs: [], nine_again: false, cp: 2, xp: 0 } },
    disciplines: { Auspex: { dots: 2, cp: 2, xp: 0 } },
    merits,
  };
}
const IVANA_MODS = [{ _id: 'm4', character_id: IVANA, stat_path: 'merits.11.dots', delta: 1, active: true, reason: 'Mother-Daughter Bond' }];

/** Charlie Ballsack shape: retired, Resilience stored at 0, a mod taking it to 1. */
function charlieBase() {
  return {
    _id: CHARLIE, name: 'Charlie Ballsack', clan: 'Gangrel', covenant: 'Carthian Movement', retired: true,
    blood_potency: 1, humanity: 7,
    attributes: { Stamina: { dots: 3, cp: 2, xp: 0 } },
    skills: { Survival: { dots: 2, specs: [], nine_again: false, cp: 2, xp: 0 } },
    disciplines: { Resilience: { dots: 0, cp: 0, xp: 0 }, Protean: { dots: 1, cp: 1, xp: 0 } },
    merits: generalMerits(4, 'Charlie'),
  };
}
const CHARLIE_MODS = [{ _id: 'm5', character_id: CHARLIE, stat_path: 'disciplines.Resilience.dots', delta: 1, active: true, reason: 'Oath' }];

/** A character carrying every overlay family's target, including absent traits for the created-leaf case. */
function wanBase() {
  return {
    _id: WAN, name: 'Wan Yelong', clan: 'Mekhet', covenant: 'Invictus',
    blood_potency: 1, humanity: 6,
    attributes: { Strength: { dots: 2, cp: 1, xp: 0 }, Presence: { dots: 2, bonus: 0, cp: 1, xp: 0 } },
    skills: { Brawl: { dots: 1, specs: [], nine_again: false, cp: 1, xp: 0 } },
    disciplines: { Celerity: { dots: 1, cp: 1, xp: 0 } },
    merits: generalMerits(4, 'Wan'),
    current: { willpower: 3 }, derived: { defence: 2 }, _gameXP: 4,
  };
}

const FAMILY_MODS = [
  ['blood_potency', 'blood_potency', 1],
  ['humanity', 'humanity', 1],
  ['disciplines.X.dots on an existing discipline', 'disciplines.Celerity.dots', 1],
  ['disciplines.X.dots on an ABSENT discipline', 'disciplines.Dominate.dots', 1],
  ['attributes.X.dots', 'attributes.Strength.dots', 1],
  ['skills.X.dots', 'skills.Brawl.dots', 1],
  ['skills.X.dots on an ABSENT skill', 'skills.Stealth.dots', 2],
  ['merits.N.dots', 'merits.2.dots', 1],
  ['merits.N.bonus', 'merits.2.bonus', 2],
];

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const meritDotsPaths = (body) => (body.merits || []).flatMap((m, i) => ('dots' in m ? [`merits.${i}.dots`] : []));
const mod = (character_id, stat_path, delta) => ({ _id: `${character_id}-${stat_path}`, character_id, stat_path, delta, active: true });

/** A simulated TM Game PUT: the merit schema rejects a `dots` key (400, nothing written); else $set and return the doc. */
function makeServer(docs) {
  const db = new Map(docs.map(d => [String(d._id), structuredClone(d)]));
  const puts = [];
  const apiPut = vi.fn(async (url, body) => {
    const id = url.split('/').pop();
    puts.push({ id, body: structuredClone(body) });
    if ((body.merits || []).some(m => m && 'dots' in m)) throw new Error('400 VALIDATION_ERROR merits.dots');
    const next = { ...db.get(id), ...structuredClone(body), _id: id };
    delete next.xp_ledger_reason;
    db.set(id, next);
    return structuredClone(next);
  });
  const apiGet = vi.fn(async (url) => structuredClone(db.get(url.split('/').pop())));
  return { db, puts, apiPut, apiGet };
}

/** Boot: chars[] overlaid through the real applyOverlayToAll, as admin.js does at line ~1329. */
async function boot(list, modsById) {
  MODS = modsById;
  await st.applyOverlayToAll(list, true);
  return list;
}

/** Open a character and enter edit mode through the real admin.js handlers. */
async function openAndEdit(h, c) {
  h.openCharDetail(c);
  await flush();
  await h.document.getElementById('cd-edit-toggle').handlers.click.at(-1)();
  await flush();
}

// ═════════════════════════════════════════════════════════════════════════════
// AC1 / AC3: each overlay family on an overlaid PARTNER, through the real buildSaveBody
// ═════════════════════════════════════════════════════════════════════════════

describe('10.6 AC3 buildSaveBody: an overlaid value never reaches the body', () => {
  for (const [label, p, delta] of FAMILY_MODS) {
    it(`${label} (${p})`, () => {
      const { buildSaveBody } = loadAdmin();
      const base = wanBase();
      const c = structuredClone(base);
      st.applyStMods(c, [mod(WAN, p, delta)], true);
      expect(getPath(c, p)).toBe((typeof getPath(base, p) === 'number' ? getPath(base, p) : 0) + delta);  // precondition
      expect(JSON.stringify(buildSaveBody(c))).toBe(JSON.stringify(buildSaveBody(base)));
    });
  }

  it('every family at once: the body equals the un-overlaid body, key order included', () => {
    const { buildSaveBody } = loadAdmin();
    const base = wanBase();
    const c = structuredClone(base);
    st.applyStMods(c, FAMILY_MODS.map(([, p, d]) => mod(WAN, p, d)), true);
    expect(JSON.stringify(buildSaveBody(c))).toBe(JSON.stringify(buildSaveBody(base)));
  });

  it('the in-memory character is untouched (still overlaid, metadata intact)', () => {
    const { buildSaveBody } = loadAdmin();
    const c = wanBase();
    st.applyStMods(c, FAMILY_MODS.map(([, p, d]) => mod(WAN, p, d)), true);
    const before = structuredClone(c);
    buildSaveBody(c);
    expect(c).toEqual(before);
    expect(c.blood_potency).toBe(2);
    expect(c.disciplines.Dominate.dots).toBe(1);
    expect(c._st_mod_base).toBeDefined();
  });

  it('overlay off by the global switch and by st_mods_suppressed: the body is the base body', async () => {
    const { buildSaveBody } = loadAdmin();
    const base = wanBase();
    const off = structuredClone(base);
    st.applyStMods(off, [mod(WAN, 'blood_potency', 1)], false);
    expect(JSON.stringify(buildSaveBody(off))).toBe(JSON.stringify(buildSaveBody(base)));
    const suppressed = { ...structuredClone(base), st_mods_suppressed: true };
    MODS = { [WAN]: [mod(WAN, 'blood_potency', 1)] };
    await st.applyOverlayToAll([suppressed], true);
    expect(suppressed.blood_potency).toBe(1);
    expect(buildSaveBody(suppressed).blood_potency).toBe(1);
  });
});

describe('10.6 AC3 no regression: a character with no overlay gives a byte-identical body', () => {
  function fixtureSet() {
    const plain = wanBase();
    const legacy = { ...henryBase(), attr_creation: [1], xp_total: 30, xp_spent: 20, ordeals: [{ complete: true }], assets: [], _partner: 1 };
    legacy.merits[3]._partner_dots = 2;
    legacy.merits[4].bonus = 0;
    const editStripped = ivanaBase();
    st.applyStMods(editStripped, [...IVANA_MODS, mod(IVANA, 'disciplines.Dominate.dots', 1), mod(IVANA, 'skills.Brawl.dots', 1)], true);
    st.stripOverlay(editStripped);   // the edit-mode character: already stripped
    const odd = { _id: 'x', name: 'Odd', merits: [], attributes: {}, skills: {}, disciplines: {}, st_mods_suppressed: true, retired: false, features: '' };
    return [plain, legacy, editStripped, charlieBase(), odd];
  }

  it('JSON.stringify equality with the pre-10.6 function over the fixture set', () => {
    const { buildSaveBody } = loadAdmin();
    const oracle = preBuild();
    for (const c of fixtureSet()) {
      expect(JSON.stringify(buildSaveBody(c))).toBe(JSON.stringify(oracle(c)));
    }
  });
});

describe('10.6 AC3 fails closed: a body that cannot be cloned and stripped safely is never sent', () => {
  it('buildSaveBody throws on an uncloneable persisted value instead of falling back to the raw object', () => {
    const { buildSaveBody } = loadAdmin();
    const c = wanBase();
    st.applyStMods(c, [mod(WAN, 'blood_potency', 1)], true);
    c.notes = { render: () => 'x' };
    expect(() => buildSaveBody(c)).toThrow();
  });

  it('buildSaveBody throws when the overlay metadata itself is uncloneable', () => {
    const { buildSaveBody } = loadAdmin();
    const c = wanBase();
    st.applyStMods(c, [mod(WAN, 'blood_potency', 1)], true);
    c._st_mod_overlay.blood_potency.mods.push({ fn() {} });
    expect(() => buildSaveBody(c)).toThrow();
  });

  it('saveCharToApi aborts the PUT and shows a visible error', async () => {
    const server = makeServer([wanBase()]);
    const c = wanBase();
    st.applyStMods(c, [mod(WAN, 'blood_potency', 1)], true);
    c.notes = { render: () => 'x' };
    const h = loadAdmin({ chars: [c], apiPut: server.apiPut, apiGet: server.apiGet });
    stateMod.chars = h.deps.chars; stateMod.editIdx = 0; stateMod.editMode = true;
    await h.saveCharToApi();
    expect(server.apiPut).not.toHaveBeenCalled();
    expect(h.deps.alert).toHaveBeenCalled();
    expect(h.document.getElementById('cd-save-api').textContent).toBe('Error');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC4: charsForSave uses the same safe clone
// ═════════════════════════════════════════════════════════════════════════════

describe('10.6 AC4 charsForSave removes an overlay-created leaf or container', () => {
  it('an absent discipline and skill created by the overlay are not stashed (no {} and no dots)', () => {
    const c = wanBase();
    st.applyStMods(c, [mod(WAN, 'disciplines.Dominate.dots', 1), mod(WAN, 'skills.Stealth.dots', 1), mod(WAN, 'blood_potency', 1)], true);
    stateMod.chars = [c];
    const [saved] = exportMod.charsForSave();
    expect('Dominate' in saved.disciplines).toBe(false);
    expect('Stealth' in saved.skills).toBe(false);
    expect(saved.blood_potency).toBe(1);
    expect(saved._st_mod_base).toBeUndefined();
    // copy-only
    expect(c.disciplines.Dominate.dots).toBe(1);
    expect(c.blood_potency).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC2: a partner is stripped BEFORE it is mutated (the index shift)
// ═════════════════════════════════════════════════════════════════════════════

describe('10.6 AC2 the partner flow strips each partner before mutating it', () => {
  it('shRemoveDomainPartner: Henry is stripped and remembered before his Safe Place is removed', async () => {
    const chars = await boot([ivanaBase(), henryBase()], { [IVANA]: IVANA_MODS, [HENRY]: HENRY_MODS });
    const [ivana, henry] = chars;
    expect(henry.blood_potency).toBe(3);   // precondition: overlaid at boot
    stateMod.chars = chars; stateMod.editIdx = 0; stateMod.editMode = true;
    st.stripOverlay(ivana);                  // the edit-mode character
    dom.shRemoveDomainPartner(0, HENRY);
    expect(henry.merits.length).toBe(17);    // the real removeMerit ran: indices shifted
    expect(henry.blood_potency).toBe(2);
    expect(henry._st_mod_base).toBeUndefined();
    expect(meritDotsPaths(henry)).toEqual([]);
    expect([...dom.getStrippedPartners()]).toContain(HENRY);
  });

  it('the INDEX SHIFT: overlaid merits.16.dots, a removed merit below it, the save body has no stray dots and base merits', async () => {
    const chars = await boot([ivanaBase(), henryBase()], { [IVANA]: IVANA_MODS, [HENRY]: [HENRY_MODS[1]] });
    const [ivana, henry] = chars;
    stateMod.chars = chars; stateMod.editIdx = 0; stateMod.editMode = true;
    st.stripOverlay(ivana);
    dom.shRemoveDomainPartner(0, HENRY);
    const { buildSaveBody } = loadAdmin();
    const body = buildSaveBody(henry);
    expect(meritDotsPaths(body)).toEqual([]);
    const expectedMerits = henryBase().merits.filter((_, i) => i !== 3).map(m => ({ ...m }));
    expect(body.merits).toEqual(expectedMerits);
  });

  it('shAddDomainPartner: every partner it touches is stripped before mutation (addMerit on Charlie)', async () => {
    const chars = await boot([ivanaBase(), henryBase(), charlieBase()], { [IVANA]: IVANA_MODS, [HENRY]: HENRY_MODS, [CHARLIE]: CHARLIE_MODS });
    const [ivana, henry, charlie] = chars;
    stateMod.chars = chars; stateMod.editIdx = 0; stateMod.editMode = true;
    st.stripOverlay(ivana);
    dom.shAddDomainPartner(0, CHARLIE);
    expect(charlie.merits.at(-1)).toMatchObject({ category: 'domain', name: 'Safe Place' });
    expect(charlie.disciplines.Resilience.dots).toBe(0);
    expect(henry.blood_potency).toBe(2);
    expect(new Set(dom.getStrippedPartners())).toEqual(new Set([HENRY, CHARLIE]));
    expect(ivana._st_mod_base).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC5: the partner cascade, its bodies and its display parity
// ═════════════════════════════════════════════════════════════════════════════

describe('10.6 AC1 / AC5 the partner cascade-save (Henry, Charlie, Ivana)', () => {
  async function cascadeScenario({ failFor } = {}) {
    const docs = [ivanaBase(), henryBase(), charlieBase()];
    const server = makeServer(docs);
    if (failFor) {
      const inner = server.apiPut.getMockImplementation();
      server.apiPut.mockImplementation(async (url, body) => {
        if (url.endsWith(failFor)) { server.puts.push({ id: failFor, body: structuredClone(body) }); throw new Error('network'); }
        return inner(url, body);
      });
    }
    const chars = await boot(docs.map(d => structuredClone(d)), { [IVANA]: IVANA_MODS, [HENRY]: HENRY_MODS, [CHARLIE]: CHARLIE_MODS });
    const [ivana, henry, charlie] = chars;
    const shown = (c) => ({ bp: c.blood_potency, res: c.disciplines?.Resilience?.dots, m16: c.merits[16]?.dots, m17: c.merits[17]?.dots, m11: c.merits[11]?.dots });
    const before = { henry: shown(henry), charlie: shown(charlie) };
    const h = loadAdmin({ chars, apiPut: server.apiPut, apiGet: server.apiGet });
    await openAndEdit(h, ivana);
    dom.shAddDomainPartner(0, CHARLIE);
    await h.saveCharToApi();
    await flush();
    return { server, h, ivana, henry, charlie, before, shown };
  }

  it('no partner body carries an overlaid value (Henry BP 2, no merit dots; Charlie Resilience 0)', async () => {
    const { server } = await cascadeScenario();
    const henryPut = server.puts.find(p => p.id === HENRY);
    const charliePut = server.puts.find(p => p.id === CHARLIE);
    expect(henryPut.body.blood_potency).toBe(2);
    expect(meritDotsPaths(henryPut.body)).toEqual([]);
    expect(charliePut.body.disciplines.Resilience.dots).toBe(0);
    expect(server.db.get(HENRY).blood_potency).toBe(2);
    expect(server.db.get(CHARLIE).disciplines.Resilience.dots).toBe(0);
  });

  it('the shared_with edit itself still reaches every partner', async () => {
    const { server } = await cascadeScenario();
    expect(server.db.get(HENRY).merits[3].shared_with.sort()).toEqual([CHARLIE, IVANA].sort());
    expect(server.db.get(CHARLIE).merits.at(-1).shared_with.sort()).toEqual([HENRY, IVANA].sort());
  });

  it('display parity: each partner shows the same ST-Mod values after the cascade, re-overlaid from fresh metadata', async () => {
    const { henry, charlie, before, shown } = await cascadeScenario();
    expect(shown(henry)).toEqual(before.henry);
    expect(shown(charlie)).toEqual(before.charlie);
    expect(henry._st_mod_overlay?.blood_potency?.base).toBe(2);
    expect(charlie._st_mod_overlay?.['disciplines.Resilience.dots']?.base).toBe(0);
    expect([...dom.getStrippedPartners()]).toEqual([]);
  });

  it('a failed partner PUT leaves that character re-overlaid as it was', async () => {
    const { charlie, henry, before, shown } = await cascadeScenario({ failFor: CHARLIE });
    expect(shown(charlie)).toEqual(before.charlie);
    expect(charlie._st_mod_overlay).toBeDefined();
    expect(shown(henry)).toEqual(before.henry);
  });

  it('a partner whose body cannot be built safely is skipped with a visible error, the rest still save', async () => {
    const docs = [ivanaBase(), henryBase(), charlieBase()];
    const server = makeServer(docs);
    const chars = await boot(docs.map(d => structuredClone(d)), { [HENRY]: HENRY_MODS, [CHARLIE]: CHARLIE_MODS });
    const [ivana, henry, charlie] = chars;
    charlie.notes = { render: () => 'x' };
    const h = loadAdmin({ chars, apiPut: server.apiPut, apiGet: server.apiGet });
    await openAndEdit(h, ivana);
    dom.shAddDomainPartner(0, CHARLIE);
    await h.saveCharToApi();
    await flush();
    expect(server.puts.map(p => p.id).sort()).toEqual([HENRY, IVANA].sort());
    expect(h.deps.alert).toHaveBeenCalled();
    expect(charlie.disciplines.Resilience.dots).toBe(1);   // re-overlaid as it was
    expect(henry.blood_potency).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC6: the edit-click race
// ═════════════════════════════════════════════════════════════════════════════

describe('10.6 AC1 / AC6 the edit-click race in renderSheetWithOverlay', () => {
  async function race() {
    const docs = [henryBase({ sharedWith: [] })];
    const server = makeServer(docs);
    const chars = await boot(docs.map(d => structuredClone(d)), { [HENRY]: HENRY_MODS });
    const [henry] = chars;
    const h = loadAdmin({ chars, apiPut: server.apiPut, apiGet: server.apiGet });
    const gate = deferred();
    singleGate = gate.promise;              // GET /api/st_mods is slow (a cold start)
    h.openCharDetail(henry);                 // the view-mode render is now waiting on st_mods
    await flush();
    await h.document.getElementById('cd-edit-toggle').handlers.click.at(-1)();   // Edit, before st_mods returns
    await flush();
    expect(henry.blood_potency).toBe(2);     // the edit-mode strip ran
    const rendersAfterEdit = h.deps.renderSheet.mock.calls.length;
    gate.resolve();                          // the older view-mode call now finishes
    await flush();
    singleGate = null;
    return { h, henry, server, rendersAfterEdit };
  }

  it('the older view-mode call applies nothing and renders nothing once Edit has been clicked', async () => {
    const { h, henry, rendersAfterEdit } = await race();
    expect(stateMod.editMode).toBe(true);
    expect(henry._st_mod_overlay).toBeUndefined();
    expect(henry.blood_potency).toBe(2);
    expect(meritDotsPaths(henry)).toEqual([]);
    expect(h.deps.renderSheet.mock.calls.length).toBe(rendersAfterEdit);
  });

  it('the save after the race (with an own-merit removal shifting indices) carries no overlaid value', async () => {
    const { h, henry, server } = await race();
    henry.merits.splice(3, 1);               // the ST removes a merit below the overlaid ones
    await h.saveCharToApi();
    const put = server.puts.find(p => p.id === HENRY);
    expect(put.body.blood_potency).toBe(2);
    expect(meritDotsPaths(put.body)).toEqual([]);
  });

  it('a view-mode call for a character that is no longer open applies nothing', async () => {
    const docs = [henryBase({ sharedWith: [] }), charlieBase()];
    const server = makeServer(docs);
    const chars = await boot(docs.map(d => structuredClone(d)), {});
    const [henry, charlie] = chars;
    const h = loadAdmin({ chars, apiPut: server.apiPut, apiGet: server.apiGet });
    const gate = deferred();
    singleGate = gate.promise;
    h.openCharDetail(henry);
    await flush();
    MODS = { [HENRY]: HENRY_MODS };
    h.openCharDetail(charlie);               // the ST moved on before Henry's st_mods returned
    gate.resolve();
    await flush();
    singleGate = null;
    expect(henry._st_mod_overlay).toBeUndefined();
    expect(henry.blood_potency).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AC7: an abandoned edit does not leave a partner queued
// ═════════════════════════════════════════════════════════════════════════════

describe('10.6 AC1 / AC7 an abandoned domain edit does not cascade on the next unrelated save', () => {
  async function abandoned(leave) {
    const docs = [ivanaBase(), henryBase(), charlieBase()];
    const server = makeServer(docs);
    const chars = await boot(docs.map(d => structuredClone(d)), { [IVANA]: IVANA_MODS, [HENRY]: HENRY_MODS, [CHARLIE]: CHARLIE_MODS });
    const [ivana, henry, charlie] = chars;
    const h = loadAdmin({ chars, apiPut: server.apiPut, apiGet: server.apiGet });
    await openAndEdit(h, ivana);
    dom.shAddDomainPartner(0, CHARLIE);      // Henry and Charlie queued and stripped
    expect(dom.getDirtyPartners().size).toBe(2);
    if (leave === 'close') h.closeCharDetail();
    await openAndEdit(h, henry);             // openCharDetail itself must also clear
    await flush();
    return { h, server, henry, charlie };
  }

  it('closeCharDetail clears the queue and re-overlays the stripped partners', async () => {
    const { h, server, charlie } = await abandoned('close');
    expect(dom.getDirtyPartners().size).toBe(0);
    expect(charlie.disciplines.Resilience.dots).toBe(1);
    expect(charlie._st_mod_overlay).toBeDefined();
    await h.saveCharToApi();
    expect(server.puts.map(p => p.id)).toEqual([HENRY]);
  });

  it('openCharDetail on another character clears the queue too', async () => {
    const { h, server, charlie, henry } = await abandoned('switch');
    expect(dom.getDirtyPartners().size).toBe(0);
    expect(charlie.disciplines.Resilience.dots).toBe(1);
    expect(henry._st_mod_overlay).toBeUndefined();   // the newly opened character is in edit mode, never re-overlaid
    await h.saveCharToApi();
    expect(server.puts.map(p => p.id)).toEqual([HENRY]);
    expect(server.puts[0].body.blood_potency).toBe(2);
  });
});
