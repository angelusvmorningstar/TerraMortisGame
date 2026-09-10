/**
 * Tests for fix.475 — feeding vitae pipeline
 *
 * Three bugs fixed:
 * Bug 1: Feeding Grounds merit with bonus dots contributed 0 dice everywhere
 *        (domMeritContribSingle omitted m.bonus; buildPool omitted FG entirely)
 * Bug 2: DT form territory pills showed stale hardcoded ambience, not live DB values
 * Bug 3: computeVitateTally slug lookup failed for all named territories —
 *        'the_academy' key (from form) never matched 'academy' TERRITORY_DATA slug
 *
 * AC1/AC3: FG bonus:4, cp:0 character → +4 dice in feeding tab pool breakdown
 * AC4: Territory pills show live ambience from _territories, not stale TERRITORY_DATA
 * AC5: vitae tally resolves named territory correctly via name-based slug fallback
 * AC6: persisted feeding_vitae_tally is used as-is (computeVitateTally not called)
 * AC7: empty feeding_territories → Barrens −4 default preserved
 * AC8: purchased FG (cp:3, bonus:0) remains unaffected — pool still shows correct count
 *
 * AC2 (DT Processing Feeding Grounds row) is not covered here — admin surface
 * requires full ST session setup; verify manually.
 */

const { test, expect } = require('@playwright/test');

// ── Mock data ─────────────────────────────────────────────────────────────────

const PLAYER_USER = {
  id: '777000475', username: 'test_player475', global_name: 'René Test',
  avatar: null, role: 'player', player_id: 'p-fix475',
  character_ids: ['char-fix475'], is_dual_role: false,
};

const GAME_CYCLE = {
  _id: 'cycle-fix475', status: 'game', label: 'Downtime 3',
  feeding_rights_confirmed: true, is_chapter_finale: false,
  created_at: '2026-05-22T00:00:00.000Z',
};

function buildChar(overrides = {}) {
  return {
    _id: 'char-fix475', name: 'René Mallory', moniker: null, honorific: null,
    clan: 'Daeva', covenant: 'Invictus', player: 'Test Player',
    blood_potency: 2, humanity: 7, humanity_base: 7, court_title: null, retired: false,
    status: {
      city: 1, clan: 1,
      covenant: { 'Carthian Movement': 0, 'Circle of the Crone': 0, 'Invictus': 1, 'Lancea et Sanctum': 0, 'Ordo Dracul': 0 },
    },
    attributes: {
      Intelligence: { dots: 2, bonus: 0 }, Wits: { dots: 2, bonus: 0 }, Resolve: { dots: 2, bonus: 0 },
      Strength: { dots: 2, bonus: 0 }, Dexterity: { dots: 2, bonus: 0 }, Stamina: { dots: 2, bonus: 0 },
      Presence: { dots: 3, bonus: 0 }, Manipulation: { dots: 2, bonus: 0 }, Composure: { dots: 2, bonus: 0 },
    },
    skills: {}, disciplines: {}, merits: [], powers: [], ordeals: [],
    ...overrides,
  };
}

/** All four FG dots are ST-awarded bonus — the bug case */
const FG_BONUS_ONLY = { category: 'domain', name: 'Feeding Grounds', cp: 0, xp: 0, bonus: 4 };

/** All three FG dots are normally purchased — regression check */
const FG_PURCHASED = { category: 'domain', name: 'Feeding Grounds', cp: 3, xp: 0, bonus: 0 };

function buildSub(overrides = {}) {
  return {
    _id: 'sub-fix475',
    chapter_id: GAME_CYCLE._id,
    character_id: 'char-fix475',
    status: 'submitted',
    responses: {
      _feed_method: 'seduction',
      _feed_disc: '',
      _feed_spec: '',
      feeding_territories: JSON.stringify({ the_academy: 'resident' }),
    },
    ...overrides,
  };
}

// ── Setup helpers ─────────────────────────────────────────────────────────────

async function setupRoutes(page, { submission = null, territories = [], char = null } = {}) {
  await page.route('**/api/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/auth/me', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLAYER_USER) })
  );
  await page.route(/\/api\/characters(\?.*)?$/, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([char || buildChar()]) })
  );
  await page.route('**/api/characters/names', r =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ _id: 'char-fix475', name: 'René Mallory', moniker: null, honorific: null }]) })
  );
  await page.route('**/api/chapters*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([GAME_CYCLE]) })
  );
  await page.route('**/api/downtime_submissions*', r =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(submission ? [submission] : []) })
  );
  await page.route('**/api/territories*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(territories) })
  );
  await page.addInitScript((u) => {
    localStorage.setItem('tm_auth_token', 'fake-test-token');
    localStorage.setItem('tm_auth_expires', String(Date.now() + 36000000));
    localStorage.setItem('tm_auth_user', JSON.stringify(u));
  }, PLAYER_USER);
}

/**
 * The Vitae Sources ledger card.
 *
 * Story 12.4 recomposed this card onto the downtime form's ledger component:
 * `.fvt-card`/`.fvt-row`/`.fvt-val` are gone, and the tab now renders TWO
 * ledger cards - Story 12.3's standing "Influence and Willpower" tally and this
 * one - so `.feed-ledger` alone is ambiguous and is filtered by title here.
 * (The class prefix is `feed-ledger`, not TM Story's own `dt-vitae-*`, because
 * those names belong to the downtime form's unrelated Vitae Projection panel in
 * this repo - see components.css.)
 */
const vitaeCard = (sandbox) => sandbox.locator('.feed-ledger', { hasText: 'Vitae Sources' });

/** One ledger row by its label, and that row's value cell (the second span). */
const ledgerRow = (sandbox, label) =>
  vitaeCard(sandbox).locator('.feed-ledger-row', { hasText: label });
const ledgerVal = (row) => row.locator('span').last();

async function openFeedingTabSandbox(page, char) {
  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(300);
  await page.evaluate(async (c) => {
    const sandbox = document.createElement('div');
    sandbox.id = 'feed-sandbox-475';
    sandbox.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#1a1208;z-index:99999;overflow:auto;';
    document.body.appendChild(sandbox);
    const { renderFeedingTab } = await import('/js/tabs/feeding-tab.js');
    await renderFeedingTab(sandbox, c);
  }, char);
  await page.waitForTimeout(500);
  return page.locator('#feed-sandbox-475');
}

/**
 * Open the DT form in a sandbox, passing territories directly so the pill
 * renderer picks up live ambience without hitting /api/territories.
 */
async function openDtFormSandbox(page, char, territories = []) {
  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(300);
  await page.evaluate(async ({ c, terrs }) => {
    const sandbox = document.createElement('div');
    sandbox.id = 'dt-sandbox-475';
    sandbox.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#1a1208;z-index:99999;overflow:auto;';
    document.body.appendChild(sandbox);
    const mod = await import('/js/tabs/downtime-form.js');
    // skipFreshFetch: true — use the supplied territories array directly
    // (mirrors what selectCharacter does when territories are pre-loaded)
    await mod.renderDowntimeTab(sandbox, c, terrs, { skipFreshFetch: true });
  }, { c: char, terrs: territories });
  await page.waitForTimeout(400);
  return page.locator('#dt-sandbox-475');
}

// ── Tests: FG bonus dots (Bug 1) ──────────────────────────────────────────────

test.describe('fix.475 — Bug 1: Feeding Grounds bonus dots', () => {

  // AC1 + AC3: bonus dots flow through domMeritContribSingle → domMeritContrib → buildPool
  test('AC3: FG with bonus:4 included in feeding tab pool breakdown and dice count', async ({ page }) => {
    const char = buildChar({ merits: [FG_BONUS_ONLY] });
    const sub  = buildSub();
    await setupRoutes(page, { submission: sub, char });
    const sandbox = await openFeedingTabSandbox(page, char);

    // Feeding state 'ready' — roll button must be visible
    const rollBtn = sandbox.locator('#feeding-roll-btn');
    await expect(rollBtn).toBeVisible({ timeout: 8000 });

    // Pool breakdown must mention Feeding Grounds
    const breakdown = sandbox.locator('.feeding-pool-breakdown');
    await expect(breakdown).toContainText('Feeding Grounds', { timeout: 5000 });

    // Dice count: Presence 3 + no-skill unskilled −1 + FG 4 = 6
    const btnText = await rollBtn.textContent();
    const m = btnText.match(/\((\d+) dice\)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBe(6);
  });

  // AC8: a character with normally purchased FG (cp:3) is unaffected by the fix
  test('AC8: FG with cp:3, bonus:0 still contributes correct dice count', async ({ page }) => {
    const char = buildChar({ merits: [FG_PURCHASED] });
    const sub  = buildSub();
    await setupRoutes(page, { submission: sub, char });
    const sandbox = await openFeedingTabSandbox(page, char);

    const rollBtn = sandbox.locator('#feeding-roll-btn');
    await expect(rollBtn).toBeVisible({ timeout: 8000 });

    // Dice count: Presence 3 − 1 unskilled + FG 3 = 5
    const btnText = await rollBtn.textContent();
    const m = btnText.match(/\((\d+) dice\)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBe(5);

    // Breakdown still mentions Feeding Grounds
    await expect(sandbox.locator('.feeding-pool-breakdown')).toContainText('Feeding Grounds');
  });

  // No FG merit → no Feeding Grounds in breakdown, dice count unaffected
  test('regression: character without FG has no Feeding Grounds in breakdown', async ({ page }) => {
    const char = buildChar(); // no merits
    const sub  = buildSub();
    await setupRoutes(page, { submission: sub, char });
    const sandbox = await openFeedingTabSandbox(page, char);

    const rollBtn = sandbox.locator('#feeding-roll-btn');
    await expect(rollBtn).toBeVisible({ timeout: 8000 });

    // Dice count: Presence 3 − 1 unskilled = 2 (no FG)
    const btnText = await rollBtn.textContent();
    const m = btnText.match(/\((\d+) dice\)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBe(2);

    await expect(sandbox.locator('.feeding-pool-breakdown')).not.toContainText('Feeding Grounds');
  });

});

// ── Tests: Stale pill ambience (Bug 2) ───────────────────────────────────────

test.describe('fix.475 — Bug 2: Territory pill shows live ambience', () => {

  // AC4: pill uses live territory data, not stale hardcoded TERRITORY_DATA
  test('AC4: Second City pill shows "Settled" (+0) from live territories, not "Tended" (+2)', async ({ page }) => {
    const char = buildChar();
    const liveSecondCity = {
      _id: 'terr-sc', slug: 'secondcity', name: 'The Second City',
      ambience: 'Settled', ambienceMod: 0,
      feeding_rights: [], regent_id: null, lieutenant_id: null,
    };
    await setupRoutes(page, { char });
    const sandbox = await openDtFormSandbox(page, char, [liveSecondCity]);

    // Expand feeding section
    const feedSection = sandbox.locator('.qf-section[data-section-key="feeding"]');
    await feedSection.waitFor({ timeout: 10000 });
    await feedSection.locator('.qf-section-title').click();
    await page.waitForTimeout(300);

    // The Second City pill's ambience badge must show "Settled" from live data
    const scPill = sandbox.locator('.dt-feed-terr-pills button', { hasText: 'The Second City' });
    await expect(scPill).toBeVisible({ timeout: 5000 });
    const amb = scPill.locator('.dt-terr-pill-amb');
    await expect(amb).toContainText('Settled');
    await expect(amb).not.toContainText('Tended');
  });

  // Hardcoded fallback: if no live territory provided, TERRITORY_DATA is used
  test('fallback: no live territories → pill falls back to hardcoded TERRITORY_DATA value', async ({ page }) => {
    const char = buildChar();
    await setupRoutes(page, { char });
    // Pass empty territories — form falls back to hardcoded TERRITORY_DATA (Tended +2)
    const sandbox = await openDtFormSandbox(page, char, []);

    const feedSection = sandbox.locator('.qf-section[data-section-key="feeding"]');
    await feedSection.waitFor({ timeout: 10000 });
    await feedSection.locator('.qf-section-title').click();
    await page.waitForTimeout(300);

    const scPill = sandbox.locator('.dt-feed-terr-pills button', { hasText: 'The Second City' });
    await expect(scPill).toBeVisible({ timeout: 5000 });
    // Hardcoded TERRITORY_DATA has Second City as Tended +2
    await expect(scPill.locator('.dt-terr-pill-amb')).toContainText('Tended');
  });

});

// ── Tests: Territory slug mismatch (Bug 3) ────────────────────────────────────

test.describe('fix.475 — Bug 3: vitae tally resolves named territory correctly', () => {

  // AC5: Academy key ('the_academy') now matches via name-based fallback
  test('AC5: submission with Academy territory → vitae tally shows Academy ambience (+3), not Barrens (−4)', async ({ page }) => {
    const char = buildChar();
    // Academy: feeding_territories key is 'the_academy'; TERRITORY_DATA slug is 'academy'
    const sub = buildSub({
      responses: {
        _feed_method: 'seduction',
        _feed_disc: '',
        _feed_spec: '',
        feeding_territories: JSON.stringify({ the_academy: 'resident' }),
      },
    });
    await setupRoutes(page, { submission: sub, char });
    const sandbox = await openFeedingTabSandbox(page, char);

    // Feeding state 'ready' — vitae tally card renders
    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });

    // Must show Academy (+3), not Barrens (−4)
    await expect(vitaeCard(sandbox)).toContainText('The Academy');
    await expect(vitaeCard(sandbox)).not.toContainText('Barrens');
  });

  // AC7: empty feeding_territories → Barrens −4 default preserved (no regression)
  test('AC7: empty feeding_territories → Barrens −4 in vitae tally', async ({ page }) => {
    const char = buildChar();
    const sub = buildSub({
      responses: {
        _feed_method: 'seduction',
        _feed_disc: '',
        _feed_spec: '',
        feeding_territories: JSON.stringify({}),
      },
    });
    await setupRoutes(page, { submission: sub, char });
    const sandbox = await openFeedingTabSandbox(page, char);

    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });

    // Ambience row must show Barrens (−4)
    const ambRow = ledgerRow(sandbox, 'Barrens');
    await expect(ambRow).toBeVisible();
    await expect(ledgerVal(ambRow)).toHaveText('-4');
  });

  // AC6: persisted feeding_vitae_tally is used as-is — computeVitateTally not called
  test('AC6: persisted feeding_vitae_tally used directly; territory not recomputed from submission', async ({ page }) => {
    const char = buildChar();
    const sub = buildSub({
      // feeding_territories has no matching territory (would recompute to Barrens)
      responses: {
        _feed_method: 'seduction',
        feeding_territories: JSON.stringify({}),
      },
      // Persisted tally records The Harbour — overrides the would-be-Barrens recompute
      feeding_vitae_tally: {
        herd: 0,
        ambience: -2,
        ambience_territory: 'The Harbour',
        oath_of_fealty: 0,
        ghouls: 0,
        rite_cost: 0,
        manual: 0,
        total_bonus: 0,
      },
    });
    await setupRoutes(page, { submission: sub, char });
    const sandbox = await openFeedingTabSandbox(page, char);

    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });

    // Persisted tally says The Harbour (−2), not Barrens (−4)
    await expect(vitaeCard(sandbox)).toContainText('The Harbour');
    await expect(ledgerVal(ledgerRow(sandbox, 'The Harbour'))).toHaveText('-2');
    await expect(vitaeCard(sandbox)).not.toContainText('Barrens');
  });

});
