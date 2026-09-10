/**
 * Epic 12, Story 12.3 - the Feeding tab's standing Influence + Willpower tally.
 *
 * Same discipline as Story 12.2's own suite (epic12.2-feeding-tab-form-roll.test.js):
 * these tests EXECUTE `public/js/tabs/feeding-tab.js` against a minimal DOM and
 * read the markup it really produced, rather than asserting on source text.
 * Three suites in this repo are permanently red precisely because they assert on
 * source snippets that later drifted (CLAUDE.md's known-failures list), and a
 * source-grep could not prove the two things this story actually has to
 * guarantee: that the card renders in EVERY state, and that its declared-spend
 * figure comes off the fetch Story 12.2 already made rather than a second one.
 *
 * There is no jsdom in this runner (server/vitest.config.js configures none, and
 * it is not installed). The pane stub below is 12.2's, unchanged - the tab only
 * ever touches `el.innerHTML`, id/class/attribute `querySelector(All)`,
 * `addEventListener` and `document.getElementById`.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

// ── Browser globals, installed before the module graph is imported ───────────

const hadLocation = 'location' in globalThis;
const hadLocalStorage = 'localStorage' in globalThis;
const hadDocument = 'document' in globalThis;
const hadFetch = 'fetch' in globalThis;
const realFetch = globalThis.fetch;

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};
globalThis.location = {
  hostname: 'terramortisgame.netlify.app',
  origin: 'https://terramortisgame.netlify.app',
  pathname: '/index.html',
};

// ── The minimal DOM the tab actually uses ────────────────────────────────────

function datasetFrom(attrs) {
  const ds = {};
  for (const m of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) {
    ds[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[2];
  }
  return ds;
}

function makePane() {
  const handlers = new Map();
  return {
    _html: '',
    handlers,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },

    querySelector(sel) {
      if (!sel.startsWith('#')) throw new Error('harness: unsupported querySelector ' + sel);
      const id = sel.slice(1);
      const re = new RegExp(`<(\\w+)([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)<\\/\\1>`);
      const m = this._html.match(re);
      if (!m) return null;
      return {
        id,
        textContent: m[3].replace(/<[^>]*>/g, ''),
        dataset: datasetFrom(m[2]),
        disabled: false,
        classList: { add() {} },
        addEventListener(type, fn) { handlers.set(sel + ':' + type, fn); },
      };
    },

    querySelectorAll(sel) {
      let re;
      if (sel.startsWith('.')) re = new RegExp(`class="[^"]*\\b${sel.slice(1)}\\b[^"]*"`, 'g');
      else if (sel.startsWith('[')) re = new RegExp(sel.slice(1, -1) + '="[^"]*"', 'g');
      else throw new Error('harness: unsupported querySelectorAll ' + sel);
      const hits = this._html.match(re) || [];
      return hits.map(hit => ({
        dataset: datasetFrom(hit),
        value: '',
        addEventListener() {},
      }));
    },

    async click(sel) {
      const fn = handlers.get(sel + ':click');
      if (!fn) throw new Error('no click handler registered for ' + sel);
      await fn();
      return true;
    },
  };
}

let leftPane, rightPane, rootEl, pane;
globalThis.document = {
  getElementById(id) {
    if (id === 'feeding-left-pane') return leftPane;
    if (id === 'feeding-right-pane') return rightPane;
    return null;
  },
};

// ── Fixtures + fetch routing ─────────────────────────────────────────────────

const CYCLE_ID = '6a8bef9a149e7b83a489adba';
const CYCLE = { _id: CYCLE_ID, label: 'Downtime 8', game_number: 8, phase: 'game' };

// TM Story's real response body. `territory_influence` is a SIBLING of
// `feeding`, not nested inside it (TM Story commit 18bbc23), and `spends[]`
// entries are `{ territory: { id, label }, amount }` with a SIGNED amount
// (content-shape.js's own influenceSpend).
function storyBody({ feeding = 'rolled', territoryInfluence = undefined } = {}) {
  const body = {
    feeding: feeding === 'rolled' ? {
      method: 'Seduction',
      poolAttr: 'Manipulation', poolSkill: 'Persuasion', poolDisc: '', poolSpecChip: null,
      bloodType: 'Human',
      rollResult: {
        pool: 7, chance: false, dice: [8, 3, 10, 2, 6, 9, 1], successes: 3,
        exceptional: false, dramatic_failure: false, rote: false, again: 10, signature: 'sig-1',
      },
      vesselVitae: [2, 1],
      poolLocked: true,
      aggHealed: 0,
    } : feeding,
    lifecycle_state: 'final',
    status: 'final',
  };
  if (territoryInfluence !== undefined) body.territory_influence = territoryInfluence;
  return body;
}

function spends(...amounts) {
  return {
    spends: amounts.map((amount, i) => ({
      territory: { id: 'terr-' + i, label: 'Territory ' + (i + 1) },
      amount,
    })),
  };
}

// A TM-Game-sourced submission, so the OLD state machine has something real to
// render when the cross-app read degrades.
function gameSubmission(charId, { rolled = true } = {}) {
  const sub = {
    _id: 'SUB1',
    character_id: charId,
    chapter_id: CYCLE_ID,
    status: 'submitted',
    responses: { _feed_method: 'stalking' },
  };
  if (rolled) {
    sub.feeding_roll_player = {
      cols: [{ r: { v: 9, s: true, x: false }, ch: [] }, { r: { v: 4, s: false, x: false }, ch: [] }],
      successes: 1, vessels: 1, safeVitae: 2, methodName: 'Stalking', pool: 2, again: 10,
      breakdown: '1 Dexterity + 1 Stealth = 2', rolledAt: '2026-09-01T00:00:00.000Z',
      dramaticFailure: false,
    };
  }
  return sub;
}

let scenario;

function jsonRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  scenario.calls.push(method + ' ' + u);

  if (u.includes('/api/wiki/v1/')) {
    scenario.storyCalls.push(u);
    if (scenario.story === 'network') throw new TypeError('Failed to fetch');
    if (scenario.story === '404') return jsonRes({ error: 'NOT_FOUND' }, 404);
    return jsonRes(scenario.story);
  }
  if (u.includes('/api/territories')) return jsonRes([]);
  if (u.includes('/api/chapters')) return jsonRes([CYCLE]);
  if (u.includes('/api/downtime_submissions')) return jsonRes(scenario.subs);
  if (u.includes('/api/tracker_state/')) {
    if (method === 'PUT') {
      scenario.puts.push(JSON.parse(opts.body));
      return jsonRes({ ok: true });
    }
    // A document (200), null (404 - genuinely no tracker document for this
    // character yet), 'server-error' (500), or 'network' (the fetch itself
    // fails). External review (12.3, High): the last two mean the real state is
    // UNKNOWN and must never render as defaults.
    if (scenario.tracker === 'network') throw new TypeError('Failed to fetch');
    if (scenario.tracker === 'server-error') return jsonRes({ error: 'INTERNAL' }, 500);
    return scenario.tracker ? jsonRes(scenario.tracker) : jsonRes({ error: 'NOT_FOUND' }, 404);
  }
  throw new Error('unrouted fetch: ' + method + ' ' + u);
};

let charSeq = 0;
function newChar() {
  charSeq += 1;
  return {
    _id: '69d73ea49162ece35897a4' + String(10 + charSeq),
    name: 'Test Subject ' + charSeq,
    clan: 'Daeva', covenant: 'Invictus',
    blood_potency: 1,
    // Resolve 3 + Composure 2 = Willpower max 5.
    attributes: { Resolve: { dots: 3 }, Composure: { dots: 2 } },
    // Clan Status 3 + Invictus Status 2 = Influence max 5 (calcTotalInfluence).
    status: { clan: 3, covenant: { Invictus: 2 } },
    skills: {}, disciplines: {}, merits: [], powers: [],
  };
}

function setST(isST) {
  if (isST) store.set('tm_auth_user', JSON.stringify({ role: 'st', character_ids: [] }));
  else store.set('tm_auth_user', JSON.stringify({ role: 'player', character_ids: [] }));
}

const { renderFeedingTab } = await import('../../public/js/tabs/feeding-tab.js');
const { default: suiteState } = await import('../../public/js/suite/data.js');

/**
 * Put real values in the character's LIVE tracker_state document - the one the
 * tab now reads for both figures.
 *
 * External review (12.3, High) moved this: the figures used to come from
 * `trackerRead()`, tracker.js's in-memory cache, which SEEDS AND RETURNS
 * DEFAULTS for any character nothing has loaded. `suiteState.chars` is still
 * populated here deliberately - it is what makes that cache resolvable, and
 * therefore what makes every assertion below discriminating: with the character
 * present but its tracker never loaded, the cache answers "full", so any test
 * expecting a non-full figure fails the moment the cache is read again.
 */
function seedTracker(char, { willpower, inf }) {
  suiteState.chars = [char];
  scenario.tracker = {
    character_id: String(char._id),
    ...(willpower != null ? { willpower } : {}),
    ...(inf != null ? { influence: inf } : {}),
  };
}

async function renderTab(char) {
  leftPane = makePane();
  rightPane = makePane();
  rootEl = makePane();
  await renderFeedingTab(rootEl, char);
  pane = leftPane._html ? leftPane : rootEl;
  return pane._html;
}

beforeEach(() => {
  store.clear();
  store.set('tm_auth_token', 'discord-token-abc');
  setST(false);
  suiteState.chars = [];
  scenario = { story: storyBody(), subs: [], tracker: null, puts: [], calls: [], storyCalls: [] };
});

afterAll(() => {
  if (!hadLocation) delete globalThis.location;
  if (!hadLocalStorage) delete globalThis.localStorage;
  if (!hadDocument) delete globalThis.document;
  if (hadFetch) globalThis.fetch = realFetch; else delete globalThis.fetch;
});

// ═════════════════════════════════════════════════════════════════════════════
//  AC 3 - both values present, with a real declared spend
// ═════════════════════════════════════════════════════════════════════════════

describe('AC 3: current Willpower and Influence, plus the declared spend', () => {
  it('shows Willpower read straight from tracker_state', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 4 });
    scenario.story = storyBody({ territoryInfluence: spends(2) });

    const html = await renderTab(char);
    expect(html).toContain('Influence and Willpower');
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('3 / 5');
  });

  it('shows current Influence and the declared spend as two separate, differently labelled rows', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 5, inf: 4 });
    scenario.story = storyBody({ territoryInfluence: spends(2, 1) });

    const html = await renderTab(char);
    expect(html).toContain('Influence (current)');
    expect(html).toContain('Influence declared this cycle (not yet processed)');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('4 / 5');
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('3');
  });

  it('never nets the declared spend off the current total, and says so', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 5, inf: 5 });
    scenario.story = storyBody({ territoryInfluence: spends(3) });

    const html = await renderTab(char);
    // 5 current, 3 declared. A netted figure would read '2 / 5'.
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('5 / 5');
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('3');
    expect(html).toContain('not taken off the current total');
  });

  it('charges a negative (ambience-degrading) spend as real expenditure, matching TM Story\'s own budget maths', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 5, inf: 5 });
    // +2 and -3: a signed sum would report -1, and +2/-2 would report nothing
    // spent at all. TM Story's influence-budget.js charges 1 per point either way.
    scenario.story = storyBody({ territoryInfluence: spends(2, -3) });

    await renderTab(char);
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('5');
  });

  it('does not produce NaN from a malformed amount', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 5, inf: 5 });
    scenario.story = storyBody({ territoryInfluence: { spends: [
      { territory: { id: 't1', label: 'T' }, amount: 'lots' },
      { territory: { id: 't2', label: 'U' }, amount: 2 },
    ] } });

    const html = await renderTab(char);
    expect(html).not.toContain('NaN');
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('2');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  AC 4 - absence degrades, it does not error
// ═════════════════════════════════════════════════════════════════════════════

describe('AC 4: absence shows the current values alone', () => {
  it('omits the declared row entirely when the response carries no territory_influence', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 4, inf: 3 });
    scenario.story = storyBody();   // no territory_influence key at all

    const html = await renderTab(char);
    expect(html).toContain('Influence and Willpower');
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('4 / 5');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('3 / 5');
    expect(html).not.toContain('declared this cycle');
    expect(pane.querySelector('#feed-tally-declared')).toBeNull();
  });

  it('omits the declared row when territory_influence is explicitly null (a cycle predating Story 11.3b)', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 4, inf: 3 });
    scenario.story = storyBody({ territoryInfluence: null });

    const html = await renderTab(char);
    expect(html).toContain('Influence and Willpower');
    expect(html).not.toContain('declared this cycle');
  });

  it.each([
    ['a network/CORS failure', 'network'],
    ['a 404 (no submission for the cycle)', '404'],
  ])('shows the current values alone, and still renders the rest of the tab, on %s', async (_label, story) => {
    const char = newChar();
    seedTracker(char, { willpower: 2, inf: 1 });
    scenario.story = story;
    scenario.subs = [gameSubmission(char._id)];

    const html = await renderTab(char);
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('2 / 5');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('1 / 5');
    expect(html).not.toContain('declared this cycle');
    // The old state machine still rendered its own roll: the card did not block it.
    expect(html).toContain('Stalking');
    expect(html).toContain('feeding-vessels-grid');
  });

  it('shows 0 for a present-but-empty spends array, which is a real figure and not an absent one', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 5, inf: 5 });
    scenario.story = storyBody({ territoryInfluence: { spends: [] } });

    const html = await renderTab(char);
    expect(html).toContain('Influence declared this cycle (not yet processed)');
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('0');
  });

  it.each([
    ['a 500 from the tracker route', 'server-error'],
    ['a network failure', 'network'],
  ])('degrades to Unavailable, not a crash and NOT defaults, on %s', async (_label, mode) => {
    const char = newChar();
    suiteState.chars = [char];
    scenario.tracker = mode;
    scenario.story = storyBody({ territoryInfluence: spends(2) });

    const html = await renderTab(char);
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('Unavailable');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('Unavailable');
    expect(html).toContain('could not be read');
    // The declared figure is independent of tracker_state and still shows.
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('2');
    expect(html).toContain('Rolled in your downtime form');
  });

  it('shows full values for a clean 404, where defaults ARE the true answer', async () => {
    const char = newChar();
    suiteState.chars = [char];
    scenario.tracker = null;   // 404: no tracker document for this character yet
    scenario.story = storyBody();

    const html = await renderTab(char);
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('5 / 5');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('5 / 5');
    expect(html).not.toContain('could not be read');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  External review (Codex, 2026-09-10) - 12.3 findings
// ═════════════════════════════════════════════════════════════════════════════

describe('review High: the figures are the live document, never a seeded default', () => {
  it('shows real persisted values on a fresh session, where nothing has loaded the tracker', async () => {
    const char = newChar();
    // The reported case verbatim: the character really is on Willpower 1/5 and
    // Influence 2/5, no tab has loaded their tracker, and tracker.js's cache
    // would answer 5/5 and 5/5 for both.
    suiteState.chars = [char];
    scenario.tracker = { character_id: String(char._id), willpower: 1, influence: 2 };
    scenario.story = storyBody();

    await renderTab(char);
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('1 / 5');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('2 / 5');
  });

  it('does not let a stale cache win over the live document', async () => {
    const char = newChar();
    suiteState.chars = [char];
    // A first render seeds tracker.js's cache through the tab's own code path.
    scenario.tracker = { character_id: String(char._id), willpower: 5, influence: 5 };
    scenario.story = storyBody();
    await renderTab(char);
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('5 / 5');

    // The server now says something different (a Tracker-tab spend elsewhere, a
    // downtime-processing write). The live read wins.
    scenario.tracker = { character_id: String(char._id), willpower: 2, influence: 1 };
    await renderTab(char);
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('2 / 5');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('1 / 5');
  });

  it('reads that document exactly once per render pass, shared with the ST panel', async () => {
    setST(true);
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 3 });
    scenario.story = storyBody({ territoryInfluence: spends(1) });

    const html = await renderTab(char);
    expect(scenario.calls.filter(c => c.startsWith('GET') && c.includes('/api/tracker_state/'))).toHaveLength(1);
    expect(html).toContain('feed-st-confirm');
  });

  it('pre-fills the ST Influence stepper from the live figure, not the maximum', async () => {
    setST(true);
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 2 });
    scenario.story = storyBody();

    await renderTab(char);
    expect(pane.querySelector('#feed-inf-spent').textContent).toBe('2');
  });
});

describe('review Medium (third round): a tracker figure is never coerced from a non-number', () => {
  it.each([
    ['booleans', true, false],
    ['arrays', [1], [2]],
    ['objects', { valueOf: () => 1 }, { valueOf: () => 2 }],
  ])('falls back to the real maximum when the document carries %s', async (_label, wp, inf) => {
    const char = newChar();
    suiteState.chars = [char];
    scenario.tracker = { character_id: String(char._id), willpower: wp, influence: inf };
    scenario.story = storyBody();

    await renderTab(char);
    // `Number(true)` is 1 and `Number([2])` is 2, so the unguarded coercion read
    // these as real, and very low, tracker figures.
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('5 / 5');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('5 / 5');
  });

  it('still reads a clean numeric string as the number it is', async () => {
    const char = newChar();
    suiteState.chars = [char];
    scenario.tracker = { character_id: String(char._id), willpower: '2', influence: '3' };
    scenario.story = storyBody();

    await renderTab(char);
    expect(pane.querySelector('#feed-tally-wp').textContent).toBe('2 / 5');
    expect(pane.querySelector('#feed-tally-inf').textContent).toBe('3 / 5');
  });
});

describe('review Low: a non-empty but unreadable spends array is not a zero', () => {
  it('shows Unavailable, not 0, when no entry carries a readable amount', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 5, inf: 5 });
    scenario.story = storyBody({ territoryInfluence: { spends: [
      { territory: { id: 't1', label: 'T' }, amount: 'lots' },
      { territory: { id: 't2', label: 'U' }, amount: null },
    ] } });

    const html = await renderTab(char);
    expect(html).toContain('Influence declared this cycle (not yet processed)');
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('Unavailable');
    expect(html).not.toContain('>0</span>');
  });

  it('still reports a genuine zero from an entry that really is 0', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 5, inf: 5 });
    scenario.story = storyBody({ territoryInfluence: spends(0) });

    await renderTab(char);
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('0');
  });

  it('does not render a hostile amount as markup', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 5, inf: 5 });
    scenario.story = storyBody({ territoryInfluence: { spends: [
      { territory: { id: 't1', label: 'T' }, amount: '</span><img src=x onerror=alert(1)>' },
    ] } });

    const html = await renderTab(char);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('Unavailable');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  AC 3 - the card is standing, not gated to one state
// ═════════════════════════════════════════════════════════════════════════════

describe('the card renders in every state, alongside whatever else is showing', () => {
  it('renders alongside the form-sourced roll (Story 12.2\'s state)', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 3 });
    scenario.story = storyBody({ territoryInfluence: spends(1) });

    const html = await renderTab(char);
    expect(html).toContain('Rolled in your downtime form');
    expect(html).toContain('id="feed-tally"');
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('1');
  });

  it('renders alongside a TM-Game-sourced completed roll', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 3 });
    scenario.story = 'network';
    scenario.subs = [gameSubmission(char._id)];

    const html = await renderTab(char);
    expect(html).toContain('Stalking');
    expect(html).toContain('id="feed-tally"');
  });

  it('renders alongside the declared-method ready state', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 3 });
    scenario.story = 'network';
    scenario.subs = [gameSubmission(char._id, { rolled: false })];

    const html = await renderTab(char);
    expect(html).toContain('id="feeding-roll-btn"');   // the ready state really rendered
    expect(html).toContain('id="feed-tally"');
  });

  it('renders alongside the no-submission generic picker', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 3 });
    scenario.story = 'network';
    scenario.subs = [];

    const html = await renderTab(char);
    expect(html).toContain('No downtime feeding declaration found');
    expect(html).toContain('id="feed-tally"');
  });

  it('renders for an ST too, above the existing confirm panel', async () => {
    setST(true);
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 3 });
    scenario.story = storyBody({ territoryInfluence: spends(2) });
    scenario.tracker = { character_id: char._id, aggravated: 0 };

    const html = await renderTab(char);
    expect(html).toContain('id="feed-tally"');
    expect(html).toContain('feed-st-confirm');
    expect(html.indexOf('id="feed-tally"')).toBeLessThan(html.indexOf('feed-st-confirm'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The fetch is reused, never duplicated
// ═════════════════════════════════════════════════════════════════════════════

describe('the declared figure rides Story 12.2\'s existing fetch', () => {
  it('makes exactly one cross-app request per render, in every state', async () => {
    for (const [story, subs] of [
      [storyBody({ territoryInfluence: spends(2) }), []],
      ['network', [/* filled below */]],
      [storyBody({ feeding: null, territoryInfluence: spends(1) }), []],
    ]) {
      const char = newChar();
      seedTracker(char, { willpower: 3, inf: 3 });
      scenario.story = story;
      scenario.subs = subs.length ? subs : [gameSubmission(char._id)];
      scenario.storyCalls = [];

      await renderTab(char);
      expect(scenario.storyCalls).toHaveLength(1);
      expect(scenario.storyCalls[0]).toBe(
        `https://tm-story-api.onrender.com/api/wiki/v1/downtime/submissions/${char._id}/${CYCLE_ID}/feeding`,
      );
    }
  });

  it('reads the declared spend even when the same response carries no roll at all', async () => {
    const char = newChar();
    seedTracker(char, { willpower: 3, inf: 3 });
    // A real draft: no feeding roll, but the Territory and Influence section is
    // filled in. The old state machine renders, and the tally still reports it.
    scenario.story = storyBody({ feeding: null, territoryInfluence: spends(4) });
    scenario.subs = [gameSubmission(char._id)];

    const html = await renderTab(char);
    expect(html).not.toContain('Rolled in your downtime form');
    expect(pane.querySelector('#feed-tally-declared').textContent).toBe('4');
    expect(scenario.storyCalls).toHaveLength(1);
  });
});
