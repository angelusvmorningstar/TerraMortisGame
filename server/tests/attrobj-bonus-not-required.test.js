/**
 * TM Admin Story tm-admin.10.2a AC9, revised by Story tm-admin.10.5 (Phase C, AC6).
 *
 * 10.2a made `attrObj.bonus` optional. 10.5 removes `bonus` from all four trait definitions (attrObj,
 * skillObj, discObj, merit): it is an in-memory overlay slot only and is never stored. With
 * `additionalProperties: false` unchanged, a body carrying a trait-level `bonus` is now REJECTED by
 * the schema, in full and partial mode alike, with the error naming `bonus`. The character write
 * routes strip it before validation (public/js/data/strip-trait-bonus.js, Angelus's 2026-10-01
 * "strip silently" ruling); the last block proves a body with `bonus` passes once stripped, with
 * `bonus` gone. The route-level proof (the real middleware order) is in
 * tm-admin-10.5-character-routes-strip-bonus.test.js. Mirrors TM Admin's own
 * server/schemas/character.schema.test.js.
 *
 * `required` is enforced by the FULL schema only (POST /api/characters and POST /api/characters/wizard);
 * every PUT validates against `characterPartialSchema`, which `derivePartialSchema()` builds with
 * `required` stripped at every depth but `additionalProperties` kept. The partial-schema block pins both.
 */

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { characterSchema, characterPartialSchema } from '../schemas/character.schema.js';
import { withoutTraitBonus } from '../../public/js/data/strip-trait-bonus.js';

const ajv = new Ajv({ allErrors: true });
const validateFull = ajv.compile(characterSchema);
const validatePartial = ajv.compile(characterPartialSchema);

const NINE = ['Intelligence', 'Wits', 'Resolve', 'Strength', 'Dexterity', 'Stamina', 'Presence', 'Manipulation', 'Composure'];
const attrs = (make) => Object.fromEntries(NINE.map((a) => [a, make(a)]));
const doc = (over = {}) => ({ name: 'Test Character', attributes: attrs(() => ({ dots: 1 })), ...over });

// One body per trait family, each carrying a trait-level `bonus` of the given value.
const FAMILY_BODIES = {
  attributes: (b) => ({ attributes: attrs(() => ({ dots: 1, bonus: b })) }),
  skills: (b) => ({ skills: { Brawl: { dots: 2, bonus: b } } }),
  disciplines: (b) => ({ disciplines: { Majesty: { dots: 1, bonus: b } } }),
  merits: (b) => ({ merits: [{ category: 'general', name: 'Resources', rating: 1, bonus: b }] }),
};
const additionalBonusError = (validate) =>
  (validate.errors || []).some((e) => e.keyword === 'additionalProperties' && e.params.additionalProperty === 'bonus');

describe('attrObj without bonus (tm-admin.10.2a AC9, still true)', () => {
  it('validates an attribute object WITHOUT a bonus key', () => {
    expect(validateFull(doc())).toBe(true);
  });

  it('still rejects a negative bonus, an attribute with no dots, and an unknown property', () => {
    expect(validateFull(doc({ attributes: attrs(() => ({ dots: 1, bonus: -1 })) }))).toBe(false);
    expect(validateFull(doc({ attributes: attrs(() => ({ bonus: 0 })) }))).toBe(false);
    expect(validateFull(doc({ attributes: attrs(() => ({ dots: 1, nonsense: 1 })) }))).toBe(false);
  });

  it('validates skill, discipline and merit objects without bonus', () => {
    expect(validateFull(doc({ skills: { Brawl: { dots: 2 } }, disciplines: { Majesty: { dots: 1 } } }))).toBe(true);
    expect(validateFull(doc({ merits: [{ category: 'general', name: 'Resources', rating: 1 }] }))).toBe(true);
  });
});

describe('no trait declares bonus (tm-admin.10.5 Phase C, AC6)', () => {
  it('the four trait definitions no longer list bonus, and stay additionalProperties: false', () => {
    for (const def of ['attrObj', 'skillObj', 'discObj', 'merit']) {
      expect(Object.keys(characterSchema.definitions[def].properties)).not.toContain('bonus');
      expect(characterSchema.definitions[def].additionalProperties).toBe(false);
    }
  });

  it('every other trait property and the required arrays are intact', () => {
    const d = characterSchema.definitions;
    expect(Object.keys(d.attrObj.properties)).toEqual(['dots', 'cp', 'xp', 'rule_key']);
    expect(Object.keys(d.skillObj.properties)).toEqual(['dots', 'specs', 'nine_again', 'cp', 'xp', 'rule_key']);
    expect(Object.keys(d.discObj.properties)).toEqual(['dots', 'cp', 'xp', 'free', 'rule_key']);
    expect(d.attrObj.required).toEqual(['dots']);
    expect(d.skillObj.required).toEqual(['dots']);
    expect(d.discObj.required).toEqual(['dots']);
    expect(d.merit.required).toEqual(['category', 'name']);
  });

  for (const [family, make] of Object.entries(FAMILY_BODIES)) {
    it(`the FULL schema rejects a stored ${family} bonus, zero or nonzero, naming bonus`, () => {
      for (const b of [0, 2]) {
        expect(validateFull(doc(make(b)))).toBe(false);
        expect(additionalBonusError(validateFull)).toBe(true);
      }
    });

    it(`the PARTIAL (PUT) schema rejects a ${family} bonus when validated WITHOUT the strip`, () => {
      for (const b of [0, 2]) {
        expect(validatePartial(make(b))).toBe(false);
        expect(additionalBonusError(validatePartial)).toBe(true);
      }
    });

    it(`a ${family} body WITH bonus passes once stripped, with bonus removed`, () => {
      for (const b of [0, 2]) {
        const stripped = withoutTraitBonus(make(b));
        expect(JSON.stringify(stripped)).not.toMatch(/"bonus"/);
        expect(validatePartial(stripped)).toBe(true);
        expect(validateFull(doc(stripped))).toBe(true);
      }
    });
  }
});

describe('the PUT partial schema strips required at every depth (characterisation)', () => {
  it('lets a trait object with no dots pass a partial save (how the two live {} rows persisted)', () => {
    expect(validatePartial({ attributes: { Presence: {} } })).toBe(true);
    expect(validatePartial({ disciplines: { Dominate: {} } })).toBe(true);
  });
});
