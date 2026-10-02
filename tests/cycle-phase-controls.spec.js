/**
 * E2E tests — Admin Cycle tab: the phase is a READ-ONLY status (Story tm-admin.27.1, 2026-10-02).
 *
 * History: this file was written for CYCLE epic #708 story 3 (phase buttons, a Game confirm and a
 * tracker reset) and sat STALE AT BASE for a long time (recorded 2026-08-16 by CM-4a: 11 failed with
 * and without that change; it still asserted three buttons with the active one disabled). Story 27.1
 * retired the whole feature: TM Game no longer sets a Chapter's phase and never wipes the trackers
 * (TM Admin is the only phase writer, and PUT /api/chapters/:id refuses phase, game_phase and status
 * with a 409). The Cycle tab now shows the phase as a status, glyph plus words, with the note
 * "Set in TM Admin". This file was rewritten to pin that, so it no longer certifies behaviour that no
 * longer exists.
 */

const { test, expect } = require('@playwright/test');

// ── Test data ──────────────────────────────────────────────

const ST_USER = {
  id: '123456789', username: 'test_st', global_name: 'Test ST',
  avatar: null, role: 'st', player_id: 'p-001',
  character_ids: [], is_dual_role: false,
};

const TEST_STORY_CYCLES = [
  { _id: 'sc-001', number: 1, label: 'Story One', created_at: '2026-01-01T00:00:00.000Z' },
];

// cyc-001: declared phase 'processing'
// cyc-002: legacy shape, no phase fields, status 'active' (reads as downtime)
// cyc-003: declared phase 'game'
// cyc-004: nothing at all (no phase set)
const TEST_CYCLES = [
  { _id: 'cyc-001', label: 'DT 1', game_number: 1, phase: 'processing', game_phase: 'processing', story_cycle_id: 'sc-001', status: 'closed' },
  { _id: 'cyc-002', label: 'DT 2', game_number: 2, story_cycle_id: null, status: 'active' },
  { _id: 'cyc-003', label: 'DT 3', game_number: 3, phase: 'game', game_phase: 'game', story_cycle_id: null, status: 'game' },
  { _id: 'cyc-004', label: 'DT 4', game_number: 4, story_cycle_id: null },
];

// ── Helpers ───────────────────────────────────────────────

async function loginAsST(page) {
  await page.route('**/api/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/auth/me', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ST_USER) })
  );
  await page.route(/\/api\/characters$/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/api/characters/names', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.addInitScript((user) => {
    localStorage.setItem('tm_auth_token', 'fake-test-token');
    localStorage.setItem('tm_auth_expires', String(Date.now() + 3600000));
    localStorage.setItem('tm_auth_user', JSON.stringify(user));
  }, ST_USER);
}

/** Mocks the Cycle tab's APIs and RECORDS every write, so a test can prove none happened. */
async function mockCycleApis(page, { cycles = TEST_CYCLES } = {}) {
  const writes = [];
  await page.route(/\/api\/story_cycles$/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_STORY_CYCLES) })
  );
  await page.route(/\/api\/story_cycles\//, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  await page.route(/\/api\/chapters$/, route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cycles) })
  );
  await page.route(/\/api\/chapters\/[^/]+$/, route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/tracker_state$/, route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // Record EVERY non-GET request to ANY /api/ endpoint (not just the two retired ones), so a regression
  // that writes somewhere new cannot slip past a test titled "makes no API write". Tests clear the list
  // after the page has loaded and assert on what happens after that.
  page.on('request', req => {
    if (req.method() !== 'GET' && /\/api\//.test(req.url())) {
      writes.push({ method: req.method(), url: req.url(), body: req.postData() });
    }
  });
  return writes;
}

async function navigateToCycleTab(page) {
  await page.goto('/admin.html');
  await page.waitForSelector('#admin-app:not([style*="display: none"])');
  await page.click('.sidebar-btn[data-domain="cycle"]');
  await expect(page.locator('#d-cycle')).toHaveClass(/active/);
  await page.waitForFunction(() => {
    const el = document.getElementById('cycle-content');
    return el && !el.textContent.includes('Loading');
  }, { timeout: 5000 });
}

// ── Tests ────────────────────────────────────────────────

test.describe('Cycle tab — the phase is a read-only status', () => {
  let writes;
  test.beforeEach(async ({ page }) => {
    await loginAsST(page);
    writes = await mockCycleApis(page);
    await navigateToCycleTab(page);
  });

  test('every cycle row shows its phase as a status, with glyph and words', async ({ page }) => {
    const status = page.locator('.cy-phase-readonly');
    await expect(status).toHaveCount(TEST_CYCLES.length);
    const texts = (await status.allTextContents()).map(t => t.trim());
    // Order is by game number descending or ascending depending on the view, so compare as a set.
    expect(texts.sort()).toEqual(['○ No phase set', '● Downtime', '● Game', '● Processing'].sort());
  });

  test('every row says the phase is set in TM Admin', async ({ page }) => {
    await expect(page.locator('.cy-phase-readonly-note')).toHaveCount(TEST_CYCLES.length);
    for (const t of await page.locator('.cy-phase-readonly-note').allTextContents()) {
      expect(t.trim()).toBe('Set in TM Admin');
    }
  });

  test('there are no phase buttons on the Cycle tab', async ({ page }) => {
    await expect(page.locator('.cy-phase-btn')).toHaveCount(0);
    await expect(page.locator('.cy-phase-group')).toHaveCount(0);
  });

  test('clicking a phase status makes no API write and shows no dialog', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', async d => { dialogs += 1; await d.dismiss(); });
    writes.length = 0; // only what happens from here on counts
    for (const el of await page.locator('.cy-phase-readonly').all()) await el.click();
    expect(dialogs).toBe(0);
    expect(writes).toEqual([]);
  });
});
