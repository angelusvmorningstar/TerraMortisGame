/**
 * Spheres domain view — aggregates Sway (and any legacy Allies or Status) and Contacts influence
 * merits across all active characters, grouped by sphere.
 *
 * One pyramid per sphere, headed "Sway". A character's score in a sphere is their Sway dots (plus any
 * legacy Allies or Status dots) summed and capped at 5, the same merged score TM Story and TM Admin
 * show. Each merit counts at the dots the sheet shows: its stored rating plus its `bonus`, which is
 * the ST Mods overlay applied to this page's own copy of the characters in initSpheresView (a whole
 * number only; nothing here is ever saved). Contacts is presence-only (one contact per listed sphere,
 * not the rating).
 */

import { apiGet } from '../data/api.js';
import { applyDerivedMerits } from '../editor/mci.js';
import { esc, displayName, sortName, discordAvatarUrl, isRedactMode } from '../data/helpers.js';
import { INFLUENCE_SPHERES } from '../data/constants.js';
import { applyOverlayToAll } from '../data/st-mods.js';
import { getGlobalSettings } from '../data/app-settings.js';

function avatarUrl(c) {
  const pi = c._player_info || {};
  if (isRedactMode() || !pi.discord_id || !pi.discord_avatar) {
    if (isRedactMode()) return discordAvatarUrl(null, null);
    let h = 0;
    const s = String(c._id || c.name || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return `https://cdn.discordapp.com/embed/avatars/${Math.abs(h) % 6}.png`;
  }
  return discordAvatarUrl(pi.discord_id, pi.discord_avatar, 64);
}

let chars = [];

export async function initSpheresView() {
  const container = document.getElementById('spheres-content');
  if (!container) return;
  container.innerHTML = '<p class="placeholder">Loading spheres\u2026</p>';

  try {
    chars = await apiGet('/api/characters');
    chars.forEach(c => applyDerivedMerits(c));
    // Apply the ST Mods so a Sway carried by a merits.N.bonus mod counts at the dots the sheet shows. This
    // module's `chars` is its own copy (never saved), and the global switch is read the way admin.js does.
    await applyOverlayToAll(chars, getGlobalSettings()?.st_mods_enabled !== false);
  } catch {
    container.innerHTML = '<p class="placeholder">Failed to load character data.</p>';
    return;
  }

  container.innerHTML = renderSpheres();
}

/**
 * Normalise a sphere name for caseless matching.
 * "high society", "High Society", "  HIGH SOCIETY  " all collapse to "High Society".
 */
function normaliseSphere(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Merit names that contribute dots to a sphere's rank score.
 * Contacts is presence-only and is tracked separately.
 *
 * 2026-08-26 Sway merge (Angelus's ruling): 'Allies' and 'Status' become one merit, 'Sway'.
 * 'Sway' is ADDED here rather than replacing the other two — characters.merits[] is migrating
 * incrementally (see server/scripts/migrate-allies-to-sway.js), so this page must render
 * correctly for a character in either state, not just the end state. A migrated character's
 * 'Sway' dots are routed into the `allies` accumulator below (arbitrary but stable, matching the
 * `rule_key:'allies'` the merit inherited). The two pyramid columns this page used to draw
 * ("Status" and "Allies") are now ONE pyramid headed "Sway": every live influence merit is a Sway
 * (66 of 66 on 2026-10-01, none named Allies or Status), so the Status column was permanently empty
 * and the Allies column was a mislabel. This is the collapse the 2026-08-26 ruling deferred.
 */
const DOTTED_MERITS = new Set(['Allies', 'Status', 'Sway']);

function getSpheresData(list = chars) {
  const active = list.filter(c => !c.retired);
  const spheres = {}; // canonicalSphere -> charId -> { name, allies, status, mortalStatus, hasContacts }

  const ensureRow = (key, c) => {
    if (!spheres[key]) spheres[key] = {};
    const cid = String(c._id || c.name);
    if (!spheres[key][cid]) {
      spheres[key][cid] = { c, allies: 0, status: 0, hasContacts: false };
    }
    return spheres[key][cid];
  };

  for (const c of active) {
    for (const m of (c.merits || [])) {
      if (m.category !== 'influence') continue;
      // Sway (and legacy Allies/Status) count at the dots the sheet shows: the stored rating plus a
      // whole-number `bonus` (the ST Mods overlay). Contacts is presence-only and reads the rating.
      const bonus = Number.isInteger(m.bonus) ? m.bonus : 0;
      const dots = (m.rating || 0) + (m.name === 'Contacts' ? 0 : bonus);
      if (dots <= 0) continue;
      const raw = (m.area || m.qualifier || '').toString();
      if (!raw && m.name !== 'Contacts') continue;

      if (m.name === 'Contacts') {
        const parts = [];
        if (raw) parts.push(...raw.split(','));
        if (Array.isArray(m.spheres)) parts.push(...m.spheres.filter(Boolean));
        for (const part of parts) {
          const key = normaliseSphere(part);
          if (!key) continue;
          ensureRow(key, c).hasContacts = true;
        }
      } else if (DOTTED_MERITS.has(m.name)) {
        for (const part of raw.split(',')) {
          const key = normaliseSphere(part);
          if (!key) continue;
          const row = ensureRow(key, c);
          if (m.name === 'Allies' || m.name === 'Sway') row.allies += dots;
          else if (m.name === 'Status') row.status += dots;
        }
      }
    }
  }

  // Ensure all 16 canonical spheres appear, even if vacant
  for (const canonical of INFLUENCE_SPHERES) {
    if (!spheres[canonical]) spheres[canonical] = {};
  }

  // Convert to sorted array per sphere — sort rows by total dots (desc), then name
  const out = [];
  for (const sphere of Object.keys(spheres)) {
    const rows = Object.values(spheres[sphere]).map(r => ({
      ...r,
      // The merged score: Sway (and legacy Allies and Status) summed, capped at 5 (sum-capped-5).
      total: Math.min(5, r.allies + r.status),
    }));
    rows.sort((a, b) => b.total - a.total || sortName(a.c).localeCompare(sortName(b.c)));
    const sphereTotal = rows.reduce((s, r) => s + r.total, 0);
    out.push({ sphere, rows, total: sphereTotal });
  }
  // Occupied spheres first (by total desc), then vacant spheres alphabetically
  out.sort((a, b) => {
    const aOcc = a.total > 0 ? 1 : 0;
    const bOcc = b.total > 0 ? 1 : 0;
    if (aOcc !== bOcc) return bOcc - aOcc;
    if (a.total !== b.total) return b.total - a.total;
    return a.sphere.localeCompare(b.sphere);
  });
  return out;
}

function renderSpherePyramid(rows, dimension) {
  const holders = rows
    .filter(r => r[dimension] > 0)
    .sort((a, b) => b[dimension] - a[dimension] || sortName(a.c).localeCompare(sortName(b.c)));

  const apex      = holders.find(r => r[dimension] === 5) || null;
  const highSeats = holders.filter(r => r[dimension] === 4).slice(0, 2);
  const floor     = holders.filter(r => r[dimension] < 4);

  const highSlots = [...highSeats];
  while (highSlots.length < 2) highSlots.push(null);

  let h = `<div class="sph-pyramid-col">`;
  h += `<div class="sph-pyramid-col-head">Sway</div>`;

  // Apex
  if (apex) {
    h += `<div class="sph-apex">`;
    h += `<div class="sph-apex-info">`;
    h += `<span class="sph-apex-name">${esc(apex.c.moniker || apex.c.name)}</span>`;
    h += `</div>`;
    h += `<span class="sph-apex-val">5</span>`;
    h += `</div>`;
  } else {
    h += `<div class="sph-apex sph-vacant"><span class="sph-vacant-label">Vacant</span></div>`;
  }

  // High seats
  h += `<div class="sph-high-row">`;
  for (const r of highSlots) {
    if (r) {
      h += `<div class="sph-high">`;
      h += `<span class="sph-high-val">4</span>`;
      h += `<span class="sph-high-name">${esc(r.c.moniker || r.c.name)}</span>`;
      h += `</div>`;
    } else {
      h += `<div class="sph-high sph-vacant"><span class="sph-vacant-label">\u2013</span></div>`;
    }
  }
  h += `</div>`;

  // Floor: one tier-block container per dot value, descending
  if (floor.length) {
    const groups = [];
    for (const r of floor) {
      const last = groups[groups.length - 1];
      if (last && last.val === r[dimension]) last.items.push(r);
      else groups.push({ val: r[dimension], items: [r] });
    }
    for (const g of groups) {
      g.items.sort((a, b) => (a.c.moniker || a.c.name).localeCompare(b.c.moniker || b.c.name));
      h += `<div class="sph-tier-block">`;
      h += `<div class="sph-tier-num">${g.val}</div>`;
      for (const r of g.items) {
        h += `<div class="sph-tier-row">${esc(r.c.moniker || r.c.name)}</div>`;
      }
      h += `</div>`;
    }
  }

  h += `</div>`;
  return h;
}

function renderSphereCard({ sphere, rows, total }) {
  const vacant = rows.filter(r => r.total > 0 || r.hasContacts).length === 0;
  let h = `<div class="sphere-card${vacant ? ' sphere-card-vacant' : ''}">`;
  h += `<div class="sphere-head"><span class="sphere-name">${esc(sphere)}</span>`;
  if (!vacant) h += `<span class="sphere-total">${total} dots</span>`;
  h += `</div>`;

  if (vacant) {
    h += `<p class="sphere-vacant-msg">No current holders</p>`;
  } else {
    h += `<div class="sph-pyramid-split">`;
    h += renderSpherePyramid(rows, 'total');
    h += `</div>`;

    const contactChars = rows
      .filter(r => r.hasContacts)
      .sort((a, b) => sortName(a.c).localeCompare(sortName(b.c)));
    if (contactChars.length) {
      h += `<div class="sph-contacts-section">`;
      h += `<div class="sph-contacts-label">Contacts</div>`;
      h += `<div class="sph-contacts-chips">`;
      for (const r of contactChars) {
        h += `<div class="sph-contact-chip">`;
        h += `<span class="sph-contact-name">${esc(r.c.moniker || r.c.name)}</span>`;
        h += `</div>`;
      }
      h += `</div>`;
      h += `</div>`;
    }
  }

  h += `</div>`;
  return h;
}

export function renderSpheres(list = chars) {
  const data = getSpheresData(list);
  let h = `<div class="spheres-grid">`;
  for (const entry of data) h += renderSphereCard(entry);
  h += `</div>`;
  return h;
}
