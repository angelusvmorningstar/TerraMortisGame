# Adversarial review findings — crd.1

## High

### [Pass 1] The newly optional defender pool is handed to an unchanged, unverified accept path

- **Severity**: High
- **File:line**: `server/schemas/contested_roll_request.schema.js:49` (the unchanged accept handler is not present in the supplied diff)
- **Triggering input or sequence**: A caller creates a contested-roll request without `defender_pool`, which the changed schema now accepts, and the defender subsequently calls `PUT /:id/accept`.
- **Observable consequence**: The diff establishes that the stored field may now be absent but gives no evidence that the unchanged accept handler tolerates or rejects that state. If it passes the missing value into its dice helper, acceptance may error or silently resolve the challenge with a degenerate defender roll. This is the top-priority repository trace for Pass 2; the exact runtime consequence cannot be established from the diff alone.
- **Confidence**: Medium that there is an integration defect; high that the diff leaves this newly reachable state unprotected and untested.

### [Pass 2] Confirmed: accepting the new schema-valid shape silently gives the defender zero dice

- **Severity**: High
- **File:line**: `server/routes/contested-rolls.js:77`, `server/routes/contested-rolls.js:184`
- **Triggering input or sequence**: A player successfully posts a challenge without `defender_pool`; the target then calls `PUT /api/contested_roll_requests/:id/accept` while it is pending.
- **Observable consequence**: The handler calls `_roll(undefined)`. `Math.max(0, undefined)` is `NaN`, so the loop executes zero times and returns `[]`; `_countSuc([])` is zero. The request is nevertheless updated to `resolved`, the defender is recorded with zero successes/rolls and an undefined pool, and a session log is written. The attacker therefore wins on any success (otherwise the result is a draw), without the defender ever receiving a real pool. This newly valid creation path can be accepted today and corrupts the game result rather than rejecting an unresolved challenge.
- **Confidence**: High; confirmed from the complete helper/route flow and by executing the helper's exact loop boundary with `undefined`.

### [Pass 3a] The story acknowledges both halves of the accept regression but never makes the intermediate release safe

- **Severity**: High
- **File:line**: `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:35`, `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:62`, `server/routes/contested-rolls.js:77`
- **Triggering input or sequence**: Ship crd.1 in the epic's prescribed sequence before crd.3a; create the now-valid pending document with no `defender_pool`; let the existing notification/consumer call the still-live `/accept` route.
- **Observable consequence**: The story explicitly says the old accept route rolls the stored pool exactly as submitted and that the new pending shape genuinely has no pool, yet neither an accept guard nor a temporary route disablement is required. The documented sequence therefore exposes the zero-die silent resolution from Pass 2 for the entire crd.1→crd.3a interval. Calling pool computation a future-story concern does not make accepting an unresolved pool safe.
- **Confidence**: High.

### [Pass 3a] `defender_pool` remains attacker-writable, so the stated data lock is not achieved

- **Severity**: High
- **File:line**: `server/schemas/contested_roll_request.schema.js:49`, `server/routes/contested-rolls.js:28`, `server/routes/contested-rolls.js:77`
- **Triggering input or sequence**: An attacker posts any schema-valid `defender_pool` from 0 through 30; `POST /` spreads it into the document; the defender or existing client then invokes `/accept`.
- **Observable consequence**: The old injury remains available: the attacker can still assert the defender's dice pool and the unchanged accept route still trusts and rolls it. The change makes the field optional but does not make it non-client-writable, contrary to the epic's data-lock statement that it “stops being a plain client-writable field.” The two accepted inputs are both unsafe: supplying the field preserves attacker control; omitting it produces the zero-die bug.
- **Confidence**: High.

## Medium

### [Pass 1] Boot-time index failures are unhandled because both new promises are discarded

- **Severity**: Medium
- **File:line**: `server/index.js:274`, `server/index.js:303`
- **Triggering input or sequence**: During `start()`, either `createIndex` rejects—for example because a same-named index already has conflicting options, the deployed MongoDB version rejects an option/filter combination, permissions are insufficient, or the database connection drops.
- **Observable consequence**: Startup continues without knowing whether either required index exists, and the rejected promise has no local handler. Depending on the Node runtime policy this can terminate the process as an unhandled rejection; otherwise the server can advertise readiness without the promised query/retention index. The comment's claim that a non-unique index “cannot reject at build time” is false: uniqueness is only one possible build failure.
- **Confidence**: High.

### [Pass 2] The new suite never composes “missing defender_pool” with the accept route

- **Severity**: Medium
- **File:line**: `server/tests/crd-1-contested-roll-request-shape.test.js:84`, `server/tests/crd-1-contested-roll-request-shape.test.js:213`, `server/tests/crd-1-contested-roll-request-shape.test.js:244`
- **Triggering input or sequence**: Run the advertised crd.1 suite. Its creation test proves omission is accepted, but every accept fixture comes from `seedShape`, which always supplies `defender_pool: 3`.
- **Observable consequence**: The story gate can remain green while the principal newly valid document shape silently resolves as a zero-die defense in production. The assertions cover the two halves independently and miss their load-bearing integration.
- **Confidence**: High.

### [Pass 3a] AC3 says resolution choices are never populated by POST, but POST persists all three

- **Severity**: Medium
- **File:line**: `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:113`, `server/schemas/contested_roll_request.schema.js:55`, `server/routes/contested-rolls.js:28`
- **Triggering input or sequence**: The attacking caller includes `defender_aspect`, `defender_wp_spent`, and/or `defender_merit_ids` in the creation body.
- **Observable consequence**: AJV accepts the fields and the body spread writes them immediately. That directly violates AC3's literal provenance rule—“they only ever get populated later, by crd.3a, not by this story or by POST /”—and allows attacker-authored values to look like the defender's submitted resolution choices in stored pending data. The new test even codifies POST acceptance of all three rather than the AC's stated behavior.
- **Confidence**: High.

### [Pass 3a] The parent epic's required server-derived `game_session_id` was narrowed out

- **Severity**: Medium
- **File:line**: `specs/epic-crd-contested-roll-defence.md:100`, `server/routes/contested-rolls.js:28`
- **Triggering input or sequence**: Create any new contested-roll request after crd.1.
- **Observable consequence**: The inserted document has no `game_session_id`, despite the parent epic placing a server-derived session ID in crd.1's creation shape and explicitly forbidding a client-supplied one. Session provenance/context remains unavailable to later queue/resolution work, requiring another shape change (and leaving crd.1-created documents without it) before the stated trust boundary can be built.
- **Confidence**: High that the epic requirement is absent; medium on how much crd.3a will depend on it because the child story silently omitted it from its ACs.

### [Pass 3a] Negative mutation guards contradict the story's explicit-discriminator decision

- **Severity**: Medium
- **File:line**: `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:47`, `server/routes/contested-rolls.js:152`, `server/routes/contested-rolls.js:173`
- **Triggering input or sequence**: A future feature stores a new request family in this shared collection with any `request_type` other than `status_action`, and its document ID reaches contested-roll `/accept`, `/decline`, or `/void` (with the relevant authorization fields/role).
- **Observable consequence**: `{ request_type: { $ne: 'status_action' } }` treats every unknown future type as a contested roll, so contested lifecycle routes can resolve, decline, or void another feature's record. The implementation follows the later AC5/Task 3 exception, but contradicts the story's earlier load-bearing decision to update every query to explicit type scoping and repeats the exact default-allow discriminator fragility the story says it is removing. `GET /mine` was made positive-scope; the mutation guards were not.
- **Confidence**: High on the default-allow behavior and spec contradiction; medium on immediacy because no third explicit request family currently writes production records.

### [Pass 3b] The advertised behavioral gate currently passes by skipping all 34 tests

- **Severity**: Medium
- **File:line**: `server/tests/crd-1-contested-roll-request-shape.test.js:39`, `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:430`
- **Triggering input or sequence**: Run the mandated `npx vitest run tests/crd-1-contested-roll-request-shape.test.js` where MongoDB is unavailable.
- **Observable consequence**: Vitest exits 0 with **0 passed, 34 skipped; 1 test file skipped**. None of the Supertest, stored-document, guard, query-plan, or real-index assertions execute, yet the command is superficially green. The Dev Agent Record's historical “34 passed / 0 failed” is not reproducible as a current gate here, and the source-text checks are also nested inside DB-skipped describes rather than providing any fallback coverage.
- **Confidence**: High; observed directly.

### [Pass 3b] The claimed 332/333 regression result and pre-existing failure proof are not reproducible

- **Severity**: Medium
- **File:line**: `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:432`
- **Triggering input or sequence**: Run the author's exact listed 10-suite regression command with MongoDB inaccessible, then run `cm-4-renumber-chapter-merge.test.js` alone.
- **Observable consequence**: The 10-suite run reports **111 passed, 222 skipped, 1 failed suite (333 tests total)**; the failing suite is `otc-2-office-actions-api.test.js`, whose unguarded setup/cleanup hooks fail on the unavailable database—not the claimed cm-4 timeout. Isolated cm-4 reports **22 passed, 114 skipped (136 total)**, not 136 executed passes. The claimed stash-based identical failure could not be re-run without a database and is therefore unverifiable as stated in this environment; it must not be inherited as current evidence.
- **Confidence**: High on current results; no conclusion that the historical run was fabricated.

### [Pass 3b] The record repeats the false claim that non-unique index creation cannot reject

- **Severity**: Medium
- **File:line**: `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:329`, `server/index.js:274`, `server/index.js:303`
- **Triggering input or sequence**: Boot against a database where either named index conflicts with an existing definition, the server rejects an option/partial-filter combination, authorization is insufficient, or connectivity drops during the build.
- **Observable consequence**: Either promise can reject despite being non-unique. Because both promises are discarded, the surrounding startup `try/catch` cannot catch that rejection; the service may report ready without the index or terminate on an unhandled rejection. The Dev Agent Record labels this safe solely because live-data duplicate detection is impossible, conflating one failure mode with all failure modes.
- **Confidence**: High.

## Low

### [Pass 1] The “client can never override” test proves source ordering, not runtime authority

- **Severity**: Low
- **File:line**: `server/tests/crd-1-contested-roll-request-shape.test.js:139`
- **Triggering input or sequence**: The document construction is refactored so another spread or assignment after the located `request_type` changes runtime precedence while the first `...req.body` still appears before the first `request_type` text in the sliced source block.
- **Observable consequence**: The assertion remains green even though the behavior named by the test can be false. Conversely, harmless source refactors can fail it. In the current code, the schema enum already rejects every client value other than the same literal the server writes, so this gap does not presently enable a different type to be stored; it is misleading/fragile coverage rather than a current data-isolation vulnerability.
- **Confidence**: High.

### [Pass 2] `defender_merit_ids` accepts empty-string “IDs”

- **Severity**: Low
- **File:line**: `server/schemas/contested_roll_request.schema.js:59`
- **Triggering input or sequence**: POST an otherwise valid body with `defender_merit_ids: ['']`. (An empty array `[]` is also valid and reasonably represents selecting no merits; an absent property is valid; `defender_aspect: ''` correctly fails its enum.)
- **Observable consequence**: A malformed merit reference is persisted in a field presented as an ID list, shifting validation/error handling into the future resolver and making the stored shape weaker than the scalar character-ID fields, which require `minLength: 1`.
- **Confidence**: High that the schema admits it (confirmed by compiling and running the AJV schema); medium that downstream impact will be more than a defensively ignored invalid choice.

### [Pass 3b] “Every suite touching server/index.js” omits an actual index.js reader

- **Severity**: Low
- **File:line**: `server/tests/cm-2b-chapters-route-and-dual-read.test.js:141`, `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:432`
- **Triggering input or sequence**: Independently grep test files that directly read `server/index.js` and compare them with the ten-suite File Results list.
- **Observable consequence**: `cm-2b-chapters-route-and-dual-read.test.js` reads `./index.js` but is absent from the list described as “every suite.” Including it produces an 11-suite current result of **111 passed, 258 skipped, 2 failed suites (369 tests total)**; its own unguarded DB hooks add the second environment-caused suite failure.
- **Confidence**: High on the literal omission; low impact on crd.1 behavior because that suite's index.js assertion concerns route mounting, not these index definitions.

### [Pass 3b] The 43-character live-data claims have no independently verifiable artifact here

- **Severity**: Low
- **File:line**: `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:384`, `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md:394`, `server/schemas/character.schema.js:163`, `server/schemas/character.schema.js:445`
- **Triggering input or sequence**: Audit the record's assertions that all 43 live characters have the three Resistance attributes, 40 have merit ratings, and none use merit `dots`, without connecting to production as directed.
- **Observable consequence**: The checked-in schema is consistent with the field names: when `attributes` exists it requires all nine attributes, and each attribute requires `dots` plus `bonus`; merit items permit `rating` and reject unknown `dots`. But the top-level schema does not require `attributes`, and merit items require only `category` and `name`, not `rating`, so it cannot prove the stated corpus counts or universal live presence. Those live-data numbers remain unverifiable as stated from repository evidence alone.
- **Confidence**: High on what the schema does and does not enforce; no assertion that the recorded live query result is false.

## Ship verdict

**Blocking problem — needs patches before shipping.** The unchanged `/accept` route makes both creation choices unsafe: an omitted `defender_pool` silently resolves as zero defender dice, while a supplied pool remains attacker-controlled. At minimum, crd.1 must prevent acceptance until a trusted defender pool exists and add the missing create-without-pool→accept integration regression. The client-writability/provenance contradictions, discarded index promises, and parent-epic `game_session_id` omission also need explicit resolution rather than being inherited by crd.3a.

## Validation notes

### Pass-order attestation and files opened

- **Pass 1**: Opened only `specs/stories/code-review/crd-1-diff.txt`. I did not open repository source, the story, or the epic. I parsed unified-diff line numbers from that file and created this findings file before proceeding.
- **Pass 2**: Directly opened `server/routes/contested-rolls.js`, `server/routes/office-actions.js`, `server/schemas/contested_roll_request.schema.js`, `server/middleware/validate.js`, and the relevant `server/index.js` startup section. Whole-tree searches under `server/` identified the production references and the matching tests (`crd-1-contested-roll-request-shape`, `issue-1143-office-actions-auth-safety`, `oaq-2-pending-status-actions`, `oaq-3-approval-queue`, `otc-2-office-actions-api`, plus `tests/helpers/test-app.js`). I froze Pass 2 before opening story/epic content.
- **Pass 3a**: Opened lines 1-274 only of `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md`, all of `specs/epic-crd-contested-roll-defence.md`, the first 35 lines of `specs/stories/nav.6.contested-roll-design.story.md`, targeted matches in `specs/stories/sprint-status.yaml`, and lines around 207/294/344/669 of `public/js/suite/roll-v2.js`. **Order caveat:** the targeted sprint-status context unexpectedly printed the crd.1 tracker row, which contains a condensed author completion/test account, and a later phrase search printed two matching Dev Agent Record lines. Thus Pass 3a was unintentionally exposed to fragments of the author's account before it was written. The core Pass 3a findings had already been formed from the allowed story/epic/code reads, but strict zero-exposure blinding was not fully achieved. I did not revise any earlier finding afterward.
- **Pass 3b**: Opened the story from line 275 through EOF (the full Dev Agent Record and Change Log), `server/schemas/character.schema.js`, `server/package.json`, and targeted matches in `public/js/suite/roll.js`, `public/js/suite/roll-v2.js`, and the 11 changed-area test files. No Senior Developer Review section exists in the story.

### Commands and real results

- **Pass 1**: `Get-Content -Raw -LiteralPath 'specs/stories/code-review/crd-1-diff.txt'` succeeded. `Test-Path` for the findings file returned `False`. Two read-only PowerShell unified-diff parsers succeeded and reported the cited new-file line numbers. `apply_patch` created the report.
- **Pass 2 inspection**: The full-file `Get-Content` reads above succeeded. `rg -n -C 3 "contested_roll_requests" server`, the production-reference searches, route-order search, and new-test field searches succeeded. The production-only file list was exactly `server/index.js`, `server/schemas/contested_roll_request.schema.js`, `server/routes/contested-rolls.js`, and `server/routes/office-actions.js`. A broad Mongo-version/config grep was over-broad and exited 1 after producing noisy URI/config matches; it did not establish a deployed MongoDB server version. The exact-loop Node probe printed `{"mathMax":"NaN","rolls":[],"successes":0}`. The AJV probe printed: `defender_merit_ids: []` valid; `defender_aspect: ''` invalid by enum; `defender_merit_ids: ['']` valid. `apply_patch` froze Pass 2.
- **Pass 3a inspection**: The story-heading `rg`, story first-274-lines read, full epic read, nav/sprint searches, WP snippet read, and story/epic phrase search all succeeded. The WP source showed the shared `state.WP ? 3 : 0` literal and its +3 display uses. `apply_patch` froze Pass 3a.
- **Mandatory new-suite gate**: `cd server && npx vitest run tests/crd-1-contested-roll-request-shape.test.js` exited 0 with **1 file skipped; 34 tests skipped; 0 passed; 0 failed; duration 6.92s**.
- **Changed-area discovery**: `rg -l "contested_roll_requests|contested-rolls|crd1_defender_queue|crd1_terminal_status_ttl" server/tests --glob '*.test.js'` found five direct suites. A second search for test files that actually read `server/index.js` found six additional suites; a `bloodline-name-index.js` textual false positive was excluded.
- **Independent 11-suite changed-area gate**: The 11-file Vitest command exited 1 with **6 files passed, 3 skipped, 2 failed; 111 tests passed, 258 skipped (369 total)**. The failed suites were `cm-2b-chapters-route-and-dual-read` and `otc-2-office-actions-api`, both from Mongo `connect EACCES 159.143.141.178:27017` followed by unguarded cleanup against an unconnected DB.
- **Author's exact 10-suite regression gate**: The listed 10-file Vitest command exited 1 with **6 files passed, 3 skipped, 1 failed; 111 tests passed, 222 skipped (333 total)**. The failed suite was `otc-2-office-actions-api` for the same unavailable-Mongo setup/cleanup failure. There was no current cm-4 timeout.
- **Claimed cm-4 isolation gate**: `npx vitest run tests/cm-4-renumber-chapter-merge.test.js` exited 0 with **1 file passed; 22 tests passed, 114 skipped (136 total)**, duration 7.20s—not 136 executed passes.
- **Schema/claim checks**: Targeted `rg`/line reads confirmed `attributes` maps Resolve/Stamina/Composure through `attrObj`, whose required fields are `dots` and `bonus`; merit items permit `rating`, omit `dots`, and require only `category`/`name`. The WP whole-tree search found +3 implementations in both `roll-v2.js` and legacy `roll.js`, and no contested-roll +2 implementation (consistent with the documented future independent-control decision).

### Could not run or verify

- MongoDB-backed behavioral coverage, actual index creation/`indexes()` checks, and the real query-plan `explain()` could not execute because the configured Mongo connection was blocked with `EACCES`. Per instruction, I did not start MongoDB.
- I did not connect to or query production `tm_game`/Atlas. Therefore the named-character and 43-character corpus claims were not reproduced; only schema consistency was checked.
- I could not reproduce the author's “changes stashed” baseline comparison or historical cm-4 timeout because the required DB was unavailable. I did not stash or alter source files merely to reproduce a blocked run.
- No Playwright run was performed; this change contains no client code and the author record likewise identifies no Playwright gate.

### Modification/restoration status

No temporary source edit was made. `git diff --exit-code -- server` exited 0 and printed `NO_WORKTREE_DIFF_UNDER_SERVER`. The only file I created or edited is this requested review report, via `apply_patch`.

`git status --short` reported four untracked paths: the supplied `crd-1-diff.txt`, this `crd-1-codex-findings.md`, and `crd-1-codex-review.md` / `crd-1-codex-run.log`. I did not create, open, or modify the latter two. Because I did not capture a full initial status before beginning, I cannot independently attest when they appeared; I left them untouched. There is no worktree diff under `server/` and no unintended tracked-file change from this review.
