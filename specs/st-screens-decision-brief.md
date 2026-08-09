# ST screens — decision brief

**For:** the product session that defines what goes in the new shell
**Date:** 2026-07-31
**Blocks:** Wave 2 of `specs/architecture/shell-spec.md`. Does not block Waves 0 or 1.

---

## How to use this

Thirteen ST screens survive downtime's departure. None has ever been examined for whether it should exist — they accreted. The shell spec lists them because they exist, which is an inventory, not a decision.

Mark each one:

- **KEEP** — port as-is
- **CUT** — delete, don't port
- **CHANGE** — port, but differently (say how)
- **?** — need to think

Then the last section, which matters most: **what's missing.**

I can tell you what each screen does and what it writes. I cannot tell you how often you use it or whether it earns its place. That's the whole point of the session.

---

## The thirteen

### 1. Data — import / export · 69 KB · 45 write calls

Bulk import and export, Excel merge and parse. **The heaviest survivor by a wide margin**, and the only one with a large write surface.

Writes to twelve collections: `characters`, `territories`, `npcs`, `rules`, `game_sessions`, `downtime_cycles`, `downtime_submissions`, `downtime_investigations`, `ordeal-responses`, `ordeal_rubrics`, `ordeal_submissions`.

> **Note:** five of those twelve are downtime and ordeals — both leaving. This screen shrinks substantially on its own. Worth deciding what bulk import/export is still *for* once downtime lives elsewhere.

---

### 2. Rule Data · 38 KB · 10 writes

The merits, devotions and manoeuvres catalogue. Writes eight rule endpoints: `derived_stat_modifier`, `disc_attr`, `grant`, `nine_again`, `skill_bonus`, `speciality_grant`, `status_floor`, `tier_budget`.

### 3. Rules Engine · 29 KB · 9 writes

Writes `/api/rules`.

> **Answered by the move (2026-08-02):** they are genuinely two screens. Their
> CSS families share **nothing** — 65 and 48 exclusive classes, zero in common
> beyond `.dt-btn` and `.placeholder-msg`, which every admin surface uses. Two
> screens that were one screen with two views would not look like that.

---

### 4. ST Mods · 33 KB · 12 writes

The signed-delta override overlay on character stats, plus its audit trail. Writes `st_mods`, `st_mod_audit`, `settings` (the global on/off), `characters`.

You've already said the **audit** half is being retooled. The panel half is the live tool.

---

### 5. NPC Register · 23 KB · 11 writes — **CUT** (Peter, 2026-08-02)

Not part of the final app; do not port. Its blocks stay in `admin-layout.css`
and go when `admin.html` does.

NPC records and flags. Writes `npcs`, `npc-flags`, `npc-flags/<id>/resolve`.

> **Note:** relational NPC pickers were suppressed for this release cycle; free-text NPC names were not. Worth confirming which side of that line the register sits on now.

---

### 6. Attendance · 21 KB · 19 writes

Session attendance and finance. Writes `game_sessions`, `game_sessions/next`, `session_logs`.

> **Load-bearing:** game XP is derived from `game_sessions` attendance data at render time. If this screen goes, XP needs another source of truth.

---

### 7. Relationship Editor · 20 KB · 8 writes — **CUT** (Peter, 2026-08-02)

Writes `relationships`. Not part of the final app; do not port. Its blocks stay
in `admin-layout.css` and go when `admin.html` does.

### 8. Dice Engine · 18 KB · **0 writes**

Makes no API calls at all — a purely local tool.

> **Note:** zero writes and zero reads means nothing depends on it and it depends on nothing. The cheapest possible cut if it isn't used, and the cheapest possible keep if it is.

### 9. Equipment Catalogue · 16 KB · 7 writes

Writes `equipment_catalogue` and its `/impact` endpoint.

### 10. Players · 12 KB · 8 writes

Discord identity and character linking. Writes `/api/players`.

### 11. Primer · 2 KB · 1 write

Uploads to `archive_documents`.

> **Note:** Documents is on your purge list. This is probably the same decision.

---

### 12–13. Tickets · 10 KB and Spheres · 7 KB — **already moved**

Listed for completeness. No decision needed unless you want to un-move them.

---

## Summary table

| # | screen | KB | writes | collections | your call |
|---|---|---:|---:|---|---|
| 1 | Data (import/export) | 69 | 45 | 12 (5 leaving) | |
| 2 | Rule Data | 38 | 10 | rules | **DONE** |
| 3 | Rules Engine | 29 | 9 | rules | **DONE** |
| 4 | ST Mods | 33 | 12 | st_mods, audit, settings | **DONE** (panel; audit still deferred) |
| 5 | NPC Register | 23 | 11 | npcs, npc-flags | **CUT** |
| 6 | Attendance | 21 | 19 | game_sessions, session_logs | **DONE** |
| 7 | Relationship Editor | 20 | 8 | relationships | **CUT** |
| 8 | Dice Engine | 18 | 0 | none | |
| 9 | Equipment Catalogue | 16 | 7 | equipment_catalogue | **DONE** |
| 10 | Players | 12 | 8 | players | **DONE** |
| 11 | Primer | 2 | 1 | archive_documents | |
| | **total to decide** | **281 KB** | | | |

Plus **Characters** — the grid and sheet editor. Not in this table because it isn't an admin module; it's the shared `editor/` code that both apps already use. It mounts into the shell regardless. Worth discussing what the ST *grid* around it should show, but the sheet itself is settled.

---

## The part this brief can't produce

**What is missing.**

Everything above is derived from code, so it can only describe what exists. The questions that matter most have no answer in the repo:

1. **What do you currently do outside the app** — in a spreadsheet, in Discord, on paper — that should be in it?
2. **What takes you longest on game day**, and does any screen here address it?
3. **What do you look at most often?** Frequency of use is invisible to me and is probably the strongest keep/cut signal available.
4. **What breaks or annoys you** that you've stopped reporting because it seemed like the way things are?
5. **Once downtime lives elsewhere, what has to cross between the two?** Anything shared becomes an integration, and integrations are the expensive kind of missing feature.

Question 5 is the one with a deadline. The rest can be answered any time; that one shapes what the downtime app has to expose, and it's cheaper to know before it's built than after.

---

## Recommended shape for the session

One pass down the table marking keep / cut / change, then the five questions. The seventeen-screen pass took minutes and removed 40% of the work; this is the same exercise on a smaller list, with the missing-features half added.

No agent should run it. An agent can prepare the input — this document — but it cannot tell you what you need the app to do.
