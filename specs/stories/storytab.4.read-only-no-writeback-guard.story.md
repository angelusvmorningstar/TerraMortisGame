# Story storytab.4: Read-Only / No-Write-Back Structural Guard

## Status: review — 2026-09-19

## Story

**As** the system, **I want** a structural, testable guarantee that fetching TM Story's downtime data
into this repo's Story tab never writes anything to `tm_game` based on that data, **so that** this
epic does not create a third "owns downtime data" system on top of the two-tracker disagreement
already logged against this ecosystem.

## Background

Per the epic's own HARD RULE: this integration is a **read-only, stateless read-time merge.** No
caching a TM-Story-sourced report into `tm_game.downtime_submissions` (even as an "optimisation" or a
"just in case TM Story is down" fallback) is permitted — that would be a real, if well-intentioned,
regression into exactly the class of problem `../TM Admin/specs/deferred-work.md`'s "Submission
Checklist Tracker has two parallel, disagreeing trackers" item already documents as a live, painful
bug in this ecosystem. TM Story's own precedent for exactly this class of guarantee is
`../TM Story/specs/stories/4-1-tm-wiki-store-and-canon-readonly.md`'s `[STRUCTURAL-GUARANTEE]` test:
the credential's OWN permissions reject a write attempt (not just "the code doesn't call a write
method today, trust us"), PLUS a command-monitoring listener asserting zero write commands are ever
issued during the relevant test suite.

## Acceptance Criteria

1. **A lexical guard**: a test scans the new module(s) storytab.1 introduces (the TM Story fetch
   helper, any merge/render code touching TM-Story-sourced data) for any Mongo write-shaped call —
   `insertOne`/`updateOne`/`updateMany`/`replaceOne`/`$out`/`$merge`/`db.command`/etc. — against ANY
   collection, and fails if one is found. Mirrors this repo's own or TM Story's own existing lexical
   write-scan precedent (check `server/db.js` or an equivalent guard test in this repo first — if one
   already exists for a different module, extend its coverage rather than writing a second, divergent
   scanner).
2. **A runtime guard, if this repo's own Mongo driver setup supports command monitoring** (check
   `server/db.js` for whether a command-monitoring listener is already wired anywhere in this repo,
   following TM Story's own precedent if not): a test exercising the full storytab.1 fetch-and-render
   path asserts zero write commands were issued to `tm_game` during that exercise.
3. **The TM Story HTTP call itself is asserted to be a GET with no body** — the simplest, cheapest
   guard, and one that should exist regardless of whether AC 2's fuller Mongo-level guard is feasible
   in this repo's current test infrastructure.
4. **No local persistence of a TM-Story-sourced report anywhere** — not `localStorage`, not a server-
   side cache collection, not a file. A fetch-and-discard-after-render model only: if TM Story is
   unreachable on the next page load, the data is fetched again, not served from a stale local copy.
   (An in-memory, request-scoped cache to avoid double-fetching within a SINGLE page render is fine and
   not what this AC forbids — the guard is against anything surviving PAST that one render.)
5. If AC 2's Mongo-level guard is judged infeasible given this repo's current test infrastructure (as
   opposed to TM Story's, which was purpose-built with this guarantee in mind from Story 4-1 onward),
   that must be disclosed explicitly in the Dev Agent Record, not silently skipped — AC 1, 3 and 4
   remain mandatory regardless.

## Explicitly NOT in scope

- Any change to how this repo already writes to its OWN `tm_game.downtime_submissions` via its
  existing, pre-existing player-facing form (frozen, per D6, but the write CODE still exists on disk) —
  this story is only about the NEW TM-Story-reading code path introduced by storytab.1.
- TM Story's own write-side guarantees — already covered on that side by its own Story 4-1.

## Dev Notes

If this repo has no existing command-monitoring-listener precedent, do not treat building one from
scratch as a blocker for this whole epic — AC 5's disclosure path exists for exactly this situation.
The lexical scan (AC 1) and the GET-with-no-body assertion (AC 3) already catch the overwhelming
majority of realistic mistakes a future edit to this code path could introduce.

## References

- `../epic-storytab-cross-db-read.md` (the HARD RULE this story enforces).
- `../TM Admin/specs/deferred-work.md` ("two parallel, disagreeing trackers" — the concrete harm this
  guard prevents from recurring a third time).
- `../TM Story/specs/stories/4-1-tm-wiki-store-and-canon-readonly.md` (the `[STRUCTURAL-GUARANTEE]`
  test pattern to mirror).
- `stories/storytab.1.inter-service-downtime-fetch.story.md` (the code this story guards).

## Dev Agent Record

**Checked for existing precedent first** (Dev Notes' own instruction): no lexical write-scan test and
no command-monitoring-listener precedent exist anywhere in this repo (`server/db.js`, `server/tests/`
both checked — no matches beyond `node_modules`). TM Story's own `server/canon-write-monitor.js` +
`mongo-store.test.js` (Story 4-1) is the real precedent, and — checked directly rather than assumed —
TM Story's own AC #7 ships the monitor helper plus a self-test using an `EventEmitter` stand-in, but
does **not** itself wire `monitorCommands: true` into its live production client; that live wiring is
deferred to TM Story's own later write-API stories (4.3+). This story goes one step further than that
precedent, live-wiring the guard against this repo's real shared test client, made safe specifically by
this repo's own `vitest.config.js` (`fileParallelism: false`, `maxWorkers: 1` — the whole suite already
runs serially against ONE real Mongo connection, so no other test file's commands can interleave with
the monitor while it is attached).

**All 4 ACs satisfied, none disclosed as infeasible (AC 5's escape hatch was not needed):**

- **AC 1 (lexical guard)**: new `server/tests/storytab4-readonly-guard.test.js` scans
  `server/lib/story-downtime-fetch.js` (whole file — it is entirely storytab.1's own new module) and
  the `GET /story-tab` handler specifically (extracted out of `server/routes/downtime.js` by marker,
  not the whole file — that file also carries this repo's own EXISTING, legitimate write routes for
  its own player-facing form, explicitly out of this story's scope) for any Mongo write-shaped driver
  call (`insertOne`/`updateOne`/`$merge`/`$out`/etc.). Self-tested for discrimination first (a
  deliberately dirty fixture must trip the scanner, a clean one must not) before trusting it against
  real source.
- **AC 2 (runtime/Mongo-level guard)**: new `server/lib/write-command-monitor.js` (`attachCommandMonitor`
  + `assertNoWriteCommands` + `WRITE_COMMANDS`, a direct port of TM Story's own shape, generalised off
  the "canon" naming since this isn't a second connection) plus its own self-test
  (`write-command-monitor.test.js`, EventEmitter stand-in, mirrors TM Story's). `server/db.js` now
  constructs its `MongoClient` with `monitorCommands: true` (one line; no functional effect with no
  listener attached). Live-wired into `api-downtime-story-tab.test.js`'s new
  `describe('Story storytab.4: read-only / no-write-back guard (AC 2)')` block: one test attaches the
  monitor to the real shared client, drives a full fetch+local-dedup+response cycle through the actual
  route, and asserts zero write commands; a companion discrimination test proves the SAME live monitor
  genuinely catches a real `insertOne` on that same client (inserted then immediately deleted,
  `_test_seeded` marker), so the "no writes" result above is not vacuously green.
- **AC 3 (GET, no body)**: new test in `story-downtime-fetch.test.js` captures the full `opts` object
  passed to `fetch` and asserts `opts.method` is `undefined` (not merely "not POST" — catches ANY
  future override) and `opts` carries no `body` key at all.
- **AC 4 (no local persistence)**: `storytab4-readonly-guard.test.js` extracts
  `fetchAndMergeStoryTabDowntimes` out of `public/js/tabs/story-tab.js` by marker and scans it for
  `localStorage.setItem`/`sessionStorage.setItem`/`indexedDB`/a non-GET `fetch`; also asserts the
  function's own body contains an `apiGet(` call and no `apiPost(`/`apiPut(`/`apiPatch(`. Read-verified
  directly (not just scanned) that the fetched `subs`/`cycles` are plain local variables passed through
  `Promise`/array spreads in `renderLatestReport`/`renderStoryTab`, never assigned to any module-level,
  exported, or storage-backed state — an in-memory, request-scoped read exactly as AC 4 requires.

**Files touched:**
- `server/lib/write-command-monitor.js` (NEW)
- `server/tests/write-command-monitor.test.js` (NEW — self-test)
- `server/tests/storytab4-readonly-guard.test.js` (NEW — AC 1 + AC 4)
- `server/db.js` (MODIFY — `monitorCommands: true`, one line)
- `server/tests/api-downtime-story-tab.test.js` (MODIFY — new AC 2 describe block, 2 tests)
- `server/tests/story-downtime-fetch.test.js` (MODIFY — new AC 3 test)

**Gate**: `npx vitest run tests/write-command-monitor.test.js tests/storytab4-readonly-guard.test.js
tests/story-downtime-fetch.test.js tests/api-downtime-story-tab.test.js
tests/story-tab-cross-app-render.test.js` (from `server/`) — 62/62 passing across all 5 touched/adjacent
files.

**Full-suite regression baseline**: two full runs taken (output captured to a scratchpad file the
second time, the first run's captured log was truncated and unusable for a per-file grep). Run 1: 25
files / 119 tests failed — an exact match to storytab.3's own confirmed baseline. Run 2: 26 files / 120
tests failed — one extra: `oxp-1-office-seats.test.js`'s "does not duplicate a seat when several applies
overlap in flight". Grepped every unique `tests/*.test.js` path mentioned anywhere in run 2's full,
untruncated log (26 matches, exactly matching the reported failed-file count) — **none of this story's
touched files (`write-command-monitor.test.js`, `storytab4-readonly-guard.test.js`,
`story-downtime-fetch.test.js`, `api-downtime-story-tab.test.js`) appear anywhere in it.** The oxp-1
delta was verified, not assumed: `git stash` (this story's changes only) + `npx vitest run
tests/oxp-1-office-seats.test.js` in isolation at base passed clean (50/50) — office-seats code is
unrelated to this story's own touched files by any plausible mechanism, and the test's own name
("overlap in flight") matches this repo's own documented Atlas-contention flake class
(`CLAUDE.md`'s "Known pre-existing failures" section already names several other tests in this same
shape). Stash restored immediately after (`git stash pop`), confirmed clean.

### Status

**Marked `review`, 2026-09-19.** No open findings yet — awaiting code-review phase (internal or
external, per the loop). 0 production behaviour changes beyond the one-line `monitorCommands: true`
addition (itself inert without a listener attached). 21 new tests across 4 test files (2 new:
`write-command-monitor.test.js` 9, `storytab4-readonly-guard.test.js` 9; 2 extended:
`api-downtime-story-tab.test.js` +2, `story-downtime-fetch.test.js` +1) — exact counts confirmed via
`--reporter=verbose`, not estimated.
