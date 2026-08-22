# Deferred Work

## Deferred from: DT Story UX (2026-04-17)

- ~~**DT Story — taller narrative textarea**~~ — **FOLDED INTO Epic 1 (Story Surface Reform) as DTS1.10** during 2026-04-27 scoping pass. See `memory/project_dt_overhaul_2026-04-27.md`.
- ~~**DT Story — collapse completed cards**~~ — **FOLDED INTO Epic 1 as DTS1.11** during 2026-04-27 scoping pass. See `memory/project_dt_overhaul_2026-04-27.md`.

## Deferred from: DTFC Epic Wave 3 (2026-04-20)

These stories are blocked on infrastructure that doesn't yet exist. Defined in `specs/epic-dtfc-downtime-form-calibration.md`.

- ~~**dtfc.9 — NPC Story Moment**~~ — **UNSHELVED**: Now has a full design. Implemented as DT Story 1.11 (Personal Story player form with NPC stub) + 1.14 (six-section report delivery). The NPC stub (`character.npcs[]`) is a placeholder interface; the full NPC Register is a separate future epic. See `specs/epic-dt-story.md` stories 1.11 and 1.14.
- ~~**dtfc.10 — Collaborative Projects**~~ — **SUPERSEDED by Epic 5 (Joint Downtimes)** during 2026-04-27 scoping pass. Architectural design is captured in `memory/project_dt_overhaul_2026-04-27.md`. Resolved product calls: lead recourse on decline (Call A), mid-cycle description edits (Call B), action-type whitelist (Call C). 6 stories: JDT5.1 schema, JDT5.2 lead invitation flow, JDT5.3 invitee acceptance flow, JDT5.4 slot lock + read-only display, JDT5.5 ST Processing Joint Projects phase, JDT5.6 lifecycle edge cases.
- **dtfc.11 — Equipment Tab in player.html**: Equipment section removed from the DT form (can be done in Wave 2). New Equipment tab in `player.html` is separate scope — needs its own design and story.

---

## Deferred from: code review of fix.2.area-of-expertise-qualifier (2026-04-10)

- **Bloodline grants persist to DB after first character save** — `applyDerivedMerits()` in `mci.js` writes bloodline-granted specs and merits (e.g., Gorgon: Animal Ken Snakes, AoE Snakes, IS Snakes) to the character on every render cycle; once saved to Atlas, they become regular character data. This is the same pattern used for MCI/PT/K-9/OHM grants and is intentional. If grants ever need to be revocable on bloodline change, a cleanup pass would be required.

---

## Deferred from: code review of npcr.3.flags-collection-admin-queue (2026-04-24)

- **`createTestApp` mountpoint has no `NODE_ENV` production guard** — pre-existing pattern across the test harness. If `createTestApp` is ever imported from non-test code, the `X-Test-User` header allows arbitrary role escalation.
- **Index-creation scripts default to `tm_suite` when `MONGODB_DB` is unset** — pre-existing convention. Vitest setup forces `tm_suite_test` for tests, but manually-run scripts still hit prod by default.
- **Timestamps stored as ISO strings, not BSON Date, project-wide** — consistent between NPCR.2 relationships and NPCR.3 flags. Lexicographic sort works on ISO-8601 by coincidence; change requires a cross-collection migration decision.
- **`apiPost` / `apiPut` do not expose HTTP status codes to callers** — app-wide concern affecting every client route. Clients cannot distinguish 409 from 500, blocking graceful conflict recovery everywhere.
- **No rate limit on `POST /api/npc-flags`** — infrastructure-level. Bounded in practice by a player's active-edge count.
- **Retired characters can still flag** — product decision. Do we silence retired PCs across all player surfaces, or just this one?
- **Test fixtures share `CREATED_FLAG_IDS[0]`/`[1]` by ordinal index** — brittle to vitest order changes; per-test fixtures would be cleaner.
- **`getTestCharacterIds` auto-seeds `_test_seeded: true` characters in `tm_suite_test` with no cleanup path** — pre-existing helper concern.

---

## Deferred from: code review of otc-2-status-actions-server-hardening (2026-08-12)

External Codex review (reasoning_effort=high, 3-pass) of the Status Actions server-hardening story
surfaced several real, verified findings that predate this story (confirmed against the pre-diff
code) and are out of its stated scope. Full record: `specs/stories/otc-2-status-actions-server-hardening.md`
→ Senior Developer Review. **Filed as issue #1143.**

- **No authorization check on `POST /api/office_actions`'s `actor_id`** (High) — any authenticated
  user can submit any character as the acting officeholder, not just their own, and not restricted
  to Head of State. Pre-existing since #691.
- **`game_session_id` is a caller-supplied, unvalidated string** (High) — nothing binds it to a
  real session or the live cycle, so an attacker can invent a fresh session id per request to reset
  both the budget check and the per-target dedupe check. Pre-existing since #691; undercuts the
  value of the otc.2 budget-formula fix, since the scoping key itself is spoofable.
- **Budget check, dedupe check, and the eventual writes are not atomic** (High/Medium) — a real
  concurrent-request race allows overspending the budget or double-acting on one target. Pre-existing
  since #691; otc.2's two added DB round-trips were traced and confirmed not to widen this
  particular window.
- **Self-target check compares raw ObjectId strings, not resolved ObjectIds** (Medium) — an
  uppercase/lowercase-hex pair of the same id bypasses the "cannot target yourself" rule.
  Pre-existing, unchanged by otc.2.
- **`server/tests/helpers/db-setup.js`'s `setupDb()`/`teardownDb()` don't skip cleanly on a failed
  MongoDB connection** (Low) — produces a confusing double-error instead of the wholesale skip the
  file's own header promises. Shared test infrastructure, affects every DB-backed suite in the
  project, not scoped to any one story.
- **`office-tab.js` cannot distinguish "no game is live" from a network/auth failure fetching
  cycles** (Medium) — both render the same "Available once the game session opens" message.
  Matches a pre-existing swallow-errors pattern already used one line above it; a real fix needs a
  UX decision on what each state should actually say.

---

## Deferred from: code review of issue-1143-status-actions-auth-safety (2026-08-12)

Internal Edge Case Hunter + Acceptance Auditor review (issue #1143's own fix). Full record:
`specs/stories/issue-1143-status-actions-auth-safety.md` → Senior Developer Review.

- **`findLatestSession()` has no tiebreak for two `game_sessions` docs sharing a date** (Medium) —
  sorts only by `session_date`, no secondary key. If an ST creates a second session record for the
  same date mid-cycle (a plausible correction), which one two different `POST /api/office_actions`
  requests each resolve to as "the current session" is not guaranteed stable across requests,
  which could split budget/dedupe scoping across two session buckets. Narrow trigger condition,
  not part of issue #1143's original 5 findings — deferred rather than folded into that fix.
- **AC1's actor-ownership check (`office-actions.js`) uses raw string equality, not
  ObjectId-normalized comparison** (Low) — inconsistent with AC4's own reasoning for why the
  self-target check needed ObjectId normalization. Fails safe (rejects a legitimate owner rather
  than admitting an impostor); real-world trigger unlikely given how `character_ids` is populated
  in this project's auth flow. Cosmetic/consistency fix if anyone touches this route again.

**Update, 2026-08-12 (otc-3 review):** the "No authorization check on `actor_id`" finding above was
re-confirmed live by otc-3's own Codex review (`server/routes/office-actions.js` is untouched by
that story's diff). otc-3 opened the Office tab to every player regardless of whether they hold a
court office, which removes the UI-level discovery barrier that previously meant only a Head of
State browsing their own office ever saw the Status Actions panel at all. The API route itself was
always directly reachable by any authenticated session regardless of tab visibility, so nothing new
is exposed — but the pre-existing gap is now more discoverable/likely to be stumbled onto. Angelus
reviewed this trade-off and approved shipping otc.3 as scoped rather than gating it on this fix
landing first; this entry's priority is unchanged (High) but this note records the increased
practical exposure for whoever picks up #1143.

## Deferred from: EQC-5 (issue #1156, dev-story implementation 2026-08-13)

- **Two skill-acquisition Playwright specs have stale fixtures, unrelated to EQC-5** (Low, found not
  caused) — `tests/fix-493-skill-acq-outcome-summary.spec.js` (4 of its 5 tests) and one of
  `tests/fix-player-skill-acq-outcome.spec.js`'s 3 tests ("AC-1: skill acquisition outcome_summary
  appears in player Resources group") fail on `main`/pre-EQC-5 exactly as they do after EQC-5's changes
  (confirmed via `git stash` isolation during this story's implementation). Root cause: both files'
  fixtures place skill-acquisition outcome data at `acquisitions_resolved[0]`, but fix.914 (a later
  story) moved Skill Acquisition to slot `[1]` (Resources kept `[0]`) and these two files' fixtures were
  never updated to match — `fix-491-skill-acquisition-outcome-card.spec.js` and
  `fix-914-acquisition-outcome-field-slot.spec.js` DO use the correct post-fix.914 slot and are fully
  green, confirming the underlying `downtime-story.js`/`downtime-views.js` read logic is correct; only
  these two test files' own fixtures are stale. EQC-5 removed the skill-acquisition WRITE side only
  (see its story's "stop writing, keep reading" shape) and explicitly did not touch either of these read
  files, so fixing stale fixtures in tests for functionality this story doesn't modify is out of its
  scope. Whoever next touches either spec should move the fixture's `acquisitions_resolved` entry from
  index `[0]` to `[1]`.

## Deferred from: EQC-4 (issue #1155, internal 3-layer review 2026-08-13)

- **A tweak request on an availability-5 item computes a cost (6) the catalogue schema cannot
  represent** (Medium) — `tweakedAvailability` returns `base + 1` unconditionally; the catalogue
  schema caps `availability` at 5, so the story's own stated grant mechanism (the ST creates a
  distinct catalogue entry at the requested cost) has no valid target for a tweak on an
  already-maximum-availability item. The request still displays and can be submitted (informational
  only, per AC #5 — doesn't block the draft), so nothing breaks mechanically; an ST reviewing such a
  request will need to adjudicate down or deny it by judgement, same as any other over-cap request.
  Not fixed in EQC-4 itself — enforcing or special-casing the boundary would mean either raising the
  catalogue's global availability cap (a much larger, unrelated change) or silently capping/hiding the
  display, both out of this story's scope. Revisit if this proves a real friction point in play.
- **AC #6 names `npm test`, but that script is a no-op stub in this repo** (Low) — `package.json`'s
  `test` script is `echo "Error: no test specified" && exit 1`; the actual regression command run for
  every EQC story (this one included) is `npx vitest run server/tests`. Looks like boilerplate carried
  across the whole EQC epic's story template rather than something specific to EQC-4 — worth fixing at
  the template level (or wiring `npm test` to the real vitest invocation) next time any EQC-epic story
  is created, rather than patched story-by-story.

## Deferred from: EQC-1 (issue #1152, Codex external review 2026-08-13)

- **`container_id` reference/topology validation** (Medium) — nothing in `characters.js`'s write routes
  (PUT /:id, POST /:id/equipment) validates a `container_id` against the same character's own
  equipment array: a dangling reference, a self-reference, a reference to a non-container catalogue
  item, or a multi-level containment chain are all accepted and stored as-is. Currently harmless
  because no code anywhere reads `container_id` yet (no containment-aware UI exists — that's EQC-3's
  job). Whoever builds the first reader MUST add real validation at that point, either at the write
  route or defensively at the read site. See `character.schema.js`'s own comment on the `equipment[]`
  field for the full disclosure.
- **`container_id` cannot identify a container INSTANCE when a character owns two equipment rows
  referencing the same catalogue item** (Medium) — e.g. two identical safes are indistinguishable by
  `catalogue_id` alone, since `equipment[]` rows carry no per-instance identity. A future
  container-assignment story will need to resolve this — likely by referencing the container's array
  INDEX rather than continuing to key off `catalogue_id`, or by introducing a per-row instance id.
  Real design decision, not a coding bug in EQC-1; deferred to whichever story first builds container
  assignment UI (EQC-3 or later).

## Deferred from: code review of oxp-3-manoeuvre-purchase-graduated-merit (2026-08-13, external Codex review)

Full record: `specs/stories/oxp-3-manoeuvre-purchase-graduated-merit.md` → Senior Developer Review.

- **The office merit-dots stepper has the same lost-update race oxp.3's manoeuvre stepper just had
  fixed** (Medium). `_adjustMeritDots` in `public/js/tabs/office-tab.js` fetches
  `GET /api/office_merit_dots`, computes `current + delta` in the client, and PUTs that absolute
  value to `server/routes/office-merit-dots.js`'s `PUT /:category`, which applies an unconditional
  `$set`. Two overlapping adjustments (two STs, or one ST double-clicking before the row
  re-renders) can both read the same starting dot count and both write the same next one, so one of
  the two requested steps is silently lost. `findOneAndUpdate` is atomic per write, but the values
  being written were already computed from a stale read, so that does not help. Pre-existing since
  PR #1147; untouched by oxp.3's diff, and found only because oxp.3 copied the pattern and then had
  to fix its own copy. The fix is the same shape as oxp.3's: a relative `PUT /:category/step` taking
  `{ merit, delta }` and doing the clamped read-modify-write in one MongoDB aggregation-pipeline
  update, with the client sending the step rather than an absolute value. Deliberately not folded
  into oxp.3, which is scoped to manoeuvre rank only.

## Deferred from: code review of oxp-2-derived-office-xp-calculation (2026-08-13, external Codex review)

Full record: `specs/stories/oxp-2-derived-office-xp-calculation.md` → Senior Developer Review.

- **`officeMonthsAccrued` fails closed to a plausible 0 on reversed argument order** (Low).
  `officeMonthsAccrued(now, createdAt)` called with the two positional arguments swapped returns a
  `Math.max(0, ...)`-clamped `0` — "this office doesn't exist yet" — rather than throwing, because a
  transposed call looks identical to a genuine before-creation `now`. Same-month transpositions are
  even less detectable (both directions can return `1`). No current caller misuses it — `public/js/
  data/office-xp.js` has no consumer yet in this codebase (oxp.6/oxp.7 will be the first) — so adding
  argument-order defence now, with nothing to actually call it wrong, is exactly the premature
  validation this project's conventions avoid. Revisit if/when a real caller is written: either name
  the parameters via an options object (`{ createdAt, now }`, immune to order by construction) or add
  a runtime assertion once there's a real call site to test it against.
- **`officeSeatXp` rebuilds the full per-category seat-count map on every call** (Low, efficiency
  only). `officeSpendKnownByCategory(allSeats)` is recomputed from scratch inside `officeSeatXp`, so a
  consumer that naively loops `allSeats.map(s => officeSeatXp(s, allSeats, ...))` to render all seats
  is O(n²) rather than O(n). Immaterial at the real live count (7 seats) and there is no consumer yet
  to optimise for. Note for whoever builds oxp.6/oxp.7's loader: call `officeSpendKnownByCategory`
  once up front and reuse the map, rather than letting each seat's render recompute it.
- **`officeXpSpentForCategory`'s raw-document fallback can misread a malformed/legacy document with a
  missing or null `dots` key as the dots map itself** (Low). The function accepts two shapes
  (`{ [meritName]: dots }` and `{ dots: {...} }`) and falls through to treating the whole argument as
  the dots map when `.dots` isn't itself an object. A document like `{ _id: 'Enforcer', updated_at:
  '...' }` (no `dots` key at all) would fall through the same way, and any numeric field on it would
  silently add to spend. Confirmed unreachable via any real write path today — `office-merit-dots.js`'s
  `PUT /:category` always writes via `$set: { 'dots.<merit>': n }`, which cannot produce a document
  missing `dots` — so this is a robustness gap in a defensive fallback branch, not a live bug.
  Deliberately not patched now: the real write path can't trigger it, and tightening shape detection
  without a real malformed document to test against risks its own subtle bug. Revisit if this
  collection is ever hand-edited outside the route (Mongo Compass, a migration script) in a way that
  could produce a `dots`-less document.

## Deferred from: cross-app data audit (2026-08-14, TM Wiki session — Dana, Data Steward)

**RESOLVED 2026-08-15.** All five items below were built out as Epic DBO's dbo-1/2/3/4 and merged to
`main` today (`specs/epic-dbo-database-ownership.md`). Left in place as the historical record of what
the audit originally found, not as open work. Each bullet now carries its own dated pointer to the
story that closed it, so a reader landing mid-section does not have to infer it from this banner.

Of the two Angelus-ruling items at the end of this section, **`story_threads` has since been ruled**
(see that paragraph, and DBO-6) and only the migration mechanics remain; **`feral` is still genuinely
open** and still nobody's to resolve alone.

Four-sweep audit comparing `tm_suite`/`tm_wiki` for duplication, forks and misplaced ownership. Full
map: `D:\Terra Mortis\data-map.md` (umbrella-level, not versioned — TM Wiki session currently holds
it; do not edit directly). Brief handed to this session: `D:\Terra Mortis\BRIEF-2026-08-14-tm-suite.md`.
These five are named in that brief as "real Suite-side defects... yours to fix, none urgent" — logged
here per the brief's own coordination protocol rather than acted on unilaterally. **Game is
2026-08-15; nothing from TM Suite deploys before it, per the brief's hard constraints.**

- **`purchasable_powers` schema rejects two fields that 666 of 673 live rows actually carry.**
  `server/schemas/purchasable_power.schema.js:70` is `additionalProperties: false` and declares
  neither `selected` (666 rows) nor `special` (527 rows) — only 7 of 673 documents pass their own
  schema. The schema's own comment at `:220-245` already records this and notes a purpose-built strip
  script exists but either was never run or something re-seeds the fields. **Open question that must
  be answered before anyone writes a new script**: never run, or does something put the fields back?
  Also blocks any reader from safely building on `special`.
  **RESOLVED 2026-08-15, see DBO-1** (`specs/stories/dbo-1-purchasable-powers-schema-vs-data.md`).
  The open question was answered before any script was written: neither field is re-seeded, both are
  stale legacy import residue. `selected` is a clean collection-wide strip; `special` had to be
  DECLARED rather than stripped, because DBO-3 made its two `'standing'` rows load-bearing in live
  code. One residual follow-up survives this closure and is logged separately below:
  `seed-rules-necropolis.js`'s `_baseDoc()` still defaults `selected: true`, so re-running that
  seeder would put the field back on nine rows.
- **`character_dossier.schema.js` does not exist.** `server/scripts/_dossier-audit.js:3` imports it
  and TM Wiki's `server/routes/characters.js:219-220` cites it as the authority for a field type. The
  file is not in this repo. A 30-document / 442-fact collection has no schema at all.
  **RESOLVED 2026-08-15, see DBO-2** (`specs/stories/dbo-2-character-dossier-schema-and-reveal.md`).
  The schema now exists, written from a fresh live inventory that reproduced all of the figures above
  exactly, and it exports `DOSSIER_TAGS` so `_dossier-audit.js:3`'s import resolves. TM Wiki's half of
  the same dead citation was already self-corrected by their story 31-1.
- **`character_dossier` reveal path was never wired.** All 442 facts are `st_hidden: true` and
  `revealed_to` appears on zero of them, so TM Wiki's shipped summary tier shows nothing to any
  non-owner. Nothing in this repo writes `revealed_to` for dossier facts. Needs an Angelus decision:
  full concealment intended, or the mechanism is simply unbuilt.
  **RESOLVED 2026-08-15, see DBO-2.** The Angelus decision this bullet asked for was taken on
  2026-08-14: all-hidden is correct as today's default, because he has not yet chosen what to reveal,
  not because it must stay concealed. The reveal writer is deliberately NOT built in this repo. TM
  Wiki's already-built `visibility_prefs` mechanism is the writer, dark behind
  `wiki_config.fact_level_enabled: false`, and the one thing it could not supply itself was a durable
  opaque per-fact key. DBO-2 shipped that mint (`fact_key`, `randomUUID()`) plus a dry-run-default
  backfill script. **Not yet fully closed on the operational side**: `--apply` against live
  `tm_suite` is Angelus's own action, after the 2026-08-15 game, and TM Wiki is owed a notification
  the moment it runs so they can decide when to flip their flag.
- **XP-spend merit picker filter bug — live, concrete, not a data/schema question.** The picker skips
  `sub_category === 'standing'`, but Mystery Cult Initiation and Professional Training carry
  `special: 'standing'` with `sub_category: null` — so the filter has never actually excluded the two
  merits its own comment names, and instead excludes `Confessor`/`Pledged`. Same class as a
  naming-mismatch bug the Wiki audit found independently on its own side. Unlike the other four items
  here, this is a straightforward code fix once someone picks it up — not blocked on an Angelus
  ruling or a data-shape investigation.
  **RESOLVED 2026-08-15, see DBO-3** (`specs/stories/dbo-3-xp-spend-standing-filter-bug.md`), which
  is merged and live. This bullet undersold it: the same broken check was duplicated at three sites
  across two files, and a fourth site (the sheet's own Add Merit picker) had no standing exclusion at
  all. Fixed with a single shared predicate, `isMeritEventGranted(rule)`, which reads
  `rule.special === 'standing'` and is the reason DBO-1 had to declare `special` rather than strip it.
- **`office_manoeuvre_ranks` does not exist in live Atlas** — not empty, absent. The route at
  `server/routes/office-manoeuvre-rank.js:7` refers to it; `office_actions` holds 0 documents live,
  `office_merit_dots` holds 2. Relevant to Epic OXP (in progress this session, oxp-1 through oxp-7
  done, not yet merged): confirmed against oxp-5's own design that its manoeuvre-reset write uses
  `upsert: false` deliberately, so a missing document is already a correct silent no-op rather than a
  bug — but any FUTURE OXP work that reads this collection will behave differently against dev
  fixtures than against production, and should treat "renders empty" as an explicit choice, not a
  surprise discovery at review time.
  **RESOLVED 2026-08-15, see DBO-4** (`specs/stories/dbo-4-office-collections-absent-empty-route.md`).
  Read-only investigation, no code defect found and none changed: the "no document = 0" convention on
  `office_manoeuvre_ranks` / `office_merit_dots` is deliberate and confirmed by reading every writer,
  and `office_actions` is empty simply because no office action has ever been approved. This bullet's
  own "oxp-1 through oxp-7 done, not yet merged" aside was stale on both halves and has since been
  corrected twice on the `epic-oxp` row in `sprint-status.yaml`. Read that row, not this line. The
  one real live hazard the story did surface is operational, not code, and stays open: the two
  pre-migration category-keyed `office_merit_dots` documents are invisible to the seat-keyed code
  until `migrate-office-purchases-to-seats.mjs --apply` is run, which is Angelus's action.

**Two items were logged here as explicitly awaiting Angelus's ruling, not Suite's to resolve alone**
(recorded for visibility only — the actual decision goes through the data map's Open Items, per the
brief). **UPDATED 2026-08-15: one has been ruled, one has not.**

- **`tm_suite.story_threads` (44 real populated threads) vs. `tm_wiki.story_threads`** (empty,
  structurally incompatible, created by a 2026-07-25 ruling that never knew canon's existed).
  **RULED 2026-08-14. The ruling is made and only the migration mechanics remain.** Recorded in
  `specs/epic-dbo-database-ownership.md` under DBO-6: the 44 threads have no route, no mount and no
  client code in this repo, only ST scripts, and no mechanical function at the table, so the empty
  `tm_wiki.story_threads` twin is the correct destination and the threads travel. Location data was
  ruled the same day and the same way under DBO-5, in Angelus's own words: *"All location data moves
  to wiki. Location has no relevance at game."* That one covers `st_map_locations` (130 docs) and
  `locations` (42 docs, 26 polygons); `territories` identity and governance stay here, because *"a
  polygon is presentation; a regent is a rule."* What is left on both is execution, tracked as
  DBO-5 and DBO-6 in `sprint-status.yaml` and joint with the Wiki's own 31-2 and 31-3, under the
  standing order: copy, verify, cut over, then drop, never delete the source first. Carry `status:
  'seeded'` forward when the threads move (2 documents hold it; no authoring script declares it) and
  flag it rather than silently dropping it.
- **TM Wiki's `feral` feeding method**, which is not a member of this repo's `feedMethodEnum`
  (`server/schemas/downtime_submission.schema.js:58-60`) and appears nowhere in `tm_suite` — either
  the Wiki drops it or this repo's enum gains it. **STILL OPEN as of 2026-08-15**, still awaiting
  Angelus, and still explicitly out of scope for Epic DBO (see that epic's "Not this epic" section).
  Opposite fixes in opposite repos, so neither side moves alone.

## Deferred from: code review of oxp-11-office-purchase-seat-keying (2026-08-13, external Codex review)

Full record: `specs/stories/oxp-11-office-purchase-seat-keying.md` → Senior Developer Review.

- **No runtime dual-schema read compatibility between the old category-keyed and new seat-keyed
  purchase collections during the deploy/migration window** (High, accepted rather than built
  around). Once `oxp-11`'s server code deploys, `GET`/`PUT /api/office_merit_dots` and
  `/api/office_manoeuvre_rank` read and write ONLY seat-keyed documents — the old `:category` routes
  are gone entirely. If the migration script has not yet run, the two existing real documents
  (Enforcer, Head of State) appear unpurchased, and an ST editing either during that gap creates a
  fresh seat-keyed document that the later migration run will then see as already-migrated and leave
  alone, permanently stranding whatever the pre-migration value actually was. Addressed for now with
  an explicit, prominent operational warning in `server/scripts/migrate-office-purchases-to-seats.mjs`'s
  own header (run the migration with `--apply` immediately after deploying, before any ST touches the
  affected tab sections) rather than code, because both live documents this migration would move
  currently hold nothing but `{ "Safe Place": 0 }` — the entire real stakes of getting the order wrong
  right now is re-typing two zeroes by hand. Revisit properly (read-both-schemas compatibility, or a
  server-side migration trigger on deploy) if either collection ever holds genuine purchase data
  before a future migration of this same shape (category-to-something-else re-keying).

## Deferred from: code review of dbo-1-purchasable-powers-schema-vs-data (2026-08-14, external Codex review)

Full record: `specs/stories/dbo-1-purchasable-powers-schema-vs-data.md` → Senior Developer Review;
`specs/epic-dbo-database-ownership.md`, DBO-1, 2026-08-14 correction.

- **`server/scripts/seed-rules-necropolis.js` re-seeds the exact dead field DBO-1 removes** (Medium,
  found by Pass 2 Edge Case Hunter, confirmed against live source). Its `_baseDoc()` defaults every
  merit it upserts to `selected: true` and `special: null`. It is active (issue #692, N-3/MNEC epic),
  not archived, and designed to be safely re-run — so a future `--apply` of it (for any reason: a
  tenth merit, a typo fix) puts `selected` straight back on its nine rows, undoing DBO-1's cleanup for
  exactly those documents and reproducing the schema-violation defect DBO-1 exists to fix. Out of
  DBO-1's own scope (a different epic's seeder). Fix: strip `selected: true` from `_baseDoc()`'s
  defaults (keep `special: null` — schema-valid, harmless). Low effort, one line, whenever N-3/MNEC is
  next touched or as a standalone follow-up.
- **A second, previously-undocumented pre-existing test failure**, same class as CLAUDE.md's own
  #1115: `server/tests/oath-a-pledge-helpers.test.js`'s "meritRating and meritEffectiveRating are
  byte-identical to their pre-OATH-A form" assertion fails on this Windows checkout — it expects LF
  text but reads CRLF file content. Confirmed unrelated to DBO-1 (neither `xp.js` nor `domain.js` is
  in this story's diff) and confirmed present without any DBO-1 change. Worth a CLAUDE.md entry
  alongside #1115 so the next story's targeted-gate count isn't thrown off by an unexplained extra
  failure; not fixed here (out of scope, likely a `.gitattributes`/line-ending config issue affecting
  more than this one file).

## Deferred from: dbo-4-office-collections-absent-empty-route (2026-08-14, external Codex review closed)

Full record: `specs/stories/dbo-4-office-collections-absent-empty-route.md` → Senior Developer
Review; `specs/epic-dbo-database-ownership.md`, DBO-4, 2026-08-14 resolution.

- **`server/scripts/migrate-office-purchases-to-seats.mjs` has not been run against live `tm_suite`
  — but the compounding-loss hazard this entry originally flagged as urgent has since been FIXED
  (2026-08-14, dbo-4's own external Codex review)**, so this is no longer time-sensitive. What
  remains is a plain deferred action: `office_merit_dots` holds 2 real, pre-oxp-11 documents still
  keyed by office category (`"Enforcer"`, `"Head of State"`) rather than by seat — confirmed via a
  read-only live query and the migration's own pure `planMigration()` function. Both currently hold
  only `{"Safe Place": 0}`. The script's own header used to warn of a compounding case: an ST setting
  a merit dot on either seat through the live seat-keyed UI before the migration ran would create a
  fresh seat-keyed document, and the migration would then unconditionally DELETE the old
  category-keyed one on its next run — not merely leave it orphaned, actively destroy whatever field
  it alone held. **Fixed**: `applyMigration`'s "recovered" branch now content-compares the two
  documents (key-order-independent canonical comparison) and only auto-clears the old one when they
  are genuinely identical; a real mismatch is now REFUSED and reported for a human to reconcile,
  matching the script's own established refuse-rather-than-guess pattern everywhere else in the file.
  Proven with 2 new regression tests (one for the refuse path, one confirming key-order alone doesn't
  cause a false refuse) plus an existing test corrected (its own fixture had unknowingly been
  exercising the unsafe path). Remaining action, whenever Angelus chooses: run
  `node scripts/migrate-office-purchases-to-seats.mjs --apply` from `server/` against live
  `tm_suite` — still a human's own action per this project's standing "one-off migration scripts are
  run by a human, not an agent" convention (same shape as DBO-1's own cleanup script), but no longer
  gated by a closing window. `office_manoeuvre_ranks` has nothing to migrate (confirmed empty on both
  sides of the key scheme) — this only concerns `office_merit_dots`.

## Deferred from: dbo-9-suite-duplicated-constants (2026-08-14, dev-story, two more pre-existing test failures found)

Full record: `specs/stories/dbo-9-suite-duplicated-constants.md` → Dev Agent Record.

- **Two more previously-undocumented, pre-existing test failures**, same family as CLAUDE.md's own
  #1115 and the oath-a-pledge-helpers CRLF failure DBO-1's review found. Confirmed unrelated to this
  story (neither touches `constants.js`, `sheet.js`, or `downtime-form.js`) by stashing this story's 3
  changed files and re-running both against the unmodified base — identical failures either way.
  - `tests/issue-836-legacy-tracker-cache-removed.test.js` fails to load at all: `ENOENT` opening
    `public/js/suite/tracker.js`, which does not exist on this checkout (per `CLAUDE.md`, the
    name-keyed persistence surface this file's own tests were written against was removed in #836 —
    the test itself appears to have gone stale along with the removal it was meant to verify).
  - `tests/n8-mandragora-prereq.test.js` fails to load at all: `SyntaxError: Invalid or unexpected
    token`, cause not investigated (out of this story's scope).
  Worth a `CLAUDE.md` "Known pre-existing failures" entry for both, so a future story's targeted-gate
  count isn't thrown off by unexplained extra failures. Not fixed here.
  **RESOLVED 2026-08-15**: `n8-mandragora-prereq.test.js`'s failure was the shebang-parse bug fixed
  below (dbo-2's own deferred entry) — passes now. `issue-836-legacy-tracker-cache-removed.test.js`'s
  ENOENT is a separate, still-open issue: this entry's own read was correct, the test is stale against
  a file renamed elsewhere (`tracker.js` → `toast.js`), left alone deliberately rather than guessed at.

## Deferred from: dbo-2-character-dossier-schema-and-reveal (2026-08-14, dev-story)

Full record: `specs/stories/dbo-2-character-dossier-schema-and-reveal.md` -> Dev Agent Record;
`specs/epic-dbo-database-ownership.md`, DBO-2.

- **`server/scripts/_havens-and-locations.js:46` `$push`es a new `character_dossier` fact with no
  `fact_key`.** Same class of finding DBO-1's own external review made against
  `seed-rules-necropolis.js`, and the same conclusion: not unsafe to ship, but the end state is not
  durable against a real workflow. The script is one-off and already run, and DBO-2 deliberately does
  not touch it (its "What this story is NOT" names all seven historical `_*.js` dossier writers as
  out of scope) - but re-running it after the backfill would create a keyless fact, silently
  reintroducing exactly the positional-addressing hazard `fact_key` exists to close, and TM Wiki's
  `visibility_prefs` has no way to address a fact without one. Fix: mint a `fact_key` with
  `randomUUID()` from `node:crypto` in that `$push`, or re-run
  `server/scripts/dbo-2-dossier-fact-key-backfill.mjs --apply` after any future run of it. Low
  effort, a few lines. **Any future writer of a dossier fact, in this repo or elsewhere, must mint a
  `fact_key`** - that is what the new schema's `required` exists to say, and it has no runtime
  enforcement behind it (no route validates this collection, no DB-level `$jsonSchema` validator).
- **Seven pre-existing test-suite LOAD failures in the `server/schemas/` + `server/scripts/` gate**,
  none caused by this story - confirmed by stashing DBO-2's three new files and re-running the same
  seven files against the unmodified base, which produced identical failures. Two are already
  documented (`n8-mandragora-prereq.test.js`, logged by DBO-9 above; `oxp-1-office-seats.test.js`,
  the shebang-in-`seed-office-seats.mjs` failure oxp-11's own record names). The other five are the
  same `SyntaxError: Invalid or unexpected token` family and appear to be undocumented:
  `issue-1013-indomitable-rules-text.test.js`, `issue-1021-failed-breakpoint-merit.test.js`,
  `issue-811-sumchannels-rootcause.test.js`, `issue-826-cleanup-script-integration.test.js`,
  `issue-837-xp-totals-deprecation.test.js`. Cause not investigated (out of DBO-2's scope) but the
  shared symptom across seven unrelated files suggests one environmental root cause rather than seven
  independent bugs - plausibly the same line-ending/encoding family as the CRLF failure DBO-1's
  review found. Worth a single `CLAUDE.md` "Known pre-existing failures" entry covering the set.
  **RESOLVED 2026-08-15**: the guess at "one environmental root cause" was right, but not CRLF/encoding
  - it was a shebang line (`#!/usr/bin/env node`) in 9 `server/scripts/*.js` files, which Node's own
  loader and Vite's dev-transform both special-case but Vitest's SSR module runner does not. Fixed by
  stripping the shebangs (harmless - this project always invokes them via `node scripts/foo.js`, never
  direct execution). All 5 files named here now pass, plus `n8-mandragora-prereq.test.js` and
  `oxp-1-office-seats.test.js` (the shebang-in-`seed-office-seats.mjs` failure oxp-11's own record
  names) - 7 of the original 7, one shared cause. A separate genuine bug the fix uncovered
  (`issue-811-sumchannels-rootcause.test.js` building a Windows-unsafe path via
  `new URL(import.meta.url).pathname` instead of `fileURLToPath()`) was also fixed alongside it.
  `CLAUDE.md`'s "Known pre-existing failures" section still needs updating to drop the now-fixed
  entries and add the 3 still-open ones (`epic.708.3`, `oath-a-pledge-helpers`, and this file's own
  `issue-836` + `issue-1013`'s missing `markdown/` corpus, #1117) - not yet done.

## Deferred from: cm-2-chapters-to-story-cycles-rename (2026-08-16, dev-story)

- **`downtimeCycleSchema` lives in a file named for submissions.** It is declared at
  `server/schemas/downtime_submission.schema.js#L572`, alongside `downtimeSubmissionSchema`, so the
  cycle schema has no file of its own and nothing named `downtime_cycle.schema.js` exists. Noticed
  while cm-2 renamed that schema's `chapter_id` field to `story_cycle_id` and deliberately left
  alone: moving it churns every importer of that module for zero behavioural gain, and cm-2b
  (`downtime_cycles` -> `chapters`) is going to rewrite that schema's identity anyway. **cm-2b is
  the natural place to fix it** - split it out then, in the same change that renames the collection
  it describes, rather than paying the importer churn twice.
- **`tests/cycle-phase-controls.spec.js` (all 11 of its 11 tests) and one assertion each in
  `tests/cycle-tab.spec.js` and `tests/cycle-prep-access.spec.js` are pre-existing reds**, confirmed
  by reproducing them against unmodified `HEAD` (base `cycle-views.js` + base spec, run in the main
  checkout) and getting identical failures. They are the same source-drift family CLAUDE.md already
  documents for `epic.708.3`: CM-1 (#1028) turned the phase cell's three fixed buttons into four
  toggleable ones and removed the "legacy" phase text, and the `is-active`/disabled semantics moved
  with it, but these specs were never updated. cm-2 renamed their route mocks and fixtures without
  touching those assertions. Worth adding to CLAUDE.md's "Known pre-existing failures" list, and
  worth a small story to re-baseline the three specs against the CM-1 phase UI.

## Deferred from: code review of cm-2-chapters-to-story-cycles-rename (2026-08-16, internal 3-layer review)

Provenance: LOCAL/internal 3-layer adversarial review (Blind Hunter, diff-only; Edge Case Hunter,
diff + full repo + sibling-repo sweep; Acceptance Auditor, story spec + two-pass verification, which
ran the migration script against `tm_suite_test` six times and independently re-queried live
`tm_suite` read-only to confirm nothing there was touched). Codex/external review was unavailable
until 2026-08-20. Thirteen findings were patched in the same pass; the four below were judged real
but out of proportion to fix here, and are recorded rather than lost.

- **[Medium] A Story deleted during the burn-in period is silently resurrected by a later `--apply`
  run.** `server/scripts/cm-2-chapters-to-story-cycles.mjs:planRename` treats "no target document
  under this source `_id`" as "never copied" and plans a copy
  (`server/scripts/cm-2-chapters-to-story-cycles.mjs`, the `if (!existing)` branch of the source
  loop). **Trigger:** during the burn-in an ST legitimately deletes an unlinked Story via the Cycle
  tab, which removes it from `story_cycles` while the source `chapters` document sits untouched
  (nothing deletes from the source until `--drop-source`); a subsequent `--apply` re-inserts it,
  resurrecting something the ST deliberately deleted, with no message distinguishing "never copied"
  from "copied, then deleted on purpose". Note the drop gate does NOT rescue this: after P2 it checks
  ID existence, so a source `_id` with no target is exactly the shape it refuses on - meaning the
  practical outcome is either a resurrection (if `--apply` runs first) or a blocked drop (if it does
  not), and the ST has to reconcile by hand either way. **Deferred because** a correct fix needs a
  tombstone or deletion-audit mechanism this migration has no notion of, which is disproportionate
  for a narrow, low-likelihood window (it requires a Story delete AND a re-run of `--apply`
  specifically during burn-in) in a script that is explicitly temporary infrastructure for one
  collection rename. If it does happen it is visible and hand-fixable: delete the resurrected row
  again in the Cycle tab.

- **[Low] `keptLabels` reporting under-counts.**
  `server/scripts/cm-2-chapters-to-story-cycles.mjs:planRename` only pushes to `keptLabels` when the
  label matches `/chapter/i`, so the dry-run's "labels a human should look at" list silently omits a
  Story whose label is unrelated ST-authored prose ("The Long Night") - left alone correctly, but
  never listed as "left alone, not chapter-shaped". **Trigger:** a dry run against a collection
  containing a non-chapter-shaped label. Cosmetic. **Deferred because** all three real live documents
  are the plain `Chapter N` form, so this has zero effect on the actual migration run, and the
  reporting shape is about to be thrown away with the script.

- **[Medium, cross-reference, not a new entry] The delete-error false-positive patched as P4 is a
  symptom of the already-logged status-code gap.** See the existing entry in *"Deferred from: code
  review of npcr.3.flags-collection-admin-queue (2026-04-24)"* above: *"`apiPost` / `apiPut` do not
  expose HTTP status codes to callers"*. **cm-2 is a second, concrete instance, and it extends the
  entry to `apiDelete`.** `public/js/data/api.js`'s shared `request()` throws
  `new Error(data.message || data.error || 'Request failed')` and discards `res.status`, so every
  caller of `apiGet`/`apiPut`/`apiPost`/`apiPatch`/`apiDelete` is reduced to string-matching prose.
  `public/js/admin/cycle-views.js`'s story-delete handler did exactly that, and the cm-2 rename
  turned a previously-safe substring match (`'cycle'`) into one that also matches the 404 and 400
  messages, so an ST deleting an already-deleted Story was told it was still in use. That specific
  case is patched (match narrowed to `'linked to'`), but the patch is still a string match on
  server prose and will break again the next time a message is reworded. **The real fix remains the
  logged one:** surface `res.status` (and ideally the `error` code) on the thrown error so callers
  can branch on `409` / `STORY_CYCLE_IN_USE` rather than on English. **Deferred because** it is an
  app-wide change to the shared API client touching every caller in the codebase, which is a story
  of its own, not a line in a collection rename.

- **[Low] `verifyRename`'s drop-time check compared the database to itself.**
  `server/scripts/cm-2-chapters-to-story-cycles.mjs:verifyRename`'s third check compares
  `plan.expectedCounts` against the current `downtime_cycles` grouping - but at drop time both sides
  were freshly derived from the same current state, so it could only ever fail on a read-read race,
  never on a real data-loss scenario. **Trigger:** none reachable; it is a check that cannot fail for
  the reason it appears to exist. As of P2 this is no longer load-bearing at all: `dropSource` no
  longer calls `verifyRename`, and the actual drop-time safety is the explicit ID-existence check
  plus the still-carries-`chapter_id` check. `verifyRename` is still genuinely useful where it is
  also called - immediately after `applyRename`'s writes, where the "expected" side was computed
  *before* those writes and the comparison is real. **Deferred because** P2 closes the practical gap
  this pointed at, and rearchitecting `verifyRename` to compare against a real pre-migration snapshot
  is more invasive than a review pass should attempt on a script due for deletion after cm-2b.

- **[Low, pre-existing, folded in here so it is not lost] Deleting a Story does not update the
  cached `view.storyCycles` array.** `public/js/admin/cycle-views.js` - the delete handler calls
  `renderRows(list.filter(...))` but never writes back to `view.storyCycles` (the create path does,
  at the `view.storyCycles = storyCycles` line), so `renderRibbon()`'s lookup can still resolve a
  deleted Story until the next full refresh. Confirmed **pre-existing** in the code cm-2 inherited
  (the same shape existed pre-rename), not introduced by this story, and cleared by any tab reload.

---

## Deferred from: code review of cm-4a-phase-transition-server-enforcement (2026-08-16, internal 3-layer review)

Internal 3-layer adversarial review (Blind Hunter diff-only, Edge Case Hunter diff + full repo,
Acceptance Auditor spec + two-pass verification against the Dev Agent Record). LOCAL/internal, not
Codex — the external reviewer was unavailable until 2026-08-20. Nine findings were patched in the
same pass; the six below were not. Full record: `specs/stories/cm-4a-phase-transition-server-enforcement.md`
→ Senior Developer Review.

- **D1 — A bare legacy `status:'game'` now suppresses a wipe that used to fire** (Medium) —
  `public/js/downtime/cycle-phase.js:48-56` (`statusToPhase`), reached from `transitionFromPhase`
  (`cycle-phase.js:96-101`). `statusToPhase` maps raw `status:'game'` straight to phase `'game'`, so
  `resetOnTransition('game','prep')` is `false` and entering prep no longer wipes. Pre-CM-4a the
  client read that shape as `null`, and `resetOnTransition(null,'prep')` is `true` — it wiped, and
  correctly. Trigger: any cycle carrying a bare `status:'game'` with no explicit `phase`/`game_phase`
  being moved to prep. The catch is this codebase's own documented ambiguity (`cycle-phase.js:14-21`,
  "THE THREE MEANINGS OF prep"): a bare `status:'game'` can equally mean the mid-ladder derived state
  "prep signed off, city not" (`deriveCycleStatus`/`signoffPhase`, `public/js/downtime/db.js:87-119`),
  which is nothing like being in game phase. The real historical example is cited in
  `server/scripts/archive/close-dt3-cycle.js` — a cycle documented as "stuck in 'game' status — only
  prep phase signed off". Not fixed here: disambiguating the three meanings of a bare `status` is a
  phase-model design decision, not a patch, and it belongs with the rename-and-cleanup work already
  planned in `D:\Terra Mortis\cycle-model.md` §11a (CM-2/CM-2b/CM-4). The one concrete example on
  record is an already-closed archived cycle, not a live-game hazard.
- **D2 — The client's reset dialog can be inaccurate, because `cy` is never re-fetched** (Low) —
  `public/js/admin/cycle-views.js`, `writePhase`'s `resetOnTransition(uiPhase(cy), phaseOrNull)`
  consult. `cy` is the cached row object and the Cycle tab holds no WebSocket subscription, so a
  concurrent writer between page load and click makes the dialog stale in either direction (warned
  when no wipe follows, or silent when one does). Trigger: two STs on the Cycle tab at once, or one
  tab left open across a phase change. Not fixed: the data-safety property this story exists to
  deliver is already correct without it — since CM-4a the server enforces the wipe rule regardless of
  what the client showed or whether it showed anything. A proper fix is a re-fetch before the dialog,
  or a response field reporting whether a wipe actually happened, surfaced to the ST after the fact.
  UX accuracy, not a defect. The comment at the head of `writePhase` was corrected in this review
  (P7) to stop claiming the two tiers "cannot disagree".
- **D3 — A player tracker write can survive the wipe** (Low) — `server/routes/tracker.js`'s
  `PUT /api/tracker_state/:character_id` is non-transactional and player-reachable. A player writing
  their own tracker inside the commit window of a phase-transition wipe can leave one character with
  a fresh post-wipe document the `deleteMany` snapshot never covered. Trigger: a phase flip during
  live play while a player is touching their own vitae/willpower. **Confirmed PRE-EXISTING** — the
  old client-side `DELETE /api/tracker_state` had the identical race, and CM-4a narrows the window
  rather than widening it. Belongs with the 5b tracker-hardening pass alongside CM-5a review finding
  K (no WebSocket broadcast on bulk delete).
- **D4 — Dead `handleOpenGamePhase` would wipe with no tracker-specific warning if revived** (Low) —
  `public/js/admin/downtime-views.js:2721-2736`. Confirmed unwired (its only reference is its own
  definition; pinned by `server/tests/cm5-reset-transition.test.js`'s "stays dead, or gains the rule
  if revived" test). If it is ever reattached it inherits the server guarantee for free — which is
  the point of moving enforcement down a tier — but its confirm dialogs mention only the
  zero-submission flip and feeding rolls unlocking, never the tracker. Flag for whoever next touches
  that function; the existing test will fail loudly if it gains a listener without a
  `resetOnTransition` consult, but it says nothing about the dialog wording.
- **D5 — Fallback-path 404 can follow a completed wipe** (Low) — `server/routes/downtime.js`,
  `runPhaseTransition` with `session === null`. In the transactions-unsupported fallback the wipe
  runs before the phase write (deliberately: that is the pre-CM-4a ordering, whose failure mode this
  codebase has already lived with). If the cycle is deleted between the initial `findOne` and the
  later `findOneAndUpdate`, the tracker is already wiped but the caller gets a 404. Dev-environment
  only — the fallback never runs on Atlas or production, both of which are replica sets — and the
  window is microseconds. Not worth blocking on.
- **D6 — `startSession()`/`endSession()` edge failures are unguarded** (Low) —
  `server/routes/downtime.js`, the cycles PUT. If `startSession()` itself throws (driver or
  topology-level failure) the error never reaches the `isTransactionsUnsupported` fallback, because
  the `try` starts after it, so the route 500s rather than degrading. An `endSession()` throw inside
  the `finally` would mask the real error. Narrow driver-level edge cases with no reproduction path;
  this project's stated convention is not to add error handling for scenarios that cannot happen in
  practice, and a 500 on a broken driver topology is honest.

## Deferred from: cm-7-fact-map-harness-and-rollback-drill (2026-08-16, create-story coverage-set research)

- **`public/js/data/game-xp.js:55` reads a field that has never existed on any live document** (Low,
  found not caused). `title: s.title || \`Game ${s.session_number || '?'}\`` reads
  `game_sessions.session_number` — `server/schemas/game_session.schema.js` declares no such field
  (only `game_number`, line 22), and a repo-wide grep found no writer anywhere that has ever set it.
  The XP breakdown panel's per-game title is therefore `Game ?` on every real session today, unless
  that session happens to carry an explicit `.title` — independent of Epic CM, and independent of any
  future renumber (a field that already never matches cannot diverge further). Not fixed by cm-7,
  which is scoped to the fact-map harness and rollback drill, not to unrelated display bugs found
  along the way. One-line fix whenever anyone is next in this file: `s.session_number` →
  `s.game_number`.

## Deferred from: code review of cm-7-fact-map-harness-and-rollback-drill (2026-08-16, internal 3-layer review)

Internal review (Blind Hunter diff-only, Edge Case Hunter diff + full repo, Acceptance Auditor
diff + spec). Seventeen findings were patched in the same pass; the two below were judged real but
out of proportion to fix here.

- **`specs/stories/sprint-status.yaml`'s `last_updated` value is not valid YAML** (Low) — the field
  is several adjacent double-quoted strings concatenated directly (`"…" "…" "…"`) with no flow-sequence
  syntax; a strict YAML parser throws on it (independently verified with PyYAML). Pre-existing across
  dozens of prior entries in this file's own history — cm-7's own header-rotation edit extended the
  pattern by prepending one more segment, same as every prior session has done, but did not introduce
  it. Fixing it means restructuring the file's own long-established (if informal) convention, which
  `tracking_system: file-system` at the top of the file already signals is not meant to be strictly
  YAML-parsed — out of proportion for a code-review pass on an unrelated story. Worth its own cleanup
  story if this file is ever consumed by real YAML tooling (the `bmad-sprint-status` skill or CI).
- **cm-7's AC8 backup-drill test only proves field-mutation restore, not insert/delete drift**
  (Low) — `server/tests/cm-7-fact-map-harness.test.js`, the "a snapshot taken before the drill
  migration restores the fixture exactly" test. It snapshots a document, mutates its `game_number`,
  and restores via `replaceOne`; it never exercises "a document was inserted after the snapshot and
  must be removed on restore" or "a document was deleted after the snapshot and must reappear on
  restore" — both standard failure modes for any real backup/restore claim. A fuller restore-scenario
  matrix (insert + delete, not just mutate) would strengthen AC8's own evidence but is disproportionate
  scope to add during a review pass; worth a follow-up if this drill mechanism is ever reused for a
  real (non-drill) backup verification.
- **Two real human-visible facts named in cm-7's original `COVERAGE_SET` item 6 are not actually
  tracked by `buildFactMap`** (Low, found not caused — narrowed rather than silently left overclaimed).
  `public/js/game/signin-tab.js:83-88` (which cycle is selected as "most recently closed", driving
  the default Sign-in tab view) and `:155-166` (`handleNewSession`'s `maxNum + 1` suggested next
  game number, shown in a confirm dialog) are both real derived facts that a `game_number` renumber
  could change, distinct from the base `game_number`/label fields the rest of the coverage set
  already tracks. Not added to `cm-7-fact-map.mjs` during its own code review (scope discipline —
  expanding a harness mid-review without a design pass risks the exact "recalled, not enumerated"
  failure mode #1031 exists to prevent), but the coverage-set citation was narrowed to stop
  overclaiming it. Whoever next touches the harness (likely alongside CM-4/CM-6, when
  `game_sessions` gets a real FK) should add `mostRecentlyClosedCycleId` and
  `suggestedNextGameNumber` fields to `buildFactMap`'s return value.

## Deferred from: code review of cm-3-derived-maintenance (2026-08-17)

Internal 3-layer review (Blind Hunter, Edge Case Hunter, Acceptance Auditor). Three findings
deferred as pre-existing, not caused by this diff:

- **`renderDowntimeTab`'s `_allCycles = []` reset has no render-generation guard** —
  `public/js/tabs/downtime-form.js:1423`. Rapid re-renders (a double-click, a fast character switch)
  can clobber in-flight cycle/story data mid-render and silently drop the PT/MCI at-risk warning on a
  real finale chapter. This project has an established fix for exactly this class (`_fetchGen`, the
  oxp-3 precedent) that this function doesn't use — but the underlying re-entrancy hazard on this
  render function predates cm-3 (it already reset other module state the same unguarded way).
  *(Amended 2026-08-17, cm-3 Task 10: `_allCycles` itself no longer exists — the redesigned
  pointer-based derivation needs no sibling-cycle list — so read this item against `_storyCycles`,
  `currentCycle` and `responseDoc`, which `renderDowntimeTab` still resets the same unguarded way.
  The hazard class and the recommended `_fetchGen` fix are unchanged.)*
- **A Story closing mid-downtime never reaches a player who already has the DT form open** —
  `public/js/tabs/downtime-form.js`, no WS push or invalidation path for `story_cycles`. Same
  limitation the old `is_chapter_finale` checkbox already had (the form's `currentCycle` was equally
  static once loaded) — not a regression cm-3 introduces, just not fixed by it either.
- **`server/routes/story-cycles.js`'s DELETE guard counts `story_cycle_id` as a string only**
  (`:104`, `countDocuments({ story_cycle_id: idStr })`) — an ObjectId-typed FK (from a hand-edit or a
  future importer) would bypass the "linked cycles" refusal and let a Story with real dependents be
  deleted. Pre-existing code, untouched by cm-3's diff (which only extended the PATCH handler).

## Deferred from: code review of xpl-2-historic-reconciliation (2026-08-18)

- **`applyReconciliation`'s idempotency guard is a non-atomic check-then-insert** —
  `server/scripts/xpl-2-historic-xp-reconciliation.mjs`, `findOne` followed by `insertOne` with no
  unique index on `xp_ledger` and no transaction. Two overlapping `--apply` invocations could both
  pass the "not found" check for the same row and insert duplicates. Deferred as pre-existing
  convention, not a regression this script introduces: every other one-off migration script in this
  repo (`migrate-office-purchases-to-seats.mjs` is the closest precedent) has the identical class of
  non-atomic guard, mitigated only by "a human runs this once, by hand," not by code. Revisit if this
  project ever moves to a pattern where migration scripts can run concurrently or unattended.

## Deferred from: code review of crd-1-data-lock-schema-hardening-wp-spike (2026-08-22, external Codex review)

External Codex review (3-pass blinded adversarial protocol) of the Epic CRD data-lock story. Full
findings: `specs/stories/code-review/crd-1-codex-findings.md`; triage and patch record: the story's
own Senior Developer Review section. Both **High** findings were reproduced live and **patched** in
that round (the `/accept` zero-die defence, and `POST /` persisting attacker-supplied
defender-resolution fields). The three below were **not** patched and each wants its own story.

- **Both new boot-time `createIndex()` promises are discarded** (Medium) — `server/index.js`, the
  `crd1_defender_queue` and `crd1_terminal_status_ttl` calls. Neither is awaited and neither has a
  `.catch()`, so the surrounding startup `try/catch` cannot see a rejection: the server can report
  ready without the index, or die on an unhandled rejection depending on the Node policy. crd.1's own
  Dev Agent Record justified this as safe because a non-unique index "cannot reject at build time" —
  that is wrong, and the reasoning conflates one failure mode (duplicate-key on a unique build) with
  all of them; option conflicts against an existing same-named index, an unsupported
  option/partial-filter combination, insufficient permissions, and a dropped connection all reject.
  Not fixed inside crd.1's patch round because this is a shared boot-path convention — the
  pre-existing oaq.2 index on the same collection is written the same way, so the fix wants to be one
  consistent pass over all of them rather than a one-off on the two newest.
- **`_findChallenge` and `PUT /:id/void` still scope by `$ne`, while `GET /mine` was upgraded to a
  positive filter** (Medium) — `server/routes/contested-rolls.js`. crd.1's own stated decision was to
  stop identifying contested rolls by the ABSENCE of a discriminator, and `GET /mine` duly became
  `request_type: { $in: [null, 'contested_roll'] }`. The two mutation guards kept
  `{ request_type: { $ne: 'status_action' } }`, which is **default-allow**: any future fourth request
  family sharing this collection is treated as a contested roll, so contested-roll lifecycle routes
  could resolve, decline or void another feature's record. No current exploit — `status_action` is
  still the only other explicit type that writes production records — but it is the exact
  implicit-discriminator fragility that produced the oaq.3 void-orphaning bug, left half-fixed.
  Task 3's own wording explicitly permitted keeping `$ne`, so this is a spec-vs-spec inconsistency
  inside crd.1 rather than a deviation from it.
- **The parent epic's server-derived `game_session_id` was never added to the creation shape**
  (Medium) — `specs/epic-crd-contested-roll-defence.md` (~line 100) puts a server-derived
  `game_session_id` in crd.1's creation shape and explicitly forbids a client-supplied one;
  `contested-rolls.js`'s `POST /` adds no such field, no AC in crd.1 ever mentioned it, and the
  schema does not declare it. **NEEDS ANGELUS'S OWN SCOPE DECISION, deliberately not resolved:** does
  this belong retroactively in crd.1, or in crd.2/crd.3a where the queue and the resolve endpoint
  actually need session provenance? Either way, every document crd.1 creates will lack it, so
  whichever story takes it on must decide separately whether pre-existing pending documents matter.
  Related precedent worth reading first: the otc-2 entry above, where `game_session_id` on
  `office_actions` is already logged as a caller-supplied, unvalidated, spoofable string — this epic
  should not reproduce that shape.

## Deferred from: code review of crd-2-player-facing-pending-queue (2026-08-22, external Codex review)

External Codex review (3-pass blinded adversarial protocol) of the Epic CRD player-facing pending
queue. Full findings, unedited: `specs/stories/code-review/crd-2-codex-findings.md`; triage and patch
record: the story's own Senior Developer Review section. **No High findings.** Three code findings
were patched in that round (the shared More badge never recomputing after the queue's own poll, a
failed poll holding a stale "Resolved" row indefinitely, and phone-width row clipping); the four
below were verified as real and deliberately NOT patched.

- **`renderDesktopSidebar()` never evaluates `app.badge` for ANY `MORE_APPS` entry** (Medium) —
  `public/js/app.js`. Mobile's `renderMoreGrid()`/`appIcon()` truth-tests each app's `badge` callback
  and emits a `.nav-badge` dot; the desktop sidebar iterates the same `MORE_APPS` array and never
  touches `.badge` at all, while desktop CSS hides the bottom nav that carries `#more-badge`. A
  desktop player therefore sees no pending-challenge signal anywhere. **Pre-existing and
  cross-cutting, not introduced by crd.2**: the Downtime tile has been badge-less in desktop mode
  since it was written, and the crd.2 dev pass found this independently and correctly declined to fix
  it for the same reason. Fixing it changes live behaviour for an existing tile outside crd.2's
  scope, so it wants its own small story covering every badged `MORE_APPS` entry at once, not a
  one-off for the newest one.
- **A player who never opens the Challenges tab only gets a fresh badge signal at boot** (Medium as
  filed; **deliberate design trade-off, not a defect**) — `public/js/app.js`'s boot path calls
  `refreshPendingQueueBadge()` once for a non-ST viewer, and `pending-queue.js`'s 10s poll is gated
  on the containing tab actually being `.active`. A challenge created after boot therefore does not
  light the tile until the player opens the queue or reloads. This is the direct consequence of the
  epic's own resource-conscious principle, established during Epic CRD's scoping: **do not poll while
  nobody is looking at the surface.** Logged here so it is a known, chosen boundary rather than an
  unnoticed gap. **Do not "fix" it by adding a global always-on poll.** If a live signal for an
  unopened tab is ever genuinely wanted, the right shape is this app's existing WebSocket broadcast
  channel (the pattern `equipment_catalogue` and `bloodlines` already use), not a second timer.
- **The boot badge refresh can overwrite a newer queue fetch** (Medium; narrow race, low real-world
  reachability) — `public/js/game/pending-queue.js`. `refreshPendingQueueBadge()` writes `state.rows`
  without joining `_fetchGen`, the generation guard that `_refetchAndRender()` uses. If the
  fire-and-forget boot request resolves AFTER a tab-open fetch has already landed, the older snapshot
  wins and the next poll's diff can fabricate a resolved row or resurrect a departed one. Reaching it
  requires the player to navigate into Challenges and complete a second round trip before the boot
  request settles. Not patched in this round because the fix (extending `_fetchGen` to cover the
  badge path) touches the same generation discipline crd.3b will be editing anyway; fold it into
  crd.3b or a small hardening story rather than a one-line change now.
- **Three assertions in `server/tests/crd-2-pending-queue.test.js` are source-text checks labelled as
  behavioural proofs** (Low) — the "goTab() accepts and forwards a context payload" test (~:313), and
  two of the design-system compliance tests (~:497, ~:508). Each can stay green while the thing its
  name claims is broken: `goTab()` could stop forwarding `ctx` with the tokens still present, a `cq-`
  class could appear only in a comment, or a colour literal could move into a multiline rule body the
  line-based filter never selects. **Not rewritten in this round** — deliberately, because the honest
  fix is a real DOM harness for these three, and this repo has no jsdom (adding one is a new
  dependency, a HALT condition). Note for whoever next touches this file: the suite's own header
  already states this limitation, and the newly-added phone-breakpoint test carries an explicit
  comment saying it is a regression tripwire rather than proof. Treat the labels as aspirational
  until there is a harness that can earn them.

**Reviewed and non-actionable** (recorded so they are not re-derived as open work): Codex's two
Pass-3b evidence-gap findings — that the story's claimed red-first test chronology is not
reproducible from the committed range, and that the "zero live writes anywhere" attestation cannot be
established from a client-side fetch shim — are about the completeness of the historical record, not
about defects in the current code. Nothing to patch; the narrower claim (this feature's browser
session created no `contested_roll_requests` document) is supported by the code itself, since the
queue imports only `apiGet` and the placeholder has no write API. Codex's "the test record reports
Mongo-skipped gates as fully passed" finding was **not reproducible**: the crd.2 suite passes with
real MongoDB access (re-run independently, 50/50 pre-patch and 59/59 post-patch); the 48/50 Codex saw
was its own sandbox failing to reach MongoDB (`EACCES` to port 27017), not a code defect.
