/**
 * Story storytab.5, wires BOTH live downtime-reading surfaces (archive-tab.js's "STORY"
 * nav and downtime-tab.js's Info tab "Past Outcomes" accordion) to the cross-app merge
 * storytab.1 built, plus AC 4's shared sort fix. No jsdom in this repo's `vitest.config.js`
 * (Story-Prep Question 2, closed), so this suite proves the DOM-free data layer
 * (`loadArchiveDowntimeData`, `loadPastOutcomesData`, `sortDowntimesByChapterRecency`)
 * against the REAL production functions, mirroring `story-tab-cross-app-render.test.js`'s
 * own precedent. AC 5's mandatory live-browser check is what proves the actual DOM wiring;
 * this suite does not attempt to substitute for it.
 */

// Browser shims: sheet.js (imported transitively via archive-tab.js) and story-tab.js's
// own auth/discord.js read pull api.js's `location` reference and localStorage. Same
// pattern as collective-2-compound-generalisation.test.js / oath-b-suspension.test.js.
// api.js itself is mocked below, so its real top-level code never runs, but the shims stay
// as a defensive precaution matching this repo's own established convention for importing
// anything that touches editor/sheet.js under plain Node.
globalThis.location = {
  origin: 'http://localhost:8080',
  hostname: 'localhost',
  href: 'http://localhost:8080/admin',
};
globalThis.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; },
};

import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ impl: null, calls: [] }));
vi.mock('../../public/js/data/api.js', () => ({
  apiGet: async (...args) => { api.calls.push(args[0]); return api.impl(...args); },
  apiPost: async () => ({}),
  apiPut: async () => ({}),
  apiPatch: async () => ({}),
  apiDelete: async () => ({}),
  apiBase: () => '',
  headers: () => ({}),
}));

import { sortDowntimesByChapterRecency } from '../../public/js/tabs/story-tab.js';
import { loadArchiveDowntimeData } from '../../public/js/tabs/archive-tab.js';
import { loadPastOutcomesData } from '../../public/js/tabs/downtime-tab.js';
import { adaptStoryReport, syntheticChapterFor } from '../lib/story-downtime-fetch.js';

beforeEach(() => { api.calls = []; });

// ── AC 4: the shared sort helper, reproducing Dana's exact chorus-review finding ──────

describe('storytab.5 AC 4: sortDowntimesByChapterRecency', () => {
  it('places a TM-Story-sourced entry (synthetic game_number ~1e9) ahead of a real Game 8 entry, the bug archive-tab.js\'s old string localeCompare got wrong', () => {
    const REAL_GAME_8 = { _id: 'game-sub-8', character_id: 'charA', chapter_id: 'chapterH', published_outcome: 'Game 8 outcome.' };
    const REAL_CHAPTER_8 = { _id: 'chapterH', game_number: 8, label: 'Game 8' };

    const storyReport = { cycle_id: 'cyc-newest', narrative: 'Game 9 (TM Story) outcome.' };
    const adaptedSub = adaptStoryReport(storyReport, 'charA', 0);
    const syntheticChapter = syntheticChapterFor('charA', 0);

    // Deliberately insert the tm_game entry FIRST; the sort, not insertion order, must decide.
    const subs = [REAL_GAME_8, adaptedSub];
    const cycles = [REAL_CHAPTER_8, syntheticChapter];

    const sorted = sortDowntimesByChapterRecency(subs, cycles);
    expect(sorted[0]).toBe(adaptedSub);
    expect(sorted[1]).toBe(REAL_GAME_8);
  });

  it('is a numeric compare, not the string localeCompare that put "1000000000" behind "8"', () => {
    // Direct reproduction of the exact comparison Dana ran in Node: confirms the fix at the
    // narrowest possible grain, independent of the fuller end-to-end test above.
    expect('1000000000'.localeCompare('8')).toBeLessThan(0); // the OLD bug's own mechanism
    const a = { chapter_id: 'synthetic' };
    const b = { chapter_id: 'real' };
    const cycles = [{ _id: 'synthetic', game_number: 1_000_000_000 }, { _id: 'real', game_number: 8 }];
    const sorted = sortDowntimesByChapterRecency([b, a], cycles);
    expect(sorted[0]).toBe(a); // synthetic (1e9) correctly sorts first under the numeric fix
  });

  it('does not mutate its input array', () => {
    const subs = [
      { chapter_id: 'a' },
      { chapter_id: 'b' },
    ];
    const cycles = [{ _id: 'a', game_number: 1 }, { _id: 'b', game_number: 2 }];
    const original = [...subs];
    sortDowntimesByChapterRecency(subs, cycles);
    expect(subs).toEqual(original);
  });

  it('preserves each source\'s own internal order (TM-Story newest-first, tm_game game_number-descending)', () => {
    const storyReports = [
      { cycle_id: 'cyc-newer', narrative: 'TM Story newer.' },
      { cycle_id: 'cyc-older', narrative: 'TM Story older.' },
    ];
    const adapted = storyReports.map((r, i) => adaptStoryReport(r, 'charA', i));
    const synthetic = storyReports.map((_, i) => syntheticChapterFor('charA', i));
    const gameSubs = [
      { _id: 'g7', character_id: 'charA', chapter_id: 'chB', published_outcome: 'Game 7.' },
      { _id: 'g1', character_id: 'charA', chapter_id: 'chA', published_outcome: 'Game 1.' },
    ];
    const gameCycles = [{ _id: 'chA', game_number: 1 }, { _id: 'chB', game_number: 7 }];

    const sorted = sortDowntimesByChapterRecency(
      [gameSubs[1], adapted[1], gameSubs[0], adapted[0]],
      [...gameCycles, ...synthetic],
    );
    expect(sorted.map(s => s._id)).toEqual([adapted[0]._id, adapted[1]._id, 'g7', 'g1']);
  });
});

// ── AC 2 / AC 6 / AC 9: archive-tab.js's loadArchiveDowntimeData ──────────────────────

describe('storytab.5 AC 2/AC 9: archive-tab.js wires the cross-app merge via loadArchiveDowntimeData', () => {
  const CHAR = { _id: 'charA' };

  it('merges a TM-Story-sourced entry into the archive list, correctly ordered ahead of tm_game entries', async () => {
    api.impl = async (url) => {
      if (url === '/api/downtime_submissions') {
        return [{ _id: 'g8', character_id: 'charA', chapter_id: 'chapterH', published_outcome: 'Game 8 outcome.' }];
      }
      if (url === '/api/chapters') {
        return [{ _id: 'chapterH', game_number: 8, label: 'Game 8' }];
      }
      if (url.startsWith('/api/downtime_submissions/story-tab')) {
        return {
          downtimes: [adaptStoryReport({ cycle_id: 'cyc9', narrative: 'Game 9 (TM Story).' }, 'charA', 0)],
          chapters: [syntheticChapterFor('charA', 0)],
        };
      }
      throw new Error(`unexpected apiGet: ${url}`);
    };

    const { downtimeSubs, cycleMap } = await loadArchiveDowntimeData(CHAR);
    expect(downtimeSubs).toHaveLength(2);
    expect(downtimeSubs[0].published_outcome).toBe('Game 9 (TM Story).');
    expect(downtimeSubs[1].published_outcome).toBe('Game 8 outcome.');
    expect(cycleMap[String(downtimeSubs[1].chapter_id)]).toBe('Game 8');
    // The story-tab-story route was actually called, proving the merge is wired, not just
    // that this call would have been safe to make.
    expect(api.calls.some(u => u.startsWith('/api/downtime_submissions/story-tab'))).toBe(true);
  });

  it('degrades to tm_game-only data, still correctly sorted, when the TM Story fetch fails, never blanks the list (AC 6)', async () => {
    api.impl = async (url) => {
      if (url === '/api/downtime_submissions') {
        return [
          { _id: 'g8', character_id: 'charA', chapter_id: 'chapterH', published_outcome: 'Game 8 outcome.' },
          { _id: 'g1', character_id: 'charA', chapter_id: 'chapterA', published_outcome: 'Game 1 outcome.' },
        ];
      }
      if (url === '/api/chapters') {
        return [
          { _id: 'chapterH', game_number: 8, label: 'Game 8' },
          { _id: 'chapterA', game_number: 1, label: 'Game 1' },
        ];
      }
      if (url.startsWith('/api/downtime_submissions/story-tab')) throw new Error('TM Story is down');
      throw new Error(`unexpected apiGet: ${url}`);
    };

    const { downtimeSubs } = await loadArchiveDowntimeData(CHAR);
    expect(downtimeSubs.map(s => s._id)).toEqual(['g8', 'g1']);
  });

  it('promotes st_review.outcome_text to published_outcome exactly as the original inline logic did', async () => {
    api.impl = async (url) => {
      if (url === '/api/downtime_submissions') {
        return [{ _id: 'g8', character_id: 'charA', chapter_id: 'chapterH', st_review: { outcome_visibility: 'published', outcome_text: 'Promoted text.' } }];
      }
      if (url === '/api/chapters') return [{ _id: 'chapterH', game_number: 8, label: 'Game 8' }];
      if (url.startsWith('/api/downtime_submissions/story-tab')) return { downtimes: [], chapters: [] };
      throw new Error(`unexpected apiGet: ${url}`);
    };

    const { downtimeSubs } = await loadArchiveDowntimeData(CHAR);
    expect(downtimeSubs).toHaveLength(1);
    expect(downtimeSubs[0].published_outcome).toBe('Promoted text.');
  });
});

// ── AC 3 / AC 6 / AC 9: downtime-tab.js's loadPastOutcomesData ────────────────────────

describe('storytab.5 AC 3/AC 9: downtime-tab.js wires the cross-app merge via loadPastOutcomesData', () => {
  const CHAR = { _id: 'charA' };

  it('merges a TM-Story-sourced entry into Past Outcomes, correctly ordered ahead of tm_game entries, replacing the old raw _id-string sort', async () => {
    api.impl = async (url) => {
      if (url === '/api/chapters') return [{ _id: 'chapterH', game_number: 8, label: 'Game 8' }];
      if (url === '/api/downtime_submissions') {
        return [{ _id: 'g8', character_id: 'charA', chapter_id: 'chapterH', published_outcome: 'Game 8 outcome.' }];
      }
      if (url.startsWith('/api/downtime_submissions/story-tab')) {
        return {
          downtimes: [adaptStoryReport({ cycle_id: 'cyc9', narrative: 'Game 9 (TM Story).' }, 'charA', 0)],
          chapters: [syntheticChapterFor('charA', 0)],
        };
      }
      throw new Error(`unexpected apiGet: ${url}`);
    };

    const { publishedSubs } = await loadPastOutcomesData(CHAR);
    expect(publishedSubs).toHaveLength(2);
    expect(publishedSubs[0].published_outcome).toBe('Game 9 (TM Story).');
    expect(publishedSubs[1].published_outcome).toBe('Game 8 outcome.');
    expect(api.calls.some(u => u.startsWith('/api/downtime_submissions/story-tab'))).toBe(true);
  });

  it('degrades to tm_game-only data, still correctly sorted, when the TM Story fetch fails, never blanks the accordion (AC 6)', async () => {
    api.impl = async (url) => {
      if (url === '/api/chapters') {
        return [
          { _id: 'chapterH', game_number: 8, label: 'Game 8' },
          { _id: 'chapterA', game_number: 1, label: 'Game 1' },
        ];
      }
      if (url === '/api/downtime_submissions') {
        return [
          { _id: 'g8', character_id: 'charA', chapter_id: 'chapterH', published_outcome: 'Game 8 outcome.' },
          { _id: 'g1', character_id: 'charA', chapter_id: 'chapterA', published_outcome: 'Game 1 outcome.' },
        ];
      }
      if (url.startsWith('/api/downtime_submissions/story-tab')) throw new Error('TM Story is down');
      throw new Error(`unexpected apiGet: ${url}`);
    };

    const { publishedSubs } = await loadPastOutcomesData(CHAR);
    expect(publishedSubs.map(s => s._id)).toEqual(['g8', 'g1']);
  });

  it('returns an empty result (not a throw) when the initial tm_game fetch itself fails, matching the original early-return behaviour', async () => {
    api.impl = async () => { throw new Error('tm_game is down'); };
    const { publishedSubs, cycles } = await loadPastOutcomesData(CHAR);
    expect(publishedSubs).toEqual([]);
    expect(cycles).toEqual([]);
  });
});
