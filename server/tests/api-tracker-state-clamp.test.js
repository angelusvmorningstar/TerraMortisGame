/**
 * Story 12.8, AC 13 - `PUT /api/tracker_state/:character_id` clamps server-side,
 * whitelists its body, and broadcasts what it actually stored.
 *
 * WHY THIS EXISTS. Until Story 12.8 this route was a bare `$set: {...req.body}`
 * with `upsert: true` and no validation of any kind - TM Story's own
 * `mongo-store.js` comment states it outright ("tracker_state has zero
 * write-side validation"), and `trackerAdj()`'s clamp
 * (`public/js/game/tracker.js:276`) is client-side, which is no boundary at all.
 * Stories 12.8 AC 9-9b make this a routinely PLAYER-reachable write, so Story
 * 12.7's own doctrine ("the server derives, never trusts the client") had to
 * reach it too.
 *
 * Each test is written against AC 13's own Observable: "a client-submitted
 * `vitae` OR `influence` value above its real ceiling is clamped by the server
 * regardless of what TM Game's own client sent, AND the WebSocket broadcast
 * carries the same clamped value(s) the database stores - a test bypasses the
 * client-side clamp entirely (a raw request) for each field independently and
 * confirms both the stored value and the broadcast payload are clamped, not just
 * one of them."
 *
 * Every request below IS that raw request: supertest talks to the route
 * directly, so no client-side clamp is anywhere in the path.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import 'dotenv/config';
import { ObjectId } from 'mongodb';
import { createTestApp, stUser } from './helpers/test-app.js';
import { setupDb, teardownDb } from './helpers/db-setup.js';
import { getCollection } from '../db.js';
import * as wsModule from '../ws.js';

let app;
let broadcastSpy;
const CHAR_OID = new ObjectId();
const CHAR_ID = CHAR_OID.toHexString();

// Blood Potency 2 -> `calcVitaeMax` 11 (`public/js/data/accessors.js:391-393`,
// BP_TABLE). Clan Status 2 + Invictus Covenant Status 3, no influence merits,
// no Contacts, no Mystery Cult Initiation -> `calcTotalInfluence` 5
// (`public/js/editor/domain.js:678-694`). Both figures are the real functions'
// own output for this document, not numbers chosen to make a test pass.
const VITAE_MAX = 11;
const INF_MAX = 5;

beforeAll(async () => {
  await setupDb();
  app = createTestApp();
  await getCollection('characters').deleteMany({ _id: CHAR_OID });
  await getCollection('characters').insertOne({
    _id: CHAR_OID,
    name: 'Clamp Test Character',
    retired: false,
    blood_potency: 2,
    covenant: 'Invictus',
    status: { clan: 2, covenant: { Invictus: 3 } },
    attributes: { Resolve: { dots: 2, bonus: 0 }, Composure: { dots: 2, bonus: 0 } },
    merits: [],
    _test_seeded: true,
  });
  await getCollection('tracker_state').deleteMany({ character_id: CHAR_ID });
  broadcastSpy = vi.spyOn(wsModule, 'broadcastTrackerUpdate');
});

afterAll(async () => {
  await getCollection('characters').deleteMany({ _id: CHAR_OID });
  await getCollection('tracker_state').deleteMany({ character_id: CHAR_ID });
  broadcastSpy.mockRestore();
  await teardownDb();
});

async function put(body) {
  broadcastSpy.mockClear();
  return request(app)
    .put(`/api/tracker_state/${CHAR_ID}`)
    .set('X-Test-User', stUser())
    .send(body);
}

/** The `fields` argument of the one broadcast this request made. */
function broadcastFields() {
  expect(broadcastSpy).toHaveBeenCalledTimes(1);
  return broadcastSpy.mock.calls[0][1];
}

describe('AC 13 - vitae is clamped against calcVitaeMax, stored AND broadcast', () => {
  it('clamps an over-ceiling vitae down to the real maximum', async () => {
    const res = await put({ vitae: 99 });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(VITAE_MAX);
  });

  it('broadcasts the POST-clamp vitae, not the raw request body', async () => {
    // data-lock #17: `broadcastTrackerUpdate(raw, updates)` used to send an
    // `updates` object built before any clamp ran, so the ST's own combat
    // tracker would have shown 99 while the database held 11.
    const res = await put({ vitae: 99 });
    expect(res.body.vitae).toBe(VITAE_MAX);
    expect(broadcastFields().vitae).toBe(VITAE_MAX);
  });

  it('clamps a negative vitae up to 0', async () => {
    const res = await put({ vitae: -5 });
    expect(res.body.vitae).toBe(0);
    expect(broadcastFields().vitae).toBe(0);
  });

  it('leaves a legal vitae untouched', async () => {
    const res = await put({ vitae: 4 });
    expect(res.body.vitae).toBe(4);
    expect(broadcastFields().vitae).toBe(4);
  });
});

describe('AC 13 - influence is clamped against calcTotalInfluence, stored AND broadcast', () => {
  it('clamps an over-ceiling influence down to the real maximum', async () => {
    const res = await put({ influence: 99 });
    expect(res.status).toBe(200);
    expect(res.body.influence).toBe(INF_MAX);
    expect(broadcastFields().influence).toBe(INF_MAX);
  });

  it('clamps a negative influence up to 0', async () => {
    const res = await put({ influence: -3 });
    expect(res.body.influence).toBe(0);
    expect(broadcastFields().influence).toBe(0);
  });

  it('leaves a legal influence untouched', async () => {
    const res = await put({ influence: 2 });
    expect(res.body.influence).toBe(2);
    expect(broadcastFields().influence).toBe(2);
  });
});

describe('AC 13 - both fields in one request, independently', () => {
  it('clamps each against its own ceiling and broadcasts both clamped', async () => {
    const res = await put({ vitae: 50, influence: 50 });
    expect(res.body.vitae).toBe(VITAE_MAX);
    expect(res.body.influence).toBe(INF_MAX);
    const fields = broadcastFields();
    expect(fields.vitae).toBe(VITAE_MAX);
    expect(fields.influence).toBe(INF_MAX);
  });
});

describe('AC 13 - the field whitelist', () => {
  it('refuses an unknown field rather than silently storing it', async () => {
    const res = await put({ vitae: 3, wallet_balance: 1000000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('wallet_balance');
    // And nothing was written or broadcast.
    expect(broadcastSpy).not.toHaveBeenCalled();
    const doc = await getCollection('tracker_state').findOne({ character_id: CHAR_ID });
    expect(doc.wallet_balance).toBeUndefined();
  });

  it('accepts every field the real client writes', async () => {
    // `persistedFields()` (public/js/game/tracker.js:45-55) plus `in_torpor`
    // (:173) plus the feeding idempotency marker
    // (public/js/tabs/feeding-tab.js:154).
    const res = await put({
      vitae: 2, willpower: 3, bashing: 1, lethal: 0, aggravated: 2,
      influence: 1, conditions: [], in_torpor: false,
      feeding_agg_healed_cycle_id: 'cycle-128',
    });
    expect(res.status).toBe(200);
    expect(res.body.feeding_agg_healed_cycle_id).toBe('cycle-128');
    expect(res.body.aggravated).toBe(2);
  });
});

describe('AC 13 - a character that cannot be read is not refused, only unclamped', () => {
  it('still writes when no character document exists for the id', async () => {
    // The clamp is an upper bound on a legal write, not an authorisation check
    // (`canAccess()` is that). Failing closed here would break every existing ST
    // tracker adjustment the moment a character record went missing.
    const orphanId = new ObjectId().toHexString();
    const res = await request(app)
      .put(`/api/tracker_state/${orphanId}`)
      .set('X-Test-User', stUser())
      .send({ vitae: 99 });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(99);
    await getCollection('tracker_state').deleteMany({ character_id: orphanId });
  });
});

describe('AC 13 follow-up (independent re-verification, 2026-09-11) - a present but non-numeric value is refused, never written unclamped', () => {
  it('refuses a non-numeric vitae rather than writing it through the clamp untouched', async () => {
    // Before this fix, `numOrNull("not a number")` returned null, which SKIPPED
    // the clamp entirely rather than refusing - so a non-numeric value bypassed
    // AC 13's own promise and landed in tracker_state verbatim.
    const res = await put({ vitae: 'not a number' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('vitae');
    expect(broadcastSpy).not.toHaveBeenCalled();
    const doc = await getCollection('tracker_state').findOne({ character_id: CHAR_ID });
    expect(doc.vitae).not.toBe('not a number');
  });

  it('refuses a non-numeric influence the same way', async () => {
    const res = await put({ influence: { not: 'a number' } });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('influence');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('a field the caller never sent is still untouched (not a false refusal)', async () => {
    const res = await put({ willpower: 3 });
    expect(res.status).toBe(200);
    expect(res.body.willpower).toBe(3);
  });

  it('a real numeric string still parses and clamps normally', async () => {
    const res = await put({ vitae: '99' });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(VITAE_MAX);
  });
});

describe('AC 9 follow-up (independent re-verification, 2026-09-11) - `_feedingMarkerGuard` makes a reconciliation write conditional', () => {
  const GUARD_CYCLE = 'cycle-guard-test';

  it('applies normally when the marker does not already match the guard', async () => {
    const res = await put({ vitae: 2, feeding_agg_healed_cycle_id: GUARD_CYCLE, _feedingMarkerGuard: GUARD_CYCLE });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(2);
    expect(res.body.feeding_agg_healed_cycle_id).toBe(GUARD_CYCLE);
  });

  it('the exact race this guards against: a second apply for the SAME cycle does not add its delta on top', async () => {
    // The marker set in the previous test now already equals GUARD_CYCLE. A
    // second reconciliation attempt for the same cycle (the race: two open
    // tabs, or a retry racing the original request) sends the SAME guard value.
    const before = await getCollection('tracker_state').findOne({ character_id: CHAR_ID });
    expect(before.feeding_agg_healed_cycle_id).toBe(GUARD_CYCLE);

    const res = await put({ vitae: before.vitae + 5, feeding_agg_healed_cycle_id: GUARD_CYCLE, _feedingMarkerGuard: GUARD_CYCLE });
    expect(res.status).toBe(200);
    // The guard blocked the write: the row comes back exactly as it already
    // was, NOT with the second request's +5 applied on top.
    expect(res.body.vitae).toBe(before.vitae);
    expect(broadcastSpy).not.toHaveBeenCalled();

    const after = await getCollection('tracker_state').findOne({ character_id: CHAR_ID });
    expect(after.vitae).toBe(before.vitae);
  });

  it('is never sent to the client and never stored as a real field', async () => {
    const res = await put({ vitae: 1, _feedingMarkerGuard: 'some-other-cycle' });
    expect(res.status).toBe(200);
    expect(res.body._feedingMarkerGuard).toBeUndefined();
    const doc = await getCollection('tracker_state').findOne({ character_id: CHAR_ID });
    expect(doc._feedingMarkerGuard).toBeUndefined();
  });

  it('a brand-new character with no tracker_state row yet is unguarded (nothing to race against)', async () => {
    const freshId = new ObjectId().toHexString();
    const res = await request(app)
      .put(`/api/tracker_state/${freshId}`)
      .set('X-Test-User', stUser())
      .send({ vitae: 3, feeding_agg_healed_cycle_id: GUARD_CYCLE, _feedingMarkerGuard: GUARD_CYCLE });
    expect(res.status).toBe(200);
    expect(res.body.vitae).toBe(3);
    await getCollection('tracker_state').deleteMany({ character_id: freshId });
  });
});
