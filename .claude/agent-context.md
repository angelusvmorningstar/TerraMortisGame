# Agent Context — TM Game

Read this first if you are one of Angelus's user-level general-purpose agents (from
`C:\Users\angel\.claude\agents\`) invoked while working in this repo. This is an **index pointing at
this repo's real reference docs**, not a restatement — follow the link for actual content. See
`C:\Users\angel\.claude\agents\AGENT-STANDARD.md` for the convention this file follows.

No prior equivalent existed (confirmed 2026-09-11, no live session in this repo at the time).

## What this repo is

Terra Mortis TM Game: a browser-based character management system for a Vampire: The Requiem 2nd
Edition LARP campaign (not Invictus — don't apply Invictus-domain agents or canon here). Express API
on Render, static frontend on Netlify, MongoDB Atlas. Owns the shared `tm_game` database that TM
Story reads and TM Admin shares credentials with. Full detail: `CLAUDE.md`.

## Where to look, by agent/topic

| If you are... | Read this first |
|---|---|
| `dana-data-steward` (schema/data-contract work) | No single data-map.md exists — closest real references are `specs/architecture.md` and `specs/data-hygiene-audit-2026-09-02.md` (most recent of two hygiene audits); this is a gap worth flagging, see fallback below |
| Anyone checking current build/planning status | `specs/epics.md` if present, `specs/deferred-work.md` |
| `aesthetics-designer` | No dedicated design SSOT found here — TM Admin/TM Story both cite TM Game's own tokens as the shared base, check `public/css/tokens.css` directly |
| Invictus-domain agents (`fabian-setting`, `reeve-rules-steward`, etc.) | Not applicable — different game system entirely (Vampire: The Requiem, not Invictus) |

## If your domain has no reference here

Say so in your report, work from general principles, and offer to write the missing reference as
your first deliverable rather than silently falling back to generic behaviour. (A real `specs/
data-map.md` — matching TM Admin's — would be a genuinely useful first deliverable for Dana here.)
