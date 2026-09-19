/**
 * Story storytab.1, unit tests for server/lib/story-downtime-fetch.js.
 *
 * Pure functions + one mocked outbound fetch, no DB, no app, no supertest. The route-
 * level integration (auth/ownership, the merged HTTP response shape) lives in
 * server/tests/api-downtime-story-tab.test.js.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { fetchStoryDowntimes, adaptStoryReport, syntheticChapterFor } from '../lib/story-downtime-fetch.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('fetchStoryDowntimes', () => {
  it('makes no network call and reports failure when authorization is missing', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ downtimes: [] }) }; };
    const result = await fetchStoryDowntimes({ authorization: undefined, characterId: 'charA' });
    expect(called).toBe(false);
    expect(result).toEqual({ ok: false, downtimes: [] });
  });

  it('makes no network call and reports failure when characterId is missing', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ downtimes: [] }) }; };
    const result = await fetchStoryDowntimes({ authorization: 'Bearer tok', characterId: undefined });
    expect(called).toBe(false);
    expect(result).toEqual({ ok: false, downtimes: [] });
  });

  it('forwards the caller\'s own Authorization header verbatim and hits the right character URL', async () => {
    let capturedUrl = null, capturedHeaders = null;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({ downtimes: [{ cycle_id: 'cyc-1' }] }) };
    };
    const result = await fetchStoryDowntimes({ authorization: 'Bearer real-player-token', characterId: 'charA' });
    expect(capturedUrl).toMatch(/\/api\/characters\/charA\/downtimes$/);
    expect(capturedHeaders).toEqual({ Authorization: 'Bearer real-player-token' });
    expect(result).toEqual({ ok: true, downtimes: [{ cycle_id: 'cyc-1' }] });
  });

  // Story storytab.4, AC 3: the cheapest possible guard — the outbound call itself must
  // be a bodyless GET, never a write-shaped verb, regardless of what the Mongo-level
  // guard (write-command-monitor.js) can or can't prove.
  it('Story storytab.4 AC 3: issues a GET with no request body (no method override, no body key at all)', async () => {
    let capturedOpts = null;
    globalThis.fetch = async (url, opts) => {
      capturedOpts = opts;
      return { ok: true, json: async () => ({ downtimes: [] }) };
    };
    await fetchStoryDowntimes({ authorization: 'Bearer x', characterId: 'charA' });
    expect(capturedOpts).not.toBeNull();
    // No explicit method means the platform default, GET — asserting it is undefined
    // (rather than just "not POST") catches a future edit adding ANY override, not only
    // the obviously-wrong ones.
    expect(capturedOpts.method).toBeUndefined();
    expect(capturedOpts).not.toHaveProperty('body');
  });

  it('reads the base URL from TM_STORY_API_URL when set', async () => {
    const prev = process.env.TM_STORY_API_URL;
    process.env.TM_STORY_API_URL = 'https://tm-story-api.example.test';
    let capturedUrl = null;
    globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({ downtimes: [] }) }; };
    try {
      await fetchStoryDowntimes({ authorization: 'Bearer x', characterId: 'charA' });
      expect(capturedUrl).toBe('https://tm-story-api.example.test/api/characters/charA/downtimes');
    } finally {
      if (prev === undefined) delete process.env.TM_STORY_API_URL; else process.env.TM_STORY_API_URL = prev;
    }
  });

  it('degrades gracefully (never throws) on a network failure', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const result = await fetchStoryDowntimes({ authorization: 'Bearer x', characterId: 'charA' });
    expect(result).toEqual({ ok: false, downtimes: [] });
  });

  it('degrades gracefully on a non-2xx response (e.g. a 403 from TM Story\'s own ownership gate)', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    const result = await fetchStoryDowntimes({ authorization: 'Bearer x', characterId: 'charA' });
    expect(result).toEqual({ ok: false, downtimes: [] });
  });

  it('degrades gracefully on a malformed (non-JSON) body', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } });
    const result = await fetchStoryDowntimes({ authorization: 'Bearer x', characterId: 'charA' });
    expect(result).toEqual({ ok: false, downtimes: [] });
  });

  it('defaults downtimes to [] when the body carries no array (still ok: true, an honest empty state)', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    const result = await fetchStoryDowntimes({ authorization: 'Bearer x', characterId: 'charA' });
    expect(result).toEqual({ ok: true, downtimes: [] });
  });
});

describe('adaptStoryReport', () => {
  const RICH_REPORT = {
    cycle_id: 'cyc-pub',
    narrative: 'Ambrose consolidated his holdings.',
    projects: [{ slot: 1, action: 'investigate', title: 'Track the Ordo cell', description: 'Follow the courier', outcome: 'Found the safehouse' }],
    projects_resolved: [{ action_type: 'investigate', outcome: 'Located it', outcome_confirmed: true, outcome_summary: 'Tracked to the safehouse.', pool_status: 'ok', slot: 1 }],
    merit_actions_resolved: [{ action_type: 'status', player_facing_note: 'Your standing rose.', outcome_summary: 'Standing rose.', pool_status: 'ok', slot: 1 }],
    story_moment: 'The habit is older than you.',
    home_report: 'The Docklands are quiet.',
    cacophony_savvy: [{ slot: 1, response: 'The Prince dines alone.' }],
  };

  it('maps declared project slots onto flat responses.project_{n}_title/_action (the shape renderOutcomeWithCards reads)', () => {
    const sub = adaptStoryReport(RICH_REPORT, 'charA', 0);
    expect(sub.responses.project_1_title).toBe('Track the Ordo cell');
    expect(sub.responses.project_1_action).toBe('investigate');
  });

  // tm-admin.21.1 follow-up: the card schema's ruled `Desired Outcome:`/`Approach:` lines read
  // `project_{n}_outcome`/`project_{n}_description`. Mapping only title/action left those two
  // lines blank on every TM-Story-sourced cycle (Game 8 onward), while Games 2-7 rendered fine.
  it('maps TM Story\'s declared outcome/description onto project_{n}_outcome/_description (the ruled Desired Outcome/Approach lines)', () => {
    const sub = adaptStoryReport(RICH_REPORT, 'charA', 0);
    expect(sub.responses.project_1_outcome).toBe('Found the safehouse');
    expect(sub.responses.project_1_description).toBe('Follow the courier');
  });

  it('keeps each declared key on its own slot number, never collapsing multi-project reports onto one', () => {
    const sub = adaptStoryReport({
      cycle_id: 'cyc-multi',
      projects: [
        { slot: 1, title: 'First', description: 'First approach', outcome: 'First aim' },
        { slot: 3, title: 'Third', description: 'Third approach', outcome: 'Third aim' },
      ],
    }, 'charA', 0);
    expect(sub.responses.project_1_outcome).toBe('First aim');
    expect(sub.responses.project_1_description).toBe('First approach');
    expect(sub.responses.project_3_outcome).toBe('Third aim');
    expect(sub.responses.project_3_description).toBe('Third approach');
    expect(sub.responses).not.toHaveProperty('project_2_outcome');
    expect(sub.responses).not.toHaveProperty('project_2_description');
  });

  it('omits a declared key entirely when TM Story\'s own filled() gate left that field off the slot, never a blank value', () => {
    const sub = adaptStoryReport({
      cycle_id: 'cyc-partial',
      projects: [{ slot: 1, action: 'investigate', title: 'Track the Ordo cell', description: 'Follow the courier' }],
    }, 'charA', 0);
    expect(sub.responses.project_1_description).toBe('Follow the courier');
    expect(sub.responses).not.toHaveProperty('project_1_outcome');
  });

  it('maps narrative -> published_outcome, and carries resolved-action arrays through unchanged (already allowlisted upstream by TM Story\'s own 74.1)', () => {
    const sub = adaptStoryReport(RICH_REPORT, 'charA', 0);
    expect(sub.published_outcome).toBe('Ambrose consolidated his holdings.');
    expect(sub.projects_resolved).toEqual(RICH_REPORT.projects_resolved);
    expect(sub.merit_actions_resolved).toEqual(RICH_REPORT.merit_actions_resolved);
  });

  it('re-nests story_moment/home_report as {response} under st_narrative, and carries cacophony_savvy through', () => {
    const sub = adaptStoryReport(RICH_REPORT, 'charA', 0);
    expect(sub.st_narrative.story_moment).toEqual({ response: 'The habit is older than you.' });
    expect(sub.st_narrative.home_report).toEqual({ response: 'The Docklands are quiet.' });
    expect(sub.st_narrative.cacophony_savvy).toEqual([{ slot: 1, response: 'The Prince dines alone.' }]);
  });

  it('omits story_moment/home_report entirely (not a blank key) when TM Story\'s report has none, or a non-string value', () => {
    const bare = adaptStoryReport({ cycle_id: 'cyc-x' }, 'charA', 0);
    expect(bare.st_narrative.story_moment).toBeUndefined();
    expect(bare.st_narrative.home_report).toBeUndefined();
    const malformed = adaptStoryReport({ cycle_id: 'cyc-x', story_moment: { nested: 'x' } }, 'charA', 0);
    expect(malformed.st_narrative.story_moment).toBeUndefined();
  });

  it('mints a synthetic, clearly-namespaced _id and chapter_id, never a value that could collide with a real ObjectId', () => {
    const sub = adaptStoryReport(RICH_REPORT, 'charA', 2);
    expect(sub._id).toBe('story:charA:cyc-pub');
    expect(sub.chapter_id).toBe('storytab.1:charA:2');
    expect(sub._tm_story_sourced).toBe(true);
  });

  it('degrades to empty arrays/object when TM Story\'s report is missing an optional field entirely', () => {
    const sub = adaptStoryReport({ cycle_id: 'cyc-empty' }, 'charA', 0);
    expect(sub.responses).toEqual({});
    expect(sub.projects_resolved).toEqual([]);
    expect(sub.merit_actions_resolved).toEqual([]);
    expect(sub.st_narrative.cacophony_savvy).toEqual([]);
    expect(sub.published_outcome).toBe('');
  });

  // Story storytab.3, AC 4: this adapter is the ONLY thing standing between TM Story's raw
  // response body and the browser — it must be a strict allowlist (named fields copied out
  // one at a time), never a spread/passthrough of whatever TM Story happened to send. An
  // unexpected field (e.g. a bug on TM Story's own side leaking another player's data into
  // this report) must not survive the adapter.
  it('drops any field on the report that is not one of its own explicitly-named fields', () => {
    const sub = adaptStoryReport({
      ...RICH_REPORT,
      _internal_st_note: 'another player\'s private note',
      owner_email: 'someone@example.com',
      raw_mongo_doc: { secret: true },
    }, 'charA', 0);
    expect(sub).not.toHaveProperty('_internal_st_note');
    expect(sub).not.toHaveProperty('owner_email');
    expect(sub).not.toHaveProperty('raw_mongo_doc');
    expect(JSON.stringify(sub)).not.toMatch(/private note|example\.com|secret/);
  });
});

describe('syntheticChapterFor', () => {
  it('produces a game_number that strictly decreases as rankFromNewest increases, matching adaptStoryReport\'s own chapter_id', () => {
    const c0 = syntheticChapterFor('charA', 0);
    const c1 = syntheticChapterFor('charA', 1);
    expect(c0.game_number).toBeGreaterThan(c1.game_number);
    expect(c0._id).toBe('storytab.1:charA:0');
    expect(c1._id).toBe('storytab.1:charA:1');
  });

  it('every synthetic game_number is comfortably above any real tm_game game_number', () => {
    const c = syntheticChapterFor('charA', 50);
    expect(c.game_number).toBeGreaterThan(1000);
  });

  // Found live, story storytab.5, 2026-09-19: a real player's own STORY tab showed "Cycle 95:1"
  // for a genuinely published TM-Story-sourced entry, because the pre-existing
  // `cycleMap[...]?.label || Cycle ${id.slice(-4)}` fallback sliced the SYNTHETIC id itself, never
  // designed to be human-readable. Fixed by giving syntheticChapterFor a real label when a
  // publishedAt date is available.
  it('sets a human month/year label from a real publishedAt date, matching downtime-tab.js\'s own en-AU short-month format', () => {
    // en-AU's own ICU short-month data abbreviates September to "Sept" (4 letters), unlike most
    // other months ("Aug", "Oct") — a real locale quirk, not a bug. Confirmed this matches
    // downtime-tab.js's own existing _cycleDate() output exactly, so kept consistent rather than
    // hand-formatted to a different, app-inconsistent shape.
    const c = syntheticChapterFor('charA', 0, '2026-09-18T09:47:48.625Z');
    expect(c.label).toBe('Sept 2026');
  });

  it('omits label (falls back to the pre-existing slice-based fallback downstream) when publishedAt is missing', () => {
    const c = syntheticChapterFor('charA', 0);
    expect(c.label).toBeUndefined();
  });

  it('omits label when publishedAt is present but unparseable, never crashes', () => {
    const c = syntheticChapterFor('charA', 0, 'not-a-real-date');
    expect(c.label).toBeUndefined();
  });
});
