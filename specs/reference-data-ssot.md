# Data Sources of Truth — TM Suite

This document maps every data domain to its authoritative source: the MongoDB collection, the API endpoint, and the UI surface where it is managed. Before building any feature that reads or writes data, check here first.

---

## Character Data

| Domain | Collection | API | Managed in UI |
|--------|-----------|-----|---------------|
| Characters (schema, stats, merits) | `characters` | `GET/PUT /api/characters` | admin.html → Player tab (character grid + sheet editor) |
| Character tracker state (vitae/WP/health) | `tracker_state` | `GET/PUT /api/tracker_state` *(ST cross-character; players read+write their own per `server/routes/tracker.js:9-15` `canAccess()`)* | game app → Tracker tab |
| Questionnaire responses | `questionnaire` | `GET/PUT /api/questionnaire` | player.html → questionnaire flow |
| Character history | `history` | `GET/PUT /api/history` | admin.html → Player tab |

**`tracker_state` has a SECOND deletion path (CM-4a, 2026-08-16).** `DELETE /api/tracker_state` is no longer the only thing that empties this collection. `PUT /api/chapters/:id` deletes **every** `tracker_state` document, in one transaction with the phase write, whenever the request body carries an own `phase` key and `resetOnTransition(from, to)` is true (`public/js/downtime/cycle-phase.js`). ST/dev only, same auth as the DELETE. A body without `phase` never touches the collection. The safety mechanism (`withoutPhaseFields`/`buildPhaseUpdate`, same file) protects the real Cycle-tab phase-transition writer directly — proven by `server/tests/cm1-cycle-phase.test.js`. **ADMR-3 (2026-08-26) retired the Data Portability importer's own `chapters` JSON-restore path entirely** (TM Admin now owns Downtime Cycle export/import) — there is no longer a cycle-restore PUT reachable through Data Portability at all, so this second deletion path can only be reached from the real Cycle tab now, not from an importer.

**Tracker client note:** Two localStorage implementations currently exist and are fragmented:
- `public/js/game/tracker.js` — keyed by `_id`, used by suite sheet + ST tracker tab *(canonical going forward)*
- `public/js/suite/tracker.js` — keyed by character name, used by feed roller *(legacy, to be replaced)*

Migration to `tracker_state` API is task #10. Until done, tracker state is localStorage only and not shared across devices.

---

## Territory & City

| Domain | Collection | API | Managed in UI |
|--------|-----------|-----|---------------|
| Territories (stats, ambience, regent) | `territories` | `GET` (auth) / `POST,PUT` (ST only) / `PATCH /:id/feeding-rights` (regent or ST) | admin.html → City tab (ST); game app → Regency tab (regent player) |

**Feeding-rights write path (RFR.1):** regent's player writes only `feeding_rights` via `PATCH /api/territories/:id/feeding-rights`. Server enforces:
- Permission: `user.character_ids.includes(territory.regent_id)` OR ST role (via `isRegentOfTerritory` helper in `middleware/auth.js`)
- Lock: cannot remove a character who has already submitted a DT marked `resident` on this territory in the active cycle (ST bypasses the lock)

**Regent and Lieutenant are implicit rights-holders** — stored on `territory.regent_id` / `territory.lieutenant_id`, deliberately NOT duplicated into `feeding_rights[]`. Any feeding-rights check must include all three fields (client helpers at `downtime-form.js:renderFeedingTerritoryPills` and admin `downtime-views.js` mismatch check do this correctly as of 2026-04-23).

---

## Office (Court Positions — Epic OXP)

| Domain | Collection | API | Managed in UI |
|--------|-----------|-----|---------------|
| Office content (asset, style, merit suite, manoeuvres, status power; per category) | `office_content` (`kind: 'office'`), plus one `kind: 'merit_caps'` singleton document in the same collection | `GET /api/office_content` *(public read)* | — *(none in TM Game; see note below)* |
| Office seats (per-seat identity, holder, category) | `office_seats` | `GET` (auth) / `PUT /:seatId/holder` (ST only) | admin.html → City tab (court panel) |
| Manoeuvre purchase rank, per seat | `office_manoeuvre_ranks` | `GET` (auth) / `PUT /:seatId`, `PUT /:seatId/step` (ST only) | admin.html → City tab (Office tab, Manoeuvres section) |
| Merit dot purchases, per seat | `office_merit_dots` | `GET` (auth) / `PUT /:seatId` (ST only) | admin.html → City tab (Office tab, Merit Suite section) |
| Applied Status Action log | `office_actions` | `GET /?game_session_id=X` (auth) / `GET /latest_session` (auth) / `GET /pending`, `PUT /:id/accept`, `PUT /:id/decline` (ST only) / `POST /` (auth; caller must own `actor_id` or be ST) | admin.html → City tab (Office tab, approval queue) |
| Per-session Status Action budget spend | `office_action_budgets` | *(written only, inside the `/:id/accept` transaction — no direct route)* | — |
| Pending Status Action requests (submitted, not yet resolved) | `contested_roll_requests` (`request_type: 'status_action'`) | `POST /api/office_actions`, `GET /api/office_actions/pending`, resolved via `PUT /:id/accept`/`/decline` | admin.html → City tab (Office tab, approval queue) |

**`office_content` (oxp.10, split out of oxp.1, 2026-08-13) replaced the static `OFFICE_DATA`/`MERIT_DOT_CAPS` constants** (`public/js/tabs/office-data.js`, deleted in the same story) with a Mongo-backed collection, mirroring Epic BL's bloodlines migration exactly: `server/schemas/office_content.schema.js`, `server/scripts/seed-office-content.js` (frozen literals, the seed of record), `server/routes/office-content.js` (public read), and `public/js/data/office-content-cache.js` (client accessor cache, loaded once at boot — `officeEntry(category)`/`meritCap(name)`, synchronous after load, same shape as `bloodlines-cache.js`'s own accessors). **Read-only in TM Game**, same locked-scope decision as bloodlines: no write route, no admin UI here; a future TM Admin story adds ST authoring against this same shared collection. **Administrator has NO `office_content` document** (its content is oxp-8, still unwritten) — every reader treats that as a normal, valid state (the pre-existing "pending" fallback in `office-tab.js`), not an error. Server-side, `office-seat-resolve.js`, `office-merit-dots.js`, `office-manoeuvre-rank.js` and `office-purchase.js` all read this collection directly via `server/lib/office-content-read.js` (no server-side cache — `office-purchase.js` reads it from inside an active MongoDB transaction alongside its other `{session}` reads, where a cache would either be blind to or would have to bypass that transaction's isolation). **Correcting a stale premise**: an earlier pass at scoping this migration assumed office-data.js had only 3 import sites; the real count, re-verified before implementation, was 6 production call sites (4 server, 2 client) plus 5 test files that imported or mocked the static module directly — all reworked in the same change.

**`office_seats`, `office_manoeuvre_ranks` and `office_merit_dots` use SEAT-keyed `_id`s** (`office_seats._id`, a 24-hex string), not office category names — re-keyed from category to seat by oxp-11 (2026-08-13) because two offices (Primogen, Socialite) carry more than one concurrent seat, and a category key cannot tell them apart. `office_actions` uses ordinary MongoDB-generated `_id`s (it is an append-only log, not a per-seat state document); `office_action_budgets` is keyed by the composite string `${game_session_id}:${actor_id}`.

**"No document = the default value" is deliberate, not a migration gap (DBO-4, 2026-08-14).** A seat that has never had a manoeuvre rank or merit dot set simply has no document — the client treats a missing seat key as rank 0 / zero dots for every merit (`public/js/tabs/office-tab.js`); the GET handlers themselves only default a missing *field on an existing document* (`doc.rank || 0`, `doc.dots || {}`), not a wholly absent seat. The one collection-mutating *reset* path (`resetManoeuvreRank`, `server/routes/office-seats.js:501-544`, fired on a handover) explicitly uses `upsert: false` to preserve this: a seat with nothing to destroy gets no document minted just to say so. Do not treat an absent or empty document as evidence of a bug in either collection.

**Migration gap, found and closed 2026-08-14 (DBO-4).** `office_merit_dots` currently holds 2 REAL, pre-oxp-11 documents still keyed by office category (`_id: "Enforcer"`, `_id: "Head of State"`), not by seat — `server/scripts/migrate-office-purchases-to-seats.mjs` (built alongside oxp-11, dry-run default, `--apply` to write) has not yet been run against live `tm_suite`. Until it runs, the current seat-keyed code cannot see these two documents at all — `GET /api/office_merit_dots` reports both seats as having zero dots purchased, even though real (if currently zero-value: `{"Safe Place": 0}`) purchases exist. **DBO-4's own external review found the migration script itself had a real data-loss bug** in exactly this scenario: if an ST set a merit dot on either seat through the live UI before the migration ran, the script would silently DELETE the old category-keyed document once it saw the newer seat-keyed one — not merely leave it orphaned — discarding any field the old document alone held. Fixed the same day: the script now compares the two documents' content and only auto-clears the old one when they are identical (a true interrupted-migration recovery); a genuine mismatch is now REFUSED and reported for a human to reconcile, matching the file's own established "refuse rather than guess" pattern. Running `--apply` is still Angelus's own action, not an agent's, per this project's standing convention for one-off migration scripts — but the script is now safe to run whenever Angelus chooses, with no compounding-loss risk if it's delayed. See `deferred-work.md` and `dbo-4-office-collections-absent-empty-route.md`'s Dev Notes for full detail.

---

## Downtime

| Domain | Collection | API | Managed in UI |
|--------|-----------|-----|---------------|
| Stories (the multi-game tier above a Chapter) | `story_cycles` | `GET /api/story_cycles`, `GET /api/story_cycles/:id` *(public read)*; `POST`/`PATCH`/`DELETE` *(ST-auth)* | admin.html → Cycle tab, Stories panel |
| Chapters (one game plus its downtime: the downtime → processing → prep → game span) | `chapters` | `GET/POST /api/chapters` | admin.html → Cycle tab (create/phase/Story link), Downtime tab (processing) |
| Downtime submissions (player forms + ST outcomes) | `downtime_submissions` | `GET/PUT /api/downtime_submissions` | player.html (submit) + admin.html Downtime tab (process) |

**`chapters` was `downtime_cycles` until cm-2b (2026-08-17).** The collection, the route
(`/api/downtime_cycles` → `/api/chapters`), the route file (`cyclesRouter` moved out of
`server/routes/downtime.js` into its own `server/routes/chapters.js`) and the one FK that names it
from a submission (`downtime_submissions.cycle_id` → `chapter_id`) all renamed together, per
`cycle-model.md` §11a. The old name described one PHASE of what the document spans; CM-1 (#1028)
had already made it span all four.

`downtime_submissions` itself is deliberately NOT renamed — a submission's identity genuinely is
about the downtime phase. Nor are the two OTHER `cycle_id` fields in this database, which point at
the same collection under their own names and were out of cm-2b's scope:
`project_invitations.cycle_id` (`server/schemas/project_invitation.schema.js`, required) and
`ranking_ballots.cycle_id` (`server/schemas/ranking_ballot.schema.js`, required), plus
`npcs.linked_cycle_id`. Reconciling those is unstarted follow-up work.

**The cutover is NOT live yet.** The migration script
(`server/scripts/cm-2b-downtime-cycles-to-chapters.mjs`) ships dry-run-verified only; `--apply` is
held until TM Cockpit's own side coordinates. See `specs/cm-2b-cross-repo-coordination.md`.

**Until `--apply` has run and burnt in, `downtime_submissions` carries the Chapter FK under EITHER
name, and there is one shared shim for that: `server/helpers/chapter-fk.js`.** The FK rename is
destructive (`$rename` removes `cycle_id`), so neither deploy order was safe on its own — code
review found both. Contract, deliberately asymmetric:

- **READ** `chapter_id`, falling back to `cycle_id` when `chapter_id` is absent, both storage types
  (the issue #497 ObjectId/string split goes through the same helper). Every server-side read site
  uses it: `downtime.js`'s list/hold-flags filters, `requireOpenCycle`, the deadline gate, the
  joint-project delete cascade and accept lookup, the published-email Chapter label,
  `chapters.js`'s DELETE-orphan guard and `/publish`, and `territories.js`'s feeding-rights lock.
  Responses are normalised to name it `chapter_id` on the wire, so client readers need no shim.
- **WRITE** `chapter_id` only. `POST`/`PUT /api/downtime_submissions` reject a body carrying
  `cycle_id` outright: **400 `LEGACY_CYCLE_ID_REJECTED`**. The Data Portability importer shapes an
  older backup's `cycle_id` to `chapter_id` at the writer instead (Lesson #105).

The `cycle_id` half is transitional and comes out in a follow-up story once the migration is
applied and stable. Grep `LEGACY_CHAPTER_FK` for every site. **Do not add a new read site that
bypasses this module**, and do not extend it to accept legacy writes — that is the exact hazard it
exists to close.

**`story_cycles` shape (cm-2 rename, cm-3 addition):**
`{ _id, number, label, created_at, final_chapter_id? }`. No JSON-schema file exists for this
collection; `server/routes/story-cycles.js` validates the three writable fields inline, and cm-3
deliberately did not introduce one for a four-field collection.

**`story_cycles.final_chapter_id` (cm-3, 2026-08-17) — the maintenance clock's only manual input.**
A string holding the `_id` of one of that Story's own member `chapters` documents, or `null`.
The ST picks it from a "Final chapter" `<select>` in the Cycle tab's Stories table. **A Story is
closed exactly when this field is set** — there is no separate `closed` flag. It is the sole ST-set
signal behind `isFinalChapterOfStory(cycle, storyCycle)` (`public/js/downtime/db.js`), which returns
true iff `storyCycle.final_chapter_id === String(cycle._id)`. That derived value gates both the ST
maintenance audit panel (`renderMaintenanceAuditPanel`, `public/js/admin/downtime-views.js`) and the
player-facing PT/MCI at-risk warning strip (`renderMaintenanceWarnings`,
`public/js/tabs/downtime-form.js`). Both resolve "which Story owns this cycle" through the one
shared `storyCycleForCycle` helper in `db.js`, never their own copy.

Freely re-settable, including back to `null`: no confirmation dialog, no history on the field.
Guarded in the other direction only — `PATCH` validates that the named cycle exists and belongs to
this Story (400 otherwise), and `PUT`/`DELETE /api/chapters/:id` refuse with
409 `CYCLE_IS_STORY_FINALE` when the target cycle is currently some Story's `final_chapter_id`, so
the pointer can never be left dangling.

**Why a pointer, and not a `closed` boolean plus "highest `game_number` in the Story":** cm-3's own
first pass shipped exactly that, and review found two holes. Structural membership alone cannot
distinguish "this Story has one chapter and is done" from "this Story has one chapter so far" (hence
the flag) — but even with the flag, a *computed* finale silently relocates whenever Story membership
changes afterwards, orphaning any `maintenance_audit` already recorded on the chapter that loses the
title, and two cycles sharing a `game_number` both classify as the finale (this project has a live
duplicate-"Game 7" precedent). A pointer answers all of it, needs no sibling-cycle list, and reads
no `game_number` at all. Ruling: `cycle-model.md` §3; redesign instruction from Angelus, 2026-08-17.

**DEPLOY NOTE — one manual step, no migration.** Live Story 1 already carries a real, ST-completed
`maintenance_audit` on its Game 3 cycle, recorded under the old `is_chapter_finale` flag. Nothing
auto-migrates it. **An ST must set Story 1's "Final chapter" to Game 3 in the Cycle tab's Stories
table at or after deploy** for that audit panel and the corresponding player warning strip to become
visible again. Until then both stay dark for Story 1, correctly but unhelpfully.

**`chapters.is_chapter_finale` is DEAD as of cm-3.** It was the per-chapter ST checkbox on the
DT Prep panel (chm-1) that `final_chapter_id` replaces. No production code reads it any more, no
migration was run, and existing values are left on live documents untouched (same convention as
`chapters` after cm-2). The Prep panel now shows a read-only derived badge in its place.
`chapters.maintenance_audit` (`{[character_id]: {pt, mci}}`, chm-2) is unchanged in shape and
role — only what gates its panel's visibility changed source. The per-character rule behind both
surfaces ("who holds PT/MCI", "who still needs a tick") lives in one place,
`public/js/downtime/maintenance.js`.

**Downtime investigations: RETIRED 2026-08-15 (TM Wiki Story 31-7).** `downtime_investigations`,
its `/api/downtime_investigations` route and the "Investigations" panel in admin.html's Downtime tab
are gone. It and `tm_wiki.prior_investigations` were the same concept modelled twice; neither ever
held a document, and `tm_suite.downtime_investigations` was never even created. TM Wiki's version is
the single surviving home, because it is wired into the player-facing downtime form rather than an
ST-only panel, and investigation continuity is story material under Epic 31's ownership test. No
migration was written: there was nothing to move.

**Influence spend:** Not a stored field. Must be derived at render time by summing influence-category action_responses from the character's last resolved downtime submission.

---

## Game Sessions & Attendance

| Domain | Collection | API | Managed in UI |
|--------|-----------|-----|---------------|
| Game sessions (dates, XP grants, payments, finances) | `game_sessions` | `GET/PUT /api/game_sessions` *(coordinator-auth: coordinator, ST, dev)* | admin.html → Attendance tab (ST); game app → Check-In tab + Finance tab (coordinator+) |
| Session logs | `session_logs` | `GET /api/session_logs` *(ST-auth)* | admin.html → Engine tab |
| Attendance | *(within game_sessions)* | `GET /api/attendance` | admin.html + game app Check-In tab |

**Payment data (FIN):** Each `attendance[n]` entry carries structured `payment: { method, amount }` (fin.2 schema). Legacy submissions with flat `payment_method: 'Cash'` are read via `public/js/game/payment-helpers.js` → `readPayment(entry)` which normalises old values ('Cash' → 'cash', 'PayID (Symon)' → 'payid', etc.) and returns `{ method, amount: 0 }` for legacy rows. Both Check-In and Finance tabs read through this helper.

**Finance shape:** `game_sessions[n].finances = { expenses: [{category, amount, date?, note?}], transfers: [{to, amount, date?}], notes }`. Takings card in Finance tab is derived from `attendance[n].payment` via `derivePayments(session)`. Balance = collected − expenses − transfers. Nothing is stored as a computed field.

**Session ↔ Chapter link (CM-6, folded into `cm-4`):** `game_sessions.chapter_id` is the enforced FK to the `chapters` document the session belongs to. Nullable; where set it is 1:1, and that is a **database constraint, not a convention** — a partial unique index `chapter_id_unique_notnull` (`{chapter_id: 1}`, `unique`, `partialFilterExpression: {chapter_id: {$type: ['objectId','string']}}`) created at boot in `server/index.js`. Never infer the pairing by matching `game_number`: `cycle-model.md` §11a records two separate live bugs caused by exactly that inference. The historical backfill lives as an explicit, evidence-cited table (`GAME_SESSION_PAIRINGS`) in `server/scripts/cm-4-renumber-chapter-merge.mjs`.

**`chapter_id` has ONE canonical stored type: `ObjectId`.** The partial unique index treats an `ObjectId` and its 24-hex string form as *distinct* keys, so a mixed-type field silently defeats the 1:1 constraint. Every write path coerces — `coerceChapterId` in `server/routes/game-sessions.js`, applied on `POST /api/game_sessions` and `PUT /api/game_sessions/:id`, plus the 24-hex `pattern` on `gameSessionSchema`. This matters because both live writers (`public/js/admin/attendance.js`, `public/js/game/signin-tab.js`) GET the whole session document and PUT it straight back after editing an unrelated field, and JSON has no ObjectId. A duplicate pairing surfaces as **409 `CHAPTER_ALREADY_PAIRED`**, never a 500. Any new writer of this field must go through the route, not straight to Mongo.

---

## Players & Auth

| Domain | Collection | API | Managed in UI |
|--------|-----------|-----|---------------|
| Player accounts (Discord link) | `players` | `GET /api/players` | admin.html (ST view) |
| Auth | *(Discord OAuth)* | `/api/auth/discord` | — |

---

## Reference / Rules Data

**Corrected 2026-09-17 (Reeve's rules-doc reconciliation pass) — the table below previously described
a "baked into JS" model that no longer exists.** `public/js/data/merits-db.js`, `devotions-db.js` and
`man-db.js` are gone (confirmed absent on disk); attributes, skills, disciplines, merits, devotions,
rites and manoeuvres now all live in one Mongo-backed collection, the same migration pattern as
`office_content` (see the Office section above).

| Domain | Source | Notes |
|--------|--------|-------|
| Rules/powers database — attributes, skills, disciplines, merits, devotions, rites, manoeuvres | `purchasable_powers` collection | `GET /api/rules` (public read, `?category=`/`?q=`/pagination filters), `POST`/`PUT /api/rules/:key` (ST only). Schema: `server/schemas/purchasable_power.schema.js` (`category` enum: `attribute`, `skill`, `discipline`, `merit`, `devotion`, `rite`, `manoeuvre`). Managed in TM Game's admin.html → Rules tab (`public/js/admin/rules-view.js`); TM Admin has its own parallel authoring surface against the same collection (see TM Admin's own specs). |
| Clan/covenant/mask/dirge constants | `public/js/data/constants.js` | Still genuinely baked into JS — not migrated, unlike the rules/powers data above |
| NPCs | `npcs` | `GET /api/npcs` (ST only) / `GET /api/npcs/for-character/:id` (player-readable for linked NPCs; ST always). Schema adds `is_correspondent` (DTOSL.1), `st_suggested_for` (DTOSL.3 pending), `created_by` (DTOSL.5 pending). Status enum includes `pending` and `archived`. |
| Feed methods + territory data | `public/js/player/downtime-data.js` | Shared constants — import from here, do not duplicate. **Note (see TM Story's own docs): TM Story's live form offers 8 feed methods via a DB-backed `tm_story.feeding_templates` collection (Story 11.9); this file/the tool's own `feed-methods.mjs` still only know the original 5 — a live drift, not addressed by this correction.** |

---

## Feeding Roll — Shared Constants

`FEED_METHODS` and `TERRITORY_DATA` are defined once in `public/js/player/downtime-data.js`.

The feed roller in the game app (`public/js/suite/tracker-feed.js`) currently has a hardcoded duplicate of both. **Do not add a third copy.** Task #7 will consolidate to the shared source.

---

## Derived Values (never stored)

These are always calculated at render time from character data:

- Size, Speed, Defence, Health max, Willpower max, Vitae max
- XP earned / XP spent / XP remaining
- Influence total (from merit dots)
- Discipline pools, derived pools

---

## Auth Boundaries

| Route prefix | Auth required | Role required |
|---|---|---|
| `/api/auth` | No | — |
| `/api/characters`, `/api/territories`, `/api/downtime_*`, `/api/players`, `/api/questionnaire`, `/api/history`, `/api/ordeal*`, `/api/rules`, `/api/npcs` | Yes (any authenticated) | — |
| `GET /api/office_seats`, `GET /api/office_manoeuvre_rank`, `GET /api/office_merit_dots`, `GET /api/office_actions`, `GET /api/office_actions/latest_session`, `POST /api/office_actions` | Yes | any authenticated (`POST` additionally requires the caller own `actor_id` or be ST) |
| `PUT /api/office_seats/:seatId/holder`, `PUT /api/office_manoeuvre_rank/:seatId(/step)`, `PUT /api/office_merit_dots/:seatId`, `GET /api/office_actions/pending`, `PUT /api/office_actions/:id/accept`, `PUT /api/office_actions/:id/decline` | Yes | ST only |
| `/api/tracker_state` | Yes | ST (cross-character) or owning player (`req.user.character_ids` per `server/routes/tracker.js:9-15`) |
| `/api/session_logs`, `/api/game_sessions` | Yes | ST only |
| `GET /api/st_mods?character_id=<id>` (single) or `GET /api/st_mods?character_ids=<csv>` (bulk; STM-7 / issue #413) | Yes | ST (any character) or owning player (`req.user.character_ids` per `server/routes/st_mods.js#canAccessMods`, applied per-id for bulk) |
| `POST /api/st_mods`, `DELETE /api/st_mods/:id`, `GET /api/st_mod_audit` | Yes | ST only |
