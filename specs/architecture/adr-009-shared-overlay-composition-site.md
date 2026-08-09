# ADR-009 — One overlay composition site, shared by both entry points

**Status:** accepted and **implemented** — D3 taken (Peter, 2026-08-02). All four steps landed. D3's behavioural change awaits browser verification.
**Date:** 2026-08-02
**Decision owner:** Peter
**Relates to:** ADR-004 (ST mods overlay), ADR-006 (defence penalty read path), #1064 (admin merge)
**Blocks:** the ST Mods panel surface in `index.html`

---

## Why this exists

The ST Mods panel is the next surface to move into `index.html`. It cannot, because of how it is mounted:

```js
initStModsPanel(rootEl, character, onMutate)
```

`admin.js` passes an `onMutate` that calls `renderSheetWithOverlay()` — and that function **is** the ADR-004/ADR-006 composition site. `app.js` has no equivalent, so mounting the panel there means either reimplementing the sequence (a second composition path, which CLAUDE.md says requires this document) or leaving the surface behind.

Investigating which of those to propose turned up something that changes the question.

---

## The finding: there are already two paths, and both claim to be the only one

`admin.js:157` and `app.js:255` each define `refreshCharacterOverlay(charId)`. They are near-duplicates, and **both carry the same comment**:

> `so both paths route through the same composition sequence (single composition site, ADR-004 §D1/§D8)`

Two functions, in two files, each documenting itself as the single site. The rule was not broken by anyone; it was satisfied twice, independently, and the copies drifted.

### They do not agree

| step | `admin.js` | `app.js` |
|---|---|---|
| load tracker state | `loadTrackerState(c)` | **absent** |
| splice current values | `spliceCurrent(c, tracker, …)` | **absent** |
| materialise armoured defence | yes | yes |
| apply mods | `loadStMods` + `applyStMods` | `applyOverlayToAll` |
| render | `renderSheet(c)` | `suiteRenderSheet()` and/or `editorRenderSheet(c)`, role-gated |

`spliceCurrent` and `loadTrackerState` appear **nowhere** in `app.js`, `suite/sheet.js` or `editor/sheet.js` — only in `admin.js`.

**Consequence today:** an ST viewing a character sheet in `admin.html` sees current vitae, willpower and health spliced from `tracker_state`. The same ST viewing the same character in `index.html` does not. That is a live parity gap, not a merge risk introduced by this work.

It is probably deliberate in origin — `tracker_state` is ST-auth-only at the API level, so the player app could not splice even if it wanted to. But the gate belongs on *role*, not on *which file the function happens to live in*.

---

## Decisions

### D1 — One module owns the sequence

Create `public/js/data/sheet-composition.js`. It exports the composition sequence and nothing else. Both `admin.js` and `app.js` import it. Neither retains a local copy.

This is an *extraction*, not a rewrite: the sequence moves verbatim from `admin.js`, which is the fuller of the two.

### D2 — What varies is injected, never branched on

The two entry points genuinely differ in two ways, and only two:

- **where characters live** — `chars` (admin) vs `suiteState.chars` (app)
- **what "render" means** — one editor sheet (admin) vs suite sheet and/or editor sheet, role-gated (app)

Both are passed in. The module must contain **no** `getRole()` call and no knowledge of which document it is running in. A conditional inside the shared module would recreate the divergence it exists to remove, just in one file instead of two.

### D3 — The tracker splice becomes conditional on capability, not on caller

The splice runs when a tracker loader is supplied, and the caller supplies one only when the session may read `tracker_state`. `app.js` supplies it for STs and not for players.

**This closes the parity gap**: an ST in `index.html` will see spliced current values, matching `admin.html` today. That is a deliberate behavioural change and the only one in this ADR. It must be verified in-browser rather than asserted, because it changes numbers a Storyteller reads at the table.

If Peter prefers to keep the gap and land the extraction alone, D3 can be deferred without blocking D1, D2, D4 or D5 — the loader simply stays absent in `app.js`. **Recommendation: take D3.** The gap is invisible until someone compares two screens and finds different vitae for one character, which is the expensive way to discover it.

### D4 — Migration order

1. Extract into `sheet-composition.js`; point `admin.js` at it. **No behavioural change** — `admin.js` keeps its exact sequence. Verifiable by diffing what the function does before and after.
2. Point `app.js`'s `refreshCharacterOverlay` at the same module, supplying its two-sheet renderer. Deletes the drifted copy.
3. Apply D3 (tracker loader for STs in `app.js`), if taken.
4. Only then mount the ST Mods panel in `index.html`.

Steps 1 and 2 are independently shippable and each ends with something openable.

### D5 — A ratchet, so this cannot recur

A test asserting that the composition sequence — `stripOverlay` / `materialiseDerivedDefence` / `applyStMods` in that order, or `applyOverlayToAll` — appears in `sheet-composition.js` and in no other file outside `data/st-mods.js`.

The rule "one composition site" was already documented and was still satisfied twice. A comment cannot enforce it; a failing test can. Following the established convention, the allowed set is a **named set that may shrink and never grow**, not a count.

### D6 — Scope limit

This ADR does not change `applyStMods`, `stripOverlay`, `applyOverlayToAll` or anything in `data/st-mods.js`. It does not move composition server-side. It does not touch the write-direction invariant (the overlay never mutates `tracker_state`). ADR-004's decisions stand unchanged; this only fixes where the sequence is *called from*.

---

## Consequences

**Good.** The ST Mods panel unblocks. The parity gap closes. A drift that already happened once cannot happen again silently. `admin.js` gets smaller, which the merge wants anyway.

**Cost.** Two files touched that are on the frozen write path's neighbourhood. The sequence is order-dependent — ADR-006 D3/D4 fixed a bug caused by getting `materialiseDerivedDefence` and `applyStMods` the wrong way round — so the extraction must preserve order exactly, and step 1 exists specifically so that can be verified with no other variable moving.

**Risk if wrong.** Silently incorrect derived stats on character sheets: defence, health, willpower, vitae. Not a crash. This is why D4 sequences a no-behaviour-change step first and why D3 requires in-browser verification.

---

## What this does not decide

Whether `refreshCharacterOverlay`'s **two** remaining callers per entry point (the WebSocket `onStModUpdate` handler and `installStModPopover`'s `onMutate`) should also converge. They already call the same local function in each file, so D1 fixes them for free — but if a third caller appears with different needs, that is a new decision, not an extension of this one.
