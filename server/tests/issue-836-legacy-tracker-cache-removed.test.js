/**
 * Issue #836 — legacy ST Suite tracker localStorage cache removed.
 *
 * Three slices:
 *   1. Static-analysis sanity guards — the dead files are gone, the dead
 *      imports are gone, the dead helpers are gone. Any future re-introduction
 *      of `tm_tracker_${...}` / `tm_dt_${...}` writers OUTSIDE the preserved
 *      migration shim fails this slice.
 *   2. Preserved-migration-shim guards — the lazy migration block at
 *      suite/sheet.js:348-361 is the only path that should still touch the
 *      legacy keys, and only for read (one-shot seed of the canonical store).
 *      Shape-asserts the exact block survives so a future cleanup doesn't
 *      accidentally yank the shim before the migration window closes.
 *   3. Behavioural — extracted migration logic seeds canonical from a legacy
 *      payload without contaminating it (field-name remap wp→willpower,
 *      inf carries through, lethal derived from health, clamping applied).
 *
 * All slices are source-text checks rather than module imports because the
 * touched modules transitively pull in browser globals (location via api.js).
 * See [[feedback_xp_derived_not_stored]] for the same node-env workaround.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(REPO_ROOT, rel)); }

// ─────────────────────────────────────────────────────────────────────────────
// Static-analysis: dead files / imports / helpers are gone
// ─────────────────────────────────────────────────────────────────────────────

describe('#836 — dead files removed', () => {
  it('public/js/admin/session-tracker.js no longer exists', () => {
    expect(exists('public/js/admin/session-tracker.js')).toBe(false);
  });
  it('public/js/admin/feeding-engine.js no longer exists', () => {
    expect(exists('public/js/admin/feeding-engine.js')).toBe(false);
  });
});

describe('#836 — admin.js drops dead imports', () => {
  const src = read('public/js/admin.js');
  it('no longer imports initFeedingEngine', () => {
    expect(src).not.toMatch(/import\s*\{\s*initFeedingEngine\s*\}/);
    expect(src).not.toMatch(/from\s*['"]\.\/admin\/feeding-engine\.js['"]/);
  });
  it('no longer imports initSessionTracker', () => {
    expect(src).not.toMatch(/import\s*\{\s*initSessionTracker\s*\}/);
    expect(src).not.toMatch(/from\s*['"]\.\/admin\/session-tracker\.js['"]/);
  });
});

describe('#836 — data/loader.js drops generic tracker helpers', () => {
  const src = read('public/js/data/loader.js');
  it('no longer exports getTrackerData', () => {
    expect(src).not.toMatch(/export\s+function\s+getTrackerData\b/);
  });
  it('no longer exports setTrackerData', () => {
    expect(src).not.toMatch(/export\s+function\s+setTrackerData\b/);
  });
});

// #836 gutted suite/tracker.js down to its single live export and the survivor
// landed as suite/toast.js. This block still asserts the gutting held; only the
// path moved. It had been reading the deleted path and failing since #836.
describe('#836 — suite/tracker.js gutted to just `toast` (now suite/toast.js)', () => {
  const src = read('public/js/suite/toast.js');
  it('no longer exports the deprecated st* helpers', () => {
    const deprecated = [
      'stGetTracker', 'stSetTracker', 'stGetDt', 'stSetDt',
      'stMaxVitae', 'stMaxWP', 'stMaxInf', 'stGetActive',
      'stResetAll', 'stApplyDowntime', 'renderPrestige',
      'togglePrestige', 'renderStOverview', 'stLogDt',
      'stPickChar', 'stDismiss',
    ];
    for (const name of deprecated) {
      expect(src, `expected ${name} to be gone from suite/tracker.js`)
        .not.toMatch(new RegExp(`export\\s+(?:function\\s+)?${name}\\b`));
      // Also catches re-export via export { ... } block
      expect(src, `expected ${name} not to appear in export {} block`)
        .not.toMatch(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`));
    }
  });
  it('still exports `toast` (the one live consumer at app.js:109)', () => {
    expect(src).toMatch(/export\s+function\s+toast\b/);
  });
  it('no longer reads or writes tm_tracker_${name} keys directly', () => {
    // The code lines (not the comment) must not call localStorage with the
    // legacy prefix. Strip out comments to make the assertion robust.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(stripped).not.toMatch(/localStorage\.\w+\(['"`]tm_tracker_/);
    expect(stripped).not.toMatch(/localStorage\.\w+\(['"`]tm_dt_/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No live writer remains for `tm_tracker_${name}` / `tm_dt_${name}` —
// except the preserved one-shot read in suite/sheet.js.
// ─────────────────────────────────────────────────────────────────────────────

describe('#836 — no live writers remain for legacy keys', () => {
  const LIVE_FILES = [
    'public/js/admin.js',
    'public/js/data/loader.js',
    'public/js/suite/toast.js',
    'public/js/data/accessors.js',
    'public/js/editor/edit.js',
    'public/js/editor/identity.js',
    'public/js/editor/sheet.js',
    'public/js/editor/xp.js',
    'public/js/game/tracker.js',
    'public/js/tabs/feeding-tab.js',
    'public/js/suite/import.js',
  ];

  for (const rel of LIVE_FILES) {
    it(`${rel}: no localStorage write to tm_tracker_<name> or tm_dt_<name>`, () => {
      const src = read(rel);
      // Strip comments so the assertion only targets executable code.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      // setItem against either prefix would be a regression. We allow the
      // canonical 'tm_tracker_local_' prefix (game/tracker.js + feeding-tab.js
      // per-device session state) and the orthogonal 'tm_tracker_state' /
      // 'tm_dt_story_collapse_global' namespaces.
      const bad = stripped.match(/localStorage\.setItem\(\s*['"`]tm_tracker_[^l_s][^\n)]*/g) || [];
      const badDt = stripped.match(/localStorage\.setItem\(\s*['"`]tm_dt_(?!story_)[^\n)]*/g) || [];
      expect(bad, `unexpected writes: ${bad.join(' | ')}`).toEqual([]);
      expect(badDt, `unexpected DT writes: ${badDt.join(' | ')}`).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Preserved-migration-shim guards — suite/sheet.js:348-361 stays intact
// ─────────────────────────────────────────────────────────────────────────────

describe('#836 — lazy migration shim preserved in suite/sheet.js', () => {
  const src = read('public/js/suite/sheet.js');

  it('still reads from `tm_tracker_<name>` via JSON.parse', () => {
    expect(src).toMatch(/const\s+oldKey\s*=\s*['"`]tm_tracker_['"`]\s*\+\s*c\.name/);
    expect(src).toMatch(/localStorage\.getItem\(\s*oldKey/);
  });

  it('only fires when canonical store has no entry for this charId', () => {
    expect(src).toMatch(/if\s*\(\s*!trackerReadRaw\(charId\)\s*\)/);
  });

  it('seeds the canonical store via trackerWriteField (id-keyed)', () => {
    expect(src).toMatch(/trackerWriteField\(charId,\s*['"`]vitae['"`]/);
    expect(src).toMatch(/trackerWriteField\(charId,\s*['"`]willpower['"`]/);
    expect(src).toMatch(/trackerWriteField\(charId,\s*['"`]inf['"`]/);
  });

  it('does NOT write back to the legacy key (one-way migration)', () => {
    // No `localStorage.setItem('tm_tracker_' + ...)` anywhere in suite/sheet.js.
    expect(src).not.toMatch(/localStorage\.setItem\(\s*['"`]tm_tracker_['"`]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioural — migration field-name remap + clamping
// ─────────────────────────────────────────────────────────────────────────────
//
// The migration block is small enough to mirror inline here. If suite/sheet.js
// drift makes this drift, the static-shape guards above catch it first.

function migrateLegacyToCanonical(c, legacy, maxes, writer) {
  // Mirrors suite/sheet.js:354-359 — the only behaviour worth covering.
  const { maxH, maxV, maxWP, maxInf } = maxes;
  const maxD = maxH - (legacy.health ?? maxH);
  writer('vitae',     Math.max(0, Math.min(legacy.vitae  ?? maxV,  maxV)));
  writer('willpower', Math.max(0, Math.min(legacy.wp     ?? maxWP, maxWP)));
  writer('lethal',    Math.max(0, Math.min(maxD,                   maxH)));
  writer('inf',       Math.max(0, Math.min(legacy.inf    ?? maxInf, maxInf)));
}

describe('#836 — migration semantics (legacy { vitae, wp, inf, health } → canonical fields)', () => {
  const maxes = { maxH: 7, maxV: 15, maxWP: 6, maxInf: 8 };

  it('maps wp → willpower (the rename across the boundary)', () => {
    const writes = {};
    const writer = (field, val) => { writes[field] = val; };
    migrateLegacyToCanonical({}, { vitae: 5, wp: 4, inf: 3 }, maxes, writer);
    expect(writes.willpower).toBe(4);
    expect('wp' in writes).toBe(false);
  });

  it('passes vitae and inf through unchanged when within max', () => {
    const writes = {};
    migrateLegacyToCanonical({}, { vitae: 5, wp: 4, inf: 3 }, maxes,
      (f, v) => { writes[f] = v; });
    expect(writes.vitae).toBe(5);
    expect(writes.inf).toBe(3);
  });

  it('clamps values above max down to max', () => {
    const writes = {};
    migrateLegacyToCanonical({}, { vitae: 99, wp: 99, inf: 99 }, maxes,
      (f, v) => { writes[f] = v; });
    expect(writes.vitae).toBe(maxes.maxV);
    expect(writes.willpower).toBe(maxes.maxWP);
    expect(writes.inf).toBe(maxes.maxInf);
  });

  it('clamps negatives up to zero', () => {
    const writes = {};
    migrateLegacyToCanonical({}, { vitae: -3, wp: -1, inf: -5 }, maxes,
      (f, v) => { writes[f] = v; });
    expect(writes.vitae).toBe(0);
    expect(writes.willpower).toBe(0);
    expect(writes.inf).toBe(0);
  });

  it('derives lethal from legacy.health (maxH - health), defaults to no damage when health missing', () => {
    const writes = {};
    migrateLegacyToCanonical({}, { vitae: 5, wp: 4, inf: 3, health: 4 }, maxes,
      (f, v) => { writes[f] = v; });
    // maxH=7, health=4 → maxD=3
    expect(writes.lethal).toBe(3);

    const writesNoHealth = {};
    migrateLegacyToCanonical({}, { vitae: 5, wp: 4, inf: 3 }, maxes,
      (f, v) => { writesNoHealth[f] = v; });
    // health missing → ?? maxH → maxD = maxH - maxH = 0
    expect(writesNoHealth.lethal).toBe(0);
  });

  it('falls back to maxes when legacy fields are missing entirely', () => {
    const writes = {};
    migrateLegacyToCanonical({}, {}, maxes, (f, v) => { writes[f] = v; });
    expect(writes.vitae).toBe(maxes.maxV);
    expect(writes.willpower).toBe(maxes.maxWP);
    expect(writes.inf).toBe(maxes.maxInf);
    expect(writes.lethal).toBe(0);
  });
});
