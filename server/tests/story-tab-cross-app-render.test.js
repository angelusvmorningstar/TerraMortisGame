/**
 * Story storytab.1, proves the two things AC 9 actually cares about, against the REAL
 * production functions rather than reimplemented test-only logic:
 *
 *   1. The ADAPTER (server/lib/story-downtime-fetch.js's adaptStoryReport) produces a
 *      sub object `renderOutcomeWithCards()` (public/js/tabs/story-tab.js) renders with
 *      the SAME visual output as an equivalent native tm_game submission, no second
 *      renderer, per the (b) decision.
 *   2. The MERGE-AND-SORT logic (renderChronicle, also in story-tab.js) places every
 *      TM-Story-sourced entry ahead of every tm_game-sourced entry (AC 6's ruled
 *      provisional block rule), while each source's own internal order survives intact.
 */

import { describe, it, expect } from 'vitest';

// renderOutcomeWithCards/renderChronicle reach into ../auth/discord.js for isSTRole()/
// getPlayerInfo() (the per-section flag affordance), which reads localStorage, not a
// real global under plain Node. Same stub this repo's own cm1-cycle-phase.test.js uses.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

import { renderOutcomeWithCards, renderChronicle } from '../../public/js/tabs/story-tab.js';
import { adaptStoryReport, syntheticChapterFor } from '../lib/story-downtime-fetch.js';

describe('storytab.1: renderOutcomeWithCards renders an adapted TM Story report like a native one', () => {
  const CHAR_ID = 'charA';

  const NATIVE_SUB = {
    _id: 'native-sub',
    character_id: CHAR_ID,
    published_outcome: 'Ambrose consolidated his holdings.',
    st_narrative: {
      story_moment: { response: 'The habit is older than you.' },
      home_report: { response: 'The Docklands are quiet.' },
      cacophony_savvy: [{ response: 'The Prince dines alone.' }],
    },
    merit_actions_resolved: [{ action_type: 'status', outcome_summary: 'Standing rose.', pool_status: 'ok' }],
  };

  const STORY_REPORT = {
    cycle_id: 'cyc-pub',
    narrative: 'Ambrose consolidated his holdings.',
    story_moment: 'The habit is older than you.',
    home_report: 'The Docklands are quiet.',
    cacophony_savvy: [{ slot: 1, response: 'The Prince dines alone.' }],
    merit_actions_resolved: [{ action_type: 'status', outcome_summary: 'Standing rose.', pool_status: 'ok' }],
  };

  it('renders byte-identical Story Moment / Home Report / Rumours sections from equivalent native vs. adapted data', () => {
    const adaptedSub = adaptStoryReport(STORY_REPORT, CHAR_ID, 0);
    const nativeHtml = renderOutcomeWithCards(NATIVE_SUB);
    const adaptedHtml = renderOutcomeWithCards(adaptedSub);
    expect(adaptedHtml).toContain('The habit is older than you.');
    expect(adaptedHtml).toContain('The Docklands are quiet.');
    expect(adaptedHtml).toContain('The Prince dines alone.');
    // Same section markup, not a thinner/different card purely because of source (AC 7).
    expect(adaptedHtml.replace(/data-sub-id="[^"]*"/g, '')).toBe(nativeHtml.replace(/data-sub-id="[^"]*"/g, ''));
  });

  it('KNOWN GAP (documented, not fixed here): a TM-Story-sourced merit resolution\'s outcome_summary does not yet reach the grouped ledger, because that renderer zips resolved[i] against a DECLARED-side reconstruction this adapter does not attempt (see story-downtime-fetch.js\'s own comment on why)', () => {
    const adaptedSub = adaptStoryReport(STORY_REPORT, CHAR_ID, 0);
    expect(adaptedSub.merit_actions_resolved[0].outcome_summary).toBe('Standing rose.'); // the data DID survive the adapter...
    const html = renderOutcomeWithCards(adaptedSub);
    expect(html).not.toContain('Standing rose.'); // ...but the ledger renderer can't reach it without a matching declared action
  });

  it('a TM-Story-sourced entry with no declared project slots renders no withheld/blank project cards it never had (per-field omission, not a thinner card)', () => {
    const adaptedSub = adaptStoryReport(STORY_REPORT, CHAR_ID, 0);
    expect(adaptedSub.responses).toEqual({});
    const html = renderOutcomeWithCards(adaptedSub);
    expect(html).not.toContain('proj-card-withheld');
  });
});

describe('storytab.1: renderChronicle places TM-Story-sourced entries ahead of tm_game-sourced ones (AC 6, the ruled block rule)', () => {
  const CHAR = { _id: 'charA' };

  const TM_GAME_NEWEST = { _id: 'game-sub-2', character_id: 'charA', chapter_id: 'chapterB', published_outcome: 'Game 7 outcome.' };
  const TM_GAME_OLDEST = { _id: 'game-sub-1', character_id: 'charA', chapter_id: 'chapterA', published_outcome: 'Game 1 outcome.' };
  const TM_GAME_CYCLES = [
    { _id: 'chapterA', game_number: 1, label: 'Game 1' },
    { _id: 'chapterB', game_number: 7, label: 'Game 7' },
  ];

  it('every TM-Story entry sorts ahead of every tm_game entry, regardless of fixture insertion order, and each source keeps its own internal order', () => {
    const storyReports = [
      { cycle_id: 'cyc-newer', narrative: 'TM Story newer cycle.' },
      { cycle_id: 'cyc-older', narrative: 'TM Story older cycle.' },
    ];
    const adaptedSubs = storyReports.map((r, i) => adaptStoryReport(r, 'charA', i));
    const syntheticCycles = storyReports.map((_, i) => syntheticChapterFor('charA', i));

    // Deliberately interleaved insertion order, the sort, not insertion order, must decide.
    const subs = [TM_GAME_NEWEST, adaptedSubs[0], TM_GAME_OLDEST, adaptedSubs[1]];
    const cycles = [...TM_GAME_CYCLES, ...syntheticCycles];

    const html = renderChronicle(subs, cycles, CHAR);
    const iNewer = html.indexOf('TM Story newer cycle.');
    const iOlder = html.indexOf('TM Story older cycle.');
    const iGame7 = html.indexOf('Game 7 outcome.');
    const iGame1 = html.indexOf('Game 1 outcome.');

    expect(iNewer).toBeGreaterThan(-1);
    expect(iOlder).toBeGreaterThan(-1);
    expect(iGame7).toBeGreaterThan(-1);
    expect(iGame1).toBeGreaterThan(-1);
    // Block rule: both TM-Story entries render before both tm_game entries.
    expect(iNewer).toBeLessThan(iGame7);
    expect(iOlder).toBeLessThan(iGame7);
    // Within-source order preserved: TM Story's own newer-first order survives.
    expect(iNewer).toBeLessThan(iOlder);
    // tm_game's own existing game_number-descending order survives untouched.
    expect(iGame7).toBeLessThan(iGame1);
  });
});
