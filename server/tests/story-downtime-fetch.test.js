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
});
