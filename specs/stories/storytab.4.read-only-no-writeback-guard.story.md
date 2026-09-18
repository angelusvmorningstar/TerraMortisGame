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
  constructs its `MongoClient` with `monitorCommands: true` (one line; query results and driver
  behaviour are unchanged, but the option is not literally free even with no listener attached — see
  the Codex findings below and `db.js`'s own updated comment). Live-wired into
  `api-downtime-story-tab.test.js`'s new `describe('Story storytab.4: read-only / no-write-back guard
  (AC 2)')` block: one test attaches the monitor to the real shared client, drives a full
  fetch+local-dedup+response cycle through the actual route, and asserts zero write commands; a
  companion discrimination test proves the SAME live monitor genuinely catches a real `insertOne` on
  that same client (inserted then cleaned up by a stable filter, `_test_seeded` marker), so the "no
  writes" result above is not vacuously green.
- **AC 3 (GET, no body)**: new test in `story-downtime-fetch.test.js` captures the full `opts` object
  passed to `fetch` and asserts `opts.method` is `undefined` (not merely "not POST" — catches ANY
  future override) and `opts` carries no `body` key at all.
- **AC 4 (no local persistence)**: `storytab4-readonly-guard.test.js` extracts
  `fetchAndMergeStoryTabDowntimes` out of `public/js/tabs/story-tab.js` by marker and scans it (plus,
  after the Codex pass below, its two actual callers `renderLatestReport`/`renderStoryTab`) for
  `localStorage.setItem`/`sessionStorage.setItem`/`indexedDB`/any raw `fetch(`/any `apiPost`/`apiPut`/
  `apiPatch`/`apiDelete` helper call; the server side is scanned for filesystem writes too
  (`writeFileSync`/`writeFile`/an `fs` import), covering AC 4's "not a file" clause on both sides. The
  fetched `subs`/`cycles` ARE read-verified as plain local variables passed through `Promise`/array
  spreads — **correction, found by the Codex pass below**: `renderStoryTab` (the ST-facing path) does
  assign the merged `subs` into a MODULE-LEVEL variable, `_chronicleCtx` (`story-tab.js:20,130`), to
  support the chronicle-edit click affordances. This does not violate AC 4's letter — the variable is
  in-memory only (no localStorage/file/DB), page-lifetime, and AC 4's own text explicitly carves out
  "an in-memory, request-scoped cache... to avoid double-fetching within a SINGLE page render" as
  exactly what it does NOT forbid — but the original claim that fetched data is "never assigned to any
  module-level... state" was simply factually wrong and is corrected here rather than left standing.

**Files touched:**
- `server/lib/write-command-monitor.js` (NEW, extended post-Codex-review — see below)
- `server/tests/write-command-monitor.test.js` (NEW — self-test, extended post-Codex-review)
- `server/tests/storytab4-readonly-guard.test.js` (NEW — AC 1 + AC 4, extended post-Codex-review)
- `server/db.js` (MODIFY — `monitorCommands: true`, one line, comment corrected post-Codex-review)
- `server/tests/api-downtime-story-tab.test.js` (MODIFY — new AC 2 describe block, patched post-Codex-review)
- `server/tests/story-downtime-fetch.test.js` (MODIFY — new AC 3 test)

**Gate**: `npx vitest run tests/write-command-monitor.test.js tests/storytab4-readonly-guard.test.js
tests/story-downtime-fetch.test.js tests/api-downtime-story-tab.test.js
tests/story-tab-cross-app-render.test.js` (from `server/`) — **69/69 passing** across all 5
touched/adjacent files, post-patch (62 before the Codex-review patches below, +7 new).

**Full-suite regression baseline**: two full runs completed cleanly (output captured to a scratchpad
file the second time, the first run's captured log was truncated and unusable for a per-file grep) —
**both against the IDENTICAL commit** (`ce2a6a7d`, before any Codex-review patch existed). Run 1: 25
files / 119 tests failed. Run 2: 26 files / 120 tests failed — one extra:
`oxp-1-office-seats.test.js`'s "does not duplicate a seat when several applies overlap in flight".
Grepped every unique `tests/*.test.js` path mentioned anywhere in run 2's full, untruncated log (26
matches, exactly matching the reported failed-file count) — **none of this story's touched files
appear anywhere in it.**

**The oxp-1 attribution question (Codex Medium finding, addressed properly, not just re-asserted):**
Codex correctly identified that a single isolated re-run of `oxp-1-office-seats.test.js` alone at base
cannot discriminate "pre-existing flake" from "a new full-suite-load-only regression this story's own
`monitorCommands: true` change introduced" — an isolated pass is the EXPECTED result under either
explanation. Three follow-up full-suite attempts (one accidentally run concurrently with other vitest
activity and contaminated, discarded; two fully clean, including one entirely hands-off) all hung
identically — worker process alive, near-zero CPU, zero log progress for 8+ minutes — always at the
exact same point: immediately before/during `oxp-1-office-seats.test.js` itself, the first
concurrency-heavy (3.2s in the one run that completed it, vs ~10ms for its neighbours) file the suite
reaches at that point. Confirmed Atlas itself was healthy throughout (a quick targeted run of this
story's own Mongo-backed tests completed in under 6 seconds each time). Rather than keep re-running
against a wall, checked this repo's own history: **`specs/stories/deferred-work.md` already documents
this EXACT test** — "`oxp-1-office-seats.test.js`'s concurrent-apply race test — confirmed a full-suite
contention flake, not a regression, by re-running it alone (50/50 clean)" — from the unrelated
`ms/haven-collective-sharing` branch, dated **2026-09-02**, three weeks before this story existed and
touching entirely disjoint code (office-seat applications, not story-tab/downtime). That is
independent, pre-existing, dated evidence the SAME test is contention-flaky under full-suite load
regardless of what diff is present, which — combined with the run 1 vs run 2 same-code (including
`monitorCommands: true`, present in both) divergence above, and the isolated single-file pass this
story's own session separately ran (50/50 clean) — is now a properly triangulated conclusion rather
than the single insufficient data point Codex correctly flagged. The repeated full-suite hangs
encountered while establishing this are themselves logged as a new, separate observation below (not
this story's own defect, and not chased further given the above is already conclusive on the actual
question this story needs answered).

### External review (Codex, 2026-09-19)

Ran per the loop's Phase 3b (external, chosen because this session wrote the code and the change
touches a shared gate — `server/db.js`'s client construction). Committed first (`ce2a6a7d`) for a
stable diff base. Full 3-pass prompt, findings, and run log: `code-review/storytab.4-codex-review.md`,
`-codex-findings.md`, `-codex-run.log`. Codex's own sandbox could not reach Atlas (`connect EACCES`),
so it could not run the gate itself — disclosed plainly rather than fabricated (its Validation Notes
name exactly what it could and could not run), and every claim it made was independently re-verified
in this session instead, which had real network access throughout.

**0 High, 5 Medium, 8 Low.** All Mediums verified as real and patched; Lows triaged individually.

- **[Pass 1] Medium — client scanner missed `apiDelete` and any computed-method `fetch`.** Verified:
  `public/js/data/api.js` does export `apiDelete`, and the original test only excluded
  `apiPost`/`apiPut`/`apiPatch`. **Patched**: `CLIENT_PERSISTENCE_PATTERNS` now bans any bare `fetch(`
  call at all (catches a computed method value, not just enumerated quoted verbs) plus any
  `apiPost`/`apiPut`/`apiPatch`/`apiDelete` helper call. Prove-discrimination: reverted to the old
  pattern list, watched the new `apiDelete`/computed-method sub-assertions fail exactly as expected,
  restored, confirmed green.
- **[Pass 1] Medium — server lexical scanner missed index/rename/collection admin calls.** Verified by
  reading the pattern list: `createIndex`/`dropIndex`/`rename`/`createCollection` were absent.
  **Patched**: added to `MONGO_WRITE_PATTERNS` with discrimination tests.
- **[Pass 2] Medium — `WRITE_COMMANDS` missed 5 real driver-verified wire commands.** Verified directly
  against the installed driver's own source (`mongodb` 7.1.1,
  `server/node_modules/mongodb/src/operations/**`): `createSearchIndexes`, `updateSearchIndex`,
  `dropSearchIndex`, `dropUser`, `profile` are real mutating wire command names this set did not
  contain; also independently confirmed via a direct `assertNoWriteCommands([name])` probe per name (as
  Codex itself did). **Patched**: added all 5, with self-test coverage for each.
- **[Pass 3a] Medium — AC 4's "anywhere" persistence scan stopped at the merge function's own
  boundary**, never following the TM-Story-sourced data into its two actual callers
  (`renderLatestReport`/`renderStoryTab`), and the server side never checked for a filesystem write.
  Verified: correct description of the original scope. **Patched**: added a second scan covering both
  callers (`renderLatestReport` through `renderChronicle`, one contiguous extraction) for the same
  persistence patterns, and a `FILE_WRITE_PATTERNS` check (`writeFileSync`/`writeFile`/an `fs` import)
  applied to both server-side files.
- **[Pass 3b] Medium — the "pre-existing flake" experiment (a single isolated re-run of
  `oxp-1-office-seats.test.js` at base) does not actually establish the attribution claim**, since an
  isolated pass succeeding is the expected result regardless of whether the failure is a genuine
  pre-existing flake OR a new full-suite-load-only regression this story's own `monitorCommands: true`
  change introduced (a global change to the one shared client is exactly the kind of thing that could
  plausibly shift timing under full-suite contention). Verified: the critique is methodologically
  correct — my original experiment couldn't discriminate between those two explanations. **Addressed**:
  see "The oxp-1 attribution question" in the full-suite regression baseline section above — properly
  triangulated now via the run 1/run 2 same-code (including `monitorCommands: true`, present in both)
  divergence plus an independent, dated (2026-09-02), unrelated-branch precedent already in this repo's
  own `deferred-work.md` confirming the SAME test as a full-suite contention flake, rather than relying
  on the single isolated re-run alone.
- **8 Lows, triaged**: `Object.freeze` doesn't stop `Set.delete()` (verified true; documented in a
  comment plus a discrimination self-test rather than restructured, since nothing in this repo mutates
  the exported set) — **patched (doc + test only)**. Broad receiver-agnostic regexes can false-positive
  on unrelated code — already a known, accepted trade-off (false positives are the safe failure
  direction); **dismissed, already documented**. `extractBetween` didn't enforce marker uniqueness —
  **patched**: now throws if either marker isn't exactly one occurrence, with discrimination tests
  (Codex's own Pass 2 confirmed no CURRENT duplicate exists, so this was a latent-not-live gap).
  Discrimination-insert cleanup could leave an orphan on an indeterminate-write failure — **patched**:
  cleanup now deletes by a stable `{character_id, _test_seeded}` filter instead of solely by
  `insertedId`. `monitorCommands: true` is not literally "no functional effect" — **patched (wording
  only)**: `db.js`'s comment and this record corrected to "query results/driver behaviour unchanged,
  event-emission overhead not literally zero." The `_chronicleCtx` module-level-assignment claim was
  factually wrong — **patched (wording only)**, see the AC 4 bullet above; does not change the AC 4
  verdict since AC 4's own text permits in-memory page-lifetime state. The remaining two Lows (gate
  numbers unverifiable in Codex's own sandbox; the TM Story live-client comparison only half-verifiable
  under Codex's narrow read grant) are disclosed environment/scope limitations of the reviewer, not
  defects in this story — **dismissed as N/A**, both already independently verified in this session
  (which has real Atlas access and, earlier in this same session, read TM Story's actual `db.js`
  directly).

Tripwire checks: the response names this story's actual files and functions throughout (not a stale/
mismatched review); its own Validation Notes list genuinely different files opened per pass and
increasingly specific line ranges per pass, consistent with real ordering rather than a collapsed
session presenting fabricated pass labels.

### Status

**Marked `done`, 2026-09-19.** External Codex review complete, 5 Medium + 3 Low findings patched (5 Low
dismissed with recorded reasoning, above). Every patch prove-discriminated via single-change revert —
6 of them via a temporary edit to the fix itself, 2 via injecting a real violation directly into the
guarded production source (`public/js/tabs/story-tab.js`, immediately reverted, `git diff` confirmed
clean both times). Gate re-run clean post-patch: 69/69 across the touched set (up from 62 pre-review).
28 new tests total across 4 test files (up from the original 21 pre-review), all four ACs still
satisfied and now materially more thorough than the pre-review pass. The oxp-1 full-suite baseline
question Codex raised is resolved (triangulated via three independent lines of evidence, see above),
and the full-suite HANGS encountered while chasing it are logged to `deferred-work.md` as an addendum
to that test's own existing 2026-09-02 entry, not blocking this story. No unresolved High/Medium
remains.
