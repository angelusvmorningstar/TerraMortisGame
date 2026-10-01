/**
 * withoutTraitBonus: return a character body with every trait-level `bonus` key removed.
 *
 * TM Admin Story tm-admin.10.5 (Epic 10, the contract phase for `bonus`). By Angelus's
 * 2026-09-28 ruling `bonus` is a RUNTIME-ONLY overlay slot: ST Mods add onto a trait's
 * `bonus` leaf in memory when a sheet loads, and nothing is ever persisted there. Angelus's
 * 2026-10-01 ruling for a stale client that still sends one: strip it silently on the way
 * in, before validation, so the save never fails and the key never reaches the database.
 *
 * Scope, deliberately narrow:
 *   - body.attributes[name], body.skills[name], body.disciplines[name] (objects of trait
 *     objects) and body.merits[i] (an array of merit objects).
 *   - only a key literally named `bonus` on one of those trait objects is removed. Any
 *     other field, including `bonus_dice`, a top-level `bonus` or a nested object's own
 *     `bonus`, is left exactly as it was.
 *   - odd shapes (null, a non-object, an array where an object belongs, a non-object
 *     merit entry) are passed through untouched and never throw. Schema validation owns
 *     rejecting a malformed shape; this function only refuses to be the thing that crashes.
 *   - in the three MAP families, a trait that stripping leaves EMPTY is dropped from the
 *     map altogether: an overlay-materialised `{ bonus: N }` (an ST Mod on a trait the
 *     character does not hold) or a stale client's `{ bonus: 0 }` must not become a
 *     stored `{}`. A trait that was already `{}` before the strip is left alone. Merit
 *     entries are NEVER dropped: their array index is their identity, so a bonus-only
 *     merit becomes `{}` in place.
 *   - each rebuilt family map is built with Object.fromEntries, never by assignment, so
 *     a key literally named `__proto__` (an own key in a JSON-parsed body) survives as an
 *     own key instead of hitting the prototype setter.
 *
 * Pure: the input is never mutated. Containers are copied only when a key is actually
 * removed from them, so a body with no `bonus` anywhere comes back as the same reference.
 *
 * Kept TEXTUALLY PARALLEL across the two apps that write characters, which cannot import
 * each other: TM Game `public/js/data/strip-trait-bonus.js` (imported by the TM Game
 * server's character routes and by the editor's save paths) and TM Admin
 * `server/lib/strip-trait-bonus.js`. Change one, change both.
 */

export const TRAIT_BONUS_MAP_FAMILIES = Object.freeze(['attributes', 'skills', 'disciplines']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function traitWithoutBonus(trait) {
  if (!isPlainObject(trait) || !Object.prototype.hasOwnProperty.call(trait, 'bonus')) return trait;
  const { bonus: _dropped, ...rest } = trait;
  return rest;
}

export function withoutTraitBonus(body) {
  if (!isPlainObject(body)) return body;
  let out = body;
  const ensureCopy = () => {
    if (out === body) out = { ...body };
    return out;
  };

  for (const family of TRAIT_BONUS_MAP_FAMILIES) {
    const map = body[family];
    if (!isPlainObject(map)) continue;
    let changed = false;
    const entries = [];
    for (const [name, trait] of Object.entries(map)) {
      const stripped = traitWithoutBonus(trait);
      if (stripped !== trait) {
        changed = true;
        if (Object.keys(stripped).length === 0) continue;
      }
      entries.push([name, stripped]);
    }
    if (changed) ensureCopy()[family] = Object.fromEntries(entries);
  }

  if (Array.isArray(body.merits)) {
    let changed = false;
    const next = body.merits.map((merit) => {
      const stripped = traitWithoutBonus(merit);
      if (stripped !== merit) changed = true;
      return stripped;
    });
    if (changed) ensureCopy().merits = next;
  }

  return out;
}
