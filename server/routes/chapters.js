import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getCollection } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { downtimeCycleSchema } from '../schemas/downtime_submission.schema.js';
// CM-1 (#1028): the pure phase contract, shared verbatim with the client and
// the tests (public/js/downtime/cycle-phase.js has no I/O and no browser
// globals, so the server imports it directly).
import { CYCLE_PHASE_SEQUENCE, cyclePhase } from '../../public/js/downtime/cycle-phase.js';
// cm-2b dual-read shim for the submission Chapter FK. See that module's header.
import { chapterFkFilter } from '../helpers/chapter-fk.js';


/**
 * Chapters: /api/chapters
 *
 * cm-2b: BEFORE this story, this router lived in `downtime.js` as
 * `cyclesRouter`, served `/api/downtime_cycles`, and read a `downtime_cycles`
 * collection. That collection never held "downtime cycles" in the sense its
 * name implied — under the settled cycle model (cycle-model.md §3, §11a) one
 * document spans downtime -> processing -> prep -> game, which is a CHAPTER;
 * `downtime` is only the first of its four phases. CM-1 (#1028) made that true
 * in the data; this story makes the name match. Collection, route and file
 * renamed together, mirroring cm-2's own `chapters.js` -> `story-cycles.js`
 * commit. (`chapters` was cm-2's OWN old collection name, freed when cm-2's
 * `--drop-source --apply` ran on 2026-08-17; the migration script's
 * `targetShapeRefusals` enforces that sequencing mechanically.)
 *
 * `downtime_submissions` is deliberately NOT renamed — a submission's identity
 * genuinely is about the downtime phase. Only its `cycle_id` FK becomes
 * `chapter_id`, and every read of that FK in this file goes through the
 * cm-2b dual-read shim in `../helpers/chapter-fk.js`.
 *
 * WHAT MOVED, AND WHAT DID NOT. `submissionsRouter` and
 * `projectInvitationsRouter` stay in `downtime.js`. They are NOT untouched:
 * roughly thirty lines in each changed, because every Chapter-collection read
 * and every submission FK read in them moved to the new names. What is
 * unchanged is their BEHAVIOUR — same routes, same auth, same status codes.
 * This file took `cyclesRouter` and the five helpers only it uses:
 * `namedFinaleRefusal`, `RouteResponse`, `isTransactionsUnsupported`,
 * `trackerState` and `runPhaseTransition` (plus the `JOINT_ELIGIBLE_ACTIONS`
 * constant). Story tm-admin.27.1 (2026-10-02) later REMOVED `RouteResponse`,
 * `isTransactionsUnsupported`, `trackerState` and `runPhaseTransition`: this app
 * no longer sets a Chapter's phase (see the PUT /:id comment below).
 * `parseId` and the `submissions()` accessor are small enough to define in both
 * files rather than lift into a shared module for two callers.
 *
 * The exported binding is still called `cyclesRouter`. Story cm-2b AC3 names it
 * that after the extraction, and a rename would churn four source-contract
 * suites for no behavioural gain; the route path and the collection are what
 * this story is about.
 */


// JDT-2: action types eligible for the Solo/Joint toggle on a project slot.
// Mirrors JOINT_ELIGIBLE_ACTIONS in public/js/tabs/downtime-data.js.
// `support` (recursive role conflict), `xp_spend` (personal), and
// `maintenance` (personal) are excluded.
const JOINT_ELIGIBLE_ACTIONS = [
  'ambience_increase',
  'ambience_decrease',
  'attack',
  'hide_protect',
  'investigate',
  'patrol_scout',
  'misc',
];

function parseId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

export const cyclesRouter = Router();
const chapters = () => getCollection('chapters');
const submissions = () => getCollection('downtime_submissions');

/**
 * cm-3 AC10 — the named-finale guard, shared by the PUT reassignment path and
 * the DELETE path.
 *
 * `story_cycles.final_chapter_id` is a plain string pointer at one cycle's
 * `_id`. Nothing in Mongo enforces the reference, so the two operations that
 * could break it are refused here rather than left to dangle: moving the named
 * cycle to a different Story, and deleting it outright. Mirrors the shape of
 * story-cycles.js's own STORY_CYCLE_IN_USE 409 — same status, same
 * "name the thing that is holding the reference" message style.
 *
 * Returns the 409 body when the operation must be refused, or `null` when it
 * is safe (no Story names this cycle, or — for the reassignment case — the FK
 * is not actually changing, so a full-document restore of an unchanged value
 * still passes through).
 */
async function namedFinaleRefusal(oid, { nextStoryId, verb } = {}) {
  const idStr = String(oid);
  const holder = await getCollection('story_cycles').findOne({ final_chapter_id: idStr });
  if (!holder) return null;

  if (nextStoryId !== undefined) {
    const current = await chapters().findOne({ _id: oid }, { projection: { story_cycle_id: 1, label: 1, game_number: 1 } });
    if (!current) return null;                                   // 404 is the PUT's own job
    const before = String(current.story_cycle_id ?? '');
    const after = nextStoryId == null ? '' : String(nextStoryId);
    if (before === after) return null;                           // no change, nothing to guard
  }

  const cycle = await chapters().findOne({ _id: oid }, { projection: { label: 1, game_number: 1 } });
  const cycleName = cycle?.label || (cycle?.game_number != null ? `Game ${cycle.game_number}` : 'This cycle');
  const storyName = `Story ${holder.number ?? '?'}${holder.label ? ` — ${holder.label}` : ''}`;
  return {
    error: 'CYCLE_IS_STORY_FINALE',
    message: `${cycleName} is the final chapter of ${storyName} and cannot be ${verb || 'changed'}. Clear or re-point that Story's final chapter first.`,
    story_cycle_id: String(holder._id),
    story_label: storyName,
  };
}

// GET /api/chapters — list all (both roles can see cycles)
// Issue #321: sort by _id desc (creation-order proxy since cycle docs lack
// created_at) so clients get a meaningful order even without their own sort.
cyclesRouter.get('/', async (req, res) => {
  const docs = await chapters().find().sort({ _id: -1 }).toArray();
  res.json(docs);
});

// POST /api/chapters — ST only
cyclesRouter.post('/', requireRole('st'), validate(downtimeCycleSchema), async (req, res) => {
  const doc = req.body;
  // CM-1 (#1028): every new cycle carries the phase order as data. `phase` is
  // deliberately NOT defaulted; a new cycle starts with no phase (legacy null).
  if (!Array.isArray(doc.phase_sequence) || doc.phase_sequence.length === 0) {
    doc.phase_sequence = [...CYCLE_PHASE_SEQUENCE];
  }
  const result = await chapters().insertOne(doc);
  const created = await chapters().findOne({ _id: result.insertedId });
  res.status(201).json(created);
});

// POST /api/chapters/:id/confirm-feeding — both roles (Regents are players)
cyclesRouter.post('/:id/confirm-feeding', async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  const { territory_id, rights } = req.body;
  if (!territory_id || !Array.isArray(rights)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'territory_id and rights[] are required' });
  }

  // 1. Load cycle; must exist and not be closed
  const cycle = await chapters().findOne({ _id: oid });
  if (!cycle) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  // CM-1 (#1028): phase-aware parity. Under the legacy model this gate only
  // rejected raw 'closed', so regents could still confirm rights during the
  // early game window (status 'game'). prep replaces that window but mirrors
  // to status 'closed', which would have newly blocked them (Codex review
  // finding, 2026-08-10). A phase-carrying cycle therefore allows
  // confirmation in downtime, prep and game, and rejects it in processing -
  // the same capability the legacy lane always had, stated in phase terms.
  const confirmBlocked = (typeof cycle.phase === 'string' && cycle.phase !== '')
    ? !['downtime', 'prep', 'game'].includes(cyclePhase(cycle))
    : cycle.status === 'closed';
  if (confirmBlocked) {
    return res.status(409).json({ error: 'CONFLICT', message: 'Cycle is closed' });
  }

  // 2. Load territory by _id (ADR-002 strict cutover Q2 — slug rejected).
  const terrCollection = () => getCollection('territories');
  const terrOid = parseId(territory_id);
  if (!terrOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid territory_id format' });
  const terrDoc = await terrCollection().findOne({ _id: terrOid });
  if (!terrDoc) return res.status(404).json({ error: 'NOT_FOUND', message: 'Territory not found' });

  if (req.user.role !== 'st') {
    const userCharIds = (req.user.character_ids || []).map(id => String(id));
    if (!userCharIds.includes(String(terrDoc.regent_id))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'You are not the Regent of this territory' });
    }
  }

  const regentCharId = String(terrDoc.regent_id);

  // 3. Append-only check — new rights must be a superset of previous
  const existing = (cycle.regent_confirmations || []).find(c => c.territory_id === territory_id);
  if (existing) {
    const removed = existing.rights.filter(r => !rights.includes(r));
    if (removed.length > 0) {
      return res.status(409).json({ error: 'CONFLICT', message: 'Cannot remove previously confirmed rights', removed });
    }
  }

  // 4. Upsert confirmation entry
  const newEntry = {
    territory_id,
    regent_char_id: regentCharId,
    confirmed_at: new Date().toISOString(),
    rights,
  };
  const updatedConfirmations = [
    ...(cycle.regent_confirmations || []).filter(c => c.territory_id !== territory_id),
    newEntry,
  ];

  // 5. Recompute gate: all territories with regent_id must have a confirmation.
  // Per ADR-002 strict cutover, confirmation territory_id values are now
  // territory _id ObjectId-strings; compare against String(t._id).
  const allTerrs = await terrCollection().find({ regent_id: { $exists: true, $ne: null } }).toArray();
  const confirmedTerritoryIds = new Set(updatedConfirmations.map(c => c.territory_id));
  const allConfirmed = allTerrs.length === 0 || allTerrs.every(t => confirmedTerritoryIds.has(String(t._id)));

  const updateFields = {
    regent_confirmations: updatedConfirmations,
    feeding_rights_confirmed: allConfirmed,
  };

  // 6. Return updated cycle doc
  const updated = await chapters().findOneAndUpdate(
    { _id: oid },
    { $set: updateFields },
    { returnDocument: 'after' }
  );
  res.json(updated);
});

// ── JDT-2: Joint projects on a cycle ─────────────────────────────────
// POST /api/chapters/:cycleId/joint_projects
// Caller is the lead. Creates one cycle.joint_projects[] entry plus one
// project_invitations doc per invitee, atomically.
cyclesRouter.post('/:cycleId/joint_projects', async (req, res) => {
  const cycleOid = parseId(req.params.cycleId);
  if (!cycleOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  const {
    lead_character_id,
    lead_submission_id,
    lead_project_slot,
    description,
    action_type,
    target_type,
    target_value,
    invitee_character_ids,
  } = req.body || {};

  // ── Body validation ──
  if (!lead_character_id) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'lead_character_id required' });
  if (!lead_submission_id) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'lead_submission_id required' });
  const slot = Number(lead_project_slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'lead_project_slot must be 1-4' });
  }
  if (typeof action_type !== 'string' || !JOINT_ELIGIBLE_ACTIONS.includes(action_type)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'action_type not joint-eligible', allowed: JOINT_ELIGIBLE_ACTIONS });
  }
  if (!Array.isArray(invitee_character_ids) || invitee_character_ids.length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invitee_character_ids must be a non-empty array' });
  }
  const inviteeIds = [...new Set(invitee_character_ids.map(String))];
  if (inviteeIds.includes(String(lead_character_id))) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Lead cannot invite themselves' });
  }

  // ── Auth: player must own lead_character_id ──
  if (req.user.role !== 'st') {
    const userCharIds = (req.user.character_ids || []).map(id => String(id));
    if (!userCharIds.includes(String(lead_character_id))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot create a joint as another character' });
    }
  }

  // ── Cycle must exist and be live ──
  const cycle = await chapters().findOne({ _id: cycleOid });
  if (!cycle) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  const liveStatuses = ['prep', 'game', 'active', 'open'];
  if (!liveStatuses.includes(cycle.status)) {
    return res.status(409).json({ error: 'CONFLICT', message: 'Cycle is not accepting joint projects' });
  }

  // ── Lead submission must exist and belong to lead_character_id ──
  const subOid = parseId(lead_submission_id);
  if (!subOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid lead_submission_id' });
  const leadSub = await submissions().findOne({ _id: subOid });
  if (!leadSub) return res.status(404).json({ error: 'NOT_FOUND', message: 'Lead submission not found' });
  const leadCharStr = leadSub.character_id?.toString();
  if (leadCharStr !== String(lead_character_id)) {
    return res.status(409).json({ error: 'CONFLICT', message: 'lead_submission_id does not belong to lead_character_id' });
  }

  // ── Reject duplicate joint for the same lead slot ──
  const existing = (cycle.joint_projects || []).find(j =>
    String(j.lead_submission_id) === String(lead_submission_id) &&
    Number(j.lead_project_slot) === slot &&
    !j.cancelled_at
  );
  if (existing) {
    return res.status(409).json({ error: 'CONFLICT', message: 'A joint already exists for this slot', joint_id: existing._id });
  }

  const now = new Date().toISOString();
  const jointId = new ObjectId().toString();

  const joint = {
    _id: jointId,
    lead_character_id: String(lead_character_id),
    lead_submission_id: String(lead_submission_id),
    lead_project_slot: slot,
    description: typeof description === 'string' ? description : '',
    action_type,
    target_type: target_type || null,
    target_value: target_value || null,
    description_updated_at: null,
    st_joint_outcome: '',
    participants: [],
    created_at: now,
    cancelled_at: null,
    cancelled_reason: null,
  };

  const invitations = inviteeIds.map(charId => ({
    _id: new ObjectId().toString(),
    joint_project_id: jointId,
    cycle_id: String(req.params.cycleId),
    invited_character_id: charId,
    invited_submission_id: null,
    status: 'pending',
    created_at: now,
    responded_at: null,
    decoupled_at: null,
    cancelled_at: null,
  }));

  await getCollection('project_invitations').insertMany(invitations);
  await chapters().updateOne({ _id: cycleOid }, { $push: { joint_projects: joint } });

  res.status(201).json({ joint, invitations });
});

// JDT-6: Re-invite alternates while submissions are open. Lead-only.
// Adds new pending invitations for the supplied invitee_character_ids,
// skipping anyone who already has an active (pending|accepted) invitation
// on this joint. Returns the newly-created invitations.
cyclesRouter.post('/:cycleId/joint_projects/:jointId/reinvite', async (req, res) => {
  const cycleOid = parseId(req.params.cycleId);
  if (!cycleOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  const cycle = await chapters().findOne({ _id: cycleOid });
  if (!cycle) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  const joint = (cycle.joint_projects || []).find(j => String(j._id) === String(req.params.jointId));
  if (!joint) return res.status(404).json({ error: 'NOT_FOUND', message: 'Joint not found' });
  if (joint.cancelled_at) {
    return res.status(409).json({ error: 'CONFLICT', message: 'Joint is cancelled; cannot re-invite' });
  }

  if (req.user.role !== 'st') {
    const userCharIds = (req.user.character_ids || []).map(String);
    if (!userCharIds.includes(String(joint.lead_character_id))) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Only the lead can re-invite' });
    }
  }

  const liveStatuses = ['prep', 'game', 'active', 'open'];
  if (!liveStatuses.includes(cycle.status)) {
    return res.status(409).json({ error: 'CONFLICT', message: 'Cycle is not accepting invitations' });
  }

  const inviteeIdsRaw = req.body?.invitee_character_ids;
  if (!Array.isArray(inviteeIdsRaw) || inviteeIdsRaw.length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invitee_character_ids must be a non-empty array' });
  }
  const inviteeIds = [...new Set(inviteeIdsRaw.map(String))];
  if (inviteeIds.includes(String(joint.lead_character_id))) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Lead cannot invite themselves' });
  }

  // Drop anyone who already has an active invitation on this joint.
  const existing = await getCollection('project_invitations')
    .find({ joint_project_id: String(joint._id), status: { $in: ['pending', 'accepted'] } })
    .toArray();
  const blocked = new Set(existing.map(i => String(i.invited_character_id)));
  const fresh = inviteeIds.filter(id => !blocked.has(id));
  if (!fresh.length) {
    return res.status(409).json({ error: 'CONFLICT', message: 'All supplied invitees already have an active invitation on this joint' });
  }

  const now = new Date().toISOString();
  const newInvitations = fresh.map(charId => ({
    _id: new ObjectId().toString(),
    joint_project_id: String(joint._id),
    cycle_id: String(req.params.cycleId),
    invited_character_id: charId,
    invited_submission_id: null,
    status: 'pending',
    created_at: now,
    responded_at: null,
    decoupled_at: null,
    cancelled_at: null,
  }));
  await getCollection('project_invitations').insertMany(newInvitations);

  res.status(201).json({ joint, invitations: newInvitations });
});

// JDT-6: Cancel a joint. Lead-only path requires zero non-decoupled
// participants AND zero pending invitations. ST-override path (body
// st_override=true) bypasses the participant check and clears all
// remaining accepted supports' slots as a safety valve.
cyclesRouter.post('/:cycleId/joint_projects/:jointId/cancel', async (req, res) => {
  const cycleOid = parseId(req.params.cycleId);
  if (!cycleOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  const cycle = await chapters().findOne({ _id: cycleOid });
  if (!cycle) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  const joint = (cycle.joint_projects || []).find(j => String(j._id) === String(req.params.jointId));
  if (!joint) return res.status(404).json({ error: 'NOT_FOUND', message: 'Joint not found' });
  if (joint.cancelled_at) {
    return res.status(409).json({ error: 'CONFLICT', message: 'Joint already cancelled' });
  }

  const isST = req.user.role === 'st' || req.user.role === 'dev';
  const userCharIds = (req.user.character_ids || []).map(String);
  const isLead = userCharIds.includes(String(joint.lead_character_id));
  const stOverride = !!(isST && req.body?.st_override);

  if (!isLead && !stOverride) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only the lead may cancel this joint' });
  }

  const activeParticipants = (joint.participants || []).filter(p => !p.decoupled_at);
  const pendingInvs = await getCollection('project_invitations')
    .find({ joint_project_id: String(joint._id), status: 'pending' })
    .toArray();

  if (isLead && !stOverride) {
    if (activeParticipants.length > 0) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'Cannot cancel while accepted supports remain; ask them to decouple first',
        accepted_supports: activeParticipants.length,
      });
    }
    if (pendingInvs.length > 0) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'Cancel pending invitations first or wait for their response',
        pending_invitations: pendingInvs.length,
      });
    }
  }

  const now = new Date().toISOString();
  const cancelledReason = stOverride ? 'st-override' : 'lead-cancelled';

  // Mutations: joint, pending invitations, lead's slot. ST override also
  // clears any remaining accepted supports' slots.
  await chapters().updateOne(
    { _id: cycleOid, 'joint_projects._id': joint._id },
    { $set: {
      'joint_projects.$.cancelled_at': now,
      'joint_projects.$.cancelled_reason': cancelledReason,
    }},
  );

  if (pendingInvs.length) {
    await getCollection('project_invitations').updateMany(
      { joint_project_id: String(joint._id), status: 'pending' },
      { $set: { status: 'cancelled-by-lead', cancelled_at: now } },
    );
  }

  // Clear lead's slot
  const leadSubOid = parseId(String(joint.lead_submission_id));
  if (leadSubOid) {
    const slot = Number(joint.lead_project_slot);
    await submissions().updateOne(
      { _id: leadSubOid },
      { $set: {
        [`responses.project_${slot}_action`]: '',
        [`responses.project_${slot}_is_joint`]: '',
        [`responses.project_${slot}_joint_id`]: null,
        [`responses.project_${slot}_joint_role`]: null,
        [`responses.project_${slot}_joint_description`]: '',
        [`responses.project_${slot}_joint_invited_ids`]: '[]',
        [`responses.project_${slot}_description`]: '',
      }},
    );
  }

  // ST override — clear active supports' slots too
  if (stOverride && activeParticipants.length) {
    for (const p of activeParticipants) {
      const subOid = parseId(String(p.submission_id));
      if (!subOid) continue;
      const slot = Number(p.project_slot);
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
      // Also flip the accepted invitation to decoupled so the badge reads truthfully.
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
  }

  const updatedCycle = await chapters().findOne({ _id: cycleOid });
  const updatedJoint = (updatedCycle.joint_projects || []).find(j => String(j._id) === String(joint._id));
  res.json({ joint: updatedJoint, cancelled_reason: cancelledReason });
});

// JDT-6: Mid-cycle joint description edit by lead. Only fields in the
// allowlist may be updated; description_updated_at is bumped to now so
// support slots can show the "lead has updated" indicator.
cyclesRouter.patch('/:cycleId/joint_projects/:jointId', async (req, res) => {
  const cycleOid = parseId(req.params.cycleId);
  if (!cycleOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  const cycle = await chapters().findOne({ _id: cycleOid });
  if (!cycle) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  const joint = (cycle.joint_projects || []).find(j => String(j._id) === String(req.params.jointId));
  if (!joint) return res.status(404).json({ error: 'NOT_FOUND', message: 'Joint not found' });
  if (joint.cancelled_at) {
    return res.status(409).json({ error: 'CONFLICT', message: 'Joint is cancelled' });
  }

  const isST = req.user.role === 'st' || req.user.role === 'dev';
  const userCharIds = (req.user.character_ids || []).map(String);
  const isLead = userCharIds.includes(String(joint.lead_character_id));
  if (!isLead && !isST) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only the lead may edit this joint' });
  }

  const allowed = ['description', 'target_type', 'target_value'];
  const setOps = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) {
      setOps[`joint_projects.$.${k}`] = req.body[k];
    }
  }
  if (Object.keys(setOps).length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'No editable fields supplied' });
  }
  const now = new Date().toISOString();
  setOps['joint_projects.$.description_updated_at'] = now;

  await chapters().updateOne(
    { _id: cycleOid, 'joint_projects._id': joint._id },
    { $set: setOps },
  );

  const updatedCycle = await chapters().findOne({ _id: cycleOid });
  const updatedJoint = (updatedCycle.joint_projects || []).find(j => String(j._id) === String(joint._id));
  res.json({ joint: updatedJoint });
});

// JDT-6: Support acknowledges that they've seen the lead's description
// change. Sets participant.description_change_acknowledged_at to now.
cyclesRouter.post('/:cycleId/joint_projects/:jointId/participants/:charId/acknowledge', async (req, res) => {
  const cycleOid = parseId(req.params.cycleId);
  if (!cycleOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  const cycle = await chapters().findOne({ _id: cycleOid });
  if (!cycle) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  const joint = (cycle.joint_projects || []).find(j => String(j._id) === String(req.params.jointId));
  if (!joint) return res.status(404).json({ error: 'NOT_FOUND', message: 'Joint not found' });

  const charId = String(req.params.charId);
  if (req.user.role !== 'st') {
    const userCharIds = (req.user.character_ids || []).map(String);
    if (!userCharIds.includes(charId)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not your participant entry' });
    }
  }

  const participant = (joint.participants || []).find(p => String(p.character_id) === charId && !p.decoupled_at);
  if (!participant) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Participant not found or has decoupled' });
  }

  const now = new Date().toISOString();
  await chapters().updateOne(
    { _id: cycleOid, 'joint_projects._id': joint._id },
    { $set: { 'joint_projects.$[j].participants.$[p].description_change_acknowledged_at': now } },
    { arrayFilters: [{ 'j._id': joint._id }, { 'p.character_id': charId, 'p.decoupled_at': null }] },
  );

  const updatedCycle = await chapters().findOne({ _id: cycleOid });
  const updatedJoint = (updatedCycle.joint_projects || []).find(j => String(j._id) === String(joint._id));
  res.json({ joint: updatedJoint, acknowledged_at: now });
});

// PUT /api/chapters/:id — ST only
//
// Story tm-admin.27.1 (retired the TM Game phase writer, 2026-10-02): TM Game no longer sets a
// Chapter's phase. TM Admin (PUT /api/chapters/:id/phase) is the only writer of `phase`,
// `game_phase` and `status`, the mirror trio (cycle-model.md section 7). This route used to carry the
// CM-4a / CM-5a transition, which also WIPED the whole `tracker_state` collection entering prep or
// game from most phases. TM Admin never wipes (Angelus's ruling of 2026-08-20, after a live incident in
// which opening Game phase destroyed stats already recorded), so two apps held opposite rules for the
// same field. The transition and its transaction are gone; this route refuses the trio.
//
// The refusal is deliberately the FIRST statement in the handler: the handler does no id parsing, no
// database read, no write and no tracker_state access before it, so no client (the admin Cycle tab, a
// stale cached page, a script) can bypass it. It runs AFTER the app-level authentication and this
// route's own ST role gate (`requireRole('st')`), so a non-ST caller gets 403, not 409 (a 403 is the
// right answer for a caller who may not write at all), and authentication may itself read the
// `players` collection. A body without those keys behaves exactly as before: label, story assignment,
// session link, prep access, submission count, joint projects and deadlines all still work.
// The Data Portability importer cannot reach this refusal for a different reason than it once could:
// Chapter import was retired from Data Portability (a chapters CSV is rejected as an unknown
// collection; see public/js/admin/data-portability.js), so nothing there PUTs a Chapter at all.
// `withoutPhaseFields` (cycle-phase.js) now serves only `buildPhaseUpdate`.
//
// A slate reset between games is now the ST's deliberate Reset All on the Tracker tab.
const PHASE_FIELDS = ['phase', 'game_phase', 'status'];

cyclesRouter.put('/:id', requireRole('st'), async (req, res) => {
  if (PHASE_FIELDS.some(k => Object.prototype.hasOwnProperty.call(req.body || {}, k))) {
    return res.status(409).json({
      error: 'PHASE_CONTROLLED_BY_TM_ADMIN',
      message: 'Chapter phase is set in TM Admin.',
    });
  }

  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  // cm-3 AC10: a cycle that a Story currently names as its `final_chapter_id`
  // cannot be moved to another Story (or unassigned) out from under that
  // pointer — that is exactly the silent-relocation failure the pointer
  // design exists to prevent, and it would orphan any maintenance_audit ticks
  // already recorded on it. The ST must clear or re-point the Story's final
  // chapter first. Only checked when the body actually carries
  // `story_cycle_id`, and only when the value would CHANGE, so the Data
  // Portability importer's full-document restore of an unchanged FK still
  // passes through untouched.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'story_cycle_id')) {
    const refusal = await namedFinaleRefusal(oid, { nextStoryId: req.body.story_cycle_id, verb: 'moved to another Story' });
    if (refusal) return res.status(409).json(refusal);
  }

  const { _id, ...updates } = req.body;

  const result = await chapters().findOneAndUpdate(
    { _id: oid },
    { $set: updates },
    { returnDocument: 'after' }
  );

  if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  return res.json(result);
});

// DELETE /api/chapters/:id — ST only.
// Hard-delete guarded by the submission count: a cycle that owns
// downtime_submissions cannot be deleted (it would orphan player data).
// Returns 409 CYCLE_HAS_SUBMISSIONS so the client can surface a clear message.
// Empty cycles (e.g. the test-residue "Test Cycle" docs) delete cleanly.
cyclesRouter.delete('/:id', requireRole('st'), async (req, res) => {
  const oid = parseId(req.params.id);
  if (!oid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  // cm-3 AC10: same guard as the story_cycle_id reassignment above. Deleting a
  // cycle a Story names as its final chapter would leave `final_chapter_id`
  // dangling, which the client's derivation reads as "no finale at all" —
  // silently, with no error anywhere.
  const finaleRefusal = await namedFinaleRefusal(oid, { verb: 'deleted' });
  if (finaleRefusal) return res.status(409).json(finaleRefusal);

  // Matched through the shared shim, not an ObjectId-only equality. Two
  // reviewers found this independently: a Chapter whose submissions are
  // DT1-era STRING-typed FKs (issue #497's still-live mixed-type split) counted
  // zero here and got deleted, orphaning every one of them. The same helper now
  // also resolves a pre-migration `cycle_id`, so a Chapter cannot be deleted
  // out from under submissions the migration has not reached yet.
  const subCount = await getCollection('downtime_submissions').countDocuments(chapterFkFilter(oid));
  if (subCount > 0) {
    return res.status(409).json({
      error: 'CYCLE_HAS_SUBMISSIONS',
      message: `Cycle has ${subCount} submission${subCount === 1 ? '' : 's'}; remove or reassign them before deleting.`,
    });
  }

  const result = await chapters().deleteOne({ _id: oid });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'NOT_FOUND', message: 'Cycle not found' });
  res.json({ deleted: true });
});

// POST /api/chapters/:id/publish — ST only; bulk-promote compiled DT reports
cyclesRouter.post('/:id/publish', requireRole('st'), async (req, res) => {
  const cycleOid = parseId(req.params.id);
  if (!cycleOid) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cycle ID format' });

  const subs = getCollection('downtime_submissions');
  // Same shim as the DELETE guard above, for the same two reasons: DT1-era
  // string-typed FKs, and pre-migration `cycle_id`. An ObjectId-only match
  // reported `{published: 0, skipped: 0}` and published nothing, silently.
  const all = await subs.find(chapterFkFilter(cycleOid)).toArray();

  let published = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const sub of all) {
    const text = sub.st_review?.outcome_text;
    if (!text) { skipped++; continue; }
    if (sub.st_review?.outcome_visibility === 'published' && sub.published_outcome) {
      skipped++;
      continue;
    }
    await subs.updateOne(
      { _id: sub._id },
      { $set: {
          published_outcome: text,
          'st_review.outcome_visibility': 'published',
          'st_review.published_at': now,
      }}
    );
    published++;
  }

  res.json({ published, skipped });
});

export default cyclesRouter;
