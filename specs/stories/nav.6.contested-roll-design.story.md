---
id: nav.6
epic: unified-nav-polish
group: E
status: superseded
priority: deferred
---

> **SUPERSEDED (2026-08-22, via crd.1).** This story describes an ST-only inline defender-picker
> popup and predates the player-driven direction entirely. It is replaced by
> `specs/epic-crd-contested-roll-defence.md` (Epic CRD — Contested Roll Defence), which gives the
> DEFENDING PLAYER their own interactive resolution screen instead of an ST-only picker. Never
> implemented — was still `needs-design`/`deferred` when superseded, despite `sprint-status.yaml`
> incorrectly marking it `done` alongside the rest of Epic Unified Nav Polish (corrected as part of
> crd.1's own AC9).

# Story nav.6: Contested Roll — Inline Defender Picker (DESIGN REQUIRED)

## ⚠️ Design Spike Required

**Do not implement this story until a design spike has been completed.**

This story captures the intent and constraints. Before work begins, a UX design session must answer the open questions below and update this story with a concrete interaction spec and acceptance criteria.

---

## Intent

The current Contested Roll feature is a popup/modal. The desired change is to redesign it as an inline defender picker — available to STs only — that smart-fills the defence pool based on the selected defending character.

## Known Constraints

- ST-only feature — players should not see the defender picker
- The defence pool should auto-populate based on the defending character's relevant stats (e.g., Defence for physical contests, Composure+Resolve for social)
- The current popup approach interrupts the dice flow — the inline approach should feel continuous
- Must work on tablet (ST's primary device at game)

## Open Design Questions (must be resolved in design spike)

1. Where does the defender picker appear? Below the attacker pool builder? In a side panel? As an expandable section?
2. How does the pool auto-fill logic work? Does the ST confirm the auto-filled pool or just roll? What if the pool is wrong?
3. Does the defender roll separately (two separate rolls) or is it resolved as a single comparison?
4. What is the right fallback if the defending character has no data in the app?
5. Is this purely a display feature (ST sees both pools) or does it write results anywhere?

## Placeholder Acceptance Criteria

*(To be replaced with real ACs after design spike)*

- ST can access contested roll mode from the Dice tab
- ST can select a defending character from a picker
- Defence pool is auto-suggested based on character data
- ST can modify the suggested pool before rolling
- Both pools are visible simultaneously before rolling

## Dev Agent Record
### Agent Model Used
### Completion Notes
### File List
