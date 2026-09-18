# Story storytab.4: Read-Only / No-Write-Back Structural Guard

## Status: backlog — can be built alongside storytab.1, but is its own reviewable unit

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
