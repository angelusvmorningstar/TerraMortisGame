/**
 * `POST /api/tracker_state/:character_id/spend` - the player self-service Vitae/Willpower
 * spend route (Game 9 prep, 2026-09-12). See tracker.js's own comment on this route for why it
 * is separate from the general PUT: PUT already carries a legitimate player-writable INCREASE
 * path (Story 12.8's automatic feeding reconciliation), so this route exists specifically to be
 * one that can only ever subtract, atomically, for a caller who is not ST/dev.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import 'dotenv/config';
import { ObjectId } from 'mongodb';
import { createTestApp, stUser, playerUser } from './helpers/test-app.js';
import { setupDb, teardownDb } from './helpers/db-setup.js';
import { getCollection } from '../db.js';
import * as wsModule from '../ws.js';

let app;
let broadcastSpy;
const CHAR_OID = new ObjectId();
const CHAR_ID = CHAR_OID.toHexString();
const OTHER_CHAR_ID = new ObjectId().toHexString();

beforeAll(async () => {
  await setupDb();
  app = createTestApp();
  await getCollection('characters').deleteMany({ _id: CHAR_OID });
  await getCollection('characters').insertOne({
    _id: CHAR_OID,
    name: 'Spend Test Character',
    retired: false,
    _test_seeded: true,
  });
  broadcastSpy = vi.spyOn(wsModule, 'broadcastTrackerUpdate');
});

afterAll(async () => {
  await getCollection('characters').deleteMany({ _id: CHAR_OID });
  await getCollection('tracker_state').deleteMany({ character_id: { $in: [CHAR_ID, OTHER_CHAR_ID] } });
  broadcastSpy.mockRestore();
  await teardownDb();
});

beforeEach(async () => {
  broadcastSpy.mockClear();
  await getCollection('tracker_state').deleteMany({ character_id: CHAR_ID });
  await getCollection('tracker_state').insertOne({
    character_id: CHAR_ID,
    vitae: 10,
    willpower: 5,
  });
});

function spendAs(user, body, charId = CHAR_ID) {
  return request(app)
    .post(`/api/tracker_state/${charId}/spend`)
    .set('X-Test-User', user)
    .send(body);
}

describe('an owning player can spend their own Vitae/Willpower', () => {
  it('decreases vitae by the requested amount', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: 3 });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(7);
  });

  it('decreases willpower by the requested amount', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'willpower', amount: 2 });
    expect(res.status).toBe(200);
    expect(res.body.willpower).toBe(3);
  });

  it('floors at 0 rather than going negative', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: 999 });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(0);
  });

  it('broadcasts the post-spend value', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: 4 });
    expect(res.body.vitae).toBe(6);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy.mock.calls[0][1].vitae).toBe(6);
  });
});

describe('ownership is enforced', () => {
  it('refuses a player who does not own this character', async () => {
    const res = await spendAs(playerUser(['some-other-character-id']), { field: 'vitae', amount: 1 });
    expect(res.status).toBe(403);
  });

  it('an ST may still spend on any character (canAccess grants st/dev unconditionally)', async () => {
    const res = await spendAs(stUser(), { field: 'vitae', amount: 1 });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(9);
  });
});

describe('validation', () => {
  it('refuses a field other than vitae/willpower', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'influence', amount: 1 });
    expect(res.status).toBe(400);
  });

  it('refuses a missing field', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { amount: 1 });
    expect(res.status).toBe(400);
  });

  it('refuses a zero amount', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: 0 });
    expect(res.status).toBe(400);
  });

  it('refuses a negative amount', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: -3 });
    expect(res.status).toBe(400);
  });

  it('refuses a non-numeric amount', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: 'lots' });
    expect(res.status).toBe(400);
  });

  it('a fractional amount truncates rather than refusing', async () => {
    const res = await spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: 2.9 });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(8); // 10 - trunc(2.9)=2
  });
});

describe('no tracker_state row yet', () => {
  it('fails closed (404), never upserts a guessed starting value', async () => {
    const res = await spendAs(playerUser([OTHER_CHAR_ID]), { field: 'vitae', amount: 1 }, OTHER_CHAR_ID);
    expect(res.status).toBe(404);
    const doc = await getCollection('tracker_state').findOne({ character_id: OTHER_CHAR_ID });
    expect(doc).toBeNull();
  });
});

describe('concurrency - the atomic pipeline update, not read-then-write', () => {
  it('two simultaneous spends both apply, neither is lost to a race', async () => {
    const [r1, r2] = await Promise.all([
      spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: 3 }),
      spendAs(playerUser([CHAR_ID]), { field: 'vitae', amount: 2 }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const doc = await getCollection('tracker_state').findOne({ character_id: CHAR_ID });
    // Starting vitae 10, both a -3 and a -2 must land: 10 - 3 - 2 = 5, regardless of order.
    expect(doc.vitae).toBe(5);
  });
});
