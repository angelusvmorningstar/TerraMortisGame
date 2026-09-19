/**
 * 2026-08-15 (live, recurring incident) — reconcileInfluenceDT() used to key off "the last CLOSED
 * cycle" instead of the cycle actually governing tonight's game, so it kept pulling a stale
 * cycle's Influence spend forward over whatever was correct. Two live symptoms: Brandy LaRoux
 * (spent 0 in DT6) briefly showed 13/20 — infMax(20) minus a closed Game 4's spend(7) — and Conrad
 * Sondergaard (also spent 0 in DT6) was left stuck at 0/7 by the same formula. Fixed to resolve
 * through getFeedingCycle() (db.js) instead, and to write every active character on each run
 * (not just spenders — a zero-spend character needs restoring to full max too, which the old
 * `spent === 0` skip could never do).
 *
 * 2026-09-19 (live, confirmed via Game 8/Game 9 tracker audit) — a SECOND, more severe bug: real
 * submissions have lived in tm_story since Game 8, but the function still read this repo's own
 * (retired, zero-row-since-Game-7) `tm_game.downtime_submissions`, so `infSpent` was always empty
 * and every character was silently reset to full max on every tracker load. Fixed to read each
 * character's declared spend from TM Story's own cross-app route (`fetchStoryFeeding`,
 * `public/js/data/story-feeding.js`, the same read the Feeding tab already relies on) instead.
 * This suite's mocks were updated to drive that route rather than the retired
 * `/api/downtime_submissions?chapter_id=` shape — `/api/downtime_submissions` is still mocked
 * because `getFeedingCycle()` itself (cycle SELECTION, unrelated to spend) still calls it.
 *
 * This suite mocks fetch and drives reconcileInfluenceDT() directly (exported for this purpose),
 * asserting on the PUT bodies sent to /api/tracker_state/:id rather than on real Mongo state.
 */
import { describe, it, expect, beforeEach } from 'vitest';

async function importTracker({ cycles, subsByCycleId, storySpendByKey = {}, trackerByCharId }) {
  globalThis.location = { origin: 'http://localhost', hostname: 'localhost', href: 'http://localhost/' };
  globalThis.localStorage = {
    getItem: (k) => (k === 'tm_auth_token' ? 'stub-token' : null),
    setItem: () => {},
    removeItem: () => {},
  };
  globalThis.window = globalThis;

  const puts = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (opts?.method === 'PUT' && u.includes('/api/tracker_state/')) {
      const charId = u.split('/api/tracker_state/')[1];
      puts.push({ charId, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.includes('/api/tracker_state/')) {
      const charId = u.split('/api/tracker_state/')[1];
      return { ok: true, status: 200, json: async () => (trackerByCharId[charId] || null) };
    }
    // TM Story's cross-app read (Story 12.3): /api/wiki/v1/downtime/submissions/:charId/:cycleId/feeding
    const storyMatch = u.match(/\/api\/wiki\/v1\/downtime\/submissions\/([^/]+)\/([^/]+)\/feeding$/);
    if (storyMatch) {
      const [, rawCharId, rawCycleId] = storyMatch;
      const key = `${decodeURIComponent(rawCharId)}:${decodeURIComponent(rawCycleId)}`;
      const territoryInfluence = storySpendByKey[key];
      if (territoryInfluence === undefined) {
        return { ok: false, status: 404, json: async () => ({ error: 'not_found', message: 'No submission for this character and cycle' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ feeding: null, territory_influence: territoryInfluence, lifecycle_state: 'draft', status: null }),
      };
    }
    // getFeedingCycle()'s own cycle-SELECTION check (unrelated to reconcile spend since the
    // 2026-09-19 fix) — content is irrelevant now, only whether the array is non-empty.
    if (u.includes('/api/downtime_submissions')) {
      const m = u.match(/chapter_id=([^&]+)/);
      const cid = m ? decodeURIComponent(m[1]) : null;
      return { ok: true, status: 200, json: async () => (subsByCycleId[cid] || []) };
    }
    if (u.includes('/api/chapters')) {
      return { ok: true, status: 200, json: async () => cycles };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const trackerMod = await import('../../public/js/game/tracker.js');
  const stateMod = await import('../../public/js/suite/data.js');
  return { trackerMod, suiteState: stateMod.default, puts };
}

// infMax comes purely from status.clan here — no merit-calc plumbing needed for these cases.
function fakeChar(id, clanStatus) {
  return { _id: id, retired: false, status: { clan: clanStatus }, merits: [] };
}

describe('gdx-8 — reconcileInfluenceDT keys off the live cycle, not the last closed one', () => {
  it('a zero-spend character in the live cycle is written to full max, not a stale closed-cycle number', async () => {
    // Cycle ids are unique per test — reconcileInfluenceDT's own _reconciledCycles guard is
    // module-level and persists across dynamic imports of the same specifier in this file.
    const dt6 = { _id: 'dt6-t1', game_number: 6, phase: 'prep' };
    const game4closed = { _id: 'game4-t1', game_number: 4, status: 'closed' };
    const brandy = fakeChar('brandy', 20);

    const { trackerMod, suiteState, puts } = await importTracker({
      cycles: [game4closed, dt6],
      // Only needed to make getFeedingCycle() select dt6 over the closed cycle.
      subsByCycleId: { 'dt6-t1': [{ character_id: 'brandy' }] },
      storySpendByKey: { 'brandy:dt6-t1': { spends: [] } },
      trackerByCharId: { brandy: { influence: 13 } }, // the wrong number the incident showed
    });
    suiteState.chars = [brandy];

    await trackerMod.ensureLoaded(brandy);
    expect(trackerMod.trackerRead('brandy').inf).toBe(13); // seeded wrong, as observed live

    await trackerMod.reconcileInfluenceDT();

    const write = puts.find((p) => p.charId === 'brandy');
    expect(write.body.influence).toBe(20); // infMax(20) - DT6 spend(0), not infMax - Game4 spend(7)=13
  });

  it('a character stuck at a wrong value from a prior bad reconcile is restored, not skipped', async () => {
    const dt6 = { _id: 'dt6-t2', game_number: 6, phase: 'prep' };
    const conrad = fakeChar('conrad', 7);

    const { trackerMod, suiteState, puts } = await importTracker({
      cycles: [dt6],
      subsByCycleId: { 'dt6-t2': [{ character_id: 'conrad' }] },
      storySpendByKey: { 'conrad:dt6-t2': { spends: [] } },
      trackerByCharId: { conrad: { influence: 0 } }, // the incident's actual stuck DB value
    });
    suiteState.chars = [conrad];

    await trackerMod.ensureLoaded(conrad);
    await trackerMod.reconcileInfluenceDT();

    const write = puts.find((p) => p.charId === 'conrad');
    expect(write.body.influence).toBe(7); // restored to full max — old `spent === 0` skip left this at 0 forever
  });

  it('a character who genuinely spent in the live cycle still gets max minus that spend', async () => {
    const dt6 = { _id: 'dt6-t3', game_number: 6, phase: 'prep' };
    const spender = fakeChar('spender', 10);

    const { trackerMod, suiteState, puts } = await importTracker({
      cycles: [dt6],
      subsByCycleId: { 'dt6-t3': [{ character_id: 'spender' }] },
      storySpendByKey: {
        'spender:dt6-t3': { spends: [{ territory: { id: 'a', label: 'A' }, amount: 4 }] },
      },
      trackerByCharId: { spender: { influence: 10 } },
    });
    suiteState.chars = [spender];

    await trackerMod.ensureLoaded(spender);
    await trackerMod.reconcileInfluenceDT();

    const write = puts.find((p) => p.charId === 'spender');
    expect(write.body.influence).toBe(6); // 10 - 4
  });

  it('no feeding-open cycle at all: reconcile is a no-op (no writes)', async () => {
    const closedOnly = { _id: 'g1', game_number: 1, status: 'closed' };
    const char = fakeChar('someone', 10);

    const { trackerMod, suiteState, puts } = await importTracker({
      cycles: [closedOnly],
      subsByCycleId: {},
      trackerByCharId: { someone: { influence: 10 } },
    });
    suiteState.chars = [char];

    await trackerMod.ensureLoaded(char);
    await trackerMod.reconcileInfluenceDT();

    expect(puts.length).toBe(0);
  });

  it("2026-09-19 fix: a legacy tm_game influence_spend row on the same cycle is ignored — only TM Story's territory_influence counts", async () => {
    const dt9 = { _id: 'dt9-t5', game_number: 9, phase: 'prep' };
    const legacy = fakeChar('legacy', 10);

    const { trackerMod, suiteState, puts } = await importTracker({
      cycles: [dt9],
      // A stale/leftover tm_game.downtime_submissions row claiming a spend of 9 — must be
      // ignored entirely now; only TM Story's own data may drive the written value.
      subsByCycleId: {
        'dt9-t5': [{ character_id: 'legacy', responses: { influence_spend: JSON.stringify({ a: 9 }) } }],
      },
      storySpendByKey: { 'legacy:dt9-t5': { spends: [{ territory: { id: 'a', label: 'A' }, amount: 3 }] } },
      trackerByCharId: { legacy: { influence: 10 } },
    });
    suiteState.chars = [legacy];

    await trackerMod.ensureLoaded(legacy);
    await trackerMod.reconcileInfluenceDT();

    const write = puts.find((p) => p.charId === 'legacy');
    expect(write.body.influence).toBe(7); // 10 - TM Story's 3, NOT 10 - the legacy row's 9 = 1
  });

  it('2026-09-19 fix: no submission for this cycle yet (404 from TM Story) reads as zero spend, full max', async () => {
    const dt9 = { _id: 'dt9-t6', game_number: 9, phase: 'prep' };
    const freshChar = fakeChar('fresh', 15);

    const { trackerMod, suiteState, puts } = await importTracker({
      cycles: [dt9],
      subsByCycleId: { 'dt9-t6': [{ character_id: 'fresh' }] },
      storySpendByKey: {}, // no entry -> the mock's fetch returns a 404, as TM Story really does
      trackerByCharId: { fresh: { influence: 15 } },
    });
    suiteState.chars = [freshChar];

    await trackerMod.ensureLoaded(freshChar);
    await trackerMod.reconcileInfluenceDT();

    const write = puts.find((p) => p.charId === 'fresh');
    expect(write.body.influence).toBe(15);
  });

  it('2026-09-19 fix: multiple declared spends across territories sum correctly', async () => {
    const dt9 = { _id: 'dt9-t7', game_number: 9, phase: 'prep' };
    const multi = fakeChar('multi', 20);

    const { trackerMod, suiteState, puts } = await importTracker({
      cycles: [dt9],
      subsByCycleId: { 'dt9-t7': [{ character_id: 'multi' }] },
      storySpendByKey: {
        'multi:dt9-t7': {
          spends: [
            { territory: { id: 'a', label: 'A' }, amount: 2 },
            { territory: { id: 'b', label: 'B' }, amount: -5 }, // sign is the effect's direction; reconcile sums magnitude spent
          ],
        },
      },
      trackerByCharId: { multi: { influence: 20 } },
    });
    suiteState.chars = [multi];

    await trackerMod.ensureLoaded(multi);
    await trackerMod.reconcileInfluenceDT();

    const write = puts.find((p) => p.charId === 'multi');
    expect(write.body.influence).toBe(13); // 20 - (2 + 5)
  });
});
