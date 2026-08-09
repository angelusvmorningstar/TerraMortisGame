/**
 * ADR-009 D5 — the overlay composition sequence lives in exactly one module.
 *
 * WHY A TEST AND NOT A COMMENT. Before ADR-009 the rule "single composition
 * site" was already written down, in ADR-004 D1/D8. It was still satisfied
 * TWICE: admin.js and app.js each defined refreshCharacterOverlay, and each
 * carried a comment describing itself as the single site. Neither author broke
 * the rule; they just could not see the other copy. The copies then drifted --
 * admin.js spliced tracker_state, app.js did not, so an ST saw different
 * current vitae depending on which document they opened.
 *
 * A comment cannot detect its own duplicate. This can.
 *
 * SHAPE: a NAMED SET that may shrink and never grow, per the convention the
 * other ADR-008 ratchets follow. A count would let a new violation silently
 * substitute for a retired one.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const JS_ROOT = path.join(REPO_ROOT, 'public', 'js');

/** Files permitted to contain the composition sequence. May shrink, never grow. */
const ALLOWED = new Set([
  'data/sheet-composition.js',
]);

/** Files permitted to define the primitives themselves. */
const PRIMITIVES = new Set([
  'data/st-mods.js',
]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Strip comments so a described sequence is never mistaken for a performed one.
 *  Line comments are stripped only at line start, so a `//` inside a URL cannot
 *  eat the rest of the line -- that exact bug once collapsed a class count to
 *  zero and made an empty result look like a pass. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

const FILES = walk(JS_ROOT).map(p => ({
  rel: path.relative(JS_ROOT, p).split(path.sep).join('/'),
  src: code(fs.readFileSync(p, 'utf8')),
}));

describe('ADR-009 D5 — one overlay composition site', () => {
  it('the materialiseDerivedDefence -> applyStMods sequence appears in exactly one module', () => {
    // The ordering bug ADR-006 D3/D4 fixed was precisely these two run the
    // wrong way round, so their co-occurrence is the sequence's signature.
    const seq = /materialiseDerivedDefence\s*\([^)]*\)[\s\S]{0,400}?applyStMods\s*\(/;
    const offenders = FILES
      .filter(f => !PRIMITIVES.has(f.rel) && seq.test(f.src))
      .map(f => f.rel);

    expect(
      offenders.filter(r => !ALLOWED.has(r)),
      `composition sequence found outside the allowed set. Route the caller ` +
      `through data/sheet-composition.js instead of repeating the sequence.`,
    ).toEqual([]);
  });

  it('spliceCurrent is called from the composition module only', () => {
    const offenders = FILES
      .filter(f => !PRIMITIVES.has(f.rel) && /\bspliceCurrent\s*\(/.test(f.src))
      .map(f => f.rel)
      .filter(r => !ALLOWED.has(r));

    expect(
      offenders,
      'spliceCurrent outside the composition module is how admin.js and app.js ' +
      'drifted apart in the first place (ADR-009).',
    ).toEqual([]);
  });

  it('the composition module carries no role logic (ADR-009 D2)', () => {
    const mod = FILES.find(f => f.rel === 'data/sheet-composition.js');
    expect(mod, 'data/sheet-composition.js is missing').toBeTruthy();
    expect(mod.src).not.toMatch(/\bgetRole\s*\(/);
    expect(mod.src).not.toMatch(/\beffectiveRole\s*\(/);
  });

  it('the composition module preserves splice -> materialise -> applyStMods order', () => {
    const mod = FILES.find(f => f.rel === 'data/sheet-composition.js');
    // Anchor on the non-edit-mode branch: edit mode strips and returns early.
    const body = mod.src.slice(mod.src.indexOf('loadTrackerState === '));
    const iSplice = body.indexOf('spliceCurrent(');
    const iMat = body.indexOf('materialiseDerivedDefence(');
    const iMods = body.indexOf('applyStMods(');
    expect(iSplice, 'spliceCurrent not found').toBeGreaterThan(-1);
    expect(iMat).toBeGreaterThan(iSplice);
    expect(iMods).toBeGreaterThan(iMat);
  });
});
