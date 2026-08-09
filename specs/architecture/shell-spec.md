# Shell Spec — one app, role-gated

**Status:** draft for approval
**Date:** 2026-07-31
**Supersedes:** the phase plan in ADR-008 (admin merge). The done-condition is unchanged: `admin.html` no longer exists and one document serves both roles. The route to it changes.

---

## What this is, and what it is not

**This is a new shell around the existing machine.** One HTML document, one navigation, one role gate. Existing modules mount into it unchanged.

**This is not a rewrite.** The server, the MongoDB schema, the rules engine, the character sheet renderer, the XP derivation, the ST-mods overlay and the design system are all kept and re-used as-is. The campaign's mechanics are not reimplemented — that is where the value is and where a rewrite would silently produce wrong numbers on character sheets.

The thing being replaced is the *shell*: two HTML documents, two navigations, two stylesheets, and the `admin-layout.css` that never joined the design system.

---

## Why this became tractable

Downtime is moving out of this app, both the ST processing side and the player submission side.

| | files | size |
|---|---:|---:|
| Total JS today | 158 | 3,809 KB |
| Leaves with downtime, cycle, ordeals, devlog, city, archive | 31 | **1,523 KB (40%)** |
| Remains | 127 | 2,286 KB |
| ...of which `dev-fixtures.js` is dev-only | 1 | 411 KB |
| **Real remaining app** | **126** | **1,875 KB** |

Three downtime files alone (`admin/downtime-views.js` 589 K, `tabs/downtime-form.js` 360 K, `admin/downtime-story.js` 200 K) are 30% of the entire codebase. They leave without anyone migrating them.

What is left of the ST side is **~300 KB across twenty small files, largest 45 KB**. No frozen write path, no monolith. That is the whole reason this is a shell job and not an epic.

---

## The shell

### One document

`public/index.html`. `public/admin.html` is deleted.

### Stylesheets

Players load what `index.html` loads today — `theme.css`, `layout.css`, `components.css`, `suite.css`. Four sheets, unchanged.

ST loads those plus **one** new sheet, `st.css`, injected only for the ST role.

`admin-layout.css` (288 KB, 2,472 selectors) is **deleted, not ported**. It uses the design system's tokens at 6.8% against the player app's 71.2%; it is a parallel styling system, not a stylesheet. The ~10 ST screens that survive are small and get restyled onto the design system as they are ported. This is the single largest simplification in the plan and it only works because downtime — the bulk of what `admin-layout.css` styles — is leaving.

### Role gate

Two questions, kept separate:

- **Authority** — is this session an ST? Decides whether ST modules are ever fetched.
- **Visibility** — is the ST currently previewing as a player? Decides whether ST screens are shown.

ST screens are loaded by dynamic `import()` behind the authority check, so a player's browser never requests a byte from `public/js/admin/`. This is already proven in production: the same technique removed a 214 KB static admin dependency from every player page load (#1075).

### Navigation

One nav. ST entries are **absent** for players, not hidden by CSS. A screen a player cannot reach is a screen whose styling cannot leak and whose code is never fetched.

---

## The machine — kept, not touched

These are re-used as-is. No work in this plan touches them.

| area | size | what it is |
|---|---:|---|
| `editor/` | 418 KB | character sheet renderer, editor, domain, merits, XP, MCI |
| `data/` | 278 KB | accessors, constants, helpers, rules helpers, ST-mods overlay, prereqs, equipment derivation |
| `suite/` | 238 KB | sheet view, roll calculator, status, territory, icons |
| `game/` | 103 KB | game-day tracker, sign-in, finance, combat, contested rolls |
| `print/` | 54 KB | PDF and print output |
| `editor/rule_engine/` | 36 KB | the eleven rule evaluators |
| `shared/`, `auth/`, `components/` | 34 KB | dice, pools, resist, Discord auth, pickers |
| server + MongoDB | — | untouched |

`editor/sheet.js` at 198 KB is the largest single survivor and is already shared by both apps today. **It does not need porting — it needs mounting.** That is what makes the shell a week of work rather than a quarter.

---

## The screens

### Player screens — already in `index.html`

Character sheet · roll calculator · feeding · relationships · regency · status · office · primer · lore. These move as nav plumbing, not as ports.

### Game-day screens

Tracker · sign-in · finance · combat · contested rolls · challenges · emergency.

### ST screens — the actual porting work

| screen | code | notes |
|---|---:|---|
| Characters | shared `editor/` | the grid and sheet editor; mounts, does not port |
| Data | 67 KB | import/export + Excel; heaviest, and the only one with many write paths |
| Rule Data | 38 KB | merits, devotions, manoeuvres |
| Rules Engine | 29 KB | the eight rule families |
| NPC register | 23 KB | |
| ST Mods | 32 KB | panel + logic + audit |
| Relationship editor | 20 KB | |
| Dice engine | 18 KB | |
| Equipment Catalogue | 16 KB | |
| Players | 12 KB | Discord identity and linking |
| Attendance | 19 KB | + session log, next session |
| Tickets | 10 KB | **already moved** |
| Spheres | 7 KB | **already moved** |

### Screens that do not arrive

Downtime · Cycle · City · Documents · Devlog · Ordeals · Archive. Deleted, moved to the wiki app, or handled elsewhere. **Seven of seventeen ST screens are deletions.**

---

## Order of work

**Wave 0 — free, do now.** Delete the six unreachable files (#1095): `tabs/wizard.js`, `suite/tracker-feed.js`, `data/kind-prompts.js`, `dt-proto-boot.js`, `tabs/influence-tab.js`, `tabs/xp-log-tab.js`. 53 KB, no risk.

**Wave 1 — the shell.** New nav, role gate, `st.css`, player screens mounted. Ends with a browser-openable app that does everything `index.html` does today, on the new shell.

**Wave 2 — ST screens.** The thirteen above, in one batch, restyled onto the design system as they land. They are small and independent; there is no dependency order between them.

**Wave 3 — delete.** The 1,523 KB of downtime, cycle, ordeals, devlog, city and archive files, once downtime is live in its new home. Deletion, not migration.

**Wave 4 — cutover.** Switch which app serves players on a chosen day. `admin.html` deleted.

Wave 1 and Wave 2 do not touch downtime, so **both can start before the current cycle closes.**

---

## Branch and deploy

Built on `dev`. `main` keeps serving today's app to players untouched throughout.

The end of this is a **cutover, not a merge**: on a chosen day `main` starts serving the new shell, with the old app one revert away. Worth planning for now rather than discovering at the end.

---

## Known debt carried in

Recorded so it is not rediscovered as a surprise.

- **A form engine written four times.** `downtime-form`, `history-form`, `ordeal-form` and `questionnaire-form` each define their own `saveDraft`, `scheduleSave`, `collectResponses`, `submitForm`, `renderForm`. A shared `tabs/draft-persist.js` exists and is unreachable — built, never adopted. **Three of the four leave with downtime**, so this largely resolves itself. Do not fix it first.
- **`d10` implemented six times**, including in `shared/dice.js` which exists and is used. Dice are rules; six copies can silently disagree. Worth one consolidation pass, in Wave 2, when the dice engine screen is ported.
- **`esc` copied into thirteen admin files.** Trivial; fix opportunistically as files are touched.
- **Icons are 197 KB across two shared modules** (`data/icons.js` 117 K, `suite/icons-data.js` 80 K). Overlap unmeasured. Worth a look in Wave 1 since both load for every user; not a blocker.
- **The QA rig has never exercised a player write path.** Matters when a writing ST screen (Data) is ported.

## What is deliberately not being done

- No parity harness. The player screens are not changing, so there is nothing to compare against.
- No collision reconciliation. A new shell has nothing to collide with; `admin-layout.css` is deleted rather than merged.
- No cleanup pass before the shell. 40% of the code leaves on its own; optimising first means polishing code that may not be ported.
