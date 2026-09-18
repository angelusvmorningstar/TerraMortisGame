/**
 * Story storytab.1: server-to-server fetch of a character's TM Story-sourced downtime
 * reports, plus the adapter that turns TM Story's own report shape into a `tm_game`-
 * shaped pseudo-submission this repo's EXISTING `renderOutcomeWithCards()`
 * (public/js/tabs/story-tab.js:384+) already knows how to render.
 *
 * WHY an adapter and not a second renderer: Angelus ruled (b) on the epic's own (a)-vs-(b)
 * question (widen TM Story's allowlist rather than build a second, TM-Story-shaped
 * renderer here), see ../TM Story/specs/stories/74-1-downtime-allowlist-widen-for-cross-
 * app-parity.md. That story widened TM Story's own `buildDowntimeReport()` to expose the
 * fields this repo's renderer needs, but the two shapes are still not byte-identical (TM
 * Story's declared content is `report.projects[]`/`.spheres[]` arrays; this repo's own
 * renderer reads flat `sub.responses.project_{n}_title` fields). Fetching alone is not
 * enough; this module also reshapes.
 *
 * READ-ONLY. This module issues exactly one outbound GET and returns a plain object; it
 * never writes anywhere, in either repo. See Story storytab.4 for the structural guard.
 */

const DEFAULT_TM_STORY_API_URL = 'https://tm-story-api.onrender.com';

function storyApiBaseUrl() {
  return process.env.TM_STORY_API_URL || DEFAULT_TM_STORY_API_URL;
}

/**
 * Calls TM Story's own leak-gated `GET /api/characters/:id/downtimes`, forwarding the
 * CALLER's own bearer token verbatim (the exact `Authorization` header value this repo's
 * own `requireAuth` already validated for the inbound request), the same player identity
 * resolves against both repos' `players` collection lookups (both read `tm_game.players`),
 * so no separate service credential is minted here.
 *
 * Never throws. A network error, non-2xx, or a malformed body is logged server-side and
 * reported back to the caller as `{ ok: false, downtimes: [] }`, TM Story being down must
 * degrade this repo's own Story tab to "your older games only," never blank the whole tab
 * (AC 3), and TM Story's own raw error text must never reach a player-facing string.
 */
export async function fetchStoryDowntimes({ authorization, characterId }) {
  if (!authorization || !characterId) return { ok: false, downtimes: [] };
  const url = `${storyApiBaseUrl()}/api/characters/${encodeURIComponent(characterId)}/downtimes`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: authorization } });
  } catch (err) {
    console.error(`storytab.1: TM Story downtime fetch failed for character ${characterId}: ${err.message}`);
    return { ok: false, downtimes: [] };
  }
  if (!res.ok) {
    console.error(`storytab.1: TM Story downtime fetch returned ${res.status} for character ${characterId}`);
    return { ok: false, downtimes: [] };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    console.error(`storytab.1: TM Story downtime response was not valid JSON for character ${characterId}: ${err.message}`);
    return { ok: false, downtimes: [] };
  }
  const downtimes = Array.isArray(body?.downtimes) ? body.downtimes : [];
  return { ok: true, downtimes };
}

// Declared-slot arrays (TM Story's `report.projects[]`/`.spheres[]`, each `{slot, action,
// title, description, outcome}`) map to this repo's own flat `sub.responses.project_{n}_*`
// naming. Only `projects` feeds `renderOutcomeWithCards()`'s own card-building loop
// (story-tab.js:394-397 iterates n=1..4 reading `project_{n}_title`/`project_{n}_action`
// only), `spheres`/`contacts`/`retainers` are intentionally NOT mapped here: they only
// matter to the LEGACY per-action merit-card fallback (`renderMeritActionCards`), which
// only runs when NO resolved action carries `outcome_summary`/`outcome` at all. Story
// 74.1 was built specifically so `outcome_summary` IS populated, keeping TM-Story-sourced
// subs on the newer grouped-ledger path (`renderMeritSummarySection`) that reads
// `merit_actions_resolved` directly and needs no declared-side mapping. A TM-Story-sourced
// merit resolution with a genuinely blank `outcome_summary` AND blank `outcome` would fall
// through to the legacy cards and render with an incomplete merit label, a known, flagged
// gap, not silently broken, and out of this story's own scope (AC list names only
// story_moment/home_report/cacophony_savvy/outcome_summary/pool_status).
function projectResponsesFromDeclaredSlots(projects) {
  const responses = {};
  for (const p of Array.isArray(projects) ? projects : []) {
    if (p?.slot == null) continue;
    if (p.title != null) responses[`project_${p.slot}_title`] = p.title;
    if (p.action != null) responses[`project_${p.slot}_action`] = p.action;
  }
  return responses;
}

// KNOWN GAP, found during this story's own review pass (2026-09-18), not fixed here:
// `renderMeritSummarySection()`'s newer grouped-ledger path (story-tab.js ~552-614) does
// not read `merit_actions_resolved[i]` in isolation, it zips it against
// `buildPlayerMeritActions(sub)[i]`, a DECLARED-side reconstruction built from FIVE
// separately-shaped flat-index conventions (`sphere_{n}_merit`/`status_{n}_merit`/
// `contact_{n}_merit`/retainer/resource fields, story-tab.js ~647-700+). A TM-Story-
// sourced merit resolution whose `outcome_summary` IS populated (Story 74.1's whole point)
// will NOT render via this ledger unless a matching declared entry also exists at the same
// index, and this adapter does not attempt that reconstruction: TM Story's own
// `report.contacts[]`/`.retainers[]`/`.spheres[]` use genuinely different field names
// (`{merit, supporting_info, question}`/`{merit, task_type, task_description}`) than the
// five flat conventions above expect, and reconciling all five correctly is a materially
// larger piece of work than this story's own ACs named (story_moment/home_report/
// cacophony_savvy/outcome_summary/pool_status only). Confirmed via a real render test
// (server/tests/story-tab-cross-app-render.test.js) rather than assumed. Flagged for
// Angelus rather than silently scoped in or quietly left broken; a TM-Story-sourced merit
// resolution currently falls back to rendering nothing for that entry (not a wrong value,
// an absent one) until a follow-up story maps the five declared shapes.

// AC 6's ruled provisional block rule: every TM-Story-sourced entry sorts ahead of EVERY
// `tm_game`-sourced entry (a real, checked fact today, `tm_game.downtime_submissions` has
// been frozen since Game 7, D6, and every TM Story submission is Game 8 or later, not an
// arbitrary append). Rather than teach the CLIENT's existing `cycleMap[...].game_number`-
// descending sort (story-tab.js's `renderLatestReport`/`renderChronicle`) a second, parallel
// sort rule, this feeds that SAME EXISTING sort a synthetic `chapter_id`/`game_number` pair
// per TM-Story cycle: a strictly-decreasing sequence starting comfortably above any real
// game_number, assigned in TM Story's own already-correct response order (its own
// `downtimeSortKey()` already guarantees most-recent-first), so relative TM-Story-to-
// TM-Story order survives untouched while every synthetic value still outranks every real
// one. ONE sort mechanism, fed correct data, not two.
//
// Must be revisited (a genuine per-entry timestamp on TM Story's own report, rather than a
// block rule) if `tm_game` ever takes a submission again, or if TM Story ever needs to
// share the podium with `tm_game` in a genuinely mixed order.
const SYNTHETIC_GAME_NUMBER_BASE = 1_000_000_000;

/**
 * Adapts ONE of TM Story's `buildDowntimeReport()` outputs into a `tm_game`-shaped
 * pseudo-submission, matching the field names `renderOutcomeWithCards()`,
 * `renderStoryMoment()`, `renderHomeReportSection()` and `renderRumoursSection()` already
 * read. Never a second renderer, the whole point of the (b) call above.
 *
 * `_id` is a synthetic, clearly-namespaced string (`story:<characterId>:<cycle_id>`),
 * never a real ObjectId, nothing downstream could mistake it for a `tm_game` document id
 * and attempt to PUT/DELETE against it (storytab.4 owns the structural proof; this comment
 * only records the intent). `chapter_id` is likewise synthetic (`storytab.1:<rank>`,
 * never a real ObjectId), the caller must also inject a matching pseudo-chapter object
 * (see `syntheticChapterFor`) into whatever `chapters` array feeds `cycleMap`, or the
 * existing sort/label lookups will silently treat the entry as chapter-less (game_number 0).
 *
 * `rankFromNewest` is the entry's 0-based position in TM Story's OWN already-sorted
 * response array (0 = most recent), the caller supplies it per entry.
 */
export function adaptStoryReport(report, characterId, rankFromNewest) {
  const chapterId = `storytab.1:${characterId}:${rankFromNewest}`;
  const sub = {
    _id: `story:${characterId}:${report.cycle_id ?? ''}`,
    _tm_story_sourced: true, // internal marker only; no renderer reads this key
    character_id: characterId,
    chapter_id: chapterId,
    published_outcome: report.narrative || '',
    responses: projectResponsesFromDeclaredSlots(report.projects),
    projects_resolved: Array.isArray(report.projects_resolved) ? report.projects_resolved : [],
    merit_actions_resolved: Array.isArray(report.merit_actions_resolved) ? report.merit_actions_resolved : [],
    st_narrative: {
      cacophony_savvy: Array.isArray(report.cacophony_savvy) ? report.cacophony_savvy : [],
    },
  };
  if (typeof report.story_moment === 'string' && report.story_moment.trim()) {
    sub.st_narrative.story_moment = { response: report.story_moment };
  }
  if (typeof report.home_report === 'string' && report.home_report.trim()) {
    sub.st_narrative.home_report = { response: report.home_report };
  }
  return sub;
}

/** The pseudo-chapter matching `adaptStoryReport()`'s own synthetic `chapter_id`. Found live,
 * story storytab.5, 2026-09-19: leaving `label` unset let the pre-existing
 * `cycleMap[...]?.label || \`Cycle ${id.slice(-4)}\`` fallback produce a garbled fragment of the
 * synthetic id itself (e.g. "Cycle 95:1") on a real player's own STORY tab — that fallback was
 * only ever meant for a genuinely unlabelled REAL chapter, never a synthetic one built to be
 * sliced. `publishedAt` (TM Story's own `report.published_at`, added the same day for exactly
 * this) gives a real, human month/year label instead, the same `{ month: 'short', year:
 * 'numeric' }` format `downtime-tab.js`'s own `_cycleDate()` already uses elsewhere in this repo.
 * Falls back to the old slice-based label only if `publishedAt` is missing/unparseable, never to
 * a crash. */
export function syntheticChapterFor(characterId, rankFromNewest, publishedAt) {
  const chapter = {
    _id: `storytab.1:${characterId}:${rankFromNewest}`,
    game_number: SYNTHETIC_GAME_NUMBER_BASE - rankFromNewest,
  };
  const d = publishedAt ? new Date(publishedAt) : null;
  if (d && !Number.isNaN(d.getTime())) {
    chapter.label = d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
  }
  return chapter;
}
