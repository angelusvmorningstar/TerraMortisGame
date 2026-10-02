/**
 * cm-2b — HTTP-level coverage for the new `chapters.js` route file and for the
 * dual-read compatibility shim (`server/helpers/chapter-fk.js`).
 *
 * WHY THIS FILE EXISTS. The first pass of story cm-2b added a route file, moved
 * a router into it, renamed the collection it reads and renamed the FK on
 * `downtime_submissions` — and shipped exactly ONE new suite, for the migration
 * script. Nothing asserted that `/api/chapters` behaves the way
 * `/api/downtime_cycles` did, nothing asserted the old path was actually gone,
 * and nothing exercised the shim at all. Review flagged all three.
 *
 * Everything here runs against `tm_suite_test` (forced by
 * tests/helpers/setup-env.js; setupDb() additionally refuses any database whose
 * name does not end `_test`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import { ObjectId } from 'mongodb';
import { setupDb, teardownDb } from './helpers/db-setup.js';
import { getDb, getCollection } from '../db.js';
import { createTestApp, stUser, playerUser } from './helpers/test-app.js';
import {
  chapterFkFilter,
  chapterFkQueryParam,
  legacyChapterFkRefusal,
  normaliseChapterFkForResponse,
  readChapterFk,
  readChapterFkOid,
  withChapterFk,
  CHAPTER_FK,
  LEGACY_CHAPTER_FK,
} from '../helpers/chapter-fk.js';

const app = createTestApp();
const FIXTURE = '_cm2b_route_fixture';

let db;
let chapterId;
let charId;

async function wipe() {
  await getCollection('chapters').deleteMany({ [FIXTURE]: true });
  await getCollection('downtime_submissions').deleteMany({ [FIXTURE]: true });
}

beforeAll(async () => {
  await setupDb();
  db = getDb();
});

beforeEach(async () => {
  await wipe();
  chapterId = new ObjectId();
  charId = new ObjectId();
  await getCollection('chapters').insertOne({
    _id: chapterId,
    label: 'Downtime 9',
    game_number: 9,
    status: 'active',
    phase: 'downtime',
    [FIXTURE]: true,
  });
});

afterAll(async () => {
  await wipe();
  await teardownDb();
});

// ══════════════════════════════════════════════════════════════════════════
// The route file itself
// ══════════════════════════════════════════════════════════════════════════

describe('cm-2b — /api/chapters is the live mount', () => {
  it('GET /api/chapters lists Chapters', async () => {
    const res = await request(app).get('/api/chapters').set('X-Test-User', stUser());
    expect(res.status).toBe(200);
    expect(res.body.some(c => String(c._id) === String(chapterId))).toBe(true);
  });

  it('GET /api/chapters is readable by a player too (both roles see Chapters)', async () => {
    const res = await request(app).get('/api/chapters').set('X-Test-User', playerUser([String(charId)]));
    expect(res.status).toBe(200);
  });

  it('POST /api/chapters is ST-only and defaults phase_sequence', async () => {
    const denied = await request(app)
      .post('/api/chapters')
      .set('X-Test-User', playerUser([String(charId)]))
      .send({ label: 'Nope', [FIXTURE]: true });
    expect(denied.status).toBe(403);

    const res = await request(app)
      .post('/api/chapters')
      .set('X-Test-User', stUser())
      .send({ label: 'Downtime 10', game_number: 10, status: 'prep', [FIXTURE]: true });
    expect(res.status).toBe(201);
    expect(res.body.phase_sequence).toEqual(['downtime', 'processing', 'prep', 'game']);
  });

  it('PUT /api/chapters/:id updates, DELETE removes an empty Chapter', async () => {
    const put = await request(app)
      .put(`/api/chapters/${chapterId}`)
      .set('X-Test-User', stUser())
      .send({ label: 'Downtime 9 (edited)' });
    expect(put.status).toBe(200);
    expect(put.body.label).toBe('Downtime 9 (edited)');

    const del = await request(app).delete(`/api/chapters/${chapterId}`).set('X-Test-User', stUser());
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
  });

  it('404s on an unknown id rather than 500ing', async () => {
    const res = await request(app)
      .put(`/api/chapters/${new ObjectId()}`)
      .set('X-Test-User', stUser())
      .send({ label: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('cm-2b — /api/downtime_cycles is genuinely gone', () => {
  it('404s at the old collection path', async () => {
    const res = await request(app).get('/api/downtime_cycles').set('X-Test-User', stUser());
    expect(res.status).toBe(404);
  });

  it('404s at the old path even with an id', async () => {
    const res = await request(app)
      .put(`/api/downtime_cycles/${chapterId}`)
      .set('X-Test-User', stUser())
      .send({ label: 'x' });
    expect(res.status).toBe(404);
  });

  it('neither prod nor the test app still mounts it', () => {
    for (const f of ['./index.js', './tests/helpers/test-app.js']) {
      expect(fs.readFileSync(f, 'utf8')).not.toContain("'/api/downtime_cycles'");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The dual-read shim — pure helpers
// ══════════════════════════════════════════════════════════════════════════

describe('cm-2b shim — pure helpers', () => {
  it('reads chapter_id first and falls back to cycle_id only when absent', () => {
    const oid = new ObjectId();
    expect(String(readChapterFk({ [CHAPTER_FK]: oid }))).toBe(String(oid));
    expect(String(readChapterFk({ [LEGACY_CHAPTER_FK]: oid }))).toBe(String(oid));
    // Both present: the new name wins, always.
    const other = new ObjectId();
    expect(String(readChapterFk({ [CHAPTER_FK]: oid, [LEGACY_CHAPTER_FK]: other }))).toBe(String(oid));
    expect(readChapterFk({})).toBe(null);
    expect(readChapterFk(null)).toBe(null);
  });

  it('coerces a string-stored legacy FK to an ObjectId', () => {
    const oid = new ObjectId();
    expect(String(readChapterFkOid({ [LEGACY_CHAPTER_FK]: String(oid) }))).toBe(String(oid));
    expect(readChapterFkOid({ [CHAPTER_FK]: 'not-an-oid' })).toBe(null);
  });

  it('builds a filter that guards the legacy branch on chapter_id being absent', () => {
    const oid = new ObjectId();
    const f = chapterFkFilter(oid);
    expect(f.$or).toHaveLength(2);
    expect(f.$or[0][CHAPTER_FK].$in.map(String)).toEqual([String(oid), String(oid)]);
    expect(f.$or[1][CHAPTER_FK]).toEqual({ $exists: false });
    expect(f.$or[1][LEGACY_CHAPTER_FK].$in.map(String)).toEqual([String(oid), String(oid)]);
  });

  it('withChapterFk merges flat, but $ands when the base already owns an $or', () => {
    const oid = new ObjectId();
    expect(withChapterFk({ status: 'submitted' }, oid).status).toBe('submitted');
    expect(withChapterFk({ status: 'submitted' }, oid).$or).toHaveLength(2);
    const nested = withChapterFk({ $or: [{ character_id: 1 }] }, oid);
    expect(nested.$and).toHaveLength(2);
    expect(nested.$or).toBeUndefined();
  });

  it('reads the query param under either name, new one first', () => {
    expect(chapterFkQueryParam({ chapter_id: 'a' })).toEqual({ raw: 'a', name: CHAPTER_FK });
    expect(chapterFkQueryParam({ cycle_id: 'b' })).toEqual({ raw: 'b', name: LEGACY_CHAPTER_FK });
    expect(chapterFkQueryParam({ chapter_id: 'a', cycle_id: 'b' }).name).toBe(CHAPTER_FK);
    expect(chapterFkQueryParam({}).raw).toBeUndefined();
  });

  it('refuses a body carrying the legacy key, and only that', () => {
    expect(legacyChapterFkRefusal({ chapter_id: 'x' })).toBe(null);
    expect(legacyChapterFkRefusal({})).toBe(null);
    // Even an explicit null still counts: the KEY is what is rejected.
    const refusal = legacyChapterFkRefusal({ cycle_id: null });
    expect(refusal.error).toBe('LEGACY_CYCLE_ID_REJECTED');
    expect(refusal.expected).toBe(CHAPTER_FK);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The dual-read shim — over HTTP, against a genuinely legacy document
// ══════════════════════════════════════════════════════════════════════════

/** A submission the migration has NOT reached: `cycle_id` only. */
async function seedLegacySubmission(overrides = {}) {
  const doc = {
    character_id: charId,
    character_name: 'Legacy Fixture',
    status: 'submitted',
    [LEGACY_CHAPTER_FK]: chapterId,
    responses: { _has_minimum: true },
    [FIXTURE]: true,
    ...overrides,
  };
  const res = await getCollection('downtime_submissions').insertOne(doc);
  return res.insertedId;
}

describe('cm-2b shim — READS resolve a pre-migration cycle_id-only submission', () => {
  it('GET /api/downtime_submissions?chapter_id= finds it', async () => {
    const id = await seedLegacySubmission();
    const res = await request(app)
      .get(`/api/downtime_submissions?chapter_id=${chapterId}`)
      .set('X-Test-User', stUser());
    expect(res.status).toBe(200);
    expect(res.body.map(d => String(d._id))).toContain(String(id));
  });

  it('GET /api/downtime_submissions?cycle_id= (a stale client) filters instead of returning everything', async () => {
    await seedLegacySubmission();
    // A second submission on a DIFFERENT Chapter must NOT come back.
    const otherChapter = new ObjectId();
    await getCollection('downtime_submissions').insertOne({
      character_id: new ObjectId(), status: 'submitted',
      [CHAPTER_FK]: otherChapter, [FIXTURE]: true,
    });

    const res = await request(app)
      .get(`/api/downtime_submissions?cycle_id=${chapterId}`)
      .set('X-Test-User', stUser());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // And it comes back NAMED chapter_id — see the response-normalisation
    // block below for why that matters to the client.
    expect(String(res.body[0][CHAPTER_FK])).toBe(String(chapterId));
  });

  it('a malformed ?cycle_id= 400s by that name, matching its ?chapter_id= sibling', async () => {
    const res = await request(app)
      .get('/api/downtime_submissions?cycle_id=nonsense')
      .set('X-Test-User', stUser());
    expect(res.status).toBe(400);
    expect(res.body.message).toContain(LEGACY_CHAPTER_FK);
  });

  it('GET /hold-flags finds it under either param name', async () => {
    await seedLegacySubmission();
    for (const param of [CHAPTER_FK, LEGACY_CHAPTER_FK]) {
      const res = await request(app)
        .get(`/api/downtime_submissions/hold-flags?${param}=${chapterId}`)
        .set('X-Test-User', stUser());
      expect(res.status).toBe(200);
      expect(res.body[String(charId)]).toBe(false);   // has minimum ⇒ not on hold
    }
  });

  it('/hold-flags still 400s when NEITHER param is supplied', async () => {
    const res = await request(app)
      .get('/api/downtime_submissions/hold-flags')
      .set('X-Test-User', stUser());
    expect(res.status).toBe(400);
  });

  it('DELETE /api/chapters/:id refuses rather than orphaning it', async () => {
    await seedLegacySubmission();
    const res = await request(app).delete(`/api/chapters/${chapterId}`).set('X-Test-User', stUser());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CYCLE_HAS_SUBMISSIONS');
    expect(res.body.message).toContain('1 submission');
  });

  it('DELETE /api/chapters/:id also refuses over a DT1-era STRING-typed chapter_id', async () => {
    // The dual-TYPE half of the same helper. Both reviewers found this one.
    await getCollection('downtime_submissions').insertOne({
      character_id: charId, status: 'submitted',
      [CHAPTER_FK]: String(chapterId), [FIXTURE]: true,
    });
    const res = await request(app).delete(`/api/chapters/${chapterId}`).set('X-Test-User', stUser());
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CYCLE_HAS_SUBMISSIONS');
  });

  it('POST /api/chapters/:id/publish publishes it instead of silently doing nothing', async () => {
    const id = await seedLegacySubmission({
      st_review: { outcome_text: 'You survived the night.' },
    });
    const res = await request(app)
      .post(`/api/chapters/${chapterId}/publish`)
      .set('X-Test-User', stUser());
    expect(res.status).toBe(200);
    expect(res.body.published).toBe(1);

    const after = await getCollection('downtime_submissions').findOne({ _id: id });
    expect(after.published_outcome).toBe('You survived the night.');
    expect(after.st_review.outcome_visibility).toBe('published');
  });

  it('PATCH /api/territories/:id/feeding-rights still sees it as "has already fed"', async () => {
    // territories.js's regent lock reads submissions by Chapter FK, and picks
    // its Chapter with `findOne({ status: 'active' })`. Any residue left active
    // in the shared tm_suite_test by an earlier suite would win that findOne
    // and point the lock at the wrong submissions, so park them for the
    // duration and put them back afterwards.
    const strays = await getCollection('chapters')
      .find({ status: 'active', [FIXTURE]: { $ne: true } }).project({ _id: 1 }).toArray();
    const strayIds = strays.map(d => d._id);
    if (strayIds.length) {
      await getCollection('chapters').updateMany(
        { _id: { $in: strayIds } }, { $set: { status: '_cm2b_parked' } });
    }

    const terrId = new ObjectId();
    const regentId = new ObjectId();
    await getCollection('territories').insertOne({
      _id: terrId, slug: 'cm2b-probe', name: 'Probe Ward',
      regent_id: String(regentId), feeding_rights: [String(charId)],
    });
    // 'resident' is the grid value the lock actually looks for (496.4).
    await seedLegacySubmission({
      responses: { feeding_territories: JSON.stringify({ [String(terrId)]: 'resident' }) },
    });

    const res = await request(app)
      .patch(`/api/territories/${terrId}/feeding-rights`)
      .set('X-Test-User', playerUser([String(regentId)]))
      .send({ feeding_rights: [] });

    await getCollection('territories').deleteOne({ _id: terrId });
    if (strayIds.length) {
      await getCollection('chapters').updateMany(
        { _id: { $in: strayIds } }, { $set: { status: 'active' } });
    }

    expect(res.status).toBe(409);
    expect(res.body.locked).toEqual([String(charId)]);
  });
});

describe('cm-2b shim — responses always NAME the FK chapter_id', () => {
  // Roughly twenty client files read `s.chapter_id` off a fetched submission
  // (app.js picks the feeding Chapter that way; admin/downtime-story.js matches
  // submissions to a Chapter that way). A legacy document handed to them as
  // `cycle_id` is found by the query and then dropped by the renderer — the
  // same empty view, one layer later. Normalised once at the boundary.
  it('GET / renames it on the way out and does not leak the legacy key', async () => {
    await seedLegacySubmission();
    const res = await request(app)
      .get(`/api/downtime_submissions?chapter_id=${chapterId}`)
      .set('X-Test-User', stUser());

    const doc = res.body.find(d => d.character_name === 'Legacy Fixture');
    expect(String(doc[CHAPTER_FK])).toBe(String(chapterId));
    expect(doc).not.toHaveProperty(LEGACY_CHAPTER_FK);
  });

  it('the stored document is UNCHANGED — this is a read fallback, not a write', async () => {
    const id = await seedLegacySubmission();
    await request(app)
      .get(`/api/downtime_submissions?chapter_id=${chapterId}`)
      .set('X-Test-User', stUser());

    const stored = await getCollection('downtime_submissions').findOne({ _id: id });
    expect(stored[LEGACY_CHAPTER_FK]).toBeTruthy();
    expect(stored[CHAPTER_FK]).toBeUndefined();
  });

  it('a PUT response is normalised too, so the client re-render sees it', async () => {
    const id = await seedLegacySubmission();
    const res = await request(app)
      .put(`/api/downtime_submissions/${id}`)
      .set('X-Test-User', stUser())
      .send({ 'responses.project_1_description': 'ST edit' });

    expect(res.status).toBe(200);
    expect(String(res.body[CHAPTER_FK])).toBe(String(chapterId));
    expect(res.body).not.toHaveProperty(LEGACY_CHAPTER_FK);
  });

  it('normaliseChapterFkForResponse leaves a modern document strictly alone', () => {
    const modern = { chapter_id: 'x' };
    expect(normaliseChapterFkForResponse(modern)).toBe(modern);
    expect(modern).toEqual({ chapter_id: 'x' });
    // Both present: the new value wins and the legacy key is dropped.
    expect(normaliseChapterFkForResponse({ chapter_id: 'x', cycle_id: 'y' })).toEqual({ chapter_id: 'x' });
  });
});

describe('cm-2b shim — the deadline gate no longer fails open on a legacy submission', () => {
  it('blocks a player edit past the deadline when the FK is cycle_id-only', async () => {
    await getCollection('chapters').updateOne(
      { _id: chapterId },
      { $set: { deadline_at: '2020-01-01T00:00:00.000Z', manual_open: false } },
    );
    const id = await seedLegacySubmission();

    const res = await request(app)
      .put(`/api/downtime_submissions/${id}`)
      .set('X-Test-User', playerUser([String(charId)]))
      .send({ 'responses.project_1_description': 'sneaking a late edit in' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('DEADLINE_PASSED');
  });

  it('and locks it outright when the Chapter is closed (requireOpenCycle)', async () => {
    await getCollection('chapters').updateOne(
      { _id: chapterId },
      { $set: { status: 'closed', phase: 'processing' } },
    );
    const id = await seedLegacySubmission();

    const res = await request(app)
      .put(`/api/downtime_submissions/${id}`)
      .set('X-Test-User', playerUser([String(charId)]))
      .send({ 'responses.project_1_description': 'edit during processing' });

    expect(res.status).toBe(423);
    expect(res.body.error).toBe('CYCLE_CLOSED');
  });
});

describe('cm-2b shim — WRITES reject the legacy key (read-only compatibility, never read-and-write-both)', () => {
  it('POST /api/downtime_submissions 400s on a body carrying cycle_id', async () => {
    const res = await request(app)
      .post('/api/downtime_submissions')
      .set('X-Test-User', stUser())
      .send({ character_id: String(charId), status: 'draft', cycle_id: String(chapterId), [FIXTURE]: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LEGACY_CYCLE_ID_REJECTED');
    expect(await getCollection('downtime_submissions').countDocuments({ [FIXTURE]: true })).toBe(0);
  });

  it('POST 400s even when the body ALSO carries a correct chapter_id', async () => {
    const res = await request(app)
      .post('/api/downtime_submissions')
      .set('X-Test-User', stUser())
      .send({
        character_id: String(charId), status: 'draft',
        chapter_id: String(chapterId), cycle_id: String(chapterId), [FIXTURE]: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LEGACY_CYCLE_ID_REJECTED');
  });

  it('PUT /api/downtime_submissions/:id 400s on a body carrying cycle_id, and writes nothing', async () => {
    const id = await seedLegacySubmission();
    const res = await request(app)
      .put(`/api/downtime_submissions/${id}`)
      .set('X-Test-User', stUser())
      .send({ cycle_id: String(new ObjectId()), status: 'draft' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('LEGACY_CYCLE_ID_REJECTED');
    const after = await getCollection('downtime_submissions').findOne({ _id: id });
    expect(after.status).toBe('submitted');                       // untouched
    expect(String(after[LEGACY_CHAPTER_FK])).toBe(String(chapterId));
  });

  it('POST with chapter_id is accepted and normalised to an ObjectId', async () => {
    const res = await request(app)
      .post('/api/downtime_submissions')
      .set('X-Test-User', stUser())
      .send({ character_id: String(charId), status: 'draft', chapter_id: String(chapterId), [FIXTURE]: true });

    expect(res.status).toBe(201);
    const stored = await getCollection('downtime_submissions').findOne({ _id: new ObjectId(res.body._id) });
    expect(stored[CHAPTER_FK]).toBeInstanceOf(ObjectId);
    expect(stored[LEGACY_CHAPTER_FK]).toBeUndefined();
  });

  it('the rejection does NOT extend to project_invitations, whose own cycle_id is deliberately kept', async () => {
    // Three FKs named cycle_id survive cm-2b untouched (coordination doc §6).
    // A guard that caught them too would break invitations outright.
    const res = await request(app)
      .get(`/api/project_invitations?cycle_id=${chapterId}&character_id=${charId}`)
      .set('X-Test-User', stUser());
    expect(res.status).toBe(200);
  });
});
