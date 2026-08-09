# Guidance: Downtime Submission Shape Alignment

## Problem

The downtime system has two ingestion paths that produce incompatible document shapes:

1. **Player portal form** (`downtime-form.js`) → writes flat key-value pairs into `responses` object (e.g. `responses.travel`, `responses.project_1_action`)
2. **CSV import** (`downtime/parser.js` + `downtime/db.js upsertCycle`) → writes nested structures into `_raw` object (e.g. `_raw.narrative.travel_description`, `_raw.projects[0].action_type`)

The admin downtime panel (`downtime-views.js`) has two rendering paths that diverge:
- `renderPlayerResponses(s)` reads from `s.responses` — works for form submissions, empty for CSV imports
- `renderProjectsPanel(s, raw)` reads from `s._raw.projects` — works for CSV imports, empty for form submissions

This means:
- Court data (travel, recount, correspondence, trust, harm, aspirations) captured via CSV is **never displayed** in the admin panel
- Project data from the form uses different field names than project data from CSV
- Sphere, contact, retainer, sorcery, and equipment sections have the same divergence

## Authoritative Schema

The `downtime_submission.schema.js` defines the canonical shape. All data should live in the `responses` object using the flat-key convention:

```
responses.travel                    — Court: travel description
responses.game_recount              — Court: game highlights
responses.rp_shoutout               — Court: JSON array of character IDs
responses.correspondence            — Court: IC letter
responses.trust                     — Court: most trusted PC
responses.harm                      — Court: actively harming PC
responses.aspirations               — Court: goals

responses._feed_method              — Feeding: method ID
responses.feeding_description       — Feeding: narrative
responses.feeding_territories       — Feeding: JSON territory grid

responses.project_1_action          — Project 1: action type enum
responses.project_1_title           — Project 1: name/title
responses.project_1_outcome         — Project 1: desired outcome
responses.project_1_description     — Project 1: detail text
responses.project_1_pool_attr       — Project 1: primary pool attribute
responses.project_1_pool_skill      — Project 1: primary pool skill
responses.project_1_pool2_attr      — Project 1: secondary pool attribute
responses.project_1_pool2_skill     — Project 1: secondary pool skill
responses.project_1_cast            — Project 1: JSON array of character IDs
responses.project_1_merits          — Project 1: applicable merits
responses.project_1_xp              — Project 1: XP spend note
(repeat for project_2, project_3, project_4)

responses.sphere_N_action           — Sphere N: action type enum
responses.sphere_N_merit            — Sphere N: merit display label
responses.sphere_N_outcome          — Sphere N: desired outcome
responses.sphere_N_description      — Sphere N: detail text
(repeat for sphere_1 through sphere_5)

responses.contact_N_request         — Contact N: information request
responses.retainer_N_task           — Retainer N: task description
responses.sorcery_N_rite            — Sorcery N: rite name
```

## Required Changes

### 1. CSV import must populate `responses`

In `public/js/downtime/db.js`, the `upsertCycle` function builds a `doc` object for each submission. Currently it sets `_raw` but not `responses`. Add a mapping function:

```
_raw.narrative.travel_description     → responses.travel
_raw.narrative.game_recount           → responses.game_recount
_raw.narrative.standout_rp            → responses.rp_shoutout
_raw.narrative.ic_correspondence      → responses.correspondence
_raw.narrative.most_trusted_pc        → responses.trust
_raw.narrative.actively_harming_pc    → responses.harm
_raw.narrative.aspirations            → responses.aspirations

_raw.regency.is_regent               → responses._gate_is_regent ("yes"/"no")
_raw.regency.territory               → responses.regent_territory
_raw.regency.regency_action          → responses.regency_action

_raw.feeding.method                   → responses._feed_method (needs normalisation to enum)
_raw.feeding.territories              → responses.feeding_territories (JSON stringify)

_raw.projects[i].action_type          → responses.project_{i+1}_action
_raw.projects[i].project_name         → responses.project_{i+1}_title
_raw.projects[i].desired_outcome      → responses.project_{i+1}_outcome
_raw.projects[i].detail               → responses.project_{i+1}_description
_raw.projects[i].primary_pool.expression → responses.project_{i+1}_pool_attr (or store raw)
_raw.projects[i].secondary_pool.expression → responses.project_{i+1}_pool2_attr (or store raw)
_raw.projects[i].characters           → responses.project_{i+1}_cast
_raw.projects[i].merits               → responses.project_{i+1}_merits
_raw.projects[i].xp_spend             → responses.project_{i+1}_xp

_raw.sphere_actions[i].merit_type     → responses.sphere_{i+1}_merit
_raw.sphere_actions[i].action_type    → responses.sphere_{i+1}_action
_raw.sphere_actions[i].desired_outcome → responses.sphere_{i+1}_outcome
_raw.sphere_actions[i].description    → responses.sphere_{i+1}_description

_raw.contact_actions.requests[i]      → responses.contact_{i+1}_request

_raw.retainer_actions.actions[i]      → responses.retainer_{i+1}_task

_raw.ritual_casting.casting           → responses.sorcery_1_rite (simplification)

_raw.meta.xp_spend                    → responses.xp_spend
_raw.meta.lore_questions              → responses.lore_request
_raw.meta.st_notes                    → responses.vamping
_raw.meta.form_comments               → responses.form_feedback
```

Keep `_raw` as archival backup. The `responses` object becomes the single read path.

### 2. Admin panel reads from `responses` only

`renderPlayerResponses(s)` already reads from `s.responses` correctly for court, feeding, projects, sorcery, equipment, and misc fields. Once CSV import populates `responses`, this function handles both paths.

`renderProjectsPanel(s, raw, char)` currently reads from `s._raw.projects`. It should fall back to or prefer `s.responses.project_N_*` fields. Alternatively, since `renderPlayerResponses` already renders project summaries from `responses`, the two rendering paths could be unified — but this is a larger refactor.

**Pragmatic approach**: keep `renderProjectsPanel` for the detailed roll/resolve workflow (it needs the structured project objects for pool building), but have it construct its project list from `responses` when `_raw.projects` is absent.

### 3. Action type normalisation

The CSV parser already normalises action types via `normaliseActionType()` (e.g. "XP Spend: Grow your character" → "xp_spend"). The form uses the enum values directly. Both should produce the same enum value in `responses.project_N_action`.

The CSV parser stores both `action_type` (normalised) and `action_type_raw` (original). Map the normalised value to `responses`.

### 4. Pool data from CSV

The CSV has free-text pool expressions like "Presence 4 + Intimidation 4 + Spec(Veiled threat) 1 + Air of Menace 2 + Nightmare 4 = 15". The form stores structured pool components (`pool_attr`, `pool_skill`, `pool_disc`).

For CSV imports, store the raw expression in a single field (e.g. `responses.project_N_pool_expr`) since it can't be cleanly decomposed into attr/skill/disc. The admin panel's pool builder UI won't auto-populate from CSV data — the ST builds the pool manually using the text as reference.

### 5. Feeding method normalisation

CSV feeding method is a free-text description. The form uses enum IDs. Add a normaliser similar to `normaliseActionType`:
- "seduction" / "seduced" → "seduction"
- "stalking" / "stalked" / "hunted" → "stalking"
- "force" / "by force" / "attacked" → "force"
- etc.

If no match, store as "other" and keep the raw text in `responses.feeding_description`.

### 6. Character ID in shoutout picks

The form stores `rp_shoutout` as a JSON array of character `_id` strings. The CSV has free-text character names. On import, attempt to resolve names to IDs using the same `findCharacter()` fuzzy matcher, then store the ID array in `responses.rp_shoutout`. Unresolved names should be stored as-is (the rendering code already handles non-ID strings by falling back to display).

### 7. Territory grid normalisation

The form stores `feeding_territories` as a JSON object: `{ "the_academy": "resident", "the_docklands": "poach" }`.

The CSV parser stores individual territory columns as `_raw.feeding.territories["The Academy"]` with values like "Resident", "Poaching", "Not feeding here".

Map:
```
"The Academy"      → key: "the_academy"
"The City Harbour"  → key: "the_city_harbour"
"The Docklands"     → key: "the_docklands"
"The Second City"   → key: "the_second_city"
"The Northern Shore" → key: "the_northern_shore"
"The Barrens"       → key: "the_barrens__no_territory_"

"Resident"          → value: "resident"
"Poaching"          → value: "poach"
"Feeding"           → value: "feed"
"Not feeding here"  → value: "none"
```

### Files to modify

| File | Change |
|------|--------|
| `public/js/downtime/db.js` | Add `mapRawToResponses(parsed)` function, call it in `upsertCycle` to populate `doc.responses` |
| `public/js/downtime/parser.js` | May need minor tweaks to normalise feeding method, territory keys |
| `public/js/admin/downtime-views.js` | `renderProjectsPanel` should fall back to `responses` when `_raw.projects` absent; court/narrative data now renders via `renderPlayerResponses` for both paths |
| `server/schemas/downtime_submission.schema.js` | No change needed — schema already defines all the flat keys |

### Testing

- Import a CSV → verify court section (travel, recount, correspondence) appears in admin panel
- Import a CSV → verify projects show in both the Player Submission panel and the Projects panel
- Submit via player form → verify same panels show the same data
- Import then re-submit via form → verify form data overwrites CSV data cleanly (no ghost fields)
- Verify `_raw` is still preserved for archival after the mapping

### Scope notes

- This story does NOT change the player portal form — it already writes the correct shape
- This story does NOT migrate historical submissions — existing CSV imports will still have empty `responses` unless re-imported
- `_raw` is kept as-is — it's the archival copy of the original CSV parse
- The `renderProjectsPanel` pool builder / roll workflow continues to work with its existing data structures — this story just ensures the data is present in both `responses` (for display) and `_raw` (for the roll workflow)
