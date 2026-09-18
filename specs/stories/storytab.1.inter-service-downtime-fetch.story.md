# Story storytab.1: Inter-Service Downtime Fetch — Story Tab Reads TM Story

## Status: backlog — (a)-vs-(b) RULED, 2026-09-18 (Angelus, direct: option (b), reversing this
## story's own original recommendation below). **This story now DEPENDS ON `../TM Story/specs/
## stories/74-1-downtime-allowlist-widen-for-cross-app-parity.md` landing first** — do not start
## `storytab.1` itself until 74-1 is done, since the whole point of choosing (b) was ONE renderer
## fed by ONE consistent shape, not a temporary (a)-shaped renderer to throw away once 74-1 lands.
## The reasoning below (kept for the record) argued for (a) specifically to avoid this cross-repo
## dependency — Angelus weighed that trade-off and chose correctness/one-code-path over shipping
## storytab.1 sooner. Re-sequence: 74-1 first, then storytab.1.

## Story

**As a** player, **I want** my Story tab's Chronicle (and the game app's "Downtime" panel) to show my
real, current downtime outcomes even for cycles filed in TM Story, **so that** I am not shown stale or
missing data for every game since Game 8 just because the two apps' databases diverged.

## Background

See `../epic-storytab-cross-db-read.md` in full before starting — it documents WHY this is a live,
current bug (not a hypothetical), the architecture decision (HTTP call to TM Story's existing
leak-gated endpoint, not a second Mongo connection), and a real schema mismatch this story must
resolve directly. This story is that epic's foundation story; the summary below repeats only what is
load-bearing for THIS story's own acceptance criteria.

## The (a)-vs-(b) decision this story must make explicitly

`public/js/tabs/story-tab.js`'s existing `renderOutcomeWithCards(sub)` (line 384+) is built against
this repo's OWN `tm_game.downtime_submissions` document shape: `sub.st_narrative.story_moment.
response`, `sub.st_narrative.home_report.response`, `sub.st_narrative.cacophony_savvy[]`, and per-
action `rev.outcome_summary`/`rev.pool_status`. TM Story's `GET /api/characters/:id/downtimes`
(`../TM Story/server/routes/downtimes.js`) returns a DIFFERENT, coarser shape — a flat `narrative`
string plus `projects_resolved`/`merit_actions_resolved` arrays with no `outcome_summary`/
`pool_status` fields at all (see `buildDowntimeReport()`, lines 208-239 of that file).

Pick ONE of:

- **(a) Build a second, TM-Story-shaped renderer in this repo**, reusing TM Story's own approach —
  parse the flat `narrative` string on `## ` headings (port `parseOutcomeSections`/`reportCard()`'s
  logic from `../TM Story/public/js/downtimes/archive.js` and `archive-format.js`, or better, extract
  it as shared logic if this repo already has an equivalent `parseOutcomeSections` — check
  `public/js/data/helpers.js` first, since TM Story's own code comments claim its version is "a
  faithful port" of exactly this repo's function). TM Story-sourced entries render with a DIFFERENT
  internal renderer than `tm_game`-sourced ones, but Sally's requirement (identical card treatment
  regardless of source) is satisfied by making both renderers PRODUCE the same visual output, not by
  using the same function.
- **(b) Ask TM Story to widen its allowlist** to also expose `st_narrative.story_moment`/`home_report`/
  `cacophony_savvy` and per-action `outcome_summary`/`pool_status`, so this repo's EXISTING
  `renderOutcomeWithCards()` can render both sources through one code path unchanged. This is
  `../TM Story/specs/stories/74-1-downtime-allowlist-widen-for-cross-app-parity.md` — a security-
  reviewed change in a DIFFERENT repo, gated on Angelus choosing this path and on that review
  happening, not something this story can assume will land in time.

**This story's own recommendation: start with (a).** It has zero cross-repo dependency, ships entirely
within this repo, and does not gate this story's own delivery on a security review in a different
repo. (b) remains available as a later simplification if Angelus wants ONE renderer long-term — but
do not block this story on it. Confirm this choice explicitly in the Dev Agent Record when built; if a
different call is made, record why.

## Acceptance Criteria

1. **A new server-side helper** (e.g. `server/lib/story-downtime-fetch.js` or equivalent — name to
   match this repo's own conventions) calls TM Story's `GET /api/characters/:id/downtimes` server-to-
   server, forwarding the CALLER's own `Authorization: Bearer <token>` header verbatim (the same token
   already validated by this repo's own `requireRole`/auth middleware for the inbound request — do not
   mint or reuse a service-level credential; this must resolve to the SAME player identity on both
   sides). Base URL from an env var (e.g. `TM_STORY_API_URL`, mirroring `TM Herald`'s own
   `TM_API_URL` convention) defaulting to `https://tm-story-api.onrender.com` in production, matching
   the deploy-URL precedent already visible in both repos' own `netlify.toml` files.
2. **The call is read-only** — a plain `fetch(...)` GET, no body, no follow-up write of any kind. See
   Story storytab.4 for the structural guard that enforces this beyond a code-review read.
3. **Failure handling matches this repo's own existing precedent for a dependent-service failure**: if
   the TM Story call fails (network error, non-2xx, malformed body), this repo's OWN `tm_game`-sourced
   data still renders — a TM Story outage degrades the Chronicle to "your older games only," it does
   not blank the whole tab. Log the failure server-side (mirroring TM Story's own `console.error` +
   generic-message convention for exactly this class of failure, per `../TM Story/public/js/
   standing-prompts/archive-load.js`'s own header comment on why raw transport errors never reach a
   player-facing string) — never surface TM Story's raw error text to the player.
4. **The (a)-vs-(b) decision above is made and recorded** (default (a) unless a documented reason to
   choose (b) emerges during implementation) before any rendering code is written.
5. **`renderLatestReport()` and `renderStoryTab()`** (`public/js/tabs/story-tab.js:31-78`, `:80+`) both
   consume the merged result: this repo's own `tm_game.downtime_submissions` entries (existing
   behaviour, unchanged) PLUS TM Story-sourced entries (new), as ONE list.
6. **Sort-before-render, never fetch-and-append.** The merged list is sorted ONCE, by real chronology
   (this repo's own `cycleMap[...].game_number` for `tm_game`-sourced entries; TM Story's own already-
   sorted response order, or an equivalent real timestamp/game-number signal, for TM Story-sourced
   entries — do NOT re-derive a TM Story entry's position from anything client-side that TM Story's own
   `downtimeSortKey()` doesn't already guarantee), before either `renderLatestReport()`'s "take
   element 0" or `renderStoryTab()`'s full-list render happens. Two separately-fetched, separately-
   appended lists (`tm_game` results first, TM Story results tacked on the end regardless of actual
   date) is the specific anti-pattern this AC forbids.
7. **Identical per-entry treatment regardless of source.** A TM Story-sourced entry must never render
   as a visibly thinner/sparser card than a `tm_game`-sourced one purely because of which source it
   came from — per-field omission (a field genuinely absent on either side) is fine and already how
   `reportCard()`/`renderOutcomeWithCards()` both work; a field that exists on one side and is simply
   never read because of which renderer got chosen is not.
8. **One loading state, one error state, one empty state**, covering the merged result — not
   independent states per source.
9. New tests cover: the merge-and-sort logic with a synthetic fixture proving a TM Story-sourced entry
   dated more recently than a `tm_game`-sourced one sorts first (and vice versa); the TM-Story-call-
   fails-gracefully path (AC 3); and whichever renderer path (a) or (b) was chosen, a rendering test
   proving a TM-Story-shaped input produces the expected visual output.
10. British English, no em-dashes, in every new string.

## Explicitly NOT in scope

- Choosing WHICH chapters/cycles to fetch from TM Story at all — this story wires the CAPABILITY to
  fetch and merge; Story storytab.2 decides the real routing rule. A reasonable placeholder for THIS
  story (e.g. "always also fetch from TM Story, regardless of chapter") is acceptable to unblock
  development, but must be clearly flagged as provisional in code comments, not presented as the final
  rule.
- The leak-gate test suite beyond what AC 9 already requires for this story's own new code — Story
  storytab.3 owns the fuller discrimination-test pass.
- The structural no-write-back guard test — Story storytab.4 owns it, though this story's own
  implementation must already satisfy it in practice (AC 2).
- `archive-tab.js` — explicitly out of scope for this whole epic per its own "Explicitly not yet
  scoped" section.
- TM Story's own allowlist — untouched unless (b) is chosen, in which case that work lives entirely in
  `../TM Story/specs/stories/74-1-downtime-allowlist-widen-for-cross-app-parity.md`, a different repo.

## Dev Notes

Check `public/js/data/helpers.js` for an existing `parseOutcomeSections` before porting TM Story's
version wholesale — TM Story's own code comment on its `archive-format.js:67-72` claims to be "a
faithful port" of exactly this repo's function, which would mean the logic to reuse for option (a)
already exists here and needs only a second call site, not a new implementation.

## References

- `../epic-storytab-cross-db-read.md` (full epic context, the architecture decision, the schema
  mismatch this story resolves).
- `public/js/tabs/story-tab.js:31-78,80+,384+` (the three functions this story changes).
- `../TM Story/server/routes/downtimes.js` (the endpoint this story calls — read its own header
  comment on the ownership/publish/allowlist gates before writing the fetch).
- `../TM Story/public/js/downtimes/archive.js`, `archive-format.js` (the TM-Story-shaped rendering
  logic to port if option (a) is chosen).
- `server/middleware/auth.js` (this repo's own bearer-token handling, to confirm the forwarded header
  shape matches what TM Story's own `server/middleware/auth.js` expects).
- `../TM Herald/services/announcements.js` (the HTTP-server-to-server shape precedent, WITH the
  missing-Authorization-header caveat the epic doc documents — do not copy that mistake).
