export const ruleGrantSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'TM Rule Grant',
  type: 'object',
  // Universally required. Per-grant_type extras are enforced via allOf below.
  required: ['source', 'grant_type', 'amount_basis'],
  additionalProperties: false,

  properties: {
    source:               { type: 'string', minLength: 1 },
    tier:                 { type: 'integer', minimum: 1, maximum: 5 },
    condition:            { type: 'string', enum: ['always', 'tier', 'choice', 'pact_present', 'bloodline', 'fighting_style_present'] },
    grant_type:           { type: 'string', enum: ['merit', 'pool', 'speciality', 'auto_bonus', 'status_floor', 'style_pool'] },
    target:               { type: 'string', minLength: 1 },
    target_field:         { type: 'string', minLength: 1 },
    target_qualifier:     { type: 'string' },
    target_category:      { type: 'string' },
    bloodline_name:       { type: 'string' },
    amount:               { type: 'integer', minimum: 0 },
    amount_basis:         { type: 'string', enum: ['flat', 'rating_of_source', 'rating_of_partner_merit', 'rating_of_status'] },
    pool_targets:         { type: 'array', items: { type: 'string', minLength: 1 } },
    partner_merit_names:  { type: 'array', items: { type: 'string', minLength: 1 } },
    partner_status_names: { type: 'array', items: { type: 'string', minLength: 1 } },
    auto_create:          { type: 'boolean' },
    sphere_source:        { type: 'string' },
    choice_field:         { type: 'string' },
    excluded_choice:      { type: 'string' },
    read_refs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'name'],
        additionalProperties: false,
        properties: {
          kind:      { type: 'string', enum: ['attribute', 'skill', 'merit', 'discipline', 'derived_stat'] },
          name:      { type: 'string', minLength: 1 },
          predicate: { type: 'string' },
          value:     { type: 'number' },
        },
      },
    },
    notes:      { type: 'string' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    // Fix (live bug report, 2026-09-09 — Friends with Benefits over-granting Feeding Grounds
    // dots after the Sway merge widened what rating_of_partner_merit sums across): an optional
    // ceiling on an auto_bonus grant's computed amount. Same shape as rule_skill_bonus's own
    // cap_at, deliberately — same concept, same field name, no new convention invented.
    cap_at: { type: 'integer', minimum: 1 },

    // ── N-1 / ADR-005 Rev 2 additions ──
    // `source_slug` is the canonical short identifier for the source (e.g. 'mci',
    // 'lk', 'inv', 'vm', 'bloodline', 'retainer', 'necropolis_sepulcher').
    // Used as the key in `m.free_grants[slug]` and as the lookup key in
    // `shareableSumForMerit`. Optional today — only seeded on rule_grant docs
    // that need flag-driven reads (Collective Compound + the UNION-baseline
    // seed for LK/Inv/VM/MCI/Bloodline/Retainer).
    source_slug: { type: 'string', minLength: 1 },
    // Whether this source's granted dots count toward partner-shareable totals
    // when the target merit is a shared domain merit. Default false on read.
    // N-1 consults this ONLY for NEW Collective Compound code paths; the
    // hardcoded subsets at `domain.js#domMeritShareableSingle` and
    // `server/routes/characters.js` partner-enrichment STAY VERBATIM per
    // Concern #1 Rev 2 (divergence preserved until the future MNEC-prerequisite
    // audit).
    partner_shareable: { type: 'boolean' },
    // Discriminator-typed object generalising sharing-scope. First two variants
    // (Rev 2): { type: 'partner_explicit' } and
    // { type: 'collective_owners_of_merit', merit, min_dots }. Future variants
    // (covenant / clan / bloodline membership, etc.) extend the `type` enum and
    // carry their own neighbouring fields rather than overloading.
    sharing_scope: {
      type: 'object',
      required: ['type'],
      properties: {
        type:     { type: 'string', enum: ['partner_explicit', 'collective_owners_of_merit'] },
        merit:    { type: 'string', minLength: 1 },
        min_dots: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },

  allOf: [
    {
      if:   { properties: { grant_type: { const: 'pool' } }, required: ['grant_type'] },
      then: { required: ['pool_targets'] },
    },
    {
      if:   { properties: { grant_type: { const: 'auto_bonus' } }, required: ['grant_type'] },
      then: { required: ['target', 'target_field'] },
    },
    {
      if:   { properties: { grant_type: { enum: ['merit', 'speciality', 'status_floor', 'style_pool'] } }, required: ['grant_type'] },
      then: { required: ['target', 'amount'] },
    },
  ],
};
