/**
 * CM-4a, as amended by Story tm-admin.27.1 (2026-10-02).
 *
 * CM-4a made the tracker slate-wipe a server-side consequence of the phase write. That was OVERRIDDEN
 * on 2026-08-20 (Angelus, after a live incident: opening Game phase wiped stats already recorded), and
 * Story 27.1 retired TM Game's phase writer altogether: TM Admin is the only writer of a Chapter's
 * `phase`, `game_phase` and `status`. TM Game's PUT /api/chapters/:id now REFUSES those keys with a 409
 * and no longer reads, writes or wipes anything on a phase body.
 *
 * What stays here: the pure `transitionFromPhase` reader (still used by the Cycle tab's read-only
 * status display) and its delegation. What is new: the refusal, its ordering and its absence of side
 * effects. The 25-pair wipe table, the transaction and atomicity tests, `isTransactionsUnsupported` and
 * the phase-button toggle tests were removed with the behaviour they covered.
 *
 * Ruling documents: TM Admin specs/cycle-model.md section 7 and 11a; story:
 * D:/Terra Mortis/TM Admin/specs/stories/tm-admin.27.1.retire-tm-game-phase-writer.story.md.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { ObjectId } from 'mongodb';

import {
  resetOnTransition,
  transitionFromPhase,
} from '../../public/js/downtime/cycle-phase.js';

import { createTestApp, stUser, playerUser } from './helpers/test-app.js';
import { setupDb, teardownDb, isDbAvailable } from './helpers/db-setup.js';
import { getCollection } from '../db.js';

const PHASE_MODULE = fs.readFileSync('../public/js/downtime/cycle-phase.js', 'utf8');
const ROUTE  = fs.readFileSync('routes/chapters.js', 'utf8');
const VIEWS  = fs.readFileSync('../public/js/admin/cycle-views.js', 'utf8');

// The five values a transition can move between, `null` included (a
// clear-to-neutral is a phase-keyed write - buildPhaseUpdate writes
// `phase: null` explicitly).
const PHASES = [null, 'downtime', 'processing', 'prep', 'game'];

// ── AC3: one shared "from phase" reader ──────────────────────────────────────

describe('cm-4a — transitionFromPhase (the single from-phase reader)', () => {
  it('reads a known `phase` value first', () => {
    for (const p of ['downtime', 'processing', 'prep', 'game']) {
      expect(transitionFromPhase({ phase: p })).toBe(p);
    }
  });

  it('falls back to a known legacy `game_phase` when `phase` is absent', () => {
    expect(transitionFromPhase({ game_phase: 'game' })).toBe('game');
    expect(transitionFromPhase({ game_phase: 'downtime' })).toBe('downtime');
  });

  // The AC3 divergence, in its dangerous direction: the client's uiPhase said
  // 'game' (so -> prep showed no dialog) while the server's cyclePhase said
  // 'processing' (so -> prep WOULD have wiped). One reader, one answer.
  it('the legacy shape {game_phase:"game", status:"closed"} resolves to game, not processing', () => {
    expect(transitionFromPhase({ game_phase: 'game', status: 'closed' })).toBe('game');
    expect(resetOnTransition(transitionFromPhase({ game_phase: 'game', status: 'closed' }), 'prep')).toBe(false);
  });

  it('falls back to statusToPhase when neither phase field is set', () => {
    expect(transitionFromPhase({ status: 'active' })).toBe('downtime');
    expect(transitionFromPhase({ status: 'open' })).toBe('downtime');
    expect(transitionFromPhase({ status: 'closed' })).toBe('processing');
    expect(transitionFromPhase({ status: 'game' })).toBe('game');
  });

  // Legacy status 'prep' means "the ST is setting the cycle up" - the START of
  // a cycle - never the phase named 'prep' near its end. statusToPhase's own
  // contract; re-pinned here because this reader now decides a WIPE.
  it('legacy status "prep" does NOT resolve to phase "prep"', () =>
    expect(transitionFromPhase({ status: 'prep' })).toBe(null));

  it('a hand-edited junk phase resolves to null rather than leaking', () => {
    expect(transitionFromPhase({ phase: 'feeding' })).toBe(null);
    expect(transitionFromPhase({ game_phase: 'feeding' })).toBe(null);
    // Junk in `phase` still lets the legacy fields answer.
    expect(transitionFromPhase({ phase: 'feeding', status: 'active' })).toBe('downtime');
  });

  it('a missing, null or empty cycle resolves to null', () => {
    expect(transitionFromPhase(null)).toBe(null);
    expect(transitionFromPhase(undefined)).toBe(null);
    expect(transitionFromPhase({})).toBe(null);
    expect(transitionFromPhase({ phase: null, game_phase: null, status: null })).toBe(null);
  });

  it('is pure: the module still declares and keeps its no-imports contract', () => {
    expect(PHASE_MODULE).toContain('PURE MODULE: no imports');
    expect(PHASE_MODULE).not.toMatch(/^\s*import\s/m);
  });
});

// ── AC2 / AC9: one implementation of the matrix, one honest comment ─────────

// ── AC6: the fallback guard is narrow ────────────────────────────────────────

// ── AC3: the client delegates to it ──────────────────────────────────────────

describe('cm-4a — cycle-views.js uiPhase delegates to the shared reader', () => {
  it('imports transitionFromPhase from the pure module', () =>
    expect(VIEWS).toMatch(/import\s*\{[^}]*transitionFromPhase[^}]*\}\s*from\s*'\.\.\/downtime\/cycle-phase\.js'/));

  it('uiPhase calls it and keeps the label-map guard', () => {
    const start = VIEWS.indexOf('function uiPhase');
    expect(start).toBeGreaterThan(-1);
    const body = VIEWS.slice(start, VIEWS.indexOf('}', VIEWS.indexOf('return', start)) + 1);
    expect(body).toContain('transitionFromPhase(cy)');
    expect(body).toContain('PHASE_LABELS[p] ? p : null');
  });

  // CM-4a review finding P5. The original of this assertion forbade the literal
  // string 'cy.phase || cy.game_phase' and was satisfied only by an accident of
  // syntax: `declaresPhase` IS a second resolution order, written with optional
  // chaining (`cy?.phase || cy?.game_phase`), and slipped past the pattern.
  //
  // The second reader is real, necessary and sanctioned - it answers a
  // DIFFERENT question (what does this document DECLARE, no `status` fallback)
  // and, since P2, has a real job: the phase buttons' toggle target, which must
  // NOT follow uiPhase's widened read. So the assertion is rewritten to what it
  // always meant: exactly ONE inline `phase || game_phase` resolution in this
  // file, and it must live inside the named `declaredPhase`.
  it('has exactly one sanctioned second resolution order, and it is declaredPhase', () => {
    const inline = VIEWS.match(/\bcy\??\.phase\s*\|\|\s*cy\??\.game_phase\b/g) || [];
    expect(inline).toHaveLength(1);

    const start = VIEWS.indexOf('function declaredPhase');
    expect(start).toBeGreaterThan(-1);
    const end = VIEWS.indexOf('\n}', start) + 2;
    expect(VIEWS.slice(start, end)).toMatch(/\bcy\??\.phase\s*\|\|\s*cy\??\.game_phase\b/);
    // Narrow on purpose: the declared read must never grow a status fallback,
    // or it stops being distinguishable from uiPhase and P2's bug returns.
    expect(VIEWS.slice(start, end)).not.toContain('status');
  });

});

// ── DB-backed: the route's refusal (Story 27.1) ─────────────────────────────
//
// issue-1143's convention: probe once at module load and describe.skipIf, so an unreachable MongoDB
// reports a clean skip rather than a failed beforeAll. A SKIPPED suite is not a passing suite.
const dbAvailable = await isDbAvailable();

let app;
const LABEL_PREFIX = 'Story 27.1 Probe';
const TRACKER_MARK = 'story271-probe';

const cycles = () => getCollection('chapters');
const tracker = () => getCollection('tracker_state');

async function makeCycle(fields = {}) {
  const doc = { label: `${LABEL_PREFIX} ${Math.random().toString(36).slice(2, 8)}`, ...fields };
  const { insertedId } = await cycles().insertOne(doc);
  return insertedId;
}

/** Seed live tracker documents, the thing a wipe destroys. */
async function seedTracker(n = 3) {
  await tracker().insertMany(Array.from({ length: n }, (_, i) => ({
    character_id: `${TRACKER_MARK}-${i}`, vitae: 5 + i, willpower: 4, _story271_probe: true,
  })));
  return n;
}
const trackerCount = () => tracker().countDocuments({});

async function cleanup() {
  await cycles().deleteMany({ label: { $regex: `^${LABEL_PREFIX}` } });
  await tracker().deleteMany({});
}

describe.skipIf(!dbAvailable)('Story 27.1 — TM Game refuses to set a Chapter phase (real DB)', () => {
  beforeAll(async () => { await setupDb(); app = createTestApp(); await cleanup(); });
  beforeEach(async () => { await cleanup(); });
  afterAll(async () => { await cleanup(); await teardownDb(); });

  const put = (id, body, user = stUser()) =>
    request(app).put(`/api/chapters/${id}`).set('X-Test-User', user).send(body);

  // AC1: each of the three keys is refused, for the ST, with nothing written and the tracker intact.
  for (const [key, value] of [['phase', 'game'], ['game_phase', 'game'], ['status', 'game']]) {
    it(`refuses a body carrying ${key}, changes nothing and leaves the tracker intact`, async () => {
      const id = await makeCycle({ phase: 'downtime' });
      const seeded = await seedTracker();
      const res = await put(id, { [key]: value });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('PHASE_CONTROLLED_BY_TM_ADMIN');
      expect(res.body.message).toMatch(/TM Admin/);
      const after = await cycles().findOne({ _id: id });
      expect(after.phase).toBe('downtime');
      expect(after.game_phase).toBeUndefined();
      expect(after.status).toBeUndefined();
      expect(await trackerCount()).toBe(seeded);
    });
  }

  it('refuses clearing a phase to neutral too (phase: null is still a phase write)', async () => {
    const id = await makeCycle({ phase: 'prep' });
    const res = await put(id, { phase: null });
    expect(res.status).toBe(409);
    expect((await cycles().findOne({ _id: id })).phase).toBe('prep');
  });

  it('refuses a MIXED body wholesale: the label in the same body is not written either', async () => {
    const id = await makeCycle({ phase: 'downtime' });
    const res = await put(id, { label: `${LABEL_PREFIX} renamed`, phase: 'prep' });
    expect(res.status).toBe(409);
    const after = await cycles().findOne({ _id: id });
    expect(after.label).not.toBe(`${LABEL_PREFIX} renamed`);
    expect(after.phase).toBe('downtime');
  });

  it('the formerly wiping transitions are all refused and wipe nothing (prep from downtime, game from processing, game from none)', async () => {
    for (const [from, to] of [['downtime', 'prep'], ['processing', 'game'], [null, 'game']]) {
      const id = await makeCycle({ phase: from });
      const seeded = await seedTracker();
      const res = await put(id, { phase: to });
      expect(res.status).toBe(409);
      expect(await trackerCount()).toBe(seeded);
      await tracker().deleteMany({});
    }
  });

  it('the refusal comes FIRST: before id validation and before any read (a malformed id still gets the 409)', async () => {
    const res = await put('not-an-object-id', { phase: 'game' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PHASE_CONTROLLED_BY_TM_ADMIN');
  });

  // AC1 (unchanged behaviour): a body without the three keys works exactly as before and never touches the tracker.
  it('a non-phase body still succeeds and never touches tracker_state', async () => {
    const id = await makeCycle({ phase: 'prep' });
    const seeded = await seedTracker();
    const res = await put(id, { label: `${LABEL_PREFIX} renamed`, submission_count: 3, session_id: 'abc' });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe(`${LABEL_PREFIX} renamed`);
    expect(res.body.phase).toBe('prep');
    expect(await trackerCount()).toBe(seeded);
  });

  it('unchanged error shapes for a non-phase body: 400 on a malformed id, 404 on a missing one', async () => {
    expect((await put('not-an-object-id', { label: 'x' })).status).toBe(400);
    expect((await put(new ObjectId().toString(), { label: 'x' })).status).toBe(404);
  });

  it('a player still cannot reach this route at all (the role gate runs before the refusal)', async () => {
    const id = await makeCycle({ phase: 'downtime' });
    const res = await put(id, { phase: 'game' }, playerUser());
    expect(res.status).toBe(403);
  });
});

// ── Source contracts (AC2, AC4): no wipe code left to run ───────────────────
describe('Story 27.1 — no code path in TM Game can wipe the trackers or set a phase', () => {
  it('the chapters router has no tracker_state access, no transaction and no transition code', () => {
    const code = ROUTE.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/tracker_state/);
    expect(code).not.toMatch(/deleteMany/);
    expect(code).not.toMatch(/startSession|withTransaction|getClient/);
    expect(code).not.toMatch(/runPhaseTransition|resetOnTransition|isTransactionsUnsupported/);
  });

  it('the route refuses the whole mirror trio, and the refusal is the first statement', () => {
    expect(ROUTE).toContain("const PHASE_FIELDS = ['phase', 'game_phase', 'status'];");
    const at = ROUTE.indexOf("cyclesRouter.put('/:id'");
    const refusal = ROUTE.indexOf('PHASE_CONTROLLED_BY_TM_ADMIN', at);
    const parse = ROUTE.indexOf('parseId(req.params.id)', at);
    expect(at).toBeGreaterThan(0);
    expect(refusal).toBeGreaterThan(at);
    expect(refusal).toBeLessThan(parse);
  });

  it('the bulk tracker wipe route is gone', () => {
    const TRACKER_ROUTE = fs.readFileSync('routes/tracker.js', 'utf8');
    const code = TRACKER_ROUTE.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('router.delete(');
    expect(code).not.toContain('deleteMany');
  });
});
