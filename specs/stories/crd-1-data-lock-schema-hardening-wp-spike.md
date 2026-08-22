---
id: crd.1
epic: crd
epic_file: specs/epic-crd-contested-roll-defence.md
status: done
priority: high
type: data-lock
depends_on: []
branch: ms/crd-1-data-lock-schema-hardening-wp-spike
---

# Story CRD.1: Data-lock, schema hardening, WP-rule spike

As the developer about to build the rest of Epic CRD (crd.2 the player queue, crd.3a the
server-side resolve endpoint, crd.3b the client resolution screen),
I want the real `contested_roll_requests` schema/routes/indexes hardened to support a two-phase
contested roll (attacker creates, defender resolves their own pool later) and the real Willpower
bonus question answered from actual code,
so that crd.3a has a data shape to write into and a settled WP+2-vs-+3 answer instead of
discovering either mid-build.

## Why this story exists

Read `server/schemas/contested_roll_request.schema.js`, `server/routes/contested-rolls.js`, and
`server/routes/office-actions.js` in full before touching anything — this story changes the first
two, not the third (office-actions.js is read-only precedent here).

**The real injury is worse than the epic doc's summary implied, and this story's own re-verification
found it precisely**: `contested_roll_request.schema.js`'s `required` array includes BOTH
`challenger_pool` AND `defender_pool` (lines 19-20), and `contested-rolls.js`'s `POST /`
(lines 13-33) inserts the request body verbatim after only schema validation — meaning **the
attacker submits the defender's dice pool at creation time today**. It is not "the system"
computing the defender's pool abstractly; it is literally the opposing player asserting what the
defender's resistance number is, with no defender input at any point before the dice roll
(`PUT /:id/accept`, lines 49-98, rolls `challenger_pool` and `defender_pool` exactly as submitted).
This sharpens the epic's own framing and should be quoted in crd.3a's own story when it's written.

**There is no existing `request_type: 'contested_roll'` value anywhere.** Confirmed by reading
every route: plain contested-roll documents have NO `request_type` field at all — it's simply
absent (`POST /`'s `doc` spread never sets it). `'status_action'` is the only explicit value that
exists (`office-actions.js:219`). The `{ request_type: { $ne: 'status_action' } }` guards on
`_findChallenge` (contested-rolls.js:153) and `/:id/void` (contested-rolls.js:133) work today only
because absence happens to satisfy `$ne`. This project has already been burned by exactly this
kind of implicit-discriminator fragility once (the `office_actions`/`contested_roll_requests` void
orphaning bug oaq.3's review found and fixed — see the comment block at `contested-rolls.js:125-131`).
**Decision for this story: stop relying on absence. Explicitly set `request_type: 'contested_roll'`
on every new contested-roll document going forward**, and update every query in
`contested-rolls.js` to filter on it explicitly rather than continuing to lean on `$ne`.

## Decisions already made (do not re-litigate)

- **Extend `contested_roll_request.schema.js` in place; do not fork a parallel collection or
  route file.** Unlike `status_action` (which bypasses this schema entirely via a direct
  `office-actions.js` insert because it's a structurally different single-party action with no
  opposing roll), contested rolls are the SAME kind of thing before and after this epic — a
  two-party opposed roll — just with the defender's pool now resolved later instead of asserted
  up front by the attacker. There is no reason to duplicate `contested-rolls.js`'s existing
  creation/accept/decline/void logic into a second file; extend the one that exists.
- **`defender_pool` is no longer required at creation.** It moves from "attacker-submitted at
  POST time" to "server-computed at resolution time" (crd.3a's job — this story only makes the
  field's presence optional and correctly typed at creation; it does not write the resolve
  endpoint). A pending contested-roll document between creation and resolution genuinely has no
  `defender_pool` yet.
- **`request_type: 'contested_roll'` is explicit going forward** (Decision above). Historical
  documents predating this story keep their absent `request_type` — no backfill migration, they're
  either already resolved (immutable history, `session_logs` is their durable record) or long
  expired. `_findChallenge` and `/:id/void`'s guards are updated to check
  `request_type: { $in: [undefined, 'contested_roll'] }`-equivalent (via `$ne: 'status_action'`
  kept as the safety net, `'contested_roll'` added as the explicit forward-going value) rather than
  removing the old guard outright — see Task 3.
- **The WP +2-vs-+3 spike is answered, not deferred**: `public/js/suite/roll-v2.js:207`
  (`const wpBonus = state.WP ? 3 : 0;`), referenced at lines 294, 344, and 669, is a single shared
  literal used by EVERY roll type in the real app today — there is no concept anywhere of a
  reduced Resistance-trait bonus. **Conclusion: crd.3a/crd.3b must NOT branch this shared file.**
  The contested-roll resolution screen gets its own, fully independent WP-spend control (mirroring
  the disposable mockup's own approach) — it never touches `state.WP`/`wpBonus` in `roll-v2.js`.
  `roll-v2.js` is only reused downstream, for the mechanical dice-roll-and-display step once a
  `final_pool` number already exists (crd.3b's own scope, not this story's).
- **`roll_type`'s existing enum (`'territory' | 'social' | 'resistance' | 'custom'`,
  `contested_roll_request.schema.js:28`) is NOT the same axis as the Mental/Social/Physical
  Resistance-Attribute choice crd.3a/3b need.** `roll_type` categorizes the CONTEST for
  session-log/display purposes (what kind of scene action this was); the M/S/P choice picks WHICH
  Resistance Attribute (Resolve/Stamina/Composure) feeds the defender's pool. They are independent
  fields — do not attempt to derive one from the other. This story adds `defender_aspect` as its
  own new field rather than overloading `roll_type`.

## What this story is NOT

- NOT the resolve endpoint itself (crd.3a) — this story only makes the schema/fields/indexes exist
  and correctly typed. No pool-recomputation logic, no merit validation, no live-Willpower
  re-check is written here.
- NOT the player-facing queue (crd.2) — `GET /mine` already exists and already works; this story
  only makes it fast (the missing index) and bounded (the missing TTL).
- NOT the client resolution screen (crd.3b) — no UI is touched in this story.
- NOT a change to `office-actions.js`'s own `status_action` flow — read-only precedent here, not a
  file this story modifies.
- NOT the crd.4 City Status/Blood Potency formula — still blocked per the epic file, untouched.
- NOT a live-data migration or backfill of historical `contested_roll_requests` documents — schema
  and index changes apply going forward only.

## Acceptance Criteria

1. `contested_roll_request.schema.js`'s `required` array no longer includes `defender_pool`.
   `defender_pool` stays in `properties` (still `integer, minimum 0, maximum 30`) but is optional at
   creation time. `challenger_pool` stays required (the attacker's own pool is unaffected by this
   epic).
2. The schema gains `request_type` (`{ type: 'string', enum: ['contested_roll'] }`, NOT required —
   omitting it is still valid for callers that don't set it, but `contested-rolls.js`'s `POST /`
   route itself always sets it explicitly to `'contested_roll'` on the inserted document,
   mirroring `office-actions.js:219`'s `request_type: 'status_action'` pattern).
3. The schema gains the three new resolution-submission fields, all optional at creation (they only
   ever get populated later, by crd.3a, not by this story or by `POST /`):
   `defender_aspect` (`{ type: 'string', enum: ['mental', 'social', 'physical'] }`),
   `defender_wp_spent` (`{ type: 'boolean' }` — a single point either spent or not, per the real
   Willpower rule's "only spend one point of Willpower per action" cap; not an integer),
   `defender_merit_ids` (`{ type: 'array', items: { type: 'string' } }`).
4. `contested-rolls.js`'s `POST /` sets `request_type: 'contested_roll'` on every document it
   creates (currently sets none).
5. `_findChallenge` (contested-rolls.js:143-160) and `PUT /:id/void` (contested-rolls.js:118-139)
   continue to correctly exclude `status_action` documents (regression: existing behaviour for
   `status_action` requests must be unchanged) AND correctly include BOTH legacy request_type-absent
   contested-roll documents AND new explicit `request_type: 'contested_roll'` documents. Real
   behavioural test: a legacy-shaped test fixture (`request_type` field entirely absent) still
   resolves/voids correctly; a new-shaped fixture (`request_type: 'contested_roll'` explicitly set)
   also resolves/voids correctly; a `status_action` fixture is still correctly excluded from both.
6. `GET /mine` (contested-rolls.js:36-46) is served by a compound index
   `{ target_character_id: 1, status: 1, created_at: -1 }` on `contested_roll_requests`, added in
   `server/index.js` alongside the existing oaq.2 partial unique index (lines 253-264) — same
   idempotent-`createIndex`-on-boot pattern, same file, same section.
7. A TTL index exists on `contested_roll_requests` for terminal-status documents
   (`status: { $in: ['resolved', 'declined', 'voided'] }`), keyed on `updated_at`, with a real
   retention window (recommend 30 days — long enough to cover a single game's own post-session
   review window per this project's own session cadence, short enough that the collection doesn't
   grow unbounded across a whole campaign; confirm this number with Angelus if a different retention
   period is wanted, don't silently pick one and bury it in code). `session_logs` already carries
   the durable audit record (`contested-rolls.js:81-95`), so nothing here needs indefinite
   retention.
8. A live spot-check confirms at least one real `tm_game.characters` document has
   `merits[].rating` (not `.dots`) and `attributes.{Resolve,Stamina,Composure}.dots` present and
   correctly shaped, run against the real Atlas connection this environment has (read-only —
   no write). Document the character checked and the exact field values read in this story's Dev
   Agent Record.
9. `specs/stories/nav.6.contested-roll-design.story.md`'s frontmatter `status` is changed to
   `superseded` and a note is added at the top of the file pointing to
   `specs/epic-crd-contested-roll-defence.md` as the superseding epic, with one sentence on why
   (predates the player-driven direction; describes an ST-only popup this epic replaces with a
   player-driven queue+resolution flow).
10. Real behavioural test coverage (Supertest against the mounted app + `tm_game_test`, this
    project's own established standard — not source-text assertions alone) for AC1-AC6.
    AC7/AC8/AC9 are index-existence/data/documentation checks respectively, not endpoint-behaviour
    tests — verify by other means appropriate to each (e.g. confirm the TTL index via
    `db.collection.indexes()` in a test or a documented manual check; AC8 is a one-time manual
    verification recorded in Dev Notes, not an automated test).

## Tasks / Subtasks

- [x] Task 1 — Schema changes (AC: 1, 2, 3)
  - [x] Update `server/schemas/contested_roll_request.schema.js`: drop `defender_pool` from
        `required`; add `request_type`, `defender_aspect`, `defender_wp_spent`,
        `defender_merit_ids` to `properties` per the exact shapes in AC2/AC3.
  - [x] Confirm `additionalProperties: false` still holds — every new field must be explicitly
        listed in `properties`, not left to fall through.

- [x] Task 2 — `POST /` sets `request_type` explicitly (AC: 4)
  - [x] `contested-rolls.js`'s `POST /` doc construction (lines 22-28) adds
        `request_type: 'contested_roll'` alongside the existing `status`/`outcome`/timestamps.

- [x] Task 3 — Route-guard audit (AC: 5)
  - [x] Update `_findChallenge`'s query (line 153) and `/:id/void`'s filter (line 133) so both
        correctly include legacy (absent `request_type`) AND new (`'contested_roll'`) documents
        while still excluding `'status_action'`. The simplest correct filter given both must be
        included: keep `request_type: { $ne: 'status_action' }` as written today — it already
        covers both cases correctly (absent !== 'status_action' is true; 'contested_roll' !==
        'status_action' is also true) — so THIS AC's real work is proving that with a genuine
        regression test for each of the three document shapes named in AC5, not necessarily
        rewriting the filter itself. Do not change the filter's logic unless the tests reveal it's
        actually wrong; do not skip writing the tests because the filter "looks like it already
        works."
  - [x] `GET /mine` (line 36-46) and `PUT /:id/accept`/`/:id/decline` (lines 49, 101) do not
        currently have any `status_action` exclusion at all except via `_findChallenge` (accept/
        decline) — `GET /mine`'s own filter (`{ target_character_id: { $in: charIds },
        status: 'pending' }`) has no `request_type` clause whatsoever. Confirm whether this is a
        real gap (could a `status_action` document ever have a `target_character_id` field and
        leak into a player's own queue?) by reading `office-actions.js`'s own document shape
        (lines 218-230) — it uses `target_id`, not `target_character_id`, so today's field-name
        mismatch already prevents the leak by accident, the same "harmless only by accident"
        pattern this project has already been burned by once. Add an explicit
        `request_type: 'contested_roll'` (or the `$ne: 'status_action'` equivalent, for
        legacy-doc coverage) clause to `GET /mine`'s query rather than continuing to rely on the
        field-name coincidence.

- [x] Task 4 — Indexes (AC: 6, 7)
  - [x] Add the compound index to `server/index.js`, same section/pattern as the existing oaq.2
        index (lines 253-264).
  - [x] Add the TTL index, same section, `background: true`, partial filter on terminal statuses,
        `expireAfterSeconds` matching the retention window decided in AC7.

- [x] Task 5 — Live data spot-check (AC: 8)
  - [x] One read-only query against the real `tm_game` database (via whatever this environment's
        established safe-read pattern is — check `server/scripts/` for an existing read-only
        query script precedent before writing a new one) confirming the real field shapes. Record
        findings in Dev Notes, do not write anywhere.

- [x] Task 6 — Supersede nav.6 (AC: 9)
  - [x] Edit `specs/stories/nav.6.contested-roll-design.story.md` per AC9.
  - [x] Check `specs/stories/sprint-status.yaml` for whether `nav.6` has its own tracked row under
        an `epic-unified-nav-polish` block; if so, update its status there too, consistent with
        this project's own established supersession precedent (`epic-npcr.md`'s FR7/FR8, superseded
        by DBO-8).

- [x] Task 7 — Tests (AC: 10)
  - [x] New test file, e.g. `server/tests/crd-1-contested-roll-request-shape.test.js`, covering
        AC1-AC6 with real Supertest coverage against the mounted app.
  - [x] Targeted regression: re-run `contested-rolls.js`'s existing test coverage (find it — likely
        an existing `contested-rolls`/`oaq`-adjacent test file) alongside the new one, confirm no
        regression.

## Dev Notes

### Current state of files this story touches (read in full before starting)

- **`server/schemas/contested_roll_request.schema.js`** (34 lines). See the Why section above for
  the full current shape — `required` includes `defender_pool` (must be removed),
  `additionalProperties: false` (every new field must be added to `properties`).
- **`server/routes/contested-rolls.js`** (187 lines). Five routes: `POST /` (create),
  `GET /mine` (defender's pending list), `PUT /:id/accept` (rolls both pools server-side, dice
  only — no pool computation), `PUT /:id/decline`, `PUT /:id/void` (ST-only). `_findChallenge`
  (143-160) is the shared lookup+pending-guard every mutating route calls.
- **`server/index.js`** lines 253-264: the one existing index on this collection, a partial unique
  index scoped to `{ request_type: 'status_action', status: 'pending' }` — this story's two new
  indexes go in the same section, same `createIndex`-on-boot pattern (not awaited, per the
  established convention for indexes whose uniqueness constraint can't realistically collide with
  live data — contrast with the AWAITED `game_sessions.chapter_id` index at lines 282-... which
  needed awaiting specifically because an ST can hand-edit data into a collision; neither new index
  here has that risk).
- **`server/schemas/character.schema.js`**: attributes at lines 162-179 (`attrObj`, `dots`+`bonus`
  both required, definition at line 402-404), merits `rating` field at line 451 (inside the shared
  merit-item sub-schema starting line 226).
- **`office-actions.js`** (read-only precedent, not touched by this story): `request_type:
  'status_action'` set explicitly at line 219; `_findPending` (94-105) is the structurally
  analogous lookup+guard helper to `contested-rolls.js`'s `_findChallenge` — same shape, worth
  comparing when writing this story's route-guard tests.

### Forward-looking note for whoever writes crd.3b (not this story's own task)

`specs/stories/sprint-status.yaml` (~line 1348-1372) shows an ACTIVE, `in-progress` **Epic RLV
(Dice Roller Harmonisation)** consolidating `roll.js`/`roll-v2.js` into one roller and retiring the
legacy one (`rlv-2-promote-roll-v2-retire-roll-v1: ready-for-dev`). crd.3b's "hand `final_pool` off
to whatever existing function already rolls dice" step should target RLV's post-rlv.2 end state,
not the legacy roller — check RLV's own progress before crd.3b starts, and read
`specs/epic-rlv-roller-harmonisation.md` for its current shape. This does not affect crd.1 at all
(this story never touches `roll-v2.js` or any roller file — the WP-spike finding above is read-only
research, not a code change here) — noted here only so it isn't lost by the time crd.3b is written.

### Project Structure Notes

No new files except the new test file and (if it doesn't already exist) a read-only spot-check
script under `server/scripts/`. No new directories. Matches this project's existing
`server/schemas/`, `server/routes/`, `server/tests/` layout exactly.

### References

- [Source: specs/epic-crd-contested-roll-defence.md#crd.1] — this story's originating scope block.
- [Source: server/schemas/contested_roll_request.schema.js] — full file, current shape confirmed
  this story.
- [Source: server/routes/contested-rolls.js] — full file, current shape confirmed this story.
- [Source: server/routes/office-actions.js#L94-105,218-230,244-266] — the structurally analogous
  `status_action` precedent (`_findPending`, explicit `request_type`, the "check at approval not
  submission" pattern crd.3a will need later).
- [Source: server/index.js#L253-264] — the one existing index on this collection.
- [Source: public/js/suite/roll-v2.js#L207,294,344,669] — the WP+3 spike finding.
- [Source: server/schemas/character.schema.js#L162-179,226,402-404,451] — attribute/merit field
  shapes.

## Dev Agent Record

### Agent Model Used

claude-opus-5 (bmad-dev-story workflow, 2026-08-22).

### Implementation Plan

Red → green → refactor per task, in the order the Tasks section lists them. Every AC that describes
endpoint behaviour (AC1-AC6) is proved by a real Supertest request against the mounted test app and
`tm_game_test`, following `oaq-2-pending-status-actions.test.js`'s established shape exactly. AC7 is
proved from two directions (the boot-time declaration in `server/index.js`, and the index definition
itself accepted by a real MongoDB and reported back through `indexes()`), AC8 by a one-time
read-only query recorded below, AC9 by inspection.

1. Task 1 (schema) then Task 2 (route) — both are prerequisites for everything else, and both are
   directly observable through `POST /`.
2. Task 3 (guard audit) — write the three-document-shape regression FIRST, then only change a
   filter if the test actually shows it wrong.
3. Task 4 (indexes) — declaration + behavioural query-plan check.
4. Task 5 (live spot-check), Task 6 (nav.6), Task 7 (regression gate).

### Debug Log References

**Task 1 — schema.** Red first: 9 of 17 new tests failed against the unmodified schema
(`must have required property 'defender_pool'` plus `must NOT have additional properties` for each
of `request_type`, `defender_aspect`, `defender_wp_spent`, `defender_merit_ids`). After the schema
edit: 15/17, leaving only the two Task 2 route tests red.

**Task 2 — `POST /` sets `request_type`.** `request_type: 'contested_roll'` is set AFTER the
`...req.body` spread so the route is always the authority on it, never the caller. A test asserts
that ordering directly, so a later refactor that moves the spread below the explicit set (silently
handing the field back to the client) fails rather than passing quietly. 17/17 green.

**Task 3 — route-guard audit.** `_findChallenge` (line 153) and `PUT /:id/void` (line 133) were
found to be **already correct** and were left unchanged, exactly as the task anticipated: `$ne:
'status_action'` genuinely covers both the legacy (field absent) and the new
(`'contested_roll'`) shapes. That is now proved rather than assumed — a legacy-shaped fixture, a
new-shaped fixture and a `status_action` fixture are each driven through accept, decline and void.

`GET /mine` was a REAL gap and did change. Its filter had no `request_type` clause at all; the only
thing keeping Status Actions out of a player's queue was `office-actions.js` happening to write
`target_id` rather than `target_character_id` — a field-name coincidence, the same "harmless only by
accident" shape that produced the oaq.3 void-orphaning bug. Red test: a hand-seeded `status_action`
document that DOES carry `target_character_id` leaked straight into `GET /mine`.

Fixed with `request_type: { $in: [null, 'contested_roll'] }` rather than the `$ne: 'status_action'`
the task offered as an alternative. `$in: [null, ...]` matches documents where the field is absent,
so legacy coverage is identical, but the filter is POSITIVE: a fourth `request_type` sharing this
collection later cannot leak into a player's queue by default. A second test discriminates the two
choices by seeding a hypothetical `'some_future_request'` document — it passes under `$in` and would
fail under `$ne`.

**Task 4 — indexes.** Both added to `server/index.js` in the same section and with the same
un-awaited `createIndex`-on-boot pattern as the oaq.2 index. Neither is unique, so neither can
reject at build time against live data (contrast the AWAITED `game_sessions.chapter_id` index
immediately below them, whose uniqueness constraint spans ST-editable data).

**Two findings recorded during Task 4, neither of which crd.1 fixes:**

1. **The TTL index is inert today.** MongoDB's TTL monitor only expires documents whose indexed
   field holds a BSON **Date**. Every writer on this collection — `contested-rolls.js` AND
   `office-actions.js` — stores `new Date().toISOString()`, i.e. a **string**. The index is
   correct, idempotent and harmless, but it will delete nothing until `updated_at` becomes a real
   Date. Converting it is a cross-route data-shape change plus a backfill of every existing
   document, which this story explicitly excludes ("NOT a live-data migration or backfill"). This is
   recorded in a comment at the index itself and pinned by a test
   (`DOCUMENTED LIMITATION: updated_at is still written as an ISO STRING`) that fails the day the
   field's type changes, so the note gets re-read instead of silently rotting. **Wants its own
   follow-up story.**
2. **The TTL's partial filter is on `status` alone**, per AC7's own wording, so it also covers
   terminal `status_action` records sharing this collection. Checked rather than assumed, and it is
   safe: `office_actions` holds the durable applied-action log, oaq.3's approval queue reads
   `status: 'pending'` only, and oaq.2's "already acted on this target this session" dedupe read is
   scoped to the CURRENT `game_session_id`, whose records are days old, never 30+. Reasoning
   recorded in the index comment. (A `request_type`-scoped partial filter was considered and
   rejected: `$ne` is not a legal partial-filter operator, and a positive
   `request_type: 'contested_roll'` filter would silently exclude every legacy document.)

**Retention window: 30 days (`expireAfterSeconds: 2592000`)**, the value AC7 recommends. Not buried
— it is named in the index comment, in the test, and flagged in the completion report for Angelus to
change if a different window is wanted.

**Test-harness artefact found and fixed (not a source defect).** oaq.2's partial UNIQUE index on
`(game_session_id, actor_id, target_id)` is created against the SHARED `tm_game_test` database by
`oaq-2-pending-status-actions.test.js`, and persists there between runs. This file's first
`status_action` fixtures left all three fields absent, so two of them keyed on `(null, null, null)`
and collided with E11000 — but only once oaq-2 had run at least once in the same database, which is
why it surfaced mid-story rather than at first write. Fixtures now carry distinct synthetic values.

**Task 5 — live spot-check.** Checked `server/scripts/` for a read-only precedent first, as the task
directs: `audit-data-hygiene.js` is the established shape (`READ ONLY` banner,
`node -r dotenv/config server/scripts/...`, `MONGODB_URI`/`MONGODB_DB` from env). A single throwaway
read-only query was run in that style rather than adding a permanent script, since AC8 is a one-time
verification with nothing to re-run. Results below. No writes; `find`/`findOne`/`countDocuments`
only.

**Task 6 — nav.6.** Verified rather than re-done: AC9 was already fully satisfied by the
`bmad-create-story` step in this same branch's working tree — `nav.6.contested-roll-design.story.md`
carries `status: superseded` plus a top-of-file SUPERSEDED note naming
`specs/epic-crd-contested-roll-defence.md` and the reason, and `sprint-status.yaml`'s
`nav-6-contested-roll-design` row is `superseded` with its own correction note. Nothing further was
needed; both files are listed in the File List because this story owns those uncommitted changes.

### Completion Notes List

**AC8 — live read-only spot-check against `tm_game` (Atlas), 2026-08-22.** Result: the epic's field
paths are correct as written, and there is no `dots`-shaped merit anywhere in live data.

- **Character checked: Yusuf Kalusicj**, `_id` `69d720427fdd1b1f9498b0d4`, not retired.
  - `attributes.Resolve`   = `{ dots: 3, bonus: 0, cp: 2, xp: 0, free: 1, rule_key: 'resolve' }`
  - `attributes.Stamina`   = `{ dots: 2, bonus: 0, cp: 1, xp: 0, free: 1, rule_key: 'stamina' }`
  - `attributes.Composure` = `{ dots: 2, bonus: 0, cp: 0, xp: 0, free: 2, rule_key: 'composure' }`
  - 30 merits, every one keyed on **`rating`**, e.g.
    `{ category: 'influence', name: 'Contacts', rating: 5, ... rule_key: 'contacts' }`.
  - Its **Indomitable** entry, which crd.3a will need to resolve generically:
    `{ category: 'general', name: 'Indomitable', rating: 2, cp: 0, xp: 2, free: 0, rule_key: 'indomitable', bonus: 0 }`.
    Note `rule_key` — a stable machine identifier already present on every merit, which is a better
    basis for crd.3a's generic merit gating than matching on `name`.
- **Corpus-wide (43 characters total):**
  - 40 carry at least one `merits[].rating`. **0 carry any `merits[].dots`** — the `rating`-not-
    `dots` finding holds across the whole live collection, not just one document.
  - The 3 without a `merits[].rating` simply have an EMPTY `merits` array (Humongulus,
    Orenthal Lamar McGillicuddy, and the retired Jelle Dunneweld) — not a different merit shape.
    crd.3a must still handle an empty merits array, but not a second field name.
  - **0 characters are missing `attributes.Resolve.dots`, `attributes.Stamina.dots`, or
    `attributes.Composure.dots`** — all three Resistance Attributes are present and correctly
    shaped on all 43, so crd.3a's aspect→Resistance-Attribute mapping has no missing-data case in
    live data.
  - 14 characters have the Indomitable merit, so crd.3a's merit-gating path has real data to test
    against.

**WP +2-vs-+3 spike — CONCLUSION (no code change here, and none wanted).** Re-confirmed against
the real file: `public/js/suite/roll-v2.js:207` is `const wpBonus = state.WP ? 3 : 0;`, a single
shared literal referenced at lines 294, 344 and 669 and used by EVERY roll type in the app. There is
no concept anywhere of a reduced Resistance-trait bonus. **crd.3a/crd.3b must NOT branch or
parameterise that shared file** — the contested-roll resolution screen gets its own fully
independent Willpower-spend control and never touches `state.WP`/`wpBonus`. `roll-v2.js` (or its
Epic RLV successor, see the story's own forward-looking note) is reused only for the mechanical
dice-roll-and-display step, once a `final_pool` number already exists. `roll-v2.js` was not opened
for editing at any point in this story.

**Two items for Angelus / a follow-up story, neither in crd.1's scope:**
1. The **TTL index is inert** until `updated_at` is stored as a BSON Date rather than an ISO
   string (see Debug Log, Task 4, finding 1). The index is in place and correct; the reaper simply
   has nothing it recognises to reap.
2. The **30-day retention window** is AC7's own recommendation and is now live in code, comment and
   test. Say if a different window is wanted.

**Not done, deliberately:** no resolve endpoint (crd.3a), no queue UI (crd.2), no resolution screen
(crd.3b), no change to `office-actions.js`, no backfill or migration of historical documents, no
client-side change of any kind.

### Test Results

- **New suite** `server/tests/crd-1-contested-roll-request-shape.test.js`: **34 passed / 0 failed**
  (AC1 ×4, AC2/AC4 ×4, AC3 ×9, AC5 ×7, AC5/AC6 ×4, AC6 ×3, AC7 ×3).
- **Changed-area regression** (10 suites — the new one plus every suite touching
  `contested-rolls.js`, `contested_roll_requests`, or `server/index.js`):
  `crd-1-contested-roll-request-shape`, `oaq-2-pending-status-actions`, `oaq-3-approval-queue`,
  `otc-2-office-actions-api`, `issue-1143-office-actions-auth-safety`, `epic.708.1-cycle-schema-api`,
  `cm-4-renumber-chapter-merge`, `oxp-3-office-manoeuvre-rank`, `feature.691.hos-city-status-power`,
  `tickets-removed` → **332 passed / 1 failed (333)**.
- The single failure is `cm-4-renumber-chapter-merge.test.js` →
  "the real-numbers Chapter-7 shape: 32 arrive, 1 was already there, 33 in total", a
  `Test timed out in 5000ms` on a heavy Atlas-backed test. **Proved pre-existing, not caused by this
  change**, two ways: (a) that suite passes **136/136** when run alone, and (b) the same multi-suite
  run with all of this story's changes stashed fails **identically** (1 failed / 298 passed). It is
  a per-test 5s timeout losing a race with remote-Atlas latency under multi-worker contention, and
  it touches `chapters`/`game_sessions`/`downtime_submissions` — no collection or code path this
  story modifies.
- No Playwright run: this story changes no client code.

### File List

- `server/schemas/contested_roll_request.schema.js` — modified (Task 1)
- `server/routes/contested-rolls.js` — modified (Tasks 2, 3)
- `server/index.js` — modified (Task 4)
- `server/tests/crd-1-contested-roll-request-shape.test.js` — **new** (Task 7)
- `specs/stories/nav.6.contested-roll-design.story.md` — modified (Task 6, AC9)
- `specs/stories/sprint-status.yaml` — modified (Task 6 / workflow status tracking)
- `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md` — this file (Dev Agent Record, File
  List, Change Log, Status, task checkboxes)

## Senior Developer Review

**Date:** 2026-08-22. **Status:** review → done. **Reviewer:** external Codex review, verified and
patched in-session. **NOT committed, NOT pushed, NOT merged** — Angelus's call.

### Provenance of the findings — what came from OUTSIDE this story's own work

Every finding triaged below came from an **EXTERNAL adversarial review run in Codex** (3-pass
blinded protocol), not from this story's own dev pass and not from anything found while writing
these patches. The full, unedited findings file is persisted at
**`specs/stories/code-review/crd-1-codex-findings.md`** — read it there rather than here; it is not
duplicated inline, and it was not edited when these patches were applied.

Nothing new was discovered during this patch pass itself. The only in-pass observations were
mechanical: two pre-existing tests in this story's own suite had codified the very behaviour the
patches remove (`accepts all three new fields together` and the `defender_aspect` `it.each` both
asserted that attacker-supplied resolution fields are echoed back), so both were rewritten to assert
schema-acceptance only. That is a consequence of patch 2, not a separate finding.

### Independent verification before any patch was written

Both High findings were **reproduced live against the real running route before a line was changed**,
rather than accepted on the reviewer's authority:

- A `contested_roll_requests` document was created through `POST /api/contested_roll_requests` with
  **no `defender_pool`** (valid per this story's own AC1 schema change), then `PUT /:id/accept` was
  called. Real result: **HTTP 200**, `defender: { pool: null, successes: 0, rolls: [] }`,
  `outcome: 'attacker'`. The defender silently lost the contest on zero dice. Root cause confirmed in
  `_roll(n)`: `Math.max(0, undefined)` is `NaN`, so the roll loop never executes and returns `[]`.
  That exact response body was reproduced again by the new red test before the guard landed.
- The three defender-resolution fields were confirmed by direct code read to survive `POST /`'s
  `...req.body` spread into the stored document, contradicting AC3's own literal wording.

### Patched (2)

1. **`PUT /:id/accept` now refuses a challenge with no resolved defender pool** (Codex Pass 2 High,
   restated by Pass 3a's "never makes the intermediate release safe" and "`defender_pool` remains
   attacker-writable"). Returns **409 `CONFLICT`** with an explicit message, matching this route's
   own existing 409 "no longer pending" convention, and leaves the record pending with no
   `session_logs` entry. Deliberately an **interim block, not resolution logic** — crd.3a's resolve
   endpoint is what will ever populate `defender_pool` for real; until then an unresolved request
   cannot be accepted at all, which is safe, rather than silently rolling zero dice, which is not.
   The guard is `== null`, not falsy, so an explicit `defender_pool: 0` (a legitimately
   crd.3a-computed zero) still accepts. It runs AFTER the ownership check, so a non-target still
   gets 403. `PUT /:id/decline` is deliberately NOT guarded — a defender may always refuse.
2. **`POST /` no longer persists attacker-supplied `defender_aspect`, `defender_wp_spent` or
   `defender_merit_ids`** (Codex Pass 3a Medium, "AC3 says resolution choices are never populated by
   POST, but POST persists all three"). All three are stripped **after** the `...req.body` spread,
   the same way `request_type` is force-set after it, so the route is always the authority. These are
   the defender's own submitted choices; letting the attacker assert them at creation is the same
   shape of injury as the attacker-writable `defender_pool` this epic exists to remove. The schema
   still lists all three (`additionalProperties: false` still holds, and crd.3a's resolve endpoint
   writes them) — they are simply never honoured at creation. **AC3's literal wording is now true as
   written and needed no amendment.**

**Prove-discrimination, run per patch, never combined.** Each patch was reverted alone, the suite
re-run, and the fix restored (the route file was byte-compared against a pre-revert copy after each
restore, `RESTORED IDENTICAL` both times):

- Patch 1 reverted alone → **1 failed / 41 passed**, the failure being exactly the live repro
  (`expected 200 to be 409`, response body carrying `defender: { pool: null, successes: 0,
  rolls: [] }` and `outcome: 'attacker'`). No patch-2 test moved.
- Patch 2 reverted alone → **3 failed / 39 passed**, all three the new provenance tests
  (`expected 'mental' to be undefined` etc.). No patch-1 test moved.

### Deferred, NOT patched here — each needs its own story

Named explicitly so they are not silently inherited by crd.3a. All three are logged in
`specs/deferred-work.md` under this story's own block.

1. **Un-awaited `createIndex()` promises in `server/index.js`** (Codex Medium, Pass 1 + Pass 3b) —
   both new crd.1 indexes (`crd1_defender_queue`, `crd1_terminal_status_ttl`) discard their promise
   with no `.catch()`. Independently confirmed by direct code read here. The Dev Agent Record's claim
   that a non-unique index "cannot reject at build time" is genuinely wrong: option conflicts,
   permissions and dropped connections all reject. Deliberately out of scope for this patch round —
   it is a boot-path convention shared with the pre-existing oaq.2 index and wants a single
   consistent fix across all of them.
2. **`$ne`-vs-positive-scoping inconsistency on `_findChallenge` and `PUT /:id/void`** (Codex Medium,
   Pass 3a) — `GET /mine` was upgraded to `request_type: { $in: [null, 'contested_roll'] }` but the
   two mutation guards still use `{ $ne: 'status_action' }`, so any future fourth request family in
   this shared collection is default-allowed into contested-roll lifecycle routes. Confirmed by
   direct code read. Real inconsistency, no current exploit (no third explicit request family
   writes production records today).
3. **The parent epic's server-derived `game_session_id` was never added** (Codex Medium, Pass 3a) —
   `specs/epic-crd-contested-roll-defence.md` (~line 100) puts a server-derived `game_session_id` in
   crd.1's creation shape and explicitly forbids a client-supplied one; `POST /` adds no such field
   and no AC in this story ever mentioned it. **NOT resolved here, and deliberately not implemented:
   this is a scope decision for Angelus** — does it belong retroactively in crd.1, or in crd.2/crd.3a
   where the queue and resolution actually need session provenance? Note that whichever way it goes,
   crd.1-created documents will not carry it.

### Regression after both patches

- **New/updated suite** `server/tests/crd-1-contested-roll-request-shape.test.js`: **42 passed /
  0 failed** (was 34; +5 patch-1 tests, +3 patch-2 tests, 2 pre-existing tests rewritten).
- **Changed-area regression, 11 suites** (the 10 the dev pass used, plus
  `cm-2b-chapters-route-and-dual-read` which Codex correctly pointed out reads `server/index.js` and
  was missing from that list): **11 files passed, 377 passed / 0 failed**. Pre-patch baseline on the
  same 11 suites is 369, i.e. **+8 = exactly the eight new tests, no new failures**.
- The `cm-4-renumber-chapter-merge.test.js` failure the dev pass recorded did not reproduce this run;
  it is a 5s-per-test timeout racing remote-Atlas latency, not a deterministic failure, and it is
  unrelated to any collection or code path this story touches.
- No Playwright run: still no client code in this story.

### Files changed by this review round

- `server/routes/contested-rolls.js` — both patches.
- `server/tests/crd-1-contested-roll-request-shape.test.js` — 8 new tests, 2 rewritten.
- `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md` — this section, Status, Change Log.
- `specs/stories/sprint-status.yaml` — crd.1 row + narrative.
- `specs/deferred-work.md` — the three deferred items above.
- `specs/stories/code-review/crd-1-codex-findings.md` — persisted external findings, **unedited**.

## Change Log

| Date | Change |
|------|--------|
| 2026-08-22 | Story created (`bmad-create-story`), `ready-for-dev`. |
| 2026-08-22 | External Codex review closed. Both High findings reproduced live before patching, then patched with per-patch prove-discrimination: `PUT /:id/accept` now returns 409 rather than silently resolving a pool-less challenge as a zero-die defence, and `POST /` strips attacker-supplied `defender_aspect`/`defender_wp_spent`/`defender_merit_ids` after the body spread (AC3's literal wording is now true as written, unamended). Three findings deferred to `specs/deferred-work.md` and named for follow-up stories: un-awaited `createIndex` promises, the `$ne`-vs-positive-scoping inconsistency on `_findChallenge`/`void`, and the epic-vs-story `game_session_id` gap (needs Angelus's own scope decision). Suite 34 → 42 passed; 11-suite changed-area regression 377/377. Status `review` → `done`. NOT committed, NOT pushed, NOT merged. |
| 2026-08-22 | `bmad-dev-story`: Tasks 1-7 implemented. `defender_pool` dropped from the schema's `required` array; `request_type`, `defender_aspect`, `defender_wp_spent`, `defender_merit_ids` added to `properties` under the existing `additionalProperties: false`. `POST /` now sets `request_type: 'contested_roll'` explicitly, after the body spread. `GET /mine` scoped with `request_type: { $in: [null, 'contested_roll'] }` — a real gap, previously safe only by a `target_id`/`target_character_id` field-name coincidence. `_findChallenge` and `PUT /:id/void` proved correct across all three document shapes and left unchanged. Compound defender-queue index and 30-day terminal-status TTL index added to `server/index.js`. Live read-only spot-check confirmed `merits[].rating` (0 of 43 characters use `.dots`) and all three Resistance Attributes present on all 43. WP spike concluded: `roll-v2.js:207`'s shared `wpBonus = 3` must not be branched by crd.3a/3b. Status `ready-for-dev` → `review`. |
