/**
 * JSON Schema (Draft-07) for player-to-player contested roll requests.
 * Collection: contested_roll_requests
 *
 * Validated on POST (challenge creation). Status, outcome, timestamps
 * are set server-side and not included in this schema.
 *
 * crd.1: this collection is shared with Status Actions (`request_type:
 * 'status_action'`), which bypass this schema entirely via a direct insert in
 * office-actions.js. Contested rolls now carry their own explicit
 * `request_type: 'contested_roll'` discriminator rather than being identified
 * by the ABSENCE of one — see the note on that property below.
 */

export const contestedRollRequestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'TM Contested Roll Request',
  type: 'object',
  required: [
    'challenger_character_id',
    'challenger_character_name',
    'target_character_id',
    'target_character_name',
    'roll_type',
    'challenger_pool',
  ],
  additionalProperties: false,
  properties: {
    challenger_character_id:   { type: 'string', minLength: 1 },
    challenger_character_name: { type: 'string', minLength: 1 },
    target_character_id:       { type: 'string', minLength: 1 },
    target_character_name:     { type: 'string', minLength: 1 },
    // crd.1: NOT required. Omitting it is still valid for any caller that
    // doesn't set it; contested-rolls.js's own POST / always sets it
    // explicitly on the inserted document (mirroring office-actions.js's
    // `request_type: 'status_action'`), so the enum here exists to stop a
    // client asserting any OTHER type through this route.
    request_type: { type: 'string', enum: ['contested_roll'] },
    // roll_type categorises the CONTEST for session-log/display purposes.
    // It is a different axis from defender_aspect below (which Resistance
    // Attribute feeds the defender's pool) — do not derive one from the other.
    roll_type:    { type: 'string', enum: ['territory', 'social', 'resistance', 'custom'] },
    challenger_pool: { type: 'integer', minimum: 0, maximum: 30 },
    // crd.1: no longer REQUIRED. It used to be attacker-submitted at creation
    // time, which meant the opposing player asserted the defender's own
    // resistance number with no defender input at any point before the dice
    // were rolled. It becomes server-computed at resolution time (crd.3a); a
    // pending challenge between creation and resolution genuinely has none.
    defender_pool:   { type: 'integer', minimum: 0, maximum: 30 },
    // crd.1: the defender's SUBMITTED resolution choices. All optional at
    // creation — they are only ever populated later, by crd.3a's resolve
    // endpoint, never by POST /. Listed here (rather than left to fall
    // through) because additionalProperties: false still holds.
    defender_aspect:    { type: 'string', enum: ['mental', 'social', 'physical'] },
    // Boolean, not an integer: the real Willpower rule caps a spend at one
    // point per action, so the only question is whether it was spent.
    defender_wp_spent:  { type: 'boolean' },
    defender_merit_ids: { type: 'array', items: { type: 'string' } },
    power_name:   { type: 'string' },
  },
};
