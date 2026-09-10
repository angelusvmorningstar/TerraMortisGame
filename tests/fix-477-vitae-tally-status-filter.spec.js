/**
 * Tests for fix.477 — computeVitateTally status filter whitelist
 *
 * Bug: the territory grid filter in computeVitateTally used retired status
 * terms ('resident', 'poach') and missed the current terms ('feeding_rights',
 * 'poaching') and legacy variant 'poacher'. Characters with feeding rights
 * (Regents, Lieutenants, merit holders) fell back to Barrens −4.
 *
 * A blocklist hotfix (commit 49c628e) was shipped as an emergency measure.
 * This story replaces it with an explicit whitelist of known status values.
 *
 * AC1: feeding_rights → named territory ambience, not Barrens
 * AC2: poaching → named territory ambience, not Barrens
 * AC3: resident (legacy) → still resolves correctly
 * AC4: poacher (legacy) → still resolves correctly
 * AC5: all 'none' → Barrens −4 default preserved
 */

const { test, expect } = require('@playwright/test');

// ── Mock data ─────────────────────────────────────────────────────────────────

const PLAYER_USER = {
  id: '777000477', username: 'test_player477', global_name: 'Test Player 477',
  avatar: null, role: 'player', player_id: 'p-fix477',
  character_ids: ['char-fix477'], is_dual_role: false,
};

const GAME_CYCLE = {
  _id: 'cycle-fix477', status: 'game', label: 'Downtime Test',
  feeding_rights_confirmed: true, is_chapter_finale: false,
  created_at: '2026-05-22T00:00:00.000Z',
};

function buildChar() {
  return {
    _id: 'char-fix477', name: 'Test Character', moniker: null, honorific: null,
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
  };
}

function buildSub(feedingTerritories) {
  return {
    _id: 'sub-fix477',
    chapter_id: GAME_CYCLE._id,
    character_id: 'char-fix477',
    status: 'submitted',
    responses: {
      _feed_method: 'seduction',
      _feed_disc: '',
      _feed_spec: '',
      feeding_territories: JSON.stringify(feedingTerritories),
    },
  };
}

// ── Setup helpers ─────────────────────────────────────────────────────────────

async function setupRoutes(page, submission) {
  await page.route('**/api/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/auth/me', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLAYER_USER) })
  );
  await page.route(/\/api\/characters(\?.*)?$/, r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([buildChar()]) })
  );
  await page.route('**/api/characters/names', r =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ _id: 'char-fix477', name: 'Test Character', moniker: null, honorific: null }]) })
  );
  await page.route('**/api/chapters*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([GAME_CYCLE]) })
  );
  await page.route('**/api/downtime_submissions*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([submission]) })
  );
  await page.route('**/api/territories*', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
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

async function openFeedingTabSandbox(page, submission) {
  const char = buildChar();
  await setupRoutes(page, submission);
  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(300);
  await page.evaluate(async (c) => {
    const sandbox = document.createElement('div');
    sandbox.id = 'feed-sandbox-477';
    sandbox.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#1a1208;z-index:99999;overflow:auto;';
    document.body.appendChild(sandbox);
    const { renderFeedingTab } = await import('/js/tabs/feeding-tab.js');
    await renderFeedingTab(sandbox, c);
  }, char);
  await page.waitForTimeout(500);
  return page.locator('#feed-sandbox-477');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('fix.477 — computeVitateTally status filter whitelist', () => {

  // AC1: current term "feeding_rights" — Regent / Lieutenant / merit holder
  test('AC1: feeding_rights status → Academy ambience (+3), not Barrens', async ({ page }) => {
    const sub = buildSub({ academy: 'feeding_rights' });
    const sandbox = await openFeedingTabSandbox(page, sub);

    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });
    await expect(vitaeCard(sandbox)).toContainText('Academy');
    await expect(vitaeCard(sandbox)).not.toContainText('Barrens');
    const ambRow1 = ledgerRow(sandbox, 'Academy');
    await expect(ambRow1).toBeVisible();
    await expect(ledgerVal(ambRow1)).toHaveText('+3');
  });

  // AC2: current term "poaching"
  test('AC2: poaching status → Harbour ambience (−2), not Barrens', async ({ page }) => {
    const sub = buildSub({ harbour: 'poaching' });
    const sandbox = await openFeedingTabSandbox(page, sub);

    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });
    await expect(vitaeCard(sandbox)).toContainText('Harbour');
    await expect(vitaeCard(sandbox)).not.toContainText('Barrens');
    await expect(ledgerVal(ledgerRow(sandbox, 'Harbour'))).toHaveText('-2');
  });

  // AC3: legacy term "resident" — old submissions before the term was retired
  test('AC3: resident (legacy) → North Shore ambience (+2), not Barrens', async ({ page }) => {
    const sub = buildSub({ northshore: 'resident' });
    const sandbox = await openFeedingTabSandbox(page, sub);

    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });
    await expect(vitaeCard(sandbox)).toContainText('North Shore');
    await expect(vitaeCard(sandbox)).not.toContainText('Barrens');
    const ambRow3 = ledgerRow(sandbox, 'North Shore');
    await expect(ambRow3).toBeVisible();
    await expect(ledgerVal(ambRow3)).toHaveText('+2');
  });

  // AC4: legacy term "poacher" — old submissions before the term was retired
  test('AC4: poacher (legacy) → Second City ambience (+2), not Barrens', async ({ page }) => {
    const sub = buildSub({ secondcity: 'poacher' });
    const sandbox = await openFeedingTabSandbox(page, sub);

    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });
    await expect(vitaeCard(sandbox)).toContainText('Second City');
    await expect(vitaeCard(sandbox)).not.toContainText('Barrens');
    const ambRow4 = ledgerRow(sandbox, 'Second City');
    await expect(ambRow4).toBeVisible();
    await expect(ledgerVal(ambRow4)).toHaveText('+2');
  });

  // AC5: all territories "none" → Barrens default preserved
  test('AC5: all territories "none" → Barrens −4 default', async ({ page }) => {
    const sub = buildSub({
      academy: 'none', harbour: 'none', dockyards: 'none',
      secondcity: 'none', northshore: 'none', the_barrens_no_territory_: 'none',
    });
    const sandbox = await openFeedingTabSandbox(page, sub);

    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });
    const ambRow = ledgerRow(sandbox, 'Barrens');
    await expect(ambRow).toBeVisible();
    await expect(ledgerVal(ambRow)).toHaveText('-4');
  });

  // QA (Quinn): multi-territory — the tally picks the BEST ambience among all declared
  // feeding territories (computeVitateTally loops + keeps the max). Doubles as a regression
  // guard on the slug-match fix: pre-fix this returned Barrens; now it must pick Academy (+3).
  test('QA: best ambience wins across multiple feeding territories', async ({ page }) => {
    const sub = buildSub({ academy: 'feeding_rights', harbour: 'poaching', dockyards: 'feeding_rights' });
    const sandbox = await openFeedingTabSandbox(page, sub);

    await expect(vitaeCard(sandbox)).toBeVisible({ timeout: 8000 });
    await expect(vitaeCard(sandbox)).toContainText('Academy'); // best of +3 / -2 / 0
    await expect(vitaeCard(sandbox)).not.toContainText('Barrens');
    const ambRowBest = ledgerRow(sandbox, 'Academy');
    await expect(ledgerVal(ambRowBest)).toHaveText('+3');
  });

});
