/**
 * TM Admin Story tm-admin.10.2a AC9 — `attrObj` no longer REQUIRES `bonus`.
 *
 * The property stays declared (integer >= 0) and `additionalProperties` is unchanged, so no live
 * document is affected; only the requirement goes. `required` is enforced by the FULL schema only
 * (POST /api/characters and POST /api/characters/wizard); every PUT validates against
 * `characterPartialSchema`, which `derivePartialSchema()` builds with `required` stripped at every
 * depth. So this changes no save. Mirrors TM Admin's own server/schemas/character.schema.test.js.
 */

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { characterSchema, characterPartialSchema } from '../schemas/character.schema.js';

const ajv = new Ajv({ allErrors: true });
const validateFull = ajv.compile(characterSchema);
const validatePartial = ajv.compile(characterPartialSchema);

const NINE = ['Intelligence', 'Wits', 'Resolve', 'Strength', 'Dexterity', 'Stamina', 'Presence', 'Manipulation', 'Composure'];
const attrs = (make) => Object.fromEntries(NINE.map((a) => [a, make(a)]));
const doc = (over = {}) => ({ name: 'Test Character', attributes: attrs(() => ({ dots: 1 })), ...over });

describe('attrObj bonus is optional (tm-admin.10.2a AC9)', () => {
  it('validates an attribute object WITHOUT a bonus key', () => {
    expect(validateFull(doc())).toBe(true);
  });

  it('still validates bonus: 0 and a nonzero bonus (the property stays declared)', () => {
    expect(validateFull(doc({ attributes: attrs(() => ({ dots: 1, bonus: 0 })) }))).toBe(true);
    expect(validateFull(doc({ attributes: attrs(() => ({ dots: 1, bonus: 2 })) }))).toBe(true);
  });

  it('still rejects a negative bonus, an attribute with no dots, and an unknown property', () => {
    expect(validateFull(doc({ attributes: attrs(() => ({ dots: 1, bonus: -1 })) }))).toBe(false);
    expect(validateFull(doc({ attributes: attrs(() => ({ bonus: 0 })) }))).toBe(false);
    expect(validateFull(doc({ attributes: attrs(() => ({ dots: 1, nonsense: 1 })) }))).toBe(false);
  });

  it('leaves skill and discipline bonus optional, as before', () => {
    expect(validateFull(doc({ skills: { Brawl: { dots: 2 } }, disciplines: { Majesty: { dots: 1 } } }))).toBe(true);
  });
});

describe('the PUT partial schema strips required at every depth (characterisation)', () => {
  it('lets a trait object with no dots pass a partial save (how the two live {} rows persisted)', () => {
    expect(validatePartial({ attributes: { Presence: {} } })).toBe(true);
    expect(validatePartial({ disciplines: { Dominate: {} } })).toBe(true);
  });
});
