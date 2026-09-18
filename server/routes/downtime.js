/**
 * Downtime submissions and joint-project invitations.
 *
 * cm-2b: the third router this file used to hold, `cyclesRouter`, moved out to
 * `chapters.js` when the `downtime_cycles` collection was renamed to
 * `chapters`. `submissionsRouter` and `projectInvitationsRouter` are unchanged
 * in behaviour; what changed here is the FK NAME they read on a submission
 * (`cycle_id` -> `chapter_id`) and the collection they resolve a Chapter from.
 *
 * NOTE the THREE FKs that deliberately did NOT rename: `project_invitations`
 * and `ranking_ballots` each carry their own `cycle_id`, and `npcs` carries
 * `linked_cycle_id`. None of them is `downtime_submissions.cycle_id`. cm-2b's
 * ruling is about the Chapter container and the one FK that names it from a
 * submission; sweeping the others in would have been the blind
 * find-and-replace AC6 explicitly forbids. Logged for a follow-up story
 * instead, and listed in `specs/cm-2b-cross-repo-coordination.md` §6 — which
 * carries the same list of three, so the two documents agree.
 *
 * DUAL-READ SHIM. Every read of the submission Chapter FK in this file goes
 * through `../helpers/chapter-fk.js`: `chapter_id`, falling back to `cycle_id`
 * when absent, both storage types. Every WRITE path writes `chapter_id` only
 * and rejects a body still carrying `cycle_id` (400 LEGACY_CYCLE_ID_REJECTED).
 * That module's header explains why the asymmetry is load-bearing, and why
 * `project_invitations`' own `cycle_id` writes below are untouched by it.
 */

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getCollection } from '../db.js';
import { requireRole, isStRole } from '../middleware/auth.js';
import { stripStReview } from '../helpers/strip-st-review.js';
import { validate } from '../middleware/validate.js';
import { downtimeSubmissionSchema } from '../schemas/downtime_submission.schema.js';
import { sendDowntimePublishedEmail } from '../helpers/email.js';
// CM-1 (#1028): the pure phase contract, shared verbatim with the client and
// the tests (public/js/downtime/cycle-phase.js has no I/O and no browser
// globals, so the server imports it directly).
import { FEEDING_ONLY_FIELDS, openCycleVerdict } from '../../public/js/downtime/cycle-phase.js';
// 2026-08-25: TM Game's own half of the D6 cross-repo decision (see that
// module's own header). STs pass through unaffected.
import { FORM_RETIRED } from '../../public/js/downtime/form-retirement.js';
// cm-2b dual-read shim. See that module's header for the read/write contract.
import {
  CHAPTER_FK,
  CHAPTER_FK_PROJECTION,
  chapterFkQueryParam,
  readChapterFk,
  readChapterFkOid,
  normaliseChapterFkForResponse,
  rejectLegacyChapterFk,
  withChapterFk,
} from '../helpers/chapter-fk.js';
// Story storytab.1: TM Story cross-app downtime fetch + adapter.
import { fetchStoryDowntimes, adaptStoryReport, syntheticChapterFor } from '../lib/story-downtime-fetch.js';

function parseId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

// D6: this form is retired for players (form-retirement.js). STs pass
// through — they still need to correct/annotate submissions filed before
// the cutover. A stable error code so the client can surface a clear
// message rather than a generic failure.
function requireFormNotRetiredForPlayers(req, res, next) {
  // 2026-09-01 general audit fix: was role === 'player', which let a
  // coordinator-role account (real, distinct role, scoped to check-in/
  // finance/emergency only) bypass the retirement gate and submit new
  // downtime writes — the same root cause as the ownership-check fixes
  // below, just for this one gate.
  if (FORM_RETIRED && !isStRole(req.user)) {
    return res.status(403).json({
      error: 'FORM_RETIRED',
      message: 'This form no longer accepts new downtime submissions. File on the sibling site instead.',
    });
  }
  next();
}

// dt-form.17 (ADR-003 §Q11): hard server gate on submission edits when the
// cycle is closed. Hard mirror's contract is that cycle-close seals the state
// in both directions; players and ST alike cannot mutate a submission whose
// cycle is closed. Returns 423 Locked with a stable error code so the client
// can surface a clear message and stop retrying.
async function requireOpenCycle(req, res, next) {
  const oid = parseId(req.params.id);
  if (!oid) return next(); // existing handler returns 400 for the format error
  const sub = await getCollection('downtime_submissions').findOne(
    { _id: oid },
    // cm-2b: BOTH FK names are projected. Projecting only `chapter_id` would
    // make the legacy fallback unreachable — the field would be stripped
    // before `readChapterFk` ever saw it, and this gate fails OPEN on a
    // missing FK, so a pre-migration submission would skip the deadline and
    // phase checks entirely.
    { projection: { ...CHAPTER_FK_PROJECTION, character_id: 1 } }
  );
  if (!sub) return next(); // existing handler returns 404
  const cycleOid = readChapterFkOid(sub);
  // Unchanged behaviour: a submission attached to no Chapter at all still
  // passes through (the gate has nothing to gate on). What the shim changes is
  // that a PRE-MIGRATION submission — `cycle_id` only — no longer looks like
  // that case. Nothing can write a `cycle_id`-only submission any more either;
  // see `rejectLegacyChapterFk` on the write verbs below.
  if (!cycleOid) return next();
  const cycle = await getCollection('chapters').findOne(
    { _id: cycleOid },
    { projection: { status: 1, phase: 1, out_of_window_player_ids: 1 } }
  );
  // CM-1 (#1028): phase-aware verdict, extracted pure so the matrix is
  // unit-testable. Cycles carrying a known `phase` use the new lane (feeding
  // fields writable in prep and game, general edits in downtime, ST always);
  // cycles without one get the legacy status==='closed' gate byte-identical,
  // including the out-of-window exception (issue #295).
  const charIdStr = String(sub.character_id || '');
  const oowIds = (cycle?.out_of_window_player_ids || []).map(String);
  const verdict = openCycleVerdict({
    cycle,
    role: req.user?.role,
    bodyKeys: Object.keys(req.body || {}),
    oowMatch: !!charIdStr && oowIds.includes(charIdStr),
  });
  if (verdict === 'locked') {
    return res.status(423).json({
      error: 'CYCLE_CLOSED',
      message: 'Cycle is closed; submissions are locked',
    });
  }
  return next();
}

// --- Submissions: /api/downtime_submissions ---

export const submissionsRouter = Router();
const submissions = () => getCollection('downtime_submissions');
// cm-2b: the Chapter container, formerly `downtime_cycles`. Read-only from
// this file except for the joint-project cascades, which edit
// `chapters.joint_projects[]` in place.
const chapters = () => getCollection('chapters');

/** STM-8 (issue #415, ADR-004 Rev 3 §D10): walk a request body for any
 *  `pool_snapshot` field and enforce the math invariant
 *  `final === base + Σ mods[].delta`. Returns an array of failure
 *  descriptors (empty when all snapshots are well-formed).
 *
 *  Handles three shapes the client may send:
 *  1. Direct key:           `pool_snapshot: { base, mods, final }`
 *  2. Dot-notation key:     `'projects_resolved.0.pool_snapshot': { ... }`
 *  3. Nested in array/obj:  `projects_resolved: [{ ..., pool_snapshot: {...} }]`
 *
 *  Validates ONLY when the key is literally `pool_snapshot` (or ends
 *  with `.pool_snapshot`) so unrelated objects that happen to have
 *  base/mods/final fields aren't false-positive flagged. */
function _validatePoolSnapshots(obj, errors = []) {
  if (obj == null || typeof obj !== 'object') return errors;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'pool_snapshot' || k.endsWith('.pool_snapshot')) {
      if (v == null) continue;            // explicit null / unset — fine
      if (typeof v !== 'object' || Array.isArray(v)) {
        errors.push({ key: k, reason: 'pool_snapshot must be an object' });
        continue;
      }
      if (typeof v.base !== 'number' || !Array.isArray(v.mods) || typeof v.final !== 'number') {
        errors.push({ key: k, reason: 'pool_snapshot requires { base: number, mods: array, final: number }' });
        continue;
      }
      let sumDelta = 0;
      for (const m of v.mods) {
        if (m && Number.isInteger(m.delta)) sumDelta += m.delta;
      }
      if (v.final !== v.base + sumDelta) {
        errors.push({ key: k, base: v.base, mods_sum: sumDelta, final: v.final, expected: v.base + sumDelta });
      }
    } else if (Array.isArray(v)) {
      for (const e of v) _validatePoolSnapshots(e, errors);
    } else if (v && typeof v === 'object') {
      _validatePoolSnapshots(v, errors);
    }
  }
  return errors;
}

// POST /api/downtime_submissions — both roles can create
//
// cm-2b: `rejectLegacyChapterFk` runs BEFORE schema validation on purpose. The
// submission schema is `additionalProperties: true` (it has to be — the
// responses blob is open-ended), so ajv would wave a stray `cycle_id` straight
// through to the writer. The reason a caller needs is "you are running stale
// code", which is a named refusal, not an unknown-property error.
submissionsRouter.post('/', requireFormNotRetiredForPlayers, rejectLegacyChapterFk, validate(downtimeSubmissionSchema), async (req, res) => {
  // STM-8 (issue #415): enforce pool_snapshot invariant on create too.
  // Resolution-time writes go via PUT so this path rarely has snapshots,
  // but a future bulk-import flow could send them here; cheaper to guard
  // both endpoints than to debug a corrupted historical record later.
  const snapErrors = _validatePoolSnapshots(req.body);
  if (snapErrors.length > 0) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'pool_snapshot math invariant violated (final must equal base + Σ delta)',
      failures: snapErrors,
    });
  }

  const doc = { ...req.body };
  // Normalise ID fields to ObjectId so GET queries match correctly
  if (doc.chapter_id) {
    const oid = parseId(String(doc.chapter_id));
    if (oid) doc.chapter_id = oid;
  }
  if (doc.character_id) {
    const oid = parseId(String(doc.character_id));
    if (oid) doc.character_id = oid;
  }
  const result = await submissions().insertOne(doc);
  const created = await submissions().findOne({ _id: result.insertedId });
  res.status(201).json(created);
});

// GET /api/downtime_submissions/hold-flags?chapter_id=<id>
// Returns { <character_id>: bool } — true == on hold (below-minimum or
// missing submission). ST sees every character in the cycle; player sees
// only their own characters' entries.
//
// Issue #257 (perf): replaces the prior N-char client loop in
// `public/js/data/dt-hold-flag.js` (one /api/downtime_submissions GET
// per character) with a single round-trip + one indexed `find` on the
// submissions collection. Biggest MongoDB-cost reduction on ST/dev
// boot (~30 calls → 1).
//
// Note: returns entries ONLY for characters that have a submission for
// the cycle. The client defaults to `true` (on hold) for any character
// absent from the map — matches the existing fallback semantics at
// dt-hold-flag.js line 39 ('No submission yet for this cycle ⇒
// definitely below-minimum.'). Keeping the absence-as-true contract
// server-side too would require knowing every character ID in scope,
// which is unnecessary work.
//
// Story storytab.1: TM Story-sourced downtimes for ONE character, adapted into this
// repo's own `tm_game`-shaped pseudo-submissions (see server/lib/story-downtime-fetch.js
// for the full rationale). A DEDICATED endpoint rather than folding this into `GET /`
// below deliberately: that route also serves this repo's own ST review/edit workflows
// (PUT /:id, DELETE /:id) against REAL `tm_game.downtime_submissions` documents, and a
// synthetic pseudo-submission mixed into that array risks an ST attempting to edit one.
// Read-only: exactly one outbound GET to TM Story, no write anywhere (AC 2; Story
// storytab.4 owns the structural proof). Registered BEFORE `GET /` for the same routing
// reason as `/hold-flags` above.
submissionsRouter.get('/story-tab', async (req, res) => {
  const characterId = req.query.character_id;
  if (!characterId) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'character_id required' });
  }
  // Same ownership rule as `GET /` below: a player may only ask for their own character.
  // An ST previewing another character's Story tab is allowed through here (matching this
  // route's own general ST bypass). If that ST is not TM Story's own named superviewer,
  // TM Story's OWN ownership gate will simply return nothing for this call, which the
  // graceful-degradation path below already handles the same as any other TM Story failure.
  if (!isStRole(req.user)) {
    const ids = (req.user.character_ids || []).map(String);
    if (!ids.includes(String(characterId))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your character' });
    }
  }
  const { downtimes } = await fetchStoryDowntimes({ authorization: req.headers.authorization, characterId });
  const subs = [];
  const chapters = [];
  downtimes.forEach((report, rankFromNewest) => {
    subs.push(adaptStoryReport(report, characterId, rankFromNewest));
    chapters.push(syntheticChapterFor(characterId, rankFromNewest));
  });
  res.json({ downtimes: subs, chapters });
});

// Registered BEFORE `GET /` so Express routes `/hold-flags` to this
// handler rather than treating it as a query of the list endpoint.
submissionsRouter.get('/hold-flags', async (req, res) => {
  // cm-2b dual-read: `?chapter_id=`, falling back to a stale client's
  // `?cycle_id=`. The 400-when-absent contract is unchanged.
  const { raw: chapterRaw, name: paramName } = chapterFkQueryParam(req.query);
  if (!chapterRaw) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${CHAPTER_FK} required` });
  }
  const cycleOid = parseId(chapterRaw);
  if (!cycleOid) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `Invalid ${paramName} format` });
  }

  // One shared helper for both the ObjectId/string split (issue #497) and the
  // chapter_id/cycle_id split (cm-2b) — not two patterns layered on each other.
  let filter = withChapterFk({}, chapterRaw);

  // 2026-09-01 general audit fix: was role === 'player'. Restrict to their
  // characters (mirrors `GET /` scoping below).
  if (!isStRole(req.user)) {
    const charIdOids = (req.user.character_ids || []).map(id =>
      id instanceof ObjectId ? id : new ObjectId(id)
    );
    const charIdStrs = charIdOids.map(id => id.toString());
    filter.character_id = { $in: [...charIdOids, ...charIdStrs] };
  }

  // Project only fields needed for the flag derivation — keeps the
  // wire size small even on ST cohorts of 30+ chars.
  const docs = await submissions()
    .find(filter, { projection: { character_id: 1, status: 1, 'responses._has_minimum': 1 } })
    .toArray();

  const map = {};
  for (const doc of docs) {
    const key = String(doc.character_id);
    const hasMin = doc.responses?._has_minimum;
    // Derivation mirrors the pre-fix client logic at
    // dt-hold-flag.js:43-50 exactly: trust the persisted derived bool
    // when present; otherwise fall back to the submission's coarse
    // status (status !== 'submitted' ⇒ on hold).
    if (typeof hasMin === 'boolean') {
      map[key] = !hasMin;
    } else {
      map[key] = doc.status !== 'submitted';
    }
  }
  res.json(map);
});

// GET /api/downtime_submissions — ST gets all, player gets only their own (st_review stripped)
submissionsRouter.get('/', async (req, res) => {
  let filter = {};
  // cm-2b dual-read: `?chapter_id=`, falling back to a stale client's
  // `?cycle_id=`. Before the shim, `?cycle_id=` matched no known param and this
  // route returned the ENTIRE collection unfiltered — a stale client asking for
  // one Chapter's submissions got every submission in the game.
  const { raw: chapterRaw, name: paramName } = chapterFkQueryParam(req.query);
  if (chapterRaw) {
    const oid = parseId(chapterRaw);
    if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: `Invalid ${paramName} format` });
    filter = withChapterFk(filter, chapterRaw);
  }

  // 2026-09-01 general audit fix (High severity): was role === 'player',
  // which let a coordinator-role account read every player's downtime
  // submission unrestricted (see the matching st_review strip fix below —
  // both gates must move together or a coordinator gets unfiltered rows
  // WITH unredacted ST notes). Restrict to their characters.
  // Accept both ObjectId and legacy string-stored character_ids (CSV imports may store as string)
  if (!isStRole(req.user)) {
    const charIdOids = (req.user.character_ids || []).map(id =>
      id instanceof ObjectId ? id : new ObjectId(id)
    );
    const charIdStrs = charIdOids.map(id => id.toString());
    filter.character_id = { $in: [...charIdOids, ...charIdStrs] };
  }

  const docs = await submissions().find(filter).toArray();

  // 2026-09-01 general audit fix: was role === 'player' — must move with
  // the ownership filter above (a coordinator otherwise saw unredacted
  // ST review notes on every submission).
  if (!isStRole(req.user)) {
    docs.forEach(doc => stripStReview(doc));
  }

  // cm-2b: a pre-migration document leaves the API naming its Chapter
  // `chapter_id`, whatever it is stored as. Without this the client fetches it
  // (the filter above found it) and then drops it on the floor, because every
  // client reader looks for `chapter_id`. Read-only: nothing is written back.
  docs.forEach(doc => normaliseChapterFkForResponse(doc));

  res.json(docs);
});

// PUT /api/downtime_submissions/:id — ST can update any, player can update own (before deadline)
// dt-form.17: cycle-close gate (ADR-003 §Q11) returns 423 before the handler runs.
// D6 (2026-08-29): requireFormNotRetiredForPlayers was wired onto POST only when the
// retirement flag shipped (2026-08-25) — an oversight, not a deliberate asymmetry. A
// player could still write to an EXISTING submission via this route whenever its own
// cycle's phase is 'downtime' (requireOpenCycle has no knowledge of FORM_RETIRED at
// all), which is exactly the "still filing on this form" confusion the retirement
// exists to prevent. STs are unaffected, same exemption as POST.
submissionsRouter.put('/:id', requireFormNotRetiredForPlayers, rejectLegacyChapterFk, requireOpenCycle, async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid submission ID format' });

  // Load existing doc for ownership check and publish-transition detection
  const existing = await submissions().findOne({ _id: oid });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Submission not found' });

  // 2026-09-01 general audit fix (High severity): was role === 'player',
  // which let a coordinator-role account edit ANY player's submission,
  // bypass the cycle-deadline gate, and (see the st_review strip fix
  // below) write st_review fields and trigger the publish-transition
  // email. Verify ownership and deadline.
  if (!isStRole(req.user)) {
    const charIds = (req.user.character_ids || []).map(id => id.toString());
    if (!charIds.includes(existing.character_id?.toString())) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your submission' });
    }

    // Enforce cycle deadline — but allow feeding-related fields through,
    // since feeding rolls happen at game time (after the submission deadline;
    // from CM-1 on, also during prep). Field list shared with the phase gate
    // via cycle-phase.js so the two cannot drift.
    const allFieldsFeeding = Object.keys(req.body).every(k => FEEDING_ONLY_FIELDS.includes(k));
    // cm-2b dual-read: a pre-migration submission carries `cycle_id` only, and
    // reading `chapter_id` alone would skip the deadline gate for exactly the
    // players whose submissions predate the migration.
    if (!allFieldsFeeding && readChapterFk(existing) != null) {
      const cycleOid = readChapterFkOid(existing);
      if (cycleOid) {
        const cycle = await chapters().findOne({ _id: cycleOid });
        if (!cycle?.manual_open && cycle?.deadline_at && new Date(cycle.deadline_at) < new Date()) {
          return res.status(403).json({ error: 'DEADLINE_PASSED', message: 'Submissions for this cycle are closed.' });
        }
      }
    }

    // Players cannot modify st_review fields (including dot-notation paths)
    delete req.body.st_review;
    for (const key of Object.keys(req.body)) {
      if (key.startsWith('st_review.')) delete req.body[key];
    }
  }

  // Detect publish transition (ST only — player requests can't reach this with st_review fields)
  const isPublishTransition =
    req.body['st_review.outcome_visibility'] === 'published' &&
    existing?.st_review?.outcome_visibility !== 'published';

  // STM-8 (issue #415, ADR-004 Rev 3 §D10): enforce pool_snapshot math
  // invariant on any pool_snapshot field present in the update. final
  // MUST equal base + Σ mods[].delta — without this guard a buggy client
  // could persist a snapshot whose total contradicts its breakdown,
  // poisoning the audit record.
  const snapErrors = _validatePoolSnapshots(req.body);
  if (snapErrors.length > 0) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'pool_snapshot math invariant violated (final must equal base + Σ delta)',
      failures: snapErrors,
    });
  }

  const { _id, ...updates } = req.body;
  // Issue #497: coerce FK strings → ObjectId before write, mirroring the POST
  // path (above). PUT bodies rarely carry chapter_id/character_id, but if they
  // do, a string value would re-introduce the mixed-type split. Malformed
  // (non-24-hex) values are left untouched, matching the POST guard.
  if (updates.chapter_id) {
    const cidOid = parseId(String(updates.chapter_id));
    if (cidOid) updates.chapter_id = cidOid;
  }
  if (updates.character_id) {
    const charOid = parseId(String(updates.character_id));
    if (charOid) updates.character_id = charOid;
  }
  const result = await submissions().findOneAndUpdate(
    { _id: oid },
    { $set: updates },
    { returnDocument: 'after' }
  );

  if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'Submission not found' });

  // Sync Mandragora Garden parked flags on the character based on the latest
  // submission state. Per-rite intent: rites named in the submission have
  // their flag set/cleared by sorcery_${n}_mandragora; rites not mentioned
  // in this submission are unchanged.
  await _syncMandragoraParkedFlags(result).catch(err =>
    console.error('[mandragora] flag sync error:', err.message)
  );

  // 2026-09-01 general audit fix: was role === 'player' — must match the
  // ownership-check gate above, or a coordinator's own PUT response would
  // echo back unredacted st_review even though they were correctly blocked
  // from writing it.
  if (!isStRole(req.user)) {
    stripStReview(result);
  }

  normaliseChapterFkForResponse(result);   // cm-2b, see GET / above
  res.json(result);

  // Fire-and-forget email on publish transition
  if (isPublishTransition) {
    _sendPublishedEmail(result).catch(err =>
      console.error('[email] Publish email error:', err.message)
    );
  }
});

/** Sync Mandragora Garden parked flags on a character from a downtime
 *  submission. For each sorcery slot in the submission with a rite name set,
 *  the corresponding rite power on the character has its mandragora_parked
 *  flag set to match `sorcery_${n}_mandragora === 'yes'`. Rites not mentioned
 *  in the submission are left unchanged. */
async function _syncMandragoraParkedFlags(submission) {
  const responses = submission?.responses;
  if (!responses || !submission.character_id) return;
  const slotCount = parseInt(responses.sorcery_slot_count || '0', 10);
  if (slotCount <= 0) return;

  const wantedByName = new Map();
  for (let n = 1; n <= slotCount; n++) {
    const riteName = responses[`sorcery_${n}_rite`];
    if (!riteName) continue;
    wantedByName.set(String(riteName), responses[`sorcery_${n}_mandragora`] === 'yes');
  }
  if (wantedByName.size === 0) return;

  const charOid = submission.character_id instanceof ObjectId
    ? submission.character_id
    : parseId(String(submission.character_id));
  if (!charOid) return;

  const character = await getCollection('characters').findOne({ _id: charOid });
  if (!character?.powers) return;

  let changed = false;
  const newPowers = character.powers.map(p => {
    if (p.category !== 'rite') return p;
    if (!wantedByName.has(p.name)) return p;
    const wantParked = wantedByName.get(p.name);
    if (Boolean(p.mandragora_parked) === wantParked) return p;
    changed = true;
    return { ...p, mandragora_parked: wantParked };
  });
  if (changed) {
    await getCollection('characters').updateOne(
      { _id: charOid },
      { $set: { powers: newPowers } }
    );
  }
}

// JDT-6: Delete a downtime submission with joint cascade. ST only.
//   - If the submission is the lead on any joint, cancel that joint
//     (cancelled_reason='lead-submission-deleted'), flip pending invitations
//     to cancelled-by-lead, and clear all accepted supports' slot fields.
//   - If the submission is an accepted participant on any joint, decouple
//     the participant entry and flip their invitation to decoupled.
//   - Then delete the submission.
submissionsRouter.delete('/:id', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid submission ID' });

  const sub = await submissions().findOne({ _id: oid });
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND', message: 'Submission not found' });

  // cm-2b dual-read: a pre-migration submission still resolves its Chapter, so
  // the joint-project cascade below runs for it rather than silently leaving
  // orphaned joints and invitations behind.
  const cycleOid = readChapterFkOid(sub);
  const subIdStr = String(oid);
  const now = new Date().toISOString();
  const cascade = { joints_cancelled: 0, participants_decoupled: 0 };

  if (cycleOid) {
    const cycle = await chapters().findOne({ _id: cycleOid });
    if (cycle) {
      // ── Lead cascade ──
      const leadJoints = (cycle.joint_projects || []).filter(j =>
        String(j.lead_submission_id) === subIdStr && !j.cancelled_at
      );
      for (const joint of leadJoints) {
        await chapters().updateOne(
          { _id: cycleOid, 'joint_projects._id': joint._id },
          { $set: {
            'joint_projects.$.cancelled_at': now,
            'joint_projects.$.cancelled_reason': 'lead-submission-deleted',
          }},
        );
        await getCollection('project_invitations').updateMany(
          { joint_project_id: String(joint._id), status: 'pending' },
          { $set: { status: 'cancelled-by-lead', cancelled_at: now } },
        );
        for (const p of (joint.participants || []).filter(p => !p.decoupled_at)) {
          const psubOid = parseId(String(p.submission_id));
          if (psubOid) {
            const slot = Number(p.project_slot);
            await submissions().updateOne(
              { _id: psubOid },
              { $set: {
                [`responses.project_${slot}_action`]: '',
                [`responses.project_${slot}_joint_id`]: null,
                [`responses.project_${slot}_joint_role`]: null,
                [`responses.project_${slot}_description`]: '',
                [`responses.project_${slot}_personal_notes`]: '',
              }},
            );
          }
          await getCollection('project_invitations').updateOne(
            { _id: p.invitation_id },
            { $set: { status: 'decoupled', decoupled_at: now } },
          );
          await chapters().updateOne(
            { _id: cycleOid, 'joint_projects._id': joint._id, 'joint_projects.participants.invitation_id': p.invitation_id },
            { $set: { 'joint_projects.$[j].participants.$[pp].decoupled_at': now } },
            { arrayFilters: [{ 'j._id': joint._id }, { 'pp.invitation_id': p.invitation_id }] },
          );
        }
        cascade.joints_cancelled++;
      }

      // ── Participant cascade ──
      // Re-read cycle in case lead-cascade above edited it
      const refreshed = await chapters().findOne({ _id: cycleOid });
      const partJoints = (refreshed?.joint_projects || []).filter(j =>
        !j.cancelled_at && (j.participants || []).some(p =>
          String(p.submission_id) === subIdStr && !p.decoupled_at
        )
      );
      for (const joint of partJoints) {
        for (const p of joint.participants.filter(p =>
          String(p.submission_id) === subIdStr && !p.decoupled_at
        )) {
          await getCollection('project_invitations').updateOne(
            { _id: p.invitation_id },
            { $set: { status: 'decoupled', decoupled_at: now } },
          );
          await chapters().updateOne(
            { _id: cycleOid, 'joint_projects._id': joint._id, 'joint_projects.participants.invitation_id': p.invitation_id },
            { $set: { 'joint_projects.$[j].participants.$[pp].decoupled_at': now } },
            { arrayFilters: [{ 'j._id': joint._id }, { 'pp.invitation_id': p.invitation_id }] },
          );
          cascade.participants_decoupled++;
        }
      }
    }
  }

  await submissions().deleteOne({ _id: oid });
  res.json({ deleted: true, cascade });
});

// ── DTSR-8 / DTSR-9: section flags ──────────────────────────────────
// Players flag a section of their published outcome they want their
// ST to review. STs resolve flags via the DT Story inbox (DTSR-9).

const VALID_FLAG_CATEGORIES = ['inconsistent', 'wrong_story', 'other'];

// POST /api/downtime_submissions/:id/section-flag — players only, own submission
submissionsRouter.post('/:id/section-flag', async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid submission ID' });

  if (req.user.role !== 'player') return res.status(403).json({ error: 'FORBIDDEN', message: 'Only players may flag a section' });

  const sub = await submissions().findOne({ _id: oid });
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND', message: 'Submission not found' });

  const charIds = (req.user.character_ids || []).map(id => id.toString());
  if (!charIds.includes(sub.character_id?.toString())) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your submission' });
  }

  const { section_key, section_idx, category, reason } = req.body || {};
  if (!section_key || typeof section_key !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'section_key required' });
  }
  if (!VALID_FLAG_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invalid category' });
  }
  const reasonText = (reason || '').toString().trim();
  if (category === 'other' && reasonText.length < 5) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'reason required for other (min 5 chars)' });
  }

  const flag = {
    _id: new ObjectId().toString(),
    section_key,
    section_idx: section_idx == null ? null : Number(section_idx),
    category,
    reason: reasonText,
    created_at: new Date().toISOString(),
    player_id: String(req.user._id || req.user.id || ''),
    status: 'open',
    resolved_at: null,
    resolution_note: null,
  };

  await submissions().updateOne({ _id: oid }, { $push: { section_flags: flag } });
  res.status(201).json(flag);
});

// PATCH /api/downtime_submissions/:id/section-flag/:flagId
// Player path: status: 'recalled' (only own submission, only own flag)
// ST path:     status: 'resolved' + resolution_note
submissionsRouter.patch('/:id/section-flag/:flagId', async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid submission ID' });

  const sub = await submissions().findOne({ _id: oid });
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND', message: 'Submission not found' });

  const flag = (sub.section_flags || []).find(f => String(f._id) === String(req.params.flagId));
  if (!flag) return res.status(404).json({ error: 'NOT_FOUND', message: 'Flag not found' });

  const newStatus = req.body?.status;
  if (newStatus === 'recalled') {
    if (req.user.role !== 'player') return res.status(403).json({ error: 'FORBIDDEN', message: 'Players recall their own flags' });
    const charIds = (req.user.character_ids || []).map(id => id.toString());
    if (!charIds.includes(sub.character_id?.toString())) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your submission' });
    }
    if (String(flag.player_id) !== String(req.user._id || req.user.id || '')) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your flag' });
    }
    flag.status = 'recalled';
  } else if (newStatus === 'resolved') {
    if (req.user.role !== 'st') return res.status(403).json({ error: 'FORBIDDEN', message: 'Only STs may resolve flags' });
    flag.status = 'resolved';
    flag.resolved_at = new Date().toISOString();
    flag.resolution_note = (req.body?.resolution_note || '').toString().trim() || null;
  } else {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'status must be "recalled" or "resolved"' });
  }

  await submissions().updateOne(
    { _id: oid, 'section_flags._id': flag._id },
    { $set: { 'section_flags.$': flag } }
  );
  res.json(flag);
});

// ── JDT-2: Project invitations: /api/project_invitations ─────────────

export const projectInvitationsRouter = Router();
const projectInvitations = () => getCollection('project_invitations');

// GET /api/project_invitations?cycle_id=...&character_id=...&status=...
//
// ST: returns all invitations on the cycle.
// Player: returns invitations they sent (lead) ∪ invitations they received
//   (invited_character_id ∈ user.character_ids). Used by JDT-2 for the
//   lead's status badges and by JDT-3 for the invitee inbox.
//
// Optional filters:
//   - character_id: narrow to invitations targeted at a specific character
//     (player can only filter to one of their own characters).
//   - status: narrow to a specific lifecycle state (pending, accepted, ...).
//
// Each invitation is enriched with `_joint`, the cycle.joint_projects[]
// entry it points to (or null if missing), so the client has the joint
// description / action_type / lead inline without a second fetch.
projectInvitationsRouter.get('/', async (req, res) => {
  const cycleIdRaw = req.query.cycle_id;
  if (!cycleIdRaw) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'cycle_id required' });
  }

  const filter = { cycle_id: String(cycleIdRaw) };
  if (req.query.status) filter.status = String(req.query.status);

  if (req.user.role !== 'st') {
    const userCharIds = (req.user.character_ids || []).map(id => String(id));
    if (userCharIds.length === 0) return res.json([]);

    if (req.query.character_id) {
      // Explicit character filter — must be one of caller's characters.
      const requested = String(req.query.character_id);
      if (!userCharIds.includes(requested)) return res.json([]);
      filter.invited_character_id = requested;
    } else {
      // No explicit filter — return invitee-received ∪ lead-sent.
      const cycleOid = parseId(cycleIdRaw);
      let leadJointIds = [];
      if (cycleOid) {
        const cycle = await chapters().findOne({ _id: cycleOid });
        leadJointIds = (cycle?.joint_projects || [])
          .filter(j => userCharIds.includes(String(j.lead_character_id)))
          .map(j => String(j._id));
      }
      filter.$or = [
        { invited_character_id: { $in: userCharIds } },
        ...(leadJointIds.length ? [{ joint_project_id: { $in: leadJointIds } }] : []),
      ];
    }
  } else if (req.query.character_id) {
    // ST may filter freely.
    filter.invited_character_id = String(req.query.character_id);
  }

  const docs = await projectInvitations().find(filter).toArray();

  // Enrich with _joint
  const cycleOid = parseId(cycleIdRaw);
  let jointsById = {};
  if (cycleOid) {
    const cycle = await chapters().findOne({ _id: cycleOid });
    for (const j of (cycle?.joint_projects || [])) {
      jointsById[String(j._id)] = j;
    }
  }
  for (const inv of docs) {
    inv._joint = jointsById[String(inv.joint_project_id)] || null;
  }

  res.json(docs);
});

// ── JDT-3: accept / decline lifecycle ────────────────────────────────
// Accept: race-safe — re-reads invitation, requires status=pending. Finds
// (or creates) the invitee's submission for the cycle, picks the lowest
// available slot, writes the joint markers onto that slot, appends the
// participant entry to joint.participants[]. Returns the bundled state.
projectInvitationsRouter.post('/:id/accept', async (req, res) => {
  const invId = req.params.id;
  const inv = await projectInvitations().findOne({ _id: invId });
  if (!inv) return res.status(404).json({ error: 'NOT_FOUND', message: 'Invitation not found' });

  // Auth: caller must own invited_character_id (ST may also accept on a
  // player's behalf for support, e.g. ST-driven testing).
  if (req.user.role !== 'st') {
    const userCharIds = (req.user.character_ids || []).map(String);
    if (!userCharIds.includes(String(inv.invited_character_id))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your invitation' });
    }
  }

  if (inv.status !== 'pending') {
    return res.status(409).json({ error: 'CONFLICT', message: 'Invitation no longer pending', current_status: inv.status });
  }

  // Locate cycle + joint
  const cycleOid = parseId(inv.cycle_id);
  if (!cycleOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle_id on invitation' });
  const cycle = await chapters().findOne({ _id: cycleOid });
  if (!cycle) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  const joint = (cycle.joint_projects || []).find(j => String(j._id) === String(inv.joint_project_id));
  if (!joint || joint.cancelled_at) {
    return res.status(409).json({ error: 'CONFLICT', message: 'Joint no longer available' });
  }

  // Find / create invitee submission for the cycle
  const charOid = parseId(inv.invited_character_id);
  let sub = null;
  if (charOid) {
    // Issue #497: tolerate both ObjectId and string chapter_id. (Joints are a
    // DT2+ feature so a string-typed DT1 submission can't actually be a joint
    // invitee, but this keeps every submission-by-chapter_id read uniformly
    // dual-type during the migration grace window.)
    // cm-2b: `withChapterFk` composes the Chapter-FK clause with this filter's
    // OWN `$or` (the dual-type character_id match) rather than either one
    // clobbering the other's top-level `$or`.
    sub = await submissions().findOne(withChapterFk({
      $or: [{ character_id: charOid }, { character_id: String(inv.invited_character_id) }],
    }, cycleOid));
  }
  if (!sub) {
    const charValue = charOid || String(inv.invited_character_id);
    const insertResult = await submissions().insertOne({
      character_id: charValue,
      chapter_id: cycleOid,
      status: 'draft',
      responses: {},
    });
    sub = await submissions().findOne({ _id: insertResult.insertedId });
  }

  // Find lowest-numbered available slot (no action set)
  const responses = sub.responses || {};
  let slot = null;
  for (let n = 1; n <= 4; n++) {
    if (!responses[`project_${n}_action`]) { slot = n; break; }
  }
  if (!slot) {
    return res.status(409).json({ error: 'CONFLICT', message: 'No available project slots' });
  }

  const now = new Date().toISOString();

  // Mutate (sequence is fine at our scale; transactional wrap not required)
  await projectInvitations().updateOne(
    { _id: invId },
    { $set: {
      status: 'accepted',
      responded_at: now,
      invited_submission_id: String(sub._id),
    }},
  );

  await chapters().updateOne(
    { _id: cycleOid, 'joint_projects._id': joint._id },
    { $push: { 'joint_projects.$.participants': {
      invitation_id: invId,
      character_id: String(inv.invited_character_id),
      submission_id: String(sub._id),
      project_slot: slot,
      joined_at: now,
      decoupled_at: null,
      description_change_acknowledged_at: now,
    }}},
  );

  await submissions().updateOne(
    { _id: sub._id },
    { $set: {
      [`responses.project_${slot}_action`]: joint.action_type,
      [`responses.project_${slot}_joint_id`]: String(joint._id),
      [`responses.project_${slot}_joint_role`]: 'support',
      [`responses.project_${slot}_description`]: joint.description || '',
    }},
  );

  // Bundle the latest state for the client re-render
  const updatedInv = await projectInvitations().findOne({ _id: invId });
  const updatedSub = await submissions().findOne({ _id: sub._id });
  const updatedCycle = await chapters().findOne({ _id: cycleOid });
  const updatedJoint = (updatedCycle.joint_projects || []).find(j => String(j._id) === String(joint._id));

  normaliseChapterFkForResponse(updatedSub);   // cm-2b, see GET /api/downtime_submissions
  res.json({ invitation: updatedInv, joint: updatedJoint, slot, submission: updatedSub });
});

projectInvitationsRouter.post('/:id/decline', async (req, res) => {
  const invId = req.params.id;
  const inv = await projectInvitations().findOne({ _id: invId });
  if (!inv) return res.status(404).json({ error: 'NOT_FOUND', message: 'Invitation not found' });

  if (req.user.role !== 'st') {
    const userCharIds = (req.user.character_ids || []).map(String);
    if (!userCharIds.includes(String(inv.invited_character_id))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your invitation' });
    }
  }

  if (inv.status !== 'pending') {
    return res.status(409).json({ error: 'CONFLICT', message: 'Invitation no longer pending', current_status: inv.status });
  }

  const now = new Date().toISOString();
  await projectInvitations().updateOne(
    { _id: invId },
    { $set: { status: 'declined', responded_at: now } },
  );

  res.json(await projectInvitations().findOne({ _id: invId }));
});

// ── JDT-6: voluntary decouple by an accepted support ─────────────────
// Caller must own invitation.invited_character_id (or be ST). Invitation
// must currently be `accepted`. Atomically: invitation → decoupled,
// participant entry on joint gets decoupled_at, support's submission slot
// fields are cleared so the slot reverts to an empty solo project slot.
projectInvitationsRouter.post('/:id/decouple', async (req, res) => {
  const invId = req.params.id;
  const inv = await projectInvitations().findOne({ _id: invId });
  if (!inv) return res.status(404).json({ error: 'NOT_FOUND', message: 'Invitation not found' });

  if (req.user.role !== 'st') {
    const userCharIds = (req.user.character_ids || []).map(String);
    if (!userCharIds.includes(String(inv.invited_character_id))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your invitation' });
    }
  }

  if (inv.status !== 'accepted') {
    return res.status(409).json({ error: 'CONFLICT', message: 'Invitation is not accepted; nothing to decouple', current_status: inv.status });
  }

  const cycleOid = parseId(inv.cycle_id);
  if (!cycleOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle_id on invitation' });
  const cycle = await chapters().findOne({ _id: cycleOid });
  if (!cycle) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  const joint = (cycle.joint_projects || []).find(j => String(j._id) === String(inv.joint_project_id));
  if (!joint) return res.status(404).json({ error: 'NOT_FOUND', message: 'Joint not found' });

  const participant = (joint.participants || []).find(p => String(p.invitation_id) === String(invId));
  if (!participant) {
    return res.status(409).json({ error: 'CONFLICT', message: 'No participant entry for this invitation' });
  }

  const now = new Date().toISOString();

  // Mutations: invitation → decoupled, participant entry → decoupled_at,
  // submission slot fields cleared so the slot reverts to a free solo slot.
  await projectInvitations().updateOne(
    { _id: invId },
    { $set: { status: 'decoupled', decoupled_at: now } },
  );

  await chapters().updateOne(
    { _id: cycleOid, 'joint_projects._id': joint._id, 'joint_projects.participants.invitation_id': invId },
    { $set: { 'joint_projects.$[j].participants.$[p].decoupled_at': now } },
    { arrayFilters: [{ 'j._id': joint._id }, { 'p.invitation_id': invId }] },
  );

  const subOid = parseId(String(participant.submission_id));
  if (subOid) {
    const slot = Number(participant.project_slot);
    await submissions().updateOne(
      { _id: subOid },
      { $set: {
        [`responses.project_${slot}_action`]: '',
        [`responses.project_${slot}_joint_id`]: null,
        [`responses.project_${slot}_joint_role`]: null,
        [`responses.project_${slot}_description`]: '',
        [`responses.project_${slot}_personal_notes`]: '',
      }},
    );
  }

  const updatedInv = await projectInvitations().findOne({ _id: invId });
  const updatedCycle = await chapters().findOne({ _id: cycleOid });
  const updatedJoint = (updatedCycle.joint_projects || []).find(j => String(j._id) === String(joint._id));
  const updatedSub = subOid ? await submissions().findOne({ _id: subOid }) : null;

  normaliseChapterFkForResponse(updatedSub);   // cm-2b, see GET /api/downtime_submissions
  res.json({ invitation: updatedInv, joint: updatedJoint, submission: updatedSub });
});

async function _sendPublishedEmail(submission) {
  try {
    const charId = submission.character_id instanceof ObjectId
      ? submission.character_id
      : parseId(String(submission.character_id));
    if (!charId) return;

    // Find player via character_ids reverse lookup
    const playersCol = getCollection('players');
    const player = await playersCol.findOne({ character_ids: charId });
    if (!player?.email) return;

    // Fetch cycle label
    // cm-2b dual-read, so a pre-migration submission's published email still
    // names its Chapter instead of falling back to the generic 'Downtime'.
    const cycleId = readChapterFkOid(submission);
    let cycleLabel = 'Downtime';
    if (cycleId) {
      const cycle = await chapters().findOne({ _id: cycleId });
      if (cycle?.label) cycleLabel = cycle.label;
    }

    // Resolve character display name
    const charsCol = getCollection('characters');
    const char = charId ? await charsCol.findOne({ _id: charId }) : null;
    const charName = char
      ? [char.honorific, char.moniker || char.name].filter(Boolean).join(' ')
      : 'Your character';

    await sendDowntimePublishedEmail({
      toEmail:      player.email,
      charName,
      cycleLabel,
      outcomeText:  submission.st_review?.outcome_text || '',
      feedMethodId: submission.responses?._feed_method || '',
    });
  } catch (err) {
    console.error('[email] _sendPublishedEmail failed:', err.message);
  }
}
