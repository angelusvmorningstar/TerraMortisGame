---
status: ready-for-development
epic: GDX
title: Game-Day Experience — player app mobile access, live roller costs, sheet layout
approved: 2026-07-11 (Peter — all PO recommendations adopted; roll history in scope)
review: specs/review-player-ui-gameday-2026-07-11.md
---

# Epic GDX — Game-Day Experience

**Issues:** umbrella #981 · GDX-1 #982 · GDX-2 #983 · GDX-3 #984 · GDX-4 #985 · GDX-5 #986 · GDX-6 #987 · GDX-7 #988 · GDX-8 #989 · GDX-9 #990 · GDX-10 #991

Player-facing app (`public/index.html` unified app) overhaul for game day: phone/phablet access hygiene, a server-set `game_in_progress` mode that makes discipline/devotion rolls apply vitae/willpower costs to the live tracker with real-time admin sync, persisted ST-visible roll history, single-scroll sheet, and legacy retirement.

## Locked decisions (2026-07-11)

| # | Decision |
|---|----------|
| D1 | Phone sheet becomes **single-scroll** with sticky jump-nav chips + pinned compact Vitae/WP/Health strip. Slice architecture retained as fallback during rollout. |
| D2 | **Structured cost fields** `vitae_cost` / `willpower_cost` (ints, nullable) + `cost_note` (free text remainder) on `purchasable_powers` and devotions. Parser-assisted migration; unparseables reported for ST review, never guessed. |
| D3 | Cost application uses a **one-tap confirm** ("Roll & spend 1 Vitae?"). No silent deduction. |
| D4 | `game_in_progress` is a **manual ST toggle** in admin, stored in `app_settings`. No auto-derivation from game_sessions. |
| D5 | **Roll history is in scope** (GDX-8): rolls persisted while `game_in_progress` is ON; live ST-visible feed in admin. |

## Design & API constraints (all stories)

- CSS via design tokens in `theme.css` only; reuse `components.css`/`suite.css` classes; no bare hex, no inline `style=` (coding-standards.md → CSS Standards). Mobile-first `min-width` queries for new/changed Suite rules.
- Derived stats never stored; tracker writes go through the existing `PUT /api/tracker_state/:character_id` → `broadcastTrackerUpdate` loop (`server/routes/tracker.js:30-44`, `server/ws.js:63`). Do not add a second tracker write path.
- ST-mod overlay invariants (ADR-004) untouched: no bounds in `applyStMods`; cost floor/guard logic lives at the tracker-write site, not the overlay.
- Player write auth follows the established own-character idiom (`canAccess`, `tracker.js:10-15`); no new auth model.
- British English; no em-dashes in UI copy.

## Stories

### Group A — Mobile access hygiene (independent, start immediately)

**GDX-1: Re-enable zoom (viewport fix)**
Remove `maximum-scale=1.0, user-scalable=no` from `public/index.html:5`. Regression sweep: verify no layout depended on the zoom lock (overlays, fixed headers, bottom nav on iOS Safari + Android Chrome).
AC: pinch-zoom works on the live app; no layout breakage in the four primary tabs + sheet + roller at 360/414/768px.

**GDX-2: Type scale + phone breakpoint**
Migrate `suite.css`/`components.css` font sizes to rem with a 12px-equivalent floor for body-level text (badges/labels may go to ~11px equivalent, nothing below); add ≤480px phone breakpoint where phablet layout breaks; fix `.xpl-table` nowrap overflow (`suite.css:2438-2441`) with an `overflow-x:auto` wrapper.
AC: no rendered text below the floor on the player surfaces; no horizontal page scroll at 360px on any player tab; OS text scaling respected.

**GDX-3: Touch-target pass**
≥44px effective hit areas (padding, not necessarily visual size) for: rating dots where tappable (`components.css:48`), `.edit-tab` strip (`components.css:174`), `.svt-btn` toggles (`suite.css:730`), tracker tap zones.
AC: all interactive player-surface controls measure ≥44px hit area; visual design unchanged at desktop.

**GDX-4: CSS standards cleanup**
Absorbs issue #859. Remove 5 bare-hex inline styles in `editor/print.js` (print stylesheet or tokens); tokenise literal colours at `suite.css:1387,1704,2451`; migrate the inline JS `grid-template-columns` (editor/sheet renderers) that force `!important` media-query overrides, where low-risk.
AC: enforcement grep clean on touched files; #859 closeable.

### Group B — Game-day roller (GDX-5 ∥ GDX-6 → GDX-7 → GDX-8)

**GDX-5: `game_in_progress` setting + live propagation**
Add `game_in_progress` (bool, default false) to `app_settings` whitelist/validators/defaults (`server/routes/app-settings.js:22-27`). Admin toggle UI (Engine domain). Open `GET /api/settings` to all authenticated users (PATCH stays ST-only). New `broadcastSettingsUpdate` WS frame (`server/ws.js` pattern per `broadcastCatalogueUpdate`) + client handler updating the settings cache live.
AC: ST flips toggle in admin → player app reflects the flag without reload; players cannot PATCH; vitest for route auth both ways.

**GDX-6: Structured power costs (blocker-remover)**
Schema: `vitae_cost`, `willpower_cost` (int ≥0, nullable), `cost_note` (string) on `purchasable_powers` (`server/schemas/purchasable_power.schema.js`) and the devotions data. Migration script parses existing `cost` strings (`"N V"`, `"N WP"`, combos); `/turn`, "see description", and unparseables get `cost_note` only and a report for ST review. Script follows the integration-test discipline (end-to-end main() test; no find+projection+replaceOne).
AC: every power has structured fields or an explicit null + note; migration report lists all non-auto-parsed rows; display falls back to `cost_note`/legacy string where structured fields are null.

**GDX-7: Apply costs on roll**
When `game_in_progress` is ON and a rolled discipline/devotion has structured costs: roll button shows "Roll & spend N Vitae[, M WP]" (D3 confirm-as-button-label — one tap total); on roll, deduct via existing `saveToApi` tracker path → existing WS broadcast → admin live update. Guards: cannot spend below 0 (insufficient resources blocks the spend-roll and offers roll-without-spend); costless/null-cost powers roll as today; flag OFF = current behaviour exactly. The WP(+3) chip remains a separate roll bonus and, when used during game, also deducts 1 WP (rules: spending WP for +3 dice is a spend) — confirm labelling makes the distinction visible.
AC: each guard has a vitest or documented browser-smoke step; admin sheet shows the deduction in real time; no tracker write when flag OFF or costs null.

**GDX-8: Persisted roll history + ST live feed**
New `roll_log` collection: `{ character_id, player_id, label, pool, results[], successes, again_rule, rote, wp_bonus, vitae_spent, wp_spent, rolled_at }`. Player POSTs own rolls (own-character idiom) **only while `game_in_progress` is ON** (practice rolls stay local); client keeps in-memory history regardless. New `broadcastRollLogged` WS frame; admin gets a live roll feed panel (Engine domain) showing character, pool label, successes, costs. Retention: cap or TTL decision at story-draft time (recommend TTL index ~90 days).
AC: player rolls during game appear in admin feed in real time; nothing persisted when flag OFF; player A cannot read player B's log (or log read is ST-only); 401/403 vitest coverage.

### Group C — Sheet layout & legacy retirement (after Group A lands)

**GDX-9: Single-scroll sheet (D1)**
Phone/game-mode sheet becomes one scrolling column (reuse the existing desktop concatenation path, `suite/sheet.js:747-755`) with: sticky jump-nav chips (Info/Stats/Skills/Powers anchors) and a pinned compact track strip (Vitae/WP/Health, tap-through to full trackers) under the header. 4-tab slicing kept behind a fallback flag during rollout, removed in a follow-up once accepted.
AC: sheet readable + track state always visible at 360px; jump chips scroll to sections; no duplicate nav layers; desktop unchanged.

**GDX-10: Legacy retirement**
Reachability-first (per #836 precedent): confirm zero traffic/entry points to `player.html`, then delete `player.html` + `public/js/player.js`; assess `editor/sheet.js` read-only-render duplication vs `suite/sheet.js` and file the consolidation scope (likely its own follow-up); update `specs/ux-design-specification.md` superseded sections.
AC: dead files removed; no console errors on boot; UX spec annotated.

### Housekeeping (bundled into first Group B story PR)

- Fix CLAUDE.md `tracker_state` "ST-auth only" claim → own-character player access per `tracker.js:10-15`.
- Verify `specs/reference-data-ssot.md` tracker/status rows against route code.

## Sequencing

```
A: GDX-1 → GDX-2 → GDX-3 → GDX-4        (independent of B/C; 1 before 2 recommended)
B: GDX-5 ∥ GDX-6  →  GDX-7  →  GDX-8
C: GDX-9 → GDX-10                        (after Group A; D1 locked)
```

Related issues: #669 (DT WP spend — sibling of GDX-7, stays separate), #817 (superseded in part by GDX-10 scope check), #859 (absorbed by GDX-4), #846 (check during GDX-7), nav.6 (out of scope, still needs-design).
