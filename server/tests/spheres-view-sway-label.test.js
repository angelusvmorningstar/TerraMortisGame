/**
 * Spheres domain view (admin): one pyramid headed "Sway", counted at the dots the sheet shows.
 *
 * Since the 2026-08-26 Allies and Status merge every live influence merit is a Sway (66 of 66 on
 * 2026-10-01). The page still drew two pyramid columns, "Status" (permanently empty) and "Allies"
 * (which held every Sway, so it was a mislabel), and counted only the stored `rating`, so a Sway
 * carried by a `merits.N.bonus` ST Mod (Orenthal's two, Samuel's one) was missing or short, and a
 * holder whose dots summed above 5 dropped off the pyramid. TM Story and TM Admin already show the
 * merged, capped score; this brings the third copy into line.
 *
 * Real renderSpheres() throughout. The runner has no DOM, so the browser-bound modules the view
 * imports (api, derived-merit rules, the ST Mods loader, settings, the helpers) are mocked, and
 * initSpheresView runs against a one-element `document` stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiGet = vi.fn();
const applyOverlayToAll = vi.fn(async (chars) => chars);
const getGlobalSettings = vi.fn(() => null);

vi.mock('../../public/js/data/api.js', () => ({ apiGet: (...a) => apiGet(...a) }));
vi.mock('../../public/js/editor/mci.js', () => ({ applyDerivedMerits: () => {} }));
vi.mock('../../public/js/data/st-mods.js', () => ({ applyOverlayToAll: (...a) => applyOverlayToAll(...a) }));
vi.mock('../../public/js/data/app-settings.js', () => ({ getGlobalSettings: () => getGlobalSettings() }));
vi.mock('../../public/js/data/helpers.js', () => ({
  esc: (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
  displayName: (c) => c.moniker || c.name,
  sortName: (c) => String(c.moniker || c.name || '').toLowerCase(),
  discordAvatarUrl: () => '',
  isRedactMode: () => false,
}));

const { renderSpheres, initSpheresView } = await import('../../public/js/admin/spheres-view.js');

const ch = (id, name, merits, extra = {}) => ({ _id: id, name, merits, ...extra });
const sway = (area, rating, extra = {}) => ({ category: 'influence', name: 'Sway', area, rating, ...extra });
const legacy = (name, area, rating) => ({ category: 'influence', name, area, rating });

// The card for one sphere, as an HTML slice.
function card(html, sphere) {
  const start = html.indexOf(`<span class="sphere-name">${sphere}</span>`);
  expect(start, `${sphere} card present`).toBeGreaterThan(-1);
  const next = html.indexOf('<div class="sphere-card', start);
  return html.slice(start, next === -1 ? undefined : next);
}
const count = (html, needle) => html.split(needle).length - 1;

beforeEach(() => {
  apiGet.mockReset();
  applyOverlayToAll.mockClear();
  getGlobalSettings.mockReset();
  getGlobalSettings.mockReturnValue(null);
});

describe('one pyramid, headed Sway', () => {
  it('draws a single pyramid column per occupied sphere, headed Sway, with no Allies or Status head', () => {
    const html = renderSpheres([ch('a', 'Alice', [sway('Street', 3)])]);
    const street = card(html, 'Street');
    expect(count(street, 'class="sph-pyramid-col"')).toBe(1);
    expect(street).toContain('<div class="sph-pyramid-col-head">Sway</div>');
    expect(street).not.toMatch(/sph-pyramid-col-head">(Allies|Status)</);
  });

  it('a vacant sphere still reads "No current holders" and draws no pyramid', () => {
    const vacant = card(renderSpheres([ch('a', 'Alice', [sway('Street', 3)])]), 'Church');
    expect(vacant).toContain('No current holders');
    expect(vacant).not.toContain('sph-pyramid-col');
  });
});

describe('Sway counts at the dots the sheet shows', () => {
  it("Orenthal's rating-0 Sway carried by a bonus of 3 holds 3 dots (he used to be missing)", () => {
    const html = renderSpheres([ch('o', 'Orenthal', [sway('Transportation', 0, { bonus: 3 }), sway('Underworld', 0, { bonus: 3 })])]);
    expect(card(html, 'Transportation')).toContain('<div class="sph-tier-num">3</div>');
    expect(card(html, 'Transportation')).toContain('Orenthal');
    expect(card(html, 'Underworld')).toContain('Orenthal');
  });

  it("Samuel's Sway of rating 1 plus a bonus of 2 holds 3 dots (he used to read 1)", () => {
    const street = card(renderSpheres([ch('s', 'Samuel', [sway('Street', 1, { bonus: 2 })])]), 'Street');
    expect(street).toContain('<div class="sph-tier-num">3</div>');
    expect(street).not.toContain('<div class="sph-tier-num">1</div>');
  });

  it('a control with no bonus counts exactly as before', () => {
    const street = card(renderSpheres([ch('c', 'Control', [sway('Street', 3)])]), 'Street');
    expect(street).toContain('<div class="sph-tier-num">3</div>');
  });

  it('only a whole-number bonus counts: a string, fraction, NaN or object is ignored', () => {
    for (const bonus of ['2', 1.5, Number.NaN, null, { n: 2 }]) {
      const street = card(renderSpheres([ch('x', 'X', [sway('Street', 2, { bonus })])]), 'Street');
      expect(street, `bonus ${String(bonus)}`).toContain('<div class="sph-tier-num">2</div>');
    }
    const nothing = renderSpheres([ch('z', 'Z', [sway('Legal', 0, { bonus: '3' })])]);
    expect(card(nothing, 'Legal')).toContain('No current holders');
  });

  it('a bonus that takes the total to 0 or below holds no Sway', () => {
    const html = renderSpheres([ch('n', 'N', [sway('Health', 1, { bonus: -1 }), sway('Church', 1, { bonus: -3 })])]);
    expect(card(html, 'Health')).toContain('No current holders');
    expect(card(html, 'Church')).toContain('No current holders');
  });

  it('Contacts stays presence-only: a bonus never turns it into a Sway holder', () => {
    const html = renderSpheres([ch('k', 'Contact', [{ category: 'influence', name: 'Contacts', area: 'Police', rating: 0, bonus: 3 }])]);
    expect(card(html, 'Police')).toContain('No current holders');
    const present = renderSpheres([ch('k', 'Contact', [{ category: 'influence', name: 'Contacts', area: 'Police', rating: 2 }])]);
    expect(card(present, 'Police')).toContain('sph-contact-chip');
    expect(card(present, 'Police')).not.toContain('sph-tier-num');
  });
});

describe('the merged score is capped at 5, so nobody drops off the pyramid', () => {
  it('one Sway of 3 plus a bonus of 3 is an apex holder with a score of 5 (it used to match no tier)', () => {
    const finance = card(renderSpheres([ch('x', 'Xavier', [sway('Finance', 3, { bonus: 3 })])]), 'Finance');
    expect(finance).toContain('<span class="sph-apex-name">Xavier</span>');
    expect(finance).toContain('<span class="sph-apex-val">5</span>');
  });

  it('two Sway merits in one sphere add and cap at 5; the sphere total counts the capped score', () => {
    const legal = card(renderSpheres([ch('t', 'Twin', [sway('Legal', 3), sway('Legal', 3)])]), 'Legal');
    expect(legal).toContain('<span class="sph-apex-name">Twin</span>');
    expect(legal).toContain('<span class="sphere-total">5 dots</span>');
  });

  it('legacy Allies plus Status still sum to one score, and a Sway of the same dots scores the same', () => {
    const a = card(renderSpheres([ch('a', 'A', [legacy('Allies', 'Police', 2), legacy('Status', 'Police', 1)])]), 'Police');
    const s = card(renderSpheres([ch('s', 'S', [sway('Police', 2), legacy('Status', 'Police', 1)])]), 'Police');
    expect(a).toContain('<div class="sph-tier-num">3</div>');
    expect(s).toContain('<div class="sph-tier-num">3</div>');
  });

  it('the sphere total is the sum of the capped scores (3 plus 3 reads 6 dots)', () => {
    const media = card(renderSpheres([ch('a', 'A', [sway('Media', 3)]), ch('b', 'B', [sway('Media', 3)])]), 'Media');
    expect(media).toContain('<span class="sphere-total">6 dots</span>');
  });

  it('retired characters are left out, as before', () => {
    const street = card(renderSpheres([ch('r', 'Retired', [sway('Street', 4)], { retired: true }), ch('a', 'Alive', [sway('Street', 2)])]), 'Street');
    expect(street).not.toContain('Retired');
    expect(street).toContain('Alive');
  });
});

describe('initSpheresView applies the ST Mods overlay to its own copy before drawing', () => {
  const container = () => { const el = { innerHTML: '' }; globalThis.document = { getElementById: (id) => (id === 'spheres-content' ? el : null) }; return el; };

  it('loads the characters, applies the overlay with the global switch on, and draws the Sway pyramid', async () => {
    const el = container();
    const chars = [ch('o', 'Orenthal', [sway('Underworld', 0, { bonus: 3 })])];
    apiGet.mockResolvedValue(chars);
    await initSpheresView();
    expect(apiGet).toHaveBeenCalledWith('/api/characters');
    expect(applyOverlayToAll).toHaveBeenCalledTimes(1);
    expect(applyOverlayToAll.mock.calls[0][0]).toBe(chars);
    expect(applyOverlayToAll.mock.calls[0][1]).toBe(true);
    expect(el.innerHTML).toContain('sph-pyramid-col-head">Sway<');
  });

  it('passes the overlay OFF when the global switch is off', async () => {
    container();
    getGlobalSettings.mockReturnValue({ st_mods_enabled: false });
    apiGet.mockResolvedValue([ch('a', 'A', [sway('Street', 2)])]);
    await initSpheresView();
    expect(applyOverlayToAll.mock.calls[0][1]).toBe(false);
  });

  it('an overlay failure shows the failure message and draws no pyramid with under-read dots', async () => {
    const el = container();
    apiGet.mockResolvedValue([ch('a', 'A', [sway('Street', 2)])]);
    applyOverlayToAll.mockRejectedValueOnce(new Error('st_mods unavailable'));
    await initSpheresView();
    expect(el.innerHTML).toContain('Failed to load character data.');
    expect(el.innerHTML).not.toContain('sph-pyramid-col');
  });
});
