# Epic STM: ST Mods (Storyteller Numeric Adjustments)

## Motivation

Storytellers need to apply arbitrary temporary numeric adjustments to controllable values on a character — attribute dots, skill dots, merit dots, current damage, current willpower, current vitae, blood pool, **and derived stats** (Defence, Health max, Speed, Initiative, etc.) — without editing the character record itself.

Concrete pressures driving this:

- **Scene effects.** A ritual grants +2 Stamina for one scene. A discipline forces Defence to 1 until next turn. A bane temporarily caps BP. Today the ST has to either edit the character (wrong: pollutes the canonical record and is hard to undo) or track it on paper (wrong: invisible to the player's sheet).
- **Quick corrections mid-session.** A wound box was missed. A spec wasn't applied to a roll. The ST wants to nudge a number without opening a full edit flow.
- **Auditability.** Whatever the ST changes, *some* record must exist of who changed what and why — both to debug "why is my Defence 2 today?" and to protect the ST against accusations of arbitrary fiat.
- **Player trust.** Players need a visual signal that a number is adjusted, with the ability to see the breakdown on demand. They should not be silently lied to about their own sheet.

The feature is additive — it does not touch the canonical `tm_suite.characters` record. Mods are a separate overlay that the render pipeline composes on top of the base character at display time.

## Goals

- ST can attach a signed integer delta to any controllable numeric stat on any character.
- The player's sheet shows the modded final value, marked as adjusted, with a click-to-expand breakdown.
- Mods survive page reloads, are visible to all STs, and are toggleable on/off at any time (Rev 4); permanently deletable when no longer wanted.
- A global kill-switch and per-character override can disable the overlay without destroying the mods.
- Every mod lifecycle event (create / activate / deactivate / delete) is logged immutably in a separate audit collection.

## Non-Goals

- **No auto-expiry.** Mods do not expire at session end, DT cycle end, or anywhere else. STs revoke manually. (If demand emerges later, the lifecycle field can be added.)
- **No priority/override semantics.** Mods are flat signed deltas only. No "set Stamina to 3 regardless." If an ST wants Stamina to be 3 when the base is 4, they apply −1.
- **No per-mod-creator ownership.** Any authenticated ST can revoke any mod. (A `lock` flag was considered and rejected — see Design Decisions.)
- **No reason-text rendering in the breakdown by default.** Reason is required for audit, but each mod has a per-mod `show_reason_to_player` toggle (default off).
- **No bounds checking.** Mods can take a stat to any value — negative, above normal max, anything. The ST has full authority; the render must not crash on out-of-range values.

> **REVERSED in Rev 4 (2026-05-20).** The original Non-Goal below — "revoking a mod hard-deletes the mod document, only the creation event survives" — was reversed when Peter pivoted from ephemeral mods to a persistent toggleable-mod library. The reversal is on the *list-cleanliness* axis only; the *accountability* axis is preserved. Canonical wording: ADR-004 §D15/D16. See "Mod lifecycle and audit (Rev 4)" under Design Decisions.
>
> ~~**No revoke history.** Revoking a mod hard-deletes the mod document. The original creation event remains in the audit log.~~ Now: revoke = toggle off (mod persists, `active: false`); permanent-delete removes the *definition* but the `st_mod_audit` ledger is immutable and survives, including a `deleted` tombstone.

## Design Decisions

### Mods are a separate collection, not embedded on the character

Mods live in a new `tm_suite.st_mods` collection. One document per mod (active or dormant):

```js
{
  _id: ObjectId,
  character_id: ObjectId,     // references characters._id
  stat_path: 'attributes.stamina.dots',   // dotted path into the rendered character shape
  delta: 1,                                // signed integer; multiple ACTIVE mods on same path sum
  reason: 'Vigour of the Lion ritual',     // required, free text
  show_reason_to_player: false,            // default false; if true, breakdown popover shows reason text
  active: true,                            // Rev 4 (D15): toggle off = false (dormant, retained); overlay applies only when active !== false
  created_by: { discord_id, discord_name },
  created_at: ISODate
}
```

Rationale: keeping mods off the character document means the canonical record stays clean, mods can be queried and bulk-revoked without touching characters, and the per-character override toggle (see below) lives on the character but doesn't entangle mod data with it. No schema migration on the `characters` collection.

### Multiple mods per stat, summed

Multiple mods on the same `stat_path` for the same character are allowed and additive. Order does not matter. No priority field. No override semantics.

### Derived stats are first-class mod targets

CLAUDE.md states derived stats (Defence, Health max, Speed, Vitae max, Willpower max) are never stored — calculated at render time. This feature is the first sanctioned exception path: the overlay applies to the *output* of derivation, not the inputs.

Concretely: the render pipeline calls existing derivation functions on the base character, then the overlay walks `st_mods` for that character and applies deltas to whichever paths it finds — including derived paths. A mod on `attributes.stamina.dots` flows through derivation naturally (Stamina change → Health max change). A mod on `derived.health_max` applies directly to the post-derivation value, independent of any Stamina mod. Both can coexist; both sum if both target the same final path.

The list of mod-target paths is open — any path the ST picks in the UI is valid. The architect should expect a per-stat-category dropdown that enumerates legal paths (attributes.*, skills.*, merits.*, current state, derived.*) but the storage shape doesn't constrain it.

### Render-time overlay, single composition function

A new helper `applyStMods(character, mods, overlayEnabled)` runs after all existing derivations on the read path. If `overlayEnabled === false` (global kill-switch off, or per-character override on), it returns the character unmodified. Otherwise it walks `mods`, sums deltas by `stat_path`, and writes the modded final values back onto the character object along with a parallel `_st_mod_overlay` shape:

```js
character._st_mod_overlay = {
  'attributes.stamina.dots': { base: 3, delta: 1, final: 4, mods: [{...}, {...}] }
}
```

The render layer reads `_st_mod_overlay` to draw the marker and populate the click-to-expand popover. No core derivation function is modified.

### Global kill-switch + per-character override

Two settings layers:

1. **Global.** A boolean in the existing app settings: `st_mods_enabled` (default true). When false, the overlay is skipped for every character. Mods remain in the database.
2. **Per-character.** A new field on the character document: `st_mods_suppressed: boolean` (default false). When true, the overlay is skipped for that character only. Lets an ST nuke mods on one test character without touching the rest of the table.

The overlay function takes `overlayEnabled = globalEnabled && !character.st_mods_suppressed`.

Individual mod revocation is not part of the settings — it's a hard delete of the mod document.

### Player UX: subtle marker + click-to-expand

Modded stats render with a small visual marker (gold dot, matching `--gold2: #E0C47A`). Clicking the marker opens a popover:

```
Stamina
  Base: 3
  ST adjustment: +1
  Final: 4
  Reason: Vigour of the Lion ritual    ← only shown if show_reason_to_player === true
```

If `show_reason_to_player` is false, the reason line is omitted but the delta and final are still shown — the player always knows a number was adjusted and by how much, just not necessarily why.

When multiple mods stack on the same stat, the popover shows them as a list:

```
Stamina
  Base: 3
  ST adjustment: +1 (Vigour of the Lion ritual)
  ST adjustment: -1
  Final: 3
```

### Audit log is append-only, separate from the mod docs

**v1 shape (superseded):** each mod creation wrote one row to `tm_suite.st_mod_audit`. Revoking hard-deleted the `st_mods` doc; the single creation row was the only survivor.

**Rev 4 shape (canonical — ADR-004 §D16):** `st_mod_audit` is an immutable **lifecycle event stream**. Every state change appends one row:

```js
{
  _id: ObjectId,
  st_mod_id: ObjectId,        // the mod this event concerns (survives even after the mod doc is deleted)
  character_id: ObjectId,
  event: 'created',           // 'created' | 'activated' | 'deactivated' | 'deleted'
  stat_path: 'attributes.stamina.dots',
  delta: 1,
  reason: 'Vigour of the Lion ritual',  // optional on toggle events; inherits creation reason (D17)
  by: { discord_id, discord_name },     // server-stamped, mandatory on every event (D17)
  at: ISODate                           // server-stamped, mandatory on every event
}
```

Lifecycle:
- **Create** → mod doc written to `st_mods` with `active: true`; `created` event appended.
- **Toggle off** (revoke) → mod doc `active: false`; `deactivated` event appended. Mod is retained (dormant).
- **Toggle on** (reactivate) → mod doc `active: true`; `activated` event appended.
- **Permanent delete** → `deleted` tombstone event appended **before** the mod doc is removed from `st_mods` (D16 ordering invariant — the tombstone must never be lost to a mid-delete failure).

**The ledger is never deleted, including on permanent-delete.** This is the reversal of the original Non-Goal, on the list-cleanliness axis only: the `st_mods` working set stays clean (dormant mods muted, deleted mods gone), while the accountability guarantee is preserved verbatim — *you can always answer "why was X's Defence 2 last session?" from the ledger, even after the mod is toggled off or deleted.*

The audit collection is ST-only on the API; players never see it.

### UI surface: dedicated "ST Mods" panel per character

In the admin character view, a new sidebar entry / panel labelled **ST Mods** lists all active mods for the character:

```
ST Mods (3 active)
─────────────────────────────────────
+ New mod
─────────────────────────────────────
Stamina (attributes.stamina.dots)         +1   [revoke]
  Vigour of the Lion ritual
  by Thoth · 2026-05-17 14:32

Defence (derived.defence)                  -2   [revoke]
  Stunned this round
  by Khepri · 2026-05-17 14:35
  [shown to player]

Damage (current.damage)                    +1   [revoke]
  Missed wound box
  by Thoth · 2026-05-17 14:28
```

Create form fields: stat-path dropdown (categorised), signed delta input, reason (required), "show reason to player" toggle (default off). Save persists to `st_mods` and writes the `st_mod_audit` row in one API call.

Per-character override (`st_mods_suppressed`) lives at the top of the same panel as a single switch.

The mod is not inline-editable on the sheet itself — sheet-side affordances would couple the editor too tightly and complicate permissioning. Mid-scene creation is fast enough from the dedicated panel via a hotkey/quick-open if needed (not in scope for v1).

### Permissions: any authenticated ST

Any user passing the existing Discord OAuth ST-auth gate can create or revoke any mod, toggle any character's override, or flip the global kill-switch. No new role. `created_by` in the audit captures attribution.

A per-mod `lock` flag (only creator/admin can revoke) was considered and rejected — there is no admin role distinct from ST, and the audit log is sufficient accountability.

### API endpoints

New routes under `/api/st_mods` (ST-auth required):

- `GET /api/st_mods?character_id=...` — list active mods for a character
- `POST /api/st_mods` — create mod, also writes audit row
- `DELETE /api/st_mods/:id` — revoke (hard delete from `st_mods`, audit untouched)
- `GET /api/st_mod_audit?character_id=...` — list audit history (active + revoked creations)
- `PATCH /api/characters/:id/st_mods_suppressed` — toggle per-character override
- Global `st_mods_enabled` flag piggybacks on whatever app-settings mechanism already exists, or introduces one if not.

### Backwards compatibility

- No change to `characters` schema except the optional `st_mods_suppressed` boolean (absent === false).
- No change to existing derivation functions.
- No change to the player-facing roll calculator unless it reads from the API and benefits from the overlay being pre-applied server-side. (TBD with architect — see Open Questions.)

## Architectural Resolutions

All four originally-open questions are resolved in **[ADR-004](architecture/adr-004-st-mods-overlay.md)** (approved, Rev 1, 2026-05-17):

1. **Overlay composition site → client-side, post-derivation** (D1). `applyStMods(c, mods, overlayEnabled)` runs in `public/js/data/st-mods.js` (new), called once per character immediately before each `renderSheet(c)` invocation in `admin.js:524` and `player.js:359`. Kill-switch is centrally enforced via the `overlayEnabled` argument. Roll calculator is explicitly out of scope for v1.
2. **Settings store → new minimal `app_settings` collection** (D2). Single document `_id: 'global'`. `GET/PATCH /api/settings` (ST-auth, whitelisted keys). Client fetches once at boot; no live broadcast — reload-driven, acceptable for a debug lever.
3. **Stat-path enumeration → hybrid** (D3). Static `public/js/data/st-mod-targets.js` covers Attributes, Skills, Current State, Derived. Merits and Disciplines are character-specific and built at panel-open time from `c.merits` / `c.disciplines`. STM-2 must add a path-resolve sanity check; STM-5 must verify `current.*` field names against `accessors.js` before shipping the dropdown.
4. **Stacking display → list each mod, no collapse in v1** (D4). Popover renders one row per mod (signed delta, optional reason, creator, timestamp) plus a final summed row, matching the PRD example below. Collapse-at-N>5 deferred until actually painful.

Implementer watch-items called out in ADR-004 §"Concerns": CLAUDE.md amendment is load-bearing (STM-1/STM-2 must add the "derived stats — sanctioned exception" paragraph with a link to ADR-004); `stat_path` validation must happen at write time in `POST /api/st_mods` (whitelist from D3 + regex `^(merits|disciplines)\.[0-9]+\.dots$` for character-derived paths); listener-routing for marker clicks (STM-4) and create-form handlers (STM-5) must be delegated, not ad-hoc per render; the `_st_mod_overlay` field must be stripped on save in `admin.js:586` per the existing `_`-prefix convention.

## Stories

Sized for ~1-day implementations. Order matters; later stories assume earlier ones are merged.

### STM-1: Backend — `st_mods` collection, CRUD API, audit log

Create `st_mods` and `st_mod_audit` collections. Add Express routes (`GET`, `POST`, `DELETE` for `st_mods`; `GET` for `st_mod_audit`). ST-auth gate on all routes. Validate `stat_path` is a string, `delta` is an integer, `reason` is non-empty. Write audit row inside the create handler in the same request. No render integration yet.

**Acceptance:** Postman/curl can create, list, and revoke mods for a known character. Audit rows accumulate and are never deleted on revoke. Unauthenticated requests return 401.

### STM-2: Render-time overlay composition

Implement `applyStMods(character, mods, overlayEnabled)` in a new module `public/js/data/st-mods.js` (per ADR-004 D1). Call it on the client immediately after the existing derivation pass and before `renderSheet(c)` at both call sites (`admin.js:524`, `player.js:359`). Produces `character._st_mod_overlay` shape. No UI yet — verified by inspecting render output. Also amend CLAUDE.md under "Derived stats are never stored" to name the overlay as the sanctioned exception with a link to ADR-004 (load-bearing per ADR-004 §"Concerns" item 1).

**Acceptance:**
- With mods in the DB and overlay enabled, character object passed to the sheet renderer shows modded final values **after** the existing derivation pass on the client, and a populated `_st_mod_overlay`.
- With overlay disabled (kill-switch or per-character), values match base derivation exactly and `_st_mod_overlay` is absent.
- **Path-resolve sanity check** (per ADR-004 D3): every path in `public/js/data/st-mod-targets.js` resolves on a representative sample character without throwing. Failing paths block the merge — they signal a static-map vs `accessors.js` divergence that would silently misroute mods.
- CLAUDE.md contains the amended paragraph linking to ADR-004.

### STM-3: Global kill-switch and per-character override

Introduce the `tm_suite.app_settings` collection (per ADR-004 D2) with a single document `_id: 'global'`, schema `{ _id, st_mods_enabled, updated_at, updated_by }`. Add ST-auth-gated `GET /api/settings` (creates with defaults if absent) and `PATCH /api/settings` (whitelisted keys; v1 whitelist = `st_mods_enabled` only). Client fetches `globalSettings` once at app boot (admin and player) and refetches on admin settings-panel save; no live broadcast.

Add `st_mods_suppressed` boolean to character schema and a `PATCH /api/characters/:id/st_mods_suppressed` endpoint. Overlay reads `globalSettings.st_mods_enabled && !character.st_mods_suppressed` and skips composition when false. Admin UI exposes the global switch in a (new, minimal) settings panel and the per-character switch at the top of the ST Mods panel (built in STM-5).

**Acceptance:**
- `GET /api/settings` returns `{ _id: 'global', st_mods_enabled: true, ... }`, seeding the doc on first call.
- `PATCH /api/settings` with `{ st_mods_enabled: false }` updates and round-trips; unknown keys are rejected.
- Toggling global off and reloading makes every character render with base values.
- Toggling per-character `st_mods_suppressed` on for a single character makes only that character render with base values.
- Both audit and mod docs are untouched throughout.

### STM-4: Player sheet — marker and click-to-expand breakdown

On the player-facing sheet, every stat with an entry in `_st_mod_overlay` renders with a gold dot marker (`--gold2: #E0C47A`). Click opens a popover. **Popover renders one row per mod in creation order** (per ADR-004 D4) — each row shows the signed delta, optional reason text (only when `show_reason_to_player === true`), creator name, and timestamp. Final summed value renders as the last row. No "+N (N mods)" collapse in v1; collapse-at->5 deferred.

Marker click handler must be wired through **delegated event routing**, not registered ad-hoc per render (per ADR-004 §"Concerns" item 3 — listener-routing static blind spot).

**Acceptance:**
- A character with two mods on Stamina (+1 with reason shown, −1 with reason hidden) renders Stamina with a marker.
- Popover lists two rows: row 1 shows `+1`, the reason text, creator, timestamp; row 2 shows `−1`, no reason text, creator, timestamp. Final row shows the summed value.
- Re-rendering the sheet (e.g. after a mod is created elsewhere) keeps the marker click working — the handler survives via delegation.

### STM-5: ST Mods admin panel — list, create, revoke, override toggle

New sidebar entry on the admin character view: **ST Mods**. Lists all active mods for the character with stat path, delta, reason, creator, timestamp, "shown to player" indicator, and revoke button. Per-character override switch at the top.

Create-form stat-path dropdown is built per ADR-004 D3:
- **Static groups** (Attributes, Skills, Current State, Derived) imported from `public/js/data/st-mod-targets.js`.
- **Character-derived groups** built at panel-open time: a `Merits` group with one entry per `c.merits[i]` (path `merits[i].dots`, label = merit name); a `Disciplines` group with one entry per `c.disciplines[i]` (path `disciplines[i].dots`, label = discipline name).
- Reopen the panel to refresh — merit/discipline groups are not cached.

Verify `current.*` field names against `public/js/data/accessors.js` before shipping the dropdown (per ADR-004 §"Concerns" item 4 — if actual fields are at top-level rather than `current.*`, the static map must match). The STM-2 path-resolve sanity check is the gate.

Create-form and revoke-button handlers must use **delegated event routing**, not ad-hoc per render (per ADR-004 §"Concerns" item 3).

**Acceptance:**
- ST can create a mod from the panel (any group: static or character-derived) and see it immediately on the player sheet with marker and breakdown.
- Merits and Disciplines groups in the dropdown reflect the current `c.merits` and `c.disciplines` of the open character, not a cached or stale set.
- ST can revoke a mod and see it disappear from the panel and the sheet.
- ST can toggle per-character override and see all markers vanish/reappear without losing the underlying mods.
- Reopening the panel after the character's merit list changes shows the updated merit options.

### STM-6: ST Mods audit view

Read-only audit log view, reachable from the ST Mods panel or as a separate admin page. Lists `st_mod_audit` entries for a character (or globally, with filters by ST and date range). Shows creation events whose mod has since been revoked, marked as such (by checking absence from `st_mods`).

**Acceptance:** A mod that was created and then revoked still appears in the audit view, marked "revoked." Filtering by creator-ST narrows the list correctly. Pagination if the list exceeds 100 entries.

## Rev 4 stories: persistent toggleable mods (STM-10..13)

STM-1..6 above shipped v1 (ephemeral mods) and v2 (multi-read-site propagation, Rev 3). Rev 4 reverses the ephemeral model to persistent toggleable mods. Detailed story files are owned by the SM; this is the PRD-level map. Architecture: ADR-004 §D15-D20.

- **STM-10 — lifecycle backend.** `st_mods` gains `active: boolean`. Toggle endpoints (activate/deactivate), permanent-delete endpoint, WS op-set expansion to `{create, activate, deactivate, delete}` (`revoke` retires), and audit lifecycle-event writes (each handler appends the matching `created|activated|deactivated|deleted` row). **HALT-DAR pin:** the `deleted` tombstone must be written before the mod doc is removed and must survive permanent-delete; an implementer satisfying delete by dropping audit rows violates the locked retention contract.
- **STM-11 — audit view (extends STM-6).** Render the lifecycle event stream directly rather than deriving revoked-state from absence. Depends on STM-10's audit shape.
- **STM-12 — panel UI (extends STM-5).** All-mods list with per-row toggle + per-row permanent-delete + filter + reactivate workflow. **Locked ACs:** inactive mods remain visible in a muted state with a clear reactivate affordance (without this the library benefit evaporates and STs default to re-create); create form soft-warns only when the typed path matches an *inactive* mod on this character (active-path stacking is silent and by design), framed as "reactivate the dormant one."
- **STM-13 — backfill migration.** Idempotent `active: true` for existing `st_mods` docs. Split from STM-10 for independent revertibility; runtime guards (`active !== false`) make correctness backfill-independent. Parallelisable with STM-11/STM-12 after STM-10 merges.

## Dependencies

- **Backend:** `server/routes/` (new `st_mods.js`), `server/db/` (collection setup), existing Discord OAuth middleware.
- **Frontend:** `public/js/editor/` (overlay composition + sheet integration), `public/js/admin/` (new ST Mods panel + audit view), `public/js/data/st-mod-targets.js` (new, stat-path enumeration).
- **Schema:** `schemas/schema_v2_proposal.md` — add `st_mods_suppressed?` to character; document new `st_mods`, `st_mod_audit`, and `app_settings` collections.
- **CLAUDE.md:** add a note under "Derived stats are never stored" carving out the ST mod overlay as the sanctioned exception path (load-bearing — see ADR-004 §"Concerns" item 1). Executed in STM-2.
- **Architecture:** [ADR-004](architecture/adr-004-st-mods-overlay.md) — Rev 1 composition site/settings/enumeration/stacking (D1-D4); Rev 2 tracker_state splice (D5-D7); Rev 3 multi-read-site propagation (D8-D14); Rev 4 persistent toggleable mods + immutable lifecycle ledger (D15-D20).
- **Story ordering (v1, per ADR-004 §"Sign-off"):** STM-1 first. STM-2 and STM-3 parallel after STM-1. STM-4 and STM-5 depend on STM-2 + STM-3. STM-6 depends on STM-1 only.
- **Story ordering (Rev 4):** STM-10 (lifecycle backend) first. STM-11 (audit view), STM-12 (panel), STM-13 (backfill) parallel after STM-10 merges.
