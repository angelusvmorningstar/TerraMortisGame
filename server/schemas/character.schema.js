/**
 * JSON Schema (Draft-07) for TM Character v3.
 *
 * This schema enforces structural correctness — types, required fields,
 * enum values, and array/object shapes. It does NOT enforce business rules
 * such as XP arithmetic, CP budgets, or merit prerequisites.
 * Those require a separate audit layer.
 *
 * v3 changes (PP.9): creation tracking is now inline on each object.
 *   - attr_creation, skill_creation, disc_creation, merit_creation removed
 *   - Attributes, skills, disciplines, merits each embed cp/xp/free + rule_key
 *   - Powers and fighting styles gain rule_key
 *   - Disciplines changed from integer to object { dots, cp, xp, free, rule_key }
 *
 * Known legacy fields still present in real data (not rejected, just tolerated):
 *   - fighting_styles[].up (old alias for free, from Excel import)
 *   - merits[].benefit_grants (old MCI format, pre-migration)
 */

/**
 * Derive a partial-update schema: same type/shape validation but no required fields.
 * Used for PUT (partial $set updates) where only some fields are sent.
 */
function derivePartialSchema(schema) {
  const clone = JSON.parse(JSON.stringify(schema));
  clone.title += ' (partial)';
  delete clone.$schema;
  (function stripRequired(obj) {
    if (!obj || typeof obj !== 'object') return;
    delete obj.required;
    for (const v of Object.values(obj)) stripRequired(v);
  })(clone);
  return clone;
}

/**
 * The five clans, exported so sibling schemas reuse the exact list instead of
 * copying it (BL-1, issue #1008 — `bloodline.schema.js` imports this).
 *
 * `characters.clan` additionally tolerates '' and null, because a character
 * can exist before their clan is set. A bloodline always belongs to a real
 * clan, so bloodline.schema.js uses this array unmodified.
 */
export const CLAN_NAMES = ['Daeva', 'Gangrel', 'Mekhet', 'Nosferatu', 'Ventrue'];

export const characterSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'TM Character v3',
  type: 'object',
  required: ['name'],
  additionalProperties: false,

  properties: {

    // ── Identity ──────────────────────────────────────────────
    name:         { type: 'string', minLength: 1 },
    player:       { type: ['string', 'null'] },
    moniker:      { type: ['string', 'null'] },
    honorific:    { type: ['string', 'null'] },
    concept:      { type: ['string', 'null'] },
    pronouns:     { type: ['string', 'null'] },
    apparent_age:    { type: ['string', 'null'] },
    features:        { type: ['string', 'null'] },
    date_of_embrace: { type: ['string', 'null'] },
    retired:          { type: 'boolean' },
    pending_approval: { type: 'boolean' },
    created_at:       { type: 'string' },
    current:          { type: ['object', 'null'], additionalProperties: true },

    // ── TM Admin interop (added 2026-08-25, TM Admin Story 2.2b) ──────────────
    //
    // TM Admin's own character editor (its PUT /api/characters/:id) writes these
    // six fields to the SAME `characters` collection this schema governs. They
    // are declared HERE, in TM Game, purely so this app keeps working: `admin.js`
    // buildSaveBody() PUTs the whole document back, so once TM Admin has written
    // one of these to a character, an undeclared key would make every subsequent
    // save from TM Game's own admin editor fail `additionalProperties: false`
    // with a 400. Nothing in TM Game reads or writes them.
    //
    // Two of the six are NOT new behaviour at all — they are pre-existing holes
    // this pass closed:
    //   * `updated_at` was already stored on 2 live characters, so a full-document
    //     save of either of those two ALREADY 400'd against this schema.
    //   * `st_mods_suppressed` is written by BOTH apps' own
    //     PATCH /:id/st_mods_suppressed and was never declared in either.
    //
    // Angelus approved this addition directly (2026-08-25) as the cheap insurance
    // while TM Game's admin editor is still live.
    updated_at:         { type: 'string' },
    st_mods_suppressed: { type: 'boolean' },
    // TM Admin makes the hardcoded starting-XP 10 an overridable default.
    xp_starting_override: { type: ['integer', 'null'], minimum: 0 },

    clan: {
      type: ['string', 'null'],
      enum: [...CLAN_NAMES, '', null]
    },
    bloodline:   { type: ['string', 'null'] },
    clan_attribute: { type: ['string', 'null'] },

    covenant: {
      type: ['string', 'null'],
      enum: [
        'Carthian Movement', 'Circle of the Crone', 'Invictus',
        'Lancea et Sanctum', 'Ordo Dracul', 'Unaligned', '', null
      ]
    },

    mask:        { type: ['string', 'null'] },
    dirge:       { type: ['string', 'null'] },
    court_title:    { type: ['string', 'null'] },
    // The HEADLINE office only, and deliberately a single field. The per-seat
    // truth lives in `office_seats.holder_id`; this pair is what the app
    // displays and gates on. `server/lib/court-category.js`'s
    // `deriveCourtCategory` computes both, in seniority order (Head of State >
    // Primogen > Administrator > Socialite > Enforcer), and
    // `PUT /api/office_seats/:seatId/holder` is the one route that writes them.
    //
    // prax.0: one character may now legitimately hold TWO seats at once, Head
    // of State plus Primogen (a Praxis winner keeps a Primogen seat they
    // already held). For that character this field reads "Head of State" while
    // a Primogen seat's `holder_id` is still theirs, permanently and by design.
    // That disagreement is correct, not drift; do not "repair" it, and do not
    // add a uniqueness assumption that a holder has at most one seat.
    court_category: { type: ['string', 'null'], enum: ['Head of State', 'Primogen', 'Administrator', 'Socialite', 'Enforcer', '', null] },
    home_territory: { type: ['string', 'null'] },
    dt_story_calibration: { type: ['string', 'null'] },

    // NPC stub register — placeholder until full NPC Register epic
    npcs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:               { type: 'string' },
          name:             { type: 'string' },
          relationship_type: { type: 'string' },
          available:        { type: 'boolean' },
          touchstone_eligible: { type: 'boolean' },
          location_context: { type: ['string', 'null'] },
          interaction_type: { type: 'string', enum: ['in_person', 'correspondence', 'other'] },
          interaction_history: { type: 'array' },
        },
      },
    },

    // regent_territory / regent_lieutenant removed — regent status is
    // now derived from the territories collection (regent_id field).

    // ── Core Stats ────────────────────────────────────────────
    blood_potency: { type: 'integer', minimum: 0, maximum: 10 },
    bp_creation:   { type: 'object', properties: { cp: { type: 'integer', minimum: 0 }, xp: { type: 'integer', minimum: 0 }, lost: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    humanity:      { type: 'integer', minimum: 0, maximum: 10 },
    humanity_base: { type: 'integer', minimum: 0, maximum: 10 },
    humanity_lost: { type: 'integer', minimum: 0 },
    humanity_xp:   { type: 'integer', minimum: 0 },

    // TM Admin interop (see the block above). TM Admin splits humanity loss into
    // a creation component (earns 2 XP per dot) and an in-play one (earns none),
    // because this app's own xpHumanityDrop() awards 2 XP for EVERY dot lost
    // whenever lost — which is what the "Failed Breakpoint" merit exists to
    // cancel. `humanity_lost` above is UNCHANGED and remains the pre-split total
    // for the 15 live characters that carry it; nothing is migrated automatically,
    // since guessing the split would either invent XP or destroy it. Nullable so
    // "not yet allocated" is storable and distinct from 0.
    humanity_lost_creation: { type: ['integer', 'null'], minimum: 0 },
    humanity_lost_play:     { type: ['integer', 'null'], minimum: 0 },
    // xp_total / xp_spent removed in #837 (Option A) — XP values are
    // derived at render time via public/js/editor/xp.js
    // (xpEarned() / xpSpent() / xpLeft()). additionalProperties:false on
    // this schema rejects any incoming PUT that still tries to send them.

    // ── Status ────────────────────────────────────────────────
    status: {
      type: 'object',
      properties: {
        city: { type: 'integer', minimum: 0, maximum: 10 },
        clan: { type: 'integer', minimum: 0, maximum: 5 },
        covenant: {
          type: 'object',
          properties: {
            'Carthian Movement':    { type: 'integer', minimum: 0, maximum: 5 },
            'Circle of the Crone':  { type: 'integer', minimum: 0, maximum: 5 },
            'Invictus':             { type: 'integer', minimum: 0, maximum: 5 },
            'Lancea et Sanctum':    { type: 'integer', minimum: 0, maximum: 5 },
            'Ordo Dracul':          { type: 'integer', minimum: 0, maximum: 5 },
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },

    // ── Willpower conditions ──────────────────────────────────
    // Fields are absent when not yet filled in — never null.
    willpower: {
      type: 'object',
      properties: {
        mask_1wp:  { type: 'string' },
        mask_all:  { type: 'string' },
        dirge_1wp: { type: 'string' },
        dirge_all: { type: 'string' }
      },
      additionalProperties: false
    },

    aspirations: { type: 'array', items: { type: 'string' } },

    // ── Attributes ────────────────────────────────────────────
    // All nine must be present; each is { dots, bonus }.
    attributes: {
      type: 'object',
      required: [
        'Intelligence','Wits','Resolve',
        'Strength','Dexterity','Stamina',
        'Presence','Manipulation','Composure'
      ],
      properties: {
        Intelligence: { $ref: '#/definitions/attrObj' },
        Wits:         { $ref: '#/definitions/attrObj' },
        Resolve:      { $ref: '#/definitions/attrObj' },
        Strength:     { $ref: '#/definitions/attrObj' },
        Dexterity:    { $ref: '#/definitions/attrObj' },
        Stamina:      { $ref: '#/definitions/attrObj' },
        Presence:     { $ref: '#/definitions/attrObj' },
        Manipulation: { $ref: '#/definitions/attrObj' },
        Composure:    { $ref: '#/definitions/attrObj' }
      },
      additionalProperties: false
    },

    // ── Attribute priorities ─────────────────────────────────
    attribute_priorities: {
      type: 'object',
      properties: {
        Mental:   { type: 'string', enum: ['Primary', 'Secondary', 'Tertiary'] },
        Physical: { type: 'string', enum: ['Primary', 'Secondary', 'Tertiary'] },
        Social:   { type: 'string', enum: ['Primary', 'Secondary', 'Tertiary'] }
      },
      additionalProperties: false
    },

    // ── Skills ────────────────────────────────────────────────
    // Sparse: only skills with dots/bonus/specs present. Each is { dots, bonus, specs, nine_again }.
    skills: {
      type: 'object',
      additionalProperties: { $ref: '#/definitions/skillObj' }
    },

    skill_priorities: {
      type: 'object',
      properties: {
        Mental:   { type: 'string', enum: ['Primary', 'Secondary', 'Tertiary'] },
        Physical: { type: 'string', enum: ['Primary', 'Secondary', 'Tertiary'] },
        Social:   { type: 'string', enum: ['Primary', 'Secondary', 'Tertiary'] }
      },
      additionalProperties: false
    },

    // ── Disciplines ───────────────────────────────────────────
    // v3: each discipline is now { dots, cp, xp, free, rule_key } instead of integer
    disciplines: {
      type: 'object',
      additionalProperties: { $ref: '#/definitions/discObj' }
    },

    // ── Powers ────────────────────────────────────────────────
    powers: {
      type: 'array',
      items: { $ref: '#/definitions/power' }
    },

    // ── Merits ────────────────────────────────────────────────
    merits: {
      type: 'array',
      items: { $ref: '#/definitions/merit' }
    },

    // ── Fighting styles & picks ───────────────────────────────
    fighting_styles: {
      type: 'array',
      items: { $ref: '#/definitions/fightingStyle' }
    },

    // Character-level flat pick list (new — replaces per-style picks array).
    fighting_picks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['manoeuvre'],
        properties: {
          manoeuvre: { type: 'string', minLength: 1 }
        },
        additionalProperties: false
      }
    },

    // ── Touchstones ───────────────────────────────────────────
    // NPCR.4: slot array, max 6. Each entry has a humanity rating
    // (assigned descending from the anchor: 7 for Ventrue, 6 else),
    // a name and optional desc. Free-text only, no edge_id — DBO-8
    // (2026-08-14) retired the old edge_id link to a `relationships` doc
    // (issue #162 had removed its only creation path; 0/44 live touchstones
    // used it). This slot stays unlinked; a separate `relationships`
    // document with kind='touchstone' can still exist alongside it
    // (restored 2026-08-15, see relationship.schema.js) — the two are not
    // joined by any id.
    touchstones: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['humanity', 'name'],
        properties: {
          humanity: { type: 'integer', minimum: 1, maximum: 10 },
          name:     { type: 'string' },
          // desc is absent when not yet written — never null
          desc:     { type: 'string' }
        },
        additionalProperties: false
      }
    },

    // ── Banes ─────────────────────────────────────────────────
    banes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:   { type: 'string' },
          effect: { type: 'string' }
        },
        additionalProperties: false
      }
    },

    // ── Ordeals ───────────────────────────────────────────────
    ordeals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name:     { type: 'string' },
          complete: { type: 'boolean' },
          xp:       { type: 'number' },
          // TM Admin interop. NOT an enforcement change — `additionalProperties:
          // true` below already admits it. Declared so the field is documented:
          // TM Admin derives ordeal completion from its own Ordeals domain and
          // lets an ST additionally ASSERT one complete. `st_asserted` is a
          // separate flag from `complete`, never a substitute for it.
          st_asserted: { type: 'boolean' }
        },
        additionalProperties: true
      }
    },

    // ── Player Preferences (#542) ─────────────────────────────
    player_prefs: {
      type: 'object',
      properties: {
        combat_action:            { type: 'object', properties: { rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 } }, additionalProperties: false },
        horror_dread:             { type: 'object', properties: { rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 } }, additionalProperties: false },
        institutional_corruption: { type: 'object', properties: { rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 } }, additionalProperties: false },
        mysticism_mystery:        { type: 'object', properties: { rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 } }, additionalProperties: false },
        personal_story:           { type: 'object', properties: { rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 } }, additionalProperties: false },
        political_intrigue:       { type: 'object', properties: { rating: { type: ['integer', 'null'], minimum: 1, maximum: 5 } }, additionalProperties: false },
        updated_at:               { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },

    // ── Influence balance (monthly income accumulator) ────────
    influence_balance: { type: 'number', minimum: 0 },

    // ── Equipment (EQ-1, issue #654; ECM-3 #870 — catalogue_id ObjectId) ──
    // Lean refs into the equipment_catalogue collection — full stats resolved
    // at render time. `catalogue_id` is an ObjectId on disk and a 24-hex
    // string on the wire (the standard JSON serialisation). Server-side
    // coercion at write sites (PUT /:id, POST /:id/equipment) hydrates the
    // wire string back to an ObjectId before $set — see
    // specs/epic-ecm-equipment-catalogue-migration.md and Khepri's ECM-3
    // dispatch for the rationale (the coercion is canonical Express+Mongo
    // hygiene, not transitional kludge — it stays after ECM-4/5 ship).
    //
    // `container_id` (EQC-1, issue #1152, epic #1038) — null/absent means
    // this item is loose (carried on the character, not stored inside
    // anything). When set, it is INTENDED to be the `catalogue_id` of ANOTHER
    // entry in this SAME character's `equipment[]` array whose catalogue
    // bucket is `container` (a haven, vehicle, safe, etc.) — "a property
    // contains a security system... never a bonus on the asset".
    // Single-level ONLY, as a stated design intent for v1 (the epic's own
    // examples - a safe inside a haven - are all single-level, and recursive
    // containment is real added complexity with no stated requirement yet) -
    // but that intent is NOT currently enforced anywhere in code.
    //
    // NOT VALIDATED AS A REFERENCE ANYWHERE YET (Codex external review,
    // 2026-08-13, confirmed by direct inspection of the PUT /:id and
    // POST /:id/equipment write paths in server/routes/characters.js): a
    // dangling reference, a self-reference, a reference to a non-container
    // item, or a multi-level chain are all accepted and stored as-is today.
    // This is currently harmless in practice because NOTHING reads
    // `container_id` anywhere in this codebase yet (no containment-aware UI
    // exists - that is EQC-3's job) - but the field is NOT "display-inert on
    // bad data" by any enforced guarantee, only by the accident of having no
    // reader yet. Whoever builds the first `container_id` consumer (EQC-3 or
    // later) MUST add real reference/topology validation at that point,
    // either at the write route or defensively at the read site - do not
    // assume this comment's stated intent is already backed by code.
    //
    // Known modelling gap, not yet resolved: `catalogue_id` alone cannot
    // distinguish two equipment-array entries that reference the SAME
    // container catalogue item (e.g. two identical safes) - there is no
    // per-instance identity on an equipment[] row. A future container-UI
    // story will need to resolve this, likely by referencing the container's
    // array INDEX or introducing a per-row instance id, not by continuing to
    // key off catalogue_id.
    equipment: {
      type: 'array',
      default: [],
      items: {
        type: 'object',
        required: ['catalogue_id', 'state', 'acquired_cycle'],
        properties: {
          catalogue_id:    { type: 'string', pattern: '^[a-f0-9]{24}$' },
          state:           { type: 'string', enum: ['carried', 'worn', 'stashed', 'lost', 'active'] },
          acquired_cycle:  { type: 'integer', minimum: 0 },
          notes:           { type: ['string', 'null'] },
          container_id:    { type: ['string', 'null'], pattern: '^[a-f0-9]{24}$' },
        },
        additionalProperties: false,
      },
    },

    // ── Assets ────────────────────────────────────────────────
    // REMOVED 2026-06-19 — consolidated into equipment[] via the catalogue's
    // bucket: 'asset' items (Vehicle (Luxury), Safe House, etc.). The previous
    // free-text assets[] storage shape collided with the catalogue's 'asset'
    // bucket name and split asset-class items across two arrays. Equipment[]
    // is the single home for all bucket types now. See chat 2026-06-19.

    // ── XP log ────────────────────────────────────────────────
    xp_log: {
      type: 'object',
      properties: {
        earned: { type: 'object', additionalProperties: { type: 'number' } },
        spent:  { type: 'object', additionalProperties: { type: 'number' } }
      },
      additionalProperties: false
    }
  },

  // ── Definitions ─────────────────────────────────────────────────────────────

  definitions: {

    // ── "One true rating" Stage 1, Phase A (TM Admin Story tm-admin.10.1,
    // 2026-08-31) — `bonus` is WRITE-FROZEN across all four definitions
    // below (attrObj, skillObj, discObj, merit). It still holds whatever
    // value it already carried before this freeze (real, nonzero values
    // genuinely exist live today — e.g. Jack Fallow's and Charles
    // Mercer-Willows's Presence, per
    // `TM Admin/specs/audits/rules-engine-and-mods-audit.md`), and every
    // existing read path (`getAttrEffective`, `skTotal`, `discDots`,
    // `meritEffectiveRating`) still sums `dots`/`rating` + `bonus` exactly
    // as before — this freeze is write-side only, nothing here changes what
    // renders. No NEW code path may write a changed value into `bonus`,
    // full stop. This is the interim step before Story 10.2 folds every
    // existing `bonus` value into `dots`/`rating` and drops the field
    // entirely; `bonus` is not removed here, only frozen.
    //
    // The only two audit-confirmed exceptions (both live-rule relationships
    // that must keep tracking another trait's *current* dots, which a
    // one-time fold cannot represent) are named in
    // `server/scripts/rules-verify/bonus-write-allowlist.json` and enforced
    // by `server/scripts/rules-verify/verify-no-bonus-writes.js` — both
    // exceptions are TM-Admin-side (Mantle of Amorous Fire's raw-write
    // script; Faith Militant's currently-unbuilt equivalent), not TM
    // Game's own code, so a clean TM Game repo has zero write sites to any
    // of the four `bonus` fields below.
    //
    // `free` REMOVED 2026-08-31 (code review, "one true rating" investigation): confirmed
    // vestigial for BOTH attributes and skills - grepped every render/mechanical code path in
    // both this repo and TM Admin's own port, zero live reads of attrObj.free or skillObj.free
    // anywhere. Unlike discObj.free (below), which IS genuinely read/displayed
    // (discBonusSources/discCard, TM Admin's characters.js) and stays. All 391 real attribute
    // instances and 630 real skill instances carrying the field were stripped from live data
    // in the same pass (dots untouched throughout - confirmed live, e.g. Charlie Ballsack's
    // Weaponry stays dots:5).
    // Story tm-admin.10.2a (2026-09-28): `bonus` is no longer REQUIRED here, matching skillObj and
    // discObj, which already treat it as optional. The property stays declared and
    // `additionalProperties` is unchanged, so no live document is affected. `required` is enforced
    // ONLY by the full schema (POST creation); every PUT uses the partial schema, which
    // derivePartialSchema() builds with `required` stripped at every depth.
    attrObj: {
      type: 'object',
      required: ['dots'],
      properties: {
        dots:     { type: 'integer', minimum: 0, maximum: 10 },
        // WRITE-FROZEN (see the block above `attrObj`). Holds whatever
        // value it already carried; no new code may change it.
        bonus:    { type: 'integer', minimum: 0 },
        cp:       { type: 'integer', minimum: 0 },
        xp:       { type: 'integer', minimum: 0 },
        rule_key: { type: ['string', 'null'] }
      },
      additionalProperties: false
    },

    skillObj: {
      type: 'object',
      required: ['dots'],
      properties: {
        dots:       { type: 'integer', minimum: 0, maximum: 5 },
        // WRITE-FROZEN (see the block above `attrObj`). Holds whatever
        // value it already carried; no new code may change it.
        bonus:      { type: 'integer', minimum: 0 },
        specs:      { type: 'array',   items: { type: 'string' } },
        nine_again: { type: 'boolean' },
        cp:         { type: 'integer', minimum: 0 },
        xp:         { type: 'integer', minimum: 0 },
        rule_key:   { type: ['string', 'null'] }
      },
      additionalProperties: false
    },

    discObj: {
      type: 'object',
      required: ['dots'],
      properties: {
        dots:     { type: 'integer', minimum: 0, maximum: 5 },
        // TM Admin interop (see the block near the top of `properties`). Brings
        // disciplines into line with attrObj and skillObj, which both already
        // declare `bonus`. Same semantics: bonus dots sit ALONGSIDE `dots` and
        // are not a purchase channel, so they are not summed into it. No
        // `maximum` on purpose — `dots` is capped at 5 because five is the rating
        // ceiling, and a bonus is what takes a trait past its own cap.
        //
        // WRITE-FROZEN (see the block above `attrObj`) as of Story
        // tm-admin.10.1. TM Game's own `accessors.discDots()` still doesn't
        // read this field at all (audit gap #7, left as-is — see
        // `TM Admin/specs/stories/tm-admin.10.1.tm-game-schema-freeze-bonus.story.md`
        // AC5) — that divergence is unrelated to the freeze and closes by
        // supersession once Story 10.2 drops the field entirely, not fixed
        // here.
        bonus:    { type: 'integer', minimum: 0 },
        cp:       { type: 'integer', minimum: 0 },
        xp:       { type: 'integer', minimum: 0 },
        free:     { type: 'integer', minimum: 0 },
        rule_key: { type: ['string', 'null'] }
      },
      additionalProperties: false
    },

    merit: {
      type: 'object',
      required: ['category', 'name'],
      properties: {
        category:      { type: 'string', enum: ['general', 'influence', 'domain', 'standing', 'manoeuvre'] },
        name:          { type: 'string', minLength: 1 },
        rating:        { type: 'integer', minimum: 0 },
        qualifier:     { type: 'string' },
        area:          { type: ['string', 'null'] },
        cult_name:     { type: ['string', 'null'] },
        role:          { type: ['string', 'null'] },
        asset_skills:  { type: 'array', items: { type: 'string' } },
        shared_with:   { type: 'array', items: { type: 'string' } },
        spheres:       { type: 'array', items: { type: 'string' } },
        // N-4 (MNEC, issue #696): White Ants — Territory slugs picked per dot.
        // Length-must-equal-rating is enforced at the route level (route can
        // pull the merit's rating from cp+xp+free); JSON schema only enforces
        // string-array shape since cross-field validation isn't representable here.
        territories:   { type: 'array', items: { type: 'string' } },
        granted_by:    { type: 'string' },
        active:        { type: 'boolean' },
        location:      { type: ['string', 'null'] }, // #506: street+suburb for Safe Place instances; carries across DT cycles
        narrow:        { type: ['string', 'boolean', 'null'] },
        ghoul:         { type: 'boolean' },
        derived:       { type: 'boolean' },
        // MCI per-dot choices
        dot1_choice:   { type: 'string', enum: ['speciality', 'merits'] },
        dot1_spec:     { type: 'string' },
        dot1_spec_skill: { type: 'string' },
        dot3_choice:   { type: 'string', enum: ['skill', 'merits'] },
        dot3_skill:    { type: 'string' },
        dot4_skill:    { type: 'string' },
        dot5_choice:   { type: 'string', enum: ['advantage', 'merits'] },
        dot5_text:     { type: 'string' },
        // MCI per-tier merit grants
        tier_grants: {
          type: 'array',
          items: {
            type: 'object',
            required: ['tier', 'name', 'category', 'rating'],
            properties: {
              tier:      { type: 'integer', minimum: 1, maximum: 5 },
              name:      { type: 'string', minLength: 1 },
              category:  { type: 'string' },
              rating:    { type: 'integer', minimum: 0, maximum: 5 },
              qualifier: { type: ['string', 'null'] }
            },
            additionalProperties: false
          }
        },
        benefit_grants:{ type: 'array' },
        // v3: inline creation tracking (formerly in merit_creation parallel array)
        cp:       { type: 'integer', minimum: 0 },
        xp:       { type: 'integer', minimum: 0 },
        free:     { type: 'integer', minimum: 0 },
        free_mci:       { type: 'integer', minimum: 0 },
        free_vm:        { type: 'integer', minimum: 0 },
        free_lk:        { type: 'integer', minimum: 0 },
        free_ohm:       { type: 'integer', minimum: 0 },
        free_inv:       { type: 'integer', minimum: 0 },
        free_attache:   { type: 'integer', minimum: 0 },
        free_pt:        { type: 'integer', minimum: 0 },
        free_mdb:       { type: 'integer', minimum: 0 },
        free_sw:        { type: 'integer', minimum: 0 },
        free_fwb:       { type: 'integer', minimum: 0 },
        free_bloodline: { type: 'integer', minimum: 0 },
        free_pet:       { type: 'integer', minimum: 0 },
        free_retainer:  { type: 'integer', minimum: 0 },
        free_carthian:  { type: 'integer', minimum: 0 }, // #508: Carthian Pull dot-allocation bonus
        // ── N-1 / ADR-005 Rev 2 (issue #670) ──
        // `free_grants` is the new slug-keyed channel map that replaces the 14
        // flat `free_<slug>` fields above. N-1 ships both shapes coexisting;
        // `meritFreeSum` sums the union. N-2 backfill moves persisted flat-field
        // data into the map and unsets the flat fields. Slugs MUST be stable:
        // renaming a slug after N-1 ships requires a data migration.
        free_grants:    { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
        // ── ADR-010 D1 / D8 (OATH-A, issue #1111) ──
        // The pledge made when a Swear By oath is sworn, persisted on the
        // OATH's merit row — not on the merits it encumbers. Both ends live
        // on the same character document, so one end must own it or they
        // desynchronise; the oath owns it because every write is
        // oath-triggered and dot-parity is a property of the oath.
        //
        // The reverse direction ("is this merit pledged, and to what?") is a
        // RENDER-TIME index rebuilt from c.merits, never persisted — the
        // project's never-store-derived rule applied to a relationship.
        //
        // Attachments reference merits by name + qualifier, NOT by array
        // index: c.merits is array-indexed and indices move under splice.
        // Name-based is the house convention (shared_with, attached_to).
        //
        // NOT `free_grants`: that is source-keyed with `minimum: 0` and
        // means dots GIVEN. A pledge is the inverse (dots owed), and
        // reusing free_grants would put pledged dots into every free-dot
        // sum in the codebase.
        sworn_by: {
          type: ['object', 'null'],
          required: ['dots_required', 'attachments'],
          properties: {
            // Snapshot of the oath's rating AT SWEAR TIME (D1b). Deliberately
            // not recomputed: for the derived-rating oaths (D4) the basis
            // moves, and a live-recomputed requirement would silently
            // invalidate a standing oath's parity every time Blood Potency
            // or Status changed.
            dots_required: { type: 'integer', minimum: 0 },
            attachments: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'dots'],
                properties: {
                  name:      { type: 'string', minLength: 1 },
                  qualifier: { type: ['string', 'null'] },
                  dots:      { type: 'integer', minimum: 1 },
                },
                additionalProperties: false,
              },
            },
            sworn_at: {
              type: ['object', 'null'],
              properties: {
                chapter_number: { type: ['integer', 'null'], minimum: 0 },
                iso:            { type: ['string', 'null'] },
              },
              additionalProperties: false,
            },
            // ADR-010 D6 — the append-only exit/restore log. OATH-A wrote an
            // empty array; OATH-B is its consumer and types it here.
            //
            // Append-only: nothing rewrites an earlier entry. An oath can be
            // sworn, broken, partly restored and re-sworn, and a single
            // mutable status field would lose that history — which is what
            // the deferred restoration work reconstructs the clock from.
            //
            // `chapter_number` is required on every event and may be null,
            // never absent. Nothing reads it in the shipped scope, which is
            // precisely why it is pinned at the schema: which chapter an oath
            // broke in is UNRECOVERABLE after the fact, and typing it here is
            // what makes the API round-trip prove it was persisted rather
            // than merely written to an in-memory fixture.
            //
            // A CHAPTER IS A MONTH, so the whole mechanic anchors on this
            // ordinal and there is no date arithmetic anywhere; `at` is a
            // provenance stamp, never a computation input.
            history: {
              type: 'array',
              items: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['event', 'reason', 'chapter_number'],
                    properties: {
                      event:          { type: 'string', enum: ['exited'] },
                      reason:         { type: 'string', enum: ['broken', 'abandoned', 'released_by_liege', 'fulfilled', 'st_void'] },
                      chapter_number: { type: ['integer', 'null'], minimum: 0 },
                      at:             { type: ['string', 'null'] },
                      by:             { type: ['object', 'null'], additionalProperties: true },
                    },
                    additionalProperties: false,
                  },
                  {
                    type: 'object',
                    required: ['event', 'dots', 'chapter_number'],
                    properties: {
                      event:          { type: 'string', enum: ['restored'] },
                      dots:           { type: 'integer', minimum: 1 },
                      chapter_number: { type: ['integer', 'null'], minimum: 0 },
                      at:             { type: ['string', 'null'] },
                      by:             { type: ['object', 'null'], additionalProperties: true },
                    },
                    additionalProperties: false,
                  },
                  {
                    // ADR-010 D6's example also shows a `sworn` entry. OATH-A
                    // does not write one (it rebuilds sworn_by wholesale on
                    // swear), but it is permitted so a future writer
                    // following the ADR is not rejected.
                    type: 'object',
                    required: ['event', 'chapter_number'],
                    properties: {
                      event:          { type: 'string', enum: ['sworn'] },
                      chapter_number: { type: ['integer', 'null'], minimum: 0 },
                      at:             { type: ['string', 'null'] },
                      by:             { type: ['object', 'null'], additionalProperties: true },
                    },
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          additionalProperties: false,
        },
        carthian_sphere: { type: ['string', 'null'] }, // #510: single sphere a Carthian dot pushed into an augmented Contacts merit (legacy single-dot; read on strip)
        carthian_spheres: { type: 'array', items: { type: 'string' } }, // #522: spheres Carthian Pull dots pushed into an augmented Contacts merit (multi-dot; for clean strip)
        // `attached_to` accepts EITHER legacy string-form (single-target, pre-Rev-2,
        // e.g. Haven / Mandragora Garden) OR the new object form for bridges
        // (Trap Door: { origin: 'Necropolis Sepulcher', destination: <Safe Place> }).
        // Every consumer reads via `normaliseAttachedTo(at)` (Concern #11) — no
        // raw reads. N-2 backfill promotes string-form to `{ destination }`.
        attached_to: {
          oneOf: [
            { type: 'string' },
            { type: 'null' },
            {
              type: 'object',
              required: ['destination'],
              properties: {
                origin:      { type: 'string', minLength: 1 },
                destination: { type: 'string', minLength: 1 },
                // N-5 (MNEC, issue #697) — Trap Door triple-anchor: the
                // Territory slug carrying the constraint for THIS Trap Door's
                // binding. Optional in the schema (Haven/Mandragora don't need
                // it); the route middleware requires it when the merit is
                // Trap Door specifically. "Is the Territory currently infected"
                // stays a render-time check per ADR-005 D7.
                territory:   { type: 'string', minLength: 1 },
              },
              additionalProperties: false,
            },
          ],
        },
        // Render-time synthesis of Collective Compound member names; NEVER
        // persisted. `buildSaveBody` (export-character.js) strips `_`-prefixed
        // merit fields before PUT/POST. Listed in the schema for completeness;
        // server validation accepts it but the save path keeps it from leaking.
        _collective_shared_with: { type: 'array', items: { type: 'string' } },
        rule_key: { type: ['string', 'null'] },
        // WRITE-FROZEN (see the block above `attrObj`) as of Story
        // tm-admin.10.1. Now mechanically enforced for merits too, matching
        // the attribute/skill channels: `shAdjMeritBonus`
        // (`public/js/editor/edit.js:599-608`), the merit-bonus stepper
        // (`feature.333`/`feature.335`, deliberately out of STM-14's own
        // scope per `specs/qa/gates/1034.1-stm-14-audited-adhoc-bonus.yml:106`)
        // that wrote a changed value into this field directly and unaudited,
        // was retired by TM Admin Story tm-admin.10.1b. Ad hoc merit bonuses
        // now go through the same audited `st_mods` apply-affordance flow
        // the attribute/skill channels already used (`merits.N.bonus` on the
        // server's dynamic stat-path regex, `server/routes/st_mods.js`). The
        // THIRD, TEMPORARY allowlist entry Story tm-admin.10.1 added (with
        // Angelus's explicit sign-off, 2026-08-31) for the interim was
        // removed once 10.1b landed — the guard is back to its original two
        // durable, audit-confirmed exceptions. See tm-admin.10.1's and
        // tm-admin.10.1b's own Dev Agent Records for the full account.
        bonus:    { type: 'integer', minimum: 0 }
      },
      additionalProperties: false
    },

    power: {
      type: 'object',
      required: ['category', 'name'],
      properties: {
        category:  { type: 'string', enum: ['discipline', 'devotion', 'rite', 'pact'] },
        name:      { type: 'string', minLength: 1 },
        discipline:{ type: 'string' },
        rank:      { type: 'integer', minimum: 1, maximum: 5 },
        level:     { type: 'integer', minimum: 1 },
        // stats is absent on pact/rite powers — never null
        stats:     { type: 'string' },
        pool_size: { type: ['integer', 'null'] },
        effect:    { type: 'string' },
        tradition:    { type: 'string' },
        free:         { type: 'boolean' },
        // Mandragora Garden parking — Cruac rites only. When true, the rite is
        // sustained by the garden across downtimes; player form auto-prefills it.
        mandragora_parked: { type: 'boolean' },
        // Pact-specific fields
        cp:                { type: 'integer', minimum: 0 },
        xp:                { type: 'integer', minimum: 0 },
        ohm_skills:        { type: 'array', items: { type: 'string' }, maxItems: 2 },
        ohm_allies_sphere: { type: ['string', 'null'] },
        partner:           { type: ['string', 'null'] },
        shared_merit:      { type: ['string', 'null'] },
        // v3: reference to purchasable_powers key
        rule_key:          { type: ['string', 'null'] }
      },
      additionalProperties: false
    },

    fightingStyle: {
      type: 'object',
      required: ['name'],
      properties: {
        name:      { type: 'string', minLength: 1 },
        type:      { type: 'string', enum: ['style', 'merit'] },
        cp:        { type: 'integer', minimum: 0 },
        xp:        { type: 'integer', minimum: 0 },
        free:      { type: 'integer', minimum: 0 },
        free_mci:  { type: 'integer', minimum: 0 },
        free_ots:  { type: 'integer', minimum: 0 },
        // Legacy field from Excel import — tolerated
        up:        { type: 'integer', minimum: 0 },
        // Legacy per-style picks — tolerated during migration to fighting_picks
        picks:     { type: 'array', items: { type: 'string' } },
        // v3: reference to purchasable_powers key
        rule_key:  { type: ['string', 'null'] }
      },
      additionalProperties: false
    }
  }
};

/** Partial schema for PUT — validates types/shapes but no field is required. */
export const characterPartialSchema = derivePartialSchema(characterSchema);
