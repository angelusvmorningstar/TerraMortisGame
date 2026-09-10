/**
 * Epic 12, Story 12.2 - the Feeding tab reflects a roll the player already made
 * in TM Story's downtime form, never re-asks for it, and applies its `aggHealed`
 * exactly once through the existing ST confirm write.
 *
 * These tests EXECUTE `public/js/tabs/feeding-tab.js` end to end (render the
 * tab, read the produced markup, click the real handlers) rather than asserting
 * on source text. This repo has three suites permanently red precisely because
 * they assert on source snippets that later drifted (see CLAUDE.md's
 * known-pre-existing-failures list) - a source-grep would also have proved
 * nothing about the two things this story actually has to guarantee: that no
 * roll button is REACHABLE, and that one confirm click makes exactly one write.
 *
 * There is no jsdom in this runner (server/vitest.config.js configures none,
 * and it is not installed - see bl5-lineage-lock-client.test.js and
 * epic12.1-story-feeding-fetch.test.js for the same note). The tab only ever
 * touches `el.innerHTML`, `querySelector(All)` with id/class/attribute
 * selectors, `addEventListener('click'|'change')` and
 * `document.getElementById`, so the minimal pane below covers the whole surface
 * it uses. `location`, `localStorage` and `fetch` are stubbed the same way
 * Story 12.1's own suite stubs them.
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
// A production hostname keeps the two API bases distinguishable: data/api.js
// resolves to '' (same-origin) while story-feeding.js resolves to TM Story's
// own deployed origin. On localhost both would be http://localhost:3000.
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

    // Fire a handler the tab really registered. Throws when there is none,
    // which is what "no roll button is reachable" is asserted with.
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

const CYCLE_ID = '6a8bef9a149e7b83a489adba';   // Jack Fallow's real Game 8 cycle (Story 12.1 grounding)
const CYCLE = { _id: CYCLE_ID, label: 'Downtime 8', game_number: 8, phase: 'game' };

// A real current-format sub-document shape (TM Story content-shape.js).
function storyFeedingBody({ aggHealed = 0, vesselVitae = [2, 1], bloodType = 'Human', extra = {} } = {}) {
  return {
    feeding: {
      method: 'Seduction',
      poolAttr: 'Manipulation', poolSkill: 'Persuasion', poolDisc: '', poolSpecChip: null,
      bloodType,
      rollResult: {
        pool: 7, chance: false, dice: [8, 3, 10, 2, 6, 9, 1], successes: 3,
        exceptional: false, dramatic_failure: false, rote: false, again: 10, signature: 'sig-1',
      },
      vesselVitae,
      poolLocked: true,
      aggHealed,
      ...extra,
    },
    lifecycle_state: 'final',
    status: 'final',
  };
}

// The TM-Game-sourced submission the OLD state machine reads. Present in every
// scenario below, so "the new state won" is never just "there was nothing else".
function gameSubmission(charId) {
  return {
    _id: 'SUB1',
    character_id: charId,
    chapter_id: CYCLE_ID,
    status: 'submitted',
    responses: { _feed_method: 'stalking' },
    feeding_roll_player: {
      cols: [{ r: { v: 9, s: true, x: false }, ch: [] }, { r: { v: 4, s: false, x: false }, ch: [] }],
      successes: 1, vessels: 1, safeVitae: 2, methodName: 'Stalking', pool: 2, again: 10,
      breakdown: '1 Dexterity + 1 Stealth = 2', rolledAt: '2026-09-01T00:00:00.000Z',
      dramaticFailure: false,
    },
  };
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
    return scenario.tracker ? jsonRes(scenario.tracker) : jsonRes({ error: 'NOT_FOUND' }, 404);
  }
  throw new Error('unrouted fetch: ' + method + ' ' + u);
};

let charSeq = 0;
function newChar() {
  // A fresh id per scenario: `_stConfirmed` in the tab is keyed by character id
  // and deliberately persists for the session, so reusing one would leak state
  // between tests.
  charSeq += 1;
  return {
    _id: '69d73ea49162ece35897a4' + String(10 + charSeq),
    name: 'Test Subject ' + charSeq,
    clan: 'Daeva', covenant: 'Invictus',
    blood_potency: 1,
    attributes: {}, skills: {}, disciplines: {}, merits: [], powers: [],
  };
}

function setST(isST) {
  if (isST) store.set('tm_auth_user', JSON.stringify({ role: 'st', character_ids: [] }));
  else store.set('tm_auth_user', JSON.stringify({ role: 'player', character_ids: [] }));
}

const { renderFeedingTab, AGG_HEALED_MARKER } = await import('../../public/js/tabs/feeding-tab.js');

async function renderTab(char) {
  leftPane = makePane();
  rightPane = makePane();
  rootEl = makePane();
  await renderFeedingTab(rootEl, char);
  // Most states mount the two-pane shell and render into the left pane; the
  // tab's pre-existing early-return states (a DB-persisted roll, a deferred
  // roll) render straight into the root element instead.  is whichever
  // one the tab really used, so a click below hits the handlers it really
  // registered.
  pane = leftPane._html ? leftPane : rootEl;
  return pane._html;
}

beforeEach(() => {
  store.clear();
  store.set('tm_auth_token', 'discord-token-abc');
  setST(false);
  scenario = { story: storyFeedingBody(), subs: [], tracker: null, puts: [], calls: [], storyCalls: [] };
});

afterAll(() => {
  if (!hadLocation) delete globalThis.location;
  if (!hadLocalStorage) delete globalThis.localStorage;
  if (!hadDocument) delete globalThis.document;
  if (hadFetch) globalThis.fetch = realFetch; else delete globalThis.fetch;
});

// ═════════════════════════════════════════════════════════════════════════════
//  AC 1 - precedence
// ═════════════════════════════════════════════════════════════════════════════

describe('AC 1: TM Story\'s completed roll takes precedence', () => {
  it('renders the form-sourced state and ignores the TM-Game submission entirely', async () => {
    const char = newChar();
    scenario.subs = [gameSubmission(char._id)];   // a real TM-Game roll is present...
    const html = await renderTab(char);

    // ...and is not what rendered. The TM Story roll (3 successes, 7 dice) won
    // over the TM Game one (1 success, 2 dice).
    expect(html).toContain('Rolled in your downtime form');
    expect(html).toContain('>3</div>');
    expect(html).not.toContain('Stalking');
  });

  it('is fetched with the ids the tab already resolved, once', async () => {
    const char = newChar();
    await renderTab(char);
    expect(scenario.storyCalls).toEqual([
      `https://tm-story-api.onrender.com/api/wiki/v1/downtime/submissions/${char._id}/${CYCLE_ID}/feeding`,
    ]);
  });

  it('skips the TM-Game submission lookup for the cycle', async () => {
    const char = newChar();
    scenario.subs = [gameSubmission(char._id)];
    await renderTab(char);
    // Exactly one ?chapter_id= read remains: getFeedingCycle's own. The tab's
    // second, `mySub`, read is skipped.
    const byCycle = scenario.calls.filter(c => c.includes('chapter_id='));
    expect(byCycle).toHaveLength(1);
  });

  it.each([
    ['a network/CORS failure', 'network'],
    ['a 404 (no submission for the cycle)', '404'],
    ['a 200 with no feeding sub-document', { feeding: null, lifecycle_state: 'draft', status: null }],
    ['a 200 with a historical partial feeding block and no rollResult', {
      feeding: { method: '', poolAttr: '', vesselVitae: [], aggHealed: 0 }, lifecycle_state: 'accepted', status: null,
    }],
  ])('falls back to the existing state machine on %s', async (_label, story) => {
    const char = newChar();
    scenario.story = story;
    scenario.subs = [gameSubmission(char._id)];
    const html = await renderTab(char);

    expect(html).not.toContain('Rolled in your downtime form');
    expect(html).toContain('Stalking');            // the TM-Game roll rendered
    expect(html).toContain('feeding-vessels-grid');
    expect(html).toContain('class="fvc-select"');  // the OLD editable allocation UI
  });

  it('produces identical markup for every degrade mode, so the new path is inert', async () => {
    const renders = [];
    for (const story of ['network', '404', { feeding: null }, { feeding: { method: 'x' } }]) {
      const char = newChar();
      scenario.story = story;
      scenario.subs = [gameSubmission(char._id)];
      // Normalise the per-scenario character id out of the markup.
      renders.push((await renderTab(char)).split(char._id).join('CHARID'));
    }
    expect(new Set(renders).size).toBe(1);
  });

  it('leaves the roll button in place when the old state machine runs', async () => {
    const char = newChar();
    scenario.story = 'network';
    scenario.subs = [{
      _id: 'SUB2', character_id: char._id, chapter_id: CYCLE_ID, status: 'submitted',
      responses: { _feed_method: 'stalking' },   // declared, not yet rolled -> 'ready'
    }];
    const html = await renderTab(char);
    expect(html).toContain('id="feeding-roll-btn"');
    await expect(pane.click('#feeding-roll-btn')).resolves.toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  AC 2 - the read-only state
// ═════════════════════════════════════════════════════════════════════════════

describe('AC 2: the form-sourced state is read-only', () => {
  it('shows dice, successes and the pool from TM Story\'s rollResult', async () => {
    const html = await renderTab(newChar());
    expect(html).toContain('7 dice');
    expect(html).toContain('<div class="feeding-suc">3</div>');
    expect(html).toContain('successes');
    // Successes (>= 8) carry the existing success class, a 1 the existing 1 class.
    expect(html).toContain('<span class="feed-die fd-s">8</span>');
    expect(html).toContain('<span class="feed-die fd-s">10</span>');
    expect(html).toContain('<span class="feed-die fd-1">1</span>');
    expect(html).toContain('<span class="feed-die">3</span>');
  });

  it('flags an exceptional success', async () => {
    scenario.story = storyFeedingBody();
    scenario.story.feeding.rollResult.successes = 5;
    scenario.story.feeding.rollResult.exceptional = true;
    const html = await renderTab(newChar());
    expect(html).toContain('successes (exceptional)');
  });

  it('flags a dramatic failure', async () => {
    scenario.story = storyFeedingBody();
    scenario.story.feeding.rollResult.dramatic_failure = true;
    const html = await renderTab(newChar());
    expect(html).toContain('feeding-dramatic');
  });

  it('renders each vessel read-only, with the tab\'s own consequence helpers', async () => {
    scenario.story = storyFeedingBody({ vesselVitae: [2, 4, 7] });
    const html = await renderTab(newChar());

    expect(html).toContain('<span class="fvc-consequence fvc-safe">Safe</span>');
    expect(html).toContain('<span class="fvc-consequence fvc-serious">Serious injury</span>');
    expect(html).toContain('<span class="fvc-consequence fvc-critical">Fatal</span>');
    expect(html).toContain('Total Vitae: <strong>13</strong>');

    // No editable allocation anywhere: no selector, no per-vessel index, no
    // "Confirm Allocation" button.
    expect(html).not.toContain('<select');
    expect(html).not.toContain('data-vessel-idx');
    expect(html).not.toContain('fvc-confirm');
    expect(pane.querySelectorAll('.fvc-select')).toHaveLength(0);
  });

  it('does not label an Animal pool with the per-vessel harm scale', async () => {
    scenario.story = storyFeedingBody({ vesselVitae: [12], bloodType: 'Animal' });
    const html = await renderTab(newChar());
    expect(html).toContain('Animal vitae');
    expect(html).toContain('12 vitae');
    expect(html).not.toContain('fvc-consequence');
  });

  it('NEVER renders or wires a roll button (the "never re-ask" requirement)', async () => {
    const char = newChar();
    scenario.subs = [gameSubmission(char._id)];
    const html = await renderTab(char);

    expect(html).not.toContain('feeding-roll-btn');
    expect(html).not.toContain('Roll Feeding');
    expect(pane.querySelector('#feeding-roll-btn')).toBeNull();
    // Nothing registered a click that could reach doFeedingRoll.
    expect([...pane.handlers.keys()]).not.toContain('#feeding-roll-btn:click');
    await expect(pane.click('#feeding-roll-btn')).rejects.toThrow(/no click handler/);
  });

  it('replaces the ST Reset Roll button with a note, for an ST', async () => {
    setST(true);
    const html = await renderTab(newChar());

    expect(html).toContain('feeding-st-override');
    expect(html).not.toContain('feeding-reroll-btn');
    expect(html).not.toContain('Reset Roll');
    expect(html).not.toContain('feeding-release-btn');
    expect(html).toContain('cannot be reset from here');
    expect(html).toContain('downtime-processing scripts');
    expect(pane.querySelector('#feeding-reroll-btn')).toBeNull();
  });

  it('shows no ST panel at all to a player', async () => {
    const html = await renderTab(newChar());
    expect(html).not.toContain('feed-st-confirm');
    expect(html).not.toContain('feeding-st-override');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  AC 3 / AC 4 - aggHealed through the existing confirm, exactly once
// ═════════════════════════════════════════════════════════════════════════════

describe('AC 3/4: aggHealed rides the existing ST confirm write', () => {
  it('shows the figure and applies vitae, influence, aggravated and the marker in ONE write', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2, vesselVitae: [3, 2] });
    scenario.tracker = { character_id: char._id, vitae: 0, aggravated: 3, influence: 4 };

    const html = await renderTab(char);
    expect(html).toContain('Aggravated Healed');
    expect(html).toContain('data-agg-healed="2"');
    // The vitae stepper still defaults from the vessels, as the existing panel does.
    expect(pane.querySelector('#feed-confirm-n').textContent).toBe('5');

    await pane.click('#feed-confirm-btn');

    expect(scenario.puts).toHaveLength(1);
    const body = scenario.puts[0];
    expect(body.vitae).toBe(5);
    expect(body).toHaveProperty('influence');
    expect(body.aggravated).toBe(1);                    // 3 on record - 2 healed
    expect(body[AGG_HEALED_MARKER]).toBe(CYCLE_ID);
    expect(Object.keys(body).sort()).toEqual(
      ['aggravated', AGG_HEALED_MARKER, 'influence', 'vitae'].sort(),
    );

    // And the confirmed record names the healing.
    expect(pane._html).toContain('Feed confirmed');
    expect(pane._html).toContain('Agg −2');
  });

  it('never drives the Aggravated track below zero', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 4 });
    scenario.tracker = { character_id: char._id, aggravated: 1 };

    await renderTab(char);
    await pane.click('#feed-confirm-btn');

    expect(scenario.puts[0].aggravated).toBe(0);
  });

  it('does not offer, or write, anything aggravated when the form healed none', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 0 });
    scenario.tracker = { character_id: char._id, aggravated: 3 };

    const html = await renderTab(char);
    expect(html).not.toContain('Aggravated Healed');

    await pane.click('#feed-confirm-btn');
    expect(scenario.puts).toHaveLength(1);
    expect(Object.keys(scenario.puts[0]).sort()).toEqual(['influence', 'vitae']);
  });

  it('treats a cycle already marked on tracker_state as applied, and re-offers nothing', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = { character_id: char._id, aggravated: 1, [AGG_HEALED_MARKER]: CYCLE_ID };

    const html = await renderTab(char);
    expect(html).toContain('already applied this cycle');
    expect(html).not.toContain('data-agg-healed');
    expect(pane.querySelector('#feed-agg-n')).toBeNull();

    await pane.click('#feed-confirm-btn');
    expect(scenario.puts).toHaveLength(1);
    expect(Object.keys(scenario.puts[0]).sort()).toEqual(['influence', 'vitae']);
  });

  it('a marker from a DIFFERENT cycle does not suppress this cycle\'s healing', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = { character_id: char._id, aggravated: 3, [AGG_HEALED_MARKER]: 'some-older-cycle' };

    const html = await renderTab(char);
    expect(html).toContain('data-agg-healed="2"');
  });

  it('a second confirm after Edit does not heal twice', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = { character_id: char._id, aggravated: 3 };

    await renderTab(char);
    await pane.click('#feed-confirm-btn');
    expect(scenario.puts[0].aggravated).toBe(1);

    // Re-open the panel (the existing "Edit" affordance) and confirm again.
    await pane.click('#feed-reconfirm-btn');
    expect(pane._html).toContain('already applied this cycle');
    expect(pane._html).not.toContain('data-agg-healed');

    await pane.click('#feed-confirm-btn');
    expect(scenario.puts).toHaveLength(2);
    expect(scenario.puts[1]).not.toHaveProperty('aggravated');
    expect(scenario.puts[1]).not.toHaveProperty(AGG_HEALED_MARKER);
  });

  it('reads the tracker document only for an ST', async () => {
    const char = newChar();
    await renderTab(char);
    expect(scenario.calls.filter(c => c.includes('/api/tracker_state/'))).toHaveLength(0);

    setST(true);
    scenario.calls = [];
    await renderTab(char);
    expect(scenario.calls.filter(c => c.startsWith('GET') && c.includes('/api/tracker_state/'))).toHaveLength(1);
  });

  it('survives a character with no tracker document at all (404)', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 1 });
    scenario.tracker = null;   // 404

    const html = await renderTab(char);
    expect(html).toContain('data-agg-healed="1"');

    await pane.click('#feed-confirm-btn');
    expect(scenario.puts[0].aggravated).toBe(0);
    expect(scenario.puts[0][AGG_HEALED_MARKER]).toBe(CYCLE_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Regression - the existing TM-Game-sourced confirm is untouched
// ═════════════════════════════════════════════════════════════════════════════

describe('the existing ST confirm write shape is unchanged', () => {
  it('still writes exactly { vitae, influence } on a TM-Game-sourced roll', async () => {
    setST(true);
    const char = newChar();
    scenario.story = 'network';                 // old state machine runs
    scenario.subs = [gameSubmission(char._id)];
    scenario.tracker = { character_id: char._id, aggravated: 3 };

    const html = await renderTab(char);
    expect(html).toContain('feed-confirm-btn');
    expect(html).toContain('Reset Roll (ST)');   // the old override survives

    await pane.click('#feed-confirm-btn');
    expect(scenario.puts).toHaveLength(1);
    expect(Object.keys(scenario.puts[0]).sort()).toEqual(['influence', 'vitae']);
    expect(scenario.puts[0]).not.toHaveProperty(AGG_HEALED_MARKER);
  });
});
