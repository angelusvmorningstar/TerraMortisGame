# Adversarial Review Findings — crd.2

## High

- None found.

## Medium

### [Pass 1] Challenges arriving after boot never refresh the inactive queue badge

- **Severity:** Medium
- **File:line:** `public/js/game/pending-queue.js:84`, `public/js/game/pending-queue.js:105`, `public/js/game/pending-queue.js:167`; `public/js/app.js:1547`
- **Triggering input or sequence:** A player boots the app when `GET /api/contested_roll_requests/mine` is empty, then another player creates a challenge while the defender remains anywhere except the Challenges tab. The only non-tab fetch is the single boot-time `refreshPendingQueueBadge()` call, and every 10-second tick is skipped unless the queue tab is active.
- **Observable consequence:** The Challenges tile and shared More badge remain clear for the rest of that session, so the defender receives no indication that a new pending challenge exists until they proactively open the queue (or reload). A boot-time fetch failure has the same indefinite effect: `fetchFailed` is set but not surfaced by the boot path and no inactive retry is scheduled.
- **Confidence:** High from the diff's complete new module and visible boot call; later repository context may reveal an independent cache refresh.

### [Pass 1] Boot badge refresh can overwrite a newer queue fetch

- **Severity:** Medium
- **File:line:** `public/js/game/pending-queue.js:105`, `public/js/game/pending-queue.js:173`
- **Triggering input or sequence:** The fire-and-forget boot `refreshPendingQueueBadge()` request starts; before it resolves, the player opens Challenges and `_refetchAndRender()` completes with a newer snapshot; the older boot request then resolves last. `_fetchGen` protects only `_refetchAndRender()` calls, while `refreshPendingQueueBadge()` writes `state.rows` without joining that generation discipline.
- **Observable consequence:** The rendered list can disagree with the cached rows/badge. On the next active poll, diffing against the stale overwritten cache can fabricate a resolved row, resurrect an already-departed item in cache, or fail to report the actual transition cleanly.
- **Confidence:** Medium-high; the write race is definite, while reachability depends on whether a player can navigate before the boot request settles.

### [Pass 2] Queue poll results never recompute the shared More badge

- **Severity:** Medium
- **File:line:** `public/js/game/pending-queue.js:196`, `public/js/game/pending-queue.js:216`; `public/js/app.js:518`, `public/js/app.js:2021`
- **Triggering input or sequence:** Boot finds a pending challenge and lights `#more-badge`; the player opens Challenges; while that tab is active, a later poll sees the request leave the pending set. The inverse also occurs when opening the queue discovers a request that the boot fetch did not know about. `_refetchAndRender()` updates `state.rows`, but neither it nor `goTab('more')` invokes `checkMoreBadge()`.
- **Observable consequence:** The shared More badge stays visibly on after the queue empties, or stays off after the queue discovers pending work. Returning to More refreshes the per-tile dot from the cache but still does not correct `#more-badge`; correction depends on unrelated actions such as visiting Feeding/Downtime or reloading.
- **Confidence:** High after tracing every `checkMoreBadge()` call site in `public/`.

### [Pass 2] Desktop players have no visible Challenges badge

- **Severity:** Medium
- **File:line:** `public/js/app.js:1994`, `public/js/app.js:2175`, `public/js/app.js:2203`; `public/css/suite.css:1690`
- **Triggering input or sequence:** A player uses desktop mode with one or more cached pending challenges. Mobile `renderMoreGrid()` evaluates each app's `badge` callback and emits a `.nav-badge`, but `renderDesktopSidebar()` renders the same `MORE_APPS` entries without evaluating or emitting `app.badge`; desktop CSS hides the bottom nav containing `#more-badge`.
- **Observable consequence:** The Challenges sidebar tile looks identical whether it has pending work or not. The new badge signal has no visible desktop consumer, so desktop defenders must open the queue speculatively.
- **Confidence:** High from the complete rendering paths and desktop CSS.

### [Pass 2] Queue row metadata is clipped on phone widths

- **Severity:** Medium
- **File:line:** `public/css/suite.css:75`, `public/css/suite.css:2364`, `public/css/suite.css:2366`, `public/css/suite.css:2379`, `public/css/suite.css:2383`; `public/js/game/pending-queue.js:262`
- **Triggering input or sequence:** Render an ordinary pending row on a phone-width viewport. The non-shrinking `.oaq-queue-actions` holds a roll badge, a `white-space: nowrap` target label, and a 19-character timestamp on one line, while the containing tab forcibly hides horizontal overflow and there is no `cq-` phone breakpoint.
- **Observable consequence:** The action cluster exceeds the available row width; the flexible challenger-name column collapses and trailing metadata is clipped. A phone player can lose the challenger identity and/or timestamp, undermining the row grammar needed to choose the right challenge.
- **Confidence:** High. A temporary real-DOM Chromium probe at 390 px confirmed `row.scrollWidth > row.clientWidth`, the actions extending past the row's right edge, and the challenger-name column collapsing to 0 px; the probe was then deleted.

### [Pass 3b] The test record reports Mongo-skipped and failed gates as fully passed

- **Severity:** Medium
- **File:line:** `specs/stories/crd-2-player-facing-pending-queue.md:443`, `specs/stories/crd-2-player-facing-pending-queue.md:449`; `server/tests/crd-2-pending-queue.test.js:378`
- **Triggering input or sequence:** Run the required focused gate now, then run the record's named 16-suite regression set in this environment. The focused gate reports `48 passed | 2 skipped (50)`, not 50 passed. The 16-suite set reports `12 passed | 3 skipped | 1 failed` files and `361 passed | 118 skipped (479)` tests; `otc-2-office-actions-api.test.js` fails Mongo setup with `connect EACCES`, then its cleanup fails because the DB never connected.
- **Observable consequence:** The record's “50 passed / 0 failed” and “16 files passed, 479 passed / 0 failed” statements are false as current gate results. In particular, the two AC6 server-scoping tests did not execute, so the focused run does not currently prove authenticated `/mine` scoping or the multi-character server result.
- **Confidence:** High; these are the exact current runner summaries. This may be environment-dependent, but a skip is not a pass and the broader gate is not green here.

## Low

### [Pass 1] A failed poll extends a resolved row beyond the promised one tick

- **Severity:** Low
- **File:line:** `public/js/game/pending-queue.js:188`, `public/js/game/pending-queue.js:194`
- **Triggering input or sequence:** A successful poll removes a pending request, placing it in `state.resolved`; the next scheduled poll fails. The failure branch sets only `state.fetchFailed = true` and leaves `state.resolved` unchanged.
- **Observable consequence:** The dimmed, untappable Resolved row remains visible through the failed tick (and through any number of consecutive failures), contradicting the module/CSS promise that it is dropped on the next poll tick. This is stale UI rather than a destructive action.
- **Confidence:** High.

### [Pass 1] Source-text assertions overstate routing and CSS coverage

- **Severity:** Low
- **File:line:** `server/tests/crd-2-pending-queue.test.js:272`, `server/tests/crd-2-pending-queue.test.js:497`, `server/tests/crd-2-pending-queue.test.js:508`
- **Triggering input or sequence:** The implementation is changed so the relevant tokens still occur somewhere in each source file, but `goTab()` no longer forwards `ctx`, or a `cq-` class appears only in a comment, or a colour literal moves into a multiline rule body that the line-based filter does not select.
- **Observable consequence:** Tests labelled as proving context forwarding, complete class definition, and colour-token discipline can remain green without proving those claims. The behavioral row-routing test exercises the queue's call into a mocked `window.goTab`, not the real dispatcher receiving/forwarding the payload.
- **Confidence:** High that the assertions are weaker than their labels; this does not by itself prove the current implementation is wrong.

### [Pass 3a] Story metadata points at the crd.1 branch, not the reviewed crd.2 branch

- **Severity:** Low
- **File:line:** `specs/stories/crd-2-player-facing-pending-queue.md:8`
- **Triggering input or sequence:** A maintainer or tracking tool uses the story frontmatter to locate the implementation branch.
- **Observable consequence:** It is directed to `ms/crd-1-data-lock-schema-hardening-wp-spike` instead of the actual reviewed branch `ms/crd-2-player-facing-pending-queue`, making the story's machine-readable implementation metadata false.
- **Confidence:** High; the current branch and HEAD were verified in Pass 2.

### [Pass 3b] The claimed Playwright set does not directly cover the new route or badge

- **Severity:** Low
- **File:line:** `specs/stories/crd-2-player-facing-pending-queue.md:458`; `tests/issue-1015-hide-challenge-rename-ordeals-xp.spec.js:12`
- **Triggering input or sequence:** Grep `tests/*.spec.js` for `MORE_APPS`, `more-badge`, `contested-queue`, or `contested-resolve` as prescribed. Only `issue-1015-hide-challenge-rename-ordeals-xp.spec.js` matches, and its three source-response assertions concern the old `challenge` tile and Ordeals label; none names the new tab ids or badge. The record's extra `issue-1135-deleted-tabs.spec.js` exercises generic More/goTab regressions but does not match any changed identifier.
- **Observable consequence:** The historical 15/15 result is reproducible, but it can stay green if the new Challenges tile badge, context forwarding, or both new destinations break. Calling it the story's changed-area E2E coverage overstates what it demonstrates.
- **Confidence:** High.

### [Pass 3b] The genuine red-first sequence is not independently reproducible

- **Severity:** Low
- **File:line:** `specs/stories/crd-2-player-facing-pending-queue.md:240`, `specs/stories/crd-2-player-facing-pending-queue.md:445`
- **Triggering input or sequence:** Inspect the committed range `268a4961..49f44305`. It contains a single final commit adding both the tests and implementation, with no committed intermediate red state or preserved test output.
- **Observable consequence:** A reviewer can verify today's green/skip state but cannot verify the claimed module-not-found → 41/50 → 50/50 chronology from repository evidence. The claim is unverified-as-stated, not proven false.
- **Confidence:** High about the evidence gap.

### [Pass 3b] The absolute zero-live-write attestation is not established by the fetch shim

- **Severity:** Low
- **File:line:** `specs/stories/crd-2-player-facing-pending-queue.md:351`, `specs/stories/crd-2-player-facing-pending-queue.md:356`; `server/index.js:226`, `server/index.js:238`, `server/index.js:245`, `server/index.js:257`, `server/index.js:274`, `server/index.js:303`
- **Triggering input or sequence:** Recreate the stated verification setup: the page shim intercepts populated `GET /mine` results, while `node server/index.js` connects independently and issues several `createIndex` commands during startup. The screenshots and any database/audit log proving the historical session are not shipped.
- **Observable consequence:** The narrow claim that this feature's browser interactions wrote no challenge documents is credible—the queue imports only `apiGet`, and the placeholder has no write API—but the broader assertion that the test fixtures were the only database writes anywhere cannot be proven from a client fetch shim and could include server-startup DDL if an index were missing.
- **Confidence:** High that the absolute claim is unverifiable from the supplied evidence; low that an actual production write occurred.

<!-- PASS 1 FROZEN: written before any repository file other than crd-2-diff.txt was opened. -->

<!-- PASS 2 FROZEN: written after repository inspection but before opening the crd.2 story or parent epic. Pass 1 text above was not revised. -->

<!-- PASS 3a FROZEN: written after the story through Dev Notes/References and the parent epic were read, but before any Dev Agent Record content was opened. The earlier findings were not revised. AC3 and AC7's literal wording strengthen, rather than retract, the Pass 1/2 findings above. -->

<!-- PASS 3b FROZEN: written after the author record was read, all available gates/probes were run, and the earlier pass text was left standing. -->

## Validation notes

### Ship assessment

**Needs patches; not ready to ship as-is.** There is no blocking security/data-integrity issue in crd.2 itself, but AC7's live badge is incomplete/stale, the desktop surface has no visible badge, and the phone row hides core identifying information. The test record also needs corrected current counts. The placeholder remains correctly inside crd.2 scope and no pool-resolution implementation leaked in.

### Files opened and pass-order attestation

- **Pass 1:** Opened only `specs/stories/code-review/crd-2-diff.txt`. I did not open repository source, the story, the epic, the author record, `crd-2-codex-review.md`, or `crd-2-codex-run.log`. Pass 1 was written before advancing.
- **Pass 2:** Opened/searched the relevant repository context under `public/`, `server/`, and `tests/`: `public/js/app.js`, `public/index.html`, `public/js/game/pending-queue.js`, `public/js/game/contested-resolve.js`, `public/js/auth/discord.js`, `public/js/data/helpers.js`, `public/js/data/loader.js`, `public/css/suite.css`, `public/css/components.css`, `server/routes/contested-rolls.js`, `server/routes/characters.js`, and matching call-site/test snippets returned by repository-wide `rg`. I also inspected Git branch/HEAD/status. I did not open either crd.2 story/spec file or the parent epic. Pass 2 was written before advancing.
- **Pass 3a:** Opened `specs/stories/crd-2-player-facing-pending-queue.md` only through line 233 (Story through References), all of `specs/epic-crd-contested-roll-defence.md`, and the supersession header of `specs/stories/nav.6.contested-roll-design.story.md`. I first located the Dev Agent Record boundary by headings, did not read past it, and froze Pass 3a before opening line 234 onward.
- **Pass 3b:** Opened the story from Dev Agent Record onward, all of `server/tests/crd-2-pending-queue.test.js`, `tests/issue-1015-hide-challenge-rename-ordeals-xp.spec.js`, `playwright.config.js`, `package.json`, `public/js/data/api.js`, and the relevant `server/index.js` startup/index block. The test runner also executed `tests/issue-1135-deleted-tabs.spec.js`. I never opened the separate untracked `crd-2-codex-review.md` or `crd-2-codex-run.log`.

### Commands and real results

- **Pass 1:** `Get-Content -Raw specs/stories/code-review/crd-2-diff.txt` succeeded (1,439 lines; direct output truncated); a line-count/diff-header `Select-String` found eight file sections; three indexed `Get-Content` slices read the remaining diff; two diff-only numbering scripts located source/test lines. `apply_patch` created this findings file.
- **Pass 2:** `rg --files -g AGENTS.md ...` returned exit 1/no file. Repository-wide `rg` calls traced `goTab`, `checkMoreBadge`, character assignment, poller teardown, the deleted module, tab ids, `/mine`, role gating, CSS classes, and badge renderers. Two exploratory `rg` commands returned exit 1 (one invalid Windows glob and one quoting attempt); their corrected forms succeeded. Indexed `Get-Content` calls opened the app boot/dispatch/badge/sidebar/data-loading blocks and the auth, route, loader, and CSS context. `git status --short; git branch --show-current; git rev-parse HEAD` reported branch `ms/crd-2-player-facing-pending-queue`, HEAD `49f443050052b0d87908d2df322b015f61cb2a4f6`, and the four untracked review artifacts listed below. `node --check` passed for `pending-queue.js`, `contested-resolve.js`, and `app.js`. Pass 2 was appended with `apply_patch`.
- **Pass 3a:** Story-heading `Select-String` located Dev Agent Record at line 234; `Get-Content` read lines 1-233 only; `Get-Content -Raw specs/epic-crd-contested-roll-defence.md` succeeded; `rg` confirmed `nav.6` is already marked superseded. Pass 3a was appended with `apply_patch`.
- **Focused required gate (Pass 3b):** `cd server && npx vitest run tests/crd-2-pending-queue.test.js` exited 0: **1 file passed; 48 tests passed, 2 skipped (50 total)**. Mongo-backed AC6 tests were skipped.
- **Playwright set discovery:** `rg -l "MORE_APPS|more-badge|contested-queue|contested-resolve" tests -g '*.spec.js'` returned only `tests/issue-1015-hide-challenge-rename-ordeals-xp.spec.js`.
- **Actual grep-derived Playwright gate:** `npx playwright test tests/issue-1015-hide-challenge-rename-ordeals-xp.spec.js` exited 0: **3/3 passed**.
- **Author's named Playwright pair:** `npx playwright test tests/issue-1015-hide-challenge-rename-ordeals-xp.spec.js tests/issue-1135-deleted-tabs.spec.js` exited 0: **15/15 passed** using two workers. Thus the numeric claim reproduces, though the set is broader than the prescribed direct-reference grep.
- **Author's named 16-suite Vitest regression:** the single `npx vitest run` invocation over all 16 named files exited 1 after 60.6 s: **12 files passed, 3 skipped, 1 failed; 361 tests passed, 118 skipped (479 total)**. `otc-2-office-actions-api.test.js` failed setup with `connect EACCES 159.143.141.178:27017` and then failed cleanup because the DB was not connected.
- **Historical red/green check:** `git log --oneline --decorate 268a4961..49f44305` and `git show --stat 49f44305` showed one final commit containing tests and implementation together; no intermediate red run is preserved.
- **Temporary real-browser probes:** I added `tests/.tmp-crd2-codex-review.spec.js`, ran it once (**1/1 passed**) to measure the 390 px overflow and multi-character labels, then deleted it. I added `tests/.tmp-crd2-codex-timing.spec.js`, ran it once (**1/1 passed**, 46.9 s in-test) to verify 0 `/mine` requests over 25 s inactive, resume on activation, per-id routing/placeholder, and the resolved/dimmed/untappable/next-tick transition, then deleted it. Both additions/deletions used `apply_patch`.
- **Final checks:** `Test-Path` returned `False` for both temporary specs. `git diff --check` exited 0. `git status --short` shows only untracked `crd-2-codex-findings.md` (the requested output) plus `crd-2-diff.txt`, `crd-2-codex-review.md`, and `crd-2-codex-run.log`; the latter three were not created, opened, or modified by me. Git also warned that the global ignore file was unreadable, which does not affect the workspace result.

### Could not run or verify

- I could not execute the Mongo-backed AC6 tests or reproduce a fully green 16-suite server gate because this environment cannot connect to MongoDB (`EACCES` to port 27017). The focused suite skipped those two tests; one older regression suite fails setup instead of skipping cleanly.
- I could not independently prove the historical red-first sequence because no intermediate state/run artifact is committed.
- I could not independently attest to the historical browser session's absolute “zero writes to live Atlas” statement or inspect its scratch screenshots. The shipped code and my fetch-shim probes support the narrower no-feature-document-write claim.

### Modification/restoration confirmation

I intentionally wrote only `specs/stories/code-review/crd-2-codex-findings.md`, as required. The two temporary Playwright specs were deleted and verified absent. I made no source change, commit, push, or external write. There are no tracked workspace changes or unintended files from this review; the status is not globally empty only because the requested findings file and three other untracked review artifacts are present.
