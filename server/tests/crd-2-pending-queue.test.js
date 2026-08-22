/**
 * crd.2 — Player-facing pending contested-roll queue (standalone).
 *
 * Coverage map:
 *   AC1 — tab-active-gated 10s poll against GET /api/contested_roll_requests/mine
 *   AC2 — row grammar: icon/type tag, challenger name, roll-type label, and an
 *         explicit per-row "which of MY characters is the target" label
 *   AC3 — resolved-but-recent transient row, gone on the next poll tick
 *   AC4 — challenge-notification.js's blocking modal is retired outright
 *   AC5 — the routing contract: goTab('contested-resolve', { challengeId })
 *   AC6 — the server's own GET /mine scoping is exercised, not re-implemented;
 *         the client adds NO filtering of its own
 *   AC7 — MORE_APPS 'player'-section entry with a live badge
 *   AC8 — this file
 *
 * TESTING APPROACH — stated explicitly per AC8's own instruction.
 * Neither `challenge-notification.js` nor `office-approvals.js` has any
 * behavioural client-side coverage today: `oaq-3-approval-queue.test.js` covers
 * office-approvals.js by SOURCE-TEXT assertion only (its own header says "no
 * browser harness in this repo"), and challenge-notification.js has none at all.
 * This file does NOT silently invent a new approach: it follows the ONE real
 * behavioural precedent this repo already has for driving a browser module in
 * Node — `dt-form-territory-fresh-fetch.test.js`, which vi.mock()s the
 * browser-only imports and drives the real module against a hand-rolled element
 * stub. There is no jsdom in this runner and adding one is a new dependency, so
 * the stub is deliberately minimal. Source-text assertions are used ONLY where
 * the thing under test is genuinely a source fact (a file's existence, a
 * registration in app.js, the absence of inline styles).
 *
 * The AC6 server half is a real Supertest request against the mounted app and
 * tm_game_test, matching crd.1's own established shape.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, playerUser } from './helpers/test-app.js';
import { setupDb, teardownDb, isDbAvailable } from './helpers/db-setup.js';
import { getCollection } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
function readFile(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
function fileExists(rel) { return fs.existsSync(path.join(REPO_ROOT, rel)); }

// ── Browser-only imports the queue module pulls in ──────────────────────────
// helpers.js reaches auth/discord.js -> localStorage, so it cannot be imported
// in Node. Same reason dt-form-territory-fresh-fetch.js mocks it.

vi.mock('../../public/js/data/api.js', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn().mockResolvedValue({}),
  apiPut: vi.fn().mockResolvedValue({}),
  apiPatch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../public/js/data/helpers.js', () => ({
  esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  displayName: c => c?.moniker || c?.name || '',
  redactCharName: s => s,
}));

const queue = await import('../../public/js/game/pending-queue.js');
const resolveScreen = await import('../../public/js/game/contested-resolve.js');
const apiModule = await import('../../public/js/data/api.js');

// ── Element stubs ───────────────────────────────────────────────────────────

/** Minimal stand-in for a `.tab` panel container. Supports exactly the surface
 *  the queue module uses: innerHTML, one delegated click listener, a
 *  [data-cq-body] lookup, and closest('.tab').classList.contains('active'). */
function makeRoot({ active = true } = {}) {
  let isActive = active;
  const body = { innerHTML: '' };
  const tab = { classList: { contains: c => c === 'active' && isActive } };
  const listeners = [];
  return {
    innerHTML: '',
    body,
    querySelector: sel => (sel === '[data-cq-body]' ? body : null),
    addEventListener: (type, fn) => listeners.push([type, fn]),
    closest: sel => (sel === '.tab' ? tab : null),
    setActive: v => { isActive = v; },
    listenerCount: () => listeners.length,
    click(target) { for (const [t, fn] of listeners) if (t === 'click') fn({ target }); },
  };
}

/** A click target that resolves to a row carrying `id`, or to nothing. */
function rowTarget(id) {
  return { closest: sel => (sel === '[data-cq-id]' && id ? { dataset: { cqId: id } } : null) };
}

const CHAR_A = { _id: '000000000000000000000a01', name: 'Yusuf Kalusicj' };
const CHAR_B = { _id: '000000000000000000000a02', name: 'Livia', moniker: 'The Whisper' };

function pendingDoc(overrides = {}) {
  return {
    _id: '000000000000000000000c01',
    request_type: 'contested_roll',
    status: 'pending',
    challenger_character_id: '000000000000000000000b01',
    challenger_character_name: 'Mammon',
    target_character_id: CHAR_A._id,
    target_character_name: 'Yusuf Kalusicj',
    roll_type: 'territory',
    challenger_pool: 6,
    created_at: '2026-08-22T10:11:12.345Z',
    updated_at: '2026-08-22T10:11:12.345Z',
    ...overrides,
  };
}

let root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  globalThis.window = { goTab: vi.fn() };
  root = makeRoot();
});

afterEach(() => {
  queue.stopPendingQueue();
  vi.useRealTimers();
  delete globalThis.window;
});

/** Drive one full init + first fetch to completion. */
async function mount(rows, chars = [CHAR_A], onQueueChange) {
  apiModule.apiGet.mockResolvedValue(rows);
  await queue.initPendingQueue(root, chars, onQueueChange);
}

/** Advance one poll interval and let the fetch settle. */
async function tick(rows) {
  if (rows !== undefined) apiModule.apiGet.mockResolvedValue(rows);
  await vi.advanceTimersByTimeAsync(queue.POLL_MS);
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — polling, and its tab-active gate
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 AC1 — tab-active-gated 10s poll', () => {
  it('polls GET /api/contested_roll_requests/mine, at 10s, the same POLL_MS the rest of this family uses', async () => {
    await mount([]);
    expect(queue.POLL_MS).toBe(10_000);
    expect(apiModule.apiGet).toHaveBeenCalledWith('/api/contested_roll_requests/mine');
    expect(apiModule.apiGet).toHaveBeenCalledTimes(1);
  });

  it('keeps polling while the containing tab is active', async () => {
    await mount([]);
    await tick();
    await tick();
    expect(apiModule.apiGet).toHaveBeenCalledTimes(3);
  });

  it('does NOT fetch on a tick while the containing tab is not active', async () => {
    await mount([]);
    root.setActive(false);
    await tick();
    await tick();
    expect(apiModule.apiGet, 'no network while the player is not looking at the queue').toHaveBeenCalledTimes(1);
  });

  it('resumes polling when the tab becomes active again', async () => {
    await mount([]);
    root.setActive(false);
    await tick();
    root.setActive(true);
    await tick();
    expect(apiModule.apiGet).toHaveBeenCalledTimes(2);
  });

  it('binds exactly one delegated click listener, at scaffold time, not per render (project convention)', async () => {
    await mount([pendingDoc()]);
    await tick([pendingDoc()]);
    await tick([pendingDoc()]);
    expect(root.listenerCount()).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — row grammar, including the multi-character target label
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 AC2 — row rendering', () => {
  it('renders the challenger name and the roll-type LABEL (not the raw enum value)', async () => {
    await mount([pendingDoc({ roll_type: 'social' })]);
    expect(root.body.innerHTML).toContain('Mammon');
    expect(root.body.innerHTML).toContain('Social Manoeuvre');
  });

  it('carries a type tag and an icon on every row', async () => {
    await mount([pendingDoc()]);
    expect(root.body.innerHTML).toMatch(/class="dtl-badge"/);
    expect(root.body.innerHTML).toMatch(/cq-row-icon/);
    expect(root.body.innerHTML).toMatch(/<svg/);
  });

  it('labels WHICH of the player\'s own characters is the target, resolved from the real character list', async () => {
    await mount([pendingDoc()], [CHAR_A, CHAR_B]);
    expect(root.body.innerHTML).toContain('Yusuf Kalusicj');
    expect(root.body.innerHTML).toMatch(/cq-target/);
  });

  it('MULTI-CHARACTER: two pending challenges against two different characters of the SAME player each carry their own target label', async () => {
    await mount(
      [
        pendingDoc({ _id: 'c1', target_character_id: CHAR_A._id, target_character_name: 'Yusuf Kalusicj' }),
        pendingDoc({ _id: 'c2', target_character_id: CHAR_B._id, target_character_name: 'Livia', challenger_character_name: 'Ludica' }),
      ],
      [CHAR_A, CHAR_B],
    );
    const html = root.body.innerHTML;
    // Neither row may be dropped, and neither may borrow the other's label —
    // the `.find()`-takes-the-first-match pattern app.js uses elsewhere would
    // silently lose one of these.
    expect(html).toContain('Yusuf Kalusicj');
    expect(html).toContain('The Whisper');   // CHAR_B's moniker wins over its name, per displayName()
    expect(html.match(/cq-target/g) || []).toHaveLength(2);
  });

  it('falls back to the document\'s own target_character_name when the character is not in the local list', async () => {
    await mount([pendingDoc({ target_character_id: 'not-mine', target_character_name: 'Someone Else' })], [CHAR_A]);
    expect(root.body.innerHTML).toContain('Someone Else');
  });

  it('escapes challenger and character names (they are stored strings, not trusted markup)', async () => {
    await mount([pendingDoc({ challenger_character_name: '<img src=x onerror=1>' })]);
    expect(root.body.innerHTML).not.toContain('<img src=x');
    expect(root.body.innerHTML).toContain('&lt;img');
  });

  it('renders a calm empty state, never a bare blank panel', async () => {
    await mount([]);
    expect(root.body.innerHTML).toMatch(/No pending challenges/i);
  });

  it('a FAILED fetch never renders as "nothing pending" (the false all-clear office-approvals.js was patched for)', async () => {
    apiModule.apiGet.mockRejectedValue(new Error('network down'));
    await queue.initPendingQueue(root, [CHAR_A]);
    expect(root.body.innerHTML).not.toMatch(/No pending challenges/i);
    expect(root.body.innerHTML).toMatch(/could not load/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — resolved-but-recent
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 AC3 — resolved-but-recent row', () => {
  it('a row that leaves the pending set shows a brief resolved state instead of vanishing instantly', async () => {
    await mount([pendingDoc({ _id: 'c1' }), pendingDoc({ _id: 'c2', challenger_character_name: 'Ludica' })]);
    await tick([pendingDoc({ _id: 'c2', challenger_character_name: 'Ludica' })]);
    expect(root.body.innerHTML).toContain('Mammon');
    expect(root.body.innerHTML).toMatch(/cq-row-resolved/);
    expect(root.body.innerHTML).toMatch(/Resolved/);
  });

  it('and is gone on the NEXT poll tick', async () => {
    await mount([pendingDoc({ _id: 'c1' }), pendingDoc({ _id: 'c2', challenger_character_name: 'Ludica' })]);
    await tick([pendingDoc({ _id: 'c2', challenger_character_name: 'Ludica' })]);
    await tick([pendingDoc({ _id: 'c2', challenger_character_name: 'Ludica' })]);
    expect(root.body.innerHTML).not.toContain('Mammon');
    expect(root.body.innerHTML).not.toMatch(/cq-row-resolved/);
    expect(root.body.innerHTML).toContain('Ludica');
  });

  it('a resolved row is NOT tappable — it carries no challenge id for the router to pick up', async () => {
    await mount([pendingDoc({ _id: 'c1' })]);
    await tick([]);
    expect(root.body.innerHTML).toMatch(/cq-row-resolved/);
    expect(root.body.innerHTML).not.toMatch(/data-cq-id="c1"/);
  });

  it('a failed poll does not fabricate resolutions — rows survive a network blip', async () => {
    await mount([pendingDoc({ _id: 'c1' })]);
    apiModule.apiGet.mockRejectedValue(new Error('network down'));
    await tick();
    expect(root.body.innerHTML).toContain('Mammon');
    expect(root.body.innerHTML).not.toMatch(/cq-row-resolved/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Code-review round (2026-08-22, external Codex review)
// specs/stories/code-review/crd-2-codex-findings.md
//
// Two Medium/Low findings that are real defects in THIS module, patched here:
//   [Pass 2] "Queue poll results never recompute the shared More badge"
//   [Pass 1] "A failed poll extends a resolved row beyond the promised one tick"
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 review — the shared More badge is recomputed after the queue\'s own poll', () => {
  it('invokes the injected badge-refresh callback when a poll EMPTIES the pending set', async () => {
    const onQueueChange = vi.fn();
    await mount([pendingDoc({ _id: 'c1' })], [CHAR_A], onQueueChange);
    onQueueChange.mockClear();

    await tick([]);

    // Without this the shared #more-badge stays visibly lit after the queue
    // empties: checkMoreBadge() has no call site the queue's own poll reaches.
    expect(onQueueChange, 'the queue emptied while the player watched; the shared badge must be told').toHaveBeenCalled();
    expect(queue.hasPendingChallenges()).toBe(false);
  });

  it('invokes it in the other direction too — a poll that DISCOVERS new pending work', async () => {
    const onQueueChange = vi.fn();
    await mount([], [CHAR_A], onQueueChange);
    onQueueChange.mockClear();

    await tick([pendingDoc({ _id: 'c9' })]);

    expect(onQueueChange, 'new pending work arrived; the shared badge must be told').toHaveBeenCalled();
    expect(queue.hasPendingChallenges()).toBe(true);
  });

  it('does NOT churn the badge on a poll that changed nothing (the epic\'s resource-conscious principle)', async () => {
    const onQueueChange = vi.fn();
    await mount([pendingDoc({ _id: 'c1' })], [CHAR_A], onQueueChange);
    onQueueChange.mockClear();

    await tick([pendingDoc({ _id: 'c1' })]);

    expect(onQueueChange).not.toHaveBeenCalled();
  });

  it('does NOT fire on a FAILED poll — a network blip is not a change to the pending set', async () => {
    const onQueueChange = vi.fn();
    await mount([pendingDoc({ _id: 'c1' })], [CHAR_A], onQueueChange);
    onQueueChange.mockClear();

    apiModule.apiGet.mockRejectedValue(new Error('network down'));
    await tick();

    expect(onQueueChange).not.toHaveBeenCalled();
  });

  it('a throwing callback never breaks the poll loop', async () => {
    const onQueueChange = vi.fn(() => { throw new Error('badge blew up'); });
    await mount([], [CHAR_A], onQueueChange);
    await tick([pendingDoc({ _id: 'c1' })]);
    await tick([]);
    expect(root.body.innerHTML).toMatch(/cq-row-resolved/);
  });

  it('app.js wires checkMoreBadge() in as the queue\'s badge-refresh callback at the goTab call site', () => {
    const src = readFile('public/js/app.js');
    expect(src).toMatch(/initPendingQueue\([^)]*checkMoreBadge[^)]*\)/);
  });
});

describe('crd.2 review — a failed poll does not hold a stale Resolved row', () => {
  it('drops the one-tick Resolved row when the NEXT poll fails, rather than holding it indefinitely', async () => {
    await mount([pendingDoc({ _id: 'c1' }), pendingDoc({ _id: 'c2', challenger_character_name: 'Ludica' })]);
    await tick([pendingDoc({ _id: 'c2', challenger_character_name: 'Ludica' })]);
    expect(root.body.innerHTML, 'precondition: the departed row is showing its one tick').toMatch(/cq-row-resolved/);

    apiModule.apiGet.mockRejectedValue(new Error('network down'));
    await tick();

    // The "one tick" promise is about the tick immediately following the
    // successful fetch that detected the departure. A failing fetch is not that
    // tick, and holding the row through any number of consecutive failures is
    // stale UI the module's own comment says it does not do.
    expect(root.body.innerHTML, 'the resolved row must not survive a failed poll').not.toMatch(/cq-row-resolved/);
    expect(root.body.innerHTML, 'still-pending rows survive the blip, as before').toContain('Ludica');
  });

  it('holds nothing across a RUN of consecutive failures either', async () => {
    await mount([pendingDoc({ _id: 'c1' })]);
    await tick([]);
    expect(root.body.innerHTML).toMatch(/cq-row-resolved/);

    apiModule.apiGet.mockRejectedValue(new Error('still down'));
    await tick();
    await tick();
    await tick();

    expect(root.body.innerHTML).not.toMatch(/cq-row-resolved/);
    expect(root.body.innerHTML).toMatch(/could not load/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 — the routing contract
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 AC5 — routing contract', () => {
  it('tapping a row navigates to the resolution destination carrying THAT challenge\'s own id', async () => {
    await mount([pendingDoc({ _id: 'c1' }), pendingDoc({ _id: 'c2' })]);
    root.click(rowTarget('c2'));
    expect(globalThis.window.goTab).toHaveBeenCalledWith('contested-resolve', { challengeId: 'c2' });
  });

  it('a click that lands outside any row routes nowhere', async () => {
    await mount([pendingDoc({ _id: 'c1' })]);
    root.click(rowTarget(null));
    expect(globalThis.window.goTab).not.toHaveBeenCalled();
  });

  it('every pending row carries its own id in the markup, so the contract is per-challenge, not "the pending list in general"', async () => {
    await mount([pendingDoc({ _id: 'c1' }), pendingDoc({ _id: 'c2' })]);
    expect(root.body.innerHTML).toMatch(/data-cq-id="c1"/);
    expect(root.body.innerHTML).toMatch(/data-cq-id="c2"/);
  });

  it('goTab() accepts and forwards a context payload, and dispatches contested-resolve with it', () => {
    const src = readFile('public/js/app.js');
    expect(src).toMatch(/function goTab\(t,\s*ctx\)/);
    expect(src).toMatch(/t === 'contested-resolve'/);
    expect(src).toMatch(/initContestedResolve\(/);
  });

  it('index.html declares both tab panels the contract needs', () => {
    const src = readFile('public/index.html');
    expect(src).toMatch(/<div id="t-contested-queue" class="tab">/);
    expect(src).toMatch(/<div id="t-contested-resolve" class="tab">/);
  });

  it('the placeholder destination is honestly labelled as incomplete and names the challenge it was opened for', () => {
    const resolveRoot = makeRoot();
    resolveScreen.initContestedResolve(resolveRoot, { challengeId: 'c9' });
    expect(resolveRoot.innerHTML).toMatch(/coming soon/i);
    expect(resolveRoot.innerHTML).toContain('c9');
  });

  it('the placeholder renders a real, honest state even with no context id at all', () => {
    const resolveRoot = makeRoot();
    resolveScreen.initContestedResolve(resolveRoot, undefined);
    expect(resolveRoot.innerHTML.length).toBeGreaterThan(0);
    expect(resolveRoot.innerHTML).toMatch(/coming soon/i);
  });

  it('the placeholder builds NO part of crd.3b\'s pool builder (no aspect control, no Willpower toggle, no merit chips)', () => {
    const src = readFile('public/js/game/contested-resolve.js');
    expect(src).not.toMatch(/defender_aspect/);
    expect(src).not.toMatch(/defender_wp_spent/);
    expect(src).not.toMatch(/defender_merit_ids/);
    expect(src).not.toMatch(/\/resolve/);
    expect(src).not.toMatch(/apiPut|apiPost/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 — server-side scoping is exercised, not re-implemented
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 AC6 (client half) — no client-side filtering of its own', () => {
  it('renders exactly what GET /mine returned, including a row the client could not have matched locally', async () => {
    // If this module ever grew its own `filter(r => myCharIds.includes(...))`,
    // it would diverge silently from the server the moment the two disagree.
    // The server is the only authority on what belongs in this queue.
    await mount(
      [
        pendingDoc({ _id: 'c1', target_character_id: CHAR_A._id }),
        pendingDoc({ _id: 'c2', target_character_id: 'a-character-this-client-has-not-loaded', target_character_name: 'Unloaded Char', challenger_character_name: 'Ludica' }),
      ],
      [CHAR_A],
    );
    expect(root.body.innerHTML).toContain('Mammon');
    expect(root.body.innerHTML).toContain('Ludica');
    expect(root.body.innerHTML).toContain('Unloaded Char');
  });

  it('the module source contains no character-id filter over the fetched rows', () => {
    const src = readFile('public/js/game/pending-queue.js');
    expect(src).not.toMatch(/character_ids/);
    expect(src).not.toMatch(/getPlayerInfo/);
  });
});

const dbAvailable = await isDbAvailable();
let app;
const PREFIX = 'CRD-2 Probe';

describe.skipIf(!dbAvailable)('crd.2 AC6 (server half) — GET /mine only ever returns the caller\'s own targets', () => {
  beforeAll(async () => {
    await setupDb();
    app = createTestApp();
    await getCollection('contested_roll_requests').deleteMany({ challenger_character_name: { $regex: `^${PREFIX}` } });
  });

  afterAll(async () => {
    await getCollection('contested_roll_requests').deleteMany({ challenger_character_name: { $regex: `^${PREFIX}` } });
    await teardownDb();
  });

  it('returns a request targeting the caller\'s character and withholds one targeting somebody else', async () => {
    const mine = '000000000000000000000c91';
    const theirs = '000000000000000000000c92';
    await getCollection('contested_roll_requests').insertMany([
      {
        request_type: 'contested_roll', status: 'pending', outcome: null,
        challenger_character_id: '000000000000000000000c99',
        challenger_character_name: `${PREFIX} Challenger`,
        target_character_id: mine, target_character_name: `${PREFIX} Mine`,
        roll_type: 'territory', challenger_pool: 5,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
      {
        request_type: 'contested_roll', status: 'pending', outcome: null,
        challenger_character_id: '000000000000000000000c99',
        challenger_character_name: `${PREFIX} Challenger`,
        target_character_id: theirs, target_character_name: `${PREFIX} Theirs`,
        roll_type: 'territory', challenger_pool: 5,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    ]);

    const res = await request(app)
      .get('/api/contested_roll_requests/mine')
      .set('X-Test-User', playerUser([mine]));

    expect(res.status).toBe(200);
    const ours = res.body.filter(r => String(r.challenger_character_name || '').startsWith(PREFIX));
    expect(ours).toHaveLength(1);
    expect(ours[0].target_character_id).toBe(mine);
  });

  it('MULTI-CHARACTER: a player with two characters gets the pending requests for BOTH', async () => {
    const c1 = '000000000000000000000c93';
    const c2 = '000000000000000000000c94';
    await getCollection('contested_roll_requests').insertMany([c1, c2].map(t => ({
      request_type: 'contested_roll', status: 'pending', outcome: null,
      challenger_character_id: '000000000000000000000c99',
      challenger_character_name: `${PREFIX} Multi`,
      target_character_id: t, target_character_name: `${PREFIX} T-${t}`,
      roll_type: 'social', challenger_pool: 4,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })));

    const res = await request(app)
      .get('/api/contested_roll_requests/mine')
      .set('X-Test-User', playerUser([c1, c2]));

    expect(res.status).toBe(200);
    const ours = res.body.filter(r => String(r.challenger_character_name || '') === `${PREFIX} Multi`);
    expect(ours.map(r => r.target_character_id).sort()).toEqual([c1, c2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7 — MORE_APPS registration + live badge
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 AC7 — badge', () => {
  it('is false before anything has been fetched', () => {
    expect(queue.hasPendingChallenges()).toBe(false);
  });

  it('goes true after the boot-time badge refresh finds pending challenges, without the queue tab ever being opened', async () => {
    apiModule.apiGet.mockResolvedValue([pendingDoc()]);
    await queue.refreshPendingQueueBadge();
    expect(queue.hasPendingChallenges()).toBe(true);
    expect(queue.pendingChallengeCount()).toBe(1);
  });

  it('goes false again when the queue empties', async () => {
    apiModule.apiGet.mockResolvedValue([pendingDoc()]);
    await queue.refreshPendingQueueBadge();
    apiModule.apiGet.mockResolvedValue([]);
    await queue.refreshPendingQueueBadge();
    expect(queue.hasPendingChallenges()).toBe(false);
  });

  it('returns a plain boolean — renderMoreGrid()\'s appIcon() only ever truth-tests it', async () => {
    apiModule.apiGet.mockResolvedValue([pendingDoc()]);
    await queue.refreshPendingQueueBadge();
    expect(typeof queue.hasPendingChallenges()).toBe('boolean');
  });

  it('a failed badge refresh does not clear a previously-known pending state', async () => {
    apiModule.apiGet.mockResolvedValue([pendingDoc()]);
    await queue.refreshPendingQueueBadge();
    apiModule.apiGet.mockRejectedValue(new Error('offline'));
    await queue.refreshPendingQueueBadge();
    expect(queue.hasPendingChallenges()).toBe(true);
  });

  it('app.js registers the queue in MORE_APPS\'s player section with a live badge callback', () => {
    const src = readFile('public/js/app.js');
    expect(src).toMatch(/id:\s*'contested-queue'[\s\S]{0,400}?section:\s*'player'/);
    expect(src).toMatch(/badge:\s*\(\)\s*=>\s*hasPendingChallenges\(\)/);
  });

  it('app.js does NOT add a NAV_ITEMS bottom-bar tile for it (MORE_APPS only, per the story)', () => {
    const src = readFile('public/js/app.js');
    expect(src).not.toMatch(/goTab:\s*'contested-queue'/);
  });

  it('the boot path refreshes the badge for players instead of starting the old modal poller', () => {
    const src = readFile('public/js/app.js');
    expect(src).toMatch(/getRole\(\)\s*!==\s*'st'\)\s*refreshPendingQueueBadge\(\)/);
  });

  it('the shared #more-badge still reflects a pending challenge, so the entry point players already use does not go quiet', () => {
    const src = readFile('public/js/app.js');
    expect(src).toMatch(/hasPendingChallenges\(\)/);
    expect(src).toMatch(/function checkMoreBadge/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — the blocking modal is retired outright
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 AC4 — challenge-notification.js retired', () => {
  it('the module file is gone, not left dead in the tree (this project deletes superseded client modules)', () => {
    expect(fileExists('public/js/game/challenge-notification.js')).toBe(false);
  });

  it('app.js no longer imports or calls startChallengePoller/stopChallengePoller', () => {
    const src = readFile('public/js/app.js');
    expect(src).not.toMatch(/startChallengePoller/);
    expect(src).not.toMatch(/stopChallengePoller/);
    expect(src).not.toMatch(/challenge-notification/);
  });

  it('no other client module still references it', () => {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    })(path.join(REPO_ROOT, 'public', 'js'));
    const offenders = files.filter(f => /startChallengePoller|stopChallengePoller|challenge-notification\.js/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map(f => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('the new queue is the sole client consumer of GET /mine', () => {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    })(path.join(REPO_ROOT, 'public', 'js'));
    const consumers = files
      .filter(f => fs.readFileSync(f, 'utf8').includes('/api/contested_roll_requests/mine'))
      .map(f => path.relative(REPO_ROOT, f).replace(/\\/g, '/'));
    expect(consumers).toEqual(['public/js/game/pending-queue.js']);
  });

  it('challenge-initiation.js (the attacker side, Finding 3) is deliberately untouched and still present', () => {
    expect(fileExists('public/js/game/challenge-initiation.js')).toBe(true);
    const src = readFile('public/js/game/challenge-initiation.js');
    expect(src).toMatch(/chi-def-pool/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CSS discipline (specs/project-context.md §1 — mandatory, not optional)
// ═══════════════════════════════════════════════════════════════════════════

describe('crd.2 — design-system compliance', () => {
  const modules = ['public/js/game/pending-queue.js', 'public/js/game/contested-resolve.js'];

  it.each(modules)('%s writes no inline style attribute, bare hex, or rgba()', rel => {
    const src = readFile(rel);
    expect(src).not.toMatch(/style="/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(src).not.toMatch(/rgba?\(/);
  });

  it('every new cq- class it emits is defined in a real stylesheet', () => {
    const css = readFile('public/css/suite.css') + readFile('public/css/components.css');
    const src = modules.map(readFile).join('\n');
    const used = new Set();
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (c.startsWith('cq-')) used.add(c);
    }
    expect(used.size, 'the modules must actually emit their own cq- classes').toBeGreaterThan(0);
    const missing = [...used].filter(c => !css.includes('.' + c));
    expect(missing).toEqual([]);
  });

  it('the new CSS uses tokens only — no literal colour in any cq- rule body', () => {
    const css = readFile('public/css/suite.css');
    const cqRules = css.split('\n').filter(l => /^\s*\.cq-/.test(l) || /,\s*\.cq-/.test(l));
    expect(cqRules.length, 'the cq- rules must actually exist in suite.css').toBeGreaterThan(0);
    for (const line of cqRules) {
      expect(line, line).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(line, line).not.toMatch(/rgba?\(/);
    }
  });

  /* Code-review round: the ONLY thing this can honestly assert is the source
     fact that a phone breakpoint for these rows exists at all. The real proof
     that it stops the clipping is a measured one (row.scrollWidth vs
     row.clientWidth at 390px in a real Chromium), which this runner has no
     browser to do — that measurement was run against a temporary Playwright
     spec and is recorded in the story's Senior Developer Review. This test is
     the regression tripwire, not the proof. */
  it('a phone-width breakpoint for the queue row exists (Codex "row metadata is clipped on phone widths")', () => {
    const css = readFile('public/css/suite.css');
    const phoneBlocks = css.match(/@media\s*\(max-width:\s*599px\)\s*\{[\s\S]*?\n\}/g) || [];
    expect(phoneBlocks.some(b => b.includes('.cq-row')), 'no ≤599px rule for .cq-row in suite.css').toBe(true);
  });

  it('reuses the existing queue chrome rather than forking a second row style', () => {
    const src = readFile('public/js/game/pending-queue.js');
    expect(src).toMatch(/stm-audit-root/);
    expect(src).toMatch(/oaq-queue-list/);
    expect(src).toMatch(/dtl-badge/);
  });

  it('shares no code with the ST-facing office-approvals.js (epic-crd Decision 3: standalone module)', () => {
    const src = readFile('public/js/game/pending-queue.js');
    expect(src).not.toMatch(/office-approvals/);
    expect(src).not.toMatch(/office_actions/);
  });

  it('uses British English in its player-facing copy, and no em-dashes in rendered output', async () => {
    const src = modules.map(readFile).join('\n');
    expect(src).not.toMatch(/\bManeuver/i);
    expect(src).not.toMatch(/\bCanceled\b/);

    // Rendered output only — the no-em-dash rule is about app-authored strings,
    // not source comments (this repo's own comments use them throughout).
    const uiRoot = makeRoot();
    apiModule.apiGet.mockResolvedValue([pendingDoc({ roll_type: 'social' })]);
    await queue.initPendingQueue(uiRoot, [CHAR_A]);
    const resolveRoot = makeRoot();
    resolveScreen.initContestedResolve(resolveRoot, { challengeId: 'c9' });
    const rendered = uiRoot.innerHTML + uiRoot.body.innerHTML + resolveRoot.innerHTML;
    expect(rendered).not.toMatch(/—/);

    // Empty state too.
    apiModule.apiGet.mockResolvedValue([]);
    const emptyRoot = makeRoot();
    await queue.initPendingQueue(emptyRoot, [CHAR_A]);
    expect(emptyRoot.innerHTML + emptyRoot.body.innerHTML).not.toMatch(/—/);
  });
});
