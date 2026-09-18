# Adversarial review - storytab.2 (Chapter-Routing Rule — Which Cycles Read tm_game vs tm_story), TM Game

You are reviewing a completed change in a repo you have full access to. You have NONE of the
conversation in which it was written, which is the point: you are here to catch what the author
could not catch about their own work.

## How to run this - read this section before anything else

This is **three passes in one session, in a fixed order**, and the order is load-bearing. Each pass
is allowed to see strictly more than the one before it. You cannot un-read a spec, so the pass that
must judge the code cold goes first.

1. Work the passes **in the order written**. Do not read ahead. Do not open a file a later pass
   grants you until you reach that pass. In particular: **the story spec is deliberately NOT in the
   diff.** Do not go looking for it during the earlier passes. The final pass will hand you the path.
2. **Freeze each pass before advancing.** Write that pass's findings out in full, to
   `specs/stories/code-review/storytab.2-codex-findings.md`, before you open anything the next pass
   allows. Do not revise an earlier pass's findings in light of what a later pass taught you - if a
   later pass contradicts an earlier one, say so as a new finding and leave the original standing.
3. At the very end, **attest** to what you actually did: which files you opened in each pass, which
   commands you ran, and anything you could not run. Do not paper over a gap - see "Honesty" below.

## Ground rules

- Repo root: `D:\Terra Mortis\TM Game`. The diff is at
  `specs/stories/code-review/storytab.2-diff.txt` and is relative to that root, taken against base
  commit `cbc1f9b9` (the storytab.1 commit immediately before this hotfix).
- The diff is **deliberately scoped to source and tooling only**: `server/routes/downtime.js` and
  `server/tests/api-downtime-story-tab.test.js`. Story-spec and tracking edits (the story file's own
  Dev Agent Record, `sprint-status.yaml`) are excluded from it on purpose, so the earlier passes stay
  genuinely blind to the author's own account. Do not treat their absence as an omission or go
  hunting for them.
- **Read and run freely** to verify a claim. Running the code beats reasoning about it every time.
  This repo has a real vitest suite (`cd server && npm test`, or a single file with
  `npx vitest run tests/<name>.test.js`); MongoDB-backed tests need a local `mongod` or they SKIP
  rather than fail (read the summary line, not just the exit code).
- **Do NOT modify, commit, or push anything.** This is one repo in a multi-repo umbrella workspace
  (`D:\Terra Mortis\`) with three sibling repos (`TM Story`, `TM Admin`, `TM Herald`) - do not read or
  touch anything outside `D:\Terra Mortis\TM Game`, even to cross-check a claim about TM Story's own
  code (the diff's own comments describe what TM Story does; treat those descriptions as claims to
  weigh, not as something to go verify by opening the sibling repo).
- A local `mongod` may or may not be running in this environment. If the suite reports the
  MongoDB-backed test files as SKIPPED rather than PASSED, say so explicitly rather than treating a
  skip as a pass - a skipped suite proves nothing about the new dedup logic, which is covered by
  exactly the kind of test (`api-downtime-story-tab.test.js`) that needs a real Mongo connection.
- This diff touches a route (`GET /api/downtime_submissions/story-tab`) that sits inside a file with
  a documented, audited security invariant: a P0 test
  (`server/tests/p0-coordinator-role-ownership-bypass.test.js`) asserts an exact count of
  `!isStRole(req.user)` occurrences across this file. The new code in this diff does NOT add another
  ownership check (it reuses the route's existing one, already in place before this diff), but
  because that count is load-bearing elsewhere in the same file, flag anything in this diff that
  changes control flow around an existing `isStRole`/ownership check, even incidentally.

## Honesty requirements (these outrank completeness)

- If you could not run something, **say so plainly and name what you could not run**. A disclosed gap
  is far more useful than a confident static read presented as a verified one.
- If you found nothing in a pass or at a severity, **say that explicitly** rather than omitting the
  section or padding with style opinions.
- Report the **exact current gate numbers** you observe: `npx vitest run tests/api-downtime-story-tab.test.js tests/story-downtime-fetch.test.js tests/story-tab-cross-app-render.test.js tests/p0-coordinator-role-ownership-bypass.test.js`. Report the real numbers
  even if they disagree with anything the story claims - especially then.

---

## PASS 1 - BLIND HUNTER (the diff, and nothing else)

You get the diff at `specs/stories/code-review/storytab.2-diff.txt` and **nothing else**. No spec, no
story file, no project context. Do not explore the repository. Do not go looking for the spec. Read
other files only to resolve an import path the diff itself leaves ambiguous.

The blinding is the point. You are here to catch what a competent reviewer with zero project memory
would catch, uncontaminated by the author's framing of what the change was supposed to do.

### What this diff claims to be

A GET route (`/api/downtime_submissions/story-tab`) fetches a character's downtime history from a
separate service ("TM Story") and adapts it into local pseudo-submissions. This diff adds a
pre-filter: before adapting TM Story's reports, it queries this repo's own `downtime_submissions`
collection for the same character, builds a set of that character's own "chapter" identifiers (a
field that may be named `chapter_id` or a legacy `cycle_id`, and may be stored as either an ObjectId
or a string - resolved via an existing helper, `chapterFkValues`/`readChapterFk`), and drops any
TM-Story-sourced report whose own `cycle_id` string matches one of those identifiers. The stated
reason (in a code comment, not to be taken as verified) is that the external service returns
migrated historical data that duplicates what this repo already has natively for the same "chapter".

**That is the shape it claims. Do not trust the shape - verify it.**

### What to hunt for

1. **The Mongo query's filter shape when `charOid` is null.** `parseId(characterId)` returns `null`
   for a non-ObjectId-shaped id (deliberately, via try/catch). The query becomes
   `{ character_id: characterId }` (a bare string) instead of `{ character_id: { $in: [...] } }`. Is
   this a correctness gap if a real character_id in this collection is stored as an ObjectId but the
   request's `characterId` came in as a numeric-looking or otherwise-parseable-as-ObjectId string that
   `parseId` nonetheless fails on for some input shape? Check `parseId`'s exact implementation for any
   input it silently mishandles.
2. **`existingChapterIdStrs` build loop**: `chapterFkValues(readChapterFk(doc))` - trace what this
   returns for a document that has NEITHER `chapter_id` nor `cycle_id` set (can `readChapterFk` return
   `null`, and if so what does `chapterFkValues(null)` produce - is a `null`/`undefined` chapter ID
   silently added to the exclusion set as the string `"null"`, and could a TM-Story report ever
   legitimately carry `cycle_id: null` or `cycle_id: undefined` and get wrongly matched against that?
3. **String coercion asymmetry**: the exclusion set is built via
   `v instanceof ObjectId ? v.toHexString() : String(v)`, but the comparison side is
   `String(report.cycle_id)`. If `report.cycle_id` is itself an object (not a string, not absent) -
   e.g. a nested `{ $oid: '...' }` shape some external JSON APIs use for BSON - `String(report.cycle_id)`
   produces `"[object Object]"`, which would never collide with a real hex string, silently defeating
   the whole dedup for that entry (fails open - the entry stays IN the response, potentially still a
   duplicate) rather than erroring. Is this the intended failure direction (never over-suppress) or an
   unnoticed inconsistency in the diff's own coercion strategy?
4. **The `rankFromNewest` reindex.** Before this diff, `rankFromNewest` was `downtimes`' own index
   (0 = TM Story's own most-recent). After this diff, it's `newDowntimes`' index (post-filter). Does
   any consumer of `adaptStoryReport`/`syntheticChapterFor`'s `rankFromNewest` argument depend on it
   being a STABLE identifier across requests (e.g. cached client-side, embedded in a URL, used as part
   of an idempotency key) rather than a purely-local loop counter recomputed fresh every request? If
   the same TM Story cycle can get a DIFFERENT `rankFromNewest` on two different requests (because a
   different intervening entry got filtered on one request but not another - e.g. right after this
   character's ST creates a new tm_game submission for a previously-unduplicated chapter), does
   anything break?
5. **Self-contradiction/regression risk**: this diff adds an `await` (the new Mongo query) into a
   route that previously had none between the ownership check and the outbound fetch. Confirm the
   ordering guarantee an existing test asserts ("never calls TM Story at all for a rejected (403)
   request") still holds - walk the actual code path and confirm the new query executes strictly
   AFTER the ownership check, not before or in parallel with it.
6. Standard checks: assertions whose pass condition is trivially satisfiable, error paths, unhandled
   promise rejections around the new `await`, resource cleanup on a thrown path (what happens if the
   new `submissions().find(...).toArray()` call itself throws - is that caught anywhere, or does it
   now turn what used to be an always-200-even-on-TM-Story-failure route into a 500 for a purely local
   DB hiccup unrelated to TM Story's own availability?), dead code, unused imports.

**STOP. Write your Pass 1 findings to `specs/stories/code-review/storytab.2-codex-findings.md` now,
before reading further.**

---

## PASS 2 - EDGE CASE HUNTER (the diff, plus the repository)

You now have full read access to `D:\Terra Mortis\TM Game`. Read whatever surrounding code you need
to understand what this change is actually plugging into. You still do **not** have the story spec or
any account of the author's intent - work from the code itself.

Your remit is boundaries and branches: walk every path, not just the one the author had in mind.

### Orientation (not ground truth - verify against the code)

Same as Pass 1's summary. Additionally: this route's sibling helper module is
`server/lib/story-downtime-fetch.js` (`fetchStoryDowntimes`, `adaptStoryReport`,
`syntheticChapterFor`), and the shared Chapter-FK dual-read/dual-type helper is
`server/helpers/chapter-fk.js` (`chapterFkValues`, `readChapterFk`, `CHAPTER_FK_PROJECTION`).

### What to hunt for

1. **Read `server/helpers/chapter-fk.js` in full.** Walk `chapterFkValues(raw)` and `readChapterFk(doc)`
   by hand for every input shape this new call site can actually produce: a doc with only `chapter_id`
   set (ObjectId), a doc with only `cycle_id` set (legacy, ObjectId or string per the file's own
   issue-#497 comment), a doc with neither, and a doc with both. Confirm the new code's own
   `existingChapterIdStrs` set ends up containing exactly the strings you'd expect for each shape - do
   not trust the diff's own comment describing the crosswalk; trace the real function bodies.
2. **The `CHAPTER_FK_PROJECTION` used in the new query** (`{ chapter_id: 1, cycle_id: 1 }` per that
   module, likely also implicitly including `_id`). Confirm the projected documents genuinely carry
   enough information for `readChapterFk` to work - i.e., that the projection doesn't accidentally
   also need `character_id` for anything downstream (it doesn't appear to, since the query's own
   filter already scoped by character_id, but verify no other code path expects the returned docs to
   carry more).
3. **Route ordering**: is `/story-tab` still registered before the general `GET /` handler in this
   router (Express matches path patterns in registration order, and the file's own comments elsewhere
   say `/story-tab` and `/hold-flags` are deliberately registered first)? Confirm this diff did not
   reorder anything and that `/story-tab` still cannot be shadowed.
4. **Malformed `character_id` input.** Trace what happens when `req.query.character_id` is present but
   is something unexpected: an array (Express query-string parsing allows `?character_id=a&character_id=b`
   to produce an array), an empty string, or a string containing Mongo operator-injection-shaped
   content (e.g. `{"$ne": null}` is not directly exploitable via a query STRING param the way a JSON
   body would be, but confirm `characterId` is used ONLY as a value being compared, never interpolated
   into a filter KEY or as a raw object).
5. **Concurrent requests / TOCTOU.** Between this route's new `submissions().find(...)` read and the
   response being sent, could a real ST write a NEW tm_game submission for the same character+chapter
   that this request's TM-Story-derived report also covers? Is there any actual harm if the check reads
   slightly stale data (a submission created a moment after this read) - i.e., is this a genuine
   concurrency defect, or is a request-scoped snapshot obviously fine given what the endpoint is for
   (read-only display, no write, next request self-corrects)?
6. **What happens to a TM-Story report whose OWN `cycle_id` collides across ranks** - can
   `fetchStoryDowntimes`'s upstream response ever contain two entries with the identical `cycle_id`
   (e.g. a TM Story-side bug, or two different downtime "phases" of one cycle)? If so, does this
   diff's filter drop BOTH, one, or neither, and is that the right behaviour either way?
7. **Fixture/mock shape vs. the real thing**: read the new tests added in
   `server/tests/api-downtime-story-tab.test.js` and compare their fixture shapes (`{ character_id:
   'charA', chapter_id: existingChapterId, published_outcome: '...' }`) field-for-field against what a
   REAL `downtime_submissions` document looks like elsewhere in this codebase (check another test file
   that seeds this same collection, e.g. `server/tests/cm-2b-chapters-route-and-dual-read.test.js` or
   `server/tests/api-territory-dual-read.test.js`). Is the new tests' fixture missing any field the
   real dedup code path or the collection's own schema validator would require, such that the test
   passes only because it is under-specified relative to production data?

**STOP. Write your Pass 2 findings to `specs/stories/code-review/storytab.2-codex-findings.md` now,
before reading further.**

---

## PASS 3 - ACCEPTANCE AUDITOR (the diff, plus the spec)

Two sub-passes, in this order. **The order is the highest-value instruction in this whole document.**

### Pass 3a - form findings BEFORE reading the author's own account

1. Read `specs/stories/storytab.2.chapter-routing-rule.story.md` - the **Story**, **Acceptance
   Criteria**, and **Explicitly NOT in scope** sections ONLY, plus the original (pre-hotfix) **Dev
   Notes** section that references `server/helpers/chapter-fk.js`.
2. **Do NOT read the "Dev Agent Record (2026-09-18)" section yet.** Skip past it entirely when you
   reach it in the file. Reading the author's own record first anchors you on their framing and turns
   a review into grading homework.
3. Against the six acceptance criteria, check the diff and the real code it touches for:
   - Violations of an AC's **literal wording**. Read the words, not the surrounding narrative - an
     AC's exception is exactly as narrow as it is written. Pay particular attention to AC 5 ("No
     change to storytab.1's actual fetch/merge/render logic beyond replacing its placeholder
     always-fetch behaviour with this story's real rule") - does the diff touch anything in
     `server/lib/story-downtime-fetch.js` or `public/js/tabs/story-tab.js`, which AC 5 says must stay
     untouched?
   - Deviations from stated intent. **The "Explicitly NOT in scope" section is equally load-bearing** -
     check the change did not quietly do an excluded thing (building a general-purpose reusable
     crosswalk tool, for instance).
   - Specified behaviour that is missing, or present only in appearance. In particular AC 6 asks for
     tests covering three cases: a chapter routed to tm_game-only, TM-Story-only, and dual-source.
     Check the ACTUAL new tests in `server/tests/api-downtime-story-tab.test.js` against all three -
     does a genuine tm_game-only case exist anywhere in this diff's own test coverage, or only the
     other two?
   - Contradictions between a stated constraint (AC 2: "NOT a hardcoded game-number or chapter-id
     comparison baked into the routing logic itself") and the actual code - is the new filter a
     genuine live-data comparison, or does it smuggle in a comparison against a fixed/hardcoded value
     anywhere?
4. **Write your Pass 3a findings down now, before moving on.**

**Explicitly NOT in scope, and deliberate - do not flag these as gaps:**
- Building `chapter-fk.js`-style reusable module/constants/query-param-resolver for this one 9-line
  check (considered and declined per the story's own Dev Agent Record you are about to read).
- A general, reusable `tm_game` <-> TM Story crosswalk tool beyond what this one dedup check needs.
- Anything about the merit-ledger gap described elsewhere in this repo's own `sprint-status.yaml` for
  storytab.1 - that is a separately-tracked, already-deferred item, unrelated to this diff.

### Pass 3b - now read the author's record and check it against reality

5. Now read the **"Dev Agent Record (2026-09-18)"** section in full. It makes specific, checkable
   claims:
   - That 15/15 sampled real characters showed a real chapter present in BOTH `tm_game.downtime_submissions`
     and TM Story's published data (a live-data claim you cannot re-verify without the TM Story
     database, but check whether the CODE's own dedup logic is actually capable of catching that
     scenario if it's true - i.e. does the code match the claimed problem).
   - That the fix is "per-character, per-chapter" and finer-grained than a chapter-level rule.
   - That TM Story's own `cycle_id` field "IS the literal `tm_game.chapters._id` hex string" (a claim
     about an EXTERNAL repo's schema you cannot verify by reading this repo alone - flag as
     unverifiable-from-this-repo rather than asserting it true or false).
   - That "`adaptStoryReport`, `syntheticChapterFor`, and every render function in `story-tab.js` are
     untouched; only `GET /story-tab`'s own handler gained the pre-filter" - verify this by diffing
     those specific files/functions yourself.
   - That the dedup test's "second, non-overlapping TM Story entry survives in the same response" -
     run that specific test and confirm.
6. **Verify each claim by running it, not by reading it.** Run the suites yourself, right now:
   `cd server && npx vitest run tests/api-downtime-story-tab.test.js tests/story-downtime-fetch.test.js tests/story-tab-cross-app-render.test.js tests/p0-coordinator-role-ownership-bypass.test.js`.
   Report the exact pass/fail/skip counts. If any file's tests SKIP (no local mongod), say so plainly -
   do not report a skip as a pass.
7. Flag anything **FALSE, OVERSTATED, or UNVERIFIABLE-AS-STATED**. This is the single highest-value
   thing this pass can find. A record's own "confirmed"/"verified" label can itself be wrong -
   re-examine each one rather than inheriting it.
8. State plainly whether you believe this change is ready to ship as-is, needs patches, or has a
   blocking problem.

---

## Output

Write everything to `specs/stories/code-review/storytab.2-codex-findings.md`, grouped `## High` /
`## Medium` / `## Low`, each finding tagged with the pass that produced it (`[Pass 1]`, `[Pass 2]`,
`[Pass 3a]`, `[Pass 3b]`). Write `- None found.` under any empty heading rather than dropping it.

For each finding:

- **One-line title**
- **Severity**: High / Medium / Low
- **File:line**
- **The triggering input or sequence** - be concrete about what reaches it
- **The observable consequence** - what actually goes wrong, for whom
- **Confidence**: how sure you are this is real and not a misread

Close with a **Validation notes** section stating:

- Which files you opened in each pass, and confirmation you did not read ahead.
- Every command you ran, with its real result, including the vitest command above.
- **Anything you could not run, and why.** Name it specifically.
- Confirmation that you modified nothing, or that anything you touched was restored and verified
  (`git status --short` clean of unintended change).
