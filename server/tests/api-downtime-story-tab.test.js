/**
 * API tests, GET /api/downtime_submissions/story-tab (Story storytab.1).
 *
 * A dedicated, read-only endpoint: fetches a character's TM Story-sourced downtimes
 * server-to-server, forwarding the caller's own bearer token, and adapts them into
 * this repo's own tm_game-shaped pseudo-submissions.
 *
 * Hotfix (2026-09-18, found during storytab.2 grounding): also queries this repo's own
 * `downtime_submissions` for the requested character, to drop any TM-Story-sourced
 * report whose `cycle_id` names a chapter this character already has a real tm_game
 * submission for (TM Story's Story 8.5 migration copied every pre-Game-8 downtime into
 * its own DB, and its own `/characters/:id/downtimes` returns those alongside native
 * Game 8+ cycles with no filter — confirmed live, 15/15 sampled characters showed real
 * chapter-id overlap). Most tests below still touch no Mongo document (an empty query
 * result behaves the same as "no dedup needed"); the dedup-specific tests seed and clean
 * up their own fixture rows.
 *
 * Codex external review (2026-09-18) found three real defects in that hotfix, since fixed
 * and covered by the "Codex review fixes" describe block below: the local dedup check did
 * not require the local doc to be PUBLISHED (an unpublished/draft local stub could suppress
 * a genuinely published TM-Story report), a filtered-out entry shifted the RANK of every
 * surviving entry after it (changing a stable report's synthetic chapter identity between
 * otherwise-identical requests), and a local Mongo failure had no fallback (would 500 an
 * otherwise-healthy request instead of degrading).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import 'dotenv/config';
import { ObjectId } from 'mongodb';
import { createTestApp, stUser, playerUser } from './helpers/test-app.js';
import { setupDb, teardownDb } from './helpers/db-setup.js';
import { getCollection, getClient } from '../db.js';
import * as dbModule from '../db.js';
import { attachCommandMonitor, assertNoWriteCommands } from '../lib/write-command-monitor.js';

let app;
const realFetch = globalThis.fetch;
const FIXTURE_SUB_IDS = [];

beforeAll(async () => {
  await setupDb();
  app = createTestApp();
});

afterEach(() => { globalThis.fetch = realFetch; });

afterAll(async () => {
  if (FIXTURE_SUB_IDS.length) {
    await getCollection('downtime_submissions').deleteMany({ _id: { $in: FIXTURE_SUB_IDS } });
  }
  await teardownDb();
});

describe('GET /api/downtime_submissions/story-tab', () => {
  it('returns 400 when character_id is missing', async () => {
    const res = await request(app)
      .get('/api/downtime_submissions/story-tab')
      .set('X-Test-User', playerUser(['charA']));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 403 when a player requests a character that is not their own', async () => {
    const res = await request(app)
      .get('/api/downtime_submissions/story-tab?character_id=charB')
      .set('X-Test-User', playerUser(['charA']));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('never calls TM Story at all for a rejected (403) request, read-only means read-only, not "fetch then discard"', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ downtimes: [] }) }; };
    await request(app)
      .get('/api/downtime_submissions/story-tab?character_id=charB')
      .set('X-Test-User', playerUser(['charA']));
    expect(called).toBe(false);
  });

  it('forwards the caller\'s own Authorization header verbatim to TM Story, for their own character', async () => {
    let capturedUrl = null, capturedAuth = null;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedAuth = opts.headers.Authorization;
      return { ok: true, json: async () => ({ downtimes: [] }) };
    };
    const res = await request(app)
      .get('/api/downtime_submissions/story-tab?character_id=charA')
      .set('X-Test-User', playerUser(['charA']))
      .set('Authorization', 'Bearer real-player-token-xyz');
    expect(res.status).toBe(200);
    expect(capturedUrl).toMatch(/\/api\/characters\/charA\/downtimes$/);
    expect(capturedAuth).toBe('Bearer real-player-token-xyz');
  });

  it('adapts a real TM Story report into a merged { downtimes, chapters } response, most-recent first', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        downtimes: [
          { cycle_id: 'cyc-newer', narrative: 'The newer cycle.' },
          { cycle_id: 'cyc-older', narrative: 'The older cycle.' },
        ],
      }),
    });
    const res = await request(app)
      .get('/api/downtime_submissions/story-tab?character_id=charA')
      .set('X-Test-User', playerUser(['charA']))
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.downtimes).toHaveLength(2);
    expect(res.body.chapters).toHaveLength(2);
    expect(res.body.downtimes[0].published_outcome).toBe('The newer cycle.');
    expect(res.body.downtimes[1].published_outcome).toBe('The older cycle.');
    // AC 6's ruled block rule: TM Story's own already-correct order survives as a
    // strictly-decreasing synthetic game_number, so the EXISTING client-side
    // game_number-descending sort places these in the same order untouched.
    const chapterMap = Object.fromEntries(res.body.chapters.map(c => [c._id, c]));
    expect(chapterMap[res.body.downtimes[0].chapter_id].game_number)
      .toBeGreaterThan(chapterMap[res.body.downtimes[1].chapter_id].game_number);
  });

  it('an ST may request any character\'s story-tab data (bypasses the ownership check on THIS side)', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ downtimes: [] }) });
    const res = await request(app)
      .get('/api/downtime_submissions/story-tab?character_id=someone-elses-char')
      .set('X-Test-User', stUser())
      .set('Authorization', 'Bearer st-tok');
    expect(res.status).toBe(200);
  });

  it('degrades gracefully to an empty merged result when TM Story is unreachable (AC 3, never a 500, never a leak of TM Story\'s raw error)', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED 10.0.0.1:443'); };
    const res = await request(app)
      .get('/api/downtime_submissions/story-tab?character_id=charA')
      .set('X-Test-User', playerUser(['charA']))
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ downtimes: [], chapters: [] });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });

  it('degrades gracefully when TM Story 403s the caller on its own side (e.g. previewing a character this bearer token does not own there)', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    const res = await request(app)
      .get('/api/downtime_submissions/story-tab?character_id=charA')
      .set('X-Test-User', playerUser(['charA']))
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ downtimes: [], chapters: [] });
  });

  describe('dedup against a real tm_game submission (2026-09-18 hotfix)', () => {
    it('drops a TM-Story-sourced report whose cycle_id names a chapter this character already has a real tm_game submission for', async () => {
      const existingChapterId = new ObjectId();
      const inserted = await getCollection('downtime_submissions').insertOne({
        character_id: 'charA',
        chapter_id: existingChapterId,
        published_outcome: 'The original tm_game copy.',
      });
      FIXTURE_SUB_IDS.push(inserted.insertedId);

      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          downtimes: [
            { cycle_id: existingChapterId.toHexString(), narrative: 'Migrated duplicate of the same game.' },
            { cycle_id: 'cyc-genuinely-new', narrative: 'A genuinely new TM Story-native cycle.' },
          ],
        }),
      });
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charA')
        .set('X-Test-User', playerUser(['charA']))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      expect(res.body.downtimes).toHaveLength(1);
      expect(res.body.downtimes[0].published_outcome).toBe('A genuinely new TM Story-native cycle.');
    });

    it('keeps a TM-Story-sourced report for a different character sharing no chapter overlap with charA\'s fixture', async () => {
      const otherChapterId = new ObjectId();
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          downtimes: [{ cycle_id: otherChapterId.toHexString(), narrative: 'Not overlapping.' }],
        }),
      });
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charB')
        .set('X-Test-User', playerUser(['charB']))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      expect(res.body.downtimes).toHaveLength(1);
    });
  });

  describe('Codex review fixes (2026-09-18)', () => {
    it('does NOT suppress a published TM-Story report when the matching local doc is unpublished (a draft/incomplete stub)', async () => {
      const draftChapterId = new ObjectId();
      const inserted = await getCollection('downtime_submissions').insertOne({
        character_id: 'charC',
        chapter_id: draftChapterId,
        status: 'draft',
        // No published_outcome, no st_review.outcome_visibility: 'published' —
        // this local row would render NOTHING on its own.
      });
      FIXTURE_SUB_IDS.push(inserted.insertedId);

      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          downtimes: [{ cycle_id: draftChapterId.toHexString(), narrative: 'The genuinely published TM Story copy.' }],
        }),
      });
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charC')
        .set('X-Test-User', playerUser(['charC']))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      expect(res.body.downtimes).toHaveLength(1);
      expect(res.body.downtimes[0].published_outcome).toBe('The genuinely published TM Story copy.');
    });

    it('still suppresses when the local doc is published via st_review.outcome_visibility rather than a top-level published_outcome', async () => {
      const chapterId = new ObjectId();
      const inserted = await getCollection('downtime_submissions').insertOne({
        character_id: 'charD',
        chapter_id: chapterId,
        st_review: { outcome_visibility: 'published', outcome_text: 'Published via st_review only.' },
      });
      FIXTURE_SUB_IDS.push(inserted.insertedId);

      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ downtimes: [{ cycle_id: chapterId.toHexString(), narrative: 'Migrated duplicate.' }] }),
      });
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charD')
        .set('X-Test-User', playerUser(['charD']))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      expect(res.body.downtimes).toHaveLength(0);
    });

    it('preserves each surviving report\'s ORIGINAL TM Story rank, not its post-filter array position', async () => {
      const overlapChapterId = new ObjectId();
      const inserted = await getCollection('downtime_submissions').insertOne({
        character_id: 'charE',
        chapter_id: overlapChapterId,
        published_outcome: 'Local copy of the overlapping chapter.',
      });
      FIXTURE_SUB_IDS.push(inserted.insertedId);

      // TM Story's own order: [overlapping (rank 0), surviving (rank 1)]. If the route
      // reindexed the post-filter array, the surviving entry would wrongly become rank 0.
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          downtimes: [
            { cycle_id: overlapChapterId.toHexString(), narrative: 'Dropped, duplicate.' },
            { cycle_id: 'cyc-surviving', narrative: 'Surviving, must keep rank 1.' },
          ],
        }),
      });
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charE')
        .set('X-Test-User', playerUser(['charE']))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      expect(res.body.downtimes).toHaveLength(1);
      // The adapter's synthetic chapter_id embeds rankFromNewest verbatim
      // (`storytab.1:<characterId>:<rankFromNewest>`) — asserting on it directly proves
      // the ORIGINAL index 1 survived, not a reindexed 0.
      expect(res.body.downtimes[0].chapter_id).toBe('storytab.1:charE:1');
    });

    it('degrades gracefully (fail-open: treats it as no local coverage) when the local dedup lookup itself fails, rather than 500ing', async () => {
      const gcSpy = vi.spyOn(dbModule, 'getCollection').mockImplementation((name) => {
        if (name !== 'downtime_submissions') return getCollection(name);
        return { find: () => ({ toArray: () => Promise.reject(new Error('simulated local Mongo failure')) }) };
      });
      try {
        globalThis.fetch = async () => ({
          ok: true,
          json: async () => ({ downtimes: [{ cycle_id: 'cyc-whatever', narrative: 'Still shown despite the local failure.' }] }),
        });
        const res = await request(app)
          .get('/api/downtime_submissions/story-tab?character_id=charF')
          .set('X-Test-User', playerUser(['charF']))
          .set('Authorization', 'Bearer tok');
        expect(res.status).toBe(200);
        expect(res.body.downtimes).toHaveLength(1);
        expect(res.body.downtimes[0].published_outcome).toBe('Still shown despite the local failure.');
      } finally {
        gcSpy.mockRestore();
      }
    });

    it('rejects a repeated (array-shaped) character_id query parameter with 400 rather than proceeding with a malformed value', async () => {
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charA&character_id=charB')
        .set('X-Test-User', playerUser(['charA']));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    // Codex review (Pass 2, Low): every other test in this file uses a non-ObjectId-shaped
    // character_id ('charA' etc.), which only ever exercises the `character_id: characterId`
    // (bare string) branch of the new query. A real character_id is a 24-hex ObjectId, which
    // takes the OTHER branch (`character_id: { $in: [ObjectId, string] }`) — untested until now.
    // Also covers the legacy `cycle_id`-only local Chapter FK (pre-cm-2b documents), the other
    // half of `readChapterFk`'s dual-read fallback this dedup depends on.
    it('dedups correctly for a real ObjectId-shaped character_id, against a local doc using the LEGACY cycle_id field (pre-cm-2b shape)', async () => {
      const realCharId = new ObjectId();
      const legacyChapterId = new ObjectId();
      const inserted = await getCollection('downtime_submissions').insertOne({
        character_id: realCharId,
        cycle_id: legacyChapterId, // legacy FK name, no chapter_id at all
        published_outcome: 'Local copy under the pre-cm-2b field name.',
      });
      FIXTURE_SUB_IDS.push(inserted.insertedId);

      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          downtimes: [{ cycle_id: legacyChapterId.toHexString(), narrative: 'Migrated duplicate.' }],
        }),
      });
      const res = await request(app)
        .get(`/api/downtime_submissions/story-tab?character_id=${realCharId.toHexString()}`)
        .set('X-Test-User', playerUser([realCharId.toHexString()]))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      expect(res.body.downtimes).toHaveLength(0);
    });
  });

  describe('Story storytab.3: leak-gate test coverage', () => {
    // AC 2: the forwarded bearer token must be THIS REQUEST's own Authorization header,
    // not a value that merely happens to match one fixed string across every test above.
    // Two distinct requests, two distinct tokens, each forwarded token must track its own
    // request rather than being hardcoded anywhere on the path from inbound to outbound.
    it('forwards a DIFFERENT caller\'s own Authorization header on a different request, proving the value tracks the inbound request rather than a fixed string', async () => {
      const captured = [];
      globalThis.fetch = async (url, opts) => {
        captured.push(opts.headers.Authorization);
        return { ok: true, json: async () => ({ downtimes: [] }) };
      };
      await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charA')
        .set('X-Test-User', playerUser(['charA']))
        .set('Authorization', 'Bearer token-one');
      await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charA')
        .set('X-Test-User', playerUser(['charA']))
        .set('Authorization', 'Bearer token-two');
      expect(captured).toEqual(['Bearer token-one', 'Bearer token-two']);
    });

    // AC 3: a TM-Story-side auth failure must degrade to "no entries shown", never a
    // second attempt with different or absent credentials. The existing "degrades
    // gracefully" tests only assert the RESPONSE shape; these assert the CALL COUNT,
    // which is the part that would actually catch a retry-on-failure regression.
    it('calls TM Story exactly once on a network failure — never retries without auth or with different credentials', async () => {
      let callCount = 0;
      globalThis.fetch = async () => { callCount += 1; throw new Error('ECONNREFUSED'); };
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charA')
        .set('X-Test-User', playerUser(['charA']))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      expect(callCount).toBe(1);
    });

    it('calls TM Story exactly once on TM Story\'s own 403 — never retries with a different identity', async () => {
      let callCount = 0;
      globalThis.fetch = async () => { callCount += 1; return { ok: false, status: 403 }; };
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charA')
        .set('X-Test-User', playerUser(['charA']))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      expect(callCount).toBe(1);
    });

    // AC 4: the merged response sent to the browser must be a pure consumer of whatever
    // TM Story's own allowlist returned — never a wider passthrough. adaptStoryReport()
    // builds its output from named fields only (unit-tested directly in
    // story-downtime-fetch.test.js), so this is the black-box confirmation at the wire:
    // an unexpected field on TM Story's response body must never reach the browser.
    it('never forwards a field on TM Story\'s report that its own adapter does not explicitly name, even one shaped like a leaked private note', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          downtimes: [{
            cycle_id: 'cyc-1',
            narrative: 'The public narrative.',
            _internal_st_note: 'SHOULD-NEVER-LEAK: another player\'s private ST note',
            owner_email: 'SHOULD-NEVER-LEAK@example.com',
            raw_mongo_doc: { anything: 'SHOULD-NEVER-LEAK' },
          }],
        }),
      });
      const res = await request(app)
        .get('/api/downtime_submissions/story-tab?character_id=charA')
        .set('X-Test-User', playerUser(['charA']))
        .set('Authorization', 'Bearer tok');
      expect(res.status).toBe(200);
      const wire = JSON.stringify(res.body);
      expect(wire).not.toMatch(/SHOULD-NEVER-LEAK/);
      expect(res.body.downtimes[0]).not.toHaveProperty('_internal_st_note');
      expect(res.body.downtimes[0]).not.toHaveProperty('owner_email');
      expect(res.body.downtimes[0]).not.toHaveProperty('raw_mongo_doc');
    });
  });

  describe('Story storytab.4: read-only / no-write-back guard (AC 2)', () => {
    // AC 2: exercises the FULL fetch-and-render path (TM Story mocked, the real local
    // dedup Mongo query included) with a live commandStarted monitor attached to the
    // real shared test client, and asserts zero write commands were issued anywhere on
    // `tm_game` during it. Complements the lexical guard (storytab4-readonly-guard.test.js
    // scans the SOURCE); this watches the WIRE.
    it('issues no write command against Mongo while serving a full fetch + local-dedup + response cycle', async () => {
      const { commands, detach } = attachCommandMonitor(getClient());
      try {
        globalThis.fetch = async () => ({
          ok: true,
          json: async () => ({
            downtimes: [
              { cycle_id: 'cyc-guard-1', narrative: 'Guard-path exercise, newer.' },
              { cycle_id: 'cyc-guard-2', narrative: 'Guard-path exercise, older.' },
            ],
          }),
        });
        const res = await request(app)
          .get('/api/downtime_submissions/story-tab?character_id=charGuard')
          .set('X-Test-User', playerUser(['charGuard']))
          .set('Authorization', 'Bearer tok');
        expect(res.status).toBe(200);
        expect(res.body.downtimes).toHaveLength(2);
      } finally {
        detach();
      }
      // Not a vacuous pass: the local dedup lookup issues a real `find`, so the monitor
      // must have recorded SOMETHING — confirming it was actually live for this request,
      // not attached-but-silent because monitorCommands somehow never fired.
      expect(commands.length).toBeGreaterThan(0);
      expect(() => assertNoWriteCommands(commands)).not.toThrow();
    });

    // Discrimination: proves the assertion above is a real guard and not vacuously
    // green because the monitor never actually observes anything — same principle as
    // write-command-monitor.test.js's own self-test, but against the REAL client this
    // story wires monitorCommands:true onto (server/db.js).
    it('(discrimination) the live monitor DOES catch a real write on the same client, proving the guard above is not vacuous', async () => {
      const { commands, detach } = attachCommandMonitor(getClient());
      let insertedId;
      try {
        const result = await getCollection('downtime_submissions').insertOne({
          character_id: 'charGuardDiscrimination',
          _test_seeded: true,
          _purpose: 'storytab.4 AC2 discrimination proof — deleted immediately below',
        });
        insertedId = result.insertedId;
        expect(commands).toContain('insert');
        expect(() => assertNoWriteCommands(commands)).toThrow(/insert/);
      } finally {
        detach();
        if (insertedId) await getCollection('downtime_submissions').deleteOne({ _id: insertedId });
      }
    });
  });
});
