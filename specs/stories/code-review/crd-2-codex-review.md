# Adversarial review - crd.2 (Player-facing pending queue), TM Game

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
   `specs/stories/code-review/crd-2-codex-findings.md`, before you open anything the next pass
   allows. Do not revise an earlier pass's findings in light of what a later pass taught you - if a
   later pass contradicts an earlier one, say so as a new finding and leave the original standing.
3. At the very end, **attest** to what you actually did: which files you opened in each pass, which
   commands you ran, and anything you could not run. Do not paper over a gap - see "Honesty" below.

## Ground rules

- Repo root: `D:\Terra Mortis\TM Game`. The diff is at `specs/stories/code-review/crd-2-diff.txt`,
  relative to that root, taken against base commit `268a4961` (crd.1's final patched state) up to
  commit `49f44305` on branch `ms/crd-2-player-facing-pending-queue`.
- The diff is **deliberately scoped to source and tooling only** (`public/` and `server/tests/`).
  Story-spec and tracking edits (the story file, `sprint-status.yaml`) are excluded on purpose, so
  the earlier passes stay genuinely blind to the author's own account. Do not treat their absence as
  an omission or go hunting for them.
- **Read and run freely** to verify a claim. Running the code beats reasoning about it every time.
- **Do NOT modify, commit, or push anything.** This repo sits in an umbrella workspace alongside
  sibling repos (`TM Story`, `TM Admin`, `TM Herald`, `TM Design System`) at `D:\Terra Mortis\`. Do
  not read or touch anything outside `D:\Terra Mortis\TM Game` even to cross-reference.
- Temporarily editing a file to prove something (revert one line, confirm the check now fails the way
  you expect, restore it) **is allowed and encouraged** - you MUST restore it exactly, confirm the
  restore with `git diff`, and say so in your output.
- **Environment hazard**: this project's server tests need a live local MongoDB and skip cleanly
  rather than fail when it's unreachable (`describe.skipIf(!dbAvailable)`) - if a suite reports far
  fewer tests than its own file's test count, that's almost certainly a skip, not a pass; disclose it
  rather than report a skip as green. This is a CLIENT-side story (new `public/js/game/pending-queue.js`
  and `public/js/game/contested-resolve.js`, a deletion of `public/js/game/challenge-notification.js`,
  changes to `public/js/app.js`), so most of the interesting behaviour lives in browser-executable
  code with NO DOM environment in this repo's own test setup (no jsdom, confirmed deliberately not
  added by this story) - the new server-side test file
  (`server/tests/crd-2-pending-queue.test.js`) tests this client module's logic through some other
  mechanism; read it to understand how before judging its coverage.
- **Blast radius note**: `public/js/app.js`'s `goTab(t)` was changed to `goTab(t, ctx)` - this is a
  single, heavily-used dispatch function with roughly 60 existing call sites across the whole app,
  all of which pass one argument. Any mistake here doesn't just affect this feature, it can break
  navigation for every OTHER tab in the app. Similarly, `checkMoreBadge()` (also touched) drives a
  single shared badge element (`#more-badge`) that other, unrelated features may also want to signal
  through - a change there that isn't purely additive can suppress or falsely trigger a badge for a
  completely different feature.

## Honesty requirements (these outrank completeness)

- If you could not run something, **say so plainly and name what you could not run**. A disclosed gap
  is far more useful than a confident static read presented as a verified one.
- If you found nothing in a pass or at a severity, **say that explicitly** rather than omitting the
  section or padding with style opinions.
- Report the **exact current gate numbers** you observe: `cd server && npx vitest run tests/crd-2-pending-queue.test.js`, plus whatever Playwright specs you determine are the real changed-area set in
  Pass 3b. Report the real numbers even if they disagree with anything the story claims - especially
  then.

---

## PASS 1 - BLIND HUNTER (the diff, and nothing else)

You get the diff at `specs/stories/code-review/crd-2-diff.txt` and **nothing else**. No spec, no
story file, no project context. Do not explore the repository. Do not go looking for the spec. Read
other files only to resolve an import path the diff itself leaves ambiguous.

The blinding is the point. You are here to catch what a competent reviewer with zero project memory
would catch, uncontaminated by the author's framing of what the change was supposed to do.

### What this diff claims to be

A player-facing UI feature replacing an existing blocking-modal notification with a calm, always-
present "pending challenges" queue. It deletes one client module (`challenge-notification.js`),
adds two new ones (`pending-queue.js`, a list view with a 10-second gated poll; `contested-resolve.js`,
a routing placeholder for a screen that doesn't exist yet), and touches a shared navigation dispatch
function (`goTab`), a shared badge-computation function (`checkMoreBadge`), a shared tile-registry
array (`MORE_APPS`), and the app's HTML shell to add two new tab containers.

**That is the shape it claims. Do not trust the shape - verify it.**

### What to hunt for

1. `goTab(t, ctx)` - the diff shows the signature changed from one parameter to two, with a comment
   claiming every existing single-argument call site is unaffected. From the diff's own visible
   context around the function (you won't have the whole file), does anything suggest that claim
   could be wrong - e.g., does `ctx` get used anywhere in a way that would behave differently for
   `undefined` versus not being passed at all, or interact with default-parameter behaviour in a way
   that could subtly change something for the ~60 callers this diff doesn't show you?
2. `pending-queue.js`'s poll-diffing logic: `state.resolved = _departedRows(state.rows, next)` runs
   unconditionally on every successful fetch, computed by comparing the PREVIOUS `state.rows` against
   the newly-fetched set. Walk this by hand for the FIRST ever fetch after a fresh mount (where
   `state.rows` starts empty from `_resetState()`) and confirm nothing spurious appears in
   `state.resolved` on that first render. Then walk it for the case where `state.rows` already has
   `N` items and the fetch FAILS (`state.fetchFailed = true` is set, but note carefully: does
   `state.resolved` get cleared, left stale from the previous tick, or something else? Read the exact
   branch.).
3. `checkMoreBadge()`'s new line - `if (!hasBadge && hasPendingChallenges()) hasBadge = true;` - is
   added to an existing function you don't have the full body of. Based on what the diff DOES show
   (the line's placement relative to `badge.classList.toggle('visible', hasBadge)` immediately after),
   does the ordering look safe, or is there a risk this new check runs before or after something it
   needs to be ordered against?
4. The badge-priming call in `boot()`: `if (getRole() !== 'st') refreshPendingQueueBadge().then(checkMoreBadge);` - this is fire-and-forget (not awaited by the surrounding boot sequence). If
   `checkMoreBadge()` is ALSO called synchronously elsewhere in `boot()` (the diff shows
   `checkMoreBadge();` a few lines above, unconditionally, for every role), what are the two possible
   orderings of these two calls, and does either produce a wrong badge state even transiently?
5. Standard hunt items, apply as relevant: assertions whose PASS condition is trivially satisfiable; a
   check whose label claims more than it tests; error paths and unhandled rejections (note
   `refreshPendingQueueBadge`'s try/catch swallows the error and only sets a flag - is that flag ever
   read/surfaced anywhere in what this diff shows, or does a boot-time fetch failure vanish silently?);
   dead code or unused imports; self-contradiction within the diff itself.

**STOP. Write your Pass 1 findings to `specs/stories/code-review/crd-2-codex-findings.md` now,
before reading further.**

---

## PASS 2 - EDGE CASE HUNTER (the diff, plus the repository)

You now have full read access to `D:\Terra Mortis\TM Game`. Read whatever surrounding code you need
to understand what this change is actually plugging into. You still do **not** have the story spec
or any account of the author's intent - work from the code itself.

Your remit is boundaries and branches: walk every path, not just the one the author had in mind.

### Orientation (not ground truth - verify against the code)

Same summary as Pass 1.

### What to hunt for

1. **Resolve Pass 1 item 4 with full repo access**: read `boot()` in full in `public/js/app.js`.
   Confirm the exact relative ordering of the synchronous `checkMoreBadge()` call and the
   fire-and-forget `refreshPendingQueueBadge().then(checkMoreBadge)` chain. Does a player who opens
   the app see a badge state that's briefly wrong (either a false badge or a missed one) before the
   async fetch resolves, and if so, does anything else in the boot sequence re-trigger
   `checkMoreBadge()` afterward to correct it, or does the badge just sit wrong until the next
   organic re-render?
2. Read `initPendingQueue(rootEl, chars)` and its call site in `goTab()` in full. `goTab()` calls
   `initPendingQueue(el, suiteState.chars || [])` every time the `'contested-queue'` tab is
   activated - is `suiteState.chars` guaranteed to be populated with the viewer's real characters by
   the time a player can actually reach this tab, or is there a plausible sequencing where a player
   opens this tab before their characters have loaded, causing `_targetLabel()` to silently fall back
   to the (explicitly-flagged-as-less-authoritative) `target_character_name` from the request document
   for every row, even though the player DOES own a matching character?
3. Trace `stopPendingQueue()`'s real call sites (search the whole `public/` tree, not just this
   diff). The module comment states it has NO app-code call site today and is used only by the test
   harness. Confirm this is actually true - is there any path, including account switching, logout,
   or a role change, where the OLD behaviour (via the now-deleted `stopChallengePoller`, which the
   diff's own comment says was ALSO never called anywhere) would have mattered, and does removing it
   change anything observable? Or was this genuinely dead either way, before and after?
4. Multi-character defenders: find where `suiteState.chars` is populated and confirm it can
   genuinely contain more than one character for a single player account (per the module's own claim
   that "a player account can own several characters"). If a real account with 2+ characters has
   pending challenges targeting DIFFERENT characters, walk `_pendingRowHtml`/`_targetLabel` by hand
   for both rows and confirm each one names the correct, DIFFERENT target character, not the same one
   twice.
5. `checkMoreBadge()`'s pre-existing logic upstream of the new line (read the WHOLE function): does
   any OTHER existing badge source in that function also fail open/closed the same way, or is the
   pattern this diff adds consistent with how every other signal in that function already behaves?
6. Route/dispatch order: with two new tab ids (`'contested-queue'`, `'contested-resolve'`) added to
   `goTab()`'s if-chain, could either string collide with, shadow, or be shadowed by an existing tab
   id anywhere else in the function or in `MORE_APPS`/`NAV_ITEMS`?
7. The deleted file: confirm `challenge-notification.js` is not still imported, required, or
   referenced anywhere else in `public/` or `server/` outside of comments (a stale reference would be
   a real regression, not just documentation debt).

**STOP. Write your Pass 2 findings to `specs/stories/code-review/crd-2-codex-findings.md` now,
before reading further.**

---

## PASS 3 - ACCEPTANCE AUDITOR (the diff, plus the spec)

Two sub-passes, in this order. **The order is the highest-value instruction in this whole document.**

### Pass 3a - form findings BEFORE reading the author's own account

1. Read `specs/stories/crd-2-player-facing-pending-queue.md` - the **Story**, **Acceptance
   Criteria**, **Tasks/Subtasks**, and **Dev Notes** sections ONLY. Also read
   `specs/epic-crd-contested-roll-defence.md` for the parent epic's own scope/decisions.
2. **Do NOT read the Dev Agent Record or any Senior Developer Review section yet.** Skip past them
   entirely. Reading the author's own record first anchors you on their framing and turns a review
   into grading homework.
3. Against the acceptance criteria, check the diff and the real code it touches for:
   - Violations of an AC's **literal wording**. Read the words, not the surrounding narrative - an AC's
     exception is exactly as narrow as it is written.
   - Deviations from stated intent. **The "What this story is NOT" section is equally load-bearing** -
     check the change did not quietly do an excluded thing (in particular: does this diff build any
     part of the actual pool-resolution screen crd.3a/3b are supposed to own, beyond a bare routing
     placeholder?).
   - Specified behaviour that is missing, or present only in appearance.
   - Contradictions between a stated constraint and the actual code.
4. **Write your Pass 3a findings down now, before moving on.**

Explicitly NOT in scope for crd.2, and deliberate - do not flag these as gaps on their own:
- Building the actual pool-resolution screen (crd.3a's server endpoint, crd.3b's client UI) - a
  routing contract into it is all this story owns.
- Refactoring `office-approvals.js` into a shared component with the new player queue - a settled
  epic-level decision (Decision 3) to keep them genuinely separate, not something this story
  relitigates.
- Fixing `challenge-initiation.js`'s own manual defender-pool input field (the original injury this
  whole epic exists to remove) - that module is currently unreachable in production (its nav tile
  was removed under a prior, unrelated issue) and is out of this story's scope.
- Updating other epics' documentation (`epic-rlv-roller-harmonisation.md`,
  `dice-roller-harmonisation-audit.md`) that may cite the now-deleted `challenge-notification.js` by
  name - flagged as belonging to whoever picks up that other epic's own work, not this story.

### Pass 3b - now read the author's record and check it against reality

5. Now read the **Dev Agent Record** in full (and any Senior Developer Review section, if present).
   It makes specific, checkable claims, including:
   - "New suite: 50/50" for `crd-2-pending-queue.test.js`, with a claimed genuine red-then-green
     sequence.
   - A changed-area regression count across a named set of suites.
   - A Playwright result (15/15 on specific named specs).
   - Specific claims about what was visually verified in a real browser (nav placement, multi-
     character labelling, the poll gate measured at 0 requests over 25s while inactive, a resolved
     row correctly dimmed and untappable) and a claim that ZERO writes were made to live production
     data during that verification.
6. **Verify each claim by running it, not by reading it.** Run
   `cd server && npx vitest run tests/crd-2-pending-queue.test.js` yourself, right now, and report the
   real result. Read that test file in full first to understand HOW it tests client-side DOM/module
   behaviour without jsdom (this repo doesn't have one) - is the testing approach it uses genuinely
   sound, or does it test something narrower than "50/50" implies? Then determine the real Playwright
   changed-area set yourself (grep `tests/*.spec.js` for references to `MORE_APPS`, `more-badge`, or
   the tab ids this diff adds) and run it if you can (note: Playwright may need a running local
   server - if you cannot start one, say so explicitly and explain what you could not verify as a
   result, per this project's own known gotchas around `npm run dev` crash-looping in some
   environments - use `node server/index.js` directly if you attempt it, not `npm run dev`).
7. Flag anything **FALSE, OVERSTATED, or UNVERIFIABLE-AS-STATED**. This is the single highest-value
   thing this pass can find. A record's own "confirmed", "verified" or "resolved" label can itself be
   wrong - re-examine each one rather than inheriting it. In particular: is the "zero writes to live
   Atlas" claim actually credible given how the record says visual verification was done (a
   client-side fetch shim) - does anything in the actual test file or the module's own code suggest a
   real write COULD have happened despite that claim?
8. State plainly whether you believe this change is ready to ship as-is, needs patches, or has a
   blocking problem.

---

## Output

Write everything to `specs/stories/code-review/crd-2-codex-findings.md`, grouped `## High` /
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
- Every command you ran, with its real result, including the gate commands named above.
- **Anything you could not run, and why.** Name it specifically.
- Confirmation that you modified nothing, or that anything you touched was restored and verified
  (`git status --short` clean of unintended change).
