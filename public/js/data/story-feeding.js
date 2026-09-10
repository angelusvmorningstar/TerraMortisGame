// Cross-app read path into TM Story's downtime store (Epic 12, Story 12.1).
//
// Every other client fetch in this app is same-origin and goes through
// `data/api.js`. This one deliberately does not: TM Game's own server reads
// `tm_game`, and Epic 8 moved all real downtime storage to `tm_story`, which
// only TM Story's service holds a credential for. Rather than hand a
// player-facing server a second database credential, this module calls TM
// Story's own read route over HTTP, exactly as TM Herald does for TM Game's
// public API.
//
// Auth is the token this app already holds. TM Story's `requireAuth` is a
// near-verbatim port of this repo's own middleware and re-validates any
// Discord access token against Discord's `/users/@me`, and both apps share
// the same Discord OAuth application, so the token issued by TM Game's own
// login is already valid there. No new auth mechanism is introduced here.
//
// NOTHING IN THE UI CONSUMES THIS YET. Story 12.1 only proves the fetch
// reaches real data; Story 12.2 decides what the Feeding tab does with it.
// `public/js/tabs/feeding-tab.js` is deliberately untouched by this story.
//
// KNOWN PRODUCTION GAP (Story 12.1 AC 4): TM Story's CORS allowlist
// (`CORS_ORIGIN` on its Render service) has never included TM Game's deployed
// origin, because until now no genuinely separate app called it cross-origin.
// Until that env var is updated in the Render dashboard, this fetch will fail
// CORS in production. That is why every failure path below degrades to a
// plain "no data" result instead of throwing.

// Resolved per call, not at module load, for the same reason `data/api.js`'s
// own `apiBase()` is (see its comment): a module-scope `location` read makes
// this module un-importable outside a browser.
//
// The localhost branch is an override point as much as a default: TM Story's
// own dev server pins itself to port 3000, which is also where this repo's
// local API lives, so the two cannot both hold that port on one machine. Set
// `tm_story_api_base` in localStorage to point at wherever TM Story is
// actually listening (or at the live service) when testing locally.
export const STORY_API_PROD = 'https://tm-story-api.onrender.com';
export const STORY_API_LOCAL = 'http://localhost:3000';
export const STORY_API_OVERRIDE_KEY = 'tm_story_api_base';

// External review finding (Codex, 2026-09-10, High): the override below used to be honoured
// on ANY host, including production. Since it carries the Discord bearer token with it, that
// meant any code able to write this one localStorage key - an XSS, a compromised extension, a
// stale value left over from testing - could redirect the token to an arbitrary origin. Reproduced
// live: a value of 'https://attacker.example/collect' silently exfiltrated the token from a
// production hostname. Fixed by only ever consulting the override on localhost, and requiring the
// parsed value to be a bare http(s) origin (no path/query/fragment/credentials) - it can point
// local dev at a different port, never at a scheme or shape that could smuggle anything extra.
function isBareHttpOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && !url.username && !url.password
    && (url.pathname === '' || url.pathname === '/')
    && !url.search && !url.hash;
}

export function storyApiBase() {
  const isLocalhost = typeof location !== 'undefined' && location.hostname === 'localhost';
  if (isLocalhost && typeof localStorage !== 'undefined') {
    let override = null;
    try {
      override = localStorage.getItem(STORY_API_OVERRIDE_KEY);
    } catch {
      // Storage access can throw (sandboxed/opaque origin, blocked storage) - fall through to
      // the plain local default rather than propagate, matching this module's own
      // never-throws contract.
    }
    if (override && isBareHttpOrigin(override)) return override.replace(/\/+$/, '');
  }
  return isLocalhost ? STORY_API_LOCAL : STORY_API_PROD;
}

// The contract is fixed by TM Story's own router mount
// (`/api/wiki/v1` in its `server/index.js`), not invented here.
export function storyFeedingPath(characterId, cycleId) {
  return `/api/wiki/v1/downtime/submissions/${encodeURIComponent(characterId)}`
    + `/${encodeURIComponent(cycleId)}/feeding`;
}

export function storyFeedingUrl(characterId, cycleId) {
  return `${storyApiBase()}${storyFeedingPath(characterId, cycleId)}`;
}

function unavailable(reason, httpStatus = 0, detail = null) {
  return { ok: false, data: null, reason, httpStatus, detail };
}

/**
 * Read one character's `content.feeding` sub-document for one cycle from TM
 * Story.
 *
 * Never throws and never rejects: this data source is expected to be
 * unreachable at times (CORS gap above, a cold Render dyno, a player with no
 * submission for the cycle), and a caller must be able to treat all of that
 * uniformly as "no data available".
 *
 * Resolves to either:
 *   { ok: true,  data: <TM Story's response body, verbatim>, httpStatus }
 *   { ok: false, data: null, reason, httpStatus, detail }
 *
 * `data` is passed through unreshaped and unnormalised - whatever TM Story
 * really sends, which is `content.feeding` (possibly partially or wholly
 * absent, on historical submissions) plus `lifecycle_state` and `status` from
 * the parent submission, plus `territory_influence` (Story 12.3: TM Story
 * commit 18bbc23 added it as a FOURTH key, `content.territory_influence`
 * verbatim or null - a sibling of `feeding`, not nested inside it, carrying
 * `{ spends: [{ territory: { id, label }, amount }] }` on a current-format
 * submission). No change was needed here for that: this function already
 * returns the whole body verbatim. Normalising historical documents is
 * Story 12.5.
 *
 * `reason` is one of:
 *   'bad-args'      - a missing character or cycle id; no request was made
 *   'no-token'      - no Discord token in localStorage; no request was made
 *   'network'       - fetch itself failed (offline, DNS, CORS rejection)
 *   'unauthorised'  - 401/403 from TM Story
 *   'not-found'     - 404, i.e. no submission or no feeding data
 *   'http'          - any other non-2xx
 *   'bad-json'      - 2xx whose body would not parse
 */
export async function fetchStoryFeeding(characterId, cycleId) {
  if (!characterId || !cycleId) return unavailable('bad-args');

  // External review finding (Codex, 2026-09-10, Low): a bare `localStorage.getItem` here sat
  // outside any try/catch, so a throwing accessor (a sandboxed/opaque origin, storage blocked by
  // policy) turned this into a rejected promise - breaking the "never throws" contract the rest
  // of this function is built around. Reproduced live with a throwing getter.
  let token = null;
  try {
    if (typeof localStorage !== 'undefined') token = localStorage.getItem('tm_auth_token');
  } catch {
    return unavailable('no-token');
  }
  if (!token) return unavailable('no-token');

  let res;
  try {
    res = await fetch(storyFeedingUrl(characterId, cycleId), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });
  } catch (err) {
    // Includes the CORS rejection case: the browser surfaces a blocked
    // cross-origin response as a TypeError here, indistinguishable from a
    // genuine network failure.
    return unavailable('network', 0, err && err.message ? err.message : String(err));
  }

  if (!res.ok) {
    const reason = (res.status === 401 || res.status === 403) ? 'unauthorised'
      : (res.status === 404) ? 'not-found'
        : 'http';
    return unavailable(reason, res.status);
  }

  if (res.status === 204) return { ok: true, data: null, httpStatus: 204 };

  let data;
  try {
    data = await res.json();
  } catch {
    return unavailable('bad-json', res.status);
  }

  return { ok: true, data, httpStatus: res.status };
}
