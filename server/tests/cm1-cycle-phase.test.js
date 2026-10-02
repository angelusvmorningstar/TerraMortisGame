/**
 * CM-1 (#1028) — phase order as data, prep as a first-class phase.
 *
 * The phase contract lives in public/js/downtime/cycle-phase.js, a pure module
 * with no I/O and no browser globals, so THIS SUITE IMPORTS IT DIRECTLY — no
 * mirror copy to keep in lockstep (the mirror convention documented at
 * derive-cycle-status.test.js:8-12 exists only because db.js imports api.js;
 * the pure module deliberately sidesteps that).
 *
 * Wiring that lives in browser-coupled or DB-coupled files (db.js, the routes,
 * the admin views) is asserted via source text, following the repo convention
 * established by epic.708.1-cycle-schema-api.test.js.
 *
 * Ruling document: D:/Terra Mortis/cycle-model.md Rev 2, sections 7 and 11.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import Ajv from 'ajv';

import {
  CYCLE_PHASE_SEQUENCE,
  PHASE_MIRROR,
  FEEDING_ONLY_FIELDS,
  statusToPhase,
  cyclePhase,
  phaseIndex,
  isFeedingOpen,
  phaseWrites,
  buildPhaseUpdate,
  openCycleVerdict,
  currentCycle,
  currentCycleInGamePhase,
} from '../../public/js/downtime/cycle-phase.js';

import { downtimeCycleSchema } from '../schemas/downtime_submission.schema.js';

const DB     = fs.readFileSync('../public/js/downtime/db.js', 'utf8');
// cm-2b split the old downtime.js in two: cyclesRouter (now the Chapters
// router) went to chapters.js, submissionsRouter stayed. cm1's assertions span
// both, so both are read.
const ROUTES = fs.readFileSync('../server/routes/chapters.js', 'utf8')
             + fs.readFileSync('../server/routes/downtime.js', 'utf8');
const VIEWS  = fs.readFileSync('../public/js/admin/cycle-views.js', 'utf8');
const FEED   = fs.readFileSync('../public/js/tabs/feeding-tab.js', 'utf8');

// ── The sequence and the mirror table ──────────────────────────────────────

describe('cm1 — phase sequence and mirror table', () => {
  it('canonical sequence is downtime, processing, prep, game', () =>
    expect([...CYCLE_PHASE_SEQUENCE]).toEqual(['downtime', 'processing', 'prep', 'game']));

  it('prep mirrors to the processing pair, never the game pair', () =>
    expect(PHASE_MIRROR.prep).toEqual({ game_phase: 'processing', status: 'closed' }));

  it('golden transition matrix: every settable phase writes all three representations', () => {
    expect(phaseWrites('downtime')).toEqual({ phase: 'downtime', game_phase: 'downtime', status: 'active' });
    expect(phaseWrites('processing')).toEqual({ phase: 'processing', game_phase: 'processing', status: 'closed' });
    expect(phaseWrites('prep')).toEqual({ phase: 'prep', game_phase: 'processing', status: 'closed' });
    expect(phaseWrites('game')).toEqual({ phase: 'game', game_phase: 'game', status: 'game' });
  });

  it('phaseWrites rejects unknown phases loudly', () =>
    expect(() => phaseWrites('feeding')).toThrow());

  it('buildPhaseUpdate: the full five-row table, including the null row', () => {
    const derive = c => (c?.game_phase === null ? 'derived-legacy' : 'unused');
    expect(buildPhaseUpdate({}, 'downtime', {}, derive)).toEqual({ phase: 'downtime', game_phase: 'downtime', status: 'active' });
    expect(buildPhaseUpdate({}, 'processing', {}, derive)).toEqual({ phase: 'processing', game_phase: 'processing', status: 'closed' });
    expect(buildPhaseUpdate({}, 'prep', {}, derive)).toEqual({ phase: 'prep', game_phase: 'processing', status: 'closed' });
    expect(buildPhaseUpdate({}, 'game', {}, derive)).toEqual({ phase: 'game', game_phase: 'game', status: 'game' });
    // Null row: both phase fields nulled, status re-derived with game_phase
    // already cleared (the #918 clear-to-neutral semantics).
    expect(buildPhaseUpdate({ game_phase: 'game', phase: 'game' }, null, {}, derive))
      .toEqual({ phase: null, game_phase: null, status: 'derived-legacy' });
  });

  it('buildPhaseUpdate: extras may add fields but can never override the mirror trio', () => {
    const out = buildPhaseUpdate({}, 'prep', { status: 'game', game_phase: 'game', phase: 'game', closed_at: 'T' }, () => 'x');
    expect(out).toEqual({ phase: 'prep', game_phase: 'processing', status: 'closed', closed_at: 'T' });
  });

  it('feeding-only field list matches the historic FEEDING_FIELDS set', () =>
    expect([...FEEDING_ONLY_FIELDS].sort()).toEqual(
      ['feeding_deferred', 'feeding_roll_player', 'feeding_vitae_allocation']));
});

// ── statusToPhase ──────────────────────────────────────────────────────────

describe('cm1 — statusToPhase', () => {
  it("maps active and open to 'downtime'", () => {
    expect(statusToPhase('active')).toBe('downtime');
    expect(statusToPhase('open')).toBe('downtime');
  });
  it("maps game to 'game' and closed to 'processing'", () => {
    expect(statusToPhase('game')).toBe('game');
    expect(statusToPhase('closed')).toBe('processing');
  });
  it("maps legacy 'prep' (pre-downtime setup) to null, NEVER to phase 'prep'", () =>
    expect(statusToPhase('prep')).toBeNull());
  it('maps junk and absence to null', () => {
    expect(statusToPhase('bogus')).toBeNull();
    expect(statusToPhase(undefined)).toBeNull();
  });
});

// ── cyclePhase ─────────────────────────────────────────────────────────────

describe('cm1 — cyclePhase', () => {
  it('a known phase field wins verbatim', () => {
    expect(cyclePhase({ phase: 'prep', status: 'closed', game_phase: 'processing' })).toBe('prep');
    expect(cyclePhase({ phase: 'game', status: 'active' })).toBe('game');
  });

  it('an unknown phase value falls back instead of leaking through', () =>
    expect(cyclePhase({ phase: 'feeding', status: 'game' })).toBe('game'));

  it('no phase field: falls back through the supplied derivation', () => {
    // The desynced document that broke feeding night: stale status with a
    // game_phase override. A deriveCycleStatus-shaped fn resolves it to game.
    const deriveLike = c => (c?.game_phase === 'game' ? 'game' : c?.status);
    expect(cyclePhase({ status: 'active', game_phase: 'game' }, deriveLike)).toBe('game');
  });

  it('no derivation supplied: falls back on raw status', () =>
    expect(cyclePhase({ status: 'closed' })).toBe('processing'));

  it('db.js binds the full legacy derivation (source check)', () =>
    expect(DB).toMatch(/cyclePhasePure\(cycle,\s*deriveCycleStatus\)/));
});

// ── phaseIndex ─────────────────────────────────────────────────────────────

describe('cm1 — phaseIndex', () => {
  it('uses the default sequence when the cycle carries none', () =>
    expect(phaseIndex({}, 'prep')).toBe(2));
  it("a cycle's own phase_sequence wins", () =>
    expect(phaseIndex({ phase_sequence: ['prep', 'game'] }, 'prep')).toBe(0));
  it('unknown phase is -1', () =>
    expect(phaseIndex({}, 'feeding')).toBe(-1));
});

// ── isFeedingOpen ──────────────────────────────────────────────────────────

describe('cm1 — isFeedingOpen (feeding opens on prep, stays open in game)', () => {
  it('true in prep and game, false in downtime and processing', () => {
    expect(isFeedingOpen({ phase: 'prep' })).toBe(true);
    expect(isFeedingOpen({ phase: 'game' })).toBe(true);
    expect(isFeedingOpen({ phase: 'downtime' })).toBe(false);
    expect(isFeedingOpen({ phase: 'processing' })).toBe(false);
  });
  it('legacy documents resolve exactly as the old game-phase lookup', () => {
    expect(isFeedingOpen({ status: 'game' })).toBe(true);
    expect(isFeedingOpen({ status: 'active' })).toBe(false);
    expect(isFeedingOpen({ status: 'closed' })).toBe(false);
  });
});

// ── openCycleVerdict (the requireOpenCycle decision) ───────────────────────

describe('cm1 — openCycleVerdict, phase-aware lane', () => {
  const feeding = ['feeding_roll_player', 'feeding_vitae_allocation'];
  const general = ['responses'];

  it('player feed-roll write during prep is ALLOWED (the point of this story)', () =>
    expect(openCycleVerdict({ cycle: { phase: 'prep', status: 'closed' }, role: 'player', bodyKeys: feeding, oowMatch: false }))
      .toBe('allow'));

  it('player general edit during prep is locked', () =>
    expect(openCycleVerdict({ cycle: { phase: 'prep', status: 'closed' }, role: 'player', bodyKeys: general, oowMatch: false }))
      .toBe('locked'));

  it('a mixed body (feeding plus general keys) does not slip through', () =>
    expect(openCycleVerdict({ cycle: { phase: 'prep', status: 'closed' }, role: 'player', bodyKeys: [...feeding, ...general], oowMatch: false }))
      .toBe('locked'));

  it('out-of-window exception survives in the phase lane', () =>
    expect(openCycleVerdict({ cycle: { phase: 'prep', status: 'closed' }, role: 'player', bodyKeys: general, oowMatch: true }))
      .toBe('allow'));

  it('feeding writes stay open in game phase', () =>
    expect(openCycleVerdict({ cycle: { phase: 'game', status: 'game' }, role: 'player', bodyKeys: feeding, oowMatch: false }))
      .toBe('allow'));

  it('the downtime window allows general player writes', () =>
    expect(openCycleVerdict({ cycle: { phase: 'downtime', status: 'active' }, role: 'player', bodyKeys: general, oowMatch: false }))
      .toBe('allow'));

  it('processing locks players out entirely (bar out-of-window)', () => {
    expect(openCycleVerdict({ cycle: { phase: 'processing', status: 'closed' }, role: 'player', bodyKeys: feeding, oowMatch: false }))
      .toBe('locked');
    expect(openCycleVerdict({ cycle: { phase: 'processing', status: 'closed' }, role: 'player', bodyKeys: general, oowMatch: true }))
      .toBe('allow');
  });

  it('the ST is never locked out in the phase lane (processing IS the ST writing resolutions)', () => {
    expect(openCycleVerdict({ cycle: { phase: 'processing', status: 'closed' }, role: 'st', bodyKeys: general, oowMatch: false }))
      .toBe('allow');
    expect(openCycleVerdict({ cycle: { phase: 'prep', status: 'closed' }, role: 'dev', bodyKeys: general, oowMatch: false }))
      .toBe('allow');
  });
});

describe('cm1 — openCycleVerdict, legacy lane (byte-identical to the old gate)', () => {
  it('locked only on raw closed status', () => {
    expect(openCycleVerdict({ cycle: { status: 'closed' }, role: 'player', bodyKeys: ['responses'], oowMatch: false })).toBe('locked');
    expect(openCycleVerdict({ cycle: { status: 'closed' }, role: 'st', bodyKeys: ['responses'], oowMatch: false })).toBe('locked');
  });
  it('out-of-window exception on a closed legacy cycle', () =>
    expect(openCycleVerdict({ cycle: { status: 'closed' }, role: 'player', bodyKeys: ['responses'], oowMatch: true })).toBe('allow'));
  it('every non-closed legacy status allows the write through to the handler', () => {
    for (const status of ['prep', 'game', 'active', 'open']) {
      expect(openCycleVerdict({ cycle: { status }, role: 'player', bodyKeys: ['responses'], oowMatch: false })).toBe('allow');
    }
  });
  it('a junk phase value is judged by the CANONICAL phase, failing closed (Codex finding)', () => {
    // {phase:'feeding', status:'game'}: canonical phase resolves to 'game',
    // where a player's general edit is locked - the junk value must not drop
    // the document into the permissive legacy lane (which would allow it).
    expect(openCycleVerdict({ cycle: { phase: 'feeding', status: 'game' }, role: 'player', bodyKeys: ['responses'], oowMatch: false }))
      .toBe('locked');
    // Feeding-only writes still work through the canonical fallback.
    expect(openCycleVerdict({ cycle: { phase: 'feeding', status: 'game' }, role: 'player', bodyKeys: ['feeding_roll_player'], oowMatch: false }))
      .toBe('allow');
    // ST bypass applies in the phase lane regardless of the junk value.
    expect(openCycleVerdict({ cycle: { phase: 'feeding', status: 'closed' }, role: 'st', bodyKeys: [], oowMatch: false }))
      .toBe('allow');
  });

  it('an empty-string phase falls to the legacy lane', () =>
    expect(openCycleVerdict({ cycle: { phase: '', status: 'closed' }, role: 'st', bodyKeys: [], oowMatch: false }))
      .toBe('locked'));
});

// ── getFeedingCycle selection (the review's High finding) ──────────────────

describe('cm1 — getFeedingCycle picks by game_number, never creation order', () => {
  async function importDb(cyclesPayload) {
    globalThis.location = { origin: 'http://localhost', hostname: 'localhost' };
    globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    globalThis.window = globalThis;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => cyclesPayload });
    return import('../../public/js/downtime/db.js');
  }

  it('a stale legacy game_phase-game cycle with a newer _id loses to the higher-game_number prep cycle', async () => {
    const stale   = { _id: 'ffffffffffffffffffffffff', game_number: 5, status: 'game', game_phase: 'game' };
    const current = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', game_number: 7, phase: 'prep', game_phase: 'processing', status: 'closed' };
    const db = await importDb([stale, current]); // stale first = API (_id desc) order
    const picked = await db.getFeedingCycle();
    expect(picked.game_number).toBe(7);
  });

  it('no feeding-open cycle: returns null', async () => {
    const db = await importDb([{ _id: '1', game_number: 6, status: 'closed', game_phase: 'processing' }]);
    expect(await db.getFeedingCycle()).toBeNull();
  });

  // 2026-08-15 live incident: a fresh "Game 7" cycle was flipped to game phase
  // for the session while "Game 6" still held the month's actual feeding
  // grids. Game 7 outranked Game 6 on game_number alone and carried zero
  // submissions, so every player's live feeding roll silently defaulted to
  // the Barrens -4 ambience fallback. These cases need per-cycle submission
  // counts, so they get their own mock that branches on URL.
  async function importDbWithSubs(cyclesPayload, subsByCycleId) {
    globalThis.location = { origin: 'http://localhost', hostname: 'localhost' };
    globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    globalThis.window = globalThis;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/downtime_submissions')) {
        const m = u.match(/chapter_id=([^&]+)/);
        const cid = m ? decodeURIComponent(m[1]) : null;
        return { ok: true, status: 200, json: async () => (subsByCycleId || {})[cid] || [] };
      }
      return { ok: true, status: 200, json: async () => cyclesPayload };
    };
    return import('../../public/js/downtime/db.js');
  }

  it('an empty higher-game_number cycle in game phase does not shadow a lower feeding-open cycle with submissions (the 2026-08-15 Game 7 incident)', async () => {
    const dt6 = { _id: 'dt6', game_number: 6, phase: 'prep' };
    const game7 = { _id: 'game7', game_number: 7, phase: 'game' };
    const db = await importDbWithSubs([game7, dt6], {
      dt6: [{ _id: 's1', character_id: 'ryan', chapter_id: 'dt6' }],
      game7: [],
    });
    const picked = await db.getFeedingCycle();
    expect(picked._id).toBe('dt6');
  });

  it('when every feeding-open candidate is empty, the highest game_number still wins (a brand-new downtime nobody has submitted to yet)', async () => {
    const dt6 = { _id: 'dt6', game_number: 6, phase: 'prep' };
    const game7 = { _id: 'game7', game_number: 7, phase: 'game' };
    const db = await importDbWithSubs([game7, dt6], { dt6: [], game7: [] });
    const picked = await db.getFeedingCycle();
    expect(picked._id).toBe('game7');
  });
});

// ── Schema matrix ──────────────────────────────────────────────────────────

describe('cm1 — downtimeCycleSchema accepts the new fields, rejects misuse', () => {
  const ajv = new Ajv({ allowUnionTypes: true, strict: false });
  const check = ajv.compile(downtimeCycleSchema);

  it("phase 'prep' is legal", () =>
    expect(check({ label: 'x', phase: 'prep' })).toBe(true));

  it('phase null is legal (legacy)', () =>
    expect(check({ label: 'x', phase: null })).toBe(true));

  it("phase 'feeding' is illegal (Rev 2 renamed it)", () =>
    expect(check({ label: 'x', phase: 'feeding' })).toBe(false));

  it("game_phase never gains 'prep'", () =>
    expect(check({ label: 'x', game_phase: 'prep' })).toBe(false));

  it('canonical phase_sequence is legal', () =>
    expect(check({ label: 'x', phase_sequence: ['downtime', 'processing', 'prep', 'game'] })).toBe(true));

  it("phase_sequence rejects 'feeding'", () =>
    expect(check({ label: 'x', phase_sequence: ['downtime', 'processing', 'feeding', 'game'] })).toBe(false));

  it('phase_sequence rejects duplicates (Codex finding)', () =>
    expect(check({ label: 'x', phase_sequence: ['downtime', 'prep', 'prep', 'game'] })).toBe(false));

  it('phase_sequence still accepts a partial order (completeness constraint deliberately deferred)', () =>
    expect(check({ label: 'x', phase_sequence: ['game'] })).toBe(true));
});

// ── Wiring (source-text checks, per the epic.708.1 convention) ─────────────

describe('cm1 — wiring', () => {
  it('requireOpenCycle routes through openCycleVerdict and fetches phase', () => {
    expect(ROUTES).toContain('openCycleVerdict({');
    expect(ROUTES).toMatch(/projection:\s*\{\s*status:\s*1,\s*phase:\s*1,\s*out_of_window_player_ids:\s*1\s*\}/);
  });

  it('cycle POST default-injects the canonical phase_sequence and never defaults phase', () => {
    expect(ROUTES).toContain('doc.phase_sequence = [...CYCLE_PHASE_SEQUENCE]');
    expect(ROUTES).not.toMatch(/doc\.phase\s*=/);
  });

  it('the submissions PUT deadline carve-out shares FEEDING_ONLY_FIELDS', () =>
    expect(ROUTES).toContain('FEEDING_ONLY_FIELDS.includes(k)'));

  it('closeCycle and openGamePhase route through THE canonical writer (Codex finding)', () => {
    expect(DB).toMatch(/closeCycle\(cycle\)\s*\{[\s\S]{0,400}?setCyclePhase\(cycle,\s*'processing',\s*\{\s*closed_at/);
    expect(DB).toMatch(/openGamePhase\(cycle\)\s*\{[\s\S]{0,400}?setCyclePhase\(cycle,\s*'game',\s*\{\s*game_phase_at/);
  });

  it('setCyclePhase delegates its writes to buildPhaseUpdate with the legacy derivation injected', () =>
    expect(DB).toMatch(/buildPhaseUpdate\(cycle,\s*phaseOrNull,\s*extra,\s*deriveCycleStatus\)/));

  it('confirm-feeding is phase-aware with legacy-parity semantics (Codex finding)', () => {
    expect(ROUTES).toMatch(/confirmBlocked[\s\S]{0,200}?\['downtime',\s*'prep',\s*'game'\]\.includes\(cyclePhase\(cycle\)\)/);
  });

  it('the feeding tab reads through getFeedingCycle', () => {
    expect(FEED).toContain('getFeedingCycle');
    expect(FEED).not.toContain('getGamePhaseCycle');
  });

  it('signoffPhase and setManualOpen are untouched by CM-1 (no phase writes)', () => {
    const start = DB.indexOf('export async function signoffPhase');
    const end = DB.indexOf('export function isInGamePhase');
    // Guard the slice boundaries so a rename cannot make the negative
    // assertions below pass vacuously on an empty string (Codex finding).
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const signoff = DB.slice(start, end);
    expect(signoff.length).toBeGreaterThan(200);
    expect(signoff).not.toContain('setCyclePhase');
    expect(signoff).not.toMatch(/\bphase:\s/);
  });
});

// ── otc.2 (2026-08-12): currentCycle / currentCycleInGamePhase ─────────────
// Codex external review (reasoning_effort=high) reproduced a real defect
// live against MongoDB: office-actions.js's original phase gate filtered ALL
// cycles for phase 'game' and took the highest game_number AMONG THOSE
// MATCHES ONLY. A stale historical cycle left in game phase therefore
// outranked a genuinely newer cycle that had moved on to prep/processing/
// downtime, because the newer cycle was never in the filtered set at all.
// A live Supertest probe got a real 201 for a grant_first submitted while
// the true current cycle was in prep. These tests reproduce that exact
// shape against the pure functions, red against the old filter-then-sort
// logic, green against currentCycle/currentCycleInGamePhase.
describe('otc.2 — currentCycle: highest game_number wins, never phase-filtered first', () => {
  it('returns null for an empty or missing list', () => {
    expect(currentCycle([])).toBeNull();
    expect(currentCycle(undefined)).toBeNull();
  });

  it('picks the highest game_number regardless of array order', () => {
    const a = { game_number: 3, phase: 'downtime' };
    const b = { game_number: 7, phase: 'processing' };
    const c = { game_number: 5, phase: 'game' };
    expect(currentCycle([a, b, c])).toBe(b);
    expect(currentCycle([c, a, b])).toBe(b);
  });
});

describe('otc.2 — currentCycleInGamePhase: the stale-cycle regression', () => {
  it('returns the cycle when the CURRENT (highest game_number) cycle is in game phase', () => {
    const old = { game_number: 5, phase: 'downtime' };
    const current = { game_number: 6, phase: 'game' };
    expect(currentCycleInGamePhase([old, current])).toBe(current);
  });

  it('THE REGRESSION: returns null when an OLDER cycle is stuck in game phase but the CURRENT cycle has moved on', () => {
    // This is the exact shape Codex reproduced live: game_number 5 left at
    // phase 'game', game_number 6 (the true current cycle) advanced to
    // 'prep'. The old filter-then-sort logic returned the stale cycle 5 and
    // let a Status Action through; the correct answer is null (no live game).
    const staleGame = { game_number: 5, phase: 'game' };
    const currentPrep = { game_number: 6, phase: 'prep' };
    expect(currentCycleInGamePhase([staleGame, currentPrep])).toBeNull();
    // Order in the array must not matter - this must not accidentally pass
    // only because the stale cycle happened to sort last.
    expect(currentCycleInGamePhase([currentPrep, staleGame])).toBeNull();
  });

  it('returns null when the current cycle is in any non-game phase', () => {
    expect(currentCycleInGamePhase([{ game_number: 1, phase: 'downtime' }])).toBeNull();
    expect(currentCycleInGamePhase([{ game_number: 1, phase: 'processing' }])).toBeNull();
    expect(currentCycleInGamePhase([{ game_number: 1, phase: 'prep' }])).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(currentCycleInGamePhase([])).toBeNull();
  });
});
