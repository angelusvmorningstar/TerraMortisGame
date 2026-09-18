# Deferred work

Items deferred from code reviews and sprint operations. Each entry is pre-existing,
not caused by the associated story, and not actionable inside that story's scope.

## Deferred from: code review of gdx-8-roll-history (2026-08-26, internal 3-layer)

- **`server/index.js`'s boot-time `createIndex` calls are un-awaited repo-wide, not just this
  story's own `roll_log` index** — Blind Hunter flagged gdx.8's own `createIndex({ rolled_at: 1 },
  ...)` call (no `await`, no `.catch()`) as a robustness gap: an `IndexOptionsConflict` on restart
  becomes an unhandled promise rejection with no operator-visible signal, and the TTL index silently
  never (re)creates. Verified via direct read of `server/index.js`: 5 of 6 `createIndex` calls in
  `start()` share this exact shape (`cyoa_passages`, `office_actions`, `contested_roll_requests` x3) —
  only `game_sessions`' own call is awaited. gdx.8's call matches the dominant existing convention in
  this exact function; it isn't a deviation this story introduced. Real gap, but story-scoped is the
  wrong size to fix it — patching just the new call would leave the other 5 (including the
  already-once-bitten `contested_roll_requests` TTL indexes) exactly as exposed. Needs its own
  async-hygiene pass across all of `start()`'s index creation, not a one-line patch riding on gdx.8.

## Deferred from: code review of pp.9-schema-v3-inline-creation (2026-04-24)

- **Apostrophe slug regex strips ASCII only** — `public/js/data/loader.js` and `server/scripts/migrate-schema-v3.js` both use ASCII-only regex. Consistent across repo but brittle to external data with curly quotes (`’`). Harmonise when next touching slug logic.
- **Dual sanitisers with different predicates** — `public/js/data/loader.js:22` uses `typeof val === 'object' ? val.dots : val`; `public/js/player.js:93` uses `v?.dots ?? v`. Behaviour differs on null values. Align in next cleanup pass.
- **Stale-cache save path produces 400s without clear UX** — `public/js/editor/export.js` no longer strips legacy creation arrays; if a client has an old localStorage doc, the save is rejected by schema `additionalProperties: false` at root. Add a friendlier client-side scrub or a 400 error message that points users to reload.
- **Tooling drift** — `scripts/migrate-points.js` and `scripts/validate-chars.js` still reference legacy parallel arrays (`attr_creation`, `skill_creation`, `disc_creation`, `merit_creation`). Either update to v3 shape or delete if superseded.
- **Wizard zero-dot discipline persistence** — Wizard can save a discipline with `dots: 0`; sanitisers strip on load only. Add a save-time filter.
- **Rite XP formula edge case** — `level === 0` or missing yields `xp = 1`. Unclear if level-less rites are a real data shape; revisit if any surface.
- **Migration validate-then-transact concurrency** — Ajv validates before `client.startSession()`; another writer modifying between validate and commit would produce an unvalidated committed doc. Single-admin migration makes this theoretical, not urgent.

## Deferred from: code review of fix.933.lore-rubric-index26 (2026-06-26)

- **No MongoDB transaction wrapping migration steps** — `server/scripts/fix-lore-rubric-index26.mjs` (and other migration scripts) perform multi-collection writes without a MongoDB session/transaction. Atlas supports multi-document transactions; adding one would make step 2 (rubric $set) and step 3 (marking loop) atomic. Pre-existing pattern across all migration scripts. Partial-failure concern in this story is addressed by the `--force-mark-patch` recovery flag instead.

## Deferred from: review of next-session-deadline-fix (2026-04-28)

- **Cleanup script `server/scripts/cleanup-stale-sessions.js` lifecycle decision** — Spec Design Notes called for the cleanup to be a manual MCP operation, not a committed script. The MCP confirmation UI was broken at execution time so a script was written instead. Now it sits in the tree forever with hardcoded `_id`s. Two options: (a) delete the script post-application (it's spent), or (b) harden it — guard the `$unset` with a date check on `session_date` so a future re-run cannot strip a freshly-set deadline. Flagged by adversarial + edge-case + acceptance reviewers.
- **`formatDeadline` invalid-date guard** — `server/routes/game-sessions.js:7` passes `cycle.deadline_at` directly to `new Date()`/`toLocaleString()`. A malformed string or BSON Date that produces `Invalid Date` would surface as the literal string `"Invalid Date"` in the public banner. Pre-existing; the broadened cycle status set marginally increases the chance of hitting cycles whose `deadline_at` was set via legacy writers (e.g. CSV import). Add `Number.isFinite(d.getTime())` check before formatting.
- **2099 fixture leak in vitest** — `server/tests/api-game-sessions-next.test.js` uses fixed dates `2099-12-31` / `2099-12-25`. If a test crashes between insert and `afterEach` (e.g. process kill during long-running suite), stale 2099 docs persist in `tm_suite_test`. The `beforeEach` sweep catches future sessions and live cycles, but a leaked `'closed'` 2099 cycle would survive. Use a fixture marker (`__test_seeded: true`) instead of a date filter.

## Deferred from: NPCR party-mode review (2026-04-24)

- **Pending-edge lifecycle cap** — Relationship edges in `status: 'pending_confirmation'` with no response accumulate silently. No TTL, no ST broom. If a PC retires or goes inactive after proposing, the proposal sits forever. Options: (a) TTL at ~90 days auto-rejecting to `status: 'rejected'`, (b) surface age on the admin edge editor so STs can manually sweep, (c) exclude proposals from retired-PC initiators. Flagged by Winston; not urgent at current volume.
- **Hard character deletion cascade** — `DELETE /api/characters/:id` does a raw `deleteOne` with no cascade to the relationships graph. Orphan edges with dangling endpoints survive. Enrichment handles it (`_other_name: null`), no crash, but graph integrity degrades. Options: cascade-retire on delete, or a periodic orphan-sweep script that retires edges whose endpoint no longer exists. Flagged by Winston.
- **Mobile rendering audit of Tier 2 UI** — Player portal is desktop-first per project memo; Tier 2 (Relationships tab) was built on that assumption. Players will open it on phones regardless. No audit done; no guarantees about the Add Relationship picker, the edit form, or the pending banner at narrow widths. Flagged by Quinn.
- **Verify multikey indexes on `relationships.a.id` and `relationships.b.id`** — NPCR.2 planned these via `server/scripts/create-relationship-indexes.js`. Confirm they actually ran on live `tm_suite` before NPC-NPC graph work expands query load. Quick verification task, flagged by Winston.
- **QA gaps in flag × st_hidden and retired-endpoint enrichment** — `_flag_state` enrichment doesn't differ by caller role (same shape for ST and player); untested. `_other_name` resolution when the PC on the other side has `retired: true` — behaviour uncharacterised. Flagged by Quinn; add to the next QA pass.
- **Admin letter-context resolver: surface failure signals** — `handleCopyLetterContext` falls through silently when the edge resolver errors. ST gets an incomplete prompt with no indication why. Add a visible "relationship resolution failed" toast or prompt-line note. Flagged by Quinn.
- **"Updated" chip field-list** — currently bare `Updated ✕`. First player to ask "what changed?" will be one too late. Derive from `history[fields].name` when the time comes. Deferred per NPCR.6 r2 design call; pulled forward as a likely soon-needed iteration.
- **Tier 4 story specs** — all five items in the epic footer (Cytoscape visualisation, timeline view, NPC-NPC graph browser, notification subsystem, public directory). Party-mode consensus: **do not spec Tier 4 yet**. Ship Tier 1-3 to main, observe for one cycle of live play, revisit with player signal. Flagged by John; unanimous.

## Deferred from: issue-1028-cm1-phase-as-data external code review (Codex, 2026-08-10)

Each item pre-existing or deliberately out of the story's scope, surfaced by the external review
and verified before deferral. Provenance: `specs/stories/code-review/issue-1028-cm1-codex-findings.md`.

- **`game-sessions.js` downtime-deadline lookup drops prep cycles** — `server/routes/game-sessions.js:42-49` picks the next deadline among live raw statuses only; a prep-phase cycle (status mirrors to `closed`) is excluded where the old early-game window (status `game`) was included. The deadline it would report during prep is a past one anyway, so the impact is a possibly-absent cosmetic deadline line. Make it phase-aware when the session banner is next touched.
- **`phase_sequence` completeness constraint** — `uniqueItems` now enforced; the schema still accepts a partial order like `['game']`. A cycle with a partial sequence gives `phaseIndex` = -1 for missing phases. Tighten (minItems/const-set) as part of the CM-2 story that first consumes ordering, where the intended flexibility gets decided rather than guessed.
- **`app.js` lifecycle submission lookup is cycle-unfiltered on the active-cycle path** — pre-existing: `_loadLifecycleData` matches the player's submission by character only when a downtime window is open, so a stale roll on an older submission could read as "rolled". The new prep-path added by CM-1's review patch IS cycle-filtered; the old path was left byte-identical to avoid a behaviour change inside a review pass. Align it next time the lifecycle cards are touched.
- **Admin DT processing header badge reads "closed" during prep** — `downtime-views.js:1242-46` reads raw status for its badge; correct data, stale word. (Carried from the story's own completion notes; re-confirmed by the review.)

## Deferred from: cm5-tracker-reset-to-prep internal 3-layer review (2026-08-10)

- **`reconcileInfluenceDT` discards the prep-week feeding-influence deduction on reload** — `public/js/game/tracker.js:181-230` absolute-sets `influence = max − downtime spend` on every tracker init, guarded only by a per-page-load `_reconciledCycles` set. Under the prep model the prep cycle IS the "last closed by game_number", so a page reload between the ST's Confirm Feed and game night re-derives influence and drops the feeding deduction. Vitae is unaffected. Needs a persistent per-(cycle, character) reconciled marker, or a skip when the cycle is the current prep/game cycle and a confirmed feed exists. **5b-shaped; briefed to Angelus as a door-side workaround for Game 7.**
- **Tracker reset is not atomic with the phase write** — in `cycle-views.js` `writePhase` the `DELETE /api/tracker_state` precedes `setCyclePhase`; a failed phase write leaves the tracker wiped and the phase unchanged, and the inline error says only "Phase change failed". Pre-existing shape (true of the legacy game reset), now reachable on prep entry too. Consider reversing the order or naming the wipe in the failure message.
- **Tracker DELETE broadcasts nothing** — `server/routes/tracker.js:50-55` does `deleteMany({})` without `broadcastTrackerUpdate`, so an open tracker tab keeps its module-scope `_cache`/`_confirmed` and can re-upload pre-wipe values on its next save. Related: `game/tracker.js:111-127` migrates a legacy `tm_tracker_state` localStorage blob back into Mongo after a wipe, and the DELETE clears no localStorage. Part of the 5b tracker-hardening pass.
- **`epic.708.3-cycle-phase-controls.test.js` is 3-red on stale assertions** (#1116: `setGamePhase`, `data-phase`, `gold2`). CM-1 and CM-5a both left it alone deliberately. It covers the exact UI these stories touch, so it is the highest-value stale suite to repair; do it before the next cycle-UI story rather than carrying the noise further.

## Deferred from: issue-1128-oversized-merit-dots external code review (Codex, 2026-08-11)

Both items pre-existing or deliberately out of the story's scope, surfaced by the external review
and verified before deferral. Provenance:
`specs/stories/code-review/issue-1128-oversized-merit-dots-codex-findings.md`.

- **Compound-target "My dots:" never reflects a suspended oath, unlike its own adjacent Total** —
  `public/js/editor/sheet.js:1303` (domain edit mode, compound-target branch). The label renders
  `'●'.repeat(_cmpOwn)` directly, never calling `shSuspendedOf`/either dot-render helper, while the
  same row's `.dom-total-lbl` two spans over correctly routes through `shDotsSuspended`. Break an
  oath pledging dots from a compound-target merit's own contribution and the row shows contradictory
  effective counts — Total reflects the suspension, "My dots:" doesn't. Confirmed pre-existing via
  `git blame` (commit `92f2a4884`, predates both OATH-B and this fix); issue-1128 deliberately left
  this branch untouched (it was already correctly bare, just not suspension-aware) and this is a
  separate defect, not a regression of this story's own fix. Fix by routing `_cmpOwn` through
  `_shSuspendBands`/`shSuspendedOf(m)` the same way the six repointed sites now do, next time the
  compound-target rendering is touched.
- **AC4's automated test checks glyph content, not actual layout fit** —
  `server/tests/issue-1128-dot-wrapper.test.js` asserts the five-dot string is `●●●●●` and has
  length 5, but never measures computed width against `.infl-dots-derived`'s 60px column. The real
  fix was verified to fit via a live browser measurement (`clientWidth`/`scrollWidth` both 60px, both
  themes — recorded in the story's Dev Agent Record item 6), but that check isn't automated, so a
  future CSS change to `.infl-dots-derived`'s font-size/padding/letter-spacing could silently break
  the fit again with this suite staying green. Would need a Playwright-based layout assertion (real
  font metrics), a heavier test shape than this codebase's existing string-comparison pattern — worth
  adding if `.infl-dots-derived` or `.trait-dots` sizing is touched again, not urgent enough to justify
  building fresh CI-layout-test infrastructure for this one column today.

## From issue-1135-delete-eight-tabs (2026-08-11)

- **`TAB_SUBTITLES` defines `territory` twice** — `public/js/app.js`, once in the legacy block and
  again under "Unified nav tab names". Both values are the same string, so the duplicate is harmless
  today (the second silently wins) and it is pre-existing, not a regression of #1135. Left alone
  deliberately: #1135 was a deletion story and this key belongs to neither a deleted nor a surviving
  tab's registration. Delete the earlier of the two next time that object is touched.
- **`renderCityTab` is now an unreferenced export** — `public/js/tabs/city-tab.js` survives #1135
  because `public/js/admin/city-views.js` imports `openCityMapOverlay` from it, but the `whos-who`
  branch that called `renderCityTab` is gone, so that function (and whatever is exclusive to it) is
  dead in production. Deliberately not removed: the story scoped `city-tab.js` as a file to leave
  alone, and pruning a shared module's dead half is exactly the unreachable-surface work already
  tracked in #1095. Fold it in there.
- ~~**The `tickets` collection still holds 69 documents (19 open)**~~ — **RESOLVED 2026-08-11: collection
  dropped** on Angelus's explicit authorisation, after the review closed and after he was told the 19 open
  ones were real unfixed bugs. The drop was guarded on the live count matching the export (69 = 69) so the
  export is a complete recovery path. Nothing further outstanding. Original entry follows for the record.
  #1135 removed all ticket CODE
  (route, schema, mount, admin view, stylesheet, player submit form) but deliberately did NOT drop
  the collection, because dropping live data needs its own explicit go-ahead. Full export taken
  first: `data/exports/tickets-full-export-2026-08-11.json` and `tickets-open-2026-08-11.md`. The 19
  open ones include real unfixed bugs ("Incorrect 9-again on new dice roller", "Feed herd bonus
  incorrectly calculated", "Shared merits require a minimum one dot investment"). They now have no
  in-app home, so they want triaging into GitHub issues before the collection is dropped.
- ~~**The admin Primer surface is unstyled**~~ — **RESOLVED 2026-08-12: the whole surface removed.**
  A full admin-feature audit found `primer-admin.js` had no remaining consumer anywhere (the primer
  players actually read is a separate static page, `public/primer/primer.html`, unrelated to the
  `archive_documents` collection this panel wrote to) — the styling gap below was a symptom of dead
  code, not a real gap to fix. Removed: the `documents` sidebar domain and section (`admin.html`),
  `initPrimerAdmin`'s import/dispatch (`admin.js`), `public/js/admin/primer-admin.js` itself, and the
  now-unreachable `primer`-type branches in `server/routes/archive-documents.js` (`GET /primer`, and
  the `isPrimer` handling in `POST /` and `POST /upload`). The `dossier`/`history_submission`/
  `downtime_response` types on the same route are untouched — those remain real, live features.
  Original entry follows for the record. `public/js/admin/primer-admin.js` (live at
  `admin.js`, domain `documents`) emits `primer-admin-shell`, `primer-file` and `primer-upload-*`,
  and none of those classes is defined in ANY stylesheet. Pre-existing and unrelated to #1135, which
  deleted only the disjoint `primer-content`/`primer-layout`/`primer-toc*` set belonging to the
  removed player tab. Flagged because the two sets share a prefix and a future prefix-wide grep will
  keep rediscovering it.

### Added by the issue-1135 external review (2026-08-11)

- **Three `_svg` icon entries were dead before #1135** — `_svg.status`, `_svg.whosWho` and
  `_svg.dtReport` in `public/js/app.js` have zero references. Confirmed unreferenced at base
  `40cee7fb`, so they are not #1135's doing (its own three orphans, `primer`/`guide`/`rules`, were
  removed). Left alone for scope discipline. Delete next time that object is touched.
- **No coordinator-role fixture in the targeted browser specs** — `tests/issue-1135-deleted-tabs.spec.js`
  and `tests/fin-checkin-finance.spec.js` both authenticate only an ST. #1135's AC9 (a coordinator sees
  the Finance tab gone, with no console error) and the coordinator half of AC10 (check-in still works)
  therefore rest on construction plus static inspection, not on an exercised path: both removed Finance
  entries were `coordinatorOnly`, so no role can render them. A regression that hit `role: 'coordinator'`
  without hitting `'st'` would go undetected. Worth a coordinator fixture next time either spec is opened.
- **Two pre-existing broken test harnesses, both confirmed broken at base `40cee7fb`** — not caused by
  #1135 and deliberately not fixed by it. (a) `tests/post-game-1.spec.js` nav-1-3 (3 tests) waits on
  `#n-more`, but `more` has no `NAV_ITEMS` entry, so that button has never existed in this nav.
  (b) `tests/desktop-and-css.spec.js` (12 tests) waits on `#btn-desktop-toggle`, which stays hidden
  because `#hdr-nav` is only revealed by `_applyDesktopMode` once `effectiveRole()` resolves to ST, and
  it does not under the spec's stubbed API. Both need a harness fix, not a product fix. A third test in
  that file (the Primer TOC css-audit, retired by #1135) was additionally **flaky**: two full runs of
  identical base code disagreed on it, failing by locator timeout in one and passing in the other.

### Added by the issue-1137 external review (2026-08-11)

- **The supported Rules Data authoring path cannot create a generic pool rule.** The producer admits
  only `condition: 'merit_present'`, but that value is absent from BOTH the admin UI's condition
  selector (`public/js/admin/rules-data-view.js`) and the API schema enum
  (`server/schemas/rules/rule-grant.schema.js`). Choosing the UI default `always` saves a rule the
  sweep ignores; POSTing `merit_present` directly is rejected by validation. The UI also has no
  fields for `source_slug`, `category`, `partner_shareable` or `sharing_scope`, all of which a
  Collective Compound needs. **Consequence:** #1137's promise that a new compound needs no code
  change is true only for a direct DB seed script, not through the supported ST-facing surface. Worth
  its own issue: widen the enum in both places and add the compound metadata fields.
- ~~**Split-source compounds get UI but no pool.**~~ **RESOLVED 2026-08-11 by ST ruling — not a
  defect, and not a decision that was ever open.** Angelus: *"you must have Blood and Sacrifice in
  order to have merits in the Fane."* Membership, funding and prerequisite all run through the one
  compound merit, so a compound with a separate way in and way of paying is not a shape this game
  builds. **Already enforced in the data**, verified against `purchasable_powers`: all six Fane
  targets (Dark Temple (Mother's Fane), Accursed Armory, Font of Corruption, The Mother's Altar,
  Primal Mandragora, Occult Collection) carry `prereq: { all: [status Crone 1, merit "Blood and
  Sacrifice" 1] }`. Nobody holds any of them yet. The scenario the review raised therefore cannot
  occur: you cannot hold a Fane merit without the gate merit that funds it. **If a future compound is
  ever seeded with `source` differing from `sharing_scope.merit`, that is a data error to reject, not
  a funding model to support.** Original entry follows for the record.
  `ownsCompound` treats a character as an owner based
  on `sharing_scope.merit`, while `applyPoolRulesFromDb` gates on `rule.source` and
  `rating_of_source` reads the same field. When those differ — which the existing
  `Silent Vigil` / `Keeper of the Ossuary` fixture in
  `server/tests/collective-2-compound-generalisation.test.js` explicitly supports — a holder of the
  membership gate who does not hold the funding source sees the compound rendered with capacity 0.
  None of the three live compounds splits them, so nothing is broken today. Needs a **product
  ruling** before code: is a split-source compound funded by the gate merit, the source merit, or
  both? Do not guess.
- **Duplicate pool rules multiply capacity.** `applyPoolRulesFromDb` pushes one `_grant_pools` entry
  per matching rule with no de-duplication, so two `rule_grant` docs for the same source would double
  a compound's allocation capacity. **Pre-existing** — the old per-source call had the same
  behaviour, since `getRulesBySource` would have returned both — and #1137 does not introduce the
  mechanism, only extends its reach to every admitted source. Verified 2026-08-11: live data has zero
  duplicate dispatch keys among the six admitted pool rules (independently confirmed by the external
  reviewer). `getCollectiveCompounds` already de-duplicates on `source|slug`; the producer does not.
  Cheap guard if it ever bites: de-duplicate by `source|category` before the push.

## Found during a TM Wiki cross-project audit, not a code review (2026-08-12)

- **TM Suite's own live covenant-ordeal picker has two real bugs**, confirmed by direct read of
  `public/js/tabs/covenant-data.js` and `public/js/tabs/ordeal-form.js` (both live, wired via
  `app.js` → `initOrdeals`, in the player nav today). Surfaced while researching TM Wiki's Epic 30
  (which built a parallel Ordeals authoring surface and sidestepped both bugs by design — auto-deriving
  covenant from canon instead of offering a picker at all), not by a review of TM Suite code itself, so
  no story exists to carry this. **Bug A** — the picked covenant is never actually persisted:
  `covenant_choice` lives only in the separate `COVENANT_ROUTING` export, never inside the
  `COVENANT_SECTIONS[cov]` array that `collectResponses()` in `ordeal-form.js` walks, so a draft saved
  through the real picker UI never has `responses.covenant_choice` set. **Bug B** — every covenant
  reuses the same question keys (`q2`..`q23`) with no covenant-discriminator field on the stored
  `ordeal_responses` document; combined with Bug A, a character whose canon `covenant` changes after a
  draft exists (a corrected record, or a genuine covenant-change RP arc) would silently show the OLD
  covenant's answers as if they answered the NEW covenant's differently-worded questions at the same
  keys, with no code path anywhere that detects or resets this. Not fixed this session — flagged only.

## Deferred from: code review of oxp-5-handover-logic (2026-08-14)

- **No transaction-rollback fault-injection test.** `PUT /api/office_seats/:seatId/holder`
  (`server/routes/office-seats.js`) wraps a genuine multi-document `session.withTransaction` — claim
  the seat, clear the departing holder, set the incoming holder, reset the manoeuvre rank — but no test
  anywhere forces a failure AFTER the seat claim commits inside the session and BEFORE the transaction
  as a whole commits, to prove the claim rolls back along with everything else rather than surviving as
  a half-applied write. This is a real, valid coverage gap, found independently by two review passes
  (Blind Hunter and Acceptance Auditor). Checked precedent before deferring rather than assuming it was
  fine: `server/routes/office-actions.js`'s `PUT /:id/accept`, the exact route this one's transaction
  scaffolding was deliberately copied from, has never had a fault-injection rollback test either, in
  this codebase's whole history — so this is not new debt oxp-5 introduced, it is an existing,
  unaddressed gap in how this codebase proves transactional atomicity, now visible on a second route.
  The atomicity itself rests on MongoDB's own ACID `session.withTransaction` guarantee, a well-
  established primitive, not custom-rolled logic — but "the primitive is trustworthy" and "we have
  proved our specific usage of it" are different claims, and only the second is missing. Building this
  properly needs a real fault-injection technique against a live Mongo session (e.g.
  `vi.spyOn(Collection.prototype, 'updateOne')` scoped precisely enough to fail only the intended call,
  without becoming a flaky or vacuously-passing mock) — worth building ONCE as shared test
  infrastructure and applying to both `office-actions.js` and `office-seats.js`, rather than each
  transactional route inventing its own ad hoc version under review-cycle time pressure. Full finding
  text: `specs/stories/code-review/oxp-5-codex-findings.md` (Pass 1 and Pass 3a, same underlying gap
  found twice independently).

## Deferred from: code review of gdx-5-game-in-progress-setting (2026-08-15)

- **`broadcastSettingsUpdate` has no try/catch around `ws.send` in its client loop** —
  `server/ws.js`. A single flaky/torn-down socket throwing mid-iteration would abort the loop, so
  later clients in the same broadcast never receive the frame. Not new: identical to the pre-existing
  shape of `broadcastCatalogueUpdate`, `broadcastStModUpdate`, and `broadcastTrackerUpdate` in the same
  file — all four share this gap. Fix once, for all four, in a dedicated hardening pass; patching only
  the newest one would be inconsistent.
- **No UI feedback beyond `console.error` on a settings-toggle PATCH failure, no guard against rapid
  double-toggle races** — `public/js/admin/st-mods-panel.js`, both `_onGlobalToggle` (pre-existing) and
  the new `_onGameInProgressToggle` (gdx.5), which deliberately mirrors it. An operator whose PATCH
  fails sees the checkbox silently revert on re-render with no visible error, and two quick clicks can
  race with no ordering guarantee. Real, but shared by the master switch too — worth a UX pass across
  both toggles together, not a one-off fix for the newer one.
- **Rapid successive settings PATCHes can trigger out-of-order concurrent client refetches** —
  `public/js/data/ws.js`'s `_handleSettingsMsg` fires an unawaited `loadGlobalSettings()` per WS frame
  with no request sequencing/generation token; two frames close together can have their `fetch`
  responses resolve out of order, leaving the client cache briefly behind the server's actual state.
  Same unguarded-refetch class of risk as the pre-existing `onCatalogueUpdate` → `refetchEquipmentCatalogue()`
  pattern (ECM-5) — not unique to or introduced by this story. Worth a shared fix (a monotonic
  generation counter that discards a stale response) applied to both call sites together.

## Deferred from: story gdx-6-structured-power-costs investigation (2026-08-15)

- **Duplicate devotion name in live data** — two separate `purchasable_powers` documents (distinct
  `_id`s) both carry `name: "Summoning"`, `category: 'devotion'`, both `cost: "1 V"`. Found live while
  sampling every devotion row for gdx.6's own cost-parsing investigation; pre-existing, not introduced
  by anything this story touched. Not itself broken — anything that looks a devotion up by `key`
  (unique) rather than `name` is unaffected — but any UI or picker that lists devotions by name alone
  (e.g. a future dropdown, search, or the legacy `DEVOTIONS_DB` shim in `editor/sheet.js` which does
  key on `d.n === p.name`) cannot currently disambiguate the two. Worth a one-off data-hygiene pass to
  confirm whether they're genuine duplicates (same rulebook power entered twice) or two different
  powers that happen to share a name and need distinguishing text.

## Deferred from: code review of gdx-6-structured-power-costs (2026-08-15)

- **`fmtRuleStats` is not actually the ONLY place a power's cost gets displayed** — the story's own
  Dev Notes claimed it was "the single shared display function... already de-duplicated once from
  three separate copies," which is true for the three copies that WERE de-duplicated
  (`editor/sheet.js`, `suite/sheet-helpers.js`, `editor/export-character.js` — the last of which calls
  `fmtRuleStats`, unaffected), but incomplete: `public/js/print/page2.js:109` and
  `public/js/editor/csv-format.js:309` each build their own independent `"Cost: " + p.cost` string,
  reading the raw legacy field directly and never calling `fmtCostLine`/`fmtRuleStats` at all. A power
  whose cost this migration successfully parsed (or classified `unparsed` with a `cost_note`) now
  displays correctly on the character sheet but shows only the old raw `cost` string (or nothing, if
  `cost` itself is null on a row this migration explicitly zeroed) on the printed sheet and in CSV
  export. Not touched by gdx.6 itself — that story's own AC7 named only `fmtRuleStats` — but worth a
  follow-up to bring both sites onto the same structured-cost-aware display logic, likely by extracting
  a shared "cost text" helper both `fmtCostLine` and these two sites can call.
- **Admin rule editor has no field for the new structured costs** — `public/js/admin/rules-view.js:390`
  exposes only the free-text `cost` input. An ST editing a rule's `cost` string after gdx.6 has no way
  to update `vitae_cost`/`willpower_cost`/`cost_note` in the same UI — they silently drift out of sync
  with the edited text (or are simply never set at all for a brand-new rule an ST authors by hand,
  since the migration only ever ran once, historically, over existing rows). Needs either a manual
  re-run of the migration after any bulk cost-text edit, or (better) three new fields in this admin
  form with the migration's own parser wired in as a "re-derive from cost" button.
- **CSV export/import round-trip drops the new fields** — `public/js/editor/csv-format.js:309` and
  `public/js/admin/data-portability.js:362,825` read/write only `cost`. Lower severity than the two
  items above: since `vitae_cost`/`willpower_cost`/`cost_note` are derived FROM `cost` (which does
  survive the round-trip), re-running `gdx-6-structured-power-costs.mjs --apply` after a CSV re-import
  restores them — nothing is permanently lost, just temporarily stale until the migration is re-run.
- **`applyCostMigration`'s `updateOne` result is unchecked** — `server/scripts/gdx-6-structured-power-costs.mjs`.
  No inspection of `matchedCount`/`modifiedCount`; if a document is deleted (or its `_id` no longer
  matches) between `planCostMigration`'s read and this row's write, the update silently no-ops while
  `written` still increments and the per-row log still claims success. Low-probability race in a
  single-operator, one-off, manually-run admin script — same risk class as several other migration
  scripts in this project that don't guard against it either (unlike `migrate-office-purchases-to-
  seats.mjs`, which specifically does, because THAT script's own multi-step insert-then-delete shape
  makes a mid-flight change genuinely dangerous; this script's plain single `$set` per row is lower
  stakes). Worth a guard if this script is ever re-run against a much larger or more actively-edited
  collection than `purchasable_powers` currently is.
- **"0 V"-shaped cost strings (no live occurrence) classify `parsed`, not `zero`** — a cost string like
  `"0 V"` or `"0 V (in bond)"` (nothing in live data has this shape today) matches the numeric parse
  patterns and lands in the `parsed` bucket with `vitae_cost: 0`, rather than the `zero` bucket the
  migration's own header comment describes as the sole path for "confirmed free." The final displayed
  string is identical either way (`fmtCostLine` renders nothing for `0/0/null` regardless of which
  bucket produced it), so this is a report/bucket-grouping inconsistency only, not a display bug — an
  ST reading the migration's plan-mode counts would see it filed as "parsed" rather than "confirmed
  free." Cosmetic; fix only if it ever actually occurs.

## Deferred from: gdx-7-apply-costs-on-roll dev-story (2026-08-15)

- **Test-harness/production routing drift on `/api/tracker_state`** — `server/tests/helpers/test-app.js:90`
  mounts the router as `mockAuth, requireRole('st'), noCache(), trackerRouter`, an app-level ST-only
  gate that does not exist in production (`server/index.js:173` mounts the same router as
  `requireAuth, noCache(), trackerRouter` only, leaving all scoping to the router's own `canAccess()`,
  which already correctly lets a player read/write their own character's tracker). Found while building
  gdx.7's live-DB integration test, which needed to reason precisely about who the real API lets write
  what. Effect: `api-tracker-state.test.js`'s existing "player is blocked (ST-only endpoint)" tests
  currently pass for the wrong reason (the test harness's own extra gate, not `canAccess()`'s real
  own-character scoping) — `playerUser([])` owns no characters either way, so removing the extra gate
  wouldn't flip those tests' outcomes, but today they give no signal about the actual production
  behaviour. Not fixed in gdx.7: the change is a one-line, low-risk mount-line correction, but
  `test-app.js` is shared infrastructure used by ~30+ suites and a routing-shape change there deserves
  its own reviewed story rather than riding in on an unrelated one. Fix: drop `requireRole('st')` from
  that one mount line so the test harness matches production exactly, then add a positive test proving
  a player CAN write their own character's tracker (currently untested in either direction with the
  correct auth boundary).

## Deferred from: gdx-7-apply-costs-on-roll internal code review (2026-08-15)

- **`trackerAdj`'s writes are fire-and-forget with no surfaced error** — `public/js/game/tracker.js`'s
  `saveToApi` swallows a failed `PUT` (`.catch(() => {/* silent fail */})`) everywhere it's called, not
  just from gdx.7's new roll-triggered spend. If the network drop happens mid-roll, the roll still
  proceeds as if the spend succeeded and nothing tells the player or ST the tracker is now out of sync.
  Pre-existing shape, confirmed by reading `tracker.js` directly; fixing it means redesigning
  `trackerAdj`/`saveToApi` itself, out of any single story's scope. Flagged by internal review (Blind
  Hunter + Edge Case Hunter, independently) as newly load-bearing now that a real live-game feature
  depends on it.
- **Vitae/Willpower spend on roll is two independent, non-atomic writes** — `roll-v2.js`'s `doRoll()`
  calls `trackerAdj` once per field (vitae, then willpower) for a devotion costing both. If the first
  write succeeds and the second fails, the character is left half-charged with no rollback. A true fix
  needs a server-side atomic multi-field spend endpoint — explicitly out of gdx.7's own scope ("NOT a
  new API endpoint"). Flagged by internal review (Blind Hunter).
- **TOCTOU race between the affordability check and the actual spend** — `roll-v2.js`'s
  `_currentSpendDecision()` reads the tracker balance once, but `trackerAdj`'s actual mutation can land
  after a WS update or an ST's manual edit has already changed it. `trackerAdj`'s own clamp-at-0 would
  then silently truncate an unaffordable spend rather than reject it, narrowly weakening the "never a
  partial spend" guarantee gdx.7's own tests otherwise enforce. Low-probability; a full fix needs a
  server-side atomic "spend-if-affordable" check, same scope boundary as the item above. Flagged by
  internal review (Edge Case Hunter).

## Deferred from: bl-1-bloodline-collection-and-seed internal 3-layer review (2026-08-10)

Each verified against the real code before deferral. Patched findings are recorded in the story's
Senior Developer Review instead.

- **The ECM router 404s a valid UPPERCASE ObjectId** — `server/routes/equipment-catalogue.js:47` compares `String(new ObjectId(id)) !== req.params.id`, and `toString()` always renders lowercase hex, so `GET /api/equipment_catalogue/507F1F77BCF86CD799439011` returns NOT_FOUND for a document that exists. Confirmed against mongodb 7.1.1. BL-1's own router was fixed (case-insensitive round-trip); the ECM twin was left alone because it is outside this story's scope and shipping a behaviour change to a live endpoint inside a review pass is the wrong place for it. Fix when ECM is next touched.
- **`slug` uniqueness is enforced only at seed time** — the seed's integrity gate aborts on a slug collision, but only `name` gets a unique index. BL-4's admin CRUD can create two bloodlines whose names collapse to the same slug. Harmless today (nothing reads `slug`); add a unique index, or drop the field, when BL-4 gives it a consumer.
- **No collection-level `$jsonSchema` validator on `bloodlines`** — `bloodline.schema.js` is enforced by the seed script and by Ajv in the route layer BL-4 will add, but a manual `insertOne` (Compass, a script, a test fixture) can put a three-discipline document in the collection and the public route will serve it. A `collMod` with `$jsonSchema` at seed time would make the four-discipline rule as real as the unique index. BL-4's call, since that is when non-seed writes start.
- **`deriveSlug` only strips decomposable diacritics** — NFD + `\p{Mn}` handles `é`, `á`, `ü`, but `ø`, `ł`, `ß`, `æ`, `đ` have no NFD decomposition and are hyphenated or eaten (`Nørvegi` → `n-rvegi`). A wholly non-Latin name derives an empty slug, which the gate catches by aborting the whole seed with no way to supply a slug by hand. No current bloodline is affected. Revisit if BL-4 ever needs one, with an explicit override slug rather than a bigger transliteration table.
- **The live cross-check counts retired characters** — `seedBloodlines` filters only `bloodline ∉ {null, ''}`, so a retired PC carrying a legacy bloodline value would land in the unresolved list alongside live PCs and make the resolving ratio unreachable. Today all 13 holders resolve so it does not bite. Exclude or separately label `retired: true` before BL-5 uses this output as its go/no-go.
- **The production mount is not exercised by any automated test** — every API test builds `createTestApp()`, which mounts the router itself. If `server/index.js` had put `/api/bloodlines` behind `requireAuth`, or omitted the mount, all eleven API tests would still pass, including the three asserting "no auth required". Covered once manually for BL-1 (booted `node index.js`, curled the endpoint, verified 200 and the 404 path). A supertest against the real app export would close it properly, and would benefit every route suite, not just this one.
- ~~**`GET /api/bloodlines` returns soft-retired entries with no filter**~~ — **VOID 2026-08-10.** Angelus ruled that a bloodline cannot be retired; they are permanent. The `active` field was removed from the schema, the seed and the fixtures the same day (BL-1 was still unmerged and unseeded), so there is nothing to filter. A schema test now rejects `active` as an unknown property so it cannot return as a BL-4 convenience.

## Found during BL-2 data-lock follow-up (2026-08-10) — `characters.bloodline` is write-once and nothing enforces it

> **DISCHARGED 2026-08-11 by BL-5** (`bl-5-character-bloodline-validation.story.md`, code-reviewed
> the same day). All three bullets below are closed: the silent name-to-null was **deleted** rather
> than guarded (with both now-dead cache imports, proved at the call sites); the false `(none)`
> display was already closed by BL-3a's review fix 4 on **both** surfaces; and both editing surfaces
> are now locked by **one** shared refusal called from `updField` **and** `shEdit`, backed by a
> server-side 409 on `PUT /api/characters/:id`. Kept here as the record of what was found and when.
> **One residue is genuinely still open:** the inline `style="..."` called out in the third bullet
> was never on the bloodline select itself; the surviving inline style in `editor/sheet.js` is at
> `:2688`, on the regent-territory label in the court row. Unrelated to lineage, still a
> normalised-CSS violation, still worth fixing when that line is next touched.

Angelus ruled 2026-08-10: *"Not every character has a bloodline but once they do it's forever. A new
character can start without a bloodline and then get one."* So `null` to a name is allowed; name to a
different name, and name to `null`, are not. Nothing enforces this — not the schema, not the route,
not the client — and two client paths break it today. Both are **registered against BL-5**, which is
consequently no longer the small story its sprint-status line described. Full entry in
`D:\Terra Mortis\data-map.md` under `characters.bloodline`.

- **`public/js/editor/edit.js:104` performs a silent name-to-null.** Changing a character's clan runs `if (c.bloodline && !validBLs.includes(c.bloodline)) c.bloodline = null;` — no warning, no confirmation, no record. A clan edit erases a fact the rules say is permanent. **Fix now determined (Angelus, 2026-08-10): clan cannot be changed either.** So the branch is unreachable and gets **deleted, not guarded** — no guard to get subtly wrong later. Precision for whoever does it: delete only the two bloodline-clearing lines (`:102-104`). The rest of the `if (field === 'clan')` block assigns the clan bane and is still needed for the FIRST time a clan is set on a new character.
- **`public/js/editor/identity.js:73-75` shows a false value.** The bloodline `<select>` is built only from `APPROVED_BLOODLINES`; a character carrying a name the constant does not know matches no `<option>`, so the browser falls back to the first — `(none)`. The editor displays "(none)" for a character who has a bloodline. It does not auto-wipe on render (the write is `onchange`), but the ST is reading a wrong value and the next touch of that control commits it. BL-2's loud miss path covers the *costing* half of this failure; the *display* half is still wrong and belongs with BL-3, which owns that dropdown.
- **Clan and bloodline each have TWO editing surfaces, and locking one is theatre.** Found 2026-08-10 while scoping the write-once lock. `editor/identity.js:69/73` uses `updField('clan')` / `updField('bloodline')`; `editor/sheet.js:2692` is a **second, independent** pair of dropdowns using `shEdit('clan')` / `shEdit('bloodline')`. Any write-once enforcement must cover both, or the rule holds on one screen and not the other — the same "one rule, two implementations" shape as the DT form's private in-clan check. Note also that `shEdit` lives in `editor/edit.js`, which has two importers (`admin.js` and `app.js`), so a handler change has to be checked against both. Minor, same line: `sheet.js:2692`'s bloodline select carries an inline `style="margin-top:3px;font-size:10px"`, which violates the project's normalised-CSS rule; fix it when that line is next touched rather than as its own change.

## Found during BL-2 (2026-08-10) — two more copies of the module-scope `location` read

BL-2 made `data/accessors.js` import `data/api.js` transitively, which exposed that `api.js` read
`location` at module scope and so could not be imported outside a browser. That broke two existing
vitest suites; **fixed in BL-2** by resolving `API_BASE` per request. Two more copies of the same
line survive elsewhere, are NOT reachable from `accessors.js`, and are therefore untouched and
unbroken today.

- **`public/js/data/app-settings.js:14` and `public/js/data/st-mods.js:22` each carry their own `const API_BASE = location.hostname === 'localhost' ? ... : ''`.** Same latent trap: the first time anything importable-in-node reaches them, the importing suite dies with `ReferenceError: location is not defined`. Worse, they are a straight duplication of `api.js`'s job, and `api.js`'s own header states the rule they break: "No other module should use raw `fetch('/api/...')` calls." Fold both onto `apiGet`/`apiRaw` when either module is next touched. Deliberately not done in BL-2: neither is reachable from the code this story changed, and widening a story that already alters XP costing to touch two more shared modules buys nothing today.
- **The workaround has spread.** 21 test files under `server/tests/` now stub `globalThis.location` (or a sibling browser global) before importing client modules. Each one is a small tax paid because a data module reaches for a browser global at import time. Worth a sweep once the three `API_BASE` copies are down to one, since most of those stubs should then be unnecessary.

## Deferred from: bl-2-cache-and-accessor-wiring internal 3-layer review (2026-08-10)

Each verified against the real code before deferral. The 13 patched findings are in the story's
Senior Developer Review.

- **The DT form still costs disciplines with the clan fallback this story removed.** `public/js/tabs/downtime-form.js:4109-4115` has its own `isClanDisc` reading `BLOODLINE_DISCS` then falling through to `CLAN_DISCS`, feeding `getXpCost` at `:4130`. It is drift #15 verbatim, still live, and it now reads a DIFFERENT source from `clanDiscList`. Explicitly **BL-3**, and the reason the epic's sequencing constraint exists: while the collection is seeded FROM the constants the two agree, so the window is safe until BL-4 lets an ST add a Mongo-only bloodline. **BL-3 must land before BL-4 is enabled.**
- **The Excel merge and the CSV/JSON importers write discipline cp/xp without the lock.** `public/js/admin/excel-merge.js:85-96` (via `data-portability.js`) and `public/js/suite/import.js:181` set `dObj.cp` / `dObj.xp` directly and never recompute `dots`, so an import during an unresolved state can leave cp/xp disagreeing with the stored dots. `data-portability.js:366` also writes `bloodline` as unvalidated free text, i.e. the importer can create the locked state it then writes through. BL-2's own test docstring overstated this by calling `shEditDiscPt` "the single write path" — it is the single *interactive* path. Gate the import merge, or validate `bloodline` against the cache on import, when data-portability is next touched.
- **The bloodline dropdown and the clan-change check still read the constants**, so a locked character has no in-app remedy: `editor/sheet.js:2702` and `editor/identity.js` build the picker from `BLOODLINE_CLANS`, and `edit.js:103-104` validates against it. A bloodline existing only in Mongo cannot be selected at all. **BL-3**, which owns those dropdowns — and it should read `bloodlinesByClan()` / `approvedBloodlines()`, which BL-2 already exposes for exactly that.
- **A locked discipline row shows two different dot totals.** `editor/sheet.js:653` renders pips from the stored `dots` (bought at 3/dot) while `:685` recomputes the `=` readout at 4/dot, so the two disagree for an unresolved character. Cosmetic while the lock note is up, but confusing. Suppress one of them when `_blLocked`.
- **Redact mode can merge two characters into one banner entry.** `_missLabel` uses `displayName`, which under redact mode returns a block-out string clamped to 10-16 chars, so two different characters can produce the same label and the `Set` merges them. Fix by keying the registry on character `_id` and resolving the label at render time.
- **`mountBloodlineWarnBanner()` returns an unsubscribe that both call sites discard.** Harmless today (boot runs once), but a re-login or SPA re-init without a page reload would register a second listener with no way to remove it. Either use the return value or stop advertising it.

## Deferred from: bl-3a-rewire-readers-to-cache internal 3-layer review (2026-08-10)

The 8 patched findings are in the story's Senior Developer Review.

- **AC 1's guard exempts whole files, including the one that matters most.** `server/tests/bl3a-one-inclan-implementation.test.js` allow-lists `public/js/data/accessors.js` and `public/js/data/bloodlines-cache.js` on the grounds that they mention the constants only in comments — but the test already strips comments before matching, so the exemption buys nothing while the claim is true and suppresses the alarm exactly when it stops being. `accessors.js` is the file that now owns the single implementation, and a future "fix" for a cold-cache bug could plausibly add a `BLOODLINE_DISCS` fallback there with the test still green. Narrow the allow-list to `constants.js` (the definition), `dev-fixtures.js` and `wizard.js`, and let the comment-stripper handle the other two. Not done in the review pass: it touches the guard protecting the epic's central claim, on a story that had already shipped a crash.
- **AC 1 and AC 7 contradict each other as written.** AC 1 lists the files permitted to mention the constants and does not include `tabs/wizard.js`; AC 7 explicitly excludes `wizard.js` as dead. The code is right (zero importers, re-confirmed repo-wide) and the AC text is sloppy. Worth fixing in BL-3b's spec so the same contradiction is not inherited.
- **A locked discipline row still shows two contradictory dot totals.** Carried from BL-2's review and re-confirmed here: `editor/sheet.js:653` renders pips from the stored `dots` (bought at 3/dot) while the `=` readout recomputes at 4/dot for an unresolved character. Cosmetic while the lock note is up. Suppress one of them when `_blLocked`.
- **A second inline style survives 33 lines from the one BL-3a fixed.** `editor/sheet.js:2673` carries `style="margin-top:3px;font-size:10px;color:var(--accent)"`. Outside BL-3a's instruction, which named only the line being edited, but it is the same violation on the same block and will need the same treatment.

## Deferred from: bl-4-admin-crud (2026-08-11)

- **Renaming a bloodline that HAS holders needs a migration script, not a UI action.** BL-4 made
  `name` immutable and excluded it from `BLOODLINE_UPDATABLE_FIELDS`
  (`server/schemas/bloodline.schema.js`), because three separate things key off the bloodline name as
  a plain string with no foreign key and none of them warns when it stops resolving:
  `characters.bloodline` (13 live holders), `rule_grant.bloodline_name` (3 live documents, all
  "Gorgons", matched case-insensitively at `bloodline-evaluator.js:29-32` and edited as free text in
  the Rules Engine admin), and the client cache's own `_byName` index. A rename orphans every holder
  at once and silently drops any bloodline grants; a cascade from a reference-data screen would be
  worse, because it performs the exact name-to-a-different-name transition Angelus ruled forbidden
  for `characters.bloodline` on 2026-08-10, on every holder simultaneously, with no record. A
  mis-typed name is corrected with delete + recreate, which BL-4's guarded DELETE keeps available
  precisely because a fresh typo has no holders. **If a bloodline with holders ever genuinely needs
  renaming**, that is a deliberate migration script updating all three referents in one pass, plus a
  `data-map.md` entry. Not written speculatively: it has never been needed, and writing it now would
  put a cascade in the repo for someone to reach for.
- **The bloodlines admin screen is not reachable in the player app's local test mode, so BL-4's
  player-side WS wiring could not be observed end to end locally.** `public/js/dev-fixtures.js:33-35`
  intercepts `GET /api/bloodlines` under `local-test-token` and serves the list from the constants,
  so a real create/edit/delete never reaches the player app's cache on a local machine. BL-4's
  `onBloodlineUpdate` wiring in `app.js` is asserted by test and the frame was observed arriving at a
  connected browser client, but the last hop is unobservable until **BL-3b** rewires
  `dev-fixtures.js`. Re-verify the player app once BL-3b lands.

## Deferred from: bl-4-admin-crud external code review (Codex, 2026-08-11)

- **`withObjectId`'s case-insensitive round-trip is still missing from the ECM twin.** BL-4's own
  router header already registers this: `server/routes/bloodlines.js`'s `withObjectId` compares
  `String(new ObjectId(raw)) !== raw.toLowerCase()`, because `ObjectId.prototype.toString()` always
  renders lowercase hex and a strict comparison 404s an UPPERCASE id that addresses a real document.
  `server/routes/equipment-catalogue.js`'s copy is still strict. One line, but it belongs to an ECM
  fix, not to a bloodlines review pass, and the two routers are otherwise deliberately parallel.
- **The player-app DT-form hop is now measured, not inferred, and is still BL-3b's.** The entry
  above recorded this as an environment limitation; this pass confirmed it by direct measurement
  rather than by reading the interceptor. `dev-fixtures.js` replaces `window.fetch` wholesale under
  `local-test-token`, so in the player app even a raw `fetch('/api/bloodlines')` typed into the
  console returns the fixture list derived from the constants. No amount of care in the browser can
  show that page a bloodline created on the admin screen; only BL-3b's rewiring can. What WAS
  observed live in this pass is the rule itself rendering from the cache in the DT form
  (`Nightmare (4 -> 5) [clan, 3 XP]` for a character whose clan does not grant Nightmare).
- **The seed script's own duplicate-name pre-check is still exact-match.**
  `server/scripts/seed-bloodlines.js` aborts `--apply` when the collection already holds two
  documents with the identical name, so the operator gets a readable message instead of a driver
  error. Now that the index carries a `strength: 2` collation, a case-DIFFERING pair also blocks the
  index and is reported by `ensureBloodlineNameIndex`'s own error instead — readable, but from a
  different place, and the seed's summary object still reports `duplicateNames: []` for that case.
  Harmless while the collection has no such pair (production has none, and the collated index now
  prevents new ones), and it is the seed, which BL-3b retires to `scripts/archive/`. Left alone
  rather than edited on its way out.

## Deferred from: bl-3b-delete-constants-and-seed external code review (Codex, 2026-08-11)

- **Three more copies of the old regex-pair comment stripper are still in the test tree.** That
  review replaced the stripper behind BL-3b's and BL-3a's source greps with a quote-aware scanner
  (`server/tests/helpers/strip-comments.js`), because the regex pair cannot tell a comment from the
  same characters inside a string and was measurably erasing executable text in 10 of 659 files
  under `public/js` and `server`. The identical pair survives at
  `server/tests/bl2-boot-priming.test.js:34`,
  `server/tests/bl4-bloodlines-admin-view.test.js:267/378/401` and
  `server/tests/bl4-bloodlines-write-api.test.js:48`. Lower risk than the two that were fixed: none
  of them walks a directory tree, each strips one named file whose content is known, and they belong
  to other stories' ACs. Repoint them at the shared helper the next time any of those three suites is
  opened, rather than in a pass scoped to BL-3b.
- **The test-tree file walkers still do not follow directory symlinks.** `walkJs` in
  `server/tests/bl3b-constants-deleted.test.js`, and its twin `walk` in
  `server/tests/bl3a-one-inclan-implementation.test.js`, skip a `.js` subtree reached only through a
  symlink or junction, so a repo-wide absence proof would silently omit it. Confirmed
  non-exploitable today: Codex's own `Get-ChildItem -Attributes ReparsePoint` over `public/js` and
  `server` returned nothing. Recorded rather than fixed, so that a future decision to link a source
  subtree into either tree knows it invalidates these guards.
- **AC 9 is not deferred work, it is an open operational gate.** Named here only so it cannot be
  mistaken for a review item that was quietly dropped. Production holds zero `bloodlines` documents;
  merging the epic before the seed is applied puts all 13 bloodline-carrying characters on BL-2's
  loud-miss path at once. It lives in the BL-3b story and its Senior Developer Review, and it is
  Angelus's operational act, not a coding task.

## Deferred from: dtlt-10-mandragora-fruit-conditionality internal 3-layer review (2026-08-18)

- **`specs/epic-dtlt-dt2-live-form-triage.md`'s Story 1.10 AC template is stale against the shipped
  Reading C ruling.** It still describes the old symmetric Reading A/B gating shape ("neither the
  `-mandDots` cost nor the `+bloodFruit` row appear" when the player opts out) — Reading C's actual
  shipped behaviour is asymmetric by design: the fruit row is now unconditional and the cost row is
  gone entirely, with no toggle to opt out of either. The epic doc was never updated when the ruling
  landed on the story file itself. Not this diff's fault (the epic doc is not in the story's own File
  List) and not fixed here; a future reader of the epic doc in isolation, without the story file's
  RULED header, would get the wrong mental model.
- **External reference memory is stale.** `C:/Users/angel/.claude/projects/D--Terra-Mortis-TM-Suite/memory/reference_vitae_deficit.md`
  (cited in dtlt-10's own story frontmatter as context) states Mandragora Garden "costs 1 vitae per
  dot" and "generates 2 fruit per dot" — both now false: Reading C removed the cost entirely, and
  the fruit multiplier was already 1x dots in the shipped code (`bloodFruit = mandDots`), not 2x, a
  pre-existing deviation from the errata's "twice that quantity" wording that predates this story
  and stays out of its scope. Not fixed here — it is a Claude memory file in a different project's
  namespace (`D--Terra-Mortis-TM-Suite`, the pre-rename project name), not a file this repo's diff
  touches. Worth a manual purge/update in a future session so it doesn't get cited as ground truth.
  Angelus's operational act, not a coding task.

## Deferred from: code review of fix.779.contacts-pt-merit-free-sum (2026-08-18, internal 3-layer)

Branch `ms/issue-779-contacts-pt-merit-free-sum` sat stranded from 2026-06-16 to 2026-08-18;
reconciled onto `dev` after passing internal review. All four items below were independently
verified against real code before deferral, not taken on a reviewer's word.

- **`meritFreeSum`/`freeOf` map-fallback staleness for evaluator-owned legacy slugs** —
  `public/js/data/rules-helpers.js` (`meritFreeSum`, `freeOf`). Six legacy slugs (`ohm`, `pt`,
  `mdb`, `bloodline`, `pet`, `sw`) have a live evaluator that unconditionally clears and
  rewrites their flat `free_<slug>` field on every render (confirmed by direct read of
  `ohm-evaluator.js`, `pt-evaluator.js`, `mdb-evaluator.js`, `bloodline-evaluator.js`,
  `style-retainer-evaluator.js`, `safe-word-evaluator.js`). Once the N-2 backfill script
  (`server/scripts/backfill-free-grants.js`) migrates one of these slugs into
  `m.free_grants[slug]`, `freeOf`'s map-wins precedence means that map value is frozen forever
  — the evaluator keeps recomputing the legacy field, but nothing ever reads it again for that
  slug on that merit. This is NOT specific to fix-779: the same map-fallback shape is already
  used identically in `mdb-evaluator.js`'s internal Mentor-rating calc and
  `safe-word-evaluator.js`'s `_effectivePartnerRating`, both predating this story. Two concrete
  consequences to design around: `pruneContactsSpheres` (`public/js/editor/domain.js:334-351`)
  could truncate a live sphere selection using a stale, too-low total (its truncate-only guard
  exists specifically to prevent data loss, so this would be exactly the failure it was built to
  avoid); `syncMeritRating` (`domain.js:319-321`) persists the stale total into `m.rating` on
  every save, so the error compounds instead of self-correcting. Real fix options: per-slug
  precedence (legacy-wins-on-conflict for evaluator-owned slugs, at the cost of `meritFreeSum`
  disagreeing with `freeOf`/the evaluator-internal reads unless those are updated too), or moving
  the six evaluators to write `free_grants` directly instead of the legacy flat field. Either is
  a real architectural story, not a one-line patch — recommend checking whether any live
  character currently has a map/legacy *mismatch* (not just both-set-equal) for one of these six
  slugs before scoping, to know if this is theoretical or already live.

- **AC-1's "displays 5 dots in the sheet editor" has no automated test exercising the actual
  render path** — `server/tests/fix-779-merit-free-sum.test.js` imports the raw `meritFreeSum`
  from `rules-helpers.js` directly; it never touches `domain.js`'s own `meritFreeSum` wrapper
  (the one every real caller — `syncMeritRating`, `pruneContactsSpheres`, `meritEffectiveRating`,
  `canAllocateCarthianPull` — actually goes through) or any sheet-editor rendering path. The
  arithmetic is covered; the acceptance criterion's actual display claim is not. Add an
  integration-level test through `domain.js`'s wrapper (or a render-path test) next time this
  area is touched.

- **AC-5's DB audit (20/20 characters correct) is stale and unauditable** — run 2026-06-16
  against then-live data, no script or output log retained in the repo, and not re-run at
  2026-08-18 merge time (live-DB verification is the user's own call per project convention).
  If PT/OHM/MDB/Bloodline/Pet-target merits have changed for any of the 20 originally-affected
  characters in the intervening two months, this claim should be treated as unverified until
  re-run.

- **Legacy-slug inclusion in `meritFreeSum` uses raw truthiness, not type-checking** —
  `public/js/data/rules-helpers.js` (`LEGACY_FREE_SLUGS.filter(s => m['free_' + s])`). A stray
  truthy-but-non-numeric legacy field (e.g. the string `"0"`, or a negative number from a
  data-entry error) would be included in the slug union and passed to `freeOf`, risking string
  coercion or an unbounded negative in the total instead of a clean numeric sum. Identical
  exposure existed in the pre-fix summing code — not introduced by this diff, just not
  addressed by it either.

## Deferred from: code review of gdx-2-mobile-type-scale (2026-08-20, internal 3-layer)

All six items below were independently verified against the live app (headless Chromium against the
real page, or direct source read) before deferral, not taken on a reviewer's word.

- **Pre-existing inline `style="font-size:Npx"` sites bypass this story's AC1 audit by construction**
  (it only scans `suite.css`/`components.css`) — `public/js/suite/territory.js:368` (12px),
  `public/js/tabs/downtime-form.js:5662` (12px), `public/js/app.js:2034` (11px). Pre-existing, not
  introduced by gdx-2, and already against this repo's own "no inline `style=`" CSS convention
  independent of this story. Candidate for a future sweep (e.g. gdx-4 mobile CSS cleanup).
- **`.npcr-modal`'s narrow-phone fix leaves zero gutter below ~400px** — `min-width:min(360px,100%)`
  (exactly what gdx-2's own Task 6 prescribed) sits the modal flush to both screen edges. Satisfies
  the story's literal AC3 (nothing clipped, fits at 360px and narrower); a cosmetic polish gap, not a
  functional violation. Worth padding the overlay in a future pass if breathing room matters.
- **200 literal `0.75rem` and 42 literal `0.6875rem` `font-size` values coexist with
  `var(--fs-floor-body)`/`var(--fs-floor-micro)` at the same computed sizes** in `suite.css` and
  `components.css` — gdx-2 only tokenised declarations it *raised* to the floor; declarations already
  at 12px/11px pre-conversion were left as plain rem literals. Retuning either floor token later would
  not move these ~242 sites. Not swept here — deciding whether "already 12px" was coincidence or the
  same floor concept is a design call, site by site, that gdx-2's own AC didn't ask for.
- **`.cc-alert.yellow{font-size:var(--fs-floor-body)}` is now dead** (`public/css/components.css`) —
  identical to its own base rule `.cc-alert{...font-size:var(--fs-floor-body)}` post-conversion, and
  `.cc-alert` itself has no live reference anywhere in `public/js/`, suggesting it predates this story
  as dead CSS. Candidate for gdx-4 (mobile CSS cleanup).
- **The AC2 sub-floor carve-out allowlist has two entries keyed to Chromium's CSSOM selector
  serialisation rather than authored source text** (`tests/desktop-and-css.spec.js`) —
  `:nth-child(2n+1)` for the authored `:nth-child(odd)`, and normalised whitespace/quoting for one
  attribute selector. Harmless while Playwright is Chromium-only in this repo (per `CLAUDE.md`); would
  fail for a spurious reason if a firefox/webkit project were ever added to `playwright.config.js`.
- **The AC3/AC4 Playwright test helpers mount a synthetic `<div class="tab active">` on
  `document.body`** rather than the real `#app`/tab ancestor chain (`tests/desktop-and-css.spec.js`),
  so an ancestor's own width cap or padding wouldn't be caught. gdx-2's specific fixes were
  independently re-verified against the real live page during this review, so this is test-methodology
  hardening for a future pass, not a live gap today.

## Deferred from: code review of admr-1-retire-bloodlines-admin (2026-08-26, external Codex)

- **`bl3b-constants-deleted.test.js`'s rewritten "AC 6" negative assertion
  (`expect(importers(), ...).toEqual([])`) has no positive control proving the scanner would actually
  detect a live, non-archive, non-test import if one appeared** (`server/tests/bl3b-constants-deleted.test.js`).
  The neighbouring test in the same describe block only confirms the archived seed script IS detected
  via a *different*, unexcluded code path - not that a hypothetical NEW non-archive/non-test importer
  would be caught by the same regex/walker. A future edit that silently breaks the `importers()` helper
  (e.g. a regex that stops matching one of the three quote styles) could leave this guard vacuously
  green. Low severity - the underlying real-world risk (a live route quietly reappearing as an
  importer without anyone noticing) is exactly what this test was written to catch, so the gap is in
  the test's own self-verification, not in its production coverage. A small fixture (a temporary file
  under `server/` importing the module, asserted to be caught, then removed) would close this.

## Deferred from: independent review of cmb-1-card-tracker-shell (2026-09-01, orchestrator inline 3-lens)

- **`combat-tab.js`'s new `_drag` gesture state (`{ active, charId }`) can get stuck `active: true`
  indefinitely.** Its `pointerdown`/`pointerup`/`pointercancel` listeners are scoped to the `.cbt-grip`
  element itself, not the document — a real drag gesture that starts on the grip and ends with the
  pointer released somewhere else (off the card entirely, which is the whole point of a reorder drag)
  never fires the grip's own `pointerup` handler, so `_drag.active` never resets. Currently harmless:
  `cmb.1` only exposes this state for its own AC6 tests and gates no behaviour on it. **`cmb.2` (the
  real drag-to-reorder story) must not build its tap-vs-drag disambiguation directly on this state
  without first adding a document-level (or Pointer Capture-based) release listener** — otherwise the
  exact "abandoned drag interferes with the next tap" failure mode this session's own party-mode
  roundtable (Sally) flagged against Sally's collapse/expand design would reappear here instead, one
  layer down.
- **`_cardHtml`'s NPC tag (`c.is_npc || c.npc`) is currently dead code.** No character document in
  this app's live data model carries either field — NPCs live in a separate `npcs` collection, never
  merged into `suiteState.chars` the way opponent player-characters are (via `/api/characters/combat`).
  Not a defect (the branch simply never renders today, matching AC3's letter), but it means the "NPC
  tag" part of AC1/AC3 is verified only against a hypothetical shape, not real NPC data. Worth a
  decision — likely surfacing during `cmb.3b`'s equipped-weapon work, which will hit the same "what is
  an NPC combatant here, really" question — on whether NPC opponents should reach the Combat tab's
  roster at all, and if so, through what real field.

## Deferred from: independent review of cmb-3a-attack-modal-shell (2026-09-01, orchestrator inline 3-lens)

- **(Low, informational, not a defect)** Rolling from the Attack modal now passes `loadPool` a
  target-specific label (e.g. `"Unarmed Combat vs Reed"`) as `POOL_NAME`, where the retired
  `combatQuickRoll` passed a bare skill name (e.g. `"Brawl"`). `public/js/game/power-mod-chips.js`
  (rlv.7's persistent modifier chips) keys its `localStorage` entries on `(charId, POOL_NAME)`, so
  this is a real, intentional side effect: any mod chips a player had already saved against a combat
  roll under the old skill-name key become unreachable (not deleted, just orphaned under a
  now-unused key), and going forward a chip added while attacking one target no longer carries over
  to a different target with the identical attack type — each attacker/type/target combination gets
  its own chip set rather than sharing one per skill. Not a bug against this story's own Acceptance
  Criteria (nothing in `cmb.3a` promises mod-chip continuity), not caught by any existing test (
  `rlv-7-persistent-mod-chips.spec.js` calls `loadPool` directly with its own test-chosen name and
  never exercised combat's naming convention), and arguably a reasonable default (finer-grained
  keying means less accidental cross-contamination between unrelated attack contexts) — but it is a
  real behavioural change to a different, already-shipped feature, worth Angelus's own read rather
  than assuming either direction is obviously correct.

## Deferred from: independent review of cmb-3c-damage-split (2026-09-01, orchestrator inline 3-lens)

- **(Low, pre-existing, newly reachable)** `public/js/game/tracker.js`'s `trackerAdj` only refuses a
  positive damage delta when the track is *already* full (`if (delta > 0 && used >= maxHp) return;`)
  — it does not clamp the size of the delta itself against remaining headroom. Every damage call site
  before this story only ever sent `delta: 1` (one button click), so this never mattered in practice:
  five individual `+1` clicks each re-check the guard and stop the moment the track fills. `cmb.3c`'s
  Apply button is the first caller in this codebase to send a delta greater than 1 (the computed split
  total), so a split that would overshoot a nearly-full health track (e.g. 2 boxes of headroom left,
  a split totalling 5) can push the stored damage past `maxHp` in one call, where the equivalent
  manual clicks would have stopped at the ceiling. Confirmed as pre-existing (not introduced or
  worsened by this story — the guard's own logic is unchanged), and the practical effect is cosmetic
  overshoot (the health box-track and `_isIncap`'s incapacitation check both already degrade
  gracefully when `dmg > maxHp`), not data corruption or a crash. This story's own test fixtures were
  deliberately built with headroom to avoid exercising the edge case rather than papering over it.
  Two candidate fixes for whoever next touches either file: clamp the delta itself inside `trackerAdj`
  (fixes every future multi-point caller, not just this one), or have `_splitApply` cap its own
  request against the card's remaining headroom before calling `applyDmg`. Not fixed here — genuinely
  a `tracker.js` concern shared by any future feature that applies damage in bulk, not specific to
  this story's own Acceptance Criteria.

## Deferred from: 2026-09-01/02 general-audit day (4-domain Workflow audit, 79 agents, adversarially verified; plus Kurtis W's own live bug reports) — P0 now RESOLVED, see below

- **(RESOLVED 2026-09-02, branch `ms/p0-coordinator-role-ownership-bypass`, committed `1b241614`,
  codex-reviewed 2026-09-02 — see the dated sub-entry below) High, security.**
  Five route files gated ownership checks on the literal string `req.user.role === 'player'` rather
  than excluding only ST (`!isStRole(req.user)`) — `server/routes/downtime.js` (GET+PUT, and POST too
  via the same shared `requireFormNotRetiredForPlayers` gate — confirmed by codex-review Pass 3;
  desirable, just under-described here originally), `history.js`, `questionnaire.js`,
  `ordeal-responses.js`, plus `game-sessions.js`'s DELETE (mount-level `requireRole('coordinator')`
  auto-expands to include st/dev, handler added no further check despite its own "(ST only)" comment).
  Fixed all five. While implementing, found and fixed two MORE instances of the identical bug the
  original audit hadn't caught: `middleware/ordeal-retirement.js`'s `requireOrdealNotRetiredForPlayers`
  (shared by history/questionnaire/ordeal-responses — without this fix a coordinator could bypass the
  Ordeals-retired block entirely and reach the handlers the other five fixes had just locked down), and
  `routes/characters.js`'s `GET /:id` (the one inconsistent spot in a file that already used the
  correct `!isStRole()` pattern in four other places, letting a coordinator read any character's full
  sheet). Deliberately left `attendance.js`'s look-alike check untouched at the time on the reasoning
  that check-in is the coordinator role's own job — **codex-review Pass 2 found that reasoning doesn't
  fully hold**: the specific check at `attendance.js:123` gates a PATCH that can flip a DIFFERENT
  character's downtime flag, not the coordinator's own check-in action. Left unpatched anyway (see the
  dated sub-entry below) because a coordinator already has equivalent access to the same field via the
  authorized `PUT /api/game_sessions/:id`, so the net privilege exposure is negligible. Verified with
  209 tests across 15 files (zero regressions) at the time of the original fix; a new static
  source-scan suite (`p0-coordinator-role-ownership-bypass.test.js`, no DB/markdown/ dependency, so it
  runs even in this checkout's degraded environment) plus a new real HTTP-level suite
  (`p0-coordinator-role-ownership-bypass-http.test.js`) that creates data as one player and proves a
  live coordinator account genuinely gets 403'd reading or writing it, with regression guards proving
  ST and "coordinator on their own data" still work. **Committed** `1b241614`, not yet pushed/PR'd.
- **(2026-09-02, codex-review of `1b241614`, 3 isolated passes — Blind Hunter/Edge Case
  Hunter/Acceptance Auditor, `reasoning_effort=high`) No High found by any pass; core authorization
  fix confirmed correct in all three.** Patched immediately (new commit, same branch): extended the
  static suite to also cover `ordeal-retirement.js` and `characters.js` (Pass 2 correctly caught that
  the original 5-file scan didn't cover the two extra fixes found during implementation — prove-
  discriminated by reverting `ordeal-retirement.js` and confirming the new assertions fail, then
  restoring). Dismissed with evidence: a claimed `ordeal-responses.js:116` crash risk for a
  coordinator with no `player_id` (Pass 1/3, converged) — `requireAuth` in `middleware/auth.js`
  unconditionally populates `player_id` from the `players` collection for every authenticated
  non-test-bypass user, so the dereference can't actually see `null`/`undefined`. Also dismissed:
  Pass 1/3's "0 tests executed, not 23 passed" reading of the static/HTTP suites — that's Codex's own
  sandbox lacking MongoDB Atlas network egress (`EACCES`) and failing a local-mongod TLS handshake
  (`ECONNRESET`), not a real repo defect; the orchestrating session re-ran both suites live, twice,
  getting real green results each time (23/23, then 27/27 after the patch above). Deferred, not
  patched here (real gaps, but no live bug and not worth widening this already-large P0 diff further):
  the HTTP suite's PUT-ownership assertions for downtime/history/ordeal-responses never reach the
  underlying ownership/deadline logic because the retirement-gate 403 fires first (both retirement
  flags are currently `true`); `questionnaire.js`'s PUT has no HTTP coverage at all; only
  `characters.js` GET has a "coordinator succeeds on their own data" positive regression test, not the
  other four surfaces. `attendance.js`'s residual bypass is covered in the entry above. Full raw
  findings: `specs/stories/code-review/p0-coordinator-role-ownership-bypass-pass{1,2,3}-findings.md`.
- **(Medium, data integrity, prepared not applied)** `server/scripts/fix-p1-audit-data-hygiene.js` and
  `server/scripts/cleanup-p1-orphaned-test-stmods.js`. Both dry-run by default with a full-document
  JSON backup before any write, both dry-run verified. Restored from stash and **committed 2026-09-02**
  (`ms/audit-2026-09-01-p2-p3-fixes`, commit `e953290e`, PR #1239) alongside the rest of the P2/P3 work.
  Not applied — Angelus runs destructive/mutating DB scripts himself via `!`.
- **(Low, display, deliberately out of scope)** `editor/sheet.js`'s Standing merit plain-name view row
  still has no per-dot ST-mod marking (unlike the Domain/Influence/General rows the P2 pass fixed) —
  its bonus band reads `m.rating` directly rather than `m.bonus`, and it isn't confirmed whether an
  active `.bonus` overlay even flows into `m.rating` for this merit category. Committed alongside the
  rest of P2/P3 (see above) as a documented gap, not a fix.
- **(RESOLVED 2026-09-02, branch `ms/kurtis-w-charlie-ballsack-bugs`)** Three live bug reports from
  Kurtis W, on his own character (Charlie Ballsack, `_id` `69d73ea49162ece35897a482`), all fixed:
  - **Domain Merit shared-partner ID leak + CSS overlap.** Confirmed live: Charlie's Safe Place/Haven
    `shared_with` arrays hold 24-hex `_id` entries (`69d73ea49162ece35897a48b`,
    `69f98167ed740b3098dc56ff`), not names. `resolveSharedWithMember` only searches whatever roster the
    caller passes it — for a player's own view that's their own role-scoped roster, which never
    contains the shared partner, so the raw ID string rendered in its place and overflowed the row.
    Fixed both ends: `server/routes/characters.js`'s player-scoped `_partner_dots` enrichment now
    resolves `shared_with` entries by `_id` as well as by name (mixed arrays included), and attaches a
    new `_partner_names` field (entry → `{name, honorific, moniker}`, everything `displayName()` needs)
    for whatever it resolved. `editor/sheet.js`'s `_viewSharedSub` (view-mode) and the edit-mode
    `dom-partners-row` (same leak, second instance found while fixing the first) both fall back to
    `_partner_names` when local resolution fails, instead of the raw entry string. No per-partner dot
    breakdown for a remotely-resolved partner (the enrichment only has a per-merit summed total,
    `_partner_dots`, used elsewhere) — the name renders correctly; that partner's own dot count is
    omitted rather than guessed at. New suite:
    `server/tests/kurtis-w-domain-partner-id-resolution.test.js` (4 tests: name-format regression
    guard, id-format — the fix, mixed array, unresolvable entry). Prove-discriminated by reverting the
    server enrichment and confirming 3 of 4 fail.
  - **Missing Professional Training dot-4 Stealth bonus.** Root cause: `preloadRules()`
    (`editor/rule_engine/load-rules.js`) hits `/api/rules/aggregate`, which was mounted `RE_ST` —
    `requireRole('st')` on the WHOLE mount, reads included — so a player got a 403 on every load. This
    is app.js's own already-documented failure mode (`loadAllData`'s comment literally says "preloadRules
    403 for a player against the ST-only rules-engine endpoint"): the 403 is swallowed by
    `Promise.allSettled`, `applyDerivedMerits` then bails out via the #249 null-cache guard, and
    *every* grant-pool-derived bonus for *every* player silently never renders — PT dot-4, MCI
    grants, OHM, bloodline rules, K-9/Falconry retainer auto-creation, all of it — not just Charlie's
    Stealth bonus; he's just the report that named a concrete, visible symptom. The 9 rule-engine
    routes (`grant`, `speciality_grant`, `skill_bonus`, `nine_again`, `disc_attr`,
    `derived_stat_modifier`, `tier_budget`, `status_floor`, `bonus_success`) plus the aggregate
    endpoint are pure reference/rule-definition data, not a player secret — same shape as
    `purchasable_powers` (`rules.js`), which is already public-GET/ST-write. Fixed to match: reads open
    to any authenticated user at the `server/index.js` mount level; writes now protected inside
    `rules-engine.js`'s own `makeRulesRouter` (`requireRole('st')` on POST/PUT/DELETE specifically),
    so loosening the mount cannot also open write access. `server/tests/helpers/test-app.js` updated
    to match (it mirrors prod's mounts, not a live import of them). Existing coverage
    (`api-rules-engine.test.js`, `api-rules-aggregate.test.js`) had "player blocked → 403" on GET for
    all 9 categories + aggregate — flipped to "player can read" (200 + shape check) with a new
    companion "player still blocked from POST" (403) added alongside every one, so the write-side
    tightening this fix depends on has its own explicit regression guard, not just an absence of a
    stale assertion.
  - **"Safe Place capped by Safe Place" confusing message.** Root cause: NOT a logic bug — Haven really
    is capped by its attached Safe Place, correctly. The wording was the problem, on two counts. (1)
    Neither the "needs an attached anchor" nor the "capped at N" derived-note named the merit it was
    describing, so a Haven row's own cap-warning read as a bare "Safe Place limits effective dots"
    sitting directly under a subtitle that ALSO reads "Attached to: Safe Place (...)" — easy to misread
    as self-referential. (2) View-mode copy (`editor/sheet.js` `_viewCappedNote`) hardcoded "Safe
    Place" even for Mandragora Garden, which (N-8, issue #761) can anchor to a Necropolis Sepulcher
    instead — a genuinely WRONG message in that case (confirmed by reproducing it: a Sepulcher-anchored
    Mandragora Garden rendered "Capped at 1 — Safe Place limits effective dots" pre-fix), not just
    unclear copy. Edit-mode already generalised this correctly; view-mode had not. Fixed: both
    messages now name the merit (`"Haven needs an attached Safe Place (0 effective dots)"`, `"Haven
    capped at 1 by its attached Safe Place"`) and Mandragora Garden's copy generalises to "Safe Place
    or Sepulcher" / "anchor" like edit-mode already did. New suite:
    `server/tests/kurtis-w-cap-warning-copy.test.js` (4 tests covering both merits × both message
    shapes). Prove-discriminated by reverting the copy and confirming all 4 fail — the failure output
    itself reproduces the Sepulcher-mislabelled-as-Safe-Place bug verbatim.

  267/267 across the 17 directly-relevant test files (characters/rules-engine/domain-merit-render
  suites). Full untargeted server run: 4897 passed / 30 failed / 76 skipped across 263 files — every
  failure accounted for: the repo's own documented pre-existing set (CLAUDE.md), the 8
  `*-parallel-write.test.js` files (documented Atlas-contention flake class), plus one this run's own
  addition, `oxp-1-office-seats.test.js`'s concurrent-apply race test — confirmed a full-suite
  contention flake, not a regression, by re-running it alone (50/50 clean). Zero failures traced to
  anything this branch touches.

  **ADDENDUM, 2026-09-19 (storytab.4 code review, unrelated branch, same test)**: seen again, and
  worse — three full-suite runs on that session's own machine, made to settle an external reviewer's
  attribution question about this same test, all HUNG (worker process alive, near-zero CPU, zero log
  progress for 8+ minutes) at the exact point this test begins, rather than merely failing one
  assertion. Atlas itself was confirmed healthy throughout (targeted Mongo-backed runs completed in
  under 6s each). Not investigated further there either (well outside that story's own scope, and this
  entry's own conclusion — full-suite contention flake, not a regression — already answered the actual
  question needed), but recorded here since a hang is a more severe symptom than an assertion failure
  and this entry is the natural place a future investigation would look first. If this recurs a third
  time across unrelated branches, it may be worth a dedicated investigation rather than continuing to
  treat each occurrence as isolated noise.
- **(RESOLVED 2026-09-02, branch `ms/haven-collective-sharing`, commit `e22e31ea`, PR #1243)** Live
  follow-up from Kurtis W after the fixes above went out: Haven read "capped at 1" regardless of the
  coterie's real shared Safe Place total. Root cause: `meritEffectiveRating`'s `CAP_DOMAIN` branch
  never summed partner contributions the way Safe Place's own `domMeritTotalSingle` does — it only
  ever read the viewing character's own Haven investment. Confirmed against the merit's own rules
  text ("Like a Safe Place, a coterie may share a Haven Merit... Each member that wishes to benefit
  must invest Merit dots in both the Safe Place and the Haven") — this was never a display bug, Haven
  was genuinely never wired up as a collectively-summed merit. Fixed by mirroring
  `domMeritTotalSingle`'s combining pattern (own + partners' own Haven dots, by-name lookup falling
  back to the server's `_partner_dots` enrichment, gated on owning ≥1 dot yourself, suspending own
  dots before combining per ADR-010 D2/OATH-B). **Mandragora Garden deliberately excluded** — per
  Angelus's ruling it can no longer be shared at all (it used to be; legacy `shared_with` data on it
  stays inert, same treatment this file already gives elsewhere), verified byte-identical via two
  dedicated regression tests. 6 new tests (`haven-collective-sharing.test.js`), prove-discriminated.
  458/459 across the 29 directly-relevant domain-merit/oath test files (the 1 failure is the same
  pre-existing stale-literal-match test noted above).
- **(Investigated, NOT a bug, 2026-09-02)** Kurtis W reported his Resilience discipline (an
  Oath-of-Serfdom `st_mods` bonus, base `dots:0`) still not showing after a hard reset. Exhaustively
  verified live against real production data (local server against live Atlas, both ST and Kurtis's
  own real player account/character_ids): the API returns identical, correct data for both roles: the
  composition function correctly produces `{dots:1}`, and the render function correctly produces a
  genuinely solid gold-filled, ring-marked dot (confirmed via actual computed DOM styles, not just
  the HTML string). Cross-checked the identical pattern on Ryan Ambrose's own Celerity (also an
  Oath-sourced `dots:0` discipline, the subject of last night's `e99b6c13` fix) — same result, composes
  and renders correctly right now. No code defect found on either character after two independent,
  real-data verification passes. Likely remaining explanation: client-side staleness (service
  worker/PWA cache) on the affected devices that a normal hard-reset doesn't clear — not something
  this session could reproduce or fix. Mid-investigation, briefly (and wrongly) concluded this was a
  role-specific bug (player fetch missing the discipline entirely) — that was an artifact of a stale
  local test server still running pre-edit code, corrected once caught; recorded here so the false
  lead doesn't get rediscovered.
