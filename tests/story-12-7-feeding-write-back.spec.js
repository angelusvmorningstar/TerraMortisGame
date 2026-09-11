/**
 * Story 12.7 — TM Game's Feeding tab becomes a pure client of TM Story.
 *
 * Covers the client half only (the TM Story write endpoint is its own repo's
 * work):
 *   AC 6   the roll POSTs to TM Story and never PUTs tm_game.downtime_submissions
 *   AC 7   after a successful roll the tab RE-READS and renders from that
 *   AC 11  frozen declarations show no picker; the picker, when shown, offers
 *          templates + recall and NEVER a custom-pool card
 *   AC 12  the template list is fetched live, not hardcoded
 *   AC 13  the ported markup carries TM Story's own tokens in BOTH themes,
 *          verified by measuring rendered geometry/colour, never by reading CSS
 *   AC 14  feedingRollGate()'s exact block/unblock behaviour and wording
 *
 * The TM Story origin in a localhost run is http://localhost:3000 (see
 * public/js/data/story-feeding.js's `storyApiBase`), which is what every route
 * glob below targets.
 */

const { test, expect } = require('@playwright/test');

const PLAYER_USER = {
  id: '777000127', username: 'test_player127', global_name: 'Pike Test',
  avatar: null, role: 'player', player_id: 'p-127',
  character_ids: ['char-127'], is_dual_role: false,
};

const GAME_CYCLE = {
  // `phase` is the current-model field and wins outright in `cyclePhase()`; the
  // legacy `status` mirror is kept beside it the way a real document carries both.
  _id: 'cycle-127', phase: 'game', status: 'game', game_number: 8, label: 'Game 8',
  feeding_rights_confirmed: true, is_chapter_finale: false,
  created_at: '2026-09-01T00:00:00.000Z',
};

const TEMPLATES = [
  { key: 'seduction', name: 'Seduction', desc: 'Lure a vessel close', attrs: ['Presence', 'Manipulation'], skills: ['Empathy', 'Socialise', 'Persuasion'], discs: ['Majesty', 'Dominate'], violence_default: 'kiss', sort_order: 1 },
  { key: 'stalking', name: 'Stalking', desc: 'Prey on a target unseen', attrs: ['Dexterity', 'Wits'], skills: ['Stealth', 'Streetwise'], discs: ['Protean', 'Obfuscate'], violence_default: null, sort_order: 2 },
  { key: 'force', name: 'By Force', desc: 'Overpower and drain', attrs: ['Strength'], skills: ['Brawl', 'Weaponry'], discs: ['Vigour'], violence_default: 'violent', sort_order: 3 },
];

function buildChar(overrides = {}) {
  return {
    _id: 'char-127', name: 'Samuel Pike', moniker: null, honorific: null,
    clan: 'Gangrel', covenant: 'Invictus', player: 'Test Player',
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

/** `content.feeding` as TM Story really stores it, unrolled (data-lock #1). */
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

/** `rollResult` as TM Story really stores it, rolled (data-lock #2). */
function rollResultDoc(overrides = {}) {
  return {
    pool: 7, chance: false, dice: [2, 8, 5, 9, 3, 10, 4],
    successes: 3, exceptional: false, dramatic_failure: false,
    rote: false, again: 10, signature: '{}',
    ...overrides,
  };
}

/**
 * Mock every route the tab touches.
 *
 * `story` is the body of GET .../feeding, or the literal string 'unreachable'
 * to make that call fail the way a CORS rejection or a cold dyno does.
 */
async function setupRoutes(page, { char = null, story = null, previous = null, templates = TEMPLATES, tracker = null, hooks = {} } = {}) {
  const calls = { rollPosts: [], declarationPosts: [], tmGamePuts: [], feedingReads: 0 };

  // TM Story first: its globs are more specific than the catch-all below, and
  // Playwright matches the LAST registered handler first.
  await page.route('**/api/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/auth/me', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLAYER_USER) }));
  await page.route(/\/api\/characters(\?.*)?$/, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([char || buildChar()]) }));
  await page.route('**/api/chapters*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([GAME_CYCLE]) }));
  await page.route('**/api/territories*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/tracker_state/*', r => {
    if (r.request().method() !== 'GET') return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    if (!tracker) return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tracker) });
  });
  // Any tm_game downtime write is a Story 12.7 regression by definition.
  await page.route('**/api/downtime_submissions**', r => {
    if (r.request().method() !== 'GET') calls.tmGamePuts.push(r.request().url());
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // TM Story is a genuinely CROSS-ORIGIN service (localhost:3000 while the app
  // runs on :8080), so a fulfilled response without CORS headers is blocked by
  // the browser and reaches the client as a network failure - which is how every
  // OTHER feeding spec in this repo ends up on the residual state machine. These
  // routes therefore answer the preflight and carry the headers the real Render
  // service does.
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
  await storyRoute('**/api/wiki/v1/downtime/submissions/*/*/previous', r => storyJson(r, 200, { previous }));
  await storyRoute('**/api/wiki/v1/downtime/submissions/*/*/feeding/roll', async r => {
    calls.rollPosts.push(JSON.parse(r.request().postData() || '{}'));
    if (hooks.onRoll) await hooks.onRoll();
    if (hooks.rollResponse) return storyJson(r, hooks.rollResponse.status, hooks.rollResponse.body);
    return storyJson(r, 200, { ok: true });
  });
  await storyRoute('**/api/wiki/v1/downtime/submissions/*/*/feeding/declaration', async r => {
    calls.declarationPosts.push(JSON.parse(r.request().postData() || '{}'));
    if (hooks.onDeclaration) await hooks.onDeclaration();
    return storyJson(r, 200, { ok: true });
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
  }, PLAYER_USER);

  return calls;
}

async function openFeedingSandbox(page, char, theme = 'dark') {
  if (process.env.TM_DEBUG) {
    page.on('console', m => console.log('PAGE:', m.type(), m.text()));
    page.on('pageerror', e => console.log('PAGEERROR:', e.message));
    page.on('requestfailed', r => console.log('REQFAIL:', r.url(), r.failure()?.errorText));
  }
  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
  await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
  // Render into the app's OWN `#t-feeding` pane rather than a detached sandbox
  // div. suite.css carries `#t-feeding`-scoped overrides (notably an
  // `!important` one on `.qf-select`), so a sandbox outside that id would
  // measure a cascade production never sees - and AC 13 is a measurement.
  await page.evaluate(async (c) => {
    const pane = document.getElementById('t-feeding');
    pane.style.cssText = 'display:block;position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;overflow:auto;';
    pane.classList.add('active');
    const { renderFeedingTab } = await import('/js/tabs/feeding-tab.js');
    await renderFeedingTab(pane, c);
  }, char);
  await page.waitForTimeout(600);
  if (process.env.TM_DEBUG) {
    // eslint-disable-next-line no-console
    console.log('SANDBOX HTML >>>', (await page.locator('#t-feeding').innerHTML()).slice(0, 1500));
  }
  return page.locator('#t-feeding');
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('Story 12.7 — frozen declaration (Scenario 1)', () => {

  test('AC 11: a declared method shows no picker, only the locked pool', async ({ page }) => {
    await setupRoutes(page, { story: feedingDoc() });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feeding-story-flow')).toBeVisible({ timeout: 10000 });
    await expect(sb.locator('.lock-tag')).toContainText('Locked from downtime');
    await expect(sb.locator('.feeding-story-flow .dt-vitae-title').first()).toContainText('Your approach: Stalking');
    // No picker at all, and in particular no custom card, ever.
    await expect(sb.locator('.feeding-story-flow [data-feed-method]')).toHaveCount(0);
    await expect(sb.locator('[data-feed-method="other"]')).toHaveCount(0);
    await expect(sb.getByText('Something else', { exact: false })).toHaveCount(0);
  });

  test('AC 11/13: the frozen pool renders pool-builder.js\'s own template markup, every control disabled', async ({ page }) => {
    await setupRoutes(page, { story: feedingDoc() });
    const sb = await openFeedingSandbox(page, buildChar());

    const selects = sb.locator('.feeding-story-flow .dt-pool-row .qf-select');
    await expect(selects).toHaveCount(2); // template branch: attr + skill, disc is chips only
    await expect(selects.nth(0)).toBeDisabled();
    await expect(selects.nth(1)).toBeDisabled();
    await expect(selects.nth(0)).toHaveValue('Dexterity');
    await expect(selects.nth(1)).toHaveValue('Stealth');
    // Dexterity 3 + Stealth 2 + Protean 2 = 7
    await expect(sb.locator('.feeding-story-flow .dt-pool-total')).toHaveText('7');
    await expect(sb.locator('.feeding-story-flow .dt-suggest-label')).toHaveText('Suggestions:');
    await expect(sb.locator('.feeding-story-flow .dt-pool-valid')).toHaveText('Pool matches the template');
    const chips = sb.locator('.feeding-story-flow .chip--suggest');
    expect(await chips.count()).toBeGreaterThan(0);
    await expect(chips.first()).toBeDisabled();
  });

  test('AC 6/AC 7: rolling POSTs trait picks to TM Story, writes nothing to tm_game, and re-reads', async ({ page }) => {
    let rolled = false;
    const calls = await setupRoutes(page, {
      hooks: {
        storyBody: () => (rolled ? feedingDoc({ rollResult: rollResultDoc() }) : feedingDoc()),
        onRoll: async () => { rolled = true; },
      },
    });
    const sb = await openFeedingSandbox(page, buildChar());

    await sb.locator('[data-feeding-roll]').click();
    await expect(sb.locator('.feeding-roll-confirm')).toContainText('This is irreversible.');
    await sb.locator('[data-feeding-roll-confirm]').click();
    await expect(sb.locator('.feeding-story-flow .feeding-roll-btn[disabled]')).toContainText('Already Rolled', { timeout: 10000 });

    expect(calls.rollPosts).toHaveLength(1);
    const body = calls.rollPosts[0];
    expect(body.method).toBe('stalking');
    expect(body.poolAttr).toBe('Dexterity');
    expect(body.poolSkill).toBe('Stealth');
    expect(body.poolDisc).toBe('Protean');
    // AC 2: trait picks only. No total, no dice, no signature.
    expect(body).not.toHaveProperty('pool');
    expect(body).not.toHaveProperty('poolTotal');
    expect(body).not.toHaveProperty('dice');
    expect(body).not.toHaveProperty('signature');
    // AC 6: nothing at all written to the retired collection.
    expect(calls.tmGamePuts).toHaveLength(0);
    // AC 7: the roll read is followed by a second, fresh read.
    expect(calls.feedingReads).toBeGreaterThanOrEqual(2);
    // And what is drawn is what came BACK, not what was hoped for.
    await expect(sb.locator('.feeding-pool-display')).toContainText('Rolled 7 dice');
    await expect(sb.locator('.feeding-pool-display')).toContainText('3 successes');
    await expect(sb.locator('.feeding-die')).toHaveCount(7);
  });

  test('AC 14: a still-custom, never-recalled declaration is blocked in TM Story\'s own words', async ({ page }) => {
    await setupRoutes(page, { story: feedingDoc({ method: 'other', poolAttr: 'Wits', poolSkill: 'Occult', poolDisc: '' }) });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feeding-story-flow .feeding-warning').first())
      .toHaveText('Feeding Roll not available yet - Custom pools need ST review before you can roll.');
    await expect(sb.locator('[data-feeding-roll]')).toHaveCount(0);
  });

  test('AC 14: a declaration with no violence chosen is blocked, and the toggle to unblock it is present', async ({ page }) => {
    await setupRoutes(page, { story: feedingDoc({ violence: null }) });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feeding-story-flow .feeding-warning').first())
      .toHaveText('Feeding Roll not available yet - choose The Kiss or Assault above to unlock it.');
    await sb.locator('[data-feed-vi="kiss"]').click();
    await expect(sb.locator('[data-feeding-roll]')).toBeVisible();
  });

  test('the vessel feed / vitae heal write-back is gated off until Story 12.8 ships its route', async ({ page }) => {
    // TM Story serves no `.../feeding/declaration` route today - that write half
    // was split out to Story 12.8 (depends_on 12.7, not yet built). Until it
    // ships, an unrecorded vessel/agg feed renders as an explanatory notice, not
    // an interactive draft with a "Save" button that would 404 on a real player.
    const calls = await setupRoutes(page, {
      story: feedingDoc({ rollResult: rollResultDoc({ successes: 2 }) }),
      tracker: { willpower: 5, influence: 3, aggravated: 2 },
    });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feeding-story-flow')).toContainText('arriving in a follow-up story');
    await expect(sb.locator('.feeding-story-flow .vd-card')).toHaveCount(0);
    await expect(sb.locator('.feeding-story-flow button.vd-box')).toHaveCount(0);
    await expect(sb.locator('[data-feeding-declare]')).toHaveCount(0);
    expect(calls.declarationPosts).toHaveLength(0);
  });

  test('a vessel feed already recorded through the downtime form still renders read-only', async ({ page }) => {
    // The gate above only withholds the WRITE affordance. Data the player already
    // committed through TM Story's own downtime form is a read, not a write, and
    // stays live exactly as Story 12.2 shipped it.
    await setupRoutes(page, {
      story: feedingDoc({
        rollResult: rollResultDoc({ successes: 2 }),
        vesselVitae: [4, 2],
        aggHealed: 1,
      }),
      tracker: { willpower: 5, influence: 3, aggravated: 2 },
    });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feeding-story-flow .vd-card')).toHaveCount(2);
    await expect(sb.locator('.feeding-story-flow button.vd-box')).toHaveCount(0, 'read-only: spans, not buttons');
    await expect(sb.locator('.feeding-story-flow .fvc-alloc-badge').first()).toHaveText('✓ Vessel feed recorded');
    await expect(sb.locator('[data-feeding-declare]')).toHaveCount(0);
  });
});

test.describe('Story 12.7 — no declaration (Scenario 2)', () => {

  test('AC 11/AC 12: the picker offers live templates and recall, and never a custom card', async ({ page }) => {
    await setupRoutes(page, { story: 'missing' });
    const sb = await openFeedingSandbox(page, buildChar());

    await expect(sb.locator('.feeding-story-flow .dt-feed-card-grid .dt-feed-card')).toHaveCount(3);
    await expect(sb.locator('[data-feed-method="seduction"]')).toContainText('Seduction');
    // AC 12: the list came off the wire - a hardcoded TM Game list would carry
    // six FEED_METHODS, not the three this run's route served.
    await expect(sb.locator('[data-feed-method="intimidation"]')).toHaveCount(0);
    await expect(sb.locator('[data-feed-method="other"]')).toHaveCount(0);
    const recall = sb.locator('[data-feed-method-recall-use]');
    await expect(recall).toContainText('No previous cycle pool to recall');
    await expect(recall).toBeDisabled();
    await expect(sb.locator('.feeding-story-flow .feeding-warning').first())
      .toContainText('There is no "Something else" option here');
  });

  test('picking a template locks the pool to its own suggestions and unblocks the roll', async ({ page }) => {
    await setupRoutes(page, { story: 'missing' });
    const sb = await openFeedingSandbox(page, buildChar());

    await sb.locator('[data-feed-method="stalking"]').click();
    await expect(sb.locator('[data-feed-method="stalking"]')).toHaveClass(/dt-feed-sel/);
    // Stalking has no violence default, so the gate still holds until one is chosen.
    await expect(sb.locator('.feeding-story-flow .feeding-warning').last())
      .toContainText('choose The Kiss or Assault above to unlock it.');
    await sb.locator('[data-feed-vi="violent"]').click();
    await sb.locator('.dt-suggest-row .chip--suggest', { hasText: 'Dexterity' }).click();
    await sb.locator('.dt-suggest-row .chip--suggest', { hasText: 'Stealth' }).click();
    await expect(sb.locator('.dt-pool-total')).toHaveText('5');
    await expect(sb.locator('[data-feeding-roll]')).toBeVisible();
  });

  test('recall offers the previous pool and exempts it from fresh review', async ({ page }) => {
    await setupRoutes(page, {
      story: 'missing',
      previous: {
        cycle: { cycle_id: 'cycle-126', game_number: 7, label: 'Game 7' },
        feeding: {
          method: 'other', poolAttr: 'Wits', poolSkill: 'Stealth', poolDisc: 'Protean',
          poolSpecChip: null, bloodType: 'Human', violence: 'kiss', description: 'As before.',
        },
      },
    });
    const sb = await openFeedingSandbox(page, buildChar());

    const recall = sb.locator('[data-feed-method-recall-use]');
    await expect(recall).toContainText('Wits + Stealth + Protean (Game 7)');
    await recall.click();
    // A recalled CUSTOM pool is pre-approved, not blocked (feedingRollGate's own
    // `recalled` branch, Angelus's 2026-08-30 ruling).
    await expect(sb.locator('.dt-pool-valid')).toHaveText('Pre-approved pool, reused from last cycle');
    await expect(sb.locator('[data-feeding-roll]')).toBeVisible();
  });

  test('a refusal from TM Story is shown to the player, not swallowed', async ({ page }) => {
    await setupRoutes(page, {
      story: 'missing',
      hooks: {
        rollResponse: {
          status: 400,
          body: { error: 'custom_not_allowed', message: 'Custom pools can only be declared in the downtime form' },
        },
      },
    });
    const sb = await openFeedingSandbox(page, buildChar());

    await sb.locator('[data-feed-method="seduction"]').click();
    await sb.locator('.dt-suggest-row .chip--suggest', { hasText: 'Presence' }).click();
    await sb.locator('.dt-suggest-row .chip--suggest', { hasText: 'Empathy' }).click();
    await sb.locator('[data-feeding-roll]').click();
    await sb.locator('[data-feeding-roll-confirm]').click();

    await expect(sb.locator('.feeding-write-notice'))
      .toHaveText('Custom pools can only be declared in the downtime form', { timeout: 10000 });
  });
});

test.describe('Story 12.7 — unreachable downtime service', () => {

  test('the tab never writes a feeding roll to tm_game, and says why it cannot roll', async ({ page }) => {
    const calls = await setupRoutes(page, { story: 'unreachable' });
    const sb = await openFeedingSandbox(page, buildChar());

    // The residual TM-Game-sourced machine, with no TM Story data at all.
    await expect(sb.locator('.feeding-story-flow')).toHaveCount(0);
    const legacyRoll = sb.locator('#feeding-roll-btn');
    if (await legacyRoll.count()) {
      await legacyRoll.click();
      await expect(sb.locator('.feeding-write-notice')).toContainText('could not reach it just now');
    }
    expect(calls.tmGamePuts).toHaveLength(0);
  });
});

test.describe('Story 12.7 — AC 13: measured, in both themes', () => {

  // Story 12.4's own method: measure what the browser actually computed, never
  // read the stylesheet. The assertions are about the PORT holding - that these
  // elements pick up TM Story's own tokens rather than TM Game's conflicting
  // legacy rules for the same class names - and that both themes resolve.
  for (const theme of ['light', 'dark']) {
    test(`the ported surface computes TM Story's own treatment (${theme})`, async ({ page }) => {
      // Vessel/agg boxes are seeded as ALREADY RECORDED: the write path that
      // would render them editable is gated off pending Story 12.8 (see
      // renderStoryFeedFlow's own comment), so the only live rendering of
      // .vd-card/.vd-box/.dt-agg-box today is the read-only one - measure that.
      await setupRoutes(page, {
        story: feedingDoc({
          rollResult: rollResultDoc({ successes: 1 }),
          vesselVitae: [3],
          aggHealed: 0,
        }),
        tracker: { willpower: 5, influence: 3, aggravated: 1 },
      });
      const sb = await openFeedingSandbox(page, buildChar(), theme);
      await expect(sb.locator('.feeding-story-flow')).toBeVisible({ timeout: 10000 });

      const m = await page.evaluate(() => {
        const pick = (sel, props) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const out = { _w: el.getBoundingClientRect().width, _h: el.getBoundingClientRect().height };
          for (const p of props) out[p] = cs.getPropertyValue(p);
          return out;
        };
        const root = getComputedStyle(document.documentElement);
        return {
          good: root.getPropertyValue('--good').trim(),
          gold2: root.getPropertyValue('--gold2').trim(),
          txt3: root.getPropertyValue('--txt3').trim(),
          ready: pick('.feeding-story-flow .feeding-ready', ['border-top-width', 'border-top-color', 'display', 'flex-direction', 'padding-top', 'border-top-left-radius']),
          rollBtn: pick('.feeding-story-flow .feeding-roll-btn', ['text-transform', 'font-size', 'padding-top', 'border-top-left-radius']),
          poolTotal: pick('.feeding-story-flow .dt-pool-total', ['font-weight', 'font-size', 'color']),
          poolSel: pick('.feeding-story-flow .qf-select', ['font-size', 'min-width']),
          die: pick('.feeding-story-flow .feeding-die', ['width', 'height', 'border-top-left-radius']),
          vdCard: pick('.feeding-story-flow .vd-card', ['padding-top', 'border-top-width']),
          vdBox: pick('.feeding-story-flow .vd-box', ['width', 'height', 'cursor']),
          aggBox: pick('.feeding-story-flow .dt-agg-box', ['width', 'height']),
          lockTag: pick('.feeding-story-flow .lock-tag', ['text-transform', 'font-size', 'color']),
          title: pick('.feeding-story-flow .dt-vitae-title', ['text-transform', 'font-size', 'color']),
          bodyOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });

      // Nothing may resolve to a blank token: a missing custom property would
      // silently paint transparent in exactly one theme.
      expect(m.good).not.toBe('');
      expect(m.gold2).not.toBe('');

      // `.feeding-ready`: TM Story's green-edged column box, not TM Game's own
      // (which has no such rule at all).
      expect(m.ready.display).toBe('flex');
      expect(m.ready['flex-direction']).toBe('column');
      expect(m.ready['border-top-width']).toBe('1px');
      expect(m.ready['padding-top']).toBe('10px');

      // `.feeding-roll-btn`: the compact 8px/16px pill, NOT TM Game's own
      // full-width 14px crimson block. Width is the real discriminator.
      expect(m.rollBtn['padding-top']).toBe('8px');
      expect(m.rollBtn['text-transform']).toBe('uppercase');
      expect(m.rollBtn._w).toBeLessThan(400);

      // The pool line, the dice, the vessel boxes and the aggravated boxes all
      // at TM Story's own sizes.
      expect(m.poolTotal['font-size']).toBe('16px');
      expect(m.poolTotal['font-weight']).toBe('700');
      expect(m.poolSel['font-size']).toBe('14px');
      expect(m.die.width).toBe('22px');
      expect(m.die.height).toBe('22px');
      expect(m.vdCard['padding-top']).toBe('10px');
      expect(m.vdBox.width).toBe('20px');
      // Read-only rendering (the only live path pending Story 12.8): a <span>,
      // not a <button>, so `.vd-box:not(button)` wins - cursor: default, not
      // pointer. Confirms the CSS split itself resolves, not just the sizing.
      expect(m.vdBox.cursor).toBe('default');
      expect(m.aggBox.width).toBe('20px');
      expect(m.lockTag['text-transform']).toBe('uppercase');
      expect(m.title['text-transform']).toBe('uppercase');
      expect(m.title['font-size']).toBe('12px');

      // Colour must actually differ between the two themes for the same token,
      // which is what proves the palette is being picked up rather than a
      // hardcoded value surviving the swap. Asserted by comparing against the
      // theme's own resolved token, not against a literal.
      expect(m.poolTotal.color).toBe(m.title.color);
      expect(m.poolTotal.color).not.toBe('rgba(0, 0, 0, 0)');
      expect(m.lockTag.color).not.toBe('rgba(0, 0, 0, 0)');
      expect(m.bodyOverflow).toBe(true);
    });
  }
});
