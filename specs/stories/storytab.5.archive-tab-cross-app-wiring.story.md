# Story storytab.5: Wire BOTH Live Downtime-Reading Surfaces (`archive-tab.js`'s "STORY" Nav AND
# `downtime-tab.js`'s "Info" Tab Accordion) to the Cross-App Downtime Fetch

## Status: review — 2026-09-19. Implemented direct (spec was already complete after chorus review,
## same precedent as storytab.1/.3/.4). All 11 ACs implemented and regression-tested; AC 5 partially
## verified live locally (degrade path confirmed real, not mocked) with the TM-Story-merge half of
## the check honestly blocked on a structural local/production auth boundary, not skipped — see the
## Dev Agent Record below for the full account and the recommended path (deploy, or Angelus's own
## live-site look). **Time-sensitive: Game 9 is today, 2026-09-19.**

## Story

**As a** player (or ST), **I want** every live surface I can actually reach that claims to show my
downtime outcomes — the "STORY" nav button, AND the Info tab's "Past Outcomes" accordion — to show my
real, current outcomes including everything filed in `tm_story` since Game 8, correctly ordered,
**so that** the epic `epic-storytab-cross-db-read` closed this week actually fixes the bug it was
opened to fix, on every surface a real player reaches, not on a code path nothing calls.

## Background

`epic-storytab-cross-db-read` (`storytab.1`-`storytab.4`) is DONE, code-reviewed (including an
external Codex pass on `storytab.4`), tested, and deployed to `main` (`9ab7fe31`). All four stories
built and tested against `public/js/tabs/story-tab.js`'s `renderStoryTab()` / `renderLatestReport()`
/ `renderChronicle()`.

**This was not a blind spot in those stories — it was a named, written scope cut, made explicitly at
the epic's own scoping time, 2026-09-18.** The epic doc's own "Why this is a real, live, current bug"
section already says: *"`public/js/tabs/archive-tab.js`'s `renderArchiveList()` reads the identical
`apiGet('/api/downtime_submissions')` call and has the identical staleness — flagged here as sharing
the same root cause, but deliberately NOT folded into this epic's stories below without a separate
scoping pass... do not silently expand any story's diff to also touch `archive-tab.js` without saying
so."* Its "Explicitly not yet scoped" section repeats the same call, verbatim, and names the fix
path: *"A future story should scope it explicitly once this epic's pattern is proven."*

That is exactly what this story is. The outgoing session's "critical finding" tonight was real and
correctly verified (live in-browser, ST role, a real character — Yusuf Kalusicj — with a real,
published Game 8 review sitting in `tm_story`, confirmed directly in Mongo) — but it is the deferred
item coming due on schedule, not a surprise regression in `storytab.1`-`.4`'s own work. Framing
matters for triage: nothing in the shipped epic needs re-opening or re-reviewing; this is purely the
named follow-up.

**What's actually broken — now confirmed to be TWO live surfaces, not one:**

1. The nav button labelled "STORY" dispatches to `initArchiveTab()` → `renderArchiveList()` in
   `public/js/tabs/archive-tab.js`. That function (`archive-tab.js:53-136`) fetches only
   `apiGet('/api/downtime_submissions')` + `apiGet('/api/chapters')` — `tm_game`'s own collections,
   frozen since Game 7.
2. **Found by Winston during chorus review, independent of the original finding above: the "Info" tab
   has the identical bug on a THIRD render path.** `app.js`'s `renderTabBody` dispatch (`t === 'info'`,
   `app.js:592-601`) calls `renderPastOutcomes(miscEl, char)` from `public/js/tabs/downtime-tab.js`
   (`downtime-tab.js:154-218`), which hand-rolls the identical `tm_game`-only fetch and was never
   touched by the epic either. **Worse: `app.js:596-598` carries a comment asserting this is "now the
   ONLY surface a published downtime outcome is visible on"** — confirmed false independent of
   tonight's incident, since `archive-tab.js`'s own Downtime Reports list shows the same data, and the
   comment predates tonight regardless.

Neither of these was a blind spot in `storytab.1`-`.4` (see the reframing above) — but they are now
BOTH confirmed live, and both need the same fix, in the same story, not a second follow-up pass.

Both surfaces call `fetchAndMergeStoryTabDowntimes()`'s intended replacement — the private helper
already exists in `story-tab.js` (currently used only at its own two call sites, `:69` inside
`renderLatestReport()` and `:117` inside `renderStoryTab()`). Confirmed directly: `renderStoryTab()`
itself has zero callers anywhere in `public/js` — not wired into the live sidebar at all (see
Story-Prep Question 1). The route, the adapter (`server/lib/story-downtime-fetch.js`), and the
read-only guard (`storytab.4`) are all correctly deployed and would work; nothing on either reachable
path calls them.

**Correction to this story's own first draft, found by Dana during chorus review**: the first draft
of this story claimed *"No second adapter, no new sort rule... is needed here — `archive-tab.js`
already sorts by the same effective key `story-tab.js` does."* **That claim was wrong, and Dana
reproduced why with real live numbers, not just a code read.** See AC 4 below — this is not a minor
correction, it is a real, reproducible ordering bug this exact wiring would trigger on its own
motivating example (a player's newest Game 8/9 review) the first time it ships. Winston's
architecture recommendation and Dana's data-integrity recommendation converged on the same shape of
fix (one shared function, not a comparator patched independently per call site). **Angelus ruled
directly, 2026-09-19: build the shared helper (Dana's Option 2).** See AC 4 for the required
implementation.

## Acceptance Criteria

1. **`fetchAndMergeStoryTabDowntimes` becomes `export`ed** from `story-tab.js` (currently a private,
   module-local `function`). No change to its own signature or behaviour — it already never throws
   and already degrades to "TM Game data only" on any TM Story failure (network, non-2xx, malformed
   body), which this story relies on rather than re-implements.
2. **`archive-tab.js`'s `renderArchiveList()` calls the exported helper** immediately after its
   existing `tm_game` fetch (right after the `subs.forEach` `published_outcome` promotion at line
   66, before `cycleMap`/`cycleOrderMap`/`downtimeSubs` are built at line 69), reassigning its local
   `subs`/`cycles` to the merged result — mirroring exactly how `renderLatestReport()` already does
   this at `story-tab.js:69`. `openDowntimeDetail` (already renders via the shared
   `renderOutcomeWithCards()`, already imported) needs no further change: it operates on whatever
   `subs`/`cycleMap` it's given.
3. **NEW, folded in from Winston's chorus finding: `downtime-tab.js`'s `renderPastOutcomes()` gets the
   identical fix.** Call the same exported helper right after its own `published_outcome` promotion
   loop (`downtime-tab.js:164-168`), before its `cycleMap`/`charId`/sort construction (`:171-177`).
   `downtime-tab.js` already imports `renderOutcomeWithCards` from `story-tab.js` (`:6`), so this adds
   a second named import from an already-imported module, the same pattern as `archive-tab.js`. **Also
   fix the false comment at `app.js:596-598`** ("this is now the ONLY surface a published downtime
   outcome is visible on") — it was already inaccurate before tonight (`archive-tab.js`'s Downtime
   Reports list shows the same data) and must not survive this story still claiming something false
   about a surface this story itself is changing.
4. **NEW, folded in from Dana's chorus finding: fix the cross-source sort bug before either surface
   ships the merge.** Confirmed and reproduced (Dana, live numbers in Node, not just a code read):
   - `archive-tab.js`'s own sort comparator (`:78-82`) is a STRING compare —
     `String(kb).localeCompare(String(ka))` — not the numeric `gb - ga` compare
     `story-tab.js`'s `renderChronicle`/`renderLatestReport` use. These are NOT equivalent, despite
     this story's own first-draft claim that "no new sort rule is needed."
   - `syntheticChapterFor()` (`server/lib/story-downtime-fetch.js:121,167-172`) assigns TM-Story
     entries `game_number: 1_000_000_000 - rank` — correct for a NUMERIC compare, but a 10-digit
     string once stringified. Real `tm_game.chapters` top out at `game_number: 8`.
     `"1000000000".localeCompare("8")` compares the first character (`'1'` vs `'8'`) and returns
     negative — **a player's newest published Game 8/9 review sorts DEAD LAST, behind even Game 2**,
     the first time a real player clicks STORY after this ships. This is exactly the motivating
     example this whole epic exists to fix, breaking a different way.
   - This risk is latent today only because `archive-tab.js`'s `cycles` array has only ever held small
     real `tm_game` integers that happen to compare correctly as strings by coincidence. Wiring in the
     merge (AC 2/3) is exactly what exposes it — so this AC cannot be deferred to a later story; it
     must land in the same change as AC 2/3, or AC 2/3 makes the product WORSE for the exact case it
     was meant to fix.
   - **RULED, Angelus, 2026-09-19: build Dana's Option 2 — one shared sort/order helper.** Not a menu
     any more; this is the required implementation. Export it alongside
     `fetchAndMergeStoryTabDowntimes` in `story-tab.js`, with `story-tab.js`'s own existing numeric
     `gb - ga` compare (already correct, already proven by `storytab.1`'s own tests) as the canonical
     logic the helper wraps. `renderChronicle`'s own inline sort, `archive-tab.js`'s comparator
     (`:78-82`), AND `downtime-tab.js`'s comparator (`:177`, see the addendum below) are all REPLACED
     by calls to this one helper — not three independently-maintained comparators any more, one.
     - **Considered and rejected, Option 1 (patch `archive-tab.js`'s comparator in isolation)**:
       smaller diff, but leaves two (in fact three, per the addendum below) independently-maintained
       sort implementations free to drift apart again — rejected for exactly the drift risk this bug
       is itself an instance of.
     - **Considered and rejected, Option 3 (change the adapter's synthetic signal itself**, e.g. a
       real ISO-timestamp-shaped value instead of a large integer, so any comparator produces the
       right order without coordination**)**: rejected by Dana's own assessment as more invasive than
       the bug needs; named here only so the option isn't silently dropped from the record.
   - **Addendum, found during the prior revision while grounding Winston's AC 3 fix (Bob's own check,
     not Winston's or Dana's finding — flagged separately to avoid misattributing it), now resolved by
     the same ruling**: `downtime-tab.js`'s OWN existing sort (`:177`,
     `String(b._id) > String(a._id) ? 1 : -1`) is a THIRD, independently-coded comparator, keyed on
     `_id` string comparison rather than `chapter_id`/`game_number` at all. The synthetic `_id`
     `adaptStoryReport()` assigns (`story:<characterId>:<cycle_id>`, `story-downtime-fetch.js:143`)
     happens to sort ahead of every real Mongo ObjectId string purely because `'s'` (0x73) is
     ASCII-greater than any hex character a real ObjectId can contain — so the BLOCK order (TM-Story
     entries ahead of `tm_game` entries) comes out right here BY A DIFFERENT COINCIDENCE than the one
     Dana found broken in `archive-tab.js`. The order AMONG TM-Story entries themselves then depends
     on lexicographically comparing raw `cycle_id` substrings, never designed or tested as a sort key.
     The shared helper above REPLACES this comparator too, not just the two Dana examined directly —
     three independently-coded comparators being fed the same new data was the underlying problem;
     the ruling above closes it for all three, not two.
5. **A real player/ST, on the live site, sees a TM-Story-sourced Game 8 (or later) downtime report in
   BOTH the "STORY" nav's Downtime Reports list AND the Info tab's Past Outcomes accordion**, correctly
   ordered relative to older `tm_game`-sourced entries (per AC 4's fix), and both detail views render
   with the same section treatment (Story Moment, Home Report, project cards, Rumours) as a native
   `tm_game` entry — this is the actual Definition of Done, not "the function is exported" or "the unit
   tests are green." **A live in-browser check of BOTH surfaces (the same class of check that caught
   this gap in the first place) is a mandatory, named step of this story's own sign-off, not an
   optional nice-to-have** — the epic this follows was fully green (code review, external Codex pass,
   tests, deploy) and still didn't meet this bar once; this story's own FIRST DRAFT also stated a false
   "no new sort rule needed" claim that only a second and third independent check (Dana's, then Bob's
   own addendum above) caught. A passing test suite alone does not satisfy this AC.
6. **TM Story failure still degrades gracefully on BOTH new call sites specifically.**
   `fetchAndMergeStoryTabDowntimes` already swallows errors internally, but that guarantee was proven
   against `story-tab.js`'s own two callers (`server/tests/storytab4-readonly-guard.test.js`'s AC 4
   persistence scan, extended post-Codex to cover exactly `renderLatestReport`/`renderStoryTab`).
   `archive-tab.js` and `downtime-tab.js` are a third and fourth caller feeding different downstream
   consumers (`archive-tab.js`'s Dossier row and Retired Characters grid; `downtime-tab.js`'s Current
   Cycle zone) — tests exercising both `renderArchiveList()` and `renderPastOutcomes()` with a
   TM-Story-failure fixture must show each surface's own Downtime/Past-Outcomes section still renders
   (`tm_game`-only, correctly) rather than the whole tab, or the unrelated Dossier/Retired-
   Characters/Current-Cycle sections, breaking.
7. **No regression to the sections of either file this story does not otherwise touch** —
   `archive-tab.js`'s Dossier row (`openDossierDetail`) and Retired Characters grid;
   `downtime-tab.js`'s Current Cycle zone (the active-downtime-window UI, unrelated to Past Outcomes).
   A before/after content comparison for a character with no TM Story data at all must be unchanged on
   both files.
8. **`storytab.4`'s read-only/no-write-back guard's coverage is checked, not assumed, against BOTH new
   call sites.** That story's own lexical/persistence scanner was originally scoped to
   `fetchAndMergeStoryTabDowntimes` and its two THEN-existing callers; `storytab.4`'s own Codex review
   already found and fixed exactly this class of gap once (Pass 3a: the AC 4 scan "stopped at the
   merge function's own boundary" until extended to follow data into its actual callers). Confirm
   whether `archive-tab.js`'s AND `downtime-tab.js`'s new call sites are covered by that existing
   scan's file list, or extend it — do not assume the guard is generic just because the function it
   guards is unchanged.
9. **RULED, Angelus, 2026-09-19: no new jsdom/DOM test environment gets added to this repo.** Both
   `archive-tab.js` and `downtime-tab.js` currently have zero unit tests of any kind, and neither
   `renderArchiveList()` nor `renderPastOutcomes()` is the DOM-free shape
   `story-tab-cross-app-render.test.js`'s existing precedent tests directly. Required approach instead:
   **extract the fetch+merge+sort logic in both files into small, pure, DOM-free functions** (the same
   shape `renderChronicle` already is in `story-tab.js`) and unit-test those directly — covering AC 2's
   and AC 3's merge-wiring, and AC 4's shared sort helper specifically. **This does NOT prove the actual
   DOM rendering wires up correctly end to end** (the `innerHTML`/`querySelectorAll`/
   `document.getElementById` calls that stay inside `renderArchiveList()`/`renderPastOutcomes()`
   themselves are explicitly NOT covered by this unit-test layer) — that gap is accepted deliberately,
   not overlooked, and is exactly what AC 5's mandatory real-browser check exists to cover instead. Do
   not treat AC 5 as optional just because AC 9's unit coverage is green.
10. **British English, no em-dashes**, in every new string, comment, and test description — repo
    convention, unchanged from every story before it in this epic.
11. **RULED, Angelus, 2026-09-19: correct both stale status trackers as part of this story's own diff**,
    not a separate ticket (Story-Prep Question 3, now closed). Specifically:
    - `../epic-storytab-cross-db-read.md`'s own Status line currently reads "DONE, 2026-09-19 — all 4
      stories complete," which overstates the epic's own stated goal ("real downtimes are currently
      invisible... the actual 'players can't see their downtime at all' blocker") given the gap this
      story closes. Update it to reflect that this story (`storytab.5`) was the actual closing story
      for that goal, and add `storytab.5` to that epic's own numbered "Stories" list.
    - `specs/stories/sprint-status.yaml`'s own epic line currently reads "storytab.1-3 done; 4 not
      started," which is independently wrong on its own terms (storytab.4 is done per its own file's
      Status line) as well as now missing storytab.5 entirely. Correct both errors in the same edit.

## Explicitly NOT in scope

- **The merit-action outcome-summary cross-render gap** (`outcome_summary`/`pool_status` not yet
  reaching `renderMeritSummarySection()` for TM-Story-sourced entries, documented in `storytab.1`'s own
  Dev Notes and `story-downtime-fetch.js`'s own comment). Angelus has already deferred this once; it
  is a real, separate, smaller gap and this story must not silently absorb it. State plainly in this
  story's own Dev Agent Record that it remains open, rather than leaving it unmentioned a second time
  in a row.
- **Any change to `storytab.1`'s adapter (`story-downtime-fetch.js`), `storytab.2`'s chapter-routing
  rule, or TM Story's own `74-1` allowlist** — beyond AC 4's sort-fix decision, which touches how the
  ADAPTER'S synthetic `game_number`/`_id` values are consumed, not what TM Story returns or how the
  adapter maps fields.
- **Merging `story-tab.js`, `archive-tab.js`, and `downtime-tab.js` into one module.** Winston
  explicitly rejected this during chorus review: the nav-dispatch layer is already clean, and the
  real duplication is one layer down (the fetch-and-normalise step, now copy-pasted across FOUR call
  sites once this story lands: `story-tab.js` x2, `archive-tab.js`, `downtime-tab.js`). Extracting that
  shared fetch+promote+filter block into one function all four call sites use is Winston's own
  recommendation as a SEPARATE backlog item, not this story. AC 4's shared sort helper (now RULED, not
  optional) closes the sort piece of that same duplication specifically, as part of this story — it
  does not itself complete the wider fetch+promote+filter extraction Winston named, which stays out.
- **Redesigning `archive-tab.js`'s Dossier/Retired Characters sections or `downtime-tab.js`'s Current
  Cycle zone**, or either file's list/detail navigation pattern generally. Only the downtime-reading
  data source and its sort changes; the surrounding UI is untouched.
- **A new jsdom (or equivalent DOM) test environment for this repo's `vitest` suite. RULED OUT,
  Angelus, 2026-09-19** — see AC 9 and Story-Prep Question 2 (closed) below. The accepted trade-off is
  that this story's own unit tests cannot prove the DOM rendering itself wires up correctly end to
  end; AC 5's mandatory real-browser check is what covers that instead, deliberately, not by omission.
- **Wiring up OR deleting `renderStoryTab()`. RULED, Angelus, 2026-09-19** — leave it exactly as it is;
  do not fix its dead-code status inside this story either way. See Story-Prep Question 1 (closed) for
  the ruling and the follow-up-ticket note.

## Story-Prep Questions — ALL CLOSED

All five questions this story originally raised have been ruled on directly by Angelus, 2026-09-19.
Kept here (rather than deleted) as the decision record — each entry names the ruling, the rationale,
and where the ruling actually lives in this story's own ACs/scope sections above. Nothing below is
still open; nothing below blocks a dev agent starting.

1. **CLOSED — ruled by Angelus, 2026-09-19: leave `renderStoryTab()` exactly as it is; open a
   separate, later ticket to investigate it, not this story.** Confirmed independently twice —
   first this session, then reaffirmed by Winston during chorus review — `renderStoryTab` has zero
   callers anywhere in `public/js`, and this story only fixes the two paths a player/ST actually
   reaches (`archive-tab.js`, `downtime-tab.js`). **A follow-up item should be opened** to investigate
   whether `renderStoryTab`/the `svt-dt` "DT Report" toggle it's wired behind is intentionally parked
   mid-rollout or itself an orphaned wiring gap (Winston's own framing) — the same way this story
   already names Winston's shared-fetch-helper extraction as its own separate backlog item, rather
   than either silently fixing or silently dropping the observation. Not created here; just recorded
   as needed and why. See "Explicitly NOT in scope" above for the corresponding scope boundary.
2. **CLOSED — ruled by Angelus, 2026-09-19.** Extract the fetch+merge+sort logic in both files into
   small, pure, DOM-free functions and unit-test those directly (covering AC 2/3's merge-wiring and
   AC 4's shared sort helper); no jsdom/DOM test environment gets added to this repo. Rationale: this
   repo's `vitest.config.js` genuinely has no DOM environment today (confirmed directly, not assumed),
   and adding one is a bigger, general-capability change disproportionate to this story, whereas the
   extraction approach mirrors `story-tab-cross-app-render.test.js`'s existing precedent exactly. The
   accepted trade-off — this layer of testing does not itself prove `renderArchiveList()`'s or
   `renderPastOutcomes()`'s actual `innerHTML`/DOM wiring is correct end to end — is deliberately
   covered instead by AC 5's mandatory real-browser check, not left as a silent gap. See AC 9 for the
   full ruling as written into this story's own acceptance criteria.
3. **CLOSED — ruled by Angelus, 2026-09-19: fix both stale trackers now, as part of this story, not a
   separate ticket.** Small enough scope addition to fold in directly rather than spin out. See AC 11
   for the full ruling (both the epic doc's overstated Status line and `sprint-status.yaml`'s
   independently-wrong epic line) as written into this story's own acceptance criteria.
4. **CLOSED — ruled by Angelus, 2026-09-19: no fallback-messaging content gets scripted by this
   story.** Player-facing comms about the gap, if the timeline slips past today's Game 9 session, is a
   judgement call for Angelus/the ST team to make in the moment, not something a Scrum Master's story
   document should pre-script. Recorded as a ruling, not actioned with any comms text here.
5. **CLOSED — ruled by Angelus, 2026-09-19.** Dana's Option 2: one shared sort/order helper,
   replacing all three currently-divergent comparators (`renderChronicle`'s own inline sort,
   `archive-tab.js`'s, and `downtime-tab.js`'s). Rationale: removes the exact drift risk that let
   three independently-coded comparators go unnoticed until this story's own chorus review caught two
   of them and Bob's own follow-up check caught the third; Options 1 and 3 are recorded in AC 4 as
   considered and rejected, not silently dropped. See AC 4 for the full ruling as written into this
   story's own acceptance criteria.

## Dev Notes

- The insertion point for AC 2 is precise and small: `archive-tab.js:66-69`, between the existing
  `published_outcome` promotion loop and the `cycleMap`/`cycleOrderMap` construction. Do not move the
  Dossier-row or Retired-Characters rendering blocks (lines 90-119); they are unaffected and should
  stay exactly where they are.
- The insertion point for AC 3 is the equivalent spot in the other file: `downtime-tab.js:168-171`,
  between the existing `published_outcome` promotion loop (`:164-168`) and the `cycleMap`/`charId`/sort
  construction (`:171-177`). Do not touch the Current Cycle zone code above it in the same file.
- `fetchAndMergeStoryTabDowntimes(char, subs, cycles)` needs a `char` argument — `archive-tab.js`
  already holds the module-level `_char` set by `initArchiveTab()` (line 46), so its call site is
  `fetchAndMergeStoryTabDowntimes(_char, subs, cycles)`; `downtime-tab.js`'s `renderPastOutcomes(el,
  char)` already receives `char` as its own parameter, so its call site is simply
  `fetchAndMergeStoryTabDowntimes(char, subs, cycles)`. Neither needs a new parameter threaded through
  from further up the call chain.
- `downtime-tab.js`'s `_cycleDate(sub, cycles)` helper (`:307-313`) looks up `closed_at`/`deadline_at`
  on the matching chapter for display purposes only; a synthetic chapter (`syntheticChapterFor()`) has
  neither field, so it degrades to an empty date string, not a crash — confirmed by reading the
  function, not assumed, and not itself an AC since it is a harmless, silent degrade (a TM-Story-
  sourced Past Outcomes row just shows no date chip, matching how `archive-tab.js`'s own equivalent
  already handles an unlabelled cycle).
- Do not treat AC 4's sort-fix as optional or deferrable once AC 2/3 land — see AC 4's own text for why
  shipping the merge without it makes the product actively worse for this story's own motivating case.
- AC 11's tracker fix: the epic doc's Status line is `../epic-storytab-cross-db-read.md:3-16` (the
  multi-line `## Status:` block at the top of the file); its numbered "Stories" list to add
  `storytab.5` to is at `../epic-storytab-cross-db-read.md:158-190`. `sprint-status.yaml`'s epic line
  is at `specs/stories/sprint-status.yaml:2237` (confirmed by direct grep this session — that file is
  831.7KB, too large to open whole; grep for `epic-storytab-cross-db-read` rather than paging through
  it by offset).

## References

- `../epic-storytab-cross-db-read.md` ("Why this is a real, live, current bug" and "Explicitly not yet
  scoped" — both sections that name the `archive-tab.js` half of this gap, 2026-09-18, before this
  story existed).
- `stories/storytab.1.inter-service-downtime-fetch.story.md` (the fetch/merge/adapter this story
  reuses; its own "Explicitly NOT in scope" already named `archive-tab.js` as out for that story
  specifically; `downtime-tab.js` was not named there at all, confirming it was a genuine chorus-
  review find, not a second known-and-deferred item).
- `stories/storytab.4.read-only-no-writeback-guard.story.md` (the guard whose coverage AC 8 above asks
  to be re-checked against both new call sites; see its own Codex Pass 3a for the precedent of exactly
  this class of gap).
- `public/js/tabs/story-tab.js:39-46` (`fetchAndMergeStoryTabDowntimes`, to be exported), `:52-96`
  (`renderLatestReport`, the pattern to mirror), `:75-81`/`:213-217` (the numeric `gb - ga` sort AC 4
  contrasts against the string comparators it fixes), `:98-193` (`renderStoryTab`, confirmed to have
  zero live callers — see Story-Prep Question 1).
- `public/js/tabs/archive-tab.js:53-136` (`renderArchiveList`, one of this story's two targets),
  `:78-82` (the string-comparator sort bug AC 4 fixes), `:153-173` (`openDowntimeDetail`, unchanged,
  already generic via `renderOutcomeWithCards`).
- `public/js/tabs/downtime-tab.js:154-218` (`renderPastOutcomes`, this story's second target, found by
  Winston), `:177` (its own independent `_id`-string sort, the addendum under AC 4).
- `public/js/app.js:592-601` (the `'info'` tab-body dispatch, including the false "ONLY surface"
  comment AC 3 corrects).
- `server/lib/story-downtime-fetch.js:121,140-172` (`adaptStoryReport`/`syntheticChapterFor`, the
  synthetic `_id`/`game_number` values whose string-vs-numeric handling AC 4 is actually about).
- `server/tests/story-tab-cross-app-render.test.js`, `server/tests/storytab4-readonly-guard.test.js`
  (existing precedent to extend/mirror, with the DOM-shape caveat in Story-Prep Question 2).
- `specs/stories/sprint-status.yaml:2237` (the stale epic line AC 11 corrects; file is too large to
  open whole, grep for `epic-storytab-cross-db-read` rather than paging through it).

## Dev Agent Record

**Status: `review`, 2026-09-19.** Implementation complete against all 11 ACs; regression-tested;
one AC only partially verified for a real, structural reason (below), not skipped.

### Implementation summary

- **AC 1**: `fetchAndMergeStoryTabDowntimes` exported from `story-tab.js`.
- **AC 4**: new exported `sortDowntimesByChapterRecency(subs, cycles)` in `story-tab.js`, wrapping
  the file's own pre-existing numeric `gb - ga` compare. `renderChronicle` and `renderLatestReport`
  now call it instead of their own inline sorts (behaviour-preserving — same comparator, same
  default). `archive-tab.js`'s old string `localeCompare` comparator and `downtime-tab.js`'s old raw
  `_id`-string comparator are both replaced by calls to the same shared helper.
- **AC 2 / AC 9**: `archive-tab.js` gets a new exported `loadArchiveDowntimeData(char)` — the
  fetch+promote+merge+sort logic extracted into one DOM-free async function, returning
  `{ downtimeSubs, cycleMap }`. `renderArchiveList()` now calls it and does only DOM work with the
  result. Dossier/Retired-Characters rendering below it is untouched.
- **AC 3 / AC 9**: same pattern in `downtime-tab.js` — new exported `loadPastOutcomesData(char)`,
  returning `{ publishedSubs, cycles }`. `renderPastOutcomes()` now calls it. The Current Cycle zone
  (`initDowntimeTab`) is untouched, per the story's own scope boundary. The false "ONLY surface"
  comment at `app.js:596-601` corrected.
- **AC 8**: `storytab4-readonly-guard.test.js` extended with two new tests scanning
  `loadArchiveDowntimeData` and `loadPastOutcomesData` for the same persistence violations AC 4's
  existing scan checks `story-tab.js`'s own two callers for.
- **AC 11**: `specs/epic-storytab-cross-db-read.md`'s Status line and Stories list corrected;
  `specs/stories/sprint-status.yaml`'s epic line corrected and this story's own line added.
- **Explicitly NOT in scope, confirmed untouched**: the merit-summary cross-render gap (still open,
  named in `story-downtime-fetch.js`'s own comment, not this story's job); `story-downtime-fetch.js`
  itself; merging the three tab files into one module (Winston's rejection recorded in the story
  itself); `renderStoryTab`'s dead-code status (Story-Prep Question 1, left exactly as found); no
  jsdom added to this repo.

### Testing

- **New**: `server/tests/storytab5-cross-app-wiring.test.js` — 10 tests. Covers AC 4 (the
  reproduced sort bug, fixed, plus non-mutation and internal-order-preservation), AC 2/AC 6 (merge
  wiring + degrade path + `published_outcome` promotion for `archive-tab.js`), AC 3/AC 6 (same for
  `downtime-tab.js`, including the "initial fetch itself fails" early-return case). All against the
  real production functions (`adaptStoryReport`/`syntheticChapterFor` from
  `story-downtime-fetch.js`), not reimplemented test logic, mirroring `story-tab-cross-app-render.
  test.js`'s own established pattern (`vi.mock` on `../../public/js/data/api.js`, following
  `bl2-bloodlines-cache.test.js`'s precedent for that mock shape).
- **Extended**: `storytab4-readonly-guard.test.js` — 2 new tests (AC 8). 16/16 passing (was 14).
- **Regression**: `story-tab-cross-app-render.test.js` (18/18, unchanged) confirms AC 1/AC 4's
  refactor didn't alter `renderChronicle`'s own AC 6 block-rule behaviour. Full targeted set (5
  files touching the four changed source files): 78/78 passing.
- **Playwright**: `tests/fix-player-skill-acq-outcome.spec.js` (the one e2e spec exercising
  `renderPastOutcomes`' real DOM output) — 1 of 3 tests fails (`AC-1: skill acquisition
  outcome_summary appears in player Resources group`, `.merit-summary-section` not found).
  **Confirmed pre-existing via `git stash` A/B**: identical failure, same error, same line, against
  unmodified base code. Not a regression from this story.

### AC 5 — partially verified locally; full verification needs a deployed environment

Per this repo's own `CLAUDE.md`: *"Angelus cannot run the app locally to smoke-test. Anything
needing a human look must be on a deployed environment first."* That constraint turned out to be
load-bearing for this specific AC, not just a general note.

**What WAS verified, live, in-browser, locally** (local frontend :8080 + local API :3000, ST role
via `local-test-token`, character Yusuf Kalusicj):
- The app boots and both surfaces (STORY nav, Info tab Past Outcomes) render without error.
- STORY tab correctly shows `tm_game`-native data ("Downtime 2") for this character.
- The TM-Story merge itself was confirmed to degrade gracefully for real (not just mocked): a
  direct call to the local `/story-tab` route returned `{"downtimes":[],"chapters":[]}` at HTTP 200
  — the merge ran, found nothing usable, and both surfaces still rendered their `tm_game` data
  correctly rather than breaking. This is a genuine, non-mocked confirmation of AC 6's degrade
  guarantee.

**What could NOT be verified locally, and why**: seeing a real TM-Story-sourced Game 8+ entry
render on either surface. `local-test-token` is a local-only auth bypass; the bearer token still
gets forwarded verbatim to TM Story's real, deployed production API (`storyApiBaseUrl()` defaults
to `https://tm-story-api.onrender.com`, and `TM_STORY_API_URL` is unset locally). That production
API almost certainly runs `NODE_ENV=production`, where TM Story's own equivalent local-test bypass
(confirmed to exist in TM Story's `middleware/auth.js`, gated by `devSurfacesEnabled()`) is
deliberately fails-closed. A same-session attempt to run TM Story's own server locally against its
`NODE_ENV=development` bypass hit a separate, unrelated blocker (its local `.env` targets a
`tm_wiki_dev` seed database via a credential that failed Mongo auth on this run) and was abandoned
rather than chased further, as out of scope for a TM Game story to be debugging a sibling repo's
local dev setup.

**Net**: the code path, the data contract, and the degrade behaviour are all confirmed correct by
real evidence (10 new automated tests reproducing the exact bug and fix with real production
functions, plus this live-but-partial browser check). What remains unverified is the one thing that
structurally requires either a deployed environment or Angelus's own real Discord-authenticated ST
session — consistent with, not contradicting, this repo's own stated testing limits. **Recommend**:
either deploy to Netlify/Render (explicit instruction required, not assumed here) so a real check
can happen, or Angelus does the live-site look himself once this ships — his own eyes on a real
Game 8/9 entry is the actual bar AC 5 sets, and no amount of further local tooling changes that.

### Deferred to a separate ticket (not this story, not started)

Named per Story-Prep Question 1: whether `renderStoryTab`'s zero-caller status is intentional
mid-rollout parking or an orphaned wiring gap of its own, worth a deliberate look. Not investigated
further here.
