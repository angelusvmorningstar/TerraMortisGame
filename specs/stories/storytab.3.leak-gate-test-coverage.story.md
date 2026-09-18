# Story storytab.3: Leak-Gate Test Coverage for the TM Story Merge Path

## Status: backlog — can be built alongside storytab.1, but is its own reviewable unit

## Story

**As** the Storyteller responsible for player privacy, **I want** an automated, adversarial test
proving a player can never see another player's TM Story-sourced downtime data through this repo's
Story tab, **so that** the new cross-service fetch does not quietly become a second, un-reviewed leak
surface alongside the ones this repo and TM Story already guard carefully.

## Background

TM Story's own `GET /api/characters/:id/downtimes` (the endpoint storytab.1 calls) is ALREADY leak-
gated on its own side — ownership check, publish gate, allowlist report builder, per its own header
comment. **This story is not re-proving TM Story's own gate.** It exists because storytab.1 introduces
a NEW code path IN THIS REPO that receives that already-gated data and merges it with this repo's own
— and a bug in THIS repo's own merge/render code (e.g. accidentally fetching or rendering a DIFFERENT
character's TM Story data than the one the viewer is authorised for) would be a leak this repo
introduced, regardless of how careful TM Story's own gate is.

## Acceptance Criteria

1. **A test proves the character id sent to TM Story's endpoint is always the VIEWER'S OWN character
   id** (or an id they are otherwise authorised for under this repo's existing rules — e.g. an ST
   viewing a player's chronicle, if that is a real existing case; confirm against
   `server/routes/downtime.js`'s own existing role checks) — never a client-suppliable id taken from
   request parameters without this repo's own authorisation check running first. A discrimination test:
   attempt to request another player's character's Chronicle and confirm the TM-Story-sourced portion
   is absent/blocked exactly as this repo's own existing `tm_game`-sourced portion already is (mirror
   `downtime.js`'s existing 403 pattern at its own ownership-check call sites, ~lines 347-440).
2. **A test proves the forwarded bearer token is the REQUESTING PLAYER's own token**, never a fixed
   service-level credential that would let this repo's server fetch AS a different identity than the
   one making the request — the token forwarded to TM Story must vary with, and be validated against,
   the actual inbound request's own `Authorization` header.
3. **A test proves a TM-Story-side auth failure (expired token, TM Story's own 403) degrades to "no
   TM-Story-sourced entries shown" rather than ever falling back to an un-authorised broader fetch** —
   confirm this repo's own code never retries the TM Story call with different credentials or without
   auth on a failure.
4. **A test proves the merged response sent to the BROWSER never includes any field TM Story's own
   allowlist did not already return** — i.e. this repo's own merge/render code is a pure consumer of
   TM Story's already-allowlisted shape, never reaching past it (e.g. never separately querying TM
   Story's raw collections, which storytab.4's guard also covers from a different angle).
5. Tests are automated, run in this repo's own existing test suite (not a manual/live-Mongo-dependent
   check), using a mocked/stubbed TM Story HTTP response — do not require a live TM Story deployment to
   run this repo's own test suite.

## Explicitly NOT in scope

- Re-testing TM Story's own `downtimes.js` leak-gate — that is TM Story's own test suite's job, already
  established and passing on that side.
- The read-only/no-write-back structural guard — Story storytab.4.
- The chapter-routing rule's own correctness — Story storytab.2's own tests cover that; this story
  assumes routing has already decided to fetch, and tests what happens once it does.

## Dev Notes

Model these tests on TM Story's OWN discrimination-test convention (an explicit negative-control case,
not just a positive "it works" test) — e.g. `../TM Story/server/routes/downtimes.test.js`'s own shape,
and this repo's own existing ownership-gate tests for `downtime.js` if any exist under
`server/routes/downtime.test.js` (check first, extend rather than reinventing the harness).

## References

- `../epic-storytab-cross-db-read.md`.
- `server/routes/downtime.js:347-440,609-666` (this repo's own existing ownership-gate pattern to
  mirror for the new code path).
- `../TM Story/server/routes/downtimes.js` (the endpoint being called — read its own leak-gate
  discipline to understand what this repo's own new code path must not undermine).
- `stories/storytab.1.inter-service-downtime-fetch.story.md` (the code this story tests).
