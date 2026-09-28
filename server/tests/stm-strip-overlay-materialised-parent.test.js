/**
 * TM Admin Story tm-admin.10.2a AC13 — stripOverlay must leave a character EXACTLY as it was before
 * the overlay when the overlay had to materialise the path.
 *
 * Root cause (read from the code, 2026-09-28): applyStMods calls setByPath(c, 'disciplines.Dominate.dots',
 * final). setByPath creates `c.disciplines.Dominate = {}` when it is absent. stripOverlay then restores an
 * absent base with setByPath(c, path, undefined), which leaves `{ dots: undefined }` behind; that
 * serialises as `{}` and violates the trait schema's `required: ['dots']`. Two such rows were found live
 * (Wan Yelong disciplines.Dominate, Yusuf Kalusicj skills.Brawl).
 *
 * This imports the REAL functions from public/js/data/st-mods.js, not an inline copy (the older
 * stm-bugfix-405-repro tests mirror the logic inline, which is how this went unseen).
 */

import { describe, it, expect } from 'vitest';
import { applyStMods, stripOverlay } from '../../public/js/data/st-mods.js';

const mod = (stat_path, delta, extra = {}) => ({ stat_path, delta, active: true, ...extra });
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('stripOverlay restores a character that lacked the modded path (tm-admin.10.2a AC13)', () => {
  it('leaves no empty discipline object when the discipline was absent (Wan Yelong shape)', () => {
    const c = { disciplines: { Auspex: { dots: 2 } } };
    const before = clone(c);
    applyStMods(c, [mod('disciplines.Dominate.dots', 4)], true);
    expect(c.disciplines.Dominate.dots).toBe(4);
    stripOverlay(c);
    expect(c).toEqual(before);
    expect('Dominate' in c.disciplines).toBe(false);
    expect(JSON.stringify(c)).not.toContain('Dominate');
  });

  it('leaves no empty skill object when the skill was absent (Yusuf Kalusicj shape)', () => {
    const c = { skills: { Athletics: { dots: 1, bonus: 0 } } };
    const before = clone(c);
    applyStMods(c, [mod('skills.Brawl.bonus', 1)], true);
    stripOverlay(c);
    expect(c).toEqual(before);
    expect('Brawl' in c.skills).toBe(false);
  });

  it('removes a materialised top-level container too when the overlay created it', () => {
    const c = { name: 'x' };
    applyStMods(c, [mod('disciplines.Dominate.dots', 2)], true);
    stripOverlay(c);
    expect(c).toEqual({ name: 'x' });
  });

  it('a parent the character already had is kept, with its other keys untouched', () => {
    const c = { disciplines: { Dominate: { dots: 3, powers: ['x'] } } };
    const before = clone(c);
    applyStMods(c, [mod('disciplines.Dominate.dots', 1)], true);
    expect(c.disciplines.Dominate.dots).toBe(4);
    stripOverlay(c);
    expect(c).toEqual(before);
  });

  it('a parent that already existed but lacked the leaf keeps the parent, drops only the leaf', () => {
    const c = { skills: { Brawl: { cp: 0, xp: 0 } } };
    const before = clone(c);
    applyStMods(c, [mod('skills.Brawl.bonus', 2)], true);
    expect(c.skills.Brawl.bonus).toBe(2);
    stripOverlay(c);
    expect(c).toEqual(before);
    expect('bonus' in c.skills.Brawl).toBe(false);
  });

  it('does not disturb a sibling mod on an existing trait when several paths are applied', () => {
    const c = { attributes: { Presence: { dots: 3, bonus: 0 } } };
    const before = clone(c);
    applyStMods(c, [mod('attributes.Presence.bonus', 1), mod('disciplines.Dominate.dots', 4)], true);
    expect(c.attributes.Presence.bonus).toBe(1);
    stripOverlay(c);
    expect(c).toEqual(before);
  });

  it('re-applying then stripping repeatedly is stable (the render loop applies on every render)', () => {
    const c = { disciplines: {} };
    const before = clone(c);
    for (let i = 0; i < 3; i++) applyStMods(c, [mod('disciplines.Dominate.dots', 4)], true);
    stripOverlay(c);
    expect(c).toEqual(before);
  });

  it('an inactive-only mod set materialises nothing at all', () => {
    const c = { skills: {} };
    const before = clone(c);
    applyStMods(c, [mod('skills.Brawl.bonus', 1, { active: false })], true);
    expect(c).toEqual(before);
  });

  it('a character with a real base value is restored to exactly that value', () => {
    const c = { attributes: { Presence: { dots: 3, bonus: 0 } } };
    applyStMods(c, [mod('attributes.Presence.dots', 2)], true);
    expect(c.attributes.Presence.dots).toBe(5);
    stripOverlay(c);
    expect(c.attributes.Presence.dots).toBe(3);
  });
});
