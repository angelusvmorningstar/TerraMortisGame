// Game 9 prep (2026-09-12): a player may now spend their OWN Vitae/Willpower from the
// character sheet's tap-box tracker (previously ST/dev-only for every tracked resource).
// Verifies, against the real DOM and the real click-delegation handler in suite/sheet.js:
//   - a player tapping a FILLED vitae/willpower box drops the displayed count (the synchronous,
//     optimistic client-side effect of trackerSpend — this suite does not depend on capturing
//     the background POST /spend network call itself, since this app's apiBase() hard-codes a
//     cross-origin http://localhost:3000 target under Playwright's http-server-only webServer,
//     which page.route does not reliably intercept here; the server-side spend route itself —
//     ownership, validation, clamping, atomicity — is covered directly by
//     server/tests/api-tracker-state-spend.test.js instead);
//   - a player tapping an EMPTY vitae/willpower box (an attempted self-restore) is a silent
//     no-op — count unchanged;
//   - Health stays fully non-interactive for a player, unchanged from before this story.
//
// Uses the same fixture-injection pattern as gdx-9-single-scroll-sheet.spec.js (window.
// onSheetChar), which sidesteps the Service Worker /api/characters interception issue
// documented there, plus an explicit ensureLoaded(c) first — onSheetChar()/renderSheet() read
// the tracker cache synchronously, and the real app only ever reaches the sheet after
// _switchChar's own `await ensureTrackerLoaded(c)`.

const { test, expect } = require('@playwright/test');
// Phone viewport: this app's `#n-stats`/`#t-stats` tab content only renders under the phone
// nav layout in this fixture-injection harness (gdx-9's own working pattern) — the default
// desktop viewport boots into desktop-mode with a collapsed sidebar and never populates
// #stats-content the same way.
test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });

const PLAYER_USER = {
  id: '900000010', username: 'test_player_spend', global_name: 'Test Player Spend',
  avatar: null, role: 'player', player_id: 'p-spend', character_ids: ['char-spend'], is_dual_role: false,
};

const CHAR = {
  _id: 'char-spend', name: 'Spend Tester', moniker: null, honorific: null,
  clan: 'Mekhet', covenant: 'Invictus', player: 'Test Player Spend',
  blood_potency: 1, humanity: 7, humanity_base: 7, court_title: null, retired: false,
  status: { city: 1, clan: 1, covenant: {} },
  // Resolve(3) + Composure(3) -> calcWillpowerMax = 6. BP 1 -> calcVitaeMax = 10 (BP_TABLE).
  // No tracker_state row is seeded remotely — ensureLoaded() falls back to these real, sheet-
  // computed defaults (full Vitae/Willpower), which is itself deterministic and known.
  attributes: {
    Intelligence: { dots: 2, bonus: 0 }, Wits: { dots: 2, bonus: 0 }, Resolve: { dots: 3, bonus: 0 },
    Strength: { dots: 2, bonus: 0 }, Dexterity: { dots: 2, bonus: 0 }, Stamina: { dots: 2, bonus: 0 },
    Presence: { dots: 2, bonus: 0 }, Manipulation: { dots: 2, bonus: 0 }, Composure: { dots: 3, bonus: 0 },
  },
  skills: {}, disciplines: {}, merits: [], powers: [], ordeals: [], banes: [],
};

async function setupSuite(page) {
  await page.addInitScript((user) => {
    localStorage.setItem('tm_auth_token', 'local-test-token');
    localStorage.setItem('tm_auth_expires', String(Date.now() + 3600000));
    localStorage.setItem('tm_auth_user', JSON.stringify(user));
  }, PLAYER_USER);

  await page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(/\/api\/characters$/, r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('/');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
}

async function openSheetFixture(page) {
  await page.evaluate(async (c) => {
    const m = await import('/js/suite/data.js');
    const tracker = await import('/js/game/tracker.js');
    m.default.chars = [c];
    await tracker.ensureLoaded(c);
    window.onSheetChar(c.name);
    window.goTab('stats');
  }, CHAR);
  await page.waitForSelector('#t-stats.active', { state: 'visible', timeout: 5000 });
  await page.waitForSelector('#tb-vitae .tbox', { timeout: 5000 });
}

test.describe('Game 9 prep — player Vitae/Willpower self-spend', () => {
  test('tapping a filled vitae box spends down to it', async ({ page }) => {
    await setupSuite(page);
    await openSheetFixture(page);

    await expect(page.locator('#tn-vitae')).toHaveText('10/10');
    // idx 0 is filled (current 10 > 0) — tapping it spends down to 0, i.e. spends all 10.
    await page.click('[data-tracker="vitae"][data-idx="0"]', { force: true });
    await expect(page.locator('#tn-vitae')).toHaveText('0/10');
  });

  test('tapping a filled willpower box spends down to it', async ({ page }) => {
    await setupSuite(page);
    await openSheetFixture(page);

    await expect(page.locator('#tn-wp')).toHaveText('6/6');
    // idx 2 is filled (current 6 > 2) — tapping it spends down to 2, i.e. spends 4.
    await page.click('[data-tracker="wp"][data-idx="2"]', { force: true });
    await expect(page.locator('#tn-wp')).toHaveText('2/6');
  });

  test('tapping an EMPTY vitae box (an attempted self-restore) is a silent no-op', async ({ page }) => {
    await setupSuite(page);
    await openSheetFixture(page);

    // First spend down to 4 (a real, legitimate spend), leaving indices 4-9 empty.
    await page.click('[data-tracker="vitae"][data-idx="4"]', { force: true });
    await expect(page.locator('#tn-vitae')).toHaveText('4/10');

    // idx 8 is now empty (current 4 <= 8) — a player tapping it must not restore anything.
    await page.click('[data-tracker="vitae"][data-idx="8"]', { force: true });
    await page.waitForTimeout(200);
    await expect(page.locator('#tn-vitae')).toHaveText('4/10');
  });

  test('tapping an EMPTY willpower box (an attempted self-restore) is a silent no-op', async ({ page }) => {
    await setupSuite(page);
    await openSheetFixture(page);

    await page.click('[data-tracker="wp"][data-idx="1"]', { force: true }); // spend down to 1
    await expect(page.locator('#tn-wp')).toHaveText('1/6');

    await page.click('[data-tracker="wp"][data-idx="4"]', { force: true }); // empty — no-op
    await page.waitForTimeout(200);
    await expect(page.locator('#tn-wp')).toHaveText('1/6');
  });

  test('Health stays fully non-interactive for a player', async ({ page }) => {
    await setupSuite(page);
    await openSheetFixture(page);

    const beforeText = await page.locator('#tn-health').textContent();
    await page.click('[data-tracker="health"][data-idx="0"]', { force: true });
    await page.waitForTimeout(200);
    await expect(page.locator('#tn-health')).toHaveText(beforeText);
  });
});
