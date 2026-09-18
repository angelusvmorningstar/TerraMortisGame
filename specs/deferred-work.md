# Deferred Work

## Deferred from: tm-admin.12.2 (Feeding tab reflects a downtime-form roll), 2026-09-10

**`game/tracker.js`'s `saveToApi` writes `tracker_state` with an unguarded partial `$set` — no rev,
version or compare-and-set — so two writers racing on the same character are last-write-wins today.**
Pre-existing, not introduced by Story 12.2, and explicitly out of that story's scope (its AC 5 names
this file as the place to record it).

The mechanics: `saveToApi(charId, fields)` (`public/js/game/tracker.js:73-83`) optimistically merges
`fields` into the module cache and fires `PUT /api/tracker_state/:id`; the route
(`server/routes/tracker.js:29-47`) does `findOneAndUpdate(filter, { $set: { ...updates } }, { upsert:
true })` with no precondition on the document it read. `trackerAdj` (line 268) reads the CACHED
counters, applies a delta locally, then writes the WHOLE `persistedFields(cs)` set (line 300) — so a
Tracker-tab +/- click and any other writer overlapping it do not merge, the later PUT simply restores
its own stale copy of every field it carries. Real concurrent writers exist: the Tracker tab's manual
adjusters, `reconcileInfluenceDT` (line 201, writes `influence` for every active character on tab
open), the Feeding tab's ST confirm, and TM Admin writing the same collection.

Story 12.2 makes the overlap slightly more likely (the Feeding tab's confirm now also carries
`aggravated`, a field the Tracker tab's own damage buttons write), but does not make it categorically
worse: the confirm is still ONE `apiPut` of exactly the fields it owns, not a new parallel write path,
and it deliberately does not route through `trackerAdj`'s whole-`persistedFields` write, which would
have widened the blast radius from three fields to seven.

A real fix needs a decision first, not just a patch: either a document `rev` incremented server-side
with a `$set` guarded on the rev the client read (409 on mismatch, client refetches), or narrowing
counter writes to `$inc` so concurrent deltas compose instead of overwriting. `$inc` suits the damage
and vitae counters; it does not suit `conditions` or the confirmed-vitae semantics, so the two
approaches are not interchangeable across the whole document. No issue number assigned; opening one is
Angelus's call. Suggested title: `guard-tracker-state-partial-writes`.

## Deferred from: issue-1122-pledge-pool-overcommit code review (2026-08-31)

External adversarial review (Codex, 3-pass) of the render-time pledge-overcommitment indicator
(#1122) surfaced two real, evidence-backed Medium findings, both genuinely out of that story's
declared scope (it wires a comparison into four existing call sites; neither of these is that) —
deferred rather than patched:

- **Deleting or renaming a pledged merit makes ALL pledge-related display vanish for that
  merit, and exposes that ADR-010 D2's own claimed guarantee is unenforced.** `shRemoveGenMerit`
  (`public/js/editor/edit-domain.js:159-166`) splices the merit row with zero check for a standing
  pledge against it — confirmed by reading the function directly, no guard exists. `buildPledgeIndex`
  still holds the orphaned pledge (keyed by name+qualifier), but every render-time consumer
  (`_pledgeBadge`, `_pledgeOvercommitNote`, and by extension #1122's whole indicator) iterates
  `c.merits` — the merit ROWS that currently exist — not the pledge index's own keys, so nothing
  renders anything once the target merit is gone. The oath's own `_oathPledgeNote` still names the
  missing attachment ("Sworn against Missing Merit 3") but does not say the pool backing it no longer
  exists at all, which is a MORE severe over-commitment (100% unfunded) than anything #1122's own
  indicator can currently express. Separately, ADR-010 D2 explicitly claims *"the editor refuses to
  sell or reallocate pledged dots out from under a standing oath"* — `shRemoveGenMerit` shows that
  claim is false for full merit removal specifically (only per-field edits route through
  `_applyPledgeFloor`). A real fix needs a product decision first: should removing a pledged merit be
  blocked outright (matching ADR-010's own claimed behaviour), release the pledge automatically, or
  something else? That decision should precede any code. Found by Pass 2 (Edge Case Hunter), verified
  independently via direct code reading (Angelus's session, 2026-08-31) rather than trusted.
- **Legacy `rating`-only merits (no `cp`/`xp`/`free_*` fields) produce DIFFERENT pledge-overcommitment
  numbers in the admin app versus the player-facing Suite app, for the identical persisted document.**
  Admin's `renderSheet` runs `ensureMeritSync(c)` (`public/js/editor/merits.js:139-158`) before
  rendering, which materialises `cp:0`/`xp:0`/every `free_*` field to `0` wherever they were
  `undefined` — a real, in-place mutation of the in-memory character. Suite's `renderSuiteSheet`
  calls `shRenderGeneralMerits(c, false)` directly (`public/js/suite/sheet.js:739`) with no such
  normalisation first. `meritRating(c, m)` (`public/js/editor/xp.js:193-197`) has an early-return
  fallback — `if (m.cp === undefined && m.xp === undefined) return m.rating || 0` — whose branch
  choice is flipped purely by whichever app ran `ensureMeritSync` first, even though nothing about
  the merit's true value changed. Reachable in practice: the schema permits a rating-only shape, and
  the server-side normaliser explicitly preserves a positive no-channel `rating` when it cannot map
  `granted_by` to a canonical channel (confirmed by the reviewer's own tracing). This is a pre-existing
  ambiguity in `meritRating` itself — it already silently affected `pledgeableDots`'s numbers before
  #1122 existed — which #1122 merely gives a directly-contradicting user-visible symptom for the
  first time (two apps quoting different "pool funds N" numbers for the same character). A real fix
  touches `meritRating`'s own fallback condition, which is explicitly out of #1122's declared scope
  ("Not a change to any dot count, `meritRating`..."). Found and reproduced by Pass 2 (two real-render
  probes, one per app, quoting the exact contradicting numbers): `#1122's own`
  `codex-findings.md` (`specs/stories/code-review/`).

## Deferred from: Codex external review of tbid-1-territory-bid-open-flow (2026-08-29)

**`terrConfirmRegent(tid, regentName)` (`public/js/suite/territory.js`) decides "is this a reopen"
purely from `state.territories.some(t => t.id === tid)`, ignoring the modal's own `mode: 'open'` /
`mode: 'reopen'` field.** Every constructor that builds a `{type: 'regent', ...}` modal today keeps
`mode` and array-membership aligned (`terrPickTerritory` only opens `mode: 'open'` for a territory
confirmed absent from `state.territories`; `terrReopen` only opens `mode: 'reopen'` for one confirmed
present), so under the real UI this cannot diverge. But the function is assigned to
`window.terrConfirmRegent`, reachable from the console or any future caller — if one ever called it
directly (or a future code path built a `mode: 'open'` modal for a `tid` already on the board) it
would silently replace the live entry in place (bids cleared, resolved reset) as if reopening it,
with no warning that a contest in progress was discarded. Judged Low severity and out of this story's
scope by Codex's own external review (Pass 1) — not a demonstrated ordinary-click path, "primarily an
exposed-handler/invariant-hardening defect." Fix, if picked up: branch on `m.mode` explicitly rather
than array membership, passing `mode` through from `terrModalSubmit`'s `window.terrConfirmRegent(m.tid,
rg)` call.

## Deferred from: Epic DTUI closure — downtime-form.js cleanup (2026-08-27)

Closing Epic DTUI's remaining backlog surfaced that `public/js/tabs/downtime-form.js`'s player-facing
rendering path is now largely unreached in production — `FORM_RETIRED = true`
(`public/js/downtime/form-retirement.js`, 2026-08-25) means non-ST players never render the real
form, only STs do (to review/correct pre-cutover submissions). That raised the obvious tech-debt
question: is the player-facing code now dead weight worth retiring/trimming?

**Angelus's explicit ruling: NOT YET.** Leave `downtime-form.js` as-is until a full downtime cycle
has completed end-to-end on TM Story's replacement form — it's "still a useful reference" until then
(a working comparison point if TM Story's form needs debugging, and a fallback shape if anything about
the cutover doesn't hold up under real use). Do not propose or start a downtime-form.js
retirement/trim epic until that condition is met. Revisit after the next full cycle closes; check
`specs/stories/sprint-status.yaml`'s `epic-cm` cycle tracking for cycle status before re-raising this.

## Deferred from: gdx-9-single-scroll-sheet code review (2026-08-27)

Internal 3-layer review (Blind Hunter/Edge Case Hunter/Acceptance Auditor) surfaced two real edge
cases, both judged real-but-narrow enough not to block this story — deferred rather than patched:

- **Live viewport resize/rotation crossing the 900px desktop breakpoint while a single-scroll sheet
  is already open leaves stale phone-only markup behind.** `_applyDesktopMode` (`app.js`'s
  `DESKTOP_MQ` change listener) toggles `desktop-mode` and re-renders the bottom nav, but never calls
  `renderSheet()`/`suiteRenderSheet()` — so `#sh-content-suite` keeps its single-scroll markup (the
  sticky `.gdx9-pinned` bar, jump-nav chips, `.gdx9-section` wrappers) even after the app switches
  into desktop mode, until the user re-selects a character and forces a fresh render. Narrow in
  practice: requires an actual live resize/rotation crossing exactly that threshold with a character
  sheet already open in single-scroll mode (tablet/foldable rotation, or a manually resized desktop
  browser window) — and the feature itself defaults off, so it can't manifest at all until the flag
  is enabled. Self-heals on the next character selection. Found by Edge Case Hunter
  (`gdx-9-single-scroll-sheet.md`'s own code review).
- **`boot()`'s `isDesktop` local (`app.js`) can go stale across the `await ensureTrackerLoaded(...)`
  a few lines later** if a resize crosses the 900px breakpoint during that await — a pre-existing
  hazard (the plain `isDesktop` ternary already had this race before gdx-9) that gdx-9 extends by
  adding one more dependent local (`gdx9SingleScroll`) and a new phone-branch destination reading off
  the same stale capture, rather than introducing a new race class. Pre-existing, not gdx-9's to fix
  solo; worth a dedicated small story if `boot()`'s resize-during-await ordering is ever tightened.

## Deferred from: dev->main reconciliation (2026-08-25)

Full reconciliation of `dev`'s 30 stranded commits (gdx-1/2/3/4/11/12, xpl-1, dtlt-10, devotion
cult-gate, issue-779/791, epic-di/epic-dbo doc closures) onto `main`, via a throwaway-branch merge
per `feedback-branch-reconciliation-technique`. 8 real conflicted files hand-resolved (char-pools.js,
app.js, roll-v2.js, suite.css, deferred-work.md, sprint-status.yaml, plus dtlt-10's own duplicate-of-
PR-#1197 finding). Full vitest (4226 passed, 13 failed — all traced to pre-existing/environmental
causes, none in the hand-resolved files) and targeted Playwright (rlv-2, rlv-4, desktop-and-css) both
green after two real regressions were found and fixed: rlv-4's own tests assumed `.gcp-choice`
matched exactly one tile (now 5, once gdx-11/12's Lash Out/Clash/Blood Bond/Humanity Check tiles are
also present) and assumed the Pools section renders expanded (gdx-11 AC9 now defaults it collapsed);
plus a stale `#t-dice` selector reference in two `desktop-and-css.spec.js` probe fixtures (rlv.2
retired that id).

Two genuine findings surfaced by bringing two independently-evolved branches together, confirmed via
direct branch comparison NOT to stem from any specific merge-conflict judgment call (identical on
`origin/main` and `origin/dev` before this reconciliation touched either) — real, but out of
proportion for a merge pass, and needing product/design judgement this pass shouldn't make
unilaterally:

- **gdx-2's own CSS ratchet (AC1: no absolute px font-size; AC2: no sub-floor type) is violated by
  13 rules in `suite.css` that gdx-2 never checked against, because they were built on `main`
  independently while gdx-2 lived on `dev`** — mostly Epic CRD's own `.cr-*`/`.cq-*` classes
  (`contested-roll.js`/`pending-queue.js`'s resolve-screen and pending-queue UI), plus
  `#desktop-sidebar.collapsed .sidebar-app-btn`/`.sidebar-util-btn`. None of these rules were touched
  by this reconciliation's own 2 `suite.css` conflict hunks — confirmed present with the exact same
  raw-px values on `origin/main` alone. Fixing this means converting ~13 CRD-era rules to the
  `--fs-floor-*` token scale gdx-2 established, which needs someone with real context on those rules
  (not blind mechanical conversion) — worth its own small follow-up story.
- **gdx-3's own AC3 test (`.trk-adj`/`.sh-tracker-info-btn` "T1/T2 fixes didn't grow the visible box
  on desktop") already asserted values (28px/16px) that don't match either parent branch's real CSS**
  — `--control-height-sm` is `36px` on both `origin/main` and `origin/dev` independently, and
  `.sh-tracker-info-btn`'s width has always been `24px` on both, not the `16px` the test expects. This
  predates the reconciliation entirely (confirmed via direct branch comparison) — the test's own
  expected values were already wrong before gdx-3 was ever storied against this file, not something
  broken by merging. Needs whoever re-baselines gdx-3's own AC3 to reconcile the test against the
  real, live token values rather than trust the original story's own recorded expectation.

## Deferred from: rlv.6 (delete dice-engine.js and its dead sidecar wiring) (2026-08-24)

Three small, independently-verified admin-app cleanup items found while scoping/reviewing rlv.6, all
explicitly out of that story's own "delete dice-engine.js" scope — none touch product behaviour for
a real user today, all are pure debt/test-accuracy items:

- **`tests/admin.spec.js`'s "Admin — Next Session Panel" describe block (~6-7 tests) clicks a stale
  `data-domain="engine"` selector.** `initNextSession()` (`public/js/admin.js:331`) is actually
  called under `domain === 'attendance'` today — the panel is real and live, its test suite's own
  `beforeEach` was never updated after the Engine domain was retired. Fix is a one-line selector
  change (`data-domain="engine"` → `data-domain="attendance"`).
- **`public/css/admin-layout.css`'s `#session-tracker` rule block (~line 2570 post-rlv.6) is orphaned
  dead CSS.** `session-tracker.js` was already deleted under issue #836, but its own CSS block was
  never removed — same shape as `dice-engine.js`'s own CSS was before rlv.6 caught it.
- **`public/js/admin.js`'s `switchDomain()` has a second statically-unreachable branch: `npcs`.**
  No `data-domain="npcs"` button exists in `admin.html`; `tests/issue-23-npc-register.spec.js`
  itself asserts the NPC Register button is absent, confirming this is intentional/already-known, not
  a live bug — just leftover dispatcher debt (`initNpcRegister` stays imported, its branch stays
  dead) of the same shape rlv.6 just cleaned up for Engine. Found by Codex's own Pass 2 during
  rlv.6's code review, correctly declined as out-of-scope by its own Pass 3a.

---

## Deferred from: code review of xpl-1-xp-ledger-write-hook (2026-08-15)

- **No index on `xp_ledger.character_id`** — `GET /:id/xp_ledger` does a full collection scan plus
  in-memory sort. Negligible at current data volume; deliberately not patched in this pass because
  the fix (a boot-time `createIndex` call in `server/index.js`, matching the existing
  `cyoa_passages`/`office_actions`/`contested_roll_requests` convention there) would land in a file
  that already carries an unrelated, uncommitted, in-progress change from a concurrent session —
  touching it risked entangling two unrelated diffs. Cheap follow-up once that file is clear.
- **Pre-fetch → diff → write is not atomic (TOCTOU)** — two concurrent `PUT`s for the same character
  can both diff against the same stale prior state, producing ledger rows that don't sum to the
  real change. Mirrors this route's own pre-existing last-writer-wins behaviour on the character
  document itself (no optimistic locking anywhere in `PUT /:id` today, ledger or not) — a real
  architectural gap, not unique to this story, and low-probability given a 3-ST team. Fixing it
  properly (findOneAndUpdate with `returnDocument:'before'` diffed against the pre-image, or a
  transaction) is a bigger change appropriate to its own story if ever prioritised.
- **Ledger covers only 4 of 5 XP-spend buckets** — `bp_creation.xp`, `humanity_xp`,
  `xp_log.spent.willpower`/`.special`, and the `powers[]` categories (devotions/pacts/fighting
  styles, via `xpSpentMerits`/`xpSpentPowers`) are real spend but out of this story's explicit
  scope. The XP History section title now says so explicitly (code-review patch); extending
  coverage is a natural follow-up story, not folded in here.
- **Non-integer `.xp` values are not guarded against** — `Number(x) || 0` in `diffXpLedgerRows`
  would carry a fractional or string-coerced XP value straight into a `delta`/`new_total` the
  (currently unwired) schema declares `integer`. No known live data has this shape; worth a guard
  if the schema is ever wired up for real.
- **Order-dependent tests in `xpl-1-xp-ledger-api.test.js`** — several tests assert on state left
  behind by an earlier test in the same file rather than establishing their own fixture. Matches
  this project's existing test style elsewhere; not fixed here to avoid restructuring test flow
  under time pressure the same day this story shipped.

---

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

## Deferred from: code review of gdx-11-vampire-mechanics-quick-actions (2026-08-19)

- **`saveToApi()` (`public/js/game/tracker.js`) has only a silent `.catch(() => {})`** — a failed
  network/auth write (e.g. a 403 from `canAccess()` on a target outside the acting player's own
  `character_ids`) reports success in the UI regardless (the optimistic cache update happens before
  the fetch even resolves). Found via gdx-11's Apply Torpor button, but this is `trackerWriteField`/
  `trackerAdj`'s own shared infrastructure (predates gdx-11, gdx-6/gdx-7 era) — every existing
  tracker write in the app (Vitae/Willpower/damage steppers, conditions) shares the identical
  pattern. Revisit as a cross-cutting fix (e.g. surface a toast on a non-2xx response) rather than
  patching one call site.
- **`char-pools.js`'s module-level `_pools` array is shared across the app's two render containers**
  (`gcp-panel` on the Sheets tab, `roll-char-pools` on the Roll tab) — a stale button `data-idx`
  clicked after the other container's own render overwrote `_pools` could resolve to a mismatched
  entry. Pre-existing (the array predates gdx-11, already shared for skill/discipline pool tiles);
  gdx-11's new `{opensPanel}`-shaped entries (no `total`/`pi`) make a hypothetical stale-index hit
  worse (`loadPool(undefined, ...)` -> `NaN` pool) than the pre-existing worst case (a wrong
  number). Real fix needs scoping `_pools` per-container (e.g. on `el.dataset` or a `WeakMap` keyed
  by the container element) rather than one shared module array — an app-wide change, not scoped to
  one story.

## Deferred from: code review of xpl-2-historic-reconciliation (2026-08-18)

- **`applyReconciliation`'s idempotency guard is a non-atomic check-then-insert** —
  `server/scripts/xpl-2-historic-xp-reconciliation.mjs`, `findOne` followed by `insertOne` with no
  unique index on `xp_ledger` and no transaction. Two overlapping `--apply` invocations could both
  pass the "not found" check for the same row and insert duplicates. Deferred as pre-existing
  convention, not a regression this script introduces: every other one-off migration script in this
  repo (`migrate-office-purchases-to-seats.mjs` is the closest precedent) has the identical class of
  non-atomic guard, mitigated only by "a human runs this once, by hand," not by code. Revisit if this
  project ever moves to a pattern where migration scripts can run concurrently or unattended.

## Deferred from: gdx-12-humanity-check-oaq-submit-approve (2026-08-19, dev-story)

- **`middleware/validate.js` caches compiled Ajv validators keyed by `schema.title`, and any two
  schemas that both omit `title` silently share one cache slot** — `cache.get(schema.title)` with
  `schema.title === undefined` for both means whichever schema compiles first "wins" the cache entry
  for both routes; the second route then validates every request against the WRONG schema. Found
  live: `server/schemas/office_action.schema.js` has no `title`; the new
  `humanity_check_request.schema.js` originally didn't either, and every POST to
  `/api/humanity_check_requests` was silently validated against `officeActionSchema` instead (a
  schema-valid Humanity Check payload 400'd with no obvious cause). Fixed locally for this story by
  giving the new schema a `title` (matching `contested_roll_request.schema.js`'s own existing
  convention). `office_action.schema.js` itself is UNCHANGED and still title-less — it remains
  latently vulnerable to the identical collision against any future schema that also omits `title`.
  Real fix is either titling every schema (enforce via a lint/test) or keying the cache off the
  schema object's own identity (`WeakMap`) instead of a string field that happens to be optional.
  Out of this story's scope — flagging so the next schema author doesn't rediscover this the hard
  way.

## Deferred from: code review of gdx-12-humanity-check-oaq-submit-approve (2026-08-20)

- **`PUT /:id/accept` and `PUT /:id/decline` bypass the Ajv `validate()` middleware/schema
  convention** the `POST /` route in the same file uses — `accept` validates its one field
  (`breaking_point_level`) manually inline instead, `decline` needs no body at all. Correct today,
  but inconsistent with this route file's own established pattern. Deferred as pre-existing
  convention drift, not unique to this story.
- **The "Load Pool" banner (`humanity-check.js`) uses a hardcoded `id="gcp-hc-load-banner"`**
  rather than a per-container-scoped id. Not currently triggered — `checkForResolvedHumanityCheck`
  has exactly one call site today (the roll tab's pools element in `app.js`'s `pickChar()`) — but
  would produce duplicate DOM ids if a future call site (e.g. the Sheet tab's own pools panel) ever
  renders it too. Deferred as a latent risk only.
- **Resolved `humanity_check` documents (`GET /mine`, unbounded query) and the ST's session-local
  `office-approvals.js` `state.levelByRequestId` Map (no eviction when a row is removed by another
  ST's poll) both grow unbounded with no cleanup path.** Matches this project's existing accepted
  accumulation pattern elsewhere for resolved/declined records at this campaign's scale — not a new
  class of problem. Deferred.
- **`.oaq-queue-row:has(.oaq-hc-level-select)` (`suite.css`) has no `@supports` fallback** for
  browsers lacking `:has()` support — the rule prevents the actions row from overflowing on narrow
  phone widths; without it that overflow returns silently on an unsupported browser. Deferred as low
  likelihood given this campaign's known device set.
- **The Approval Queue's 10-second poll re-render can interrupt an ST mid-choice on an open
  breaking-point `<select>`** (`office-approvals.js`). Deferred — shares the same re-render-on-poll
  shape as the rest of this file's existing rows, not a new pattern introduced by this story.
- **The `middleware/validate.js` Ajv-cache title-collision landmine** (`office_action.schema.js`
  still has no `title`, still latently vulnerable to the identical collision against any future
  title-less schema) — already found, fixed for this story's own schema, and filed above during
  Task 2. Re-confirmed by this review as already tracked, not a new gap.

## Deferred from: code review of gdx-1-mobile-zoom (2026-08-20)

- **The new viewport-meta-tag test (`tests/desktop-and-css.spec.js`) doesn't defensively handle a
  hypothetical multiple-viewport-tag (Playwright strict-mode violation) or entirely-missing-tag
  (`null` attribute, unclear matcher error) scenario.** Neither is reachable given the current
  DOM — there is exactly one, always-present viewport meta tag in `public/index.html` — cheap to
  add if that ever changes, not worth the defensive code now.

## Deferred from: gdx-3-mobile-touch-targets (2026-08-20, dev-story)

Three deliberate carve-outs from Epic GDX Group A's 44px touch-target pass (issue #984). Each is a
real gap with a measured selector list, recorded here so a follow-up story does not have to
re-derive it. Opening GitHub issues for them is Angelus's call.

- **B1 - the Downtime form's own `.dt-` prefixed controls.** Roughly 45 selectors from
  `components.css:1422` onward, plus `#t-downtime .qf-carthian-remove` (`suite.css:1699`),
  `.raw-toggle-btn` (`suite.css:1734`), `.dt-history-summary` (`suite.css:1723`) and
  `.dt-mobile-show-anyway` (`suite.css:1452`). **Reason: another epic has already ratified a
  conflicting target size for this surface.** `specs/epic-dtui-downtime-form-ux-refactor.md`'s NFR9
  says "Touch targets >= 32px for tickers and chips; >= 36px for buttons", and
  `specs/stories/dtui-2-dt-chip-and-chip-grid.story.md`'s CC6 shipped `min-height:32px` on `.dt-chip`
  as a deliberate design decision - it measures exactly 32px today, i.e. it is *at* its own ratified
  floor. Overriding another epic's accepted criterion is a product decision, and the DT form's dense
  chip grids would re-flow. The boundary is the `.dt-` prefix, not the file section: the `.qf-`
  shared form primitives live in the same section but also render on Ordeals, Archive, Feeding and
  the questionnaire, so they were fixed by gdx-3 (44px exceeds rather than contradicts DTUI's
  ">= 36px for buttons").
- **B2 - ST-only surfaces other than the Tracker tab.** `.cbt-*` (Combat tab,
  `public/js/game/combat-tab.js`), `#t-territory .regent-sel` (24.4px) and
  `#t-territory .peek-toggle-label` (14.4px) - the two stragglers css-4 missed - `.stm-*` (ST mods
  panel and audit), `.si-*` (Check-In, coordinator-only), `.city-map-*` / `.city-section-hd`,
  `.sidebar-st-btn`, and `#desktop-sidebar .sidebar-btn`. **Reason:** issue #984's AC1 says
  "player-surface controls" and names none of these. The ST Tracker tab is the one ST-only surface
  the issue does name, so it was fixed; these were not.
- **B3 - the ST character editor's own chrome**, i.e. `components.css` lines 143 to 511 (`.dot`,
  `.skill-flag`, `.cap-btn`, `.mci-*`, `.infl-*`, `.dev-*`, `.sk-spec-*`, `.sh-bane-*`,
  `.sh-attr-pri select`, `.sh-edit-select`, `.topbar-btn`, `.topbar-action`, `.edit-back`) plus the
  edit-mode-only selectors in the SHEET VIEW section (`.sh-stat-adj`, `.sh-stat-lr`,
  `.sh-ts-slot-add`, `.sh-ts-slot-btn`, `.rel-edit-btn`, `.rite-free-badge`, `.rite-xp-badge`).
  Same carve-out boundary gdx-2 used, for the same shared-stylesheet reason, with `.edit-tab`
  explicitly pulled OUT of it and fixed (see the story's scoping call). `.dot` in particular
  (`components.css:48`, 18x18) is carved out on measured evidence rather than by inheritance: the
  `.attr-row` / `.skill-row` pitch is about 29px and `.dot-stepper{gap:2px}` gives a 20px horizontal
  pitch, so a 44px hit area would overlap the row above and below by ~7px each and every neighbouring
  dot by 24px. Expanding it would make mis-taps MORE likely, not less - WCAG 2.5.8's spacing
  exception exists for exactly this case. The only real fix is re-laying-out the editor's Attribute
  and Skill grids for phone widths, which is a redesign.

Two smaller findings surfaced while measuring, both gdx-4 (mobile CSS cleanup) candidates rather
than gdx-3 work:

- **`.gcp-rote-badge` (`suite.css`) has no positioned ancestor.** It is `position:absolute;
  top:-4px; right:14px`, but only `.gcp-pool-btn.gcp-9a` declares `position:relative` - the
  `.gcp-rote` variant does not, so the badge currently anchors to `.tab` (`position:absolute;
  inset:0`) and renders at the top of the whole tab rather than on its own tile. gdx-3 found this by
  having to exclude `.gcp-pool-btn` from its Technique T2 list to avoid silently "fixing" (i.e.
  moving) it. `.gcp-pool-btn` already measures 320x64 at 360px, so it needed no touch-target work
  either way.
- **`.hdr-profile`, `.hdr-profile-menu` and `.hdr-menu-item` (`suite.css:59-66`) appear to be dead
  CSS.** A full grep of `public/` for that markup - `.html` and `.js`, excluding
  `getElementById`/`closest` lookups - returns nothing that emits them, although `app.js` still
  queries `#hdr-profile-menu` in two places. gdx-3 gave them their hit-area treatment anyway because
  they are named in the story's own in-scope inventory, but if they really are dead they should be
  deleted rather than maintained.

## Deferred from: code review of gdx-3-mobile-touch-targets (2026-08-20, external Codex)

External Codex adversarial review plus independent verification. Everything below was measured in
headless Chromium against the real served page, not reasoned from the diff.

- **[RESOLVED 2026-08-31 - issue #1192 fixed, exception removed.] Thirteen Technique T2 selectors now expand horizontally only,
  because a full 44px vertical expansion reaches into their own stacked or wrapped siblings.**
  Angelus authorised the follow-up (option b below) rather than accepting the capped state
  permanently - #1192 landed Technique T3 (phone-tier row growth) on all thirteen, verified against
  the real sibling-run Playwright fixtures (`css-audit — every in-scope control has a >=44px
  effective hit area at 360px`, `... no two sibling hit areas overlap`, both pass now), and
  `GDX3_AC2_EXCEPTIONS` in `tests/desktop-and-css.spec.js` no longer lists any of the thirteen.
  `.effpool-spec`, `.trk-chip-rm`, `.trk-card-hd`, `.trk-adj.sm`, `.sh-tracker-info-btn`,
  `.rl-sec-hd`, `.status-chip-st`, `.rank-pill`, `.settings-btn`, `.settings-checkbox-row`,
  `.rules-expander-toggle`, `.qf-checkbox-label`, `.char-picker__chip-remove`. Measured overlaps
  before the review round's fix ran from 2px (`.settings-btn`) to 26px (`.settings-checkbox-row`),
  and in every case `document.elementFromPoint` inside the overlap resolved to the NEXT sibling, so
  a tap on the row you can see activated the row below it. The review round removed that regression
  by dropping the vertical expansion for these thirteen (the overlay is now exactly the element's
  own box tall), which restores the pre-gdx-3 hit behaviour but does not reach 44px. **The real fix
  is a phone-tier row growth (Technique T3), exactly as gdx-3 already did for `.arc-doc-item`,
  `.char-picker__option`, `.hdr-menu-item` and `.qf-radio-label` - but that is a VISIBLE phone
  change and AC4 requires each such selector to be signed off by name, so it is a product decision
  rather than a review-round patch.** The checked-in `no two sibling hit areas overlap` test in
  `tests/desktop-and-css.spec.js` ratchets the current state, and `GDX3_AC2_EXCEPTIONS` in the same
  file is the machine-readable list.
- **`.svt-btn` has only a 24px effective vertical hit area at viewports of 600px and above.**
  `.sheet-topbar button::after` also matches it (they share the topbar), but its parent
  `.svt-toggle` carries `overflow:hidden` to clip the segmented control's 4px corners, so the
  overlay is swallowed. Measured at 1280px: box 62.19x24, overlay computes 62.19x44, and
  `elementFromPoint` 21px above and below the centre both resolved to `div.sheet-topbar`. gdx-3's
  T3 fix (`min-height:var(--tap-min)`) is scoped to `@media (max-width:599px)`, so desktop widths
  get nothing. **Not an AC1 breach** - AC1 is written for a 360px viewport, where T3 does apply and
  the control measures 62x44 - but it is a real gap for a wide touch device. The fix is either
  relaxing `.svt-toggle` to `overflow:visible` with per-child radius, or lifting the `min-height`
  out of the media query; both are visible-risk changes gdx-3 explicitly declined to make blind.
- **`.prestige-toggle`, `.st-char-dismiss`, `.hdr-profile`, `.hdr-menu-item` and `.feed-toggle` have
  no live render path, yet carry gdx-3 touch-target rules and test fixtures.** Verified by full
  grep of `public/js/`, `public/index.html` and `public/admin.html`: `.prestige-toggle` and
  `.st-char-dismiss` occur only in the repository-root legacy `index.html`, which is not served
  (Playwright and the dev server both serve `public/`); `.hdr-profile` and `.hdr-menu-item` are
  emitted nowhere at all (`app.js` still queries the `#hdr-profile-menu` **id**, which is a
  different thing); and `.feed-toggle` is emitted nowhere either - the only grep hits are the
  substring inside `proc-feed-toggles-row` in `public/js/admin/downtime-views.js`, which is an
  admin-app class and `admin.html` does not load `suite.css`. This extends the dev-story's own
  `.hdr-profile` note above to five selectors. Deleting them is gdx-4's job (dead-rule cleanup);
  gdx-3 correctly declined to delete rules named in its own inventory.
- **The gdx-3 fixtures are synthetic below the tab.** `gdx3Measure` mounts into the real
  `#t-<tab>` element index.html ships (so the tab's padding, width cap and `overflow-x:hidden` do
  apply) but replaces everything inside it with hand-authored markup, so a production clipping
  ancestor, stacking context or neighbour that a fixture omits cannot fail the probe. Two real
  defects hid behind exactly that gap and were only found by mounting realistic sibling runs (the
  wrapped `.rank-pill` set and the Office `.cs-step-btn` pair). The review round added a
  multi-sibling test that closes the specific hole; a fixture strategy that renders through the real
  JS renderers rather than hand-written HTML would close it properly, and is a test-infrastructure
  story of its own.

## Deferred from: gdx-4-mobile-css-cleanup (2026-08-20, dev-story; +2, 2026-08-21, Codex review response)

Six deliberate carve-outs from the CSS-standards cleanup (issue #985, absorbing #859). Two were named
when the story was scoped, two surfaced during the audit that wrote it, and two more surfaced while
addressing the Codex adversarial review's findings (2026-08-21) - hardening the checked-in ratchet
surfaced a genuine pre-existing violation the old, looser regex could never see. Each is recorded
with its evidence and a suggested follow-up title so nothing has to be re-derived. Opening GitHub
issues for them is Angelus's call.

- **Carve-out 1: seven confirmed-dead CSS declarations, blocked on retiring gdx-3's fixtures.**
  `.hdr-profile` (`suite.css:59`), `.hdr-profile-menu` (`:64`), `.hdr-menu-item` (`:65`),
  `.prestige-toggle` (`:578`), `.st-char-dismiss` (`:590`), `.feed-toggle` (`:514`), and
  `.cc-alert.yellow`'s `font-size` (`components.css:21`). Evidence is already in this file's gdx-3
  dev-story and gdx-3 Codex-review sections: the first three are emitted nowhere in `public/js/`,
  `public/index.html` or `public/admin.html` (`app.js` queries the `#hdr-profile-menu` **id**, which
  is a different thing); `.prestige-toggle` and `.st-char-dismiss` occur only in the
  repository-root legacy `index.html`, which is not served; `.feed-toggle`'s only grep hits are the
  substring inside `proc-feed-toggles-row` in `public/js/admin/downtime-views.js`, an admin class,
  and `admin.html` does not load `suite.css`. **Why not in gdx-4:** this is removal of live CSS
  surface, not a token substitution, and six of the seven currently carry gdx-3's touch-target rules
  **and** gdx-3 test fixtures (`suite.css:2783`, `2788`, `2859`, `2864`, `2955`, plus `GDX3_PROBES`
  and `GDX3_SIBLING_PROBES` in `tests/desktop-and-css.spec.js`). Deleting the base rules without
  retiring those fixtures breaks the gdx-3 ratchet, and retiring gdx-3 fixtures is a decision about
  gdx-3's AC. Suggested title: *`gdx-13-dead-css-selector-retirement`: delete seven confirmed dead
  declarations and retire their gdx-3 fixtures.*

- **Carve-out 2: three inline `font-size:Npx` literals gdx-2's file-scoped audit could not reach.**
  `public/js/suite/territory.js:368` (`font-size:12px` inside a `selStyle` string),
  `public/js/tabs/downtime-form.js:5662` (`font-size:12px` on `.dt-feed-dim`), and
  `public/js/app.js:2034` (`font-size:11px` on the Player Mode sub-label). All three re-verified at
  their stated lines during gdx-4's audit. **Why not in gdx-4:** gdx-4's AC is colour-scoped, exactly
  as #854's was, and #985 says nothing about `font-size`. More substantively these are gdx-2's
  concern: the right fix is `var(--fs-floor-body)` / `var(--fs-floor-micro)` under gdx-2's own floor
  rules, checked against the ~242 sibling sites `specs/stories/deferred-work.md:570-575` records,
  rather than fixed in isolation. Suggested title: *`gdx-14-inline-font-size-sweep`: retire the three
  inline `font-size` literals gdx-2's file-scoped audit could not reach.*

- **Carve-out 3: the ~17 bare `rgba()` literals in `suite.css` (discovered during gdx-4's audit).**
  Lines 40, 252, 253, 721, 1030, 1319, 1324, 1356, 1363, 1378, 1477, 1478, 1535, 1948, 2259, 2272,
  2297 at the pre-gdx-4 commit: shadows, scrims and tinted fills. Many have a plausible alpha token
  in `theme.css` (`--overlay`, `--overlay2`, `--crim-aNN`, `--gold-aNN`, `--green4-aNN` and about
  sixty siblings) but several have none. **Why not in gdx-4:** matching a hand-mixed rgba to the
  nearest token is a per-site design judgement **in two themes**, not a mechanical substitution, and
  seventeen of those is its own story. `server/tests/gdx-4-css-standards-grep.test.js` deliberately
  asserts these are still present, so sweeping them is a conscious act that updates that test rather
  than something that happens quietly under cover of tidying. Suggested title:
  *`gdx-15-rgba-literal-tokenisation`: match or mint an alpha token for each of the seventeen bare
  `rgba()` sites in `suite.css`.*

- **Carve-out 4: two undefined custom properties in the admin Next Session panel (discovered during
  gdx-4's audit).** `public/js/admin/next-session.js` uses `var(--fh2)` (line 23) and `var(--muted)`
  (line 24); **neither token is declared anywhere in `public/css/`**, verified by grep across all six
  stylesheets. Both declarations therefore silently do nothing today, so the heading falls back to
  the inherited font and the status text to the inherited colour. (gdx-4's story text cited these as
  "lines 22-23"; the real lines are 23 and 24, and they are two different declarations rather than
  one line carrying both.) **Why not in gdx-4:** an undefined token is a live rendering bug whose fix
  **changes what the admin panel looks like**, and Angelus cannot smoke-test locally, so it needs a
  look on a deployed environment. gdx-4 edited line 26 of the same function and deliberately left
  these alone. Suggested title: *`gdx-16-next-session-undefined-tokens`: resolve `--fh2` and
  `--muted` in the admin Next Session panel, with a deployed look before and after.*

- **Carve-out 5: the bare-hex ratchet only ever scanned `suite.css`, not the whole of `public/css`
  AC7 promises (found by the Codex review, 2026-08-20).** `server/tests/gdx-4-css-standards-grep.test.js`'s
  AC3 assertion read only `public/css/suite.css`; a literal reintroduced in any of the other five
  stylesheets could stay green forever. Re-measured with the actual `declarationValues()`/`BARE_HEX`
  predicate (not a naive grep, which mostly matches ID selectors like `#feed-toggle` and GitHub-issue
  references like `#1155` inside comments): `admin-shared.css`, `admin-spheres.css`, `components.css`
  and `layout.css` already have **zero** genuine bare-hex declaration values and are now held to the
  same zero-offender standard as `suite.css`. `admin-layout.css` has **four** genuine, pre-existing
  ones, none related to gdx-4: `.proc-ambience-dir-decrease { color: #c06060 }` (line 5712),
  `.npcr-rels-row.disp-positive`'s `border-left` (`#5a7d3a`, line 9155), `.hd-btn-delete`'s `color`
  (`#fff`, line 9983) and its `:hover` `background` (`#a00`, line 9985). **Why not swept now:**
  matching each to a theme-correct token is the same per-site, two-theme design judgement carve-out 3
  already deferred for `suite.css`'s rgba sites, just in a different stylesheet - bundling an
  unaudited four-site sweep into a review response is how a "quick fix" becomes the next
  `downtime-form.js:5498`. The ratchet now grandfathers `admin-layout.css` at its measured count of 4
  and fails on growth, so a NEW bare hex anywhere in `public/css` is still caught even though these
  four are not yet swept. Suggested title: *`gdx-17-css-hex-ratchet-full-coverage`: tokenise
  `admin-layout.css`'s four remaining bare-hex declarations and drop the ratchet's baseline to zero.*

- **Carve-out 6: a genuine, pre-existing rgba() literal in an inline `style="..."` attribute in
  `public/js/editor/sheet.js`, invisible to AC2's ratchet until the Codex review's fix to it
  (2026-08-20/21).** `sheet.js:456-457`, the Sheet editor's Touchstones panel: `'<span
  class="sh-ts-slot-att" style="color:' + (att ? 'rgba(140,200,140,.9)' : 'var(--txt3)') + '">'` -
  when a touchstone is "Attached" (`att === true`) the span's colour is the bare literal
  `rgba(140,200,140,.9)`; when "Detached" it already uses a token. AC2's original regex stopped its
  value scan at the first quote of EITHER kind, which sat zero characters after `color:` in this exact
  source (`color:' + (att ? ...`), so it was structurally invisible to the old check and has nothing
  to do with gdx-4's own diff - the Codex-hardened regex (quote-matched by backreference) is what
  surfaced it. **Worth noting for whoever picks this up:** `theme.css`'s dark-theme block already
  declares `--green2-a9:rgba(140,200,140,.9)` (line 231) - an EXACT match for the literal in dark
  theme - while the Parchment (default, light) block's `--green2-a9` resolves to a different value
  (`rgba(42,122,74,.90)`, line 57). That means the current code does not just skip tokenisation, it
  renders the dark-theme green on every theme, which is the same "mis-themed by a hard-coded value"
  shape `.dev-preview-btn` had. **Why not fixed here:** `sheet.js`'s Touchstones panel is entirely
  outside gdx-4's file list and was never audited by this story; any colour change needs Angelus's own
  deployed-environment look before shipping, per this repo's own testing discipline (Angelus cannot
  smoke-test locally). `server/tests/gdx-4-css-standards-grep.test.js`'s AC2 describe block carries a
  narrow, explicitly-labelled `DEFERRED_VIOLATIONS` entry for this one site (distinct from AC1's
  compliant-shape `ALLOWED` list) so the ratchet stays green without silently absorbing it. Suggested
  title: *`gdx-18-sheet-touchstone-attached-colour-token`: replace the Touchstones panel's inline
  `rgba(140,200,140,.9)`/`var(--txt3)` conditional with a class toggle backed by `--green2-a9`
  (or the nearest reviewed token), with a deployed before/after look.*
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
- **RULED ON by Angelus, 2026-09-01: `game_session_id` provenance belongs in crd.2/crd.3a, not
  retroactively in crd.1.** (Medium) — `specs/epic-crd-contested-roll-defence.md` (~line 100) puts
  a server-derived `game_session_id` in crd.1's creation shape and explicitly forbids a
  client-supplied one; `contested-rolls.js`'s `POST /` adds no such field, no AC in crd.1 ever
  mentioned it, and the schema does not declare it. Decision: add it where session provenance is
  actually consumed — the player-facing pending queue (crd.2) and the resolve endpoint (crd.3a) —
  not by reopening the already-closed crd.1 story. Every document crd.1 created lacks the field;
  whichever of crd.2/crd.3a takes this on should treat those as pre-migration data rather than
  assume the field is always present. Not yet built — this only settles which story owns it.
  Related precedent worth reading first: the otc-2 entry above, where `game_session_id` on
  `office_actions` is already logged as a caller-supplied, unvalidated, spoofable string — this epic
  should not reproduce that shape.

## Deferred from: independent review of prax-4a-peoples-harpy-resolve (2026-08-30, bmad-epic-loop)

- **`server/routes/praxis-sessions.js`'s `POST /:id/claims`, `DELETE /:id/claims/:characterId` and
  `PUT /:id/support` have no guard against `resolved.<tally>` being non-null** (Medium). Once
  prax.4a's `POST /:id/resolve-harpy` sets `resolved.harpy`, the client hides the pool/claimants UI
  for that tally (structurally, not just disabled controls), but nothing server-side stops a stale ST
  browser tab, or a direct API call, from still opening a new Harpy claim, withdrawing one, or
  reassigning Harpy support afterwards. The frozen snapshot itself (`resolved.harpy.winner_character_id`
  / `final_tally`) is untouched by this either way — only the live `harpy.claims`/`harpy.support`
  arrays underneath it can silently drift from what was true at resolve time. That cuts against the
  "frozen historical record, kept forever" framing prax.4a's own code comments use throughout (AC7:
  "the board keeps its full historical claim/support data forever, alongside the frozen snapshot").
  Real-world exposure is low — it needs two concurrent ST sessions, one of them stale, on an ST-only
  tool with no player visibility — but it is real. Not fixed in prax.4a: that story's own "What this
  story is NOT" section explicitly scoped out touching prax-1's claim/support routes, and the natural
  fix (gate all three routes on `resolved[tally] === null`, mirroring the CAS discipline
  `resolve-harpy` itself already uses) touches exactly those routes. Prax.4b's own resolve route for
  the Praxis tally will want the identical guard for `resolved.praxis`, so this is a natural candidate
  to fix once, for both tallies, alongside that story rather than as two separate patches.
- **RULED ON by Angelus, 2026-09-01: a People's Harpy re-election is a continuation of the same
  tenure, not a fresh one — skip the manoeuvre reset.** `resetManoeuvreRank` used to fire
  unconditionally on `resolve-harpy`'s resolve path, including when the declared winner was the
  SITTING People's Harpy being re-elected, in contrast to `office-seats.js`'s own `PUT
  /:seatId/holder` (AC4), which already treats a same-holder request as not a handover at all and
  skips the reset for exactly this reason. Fixed as part of the 2026-09-01 stranded-branch
  consolidation: `resolve-harpy` now skips the reset when `currentHolderId === claimantId`,
  mirroring the clear-departing-holder skip already in step 5 of the same route. The "sitting
  Harpy re-winning is not a conflict" test in `prax-4a-peoples-harpy-resolve.test.js` now also
  seeds a pre-existing manoeuvre rank and asserts it survives the re-election untouched.

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

---

## Deferred from: code review of crd-3a-server-resolve-endpoint (2026-08-23)

External Codex CLI review (3-pass blinded adversarial protocol, `model_reasoning_effort=high`) of the
server-side contested-roll resolve endpoint found one real, verified finding that predates this story
and is cross-cutting rather than specific to it — deferred rather than patched here, matching the same
reasoning this file already applies elsewhere to pre-existing patterns surfaced incidentally by a
narrower story.

- **`PUT /:id/resolve`, `PUT /:id/accept`, `PUT /:id/decline` and `PUT /:id/void` (all in
  `server/routes/contested-rolls.js`) share a check-then-blind-write TOCTOU race.** Each route calls
  `_findChallenge` (which asserts `status: 'pending'`), does its own work, then issues a final
  `updateOne` filtered on `{ _id: challenge._id }` alone — with no re-check that `status` is still
  `'pending'` at write time. Two of these routes racing the SAME document (confirmed reachable in
  principle: a re-resolve racing `/accept`, or a first resolve racing `/decline`) can both pass their
  own `_findChallenge` check before either writes, then both writes succeed — the later write can
  silently overwrite fields on a document that has already gone terminal (`resolved`/`declined`/
  `voided`) via the other route. In the accept race specifically, the stored `defender_pool` and
  resolution choices could end up describing a LATER resolve while `outcome.defender.pool` and the
  actual rolled dice were generated from an EARLIER pool — internally contradictory audit data on a
  record that has already been rolled and can never be re-rolled.
  - **Read directly and confirmed pre-existing**: `/accept`'s own `updateOne({ _id: challenge._id },
    { $set: { status: 'resolved', ... } })` (unmodified since crd.1) has the identical shape — no
    `status` re-check in its own filter — and so do `/decline` and `/void`. This is not something
    crd.3a introduced, and not something crd.3a made measurably worse; crd.3a's own AC7 already
    addresses the NARROWER "two concurrent resolves" case correctly (full recompute-and-overwrite,
    genuinely idempotent, no partial-merge risk) — this finding is about resolve racing a DIFFERENT,
    terminal-transitioning verb, which is a different race class entirely.
  - **Why deferred rather than patched here**: the correct, honest fix is adding a `status`-scoped
    filter (e.g. `{ _id: challenge._id, status: 'pending' }`, checking `result.matchedCount` and
    409ing on zero) to ALL FOUR routes uniformly — patching only the newest route while leaving the
    other three inconsistent would be worse than leaving all four consistently exposed, since it
    invites the next reader to assume `/resolve` is somehow the risky one. This is real, scoped,
    cross-cutting hardening work across the whole file — its own story, not a drive-by fix.
  - **Reachability note**: exploiting this needs two requests racing within the same narrow window on
    one document; not a click a human is likely to reproduce by accident, but a plausible outcome of
    a double-submit, a retried request, or a defender resolving right as an ST or the attacker's own
    client hits accept/decline. Cheap to fix once scoped as its own story.

**Reviewed and dismissed with evidence** (recorded so they are not re-derived as open work): "awaited
database failures have no local error translation" — true of `/resolve`, but Codex's own Pass 2
investigation confirmed `/accept`, `/decline` and `/void` all share the same no-local-`try/catch`
convention, relying on Express 5.2.1's built-in async-handler rejection catching; established
application-wide behaviour, not a crd.3a-specific defect. "Claimed real-Mongo green gates... are
unverifiable in this review environment" — re-run independently in this session immediately after the
review returned: 172/172 (pre-patch) and 182/182 (post-patch) both reproduced exactly. The reviewer's
own sandbox was denied network access to MongoDB entirely (`EACCES` to the configured host), the same
reviewer-sandbox limitation crd-1's and crd-2's own external reviews hit on port 27017 — not a defect
in the record.

---

## Deferred from: crd.3b design-lock (bmad-agent-ux-designer, 2026-08-23)

- **`.rv2-again-seg button.on` (suite.css/roll-v2.js) likely has a real light-theme contrast defect.**
  Building crd.3b's own resolve-screen mockup (`public/mockups/crd-3b-resolve-screen-mockup.html`)
  by mirroring this control's exact shape and token language surfaced that its `.on` state uses
  `--gold2`/`--gold2-a25`, and in Parchment (light, the default theme) `--gold2` is a dark brownish
  gold (`#7A5208`) that is nearly indistinguishable at 25% opacity against the equally-warm parchment
  surface underneath it — measured directly via a Playwright screenshot comparison, not asserted from
  the token value alone. In dark theme this is invisible as a problem because `--accent` already
  equals `--gold2` there, so the two tokens produce identical output — the divergence is Parchment-
  only. crd.3b's own new components (`.cr-aspect-seg`, `.cr-wp-toggle`, `.cr-merit-chip`) were built
  using `--accent`/`--accent-a25`/`--accent-a40` instead specifically to avoid inheriting this defect,
  confirmed via a before/after screenshot: dark theme is pixel-identical either way, light theme goes
  from a near-invisible selected state to a bold, legible crimson one. `.rv2-again-seg` itself was NOT
  touched — it is pre-existing, shared by the Again-rule control on the live dice roller, and outside
  crd.3b's own scope. Wants its own small story: swap `.rv2-again-seg button.on`'s two `--gold2`
  references to `--accent` equivalents and re-verify the Again-rule control still reads correctly in
  both themes.

---

## Deferred from: code review of crd-3b-client-resolution-screen (2026-08-23)

External Codex CLI review (3-pass blinded adversarial protocol) of the client resolution screen
found one real, verified finding narrow enough to defer rather than patch — a display-only echo of a
data-integrity gap crd-3a's own review already fixed the correctness-critical half of.

- **Schema-valid duplicate character merit rows sharing one `rule_key` render as duplicate, visually-
  linked chips in `public/js/game/contested-resolve.js`.** Selection is keyed on `rule_key` in a
  `Set` (`state.meritIds`), so if a character has two merit rows both carrying, say, `rule_key:
  'closed-book'` (possibly with different `rating` values — a real, reachable shape, since
  `character.schema.js` still has no cross-row `rule_key` uniqueness constraint), toggling EITHER
  chip visually selects both, and only one submitted id reaches the server. The two chips can even
  advertise different bonus previews (each reads its own row's `rating`) while only one row's value
  is what the server actually uses.
  - **Not a correctness bug on the bonus itself**: crd-3a's own code review already fixed the
    server-side double-counting this exact data shape used to cause (`server/routes/
    contested-rolls.js`'s merit-bonus loop now looks up ONE row per resolved `rule_key` via
    `.find()`, so the computed pool is correct regardless of how many chips the client shows). This
    finding is purely about the CLIENT's display being confusing/contradictory for an anomalous
    character, not about the pool number being wrong.
  - **Why deferred**: the real fix is at the data-integrity layer (either enforce `rule_key`
    uniqueness within a character's `merits[]` at the schema/write-path level, or have the client
    dedupe by `rule_key` before rendering chips, keeping only one representative row) — genuinely
    separate scoped work, not a one-off patch to this screen alone, and the underlying anomaly is
    the same one already tracked from crd-3a's own review.
  - **Reachability**: needs a character with two merit rows sharing a resolvable `rule_key`, which
    nothing currently in this codebase's write paths prevents but which also isn't a shape any
    known live character currently has (not checked against live `tm_game.characters` as part of
    this review — a live data-integrity audit, if wanted, is separate work).

## Deferred from: code review of rlv-2-promote-roll-v2-retire-roll-v1 (2026-08-24, internal 3-layer review)

Internal review (Blind Hunter diff-only, Edge Case Hunter diff + full repo, Acceptance Auditor
two-pass spec + Dev Agent Record verification), all three as subagents in this session, since
Codex was unavailable (quota resets 2026-08-27). Two findings patched in the same pass (a stale
`roll.js` comment in `equipment-client-fixes.test.js`, a second stale "Dice" assertion in
`desktop-and-css.spec.js` the dev-story pass had missed) plus the Dev Agent Record's own test-count
inaccuracies corrected (verified via `npx playwright test --list`: 6/6, 7/7, 13/13, not the
originally-recorded 5/5, 8/8, 15/15 — all three files were genuinely fully green either way). The
two below were judged real but out of proportion to fix in this pass, or not this story's to fix.

- **`specs/architecture/system-map.md` §10 ("Dice Roller Implementations") is deeply stale, unrelated
  to and predating this story** (Low, found not caused). It still lists `js/suite/roll.js` as the
  Suite app's roller and the Game app roller as "(missing) — Needs to be built", when the Game app
  roller (`roll-v2.js`, promoted to sole roller by this very story) has existed and shipped for some
  time before rlv.2 ever started. This story's own diff makes the `roll.js` line doubly wrong (the
  file no longer exists at all), but the whole table was already wrong in a much bigger way before
  that. Not patched here — a one-line fix would leave the rest of the table (the "Game app (missing)"
  row, the "DT processing... gold standard" framing) equally misleading, and a proper fix is a full
  re-audit of this doc against the real current roller landscape (`roll-v2.js`, `dice-engine.js`,
  `downtime-views.js`'s own roller, `contested-roll.js`), which is its own scoped task, not a
  one-line patch inside a code review.
- **RESOLVED 2026-08-24 — the predicted sequencing/merge-conflict risk between rlv.1 (PR #1196) and
  rlv.2's own `combat-tab.js` changes materialised exactly as flagged, the day after this entry was
  written.** Original entry (below, kept for the record) recommended merging #1196 first, then
  rebasing rlv.2 — but rlv.2 (PR #1198) merged to `main` first instead, per Angelus's own sequencing
  on the day. Attempting `gh pr merge` on #1196 next surfaced a real conflict in `app.js` and
  `combat-tab.js` (that branch predates rlv.2, still has the whole `rollV1`/`rollV2`/`USE_NEW_ROLLER`
  flag system rlv.2 deleted). Resolution, per Angelus's own instruction: **#1196 closed unmerged**,
  since its fix is fully subsumed by rlv.2's own unconditional `combat-tab.js` wiring — the
  "wrong roller" bug #1196 existed to fix cannot recur once there's only one roller. Its regression
  test was rewritten against post-rlv.2 `main` (no flag) and merged separately as PR #1201
  (`server/tests/rlv-1-combat-tab-quick-roll.test.js`), prove-discriminated (reverted the `goTab`
  target locally, confirmed the exact test failed, restored). Original entry, superseded by the
  above but kept for context:
  - A real sequencing/merge-conflict risk between rlv.1 (PR #1196, open, not merged) and rlv.2's own
    uncommitted `combat-tab.js` changes (Medium, coordination risk, not a code defect). rlv.2's Dev
    Notes assumed "land rlv.1 first" before its own dev-story ran, but PR #1196 was never actually
    merged onto this branch — this branch's `combat-tab.js` still had the ORIGINAL unfixed
    `goTab('dice')`/`import ... from '../suite/roll.js'` code when rlv.2's dev-story started, and
    rlv.2 fixed it directly (correctly, and independently of rlv.1's own fix shape) as part of
    repointing away from the deleted `roll.js`. Recommended handling at the time: merge rlv.1's PR
    #1196 to `main` FIRST, then rebase/recreate rlv.2's branch off the post-merge `main` — overtaken
    by events (rlv.2 merged first), resolved by closing #1196 instead once the conflict was real.

## Deferred from: rlv-2-promote-roll-v2-retire-roll-v1 (2026-08-24, dev-story)

- **`tests/suite.spec.js` has at least 5 of 24 tests already failing, independent of this story**
  (Medium, found not caused, previously undocumented). "starts on Roll tab" (no `.active` class on
  `#t-roll`/element not found), "Roll and Character nav buttons visible" (`#n-roll` not found/not
  visible), "Territory nav visible for ST" (`#n-territory` hidden), "tab navigation works" (60s
  timeout clicking `#n-chars`), and "Player nav button visible" (`#nav-player` — that id doesn't
  exist anywhere in `app.js`'s real `NAV_ITEMS`, looks like a stale selector from a much older nav
  structure). Confirmed via `git stash` isolation: identical failures, same line numbers, against
  the UNMODIFIED base code before this story changed anything (only the "starts on Roll tab" and
  "Roll and Character nav buttons" errors shift from "element not found" pre-change to "found but
  not active/hidden" post-change, because `#t-dice`/`#n-dice` no longer exist for the assertion to
  miss entirely — same underlying failure, not a new one). Stopped investigating past test 12/24
  once the pre-existing pattern was confirmed (this file's mocking/fixture setup looks incomplete
  for the ST/Player nav describe blocks) — full root-cause is out of this story's scope and the run
  is slow (one 60s timeout per pass). Worth a `CLAUDE.md` "Known pre-existing failures" entry and a
  proper investigation story of its own; do not re-derive from scratch, this session already proved
  it's pre-existing twice (stash-isolated on two separate runs).

- **`tests/feature-662-eq3-roll-calc-equipment-chips.spec.js` has 7 of 12 tests already failing,
  independent of this story** (Medium, found not caused, previously undocumented). AC-1, AC-2, AC-3,
  AC-4, AC-7, AC-8 and AC-10 all fail on `#effline .effpool-spec[data-equip]` / weapon-reference
  assertions never finding elements. Confirmed via `git stash` isolation: identical 7 failures,
  same test names, against the UNMODIFIED base code (`goTab('dice')` / `#t-dice`) before this story
  changed anything. Not investigated further (equipment-chip rendering is outside this story's
  scope — `togEquipChip`/`updWeaponRef` are the byte-identical-confirmed functions per the Phase 0
  audit, so the break is more likely in equipment-catalogue data shape or fixture setup than in
  roll.js vs roll-v2.js divergence, but that's a guess, not a finding). Worth a `CLAUDE.md` "Known
  pre-existing failures" entry so a future story's targeted-gate count isn't thrown off by it.

- **`tests/st-only-chrome.spec.js`'s two "Dice tab" nav-visibility tests were already broken before
  this story touched anything** (Low, found not caused). "ST sees Dice tab in bottom nav" only ever
  passed because the `dice`/`roll` `NAV_ITEMS` entries have never carried an `stOnly`/`condition`
  gate in `app.js` — every role has always seen this tab. "Player does NOT see Dice tab in bottom
  nav" was confirmed genuinely failing on a clean baseline run (`npx playwright test
  tests/st-only-chrome.spec.js`, before any rlv.2 code change), independent of this story. rlv.2
  deletes the `dice` nav item outright and consolidates to a single, still-ungated `roll` item, so
  renaming the selector from `#n-dice` to `#n-roll` would not fix the premise — it would just point
  an already-wrong assertion at the surviving tab (the Roll tab is a core player-facing feature and
  should never be ST-only). Both tests were removed rather than renamed; the file's other two tests
  (`#hdr-nav` visibility) are unrelated and untouched. If phone bottom-nav role gating was ever
  meant to hide the Roll tab from players specifically, that's a product decision for Angelus, not
  something to infer from a test that has been wrong on at least one side since before this story.

## Deferred from: code review of rlv-7-persistent-per-power-mod-chips (2026-08-24, external Codex)

- **Pre-built skill-tile fallback drops `roteEligible`/`meritBonus`/`meritLabel` even though the
  source pool object already carries them** (Medium, found not caused — pre-existing, all three
  `app.js` call sites predate rlv.7). `char-pools.js`'s skill-pool loop places `roteEligible`,
  `meritBonus`, and `meritLabel` directly on each pushed pool object (`char-pools.js:129`) but
  deliberately sets that same object's `pi: null` (rlv.4's own review-fixed design — the ad-hoc
  Custom Pool path builds its own `pi` shape). Every `app.js` `onTap` callback that loads one of
  these tiles (`app.js:1149`, `336`, `1286`) falls back to `p.pi || { total, attr, attrV, skill,
  skillV, nineAgain, resistance }` when `p.pi` is falsy — a fallback object that never carries
  `roteEligible`/`meritBonus`/`meritLabel`, even though `p` (the pool object one level up) has them
  right there. Concretely: loading a pre-built Intimidation tile for a character with the "Air of
  Menace" merit shows the numerically-correct boosted total (the merit bonus is already baked into
  `poolTotal` before the tile is built), but `#effline`'s breakdown never shows the "AoM +N" segment,
  and a Professional-Training-5 character's Rote-eligible tile loses its clickable "Rote ✓" cue on
  load (both segments are gated on `pi.meritBonus`/`pi.roteEligible` in `updPool()`, `roll-v2.js`).
  Not fixed here — genuinely pre-existing (confirmed: none of the three call sites were touched by
  this diff, and the same fallback-drops-fields shape exists identically at all three), out of this
  story's own scope (persistent mod chips, not pool-tile fallback completeness). Fix is small when
  picked up: add `roteEligible: p.roteEligible, meritBonus: p.meritBonus, meritLabel: p.meritLabel`
  to each of the three fallback object literals.

## Deferred from: code review of dtui-23-feeding-territory-relocation (2026-08-25, external Codex)

- **Legacy lowercase Blood Type values (`"human"` instead of `"Human"`) render unselected and are
  silently erased to `[]` on the next save** (Medium, found not caused — pre-existing, confirmed
  against base commit `361716b6`). `downtime-form.js`'s Blood Type render case compares the saved
  value against `'Animal'`/`'Human'`/`'Kindred'` with exact `===` (`selectedBlood === bt`), and the
  same case-sensitive comparison already existed in the pre-dtui-23 button-toggle code this story
  replaced. Several repository fixtures carry the lowercase shape (e.g.
  `tests/feat-735-feed-card-terr-pill-and-override-chips.spec.js:67`'s `_feed_blood_types: '["human"]'`),
  meaning at least some historical submissions plausibly do too. Concretely: loading a submission
  with `_feed_blood_types: '["human"]'` renders no Blood Type radio checked, and any subsequent save
  (even one that changes nothing else) collects the checked-radio state and overwrites the field
  with `[]`, silently dropping the player's prior choice. Not fixed here — dtui-23 is a Feeding
  UI-restructure story, not a data-migration story, and normalising legacy casing across whatever
  historical submissions carry it is a separate, broader concern (touches read AND write paths, and
  arguably belongs alongside a data audit of how many live submissions are actually affected). Fix
  when picked up: normalise case on read (e.g. `String(saved).toLowerCase() === bt.toLowerCase()`
  for the render-side match) at minimum; whether to also rewrite stored lowercase values to the
  canonical casing on next save is a product/data decision, not purely technical.

## Deferred from: code review of dtui-22-mandragora-visibility-vitae-calc (2026-08-25, external Codex)

- **`meritEffectiveRating()`'s `CAP_DOMAIN` branch (Haven, Mandragora Garden) doesn't zero the
  result for an unattached anchor, despite the editor's own UI copy claiming it does** (Medium,
  confirmed pre-existing — `public/js/editor/domain.js:363-403`, unrelated to and untouched by this
  story's diff). `_havenCap(c, m)` returns `0` when a Haven/Mandragora Garden merit has no
  `attached_to` anchor set. But `meritEffectiveRating()`'s own arithmetic for that branch is
  `Math.min(effectiveStored, cap || stored)` — when `cap` is `0` (a legitimate falsy return, not
  "unset"), the `||` substitutes `stored` instead, so an unattached merit with e.g. `cp: 2` returns
  effective rating `2`, not `0`. This directly contradicts `editor/sheet.js:1364`'s own warning text
  ("Needs an attached Safe Place or Sepulcher — contributes 0 dots until linked"). Confirmed via
  direct Node import trace of `meritEffectiveRating()` for an unattached `{ cp: 2, xp: 0 }`
  Mandragora Garden: returns `2`. Not fixed here — `meritEffectiveRating()` is the shared, canonical
  effective-rating helper ("use this everywhere", per its own doc comment) used across Haven, the
  editor sheet, and every other domain-merit consumer; a fix belongs to whoever next works in
  `domain.js`, with its own investigation into what Haven's own unattached-anchor behaviour is
  supposed to be (this may be intentional slack during character build, not a bug — needs a ruling,
  not a guess). Likely fix when picked up: `Math.min(effectiveStored, cap > 0 ? cap : 0)` for the
  no-anchor case specifically, while leaving the has-anchor cap logic (`cap || stored` when `cap` is
  a genuine positive number) untouched.

- **The same `CAP_DOMAIN` branch (and the generic non-domain merit path beside it) never reads
  `m.bonus`, even though the editor sheet exposes a working "Bonus" stepper on every domain merit
  row** (Medium, confirmed pre-existing — same file/lines as above). `meritBdRow()`
  (`public/js/editor/xp.js:207-275`) renders a Bonus +/- control for domain merits by default
  (`opts.hideBonus` is only set true for standing merits) and stores it as `mc.bonus`; a SEPARATE
  helper, `domMeritContribSingle()` (`domain.js:43-53`, used for Safe Place/Feeding Grounds'
  multi-instance summing), does read `m.bonus` into its total. But `meritEffectiveRating()` itself —
  the helper `effectiveDomainDots()` (and therefore this session's dtui-22 story) calls for
  Mandragora Garden — sums only `cp + xp + meritFreeSum(m)` in both its `CAP_DOMAIN` branch and its
  generic fallback, omitting `m.bonus` entirely. Confirmed via direct Node trace: an attached
  Mandragora Garden with `{ cp: 0, xp: 0, bonus: 1 }` returns effective rating `0`, even though the
  character sheet displays one usable bonus dot on that row. Not fixed here for the same reason as
  the unattached-anchor gap above — shared helper, cross-cutting, needs its own scoped investigation
  (in particular: is `m.bonus` even meant to count toward CAP_DOMAIN/singleton merits' effective
  rating, or is the Bonus stepper itself a latent no-op for these merit types the way it already
  is — by explicit design — for standing merits like MCI/PT? `xp.js:266-269`'s own comment shows
  this exact "control renders, doesn't actually do anything" pattern has happened at least once
  before and was handled by hiding the control, not by wiring it up).

## Deferred from: code review of admr-2-retire-devlog-admin (2026-08-26, external Codex)

- **`render.yaml`'s `bot` service block declares `ANNOUNCE_DEVLOG_CHANNEL_ID` for a Discord bot
  worker whose `rootDir: bot` no longer exists in this repo** (Low, confirmed pre-existing and
  unrelated to this story's diff — `render.yaml:6,20`). The `bot/` directory was extracted to the
  `TM Herald` sibling repo on 2026-07-20 (per the umbrella `CLAUDE.md`'s topology notes), over a
  month before this session; this render.yaml service block has been stale since then, not as a
  consequence of ADMR-2. `ANNOUNCE_DEVLOG_CHANNEL_ID` is now doubly orphaned as of this story (no
  code in this repo ever reads it, and it named a route this story deletes), but the whole `bot:`
  service block was already dead deployment config regardless of Devlog. Not fixed here — this
  story's diff never touches `render.yaml`, and the real fix (removing or updating the stale `bot`
  service block entirely) is a deployment-config decision, not a code retirement. Found via an
  external Codex review during ADMR-2's own external review pass.

- **`playwright.config.js`'s `webServer.command` runs `npx http-server public -p 8080 -s`, but
  `http-server` is not a declared `devDependency`** (Low, confirmed pre-existing and unrelated to
  this story's diff — `playwright.config.js:11`, `package.json` declares `serve` instead). In a
  network-restricted environment (no npm registry access), `npx http-server` fails outright rather
  than falling back to an already-installed package, causing every Playwright run to time out before
  a single test executes. Confirmed this genuinely reproduces in a sandboxed environment (an external
  Codex review's own sandbox hit exactly this failure); confirmed it does NOT reproduce in this
  session's own working environment (network access to the npm registry available, `npx
  playwright test` succeeds normally). Not fixed here — neither file is touched by this story's
  diff, and the real fix (declaring `http-server` as a devDependency, or switching the webServer
  command to the already-declared `serve` package) is a repo-hygiene item, not specific to Devlog.

## Deferred from: code review of oxp-9-spend-routes-through-oaq (2026-08-27, external Codex, 3 isolated passes)

- **`office-tab.js`'s purchase-request control is not disabled while its own POST is in flight**
  (Low, UX only — `public/js/tabs/office-tab.js:853-866`, `_submitPurchaseRequest`). The handler
  awaits `apiPost` without first marking the button busy, so a double-click fires two submissions.
  This was the CLIENT-side trigger Codex pass 1 named for the one-pending-per-seat race, and pass 2
  used it to reproduce a real double spend (a burst created ten pending rows for one seat, two of
  which were then accepted onto the same merit). **The defect itself is fixed** — this review round
  added the partial unique index on `{ seat_id }` that arbitrates it authoritatively at the database
  level, plus a duplicate-key-to-409 translation, plus a concurrency regression test; see the story's
  Senior Developer Review section. What is left is purely cosmetic: the second click now gets a
  toast reading "A purchase request is already pending for this seat", which is correct but reads as
  an error for what is really just an impatient user. Adding a busy lock (disable, await, re-enable
  under the existing `el._officeManoeuvreGen` generation guard, the same shape `_adjustMeritDots`
  would need) would make the second click a silent no-op instead. Not done here: the patch round was
  scoped to correctness findings and this touches a client render path with its own generation-guard
  invariants, so it wants its own story rather than a drive-by edit inside a review round.

## Deferred from: independent review of prax-1-schema-scaffold (2026-08-29, bmad-epic-loop)

- **`PUT /api/praxis_sessions/:id/support`'s claimant-still-open check is not atomically race-closed**
  (Low - `server/routes/praxis-sessions.js`, the support-assignment route). AC5's own duplicate-claim
  guard and AC6's own withdraw route both close their equivalent race with an atomic filter inside the
  write itself; this one instead reads the board snapshot at the top of the request and checks the
  claimant is still open against THAT read, not a filter re-checked at write time. A support
  assignment made in the same instant as a concurrent withdrawal of that same claimant could
  theoretically land after the claim is already gone. Real-world exposure is negligible - this is a
  single-ST, sequential-tap admin tool with no UI that could even attempt two concurrent writes today
  - and any resulting orphaned support entry self-heals the next time that claimant is withdrawn
  again (AC6's own cascade filters on current support values every time it runs, not just once).
  Not fixed: not required by any AC as written, and prax-1 was independently re-verified and marked
  done on the strength of every AC it DID promise. Flagged here so prax-4a/prax-4b (both resolve
  paths, both reading claim/support state as a resolve-time source of truth) know the theoretical gap
  exists if either ever needs a stronger guarantee than "correct barring a same-instant race."

## Deferred from: independent review of prax-2/prax-3 (2026-08-29, bmad-epic-loop)

- **`server/tests/gdx-4-css-standards-grep.test.js`'s "leaves the compliant var() fallbacks in place"
  assertion fails at base, on `main`, with no PRAX changes present** (Low - pre-existing, confirmed via
  `git stash` A/B during both prax-2's and prax-3's own independent reviews, run again independently
  each time with the same result). The assertion checks `public/css/suite.css` only, a file no PRAX
  story touches (all PRAX CSS lives in `admin-layout.css`), so it is unrelated to this epic's own
  work - but it is also not in root `CLAUDE.md`'s own "Known pre-existing failures" list, so anyone
  who hits it cold will spend time re-diagnosing something already known. Not fixed here (out of
  scope for a UI-board epic to go patch an unrelated CSS-standards test), but worth its own line in
  `CLAUDE.md`'s known-failures list the next time that file gets a maintenance pass.

## Deferred from: independent review of prax-4b-head-of-state-resolve (2026-08-30, bmad-epic-loop)

- **`office-tab.js`'s new `praxis_resolved` WS wiring can never reach the player it is for**
  (Medium - `public/js/tabs/office-tab.js`'s `onPraxisResolved`, wired via `public/js/app.js`).
  `server/ws.js`'s `broadcastPraxisResolved` fans out to `['st', 'dev']` roles only (the same,
  correct scope every other route in `praxis-sessions.js` uses, since Praxis tally/vote data must
  never reach a player socket) - but `office-tab.js` is loaded by `app.js`, the PLAYER Suite app
  (`public/index.html`), not the ST admin app, and the actual audience for a post-resolve office-tab
  refresh is the affected PLAYER themselves: the new Head of State, or whoever just lost
  Enforcer/Administrator/City Harpy/People's Harpy/the old Head of State seat. A real player's own
  Office tab will show stale purchase controls and budget preview - a seat they no longer hold, or one
  they now do but the tab does not yet know it - until they manually reload the page or switch domains
  away and back. `city-views.js`'s own wiring (via `admin.js`, correctly ST-only) has no equivalent
  problem. Bounded impact, not a security gap: `server/routes/office-purchase.js` independently
  re-validates `holder_id` server-side before any purchase commits, so a stale client can never let a
  wrongful purchase actually go through - this is UX staleness, not data integrity. Root cause: the
  story's own spec (written by the orchestrator, before this session confirmed the real file layout)
  assumed `office-tab.js` lived under `public/js/admin/`, an ST-only surface; it does not. **Not fixed
  here** - the real fix (broadening `broadcastPraxisResolved` to reach the affected player
  specifically, or to all roles outright - arguably safe, since `court_category`/`court_title` are
  already ordinary player-visible character-sheet fields and only the tally/vote *process* itself is
  meant to stay ST-only) is a genuine scope/architecture call that deserves its own decision, not a
  drive-by patch inside this story's own review pass.

## Deferred from: rcv-2-three-independent-accordions code review (2026-08-30)

Independent review found `.gcp-choice-wide` (`public/css/suite.css`) and `choiceBtn()`'s own `wide`
parameter (`public/js/game/char-pools.js`) are now fully dead code - the only live caller that ever
passed `wide: true` was the old "+ Custom Pool" grid tile, which rcv.2 relocated out of the tile grid
entirely into its own standalone `.gcp-freebuild-btn`. Confirmed via grep: no remaining `choiceBtn(...,
true)` call anywhere in the file.

**Not removed as part of rcv.2** - the story's own AC9 named a specific, deliberately scoped list of
CSS to retire (`.gcp-section-hd`, `.gcp-collapse-btn`, `.gcp-pools-wrap`, `.gcp-all-collapsed`), and
`.gcp-choice-wide` wasn't on it; expanding the deletion mid-implementation would also require editing
`tests/rlv-4-custom-pool-builder.spec.js`'s own CSS-presence smoke test (`suite.css contains the
scoped-panel and choice-tile classes`, which asserts `.gcp-choice-wide` is present), a second test file
beyond the two rcv.2 already had to touch for its own DOM restructure - judged real scope creep, not
this story's job. Revisit whenever `rlv-4-custom-pool-builder.spec.js` itself is next touched, or as a
small standalone dead-code cleanup story.

## Deferred from: rcv-3a-rules-explanation-disciplines-rites code review (2026-08-30)

Three internal review layers (Blind Hunter/Edge Case Hunter/Acceptance Auditor, run after two failed
external Codex attempts on a corrupted models cache) converged on two real bugs, both patched (see the
story's own Senior Developer Review). A handful of smaller findings were judged real-but-narrow enough
not to block the story - deferred rather than patched:

- **A power whose cost data is a truthy legacy `cost` string but resolves to an empty formatted line
  (e.g. structured `vitae_cost:0, willpower_cost:0` alongside a non-empty legacy `cost`) opens the
  Rules-explanation box onto a completely empty body.** `roll-v2.js`'s `updRulesSummary()` gate treats
  a truthy `pi.cost` as reason enough to show the box, but `fmtCostLine()`'s own "confirmed free"
  branch can still yield `''` for that same `pi`, and if `action`/`duration`/`effect`/`rules_text` are
  also all absent, `metaHtml + descHtml + expanderHtml` is `''` too - an empty disclosure. Real
  reachability is low (requires a rule doc carrying both a legacy `cost` string AND confirmed-zero
  structured costs AND no action/duration/description/rules_text simultaneously) and unverified against
  live data. Fixing it properly means restructuring the gate to check what will actually render, not
  just whether any one field is present - a real but non-trivial change this story's own patches didn't
  reach for. Revisit if a live report of an empty "Rules explanation" box ever surfaces.
- **Whitespace-only `action`/`duration`/`effect`/`cost` strings survive `getPool()`'s `|| null`
  normalisation** (only falsy values - `''`, `null`, `undefined` - are caught) **and render a blank
  chip/line with its bullet separator still present.** Cosmetic only; requires a hand-edited rule doc
  with a whitespace-only field, which nothing in the admin tooling currently produces.
- **The new box is horizontally misaligned with the `.rv2-breakdown` disclosure directly below it** -
  `.rules-summary` carries no side padding of its own while `.rv2-breakdown` has `padding:4px 16px
  8px`, insetting the two stacked disclosures' content by 16px per side differently. Purely visual.
- **A long unparsed legacy `cost` string** (e.g. `"3-9 V & 1 WP"`, `"Free / 1 V"`) **can compress the
  "Rules explanation" label and clip on a narrow phone viewport** - `.power-cost` is `white-space:
  nowrap` inside a `justify-content:space-between` flex header with only the label able to shrink.
  Not measured at a real viewport; flagged from static CSS reading only.

## Deferred from: rcv-4-surface-mod-chips implementation (2026-08-30)

Real, pre-existing defect found while relocating the persistent mod-chip UI, not introduced by that
story and out of its own scope to fix (it explicitly forbids adding new CSS):

- **A persistent mod chip's own "x" delete affordance is not actually pointer-reachable by a real
  click, anywhere it has ever rendered.** `gdx-3`'s own 44px touch-target overlay
  (`public/css/suite.css`, `.effpool-spec::after`, `:3190,3239-3248` - absolute, centred,
  `min-width`/`min-height: var(--tap-min)`, deliberately NOT `pointer-events: none`) covers the whole
  chip including its own "x" child, so a real click aimed at the x's centre hits the parent chip's own
  toggle handler (`togPowerChip`) instead of the delete handler (`removePowerChip`). Verified via
  `document.elementFromPoint` at the x's exact centre in both the chip's old container (`#effline`,
  pre-rcv.4) and its new one (`#rv2-power-chips`, post-rcv.4) - identical result in both, confirming
  this is container-independent and predates rcv.4 entirely (most likely present since gdx-3's own
  touch-target work landed, or since rlv.7 first added the delete affordance on top of it, whichever
  came later - not investigated further here). Real-world impact is likely narrow (a touch tap and a
  mouse click both resolve through the same DOM hit-test, so a player probably experiences this as
  "sometimes toggles instead of deleting" rather than "delete never works" depending on exact tap
  position within the 44px zone) but it is a genuine, reproducible UI defect, not a test artifact -
  `tests/rlv-7-persistent-mod-chips.spec.js`'s own delete test now dispatches the click event directly
  rather than relying on Playwright's real pointer geometry, to keep asserting the DELETE HANDLER's own
  correctness without being blocked by this separate, pre-existing hit-testing issue. Fix needs a CSS
  change (either `pointer-events: none` on the "x" specifically within the overlay's own stacking
  context, or a z-index/positioning adjustment so the delete child sits above the touch-target overlay)
  - a small, real, standalone fix, not urgent enough to justify a dedicated story on its own but worth
  picking up alongside the next real touch-target-adjacent piece of work.

## Deferred from: dtlt-1-bonus-success-mechanic code review (2026-08-31)

External Codex review, three isolated passes (Blind Hunter, Edge Case Hunter, Acceptance Auditor —
Pass 3 hit a ChatGPT usage limit after completing only its blind sub-pass, 3a). Both fully-completed
passes independently converged on the same stored-XSS defect and the same "players can't reach it"
architectural fact from different angles - real signal, not noise. Four findings were patched (XSS
escaping in `roll-v2.js`, the Feeding ST-confirmed-pool stale-trait-context bug, the repeatable-merit
rating-undercount in `_count()`, and a `getRulesBySource` consistency gap) - see the story's own Senior
Developer Review for the full triage and prove-discrimination detail. The remainder, judged real but
not worth blocking on:

- **RULED ON by Angelus, 2026-08-31: ship dtlt-1 as-is.** The entire rules-engine (all nine families,
  including the new `rule_bonus_success`) is mounted behind `requireRole('st')`, so a normal player's
  client can never populate the rules cache at all - confirmed pre-existing (issue #249's
  `applyDerivedMerits` null-cache guard and the issue #256 comment in `app.js` both already document
  and gracefully degrade around exactly this), not introduced by dtlt-1. Both Codex passes independently
  rated this High and both made the same sharper point worth surfacing: an ST/dev tester will see
  Stronger Than You fire correctly and reasonably conclude the feature works, while no actual player's
  own session ever receives it - the ST-authorized path masks the gap rather than exposing it.
  **Investigated further before the ruling** (correcting this entry's own first-draft framing): unlike
  what "every rule family already no-ops for players" implies, only `rule_bonus_success` is genuinely
  stuck - Vigour/Resilience (`discAttrBonus()`, `accessors.js:122`) has a deliberate legacy hardcoded
  fallback that still works with no cache at all, and MCI/PT/K-9/Falconry grants affect persisted merit
  dots, so a player's own already-saved rating is unaffected by their client's inability to recompute
  the grant live. A bonus success has no persisted equivalent - it only exists at roll time - so this is
  the first rule family with no possible escape hatch, not just another instance of an old, already-
  worked-around gap. Angelus's decision: ship now, correct for ST-run/ST-confirmed rolls and downtime
  processing, degraded only for a player's own direct live roll; open a separate future story if the
  rules-engine's player-auth boundary itself should change. Not blocking, not revisited here.
- **[Low] Whitespace-only predicate `name` (e.g. `'   '`) passes both the JSON Schema and
  `checkBonusSuccessDoc`'s `minLength: 1`, and matches a live roll surface's own empty-string trait
  normalisation** (`roll-v2.js` sets `attr: ''`/`skill: ''` on a contextless chance roll; `_sameName`
  trims both sides, so `''` matches `'   '`). Requires an ST to author a malformed rule with a
  whitespace-only name - an authoring-discipline gap, not a reachable player-facing bug. Fix is cheap
  (trim before the `minLength` check, or reject an all-whitespace name explicitly in `checkBonusSuccessDoc`)
  whenever the admin editor UI for this collection is built (already a deferred follow-up per this
  story's own "Final consequence").
- **[Low] A `rule_bonus_success` document that reaches the aggregate read path with `count_basis: 'flat'`
  and no `flat_amount` (only reachable by bypassing POST/PUT - a direct DB write or corrupt import)
  defaults to `+1` via `rule.flat_amount ?? 1` rather than being skipped**, which is inconsistent with
  the evaluator's own stated "malformed docs are skipped" posture. The normal write route already
  rejects this shape (`checkBonusSuccessDoc`), so operational likelihood is low. Worth a defensive
  `_int(rule.flat_amount)` (treating a missing amount as 0, not 1) if this collection ever gets a bulk
  import/migration path.
- **[Low] `_int()` (the private numeric-coercion helper in `bonus-success-evaluator.js`) throws a
  `TypeError` on a `Symbol` or null-prototype-object input to `Number(...)`**, rather than returning 0
  like every other malformed input. No current call site can reach this (all real callers pass numbers
  or plain falsy/string values), so it's a latent hardening gap, not a live defect.
- **[Low, test-coverage only] The Vigour-2 "regression" row in `bonus-success.test.js` proves Stronger
  Than You does not fire for a Vigour character; it does not build an actual Strength+Brawl pool and
  assert the pool size still includes Vigour's own `rule_disc_attr` dot contribution.** The production
  Vigour code itself is untouched by this diff (confirmed directly - no changes anywhere near
  `rule_disc_attr`, its evaluator, or `seed-rules-disc-attr.js`), so the claim the test's own comment
  makes ("Vigour and Resilience stay in `rule_disc_attr`") is true - it's just proven by inspection of
  the diff, not by this specific test. A real pool-building integration test would need to pull in the
  character-render pipeline this evaluator's test file deliberately avoids importing (part of what
  keeps it pure/import-free per its own docblock) - out of proportion for this story's own scope.
- **[Low, dismissed - fixture-realism only, not a defect] `bonus-success.test.js`'s fighting-style
  fixtures carry a `rating` field the real `fightingStyle` schema definition doesn't have**
  (`character.schema.js`'s definition has `cp`/`xp`/`free`/`free_mci`/`free_ots`/`up`/`picks`/`rule_key`,
  no `rating`). Harmless: the evaluator's `manoeuvre_present` predicate only ever reads
  `fighting_picks`, never `fighting_styles`, so the extra field is inert. Already disclosed in the
  story's own Dev Agent Record before external review ran.

## Deferred from: cross-repo redundancy review (2026-08-25, TM Admin liaison)

- **No compare-and-set on `merits`, `powers`, `status`, `court_title`/`court_category`, or
  `equipment` — last-write-wins on all five, confirmed real by TM Admin against their own code**
  (Medium-High; both apps' admin character editors do a full-document `PUT /api/characters/:id`
  with a blind `$set: updates`, `server/routes/characters.js:502-665`). `WRITE_ONCE_FIELDS` in
  `server/lib/character-write-once.js` is `['clan', 'bloodline']` only — the sole compare-and-set
  protection anywhere on this document. Two STs (one in TM Game, one in TM Admin) editing the same
  character around the same time, or a concurrent write racing a player self-service route, can
  silently drop whichever save landed first. `merits` is the highest-risk of the five: it's also
  written by TM Game's own player self-service routes (`safe_place_locations`, `carthian_pull`),
  not just the two ST editors — three independent writers on one field with zero conflict
  detection between any pair of them. Not fixed here — this is a real design question (per-field
  version tokens? optimistic concurrency on the whole document? something narrower matching just
  the fields both apps' editors actually touch?), not a bounded pattern to port the way the
  ordeals-array race was (see the two entries directly above this one, and the sibling fix on
  branch `ms/issue-ordeal-cascade-atomic-write`). Needs a scoped conversation with Angelus on
  approach before anyone builds it, not an improvised fix. Cross-referenced in TM Admin's own
  liaison notes from the same review.

- **Roughly ten `public/js/admin/*.js` modules are confirmed redundant with TM Admin and safe to
  retire, at Angelus's discretion — not urgent, dead code rather than dangerous code** (unlike the
  two entries above). Confirmed via an independent fork reading TM Admin's own `specs/sprint-status.yaml`
  and cross-checking each module against it: `players-view.js` (2.1 Players, done), `city-views.js`
  + `spheres-view.js` (2.4 City+Spheres, done — Prestige/Influence calc specifically flagged
  "PARTIALLY IN" by TM Admin's own story, blocked on porting `meritEffectiveRating`, so don't touch
  that one sub-piece yet), `attendance.js` (2.3 Attendance & XP, done), `ordeals-admin.js` (Epic 3/4,
  done), `equipment-catalogue-admin.js` (4.1, done), `rules-data-view.js` + `rules-view.js` (4.2/4.3,
  done), `st-mods-panel*.js` + `st-mods-audit.js` (4.4a/4.4b, done), `bloodlines-admin.js` (6.1,
  done), `devlog-admin.js` (6.2, done). `cycle-views.js`/`next-session.js`/`session-log.js` likely
  covered by 2.5 Chapters & Stories (done) but session-log specifically wasn't verified — check
  before retiring. **Do NOT touch**: the character editor (`admin.js`'s own sheet-edit path — TM
  Admin's 2.2b port covers only ~11 of ~60 handlers as of 2026-08-25, still `review` not `done`, and
  TM Admin's own session explicitly said not to retire this yet), the Downtime admin modules
  (`downtime-*.js`, TM Admin's Epic 5 is `not-storied`, gated behind a tm_game→tm_story storage
  migration not yet reached), and `data-portability*.js`/`excel-merge.js`/`excel-parser.js` (TM
  Admin deliberately dropped the Excel-merge tool as legacy rather than porting it — Angelus already
  called it dead weight, but that's a separate call from "TM Admin replaced it"). Not retired here —
  deliberately deferred rather than rushed at the end of an already-large session; do as its own
  scoped pass, probably one module (or a few related ones) at a time rather than one big sweep, per
  Angelus's own explicit steer 2026-08-25. See also `specs/architecture/adr-008-admin-merge.md`
  (marked superseded the same day — TM Admin's separate-app approach is the actual direction, not
  ADR-008's merge-into-one-app plan) for the broader architectural context this sits inside.

## Deferred from: issue-1132-write-once-violation-audit-log code review (2026-08-31)

External Codex CLI review, 3-pass single session, high reasoning effort. No High-severity finding.
Two patched and prove-discriminated (a non-Error rejection in the audit insert's catch block could
itself throw, turning the 409 it guards into a 500; the documentation schema couldn't represent every
value the module promises to preserve) - see the story's own Senior Developer Review for the full
triage. One real finding deferred rather than fixed:

- **[Medium, deferred] The best-effort audit insert (`write-once-violation-log.js`'s
  `recordWriteOnceViolations`) is `await`ed with no local time bound, so a stalled MongoDB/network
  connection delays the 409 it sits in front of indefinitely rather than merely risking it becoming a
  500.** Real, but not unique to this story: `xp_ledger`'s own insert at the identical call site in
  `characters.js` (`PUT /:id`, line ~733) has the exact same shape and is equally unaddressed - this
  story's own module explicitly says it mirrors that established precedent ("Same guarantee xpl.1's
  ledger insert makes, for the same reason"). Fixing it here alone, without touching the pattern it
  deliberately copies, would leave the codebase with two inconsistent versions of the same risk rather
  than resolving it. Needs a decision on the general pattern (a bounded local timeout on the insert, or
  detaching it entirely with a fire-and-forget + logged-rejection shape), then applying it to both call
  sites together. Suggested title: `bound-best-effort-audit-inserts` (no issue number assigned; opening
  a GitHub issue for it is Angelus's call).

## Raised from TM Story's own deferred-work.md (items #384/#385), Angelus's ruling 2026-09-01

TM Story (read-only consumer of `tm_game`) found two real data gaps it cannot fix itself. Both ruled
by Angelus 2026-09-01; not yet actioned here.

- **["Mantle of Amorous Fire" rite: deliberate rename, 2 real characters need migrating.] The live
  `purchasable_powers` catalogue re-keyed AND renamed this rite (`rite-mantle-of-amorous-fire` →
  `rite-the-mantle-of-amorous-fire`, "Mantle of Amorous Fire" → "The Mantle of Amorous Fire").
  Brandy LaRoux and Jack Fallow both already hold this rite, stored under the OLD key — TM Story's
  own rite picker can no longer resolve it for either character (neither a stale-key nor a
  folded-name match works, since the article makes the strings differ), so it's honestly omitted
  from both characters' pickers there rather than guessed at.** Angelus confirmed the rename was
  intentional (not catalogue drift) — the fix is to migrate Brandy LaRoux's and Jack Fallow's own
  stored rite key/name to the new catalogue values, not to revert the catalogue. A `tm_game` write;
  TM Story cannot make it. Full context: TM Story's `specs/deferred-work.md` item #384.

- **[`rule_key` backfill gap — 60 of 68 real character rite power instances carry no working join
  key at all.] A catalogue-wide data-hygiene gap on the character side, not the catalogue side (the
  catalogue's own `rule_key` values are fine — TM Story's own item #383 already confirmed this and
  made its rite picker resilient to the gap via a folded-name fallback).** Any future feature —
  in TM Game, TM Admin, or TM Story — that joins character-side rite data on `rule_key` inherits the
  same risk #383 just patched around for one consumer. Angelus ruled this should be a real,
  scoped backlog item here (or in TM Admin) rather than just a note — a permanent `rule_key`
  backfill across affected characters' rite instances. Unscoped, unprioritised as of this entry.
  Full context: TM Story's `specs/deferred-work.md` item #385.

## Deferred from: tm-admin.12.4 (visual recompose review), 2026-09-10

External Codex review of Story 12.4's own follow-up fix (`758f20b5`, TM Admin specs) found that
`tests/fix-475-feeding-vitae-pipeline.spec.js` and `tests/fix-477-vitae-tally-status-filter.spec.js`
have been genuinely broken since well before this story — real repository history confirms it, not
just assertion: both specs' cycle mocks only set `status: 'game'`, but the canonical phase reader
(added in a later change than the mocks) derives `"prep"` from the absent `phase`/`game_phase`
fields, so `getFeedingCycle()` returns `null` and both specs never get past the tab's own "Feeding
rolls open when the Storyteller opens the game phase" placeholder — none of their real assertions
(territory-precedence, ambience/status behaviour) currently execute.

**The fix is real, small, and already verified by the reviewer**: add `phase: 'game', game_phase:
'game'` alongside the existing `status: 'game'` in both mocks' cycle fixture. Directly exercising
`public/js/downtime/cycle-phase.js` confirmed this resolves phase to `"game"` and opens feeding
(current mock: derived phase `null`, feeding closed; with the fix: phase `"game"`, feeding open).

**Not fixed as part of Story 12.4** because it's pre-existing (dated to a May/August mismatch between
when the mocks were written and when the phase reader was added) and unrelated to what that story
actually changed (a CSS class rename) — Story 12.4's own dev pass attempted this exact fix, reported
it didn't work, but the external review's own direct verification found it does. Whoever picks this
up should re-verify against the live file rather than trust either prior claim uncritically, then
apply the fix and confirm both specs' real assertions execute (not just reach the phase-open state).

## Deferred from: tm-admin.12.8 (feeding vessel-heal/tracker write-back) independent re-verification, 2026-09-11

**`doFeedingDeclaration()` (the Save-click handler, `public/js/tabs/feeding-tab.js`) has no
independent marker check of its own**, unlike the AC 14 fix applied to the ST-confirm handler in this
same story (which guards the write in both the render AND the handler, "the second lock on the same
door"). `doFeedingDeclaration()` relies entirely on `feedDeclarationLocked()` having kept the Save
button un-rendered/un-clickable. Analysis at review time: real risk is low, because this app rebinds
event listeners to freshly-rendered DOM elements on every `render()` call (no event delegation), so a
detached/stale button cannot receive a genuine user click in a real browser — only a programmatic
`.click()` on a retained node reference (exactly the "positive control" pattern the AC 14 test itself
uses) could reach it, which is not a real user path. The `_feedingMarkerGuard` fix added to
`applyFeedToTracker()` during this same review (server/routes/tracker.js's conditional write) happens
to close the practical consequence anyway, since both `doFeedingDeclaration()` and
`maybeReconcileFeed()` share that one function. Left here as a consistency note: if
`doFeedingDeclaration()` is ever refactored to call something other than `applyFeedToTracker()`
directly, re-add an explicit marker check at the top of the handler rather than assume the render
gate is sufficient.

**A zero-success feed against a character with zero EXISTING Aggravated damage renders no Save
control at all in TM Game's Feeding tab** (`renderFeedDeclareControl()`'s own `!hasVessels &&
!hasHealing` early return — `hasVessels` is false for a zero-success roll, `hasHealing` is false when
`tracker.aggravated` is already 0). This is narrower than the already-documented "known narrowing"
gap in `renderFeedAggHealing()` (which is about not being able to SPEND on healing pre-save): here,
a player who fed for zero successes but has a real, positive `vitaeProjection().net` (territory
ambience plus Herd/Flock) and no Aggravated damage to heal has no way to trigger ANY declaration
through this tab at all — not even a "no vessels, no healing, just bank the Vitae" save — and must
record it through TM Story's own downtime form instead. Low severity (a real, working correction
route exists), not fixed as part of this story since the button's own gating logic would need a
third condition (a positive server-estimated total) that this tab cannot compute pre-save without
either a dedicated probe endpoint or the same pre-save-`fedTotal` gap already named in the "known
narrowing" comment. Revisit alongside that gap if it's ever closed.

## Deferred from: live incident (Aleksei Romanov blood-type toggle hotfix), 2026-09-18

**Angelus's own future-scope flag, not yet built**: when a player (or the ST, acting on a player's
behalf) clicks Roll Feeding — an irreversible action — the character's current Vitae pool should be
explicitly cleared to 0 at that moment, so that whatever amount is later confirmed from vessel draws
is guaranteed to be added to a genuinely empty pool, not whatever the tracker happened to hold going
in.

**Where this sits today, verified against live code**: `doFeedingRoll()`
(`public/js/tabs/feeding-tab.js:3041-3070`) — the irreversible roll click handler — does not touch
`tracker_state`/Vitae at all; it only posts the roll result to the submission and re-reads it.
The only Vitae write happens later, at confirm/declare time, in `applyFeedToTracker()`
(`:3189` onward), which per [[feedback_vitae-never-carries-over-write-is-absolute-set]] already does
an absolute set (`clamp(fedTotal - spent, 0, max)`) rather than a delta-add — the 2026-09-14 Etsy
incident that rule documents is fixed at THIS point.

**Why this is still worth building, not just theoretical**: the current correctness depends entirely
on `applyFeedToTracker()`'s math staying right forever, with no earlier invariant enforced. Angelus's
ask adds a second, independent guarantee at the earliest possible moment (the irreversible roll
itself) rather than trusting the later confirm-step write alone — the same "second lock on the same
door" discipline already applied to the marker-guard fix noted in the tm-admin.12.8 entry above, just
one step earlier in this flow. Would also close any hypothetical window between roll and confirm
where a manual tracker edit or an unrelated write could leave stale Vitae the confirm step's own
absolute-set math never gets a chance to correct, since it only runs once, at declare time.

**Not scoped or built.** Whoever picks this up should re-verify `doFeedingRoll()`'s current behaviour
against live code first (this entry is dated 2026-09-18; the function may have changed), then decide
where the zero-write belongs — inside `doFeedingRoll()` itself, or in the server route
`postStoryFeedingRoll()` calls into, so it can't be bypassed by any other roll entry point.

## Deferred from: live Breaking Point/bane rulings (Yusuf Kalusicj, Orenthal Lamar McGillicuddy), 2026-09-18

**Angelus's own tech-debt flag**: the Humanity/Detachment check roll in the dice roller doesn't
apply a dice penalty for a held detachment bane. Every bane carries a standing "−1 die to all future
Detachment rolls" cost (`st-rulings-log.md`, the Charlie Ballsack precedent and this session's own
Yusuf/Orenthal entries) — nothing enforces it mechanically today.

**Verified, not just assumed**: `detachmentDicePool({ humanity, level, touchstoneMod, meditativeMindBonus })`
(`TM Story/public/js/downtime-form/feeding-reference.js:423`) is the only Detachment-pool-sizing
function in either repo — it takes a touchstone modifier and a Meditative Mind bonus, but no
bane-count/bane-penalty parameter at all. Grepped both repos for `detachmentDicePool` and for
`Detachment` generally: TM Game's actual dice roller (`public/js/suite/roll-v2.js`) has **no
Detachment-specific roll path whatsoever** — no hit for either term. A Humanity check today is very
likely run as a manual/custom pool the ST sizes by hand, which means a bane's −1 is only ever applied
if a human remembers to subtract it every time, for every bane a character holds simultaneously (no
cap enforcement observed either — see the Mekhet "Additional Bane does not count towards Bane cap"
errata note, implying a cap exists and multiple banes can genuinely stack).

**Not scoped or built.** Two real gaps, either could be its own story: (1) `detachmentDicePool()`
needs a bane-count parameter, mirroring how it already takes `touchstoneMod`; (2) there may be no
dedicated Detachment roll path in TM Game's live roller at all, which is a bigger question — worth
checking against Epic RCV/RLV's own scope (both closed/done) before assuming this needs new roller
surface versus just a formula fix to an existing manual-pool flow.

## Deferred from: Game 8 equipment audit, 2026-09-18 — combat module is equipment-aware for weapons, NOT for armour

**Angelus's own flag, verified against live code.** `public/js/game/combat-tab.js` genuinely IS
equipment-aware for weapons — it reads a character's `equipment[]`, resolves each entry via
`getCatalogueEntry(item.catalogue_id)`, and pulls real `damage_mod`/`damage_type` for attack
resolution (confirmed live: `isEquipmentOnMe()` filters to carried/worn states, `damage_mod` read
at line ~865-871). **Armour is a different story**: `calcDefence`/`calcHealth`
(`public/js/data/accessors.js`, imported by `combat-tab.js`) have **zero reference to
`armour_value` or `equipment` anywhere in that file** — grepped directly, no hits. So a character's
equipped armour (`armour_value`/`defence_penalty` on a catalogue item) currently has **no
mechanical effect on combat at all** — tracked on the sheet, never read for defense.

**Why this is live-relevant today, not theoretical**: this session applied real armour items to
several characters' sheets (Yusuf's 10 Ballistic Vests, Eve's custom armoured undershirt, Charlie's
tailored sports gear, Wan/Clarence/Ryan's vests) as part of the Game 8 equipment pass. None of that
armour currently does anything in a Combat-tab fight — only their weapons would show any real
mechanical effect.

**Not scoped or built.** Real candidate story, likely folding into Epic CMB (the combat-panel
rebuild, currently all-backlog): `calcDefence`/`calcHealth` (or their CMB-rebuilt equivalents) need
to read equipped armour's `armour_value`/`defence_penalty` the same way weapon resolution already
reads `damage_mod`. Whoever picks this up should re-verify this entry's own claims against live
code first (dated 2026-09-18) and check whether the CMB epic's own scoping already accounts for
this before treating it as a fresh gap.

## Deferred from: combat-readiness review + live staking scenario, 2026-09-18 — armour gap is worse than "no effect," and staking specifically is unprotected

**PARKED — pick back up after Game 8 downtime is fully closed out, per Angelus's explicit instruction 2026-09-18. Do not start on this mid-downtime.**

Supersedes/corrects the entry above (same date, same audit day) in two ways, both verified against
live code by three independent reviewers (Reeve, Winston, Dana, Sally — a `tm-combat-readiness-review`
workflow) plus a follow-up direct check this session:

1. **Armour is not "zero effect" — it's net-negative.** `combat-tab.js` doesn't call `calcDefence`
   directly; it calls `defenceForDisplay(c)` from `public/js/data/equipment-derivation.js`, which
   **does** read `c.equipment[]` and subtracts a worn item's `defence_penalty` from the wearer's
   Defence (`armourDefencePenalty()`, `equipment-derivation.js:192-204`). So worn armour is live and
   working for its *encumbrance* half — it makes the wearer easier to hit — while `armour_value` (the
   *protection* half) is confirmed still never read anywhere in `public/js` for damage reduction. Net
   effect for every character wearing armour right now: strictly worse off than wearing nothing.
   Armour is also not displayed anywhere in the Combat tab UI (not on the card, not the Attack
   modal) — an ST has no in-tool cue to remember a target is armoured at all.

2. **Staking specifically has its own, separate gap, independent of the general armour issue —
   and it's the one with live consequences tomorrow (2026-09-19).** The real rule (Errata Master
   §"A Stake to the Heart", matches Rulebook:8409-8417): a stake attack takes a -3 die penalty to
   target the heart; it only causes Torpor at **5+ successes AND 5+ net damage**. Core text
   (Rulebook:15343) states damage-reduction stats specifically make staking harder — soak is meant
   to be the defence against it.
   - `combat-tab.js` (the live Combat tab) has **zero staking logic at all** — no heart-targeting
     penalty, no 5-success/5-damage gate, no Torpor trigger, doesn't import `isStakeWeapon`.
   - Staking logic exists only in a different tool, `public/js/suite/roll-v2.js` (`_stakeNote()`,
     ~line 864-914): flags "5+ successes with a stake — confirm 5+ net damage," lets the ST apply
     Torpor to a picked target. **Its own code comment states outright that armour/soak reduction is
     not computed at this layer** — the ST has to hand-calculate net damage against armour every
     time, in neither tool automatically.
   - **Live scenario, confirmed direct from Mongo this session**: the actual plan for tomorrow's
     session is to stake Eve Lockridge. She has three `equipment[]` entries flagged `state: "worn"`
     simultaneously (Reinforced Clothing AV1/DP0, Armoured Vest AV3/DP1, Custom Armoured Undershirt
     AV3/DP0) plus a stashed Ballistic Vest. **Angelus ruled live, 2026-09-18: worn armour does not
     stack** — only one applies. Which specific item is the open, unresolved question (Custom
     Armoured Undershirt is strictly better than Armoured Vest for her — same AV3, no DP1 penalty —
     so there's no reason the Vest would be the one in effect unless deliberately chosen). She has no
     Resilience merit, so armour is her only mechanical defence against being staked. **If the stake
     attempt resolves through either live tool as-is, she is staked exactly as easily as if she wore
     nothing** — defeating the entire point of the equipment purchased for her this cycle.
   - **This compounds**: Yusuf's armour (Full Tactical AV4/DP2, 10 Ballistic Vests) is expected to be
     distributed to the rest of the Carthians before tomorrow, so the same silent gap will apply to
     everyone who receives a share.
   - **Workaround used for tomorrow specifically (manual, not code)**: when a stake roll lands 5+
     successes, the ST subtracts the defender's applicable `armour_value` from the raw damage before
     checking the 5-net-damage threshold, by hand, in both tools. Not automated anywhere.

**Also found, same review, not staking-specific:**
- **Dana**: `trackerAdj()` (`tracker.js:298-332`) silently no-ops on further damage once a health
  track is full — no Bashing→Lethal→Aggravated wrap-around/upgrade, no error, the button just does
  nothing. Real risk in a large scene: someone should be dropped or upgraded to Aggravated and
  isn't, with no UI signal it happened.
- **Sally**: the Kindred bashing/lethal split calculator renders identically on every card
  regardless of species (no `isNpc` gate) — nothing stops an ST clicking Apply on a mortal, who
  shouldn't get Bashing-by-default.
- **Sally**: the Attack modal's weapon-rating reference chip isn't passed to the split calculator —
  the ST has to remember and retype it, and two live characters' notes (Brandy's, Samuel's) already
  disagree with the catalogue number for that exact stat.
- **Winston**: Epic CMB (the combat-panel rebuild the earlier entry assumed was "all-backlog") is
  actually done — code-complete, reviewed, closed 2026-09-01, merged and pushed to `origin/main`
  (`de3fd643`, 2026-09-18). The armour/staking/wrap-around gaps above are gaps in the *shipped*
  module, not a not-yet-built one. Unverified from this review alone: whether the live Render/Netlify
  deploy is actually serving that commit — worth a direct dashboard check before relying on it.

**All three reviewers' explicit recommendation, independently converged on**: don't patch combat
math same-day before a live session. Brief the ST running the scene on the manual workarounds
instead. Consistent with parking this until after downtime closes.

**Not scoped or built.** Real candidate story/stories, likely folding into a future combat-epic pass
once picked back up: (1) wire `armour_value` into damage resolution generally: (2) give staking its
own first-class resolution path (heart-targeting penalty, 5-success/5-damage gate, armour-aware net
damage, Torpor application) in the tool actually used live (`combat-tab.js`), not just the
side-roller; (3) health-track wrap-around/upgrade on a full track; (4) species-gate the Kindred split
calculator; (5) surface armour on the combat card itself so an ST has an in-tool cue.

## Deferred from: Game 8 XP/Sway audit, 2026-09-18 — MCI merit instances never renamed to Organisation

**Angelus's own flag, mid-audit**: the assistant used "MCI" in its own prose when the term was
renamed to **Organisation** across all three repos on 2026-08-26 (see TM Admin memory
`project_sway-merge-completed`). Investigating why the stale term was so easy to reach for surfaced
a real, previously-undiscovered gap in that migration, not just a wording slip.

**Verified against live data**: the 2026-08-26 Sway merge explicitly renamed all 62 Allies/Status
merit instances to `"Sway"` on the actual character documents (`characters.merits[].name`). **No
equivalent rename ever happened for MCI.** Confirmed live today: **18 characters still carry a
merit literally named `"Mystery Cult Initiation"`** (Yusuf Kalusicj, Alice Vunder, Brandy LaRoux,
Charles Mercer-Willows, Charlie Ballsack, Eve Lockridge, Ivana Horvat, Jack Fallow, Livia, Ludica
Lachramore, Ryan Ambrose, Xavier Boussade, Etsy, Keeper, Aleksei Romanov, Màibh Urquhart, Samuel
Pike, Orenthal Lamar McGillicuddy), **zero characters carry a merit named `"Organisation"`.** The
2026-08-26 migration's own code changes (MERIT_MATRIX sway/organisation entries, the
`merit_actions.organisation` lane key, etc.) only renamed the CATEGORY/lane the merit sorts into —
the merit instance's own `name` field on every character sheet was never touched.

**Consequence**: `merit_actions.organisation[].merit.label` (the native downtime-form's own grow/
action rows) reads directly off this stale `name` field, so every Organisation-lane action this
cycle (e.g. Ryan Ambrose's Dockyard Dogs grow) displays as "Mystery Cult Initiation (...)" to the ST
today, not "Organisation (...)" — cosmetic only, no mechanical effect (rule_key stays stable
regardless, same pattern as the Sway rename), but real player/ST-facing terminology drift.

**Not scoped or built.** Whoever picks this up should treat it as the same class of fix as the
original Allies→Sway character-data rename (a `$set` on `merits.$.name` for all 18 affected
characters, matched by array-filter on `name: "Mystery Cult Initiation"`), re-verify the count
against live data first (this entry is dated 2026-09-18), and check whether `rule_key`/`cult_name`
or anything else needs to move alongside it before running it.
