/* Display helper functions — pure, no DOM manipulation */

import { ICONS } from './icons.js';
import { ARCHETYPES_DB } from './constants.js';
import { getRole } from '../auth/discord.js';
import { TERRITORY_DATA } from '../tabs/downtime-data.js';

/* ── Dev-mode redaction ────────────────────────────────────
   The 'dev' role has full ST-equivalent access but every character and
   player name shown in the UI is replaced with a black block so the
   developer can work on the app without seeing real player PII.
   Redaction happens at the display-helper level; underlying data on
   the character objects is untouched so lookups, sorts, and API
   round-trips all still work. */

const REDACT_BLOCK = '\u2588';

export function isRedactMode() {
  if (getRole() !== 'dev') return false;
  // Don't redact on the player portal — dev users see their own characters there
  if (location.pathname.startsWith('/player')) return false;
  // Don't redact when dev has Player Mode active
  if (sessionStorage.getItem('tm_view_mode') === 'player') return false;
  return true;
}

/** Replace a name-like string with a block-character placeholder.
 *  Length is clamped so layout stays stable without revealing exact length. */
function _blockOut(s, min = 8, max = 14) {
  if (s == null || s === '') return s;
  const len = Math.max(min, Math.min(max, String(s).length));
  return REDACT_BLOCK.repeat(len);
}

/** Wrap a raw player-name string for display. Returns the original string
 *  for non-dev roles; otherwise returns a block-character redaction. */
export function redactPlayer(s) {
  return isRedactMode() ? _blockOut(s, 6, 12) : s;
}

/** Wrap a raw character-name string for display (use when you need to show
 *  a name that didn't come through displayName(c) — e.g. legacy lookups). */
export function redactCharName(s) {
  return isRedactMode() ? _blockOut(s, 8, 14) : s;
}

/** Generic black-square avatar used in dev mode to redact Discord pics.
 *  Inline SVG data URL so no network call is made. */
const REDACTED_AVATAR =
  'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" fill="#000"/>' +
    '</svg>'
  );

/** Return a Discord CDN avatar URL, or the generic redacted block in dev mode.
 *  discordId / avatarHash may be null — falls back to Discord's default avatar
 *  set (embed/avatars/0.png) in normal mode. */
export function discordAvatarUrl(discordId, avatarHash, size = 64) {
  if (isRedactMode()) return REDACTED_AVATAR;
  if (discordId && avatarHash) {
    return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=${size}`;
  }
  return 'https://cdn.discordapp.com/embed/avatars/0.png';
}

const CLAN_ICON_KEY = {
  Daeva: 'daeva',
  Gangrel: 'gangrel',
  Mekhet: 'mekhet',
  Nosferatu: 'nosferatu',
  Ventrue: 'ventrue'
};

const COV_ICON_KEY = {
  'Carthian Movement': 'carthian',
  'Circle of the Crone': 'crone',
  'Invictus': 'invictus',
  'Lancea et Sanctum': 'lance'
};

export { CLAN_ICON_KEY, COV_ICON_KEY };

export function clanIcon(clan, sz) {
  const k = CLAN_ICON_KEY[clan];
  if (!k) return '';
  const u = ICONS[k];
  return '<span class="faction-icon clan-icon" style="-webkit-mask-image:url(\'' + u + '\');mask-image:url(\'' + u + '\');width:' + sz + 'px;height:' + sz + 'px;"></span>';
}

export function covIcon(cov, sz) {
  const k = COV_ICON_KEY[cov];
  if (!k) return '';
  const u = ICONS[k];
  return '<span class="faction-icon cov-icon" style="-webkit-mask-image:url(\'' + u + '\');mask-image:url(\'' + u + '\');width:' + sz + 'px;height:' + sz + 'px;"></span>';
}

export function shDots(n) {
  return '<span class="pointed"></span>'.repeat(Math.max(0, n || 0));
}

/** Render `base` filled dots followed by `bonus` hollow dots.
 *
 *  Issue #408 (Epic STM UX polish): optional `opts` lets callers tag
 *  a sub-range of dots as "ST-modded" — those dots receive the
 *  `stm-modded-dot` class + `data-stm-marker-path` attribute + a
 *  `title` tooltip. The delegated click handler at document.body
 *  (`installStModPopover`) dispatches on `data-stm-marker-path`, so
 *  clicking a modded dot opens the popover. This replaces the
 *  pre-#408 standalone `.stm-marker` pip that visually collided
 *  with the dot run.
 *
 *  opts = {
 *    filledMod: { from, to, path, title } | undefined,
 *    hollowMod: { from, to, path, title } | undefined,
 *  }
 *  Indices are zero-based into the respective stream
 *  (filled = positions [0..base-1]; hollow = positions [0..bonus-1]).
 *  `to` is exclusive. Callers compute hollow-stream indices including
 *  any auto-bonus offset (attributes: autoBonus dots come first in
 *  the hollow stream; modded manual bonus starts at autoBonus + ovBonus.base).
 *
 *  No-opts path is byte-identical to the pre-#408 implementation. */
export function shDotsWithBonus(base, bonus, opts) {
  if (!opts || (!opts.filledMod && !opts.hollowMod)) {
    if (!bonus) return shDots(base);
    return '<span class="pointed"></span>'.repeat(Math.max(0, base || 0)) + '<span class="pointed hollow"></span>'.repeat(Math.max(0, bonus || 0));
  }
  const fm = opts.filledMod;
  const hm = opts.hollowMod;
  let out = '';
  const baseN = Math.max(0, base || 0);
  for (let i = 0; i < baseN; i++) {
    if (fm && i >= fm.from && i < fm.to) {
      out += `<span class="pointed stm-modded-dot" data-stm-marker-path="${esc(fm.path || '')}" title="${esc(fm.title || '')}"></span>`;
    } else {
      out += '<span class="pointed"></span>';
    }
  }
  const bonusN = Math.max(0, bonus || 0);
  for (let i = 0; i < bonusN; i++) {
    if (hm && i >= hm.from && i < hm.to) {
      out += `<span class="pointed hollow stm-modded-dot" data-stm-marker-path="${esc(hm.path || '')}" title="${esc(hm.title || '')}"></span>`;
    } else {
      out += '<span class="pointed hollow"></span>';
    }
  }
  return out;
}

/** Card name: moniker || name, no honorific. Redacted in dev mode.
 *  Used for character grid cards where honorific is omitted for brevity. */
export function cardName(c) {
  const base = c.moniker || c.name;
  return isRedactMode() ? _blockOut(base, 10, 16) : base;
}

/** Display name: honorific + (moniker || name). Redacted in dev mode. */
export function displayName(c) {
  const base = c.moniker || c.name;
  const raw = c.honorific ? c.honorific + ' ' + base : base;
  return isRedactMode() ? _blockOut(raw, 10, 16) : raw;
}

/** Display name without redaction — for functional UI controls (dropdowns,
 *  option text) where the user needs to read the name to make a selection.
 *  Identical to displayName() but skips the dev-mode block-out. */
export function displayNameRaw(c) {
  const base = c.moniker || c.name;
  return c.honorific ? c.honorific + ' ' + base : base;
}

/** Sort key: moniker || name (no honorific). Not redacted — used only for
 *  internal sort order, never rendered to the DOM. */
export function sortName(c) {
  return (c.moniker || c.name || '').toLowerCase();
}

/** Dropdown option label: moniker || name (no honorific, no redaction).
 *  Honorifics make alphabetical scanning of long character lists hard
 *  ("Dr A", "Lord A", "Sister A" all clump under their titles instead
 *  of by name). Use for <option> labels in character pickers. */
export function dropdownName(c) {
  return c.moniker || c.name;
}

/**
 * Find a character's regent territory from the territories array.
 * Returns { territory, territoryId, slug, lieutenantId, ambience } or null.
 *
 * Pure function — recomputes on every call. Per issue #13 Surface 2 (audit
 * 2026-05-05), the previous c._regentTerritory cache could go stale when a
 * regent or ambience changed mid-session because no bust-on-write hook
 * existed. Recomputing on every call is O(N) over a 5-element territories
 * array; the caching layer was an unnecessary optimisation that introduced
 * a class of display-stale bugs.
 */
export function findRegentTerritory(territories, c) {
  if (!territories || !c) return null;
  const cid = String(c._id);
  // Prefer canonical territories over stale/orphaned duplicates (issue #216).
  // If multiple docs match the same regent_id, the one whose slug appears in
  // TERRITORY_DATA wins; otherwise the first match is used as a safe fallback.
  const canonicalSlugs = new Set(TERRITORY_DATA.map(td => td.slug));
  const matches = territories.filter(t => t.regent_id === cid);
  if (!matches.length) return null;
  const t = matches.find(m => canonicalSlugs.has(m.slug)) || matches[0];
  // territoryId is the canonical FK (Mongo _id, stringified) per ADR-002.
  // slug is exposed alongside for callers that need to match against legacy
  // slug-variant strings (e.g. submissions feeding_territories keys, Q4).
  return {
    territory: t.name || t.slug,
    territoryId: String(t._id),
    slug: t.slug || null,
    lieutenantId: t.lieutenant_id || null,
    ambience: t.ambience || null,
  };
}

export function esc(s) {
  return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function shortCov(c) {
  if (!c) return '?';
  const m = {
    'Carthian Movement': 'Carthian',
    'Circle of the Crone': 'Crone',
    'Lancea et Sanctum': 'Lance',
    'Ordo Dracul': 'Ordo'
  };
  return m[c] || c;
}

export function formatSpecs(c, specs) {
  if (!specs || !specs.length) return '';
  return specs.map(sp => {
    const enhanced = hasAoE(c, sp);
    return esc(sp) + (enhanced ? ' <span class="aoe-bonus">+2</span>' : '');
  }).join(', ');
}

export function hasAoE(c, specName) {
  return (c.merits || []).some(m =>
    m.name?.toLowerCase() === 'area of expertise' && m.qualifier && m.qualifier.toLowerCase() === specName.toLowerCase()
  );
}

export function isSpecs(c) {
  const results = [];
  for (const m of (c.merits || [])) {
    if (m.name?.toLowerCase() !== 'interdisciplinary specialty') continue;
    const q = m.qualifier || '';
    if (!q) continue;
    let fromSkill = null;
    for (const [skillName, so] of Object.entries(c.skills || {})) {
      if ((so.specs || []).some(s => s.toLowerCase() === q.toLowerCase())) {
        fromSkill = skillName;
        break;
      }
    }
    if (fromSkill) results.push({ spec: q, fromSkill });
  }
  return results;
}

/**
 * Derive willpower recovery conditions from a character's Mask and Dirge.
 * Never reads c.willpower — always computed from ARCHETYPES_DB.
 */
export function getWillpower(c) {
  const mask  = ARCHETYPES_DB[c.mask]  || {};
  const dirge = ARCHETYPES_DB[c.dirge] || {};
  return {
    mask_1wp:  mask.wp1   || '',
    mask_all:  mask.wpAll || '',
    dirge_1wp: dirge.wp1  || '',
    dirge_all: dirge.wpAll || '',
  };
}

/**
 * Resolve a shared_with entry (string) to a character object.
 * Accepts either a 24-hex ObjectId (new format) or a legacy character name.
 * Returns the matching character object, or null if not found.
 *
 * @param {Array} chars - state.chars array
 * @param {string} entry - _id hex string or character name
 * @returns {object|null}
 */
export function resolveSharedWithMember(chars, entry) {
  if (typeof entry === 'string' && /^[a-f0-9]{24}$/i.test(entry)) {
    return chars.find(ch => String(ch._id) === entry) || null;
  }
  return chars.find(ch => ch.name === entry) || null;
}

/**
 * Issue #816 / #496: canonical OID-to-slug boundary for territories.
 *
 * Territory values are persisted as ObjectId strings (`collectResponses()`
 * remaps at the save boundary), but `TERRITORY_DATA` and every `data-*`
 * attribute in the DT form carry short SLUGS. Any renderer or click handler
 * that compares a saved value against a slug must normalise first, or it
 * compares an OID to a slug and silently never matches — which is exactly
 * how the Ambience arrows lost their selection on every render after the
 * first collect (fixed 2026-07-30).
 *
 * Pass-through for values that are already slugs, empty, or unknown, so it is
 * safe to call on any territory field regardless of vintage.
 *
 * Territories are INJECTED rather than imported, per the ADR-006 D1
 * convention — this module stays pure and testable, and callers own the
 * lookup source.
 *
 * @param {Array} territories - the live territories list (objects with _id + slug)
 * @param {string} val - an ObjectId string, a slug, or ''
 * @returns {string} the matching slug, or `val` unchanged
 */
export function terrSlugFromId(territories, val) {
  if (!val || !/^[a-f0-9]{24}$/i.test(String(val))) return val || '';
  const t = (territories || []).find(x => String(x?._id) === String(val));
  return t?.slug || val;
}

/**
 * Parse a published downtime outcome string (## Section headings format)
 * into an array of { heading, body } objects for rendering.
 * If no ## headings found, returns a single entry with heading=null.
 */
export function parseOutcomeSections(text) {
  if (!text) return [];
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  if (!sections.length) return [{ heading: null, lines: text.split('\n') }];
  return sections;
}
