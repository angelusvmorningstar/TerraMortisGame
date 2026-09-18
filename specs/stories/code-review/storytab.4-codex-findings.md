# Adversarial review — storytab.4

## High

- [Pass 1] None found.
- [Pass 2] None found.
- [Pass 3a] None found.
- [Pass 3b] None found.

## Medium

### [Pass 1] The client lexical guard permits non-GET helper calls and computed methods

- **Severity:** Medium
- **File:line:** `server/tests/storytab4-readonly-guard.test.js:62-67,136-141`
- **Triggering input or sequence:** Change `fetchAndMergeStoryTabDowntimes` to call `apiDelete(...)`, or call `fetch(url, { method: destructiveMethod })`. `CLIENT_PERSISTENCE_PATTERNS` only recognizes literal `fetch(...)` calls whose method is one of four quoted uppercase strings, while the explicit helper assertions cover `apiPost`, `apiPut`, and `apiPatch` but omit `apiDelete`.
- **Observable consequence:** A write-shaped outbound request can be introduced into the guarded client function while the AC 4 scanner remains green. The existing positive fixture only proves one literal `fetch(... method: 'POST' ...)` spelling, not the broader property claimed by the test.
- **Confidence:** High; both examples are direct non-matches of the shown patterns.

### [Pass 1] The server lexical guard omits legitimate Mongo write APIs

- **Severity:** Medium
- **File:line:** `server/tests/storytab4-readonly-guard.test.js:42-58,112-126`
- **Triggering input or sequence:** Add a branch in either scanned server region that invokes a mutating driver API not listed by `MONGO_WRITE_PATTERNS`, for example `collection.createIndex(...)`, `collection.dropIndex(...)`, `collection.rename(...)`, or `db.createCollection(...)`.
- **Observable consequence:** The source-level guard passes even though the guarded path contains a Mongo schema/data mutation. A live happy-path request may still catch an executed wire command, but an unexercised conditional write is precisely what the lexical layer is meant to detect.
- **Confidence:** High that the listed spellings evade the regex array; medium on practical likelihood in this narrow handler.

### [Pass 2] The runtime denylist misses mutating commands exposed by the installed driver

- **Severity:** Medium
- **File:line:** `server/lib/write-command-monitor.js:34-49`; `server/node_modules/mongodb/src/operations/search_indexes/create.ts:37-38`; `server/node_modules/mongodb/src/operations/search_indexes/update.ts:25-26`; `server/node_modules/mongodb/src/operations/search_indexes/drop.ts:25-26`; `server/node_modules/mongodb/src/operations/remove_user.ts:23-24`; `server/node_modules/mongodb/src/operations/set_profiling_level.ts:52-53`
- **Triggering input or sequence:** With installed `mongodb` 7.1.1, execute a supported mutation such as `collection.createSearchIndex(...)`, `collection.updateSearchIndex(...)`, `collection.dropSearchIndex(...)`, `db.removeUser(...)`, or `db.setProfilingLevel(...)` while the monitor is attached. The driver emits `createSearchIndexes`, `updateSearchIndex`, `dropSearchIndex`, `dropUser`, or `profile`; none is in `WRITE_COMMANDS`. A direct runtime probe confirmed `assertNoWriteCommands([name])` returns normally for all five.
- **Observable consequence:** The live “zero write commands” assertion can declare a mutating workload read-only. At least the search-index APIs also evade the lexical pattern list, so inserting one into a guarded but conditionally executed branch can bypass both claimed defence layers.
- **Confidence:** High; the command names come from the installed driver's operation source and were passed through the real assertion function.

### [Pass 3a] AC 4's “anywhere” persistence guarantee is only scanned at the merge boundary

- **Severity:** Medium
- **File:line:** `server/tests/storytab4-readonly-guard.test.js:128-141`; `public/js/tabs/story-tab.js:52-130,181,202-226`; `server/lib/story-downtime-fetch.js:38-60`; `server/routes/downtime.js:250-329`
- **Triggering input or sequence:** Add `localStorage.setItem(...)`, `sessionStorage.setItem(...)`, or IndexedDB persistence in `renderLatestReport`, `renderStoryTab`, or `renderChronicle` after `fetchAndMergeStoryTabDowntimes` returns; alternatively add file-backed persistence (`fs.writeFile`, a disk cache library) in the server fetch helper or route. TM-Story-sourced objects flow into those downstream render/state functions, but the client scan ends immediately before `renderLatestReport`, and the server scan only recognizes selected Mongo spellings.
- **Observable consequence:** AC 4 literally prohibits local persistence “anywhere” and explicitly names both a server-side cache collection and a file, yet these durable write regressions leave every new structural test green. The current code appears fetch-and-discard, but the delivered guarantee is materially narrower than the acceptance criterion.
- **Confidence:** High on the uncovered byte ranges and missing file-persistence patterns; medium on whether the intended remediation is a broader lexical scan or a different structural assertion.

### [Pass 3b] The “pre-existing flake” experiment does not establish the claimed attribution

- **Severity:** Medium
- **File:line:** `specs/stories/storytab.4.read-only-no-writeback-guard.story.md:133-146`; `server/db.js:29-38`
- **Triggering input or sequence:** The changed full suite reportedly adds one `oxp-1-office-seats.test.js` overlap failure, after which the author stashes this story and runs that file once in isolation at base; it passes 50/50. A base isolated pass is also the expected result for a regression that only manifests under full-suite load. Moreover, this story changes the one shared `MongoClient` to perform command-monitoring instrumentation for every command, so “unrelated ... by any plausible mechanism” is not justified for a timing-sensitive overlap test.
- **Observable consequence:** The record labels the extra failure pre-existing without reproducing it at base under comparable full-suite conditions or showing that current and base have equal isolated/load behavior. A suite-wide timing regression from the production client change can therefore be waived as noise.
- **Confidence:** High that the described experiment is insufficient; low-to-medium that `monitorCommands` actually caused this specific failure.

## Low

### [Pass 1] `Object.freeze` does not make the exported `Set` immutable

- **Severity:** Low
- **File:line:** `server/lib/write-command-monitor.js:34-49`; `server/tests/write-command-monitor.test.js:91-103`
- **Triggering input or sequence:** Any consumer executes `WRITE_COMMANDS.delete('insert')`, `WRITE_COMMANDS.clear()`, or otherwise mutates the exported set. `Object.freeze(new Set(...))` freezes the object surface, not the set's internal entries, while the self-test only checks `Object.isFrozen`.
- **Observable consequence:** Subsequent `assertNoWriteCommands` calls can silently stop classifying real writes, despite the test named “is frozen” continuing to pass.
- **Confidence:** High on JavaScript semantics; low likelihood without a new or malicious consumer.

### [Pass 1] Broad method-name regexes can reject unrelated read-only refactors

- **Severity:** Low
- **File:line:** `server/tests/storytab4-readonly-guard.test.js:54-55`
- **Triggering input or sequence:** Use an unrelated object's `.drop()` or `.command()` method inside either scanned region, such as a queue or parser object that is not a Mongo collection/database.
- **Observable consequence:** The structural test reports a Mongo write regression where none exists, creating a maintenance false positive and encouraging developers to weaken or bypass the guard.
- **Confidence:** High that the patterns are receiver-agnostic; practical likelihood is uncertain.

### [Pass 1] Region extraction assumes marker uniqueness but never enforces it

- **Severity:** Low
- **File:line:** `server/tests/storytab4-readonly-guard.test.js:75-82,119-124,131-136`
- **Triggering input or sequence:** A marker literal is duplicated in a comment or another source fragment. In particular, an end-marker-like string introduced after the chosen start but before the true boundary causes `indexOf` to stop early; a duplicated start can shift or broaden the scan depending on placement.
- **Observable consequence:** The scanner can inspect a truncated or unintended byte range without failing, contrary to its “unique literal markers” premise. Whether the current source already contains duplicates must be checked in Pass 2 because Pass 1 is restricted to the diff.
- **Confidence:** High on the helper behavior; current-source impact not yet established in this pass.

### [Pass 1] The discrimination insert has an indeterminate-write cleanup gap

- **Severity:** Low
- **File:line:** `server/tests/api-downtime-story-tab.test.js:448-471`
- **Triggering input or sequence:** MongoDB accepts the insert but the driver rejects before returning the acknowledgement (for example, a connection loss after server execution), leaving `insertedId` unset; or the cleanup `deleteOne` itself fails.
- **Observable consequence:** The test can leave a `_test_seeded` document behind because cleanup only knows the server-returned id, and the shown surrounding cleanup does not identify this new document by a preallocated id or stable purpose key.
- **Confidence:** Medium; this is a standard indeterminate-write failure mode, but uncommon in a healthy test run.

- [Pass 2] None found.
- [Pass 3a] None found.

### [Pass 3b] The record's “inert without a listener” claim is overstated

- **Severity:** Low
- **File:line:** `server/db.js:29-38`; `server/node_modules/mongodb/src/cmap/connection.ts:291-299,512-520,560-585`; `server/node_modules/mongodb/src/mongo_types.ts:452-461`; `specs/stories/storytab.4.read-only-no-writeback-guard.story.md:102-103,150-153`
- **Triggering input or sequence:** Issue any MongoDB command with `monitorCommands: true` and no application listener. Driver 7.1.1 makes `shouldEmitAndLogCommand` true from the option alone, timestamps the operation, constructs started/succeeded/failed event objects, and calls `emit`; listener presence is not checked first.
- **Observable consequence:** Database results are unchanged, but the option is not inert: every route/script/test using the shared client pays command-monitoring allocations and event-emission work. The record's absolute “no functional effect” wording obscures the only plausible suite-wide impact of this production-client change.
- **Confidence:** High; this is the installed driver's executed control flow. The performance magnitude was not benchmarked.

### [Pass 3b] The AC 4 record denies a module-level assignment that exists

- **Severity:** Low
- **File:line:** `public/js/tabs/story-tab.js:20,117-130`; `specs/stories/storytab.4.read-only-no-writeback-guard.story.md:114-119`
- **Triggering input or sequence:** `renderStoryTab` fetches and merges TM-Story-sourced submissions, then assigns the resulting `subs` array into module-level `_chronicleCtx` at line 130.
- **Observable consequence:** The Dev Agent Record's factual assertion that fetched `subs`/`cycles` are “never assigned to any module-level ... state” is false. This state is memory-only and therefore does not itself violate AC 4's durable-persistence prohibition, but it weakens confidence in the claimed read-verification and survives beyond the function's render call.
- **Confidence:** High.

### [Pass 3b] The recorded passing and regression counts are not reproducible in the current environment

- **Severity:** Low
- **File:line:** `specs/stories/storytab.4.read-only-no-writeback-guard.story.md:128-146,152-155`; `server/tests/helpers/global-setup.js:73-94`
- **Triggering input or sequence:** Run the exact five-file gate. Global setup aborts before discovery because Atlas connections are denied with `connect EACCES 159.143.141.178:27017`; Vitest reports “No test files found” and exit code 1. The same precondition prevents a fresh full-suite or base-isolation comparison.
- **Observable consequence:** The current observed gate is 0 test files / 0 tests executed, not an independently confirmed 62/62. Static counting does confirm 62 declared tests across the five files and exactly 21 added `it()` declarations, but the pass/fail claims and the two full-suite baselines remain unverified in this review.
- **Confidence:** High on the observed abort and static counts; this does not prove the author's earlier successful run was false.

### [Pass 3b] The TM Story live-client comparison is only partially verifiable under the allowed evidence

- **Severity:** Low
- **File:line:** `specs/stories/storytab.4.read-only-no-writeback-guard.story.md:76-84`; `D:\Terra Mortis\TM Story\server\canon-write-monitor.js:1-13`; `D:\Terra Mortis\TM Story\server\canon-write-monitor.test.js:1-10`
- **Triggering input or sequence:** Inspect the two specifically authorized TM Story precedent files. They verify that TM Story ships the helper and an EventEmitter self-test, but whether its live production client sets `monitorCommands: true` is a negative claim about TM Story's separate DB construction file, which this review is expressly forbidden to open.
- **Observable consequence:** The helper/self-test half of the comparison is confirmed; the “does not wire ... into its live production client” half cannot be directly verified from the permitted files and should not be presented as independently re-confirmed here.
- **Confidence:** High on the evidentiary limitation.

## Validation notes

### Readiness

**Needs patches before shipping as the claimed structural guarantee.** I found no evidence that the current story-tab path writes fetched TM Story reports today, and no blocking/high-severity production defect. The medium findings are nevertheless acceptance-relevant: both lexical/runtime guards have concrete write-shaped bypasses, AC 4's structural coverage stops before downstream render/state code and ignores file persistence, and the extra full-suite failure was attributed to a pre-existing flake by an experiment that cannot establish that conclusion.

### Pass isolation and files opened

- **Pass 1 (blind):** Opened only `specs/stories/code-review/storytab.4-diff.txt`. I did not open the story, status, Dev Agent Record, repository source, Git metadata, or sibling-repo files. I then wrote the complete Pass 1 findings into this file before advancing.
- **Pass 2 (repository, still story-blind):** Opened `server/lib/write-command-monitor.js`, `server/tests/write-command-monitor.test.js`, `server/tests/storytab4-readonly-guard.test.js`, `server/tests/api-downtime-story-tab.test.js`, `server/tests/helpers/db-setup.js`, `server/tests/helpers/global-setup.js`, `server/tests/helpers/setup-env.js`, `server/lib/story-downtime-fetch.js`, `server/routes/downtime.js`, `public/js/tabs/story-tab.js`, `server/db.js`, `server/vitest.config.js`, and `server/node_modules/mongodb/package.json`. Inspected `getClient()`/transaction excerpts in `server/routes/chapters.js`, `office-actions.js`, `office-purchase.js`, `office-seats.js`, and `praxis-sessions.js`. Inspected command-name/monitoring excerpts in the installed driver's `src/operations/**`, especially `search_indexes/{create,update,drop}.ts`, `remove_user.ts`, `set_profiling_level.ts`, `client_bulk_write/client_bulk_write.ts`, `get_more.ts`, plus `src/cmap/connection.ts`, `src/mongo_types.ts`, and their compiled `lib` counterparts. Consulted MongoDB's official `$lookup`, `$unionWith`, `$out`, and `$merge` documentation. I did not open any part of the story spec or sprint tracking file. I froze Pass 2 before advancing.
- **Pass 3a (spec without author account):** First listed section headings, then read only lines 5-10 and 25-64 of `specs/stories/storytab.4.read-only-no-writeback-guard.story.md` (Story, Acceptance Criteria, Explicitly NOT in scope, Dev Notes). I deliberately did not read Background, References, Status content, or Dev Agent Record. Re-inspected the relevant data flow in `public/js/tabs/story-tab.js`, `server/lib/story-downtime-fetch.js`, and `server/routes/downtime.js`, then froze Pass 3a.
- **Pass 3b (author account unlocked):** Read line 3 and lines 74-end of the story file (top Status plus Dev Agent Record and its Status subsection). Read only the two authorized sibling-repo files: `D:\Terra Mortis\TM Story\server\canon-write-monitor.js` and `D:\Terra Mortis\TM Story\server\canon-write-monitor.test.js`; I did not explore any other TM Story file or any other sibling repo. Re-inspected the installed driver's monitoring source and current Git diff/status. The requested pass order was preserved; no earlier finding was revised after later context.

### Source-range and no-finding checks

- The route markers each occur exactly once today. `extractBetween` selects bytes 12,394-17,560, lines 250-330 of `server/routes/downtime.js`: the complete `GET /story-tab` handler through its closing `});`, plus the following explanatory comments, stopping immediately before `GET /hold-flags` at line 331.
- The client markers each occur exactly once today. They select bytes 2,316-2,768, lines 39-51 of `public/js/tabs/story-tab.js`: the complete `fetchAndMergeStoryTabDowntimes` function plus its following JSDoc, stopping immediately before `renderLatestReport` at line 52.
- MongoDB's official docs state that nested `$lookup`, `$unionWith`, and `$facet` pipelines cannot contain `$out` or `$merge`. Therefore top-level-only aggregate inspection is not a practical nested-write hole for valid MongoDB pipelines; an invalid nested pipeline fails rather than writing.
- `getMore` is the installed driver's command for retrieving later cursor batches (`src/operations/get_more.ts`) and is correctly excluded from writes. A real forced-small-batch probe was attempted but could not reach Atlas.
- Both shared-client monitor attachments in `api-downtime-story-tab.test.js` detach in `finally`, including assertion/request failures. Unit self-tests that omit `detach` use fresh local `EventEmitter` instances with bounded emitted events, so they do not leak a shared listener or create meaningful unbounded growth.
- Repository search found no unconditional production `commandStarted` listener and no other command-monitor listener. `monitorCommands: true` enables instrumentation globally, but listener attachment remains test-local.
- `setupDb()` throws on connection failure, and current `globalSetup` aborts the run before discovery; these AC 2 tests do not silently skip when MongoDB is unavailable.
- The lexical and EventEmitter discrimination tests use genuine positive fixtures that would fail if their scanner/assertion logic were removed. The live discrimination test also contains real `insertOne`/throw assertions, but it could not be executed here.
- The story commit changes no existing POST/PUT/DELETE handler implementation for `/api/downtime_submissions`; its six `server/` changes match the supplied diff's stated scope.

### Commands run and observed results

All commands used working directory `D:\Terra Mortis\TM Game` unless noted.

1. `Get-Content -Raw specs/stories/code-review/storytab.4-diff.txt` — succeeded; this was the sole Pass 1 read.
2. Pass 2 raw reads of the monitor, guard, route, client, fetch helper, DB module, DB helpers, API test, driver package, and Vitest config; `rg -n --glob '!node_modules/**' --glob '!specs/stories/**' "getClient\(" server` — all succeeded. The `getClient` search found `db.js`, the two new API-test uses, and transaction/session consumers in `chapters.js`, `office-actions.js`, `office-purchase.js`, `office-seats.js`, and `praxis-sessions.js`.
3. One multi-command orchestration attempt failed at the wrapper/script level before producing command output; I reran its intended reads separately. No repository mutation occurred.
4. Inline Node extraction script reproducing both `extractBetween` calls — succeeded; route range 5,167 characters/82 split lines with one occurrence of each marker, client range 453 characters/14 split lines with one occurrence of each marker.
5. `Get-Content` for `db-setup.js`, `global-setup.js`, and `setup-env.js`; `rg 'commandStarted|monitorCommands' server`; transaction-context `Select-String`; driver-operation `Get-ChildItem`/`rg` — succeeded. No competing listener was found; current infrastructure is fail-fast, not skip-on-Mongo-failure.
6. Driver command-name `rg` plus full reads of `remove_user.ts` and `set_profiling_level.ts` — succeeded; identified omitted mutators `createSearchIndexes`, `updateSearchIndex`, `dropSearchIndex`, `dropUser`, and `profile`.
7. `Get-Content server/db.js`, API-test prefix, and fixture/setup `Select-String` — succeeded; confirmed discrimination cleanup is separate from `FIXTURE_SUB_IDS`.
8. Inline Node live request + forced `batchSize: 1` cursor probe (from `server/`) — failed before either probe ran: `setupDb()` received `MongoServerSelectionError`, underlying `connect EACCES` to Atlas addresses on port 27017. `closeDb()` still ran.
9. Official MongoDB web searches for `$lookup`/`$unionWith` nested-pipeline restrictions — succeeded; both prohibit `$out`/`$merge` in their nested pipelines.
10. `rg` of installed driver `monitorCommands`/event-emission paths — succeeded; confirmed event construction/emission is controlled by the option, not listener count.
11. Inline Node probe of `assertNoWriteCommands` with the five omitted command names — succeeded; every name reported `listed=false` and “PASSED as read.”
12. Story heading `Select-String`, followed by selective `Get-Content` of only the permitted Pass 3a line ranges — succeeded.
13. `rg`/targeted `Get-Content` tracing the merge into `renderLatestReport`, `renderStoryTab`, `renderChronicle`, edit/flag handlers, and adapter fields — succeeded; found the module-level `_chronicleCtx` assignment.
14. Selective `Get-Content` of top Status and Dev Agent Record only after Pass 3a was frozen — succeeded.
15. Required gate, from `server/`: `npx vitest run tests/write-command-monitor.test.js tests/storytab4-readonly-guard.test.js tests/story-downtime-fetch.test.js tests/api-downtime-story-tab.test.js tests/story-tab-cross-app-render.test.js` — **exit 1; 0 test files and 0 tests executed.** Global setup reported `connect EACCES 159.143.141.178:27017`, then “No test files found.” Thus the current observed gate is not 62/62. Static declaration counts are 9 + 9 + 18 + 22 + 4 = **62**, but passing status was not verified.
16. `npx vitest --help --expand-help | Select-String ...` — succeeded; checked whether the precondition could be disabled directly without editing configuration. No appropriate `globalSetup` CLI override was exposed.
17. Per-file `Select-String '^\s*(it|test)\('` — succeeded; returned the 9/9/18/22/4 totals above.
18. `Get-Content` of the two authorized TM Story precedent files — succeeded; confirmed helper plus nine-test EventEmitter self-test. The live-client negative claim remains outside the evidence those two files can provide.
19. `git diff --name-status/--stat e661cf48..ce2a6a7d -- server` — succeeded; six expected files, 428 insertions/1 deletion. `git diff` of all six current source paths was empty.
20. `git status --short` — succeeded; showed only pre-existing/untracked review artifacts plus this requested output: `storytab.4-codex-findings.md`, `storytab.4-codex-review.md`, `storytab.4-codex-run.log`, and `storytab.4-diff.txt`. Git also warned that the user-level ignore file was unreadable; this did not affect the path-specific diff check.
21. `Select-String` for the author-record claims and corresponding driver/client lines — succeeded; located the exact “inert,” module-state, gate, and baseline claims and `_chronicleCtx` assignment.
22. `git diff -U0 e661cf48..ce2a6a7d -- server | Select-String '^\+\s*it\('` — succeeded; exactly **21** added `it()` declarations, agreeing with the record's new-test count.
23. Final findings-structure `Select-String`, line count, path-specific source `git diff`, and `git status --short` — succeeded; the report had the required High/Medium/Low and Validation headings, all six story source/test paths remained diff-empty, and status still showed only the four untracked review artifacts named above. Git repeated the harmless unreadable user-ignore warning.

### Could not run or verify

- Could not execute the five-file gate, live request trace, forced multi-batch cursor trace, live discrimination write, full untargeted suite, fresh failure-list grep, or `oxp-1-office-seats.test.js` current/base comparisons because this sandbox denies the Atlas TCP connections required by global setup (`EACCES`).
- Did not run the optional full untargeted `npx vitest run`; it would abort at the same mandatory global precondition before producing file/test counts. Therefore the recorded 25/119 and 26/120 full-suite failure baselines were not independently verified.
- Did not use `git stash` or temporarily edit source: with Mongo unavailable, the requested base-isolation experiment could not reach test execution, and stashing would add risk without evidence. No source, test, config, tracking, sibling-repo, or Git state was modified. The only file created/updated was this explicitly requested findings file; final path-specific `git diff` for all six story source/test files was empty.
