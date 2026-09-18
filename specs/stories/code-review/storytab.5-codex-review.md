# Adversarial review - storytab.5 (Wire BOTH Live Downtime-Reading Surfaces to the Cross-App Downtime Fetch), TM Game

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
   `specs/stories/code-review/storytab.5-codex-findings.md`, before you open anything the next pass
   allows. Do not revise an earlier pass's findings in light of what a later pass taught you - if a
   later pass contradicts an earlier one, say so as a new finding and leave the original standing.
3. At the very end, **attest** to what you actually did: which files you opened in each pass, which
   commands you ran, and anything you could not run. Do not paper over a gap - see "Honesty" below.

## Ground rules

- Repo root: `D:\Terra Mortis\TM Game`. The diff is at
  `specs/stories/code-review/storytab.5-diff.txt` and is relative to that root, taken against base
  commit `9ab7fe31` (the tip of `main` this branch was cut from) up to commit `a8d16c5c` (this
  story's own commit, on branch `ms/storytab-5-archive-tab-wiring`).
- The diff is **deliberately scoped to source and tooling only** (`public/js` and `server/tests`).
  Story-spec and tracking edits (`specs/stories/storytab.5...story.md`,
  `specs/epic-storytab-cross-db-read.md`, `specs/stories/sprint-status.yaml`) are excluded from it
  on purpose, so the earlier passes stay genuinely blind to the author's own account. Do not treat
  their absence as an omission or go hunting for them.
- **Read and run freely** to verify a claim. Running the code beats reasoning about it every time.
- **Do NOT modify, commit, or push anything.** This repo (`TM Game`) sits in a multi-repo umbrella
  workspace alongside sibling repos `TM Story`, `TM Admin`, and `TM Herald` at
  `D:\Terra Mortis\<name>` - do not read from or touch any of those, even to check something; this
  review is scoped to `TM Game` only.
- **Environment hazard**: this repo's own `CLAUDE.md` warns that Playwright e2e specs share port
  8080 and must never run two invocations concurrently. The author's own local dev servers (API on
  :3000, static frontend on :8080) have been stopped for this review, so both ports should be free -
  but if you run any Playwright spec, run only ONE at a time, and disclose if a port is unexpectedly
  held. Running the vitest suites (unit/integration) does not need either port.
- **Blast radius note**: two of the four production functions touched here
  (`fetchAndMergeStoryTabDowntimes`, and the new `sortDowntimesByChapterRecency`) are shared
  infrastructure - `story-tab.js`'s own two pre-existing callers (`renderLatestReport`,
  `renderChronicle`) now route through the refactored sort helper too, not just the two new callers
  this story adds. A mistake in the shared helper risks breaking the player-facing Story tab (ST and
  player views) that storytab.1-4 already shipped and tested, not just the two new call sites.

## Honesty requirements (these outrank completeness)

- If you could not run something, **say so plainly and name what you could not run**. A disclosed gap
  is far more useful than a confident static read presented as a verified one.
- If you found nothing in a pass or at a severity, **say that explicitly** rather than omitting the
  section or padding with style opinions.
- Report the **exact current gate numbers** you observe: `cd server && npx vitest run
  tests/storytab5-cross-app-wiring.test.js tests/storytab4-readonly-guard.test.js
  tests/story-tab-cross-app-render.test.js`. Report the real numbers even if they disagree with
  anything the story claims - especially then.

---

## PASS 1 - BLIND HUNTER (the diff, and nothing else)

You get the diff at `specs/stories/code-review/storytab.5-diff.txt` and **nothing else**. No spec, no
story file, no project context. Do not explore the repository. Do not go looking for the spec. Read
other files only to resolve an import path the diff itself leaves ambiguous.

The blinding is the point. You are here to catch what a competent reviewer with zero project memory
would catch, uncontaminated by the author's framing of what the change was supposed to do.

### What this diff claims to be

A fix wiring two downtime-history render surfaces (`archive-tab.js`'s `renderArchiveList`,
`downtime-tab.js`'s `renderPastOutcomes`) to a cross-app data merge (`fetchAndMergeStoryTabDowntimes`,
now exported from `story-tab.js`) that a sibling render path already used. It also replaces three
independently-coded sort comparators (one in each of the three files) with one shared exported
function, `sortDowntimesByChapterRecency`, and extracts the fetch/merge/sort logic in the two newly-
wired files into standalone async functions (`loadArchiveDowntimeData`, `loadPastOutcomesData`) so
they're unit-testable without a DOM. A two-line comment fix in `app.js` and two new tests added to an
existing guard-test file round it out.

**That is the shape it claims. Do not trust the shape - verify it.**

### What to hunt for

1. **`sortDowntimesByChapterRecency`'s non-mutation claim.** It returns `[...subs].sort(...)`.
   Confirm this genuinely never mutates its `subs` argument in place, including when `subs` is
   itself an array literal built from a spread elsewhere in a caller (aliasing risk).
2. **The `?? 0` fallback when a sub's `chapter_id` doesn't match anything in `cycles`.** Both new
   call sites (`archive-tab.js`, `downtime-tab.js`) now route through this same fallback. Is this
   genuinely equivalent to what each file's OWN previous comparator did for an unmatched chapter_id,
   or could it now sort orphaned entries into a different relative position than before? Flag as
   "worth checking" if you cannot resolve this from the diff alone - Pass 2 has full repo access.
3. **Self-contradiction within the diff**: `loadArchiveDowntimeData`'s try/catch wraps a
   `Promise.all` whose own two `apiGet(...)` calls each carry their own `.catch(() => [])`. Can the
   outer `catch { /* non-fatal */ }` block in that function ever actually be reached by anything
   other than a bug in `subs.forEach`'s own promotion loop? Is that dead-letter shape intentional or
   an oversight the diff introduces?
4. **`loadPastOutcomesData`'s corresponding shape has NO per-call `.catch()`** - a single rejection
   from either `apiGet` call inside its `Promise.all` fails the whole function's initial fetch and
   returns `{ publishedSubs: [], cycles: [] }` immediately. Is this asymmetry with
   `loadArchiveDowntimeData` (which tolerates a partial per-call failure) deliberate, or a real
   behavioural inconsistency between two functions doing the same job in two files?
5. **The two new `storytab4-readonly-guard.test.js` tests' `extractBetween` markers.** This exact
   test file has a documented history (visible in its own comments) of a previous Codex review
   catching a non-unique marker silently mis-scoping a region. Check the new markers
   (`'export async function loadArchiveDowntimeData(char) {'` /
   `'async function renderArchiveList() {'` and the `downtime-tab.js` equivalents) are genuinely
   unique in their respective files, not just plausible-looking.
6. Assertions whose PASS condition is trivially satisfiable, error paths, unhandled rejections,
   resource cleanup on the thrown path, dead code, unused imports, unreachable branches - the usual
   sweep, applied to this diff specifically, not generically.

**STOP. Write your Pass 1 findings to `specs/stories/code-review/storytab.5-codex-findings.md` now,
before reading further.**

---

## PASS 2 - EDGE CASE HUNTER (the diff, plus the repository)

You now have full read access to `D:\Terra Mortis\TM Game` (and only that repo - see the sibling-repo
ground rule above). Read whatever surrounding code you need to understand what this change is
actually plugging into. You still do **not** have the story spec or any account of the author's
intent - work from the code itself.

Your remit is boundaries and branches: walk every path, not just the one the author had in mind.

### Orientation (not ground truth - verify against the code)

Same summary as Pass 1 above. `fetchAndMergeStoryTabDowntimes` (in `story-tab.js`) calls a
server-to-server route (`server/lib/story-downtime-fetch.js`'s `fetchStoryDowntimes`,
`adaptStoryReport`, `syntheticChapterFor` - not touched by this diff, but load-bearing for what
"correctly sorted" even means here) that fetches a character's TM-Story-sourced downtime history and
adapts it into this repo's own submission/chapter shape, with a synthetic `game_number` far above any
real one so the new shared sort keeps TM-Story-sourced entries ahead of `tm_game`-sourced ones.

### What to hunt for

1. **Trace `sortDowntimesByChapterRecency` by hand** against a synthetic `game_number` from
   `server/lib/story-downtime-fetch.js`'s `syntheticChapterFor` (base `1_000_000_000`, decreasing per
   rank) mixed with a real `tm_game` chapter's `game_number` (small integers, currently topping out
   around 8-9). Confirm the numeric compare genuinely produces newest-TM-Story-first,
   newest-tm_game-second ordering for a range of ranks, not just rank 0.
2. **Route/matcher-order style check on `extractBetween`'s new call sites**: could either new marker
   pair (`loadArchiveDowntimeData`/`renderArchiveList` in `archive-tab.js`,
   `loadPastOutcomesData`/`renderPastOutcomes` in `downtime-tab.js`) accidentally capture MORE than
   intended if either file is later edited to add another function between the two markers - i.e. is
   the scoping robust, or does it only work by accident of current file layout?
3. **`app.js`'s tab-dispatch order** (`t === 'archive'` vs `t === 'info'`, around where the corrected
   comment sits). Confirm the comment fix is accurate against the REAL current dispatch table, not
   just plausible - does `archive-tab.js`'s `renderArchiveList` genuinely reach a real player/ST
   today via the `'archive'` tab, independent of this diff's own changes?
4. **What happens when an awaited condition never resolves the way expected**: if TM Story's server
   route (`fetchAndMergeStoryTabDowntimes`'s own internal fetch) hangs rather than rejecting or
   returning non-2xx, does either new call site (`loadArchiveDowntimeData`,
   `loadPastOutcomesData`) have any timeout of its own, or does it inherit whatever
   `fetchAndMergeStoryTabDowntimes`/the underlying `apiGet` already provides? Is that acceptable, or
   a new exposure this diff introduces by adding two more callers?
5. **State mutated by one step leaking into a later step**: `story-tab.js`'s `renderChronicle` and
   `renderLatestReport` both build their OWN local `cycleMap` (a full `{_id: chapterObject}` map) for
   label/status lookups, then ALSO call the new shared sort helper, which builds its own SEPARATE,
   internal `game_number`-only map from the same `cycles` array. Confirm these two maps can never
   disagree (e.g. if `cycles` contained a duplicate `_id`, would the two maps resolve it the same
   way?) and that this duplication is genuinely harmless, not just probably fine.
6. **Fixture/mock shape vs. real consumer, field for field**: the new test file
   (`storytab5-cross-app-wiring.test.js`) mocks `apiGet` and constructs fixtures using the REAL
   `adaptStoryReport`/`syntheticChapterFor` functions rather than hand-rolled synthetic objects. Spot
   check that the fixtures these tests build genuinely match what the real
   `/api/downtime_submissions/story-tab` route would actually return in production (read
   `server/routes/downtime.js`'s `/story-tab` handler and `server/lib/story-downtime-fetch.js` to
   confirm), not a shape the test merely finds convenient.

**STOP. Write your Pass 2 findings to `specs/stories/code-review/storytab.5-codex-findings.md` now,
before reading further.**

---

## PASS 3 - ACCEPTANCE AUDITOR (the diff, plus the spec)

Two sub-passes, in this order. **The order is the highest-value instruction in this whole document.**

### Pass 3a - form findings BEFORE reading the author's own account

1. Read `specs/stories/storytab.5.archive-tab-cross-app-wiring.story.md` - the **Story**,
   **Acceptance Criteria**, **Explicitly NOT in scope**, and **Dev Notes** sections ONLY.
2. **Do NOT read the Dev Agent Record section yet.** Skip past it entirely. Reading the author's own
   record first anchors you on their framing and turns a review into grading homework.
3. Against the acceptance criteria, check the diff and the real code it touches for:
   - Violations of an AC's **literal wording**. Read the words, not the surrounding narrative - an AC's
     exception is exactly as narrow as it is written.
   - Deviations from stated intent. **The "Explicitly NOT in scope" section is equally load-bearing** -
     check the change did not quietly do an excluded thing (e.g. did it touch `story-downtime-fetch.js`,
     merge the three tab files, wire up or delete `renderStoryTab`, or add a jsdom/DOM test
     environment - all explicitly ruled out?).
   - Specified behaviour that is missing, or present only in appearance (e.g. AC 4's shared sort
     helper: does it genuinely replace all THREE comparators the AC names, or did one survive
     untouched?).
   - Contradictions between a stated constraint and the actual code.
4. **Write your Pass 3a findings down now, before moving on.**

**Explicitly NOT in scope, and deliberate - do not flag these as gaps:** the merit-action
outcome-summary cross-render gap (named and left open on purpose, both in this story and in
`server/lib/story-downtime-fetch.js`'s own comment); any change to `story-downtime-fetch.js` itself;
merging `story-tab.js`/`archive-tab.js`/`downtime-tab.js` into one module (rejected during this
story's own chorus review, recorded in-file); wiring up or deleting `renderStoryTab` (ruled to leave
it exactly as-is, a separate future ticket); adding a jsdom/DOM test environment to this repo (ruled
out explicitly - the DOM-free extraction pattern is the accepted trade-off, with the real DOM wiring
left to a live-browser check outside this diff's own test suite).

### Pass 3b - now read the author's record and check it against reality

5. Now read the **Dev Agent Record** in full. It makes specific, checkable claims:
   - "10 new tests" in `storytab5-cross-app-wiring.test.js`, all passing.
   - "16/16 passing (was 14)" in the extended `storytab4-readonly-guard.test.js`.
   - "18/18, unchanged" in `story-tab-cross-app-render.test.js` - i.e. the AC 1/AC 4 refactor did not
     alter that suite's existing behaviour.
   - "78/78 passing" across the full targeted 5-file set.
   - A specific claim about `tests/fix-player-skill-acq-outcome.spec.js`: 1 of 3 Playwright tests
     fails, and this failure is **confirmed pre-existing via a `git stash` A/B** against unmodified
     base code, not a regression from this story.
   - A specific claim that the TM-Story-merge half of AC 5 could not be verified locally because a
     `local-test-token` bearer forwarded to TM Story's real production API gets rejected there
     (`NODE_ENV=production` disables the equivalent bypass on that side), and that the degrade path
     was nonetheless confirmed for real via a direct call to the local `/story-tab` route returning
     `{"downtimes":[],"chapters":[]}` at HTTP 200.
6. **Verify each claim by running it, not by reading it.** Run the suites yourself, right now. Run
   the drivers yourself. Grep the files yourself. If a first run is inconsistent, run it twice and
   say so. For the Playwright claim specifically: you do not need to re-run the full `git stash` A/B
   yourself unless you have time - but DO confirm the AC-1 test in that spec still fails today, and
   that its failure message matches what the record describes (`.merit-summary-section` not found),
   as a sanity check that the claim is at least consistent with current reality.
7. Flag anything **FALSE, OVERSTATED, or UNVERIFIABLE-AS-STATED**. This is the single highest-value
   thing this pass can find. A record's own "confirmed", "verified" or "resolved" label can itself be
   wrong - re-examine each one rather than inheriting it.
8. State plainly whether you believe this change is ready to ship as-is, needs patches, or has a
   blocking problem.

---

## Output

Write everything to `specs/stories/code-review/storytab.5-codex-findings.md`, grouped `## High` /
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
- Every command you ran, with its real result, including the vitest gate commands named above.
- **Anything you could not run, and why.** Name it specifically.
- Confirmation that you modified nothing, or that anything you touched was restored and verified
  (`git status --short` clean of unintended change).
