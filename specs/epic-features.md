---
epic_id: feat
epic_name: Feature Backlog
status: backlog
created: 2026-04-17
---

# Epic FEAT: Feature Backlog

## Overview

Standalone features and fixes that don't fit an existing epic. Includes quick wins, data management improvements, and deferred major systems.

---

## Story FEAT-1: Remove Resolved Tickets

**Backlog item:** 10

**As a** player or ST,
**I want** to mark tickets as resolved and remove them from the active view,
**so that** the tickets list doesn't accumulate stale items.

### Acceptance Criteria

1. ST can mark any ticket as resolved
2. Resolved tickets are hidden from the default ticket list view
3. Optional: a "show resolved" toggle to view archived tickets
4. Player can see when their ticket has been resolved

### Dev Notes

- Current ticket statuses: open, in-progress, closed — confirm schema
- Files: `public/js/player/tickets-tab.js`, `server/routes/` (tickets endpoint)

---

## Story FEAT-2: Non-Vampire Territories in City Tab

**Backlog item:** 16

**As a** player or ST viewing the City tab,
**I want** non-vampire territories (human-controlled areas) to appear in the city view,
**so that** the full territorial picture of the city is visible.

### Acceptance Criteria

1. Non-vampire territories can be added to the territories collection with a type flag
2. Player city tab distinguishes vampire territories from non-vampire territories visually
3. Non-vampire territories do not show regent/feeding rights controls

### Dev Notes

- Add `type: 'vampire' | 'mortal' | 'contested'` (or similar) to territory schema
- Rendering: player city tab `public/js/player/city-tab.js`, admin city view `public/js/admin/city-views.js`
- Confirm territory types with Angelus before implementation

---

## Story FEAT-3: Duplicate Character / Hard Delete

**Backlog item:** 19

**As an** ST,
**I want** to hard-delete a character record from the database,
**so that** duplicate or erroneously created characters (e.g. Lady Julia appearing in DT2) can be permanently removed.

### Acceptance Criteria

1. ST admin has a hard-delete option for character records (distinct from the existing retire/soft-delete)
2. Hard delete removes the character from MongoDB and from all associated records (attendance, downtime submissions, player character_ids arrays)
3. A confirmation gate prevents accidental deletion
4. Immediate use case: remove the duplicate Lady Julia entry from DT2 attendance/submissions

### Dev Notes

- Currently only soft-delete (retire flag) exists
- Hard delete requires cascade: characters, downtime_submissions, game_sessions attendance entries, players.character_ids
- Consider an audit log entry on hard delete
- Files: `server/routes/characters.js`, `public/js/admin/` (character editor or players view)

---

## Story FEAT-4: ST Plot & NPC Tracker

**Backlog item:** 20

**As a** Storyteller,
**I want** a system to create and track plots and NPCs,
**so that** ongoing narratives and key non-player characters are managed in one place.

### Acceptance Criteria

*To be defined — requires UX scoping session before story is ready-for-dev.*

### Dev Notes

- Major new feature — needs Mary/UX session before implementation
- Consider: separate admin tab, or integrated into existing city/engine tab?
- NPC data model: name, description, faction, status, linked plots
- Plot data model: title, description, status (active/resolved/archived), linked characters, linked NPCs, notes
- Status: **backlog — not ready for dev**

---

## Story FEAT-5: Login Linked to Email

**Backlog item:** 23

**As a** player without a Discord account,
**I want** to log in using my email address,
**so that** I can access the player portal without requiring Discord.

### Acceptance Criteria

*To be defined — requires scoping session. Relates to existing email_auth backlog item.*

### Dev Notes

- Current auth: Discord OAuth only
- Options: (a) email+password as alternative to Discord, (b) email-based magic link, (c) email purely for identity verification alongside Discord
- Scope decision needed before story can be written
- Status: **backlog — not ready for dev**

---

## Story FEAT-6: Combat module health-check + roller auto-spend of Vitae/Willpower

**Backlog item:** 24

**Logged 2026-09-18, Angelus's own instruction: log as a task, do not start.** Potential scope for a
future build session, not scoped yet. Two related asks, likely two stories once scoped:

**(a) Ensure the combat module is working properly.** No specific defect named — a general
verification/health-check ask. `epic-cmb-combat-panel.md` (combat panel rebuild, ALL stories still
`backlog`, unstarted) already covers the card-based rebuild; this note may be about that epic
specifically, or about the CURRENT `combat-tab.js` still working correctly in the meantime — needs
clarifying with Angelus before scoping which one.

**(b) The dice roller should be able to spend Vitae/Willpower, reducing the player's pool in the
app** — and should automatically recognise when a player activates/rolls a power that costs Vitae or
Willpower (or spends WP to add dice) and apply the corresponding pool reduction itself, rather than
requiring a separate manual tracker edit.

**Hard constraint, stated explicitly: players must NEVER be able to ADD Vitae or Willpower through
this mechanism — reduction only.** Angelus named that there will be exceptions eventually, but ruled
them explicitly out of scope for now — any future scoping of (b) must preserve reduction-only as the
default and treat any add-path as a separate, later, explicitly-scoped exception, not a general
capability.

### Dev Notes

- Related existing epics to check before scoping: `epic-cmb-combat-panel.md` (backlog, combat
  panel's own manual Vitae/Willpower +/- already exists there per cmb.1's own notes), `epic-rlv-
  roller-harmonisation.md` (done, consolidated the roller engine this would build on), `epic-rcv-
  roller-convergence.md` (done, ported the special-mechanics UI layer — Willpower-adds-dice etc.
  already has some UI presence per that epic's own notes, worth checking exactly what it did and
  didn't wire to a tracker write).
- Not yet verified against live code whether any power activation today already writes to
  `tracker_state` automatically, or whether every Vitae/Willpower pool change is currently manual
  (Tracker tab, Combat tab's own +/-, ST confirm). That's the first thing a scoping pass should
  establish.
- Status: **backlog — not ready for dev, do not start until scoped**
