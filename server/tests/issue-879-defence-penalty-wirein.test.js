/**
 * Issue #879 — defence_penalty wire-in (ADR-006).
 *
 * Three slices anchored on the SM brief's verbatim N-1 acceptance gates:
 *
 *   1. **Concern #4 (regression):** STM mod on derived.defence is visibly
 *      reflected in the displayed value, not just the marker. The
 *      pre-ADR-006 bug at sheet.js:441 + ADR-004 D5 — overlay populated
 *      `c._st_mod_overlay['derived.defence']` but the sheet read raw
 *      `calcDefence(c)` so the modded value never reached the DOM.
 *
 *   2. **Concern #8 (editor hint wording):** when >1 armour item is in
 *      state==='worn', editor/sheet.js surfaces the verbatim string
 *      _"Only one armour applies; highest defence_penalty wins."_ Wording
 *      must not drift; static-text assertion guards against rewording.
 *
 *   3. **Concern #9 (single-floor invariant):** the floor at 0 lives in
 *      exactly one place — the helper composition in equipment-derivation.js.
 *      No redundant `Math.max(0, ...)` clamps in the sheet renderer or in
 *      `applyStMods`. STM overlay can legitimately push the rendered value
 *      below 0 per ADR-004's no-bounds contract.
 *
 * Plus pure-helper tests for armourDefencePenalty, wornArmourCount,
 * materialiseDerivedDefence, defenceForDisplay, defenceMechanicalBase —
 * the behaviour contract from ADR-006 D1 / D2 / D2-FLOOR / D3 / D4 / D5.
 *
 * The behavioural slice imports equipment-derivation.js via dynamic import
 * with a browser-globals stub (the module reaches the cache module → api.js
 * which uses `location`). Same pattern ECM-1 / ECM-5 use.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(REPO_ROOT, rel)); }

// Convenience: deterministic test characters (no rules cache; minimal shape).
function mkChar(overrides = {}) {
  return {
    name: 'Fixture',
    attributes: {
      Dexterity: { dots: 3, bonus: 0 }, Wits: { dots: 3, bonus: 0 },
      Strength: { dots: 2, bonus: 0 }, Stamina: { dots: 2, bonus: 0 },
      Presence: { dots: 2, bonus: 0 }, Manipulation: { dots: 2, bonus: 0 },
      Composure: { dots: 2, bonus: 0 }, Intelligence: { dots: 2, bonus: 0 },
      Resolve: { dots: 2, bonus: 0 },
    },
    skills: { Athletics: { dots: 2, bonus: 0, specs: [], nine_again: false } },
    disciplines: {}, merits: [], equipment: [],
    ...overrides,
  };
}

// Synthetic catalogue lookup — tests inject this rather than reaching the cache.
function mkLookup(items) {
  const byId = new Map(items.map(it => [String(it._id), it]));
  return (id) => byId.get(String(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Static-analysis — file existence, exports, no redundant clamps
// ─────────────────────────────────────────────────────────────────────────────

describe('#879 — equipment-derivation.js module shape', () => {
  it('the helper module exists', () => {
    expect(exists('public/js/data/equipment-derivation.js')).toBe(true);
  });

  const src = read('public/js/data/equipment-derivation.js');

  it('exports armourDefencePenalty, materialiseDerivedDefence, defenceForDisplay, defenceMechanicalBase, wornArmourCount (D1 + D2 + D2-FLOOR + D3 + D4 + D5)', () => {
    expect(src).toMatch(/export\s+function\s+armourDefencePenalty\b/);
    expect(src).toMatch(/export\s+function\s+materialiseDerivedDefence\b/);
    expect(src).toMatch(/export\s+function\s+defenceForDisplay\b/);
    expect(src).toMatch(/export\s+function\s+defenceMechanicalBase\b/);
    expect(src).toMatch(/export\s+function\s+wornArmourCount\b/);
  });

  it('helper signature accepts an injectable catalogue lookup (default = ECM-5 cache reader)', () => {
    // armourDefencePenalty(c, catalogueLookup = getCatalogueEntry)
    expect(src).toMatch(/armourDefencePenalty\s*\(\s*c\s*,\s*catalogueLookup\s*=\s*getCatalogueEntry\s*\)/);
  });

  it('filters by state === \'worn\' (positive predicate, not !==)', () => {
    expect(src).toMatch(/item\.state\s*!==\s*['"]worn['"]/);
    expect(src).not.toMatch(/item\.state\s*===\s*['"]stashed['"]/);
  });

  it('filters by bucket === \'armour\'', () => {
    expect(src).toMatch(/entry\.bucket\s*!==\s*['"]armour['"]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concern #9 (single-floor invariant) — static-analysis
// ─────────────────────────────────────────────────────────────────────────────

describe('#879 — Concern #9 (single-floor invariant)', () => {
  it('the floor lives in equipment-derivation.js (Math.max(0, ...) on calcDefence)', () => {
    const src = read('public/js/data/equipment-derivation.js');
    // Both materialiseDerivedDefence and defenceMechanicalBase contain the clamp.
    const matches = src.match(/Math\.max\(\s*0\s*,\s*calcDefence\(c\)\s*-\s*armourDefencePenalty/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('public/js/data/st-mods.js adds NO defence-specific floor clamp', () => {
    const src = read('public/js/data/st-mods.js');
    // applyStMods's mechanical core only does base + delta; no defence-specific clamp.
    expect(src).not.toMatch(/Math\.max\(\s*0\s*,\s*[^)]*derived\.defence/);
  });

  it('public/js/editor/sheet.js adds NO defence-specific floor clamp at the render site', () => {
    const src = read('public/js/editor/sheet.js');
    // The defDisplay render line should not wrap the value in Math.max(0, ...).
    // It reads defenceForDisplay(c) verbatim.
    expect(src).toMatch(/defenceForDisplay\(c\)\}\$\{markerFor\(c,\s*['"]derived\.defence['"]/);
    expect(src).not.toMatch(/defDisplay\s*=\s*`\$\{Math\.max\(0/);
  });

  it('public/js/suite/sheet.js adds NO defence-specific floor clamp at the render site', () => {
    const src = read('public/js/suite/sheet.js');
    expect(src).toMatch(/defenceForDisplay\(c\)/);
    expect(src).not.toMatch(/\$\{Math\.max\(0,\s*defenceForDisplay/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concern #8 (editor hint wording verbatim)
// ─────────────────────────────────────────────────────────────────────────────

describe('#879 — Concern #8 (editor hint wording verbatim)', () => {
  const src = read('public/js/editor/sheet.js');

  it('renders the soft hint exactly as: "Only one armour applies; highest defence_penalty wins."', () => {
    // Verbatim match — drift in the hint wording is a failed AC.
    expect(src).toContain('Only one armour applies; highest defence_penalty wins.');
  });

  it('gates the hint on wornArmourCount(c) > 1 (not on byBucket.armour.length > 1, which would also count carried/stashed)', () => {
    expect(src).toMatch(/wornArmourCount\(c\)\s*>\s*1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Render-path orchestrator — materialisation runs BEFORE applyStMods
// (Concern #4 / pre-existing ADR-004 D5 display bug fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('#879 — Concern #4 (render-path orchestrator wires materialisation before applyStMods)', () => {
  // ADR-009 D1 moved the sequence out of admin.js into data/sheet-composition.js
  // so that admin.js and app.js could stop each keeping their own copy. The
  // invariant this guards is unchanged and is now asserted at the single site.
  // Do not re-point this at an entry point: if the sequence reappears in one,
  // adr-009-single-composition-site.test.js is what should fail.
  it('sheet-composition.js calls materialiseDerivedDefence before applyStMods', () => {
    const src = read('public/js/data/sheet-composition.js');
    const fnStart = src.indexOf('export async function renderSheetWithOverlay');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart);
    // Anchor past the edit-mode early return, which strips and re-materialises
    // without ever reaching applyStMods.
    const nonEdit = fnBody.slice(fnBody.indexOf('loadTrackerState === '));
    const idxMaterialise = nonEdit.indexOf('materialiseDerivedDefence');
    const idxApply       = nonEdit.indexOf('applyStMods(');
    expect(idxMaterialise).toBeGreaterThan(-1);
    expect(idxApply).toBeGreaterThan(-1);
    expect(idxMaterialise).toBeLessThan(idxApply);
  });

  it('admin.js boot pre-loops materialiseDerivedDefence BEFORE applyOverlayToAll', () => {
    const src = read('public/js/admin.js');
    // The bulk path: `for (const c of chars) materialiseDerivedDefence(c); await applyOverlayToAll(...)`.
    expect(src).toMatch(/for\s*\(\s*const\s+c\s+of\s+chars\s*\)\s*materialiseDerivedDefence\(c\)/);
  });

  it('app.js (player portal) pre-loops materialiseDerivedDefence BEFORE applyOverlayToAll at boot', () => {
    const src = read('public/js/app.js');
    expect(src).toMatch(/for\s*\(\s*const\s+c\s+of\s+\(suiteState\.chars\s*\|\|\s*\[\]\)\s*\)\s*materialiseDerivedDefence\(c\)/);
  });

  // ADR-009 D1 step 2 converged admin.js's and app.js's refreshCharacterOverlay
  // onto one implementation, so this invariant is now asserted once at the
  // shared site instead of twice at two copies that could disagree -- which is
  // exactly what they had started to do.
  it('the onStModUpdate path re-materialises before re-applying', () => {
    const src = read('public/js/data/sheet-composition.js');
    expect(src).toMatch(/materialiseDerivedDefence\(target\);\s*await\s+applyOverlayToAll\(\[target\]/);
  });

  it('neither entry point keeps its own copy of that sequence', () => {
    for (const rel of ['public/js/admin.js', 'public/js/app.js']) {
      expect(read(rel), `${rel} should delegate to data/sheet-composition.js`)
        .not.toMatch(/materialiseDerivedDefence\(target\);\s*await\s+applyOverlayToAll\(\[target\]/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Read-site sweep (sheet, suite/sheet, roll calc, combat-tab, exports)
// ─────────────────────────────────────────────────────────────────────────────

describe('#879 — read-site sweep migrates to defenceForDisplay / defenceMechanicalBase', () => {
  it('editor/sheet.js defDisplay reads defenceForDisplay (overlay-aware)', () => {
    const src = read('public/js/editor/sheet.js');
    expect(src).toMatch(/const\s+defDisplay\s*=\s*`\$\{defenceForDisplay\(c\)\}\$\{markerFor\(c,\s*['"]derived\.defence['"]\)/);
  });

  it('editor/sheet.js per-item armour annotation STILL calls raw calcDefence(c) per ADR-006 Concern #2', () => {
    const src = read('public/js/editor/sheet.js');
    // The pre-armour, pre-overlay hypothetical baseline: "if you wore only this item, defence would be X".
    expect(src).toMatch(/const\s+baseDefence\s*=\s*calcDefence\(c\)/);
  });

  it('suite/sheet.js defence cell reads defenceForDisplay', () => {
    const src = read('public/js/suite/sheet.js');
    expect(src).toMatch(/\$\{defenceForDisplay\(c\)\}\$\{markerFor\(c,\s*['"]derived\.defence['"]\)/);
  });

  it('game/char-pools.js (roll calculator) reads defenceForDisplay', () => {
    const src = read('public/js/game/char-pools.js');
    expect(src).toMatch(/const\s+defence\s*=\s*defenceForDisplay\(char\)/);
  });

  it('game/combat-tab.js (combat scene snapshot) reads defenceForDisplay', () => {
    const src = read('public/js/game/combat-tab.js');
    expect(src).toMatch(/defence:\s*defenceForDisplay\(c\)/);
  });

  it('editor/export-character.js JSON export uses defenceMechanicalBase (no overlay)', () => {
    const src = read('public/js/editor/export-character.js');
    expect(src).toMatch(/defence:\s*defenceMechanicalBase\(c\)/);
  });

  it('editor/csv-format.js CSV export uses defenceMechanicalBase (no overlay)', () => {
    const src = read('public/js/editor/csv-format.js');
    expect(src).toMatch(/row\.push\(\s*defenceMechanicalBase\(c\)\s*\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioural — dynamic import the helper module under the location stub.
// ─────────────────────────────────────────────────────────────────────────────

describe('#879 — armourDefencePenalty behaviour (D1 + D2)', () => {
  it('returns 0 when no worn armour is present', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const c = mkChar({ equipment: [] });
    expect(mod.armourDefencePenalty(c)).toBe(0);
  });

  it('returns 0 for armour items in non-worn states', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const items = [
      { _id: 'aaa1', bucket: 'armour', defence_penalty: 2 },
      { _id: 'aaa2', bucket: 'armour', defence_penalty: 3 },
    ];
    const c = mkChar({ equipment: [
      { catalogue_id: 'aaa1', state: 'carried' },
      { catalogue_id: 'aaa2', state: 'stashed' },
    ]});
    expect(mod.armourDefencePenalty(c, mkLookup(items))).toBe(0);
  });

  it('D1: filters by bucket === \'armour\' — ignores worn non-armour items', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const items = [
      { _id: 'wep1', bucket: 'weapon', defence_penalty: 5 },   // not armour, ignored
      { _id: 'arm1', bucket: 'armour', defence_penalty: 2 },
    ];
    const c = mkChar({ equipment: [
      { catalogue_id: 'wep1', state: 'worn' },
      { catalogue_id: 'arm1', state: 'worn' },
    ]});
    expect(mod.armourDefencePenalty(c, mkLookup(items))).toBe(2);
  });

  it('D2: returns the MAX defence_penalty across multiple worn armour items (worst-case stacking)', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const items = [
      { _id: 'arm1', bucket: 'armour', defence_penalty: 1 },
      { _id: 'arm2', bucket: 'armour', defence_penalty: 3 },
      { _id: 'arm3', bucket: 'armour', defence_penalty: 2 },
    ];
    const c = mkChar({ equipment: [
      { catalogue_id: 'arm1', state: 'worn' },
      { catalogue_id: 'arm2', state: 'worn' },
      { catalogue_id: 'arm3', state: 'worn' },
    ]});
    expect(mod.armourDefencePenalty(c, mkLookup(items))).toBe(3);
  });

  it('treats null/undefined/non-integer defence_penalty as 0', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const items = [
      { _id: 'a1', bucket: 'armour', defence_penalty: null },
      { _id: 'a2', bucket: 'armour', defence_penalty: undefined },
      { _id: 'a3', bucket: 'armour', defence_penalty: 'bad' },
    ];
    const c = mkChar({ equipment: items.map(it => ({ catalogue_id: it._id, state: 'worn' })) });
    expect(mod.armourDefencePenalty(c, mkLookup(items))).toBe(0);
  });

  it('ignores items with no catalogue match (fail-soft per Concern #5)', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const c = mkChar({ equipment: [{ catalogue_id: 'ghost', state: 'worn' }] });
    expect(mod.armourDefencePenalty(c, () => undefined)).toBe(0);
  });
});

describe('#879 — wornArmourCount (drives the editor hint)', () => {
  it('counts only worn-state armour items', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const items = [
      { _id: 'a1', bucket: 'armour' }, { _id: 'a2', bucket: 'armour' },
      { _id: 'a3', bucket: 'armour' }, { _id: 'w1', bucket: 'weapon' },
    ];
    const c = mkChar({ equipment: [
      { catalogue_id: 'a1', state: 'worn' },
      { catalogue_id: 'a2', state: 'worn' },
      { catalogue_id: 'a3', state: 'carried' },
      { catalogue_id: 'w1', state: 'worn' },
    ]});
    expect(mod.wornArmourCount(c, mkLookup(items))).toBe(2);
  });
});

describe('#879 — materialiseDerivedDefence (D3 + D4)', () => {
  it('writes c.derived.defence = max(0, calcDefence - armourDefencePenalty), floors at 0', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const accessors = await import('../../public/js/data/accessors.js');
    // calcDefence on the mkChar fixture: min(Dex=3, Wits=3) + Athletics=2 + discBonus=0 = 5.
    const c = mkChar({ equipment: [{ catalogue_id: 'arm1', state: 'worn' }] });
    const items = [{ _id: 'arm1', bucket: 'armour', defence_penalty: 2 }];
    const result = mod.materialiseDerivedDefence(c, mkLookup(items));
    expect(result).toBe(accessors.calcDefence(c) - 2);
    expect(c.derived.defence).toBe(result);
  });

  it('D2-FLOOR: clamps to 0 when armourPenalty exceeds base defence', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    // Tiny char: Dex=1, Wits=1, Athletics=0 → calcDefence = 1.
    const tinyChar = mkChar({
      attributes: { ...mkChar().attributes, Dexterity: { dots: 1, bonus: 0 }, Wits: { dots: 1, bonus: 0 } },
      skills: {},
      equipment: [{ catalogue_id: 'arm1', state: 'worn' }],
    });
    const items = [{ _id: 'arm1', bucket: 'armour', defence_penalty: 5 }];
    expect(mod.materialiseDerivedDefence(tinyChar, mkLookup(items))).toBe(0);
  });
});

describe('#879 — defenceForDisplay (read-site helper)', () => {
  it('returns materialised c.derived.defence when present', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const c = mkChar({ derived: { defence: 42 } });
    expect(mod.defenceForDisplay(c)).toBe(42);
  });

  it('Concern #4 verbatim: STM mod on derived.defence is visibly reflected (modded > base)', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const accessors = await import('../../public/js/data/accessors.js');
    // Materialise then simulate applyStMods writing the modded value to c.derived.defence.
    const c = mkChar({ equipment: [] });
    mod.materialiseDerivedDefence(c);
    const base = accessors.calcDefence(c);
    expect(c.derived.defence).toBe(base);
    // Simulate STM mod: +3
    c.derived.defence = base + 3;
    expect(mod.defenceForDisplay(c)).toBe(base + 3);
  });

  it('Concern #4 verbatim: STM mod can push displayed defence below 0 per ADR-004 no-bounds (single-floor invariant Concern #9)', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    // Pre-condition: c.derived.defence = 1 (post-materialisation, no overlay).
    // STM mod = -5 → c.derived.defence = -4.
    const c = mkChar({ derived: { defence: -4 } });
    // defenceForDisplay reads the materialised value verbatim — no defensive
    // clamp. The renderer displays -4. (Concern #9: floor lives only at
    // materialiseDerivedDefence, NOT here.)
    expect(mod.defenceForDisplay(c)).toBe(-4);
  });
});

describe('#879 — defenceMechanicalBase (export-site helper)', () => {
  it('always computes fresh — ignores c.derived.defence (which may carry overlay)', async () => {
    if (typeof globalThis.location === 'undefined') globalThis.location = { hostname: '' };
    const mod = await import('../../public/js/data/equipment-derivation.js');
    const accessors = await import('../../public/js/data/accessors.js');
    // Even if c.derived.defence is overlay-modded to some weird value,
    // defenceMechanicalBase returns the canonical mechanical baseline.
    const c = mkChar({
      equipment: [{ catalogue_id: 'arm1', state: 'worn' }],
      derived: { defence: 99 },   // overlay-modded; should be ignored
    });
    const items = [{ _id: 'arm1', bucket: 'armour', defence_penalty: 2 }];
    const result = mod.defenceMechanicalBase(c, mkLookup(items));
    expect(result).toBe(Math.max(0, accessors.calcDefence(c) - 2));
    expect(result).not.toBe(99);
  });
});
