# Epic: Story Tab Reads TM Story's `tm_story` Database (Cross-Repo)

## Status: DONE, 2026-09-19 — 5 stories complete (storytab.1-4 PLUS storytab.5, added
## 2026-09-19, corrected here per that story's own AC 11). storytab.1 done 2026-09-18 (see that
## story's own Senior Developer Review for the full account, including a real P0 security-test
## regression found and fixed); storytab.2 also done 2026-09-18 (a dedup hotfix + external-review
## fixes; see its own Senior Developer Review — includes a real process incident where the external
## reviewer fabricated a decision attribution, caught and corrected before Angelus was actually
## asked); storytab.3 also done 2026-09-18 (test-coverage-only story — audited storytab.1/.2's
## existing tests first, found most ACs already satisfied, filled 2 real verification gaps with 5
## new tests, no production code changed; see its own Dev Agent Record); storytab.4 done 2026-09-19
## (the read-only/no-write-back structural guard — a lexical source scanner plus a live Mongo
## command-monitor wired against the real shared test client, one step further than TM Story's own
## equivalent precedent; external Codex review found 5 real Medium + 3 real Low gaps in the guard's
## own coverage, all verified and patched with prove-discrimination including 2 real-source
## injection probes; see its own Dev Agent Record).
##
## storytab.1-4 built and tested against `story-tab.js`'s own two callers
## (`renderLatestReport`/`renderStoryTab`), neither of which is the code path a real player/ST
## reaches — a named, written scope cut at this epic's own original scoping time (see "Why this is
## a real, live, current bug" below), not a blind spot. **storytab.5, done 2026-09-19, is the story
## that actually closes this epic's own stated goal** ("real downtimes are currently invisible...
## the actual 'players can't see their downtime at all' blocker"): it wires the two live surfaces a
## player/ST actually reaches (`archive-tab.js`'s "STORY" nav, `downtime-tab.js`'s Info tab "Past
## Outcomes" accordion) to the same merge, plus a real cross-source sort-bug fix (Dana's chorus-review
## finding) neither of storytab.1-4 needed, since neither of their own two callers was ever fed real
## mixed tm_game/TM-Story data through a comparator that diverged from `story-tab.js`'s own. See
## `stories/storytab.5.archive-tab-cross-app-wiring.story.md` for the full account.
##
## Was PRIORITY over `../TM Story/specs/epic-73-papers-reading-experience.md`; that re-sequencing call
## is now moot with this epic closed.

## Priority note (Angelus, direct, 2026-09-18, same night this epic was opened)

"The archive can be a little bit broken, the priority is getting the downtimes out." This is the
priority epic: real downtimes are currently invisible on TM Game's own Story tab for every game since
Game 8 (`tm_game.downtime_submissions` frozen since Game 7) — the actual "players can't see their
downtime at all" blocker, versus `../TM Story/specs/epic-73-papers-reading-experience.md`'s
readability/cosmetic polish on a page that at least technically shows the data. This is an explicit
re-sequencing call from Angelus, not this epic's own default ordering.

**RE-SEQUENCED WITHIN THIS EPIC, same night, once `storytab.1`'s own (a)-vs-(b) decision was put to
Angelus directly**: he ruled (b) — widen TM Story's own allowlist — over this story's own original
(a)-favouring recommendation. That means one single story living in `../TM Story/specs/stories/
74-1-downtime-allowlist-widen-for-cross-app-parity.md` (nominally part of the LOWER-priority
`epic-73` bucket) is now a real PREREQUISITE of this epic's own foundation story, `storytab.1`. Build
order: **74-1 first, then storytab.1, then storytab.2-4.** Don't let "epic-73 is lower priority"
be read as "74-1 can wait" — it can't, this epic depends on it directly.

## Origin

Angelus, 2026-09-18: "I also want Story on TM game to point to the tm_story database for the most
recent downtime." Investigated the same night by Winston (architecture) as part of a wider Papers/
Archive investigation Bob (Scrum Master) turned into stories. This is the one piece of that
investigation that is genuinely cross-repo — TM Game (this repo) reads data TM Story (`../TM Story`)
owns. The rest of that investigation's findings are TM Story-owned and live at
`../TM Story/specs/epic-73-papers-reading-experience.md` — unrelated to this epic except that both
were scoped the same night.

## Why this is a real, live, current bug (not a hypothetical improvement)

Confirmed directly against this repo's own code and cross-referenced with TM Admin's own recent fix
of the identical bug pattern (see "Precedent" below):

- **TM Game's own Downtime form is frozen for players.** D6 ("there is only ever one live downtime
  form and TM Story is sole owner") froze `tm_game`'s player-facing downtime submission path in
  2026-08-24/25. Since then, every real downtime — Game 8 onward — is filed natively in
  `tm_story.downtime_submissions`, never in this repo's own `tm_game.downtime_submissions`.
- **`tm_game.downtime_submissions` has been untouched since Game 7** (confirmed live, 2026-09-08: 180
  docs, no change since 2026-04-30). This repo's own Storyteller-review write path
  (`server/routes/downtime.js`'s `submissionsRouter`) has nothing new to write into, because nothing
  new is filed here to review.
- **`public/js/tabs/story-tab.js`'s `renderLatestReport()` and `renderStoryTab()` both read
  `apiGet('/api/downtime_submissions')`** — this repo's own frozen collection. For any cycle from Game
  8 onward, this call returns nothing, or stale pre-freeze data, regardless of what the Storyteller has
  actually published for that player in `tm_story`. **This means the Story tab (both the game-app
  "Downtime" panel via `renderLatestReport` and the full Story tab's Chronicle via `renderStoryTab`)
  has been silently wrong for every player, every cycle, since Game 8** — not a future risk, a current
  one.
- **`public/js/tabs/archive-tab.js`'s `renderArchiveList()` reads the identical
  `apiGet('/api/downtime_submissions')` call** and has the identical staleness — flagged here as
  sharing the same root cause, but deliberately NOT folded into this epic's stories below without a
  separate scoping pass (see "Explicitly not yet scoped" at the end of this doc); do not silently
  expand any story's diff to also touch `archive-tab.js` without saying so.

## Precedent: TM Admin already hit and fixed this exact bug pattern

TM Admin's own Downtime page had the identical defect (reading the retired `tm_game` collection for
data that had moved to `tm_story`) across several sections (City, Report/Intel/Sign-off, with
Maintenance/Court-Pulse/chapter-badges still open there as of the last record). TM Admin's fix pattern
was a SECOND, direct Mongo connection into `tm_wiki`/`tm_story` (`connectWikiDb()` +
`getWikiCollection()` + a shared `assembleWikiSubmissions()` helper), reusing the SAME Atlas
`Storyteller` credential this repo, TM Story, and TM Admin all already share.

**This precedent proves the connection pattern is operationally sound in this ecosystem — it does
NOT settle which shape THIS epic should use.** TM Admin is Storyteller-only tooling: every viewer sees
everything, so a direct second Mongo connection carries no per-viewer leak risk. TM Game's Story tab is
PLAYER-FACING: a player must only ever see their own character's downtime data, and TM Story's own
`GET /api/characters/:id/downtimes` already has a security-reviewed, tested leak-gate enforcing exactly
that (`../TM Story/server/routes/downtimes.js`'s own header: "the SOLE authorisation boundary for
downtime data... NEVER a spread of the raw submission"). Duplicating that allowlist logic a second time
in this repo, direct against Mongo, would mean maintaining two independent copies of a security-
sensitive boundary that has ALREADY been rewritten twice (per that file's own migration history) —
real, demonstrated drift risk, not a theoretical one.

## The decision: HTTP call to TM Story's existing endpoint, not a second Mongo connection

Four shapes were weighed (Winston, 2026-09-18):

1. **A second, direct read-only Mongo connection from this repo straight into `tm_story`.** Full field
   parity possible, but duplicates TM Story's own leak-gate allowlist a second time in a second repo —
   REJECTED for the reason above.
2. **RECOMMENDED. This repo's server calls TM Story's existing `GET /api/characters/:id/downtimes`
   server-to-server (HTTP), forwarding the caller's own bearer token verbatim.** Keeps the allowlist in
   exactly one place — TM Story's own, already-reviewed route. Both apps already resolve identity from
   the same `tm_game.players` collection via a Discord bearer token (confirmed: TM Game's
   `server/middleware/auth.js` and TM Story's `server/middleware/auth.js` both check `req.headers.
   authorization`'s `Bearer ` prefix) — there is no separate session model to reconcile, the same
   token that authenticates a player against THIS repo's API is valid against TM Story's.
   **Ecosystem precedent for the HTTP-server-to-server SHAPE itself**: TM Herald already calls this
   repo's own API this way (`TM Herald/services/announcements.js`, `process.env.TM_API_URL` +
   `fetch(...)`. **Caveat, load-bearing for Story storytab.1**: that existing copy of the pattern
   currently ships WITHOUT forwarding an Authorization header at all (its own code comment: "no
   Authorization header is sent... both polls are currently getting a 401 on every" — a known, live bug
   in TM Herald, not something to copy). This epic's own implementation must forward the bearer token
   correctly; do not reproduce TM Herald's mistake by citing it as if it were a clean working example.
3. **Browser-side merge** (the player's own browser fetches from both `tm-game-api.onrender.com` and
   `tm-story-api.onrender.com` directly) — REJECTED. Confirmed live: both repos' `netlify.toml` proxy
   `/api/*` ONLY to their own Render service (`TM Game/netlify.toml:17-21` → `tm-game-api.onrender.com`;
   `../TM Story/netlify.toml:46-50` → `tm-story-api.onrender.com`). A client-side merge needs a new
   CORS allowlist entry on TM Story's API and breaks the same-origin convention both apps deliberately
   rely on (`../TM Story/netlify.toml`'s own header comment: "from the browser's point of view every
   request is same-origin against the Netlify domain — which is also why CORS barely matters in
   production").
4. **A new API gateway** — REJECTED, no such component exists anywhere in this ecosystem; standing one
   up for one feature is disproportionate new infrastructure.

## HARD RULE, applies to every story in this epic

**Read-only, stateless read-time merge. NO write-back into `tm_game.downtime_submissions`.**
Persisting a local copy of TM Story's data would create a THIRD "owns downtime data" system, on top of
the two-tracker disagreement already logged in `../TM Admin/specs/deferred-work.md` ("The Submission
Checklist Tracker has two parallel, disagreeing 'is this resolved' trackers", 2026-09-18). Every story
below must be checkable against this rule directly — see Story storytab.4.

## A real, confirmed terminology/schema mismatch this epic must reconcile

This repo renamed `downtime_cycles` → `chapters` (cm-2b; `server/helpers/chapter-fk.js`'s dual-read
shim, `chapter_id` falling back to `cycle_id`). **TM Story has NOT made the same rename** — its own
`server/mongo-store.js` and `server/routes/downtimes.js` still use `cycle_id`/`downtime_cycles`
throughout (confirmed by direct read, 2026-09-18: `getDowntimeCycleById`, `getActiveDowntimeCycle`,
`downtimeSortKey`'s own `merged?.cycle_id` fallback). Any code in this epic that needs to relate "a
TM Story cycle" to "a TM Game chapter" (Story storytab.2, chapter-routing) must reconcile these two
names directly — they are the same underlying real-world concept (one game's downtime window) under
two different field/collection names in the two repos, not two different concepts.

**A second, deeper mismatch, relevant to Story storytab.1 specifically:** this repo's own
`renderOutcomeWithCards(sub)` (`public/js/tabs/story-tab.js:384+`) expects a TM Game-shaped submission
document — `sub.st_narrative.story_moment.response`, `sub.st_narrative.home_report.response`,
`sub.st_narrative.cacophony_savvy[]`, and per-action `rev.outcome_summary`/`rev.pool_status` on
resolved merit actions. **TM Story's `buildDowntimeReport()` (`../TM Story/server/routes/
downtimes.js:208-239`) does not produce this shape at all** — it returns a flatter, differently-
allowlisted report: a single `narrative` string (parsed client-side into `## `-delimited sections by
TM Story's own `parseOutcomeSections`/`reportCard()` in `../TM Story/public/js/downtimes/archive.js`
and `archive-format.js`), plus `projects_resolved`/`merit_actions_resolved` arrays that do NOT carry
`outcome_summary`/`pool_status` fields. **This repo's existing `renderOutcomeWithCards()` cannot render
a TM Story-sourced report directly without either (a) this repo building a second, TM-Story-shaped
renderer, or (b) TM Story's allowlist being widened to also expose the split `story_moment`/
`home_report`/`cacophony_savvy`/`outcome_summary`/`pool_status` fields.** This is the concrete form of
the "allowlist decision/widening" trade-off Winston flagged, not an abstract risk — Story storytab.1
must make an explicit call between (a) and (b) rather than discovering this mid-implementation.

## Stories

1. **`stories/storytab.1.inter-service-downtime-fetch.story.md`** — the actual HTTP wiring: this
   repo's server calls TM Story's `GET /api/characters/:id/downtimes`, forwarding the bearer token;
   `story-tab.js` merges the result with this repo's own (frozen, but not necessarily empty for
   historical Games 1-7) `tm_game.downtime_submissions` data into ONE reverse-chronological list, sort-
   before-render, identical per-entry treatment regardless of source (Sally's UX requirement — see the
   Papers investigation's UX findings, ported here since the same "never a visibly thinner card for a
   newer entry" principle applies). Makes the explicit (a)-vs-(b) rendering call named above.
2. **`stories/storytab.2.chapter-routing-rule.story.md`** — which chapters/cycles this repo's Story tab
   reads from `tm_game` vs from `tm_story` (via storytab.1's new fetch), driven by real chapter/cycle
   data (e.g. "does this repo's own `chapters` collection have review data for this chapter" or an
   equivalent real signal), NOT a hardcoded game-number cutoff (Game 8 is true today but is a moving
   target, not a constant to bake in).
3. **`stories/storytab.3.leak-gate-test-coverage.story.md`** — proves the new merge path cannot leak
   another player's TM Story-sourced downtime data through this repo's own Story tab, matching the
   discrimination-test discipline TM Story's own `downtimes.js` already establishes on its own side,
   and this repo's own `server/routes/downtime.js` establishes for its existing `tm_game` data (real
   ownership-gate checks + `stripStReview()` redaction, confirmed live at lines ~347-440 and ~609-666
   of that file) — an automated test that a non-owner's request never receives owner-only content, not
   just a code-review assertion that it shouldn't.
4. **`stories/storytab.4.read-only-no-writeback-guard.story.md`** — a structural, testable guarantee
   that nothing in this new code path ever writes to `tm_game.downtime_submissions` (or any other
   `tm_game` collection) based on TM Story-sourced data, mirroring TM Story's own precedent for this
   exact kind of guarantee (`../TM Story/specs/stories/4-1-tm-wiki-store-and-canon-readonly.md`'s
   `[STRUCTURAL-GUARANTEE]` test: the credential itself, or a command-monitoring listener, catches a
   write attempt — not just a code-review read).
5. **`../TM Story/specs/stories/74-1-downtime-allowlist-widen-for-cross-app-parity.md`** (lives in TM
   Story's own repo, since it changes TM Story's own allowlist — see that file) — the "allowlist
   decision/widening" piece, gated on Story storytab.1's own (a)-vs-(b) call landing on (b), and on a
   security review Winston explicitly flagged as deserving its own separate pass, not bundled into the
   plumbing.
6. **`stories/storytab.5.archive-tab-cross-app-wiring.story.md`** — added 2026-09-19, after storytab.1-4
   closed. Wires the TWO live surfaces a real player/ST actually reaches — `archive-tab.js`'s "STORY"
   nav and `downtime-tab.js`'s Info tab "Past Outcomes" accordion — to the same cross-app merge
   storytab.1 built, neither of which storytab.1-4 touched (both call `story-tab.js`'s own two
   callers, not either of these). Also fixes a real cross-source sort bug found during that story's
   own chorus review (Dana): a string comparator that put a TM-Story-sourced entry's synthetic
   `game_number` behind a real one, via one shared sort helper replacing three independently-coded
   comparators. This is the story that actually closes this epic's own stated goal.

## Sequencing

storytab.1 first (it makes the rendering-shape call every other story depends on). storytab.2 depends
on storytab.1 existing (routing needs something to route to). storytab.3 and storytab.4 can be built
alongside storytab.1 as the SAME change lands (a leak-gate and a no-write-back guard are naturally part
of the first story's own test suite) but are named separately here because Winston's own scope check
sized this as 3-5 independently reviewable stories, and a leak-gate test suite deserves its own
acceptance criteria and its own review attention, not a footnote inside a wiring story. TM Story's
74-1 is gated on storytab.1's (a)-vs-(b) decision AND on Angelus naming it a priority — do not start it
speculatively.

## Explicitly not yet scoped

- **TECH DEBT (Angelus's ruling, 2026-09-18, storytab.2):** TM Story's `GET /characters/:id/downtimes`
  has no chapter/cycle-scoped filter, so storytab.2's dedup route always fetches a character's ENTIRE
  TM Story history before locally filtering out chapters `tm_game` already covers — it cannot skip
  the TM Story call even for a tm_game-only character. Fixing this for real needs a cross-repo change
  to TM Story's own API (a filter parameter), out of storytab.2's own scope. Accepted as-is for now
  (correct output, just an occasionally-unneeded network call); pick up as its own story if TM Story's
  per-character history ever grows large enough for the always-fetch cost to matter in practice.
- `archive-tab.js`'s identical staleness (see "Why this is a real, live, current bug" above) — flagged,
  not folded into any story here. A future story should scope it explicitly once this epic's pattern is
  proven.
- Any change to TM Story's `downtimes.js` beyond the allowlist widening that
  `../TM Story/specs/stories/74-1-downtime-allowlist-widen-for-cross-app-parity.md` covers (if
  chosen) — do not touch its publish gate, ownership gate, or sort logic from this repo.
- TM Story's own Papers/Archive investigation and its five stories (`../TM Story/specs/
  epic-73-papers-reading-experience.md`) — a parallel, unrelated piece of the same night's investigation.

## References

- `public/js/tabs/story-tab.js:31-78` (`renderLatestReport`), `:80+` (`renderStoryTab`,
  `renderOutcomeWithCards` at `:384+`).
- `public/js/tabs/archive-tab.js:44-100` (`renderArchiveList`, the twin staleness, out of scope).
- `server/routes/downtime.js` (this repo's own frozen-for-players submission router).
- `server/helpers/chapter-fk.js` (the `chapter_id`/`cycle_id` dual-read shim, relevant to storytab.2).
- `server/middleware/auth.js` (bearer-token auth, the shared identity mechanism).
- `netlify.toml:17-21` (this repo's own `/api/*` proxy, confirming the browser-merge rejection).
- `../TM Story/server/routes/downtimes.js` (the endpoint this epic calls; read its own header comment
  before touching anything near it).
- `../TM Story/netlify.toml:46-50` (TM Story's own `/api/*` proxy, same rejection evidence).
- `../TM Herald/services/announcements.js` (the cited HTTP-server-to-server precedent, WITH its own
  missing-Authorization-header caveat).
- `../TM Admin/specs/deferred-work.md` ("two parallel, disagreeing trackers" — the reason for the
  read-only hard rule).
