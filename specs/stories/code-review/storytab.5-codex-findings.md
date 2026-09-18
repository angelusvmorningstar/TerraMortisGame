# Adversarial review — storytab.5

## High

### Pass 1

- None found.

### Pass 2

- None found.

### Pass 3a

- None found.

### Pass 3b

#### [Pass 3b] Mandatory AC 5 live-source sign-off was not done, despite the record declaring all 11 ACs complete

- **Severity:** High
- **File:line:** `specs/stories/storytab.5.archive-tab-cross-app-wiring.story.md:148`; `specs/stories/storytab.5.archive-tab-cross-app-wiring.story.md:343`; `specs/stories/storytab.5.archive-tab-cross-app-wiring.story.md:409`
- **Triggering input or sequence:** A real player or ST opens both live surfaces with a genuinely TM-Story-sourced Game 8+ report under real deployed authentication. AC 5 explicitly makes that live-site, both-surface observation mandatory and says green unit tests do not satisfy it. The record later admits that exact case could not be verified on either surface, while its status still says implementation is complete against all 11 ACs.
- **Observable consequence:** The story can be accepted and the epic marked done without anyone having observed the core motivating data on either real surface. A routing, authentication, production-response, or DOM integration defect that mocks/local degradation cannot expose could ship unnoticed. My own mocked live-browser probe confirms the DOM wiring works with a correctly shaped response, but it cannot replace the specified real-source/live-site check.
- **Confidence:** High that the mandatory acceptance step is incomplete and the status is overstated; no claim that the unverified production path is necessarily broken.

## Medium

### Pass 1

#### [Pass 1] The two new loaders handle identical initial-fetch failures differently

- **Severity:** Medium
- **File:line:** `public/js/tabs/downtime-tab.js:156`; `public/js/tabs/archive-tab.js:58`
- **Triggering input or sequence:** Either `/api/chapters` or `/api/downtime_submissions` rejects while the other request—and potentially `/api/downtime_submissions/story-tab`—would succeed. `loadPastOutcomesData` rejects the whole `Promise.all` and returns empty immediately, whereas `loadArchiveDowntimeData` converts each individual rejection to `[]` and continues through the cross-app merge.
- **Observable consequence:** The Info-tab Past Outcomes surface can show no history at all while the Archive surface still shows the surviving TM Game data and/or TM Story data for the same character. This is especially conspicuous now that both helpers claim to perform the same fetch/merge/sort job. The prior inline Past Outcomes code also returned early on a base-fetch failure, so repository context/spec intent is needed in Pass 2/3 to determine whether preserving that behavior is required or whether the new cross-app wiring should have made both paths resilient.
- **Confidence:** High that the asymmetry and observable divergence are real; medium that it violates intended behavior before reading the spec.

### Pass 2

#### [Pass 2] A stalled TM Story request leaves both newly wired surfaces waiting forever

- **Severity:** Medium
- **File:line:** `public/js/tabs/archive-tab.js:70`; `public/js/tabs/downtime-tab.js:169`; `public/js/data/api.js:31`; `server/lib/story-downtime-fetch.js:41`
- **Triggering input or sequence:** TM Story accepts the server-to-server connection but never resolves the response (or the local `/story-tab` handler otherwise remains pending). The server's outbound `fetch` has no `AbortSignal`/deadline, the browser `apiGet` wrapper has no deadline, and neither new loader adds one around `fetchAndMergeStoryTabDowntimes`.
- **Observable consequence:** Archive remains on “Loading…” indefinitely, while Info's Past Outcomes area is cleared and remains blank indefinitely—even though both surfaces already fetched usable TM Game history. The tested rejection/degrade path never runs because no promise rejects. The underlying route already exposed the older Story-tab callers to this, but this change expands the user-facing blast radius to both live reading surfaces.
- **Confidence:** High that there is no timeout and that a never-settling fetch blocks rendering; medium on severity because infrastructure-level request timeouts may exist outside this repository.

### Pass 3a

#### [Pass 3a] AC 6/7's required surface-level regression evidence is absent from the committed tests

- **Severity:** Medium
- **File:line:** `server/tests/storytab5-cross-app-wiring.test.js:113`; `server/tests/storytab5-cross-app-wiring.test.js:183`; spec AC 6-7
- **Triggering input or sequence:** A future change breaks the hand-off from `renderArchiveList`/`renderPastOutcomes` to the extracted loader, or a TM Story failure/no-data case accidentally disrupts Archive's Dossier/Retired Characters or Downtime's Current Cycle UI. The new tests call only `loadArchiveDowntimeData` and `loadPastOutcomesData`; the test corpus contains no call to either render function and no before/after content comparison.
- **Observable consequence:** The suite can stay green while the actual two surfaces render nothing or regress adjacent sections. AC 9 deliberately accepts that DOM-free unit tests cannot close the DOM-wiring gap, but AC 6 still literally requires tests “exercising both `renderArchiveList()` and `renderPastOutcomes()`” and AC 7 requires a before/after content comparison. The diff supplies neither; Pass 3b must determine whether the record provides separate live/manual evidence.
- **Confidence:** High that the committed tests do not provide the specified evidence; medium on final acceptance impact pending the mandatory browser-check record.

### Pass 3b

#### [Pass 3b] The Dev Agent Record overstates `story-tab-cross-app-render.test.js` as 18/18

- **Severity:** Medium
- **File:line:** `specs/stories/storytab.5.archive-tab-cross-app-wiring.story.md:384`; `server/tests/story-tab-cross-app-render.test.js:29`
- **Triggering input or sequence:** Run `story-tab-cross-app-render.test.js` by itself or count its test cases at either base commit `9ab7fe31` or the reviewed commit. Vitest reports 4 tests, and the file contains four `it(...)` cases at both revisions—not 18.
- **Observable consequence:** The record attributes fourteen nonexistent regression tests to the suite, overstating how extensively the shared-sort refactor is covered. The suite is green at its real count (4/4), and the separately claimed inferred five-file total is genuinely 78/78, so this is a false per-suite audit claim rather than a test failure.
- **Confidence:** High; verified by an isolated Vitest run, source count, and base-commit source count.

## Low

### Pass 1

#### [Pass 1] The shared sorter changes orphan and legacy-chapter ordering without a regression test

- **Severity:** Low
- **File:line:** `public/js/tabs/story-tab.js:52`; `public/js/tabs/archive-tab.js:76`; `public/js/tabs/downtime-tab.js:175`
- **Triggering input or sequence:** A published submission has a `chapter_id` absent from `cycles`, or its matched chapter lacks `game_number`. The shared helper assigns it numeric rank `0`. Archive previously assigned an unmatched chapter `''` (also effectively placing it below normal positive game numbers, with stable ties), but additionally fell back through `cycle_number`, `created_at`, and `_id`; Past Outcomes previously ordered every submission by its own `_id` string, including orphans.
- **Observable consequence:** Past Outcomes can reorder orphaned entries relative to each other and to matched entries; Archive can move entries whose legacy chapter has no `game_number`. The new tests cover normal synthetic and real chapters but not either boundary. This may be an intentional normalization, but the diff alone does not establish it.
- **Confidence:** High that ordering differs for these inputs; low-to-medium that such inputs are valid/current production data.

#### [Pass 1] Archive's outer fetch catch is effectively dead-letter error handling

- **Severity:** Low
- **File:line:** `public/js/tabs/archive-tab.js:58`
- **Triggering input or sequence:** A normal rejection from either `apiGet` call is already consumed by its local `.catch(() => [])`. The outer `catch` is reached only by an unusual synchronous throw while constructing the calls, an abnormal thenable/`Promise.all` failure, or an exception in the subsequent `subs.forEach` promotion loop.
- **Observable consequence:** A promotion-loop programming/data-shape error is silently treated like a non-fatal fetch problem, while ordinary fetch failures never exercise the block. That makes genuine defects harder to diagnose and gives the error boundary a misleading shape.
- **Confidence:** High.

### Pass 2

- None found.

### Pass 3a

#### [Pass 3a] AC 2/3 literally require direct merge calls from the render functions, but the implementation calls indirectly

- **Severity:** Low
- **File:line:** `public/js/tabs/archive-tab.js:83`; `public/js/tabs/downtime-tab.js:184`; spec AC 2-3
- **Triggering input or sequence:** Static acceptance auditing looks for `fetchAndMergeStoryTabDowntimes` inside `renderArchiveList()` and `renderPastOutcomes()` as those ACs literally specify. The call is instead inside the new loaders, and each render function calls its loader.
- **Observable consequence:** Runtime behavior matches the combined intent of AC 2/3 and AC 9, but the implementation does not meet AC 2/3's unqualified direct-call wording. This is a spec-conformance discrepancy, not a user-visible defect.
- **Confidence:** High on the literal mismatch; high that the indirect call is behaviorally equivalent on the normal path.

#### [Pass 3a] New comments and test descriptions violate AC 10's explicit no-em-dash rule

- **Severity:** Low
- **File:line:** `public/js/app.js:597`; `public/js/tabs/archive-tab.js:54`; `public/js/tabs/downtime-tab.js:153`; `server/tests/storytab5-cross-app-wiring.test.js:2`
- **Triggering input or sequence:** Inspect any of the newly added lines containing `—`; the diff adds them in production comments, guard-test comments, and several test descriptions.
- **Observable consequence:** No runtime behavior changes, but the change fails the story's literal “no em-dashes in every new string, comment, and test description” acceptance rule. A diff scan found multiple violations across four changed files.
- **Confidence:** High.

### Pass 3b

#### [Pass 3b] The record does not establish that production rejected `local-test-token` specifically

- **Severity:** Low
- **File:line:** `specs/stories/storytab.5.archive-tab-cross-app-wiring.story.md:409`
- **Triggering input or sequence:** The local `/story-tab` route returns HTTP 200 with empty arrays. That same response is produced for an upstream 403, a network failure, malformed JSON, or other swallowed failure. The record says the production API “almost certainly” runs in production mode and cites sibling-repository middleware, but provides no captured upstream status.
- **Observable consequence:** The stated auth-boundary diagnosis is unverifiable as written. My direct local route run reproduced the exact HTTP 200/empty response while its server log said `fetch failed`, demonstrating that the response alone cannot distinguish a production auth rejection from connectivity failure. This does not invalidate the verified degrade behavior, but it weakens the explanation for why AC 5 was blocked.
- **Confidence:** High that the cited evidence is non-discriminating; unknown whether the author's original environment separately logged a 403.

## Ship assessment

This change is **not ready to close as shipped/accepted** because AC 5's explicitly mandatory real-source, both-surface live-site check remains undone. The implementation otherwise passes the independently runnable targeted suites and a mocked real-browser two-surface probe, but it also needs patches or explicit disposition for the unbounded wait, the missing AC 6/7 surface-level regression evidence, and the literal AC 10 violations. Deployment may be the necessary validation step, but deployment must not be recorded as acceptance until the real Game 8+ check succeeds on both surfaces.

## Validation notes

### Pass 1 (blind)

- Opened only `specs/stories/code-review/storytab.5-diff.txt`. I did not open the story spec, repository source files, configuration, git history, or any sibling repository.
- Command run: `Get-Content -Raw -LiteralPath 'specs/stories/code-review/storytab.5-diff.txt'` from the repo root; it completed successfully and returned the supplied source/tooling diff.
- Diff-only checks: `[...subs].sort(...)` creates a distinct array and does not mutate the caller's array container, including when the input expression is itself a spread-built array; the comparator does not mutate element objects. The new exact start/end marker strings each appear as one function boundary in the supplied diff, but current-file uniqueness could not honestly be verified without opening the files, which Pass 1 forbids; deferred to Pass 2.

### Pass 2 (repository context, still spec-blind)

- Opened `public/js/tabs/archive-tab.js`, `public/js/tabs/downtime-tab.js`, `public/js/tabs/story-tab.js`, `public/js/app.js`, `public/js/data/api.js`, `public/index.html`, `server/lib/story-downtime-fetch.js`, `server/routes/downtime.js`, `server/routes/chapters.js`, `server/schemas/downtime_submission.schema.js`, `server/tests/storytab4-readonly-guard.test.js`, `server/tests/storytab5-cross-app-wiring.test.js`, `server/tests/story-tab-cross-app-render.test.js`, selected portions of `server/tests/api-downtime-story-tab.test.js`, `server/package.json`, and `server/vitest.config.js`. I did not open the story spec, epic, sprint status, Dev Agent Record, or any sibling repository. `git diff --name-only` printed the already-known story-spec path but did not read its contents.
- Commands run successfully: targeted `Get-Content` reads of every file/portion listed above; `rg -n -C 25 "story-tab|fetchStoryDowntimes" server/routes/downtime.js`; exact-marker search across both tab files; caller search for `initArchiveTab`, `renderPastOutcomes`, and `sortDowntimesByChapterRecency`; app import/dispatch/nav searches; `rg` searches for chapter ordering fields and route tests; `git diff --stat 9ab7fe31..a8d16c5c -- public/js server/tests`; and `git diff --name-only 9ab7fe31..a8d16c5c`. The diff stat was 6 scoped files, 352 insertions, 50 deletions; the full changed-name list additionally named only the deliberately excluded tracking/spec files described by the review instructions.
- Probe command run successfully: a Node ESM script mixed synthetic ranks 0, 1, 2, and 10 with real games 1, 8, and 9; output was `s0,s1,s2,s10,g9,g8,g1`, confirming newest-TM-Story-first followed by descending TM Game order beyond rank 0. A duplicate-ID probe output `a,b`; both the render lookup maps and sort map use the same forward loop/last-write-wins rule, so they resolve duplicate `_id` values consistently.
- One first attempt at the multi-rank Node probe failed with `TypeError: Cannot read properties of undefined (reading 'sub')` because the probe mistakenly indexed `story[10]` rather than the array position holding rank 10. I corrected only the ad hoc probe and reran it successfully; no repository file was involved.
- Two batched read/search invocations reported a wrapper-level failure because one contained `rg` returned exit 1 for no matches. I reran their constituent commands with per-command result capture. The significant no-match result was the timeout scan: `rg -n "AbortController|AbortSignal\.timeout|timeout" public/js/data/api.js server/lib/story-downtime-fetch.js server/routes/downtime.js` exited 1 with no output.
- Marker result: each of the four exact markers occurs once at the expected lines (Archive 58/83; Past Outcomes 157/184), and `extractBetween` itself verifies global uniqueness and end-after-start. A later helper inserted between each current marker pair would be included (safe-direction false positive risk); a delegated helper placed outside the region would not be followed, so this remains a lexical guard rather than a call-graph proof, but the present scopes are correctly bounded.
- Fixture result: `adaptStoryReport` and `syntheticChapterFor` create exactly the `{downtimes, chapters}` element shapes emitted by the real route. The production route may preserve rank holes after deduplication; the sort is still correct because synthetic `game_number` remains strictly decreasing by original rank. No fixture/consumer mismatch was found.
- Dispatch result: Info is a real bottom-nav destination and calls `renderPastOutcomes`; Archive is a visible “Story” More-grid/sidebar app for both players and ST/dev users and calls `initArchiveTab`. The corrected `app.js` comment is accurate.

### Pass 3a (acceptance audit before the Dev Agent Record)

- Read only the story's `## Story` (lines 11-18), `## Acceptance Criteria` (79-206), `## Explicitly NOT in scope` (207-237), and `## Dev Notes` (281-310) sections. I did not open line 341 or later, where the Dev Agent Record begins.
- Process disclosure: before the selective reads, `rg -n "^## "` unexpectedly exposed lines 4-9 because the wrapped Status prose itself uses `##` on every line. Those six lines revealed the high-level claim that all ACs were implemented and that AC 5 was partially verified/partially blocked. They did not expose the Dev Agent Record's detailed claims or evidence, but this means Pass 3a was not perfectly blind to that top-level self-assessment; I did not use it to revise Pass 1 or Pass 2.
- Commands run: the heading search above; four bounded `Get-Content | Select-Object -Skip ... -First ...` reads for the permitted sections; `git diff 9ab7fe31..a8d16c5c -- specs/epic-storytab-cross-db-read.md`; the equivalent diff for `specs/stories/sprint-status.yaml`; `rg` across `server/tests` for the two loaders/renderers; a zero-context source/test diff filtered for added em dashes; and a changed-file scope scan covering the adapter, three tab modules, package, and Vitest config.
- Scope result: the change did not modify `server/lib/story-downtime-fetch.js`, merge the three tab modules, wire up/delete `renderStoryTab`, or add jsdom/config/dependencies. The adapter's known merit-action rendering gap remains untouched. AC 4's shared helper replaced the Archive, Past Outcomes, `renderChronicle`, and `renderLatestReport` inline comparators. AC 11's epic/sprint tracker edits are present and say storytab.5 closes the epic.

### Pass 3b (Dev Agent Record audit and independent runs)

- Opened the Dev Agent Record from line 341 to EOF, then `package.json`, `playwright.config.js`, `tests/fix-player-skill-acq-outcome.spec.js`, relevant excerpts of `CLAUDE.md`, `server/index.js`, and `server/tests/helpers/setup-env.js`. I also re-opened/count-checked the already-seen targeted test files and searched the story record for exact claim line numbers. I never opened or touched a sibling repository.
- **Exact requested Vitest gate, real repository configuration:** ran `npx vitest run tests/storytab5-cross-app-wiring.test.js tests/storytab4-readonly-guard.test.js tests/story-tab-cross-app-render.test.js` from `server` twice. Both runs aborted before collection because global setup could not reach the configured MongoDB endpoint (`connect EACCES 159.143.141.178:27017`). Real official result: **0 test files run; no pass count; exit 1** on both attempts.
- **DB-independent diagnostic gate:** created a temporary `D:\tmp\storytab5-vitest.config.mjs` with the same Node/forks/serial shape but no repository global setup. The first invocation without `--configLoader runner` failed because Vite could not create its timestamp file in `D:\tmp` (`EPERM`). With `--configLoader runner`, the same three files passed **30/30** (3 files) twice. Per-file isolated reruns were **10/10** for `storytab5-cross-app-wiring`, **16/16** for `storytab4-readonly-guard`, and **4/4** for `story-tab-cross-app-render`. The temporary config was deleted.
- **Five-file 78 claim:** the record did not name the extra two files. An initial guess using `story-downtime-fetch.test.js` and `api-downtime-story-tab.test.js` produced 48 passes plus 22 skipped/one failed suite because the latter needs the omitted setup/DB; that was not treated as the claimed set. Searching for suites that import/scan the four changed client files identified the only natural five-file set totaling 78: the three named files plus `fix.398.revision-note-prompt-injection.test.js` (23) and `issue-1156-eqc5-remove-skill-acquisition.test.js` (25). That inferred set passed **78/78** (5 files) under the temporary diagnostic config.
- **Playwright:** confirmed ports 3000 and 8080 were free, then ran exactly one invocation: `npx playwright test tests/fix-player-skill-acq-outcome.spec.js`. Result: **1 failed, 2 passed**. AC-1 failed at line 130 with `.merit-summary-section` “element(s) not found”; AC-2 and AC-3 passed. This matches the current-failure portion of the record exactly. Per the user instruction, I did not repeat the author's `git stash` A/B against base, so the historical pre-existing attribution remains not independently proved here, only strongly consistent.
- **Direct local route:** launched `node index.js` in one bounded shell while a second shell requested `GET http://localhost:3000/api/downtime_submissions/story-tab?character_id=69d720427fdd1b1f9498b0d4` with `Authorization: Bearer local-test-token`. The request returned **HTTP 200** and `{"downtimes":[],"chapters":[]}`. Server logs showed both `storytab.1 ... fetch failed` and a caught local dedup error because Mongo was unavailable, confirming the real degrade response while not confirming the record's specific upstream-403 explanation. The bounded server command timed out and was terminated; port 3000 was free afterward.
- **Additional live-browser probe:** with one bounded static server and one headless Chromium session (no concurrent Playwright invocation), mocked the real `/story-tab` response shape with a synthetic Game 9 entry plus a native Game 8 entry. Info rendered 2 rows in Story-then-Game order; Archive produced IDs `["story:charA:cyc9","game8"]`; clicking the first Archive row rendered the TM Story narrative plus Story Moment, Home Report, and Rumour content. This validates current DOM hand-off under mocked I/O, not AC 5's mandatory deployed real-source observation. The static-server shell timed out by design and port 8080 was free afterward.
- Other commands run in Pass 3b: targeted `rg` searches for claimed test names/counts and source imports; `rg -c`/`Select-String` case counts; `git show 9ab7fe31:server/tests/story-tab-cross-app-render.test.js` count check; `git show --format=fuller --stat a8d16c5c`; `npx vitest --help --globalSetup`; reads/searches of Playwright/server configuration; repeated port checks; test-artifact enumeration; and final status/cleanup checks. One attempted recursive `Remove-Item` cleanup command and one attempted `Start-Process` orchestration command were rejected by policy before execution. Generated Playwright result files were instead deleted explicitly, their now-empty directories removed, and cleanup verified.
- **Could not run/verify:** the official Vitest gate or official-config five-file set past global setup (Mongo network access is denied in this environment); a real deployed TM Story Game 8+ browser check (no real user credential/deployment was supplied, and no deployment was authorised); the claimed production-403 cause; the sibling-repository local-server attempt (explicitly out of scope); the author's `git stash` A/B; or an unrelated full repository suite. These gaps are disclosed rather than counted as passes.
- **Workspace attestation:** no tracked file changed (`git diff --name-only` was empty). The only lasting file I created is this required findings report. The pre-existing untracked `storytab.5-diff.txt` and `storytab.5-codex-review.md` remain untouched. Temporary Vitest config and Playwright `test-results` were removed and verified absent. Final ports 3000/8080 had no listeners. Final `git status --short` showed exactly the three untracked review artifacts (`storytab.5-codex-findings.md`, the pre-existing `storytab.5-codex-review.md`, and the supplied `storytab.5-diff.txt`) plus a harmless permission warning for the user's global git-ignore file.
