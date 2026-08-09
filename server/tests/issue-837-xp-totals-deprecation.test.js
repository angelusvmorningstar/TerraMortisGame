/**
 * Issue #837 — xp_total / xp_spent deprecation tests.
 *
 * Four slices:
 *   1. Schema static guard — properties block in character.schema.js no longer
 *      declares xp_total / xp_spent. Re-introducing them in the schema
 *      would re-enable the persistence path Option A is closing.
 *   2. Client-write strip guard — buildSaveBody in public/js/admin.js strips
 *      both fields before PUT (static-text check, since admin.js depends on
 *      browser globals and can't be import()ed under vitest's node env).
 *   3. Behavioural: render-time derivation tracks humanity drops without
 *      any field-write on the doc (the key dispatch assertion). Imports
 *      editor/xp.js directly (pure module).
 *   4. Integration test calling main() end-to-end with --apply against the
 *      test MongoDB — seeds a fully-formed character WITH xp_total/xp_spent
 *      plus attributes/skills/etc, asserts the deprecated fields are
 *      $unset and every other field SURVIVES (the prod-incident assertion
 *      from #828). MUST fail against any replaceOne-with-projection variant.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDb, teardownDb } from './helpers/db-setup.js';
import { getCollection } from '../db.js';
import { characterSchema } from '../schemas/character.schema.js';
import { main } from '../scripts/cleanup-xp-totals-deprecation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }

const TEST_FLAG = '_issue_837_integration_test';

beforeAll(async () => { await setupDb(); });
afterAll(async () => {
  const col = getCollection('characters');
  await col.deleteMany({ [TEST_FLAG]: true });
  await teardownDb();
});
beforeEach(async () => {
  const col = getCollection('characters');
  await col.deleteMany({ [TEST_FLAG]: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema static guard
// ─────────────────────────────────────────────────────────────────────────────

describe('#837 — character schema no longer declares xp_total / xp_spent', () => {
  it('characterSchema.properties does not include xp_total', () => {
    expect(characterSchema.properties.xp_total).toBeUndefined();
  });
  it('characterSchema.properties does not include xp_spent', () => {
    expect(characterSchema.properties.xp_spent).toBeUndefined();
  });
  it('schema still has additionalProperties:false so unknown fields are rejected', () => {
    // This is the mechanism that makes Option A enforceable: a client that
    // resends xp_total on PUT gets rejected at the validation boundary.
    expect(characterSchema.additionalProperties).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client-write strip guard
// ─────────────────────────────────────────────────────────────────────────────

describe('#837 — buildSaveBody strips xp_total / xp_spent', () => {
  const src = read('public/js/admin.js');

  it('declares _DEPRECATED_FIELDS containing xp_total + xp_spent', () => {
    expect(src).toMatch(/_DEPRECATED_FIELDS\s*=\s*new\s+Set\(\[\s*'xp_total'\s*,\s*'xp_spent'/);
  });

  it('buildSaveBody references _DEPRECATED_FIELDS in its strip check', () => {
    const fnStart = src.indexOf('function buildSaveBody');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = src.indexOf('\n}\n', fnStart);
    const body = src.slice(fnStart, fnEnd);
    expect(body).toMatch(/_DEPRECATED_FIELDS\.has\(k\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioural — derivation tracks state mutations without field writes
// ─────────────────────────────────────────────────────────────────────────────

// xp.js transitively imports public/js/data/api.js which reads the browser
// `location` global at module load. Stub it before dynamic import so the
// module loads cleanly under vitest's node env. xpEarned / xpSpent / xpLeft
// themselves don't touch fetch — they're pure derivation off the character
// shape — so a no-op location stub is sufficient.

describe('#837 — render-time derivation tracks state without persisting xp fields', () => {
  it('xpLeft reflects humanity drop without xp_total / xp_spent being mutated on doc', async () => {
    if (typeof globalThis.location === 'undefined') {
      globalThis.location = { hostname: '' };
    }
    const { xpEarned, xpSpent, xpLeft } = await import('../../public/js/editor/xp.js');

    const c = {
      humanity: 7,
      humanity_base: 7,
      ordeals: [],
      attributes: {}, skills: {}, disciplines: {}, merits: [], powers: [],
      attr_creation: { cp: 5, xp: 0 },
      skill_creation: { cp: 0, xp: 0 },
      disc_creation: { cp: 0, xp: 0 },
      merit_creation: { cp: 0, xp: 0 },
      xp_log: { earned: {}, spent: {} },
    };

    // Starting baseline: 10 starting + 0 drops + 0 ordeals + 0 game = 10.
    const totalBefore = xpEarned(c);
    const spentBefore = xpSpent(c);
    const leftBefore = xpLeft(c);
    expect(totalBefore).toBe(10);
    expect(leftBefore).toBe(totalBefore - spentBefore);

    // Mutate humanity (drop by 2): humanity drop awards 2 XP per dot lost,
    // so xpEarned should jump by 4 with NO field write on the doc.
    c.humanity = 5;
    const totalAfter = xpEarned(c);
    const leftAfter = xpLeft(c);
    expect(totalAfter).toBe(totalBefore + 4);
    expect(leftAfter).toBe(totalAfter - spentBefore);

    // Crucially: no safety-net field-write happened. The doc still has no
    // xp_total / xp_spent fields. (The whole point of Option A.)
    expect(c.xp_total).toBeUndefined();
    expect(c.xp_spent).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration test — main() end-to-end with --apply
// ─────────────────────────────────────────────────────────────────────────────

function seedDoc() {
  return {
    [TEST_FLAG]: true,
    name: '#837 Integration Test',
    clan: 'Nosferatu', covenant: 'Invictus', mask: 'Survivor', dirge: 'Curmudgeon',
    concept: 'Integration test fixture for #837',
    status: { city: 1, clan: 2, covenant: 3 },
    attributes: {
      Intelligence: { dots: 3, bonus: 0 }, Wits: { dots: 2, bonus: 0 }, Resolve: { dots: 2, bonus: 0 },
      Strength: { dots: 2, bonus: 0 }, Dexterity: { dots: 3, bonus: 0 }, Stamina: { dots: 2, bonus: 0 },
      Presence: { dots: 1, bonus: 0 }, Manipulation: { dots: 2, bonus: 0 }, Composure: { dots: 3, bonus: 0 },
    },
    skills: {
      Investigation: { dots: 3, bonus: 0, specs: ['Forensics'], nine_again: false },
      Stealth: { dots: 4, bonus: 0, specs: [], nine_again: false },
    },
    disciplines: { Auspex: 2, Obfuscate: 3 },
    powers: [],
    merits: [{ name: 'Safe Place', category: 'domain', cp: 2, xp: 0, qualifier: 'Apt' }],
    humanity: 6, humanity_base: 7, blood_potency: 1,
    aspirations: ['Survive'],
    // The deprecated fields — these are what the script must $unset.
    xp_total: 28,
    xp_spent: 16,
  };
}

describe('#837 — cleanup script main() integration (write-path safety)', () => {
  it('unsets xp_total / xp_spent + preserves ALL other fields when --apply runs', async () => {
    const col = getCollection('characters');
    const seed = seedDoc();
    const ins = await col.insertOne(seed);
    const id = ins.insertedId;
    const before = await col.findOne({ _id: id });
    expect(before.xp_total).toBe(28);
    expect(before.xp_spent).toBe(16);

    const origArgv = process.argv;
    process.argv = [...origArgv, '--apply'];
    try { await main(); } finally { process.argv = origArgv; }

    const after = await col.findOne({ _id: id });

    // Primary assertion: deprecated fields are gone.
    expect(after.xp_total).toBeUndefined();
    expect(after.xp_spent).toBeUndefined();
    expect('xp_total' in after).toBe(false);
    expect('xp_spent' in after).toBe(false);

    // Survival assertions (would all fail against replaceOne-with-projection).
    expect(after.clan).toBe(before.clan);
    expect(after.covenant).toBe(before.covenant);
    expect(after.status).toEqual(before.status);
    expect(after.attributes, 'attributes must survive — the field the #828 prod incident lost').toEqual(before.attributes);
    expect(after.skills).toEqual(before.skills);
    expect(after.disciplines).toEqual(before.disciplines);
    expect(after.merits).toEqual(before.merits);
    expect(after.humanity).toBe(before.humanity);
    expect(after.humanity_base).toBe(before.humanity_base);
    expect(after.blood_potency).toBe(before.blood_potency);
    expect(after.aspirations).toEqual(before.aspirations);
  });

  it('dry-run does not modify the document', async () => {
    const col = getCollection('characters');
    const seed = seedDoc();
    const ins = await col.insertOne(seed);
    const id = ins.insertedId;
    const before = await col.findOne({ _id: id });

    const origArgv = process.argv;
    process.argv = origArgv.filter(a => a !== '--apply');
    try { await main(); } finally { process.argv = origArgv; }

    const after = await col.findOne({ _id: id });
    expect(after).toEqual(before);
    expect(after.xp_total).toBe(28);
    expect(after.xp_spent).toBe(16);
  });

  it('idempotent: second --apply run leaves doc unchanged', async () => {
    const col = getCollection('characters');
    const seed = seedDoc();
    const ins = await col.insertOne(seed);
    const id = ins.insertedId;

    const origArgv = process.argv;
    process.argv = [...origArgv, '--apply'];
    try {
      await main();
      const afterFirst = await col.findOne({ _id: id });
      await main();
      const afterSecond = await col.findOne({ _id: id });
      expect(afterSecond).toEqual(afterFirst);
      expect(afterSecond.xp_total).toBeUndefined();
      expect(afterSecond.xp_spent).toBeUndefined();
      expect(afterSecond.attributes).toBeTruthy();
      expect(afterSecond.skills).toBeTruthy();
    } finally {
      process.argv = origArgv;
    }
  });

  it('no-op when no docs carry the deprecated fields (early return path)', async () => {
    const col = getCollection('characters');
    const seed = seedDoc();
    delete seed.xp_total;
    delete seed.xp_spent;
    const ins = await col.insertOne(seed);
    const id = ins.insertedId;
    const before = await col.findOne({ _id: id });

    const origArgv = process.argv;
    process.argv = [...origArgv, '--apply'];
    try { await main(); } finally { process.argv = origArgv; }

    const after = await col.findOne({ _id: id });
    expect(after).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup script placement / shape sanity guards
// ─────────────────────────────────────────────────────────────────────────────

describe('#837 — cleanup script shape guards', () => {
  const src = read('server/scripts/cleanup-xp-totals-deprecation.js');

  it('uses updateMany with $unset (NOT replaceOne)', () => {
    expect(src).toMatch(/updateMany\(/);
    expect(src).toMatch(/\$unset:\s*\{\s*xp_total:\s*['"]['"]\s*,\s*xp_spent:\s*['"]['"]/);
    expect(src).not.toMatch(/replaceOne\(/);
  });

  it('main() is exported + direct-invocation guarded', () => {
    expect(src).toMatch(/export async function main/);
    expect(src).toMatch(/import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/);
  });

  it('script defaults to dry-run; requires --apply to write', () => {
    expect(src).toMatch(/process\.argv\.includes\(['"]--apply['"]\)/);
    expect(src).toMatch(/DRY_RUN\s*=\s*!APPLY/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client-side deprecation sanity guards — sites that previously wrote xp_total
// ─────────────────────────────────────────────────────────────────────────────

describe('#837 — client-side writer sites no longer touch xp_total / xp_spent', () => {
  it('editor/edit.js has no `c.xp_total =` assignment anywhere', () => {
    const src = read('public/js/editor/edit.js');
    expect(src).not.toMatch(/c\.xp_total\s*=/);
    expect(src).not.toMatch(/c\.xp_spent\s*=/);
  });

  it('editor/identity.js no longer renders editable xp_total / xp_spent inputs', () => {
    const src = read('public/js/editor/identity.js');
    // The pre-#837 shape used updField('xp_total', ...). The new shape uses
    // disabled inputs sourced from xpEarned() / xpSpent().
    expect(src).not.toMatch(/updField\(['"]xp_total['"]/);
    expect(src).not.toMatch(/updField\(['"]xp_spent['"]/);
  });

  // tabs/wizard.js deleted (Wave 0, #1095) — it was unreachable from every HTML
  // entry point, so its xp_total / xp_spent assertion is satisfied by absence.
});
