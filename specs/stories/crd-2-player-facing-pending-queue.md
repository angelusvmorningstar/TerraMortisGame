---
id: crd.2
epic: crd
epic_file: specs/epic-crd-contested-roll-defence.md
status: done
priority: high
type: feature
depends_on: [crd.1]
branch: ms/crd-2-player-facing-pending-queue
---

# Story CRD.2: Player-facing pending queue (standalone)

As a defending player,
I want to see my pending contested-roll challenges as a calm, always-present list I check on my own
terms,
so that I am never ambushed by a blocking modal, and so the queue can route me into a real
resolution screen (crd.3b, not built yet) instead of the interrupt-and-immediately-accept flow that
crd.1 already made unusable for any correctly-created new-style request.

## Why this story exists

Read `public/js/game/challenge-notification.js`, `public/js/game/challenge-initiation.js`, and
`public/js/suite/office-approvals.js` in full before touching anything — this story replaces the
first, leaves the second alone (flagged, not fixed here), and borrows only *row-grammar* from the
third by inspection.

**Finding 1 — `challenge-notification.js`'s existing modal is now structurally incompatible with
crd.1's own schema change.** `_showIncomingModal()` (lines 69-111) unconditionally renders
`challenge.defender_pool` as "Your pool" (line 95) and its Accept button calls `PUT /:id/accept`
directly with no way to submit a resolved pool (lines 113-133). crd.1 made `defender_pool` legally
absent on a pending contested-roll document and added a 409 guard specifically for that case
(`contested-rolls.js:107-112`, `"This challenge has no defender pool yet and cannot be accepted"`).
For any contested-roll document created the *new*, intended way (no `defender_pool` supplied), this
modal today would literally render `"Your pool: undefined"` and its Accept button would always
409. This story does not merely "soften an interrupt into a calmer list" — it replaces a flow that
crd.1 has already made non-functional for its own intended future documents.

**Finding 2 — contested rolls are not currently creatable through ANY live UI**, as far as a
full-repo search this story's own investigation ran can find. `challenge-initiation.js` (the
attacker-side "Issue a Challenge" modal, the only client code anywhere that `POST`s to
`/api/contested_roll_requests`) is reachable only via `goTab('challenge')`
(`public/js/app.js:460-462`), and nothing in `app.js`, any `public/*.html`, or any other client file
calls `goTab('challenge')` — its `MORE_APPS` tile was removed with a code comment
(`public/js/app.js:1688`, `"Challenge tile hidden (#1015)... remain wired for future programmatic
use"`), leaving the wiring orphaned. **This means the whole contested-roll feature is currently
dormant in production** — not actively broken for real players today, because nothing currently
creates a challenge at all outside of a direct API call or a test. This changes the risk framing
from "fix a live regression" to "properly finish and re-enable a feature that was hidden mid-build"
— still the right work, lower immediate urgency than crd.1's own Senior Developer Review implied.
State this plainly in this story's own Dev Agent Record so nobody re-derives the wrong urgency
later.

**Finding 3 (real, not this story's job to fix, but essential context):**
`challenge-initiation.js` still has a manual "Their pool (defender)" number input
(`public/js/game/challenge-initiation.js:69-71`, submitted verbatim as `defender_pool` on every
`POST`, line 134) — the exact attacker-writable-defender-pool injury this whole epic exists to
remove, still live in the one client module that creates these documents, un-hidden or not. **Not
fixed in this story.** Flagged for whichever story re-enables the `challenge` tile (likely paired
with crd.3a/3b, since the fix is "stop asking the attacker for the defender's pool at all," which
only makes sense once the defender has a real resolution screen to use instead).

## Decisions already made (do not re-litigate)

- **Standalone new client module, not a refactor of `office-approvals.js`.** Settled at the epic
  level (Decision 3, `specs/epic-crd-contested-roll-defence.md`) — Angelus's explicit
  correctness-over-speed reversal of the original "one shared component" plan. Do not reopen it in
  this story. This story MAY borrow `office-approvals.js`'s row-grammar conventions (icon/type tag,
  compressed who-what, resolved-but-recent state rather than vanishing instantly, poll-only-while-
  tab-active) by reading and imitating the pattern — it shares zero imports or code with that file.
- **This story REPLACES `challenge-notification.js`'s modal-popup-on-poll behaviour outright**, per
  Finding 1 above — coexistence was considered and rejected: the modal is already broken for the
  document shape this whole epic exists to produce, so "leave it running alongside the new queue"
  means shipping a UI that shows `undefined` and a button that always fails. `challenge-
  initiation.js` (the attacker side) is untouched — it is a separate module with its own separate
  problem (Finding 3), not this story's file.
- **The queue's "tap to resolve" action routes to a genuine placeholder screen, not the real
  resolution UI.** crd.3a (server) and crd.3b (client resolution screen) do not exist yet — this
  story defines and implements the real routing *contract* (see AC5) with a minimal, honestly-
  labelled stub destination ("Resolution coming soon" or equivalent), so crd.3b's whole job later is
  to build the real screen behind an already-working door, not to also invent the door. Do not build
  any part of the interactive pool-builder (Mental/Social/Physical, Willpower, merit chips) in this
  story — that is crd.3b's scope, explicitly.
- **Multi-character defenders**: `character_ids` is a real array on player accounts
  (`public/js/app.js` ~1088/1634/2241/2283/2455). The existing app has no dedicated multi-character
  *switcher* UI for this kind of content — the one existing pattern that resolves "my character" from
  `character_ids` (`_moreGridCondition`, `app.js:1707-1721`) just takes the first match via `.find()`,
  which is NOT an acceptable pattern for a queue (a second character's pending challenge would be
  silently invisible). This story's queue query and row rendering must work across ALL of a player's
  `character_ids`, with an explicit per-row "which character" label — see AC2.
- **Nav placement: register in `MORE_APPS`'s existing `'player'` section**
  (`public/js/app.js:1673-1699`), alongside `downtime`/`ordeals`/`archive`, NOT a new `NAV_ITEMS`
  bottom-bar tile. Reuse the exact live-badge pattern the `downtime` entry already establishes
  (`badge: () => {...}`, `app.js:1680-1686`) rather than inventing a new badge mechanism — this
  story's badge callback returns true/false (or a count, matching whatever the real render call site
  expects — confirm by reading how `badge` is consumed before assuming its return shape) based on
  whether the player has any pending contested-roll requests targeting any of their characters.

## What this story is NOT

- NOT crd.3a (the server-side resolve endpoint) — no new server route is added by this story beyond
  what crd.1 already shipped (`GET /mine` already exists, already works, already has its index).
- NOT crd.3b (the client resolution screen) — the queue's row-tap destination is a placeholder,
  explicitly, per the Decisions above.
- NOT a fix to `challenge-initiation.js`'s attacker-side defender-pool input (Finding 3) — flagged,
  not touched.
- NOT re-enabling the `challenge` `MORE_APPS` tile / un-hiding issue #1015 — that is the attacker-
  initiation side, a separate concern from this story's defender-facing queue, and re-enabling it
  before Finding 3 is fixed would put the manual-defender-pool injury back in front of real players.
- NOT the crd.4 City Status/Blood Potency formula — irrelevant to this story regardless.
- NOT a change to `contested-rolls.js`'s `GET /mine` query itself — crd.1 already scoped and indexed
  it correctly; this story only consumes it.

## Acceptance Criteria

1. A new standalone client module (e.g. `public/js/player/pending-queue.js`) polls
   `GET /api/contested_roll_requests/mine` every 10 seconds, gated on the containing tab/panel
   actually being visible (mirror `office-approvals.js`'s own tab-active-gated poll pattern by
   inspection — do not poll when the player isn't looking at the queue).
2. The queue lists every pending item returned, each row showing: an icon/type tag, the challenger's
   name, the roll type (reuse `challenge-notification.js`'s existing `ROLL_LABELS` map or an
   equivalent), and — because a player's `character_ids` can contain more than one character — which
   of the player's OWN characters is the target, explicitly labelled on the row (not assumed,
   not omitted).
3. A resolved-but-recent row (accepted/declined via whatever this story's own resolve stub does, see
   AC5) shows a brief "resolved" state rather than instantly vanishing, then disappears on the next
   poll tick — mirroring `office-approvals.js`'s own resolved-row convention.
4. `public/js/game/challenge-notification.js`'s poll-and-popup-a-blocking-modal behaviour is removed
   from whatever currently invokes it (find the real call site — confirm via `grep` before assuming,
   don't guess it's only wired in one place), and this story's new module takes over as the sole
   consumer of `/api/contested_roll_requests/mine` polling. Confirm no other code still calls
   `startChallengePoller()`/`stopChallengePoller()` after this change, or update it if it does.
5. Tapping a queue row navigates to a real, working (but honestly labelled as incomplete) resolution
   destination carrying an explicit context id referencing the specific challenge (its `_id`) — not
   just "the defender's pending list in general." Define and implement this as a real routing
   contract (e.g. a `goTab('contested-resolve', { challengeId })`-shaped call, or this app's real
   equivalent pattern — confirm the actual `goTab()` signature before assuming it accepts a second
   argument, extend it if it doesn't) that crd.3b can build the real screen behind later without
   changing the queue's own code.
6. `GET /mine`'s existing server-side scoping (crd.1, `contested-rolls.js:56-79`) is exercised, not
   re-implemented — a real behavioural test confirms the queue module renders only items the API
   actually returns for the authenticated player, i.e. this story does not add its own client-side
   filtering that could silently diverge from the server's.
7. The `MORE_APPS` entry (`app.js`, `'player'` section) is added with a live badge reflecting whether
   the player has any pending contested-roll requests, following the `downtime` entry's established
   `badge: () => {...}` shape.
8. Real behavioural/unit test coverage for the module's polling gate, row rendering (including the
   multi-character label), the resolved-but-recent transition, and the routing contract. Follow this
   project's established client-testing convention — check whether `office-approvals.js` or
   `challenge-notification.js` have any existing test coverage to match the pattern against; if
   neither does, say so explicitly in Dev Notes rather than silently inventing a new testing
   approach for player-facing modules.

## Tasks / Subtasks

- [x] Task 1 — Confirm real call sites and signatures before writing anything (AC: 4, 5)
  - [x] Grep the whole client tree for every import of `challenge-notification.js`
        (`startChallengePoller`/`stopChallengePoller`) and confirm the full list of call sites.
  - [x] Read `goTab()`'s real current implementation (`app.js:458` onward) and confirm whether it
        already accepts a second argument/context payload, or needs extending.
  - [x] Confirm how `MORE_APPS`'s `badge` field is actually consumed by the renderer (read the
        render call site, not just the `downtime` entry's own usage) before writing this story's
        own badge callback.

- [x] Task 2 — New standalone queue module (AC: 1, 2, 3, 6, 8)
  - [x] `public/js/player/pending-queue.js` (or the real confirmed correct path per this project's
        `public/js/player/` vs `public/js/game/` convention — check which directory player-facing,
        non-ST modules actually live in before picking one).
  - [x] Tab-active-gated 10s poll against `GET /api/contested_roll_requests/mine`.
  - [x] Row rendering: icon/type tag, challenger name, roll type, per-row target-character label
        (multi-character-safe).
  - [x] Resolved-but-recent transient state.

- [x] Task 3 — Routing contract + placeholder destination (AC: 5)
  - [x] Implement the context-id-carrying navigation call.
  - [x] Build the minimal, honestly-labelled placeholder screen/tab it routes to (no pool-builder
        logic — that's crd.3b).

- [x] Task 4 — Retire the blocking-modal flow (AC: 4)
  - [x] Remove/replace every confirmed call site of `startChallengePoller()` from Task 1's findings.
  - [x] Decide (and document the decision) whether `challenge-notification.js` itself is deleted or
        left in the tree unused — check this project's convention for retiring a superseded module
        (grep for a precedent, e.g. how `player.html`/`player.js` were handled per gdx-10's own
        history) rather than guessing.

- [x] Task 5 — Nav registration (AC: 7)
  - [x] Add the `MORE_APPS` `'player'`-section entry with the live badge callback.

- [x] Task 6 — Tests (AC: 8)
  - [x] Cover polling gate, row rendering incl. multi-character label, resolved-but-recent
        transition, routing contract, and badge callback correctness.

## Dev Notes

### Current state of files this story touches (read in full before starting)

- **`public/js/game/challenge-notification.js`** (199 lines). Full current behaviour described in
  Finding 1 above. `ROLL_LABELS` (lines 16-21) is worth reusing directly (import it, don't
  reimplement) if this story doesn't delete the file outright.
- **`public/js/game/challenge-initiation.js`** (156 lines). Read-only precedent for this story —
  NOT touched. Its `_render()` (line 36) shows the real `.ch-overlay`/`.ch-modal` CSS class
  vocabulary already established for this feature area; this story's own new UI should stay
  visually consistent with it rather than inventing a new visual language, even though it shares no
  code.
- **`public/js/suite/office-approvals.js`** — read for row-grammar/poll-gating STYLE only, per the
  epic's own Decision 3. Do not import from it.
- **`server/routes/contested-rolls.js`**, post-crd.1: `GET /mine` is now at lines 56-79 (NOT the
  epic doc's stale `36-46` citation — line numbers shifted when crd.1 landed; always re-confirm
  against the live file, don't trust an epic doc's citation as current).
- **`public/js/app.js`**: `NAV_ITEMS` (395-419), `MORE_APPS` (1673-1699, the `'player'` section is
  1679-1687), `MORE_SECTIONS` (1701-1705), `goTab()` (458 onward, the orphaned `'challenge'` branch
  at 460-462), `character_ids` real usages (1088, 1634, 1714, 2241, 2283, 2455).

### Project Structure Notes

Confirm the real `public/js/player/` vs `public/js/game/` directory convention before creating the
new file (Task 2) — both directories exist and this story's two closest precedents
(`challenge-notification.js`, `challenge-initiation.js`) both live under `public/js/game/`, which
may mean this new module belongs there too rather than a new `public/js/player/` path assumed by
the epic doc's own suggestion. Follow whichever the real precedent says, not the epic doc's guess.

### References

- [Source: specs/epic-crd-contested-roll-defence.md#crd.2] — originating scope block.
- [Source: public/js/game/challenge-notification.js] — full file, the flow this story replaces.
- [Source: public/js/game/challenge-initiation.js] — full file, the paired attacker-side module,
  untouched, Finding 3.
- [Source: public/js/app.js#L393-419,458-462,1673-1721] — nav structure, orphaned challenge route,
  character_ids usage precedent.
- [Source: server/routes/contested-rolls.js#L56-79] — `GET /mine`, current post-crd.1 line numbers.
- [Source: specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md] — depth/format precedent and
  the real schema/route state this story builds on.

## Dev Agent Record

### Agent Model Used

claude-opus-5 (`bmad-dev-story` workflow, 2026-08-22).

### Implementation Plan

Red → green → refactor per task, in the Tasks order. One new test file
(`server/tests/crd-2-pending-queue.test.js`) written FIRST and confirmed red (module not found)
before a line of implementation existed, then driven green task by task. Task order held: Task 1
(confirm, no code) → Task 2 (module) → Task 3 (routing + placeholder) → Task 4 (retire) → Task 5
(nav) → Task 6 (tests, written up front and completed alongside). Browser verification after the
suite was green, then the changed-area regression.

### Debug Log References

**Task 1 — confirmations. All three came back different from what the story assumed, so none of
them were safe to guess at.**

1. **`startChallengePoller`/`stopChallengePoller` have exactly ONE call site between them, and one
   of the two is dead.** Full-repo grep: `public/js/app.js:55` (the import) and `public/js/app.js:1520`
   (`if (getRole() !== 'st') startChallengePoller();`). **`stopChallengePoller` was imported and
   never called anywhere** — the poller, once started, ran for the whole session with no way to
   stop it. Every other hit in the repo is a spec/doc reference or a comment, not a call.
2. **`goTab()` took ONE argument and had no context mechanism at all** (`app.js:458`,
   `function goTab(t)`). It is invoked from ~60 inline `onclick="goTab('x')"` strings in
   JS-generated markup plus `window.goTab(...)` from three modules. Extended to `goTab(t, ctx)`:
   purely additive, every existing single-argument call site is unaffected, and only a tab that
   declares it wants a context reads one. This is the story's "extend it if it doesn't" branch.
3. **`badge` is consumed in exactly ONE place, and it is a truthiness test, not a count.**
   `renderMoreGrid()`'s inner `appIcon()` (`app.js:1958`):
   `const hasBadge = typeof app.badge === 'function' && app.badge();` then renders a bare
   `<span class="nav-badge visible"></span>` dot. **A returned number would render identically to a
   boolean and its value would be discarded**, so this story's callback returns a plain boolean.
   Real finding while reading the second render site: **`renderDesktopSidebar()` (`app.js:2113`)
   renders NO badge at all** — it iterates the same `MORE_APPS` array but never touches `.badge`.
   The Downtime tile has therefore always been badge-less in desktop mode. Pre-existing, affects the
   existing entry identically, **not fixed here** (it changes a live surface for an existing tile,
   which is its own small story).

**Task 2 — the queue module.** Placed at **`public/js/game/pending-queue.js`**, not the epic doc's
suggested `public/js/player/`: **`public/js/player/` does not exist on disk at all**. The real
directory list is `admin/ auth/ components/ data/ downtime/ editor/ game/ print/ shared/ suite/
tabs/`, and both of this story's closest precedents already live in `game/`. Followed the real
precedent as the story's Project Structure Notes direct, not the epic doc's guess.

Poll gate mirrors the ST approval queue's own by inspection and for the same stated reason:
`goTab()` never unmounts a tab, it only toggles `.tab.active`, so `closest('.tab').classList
.contains('active')` is the only honest "is the player looking at this" signal available.

**Resolved-but-recent (AC3) is driven by DEPARTURE FROM THE PENDING SET, not by a local action.**
This story deliberately puts **no Accept/Decline button on a queue row**: accepting needs a resolved
pool, which is exactly what does not exist yet (crd.1's 409 guard), and declining belongs beside the
accept affordance on crd.3b's screen rather than as a lone orphan mutation here. So the transition is
computed as `prevRows − nextRows` on each successful poll: a row that was pending last tick and is
absent now gets one tick of a dimmed, untappable "Resolved" state, and vanishes on the next tick
because the following diff runs against a `state.rows` that no longer holds it. This is genuinely
reachable **today** (an ST `PUT /:id/void`, or a decline from another device) and it is the same
mechanism crd.3b's real resolution will trip without any change to this module.

Two failure-mode guards carried over by inspection from the ST queue's own review history, because
they are the same two mistakes available here: a failed fetch must never render as "nothing pending"
(a false all-clear), and a failed fetch must never be diffed as "everything resolved at once". Both
are pinned by tests.

**Task 3 — routing contract.** `goTab('contested-resolve', { challengeId })`, with the destination
mounted from `goTab`'s own tab-init block exactly like every other More-grid app. The placeholder
(`public/js/game/contested-resolve.js`) says on screen that pool-building is coming soon, names the
challenge it was opened for, and offers only a Back button. Its tests assert the ABSENCE of
crd.3b's surface (no `defender_aspect`/`defender_wp_spent`/`defender_merit_ids`, no `apiPut`/
`apiPost`, no call to crd.3a's future endpoint) so the scope line cannot be crossed quietly later.

**Task 4 — retirement: DELETED, not left dead.** The convention was checked against real history
rather than guessed, as the task directs. `git log --diff-filter=D` over `public/js/**` returns a
consistent, unbroken precedent: `player.js` (#1047, the gdx-adjacent case the story names),
`tickets-tab.js` (#1068), eight modules at once in #1135, `dice-modal.js` (#1010),
`equipment-data.js` (ECM-7 #874), `session-tracker.js`/`feeding-engine.js` (#836), the PP-7 batch.
**This project has never retired a superseded client module by leaving it in the tree.** Deleted via
`git rm`. Two stale comments that cited it by name were corrected in place rather than left to rot:
`public/js/suite/office-approvals.js` (its poll-pattern citation) and `public/css/suite.css:2357`
(the `.ch-*` provenance note). Neither is a behaviour change.

**Task 5 — nav.** `MORE_APPS` `'player'` section, between `ordeals` and `archive`, id
`contested-queue`, label "Challenges", shield icon (deliberately not the Combat tab's crossed
blades — this is the defence surface and the two sit in the same grid). Badge follows the
`downtime` entry's shape exactly: a pure read of a cache the boot path primed
(`refreshPendingQueueBadge()`), never a fetch from inside the callback, which matters because
`renderMoreGrid()` calls it on every single render. No `NAV_ITEMS` entry, per the story.

**A real pre-existing bug removed as a side effect, worth naming.** The retired module's
`_updateBadge()` wrote `#more-badge` directly with `textContent` + `style.display`, while
`checkMoreBadge()` owns the same element via `classList.toggle('visible', ...)`. The two fought:
whichever ran last won, and the poller's `style.display = 'none'` could suppress a badge
`checkMoreBadge` had legitimately turned on. There is now one owner of that element. The signal
itself is preserved rather than dropped — `checkMoreBadge()` ORs in `hasPendingChallenges()`, so a
pending challenge still lights the entry point players already have muscle memory for.

**Task 6 — testing convention, stated explicitly because AC8 asks for it.** Checked both precedents
before writing anything. **`challenge-notification.js` had no test coverage of any kind.**
`office-approvals.js` is covered by `oaq-3-approval-queue.test.js`, but its client half is
**source-text assertions only**, by its own stated rationale ("no browser harness in this repo").
Neither gives a behavioural pattern to match. Rather than silently invent one, this story followed
the ONE real behavioural precedent the repo already has for driving a browser module under vitest:
`dt-form-territory-fresh-fetch.test.js`, which `vi.mock()`s the browser-only imports and drives the
real module against a hand-rolled element stub. **No jsdom was added** — it is not in
`server/package.json` and adding it is a new dependency, which is a HALT condition, so the stub is
deliberately minimal (innerHTML, one delegated listener, a `[data-cq-body]` lookup, and
`closest('.tab')`). Source-text assertions are used only where the thing under test genuinely IS a
source fact: a file's existence, a registration in `app.js`, the absence of an inline style.

### Browser verification (what was actually seen, not what the code should produce)

Local frontend on `:8080` (`npx http-server`, port confirmed free first) and the local API via plain
`node server/index.js` — **not** `npm run dev`, whose `--watch` flag crash-loops here. Auth via the
documented localhost bypass (`tm_auth_token = 'local-test-token'`).

**Guardrail compliance — no live data was written.** The bypass user resolves to `character_ids: []`,
so `GET /mine` genuinely returns `[]` against live Atlas, which verified the empty state for real.
Every POPULATED state was produced by a **client-side `window.fetch` shim in the page** that returns
synthetic rows for that one URL. That is strictly safer than the fallback the guardrail permits: **no
`contested_roll_requests` document was created, accepted, declined or voided against live `tm_game`
at any point.** The only database writes anywhere in this story were the Supertest fixtures, against
`tm_game_test`, cleaned up in `afterAll`.

Screenshots saved to the session scratch dir (not shipped). What was actually observed:

- **Nav placement.** The Challenges tile renders in the **Player** section of the More grid, between
  Ordeals and Story, and again in the desktop sidebar's Player group. Section membership confirmed
  programmatically, not just by eye: `Player -> [downtime, ordeals, contested-queue, archive]`.
- **Empty state.** "No pending challenges." on the Parchment theme, correct italic
  `.stm-audit-empty` treatment, header and subtitle in the right type roles.
- **Populated queue, three rows, two different defending characters.** Each row shows the shield
  icon, the challenger's name, the roll-type LABEL (Territory Bid / Social Manoeuvre / Resistance
  Check, not the raw enum), the gold `DEFENDING AS <NAME>` label, and the timestamp. The two rows
  targeting different characters of the same player each carried their own correct label — the
  multi-character case rendering correctly in a real browser, not just in a test assertion.
- **Routing.** Clicking the THIRD row navigated to the placeholder carrying `...c93`, and the
  placeholder rendered that specific challenge's own challenger, contest type and defending
  character. The Back button returned to the queue.
- **Resolved-but-recent, on a real 10s poll tick.** Removing the middle challenge from the fed data
  and waiting for an actual tick produced a dimmed "Ludica / RESOLVED / DEFENDING AS LIVIA" row at
  the bottom with no timestamp and **no `data-cq-id`** (confirmed in the DOM, so it is genuinely
  untappable, not just visually dimmed). Two ticks later it was gone.
- **Poll gate, measured rather than asserted.** With a counter wrapped around `fetch`:
  **0 requests to `/mine` over 25 seconds while the tab was inactive**, and polling resumed
  immediately on returning to the tab. This is the AC1 behaviour observed live.
- **Failure state.** A simulated network failure with an empty queue rendered "Could not load your
  challenges. Retrying automatically…" and NOT the empty state.
- **Console.** Clean. The only errors logged across the whole session were the three deliberately
  simulated `[pending-queue] fetch failed: Error: simulated blip` lines. No uncaught exceptions, no
  404s, no module-resolution errors.

**Two REAL defects were found only in the browser and fixed** — neither was visible in the test
suite, which is the argument for having looked:

1. The placeholder's prose, its detail rows and its reference line collided with no vertical rhythm
   (the `.ch-*` detail classes were written for a modal body that supplies its own gap), and the
   Back button went full-bleed across the desktop pane. Fixed with a `.cq-resolve-body` column
   (`gap`, `max-width: 520px`).
2. `.derived-note` carries an 8px inline pad for its usual chip context; as a standalone reference
   line that rendered as a stray indent. Zeroed on `.cq-ref` only.

### Completion Notes List

**Finding 2 restated plainly, so nobody re-derives the wrong urgency later.** **Contested rolls are
currently DORMANT in production.** The only client code anywhere that creates one
(`challenge-initiation.js`) is reachable only through `goTab('challenge')`, and nothing in the app
calls that — its More-grid tile was hidden by #1015 and the wiring left orphaned. Nothing except a
direct API call or a test creates a challenge today. So this story is **not** fixing a live
regression players are hitting; it is properly finishing and re-arming a feature that was hidden
mid-build. The work is right, the urgency is lower than crd.1's own review implied, and **shipping
this story alone does not make the feature reachable** — the attacker side stays dark until
whichever story re-enables that tile (which must not happen before Finding 3 is fixed).

**Finding 3 is untouched, as scoped.** `challenge-initiation.js:69-71` still asks the ATTACKER for
"Their pool (defender)" and submits it verbatim as `defender_pool` (line 134). Confirmed still
present by a test in this story's own suite, so it cannot be quietly assumed fixed. It belongs with
whichever story re-enables the challenge tile, paired with crd.3a/3b.

**Decisions taken in this story, and why:**

- **No Accept/Decline button on a queue row.** See the Task 2 debug note. The queue lists and
  routes; the mutations belong beside the pool that justifies them, on crd.3b's screen.
- **`stopPendingQueue()` is exported with no app-code call site, deliberately and stated in the
  source.** It is the real lifecycle counterpart to `initPendingQueue` and clears the badge cache so
  it cannot survive an account switch. This app's only exit is `logout()`, which does a full
  `window.location.reload()` and takes all module state with it, so wiring it there would be
  ceremony that does nothing. Flagged in the module header rather than hidden.
- **An ST sees the Challenges tile.** The `'player'` MORE_APPS section is not actually role-gated
  (no `playerOnly` flag on `downtime`, `ordeals` or `archive` either), so this entry behaves exactly
  like its siblings. Left consistent rather than made a special case; its badge stays dark for an ST
  because the boot-time refresh is non-ST only, and opening it just shows the empty state.

**One consequence for another epic, not fixed here.** Deleting the retired module removes one of the
three consumers **Epic RLV's rlv.5 names by file**
(`specs/epic-rlv-roller-harmonisation.md:63` — "`contested-roll.js`, `combat-tab.js`,
`challenge-notification.js`"), and `specs/dice-roller-harmonisation-audit.md` discusses it in four
places. **Those two documents now cite a file that no longer exists.** rlv.5's job just got smaller
(two consumers, not three) rather than harder. Not edited here — they are another epic's documents,
and silently rewriting another epic's scope from inside this story is worse than flagging it.

**Not done, deliberately:** no resolve endpoint (crd.3a), no pool builder of any kind (crd.3b), no
change to `challenge-initiation.js`, no re-enabling of the `challenge` tile, no change to
`office-approvals.js` beyond correcting one stale comment, no change to `contested-rolls.js` at all,
no crd.4 formula work, no new dependency.

### Test Results

- **New suite** `server/tests/crd-2-pending-queue.test.js`: **50 passed / 0 failed**
  (AC1 ×5, AC2 ×7, AC3 ×4, AC5 ×7, AC6 ×4 — two of them real DB-backed Supertest requests against
  `tm_game_test`, AC7 ×9, AC4 ×5, design-system/British-English compliance ×6). Confirmed RED first:
  the initial run failed at import with `Cannot find module '/public/js/game/pending-queue.js'`, then
  went 41/50 with the module alone, then 50/50 once the app.js/index.html wiring and the deletion
  landed.
- **Changed-area regression, 16 suites** (the new one, crd.1's, and every suite that reads
  `public/js/app.js`, `public/index.html`, `public/css/suite.css`, `office-approvals`, or the
  `contested_roll_requests` collection): **16 files passed, 479 passed / 0 failed.**
  Suites: `crd-2-pending-queue`, `crd-1-contested-roll-request-shape`, `oaq-2-pending-status-actions`,
  `oaq-3-approval-queue`, `otc-2-office-actions-api`, `otc-3-office-nav-unconditional`,
  `issue-1143-office-actions-auth-safety`, `oxp-3-office-manoeuvre-rank`,
  `feature.691.hos-city-status-power`, `feature.687.ranking-score-models`,
  `issue-871-876-ecm-4-9-bundle`, `issue-879-defence-penalty-wirein`, `bl2-boot-priming`,
  `bl2-bloodline-warn-banner`, `bl4-bloodlines-admin-view`, `bl5-lineage-lock-client`.
- **Playwright E2E**, the two specs that actually assert on `MORE_APPS`/the More grid/`goTab`
  (`issue-1015-hide-challenge-rename-ordeals-xp.spec.js` — the spec that hid the challenge tile in
  the first place — and `issue-1135-deleted-tabs.spec.js`): **15 passed / 0 failed.** Run as a single
  invocation, never two concurrently.
- **No known-stale failure was encountered**, so none had to be discounted. The CLAUDE.md list was
  read first specifically so a pre-existing failure would not be mistaken for a regression; none of
  the listed suites is in this story's changed area, and nothing in the runs above failed.
- Parse-check (`node --check`) run on all four modified/new JS files, matching the repo's own
  `.githooks` staged-file check.

### File List

- `public/js/game/pending-queue.js` — **new** (Task 2)
- `public/js/game/contested-resolve.js` — **new** (Task 3)
- `public/js/game/challenge-notification.js` — **DELETED** (Task 4)
- `public/js/app.js` — modified (Tasks 3, 4, 5: imports, `goTab(t, ctx)` + dispatch,
  `TAB_SUBTITLES`, boot path, `MORE_APPS` entry, `checkMoreBadge`)
- `public/index.html` — modified (Task 3: the two tab panels)
- `public/css/suite.css` — modified (Tasks 2, 3: `.cq-*` rules, `.cq-row` grouped into the existing
  `.oaq-queue-row` rule, one stale comment corrected)
- `public/js/suite/office-approvals.js` — modified (Task 4: stale comment citing the deleted module;
  no behaviour change)
- `server/tests/crd-2-pending-queue.test.js` — **new** (Task 6)
- `specs/stories/sprint-status.yaml` — modified (workflow status tracking)
- `specs/stories/crd-2-player-facing-pending-queue.md` — this file (Dev Agent Record, File List,
  Change Log, Status, task checkboxes)

## Senior Developer Review

**Round: EXTERNAL Codex review (3-pass blinded adversarial protocol), 2026-08-22.** Findings
persisted unedited at `specs/stories/code-review/crd-2-codex-findings.md`. **No High findings this
time** (crd.1's round had two). Nothing below was found by this story's own dev pass.

### Independent verification before any patch was written

Codex's findings were **not** accepted on the reviewer's authority. The orchestrating session
re-derived each one against the real code first, and two of them changed shape as a result:

- **Every `checkMoreBadge()` call site in `public/js/app.js` was grepped directly.** There are exactly
  four: after visiting Feeding (~:550), at boot (~:1543), the definition itself, and one internal
  self-call from `_markSubViewed()`. **None** is reachable from `pending-queue.js`'s own poll tick.
  Codex's Pass 2 finding is real in both directions.
- **`renderDesktopSidebar()` was read directly** and confirmed never to reference `app.badge` for ANY
  `MORE_APPS` entry. Real, but **pre-existing and cross-cutting** - the existing Downtime tile has
  never had a visible desktop badge either - so this story's dev pass was right to decline it, and
  this review round declines it again for the same reason. Deferred, not patched.
- **The phone clipping was confirmed empirically**, by Codex's own temporary 390px Chromium probe
  (`row.scrollWidth > row.clientWidth`), and independently re-measured in this round before and after
  the fix (numbers below).
- **Codex's "the test record reports Mongo-skipped gates as fully passed" finding did NOT reproduce.**
  The crd.2 suite passes 50/50 with real MongoDB access, re-run independently. The `48 passed |
  2 skipped` Codex reported was its own sandbox unable to reach MongoDB (`EACCES` to port 27017), not
  a code defect. **No action taken; the story's original 50/50 record stands as written.**

### Patches applied (4), each prove-discriminated ALONE

Every code patch was reverted on its own, the specific new test confirmed to fail for the expected
reason, then restored and re-confirmed green. Never combined.

**Patch 1 - the shared More badge now recomputes after the queue's own poll.**
`initPendingQueue(rootEl, chars, onQueueChange)` takes an OPTIONAL callback, fired after any poll
that actually changes the pending set (membership by `_id`, in either direction). `app.js`'s `goTab`
injects `checkMoreBadge` at the mount site. **Injection rather than import, deliberately:** `app.js`
already imports FROM `pending-queue.js`, so reaching back the other way would make the dependency
circular; a callback keeps the arrow pointing one way and leaves the module testable with no `app.js`
in the picture. Gated on a real change rather than firing every tick, which respects the same
resource-conscious principle the poll gate itself exists for. A throwing callback is caught and
logged so a badge failure can never take the poll loop down. *Revert-alone result: 3 failed / 56
passed - exactly the three new badge tests, with the failed-poll tests still green.*

**Patch 2 - a failed poll no longer holds a stale "Resolved" row.** `_refetchAndRender()`'s failure
branch now clears `state.resolved`. The module's own "one tick" promise is specifically about the
tick immediately following the **successful** fetch that spotted the departure; a failing fetch is
not that tick, and the old code carried a dimmed, untappable row forward through any number of
consecutive failures. `state.rows` (the real pending work) is what must survive a blip, and it still
does - the existing "a failed poll does not fabricate resolutions" test is unchanged and still green.
*Revert-alone result: 1 failed / 58 passed - exactly the new stale-resolved-row test.*

**Patch 3 - phone-width row clipping.** A `@media (max-width: 599px)` block for `.cq-row` in
`public/css/suite.css`, using the same breakpoint `#bnav` and the Status ranking drawer already use.
The action cluster gets its own line under the challenger name rather than either being shrunk, so
the name keeps a real column and the metadata wraps instead of running off the edge. Tokens only, no
literal colour, no inline style. *Measured at 390px in real Chromium, via a temporary Playwright spec
that was deleted afterwards (matching how Codex cleaned up after its own probes):*

| | before | after |
|---|---|---|
| `row.scrollWidth` vs `clientWidth` | 450-477 vs 342 (overflowing) | 342 vs 342 |
| challenger-name column width | **0px (fully collapsed)** | 288px |
| action cluster right edge vs row right edge | 501 vs 366 (135px past) | 352 vs 366 |

*Revert-alone result: the probe failed on the first assertion with exactly Codex's numbers, and the
permanent source-level tripwire in the vitest suite failed too (1 failed / 58 passed).*

**Patch 4 - story metadata.** Frontmatter `branch:` corrected from
`ms/crd-1-data-lock-schema-hardening-wp-spike` to `ms/crd-2-player-facing-pending-queue`, the branch
this story was actually implemented and reviewed on.

### Findings deferred, each named against its Codex finding

All four are logged in `specs/deferred-work.md` under this story's own block, with fuller reasoning.

- **[Pass 2] "Desktop players have no visible Challenges badge"** - pre-existing and cross-cutting,
  identical for the existing Downtime tile. Patching it here would change live behaviour for a tile
  outside this story's scope. Wants its own story covering every badged `MORE_APPS` entry at once.
- **[Pass 1] "Challenges arriving after boot never refresh the inactive queue badge"** - **not a bug,
  a deliberate trade-off.** It is the direct consequence of Epic CRD's own resource-conscious
  principle, settled during this epic's scoping: do not poll while nobody is looking at the surface.
  Logged so it is a chosen boundary rather than an unnoticed gap. Explicitly **not** to be worked
  around with a global always-on poll; if a live signal is ever wanted for an unopened tab, the right
  shape is this app's existing WebSocket broadcast channel.
- **[Pass 1] "Boot badge refresh can overwrite a newer queue fetch"** - real, but a narrow race with
  low real-world reachability (the player must complete a tab-open round trip before the
  fire-and-forget boot request settles). The fix extends `_fetchGen` across the badge path, which is
  the same generation discipline crd.3b will be editing; fold it in there rather than a one-liner now.
- **[Pass 1] "Source-text assertions overstate routing and CSS coverage"** - the three named
  assertions genuinely are weaker than their labels. **Not rewritten**, because the honest fix is a
  real DOM harness and this repo has no jsdom (a new dependency is a HALT condition). Noted for
  whoever next touches the file; the newly-added phone-breakpoint test carries an explicit comment
  saying it is a regression tripwire, not proof.

**Reviewed and non-actionable** (recorded so nobody re-derives them as open work): the two Pass-3b
evidence-gap findings - the unreproducible red-first chronology, and the unprovable absolute
"zero live writes anywhere" attestation - are about the completeness of the historical record, not
about defects in the current code. No retroactive proof was attempted; the narrower claim (this
feature's browser session created no `contested_roll_requests` document) is supported by the code
itself, since the queue imports only `apiGet` and the placeholder has no write API. Codex's
[Pass 3b] "claimed Playwright set does not directly cover the new route or badge" is accurate as a
scoping observation and is answered by the regression numbers below rather than by adding E2E
coverage crd.3b will need to rewrite anyway.

**Not done, deliberately:** no part of crd.3a/3b's resolution screen, no change to
`renderDesktopSidebar()`, no global poll, no rewrite of the three source-text tests, no edit to
`specs/stories/code-review/crd-2-codex-findings.md` (kept unedited as the review record).

### Review-round test results

- **New suite** `server/tests/crd-2-pending-queue.test.js`: **59 passed / 0 failed** (50 pre-patch +
  9 new: 6 for Patch 1, 2 for Patch 2, 1 source-level tripwire for Patch 3). Confirmed RED first;
  5 of the 9 failed on the pre-patch code and the other 4 are additional assertions around them. The
  two Mongo-backed AC6 tests **ran** (not skipped) in this environment.
- **Changed-area regression, the same 16 suites the dev pass used**: **16 files passed, 488 passed /
  0 failed** - exactly +9 over the 479 pre-patch baseline, no new failures.
- **Playwright**, the two specs that touch `MORE_APPS`/the More grid
  (`issue-1015-hide-challenge-rename-ordeals-xp.spec.js`, `issue-1135-deleted-tabs.spec.js`):
  **15 passed / 0 failed**, single invocation. Unchanged from baseline.
- **Temporary 390px probe** written, measured, and deleted. `tests/` contains no leftover `.tmp-*`
  spec.
- Parse-check (`node --check`) on both modified JS files.
- **NOT committed, NOT pushed, NOT merged.** Working tree left uncommitted.

### Review-round file list

- `public/js/game/pending-queue.js` - modified (Patches 1, 2)
- `public/js/app.js` - modified (Patch 1: the `initPendingQueue` call site in `goTab`)
- `public/css/suite.css` - modified (Patch 3: the <=599px `.cq-row` block)
- `server/tests/crd-2-pending-queue.test.js` - modified (9 new tests)
- `specs/stories/crd-2-player-facing-pending-queue.md` - this file (frontmatter `branch` + `status`,
  this section, Change Log)
- `specs/deferred-work.md` - modified (four deferred findings)
- `specs/stories/sprint-status.yaml` - modified (status + narrative)

## Change Log

| Date | Change |
|------|--------|
| 2026-08-22 | **CODE REVIEW CLOSED, `review` -> `done`.** External Codex review (3-pass blinded adversarial protocol; findings persisted unedited at `specs/stories/code-review/crd-2-codex-findings.md`), **no High findings**. Every finding was independently re-verified against the real code before any patch was written, and two changed shape as a result: the `checkMoreBadge()` call-site grep confirmed none of its four call sites is reachable from the queue's own poll tick, and Codex's "the test record reports Mongo-skipped gates as fully passed" finding did NOT reproduce (the suite really is 50/50 with MongoDB reachable; Codex's 48/50 was its own sandbox `EACCES` to port 27017, so the original record stands). FOUR PATCHES, each prove-discriminated ALONE: (1) `initPendingQueue` takes an optional `onQueueChange` callback fired after any poll that changes the pending set, injected by `goTab` as `checkMoreBadge` - injection not import, because `app.js` already imports FROM this module and the reverse would be circular; without it the shared `#more-badge` went stale in BOTH directions while the tab was open (revert-alone: 3 failed/56 passed). (2) A failed poll now clears `state.resolved` instead of holding a dimmed "Resolved" row through any number of consecutive failures - the "one tick" promise is about the tick after a SUCCESSFUL fetch, and `state.rows` is still what survives a blip (revert-alone: 1 failed/58 passed). (3) A `@media (max-width: 599px)` block for `.cq-row` in `suite.css`, the same breakpoint `#bnav` already uses: at 390px the row was overflowing 450-477px into a 342px box with the challenger-name column collapsed to **0px** and the action cluster 135px past the row's right edge; after, 342/342 with a 288px name column. Measured in real Chromium via a temporary Playwright spec, deleted afterwards. (4) Frontmatter `branch` corrected to `ms/crd-2-player-facing-pending-queue`. FOUR FINDINGS DEFERRED to `specs/deferred-work.md`, each named against its Codex finding: the desktop-sidebar badge gap (pre-existing and cross-cutting - `renderDesktopSidebar()` never evaluates `app.badge` for ANY `MORE_APPS` entry, so the Downtime tile has always been badge-less on desktop too; wants its own story, not a one-off here); the boot-only badge refresh window (**a deliberate trade-off, not a bug** - it falls straight out of this epic's own "don't poll unless the tab is visible" principle, and must NOT be worked around with a global always-on poll; WebSocket is the right shape if a live signal is ever wanted); the boot-badge-vs-tab-open race (real but narrow, and its fix extends the same `_fetchGen` discipline crd.3b will be editing); and the three source-text-only test assertions (genuinely weaker than their labels, but the honest fix needs a DOM harness and adding jsdom is a HALT condition). Codex's two Pass-3b evidence-gap findings (unreproducible red-first chronology, unprovable absolute zero-live-write claim) reviewed and recorded as non-actionable - they are about the historical record's completeness, not current-code defects. Suite 50 -> 59 passed/0 failed; changed-area regression 16 suites 488 passed/0 failed (exactly +9 over the 479 baseline, no new failures); Playwright pair 15/15 unchanged. NOT committed, NOT pushed, NOT merged. |
| 2026-08-22 | `bmad-dev-story`: Tasks 1-6 implemented. New standalone `public/js/game/pending-queue.js` (NOT `public/js/player/` — that directory does not exist on disk; followed the real `game/` precedent) with a tab-active-gated 10s poll, multi-character-safe per-row "Defending as" labels, and a resolved-but-recent state driven by departure from the pending set rather than a local mutation (the queue deliberately carries no Accept/Decline button — those belong beside crd.3b's pool). `public/js/game/contested-resolve.js` added as an honestly-labelled placeholder behind a real routing contract: `goTab()` extended additively to `goTab(t, ctx)` and dispatches `contested-resolve` with `{ challengeId }`. `challenge-notification.js` DELETED, matching this project's unbroken precedent for retiring superseded client modules (checked against `git log --diff-filter=D`, not guessed); its single live call site (`app.js:1520`) replaced by a boot-time badge refresh, and its never-called `stopChallengePoller` import removed with it. `MORE_APPS` 'player'-section entry with a live badge following the `downtime` entry's cache-read shape; `#more-badge` keeps reflecting pending challenges via `checkMoreBadge`, which also removes a real pre-existing clash between the old poller's inline `style.display` writes and `checkMoreBadge`'s class toggle. Three Task-1 confirmations all came back different from what the story assumed (one call site not several, `goTab` had no context arg at all, `badge` is truth-tested by exactly one renderer and ignored by the desktop sidebar entirely). New suite 50/50; changed-area regression 16 suites, 479/479; two nav-related Playwright specs 15/15. Browser-verified end to end with no live-data writes (populated states via a client-side fetch shim); two real spacing defects found only in the browser and fixed. Status `ready-for-dev` → `review`. NOT committed, NOT pushed, NOT merged. |
| 2026-08-22 | Story created (`bmad-create-story`), `ready-for-dev`. Investigation found two things the epic doc didn't anticipate: `challenge-notification.js`'s existing modal is already broken by crd.1's own schema change (Finding 1), and contested rolls currently have no reachable creation path in any live UI at all (Finding 2) — softens this story's urgency framing without changing its scope. |
