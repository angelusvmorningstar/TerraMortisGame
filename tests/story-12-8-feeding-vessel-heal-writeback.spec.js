/**
 * Story 12.8 - vessel-feed + vitae-heal write-back, and automatic tracker_state
 * application.
 *
 * Covers TM Game's client half. Each test is named for the AC whose own
 * "Observable" line it is written against:
 *
 *   AC 9    the tracker application is a RECONCILIATION (fires from a bare tab
 *           load, no click), it does not fire twice, and — CHANGED 2026-09-14,
 *           Angelus's own standing rule ("Vitae does not carry over from game to
 *           game... always 0 before feeding... this overwrites the CURRENT vitae
 *           amount") — it is a CLAMPED ABSOLUTE SET, not a delta-add: whatever
 *           Vitae is already on the tracker plays no part in the write at all
 *   AC 9a   the healing budget rendered is the SERVER'S derived `fedTotal`, not
 *           the client's vessel-only sum (a Barrens feed is the discriminator)
 *   AC 9b   the un-gate: a real, reachable Save control that POSTs for real;
 *           write-once, so it never comes back; and the zero-success feed the
 *           `successes <= 0` removal makes reachable
 *   AC 10   ONE marker gates both halves - a marker already set suppresses the
 *           whole application, not just the Aggravated part of it
 *   AC 11   the write is keyed by character id and unconditional on view state
 *   AC 12   a failed tracker read is fail-closed and surfaced, never silent
 *   AC 14   the ST-confirm panel respects an auto-applied feed in its RENDER and
 *           in its HANDLER
 *
 * AC 13 (the server-side clamp and the post-clamp WebSocket broadcast) is a
 * server test, not a browser one: `server/tests/api-tracker-state-clamp.test.js`.
 *
 * Harness conventions are Story 12.7's own (`story-12-7-feeding-write-back.spec.js`),
 * including the CORS-carrying TM Story routes - without those headers a fulfilled
 * cross-origin response is blocked by the browser and every test silently falls
 * through to the residual state machine.
 */

const { test, expect } = require('@playwright/test');

const PLAYER_USER = {
  id: '777000128', username: 'test_player128', global_name: 'Pike Test',
  avatar: null, role: 'player', player_id: 'p-128',
  character_ids: ['char-128'], is_dual_role: false,
};

const ST_USER = { ...PLAYER_USER, id: '777000129', username: 'test_st129', role: 'st' };

const GAME_CYCLE = {
  _id: 'cycle-128', phase: 'game', status: 'game', game_number: 8, label: 'Game 8',
  feeding_rights_confirmed: true, is_chapter_finale: false,
  created_at: '2026-09-01T00:00:00.000Z',
};

const TEMPLATES = [
  { key: 'stalking', name: 'Stalking', desc: 'Prey on a target unseen', attrs: ['Dexterity', 'Wits'], skills: ['Stealth', 'Streetwise'], discs: ['Protean', 'Obfuscate'], violence_default: null, sort_order: 1 },
];

function buildChar(overrides = {}) {
  return {
    _id: 'char-128', name: 'Samuel Pike', moniker: null, honorific: null,
    clan: 'Gangrel', covenant: 'Invictus', player: 'Test Player',
    // Blood Potency 2 -> calcVitaeMax 11 (accessors.js BP_TABLE). Every delta
    // assertion below is chosen to sit under that ceiling except the one that
    // deliberately tests it.
    blood_potency: 2, humanity: 7, humanity_base: 7, court_title: null, retired: false,
    status: {
      city: 1, clan: 1,
      covenant: { 'Carthian Movement': 0, 'Circle of the Crone': 0, 'Invictus': 1, 'Lancea et Sanctum': 0, 'Ordo Dracul': 0 },
    },
    attributes: {
      Intelligence: { dots: 2, bonus: 0 }, Wits: { dots: 2, bonus: 0 }, Resolve: { dots: 2, bonus: 0 },
      Strength: { dots: 2, bonus: 0 }, Dexterity: { dots: 3, bonus: 0 }, Stamina: { dots: 2, bonus: 0 },
      Presence: { dots: 2, bonus: 0 }, Manipulation: { dots: 2, bonus: 0 }, Composure: { dots: 2, bonus: 0 },
    },
    skills: { Stealth: { dots: 2, bonus: 0, specs: [] } },
    disciplines: { Protean: { dots: 2 } },
    merits: [], powers: [], ordeals: [],
    ...overrides,
  };
}

/** `content.feeding` as TM Story really stores it. */
function feedingDoc(overrides = {}) {
  return {
    territory: { id: 'terr-1', label: 'The Docks' },
    method: 'stalking',
    poolAttr: 'Dexterity', poolSkill: 'Stealth', poolDisc: 'Protean',
    poolSpecChip: null,
    bloodType: 'Human', violence: 'kiss', violencePreset: false,
    description: 'Follows them home.',
    rollResult: null, vesselVitae: [], poolLocked: false, aggHealed: 0,
    ...overrides,
  };
}

function rollResultDoc(overrides = {}) {
  return {
    pool: 7, chance: false, dice: [2, 8, 5, 9, 3, 10, 4],
    successes: 3, exceptional: false, dramatic_failure: false,
    rote: false, again: 10, signature: '{}',
    ...overrides,
  };
}

const MARKER = 'feeding_agg_healed_cycle_id';

/**
 * Mock every route the tab touches, and RECORD the tracker writes.
 *
 * `tracker` is the GET body (or null for a 404, the "no document yet" case).
 * `fedTotal` is what the declaration route answers with (AC 9a); pass null to
 * simulate a route that answered without one.
 */
async function setupRoutes(page, {
  char = null, story = null, templates = TEMPLATES, tracker = null,
  fedTotal = 0, trackerReadFails = false, user = PLAYER_USER, hooks = {},
} = {}) {
  const calls = { trackerPuts: [], declarationPosts: [], feedingReads: 0 };

  await page.route('**/api/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/auth/me', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) }));
  await page.route(/\/api\/characters(\?.*)?$/, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([char || buildChar()]) }));
  await page.route('**/api/chapters*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([GAME_CYCLE]) }));
  await page.route('**/api/territories*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/tracker_state/*', r => {
    if (r.request().method() !== 'GET') {
      calls.trackerPuts.push({
        url: r.request().url(),
        body: JSON.parse(r.request().postData() || '{}'),
      });
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    // A read FAILURE is not a 404: 404 means "no document yet, so defaults are
    // the true answer", which the tab treats as known state. A 500 is the real
    // "unknown" case AC 12 is about.
    if (trackerReadFails) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    if (!tracker) return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tracker) });
  });
  await page.route('**/api/downtime_submissions**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
  const storyRoute = (glob, handler) => page.route(glob, async r => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    return handler(r);
  });
  const storyJson = (r, status, obj) => r.fulfill({
    status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
  });

  await storyRoute('**/api/wiki/v1/downtime/feeding-templates', r => storyJson(r, 200, { templates }));
  await storyRoute('**/api/wiki/v1/downtime/submissions/*/*/previous', r => storyJson(r, 200, { previous: null }));
  await storyRoute('**/api/wiki/v1/downtime/submissions/*/*/feeding/roll', r => storyJson(r, 200, { ok: true }));
  await storyRoute('**/api/wiki/v1/downtime/submissions/*/*/feeding/declaration', async r => {
    calls.declarationPosts.push(JSON.parse(r.request().postData() || '{}'));
    if (hooks.onDeclaration) await hooks.onDeclaration();
    if (hooks.declarationResponse) {
      return storyJson(r, hooks.declarationResponse.status, hooks.declarationResponse.body);
    }
    return storyJson(r, 200, fedTotal === null ? { ok: true } : { ok: true, fedTotal });
  });
  await storyRoute('**/api/wiki/v1/downtime/submissions/*/*/feeding', r => {
    calls.feedingReads += 1;
    const body = typeof hooks.storyBody === 'function' ? hooks.storyBody(calls.feedingReads) : story;
    if (body === 'unreachable') return r.abort('failed');
    if (body === 'missing') return storyJson(r, 404, { error: 'not_found', message: 'no' });
    return storyJson(r, 200, { feeding: body, territory_influence: null, lifecycle_state: 'final', status: null });
  });

  await page.addInitScript((u) => {
    localStorage.setItem('tm_auth_token', 'fake-test-token');
    localStorage.setItem('tm_auth_expires', String(Date.now() + 36000000));
    localStorage.setItem('tm_auth_user', JSON.stringify(u));
  }, user);

  return calls;
}

/**
 * `awaitRender: false` starts the render WITHOUT waiting for it to settle.
 * `renderFeedingTab` now awaits the reconciliation (AC 9) before it resolves, so
 * the default form of this helper always returns AFTER the tracker application
 * has completed and redrawn - which is what every other test here wants, and
 * exactly what the AC 14 handler test must not have.
 */
async function openFeedingSandbox(page, char, theme = 'dark', { awaitRender = true } = {}) {
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  if (process.env.TM_DEBUG) {
    page.on('console', m => console.log('PAGE:', m.type(), m.text()));
    page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  }
  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
  await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
  await page.evaluate(async ({ c, awaitRender }) => {
    const pane = document.getElementById('t-feeding');
    pane.style.cssText = 'display:block;position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;overflow:auto;';
    pane.classList.add('active');
    const { renderFeedingTab } = await import('/js/tabs/feeding-tab.js');
    window.__renderFeedingTab = renderFeedingTab;
    const p = renderFeedingTab(pane, c);
    if (awaitRender) await p;
  }, { c: char, awaitRender });
  if (awaitRender) await page.waitForTimeout(700);
  const sb = page.locator('#t-feeding');
  sb.__consoleErrors = consoleErrors;
  return sb;
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('Story 12.8 - AC 9b: the un-gate, and write-once', () => {

  test('a resolved, unrecorded feed renders a real Save control that POSTs for real', async ({ page }) => {
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }) }),
      tracker: { vitae: 1, willpower: 5, influence: 3, aggravated: 0 },
      fedTotal: 5,
    });
    const sb = await openFeedingSandbox(page, buildChar());

    const save = sb.locator('[data-feeding-declare]');
    await expect(save).toHaveCount(1);
    await expect(save).toHaveText('Save Vessel Feed');
    // The editable vessel strip is genuinely back: buttons, not spans.
    await expect(sb.locator('.feeding-story-flow button.vd-box')).toHaveCount(14);

    // Draw 3 from vessel 1, then save.
    await sb.locator('.vd-boxes[data-vessel-idx="0"] button.vd-box').nth(2).click();
    await expect(sb.locator('.vd-summary')).toContainText('Total vitae drawn: 3');
    await save.click();
    await page.waitForTimeout(700);

    expect(calls.declarationPosts).toHaveLength(1);
    expect(calls.declarationPosts[0]).toEqual({ vesselVitae: [3, 0], aggHealed: 0 });
  });

  test('once a declaration is on file the Save control does not reappear (write-once)', async ({ page }) => {
    await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 0 }),
      tracker: { vitae: 1, willpower: 5, influence: 3, aggravated: 0, [MARKER]: 'cycle-128' },
    });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feeding-story-flow .vd-card')).toHaveCount(2);
    await expect(sb.locator('[data-feeding-declare]')).toHaveCount(0);
    await expect(sb.locator('.feeding-story-flow button.vd-box')).toHaveCount(0);
  });

  test('a zero-success roll still offers healing (the invented `successes <= 0` gate is gone)', async ({ page }) => {
    // RULED (Angelus, 2026-09-11): "match the form". TM Story's own healing gate
    // (sections/feeding.js:875) has no successes term, so a feed that secured no
    // vessel but carries a real projection net still has a budget to spend. Its
    // VESSEL gate (:689) genuinely does exclude zero successes, so no vessel
    // strip renders - both ported faithfully, disagreeing exactly as they do
    // there.
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 0, dice: [2, 3, 4, 5, 6, 7, 3] }) }),
      tracker: { vitae: 0, willpower: 5, influence: 3, aggravated: 2 },
      fedTotal: 4,
    });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feeding-story-flow .vd-card')).toHaveCount(0, 'no vessels below one success');
    await expect(sb.locator('.feeding-story-flow .dt-agg-boxes')).toHaveCount(1, 'the healing panel is still offered');
    await expect(sb.locator('[data-feeding-declare]')).toHaveCount(1);

    // KNOWN, DOCUMENTED CONSEQUENCE, asserted rather than hidden. The budget a
    // box is enabled against is the PRE-SAVE one, and before any declaration has
    // been sent there is no server `fedTotal` to render from (nothing stores one;
    // AC 9a's only source is the declaration route's own response). The client
    // floor for a zero-success feed is 0, so every box is correctly disabled
    // rather than offering a commitment the server would refuse - this tab never
    // renders a control that would produce an invalid declaration. See
    // `renderFeedAggHealing()`'s own comment.
    await expect(sb.locator('button[data-agg-box="1"]')).toBeDisabled();

    await sb.locator('[data-feeding-declare]').click();
    await page.waitForTimeout(700);
    expect(calls.declarationPosts).toHaveLength(1);
    expect(calls.declarationPosts[0]).toEqual({ vesselVitae: [], aggHealed: 0 });
    // And the Vitae the feed DID yield still reaches the tracker, off the
    // server's own total.
    const feedPut = calls.trackerPuts.find(p => p.body[MARKER] === 'cycle-128');
    expect(feedPut).toBeTruthy();
    expect(feedPut.body.vitae).toBe(4);
  });
});

test.describe('Story 12.8 - AC 9/AC 10: reconciliation, absolute set, idempotency', () => {

  test('AC 9: a declaration with no marker applies from a BARE TAB LOAD, no click involved', async ({ page }) => {
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 1 }),
      tracker: { vitae: 1, willpower: 5, influence: 3, aggravated: 2 },
      fedTotal: 6,
    });
    await openFeedingSandbox(page, buildChar());
    await page.waitForTimeout(900);

    // The stored declaration was re-sent verbatim to obtain the server's own
    // fedTotal (nothing stores it), and the tracker was written once.
    expect(calls.declarationPosts).toHaveLength(1);
    expect(calls.declarationPosts[0]).toEqual({ vesselVitae: [4, 2], aggHealed: 1 });
    expect(calls.trackerPuts).toHaveLength(1);
    const body = calls.trackerPuts[0].body;
    // LIVE BUG FIX, 2026-09-14 (Angelus: "Vitae does not carry over from game to
    // game... it is always 0 before feeding... this overwrites the CURRENT vitae
    // amount"): fedTotal 6, one box healed at 4 Vitae => 2 remaining, SET outright.
    // The tracker's own pre-existing 1 is irrelevant and must not survive into the
    // write — a delta-add would have written 3 (1 + 2), which is exactly the bug.
    expect(body.vitae).toBe(2);
    expect(body.aggravated).toBe(1);
    expect(body[MARKER]).toBe('cycle-128');
  });

  test('AC 9 [FIXED 2026-09-14]: Vitae already on the tracker does NOT survive the write — it is overwritten', async ({ page }) => {
    // Angelus's own standing rule, repeated at least 5 times: Vitae never carries
    // over between games and is always 0 before feeding. A nonzero prior value
    // here represents exactly the failure this fix closes — a stray earlier write
    // (the OLD ST-confirm panel, or a stale pre-Story-12.8 value) — and the
    // reconciliation must OVERWRITE it with fedTotal, never add to it.
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [3, 1], aggHealed: 0 }),
      tracker: { vitae: 2, willpower: 5, influence: 3, aggravated: 0 },
      fedTotal: 4,
    });
    await openFeedingSandbox(page, buildChar());
    await page.waitForTimeout(900);

    expect(calls.trackerPuts).toHaveLength(1);
    expect(calls.trackerPuts[0].body.vitae).toBe(4); // fedTotal alone, NOT 2 (stray prior) + 4
  });

  test('AC 9: the SET is clamped against the real Vitae maximum', async ({ page }) => {
    // Blood Potency 2 => calcVitaeMax 11. A fedTotal of 15 (e.g. a strong ambience/
    // Oath-of-Fealty bonus on top of a big draw) must land on 11, not 15 — and the
    // tracker's own pre-existing 9 must play NO part in that (an old delta-add
    // would have summed to 24 before clamping; this must clamp fedTotal alone).
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 0 }),
      tracker: { vitae: 9, willpower: 5, influence: 3, aggravated: 0 },
      fedTotal: 15,
    });
    await openFeedingSandbox(page, buildChar());
    await page.waitForTimeout(900);

    expect(calls.trackerPuts).toHaveLength(1);
    expect(calls.trackerPuts[0].body.vitae).toBe(11);
  });

  test('AC 9/AC 10: a marker already naming this cycle suppresses the whole application', async ({ page }) => {
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 1 }),
      tracker: { vitae: 1, willpower: 5, influence: 3, aggravated: 2, [MARKER]: 'cycle-128' },
      fedTotal: 6,
    });
    await openFeedingSandbox(page, buildChar());
    await page.waitForTimeout(900);

    // Not the Aggravated half only - NOTHING is written, and `tracker_state.vitae`
    // is not reset by a second pass over an already-applied feed.
    expect(calls.trackerPuts).toHaveLength(0);
    expect(calls.declarationPosts).toHaveLength(0);
  });

  test('AC 9: a second load after a successful application does not write again', async ({ page }) => {
    // The marker written by the first pass is the only thing stopping the second.
    let marker = null;
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 0 }),
      fedTotal: 6,
    });
    // Re-route tracker GET so it reflects what the first pass wrote.
    await page.route('**/api/tracker_state/*', r => {
      if (r.request().method() !== 'GET') {
        const body = JSON.parse(r.request().postData() || '{}');
        calls.trackerPuts.push({ url: r.request().url(), body });
        if (body[MARKER]) marker = body[MARKER];
        return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ vitae: 1, willpower: 5, influence: 3, aggravated: 0, ...(marker ? { [MARKER]: marker } : {}) }),
      });
    });

    await openFeedingSandbox(page, buildChar());
    await page.waitForTimeout(900);
    expect(calls.trackerPuts).toHaveLength(1);

    // A fresh tab load, same character, same cycle.
    await page.evaluate(async (c) => {
      const pane = document.getElementById('t-feeding');
      await window.__renderFeedingTab(pane, c);
    }, buildChar());
    await page.waitForTimeout(900);
    expect(calls.trackerPuts).toHaveLength(1);
  });
});

test.describe('Story 12.8 - AC 9a: the server derives fedTotal, the client renders it', () => {

  test('a Barrens feed renders the SERVER total, not the client vessel-only sum', async ({ page }) => {
    // The Barrens carries a real ambienceMod of -4 (sections/feeding.js:886-891),
    // so the client's naive "vessel draws alone" figure OVERSTATES the budget
    // there - the exact case data-lock #13 names. Vessels sum to 6; the server's
    // own territory-aware total is 2.
    await setupRoutes(page, {
      story: feedingDoc({
        rollResult: rollResultDoc({ successes: 2 }),
        vesselVitae: [4, 2], aggHealed: 0,
        territory: { id: 'terr-barrens', label: 'The Barrens' },
      }),
      tracker: { vitae: 0, willpower: 5, influence: 3, aggravated: 3 },
      fedTotal: 2,
    });
    const sb = await openFeedingSandbox(page, buildChar());
    await page.waitForTimeout(900);

    // "0 of 2 Vitae committed to healing" - 2 is the server's number. The client's
    // own sum would have said 6, and offered a box the server would have refused.
    await expect(sb.locator('.dt-agg-summary')).toContainText('of 2 Vitae committed to healing');
    await expect(sb.locator('.dt-agg-summary')).not.toContainText('of 6 Vitae');
  });
});

test.describe('Story 12.8 - AC 11: keyed by character id, unconditional on view state', () => {

  test('the tracker write completes for the right character even after the view moves on', async ({ page }) => {
    const OTHER = buildChar({ _id: 'char-999', name: 'Someone Else' });
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }) }),
      tracker: { vitae: 1, willpower: 5, influence: 3, aggravated: 0 },
      fedTotal: 5,
      hooks: {
        // Mid-flight: the declaration POST is in the air when the tab is
        // re-rendered for a DIFFERENT character, invalidating every view
        // snapshot the handler holds.
        onDeclaration: async () => {},
      },
    });
    const sb = await openFeedingSandbox(page, buildChar());

    await sb.locator('.vd-boxes[data-vessel-idx="0"] button.vd-box').nth(4).click();
    await page.evaluate(async (other) => {
      const pane = document.getElementById('t-feeding');
      const btn = pane.querySelector('[data-feeding-declare]');
      btn.click();                       // starts the POST
      await new Promise(r => setTimeout(r, 10));
      await window.__renderFeedingTab(pane, other);  // the view moves on
    }, OTHER);
    await page.waitForTimeout(1200);

    // The work still happened, and it happened against the character it was
    // about - not the one now on screen.
    const feedPut = calls.trackerPuts.find(p => p.body[MARKER] === 'cycle-128');
    expect(feedPut).toBeTruthy();
    expect(feedPut.url).toContain('/api/tracker_state/char-128');
  });
});

test.describe('Story 12.8 - AC 12: a failed tracker read is fail-closed and surfaced', () => {

  test('an unreadable tracker produces zero writes and a real, visible signal', async ({ page }) => {
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 1 }),
      trackerReadFails: true,
      fedTotal: 6,
    });
    const sb = await openFeedingSandbox(page, buildChar());
    await page.waitForTimeout(900);

    // Scoped to FEED writes. The app shell's own live tracker (`game/tracker.js`'s
    // `ensureLoaded`) seeds a defaults document of its own when a read fails, and
    // that write is not this story's and is not what fail-closed is about; what
    // must not happen is a feed being applied off unknown state, and a feed
    // application is identifiable by the marker it always carries.
    expect(calls.trackerPuts.filter(p => MARKER in p.body)).toHaveLength(0);
    expect(calls.declarationPosts).toHaveLength(0);
    await expect(sb.locator('.feeding-write-notice'))
      .toContainText('tracker could not be read just now');
    // Not a swallowed error: it reaches the console too.
    expect(sb.__consoleErrors.some(t => t.includes('[feeding] tracker_state unreadable'))).toBe(true);
  });

  test('an unreadable tracker also refuses the Save click rather than recording an unappliable feed', async ({ page }) => {
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }) }),
      trackerReadFails: true,
      fedTotal: 5,
    });
    const sb = await openFeedingSandbox(page, buildChar());

    // The vessel strip needs no tracker read, so the control is still offered -
    // it is the WRITE that fails closed, with a sentence, not the render.
    await expect(sb.locator('[data-feeding-declare]')).toHaveCount(1);
    await sb.locator('[data-feeding-declare]').click();
    await page.waitForTimeout(700);

    expect(calls.declarationPosts).toHaveLength(0);
    expect(calls.trackerPuts.filter(p => MARKER in p.body)).toHaveLength(0);
    await expect(sb.locator('.feeding-write-notice')).toContainText('tracker could not be read just now');
  });
});

test.describe('Story 12.8 - AC 14: the ST-confirm panel respects an auto-applied feed', () => {

  test('the RENDER shows the already-applied state with no Confirm control at all', async ({ page }) => {
    await setupRoutes(page, {
      user: ST_USER,
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 1 }),
      tracker: { vitae: 7, willpower: 5, influence: 3, aggravated: 1, [MARKER]: 'cycle-128' },
    });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feed-st-confirm')).toBeVisible();
    await expect(sb.locator('#feed-already-applied')).toContainText('already been applied to the tracker');
    // Absent, not merely relabelled - and the steppers are gone with it, so there
    // is nothing left to read a Vitae figure off.
    await expect(sb.locator('#feed-confirm-btn')).toHaveCount(0);
    await expect(sb.locator('#feed-confirm-n')).toHaveCount(0);
  });

  test('the HANDLER refuses to write Vitae even when reached past the render guard', async ({ page }) => {
    // The "second lock on the same door" standard this file already applies for
    // `_confirmInFlight`, and a genuinely reachable route rather than a contrived
    // one: the panel is rendered while the marker is still absent, so a LIVE
    // Confirm button and its listener exist; the reconciliation then completes,
    // sets the marker and re-renders, which detaches that node but not its
    // listener. Anything still holding the old node - a queued event, a handler
    // captured before the redraw - reaches the handler with the render guard
    // already gone. It must refuse anyway.
    const calls = await setupRoutes(page, {
      user: ST_USER,
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 1 }),
      tracker: { vitae: 7, willpower: 5, influence: 3, aggravated: 1 },
      fedTotal: 6,
      // Slow enough that the first render is definitely on screen, with a live
      // Confirm control, before the marker lands.
      hooks: { onDeclaration: async () => { await new Promise(r => setTimeout(r, 1500)); } },
    });
    const sb = await openFeedingSandbox(page, buildChar(), 'dark', { awaitRender: false });

    // Pre-reconciliation: the control really is live, and really is bound.
    await expect(sb.locator('#feed-confirm-btn')).toHaveCount(1, { timeout: 10000 });
    const captured = await page.evaluate(() => {
      window.__staleConfirmBtn = document.querySelector('#t-feeding #feed-confirm-btn');
      return !!window.__staleConfirmBtn;
    });
    expect(captured).toBe(true);

    // Let the reconciliation finish and redraw.
    await page.waitForTimeout(2200);
    await expect(sb.locator('#feed-already-applied')).toBeVisible();
    await expect(sb.locator('#feed-confirm-btn')).toHaveCount(0);
    const reconcilePuts = calls.trackerPuts.filter(p => MARKER in p.body);
    expect(reconcilePuts).toHaveLength(1);

    // Now reach the handler through the detached node, past the render guard.
    const before = calls.trackerPuts.length;
    await page.evaluate(() => window.__staleConfirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(700);

    // Nothing at all. An unguarded handler would have written `{ vitae, influence }`
    // straight over the automatic application.
    expect(calls.trackerPuts.slice(before)).toHaveLength(0);
  });

  test('positive control: the same detached-node click DOES write when no marker is set', async ({ page }) => {
    // The discriminator for the test above. Identical construction, one thing
    // changed: the reconciliation FAILS (the declaration route refuses), so it
    // redraws - detaching the Confirm node exactly as before - without setting a
    // marker. The same detached click now goes through and writes
    // `{ vitae, influence }`. That is what proves the refusal above comes from
    // the handler's own guard and not from a listener that simply died with the
    // node.
    const calls = await setupRoutes(page, {
      user: ST_USER,
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }), vesselVitae: [4, 2], aggHealed: 1 }),
      tracker: { vitae: 7, willpower: 5, influence: 3, aggravated: 1 },
      hooks: {
        onDeclaration: async () => { await new Promise(r => setTimeout(r, 1500)); },
        declarationResponse: { status: 500, body: { error: 'boom', message: 'no' } },
      },
    });
    const sb = await openFeedingSandbox(page, buildChar(), 'dark', { awaitRender: false });

    await expect(sb.locator('#feed-confirm-btn')).toHaveCount(1, { timeout: 10000 });
    await page.evaluate(() => { window.__staleConfirmBtn = document.querySelector('#t-feeding #feed-confirm-btn'); });

    await page.waitForTimeout(2200);
    expect(calls.trackerPuts.filter(p => MARKER in p.body)).toHaveLength(0, 'no marker was set');
    // The redraw really did happen, so the captured node really is detached.
    const detached = await page.evaluate(() => !document.contains(window.__staleConfirmBtn));
    expect(detached).toBe(true);

    const before = calls.trackerPuts.length;
    await page.evaluate(() => window.__staleConfirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForTimeout(700);

    const written = calls.trackerPuts.slice(before).filter(p => 'influence' in p.body);
    expect(written).toHaveLength(1);
  });
});
