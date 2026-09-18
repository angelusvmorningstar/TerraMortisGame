# Adversarial review - storytab.4 (Read-Only / No-Write-Back Structural Guard), TM Game

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
   `specs/stories/code-review/storytab.4-codex-findings.md`, before you open anything the next pass
   allows. Do not revise an earlier pass's findings in light of what a later pass taught you - if a
   later pass contradicts an earlier one, say so as a new finding and leave the original standing.
3. At the very end, **attest** to what you actually did: which files you opened in each pass, which
   commands you ran, and anything you could not run. Do not paper over a gap - see "Honesty" below.

## Ground rules

- Repo root: `D:\Terra Mortis\TM Game`. The diff is at `specs/stories/code-review/storytab.4-diff.txt`
  and is relative to that root, taken against base commit `e661cf48` (this story's own commit is
  `ce2a6a7d`, already applied to `main` - the diff and the working tree should match).
- The diff is **deliberately scoped to source and tooling only** (everything under `server/`).
  Story-spec and tracking edits (`specs/stories/storytab.4.read-only-no-writeback-guard.story.md`,
  `specs/stories/sprint-status.yaml`) are excluded from it on purpose, so the earlier passes stay
  genuinely blind to the author's own account. Do not treat their absence as an omission or go hunting
  for them during Pass 1/2.
- **Read and run freely** to verify a claim. Running the code beats reasoning about it every time.
- **Do NOT modify, commit, or push anything.** This is one of four sibling repos in an umbrella
  workspace (`D:\Terra Mortis\`): TM Story, TM Admin, TM Herald, TM Design System sit alongside this
  one. Do not modify or explore any of them. One narrow exception: this story's own Dev Agent Record
  makes a factual comparison claim against TM Story's own precedent files,
  `D:\Terra Mortis\TM Story\server\canon-write-monitor.js` and
  `D:\Terra Mortis\TM Story\server\canon-write-monitor.test.js` (its own Story 4-1). You may READ
  (never modify) those two specific files, and nothing else in that repo, solely to verify that one
  claim.
- Temporarily editing a file to prove something (revert one line, confirm the check now fails the way
  you expect, restore it) **is allowed and encouraged** - you MUST restore it exactly, confirm the
  restore with `git diff`, and say so in your output.
- **Environment hazards**: the vitest suite needs a real MongoDB connection (`server/.env`'s
  `MONGODB_URI`, Atlas-backed; several suites SKIP rather than fail without a local `mongod` - a
  skipped suite is not a passing suite, per this repo's own `CLAUDE.md`). The suite is configured
  `fileParallelism: false, maxWorkers: 1` in `server/vitest.config.js` - **do not run two vitest
  invocations concurrently**, they will contend for the same shared `tm_game_test` database. A full
  untargeted `npx vitest run` (no path arg) takes roughly 12-13 minutes; prefer the targeted GATE
  COMMANDS below unless you have time for a full run, and disclose which you did.
- **Blast radius**: `server/db.js`'s new `monitorCommands: true` option is on the ONE shared
  `MongoClient` every route, script, and all ~275 of this repo's own test files use via
  `getClient()`/`getCollection()` - a mistake here affects the whole application's test suite and
  production connection, not just this diff's own new tests.

## Honesty requirements (these outrank completeness)

- If you could not run something, **say so plainly and name what you could not run**. A disclosed gap
  is far more useful than a confident static read presented as a verified one.
- If you found nothing in a pass or at a severity, **say that explicitly** rather than omitting the
  section or padding with style opinions.
- Report the **exact current gate numbers** you observe (see GATE COMMANDS below). Report the real
  numbers even if they disagree with anything the story claims - especially then.

---

## PASS 1 - BLIND HUNTER (the diff, and nothing else)

You get the diff at `specs/stories/code-review/storytab.4-diff.txt` and **nothing else**. No spec, no
story file, no project context. Do not explore the repository. Do not go looking for the spec. Read
other files only to resolve an import path the diff itself leaves ambiguous.

The blinding is the point. You are here to catch what a competent reviewer with zero project memory
would catch, uncontaminated by the author's framing of what the change was supposed to do.

### What this diff claims to be

A structural guard proving one specific server-side code path (an inter-service HTTP fetch + a local
Mongo read + response merge) never issues a write against MongoDB and never persists fetched data
anywhere durable. It adds: a new lexical source-scanner test file; a new runtime Mongo
command-monitor module plus its own self-test; a new describe block wiring that monitor live against
the real shared test database client during an actual HTTP request cycle, including a
"discrimination" test that deliberately performs a real write to prove the monitor catches it; a new
test asserting an outbound fetch call is a bodyless GET; and one new constructor option
(`monitorCommands: true`) on the production `MongoClient`.

**That is the shape it claims. Do not trust the shape - verify it.**

### What to hunt for

1. **`server/lib/write-command-monitor.js`'s `classifyCommand`**: it inspects `event.command.pipeline`
   for `$out`/`$merge` only at the TOP LEVEL of the pipeline array. Does it (or should it) also catch
   `$merge`/`$out` nested inside a `$lookup`/`$unionWith` sub-pipeline stage? Is this a real gap in the
   module as written, and if so, does it matter for how the module is actually USED elsewhere in this
   diff?
2. **`attachCommandMonitor`'s returned `commands` array** grows unbounded for as long as the listener
   is attached. Is `detach()` actually called on every code path that attaches it in this diff,
   including a THROWN path (an assertion failure between attach and detach)? Check both new test files
   that use it.
3. **The regex patterns in `storytab4-readonly-guard.test.js`** (`MONGO_WRITE_PATTERNS`,
   `CLIENT_PERSISTENCE_PATTERNS`): several are broad string matches (e.g. `\.drop\s*\(/`,
   `\.command\s*\(/`) that could false-positive on unrelated code (a non-Mongo `.drop()`, e.g. on an
   array or a Set). Also check `nonGetFetch`'s regex
   (`/fetch\([^;]*?method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/`) for a plausible false-negative shape
   - a `fetch()` call whose `method:` key is far enough away, or split across a multi-line object
     literal in a way the non-greedy `[^;]*?` might not span correctly.
4. **`extractBetween` in the same file** does a plain `source.indexOf(startMarker)` - if the literal
   start-marker string happens to appear TWICE in the source (e.g. once in an unrelated comment above
   the real target), does it silently extract the WRONG (or an empty/truncated) region instead of the
   intended one? Check this against the actual marker strings used, not just in the abstract.
5. **The discrimination test in `api-downtime-story-tab.test.js`** (`(discrimination) the live monitor
   DOES catch a real write...`) inserts a real document into `downtime_submissions`, then deletes it in
   a `finally` block. Is the insert->assert->delete sequence actually safe if an assertion throws
   partway through? Could this test leave an orphan document behind under any failure mode, and does it
   interact badly with the file's own `afterAll` cleanup (`FIXTURE_SUB_IDS`)?
6. **Self-contradiction check**: the story's own commit message and Dev Agent Record (not visible to
   you yet, but check the CODE for this) claims `monitorCommands: true` has "no functional effect with
   no listener attached." Does anything in the diff actually attach a listener unconditionally at
   module load (which would contradict that), or is it genuinely opt-in per-test only?
7. Standard sweep: assertions whose PASS condition is trivially satisfiable, error paths and
   async/await misuse, resource cleanup on the thrown path, dead code or unused imports, and any
   self-contradiction within the diff itself.

**STOP. Write your Pass 1 findings to `specs/stories/code-review/storytab.4-codex-findings.md` now,
before reading further.**

---

## PASS 2 - EDGE CASE HUNTER (the diff, plus the repository)

You now have full read access to `D:\Terra Mortis\TM Game`. Read whatever surrounding code you need
to understand what this change is actually plugging into. You still do **not** have the story spec or
any account of the author's intent - work from the code itself.

Your remit is boundaries and branches: walk every path, not just the one the author had in mind.

### Orientation (not ground truth - verify against the code)

Same summary as Pass 1. Now verify it against the real files: `server/lib/story-downtime-fetch.js`,
the `GET /story-tab` handler in `server/routes/downtime.js` (~lines 250-327), and
`public/js/tabs/story-tab.js`'s `fetchAndMergeStoryTabDowntimes` (~lines 39-46) are the code this
diff's new tests exist to guard, though none of those three files are themselves modified by this
diff.

### What to hunt for

1. Read `server/lib/write-command-monitor.js` in full, then read `server/tests/storytab4-readonly-
   guard.test.js`'s `extractBetween` calls and confirm, by hand, exactly which byte range of
   `server/routes/downtime.js` and `public/js/tabs/story-tab.js` each one actually extracts TODAY.
   Print or reason through the extracted substring and confirm it is the complete, correctly-bounded
   handler/function and not a partial or shifted region.
2. Walk the EXACT sequence `attachCommandMonitor(getClient())` -> a real `find` on
   `downtime_submissions` (the dedup lookup inside the `/story-tab` route) -> `res.json(...)` and
   confirm the recorded `commands` array genuinely contains at least one entry for this specific
   request shape, so the "not vacuous" claim in the guard test is actually earned by a real command,
   not just an artifact of some unrelated background query.
3. Does `WRITE_COMMANDS` correctly exclude `getMore` (cursor iteration on a `.find().toArray()` result
   set larger than one batch)? Confirm by reading the MongoDB driver's actual wire behaviour or by
   testing with a query that forces multiple batches, if practical - a misclassified `getMore` would
   make this guard fail EVERY real request, not just a writing one.
4. Search the whole `server/` tree for every other call site of `getClient()` (not just this diff's
   own new test). Does adding `monitorCommands: true` to the shared client risk any interaction with
   an existing consumer - e.g. `server/lib` code that already relies on `MongoClient`'s event emitter
   for something else, or a transaction/session helper (the `office-actions.js` reference in
   `db.js`'s own comment about `getClient()`) that could behave differently with command monitoring on?
5. What happens to the new `api-downtime-story-tab.test.js` AC2 tests if a local `mongod` is
   unreachable and the suite's documented "SKIP rather than fail" behaviour kicks in for this file -
   does the guard silently skip (giving a false sense of coverage) or does `beforeAll`'s `setupDb()`
   hard-fail the whole file? Check `server/tests/helpers/db-setup.js`'s real behaviour, not the
   comment.
6. Re-read `CANON_WRITE_COMMANDS`/`WRITE_COMMANDS` for completeness against the CURRENT MongoDB driver
   version installed (`server/node_modules/mongodb/package.json`) - does this driver version issue any
   additional write-shaped wire command name this list might be missing (check the driver's own docs
   or source for command names this list does not enumerate)?

**STOP. Write your Pass 2 findings to `specs/stories/code-review/storytab.4-codex-findings.md` now,
before reading further.**

---

## PASS 3 - ACCEPTANCE AUDITOR (the diff, plus the spec)

Two sub-passes, in this order. **The order is the highest-value instruction in this whole document.**

### Pass 3a - form findings BEFORE reading the author's own account

1. Read `specs/stories/storytab.4.read-only-no-writeback-guard.story.md` - the **Story**,
   **Acceptance Criteria**, **Explicitly NOT in scope**, and **Dev Notes** sections ONLY.
2. **Do NOT read the "Dev Agent Record" or "Status" sections yet.** Skip past them entirely. Reading
   the author's own record first anchors you on their framing and turns a review into grading
   homework.
3. Against the five acceptance criteria, check the diff and the real code it touches for:
   - Violations of an AC's **literal wording**. Read the words, not the surrounding narrative - an
     AC's exception is exactly as narrow as it is written.
   - Deviations from stated intent. **The "Explicitly NOT in scope" section is equally load-bearing**
     - check the change did not quietly touch the existing player-facing write routes
     (POST/PUT/DELETE on `/api/downtime_submissions`), which this story explicitly excludes.
   - Specified behaviour that is missing, or present only in appearance.
   - Contradictions between a stated constraint and the actual code.
4. **Write your Pass 3a findings down now, before moving on.**

**Settled decisions - do not re-litigate these, they are deliberate:**
- AC 5's disclosure escape hatch ("if AC 2's Mongo-level guard is judged infeasible... that must be
  disclosed") was available but NOT used - a full live AC2 implementation was built instead. Do not
  flag "this should have just disclosed infeasibility"; judge the live implementation on its own
  merits instead.
- This story deliberately does not touch, test, or change this repo's OWN existing write paths for
  its own player-facing downtime form (frozen per a prior decision, "D6") - that is out of scope by
  the story's own text, not an oversight.
- TM Story's own write-side guarantees (its own Story 4-1) are explicitly out of scope here - this
  story only guards the NEW code path in THIS repo that consumes TM Story's already-gated data.

### Pass 3b - now read the author's record and check it against reality

5. Now read the **Dev Agent Record** and **Status** sections in full. They make specific, checkable
   claims, including:
   - "21 new tests across 4 test files... 62/62 passing on the touched set" - verify the exact counts
     by actually running the suite, not by reading the claim.
   - "None of this story's touched files appear in either of two full-suite failure lists" - the
     record names the specific files; grep for them yourself against a fresh run's real output.
   - The `oxp-1-office-seats.test.js` "overlap in flight" test failure is claimed to be a PRE-EXISTING
     flake, unrelated to this diff, verified via a `git stash` + isolated run at base. Re-verify this
     claim yourself if practical (a `git stash` of this diff's files, run that one test file in
     isolation, compare) - this is exactly the kind of claim that is easy to overstate.
   - "`monitorCommands: true` has no functional effect with no listener attached" - verify this is
     actually true of the MongoDB Node driver (check the driver's own docs/source, not just trust the
     claim).
   - The comparison claim against TM Story's own `canon-write-monitor.js`/`.test.js` (Story 4-1) -
     that TM Story ships the helper + self-test but does NOT itself wire `monitorCommands: true` into
     its own live `db.js` client. You have narrow read access to those two specific files (see Ground
     rules) - verify this claim directly rather than trusting it.
   - The lexical scanner's own "discrimination" self-tests, and the live command-monitor's own
     "discrimination" test, both claim to prove their respective guards are not vacuous. Confirm each
     discrimination test is actually asserting on a REAL positive case, not something that would pass
     even with the guard logic deleted.
6. **Verify each claim by running it, not by reading it.** Run the suites yourself, right now. Grep
   the files yourself. If a first run is inconsistent, run it twice and say so.
7. Flag anything **FALSE, OVERSTATED, or UNVERIFIABLE-AS-STATED**. This is the single highest-value
   thing this pass can find. A record's own "confirmed", "verified" or "resolved" label can itself be
   wrong - re-examine each one rather than inheriting it.
8. State plainly whether you believe this change is ready to ship as-is, needs patches, or has a
   blocking problem.

---

## Output

Write everything to `specs/stories/code-review/storytab.4-codex-findings.md`, grouped `## High` /
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
- Every command you ran, with its real result, including at minimum:
  `cd server && npx vitest run tests/write-command-monitor.test.js tests/storytab4-readonly-guard.test.js tests/story-downtime-fetch.test.js tests/api-downtime-story-tab.test.js tests/story-tab-cross-app-render.test.js`
  (claimed: 62/62 passing). A full untargeted `npx vitest run` is optional given its ~12-13 minute
  runtime - if you run it, report the real Test Files/Tests failed counts; if you don't, say so.
- **Anything you could not run, and why.** Name it specifically.
- Confirmation that you modified nothing, or that anything you touched was restored and verified
  (`git status --short` clean of unintended change).
