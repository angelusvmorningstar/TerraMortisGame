# Player UI & Game-Day Experience Review

**Author:** Sarah (PO) with three code-exploration passes
**Date:** 2026-07-11
**Status:** Resolved 2026-07-11 — all recommendations adopted; D5 roll history IN scope. Epic: `specs/epic-gdx-gameday-experience.md`
**Scope:** Player-facing app (`public/index.html` unified app), mobile/phablet/desktop access, dice roller game-day features, character sheet layout, general UI best practice.

---

## 1. Ground truth (corrects stale assumptions)

1. **`public/index.html` + `public/js/app.js` is THE player app.** `public/player.html` is a dead redirect stub (`player.html:21-35` does `window.location.replace('/')`). All player functionality lives in the unified app with role-aware rendering.
2. **The April 2026 UX spec is outdated in both directions.** It mandated a single-column sheet (partially implemented — desktop only) and said "no responsive breakpoints required" (the code has since grown ~13 breakpoints in `suite.css`). Neither claim describes the current app.
3. **CLAUDE.md's tracker auth claim is stale.** `tracker_state` is NOT ST-only: `canAccess` (`server/routes/tracker.js:10-15`) already lets a player GET and PUT their own characters' tracker docs, and the PUT already broadcasts over WS. *(Action: fix CLAUDE.md line.)*
4. **Two sheet renderers exist**: `public/js/suite/sheet.js` (891 lines, current app, 4-way split) and `public/js/editor/sheet.js` (2684 lines, editor + legacy portal, single column). Two roller surfaces exist: the Dice tab (`suite/roll.js`) and the contextual `suite/dice-modal.js` opened from sheet rows.

---

## 2. Mobile / responsive audit — findings by severity

| # | Severity | Finding | Evidence |
|---|----------|---------|----------|
| M1 | **CRITICAL** | Pinch-zoom disabled on the live app: `maximum-scale=1.0, user-scalable=no`. WCAG 1.4.4 failure; no escape hatch for small text. | `public/index.html:5` |
| M2 | **HIGH** | Type scale is absolute-px only (589 px font-sizes, 0 rem in `suite.css`) with ~330 rules at 9–11px. Ignores OS text scaling; compounds M1. | `suite.css` throughout; e.g. `.cbt-incap-lbl` 9px `:1697`, `.edit-tab` 10px `components.css:174` |
| M3 | MEDIUM | No true phone breakpoint — narrowest is 599/600px; a 360px phone gets phablet layout. `nowrap` numeric tables (XP log) can overflow horizontally. | `suite.css:88`, `:2438-2441` |
| M4 | MEDIUM | Sub-44px touch targets: 18px rating dots (tappable in editor), ~26–30px editor tab strips and sheet-view toggles. | `components.css:48`, `:174`; `suite.css:730` |
| M5 | LOW | Standards violations: 5 bare-hex inline styles in `editor/print.js` (print-only); literal colours in `suite.css:1387,1704,2451`; mixed max-/min-width breakpoints vs the mandated mobile-first convention; 103 inline `style=` attrs in editor JS forcing `!important` media-query overrides. | as cited |
| M6 | INFO | `player.html` + `player.js` (536 lines) + the portal path of `editor/sheet.js` are legacy surface kept alive only by the redirect. | `player.html:21-35` |

**What is already good:** panel stacking works (`city-split`, `tab-split` etc. all collapse), the roll calculator buttons are 56px thumb-friendly, bottom nav is 70px with safe-area insets and scroll affordance, PWA meta is complete, and design-token/theming discipline is strong. The mobile experience is undermined by two cheap cross-cutting defects (M1, M2), not by structure.

---

## 3. Dice roller — current behaviour vs desired

**Current:**
- Pool building via shortcut panels (Character / Discipline / Common / Auspex) → `loadPool` → adjust pool/bonus/again → chips: Rote, No Again, WP (+3 dice). `app.js:720-861`, `suite/roll.js:33,329-473`, `game/char-pools.js`.
- **Costs are display-only.** Discipline/devotion cost strings ("Cost: 1 V") are shown in pickers (`app.js:778-779`, `shared/pools.js:49-54`) but nothing is ever deducted. The WP chip is a roll *bonus*, not a WP *spend* against the tracker.
- Roll history is in-memory only (`state.hist`, cap 20, `suite/roll.js:450-456`) — lost on refresh, never sent anywhere.

**Desired (Peter, 2026-07-11):** a server-set `game_in_progress` status; when ON, rolling a discipline/devotion with a vitae/WP cost applies those costs to the character's live tracker and the admin portal updates in real time.

### Feasibility — mostly already built

| Piece | Status | Work |
|---|---|---|
| WS server + `tracker` broadcast frame | **Exists** (`server/ws.js`; auth'd, heartbeat, reconnecting client `public/js/data/ws.js`) | None — reuse frame |
| Player writes own `tracker_state` | **Already works** (`tracker.js:10-15`) | None (fix stale CLAUDE.md) |
| Admin live re-render on tracker change | **Already works** end-to-end (`tracker.js:44` → `ws.js:124` → `admin.js:203-209`) | None |
| `game_in_progress` flag | Missing | Add key to `app_settings` whitelist (`server/routes/app-settings.js:22-27`) + admin toggle |
| Player can read the flag | **Blocked** — `/api/settings` GET is ST-only (`app-settings.js:47`) | Open GET to all authed users (PATCH stays ST-only) |
| Flag flips push live | Missing (client settings cache is boot-only) | New `broadcastSettingsUpdate` WS frame, or accept effect-on-reload |
| Machine-readable costs | **BLOCKER** — free text: `"1 V"`, `"2 V"`, `"5 V/turn"`, `"-"`, `""`, "see description" | Structured `vitae_cost`/`willpower_cost` ints on `purchasable_powers` + devotions (schema + migration), with parser-assisted backfill and an "unparseable → no auto-apply, prompt player" fallback |

**Auth shape:** identical to six existing player-write precedents (tracker, cyoa, ordeal-responses, questionnaire, contested rolls, DT submissions) — own-character scope enforced in-router. No new auth model.

**Adjacent open issues that belong in this scope:** #669 (WP spend in DT wired to tracker — sibling of cost-apply), #817 (delete dead name-keyed trackers), #859 (inline-style cleanup), #846 (dead dice-engine import), `nav.6` (contested-roll defender picker, needs-design).

---

## 4. Character sheet layout — panels vs single scroll

Current: `suite/sheet.js` renders once, then **slices into 4 tabs** (Info / Stats / Skills / Powers) on phone & game mode (`sheet.js:190-193,747-755`); **desktop already concatenates the same HTML into one scrolling column**. So both layouts exist today — the split is a mobile presentation choice, not a data or renderer difference.

Trade-off analysis for the phone/game-day context:

- **4-tab split (current):** no long scroll to reach Powers mid-scene; but track state (Vitae/WP/Health) lives only in Stats, so applying damage while looking at a power means tab-hopping. Tabs also compete with the app's bottom nav — two nav layers.
- **Single scroll:** matches the UX-spec direction and the "document-like dossier" feel; with a sticky mini-nav (jump links) and a **sticky compact track strip** (Vitae/WP/Health always visible), it removes the tab-hop for exactly the game-day case that matters.

**PO recommendation (§6-D1):** single scrolling page with (a) sticky jump-nav chips and (b) a persistent compact tracker strip pinned under the header. Keep the slice architecture (it costs nothing) so the split can survive as a fallback during rollout.

---

## 5. Proposed epic structure

### Epic GDX — Game-Day Experience (player app)

**Group A — Mobile access hygiene** (highest value-per-effort, no design dependencies)
- GDX-1: Re-enable zoom; viewport fix. *(one line + regression sweep of any layout that relied on the zoom lock)*
- GDX-2: Type-scale migration to rem with a floor (no rendered text below ~12px equivalent); phone breakpoint ≤480px; fix nowrap-table overflow.
- GDX-3: Touch-target pass — rating dots, tab strips, sheet toggles to ≥44px effective (hit-area padding, not necessarily visual size).
- GDX-4: Standards cleanup — absorb #859, print.js hexes, literal colours, migrate inline JS layout styles that force `!important` overrides.

**Group B — Game-day roller** (server + client)
- GDX-5: `game_in_progress` setting — app_settings key + validators + defaults; admin toggle UI; open GET /api/settings to all authed users; `broadcastSettingsUpdate` WS frame + client handler.
- GDX-6: Structured power costs — schema fields `vitae_cost`/`willpower_cost` (+ `cost_note` for the irreducible free-text cases) on purchasable_powers and devotions; parser-assisted data migration + report of unparseables for ST review. *(Blocker-remover; must precede GDX-7.)*
- GDX-7: Cost application on roll — when `game_in_progress` and a rolled power has structured costs: confirm-spend prompt → deduct via existing tracker `saveToApi` → existing WS broadcast → admin live update. Insufficient-resource guard (can't spend below 0). Costless/unparseable powers roll as today.
- GDX-8 (optional): persist roll history / surface player rolls to ST during game. *(Not requested; parked unless wanted.)*

**Group C — Sheet layout & legacy consolidation**
- GDX-9: Single-scroll sheet with sticky jump-nav + pinned track strip (per §6-D1 decision).
- GDX-10: Legacy retirement — delete `player.html` redirect + `player.js` after confirming zero traffic; scope the `editor/sheet.js` vs `suite/sheet.js` duplication (read-only rendering paths only; editor keeps its own).

**Sequencing:** A1–A3 immediately (independent); GDX-5 ∥ GDX-6, then GDX-7; Group C after the D1 decision. #669 folds into Group B as a related-but-separate story (DT-time WP spend vs live spend).

---

## 6. Decisions required (Peter)

- **D1 — Sheet layout:** adopt single-scroll + sticky track strip as the phone default (recommended), keep 4-tab split, or make it a per-user toggle?
- **D2 — Cost data:** structured integer fields + migration (recommended) vs runtime parser only?
- **D3 — Cost apply UX:** confirm-prompt before spending (recommended — one tap: "Roll & spend 1 Vitae?") vs silent auto-apply?
- **D4 — `game_in_progress` control:** manual ST toggle in admin (recommended, simplest) vs auto-derived from `game_sessions` date windows?
- **D5 — Scope check:** is GDX-8 (persisted/ST-visible roll history) wanted this cycle, or parked?

---

## 7. Corrections to standing docs (do regardless)

1. CLAUDE.md `tracker_state` "ST-auth only" line → rewrite to reflect `canAccess` own-character player access.
2. `specs/ux-design-specification.md` → mark superseded sections (mobile stance, player.html references).
3. `specs/reference-data-ssot.md` → verify tracker/status rows against route code while in there (stale-SSOT pattern).
