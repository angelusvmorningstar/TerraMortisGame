import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getCollection } from '../db.js';
import { requireRole, isStRole } from '../middleware/auth.js';
import { validateCharacter, validateCharacterPartial } from '../middleware/validateCharacter.js';
import { normalizeMeritsMiddleware, normalizeCharacterMerits, validateWhiteAntsTerritoriesMiddleware, validateTrapDoorAnchorMiddleware } from '../lib/normalize-character.js';
import { diffXpLedgerRows } from '../lib/xp-ledger-diff.js';
// tm-admin.10.5: the pure trait-`bonus` strip, shared with the editor's save paths (and kept
// textually parallel with TM Admin's server/lib/strip-trait-bonus.js).
import { withoutTraitBonus } from '../../public/js/data/strip-trait-bonus.js';
// N-1 (ADR-005 Rev 2): map-fallback shape for per-slug reads. Used in the
// partner-dots enrichment below so the server's hardcoded subset survives
// the N-2 backfill from `m.free_<slug>` to `m.free_grants.<slug>`. The
// SUBSET ITSELF (mci + bloodline + retainer) is preserved verbatim per
// Concern #1 Rev 2 — divergence with the client's mci-only subset stays.
import { freeOf, resolveSharingScope } from '../../public/js/data/rules-helpers.js';
// BL-5 (#1008): clan and bloodline are write-once. The decision is pure and
// lives in its own module (the bloodline-delete-guard.js precedent); only the
// wiring is here.
import { WRITE_ONCE_FIELDS, checkWriteOnce, writeOnceRaceMessage } from '../lib/character-write-once.js';
// #1132: refused write-once transitions are recorded as well as refused.
// Purely additive — character-write-once.js's own logic is untouched.
import { recordWriteOnceViolations } from '../lib/write-once-violation-log.js';
import { bloodlineKey } from '../lib/bloodline-key.js';
// ECM-7 (#874): the EQUIPMENT_CATALOGUE static-module import + the dead
// _CATALOGUE_IDS slug set were removed alongside the static module deletion.
// POST /api/characters/:id/equipment validates catalogue existence via the
// Mongo equipment_catalogue collection lookup (post-ECM-3 #870 #885).

const router = Router();
const col = () => getCollection('characters');

// #510: canonical influence spheres (mirrors public/js/data/constants.js:123).
// Carthian Pull allocations to Allies/Contacts must pick from this fixed set so
// downstream systems recognise the qualifier.
const INFLUENCE_SPHERES = ['Bureaucracy', 'Church', 'Finance', 'Health', 'High Society', 'Industry', 'Legal', 'Media', 'Military', 'Occult', 'Police', 'Politics', 'Street', 'Transportation', 'University', 'Underworld'];

/**
 * Strip ephemeral underscore-prefixed fields from req.body before validation.
 * xpl.1: also pulls `xp_ledger_reason` off the body onto `req.xpLedgerReason`
 * — it is a signal to the PUT handler's ledger hook, never a character
 * field, and the character schema's `additionalProperties: false` would
 * otherwise reject it before the handler ever runs.
 */
function stripEphemeral(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    if (Object.prototype.hasOwnProperty.call(req.body, 'xp_ledger_reason')) {
      req.xpLedgerReason = req.body.xp_ledger_reason;
      delete req.body.xp_ledger_reason;
    }
    for (const key of Object.keys(req.body)) {
      if (key.startsWith('_')) delete req.body[key];
    }
  }
  next();
}

/**
 * tm-admin.10.5 (Angelus's 2026-10-01 ruling, "strip silently"): remove any trait-level `bonus`
 * key from req.body (attributes, skills, disciplines, merits) before validation. `bonus` is a
 * runtime-only overlay slot and is never persisted; a stale or cached client that still sends one
 * (zero or not) must neither fail its save nor get the key into the database. Placed straight after
 * stripEphemeral on every character create and save route.
 */
function stripTraitBonus(req, res, next) {
  req.body = withoutTraitBonus(req.body);
  next();
}

/**
 * BL-5 (#1008) — does an ACQUIRED bloodline name resolve against the
 * collection? Returns a message when it demonstrably does not, and `null`
 * whenever the collection cannot answer.
 *
 * Three deliberate refusals to judge, each of which would otherwise reject a
 * legitimate first-set:
 *   - the collection is EMPTY. Production holds zero bloodline documents right
 *     now, so a check that fired here would reject every acquisition in the
 *     app. This is BL-3a's `bloodlinesResolvable()` reasoning applied server
 *     side, and the same lesson its review paid for.
 *   - the read THREW. An unreadable collection is a system state, not evidence
 *     about the value.
 *   - the value is not a usable string. Schema validation owns that.
 *
 * Matching is on the shared trim + case-fold key, the same one the client
 * resolves costing through, so a value that costs correctly is never refused
 * for a spelling difference. The collection is read whole and filtered in
 * memory, which is BL-4's own precedent for exactly this comparison (it is a
 * couple of dozen documents).
 */
async function bloodlineDoesNotResolve(name) {
  const key = bloodlineKey(name);
  if (!key) return null;
  let docs;
  try {
    docs = await getCollection('bloodlines').find({}, { projection: { name: 1 } }).toArray();
  } catch (err) {
    console.error('[characters] bloodline referential check could not read the collection:', err.message);
    return null;
  }
  if (!docs.length) return null;
  if (docs.some(d => bloodlineKey(d && d.name) === key)) return null;
  return `Bloodline "${String(name)}" is not in the bloodlines collection. `
    + 'A bloodline is permanent once acquired, so it is checked at the moment it is set. '
    + 'Add it under Reference Data first, or correct the spelling.';
}

function parseId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

/**
 * EQC-3 review patch (issue #1154, Codex external review Medium finding):
 * `container_id` validation was originally added ONLY to
 * `POST /:id/equipment`. `PUT /:id` (the main admin Save-to-DB path,
 * `public/js/admin.js`'s `buildSaveBody()`) and the two character-create
 * routes (`POST /wizard`, `POST /`) all accept a full `equipment[]` array
 * with zero container_id validation - the review found this meant
 * enforcement depended entirely on which endpoint a caller used, and a full
 * character save could silently persist a dangling, self-referencing, or
 * non-container `container_id` that the single-item endpoint would have
 * rejected. Extracted as ONE shared validator every equipment-array write
 * path calls, so the rule can never drift out of sync between them again -
 * the same lesson EQC-1's own review already taught this epic once.
 *
 * Validates the WHOLE array's container_id references against EACH OTHER
 * (not against a separately-fetched "existing" state), which also lets this
 * same function serve `POST /:id/equipment` (validate existing + the one new
 * item, combined) and `PUT /:id` (validate the incoming array as submitted)
 * with identical logic.
 *
 * Additionally enforces the single-level containment rule EQC-1's own
 * schema comment establishes but this story's first version never actually
 * checked: a `container_id` target must not ITSELF already be contained
 * (have its own `container_id` set) - otherwise nesting depth would be
 * unbounded rather than the documented single level.
 *
 * @param {object[]} equipment - the full candidate equipment array to validate
 * @returns {Promise<string|null>} an error message, or null if valid
 */
async function validateEquipmentContainerRefs(equipment) {
  if (!Array.isArray(equipment)) return null;
  const containerRefs = equipment.filter(e => e && e.container_id != null);
  if (!containerRefs.length) return null;

  const referencedIds = [...new Set(containerRefs.map(e => e.container_id))];
  const validRefIds = referencedIds.filter(id => typeof id === 'string' && ObjectId.isValid(id) && String(new ObjectId(id)) === id);
  const catalogueDocs = validRefIds.length
    ? await getCollection('equipment_catalogue').find(
        { _id: { $in: validRefIds.map(id => new ObjectId(id)) } },
        { projection: { bucket: 1 } },
      ).toArray()
    : [];
  const bucketById = new Map(catalogueDocs.map(d => [String(d._id), d.bucket]));

  for (const item of containerRefs) {
    const cid = item.container_id;
    if (typeof cid !== 'string' || !ObjectId.isValid(cid) || String(new ObjectId(cid)) !== cid) {
      return `container_id must be a 24-hex ObjectId string or null; got '${cid}'`;
    }
    const targetRows = equipment.filter(e => e && e !== item && String(e.catalogue_id) === cid);
    if (!targetRows.length) {
      return `container_id does not reference an item this character already owns: ${cid}`;
    }
    const bucket = bucketById.get(cid);
    if (bucket !== 'container') {
      return `container_id must reference a container-bucket catalogue item; got bucket '${bucket ?? '(unknown)'}'`;
    }
    // Single-level: none of the matching target rows may themselves be contained.
    if (targetRows.some(row => row.container_id != null)) {
      return `container_id references a container that is itself contained (single-level containment only): ${cid}`;
    }
  }
  return null;
}

/**
 * NPCR.4 helpers — touchstones live on character.touchstones[], capped at 6,
 * free-text only (DBO-8, 2026-08-14). Slot rating descends from the clan
 * anchor (Ventrue=7, else=6).
 */

function anchorFor(character) {
  return character?.clan === 'Ventrue' ? 7 : 6;
}

/**
 * Validate a touchstones[] array on a save body: cap and
 * humanity-in-anchor-range. Returns null on success or an error message
 * string.
 */
function validateTouchstones(touchstones, currentCharDoc) {
  if (!Array.isArray(touchstones)) return null;
  if (touchstones.length > 6) {
    return `touchstones cap is 6 (received ${touchstones.length})`;
  }

  const anchor = anchorFor(currentCharDoc);
  const minRating = Math.max(1, anchor - 5);
  for (const t of touchstones) {
    if (!Number.isInteger(t?.humanity) || t.humanity < minRating || t.humanity > anchor) {
      return `touchstone humanity ${t?.humanity} out of range (anchor=${anchor}, min=${minRating})`;
    }
  }
  return null;
}

// N-1 (ADR-005 Rev 2 §D3): Collective Compound synthesis on the server side.
// Mirrors the client-side pass in `mci.js#applyDerivedMerits` so the player
// portal sees synthesised `_collective_shared_with` without needing to run
// the full editor rule-engine in the browser. ST path uses its full `chars`
// array as the search context (no extra fetch); player path augments its own
// chars with any collective members it doesn't otherwise have access to (one
// scoped fetch by source-merit name; reuses the existing partner projection
// shape — `{ name: 1, merits: 1 }`). Never persists `_collective_shared_with`
// — it lives only on the response, stripped by `buildSaveBody` on the save
// path (per Concern #3).
async function _enrichCollectiveSharing(chars) {
  const grantsCol = getCollection('rule_grant');
  const collectiveRules = await grantsCol
    .find({ 'sharing_scope.type': 'collective_owners_of_merit' })
    .toArray();
  if (!collectiveRules.length) return;

  // Build the search context: union of `chars` plus any collective-owner chars
  // not already in the set. Player path needs the augmentation; ST path's
  // `chars` already contains everyone (the union is a no-op there).
  const sourceMerits = [...new Set(collectiveRules.map(r => r?.sharing_scope?.merit).filter(Boolean))];
  let searchContext = chars;
  if (sourceMerits.length) {
    const haveIds = new Set(chars.map(c => String(c._id)).filter(Boolean));
    const extras = await col()
      .find(
        { 'merits.name': { $in: sourceMerits } },
        { projection: { name: 1, merits: 1 } }
      )
      .toArray();
    const missing = extras.filter(e => e && e._id && !haveIds.has(String(e._id)));
    if (missing.length) searchContext = chars.concat(missing);
  }

  for (const c of chars) {
    for (const rule of collectiveRules) {
      const synthesised = resolveSharingScope(rule.sharing_scope, c, searchContext, rule);
      if (synthesised == null) continue;
      const targets = Array.isArray(rule.pool_targets) ? rule.pool_targets : [];
      if (!targets.length) continue;
      for (const m of (c.merits || [])) {
        if (targets.includes(m.name)) m._collective_shared_with = synthesised;
      }
    }
  }
}

// GET /api/characters — ST gets all, player gets only their characters
// ?mine=1 forces the player-only path for any role (used by player portal)
router.get('/', async (req, res) => {
  if (isStRole(req.user) && !req.query.mine) {
    const chars = await col().find().toArray();
    await _enrichCollectiveSharing(chars);
    return res.json(chars);
  }

  // Player (or ST with ?mine=1): return only their linked characters
  const ids = (req.user.character_ids || []).map(id =>
    id instanceof ObjectId ? id : new ObjectId(id)
  );
  const chars = await col().find({ _id: { $in: ids } }).toArray();

  // Enrich shared domain merits with partner contributions so the
  // player portal can render filled/hollow dots without needing the
  // full partner character objects (which it can't access).
  //
  // Kurtis W bug report (2026-09): shared_with entries come in two formats
  // (resolveSharedWithMember's own doc comment) — a legacy character name,
  // or a 24-hex ObjectId string (the current format, written by
  // shAddDomainPartner). This enrichment used to resolve by name only, so
  // an ID-format entry silently matched nothing here — no partner dots,
  // and (client-side, editor/sheet.js's _viewSharedSub) no display name
  // either, since resolveSharedWithMember also only searches the player's
  // own role-scoped roster, which never contains the shared partner. The
  // raw ~50-character ID string then rendered in place of a name, long
  // enough to overflow the row and visually overlap the one below it.
  // Now resolves both formats and additionally attaches `_partner_names`
  // (entry -> {name, honorific, moniker}, everything displayName() needs)
  // so the client can render a real name for an ID-format entry it can't
  // resolve locally, not just the dots.
  const partnerNames = new Set();
  const partnerIds = new Set();
  for (const c of chars) {
    for (const m of (c.merits || [])) {
      if (m.category === 'domain' && m.shared_with) {
        for (const pn of m.shared_with) {
          if (/^[a-f0-9]{24}$/i.test(pn)) partnerIds.add(pn);
          else partnerNames.add(pn);
        }
      }
    }
  }
  if (partnerNames.size > 0 || partnerIds.size > 0) {
    const or = [];
    if (partnerNames.size > 0) or.push({ name: { $in: [...partnerNames] } });
    if (partnerIds.size > 0) or.push({ _id: { $in: [...partnerIds].map(id => new ObjectId(id)) } });
    const partners = await col()
      .find(
        { $or: or },
        { projection: { name: 1, honorific: 1, moniker: 1, merits: 1 } }
      )
      .toArray();
    // Build map: shared_with entry (name OR id hex string) → { meritName → shareable dots }
    const partnerMap = new Map();
    // Build map: shared_with entry → display fields (name/honorific/moniker)
    const partnerDisplay = new Map();
    for (const p of partners) {
      const meritDots = {};
      for (const m of (p.merits || [])) {
        if (m.category !== 'domain') continue;
        // N-1 (Concern #1 Rev 2 VERBATIM): subset preserved verbatim — DO NOT
        // narrow to match the client's mci-only subset. Per-slug reads via
        // `freeOf` for N-2-backfill safety; behaviour identical pre-N-1.
        meritDots[m.name] = (m.cp || 0) + freeOf(m, 'mci') + freeOf(m, 'bloodline')
                          + freeOf(m, 'retainer') + (m.xp || 0);
      }
      const display = { name: p.name, honorific: p.honorific || null, moniker: p.moniker || null };
      partnerMap.set(p.name, meritDots);
      partnerDisplay.set(p.name, display);
      const idStr = String(p._id);
      partnerMap.set(idStr, meritDots);
      partnerDisplay.set(idStr, display);
    }
    // Attach _partner_dots and _partner_names on each shared domain merit
    for (const c of chars) {
      for (const m of (c.merits || [])) {
        if (m.category !== 'domain' || !m.shared_with || !m.shared_with.length) continue;
        let pd = 0;
        let names = null;
        for (const pn of m.shared_with) {
          const pm = partnerMap.get(pn);
          if (pm && pm[m.name]) pd += pm[m.name];
          const disp = partnerDisplay.get(pn);
          if (disp) {
            if (!names) names = {};
            names[pn] = disp;
          }
        }
        if (pd > 0) m._partner_dots = pd;
        if (names) m._partner_names = names;
      }
    }
  }

  await _enrichCollectiveSharing(chars);
  res.json(chars);
});

// GET /api/characters/public — public who's who list (any authenticated user)
// Returns only display fields for active, non-retired characters.
router.get('/public', async (req, res) => {
  const chars = await col()
    .find(
      { retired: { $ne: true }, pending_approval: { $ne: true } },
      { projection: { name: 1, honorific: 1, moniker: 1, clan: 1, covenant: 1, court_title: 1, court_category: 1, regent_territory: 1, player: 1, blood_potency: 1, humanity: 1 } }
    )
    .toArray();
  const sortKey = c => `${c.covenant || 'zzz'}|${(c.moniker || c.name || '').toLowerCase()}`;
  chars.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  res.json(chars);
});

// GET /api/characters/game-xp — attendance XP summary for all characters.
// Any authenticated user can access this (players need it for XP display).
// Returns per-session attendance data without sensitive ST notes.
router.get('/game-xp', async (req, res) => {
  const sessions = await getCollection('game_sessions')
    .find({}, { projection: { session_date: 1, title: 1, session_number: 1, attendance: 1 } })
    .sort({ session_date: -1 })
    .toArray();
  // Strip sensitive fields from attendance — only keep XP-relevant data
  for (const s of sessions) {
    s.attendance = (s.attendance || []).map(a => ({
      character_id: a.character_id,
      character_name: a.character_name,
      name: a.name,
      display_name: a.display_name,
      character_display: a.character_display,
      attended: !!a.attended,
      costuming: !!a.costuming,
      downtime: !!a.downtime,
      extra: a.extra || 0,
    }));
  }
  res.json(sessions);
});

// GET /api/characters/combat — lightweight resistance data for all active characters.
// Used by the game app dice roller to populate the opponent target dropdown
// when a player needs to select a resistance target. Returns only the fields
// needed for contested roll calculations — no merit data, no powers, no PII.
router.get('/combat', async (req, res) => {
  const chars = await col()
    .find(
      { retired: { $ne: true }, pending_approval: { $ne: true } },
      {
        projection: {
          name: 1, honorific: 1, moniker: 1, clan: 1, covenant: 1,
          blood_potency: 1,
          'attributes.Resolve': 1, 'attributes.Composure': 1,
          'attributes.Strength': 1, 'attributes.Dexterity': 1,
          'attributes.Stamina': 1, 'attributes.Wits': 1,
          'attributes.Presence': 1, 'attributes.Manipulation': 1,
          'attributes.Intelligence': 1,
          disciplines: 1,
        },
      }
    )
    .toArray();
  const sortKey = c => (c.moniker || c.name || '').toLowerCase();
  chars.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  res.json(chars);
});

// GET /api/characters/status — status ranking data (any authenticated user)
// Returns active characters with clan/covenant status, joined with their
// linked player's Discord avatar so the player portal Status tab can
// render ranked lists with profile pics. Must be declared before /:id.
router.get('/status', async (req, res) => {
  const chars = await col()
    .find(
      { retired: { $ne: true }, pending_approval: { $ne: true } },
      {
        projection: {
          name: 1, honorific: 1, moniker: 1,
          clan: 1, covenant: 1,
          'status.clan': 1, 'status.covenant': 1, 'status.city': 1,
          court_title: 1, court_category: 1,
          player: 1, powers: 1,
        },
      }
    )
    .toArray();

  // Join linked player Discord info for avatars
  const players = await getCollection('players')
    .find({}, { projection: { _id: 1, character_ids: 1, discord_id: 1, discord_avatar: 1 } })
    .toArray();
  const charToPlayer = new Map();
  for (const p of players) {
    for (const cid of (p.character_ids || [])) {
      charToPlayer.set(String(cid), {
        discord_id: p.discord_id || null,
        discord_avatar: p.discord_avatar || null,
      });
    }
  }
  for (const c of chars) {
    c._player_info = charToPlayer.get(String(c._id)) || null;
    const otsOath = (c.powers || []).find(p => p.category === 'pact' && (p.name || '').toLowerCase() === 'oath of the scapegoat');
    c._ots_covenant_bonus = otsOath ? ((otsOath.cp || 0) + (otsOath.xp || 0)) : 0;
    delete c.powers;
  }

  res.json(chars);
});

// GET /api/characters/names — lightweight list of all active character names (any authenticated user)
router.get('/names', async (req, res) => {
  const chars = await col()
    .find({ retired: { $ne: true } }, { projection: { name: 1, moniker: 1, honorific: 1, player: 1 } })
    .toArray();
  const sortName = c => (c.moniker || c.name).toLowerCase();
  chars.sort((a, b) => sortName(a).localeCompare(sortName(b)));
  res.json(chars);
});

// GET /api/characters/:id — ST gets any, player gets only their own
router.get('/:id', async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });

  // 2026-09-01 general audit fix (found while implementing the P0 fix,
  // not in the original audit's own finding): was role === 'player' — the
  // one inconsistent spot in this file, which already uses !isStRole(req.user)
  // everywhere else (lines ~247, ~809, ~866, ~1042). Let a coordinator-role
  // account read any character's full sheet with no ownership check.
  if (!isStRole(req.user)) {
    const owns = (req.user.character_ids || []).some(id => id.toString() === oid.toString());
    if (!owns) return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your character' });
  }

  const char = await col().findOne({ _id: oid });
  if (!char) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });

  res.json(char);
});

// POST /api/characters/wizard — player creates their own character
router.post('/wizard', requireRole('player'), stripEphemeral, stripTraitBonus, validateCharacter, normalizeMeritsMiddleware, validateWhiteAntsTerritoriesMiddleware, validateTrapDoorAnchorMiddleware, async (req, res) => {
  const players = getCollection('players');
  const player = await players.findOne({ _id: req.user.player_id });
  const existingIds = player?.character_ids || [];

  // First character is auto-approved; subsequent characters await ST sign-off
  const isFirst = existingIds.length === 0;

  const doc = { ...req.body };
  delete doc._id;
  doc.pending_approval = !isFirst;
  doc.retired = false;
  doc.created_at = new Date().toISOString();

  // EQC-3 review patch (issue #1154, Codex external review Medium finding):
  // same shared validator every other equipment-array write path calls —
  // chargen doesn't typically arrive with pre-populated containment, but
  // enforcement must not depend on which endpoint happens to be used.
  if (Array.isArray(doc.equipment)) {
    const containerErr = await validateEquipmentContainerRefs(doc.equipment);
    if (containerErr) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: containerErr });
    }
  }

  const result = await col().insertOne(doc);
  const created = await col().findOne({ _id: result.insertedId });

  // Link to player record
  await players.updateOne(
    { _id: req.user.player_id },
    { $push: { character_ids: result.insertedId } }
  );

  res.status(201).json(created);
});

// POST /api/characters — ST only
router.post('/', requireRole('st'), stripEphemeral, stripTraitBonus, validateCharacter, normalizeMeritsMiddleware, validateWhiteAntsTerritoriesMiddleware, validateTrapDoorAnchorMiddleware, async (req, res) => {
  const doc = req.body;
  if (!doc || !doc.name) return res.status(400).json({ error: 'VALIDATION_ERROR', message: "Field 'name' is required" });

  // EQC-3 review patch (issue #1154): same shared validator as every other
  // equipment-array write path (see POST /wizard's own comment).
  if (Array.isArray(doc.equipment)) {
    const containerErr = await validateEquipmentContainerRefs(doc.equipment);
    if (containerErr) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: containerErr });
    }
  }

  const result = await col().insertOne(doc);
  const created = await col().findOne({ _id: result.insertedId });
  res.status(201).json(created);
});

// PUT /api/characters/:id — ST only
// Uses partial schema validation: types/shapes checked but no field is required,
// so both full document saves and partial updates (e.g. regent assignment) are valid.
router.put('/:id', requireRole('st'), stripEphemeral, stripTraitBonus, validateCharacterPartial, normalizeMeritsMiddleware, validateWhiteAntsTerritoriesMiddleware, validateTrapDoorAnchorMiddleware, async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });

  const { _id, willpower, ...updates } = req.body;
  // xpl.1: already stripped from req.body by stripEphemeral (before schema
  // validation ran) - read the stashed value instead of destructuring it.
  const xp_ledger_reason = req.xpLedgerReason;

  // ECM-3 (#870): hydrate equipment[].catalogue_id 24-hex strings back to
  // ObjectId before $set. The schema validation upstream already enforces
  // the 24-hex shape; the ObjectId.isValid guard is defensive — if a stray
  // bad value slips through, return 400 rather than throwing in $set.
  if (Array.isArray(updates.equipment)) {
    const hydrated = [];
    for (const item of updates.equipment) {
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'equipment[] items must be objects' });
      }
      const cid = item.catalogue_id;
      if (typeof cid === 'string' && ObjectId.isValid(cid) && String(new ObjectId(cid)) === cid) {
        hydrated.push({ ...item, catalogue_id: new ObjectId(cid) });
      } else if (cid instanceof ObjectId) {
        hydrated.push(item);
      } else {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `equipment[].catalogue_id must be a 24-hex ObjectId string; got ${typeof cid === 'string' ? `'${cid}'` : typeof cid}`,
        });
      }
    }
    updates.equipment = hydrated;

    // EQC-3 review patch (issue #1154, epic #1038, Codex external review
    // Medium finding): this is the main admin Save-to-DB path
    // (public/js/admin.js's buildSaveBody() submits the FULL equipment
    // array here) and originally had ZERO container_id validation — the
    // single-item POST /:id/equipment endpoint's checks simply didn't run
    // for a full-character save, so an invalid container_id rejected by
    // one endpoint was silently accepted by this one. Same shared validator
    // POST /:id/equipment now calls, run against the incoming array as
    // submitted (this route replaces the whole equipment array, so there
    // is no separate "existing rows" to merge in — updates.equipment IS
    // the candidate final state).
    const containerErr = await validateEquipmentContainerRefs(updates.equipment);
    if (containerErr) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: containerErr });
    }
  }

  // BL-5 (#1008): clan and bloodline are write-once, and until this story
  // nothing knew it. The check needs the STORED value, which is why it is not a
  // middleware (every middleware in the chain above is body-only) and why the
  // read the touchstones branch already performed is HOISTED here and widened
  // rather than duplicated: one document, one read, two questions.
  //
  // Nothing is read at all unless the body actually carries one of the three
  // fields that need it.
  const has = k => Object.prototype.hasOwnProperty.call(updates, k);
  const guardedInBody = WRITE_ONCE_FIELDS.filter(has);
  let existingChar = null;
  if (guardedInBody.length || has('touchstones')) {
    existingChar = await col().findOne({ _id: oid }, { projection: { clan: 1, bloodline: 1 } });
  }

  // `acquisitions` is field -> the value stored at the moment of the read. It
  // is what turns the update into a compare-and-set below. Only an ACQUISITION
  // goes in: a no-op save must not gain a filter condition, or an unrelated
  // concurrent write would fail somebody's merit save.
  const acquisitions = {};
  if (existingChar) {
    for (const field of guardedInBody) {
      const v = checkWriteOnce(field, existingChar[field], updates[field]);
      if (!v.allowed) {
        // 409, not 400: the body is well-formed and schema-valid. What
        // conflicts is the stored state. Same code BL-4 returns for the name
        // collision and the guarded delete.
        //
        // #1132: record the attempt before refusing it. One row, for the one
        // field adjudicated here — this loop returns on the FIRST refusal
        // (BL-5's behaviour, deliberately unchanged), so a body forbidding both
        // fields records the first one WRITE_ONCE_FIELDS reaches. Best-effort:
        // recordWriteOnceViolations never throws, so this cannot turn a 409
        // into a 500.
        await recordWriteOnceViolations(oid, [{
          field,
          stored_value: existingChar[field],
          attempted_value: updates[field],
        }], req.user);
        return res.status(409).json({ error: 'WRITE_ONCE_VIOLATION', message: v.reason });
      }
      if (!v.changed) continue;
      acquisitions[field] = existingChar[field];

      // The referential check (BL-5 AC 8), on ACQUISITION ONLY. Running it on a
      // no-op would fail every existing holder's next full-document save, and
      // running it against an empty or unreadable collection would reject every
      // first-set in the app — production holds zero bloodline documents right
      // now. A lookup that cannot answer must not be allowed to answer "no".
      if (field === 'bloodline') {
        const err = await bloodlineDoesNotResolve(updates.bloodline);
        if (err) return res.status(400).json({ error: 'VALIDATION_ERROR', message: err });
      }
    }
  }

  // NPCR.4: if the save includes touchstones[], validate cap and humanity-in-range.
  // Reuses BL-5's hoisted `existingChar` read above (already projects `clan`,
  // which is all this check needs) instead of a second document read — this
  // repo's own reconciliation of the two branches (2026-08-18), not part of
  // either story's original scope. NOTE: the bl branch this was merged from
  // carried a further-enhanced (async, edge_id-referential-checking) version
  // of `validateTouchstones`; that enhancement's own function-definition
  // change was NOT part of this merge (unrelated to BL-1..5's actual scope,
  // and its origin/intent wasn't clear enough to adopt silently here) — this
  // keeps the simpler, currently-live signature. Revisit as its own story if
  // the edge_id check is still wanted.
  if (has('touchstones')) {
    if (!existingChar) existingChar = await col().findOne({ _id: oid }, { projection: { clan: 1, bloodline: 1 } });
    const effectiveChar = { ...existingChar, ...updates }; // updates may also change clan
    const err = validateTouchstones(updates.touchstones, effectiveChar);
    if (err) return res.status(400).json({ error: 'VALIDATION_ERROR', message: err });
  }

  // Compare-and-set. Between the read above and this write nothing holds a
  // lock, so two concurrent acquisitions could both see "no value", both pass,
  // and the second silently overwrite the first — the read-then-write class
  // BL-4's review found three of. Putting the prior value in the FILTER makes
  // the whole thing one atomic operation, which is what a MongoDB transaction
  // would not have given us (transactions conflict on writes; there is no
  // predicate locking). What stays deliberately open: a concurrent write
  // setting the SAME value is indistinguishable from a no-op, and is harmless.
  const filter = { _id: oid };
  for (const [field, prior] of Object.entries(acquisitions)) {
    // `undefined` means the field was absent from the document. `null` is the
    // right filter for that: in MongoDB it matches both null and missing.
    filter[field] = prior === undefined ? null : prior;
  }

  // xpl.1: diff the incoming trait-object XP totals against the pre-update
  // document for exactly the four categories this story covers. Every save
  // round-trips the FULL attributes/skills/disciplines/merits objects
  // (buildSaveBody, public/js/admin.js:964-991), not a per-field patch, so
  // comparing against a fresh pre-fetch is required - the PUT body alone
  // never tells us what changed. This is a SEPARATE read from the write-once
  // `existingChar` fetch above (that one only projects clan/bloodline) -
  // deliberately not merged into it, since the two features (write-once
  // lineage lock, XP ledger) are independent stories with independent scopes.
  //
  // Code-review (2026-08-15, Medium): the pre-fetch itself was unguarded,
  // so a transient read failure would 500 the WHOLE character save - the
  // opposite of the "ledger machinery never blocks a real save" intent the
  // insert's own try/catch below already honours. Wrapped the same way: a
  // failed pre-fetch just means no ledger rows for this save, logged, not
  // thrown.
  const TRAIT_KEYS = ['attributes', 'skills', 'disciplines', 'merits'];
  let xpLedgerRows = [];
  if (TRAIT_KEYS.some(k => Object.prototype.hasOwnProperty.call(updates, k))) {
    try {
      const priorChar = await col().findOne(
        { _id: oid },
        { projection: { attributes: 1, skills: 1, disciplines: 1, merits: 1 } }
      );
      xpLedgerRows = diffXpLedgerRows(priorChar || {}, updates);
    } catch (err) {
      console.error('xp_ledger pre-fetch failed for character', String(oid), err.message);
    }
    if (xpLedgerRows.length && typeof xp_ledger_reason === 'string' && xp_ledger_reason.trim() === '') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'xp_ledger_reason cannot be blank' });
    }
  }

  const result = await col().findOneAndUpdate(
    filter,
    { $set: updates },
    { returnDocument: 'after' }
  );

  if (!result) {
    const raced = Object.keys(acquisitions);
    if (raced.length) {
      // Zero matches on a document that still exists is the race, not a 404.
      // The projection is widened rather than added to: the filter ANDs EVERY
      // acquired field's prior value, so a single field moving underneath trips
      // the whole update, and naming both would send the ST looking at a field
      // that never changed. Same read, one more field, no extra round trip.
      const stillThere = await col().findOne({ _id: oid }, { projection: { clan: 1, bloodline: 1 } });
      if (stillThere) {
        // `?? null` on both sides, because the filter itself normalises an
        // absent prior value to null (`prior === undefined ? null : prior`).
        const moved = raced.filter(f => (stillThere[f] ?? null) !== (acquisitions[f] ?? null));
        // If nothing reads as moved the value went and came back, or moved
        // again after this read. Name every acquired field rather than none.
        const named = moved.length ? moved : raced;
        // #1132: one row per raced field — this branch adjudicates them all at
        // once, so unlike the direct check above it can genuinely produce two.
        // `stored_value` is what ACTUALLY LANDED (read back a moment ago), not
        // the prior value this request was pinning; that prior value is exactly
        // what makes this a race rather than a plain refusal.
        await recordWriteOnceViolations(oid, named.map(f => ({
          field: f,
          stored_value: stillThere[f] ?? null,
          attempted_value: updates[f],
        })), req.user);
        return res.status(409).json({
          error: 'WRITE_ONCE_VIOLATION',
          message: writeOnceRaceMessage(named),
        });
      }
    }
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });
  }

  // xpl.1: best-effort ledger insert - never blocks or fails the character
  // save itself (see story Dev Notes -> Design Decisions for why no
  // transaction). A failure here is logged, not surfaced to the client.
  if (xpLedgerRows.length) {
    try {
      const at = new Date().toISOString();
      const reason = (typeof xp_ledger_reason === 'string' && xp_ledger_reason.trim()) ? xp_ledger_reason.trim() : undefined;
      // Code-review (2026-08-15, Medium): req.user.username was assumed
      // always present; fall back rather than write an unattributed row.
      const stUsername = req.user?.username || 'unknown';
      const docs = xpLedgerRows.map(row => {
        const doc = { character_id: oid, ...row, at, st_username: stUsername };
        if (reason) doc.reason = reason;
        return doc;
      });
      await getCollection('xp_ledger').insertMany(docs);
    } catch (err) {
      console.error('xp_ledger insert failed for character', String(oid), err.message);
    }
  }

  res.json(result);
});

// GET /api/characters/:id/xp_ledger — ST only. xpl.1: read-only history of
// XP-affecting writes to this character, newest first.
router.get('/:id/xp_ledger', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });
  // _id tiebreak: rows from one save share an identical `at` (see the
  // insert above), so `at` alone leaves same-save ordering unspecified.
  const rows = await getCollection('xp_ledger')
    .find({ character_id: oid })
    .sort({ at: -1, _id: -1 })
    .toArray();
  res.json(rows);
});

// GET /api/characters/:id/cascade-preview — ST only
router.get('/:id/cascade-preview', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });
  try {
    const [submissions, sessionsAffected, players] = await Promise.all([
      getCollection('downtime_submissions').countDocuments({ character_id: oid }),
      getCollection('game_sessions').countDocuments({ 'attendance.character_id': oid }),
      getCollection('players').countDocuments({ character_ids: oid }),
    ]);
    res.json({ submissions, sessionsAffected, players });
  } catch (err) {
    res.status(500).json({ error: 'PREVIEW_FAILED', message: err.message });
  }
});

// PATCH /api/characters/:id/st_mods_suppressed — ST only.
// Epic STM (issue #378): per-character override of the overlay kill-switch.
// Truthy → suppress; false → clear ($unset to keep characters that have
// never been touched by STM clean of a transient false flag).
router.patch('/:id/st_mods_suppressed', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });

  const { st_mods_suppressed } = req.body || {};
  if (typeof st_mods_suppressed !== 'boolean') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'st_mods_suppressed must be boolean' });
  }

  const update = st_mods_suppressed
    ? { $set: { st_mods_suppressed: true } }
    : { $unset: { st_mods_suppressed: '' } };

  const result = await col().findOneAndUpdate(
    { _id: oid },
    update,
    { returnDocument: 'after' },
  );
  if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });
  res.json(result);
});

// PATCH /api/characters/:id/safe_place_locations — player (own char) or ST.
// #506: persist per-Safe-Place street+suburb on the character so locations carry
// across downtime cycles. Narrowly scoped: only the `location` field on `Safe
// Place` domain merits is touched; every other merit and field is left exactly
// as-is. The player-facing downtime form cannot use PUT /:id (ST-only), so this
// is the sole player write path. Ownership mirrors GET /:id (:331-333).
router.patch('/:id/safe_place_locations', async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });

  // Ownership: players may only write their own character; ST may write any.
  if (!isStRole(req.user)) {
    const owns = (req.user.character_ids || []).some(id => id.toString() === oid.toString());
    if (!owns) return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your character' });
  }

  const { locations } = req.body || {};
  if (!Array.isArray(locations)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'locations must be an array' });
  }
  const MAX_LEN = 200;
  const clean = locations.map(v => {
    if (v == null) return '';
    if (typeof v !== 'string') return null; // sentinel: invalid entry
    return v.slice(0, MAX_LEN);
  });
  if (clean.some(v => v === null)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'each location must be a string' });
  }

  const char = await col().findOne({ _id: oid });
  if (!char) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });

  // Apply positionally to Safe Place domain merits in document order — the same
  // filter the downtime form renders/collects by, so index i aligns within a
  // single load->submit. A shorter array leaves trailing safe places untouched.
  let spIndex = 0;
  const merits = (char.merits || []).map(m => {
    if (m.category === 'domain' && m.name === 'Safe Place') {
      const loc = clean[spIndex];
      spIndex += 1;
      if (loc !== undefined) return { ...m, location: loc };
    }
    return m;
  });

  const result = await col().findOneAndUpdate(
    { _id: oid },
    { $set: { merits } },
    { returnDocument: 'after' },
  );
  if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });
  res.json(result);
});

// PATCH /api/characters/:id/carthian_pull — player (own char) or ST.
// #508: allocate the single Carthian Pull dot to Allies/Contacts/Haven/Herd as a
// live bonus dot (the `free_carthian` channel) on the character, so it shows on
// the sheet via the existing bonus-dot model. At most one Carthian-Pull bonus
// exists at a time, so every write is strip-then-apply: bonus-only instances we
// created (tagged `granted_by:'Carthian Pull'`) are deleted, an augmented
// existing Herd/Haven has its `free_carthian` cleared, then the new allocation
// is applied. Player-scoped (the ST-only PUT cannot be used by players);
// ownership mirrors GET /:id (:331-333). `target:''` clears the allocation.
router.patch('/:id/carthian_pull', async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });

  if (!isStRole(req.user)) {
    const owns = (req.user.character_ids || []).some(id => id.toString() === oid.toString());
    if (!owns) return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your character' });
  }

  // #522: accept a SET of allocations { allocations: [{ target, sphere }, ...] }.
  // The legacy single { target, sphere } is normalised to a one-element set
  // (and target:'' to an empty set = cleared) for back-compat. The pool size is
  // the character's Carthian (Covenant) Status, read from the doc — never
  // trusted from the client.
  const body = req.body || {};
  let rawAllocations;
  if (Array.isArray(body.allocations)) {
    rawAllocations = body.allocations;
  } else if (typeof body.target === 'string') {
    rawAllocations = body.target ? [{ target: body.target, sphere: body.sphere }] : [];
  } else {
    rawAllocations = [];
  }

  const VALID_TARGETS = ['allies', 'contacts', 'haven', 'herd'];
  const allocations = [];
  for (const a of rawAllocations) {
    const target = a && typeof a.target === 'string' ? a.target : '';
    if (target === '') continue; // empty rows are no-ops
    if (!VALID_TARGETS.includes(target)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invalid target' });
    }
    let sphereStr = '';
    if (target === 'allies' || target === 'contacts') {
      sphereStr = typeof a.sphere === 'string' ? a.sphere.trim().slice(0, 120) : '';
      if (!sphereStr) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sphere required for allies/contacts' });
      // #510: sphere must be a recognised influence sphere, not free text.
      if (!INFLUENCE_SPHERES.includes(sphereStr)) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sphere must be a valid influence sphere' });
      }
    }
    allocations.push({ target, sphere: sphereStr });
  }

  const char = await col().findOne({ _id: oid });
  if (!char) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });

  // Pool = Carthian Movement covenant Status (0–5). #522.
  const pool = Number(char.status?.covenant?.['Carthian Movement']) || 0;
  if (allocations.length > pool) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `Carthian Pull allows ${pool} dot(s) (your Carthian Status); ${allocations.length} requested` });
  }

  // 1) Strip ALL prior Carthian-Pull residue, leaving zero trace:
  //    - delete bonus-only instances we created (granted_by:'Carthian Pull');
  //    - clear free_carthian from any merit we augmented in place;
  //    - pop every Contacts sphere a Carthian dot pushed (carthian_spheres[]
  //      plural #522, or the legacy single carthian_sphere #510) so rating
  //      stays equal to spheres.length.
  let merits = (char.merits || [])
    .filter(m => m.granted_by !== 'Carthian Pull')
    .map(m => {
      const hasPushed = (Array.isArray(m.carthian_spheres) && m.carthian_spheres.length) || m.carthian_sphere;
      if (!m.free_carthian && !hasPushed) return m;
      const rest = { ...m };
      delete rest.free_carthian;
      const popped = [];
      if (Array.isArray(rest.carthian_spheres)) { popped.push(...rest.carthian_spheres); delete rest.carthian_spheres; }
      if (rest.carthian_sphere) { popped.push(rest.carthian_sphere); delete rest.carthian_sphere; }
      if (popped.length && Array.isArray(rest.spheres)) rest.spheres = rest.spheres.filter(s => !popped.includes(s));
      return rest;
    });

  // Normalize once so ratings reflect the stripped base (rating = sum of
  // channels) before we cap-check against the base.
  const baseDoc = { merits };
  normalizeCharacterMerits(baseDoc);
  merits = baseDoc.merits;

  // 2) Tally the requested dots per target (stacking allowed — PO 2026-06-01).
  const alliesAdds = new Map();   // area -> dot count
  const contactsAdds = [];        // ordered, distinct spheres to push
  let havenAdds = 0, herdAdds = 0;
  for (const { target, sphere } of allocations) {
    if (target === 'allies') alliesAdds.set(sphere, (alliesAdds.get(sphere) || 0) + 1);
    else if (target === 'contacts') contactsAdds.push(sphere);
    else if (target === 'haven') havenAdds++;
    else herdAdds++;
  }

  // 3) Validate caps against the stripped base (reject over-cap — PO 2026-06-01).
  //    Allies: base(area) + added <= 5 per sphere. Herd/Haven uncapped here.
  for (const [area, cnt] of alliesAdds) {
    const ex = merits.find(m => m.category === 'influence' && m.name === 'Allies' && (m.area || '') === area);
    const base = ex ? (ex.rating || 0) : 0;
    if (base + cnt > 5) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `Allies (${area}) would exceed 5 dots` });
    }
  }
  //    Contacts: each pushed sphere distinct + not already held; total <= 5.
  const contactsEx = merits.find(m => m.category === 'influence' && m.name === 'Contacts');
  const existingContactSpheres = contactsEx && Array.isArray(contactsEx.spheres) ? contactsEx.spheres : [];
  const seenContact = new Set();
  for (const sp of contactsAdds) {
    if (existingContactSpheres.includes(sp)) return res.status(400).json({ error: 'VALIDATION_ERROR', message: `Contacts sphere already held: ${sp}` });
    if (seenContact.has(sp)) return res.status(400).json({ error: 'VALIDATION_ERROR', message: `a Contacts sphere can only be held once: ${sp}` });
    seenContact.add(sp);
  }
  if (existingContactSpheres.length + contactsAdds.length > 5) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Contacts would exceed 5 spheres' });
  }

  // 4) Apply. Match the existing merit by qualifier (Allies → area, Contacts →
  //    spheres[]); augment it, or create a bonus-only instance if absent.
  for (const [area, cnt] of alliesAdds) {
    const ex = merits.find(m => m.category === 'influence' && m.name === 'Allies' && (m.area || '') === area);
    if (ex) ex.free_carthian = (ex.free_carthian || 0) + cnt;
    else merits.push({ category: 'influence', name: 'Allies', area, granted_by: 'Carthian Pull', free_carthian: cnt, rating: cnt });
  }
  if (contactsAdds.length) {
    if (contactsEx) {
      contactsEx.spheres = [...existingContactSpheres, ...contactsAdds];
      contactsEx.free_carthian = (contactsEx.free_carthian || 0) + contactsAdds.length;
      contactsEx.carthian_spheres = [...(Array.isArray(contactsEx.carthian_spheres) ? contactsEx.carthian_spheres : []), ...contactsAdds];
    } else {
      merits.push({ category: 'influence', name: 'Contacts', spheres: [...contactsAdds], carthian_spheres: [...contactsAdds], granted_by: 'Carthian Pull', free_carthian: contactsAdds.length, rating: contactsAdds.length });
    }
  }
  for (const [name, cnt] of [['Haven', havenAdds], ['Herd', herdAdds]]) {
    if (!cnt) continue;
    const ex = merits.find(m => m.category === 'domain' && m.name === name);
    if (ex) ex.free_carthian = (ex.free_carthian || 0) + cnt;
    else merits.push({ category: 'domain', name, granted_by: 'Carthian Pull', free_carthian: cnt, rating: cnt });
  }

  // 5) Re-sync ratings (rating = sum of channels) so the doc stays consistent.
  const docForNorm = { merits };
  normalizeCharacterMerits(docForNorm);
  merits = docForNorm.merits;

  const result = await col().findOneAndUpdate(
    { _id: oid },
    { $set: { merits } },
    { returnDocument: 'after' },
  );
  if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });
  res.json(result);
});

// DELETE /api/characters/:id — ST only (hard-delete with cascade)
router.delete('/:id', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });
  try {
    // Cascade deletes first; character delete is last as the completion marker
    await getCollection('downtime_submissions').deleteMany({ character_id: oid });
    await getCollection('ordeal_submissions').deleteMany({ character_id: oid }).catch(() => {});
    await getCollection('histories').deleteMany({ character_id: oid }).catch(() => {});
    await getCollection('questionnaire_responses').deleteMany({ character_id: oid }).catch(() => {});
    await getCollection('tracker_state').deleteMany({ character_id: oid }).catch(() => {});
    await getCollection('game_sessions').updateMany({}, { $pull: { attendance: { character_id: oid } } });
    await getCollection('players').updateMany({}, { $pull: { character_ids: oid } });
    await getCollection('npcs').updateMany({}, { $pull: { linked_character_ids: oid } }).catch(() => {});

    const result = await col().deleteOne({ _id: oid });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });
    res.status(204).end();
  } catch (err) {
    console.error('Hard-delete cascade failed:', err);
    res.status(500).json({ error: 'CASCADE_FAILED', message: err.message });
  }
});

// PATCH /api/characters/:id/player_prefs — player (own char) or ST.
// #542: persist player preference ratings. Narrowly scoped: only the
// `player_prefs` subdocument is touched. Ownership mirrors GET /:id.
router.patch('/:id/player_prefs', async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID format' });

  if (!isStRole(req.user)) {
    const owns = (req.user.character_ids || []).some(id => id.toString() === oid.toString());
    if (!owns) return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your character' });
  }

  const { player_prefs } = req.body || {};
  if (!player_prefs || typeof player_prefs !== 'object') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'player_prefs must be an object' });
  }

  const VALID_KEYS = [
    'combat_action', 'horror_dread', 'institutional_corruption',
    'mysticism_mystery', 'personal_story', 'political_intrigue',
  ];
  const prefs = {};
  for (const key of VALID_KEYS) {
    const v = player_prefs[key];
    if (v === undefined) continue;
    const rating = (v && typeof v === 'object') ? v.rating : v;
    if (rating !== null && rating !== undefined &&
        (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${key}.rating must be 1–5 integer or null` });
    }
    prefs[key] = { rating: rating ?? null };
  }
  prefs.updated_at = new Date().toISOString();

  const result = await col().findOneAndUpdate(
    { _id: oid },
    { $set: { player_prefs: prefs } },
    { returnDocument: 'after' },
  );
  if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });
  res.json(result);
});

// ── Equipment routes (EQ-1, issue #654) ─────────────────────────────────────
//
// All three routes require ST auth.
// DELETE routes: client must refresh after delete to avoid stale indices.
//
// 2026-06-19: character.assets[] removed (consolidated into equipment[]
// via the catalogue's bucket: 'asset' items). Response shape is now just
// { equipment } — no more { equipment, assets }.

// GET /api/characters/:id/equipment — returns { equipment } for the character.
router.get('/:id/equipment', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID' });
  const char = await col().findOne({ _id: oid }, { projection: { equipment: 1 } });
  if (!char) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });
  res.json({ equipment: char.equipment || [] });
});

// POST /api/characters/:id/equipment — append a single equipment item.
//
// ECM-3 (#870): `catalogue_id` is a 24-hex ObjectId string on the wire,
// matching the new equipment_catalogue collection's _id shape. Existence
// is checked via a Mongo lookup against equipment_catalogue, not against
// the static EQUIPMENT_CATALOGUE slug set — the slug set is dead post-ECM-3
// (ECM-7 deletes the static module entirely). The catalogue_id is hydrated
// to an ObjectId before $push so storage stays ObjectId-typed across the
// full lifecycle; see specs/epic-ecm-equipment-catalogue-migration.md.
router.post('/:id/equipment', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID' });

  const item = req.body;
  const VALID_STATES = ['carried', 'worn', 'stashed', 'lost', 'active'];
  if (!item || typeof item !== 'object') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Request body must be an equipment item object' });
  }
  if (!item.catalogue_id || typeof item.catalogue_id !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'catalogue_id is required' });
  }
  if (!ObjectId.isValid(item.catalogue_id) || String(new ObjectId(item.catalogue_id)) !== item.catalogue_id) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `catalogue_id must be a 24-hex ObjectId string; got '${item.catalogue_id}'`,
    });
  }
  if (!VALID_STATES.includes(item.state)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `state must be one of: ${VALID_STATES.join(', ')}` });
  }
  if (!Number.isInteger(item.acquired_cycle) || item.acquired_cycle < 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'acquired_cycle must be a non-negative integer' });
  }

  const catalogueOid = new ObjectId(item.catalogue_id);
  const catalogueDoc = await getCollection('equipment_catalogue').findOne(
    { _id: catalogueOid },
    { projection: { _id: 1 } }
  );
  if (!catalogueDoc) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `Unknown catalogue item: ${item.catalogue_id}` });
  }

  // EQC-3: widened from { _id: 1 } to also read `equipment` — needed to
  // validate the container_id claim below against what this character
  // already owns.
  const char = await col().findOne({ _id: oid }, { projection: { equipment: 1 } });
  if (!char) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });

  // EQC-3 review patch (issue #1154, Codex external review Medium finding):
  // validated via the SAME shared validator PUT /:id and the character-create
  // routes now also call, against the WOULD-BE final array (existing rows +
  // this one new item) — no separate, divergent inline copy of the same
  // three rules any more (that divergence is exactly what let PUT /:id
  // bypass this validation entirely in the first version of this story).
  const candidateEquipment = [...(char.equipment || []), { catalogue_id: item.catalogue_id, container_id: item.container_id ?? null }];
  const containerErr = await validateEquipmentContainerRefs(candidateEquipment);
  if (containerErr) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: containerErr });
  }

  const cleanItem = {
    catalogue_id:   catalogueOid,
    state:          item.state,
    acquired_cycle: item.acquired_cycle,
    notes:          item.notes ?? null,
    // EQC-3: stored as a plain STRING, not coerced to an ObjectId like
    // catalogue_id is — container_id's own schema type is a string pattern
    // field, not an ObjectId reference type, per EQC-1's own schema comment.
    // Coercing it here would create a type mismatch against the
    // string-comparison read sites (e.g. `e.catalogue_id === containerId`).
    container_id:   item.container_id ?? null,
  };
  const result = await col().findOneAndUpdate(
    { _id: oid },
    { $push: { equipment: cleanItem } },
    { returnDocument: 'after', projection: { equipment: 1 } },
  );
  res.json({ equipment: result.equipment || [] });
});

// DELETE /api/characters/:id/equipment/:itemIndex — remove by zero-based index.
// Client must refresh after delete to avoid stale indices.
router.delete('/:id/equipment/:itemIndex', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid character ID' });

  const char = await col().findOne({ _id: oid }, { projection: { equipment: 1 } });
  if (!char) return res.status(404).json({ error: 'NOT_FOUND', message: 'Character not found' });

  const idx = parseInt(req.params.itemIndex, 10);
  const arr = char.equipment || [];
  if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Equipment index out of range' });
  }

  arr.splice(idx, 1);
  const result = await col().findOneAndUpdate(
    { _id: oid },
    { $set: { equipment: arr } },
    { returnDocument: 'after', projection: { equipment: 1 } },
  );
  res.json({ equipment: result.equipment || [] });
});

// /api/characters/:id/assets routes REMOVED 2026-06-19 — character.assets[]
// consolidated into equipment[] via the catalogue's bucket: 'asset' items.
// All asset-class items now flow through the equipment routes above.

export default router;
