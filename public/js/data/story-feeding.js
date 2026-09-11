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
// Story 12.1 only proved the fetch reached real data; Story 12.2 gave the
// Feeding tab a read-only view of a roll already made in the downtime form; and
// Story 12.7 added the WRITE half at the bottom of this file, which is what makes
// `public/js/tabs/feeding-tab.js` a pure client of TM Story rather than a tab
// that writes feeding results into TM Game's own retired
// `tm_game.downtime_submissions`. (This header used to end "NOTHING IN THE UI
// CONSUMES THIS YET" - true when 12.1 shipped, false since 12.2.)
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

// ── Story 12.7: the write half, and the two reference reads it needs ──────────
//
// Story 12.1 built the read; this is the missing other half of the same pattern.
// Everything below calls TM Story over the same HTTP boundary, with the same
// Discord bearer token, for the same reason spelled out in this file's header: TM
// Game's own server holds no `tm_story` credential and must not be given one.
//
// THE ROLL PATH IS THE ONE NAMED IN THE STORY. Story 12.7's Architecture section
// specifies `POST .../submissions/:character_id/:cycle_id/feeding/roll`, and the
// server half was being built in parallel with this client. If the route landed
// at a different path, THIS CONSTANT IS THE ONLY PLACE TO CHANGE.
export function storyFeedingRollPath(characterId, cycleId) {
  return `${storyFeedingPath(characterId, cycleId)}/roll`;
}

// THE DECLARATION PATH IS AN ASSUMPTION, AND IS FLAGGED AS ONE.
//
// Story 12.7 documents an endpoint for the ROLL only, but Angelus's own workflow
// ruling for this story is that once the roll exists, the vessel feed and the
// vitae heal both open together, "completable now, not gated one at a time across
// separate visits" - which means TM Game must be able to write
// `content.feeding.vesselVitae` and `content.feeding.aggHealed` as well, or the
// panels would be a second silent-drop of exactly the kind this story exists to
// remove. No path for that is named anywhere in the story, so this one is
// inferred from the roll route's own shape rather than guessed at random.
//
// It must be confirmed against the server half before this ships. A 404 here is
// surfaced to the player as a plain "could not save" (never a silent success), so
// a wrong guess degrades honestly rather than losing a declaration.
export function storyFeedingDeclarationPath(characterId, cycleId) {
  return `${storyFeedingPath(characterId, cycleId)}/declaration`;
}

// Already live (Story 11.9, TM Story's own `wiki-downtime-reference.js:343`).
// Story 12.7 AC 12: the template list is READ from here, never a second hardcoded
// copy in TM Game.
export const STORY_FEEDING_TEMPLATES_PATH = '/api/wiki/v1/downtime/feeding-templates';

// Already live (Story 11.10). Supplies the "Same as Last Time" recall offer.
export function storyPreviousPath(characterId, cycleId) {
  return `/api/wiki/v1/downtime/submissions/${encodeURIComponent(characterId)}`
    + `/${encodeURIComponent(cycleId)}/previous`;
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

// ── Story 12.7: shared request plumbing for the new calls ────────────────────
//
// `fetchStoryFeeding` above is deliberately NOT refactored onto this: its exact
// reason strings and never-throws contract are pinned by Story 12.1's own tests,
// and rewriting a shipped, reviewed function to share a helper with new code is
// how a working read acquires a new bug. This helper repeats its shape instead.

function storyToken() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem('tm_auth_token');
  } catch {
    // A throwing accessor (sandboxed/opaque origin, storage blocked by policy) is
    // "no token", never a rejected promise - same contract as the read above.
    return null;
  }
  return null;
}

/**
 * One request against TM Story, resolved to the same result shape the read uses.
 *
 * Never throws and never rejects, for the same reasons documented on
 * `fetchStoryFeeding`. `reason` carries the same vocabulary, plus:
 *   'conflict'  - 409, i.e. a roll already exists for this submission
 *   'refused'   - 400, i.e. TM Story rejected the declaration itself
 *
 * `detail` carries TM Story's own human-readable message when it sent one, so a
 * refusal the player can act on ("Custom pools can only be declared in the
 * downtime form") reaches the screen instead of a generic failure.
 */
async function storyRequest(method, path, body) {
  const token = storyToken();
  if (!token) return unavailable('no-token');

  let res;
  try {
    res = await fetch(`${storyApiBase()}${path}`, {
      method,
      headers: {
        'Accept': 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'Authorization': `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    return unavailable('network', 0, err && err.message ? err.message : String(err));
  }

  // Parsed BEFORE the ok check: a non-2xx from TM Story's own `fail()` helper
  // carries `{ error, message }`, and that message is the whole point of showing
  // a refusal rather than a shrug.
  let data = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const reason = (res.status === 401 || res.status === 403) ? 'unauthorised'
      : res.status === 404 ? 'not-found'
        : res.status === 409 ? 'conflict'
          : res.status === 400 ? 'refused'
            : 'http';
    const detail = (data && typeof data.message === 'string') ? data.message : null;
    return unavailable(reason, res.status, detail);
  }

  if (res.status === 204) return { ok: true, data: null, httpStatus: 204 };
  if (data === null) return unavailable('bad-json', res.status);
  return { ok: true, data, httpStatus: res.status };
}

/**
 * The live feeding-template list (Story 12.7, AC 12).
 *
 * Resolves to `{ ok: true, data: [...] }` with TM Story's `templates` array
 * unwrapped, or the same `{ ok: false, reason }` shape as every other call here.
 * An unreachable list is NOT topped up from a local seed - see
 * `normaliseTemplates` in `story-feeding-rules.js` for why.
 */
export async function fetchStoryFeedingTemplates() {
  const res = await storyRequest('GET', STORY_FEEDING_TEMPLATES_PATH);
  if (!res.ok) return res;
  const list = Array.isArray(res.data?.templates) ? res.data.templates : [];
  return { ok: true, data: list, httpStatus: res.httpStatus };
}

/**
 * The previous cycle's own declaration, for the "Same as Last Time" recall card.
 *
 * `data` is TM Story's `previous` key verbatim (its own allowlist projection), or
 * null when there genuinely is nothing to recall - which is a 200, not an error.
 */
export async function fetchStoryPrevious(characterId, cycleId) {
  if (!characterId || !cycleId) return unavailable('bad-args');
  const res = await storyRequest('GET', storyPreviousPath(characterId, cycleId));
  if (!res.ok) return res;
  return { ok: true, data: res.data?.previous ?? null, httpStatus: res.httpStatus };
}

/**
 * Commit a feeding roll (Story 12.7, AC 6).
 *
 * `pick` carries TRAIT PICKS ONLY - never a pool total, never dice. AC 2 rules
 * that the route derives the real effective pool server-side (Feeding Grounds,
 * Area of Expertise, the unskilled penalty, 9-again and rote eligibility) and
 * calls TM Story's own `rollPool()`; a client-supplied number would be the second
 * independent implementation the data-lock ruled out.
 *
 * Expected `pick` keys: `method`, `poolAttr`, `poolSkill`, `poolDisc`,
 * `poolSpecChip`, `bloodType`, `violence`, and `territory` when the client has
 * one. A frozen declaration sends back exactly what is already stored, which is
 * what AC 3's "the pool is frozen once final" comparison expects to see.
 */
export async function postStoryFeedingRoll(characterId, cycleId, pick) {
  if (!characterId || !cycleId) return unavailable('bad-args');
  return storyRequest('POST', storyFeedingRollPath(characterId, cycleId), pick || {});
}

/**
 * Commit the vessel feed and the vitae heal together (one write, one sitting).
 *
 * `declaration` carries `{ vesselVitae: [n, ...], aggHealed: n }`. See
 * `storyFeedingDeclarationPath` above: THIS PATH IS AN ASSUMPTION pending the
 * server half of Story 12.7, and a 404 from it is surfaced to the player rather
 * than swallowed.
 */
export async function postStoryFeedingDeclaration(characterId, cycleId, declaration) {
  if (!characterId || !cycleId) return unavailable('bad-args');
  return storyRequest('POST', storyFeedingDeclarationPath(characterId, cycleId), declaration || {});
}
