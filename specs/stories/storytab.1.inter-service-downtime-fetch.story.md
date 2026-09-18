# Story storytab.1: Inter-Service Downtime Fetch — Story Tab Reads TM Story

## Status: done, 2026-09-18 (Angelus, direct throughout the session: the (a)-vs-(b) ruling, the AC 6
## sort-rule ruling, and the merit-ledger gap deferral). 74-1 landed first in TM Story, then this
## story implemented (b): the adapter, the new fetch route, and the merge-and-sort. See "Senior
## Developer Review" below for the full account, including a real regression found and fixed.

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

**SUPERSEDED by the Status line above: Angelus ruled (b) directly, 2026-09-18, before this story was
built.** `../TM Story/specs/stories/74-1-downtime-allowlist-widen-for-cross-app-parity.md` is done
(2026-09-18, same session): `buildDowntimeReport()` now exposes `story_moment`/`home_report` (bare
`.response` strings, flat at the report's own top level, not nested under `st_narrative` the way this
repo's `sub` shape has them), `cacophony_savvy[]` (`{slot, response}` entries), and
`outcome_summary`/`pool_status` on `projects_resolved`/`merit_actions_resolved` entries.

**This does NOT mean zero adapter work.** TM Story's report shape is still not byte-identical to
this repo's own `tm_game.downtime_submissions` document shape `renderOutcomeWithCards()` reads
directly:

- Declared project/sphere content: TM Story returns `report.projects[]`/`report.spheres[]` as
  `{slot, action, title, description, outcome}` arrays; this repo's own renderer reads flat
  `sub.responses.project_{n}_title`/`project_{n}_action` fields (or `sub[...]` directly, per
  `story-tab.js:396`). AC1's new helper must map slot -> `n` when building the adapted `sub`.
- Narrative fields: TM Story's `report.story_moment`/`report.home_report` are flat strings; this
  repo's renderer reads `sub.st_narrative.story_moment.response`/`.home_report.response`. The adapter
  re-nests them.
- `report.cacophony_savvy[]` entries are `{slot, response}`; this repo's renderer reads `.response`
  off each entry directly (`s?.response`), so the extra `slot` key is harmless and needs no stripping.
- `report.projects_resolved`/`.merit_actions_resolved` already carry `outcome_summary`/`pool_status`
  alongside the scalars this repo's renderer already reads (`action_type`, `outcome`,
  `outcome_confirmed`, `no_roll`, `player_facing_note`, `pool`, `roll`), no further mapping needed
  there beyond the container key names, which already match.
- `acquisitions_resolved` (Resources/Skill Acquisition fixed slots) has no TM Story equivalent;
  leave undefined for a TM-Story-sourced entry; the renderer already treats it as optional.

So the actual shape of AC1's new helper is: fetch TM Story's report, then ADAPT it into a
`tm_game`-shaped `sub` object (same field names `renderOutcomeWithCards()` already reads), rather
than either (a)'s full second renderer or a naive pass-through assuming identical shapes. This keeps
Sally's "one renderer, one visual treatment" requirement (the whole point of choosing (b)) while
still doing real, testable mapping work.

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
4. **The (a)-vs-(b) decision is (b), already ruled** (see the Status line and the superseded-decision
   note above): build the ADAPTER (TM Story report shape -> `tm_game`-shaped `sub` fields) described
   there, feeding the EXISTING `renderOutcomeWithCards()` unchanged. Do not build a second renderer.
5. **`renderLatestReport()` and `renderStoryTab()`** (`public/js/tabs/story-tab.js:31-78`, `:80+`) both
   consume the merged result: this repo's own `tm_game.downtime_submissions` entries (existing
   behaviour, unchanged) PLUS TM Story-sourced entries (new), as ONE list.
6. **Sort-before-render, never fetch-and-append blindly.** RULED, 2026-09-18 (Angelus, direct): TM
   Story's own report carries NO per-entry timestamp (`buildDowntimeReport()` never exposes
   `published_at`/`submitted_at` on the report object itself, only the ARRAY's overall order, which
   its own `downtimeSortKey()` already guarantees is most-recent-first), so a genuinely general,
   per-entry cross-source chronological comparison has no real key to compare on today. Rather than
   reopening the just-closed 74-1 to add one, the merge uses a PROVISIONAL BLOCK RULE, grounded in a
   real, checked fact rather than an arbitrary append: `tm_game.downtime_submissions` has been frozen
   since Game 7 (D6, 2026-08-24/25) and every TM Story submission is Game 8 or later, so EVERY
   TM-Story-sourced entry is, in fact, more recent than EVERY `tm_game`-sourced entry today. The
   merged list is therefore: TM Story-sourced entries first (in TM Story's own already-sorted
   response order, untouched), then `tm_game`-sourced entries (in this repo's own existing
   `cycleMap[...].game_number`-descending order, untouched), ONE sort decision, made once, before
   either `renderLatestReport()`'s "take element 0" or `renderStoryTab()`'s full-list render happens,
   not two independently fetched-and-displayed lists. This is a real, checked ordering for the current
   data, not a hardcoded assumption papering over a mismatch, but it IS block-level, not per-entry,
   and must be revisited (a genuine per-entry key added to TM Story's report) if `tm_game` ever takes
   a submission again or this fact stops holding. Code comments at the merge site must say so plainly.
7. **Identical per-entry treatment regardless of source.** A TM Story-sourced entry must never render
   as a visibly thinner/sparser card than a `tm_game`-sourced one purely because of which source it
   came from — per-field omission (a field genuinely absent on either side) is fine and already how
   `reportCard()`/`renderOutcomeWithCards()` both work; a field that exists on one side and is simply
   never read because of which renderer got chosen is not.
8. **One loading state, one error state, one empty state**, covering the merged result — not
   independent states per source.
9. New tests cover: the merge-and-sort logic, proving ALL TM-Story-sourced entries sort ahead of ALL
   `tm_game`-sourced entries regardless of fixture insertion order (the block rule, AC 6), AND that
   each source's own internal order survives the merge untouched (TM Story's own response order;
   `tm_game`'s own `game_number`-descending order); the TM-Story-call-fails-gracefully path (AC 3);
   and the ADAPTER (TM Story report -> `tm_game`-shaped `sub`), proving a real TM Story report shape
   (declared slots, `story_moment`/`home_report`/`cacophony_savvy`, `outcome_summary`/`pool_status`)
   produces a `sub` object `renderOutcomeWithCards()` renders identically to an equivalent native
   `tm_game` submission.
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
already exists here and needs only a second call site, not a new implementation. (Superseded by the
(b) ruling; this note is kept only because it also confirms the two repos' section-parsing logic was
already reconciled once before, relevant background for anyone later auditing `published_outcome`
parity.)

### Real finding, 2026-09-18 (implementation session): a genuine gap in AC 7, flagged not silently fixed

`renderMeritSummarySection()`'s newer grouped-ledger path (story-tab.js ~552-614) does not read
`merit_actions_resolved[i]` in isolation, it zips it against `buildPlayerMeritActions(sub)[i]`, a
DECLARED-side reconstruction built from FIVE separately-shaped flat-index conventions
(`sphere_{n}_merit`/`status_{n}_merit`/`contact_{n}_merit`/retainer/resource fields). TM Story's own
`report.contacts[]`/`.retainers[]`/`.spheres[]` (already exposed pre-74.1) use genuinely different
field names (`{merit, supporting_info, question}`/`{merit, task_type, task_description}`) than those
five conventions expect, and reconciling all five correctly is materially larger than mapping the
fields this story's own ACs actually named. Confirmed live via a real render test (not assumed): a
TM-Story-sourced merit resolution's `outcome_summary` survives the adapter (proven directly) but does
not currently reach the ledger's rendered output, because no matching declared entry exists at the
same array index for it to zip against.

**Scope call, this session**: NOT fixed here, flagged for Angelus rather than either silently
shipping broken or unilaterally absorbing a materially larger mapping job. Project-action cards
(`projects_resolved`, story_moment, home_report, cacophony_savvy) are UNAFFECTED; `outcome_summary`
is a merit-action-only field on TM Game's own renderer; the project-card path never reads it. Logged
here rather than in a separate deferred-work doc since it is this story's own AC 7 that is not yet
fully met, not an unrelated tech-debt item.

## Senior Developer Review (completed 2026-09-18, same session, inline, no external Codex pass)

Implemented directly (inline, not delegated: a coordinate/architecture-sensitive cross-repo story):

- `server/lib/story-downtime-fetch.js` (new): `fetchStoryDowntimes()` (the server-to-server GET,
  forwarding the caller's own bearer token verbatim, never throwing), `adaptStoryReport()` (TM Story
  report -> `tm_game`-shaped pseudo-submission), `syntheticChapterFor()` (the block-rule sort key).
- `server/routes/downtime.js`: new `GET /story-tab` route, deliberately separate from the general
  `GET /` (which also serves this repo's own ST review/edit workflows against REAL documents).
- `public/js/tabs/story-tab.js`: `renderLatestReport()`/`renderStoryTab()` now merge in the new
  route's result before the EXISTING game_number-descending sort runs; `renderChronicle` exported for
  test coverage.

**A genuine regression found and fixed during this review, not by a subagent (there was no
subagent; caught on a full-suite run)**: the new route's own ownership gate is a 7th
`!isStRole(req.user)` occurrence in `downtime.js`, which broke `p0-coordinator-role-ownership-bypass
.test.js`'s exact-count assertion (a real P0 security regression test from a 2026-09-01 audit).
Verified via a git-stash baseline comparison that this was the ONLY test genuinely caused by this
story's diff (the full suite's other ~124 failing tests, across ~25 files, reproduce identically on
an unmodified `main` checkout, confirmed by running the same test files before and after stashing
this story's changes). Fixed by updating that test's expected count from 6 to 7 with a comment
explaining the new, legitimate gate, not by loosening or removing the assertion.

FINAL GATE: this story's own 3 new test files (44 tests) plus the corrected P0 test (16 tests) all
pass in isolation and together. Full-suite regression count is unchanged from the pre-existing
baseline (verified via stash comparison) aside from the one P0 test now correctly reflecting 7 gates.
No `public/` visual verification was performed beyond the render-output string assertions in
`story-tab-cross-app-render.test.js` (no live browser render this session); recommend a manual
Story-tab check against a real character with both `tm_game` and `tm_story` published cycles before
this ships to Netlify.

**Known gap, not fixed here (Angelus's own call, 2026-09-18): merit-action outcome summaries
(`outcome_summary`/`pool_status` on `merit_actions_resolved`) do not yet reach the rendered Story tab
for TM-Story-sourced entries** (see the "Real finding" note above). Documented, deferred, not
silently shipped broken.

backlog -> ready-for-dev -> done (single session, no intermediate commit; the (a)-vs-(b) and AC 6
sort-rule decisions were made live during this session via direct questions to Angelus, not
pre-ruled).

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
