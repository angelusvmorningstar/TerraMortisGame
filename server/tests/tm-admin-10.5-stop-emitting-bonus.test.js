/**
 * TM Admin Story tm-admin.10.5, Phase A (Tasks 2 and 4, TM Game client side): the editor stops
 * EMITTING a `bonus` leaf on new traits and stops FORWARDING any `bonus` leaf on save.
 *
 * Ruling in force (Angelus 2026-09-28): `bonus` is a RUNTIME-ONLY overlay slot. ST Mods add onto a
 * trait's `bonus` leaf in memory when a sheet loads; nothing is ever persisted there. So:
 *   - constructors build traits without the key (a missing `bonus` reads as 0 everywhere),
 *   - the two save paths (`buildSaveBody` for the API, `charsForSave` for localStorage) strip it,
 *     proven against an OVERLAID character so an in-memory overlay value can never round-trip,
 *   - readers keep treating a missing `bonus` as 0 (asserted below, not assumed).
 *
 * Real functions throughout. `buildSaveBody` is file-local to admin.js (a browser entry module that
 * cannot be imported under Node), so its REAL source text is sliced out of admin.js and evaluated,
 * rather than re-typed here as a mirror.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const u = (...p) => pathToFileURL(path.resolve(REPO_ROOT, ...p)).href;

let withoutTraitBonus, applyStMods;
let setAttrVal, setSkillObj, getAttrBonus, getAttrTotal, getAttrEffective, getSkillObj, skBonus;
let ensureMeritSync, addMerit;
let editMod, stateMod, exportMod, applyBloodlineRulesFromDb;

beforeAll(async () => {
  ({ withoutTraitBonus } = await import(u('public', 'js', 'data', 'strip-trait-bonus.js')));
  ({ applyStMods } = await import(u('public', 'js', 'data', 'st-mods.js')));
  const acc = await import(u('public', 'js', 'data', 'accessors.js'));
  ({ setAttrVal, setSkillObj, getAttrBonus, getAttrTotal, getAttrEffective, getSkillObj, skBonus } = acc);
  ({ ensureMeritSync, addMerit } = await import(u('public', 'js', 'editor', 'merits.js')));
  const loadRulesMod = await import(u('public', 'js', 'editor', 'rule_engine', 'load-rules.js'));
  vi.spyOn(loadRulesMod, 'getRulesCache').mockReturnValue({
    rule_grant: [], rule_nine_again: [], rule_skill_bonus: [], rule_speciality_grant: [],
    rule_tier_budget: [], rule_disc_attr: [], rule_derived_stat_modifier: [],
  });
  editMod = await import(u('public', 'js', 'editor', 'edit.js'));
  editMod.registerCallbacks(() => {}, () => {});
  stateMod = (await import(u('public', 'js', 'data', 'state.js'))).default;
  exportMod = await import(u('public', 'js', 'editor', 'export.js'));
  ({ applyBloodlineRulesFromDb } = await import(u('public', 'js', 'editor', 'rule_engine', 'bloodline-evaluator.js')));
});

/** Every path in `obj` whose last key is literally `bonus`. */
function bonusPaths(obj, prefix = '') {
  const out = [];
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (k === 'bonus') out.push(p);
    out.push(...bonusPaths(v, p));
  }
  return out;
}

/** Slice a brace-balanced block starting at the first `{` at or after `declRe`'s match. */
function sliceBlock(src, declRe) {
  const m = declRe.exec(src);
  if (!m) throw new Error(`declaration not found: ${declRe}`);
  const open = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error(`unbalanced braces scanning ${declRe}`);
}

/** The REAL buildSaveBody from admin.js, with the module-level sets it closes over. */
function loadRealBuildSaveBody() {
  const src = read('public/js/admin.js');
  const legacy = /const _LEGACY_FIELDS = new Set\([^;]*\);/.exec(src)[0];
  const deprecated = /const _DEPRECATED_FIELDS = new Set\([^;]*\);/.exec(src)[0];
  const fn = sliceBlock(src, /function buildSaveBody\(c\)\s*\{/);
  // eslint-disable-next-line no-new-func
  return new Function('withoutTraitBonus', `${legacy}\n${deprecated}\n${fn}\nreturn buildSaveBody;`)(withoutTraitBonus);
}

/** A live-shaped character: stored zero bonuses (as all 44 live characters carry today) plus an
 *  ST Mods overlay that materialises nonzero `bonus` leaves in memory. */
function overlaidCharacter() {
  const c = {
    _id: 'c-105', name: 'Jack Fallow', clan: 'Daeva', covenant: 'Circle of the Crone',
    attributes: { Presence: { dots: 3, bonus: 0, cp: 2, xp: 0 }, Wits: { dots: 2, bonus: 0, cp: 1, xp: 0 } },
    skills: { Persuasion: { dots: 2, bonus: 0, specs: [], nine_again: false, cp: 2, xp: 0 } },
    disciplines: { Majesty: { dots: 2, cp: 2, xp: 0 } },
    merits: [
      { category: 'general', name: 'Striking Looks', rating: 2, cp: 2, xp: 0, bonus: 0 },
      { category: 'influence', name: 'Sway', area: 'Military', rating: 1, cp: 1, xp: 0 },
    ],
    current: { willpower: 3 },
    derived: { defence: 2 },
  };
  applyStMods(c, [
    { stat_path: 'attributes.Presence.bonus', delta: 3, active: true, reason: 'Mantle of Amorous Fire' },
    { stat_path: 'skills.Brawl.bonus', delta: 1, active: true, reason: 'materialises a new skill' },
    { stat_path: 'merits.1.bonus', delta: 2, active: true, reason: '10.2b-style merit row' },
    { stat_path: 'disciplines.Majesty.bonus', delta: 1, active: true, reason: 'discipline slot' },
  ], true);
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// The pure helper
// ─────────────────────────────────────────────────────────────────────────────

describe('10.5 withoutTraitBonus (shared with the TM Game server)', () => {
  it('removes bonus from attributes, skills, disciplines and merits, zero or nonzero', () => {
    const body = {
      name: 'X',
      attributes: { Wits: { dots: 2, bonus: 0, cp: 1 }, Presence: { dots: 3, bonus: 2 } },
      skills: { Brawl: { dots: 1, bonus: 0, specs: ['Grapple'], nine_again: true } },
      disciplines: { Majesty: { dots: 2, bonus: 1 } },
      merits: [{ name: 'Sway', rating: 1, bonus: 3, cp: 1 }, { name: 'Allies', rating: 2 }],
    };
    const out = withoutTraitBonus(body);
    expect(bonusPaths(out)).toEqual([]);
    expect(out.attributes.Wits).toEqual({ dots: 2, cp: 1 });
    expect(out.skills.Brawl).toEqual({ dots: 1, specs: ['Grapple'], nine_again: true });
    expect(out.merits).toEqual([{ name: 'Sway', rating: 1, cp: 1 }, { name: 'Allies', rating: 2 }]);
  });

  it('never mutates its input', () => {
    const body = { attributes: { Wits: { dots: 2, bonus: 0 } }, merits: [{ name: 'Sway', bonus: 3 }] };
    const snapshot = JSON.parse(JSON.stringify(body));
    withoutTraitBonus(body);
    expect(body).toEqual(snapshot);
  });

  it('returns a body with no bonus anywhere unchanged (same reference)', () => {
    const body = { name: 'X', attributes: { Wits: { dots: 2 } }, merits: [{ name: 'Sway', rating: 1 }] };
    expect(withoutTraitBonus(body)).toBe(body);
  });

  it('leaves every key that is not literally a trait-level bonus alone', () => {
    const body = {
      bonus: 7,                                            // top level: not a trait
      bonus_dice: 2,
      attributes: { Wits: { dots: 2, bonus_dots: 1, nested: { bonus: 4 } } },
      merits: [{ name: 'Sway', rule_bonus_success: 1, benefit_grants: [{ bonus: 1 }] }],
      fighting_styles: [{ name: 'Boxing', bonus: 1 }],    // not a trait family
    };
    expect(withoutTraitBonus(body)).toEqual(body);
  });

  it('tolerates odd shapes without throwing', () => {
    for (const odd of [null, undefined, 0, 'str', [], [{ bonus: 1 }]]) {
      expect(() => withoutTraitBonus(odd)).not.toThrow();
      expect(withoutTraitBonus(odd)).toBe(odd);
    }
    const body = {
      attributes: null,
      skills: ['Brawl'],
      disciplines: 'none',
      merits: [null, 'Sway', 3, ['bonus'], { name: 'Allies', bonus: 0 }],
    };
    let out;
    expect(() => { out = withoutTraitBonus(body); }).not.toThrow();
    expect(out.attributes).toBeNull();
    expect(out.skills).toEqual(['Brawl']);
    expect(out.disciplines).toBe('none');
    expect(out.merits).toEqual([null, 'Sway', 3, ['bonus'], { name: 'Allies' }]);
    const notArray = { merits: { 0: { bonus: 1 } } };
    expect(withoutTraitBonus(notArray)).toBe(notArray);
  });

  it('tolerates a null trait inside a family map', () => {
    const body = { attributes: { Wits: null, Presence: { dots: 2, bonus: 0 } } };
    expect(withoutTraitBonus(body).attributes).toEqual({ Wits: null, Presence: { dots: 2 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stop FORWARDING: the two save paths, against an overlaid character
// ─────────────────────────────────────────────────────────────────────────────

describe('10.5 buildSaveBody (admin.js, the real source) never forwards bonus', () => {
  it('an overlaid character produces a save body with no bonus key anywhere', () => {
    const buildSaveBody = loadRealBuildSaveBody();
    const c = overlaidCharacter();
    // Precondition: the overlay really did put nonzero bonus leaves in memory.
    expect(c.attributes.Presence.bonus).toBe(3);
    expect(c.skills.Brawl.bonus).toBe(1);
    expect(c.merits[1].bonus).toBe(2);
    expect(c.disciplines.Majesty.bonus).toBe(1);

    const body = buildSaveBody(c);
    expect(bonusPaths(body)).toEqual([]);
    // Everything else is still sent, and the existing strips still hold.
    expect(body.attributes.Presence).toMatchObject({ dots: 3, cp: 2, xp: 0 });
    expect(body.merits[0]).toEqual({ category: 'general', name: 'Striking Looks', rating: 2, cp: 2, xp: 0 });
    expect(body._id).toBeUndefined();
    expect(body.current).toBeUndefined();
    expect(body.derived).toBeUndefined();
    expect(body._st_mod_overlay).toBeUndefined();
    expect(body._st_mod_base).toBeUndefined();
  });

  it('the in-memory character keeps its overlay values (strip is copy-only)', () => {
    const buildSaveBody = loadRealBuildSaveBody();
    const c = overlaidCharacter();
    buildSaveBody(c);
    expect(c.attributes.Presence.bonus).toBe(3);
    expect(c.merits[1].bonus).toBe(2);
    expect(getAttrEffective(c, 'Presence')).toBeGreaterThanOrEqual(6);
  });
});

describe('10.5 charsForSave (export.js) never stashes bonus', () => {
  it('an overlaid character is stashed with no bonus key anywhere', () => {
    const c = overlaidCharacter();
    stateMod.chars = [c];
    const [saved] = exportMod.charsForSave();
    expect(bonusPaths(saved)).toEqual([]);
    expect(saved.attributes.Presence.dots).toBe(3);
    // NOT asserted: what happens to a container the overlay itself created (skills.Brawl here).
    // charsForSave deep-clones through JSON, which drops the `undefined` entries in _st_mod_base,
    // so stripOverlay cannot delete an overlay-created leaf on the copy. A pre-existing gap (it
    // used to stash `{ bonus: 1 }`; the strip now drops the emptied trait key instead of saving
    // `{}`), reported in the 10.5 Dev Agent Record.
    // Copy-only.
    expect(c.attributes.Presence.bonus).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stop EMITTING: the constructors and setters
// ─────────────────────────────────────────────────────────────────────────────

describe('10.5 accessors: setAttrVal / setSkillObj stop writing a zero bonus', () => {
  it('setAttrVal on a new attribute writes dots only', () => {
    const c = {};
    setAttrVal(c, 'Wits', 2, 0);
    expect(c.attributes.Wits).toEqual({ dots: 2 });
  });

  it('setAttrVal preserves cp/xp/free/rule_key and drops a stored zero bonus', () => {
    const c = { attributes: { Wits: { dots: 1, bonus: 0, cp: 1, xp: 4, free: 0, rule_key: null } } };
    setAttrVal(c, 'Wits', 3, getAttrBonus(c, 'Wits'));
    expect(c.attributes.Wits).toEqual({ dots: 3, cp: 1, xp: 4, free: 0, rule_key: null });
  });

  it('setAttrVal carries a nonzero in-memory (overlay) bonus through for display', () => {
    const c = { attributes: { Presence: { dots: 3, bonus: 2, cp: 2 } } };
    setAttrVal(c, 'Presence', 4, getAttrBonus(c, 'Presence'));
    expect(c.attributes.Presence).toEqual({ dots: 4, bonus: 2, cp: 2 });
  });

  it('setSkillObj on a new skill writes no bonus', () => {
    const c = {};
    setSkillObj(c, 'Brawl', { dots: 2, bonus: 0, specs: [], nine_again: false });
    expect(c.skills.Brawl).toEqual({ dots: 2, specs: [], nine_again: false });
  });

  it('setSkillObj still deletes an empty skill, and carries a nonzero overlay bonus', () => {
    const c = { skills: { Brawl: { dots: 1, bonus: 0, specs: [], nine_again: false } } };
    setSkillObj(c, 'Brawl', { dots: 0, bonus: 0, specs: [], nine_again: false });
    expect(c.skills.Brawl).toBeUndefined();
    setSkillObj(c, 'Athletics', { dots: 0, bonus: 1, specs: [], nine_again: false });
    expect(c.skills.Athletics).toEqual({ dots: 0, bonus: 1, specs: [], nine_again: false });
  });

  it('the attrs-tab dot handlers round-trip through the setters without adding bonus', () => {
    // clickAttrDot (attrs-tab.js:83) passes getAttrBonus(c, attr) straight back in; clickSkillDot,
    // toggleNineAgain and updSkillSpec pass getSkillObj(c, skill), which always reports bonus 0.
    const c = { attributes: { Wits: { dots: 2, cp: 1 } }, skills: { Brawl: { dots: 1, specs: [], nine_again: false } } };
    setAttrVal(c, 'Wits', 3, getAttrBonus(c, 'Wits'));
    const sk = getSkillObj(c, 'Brawl');
    sk.nine_again = true;
    setSkillObj(c, 'Brawl', sk);
    expect(bonusPaths(c)).toEqual([]);
  });
});

describe('10.5 merits.js: ensureMeritSync / addMerit stop defaulting bonus', () => {
  it('ensureMeritSync backfills the creation channels but never adds bonus', () => {
    const c = { merits: [{ name: 'Allies', rating: 2 }] };
    ensureMeritSync(c);
    expect(c.merits[0].cp).toBe(0);
    expect(c.merits[0].free_mci).toBe(0);
    expect('bonus' in c.merits[0]).toBe(false);
  });

  it('ensureMeritSync leaves an existing in-memory bonus untouched (the overlay slot)', () => {
    const c = { merits: [{ name: 'Sway', rating: 1, bonus: 2 }] };
    ensureMeritSync(c);
    expect(c.merits[0].bonus).toBe(2);
  });

  it('addMerit appends a merit with no bonus key', () => {
    const c = {};
    addMerit(c, { category: 'general', name: 'Resources', rating: 1 });
    expect(c.merits[0].rule_key).toBeNull();
    expect('bonus' in c.merits[0]).toBe(false);
  });
});

describe('10.5 edit.js constructors build traits without bonus', () => {
  function editing(c) {
    stateMod.chars = [c];
    stateMod.editIdx = 0;
    return c;
  }

  it('shEditAttrPt (edit.js:564) creates a missing attribute without bonus', () => {
    const c = editing({ name: 'T', attributes: {}, attribute_priorities: { Mental: 'Primary', Physical: 'Secondary', Social: 'Tertiary' } });
    editMod.shEditAttrPt('Wits', 'xp', 0);
    expect(c.attributes.Wits).toBeDefined();
    expect('bonus' in c.attributes.Wits).toBe(false);
  });

  it('shSetClanAttr (edit.js:615) creates a missing attribute without bonus', () => {
    const c = editing({ name: 'T', attributes: {}, clan_attribute: null });
    editMod.shSetClanAttr('Presence');
    expect(c.attributes.Presence).toBeDefined();
    expect('bonus' in c.attributes.Presence).toBe(false);
  });

  it('shAddSpec (edit.js:722) creates a missing skill without bonus', () => {
    const c = editing({ name: 'T', skills: {} });
    editMod.shAddSpec('Occult');
    expect(c.skills.Occult.specs).toEqual(['']);
    expect('bonus' in c.skills.Occult).toBe(false);
  });

  it('shEditSkillPt (edit.js:750) creates a missing skill without bonus', () => {
    const c = editing({ name: 'T', skills: {}, skill_priorities: { Mental: 'Primary', Physical: 'Secondary', Social: 'Tertiary' } });
    editMod.shEditSkillPt('Occult', 'xp', 0);
    expect(c.skills.Occult).toBeDefined();
    expect('bonus' in c.skills.Occult).toBe(false);
  });
});

describe('10.5 bloodline-evaluator: a granted speciality skill is built without bonus', () => {
  it('applyBloodlineRulesFromDb (bloodline-evaluator.js:40)', () => {
    const c = { bloodline: 'Gorgons', skills: {}, merits: [] };
    applyBloodlineRulesFromDb(c, {
      grants: [{ condition: 'bloodline', bloodline_name: 'Gorgons', grant_type: 'speciality', target: 'Animal Ken', target_qualifier: 'Snakes' }],
    });
    expect(c.skills['Animal Ken'].specs).toEqual(['Snakes']);
    expect('bonus' in c.skills['Animal Ken']).toBe(false);
  });
});

describe('10.5 new-character documents carry no bonus (admin.js new character, wizard)', () => {
  it('admin.js blank character (admin.js:982, 988) has no bonus key', () => {
    const block = sliceBlock(read('public/js/admin.js'), /const blank = \{/);
    expect(block).toMatch(/attributes: Object\.fromEntries/);
    expect(block).not.toMatch(/\bbonus\b/);
  });

  it('wizard buildCharDoc (wizard.js:678, 688) has no bonus key', () => {
    const block = sliceBlock(read('public/js/tabs/wizard.js'), /function buildCharDoc\(\)\s*\{/);
    expect(block).toMatch(/attributes\[attr\] = \{/);
    expect(block).not.toMatch(/\bbonus\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Readers are KEPT by the ruling: a missing bonus must read as 0
// ─────────────────────────────────────────────────────────────────────────────

describe('10.5 readers treat a missing bonus as 0', () => {
  it('attribute and skill readers', () => {
    const c = { attributes: { Wits: { dots: 3 } }, skills: { Brawl: { dots: 2, specs: [] } }, disciplines: {}, merits: [] };
    expect(getAttrBonus(c, 'Wits')).toBe(0);
    expect(getAttrTotal(c, 'Wits')).toBe(3);
    expect(getAttrEffective(c, 'Wits')).toBe(3);
    expect(getSkillObj(c, 'Brawl').bonus).toBe(0);
    expect(skBonus(c, 'Brawl')).toBe(0);
  });

  it('a stripped save body re-read through the readers gives the same base totals', () => {
    const buildSaveBody = loadRealBuildSaveBody();
    const c = overlaidCharacter();
    const body = buildSaveBody(c);
    expect(getAttrTotal(body, 'Presence')).toBe(3);
    expect(getAttrTotal(body, 'Wits')).toBe(2);
  });
});
