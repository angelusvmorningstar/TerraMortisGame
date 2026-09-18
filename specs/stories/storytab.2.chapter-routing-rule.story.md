# Story storytab.2: Chapter-Routing Rule — Which Cycles Read `tm_game` vs `tm_story`

## Status: backlog — depends on storytab.1

## Story

**As** the system, **I want** a real, data-driven rule deciding whether a given chapter's downtime
data should be read from this repo's own `tm_game.downtime_submissions` or fetched from TM Story, **so
that** the Story tab does not depend on a hardcoded game-number cutoff that will silently go stale the
moment the actual cutover circumstances change.

## Background

Story storytab.1 wires the CAPABILITY to fetch from TM Story; this story decides WHEN to use it,
instead of storytab.1's own placeholder ("always also fetch from TM Story, regardless of chapter" —
see that story's own "Explicitly NOT in scope").

**Why "Game 8" must not be hardcoded.** Game 8 is true TODAY (D6's cutover, 2026-08-24/25) but it is a
fact about when a decision happened, not a stable property of the data. A hardcoded `game_number >= 8`
check breaks the moment:
- A future re-freeze/re-thaw happens for any reason (this repo's own frozen-form precedent shows
  freezes are real operational events, not permanent constants).
- Historical Games 1-7 data ever needs correction or re-publication through TM Story instead of this
  repo (not currently planned, but the routing rule should not assume it can never happen).
- A chapter genuinely has data in BOTH places (e.g. an edge-case cycle spanning the cutover) — a real
  possibility this story must define behaviour for, not silently ignore.

## The real signal to route on

Per this repo's own dual-read shim precedent (`server/helpers/chapter-fk.js`, the `chapter_id`
falling back to `cycle_id` pattern already established for exactly this kind of "which of two
generations of data does this record belong to" question) — the routing rule should be based on a
REAL, checkable fact about each chapter, not a number comparison. Candidates to evaluate during
implementation (this story's own job is to pick and justify one, not to guess here):

- Does this repo's own `chapters` collection show a `submitted`/reviewed count of zero (or a stale
  `updated_at`) for a chapter dated on/after the D6 freeze, while TM Story genuinely has data for the
  same chapter? (Requires reconciling `chapter_id` vs TM Story's `cycle_id` — see the epic doc's own
  terminology-mismatch section; the two are the same real cycle under two names, and there is no
  existing crosswalk table confirmed to exist — check for one before assuming a lookup is free.)
- A stored, explicit `frozen_for_players_at` (or equivalent) field on this repo's own `chapters`
  collection, set once at the D6 cutover and checkable per-chapter going forward — this would need to
  be ADDED if it does not already exist; confirm against the real schema before assuming it does.
- Simply: for every chapter, fetch from BOTH sources and merge whatever each one has (no routing at
  all, just always-query-both) — the simplest possible rule, and arguably the most robust against
  future surprises, at the cost of always paying storytab.1's HTTP round-trip even for chapters that
  will obviously return nothing from one side. Worth weighing against the more targeted options above,
  not dismissed by default.

## Acceptance Criteria

1. A concrete, justified routing rule is chosen and documented in this story's own Dev Notes/Dev Agent
   Record when built — not left as storytab.1's placeholder.
2. The rule is driven by real, checkable data (a field, a count, an explicit marker) — NOT a hardcoded
   game-number or chapter-id comparison baked into the routing logic itself.
3. **A chapter with data in both sources is a defined, tested case**, not an unhandled edge case — the
   AC does not mandate a specific resolution (e.g. "prefer TM Story," "merge both," "prefer whichever
   has a later `updated_at`") but does mandate that ONE resolution is chosen, documented, and covered
   by a test with a synthetic dual-source fixture.
4. The rule is re-evaluatable without a code deploy if practical (e.g. driven by a stored field rather
   than a compiled-in constant) — if not practical within this story's scope, that is an acceptable
   trade-off but must be flagged explicitly, not silently accepted.
5. No change to storytab.1's actual fetch/merge/render logic beyond replacing its placeholder
   always-fetch behaviour with this story's real rule — this story is a routing-decision layer in
   front of storytab.1's existing capability, not a rebuild of it.
6. Tests cover: a chapter routed to `tm_game`-only, a chapter routed to TM-Story-only, and the
   dual-source case from AC 3 — each with a synthetic fixture proving the correct source(s) were
   queried.

## Explicitly NOT in scope

- storytab.1's fetch/merge/render mechanics themselves — reused, not rebuilt.
- Building the `chapters` ↔ `downtime_cycles` crosswalk as a general-purpose, reusable tool beyond what
  this routing rule itself needs — if a full crosswalk turns out to already exist or be trivial to
  add, use it; if it would be a substantial separate piece of work, scope that as its own follow-up
  rather than silently absorbing it here.

## Dev Notes

Read `server/helpers/chapter-fk.js` in full before designing this rule — it is the closest real
precedent in this repo for "resolve which generation of a renamed concept a given record belongs to,"
and its own header comment explains the reasoning that led to a dual-read shim rather than a one-time
migration, which may or may not be the right model here too.

## References

- `../epic-storytab-cross-db-read.md` (the terminology-mismatch section this story must reconcile).
- `stories/storytab.1.inter-service-downtime-fetch.story.md` (the placeholder this story replaces).
- `server/helpers/chapter-fk.js` (the dual-read-shim precedent).
- `../TM Story/server/mongo-store.js` (`getDowntimeCycleById`, `getActiveDowntimeCycle`, etc. — TM
  Story's own cycle-identification accessors, relevant if the crosswalk needs to query that side).
