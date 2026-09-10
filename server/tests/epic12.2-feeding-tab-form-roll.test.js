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
// A LATER cycle, used to prove a confirmation recorded against CYCLE does not
// suppress this one's own confirm controls (external review, 12.2 Low).
const CYCLE2_ID = '6b9cef9a149e7b83a489adbb';
const CYCLE2 = { _id: CYCLE2_ID, label: 'Downtime 9', game_number: 9, phase: 'game' };

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
  if (u.includes('/api/chapters')) return jsonRes([scenario.cycle]);
  if (u.includes('/api/downtime_submissions')) return jsonRes(scenario.subs);
  if (u.includes('/api/tracker_state/')) {
    if (method === 'PUT') {
      scenario.puts.push(JSON.parse(opts.body));
      // `holdPut` keeps the write genuinely in flight so a test can navigate
      // away before it settles (external review, third round, Medium: the
      // confirm handler's async race). The body is recorded first, so the
      // "was it sent, and with what" assertions do not depend on the release.
      if (scenario.holdPut) {
        return new Promise(resolve => { scenario.releasePut = () => resolve(jsonRes({ ok: true })); });
      }
      return jsonRes({ ok: true });
    }
    // `scenario.tracker`: a document (200), null (404 - no tracker document
    // for this character yet), 'server-error' (500) or 'network' (the fetch
    // itself fails). The last two are the cases the tab must NOT read as
    // "defaults are fine" (external review, 12.2 High / 12.3 High).
    if (scenario.tracker === 'network') throw new TypeError('Failed to fetch');
    if (scenario.tracker === 'server-error') return jsonRes({ error: 'INTERNAL' }, 500);
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
// Only ever used to reproduce the seeded-default cache the confirm panel used
// to prefer. Nothing in the tab may read a figure out of that cache any more.
const { default: suiteState } = await import('../../public/js/suite/data.js');
const { trackerWriteField } = await import('../../public/js/game/tracker.js');

/**
 * Put the character in exactly the state the reported bug needed: resolvable
 * through `suiteState.chars`, with tracker.js's in-memory cache already SEEDED
 * WITH DEFAULTS (`aggravated: 0`) and never loaded from the server. Any render
 * of the Tracker tab, or of Story 12.3's tally card as first written, does this
 * on its own - `trackerWriteField` is just the shortest way to trigger the same
 * `fromCache()` seeding here.
 */
function seedDefaultCache(char) {
  suiteState.chars = [char];
  trackerWriteField(String(char._id), 'conditions', []);
}

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
  suiteState.chars = [];
  scenario = {
    story: storyFeedingBody(), subs: [], tracker: null, cycle: CYCLE,
    puts: [], calls: [], storyCalls: [],
    holdPut: false, releasePut: null,
  };
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
    // Story 12.4 recomposed these onto the downtime form's own dice classes
    // (.feeding-die/.feeding-die-hit). Same intent as before: successes (>= 8)
    // are marked as hits, every other die - including the 1 - renders plain.
    // `.fd-1`'s botch tint has no counterpart in the form and was dropped, so
    // the 1 is now asserted as a rendered plain die rather than by that class.
    expect(html).toContain('<span class="feeding-die feeding-die-hit">8</span>');
    expect(html).toContain('<span class="feeding-die feeding-die-hit">10</span>');
    expect(html).toContain('<span class="feeding-die">1</span>');
    expect(html).toContain('<span class="feeding-die">3</span>');
    // ...and the flat row became one column per BASE die: the 10 exploded, so
    // its child (2) hangs below it in the same column, joined by a stem.
    expect(html).toContain(
      '<div class="feeding-dice-col"><span class="feeding-die feeding-die-hit">10</span>'
      + '<div class="feeding-die-conn"></div><span class="feeding-die">2</span></div>',
    );
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

    // Story 12.4: the harm tier is now the form's own .vd-tier badge, and the
    // Critical/Fatal collapse was split to match TM Story's ladder exactly (7
    // vitae is `vd-fatal`, not `fvc-critical`). Same five labels, same
    // boundaries - `fvcConseqText` is untouched.
    expect(html).toContain('<span class="vd-tier vd-safe">Safe</span>');
    expect(html).toContain('<span class="vd-tier vd-serious">Serious injury</span>');
    expect(html).toContain('<span class="vd-tier vd-fatal">Fatal</span>');
    expect(html).toContain('Total Vitae: <strong>13</strong>');

    // The drawn amount is now a box strip, filled to the value, three-band
    // coloured (1-2 green, 3-4 amber, 5+ red) exactly as the form draws it.
    expect(html).toContain('<div class="vd-vitae-count">4 vitae drawn</div>');
    expect(html).toContain('<span class="vd-box vd-box-filled vd-c-red"></span>');

    // No editable allocation anywhere: no selector, no per-vessel index, no
    // "Confirm Allocation" button.
    expect(html).not.toContain('<select');
    expect(html).not.toContain('data-vessel-idx');
    expect(html).not.toContain('fvc-confirm');
    expect(pane.querySelectorAll('.fvc-select')).toHaveLength(0);
    // Story 12.4, AC 2: the ported boxes are TM Story's INPUT control there and
    // a pure read-out here, so they must be non-interactive spans. Nothing on
    // this whole surface may be a button for a player.
    expect(html).not.toContain('<button');
  });

  it('does not label an Animal pool with the per-vessel harm scale', async () => {
    scenario.story = storyFeedingBody({ vesselVitae: [12], bloodType: 'Animal' });
    const html = await renderTab(newChar());
    expect(html).toContain('Animal Blood Pool');
    expect(html).toContain('12 vitae drawn');
    expect(html).not.toContain('vd-tier');
    // Story 12.4: and no box strip either. TM Story draws one box per point of
    // the shared pool, whose ceiling is successes x 3 - its own rule, which TM
    // Game must not reconstruct just to fill a card in.
    expect(html).not.toContain('vd-boxes');
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

  // Was 'reads the tracker document only for an ST'. External review (12.3,
  // High) killed that behaviour deliberately: Story 12.3's tally card renders
  // for EVERY role in every state and shows real tracker figures, so a player
  // needs the same live read. Exactly one GET per render pass, shared by the
  // card and the confirm panel, is the replacement guarantee.
  it('reads the live tracker document exactly once per render, for both roles', async () => {
    const char = newChar();
    await renderTab(char);
    expect(scenario.calls.filter(c => c.startsWith('GET') && c.includes('/api/tracker_state/'))).toHaveLength(1);

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

// ═════════════════════════════════════════════════════════════════════════════
//  External review (Codex, 2026-09-10) - findings against 12.2 and 12.3
// ═════════════════════════════════════════════════════════════════════════════

describe('review High: the aggravated write is computed from the LIVE tracker document', () => {
  it('uses the live figure, not tracker.js\'s seeded-default cache', async () => {
    setST(true);
    const char = newChar();
    // The real interlock between the two reviews: tracker.js SEEDS
    // `aggravated: 0` for any character nothing has loaded (its own
    // `fromCache`), and 12.3's tally card as first written triggered exactly
    // that on every render. That seeded 0 was then what the confirm panel
    // preferred over the real document.
    seedDefaultCache(char);
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = { character_id: char._id, aggravated: 3, influence: 0 };

    await renderTab(char);
    await pane.click('#feed-confirm-btn');

    // 3 on record minus 2 healed. The cache-first version wrote 0 here, healing
    // all three boxes.
    expect(scenario.puts[0].aggravated).toBe(1);
  });

  it.each([
    ['a 500 from the tracker route', 'server-error'],
    ['a network failure', 'network'],
  ])('fails closed on %s: no confirm control, no write path at all', async (_label, mode) => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = mode;

    const html = await renderTab(char);

    expect(html).toContain('could not be read');
    expect(html).not.toContain('feed-confirm-btn');
    expect(html).not.toContain('data-agg-healed');
    expect(html).not.toContain('feed-inf-spent');
    expect(pane.querySelector('#feed-confirm-btn')).toBeNull();
    await expect(pane.click('#feed-confirm-btn')).rejects.toThrow(/no click handler/);
    expect(scenario.puts).toHaveLength(0);
    // The roll itself still renders: a failed tracker read is not a failed tab.
    expect(html).toContain('Rolled in your downtime form');
  });

  it('still offers the healing when the read is a clean 404 (no document yet)', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = null;   // 404

    const html = await renderTab(char);
    expect(html).toContain('data-agg-healed="2"');
    expect(html).not.toContain('could not be read');
  });
});

describe('review High: TM Story\'s payload is normalised at the boundary', () => {
  const XSS = '</span><img src=x onerror=alert(document.cookie)>';

  it('renders only normalised dice, never raw external markup', async () => {
    scenario.story = storyFeedingBody();
    scenario.story.feeding.rollResult.dice = [8, XSS, 3, { toString: () => XSS }, null];
    const html = await renderTab(newChar());

    expect(html).toContain('Rolled in your downtime form');
    expect(html).toContain('<span class="feeding-die feeding-die-hit">8</span>');
    expect(html).toContain('<span class="feeding-die">3</span>');
    // Nothing of the payload survived, escaped or otherwise.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('document.cookie');
  });

  it('renders only normalised vessel values, never raw external markup', async () => {
    scenario.story = storyFeedingBody({ vesselVitae: [2, XSS, 4] });
    const html = await renderTab(newChar());

    expect(html).toContain('<div class="vd-vitae-count">2 vitae drawn</div>');
    expect(html).toContain('<div class="vd-vitae-count">4 vitae drawn</div>');
    expect(html).toContain('Total Vitae: <strong>6</strong>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('escapes, rather than executes, a hostile method or blood type', async () => {
    scenario.story = storyFeedingBody({ bloodType: XSS });
    scenario.story.feeding.method = XSS;
    const html = await renderTab(newChar());

    // `method` is the one string still interpolated, and esc() neutralises it:
    // it appears as inert text, never as a tag the browser would parse.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('</span><img');
    expect(html).toContain('&lt;/span&gt;&lt;img src=x onerror=alert(document.cookie)&gt;');
  });

  it('never lets a hostile aggHealed reach the ST panel as markup or as a write', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: XSS });
    scenario.tracker = { character_id: char._id, aggravated: 3 };

    const html = await renderTab(char);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Aggravated Healed');

    await pane.click('#feed-confirm-btn');
    expect(scenario.puts[0]).not.toHaveProperty('aggravated');
  });
});

describe('review Medium: only a genuinely usable rollResult activates the new state', () => {
  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['a bare string', 'rolled'],
    ['a number', 7],
    ['a rollResult that is an empty object', { rollResult: {} }],
    ['a rollResult that is an array', { rollResult: [] }],
    ['a rollResult with no dice array', { rollResult: { successes: 3 } }],
    ['a rollResult whose dice is a string', { rollResult: { dice: '8,3', successes: 3 } }],
    ['a rollResult with a non-integer successes', { rollResult: { dice: [8], successes: '3' } }],
    ['a rollResult with a negative successes', { rollResult: { dice: [8], successes: -1 } }],
    ['a rollResult with no successes at all', { rollResult: { dice: [8, 3] } }],
  ])('falls through to the old state machine on %s', async (_label, feeding) => {
    const char = newChar();
    scenario.story = { feeding, lifecycle_state: 'final', status: 'final' };
    scenario.subs = [gameSubmission(char._id)];

    const html = await renderTab(char);
    expect(html).not.toContain('Rolled in your downtime form');
    expect(html).not.toContain('This result is final');
    expect(html).toContain('Stalking');              // the TM-Game roll rendered instead
    expect(html).toContain('class="fvc-select"');    // ...with its own editable allocation UI
  });

  it('does not fabricate a zero-success locked result from a malformed payload', async () => {
    const char = newChar();
    scenario.story = { feeding: {}, lifecycle_state: 'final', status: 'final' };
    scenario.subs = [gameSubmission(char._id)];

    const html = await renderTab(char);
    expect(html).not.toContain('<div class="feeding-suc">0</div>');
  });

  it('still accepts a legitimate zero-success roll', async () => {
    scenario.story = storyFeedingBody();
    scenario.story.feeding.rollResult.dice = [4, 2, 5];
    scenario.story.feeding.rollResult.successes = 0;
    const html = await renderTab(newChar());
    expect(html).toContain('Rolled in your downtime form');
    expect(html).toContain('<div class="feeding-suc">0</div>');
  });
});

describe('review Low: a confirmation is remembered per cycle, not per character', () => {
  it('does not hide the NEW cycle\'s confirm controls after the active cycle changes', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 0 });
    scenario.tracker = { character_id: char._id, aggravated: 0, influence: 0 };

    await renderTab(char);
    await pane.click('#feed-confirm-btn');
    expect(pane._html).toContain('Feed confirmed');

    // The ST opens the next game's cycle; the player never reloaded the page.
    scenario.cycle = CYCLE2;
    const html = await renderTab(char);

    expect(html).not.toContain('Feed confirmed');
    expect(html).toContain('id="feed-confirm-btn"');
    await pane.click('#feed-confirm-btn');
    expect(scenario.puts).toHaveLength(2);
  });

  it('still shows the confirmed record for the cycle it was recorded against', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 0 });
    scenario.tracker = { character_id: char._id, aggravated: 0, influence: 0 };

    await renderTab(char);
    await pane.click('#feed-confirm-btn');
    const html = await renderTab(char);   // same cycle, re-rendered
    expect(html).toContain('Feed confirmed');
    expect(html).not.toContain('id="feed-confirm-btn"');
  });
});

describe('review Medium: a confirm write cannot be started twice', () => {
  it('ignores a second click while the first write is in flight', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = { character_id: char._id, aggravated: 3, influence: 0 };

    await renderTab(char);
    // Both clicks fire before either write settles - the two-tabs/double-click
    // race, in one process.
    await Promise.all([pane.click('#feed-confirm-btn'), pane.click('#feed-confirm-btn')]);

    expect(scenario.puts).toHaveLength(1);
    expect(scenario.puts[0].aggravated).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  External review, third round (Codex, 2026-09-10)
// ═════════════════════════════════════════════════════════════════════════════

describe('review Medium: an in-flight confirm cannot land on a view it was not about', () => {
  it('does not apply a stale confirm response to the character now on screen', async () => {
    setST(true);
    const charA = newChar();
    const charB = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = { character_id: charA._id, aggravated: 3, influence: 4 };

    await renderTab(charA);
    const paneA = pane;
    expect(paneA._html).toContain('data-agg-healed="2"');

    // The write starts and stays in flight.
    scenario.holdPut = true;
    const inFlight = paneA.click('#feed-confirm-btn');   // deliberately not awaited

    // ...and the ST switches to a different character before it settles.
    scenario.tracker = { character_id: charB._id, aggravated: 5, influence: 1 };
    const htmlB = await renderTab(charB);
    const paneB = pane;
    expect(htmlB).toContain('data-agg-healed="2"');           // B's own healing, unapplied
    expect(htmlB).not.toContain('already applied this cycle');

    scenario.releasePut();
    await inFlight;

    // B's view is exactly as B rendered it. Before this fix, A's response was
    // merged into the now-current `trackerDoc` and re-rendered here, so B
    // showed A's aggravated marker as "already applied this cycle" and A's
    // Influence figure.
    expect(paneB._html).toBe(htmlB);
    expect(paneB._html).not.toContain('already applied this cycle');
    expect(paneB._html).not.toContain('Feed confirmed');

    // A's write is not lost: it went once, computed from A's own live document.
    expect(scenario.puts).toHaveLength(1);
    expect(scenario.puts[0].aggravated).toBe(1);              // A's 3 - 2, never B's 5
    expect(scenario.puts[0][AGG_HEALED_MARKER]).toBe(CYCLE_ID);

    // ...and A's own confirmation record really was stored, under A's key.
    scenario.holdPut = false;
    scenario.tracker = { character_id: charA._id, aggravated: 1, influence: 4, [AGG_HEALED_MARKER]: CYCLE_ID };
    const htmlA2 = await renderTab(charA);
    expect(htmlA2).toContain('Feed confirmed');
    expect(htmlA2).toContain('Agg −2');

    // B, meanwhile, still has its own healing to confirm.
    scenario.tracker = { character_id: charB._id, aggravated: 5, influence: 1 };
    const htmlB2 = await renderTab(charB);
    expect(htmlB2).toContain('data-agg-healed="2"');
    await pane.click('#feed-confirm-btn');
    expect(scenario.puts).toHaveLength(2);
    expect(scenario.puts[1].aggravated).toBe(3);              // B's own 5 - 2
  });

  it('files a confirmation begun in one cycle under THAT cycle, not the one that opened mid-write', async () => {
    setST(true);
    const char = newChar();
    scenario.story = storyFeedingBody({ aggHealed: 2 });
    scenario.tracker = { character_id: char._id, aggravated: 3, influence: 0 };

    await renderTab(char);
    const pane1 = pane;
    scenario.holdPut = true;
    const inFlight = pane1.click('#feed-confirm-btn');

    // The ST opens the next game's cycle while the write is in flight.
    scenario.cycle = CYCLE2;
    const html2 = await renderTab(char);
    const pane2 = pane;
    expect(html2).toContain('id="feed-confirm-btn"');

    scenario.releasePut();
    await inFlight;
    scenario.holdPut = false;

    // Cycle 2's own confirm controls survive: the cycle-1 record was keyed to
    // cycle 1, not to whatever was active when the response landed.
    expect(pane2._html).toBe(html2);
    expect(pane2._html).not.toContain('Feed confirmed');
    expect(pane2._html).toContain('id="feed-confirm-btn"');
    expect(scenario.puts).toHaveLength(1);
    expect(scenario.puts[0][AGG_HEALED_MARKER]).toBe(CYCLE_ID);

    // Back in cycle 1, the confirmation is remembered.
    scenario.cycle = CYCLE;
    scenario.tracker = { character_id: char._id, aggravated: 1, influence: 0, [AGG_HEALED_MARKER]: CYCLE_ID };
    expect(await renderTab(char)).toContain('Feed confirmed');

    // ...and cycle 2's own healing is still separately confirmable.
    scenario.cycle = CYCLE2;
    scenario.tracker = { character_id: char._id, aggravated: 1, influence: 0, [AGG_HEALED_MARKER]: CYCLE_ID };
    const html2b = await renderTab(char);
    expect(html2b).toContain('data-agg-healed="2"');
    await pane.click('#feed-confirm-btn');
    expect(scenario.puts).toHaveLength(2);
    expect(scenario.puts[1][AGG_HEALED_MARKER]).toBe(CYCLE2_ID);
  });
});

describe('review Medium: Number() is never asked to type-check a JSON value', () => {
  it('rejects a boolean, a nested array and an object among the dice', async () => {
    scenario.story = storyFeedingBody();
    scenario.story.feeding.rollResult.dice = [8, true, [8], { valueOf: () => 8 }, 3];
    const html = await renderTab(newChar());

    expect(html).toContain('Rolled in your downtime form');
    // Exactly the two real dice, and nothing coerced beside them: `Number(true)`
    // is 1 and `Number([8])` is 8, so the unguarded version rendered five.
    // The trailing [" ] excludes `.feeding-die-conn`, the stem element Story
    // 12.4's columns add between an exploded die and its child.
    expect(html.match(/class="feeding-die[" ]/g) || []).toHaveLength(2);
    expect(html).toContain('<span class="feeding-die feeding-die-hit">8</span>');
    expect(html).toContain('<span class="feeding-die">3</span>');
    // Was `not.toContain('fd-1')` - the 1 a boolean used to become. Story 12.4
    // dropped that class with the rest of the old dice skin, so the same intent
    // is now asserted directly: no die showing a 1 was rendered at all.
    expect(html).not.toContain('>1</span>');
  });

  it('rejects a boolean, a nested array and an object among the vessel vitae', async () => {
    scenario.story = storyFeedingBody({ vesselVitae: [2, true, [3], { a: 1 }, 1] });
    const html = await renderTab(newChar());

    // 2 + 1 only. Unguarded, `true` became a 1-vitae vessel and `[3]` a 3-vitae
    // one, for a fabricated total of 7 across four cards.
    expect(html.match(/class="vd-card"/g) || []).toHaveLength(2);
    expect(html).toContain('Total Vitae: <strong>3</strong>');
    expect(html).not.toContain('Vessel 3');
  });

  it.each([
    ['a boolean', true],
    ['a nested array', [7]],
    ['an object', { valueOf: () => 7 }],
  ])('does not report a pool size from %s', async (_label, pool) => {
    scenario.story = storyFeedingBody();
    scenario.story.feeding.rollResult.pool = pool;
    const html = await renderTab(newChar());

    expect(html).toContain('Rolled in your downtime form');
    expect(html).not.toContain('feeding-pool-total');   // no fabricated "1 dice"/"7 dice"
  });

  it('still accepts genuine numbers and clean numeric strings', async () => {
    scenario.story = storyFeedingBody({ vesselVitae: ['2', 1] });
    scenario.story.feeding.rollResult.dice = ['8', 3];
    scenario.story.feeding.rollResult.pool = '2';
    const html = await renderTab(newChar());

    expect(html.match(/class="feeding-die[" ]/g) || []).toHaveLength(2);
    expect(html).toContain('<span class="feeding-pool-total">2 dice</span>');
    expect(html).toContain('Total Vitae: <strong>3</strong>');
  });
});

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
