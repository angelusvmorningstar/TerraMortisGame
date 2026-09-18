# Adversarial review — storytab.2

## High

- None found in Pass 1.
- None found in Pass 2.

### [Pass 3a] The routing decision happens after TM Story is fetched, so the specified always-fetch behavior was never replaced

- **Severity:** High
- **File:line:** `server/routes/downtime.js:266, 284-297`; `specs/stories/storytab.2.chapter-routing-rule.story.md:10-13, 65-71`
- **Triggering input or sequence:** An authorized character has only locally authoritative chapters (including the limiting case where every TM Story cycle would overlap a local submission), and the Story tab requests the route.
- **Observable consequence:** `fetchStoryDowntimes(...)` runs before the local submission query and filtering decision, so TM Story is contacted and all its reports are read on every successful request. The code implements post-fetch response deduplication, not the Story/AC 5 requirement to replace storytab.1's placeholder “always-fetch behaviour” with a source-routing rule. There can be no genuine tm_game-only execution path: TM Story is still queried even when every eventual entry is discarded. This is a literal acceptance failure and preserves unnecessary latency/dependency/data access for locally routed chapters.
- **Confidence:** High. The call order is explicit, and AC 5 specifically names replacement of always-fetch behavior.

### [Pass 3b] The Dev Agent Record falsely marks AC 5 and AC 6 satisfied

- **Severity:** High
- **File:line:** `specs/stories/storytab.2.chapter-routing-rule.story.md:120-129`; `server/routes/downtime.js:266, 284-303`; `server/tests/api-downtime-story-tab.test.js:145-178`
- **Triggering input or sequence:** A reviewer relies on the record's “yes” for AC 5 and “Tests cover tm_game-only, TM-Story-only, and dual-source” for AC 6, then checks the route order and the two added test cases.
- **Observable consequence:** The record converts two known gaps into a completion claim. TM Story is still always fetched before the filter, post-filter reindexing changes adaptation output, and the record itself admits that the route has no dedicated tm_game-only test. That can cause the story to be approved despite a literal AC 5 behavior failure and missing AC 6 case. The narrower subclaim that `adaptStoryReport`, `syntheticChapterFor`, and `story-tab.js` were textually untouched is true; it does not make the AC-level conclusion true.
- **Confidence:** High; this is directly established by call order, the base diff, and the record's own qualification.

## Medium

### [Pass 1] A local Mongo read failure can now abort a route whose external-fetch failure path previously returned an empty success

- **Severity:** Medium
- **File:line:** `server/routes/downtime.js:267-274` (new-code line numbers from the supplied diff hunk)
- **Triggering input or sequence:** An otherwise-authorized `GET /api/downtime_submissions/story-tab?character_id=<owned-id>` completes `fetchStoryDowntimes`, then `submissions().find(...).toArray()` rejects because the local database is unavailable or the query fails.
- **Observable consequence:** The newly added rejection is not caught anywhere visible in the diff, so the handler cannot build its response and will fall into Express error handling (normally a 500). This makes the endpoint depend on both services even when TM Story returned usable data; before this diff, there was no local collection read on this path. Whether an enclosing wrapper changes that result cannot be established from the Pass 1-only material.
- **Confidence:** High that the new await adds this failure mode; medium on the exact HTTP response because Pass 1 does not permit reading the router's surrounding error middleware.

### [Pass 1] Filtering before assigning `rankFromNewest` can renumber surviving synthetic records between otherwise equivalent requests

- **Severity:** Medium
- **File:line:** `server/routes/downtime.js:284-289` (new-code line numbers from the supplied diff hunk)
- **Triggering input or sequence:** TM Story returns reports `[A, B]`. On one request neither overlaps local data, so B is adapted with rank 1. Later, a local submission makes A overlap; the next request filters A and adapts the same B with rank 0.
- **Observable consequence:** Both `adaptStoryReport` and `syntheticChapterFor` receive a different rank for B after the unrelated preceding entry is filtered. If either helper derives a pseudo-record/chapter identifier or other client-visible stable field from that rank, the same external report changes identity and can disrupt keyed rendering, cached selection, or links. The diff supplies no test for identity stability of a surviving report across this transition.
- **Confidence:** Medium. The changed argument is certain; whether it is observable as identity requires helper bodies that are intentionally unavailable in Pass 1.

### [Pass 2] An unpublishable local row can suppress the only publishable copy of a chapter

- **Severity:** Medium
- **File:line:** `server/routes/downtime.js:286-297`; `public/js/tabs/story-tab.js:75-80, 210-215`
- **Triggering input or sequence:** A character has any local `downtime_submissions` document for chapter X (for example a draft, incomplete row, or historical row without `published_outcome`), while TM Story returns a published report for cycle X with a narrative.
- **Observable consequence:** The route adds X to the exclusion set without checking local status or whether the local row has displayable content, so it drops TM Story's report. The client later filters local rows on `s.published_outcome`, meaning the local row is also absent from the Chronicle. The user sees no entry for X even though TM Story supplied one. This needs either a product rule explicitly making mere local-row existence authoritative, or a filter tied to the same publishability condition the renderer uses.
- **Confidence:** Medium-high on the code path and visible blank; medium on production reachability because the repository does not prove whether every overlapping historical local row is guaranteed to have `published_outcome`.

### [Pass 2] Post-filter reindexing violates the helper contract and changes the visible fallback chapter label

- **Severity:** Medium
- **File:line:** `server/routes/downtime.js:301-303`; `server/lib/story-downtime-fetch.js:137-141, 167-170`; `public/js/tabs/story-tab.js:89, 222`
- **Triggering input or sequence:** TM Story returns `[A, B]`; B initially has rank 1. A later becomes locally duplicated and is filtered, so B is passed to both helpers with rank 0 even though it remains rank 1 in TM Story's own response.
- **Observable consequence:** `adaptStoryReport`/`syntheticChapterFor` document `rankFromNewest` as the position in TM Story's own array, but the route now supplies the filtered-array position. B's synthetic `chapter_id` and `game_number` change. Because pseudo-chapters have no label, both Story views derive the displayed fallback from the last four characters of that synthetic ID, so the same B report can visibly change from a rank-1-derived label to a rank-0-derived label between requests. The report `_id` stays stable because it is cycle-based, but its chapter identity and label do not.
- **Confidence:** High; the helper and renderer bodies make the consequence direct.

### [Pass 3a] AC 6 has no distinct tm_game-only fixture and does not prove the required source-query behavior

- **Severity:** Medium
- **File:line:** `server/tests/api-downtime-story-tab.test.js:145-178`; `specs/stories/storytab.2.chapter-routing-rule.story.md:68-71`
- **Triggering input or sequence:** Review the diff's added cases against AC 6's three separately enumerated scenarios: tm_game-only, TM-Story-only, and dual-source.
- **Observable consequence:** The first test is the dual-source fixture (one overlapping report is suppressed while one non-overlapping report survives); the second is TM-Story-only for `charB`. There is no distinct tm_game-only fixture. No test asserts that TM Story is not queried for such a case—and the implementation has no path capable of satisfying that assertion. Therefore AC 6's three-case coverage and “correct source(s) were queried” proof are incomplete.
- **Confidence:** High; the diff adds exactly two cases and neither is a distinct local-only execution.

### [Pass 3a] Reindexing surviving reports changes storytab.1 adaptation behavior beyond applying the routing rule

- **Severity:** Medium
- **File:line:** `server/routes/downtime.js:297-303`; `specs/stories/storytab.2.chapter-routing-rule.story.md:65-67`
- **Triggering input or sequence:** A report earlier in TM Story's ordered response is filtered because it overlaps locally, leaving a later report to be adapted.
- **Observable consequence:** The survivor receives a new filtered-array rank, changing its synthetic chapter ID, game number, and fallback label. That is not necessary to exclude the locally routed report and conflicts with AC 5's narrow permission: no change to storytab.1's actual fetch/merge/render behavior beyond replacing the placeholder behavior with the real rule. Preserving each report's original TM Story index while filtering would apply the rule without this side effect.
- **Confidence:** High.

## Low

### [Pass 1] Object-shaped external `cycle_id` values fail open and bypass deduplication

- **Severity:** Low
- **File:line:** `server/routes/downtime.js:284`
- **Triggering input or sequence:** TM Story returns a report with an Extended-JSON/BSON-like value such as `cycle_id: { $oid: "<matching chapter hex>" }` while the local submission resolves to the corresponding `ObjectId`/hex string.
- **Observable consequence:** The local side normalizes an `ObjectId` to its hex string, but `String(report.cycle_id)` becomes `"[object Object]"`; the migrated duplicate remains in the response. This is a fail-open behavior, so it causes duplicate display rather than suppressing a legitimate report.
- **Confidence:** Medium-low. The coercion behavior is certain, but the Pass 1 material does not establish that TM Story can emit an object rather than the claimed literal string.

### [Pass 2] Repeated `character_id` query parameters are accepted as an array and sent downstream as a synthetic combined ID

- **Severity:** Low
- **File:line:** `server/routes/downtime.js:250-265, 284-290`
- **Triggering input or sequence:** An ST requests `GET /api/downtime_submissions/story-tab?character_id=a&character_id=b`. Express 5 parses `character_id` as `['a', 'b']`; the ST bypasses the ownership comparison.
- **Observable consequence:** The array is truthy, `fetchStoryDowntimes` stringifies it through `encodeURIComponent` as `a%2Cb`, and the local Mongo filter receives the array as the value of `character_id`. The endpoint returns a misleading success/fallback for a malformed request and makes an unintended outbound request rather than rejecting it with 400. The value is never used as a filter key or raw operator, so the tested bracket/JSON operator-shaped strings do not create Mongo operator injection.
- **Confidence:** High; the repository's installed Express 5.2.1 parser was exercised directly with repeated, empty, bracketed, and JSON-shaped query strings.

### [Pass 2] The new integration test misses the production-like ObjectId character branch and the legacy/string Chapter-FK branches

- **Severity:** Low
- **File:line:** `server/tests/api-downtime-story-tab.test.js:145-178`; `server/routes/downtime.js:284-297`
- **Triggering input or sequence:** A regression affects only (a) a 24-hex `character_id`, which takes the `$in: [ObjectId, string]` branch, (b) a legacy `cycle_id` local FK, or (c) a string-stored local Chapter FK.
- **Observable consequence:** The dedup test still passes because it uses the deliberately non-ObjectId-shaped `charA` and only a modern ObjectId-valued `chapter_id`. The new call site's advertised dual-name/dual-type behavior is therefore established by static composition of existing helpers, not by its own HTTP integration coverage; a future query-shape or projection regression on the production-like branch would not be caught here.
- **Confidence:** High on the uncovered branches; low-to-medium on defect risk because the helper's isolated behavior is correct.

### [Pass 3b] The two live-data premises underlying the cross-source match are unverifiable from this repository

- **Severity:** Low
- **File:line:** `specs/stories/storytab.2.chapter-routing-rule.story.md:90-101, 132-136`; `server/routes/downtime.js:268-283, 297`
- **Triggering input or sequence:** Attempt to independently validate (a) the claimed 15/15 real-character overlap and migration counts, or (b) that external TM Story `cycle_id` is always the literal lowercase `tm_game.chapters._id` hex string, while obeying the review's prohibition on reading the sibling repository and without access to the TM Story database.
- **Observable consequence:** This repository can prove only that the dedup works if the external field is the claimed scalar string. It cannot substantiate the sampled-data claim or external schema contract that justifies the hotfix; if that contract admits another representation, the string comparison can leave duplicates (as in the Pass 1 object-shape finding). These claims must be labeled externally verified/unverifiable-here, not inherited as repository-verified facts.
- **Confidence:** High on unverifiability; no assertion is made that either external claim is false.

### [Pass 3b] The author's “any local document wins” rule narrows, but does not erase, the Pass 2 publishability risk

- **Severity:** Low
- **File:line:** `specs/stories/storytab.2.chapter-routing-rule.story.md:105-111`; `server/routes/downtime.js:286-297`
- **Triggering input or sequence:** Re-read the Pass 2 case (a local row without `published_outcome` suppresses a published external report) after the Dev Agent Record defines the rule as “NO real ... document” and says the local copy always wins on overlap.
- **Observable consequence:** Later intent confirms that the implementation's unqualified existence check is deliberate, so the Pass 2 finding is not an implementation deviation from the author's chosen rule. The earlier finding remains standing as required because the observable blank Chronicle still occurs for that data shape; the unresolved question shifts from “did code omit a publishability filter?” to “did the chosen rule intentionally accept this user-visible loss?”
- **Confidence:** High on the intent clarification; medium on production reachability of an overlapping unpublishable local row.

---

## Pass 1 freeze note

These findings were written before opening any repository file other than `specs/stories/code-review/storytab.2-diff.txt`. The diff did not contain `parseId`, `chapterFkValues`, `readChapterFk`, `adaptStoryReport`, or `syntheticChapterFor` implementations, so Pass 1 did not claim runtime verification of their behavior. No tests or repository searches were run in Pass 1.

## Pass 2 freeze note

Pass 2 read repository context but did not open `specs/stories/storytab.2.chapter-routing-rule.story.md`. It confirmed that missing Chapter FKs add no sentinel to the set; `chapter_id` wins when both FK names exist; the projection is sufficient; `/story-tab` remains registered before `GET /`; both duplicate external entries are dropped when their shared `cycle_id` overlaps and both survive otherwise; and the read-only TOCTOU window is self-correcting on the next request rather than a material concurrency defect. The ownership check still returns before both the outbound fetch and new Mongo query, and the diff does not add or move an `isStRole` check. The minimal direct-insert test fixture is sufficient for this projected read and no Mongo collection validator was found, although the coverage gaps above remain.

## Pass 3a freeze note

Pass 3a read only the story's `Story`, `Acceptance Criteria`, `Explicitly NOT in scope`, and original `Dev Notes` sections. It did not read the `Background`, `The real signal to route on`, `Dev Agent Record (2026-09-18)`, or `References` contents. AC 2 is satisfied by live submission/chapter identifiers rather than a fixed game number or chapter ID; AC 3 has a documented-in-code local-wins resolution and a synthetic dual-source test; AC 4's decision is recomputed from stored data on every request; and the change does not build either excluded general-purpose crosswalk. AC 1's documentation claim was intentionally deferred because its named Dev Agent Record was still unread at this freeze point.

## Ship assessment

**Not ready to ship as-is; the acceptance mismatch is blocking.** Either the implementation must gain a genuine source-routing path that can avoid TM Story for tm_game-only cases (with the three literal AC 6 fixtures), or the Story/ACs must be explicitly renegotiated to specify post-fetch deduplication instead. Independently, preserve original TM Story indices through filtering and decide/document whether an unpublishable local row is meant to suppress a publishable external report.

## Validation notes

### Pass boundaries and files opened

- **Pass 1:** Opened only `specs/stories/code-review/storytab.2-diff.txt`. No repository search, source file, story file, or test was opened or run before the Pass 1 findings were written.
- **Pass 2:** Opened `server/routes/downtime.js`, `server/helpers/chapter-fk.js`, `server/lib/story-downtime-fetch.js`, `public/js/tabs/story-tab.js`, `server/tests/api-downtime-story-tab.test.js`, `server/tests/cm-2b-chapters-route-and-dual-read.test.js`, `server/tests/api-territory-dual-read.test.js`, `server/tests/helpers/test-app.js`, `server/tests/helpers/db-setup.js`, `server/package.json`, `server/vitest.config.js`, and `server/tests/helpers/setup-env.js`. Repository searches also scanned relevant paths under `server/tests`, `server/schemas`, `server/scripts`, and `server/routes`. The story specification was not opened until Pass 2 was frozen.
- **Pass 3a:** First used heading-only output to identify boundaries, then opened only lines 8-14 and 53-87 of `specs/stories/storytab.2.chapter-routing-rule.story.md` (Story, Acceptance Criteria, Explicitly NOT in scope, and original Dev Notes). The Dev Agent Record content was not opened until the Pass 3a findings were written.
- **Pass 3b:** Opened lines 88-141 of the story (the full Dev Agent Record) and `server/tests/p0-coordinator-role-ownership-bypass.test.js`; used Git against base `cbc1f9b9` to verify changed/untouched files and the base ownership-check count. I did not read or touch anything outside `D:\Terra Mortis\TM Game`, including the TM Story sibling.

### Commands run and observed results

All commands below were run from `D:\Terra Mortis\TM Game` unless a different working directory is stated.

1. `Get-Content -Raw -LiteralPath 'specs/stories/code-review/storytab.2-diff.txt'` — succeeded; supplied two-file diff read.
2. `Get-Content -Raw -LiteralPath 'server/helpers/chapter-fk.js'` — succeeded.
3. `Get-Content -Raw -LiteralPath 'server/lib/story-downtime-fetch.js'` — succeeded.
4. `$lines = Get-Content -LiteralPath 'server/routes/downtime.js'; $lines[0..340]` — succeeded.
5. `Get-Content -Raw -LiteralPath 'server/tests/api-downtime-story-tab.test.js'` — succeeded.
6. `rg -n -C 8 "function parseId|const parseId|export function adaptStoryReport|export function syntheticChapterFor|rankFromNewest|story-tab|submissionsRouter.get\('/'" server/routes/downtime.js server/lib/story-downtime-fetch.js` — succeeded; located `parseId`, route ordering, and rank consumers.
7. `$lines = Get-Content -LiteralPath 'server/lib/story-downtime-fetch.js'; $lines[115..260]` — succeeded.
8. `Get-Content -Raw -LiteralPath 'server/tests/cm-2b-chapters-route-and-dual-read.test.js'` — succeeded.
9. `Get-Content -Raw -LiteralPath 'server/tests/api-territory-dual-read.test.js'` — succeeded.
10. `Get-Content -Raw -LiteralPath 'server/tests/helpers/test-app.js'` — succeeded.
11. `Get-Content -Raw -LiteralPath 'server/tests/helpers/db-setup.js'` — succeeded.
12. `rg -n -C 4 "storytab\.1:|chapter_id|cycleMap|renderChronicle|renderLatestReport" public/js/tabs/story-tab.js` — succeeded.
13. `rg -n -C 3 "downtime_submissions.*insert|insertOne\(\{|character_id:.*chapter_id|chapter_id:.*character_id" server/tests | Select-Object -First 240` — succeeded.
14. `node --input-type=module -e "import { ObjectId } from 'mongodb'; import { chapterFkValues, readChapterFk } from './helpers/chapter-fk.js'; ..."` from `server` — succeeded; observed modern ObjectId, legacy ObjectId, and legacy string each normalize to the expected hex; missing FK produces `[]`; both fields select the modern value.
15. One parallel inspection batch containing `Get-Content server/package.json`, two line-range reads, and an `rg` validator search returned aggregate exit 1 with no retained output; because the combined runner did not identify the failing member, the three needed reads were rerun individually and the validator search was simplified (commands 16-19).
16. `Get-Content -Raw -LiteralPath 'server/package.json'` — succeeded; observed Express 5.2.1, MongoDB 7.1.1, Vitest 4.1.2.
17. `$lines = Get-Content -LiteralPath 'public/js/tabs/story-tab.js'; $lines[30..120]; $lines[190..265]` — succeeded.
18. `$lines = Get-Content -LiteralPath 'server/tests/cm-2b-chapters-route-and-dual-read.test.js'; $lines[0..150]` — succeeded.
19. `rg -n "downtimeSubmissionSchema|createCollection|collMod|validator" server` — succeeded; no Mongo collection validator for `downtime_submissions` was found.
20. `node --input-type=module -e "import express from 'express'; import request from 'supertest'; ..."` from `server` — succeeded; repeated parameter parsed as an array, empty as `""`, bracket syntax as a separate literal key, and JSON operator text as a string.
21. `rg -n -C 5 "app\.use\(\(err|error handler|next\(err\)|process\.on\('unhandledRejection|uncaughtException" server/index.js server` — exited 1 with no matches.
22. `Get-Content -Raw -LiteralPath 'server/vitest.config.js'` — succeeded.
23. `Get-Content -Raw -LiteralPath 'server/tests/helpers/setup-env.js'` — succeeded.
24. `rg -n "isDbAvailable|skipIf|Mongo" server/tests/api-downtime-story-tab.test.js server/tests/story-downtime-fetch.test.js server/tests/story-tab-cross-app-render.test.js server/tests/p0-coordinator-role-ownership-bypass.test.js server/tests` — succeeded.
25. `$lines = Get-Content -LiteralPath 'server/routes/downtime.js'; $lines[358..430]` — succeeded.
26. `rg -n "^#{1,4} " 'specs/stories/storytab.2.chapter-routing-rule.story.md'` — succeeded; headings only were used to set Pass 3a boundaries.
27. `$lines = Get-Content -LiteralPath 'specs/stories/storytab.2.chapter-routing-rule.story.md'; $lines[7..13]; $lines[52..86]` — succeeded; restricted Pass 3a read.
28. `$lines = Get-Content -LiteralPath 'specs/stories/storytab.2.chapter-routing-rule.story.md'; $lines[87..140]` — succeeded after Pass 3a freeze; full Dev Agent Record read.
29. Required gate, from `server`: `npx vitest run tests/api-downtime-story-tab.test.js tests/story-downtime-fetch.test.js tests/story-tab-cross-app-render.test.js tests/p0-coordinator-role-ownership-bypass.test.js` — **exit 1 before collection/execution**. Global setup reported MongoDB unreachable at the configured URI (`connect EACCES 159.143.141.178:27017`) and “No test files found.” Exact result: **0 test files executed; 0 tests passed; 0 failed; 0 skipped**. This was an infrastructure abort, not a test failure and not a skip.
30. `rg --files -g '*vitest*' -g '*no-db*' -g '*pure*' server` — succeeded; only `server/vitest.config.js` exists, with no approved no-DB config.
31. `npx vitest --help --globalSetup` from `server` — exited 0 but warned that no matching subcommand option was found and printed general help; no CLI switch to disable the repository global setup was identified.
32. `git diff --name-status cbc1f9b9 -- server/lib/story-downtime-fetch.js public/js/tabs/story-tab.js server/routes/downtime.js server/tests/api-downtime-story-tab.test.js` — succeeded; only `server/routes/downtime.js` and `server/tests/api-downtime-story-tab.test.js` were modified.
33. `git diff --unified=0 cbc1f9b9 -- server/lib/story-downtime-fetch.js public/js/tabs/story-tab.js` — succeeded with empty diff; adapter, synthetic-chapter helper, and renderer file are textually untouched.
34. `git diff --check cbc1f9b9 -- server/routes/downtime.js server/tests/api-downtime-story-tab.test.js` — succeeded with no whitespace errors.
35. `Get-Content -Raw -LiteralPath 'server/tests/p0-coordinator-role-ownership-bypass.test.js'` — succeeded; expected exact downtime count is 7.
36. `$content = Get-Content -Raw -LiteralPath 'server/routes/downtime.js'; ([regex]::Matches($content, '!isStRole\(req\.user\)')).Count` — succeeded; current count is exactly **7**.
37. `git show cbc1f9b9:server/routes/downtime.js | Select-String -Pattern '!isStRole\(req.user\)' -AllMatches | Measure-Object | Select-Object -ExpandProperty Count` — succeeded; base count is **7**. The diff neither adds nor moves an ownership check, and the existing check still returns before both the outbound fetch and local query.
38. `git status --short` — succeeded; before final report completion it showed the intended untracked findings file plus pre-existing/unmodified untracked review artifacts (`storytab.2-codex-review.md`, `storytab.2-codex-run.log`, and the supplied `storytab.2-diff.txt`). Git also warned that the user-level global ignore file was inaccessible.
39. `rg -n "^#|^### \[Pass|Not ready to ship|0 tests passed|Files changed by this review" 'specs/stories/code-review/storytab.2-codex-findings.md'` — succeeded; confirmed all severity groups, pass tags, ship assessment, exact gate count, and validation closing section are present.
40. Final `git status --short` — succeeded with the same four untracked paths listed in command 38. Only `storytab.2-codex-findings.md` was created by this review; the other three were present inputs/artifacts and were not modified.

### Claims checked and limitations

- **Confirmed statically:** Given a scalar external `cycle_id` equal to the local Chapter ID, the code catches the claimed dual-source scenario; matching is per-character and per-chapter; a matching external cycle is removed; all identical external `cycle_id` entries are removed; and a non-overlapping entry remains in the response by construction. The new test explicitly asserts that survivor.
- **Confirmed by Git:** `adaptStoryReport`, `syntheticChapterFor`, and `public/js/tabs/story-tab.js` are untouched relative to `cbc1f9b9`; only the route and its API test changed among the four checked files.
- **Not runtime-verified:** The dedup survivor assertion, ownership P0 suite, fetch adapter suite, and cross-app render suite could not execute because the mandatory global infrastructure precondition aborted the run. No suite was skipped; none reached execution.
- **Not verifiable in scope:** The 15/15 live-character sample, TM Story migration counts, and the external `cycle_id` schema/value contract require external data or the forbidden sibling repository. They were not independently verified.
- **P0 invariant:** Static current and base counts are both exactly 7. No control flow was added before or inside the existing `!isStRole(req.user)` ownership branch.
- **Files changed by this review:** Only this requested report, `specs/stories/code-review/storytab.2-codex-findings.md`, was created/updated. No source, test, spec, tracking, commit, or sibling-repository file was modified.
