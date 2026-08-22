/**
 * crd.1 — real behavioural coverage for the contested-roll data-lock /
 * schema-hardening story (Epic CRD, specs/epic-crd-contested-roll-defence.md).
 *
 *   AC1 — `defender_pool` is no longer REQUIRED at creation (the attacker no
 *         longer asserts the defender's dice pool); `challenger_pool` still is.
 *   AC2 — the schema knows about `request_type` and `POST /` sets it to
 *         'contested_roll' on every document it creates.
 *   AC3 — the three defender-resolution fields (`defender_aspect`,
 *         `defender_wp_spent`, `defender_merit_ids`) exist, correctly typed,
 *         and are optional at creation.
 *   AC4 — covered together with AC2 (same route change).
 *   AC5 — `_findChallenge` (accept/decline) and `PUT /:id/void` include BOTH
 *         legacy request_type-absent documents AND new explicit
 *         'contested_roll' documents, and still exclude 'status_action'.
 *   AC6 — `GET /mine` is served by the compound index, and is scoped so a
 *         'status_action' document can never leak into a player's queue.
 *   AC7 — the terminal-status TTL index exists with the agreed retention.
 *
 * AC8 is a one-time live read-only spot-check recorded in the story's Dev
 * Agent Record, not an automated test. AC9 is a documentation edit.
 *
 * Follows oaq-2-pending-status-actions.test.js exactly: real Supertest
 * requests against the mounted test app + tm_game_test, prefixed fixtures,
 * describe.skipIf(!dbAvailable) for a clean skip when MongoDB is unreachable.
 *
 * DB-backed: real MongoDB required. See db-setup.js.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, stUser, playerUser } from './helpers/test-app.js';
import { setupDb, teardownDb, isDbAvailable } from './helpers/db-setup.js';
import { getCollection } from '../db.js';
import { ObjectId } from 'mongodb';

const dbAvailable = await isDbAvailable();

let app;
const NAME_PREFIX = 'CRD-1 Probe';

// Stable, obviously-synthetic character ids. POST / only checks these against
// req.user.character_ids — it never reads the characters collection — so no
// character fixtures are needed for the request-shape ACs.
const CHALLENGER_ID = '000000000000000000000c01';
const TARGET_ID     = '000000000000000000000d01';

async function cleanup() {
  await getCollection('contested_roll_requests').deleteMany({
    $or: [
      { challenger_character_name: { $regex: `^${NAME_PREFIX}` } },
      { target_character_name:     { $regex: `^${NAME_PREFIX}` } },
      { actor_name:                { $regex: `^${NAME_PREFIX}` } },
    ],
  });
}

function validBody(overrides = {}) {
  return {
    challenger_character_id:   CHALLENGER_ID,
    challenger_character_name: `${NAME_PREFIX} Challenger`,
    target_character_id:       TARGET_ID,
    target_character_name:     `${NAME_PREFIX} Target`,
    roll_type:                 'social',
    challenger_pool:           7,
    ...overrides,
  };
}

function post(body, userHeader = playerUser([CHALLENGER_ID])) {
  return request(app).post('/api/contested_roll_requests').set('X-Test-User', userHeader).send(body);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupDb();
  app = createTestApp();
  await cleanup();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await cleanup();
  await teardownDb();
});

describe.skipIf(!dbAvailable)('crd.1 AC1 — defender_pool is optional at creation', () => {
  it('accepts a challenge with NO defender_pool at all (the attacker no longer asserts it)', async () => {
    const res = await post(validBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.defender_pool, 'a pending challenge genuinely has no defender pool yet').toBeUndefined();
    expect(res.body.challenger_pool).toBe(7);
    expect(res.body.status).toBe('pending');
  });

  it('still REQUIRES challenger_pool — the attacker\'s own pool is unaffected by this epic', async () => {
    const body = validBody();
    delete body.challenger_pool;
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('still validates defender_pool\'s range when it IS supplied', async () => {
    const res = await post(validBody({ defender_pool: 31 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('still accepts an in-range defender_pool when supplied', async () => {
    const res = await post(validBody({ defender_pool: 4 }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.defender_pool).toBe(4);
  });
});

describe.skipIf(!dbAvailable)('crd.1 AC2/AC4 — request_type is an explicit, known field', () => {
  it('POST / sets request_type: \'contested_roll\' on every document it creates', async () => {
    const res = await post(validBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.request_type).toBe('contested_roll');

    const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(res.body._id) });
    expect(stored.request_type, 'the stored document, not just the response body').toBe('contested_roll');
  });

  it('accepts an explicit request_type: \'contested_roll\' in the body (additionalProperties: false must not reject it)', async () => {
    const res = await post(validBody({ request_type: 'contested_roll' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.request_type).toBe('contested_roll');
  });

  it('rejects any other request_type — a client cannot smuggle a status_action through this route', async () => {
    const res = await post(validBody({ request_type: 'status_action' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('a client-supplied request_type can never override the server\'s own value', async () => {
    // The enum makes 'contested_roll' the only accepted input, but the route
    // must still be the authority: the explicit set has to come AFTER the
    // req.body spread, not before it.
    const src = await import('node:fs').then(fs =>
      fs.promises.readFile(new URL('../routes/contested-rolls.js', import.meta.url), 'utf8'));
    const docBlock = src.slice(src.indexOf('const doc = {'), src.indexOf('const result'));
    expect(docBlock.indexOf('...req.body')).toBeLessThan(docBlock.indexOf('request_type'));
  });
});

describe.skipIf(!dbAvailable)('crd.1 AC3 — the defender-resolution fields exist and are correctly typed', () => {
  it('accepts all three new fields as SCHEMA-VALID shapes (additionalProperties: false must not reject them)', async () => {
    const res = await post(validBody({
      defender_aspect:    'mental',
      defender_wp_spent:  true,
      defender_merit_ids: ['indomitable', 'closed-book'],
    }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  // ── Code-review patch 2 (external Codex review, Pass 3a Medium) ────────────
  // These three are the DEFENDER's own submitted resolution choices, written
  // later by crd.3a's resolve endpoint. AC3 says literally that they "only ever
  // get populated later, by crd.3a, not by this story or by POST /" — but the
  // `...req.body` spread let the ATTACKER assert all three at creation time,
  // the same shape of injury as the original attacker-writable defender_pool
  // this whole epic exists to fix. Stripped after the spread, exactly the way
  // request_type is force-set after it.
  it('POST / never PERSISTS attacker-supplied defender-resolution fields (AC3\'s literal provenance rule)', async () => {
    const res = await post(validBody({
      defender_aspect:    'mental',
      defender_wp_spent:  true,
      defender_merit_ids: ['indomitable', 'closed-book'],
    }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(res.body._id) });
    for (const field of ['defender_aspect', 'defender_wp_spent', 'defender_merit_ids']) {
      expect(stored[field], `${field} must not survive from the attacker's creation body into the stored document`).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(stored, field), `${field} must not be present at all, not even as null`).toBe(false);
      expect(res.body[field], `${field} must not be echoed back either`).toBeUndefined();
    }
  });

  it('each of the three is stripped INDEPENDENTLY, not only when all three arrive together', async () => {
    for (const [field, value] of [['defender_aspect', 'social'], ['defender_wp_spent', true], ['defender_merit_ids', ['indomitable']]]) {
      const res = await post(validBody({ [field]: value }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(res.body._id) });
      expect(Object.prototype.hasOwnProperty.call(stored, field), `${field} alone must still be stripped`).toBe(false);
    }
  });

  it('stripping the three does not disturb the fields POST / legitimately stores', async () => {
    const res = await post(validBody({
      defender_aspect: 'physical',
      power_name:      'Awe',
      defender_pool:   4,
    }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(res.body._id) });
    expect(stored.power_name).toBe('Awe');
    expect(stored.defender_pool).toBe(4);
    expect(stored.challenger_pool).toBe(7);
    expect(stored.request_type).toBe('contested_roll');
    expect(Object.prototype.hasOwnProperty.call(stored, 'defender_aspect')).toBe(false);
  });

  it('all three are OPTIONAL — a challenge created without them is still valid', async () => {
    const res = await post(validBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.defender_aspect).toBeUndefined();
    expect(res.body.defender_wp_spent).toBeUndefined();
    expect(res.body.defender_merit_ids).toBeUndefined();
  });

  it.each(['mental', 'social', 'physical'])('the schema accepts defender_aspect: %s (POST / then strips it — see patch 2 below)', async (aspect) => {
    const res = await post(validBody({ defender_aspect: aspect }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('rejects an off-enum defender_aspect', async () => {
    const res = await post(validBody({ defender_aspect: 'spiritual' }));
    expect(res.status).toBe(400);
  });

  it('rejects a NUMERIC defender_wp_spent — the real rule caps a spend at one point per action, so it is a boolean', async () => {
    const res = await post(validBody({ defender_wp_spent: 2 }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-array defender_merit_ids, and a non-string member', async () => {
    expect((await post(validBody({ defender_merit_ids: 'indomitable' }))).status).toBe(400);
    expect((await post(validBody({ defender_merit_ids: [1, 2] }))).status).toBe(400);
  });

  it('still rejects a genuinely unknown field — additionalProperties: false must still hold', async () => {
    const res = await post(validBody({ defender_smuggled_bonus: 5 }));
    expect(res.status).toBe(400);
    expect(res.body.errors.some(e => e.property === 'defender_smuggled_bonus')).toBe(true);
  });
});

// ── AC5: the three document shapes that share this collection ────────────────
// Inserted directly, not through POST /, because two of them cannot be created
// through this router at all: the LEGACY shape (no request_type field
// whatsoever) is what every contested roll written before crd.1 looks like and
// is no longer producible, and the status_action shape is written by
// office-actions.js.
async function seedShape(shape, overrides = {}) {
  const base = {
    challenger_character_id:   CHALLENGER_ID,
    challenger_character_name: `${NAME_PREFIX} Challenger`,
    target_character_id:       TARGET_ID,
    target_character_name:     `${NAME_PREFIX} Target`,
    roll_type:       'social',
    challenger_pool: 5,
    defender_pool:   3,
    status:     'pending',
    outcome:    null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  if (shape === 'new')           base.request_type = 'contested_roll';
  if (shape === 'status_action') {
    base.request_type = 'status_action';
    // oaq.2's partial UNIQUE index on (game_session_id, actor_id, target_id)
    // is scoped to pending status_actions and is created against the shared
    // tm_game_test database by oaq-2-pending-status-actions.test.js. Without
    // distinct values here, two status_action fixtures in this file would both
    // key on (null, null, null) and collide with E11000 — a cross-file
    // artefact of the shared test DB, not a property of the code under test.
    const uniq = `${Date.now()}_${Math.random()}`;
    base.game_session_id = overrides.game_session_id ?? `crd1-${uniq}`;
    base.actor_id        = overrides.actor_id        ?? `crd1-actor-${uniq}`;
    base.target_id       = overrides.target_id       ?? `crd1-target-${uniq}`;
  }
  // shape === 'legacy' deliberately sets no request_type at all.
  const { insertedId } = await getCollection('contested_roll_requests').insertOne(base);
  return String(insertedId);
}

const defenderUser = () => playerUser([TARGET_ID]);

describe.skipIf(!dbAvailable)('crd.1 AC5 — _findChallenge and PUT /:id/void across all three document shapes', () => {
  it.each([['legacy (request_type absent)', 'legacy'], ['new (request_type: contested_roll)', 'new']])(
    'accept resolves a %s contested roll', async (_label, shape) => {
      const id = await seedShape(shape);
      const res = await request(app).put(`/api/contested_roll_requests/${id}/accept`).set('X-Test-User', defenderUser());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('resolved');
      expect(res.body.outcome).toBeTruthy();
    });

  it.each([['legacy (request_type absent)', 'legacy'], ['new (request_type: contested_roll)', 'new']])(
    'decline declines a %s contested roll', async (_label, shape) => {
      const id = await seedShape(shape);
      const res = await request(app).put(`/api/contested_roll_requests/${id}/decline`).set('X-Test-User', defenderUser());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(id) });
      expect(stored.status).toBe('declined');
    });

  it.each([['legacy (request_type absent)', 'legacy'], ['new (request_type: contested_roll)', 'new']])(
    'void voids a %s contested roll', async (_label, shape) => {
      const id = await seedShape(shape);
      const res = await request(app).put(`/api/contested_roll_requests/${id}/void`).set('X-Test-User', stUser());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('voided');
    });

  it('accept, decline and void ALL refuse a status_action document (404), leaving it untouched', async () => {
    // oaq.3's own regression, re-proved here because crd.1 adds a third
    // possible request_type value to the same collection: a status_action
    // must stay reachable only by office-actions.js's own lifecycle.
    for (const verb of ['accept', 'decline', 'void']) {
      const id = await seedShape('status_action', { actor_name: `${NAME_PREFIX} Actor` });
      const user = verb === 'void' ? stUser() : defenderUser();
      const res = await request(app).put(`/api/contested_roll_requests/${id}/${verb}`).set('X-Test-User', user);
      expect(res.status, `${verb} must not touch a status_action document`).toBe(404);
      const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(id) });
      expect(stored.status, `${verb} must leave the status_action record pending`).toBe('pending');
    }
  });
});

// ── Code-review patch 1 (external Codex review, Pass 2/Pass 3a High) ─────────
// AC1 made `defender_pool` optional at creation, but `PUT /:id/accept` was left
// unchanged. The two halves were each covered in isolation and their
// integration was not: creating WITHOUT a pool and then accepting was never
// composed in a test. Live reproduction confirmed the consequence —
// `_roll(undefined)` returns `[]` (because `Math.max(0, undefined)` is `NaN`),
// so the request resolved 200 with `defender: { pool: null, successes: 0,
// rolls: [] }` and `outcome: 'attacker'`: the defender silently lost on zero
// dice. These tests compose the two halves.
describe.skipIf(!dbAvailable)('crd.1 review patch — /accept refuses a challenge with no defender pool yet', () => {
  it('the exact live repro: POST with NO defender_pool, then accept — must NOT resolve as a zero-die defence', async () => {
    const created = await post(validBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.defender_pool).toBeUndefined();

    const res = await request(app)
      .put(`/api/contested_roll_requests/${created.body._id}/accept`)
      .set('X-Test-User', defenderUser());

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
    expect(String(res.body.message)).toMatch(/defender pool/i);

    // And the record must be left exactly as it was — not resolved, no outcome,
    // and no session_logs entry written on its behalf.
    const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(created.body._id) });
    expect(stored.status, 'a blocked accept must leave the challenge pending').toBe('pending');
    expect(stored.outcome).toBeNull();
    const logs = await getCollection('session_logs')
      .countDocuments({ challenge_id: String(created.body._id) });
    expect(logs, 'no session log may be written for a refused accept').toBe(0);
  });

  it('an explicit defender_pool of 0 is a RESOLVED pool, not a missing one — it still accepts and rolls', async () => {
    // Discriminates a correct null/undefined check from a falsy `!pool` check:
    // zero dice deliberately assigned by crd.3a is a legitimate resolved state.
    const id = await seedShape('new', { defender_pool: 0 });
    const res = await request(app).put(`/api/contested_roll_requests/${id}/accept`).set('X-Test-User', defenderUser());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(res.body.outcome.defender.pool).toBe(0);
  });

  it('REGRESSION: the pre-existing accept path (defender_pool supplied) is unaffected and still rolls', async () => {
    const id = await seedShape('new'); // seedShape always supplies defender_pool: 3
    const res = await request(app).put(`/api/contested_roll_requests/${id}/accept`).set('X-Test-User', defenderUser());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('resolved');
    expect(res.body.outcome.defender.pool).toBe(3);
    expect(res.body.outcome.defender.rolls.length, 'three real dice, not an empty degenerate roll').toBe(3);
    expect(res.body.outcome.attacker.rolls.length).toBe(5);
  });

  it('the pool guard runs AFTER the ownership check — a non-target still gets 403, not the pool 409', async () => {
    const created = await post(validBody());
    const res = await request(app)
      .put(`/api/contested_roll_requests/${created.body._id}/accept`)
      .set('X-Test-User', playerUser(['000000000000000000000d99']));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('decline is NOT blocked by a missing defender pool — a defender may always refuse a challenge', async () => {
    const created = await post(validBody());
    const res = await request(app)
      .put(`/api/contested_roll_requests/${created.body._id}/decline`)
      .set('X-Test-User', defenderUser());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(created.body._id) });
    expect(stored.status).toBe('declined');
  });
});

describe.skipIf(!dbAvailable)('crd.1 AC5/AC6 — GET /mine is scoped by request_type, not by field-name coincidence', () => {
  it('returns BOTH legacy and new-shaped pending contested rolls targeting me', async () => {
    await cleanup();
    const legacyId = await seedShape('legacy');
    const newId    = await seedShape('new');

    const res = await request(app).get('/api/contested_roll_requests/mine').set('X-Test-User', defenderUser());
    expect(res.status).toBe(200);
    const ids = res.body.map(d => String(d._id));
    expect(ids).toContain(legacyId);
    expect(ids).toContain(newId);
  });

  it('never returns a status_action document, even one that DOES carry target_character_id', async () => {
    // Today's protection is accidental: office-actions.js writes `target_id`,
    // not `target_character_id`, so a status_action simply never matches this
    // query's field name. That is the same "harmless only by accident" shape
    // that produced the void-orphaning bug — any future writer adding a
    // target_character_id to a status_action would leak it straight into a
    // player's own queue. Scoped explicitly instead.
    await cleanup();
    const leakId = await seedShape('status_action', {
      target_character_id: TARGET_ID,
      actor_name: `${NAME_PREFIX} Actor`,
    });

    const res = await request(app).get('/api/contested_roll_requests/mine').set('X-Test-User', defenderUser());
    expect(res.status).toBe(200);
    const ids = res.body.map(d => String(d._id));
    expect(ids, 'a Status Action must never appear in a player\'s contested-roll queue').not.toContain(leakId);
  });

  it('never returns a HYPOTHETICAL FUTURE request_type either — the filter is positive, not a negation of status_action', async () => {
    // Discriminates the chosen `$in: [null, 'contested_roll']` filter from the
    // `$ne: 'status_action'` alternative the story allowed: a fourth type
    // sharing this collection later must not leak by default.
    await cleanup();
    const futureId = await seedShape('legacy', { request_type: 'some_future_request' });

    const res = await request(app).get('/api/contested_roll_requests/mine').set('X-Test-User', defenderUser());
    expect(res.status).toBe(200);
    expect(res.body.map(d => String(d._id))).not.toContain(futureId);
  });

  it('only returns PENDING requests, and only ones targeting the caller\'s own characters', async () => {
    await cleanup();
    const pendingId  = await seedShape('new');
    await seedShape('new', { status: 'resolved' });
    await seedShape('new', { target_character_id: '000000000000000000000d99' });

    const res = await request(app).get('/api/contested_roll_requests/mine').set('X-Test-User', defenderUser());
    expect(res.status).toBe(200);
    expect(res.body.map(d => String(d._id))).toEqual([pendingId]);
  });
});

// ── AC6/AC7: indexes ────────────────────────────────────────────────────────
// Boot-time index creation lives in server/index.js, which cannot be imported
// here (it calls start() and binds a port). So these are covered from two
// directions: the DECLARATION is checked against server/index.js's real
// source, and the SPEC is checked behaviourally — the exact same index
// definitions are built against tm_game_test and the real GET /mine query is
// explained against them.

const CRD1_QUEUE_INDEX = {
  key:  { target_character_id: 1, status: 1, created_at: -1 },
  opts: { name: 'crd1_defender_queue', background: true },
};
const CRD1_TTL_INDEX = {
  key:  { updated_at: 1 },
  opts: {
    name: 'crd1_terminal_status_ttl',
    background: true,
    expireAfterSeconds: 2592000, // 30 days
    partialFilterExpression: { status: { $in: ['resolved', 'declined', 'voided'] } },
  },
};

function indexJsSource() {
  return import('node:fs').then(fs =>
    fs.promises.readFile(new URL('../index.js', import.meta.url), 'utf8'));
}

/** The createIndex(...) call bodies server/index.js makes on this collection. */
function contestedRollIndexBlocks(src) {
  const blocks = [];
  const marker = "collection('contested_roll_requests').createIndex(";
  let at = src.indexOf(marker);
  while (at !== -1) {
    const end = src.indexOf('\n    );', at);
    blocks.push(src.slice(at, end).replace(/\s+/g, ' '));
    at = src.indexOf(marker, at + 1);
  }
  return blocks;
}

describe.skipIf(!dbAvailable)('crd.1 AC6 — GET /mine is served by a compound index', () => {
  it('server/index.js declares the { target_character_id, status, created_at } compound index on boot', async () => {
    const blocks = contestedRollIndexBlocks(await indexJsSource());
    const queue = blocks.filter(b => b.includes('target_character_id'));
    expect(queue.length, 'exactly one boot-time index keyed on target_character_id').toBe(1);
    expect(queue[0]).toContain('target_character_id: 1');
    expect(queue[0]).toContain('status: 1');
    expect(queue[0]).toContain('created_at: -1');
    expect(queue[0], 'the oaq.2 partial-unique index must not be disturbed').not.toContain('unique: true');
  });

  it('the real GET /mine query plans as an index scan against that index, not a collection scan', async () => {
    const col = getCollection('contested_roll_requests');
    await col.createIndex(CRD1_QUEUE_INDEX.key, CRD1_QUEUE_INDEX.opts);

    // The same filter/sort contested-rolls.js's GET /mine issues.
    const plan = await col.find({
      target_character_id: { $in: [TARGET_ID] },
      status: 'pending',
      request_type: { $in: [null, 'contested_roll'] },
    }).sort({ created_at: -1 }).explain('queryPlanner');

    const stages = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(stages, 'GET /mine must not fall back to a COLLSCAN at table scale').not.toContain('COLLSCAN');
    expect(stages).toContain(CRD1_QUEUE_INDEX.opts.name);
  });

  it('the oaq.2 partial unique index is still declared and untouched', async () => {
    const blocks = contestedRollIndexBlocks(await indexJsSource());
    const oaq2 = blocks.filter(b => b.includes("request_type: 'status_action'"));
    expect(oaq2.length).toBe(1);
    expect(oaq2[0]).toContain('unique: true');
  });
});

describe.skipIf(!dbAvailable)('crd.1 AC7 — terminal-status TTL index', () => {
  it('server/index.js declares a 30-day TTL index on updated_at, partial-filtered to terminal statuses', async () => {
    const blocks = contestedRollIndexBlocks(await indexJsSource());
    const ttl = blocks.filter(b => b.includes('expireAfterSeconds'));
    expect(ttl.length, 'exactly one boot-time TTL index on this collection').toBe(1);
    expect(ttl[0]).toContain('updated_at: 1');
    expect(ttl[0], '30 days — agreed retention window, see the story AC7').toContain('expireAfterSeconds: 2592000');
    for (const status of ['resolved', 'declined', 'voided']) expect(ttl[0]).toContain(`'${status}'`);
    expect(ttl[0], 'a TTL index must never also be unique').not.toContain('unique: true');
  });

  it('that index definition is accepted by MongoDB and reports the expected TTL + partial filter', async () => {
    const col = getCollection('contested_roll_requests');
    await col.createIndex(CRD1_TTL_INDEX.key, CRD1_TTL_INDEX.opts);

    const indexes = await col.indexes();
    const ttl = indexes.find(i => i.name === CRD1_TTL_INDEX.opts.name);
    expect(ttl, 'the TTL index must exist').toBeTruthy();
    expect(ttl.key).toEqual({ updated_at: 1 });
    expect(ttl.expireAfterSeconds).toBe(2592000);
    expect(ttl.partialFilterExpression).toEqual({ status: { $in: ['resolved', 'declined', 'voided'] } });
  });

  it('DOCUMENTED LIMITATION: updated_at is still written as an ISO STRING, so the TTL reaper is inert today', async () => {
    // MongoDB's TTL monitor only expires documents whose indexed field holds a
    // BSON Date (or an array of them). Every writer on this collection stores
    // `new Date().toISOString()` — a string — so the index above is correct,
    // idempotent and harmless, but deletes nothing until updated_at becomes a
    // real Date. Converting it is a data-shape change across both route
    // families (contested-rolls.js AND office-actions.js) plus a backfill of
    // every existing document, which crd.1 explicitly excludes ("NOT a
    // live-data migration or backfill"). Flagged for a follow-up story.
    //
    // If this test ever fails, updated_at has become a Date: the TTL is now
    // genuinely live — re-read the retention window and this note rather than
    // just deleting the assertion.
    const res = await post(validBody());
    expect(res.status).toBe(201);
    const stored = await getCollection('contested_roll_requests').findOne({ _id: new ObjectId(res.body._id) });
    expect(typeof stored.updated_at, 'still an ISO string — see this test\'s own comment').toBe('string');
  });
});
