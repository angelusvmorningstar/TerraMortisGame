import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getCollection } from '../db.js';
import { broadcastTrackerUpdate } from '../ws.js';
// Story 12.8 (AC 13): the REAL ceiling functions, imported rather than
// reimplemented. `calcVitaeMax` is the same one `trackerAdj()` clamps against
// client-side (`public/js/game/tracker.js:276`), and `calcTotalInfluence` is
// this repo's single source of truth for an influence maximum
// (`public/js/editor/domain.js:678`, whose own May-2026 comment says it exists
// "so all influence-resource maxes match" - there is no separate
// `calcInfluenceMax` to reuse).
//
// Both are safe to import here, verified by running them under Node against a
// real character shape before this route was written. That is NOT true of
// `public/js/data/accessors.js` as a whole - `server/routes/contested-rolls.js:94`
// records that module as browser-coupled - but `calcVitaeMax` itself
// (`accessors.js:391-393`) is a pure BP_TABLE lookup, and importing the module
// resolves cleanly in this process because every `location`/`localStorage` read
// in the chain is lazy (see `public/js/data/api.js:19`'s own comment on why).
import { calcVitaeMax } from '../../public/js/data/accessors.js';
import { calcTotalInfluence } from '../../public/js/editor/domain.js';

const router = Router();
const col = () => getCollection('tracker_state');

// Ownership check: players can only access their own characters
function canAccess(req, charId) {
  const role = req.user?.role;
  if (role === 'st' || role === 'dev') return true;
  const ids = (req.user?.character_ids || []).map(String);
  return ids.includes(charId);
}

/**
 * Story 12.8 (AC 13): the accepted body's field whitelist.
 *
 * This route was a bare `$set: {...req.body}` with `upsert: true` until now -
 * TM Story's own `mongo-store.js` comment states it outright: "tracker_state has
 * zero write-side validation". That was survivable while the only callers were
 * the ST's own live tracker and combat tab; Stories 12.8 AC 9-9b make it a
 * routinely PLAYER-reachable path, so an unbounded `$set` on a document keyed by
 * a character id the caller supplies is no longer an acceptable shape.
 *
 * The list is derived from every real write site in this repo, not invented:
 * `persistedFields()` (`public/js/game/tracker.js:45-55`) carries vitae,
 * willpower, bashing, lethal, aggravated, influence and conditions;
 * `trackerWriteField()` (:173) adds in_torpor; and the feeding tab's own
 * idempotency marker (`public/js/tabs/feeding-tab.js:154`,
 * `feeding_agg_healed_cycle_id`) is written by both the ST-confirm handler and
 * Story 12.8's automatic reconciliation.
 *
 * An unknown field is REFUSED, not silently dropped, matching the
 * `additionalProperties: false` discipline Story 12.7's own request schema
 * established on TM Story's side: a stray field is a client bug, and a silent
 * drop is how a client bug survives to production.
 */
// Same key `feeding-tab.js:154` exports client-side; named here too so the
// guarded-write path below (`_feedingMarkerGuard`) does not repeat the literal.
const AGG_HEALED_MARKER = 'feeding_agg_healed_cycle_id';

const TRACKER_FIELDS = new Set([
  'vitae', 'willpower', 'bashing', 'lethal', 'aggravated',
  'influence', 'conditions', 'in_torpor',
  AGG_HEALED_MARKER,
]);

/** A finite number from a genuinely numeric value, else null. */
function numOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Either key shape a character document may carry (data-lock #18). */
function idFilter(raw) {
  try { return { _id: { $in: [new ObjectId(raw), raw] } }; }
  catch { return { _id: raw }; }
}

// GET /api/tracker_state/:character_id — get tracker for character
router.get('/:character_id', async (req, res) => {
  const raw = req.params.character_id;
  if (!canAccess(req, raw)) return res.status(403).json({ error: 'FORBIDDEN' });
  let filter;
  try { filter = { character_id: { $in: [new ObjectId(raw), raw] } }; }
  catch { filter = { character_id: raw }; }
  const doc = await col().findOne(filter);
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND', message: 'Tracker state not found for this character' });
  res.json(doc);
});

// PUT /api/tracker_state/:character_id — upsert tracker for character
router.put('/:character_id', async (req, res) => {
  const raw = req.params.character_id;
  if (!canAccess(req, raw)) return res.status(403).json({ error: 'FORBIDDEN' });
  // `_feedingMarkerGuard` is a CONTROL field, not a tracker_state field - stripped
  // here so it never reaches the whitelist check or the stored document. See its
  // own use below (independent re-verification follow-up, 2026-09-11).
  const { _id, character_id: _ignoredCharId, _feedingMarkerGuard, ...updates } = req.body || {};

  // AC 13: the whitelist, before anything else touches the body.
  const stray = Object.keys(updates).find(k => !TRACKER_FIELDS.has(k));
  if (stray) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `Unknown tracker_state field: ${stray}`,
    });
  }

  // AC 13 follow-up (independent re-verification, 2026-09-11): a PRESENT but
  // non-numeric vitae/influence (a string that does not parse, an object, an
  // array) used to fall through `numOrNull()` as null and skip the clamp below
  // silently - so `{ vitae: "abc" }` bypassed the ceiling entirely and wrote
  // literal garbage into tracker_state. Refused here, before the clamp even
  // needs a character document to check against. A field the caller never sent
  // is untouched (`'vitae' in updates` is false), which is the existing,
  // correct behaviour for a partial `$set` this route already relies on - only
  // a field that IS present and IS NOT a real number is new the refusal.
  for (const field of ['vitae', 'influence']) {
    if (field in updates && numOrNull(updates[field]) === null) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `${field} must be a number`,
      });
    }
  }

  // AC 13: the clamp. Story 12.7's own AC 2 doctrine - "the server derives,
  // never trusts the client" - had never actually reached this route; the only
  // ceiling either of these two fields had was `trackerAdj()`'s, which is
  // client-side and therefore no boundary at all. Both are clamped here against
  // the character's REAL maximum, read from the character document.
  //
  // A character document that cannot be read leaves the write UNCLAMPED rather
  // than refused: there is no ceiling to clamp against, and failing closed here
  // would break every existing ST tracker adjustment the moment a character
  // record went missing. The clamp is an upper bound on a legal write, not an
  // authorisation check - `canAccess()` above is that.
  let character = null;
  try { character = await getCollection('characters').findOne(idFilter(raw)); }
  catch { character = null; }

  if (character) {
    const vitae = numOrNull(updates.vitae);
    if (vitae !== null) updates.vitae = clamp(Math.trunc(vitae), 0, calcVitaeMax(character));
    const influence = numOrNull(updates.influence);
    if (influence !== null) updates.influence = clamp(Math.trunc(influence), 0, calcTotalInfluence(character));
  }

  let filter;
  try { filter = { character_id: { $in: [new ObjectId(raw), raw] } }; }
  catch { filter = { character_id: raw }; }

  let result;
  if (_feedingMarkerGuard !== undefined) {
    // Independent re-verification follow-up (2026-09-11): Story 12.8's automatic
    // reconciliation (`maybeReconcileFeed()`) and its Save-triggered twin both
    // read the marker, then compute a delta, then PUT - two near-simultaneous
    // callers for the SAME character (two open tabs, a retry racing the
    // original request) could each pass the "marker absent" check before either
    // writes, and both apply the delta. This is a real gap Story 12.7's own
    // atomic-write discipline (the roll route's `content.feeding.rollResult:
    // null` filter) exists to prevent, applied one layer down.
    //
    // NOT folded into the plain `upsert: true` path above: adding a marker
    // condition straight into an upsert filter risks Mongo inserting a SECOND
    // document for the same character_id the moment the filter fails to match
    // an existing one (a duplicate tracker_state row is a far worse bug than
    // the race this guards against). So the guarded write is NEVER an upsert:
    // it only ever updates a document that is already there and does not yet
    // carry this marker. A character with no tracker_state row yet has nothing
    // to race against (nobody else can have already applied a feed to a row
    // that does not exist), so that case falls through to the plain path below,
    // unguarded, exactly as it always has.
    const guardedFilter = { ...filter, [AGG_HEALED_MARKER]: { $ne: _feedingMarkerGuard } };
    result = await col().findOneAndUpdate(
      guardedFilter,
      { $set: { ...updates, character_id: raw } },
      { returnDocument: 'after' },
    );
    if (!result) {
      const existing = await col().findOne(filter);
      if (existing) {
        // The guard blocked this write: some other request already applied this
        // exact marker first. Report the row as it genuinely stands, not as a
        // failure - the caller's own feed IS applied, just not by this request.
        return res.json(existing);
      }
      // No document at all yet: nothing to guard against, safe to create.
      result = await col().findOneAndUpdate(
        filter,
        { $set: { ...updates, character_id: raw } },
        { returnDocument: 'after', upsert: true },
      );
    }
  } else {
    result = await col().findOneAndUpdate(
      filter,
      { $set: { ...updates, character_id: raw } },
      { returnDocument: 'after', upsert: true }
    );
  }

  // Broadcast to all connected WebSocket clients.
  //
  // Story 12.8 (AC 13, data-lock #17): `updates` is broadcast AFTER the clamp
  // above has been applied to it, not before. This line used to send the raw
  // request body, which was built before any clamp existed - so the moment a
  // clamp landed, every connected client (the ST's own combat tracker) would
  // have received the pre-clamp number while the database held the clamped one.
  // The object mutated above is deliberately the same object sent here, so the
  // two cannot drift apart again.
  broadcastTrackerUpdate(raw, updates);

  res.json(result);
});

// POST /api/tracker_state/:character_id/spend — player self-service Vitae/Willpower spend.
//
// Deliberately a SEPARATE, narrower route from the general PUT above, not an extra branch on
// it. PUT already carries a legitimate, validated player-writable INCREASE path — Story 12.8's
// automatic feeding reconciliation writes `vitae` UP from the player's own session when they
// load the Feeding tab — so a blanket "a non-ST caller may only decrease" rule on PUT would
// break that already-shipped feature. This route can never increase anything: it only ever
// subtracts a caller-declared amount, floored at 0, computed via a Mongo aggregation-pipeline
// update (not read-then-write) so two near-simultaneous spends — a double-click, two open tabs —
// can't race past each other and each apply their own subtraction against a stale read.
router.post('/:character_id/spend', async (req, res) => {
  const raw = req.params.character_id;
  if (!canAccess(req, raw)) return res.status(403).json({ error: 'FORBIDDEN' });

  const { field } = req.body || {};
  if (field !== 'vitae' && field !== 'willpower') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'field must be "vitae" or "willpower"' });
  }
  const amt = numOrNull(req.body?.amount);
  if (amt === null || amt <= 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'amount must be a positive number' });
  }
  const spend = Math.trunc(amt);

  let filter;
  try { filter = { character_id: { $in: [new ObjectId(raw), raw] } }; }
  catch { filter = { character_id: raw }; }

  // No upsert: a spend against a character with no tracker_state row yet has no real current
  // value to subtract from (the row is normally created by the sheet's own initial load, before
  // a player could ever reach a spend control) — fail closed rather than guess a starting value.
  const result = await col().findOneAndUpdate(
    filter,
    [{ $set: { [field]: { $max: [0, { $subtract: [{ $ifNull: [`$${field}`, 0] }, spend] }] } } }],
    { returnDocument: 'after' },
  );
  if (!result) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'No tracker state on file yet for this character - load the sheet first.' });
  }

  broadcastTrackerUpdate(raw, { [field]: result[field] });
  res.json(result);
});

// DELETE /api/tracker_state — ST/dev only, bulk wipe for game-start reset
router.delete('/', async (req, res) => {
  const role = req.user?.role;
  if (role !== 'st' && role !== 'dev') return res.status(403).json({ error: 'FORBIDDEN' });
  const result = await col().deleteMany({});
  res.json({ deleted: result.deletedCount });
});

export default router;
