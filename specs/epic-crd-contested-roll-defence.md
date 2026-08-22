# Epic: CRD — Contested Roll Defence

**Goal:** Give the defending player in a contested roll their own interactive dice-pool builder
(Willpower spend, applicable merits like Indomitable and Closed Book, Mental/Social/Physical choice
where the triggering rule doesn't already fix the pool) instead of having their pool computed and
handed to them for a single accept/decline — covering BOTH a contest that matches a named roll on
their own sheet and one that doesn't, as one complete resolution capability, not two. Surface this
through a new, standalone player-facing pending-items queue.

**Why:** The existing `contested_roll_requests` accept-flow
(`server/routes/contested-rolls.js`, `public/js/game/challenge-notification.js`) computes the
defender's dice pool for them and hands it over for a single accept/decline action, via a blocking
modal — it never lets the defender apply legitimate reactive choices before rolling. Confirmed by
Angelus across two scoping sessions (2026-08-22): this is the actual defect the epic exists to fix,
not a speculative convenience feature.

**Source:** two 2026-08-22 party-mode sessions.
- Initial scoping (Winston/Sally/John/Mary/Dana): established the injury, the real WP rule (+2 on a
  Resistance trait, not +3), the attendance-gating fix (`chapters.phase`), and parked crd.4.
- Hardening pass (Winston/Dana/Sally/John), run against a working two-device disposable mockup
  (Angelus confirmed it's good) that proved the resolution mechanics live: real field/route/index
  detail below is drawn from this pass, including a genuine Winston/John disagreement that Angelus
  resolved directly — see Decisions below.

Grounded against real code: `server/schemas/contested_roll_request.schema.js`,
`server/routes/contested-rolls.js`, `server/routes/office-actions.js`, `server/index.js` (lines
245-264), `server/schemas/character.schema.js`, `schemas/schema_v2_proposal.md`,
`public/js/game/challenge-notification.js`, `public/js/suite/office-approvals.js`,
`public/js/app.js` (~1088/1634, `character_ids`), `server/schemas/game_session.schema.js`,
`server/routes/chapters.js`, `specs/stories/nav.6.contested-roll-design.story.md`.

---

## Decisions made this session (do not relitigate)

Angelus's explicit call, 2026-08-22: **optimise for correctness and thoroughness over speed** —
"I want to do this correct not fast." Every decision below was made against that standard, not
against "what ships soonest."

1. **Ship the complete resolution capability — matched roll AND no-match fallback — as ONE epic,
   not split across two.** The server-side pool recompute/validate step (crd.3a below) is the real
   trust boundary in this feature; splitting matched-vs-fallback into separate epics means building
   and reviewing that trust boundary twice, in two review cycles, with two chances for the
   implementations to drift. Doing it once, completely, is the more careful choice.
2. **Build the player-facing queue (crd.2) as part of this epic, not deferred to a later one.**
   crd.3's resolution screen is designed against its permanent entry point from day one. The
   alternative (wire crd.3 onto the existing blocking modal now, rewire onto a queue later) touches
   the trust-boundary code twice for no correctness gain — rejected on the same grounds as (1).
3. **REVERSED from the initial scoping session: do NOT refactor `office-approvals.js` into a
   shared, role-parameterised component as part of this epic.** The initial session's Goal line
   called for "one genuinely shared component parameterised by viewer role" (Winston's
   recommendation, confirmed by Angelus at the time). The hardening pass revisited this: refactoring
   a live, working ST-facing file as a side effect of shipping a new player-facing feature is itself
   a downstream-impact risk — a regression there breaks something STs already depend on during a
   live game, for a generalisation benefit that's currently theoretical (one real consumer, not
   two). Angelus's correctness-over-speed call reverses course here specifically: crd.2 builds a
   new, standalone player-facing module. Unifying it with `office-approvals.js` becomes its own
   deliberate future refactor story, decided once both implementations are live and there's real
   evidence of drift worth paying down — not bundled into this epic.
4. **The mockup is a validated SPEC for the rules logic, not code to port.** The aspect→Resistance-
   Attribute mapping, the real WP+2 rule, and merit-gating off real sheet data are proven correct
   (including two real bugs already found and fixed there — a `findItem()` lookup gap that broke
   the whole controls panel, and a hardcoded `+3` in the pool-breakdown row that didn't respect the
   WP+2 rule). None of the mockup's actual code (global mutable state, inline string-built HTML, no
   auth, no schema validation) should be carried over — server and client are built fresh to this
   project's real conventions (design tokens, `validate()` middleware, real auth).
5. **`specs/stories/nav.6.contested-roll-design.story.md` is SUPERSEDED by this epic.** It describes
   an ST-only inline defender-picker popup, `needs-design`/`deferred` status, and predates the
   player-driven direction entirely. Formally mark it superseded as part of crd.2 — do not leave it
   inconsistent for a future dev to trip over.
6. **The WP +2-vs-+3 general rule needs a verification spike before crd.3a is built in detail** —
   confirm whether the real app already hard-codes +3 anywhere in a shared Willpower-spend helper
   other pools depend on. If it does, changing the bonus for contested rolls only is a shared-helper
   change with its own blast radius, not a footnote inside crd.3a. Scheduled as the first task of
   crd.1.

---

## Stories

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| crd.1 | Data-lock, schema hardening, WP-rule spike | backlog | See Data-lock detail below. |
| crd.2 | Player-facing pending queue (standalone) | backlog | See Queue detail below. |
| crd.3a | Server-side resolve endpoint (trust boundary) | backlog | See Resolution detail below. |
| crd.3b | Client resolution screen | backlog | Depends on crd.3a existing; see Resolution detail below. |
| crd.4 | City Status/BP contest-pool house rule | **blocked** | Unchanged from the initial scoping session — still blocked on an Errata citation and Mary's four open edge-case questions (attacker-higher-status case, City-Status ties, BP=0/gap=0 floor, capped-vs-uncapped scaling). Does not block crd.1–3b: rules-fixed contests never touch this formula, and neither does the generic Defensive Reaction pool as scoped here — it uses Resistance Attribute + Willpower + merits only, no Blood Potency/City Status term. |

### crd.1 — Data-lock, schema hardening, WP-rule spike

Real findings this needs to act on, not just record:

- **`contested_roll_request.schema.js:9-33` has no `request_type` property and
  `additionalProperties: false`** — it will reject a `'contested_roll'` document as written today.
  Follow the oaq.1 precedent exactly: `status_action` docs bypass this schema entirely via a direct
  `insertOne` (`office-actions.js:218-234`). Each request_type gets its own insert path/field set,
  not one schema stretched with optional fields.
- New fields needed on creation (attacker side), reusing existing naming
  (`challenger_character_id/name`, `target_character_id/name` already present, lines 24-27):
  `request_type: 'contested_roll'`, `game_session_id` (server-derived via `findLatestSession()`,
  same pattern as `office-actions.js:159` — never client-supplied).
- New fields needed for the defender's SUBMITTED resolution (this is the real new surface):
  `defender_aspect` ('mental'|'social'|'physical', only when the roll type doesn't already fix the
  pool), `defender_wp_spent` (boolean/integer, capped against the character's real current
  Willpower — never client-asserted), `defender_merit_ids` (array). `defender_pool` stops being a
  plain client-writable field (it's `integer, minimum 0, maximum 30` today with no
  server/client provenance distinction) and becomes server-computed at accept time from these
  submitted choices — this is crd.3a's job, but the field needs to exist first.
- **No index supports the defender's own queue query today.** The only index on this collection is
  oaq.2's partial unique index scoped to `status_action`. Add a compound index
  `{ target_character_id: 1, status: 1, created_at: -1 }` — without it, `GET /mine` becomes an
  unindexed scan across every historical challenge at real table scale (30+ players polling every
  10s).
- **No TTL index exists anywhere on this collection** — resolved/declined/voided docs accumulate
  forever. Add a TTL index on `updated_at` for terminal statuses (partial-filter TTL). `session_logs`
  already carries the durable audit record, so nothing here needs indefinite retention.
- **Route audit requirement**: adding a third `request_type` to a collection that already needed a
  `request_type: { $ne: 'status_action' }` guard bolted onto `_findChallenge` and the `/void` route
  (to fix a real orphaning bug oaq.3's review found) means every existing query against this
  collection needs re-checking for whether it's actually scoped to the type it means to touch. Write
  this as an explicit AC, not an assumption.
- **Merit/attribute field paths, confirmed against the live schema** (not the mockup's fixture
  shape): `character.attributes.Resolve/Stamina/Composure.dots` (required, confirmed present).
  `character.merits[]` entries are `{ category, name, rating, qualifier? }` — **`rating`, not
  `dots`**. A resolver checks `merits.filter(m => m.name === 'Indomitable')`, not a flat boolean or
  a `dots` key. One live spot-check against a real `tm_game.characters` document before crd.3a build
  starts — schema-enforced-on-write and every-existing-document-conforms aren't the same guarantee
  (CLAUDE.md's own "Known data issues" section lists real quirks on old migrated characters).
- **The WP-rule spike** (Decision 6 above): confirm whether the real app's existing Willpower-spend
  UI/logic hard-codes +3 anywhere shared across multiple roll types, before crd.3a assumes it can
  branch a +2/+3 value in isolation.
- **Formally mark `nav.6.contested-roll-design.story.md` superseded** by this epic (Decision 5).

### crd.2 — Player-facing pending queue (standalone)

- **This is not a greenfield surface** — `public/js/game/challenge-notification.js` already polls
  `/api/contested_roll_requests/mine` every 10s and pops ONE BLOCKING MODAL at a time, with a badge
  on `#more-badge`. crd.2's job is to soften that interrupt into something the player checks on
  their own terms (a calm, always-present queue list — established pattern in this app's OTHER
  accordion sections), not to invent a notification surface from nothing. Keep `#more-badge` or its
  equivalent as the entry point if players already have muscle memory for it elsewhere in the app —
  confirm with whoever owns that element before reusing it.
- **Per Decision 3: standalone new module** (`public/js/player/my-queue.js` or similar), not a
  refactor of `office-approvals.js`. It may borrow row-grammar conventions (icon/type tag,
  compressed who-what, resolved-but-recent state rather than vanishing instantly) by inspection, but
  shares no code with the ST-facing file in this story.
- **The context/source-id mechanism is genuinely new** — `office-approvals.js` has no equivalent,
  because ST approvals never need "resume to the same place." Design it deliberately in this story,
  not as a wave-through from OAQ.
- **Multi-character defenders are a real, already-supported case, not a hypothetical edge case** —
  `character_ids` is a real array on player accounts (`app.js` ~1088/1634). The queue needs to
  either show pending items across all of a player's characters with a clear per-item "which
  character" label, or require a character selected first — design this explicitly rather than
  assuming one character per player.
- Server-side filter on `target_character_id` for the `GET /mine`-equivalent query — enforce
  "a player only ever sees requests where they're the target" at the query level, not just in the
  client's rendering.

### crd.3a — Server-side resolve endpoint (trust boundary)

- New route (e.g. `POST /api/contested_roll_requests/:id/resolve`): re-reads the defender's LIVE
  character document, recomputes the Resistance Attribute from `defender_aspect`, validates each
  submitted merit ID against the character's real `merits[]` (never trusts a client-sent merit
  list), re-checks current Willpower live at accept time — not the value that was true at
  submission, mirroring `computeNewStatus`'s own "check at approval, not submission" precedent
  (`office-actions.js:47-51`) — and only then writes `final_pool`/`resolution`.
- Guard against double-submission with the SAME `status !== 'pending'` re-check pattern already
  proven in `_findChallenge`/`_findPending` — reuse those helpers, don't reimplement the guard.
- Unit-testable in isolation, no UI dependency — this is where adversarial test coverage belongs
  (claimed merits the character doesn't have, wrong aspect for the contest type, WP double-spend,
  a request already resolved by a race).
- No merit-specific conditional logic (`if (meritName === 'Indomitable')`) — gating reads generic
  merit category/effect fields already on the character document, proven across two different
  merits (Indomitable, Closed Book) in the mockup using the same mechanism. If a third merit needs a
  code change to support, that's the RLOG failure mode showing up disguised as a feature — catch it
  in review.

### crd.3b — Client resolution screen

- Depends on crd.3a's endpoint existing. Mental/Social/Physical segmented control (not a dropdown —
  matches this app's established chevron/segmented-control vocabulary), Willpower toggle correctly
  labelled with its real bonus (+2 here, confirmed by crd.1's spike, not the usual +3), merit chips
  populated from a real `GET` of the defender's own merits — never hardcoded, never assumed present.
- On accept, hands `final_pool` off to whatever existing function already rolls dice and renders the
  result (`public/js/suite/roll.js`/`roll-v2.js` or wherever that lives) — the pool-building logic is
  new, the dice-rolling-and-display logic is reused as-is.
- Genuinely new UI vocabulary for this app: an "on behalf of [Character]" style header when a
  multi-character player is resolving — there's no existing pattern to borrow (per crd.2's finding),
  design it deliberately here.

---

## Sequencing notes

- crd.1 → crd.2 → crd.3a → crd.3b, in that order — crd.3b's entry point is crd.2's queue, and
  crd.3a needs crd.1's schema/index work to exist first.
- Does not depend on further Epic OAQ work — OAQ is done/live. This epic does not change OAQ's own
  ST-facing behaviour (Decision 3 keeps `office-approvals.js` untouched).
- crd.4 needs its own dedicated scoping pass (Mary's four open questions) before any story is
  written against it — do not fold it into crd.1–3b's dev-story work.
- No code, schema, or live-data changes made by either scoping session. CLAUDE.md's hard rule
  against push/merge/deploy applies as always; this doc is scope-recording only.
