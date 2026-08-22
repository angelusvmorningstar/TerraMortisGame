import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { connectDb, closeDb, isConnected, getDb } from './db.js';
import { verifyRulesEngine, formatMissingReport, formatPassReport } from './scripts/rules-verify/verify-rules-engine.js';
import authRouter from './routes/auth.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { cacheControl, noCache } from './middleware/cache-control.js';
import charactersRouter from './routes/characters.js';
import territoriesRouter from './routes/territories.js';
import trackerRouter from './routes/tracker.js';
import rankingBallotsRouter from './routes/ranking_ballots.js';
import sessionsRouter from './routes/sessions.js';
import { cyclesRouter } from './routes/chapters.js';
import { submissionsRouter, projectInvitationsRouter } from './routes/downtime.js';
import npcsRouter from './routes/npcs.js';
import relationshipsRouter from './routes/relationships.js';
import npcFlagsRouter from './routes/npc-flags.js';
import gameSessionsRouter, { getNextSession } from './routes/game-sessions.js';
import playersRouter from './routes/players.js';
import questionnaireRouter from './routes/questionnaire.js';
import historyRouter from './routes/history.js';
import ordealResponsesRouter from './routes/ordeal-responses.js';
import ordealSubmissionsRouter from './routes/ordeal-submissions.js';
import ordealRubricsRouter from './routes/ordeal-rubrics.js';
import attendanceRouter from './routes/attendance.js';
import rulesRouter from './routes/rules.js';
import officeActionsRouter from './routes/office-actions.js';
import officeMeritDotsRouter from './routes/office-merit-dots.js';
import officeManoeuvreRankRouter from './routes/office-manoeuvre-rank.js';
import officeSeatsRouter from './routes/office-seats.js';
import {
  grantRouter, specialityGrantRouter, skillBonusRouter, nineAgainRouter, rulesAggregateRouter,
  discAttrRouter, derivedStatModRouter, tierBudgetRouter, statusFloorRouter,
} from './routes/rules-engine.js';
import adminMigrationsRouter from './routes/admin-migrations.js';
import contestedRollsRouter from './routes/contested-rolls.js';
import stModsRouter, { auditRouter as stModAuditRouter } from './routes/st_mods.js';
import appSettingsRouter from './routes/app-settings.js';
import devlogRouter from './routes/devlog.js';
import buildEquipmentCatalogueRouter from './routes/equipment-catalogue.js';
import storyCyclesRouter from './routes/story-cycles.js';
import buildBloodlinesRouter from './routes/bloodlines.js';
import cyoaRouter from './routes/cyoa.js';
import { attachWS } from './ws.js';
// NOTE: The old /api/pdf route was removed. Character sheet PDFs are now
// rendered client-side via public/js/print/. See
// specs/guidance/pdf-target/PRIOR-ART.md for the post-mortem on why the
// server-side pdfkit approach failed on Render.

const app = express();

// CORS v3 manual middleware — NO cors package
const allowedOrigins = config.CORS_ORIGIN.split(',').map(o => o.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || config.NODE_ENV !== 'production')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

// Health check — proves DB connectivity
app.get('/api/health', (req, res) => {
  const dbStatus = isConnected() ? 'connected' : 'disconnected';
  const httpStatus = dbStatus === 'connected' ? 200 : 503;
  res.status(httpStatus).json({ status: dbStatus === 'connected' ? 'ok' : 'error', db: dbStatus });
});

// Auth routes (public — no middleware)
app.use('/api/auth', authRouter);

// Equipment catalogue (public reads; DT form and player app both need access).
// Epic ECM (#868): the `equipment_catalogue` collection lives at
// /api/equipment_catalogue. Writes are ST-gated per-handler inside the
// router (requireAuth + requireRole('st')) — the parent mount is unauthed.
// The legacy /api/equipment/catalogue alias from EQ-1 was removed in ECM-7
// (#874) — all clients (ECM-4 DT form, ECM-5 character editor, ECM-6
// admin sidebar) hit /api/equipment_catalogue directly.
app.use('/api/equipment_catalogue', buildEquipmentCatalogueRouter(requireAuth));

// Bloodlines (public reads). Epic BL (#1008): the `bloodlines` collection
// lives at /api/bloodlines. BL-1 ships reads only and nothing in the client
// consumes them yet — BL-2 rewires `clanDiscList` onto this, and the player
// app needs it without a token, hence the unauthed mount. Writes arrive in
// BL-4 inside the router, following the equipment_catalogue precedent above.
app.use('/api/bloodlines', buildBloodlinesRouter(requireAuth));

// Protected routes — require valid token (role resolved from players collection)
// Characters and downtime submissions have internal role filtering (ST vs player)
//
// Issue #255 (perf, 2026-05-11): explicit Cache-Control discipline.
// Endpoints whose data varies per user (mine=1 vs ST sees all) or
// mutates frequently are marked `no-cache` so browsers always
// revalidate. Read-only / slowly-changing endpoints (rule docs,
// territory list) get `private, max-age=300` for in-session reuse.
app.use('/api/characters', requireAuth, noCache(), charactersRouter);
app.use('/api/chapters', requireAuth, noCache(), cyclesRouter);
app.use('/api/downtime_submissions', requireAuth, noCache(), submissionsRouter);
app.use('/api/ranking_ballots', requireAuth, noCache(), rankingBallotsRouter);
app.use('/api/project_invitations', requireAuth, noCache(), projectInvitationsRouter);
app.use('/api/players', requireAuth, noCache(), playersRouter);
app.use('/api/questionnaire', requireAuth, noCache(), questionnaireRouter);
app.use('/api/history', requireAuth, noCache(), historyRouter);
app.use('/api/ordeal-responses', requireAuth, noCache(), ordealResponsesRouter);
app.use('/api/ordeal_submissions', requireAuth, noCache(), ordealSubmissionsRouter);
app.use('/api/ordeal_rubrics', requireAuth, noCache(), ordealRubricsRouter);
app.use('/api/attendance', requireAuth, noCache(), attendanceRouter);
app.use('/api/cyoa', requireAuth, noCache(), cyoaRouter);
// RETIRED, Story 31-5 (TM Wiki). `archive_documents` (60 narrative documents:
// character dossiers, downtime narratives, character histories) moved to `tm_wiki`,
// reader AND writer together - the constraint TM Wiki's deferred-work item 163
// exists to enforce. Leaving this route mounted would have made TM Suite a SECOND
// writer against a collection whose canonical copy now lives elsewhere, which is
// precisely the split that once stranded a real player's Downtime 6.
// Replacements, all in TM Wiki: the player read is its own
// server/routes/wiki-archive-documents.js; ST authoring is its server/scripts/
// archive-doc-upload.mjs / archive-doc-edit.mjs / archive-doc-list.mjs (ruling 12,
// 2026-07-25: ST-facing capability is scripts, not a built surface).
// The collection itself is dropped separately and manually, by Angelus, via
// server/scripts/_drop-31-5-archive-documents.mjs - copy, verify, cut over, THEN drop.
// Rules engine — must mount before /api/rules (purchasable_powers) so Express
// routes /api/rules/grant etc. to the engine, not the /:key wildcard.
//
// Issue #255: rule docs change rarely (only via ST writes in the admin
// Rules Data view, which calls invalidateRulesCache() to flush the
// client-side cache on update). Safe to mark cacheable for 5 minutes
// — STs editing rules see their own writes via the client's in-memory
// cache invalidation; other users see new values within one max-age
// window after a server-side change.
const RE_ST = [requireAuth, requireRole('st')];
const CACHE_5MIN = cacheControl(300);
app.use('/api/rules/grant',                  ...RE_ST, CACHE_5MIN, grantRouter);
app.use('/api/rules/speciality_grant',       ...RE_ST, CACHE_5MIN, specialityGrantRouter);
app.use('/api/rules/skill_bonus',            ...RE_ST, CACHE_5MIN, skillBonusRouter);
app.use('/api/rules/nine_again',             ...RE_ST, CACHE_5MIN, nineAgainRouter);
app.use('/api/rules/disc_attr',              ...RE_ST, CACHE_5MIN, discAttrRouter);
app.use('/api/rules/derived_stat_modifier',  ...RE_ST, CACHE_5MIN, derivedStatModRouter);
app.use('/api/rules/tier_budget',            ...RE_ST, CACHE_5MIN, tierBudgetRouter);
app.use('/api/rules/status_floor',           ...RE_ST, CACHE_5MIN, statusFloorRouter);
// Issue #256 (perf): aggregated rules-engine endpoint — coalesces the
// 7 per-category endpoints into a single round-trip for `preloadRules`.
// Mounted before `/api/rules` (purchasable powers) so Express routes
// `/api/rules/aggregate` to this router, not the wildcard.
//
// Issue #265 (rebase-resolution): the aggregate endpoint serves the
// same rule-doc content the 7 per-category endpoints do, just merged
// into one response — so it gets the same CACHE_5MIN treatment.
// Closes #265's one-line follow-up as part of this rebase.
app.use('/api/rules/aggregate',              ...RE_ST, CACHE_5MIN, rulesAggregateRouter);
app.use('/api/rules', requireAuth, CACHE_5MIN, rulesRouter);
app.use('/api/contested_roll_requests', requireAuth, contestedRollsRouter);

// /api/pdf removed — PDF generation moved client-side to public/js/print/.
// Stale browsers calling the old endpoint get a 410 Gone with a refresh hint.
app.all('/api/pdf/*path', (req, res) => {
  res.status(410).json({
    error: 'GONE',
    message: 'PDF generation has moved client-side. Hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R) to load the new renderer.',
  });
});

// Public game session endpoint — used by website banner (no auth)
app.get('/api/game_sessions/next', getNextSession);

// Territories — GET open to all authenticated users; writes are ST-only (enforced in router).
// Issue #255: same data for every reader (no per-user filtering) and
// changes rarely. Cacheable for 5 minutes. ST writes invalidate the
// client cache on save.
app.use('/api/territories', requireAuth, CACHE_5MIN, territoriesRouter);
// Tracker — auth required; players can only read/write own characters (enforced in router).
// Issue #255: per-user state (own characters) and mutates on every roll → no-cache.
app.use('/api/tracker_state', requireAuth, noCache(), trackerRouter);
app.use('/api/session_logs', requireAuth, requireRole('st'), noCache(), sessionsRouter);
// Coordinator tier: needs read/write for check-in (fin.3). The finance UI (fin.4)
// was deleted by #1135, but the route keeps this tier for the check-in and the
// session finance fields it still writes.
// requireRole('coordinator') implicitly allows st/dev too.
// Issue #255: live session state → no-cache.
app.use('/api/game_sessions', requireAuth, requireRole('coordinator'), noCache(), gameSessionsRouter);
// TM Wiki Story 31-7 (2026-08-15): /api/downtime_investigations is RETIRED. It
// and tm_wiki's prior_investigations were the same concept modelled twice, and
// neither collection ever held a document - tm_suite.downtime_investigations was
// never even created. TM Wiki's version survives as the single home, because it
// is wired into the player-facing downtime form rather than being an ST-only
// admin panel, and an investigation tracker is downtime/story continuity
// material under Epic 31's ownership test. No migration was needed or written:
// there was nothing to move.
app.use('/api/npcs', requireAuth, noCache(), npcsRouter);
app.use('/api/relationships', requireAuth, noCache(), relationshipsRouter);
app.use('/api/npc-flags', requireAuth, noCache(), npcFlagsRouter);
app.use('/api/admin', requireAuth, requireRole('st'), noCache(), adminMigrationsRouter);
// Epic STM (issue #358): ST mod overlay foundation. ST-auth gated at the
// router level (requireRole('st')); requireAuth must run first to populate
// req.user. no-cache since mods mutate frequently from the admin panel.
app.use('/api/st_mods', requireAuth, noCache(), stModsRouter);
app.use('/api/st_mod_audit', requireAuth, noCache(), stModAuditRouter);
// Epic STM (issue #378): global app settings (kill-switch lives here).
// ST-auth at router level; requireAuth populates req.user. no-cache since
// PATCH from the STM-5 admin panel needs to surface to all readers without
// stale-cache lag.
app.use('/api/settings', requireAuth, noCache(), appSettingsRouter);
app.use('/api/devlog',         requireAuth, noCache(), devlogRouter);
app.use('/api/office_actions', requireAuth, noCache(), officeActionsRouter);
app.use('/api/office_merit_dots', requireAuth, noCache(), officeMeritDotsRouter);
app.use('/api/office_manoeuvre_rank', requireAuth, noCache(), officeManoeuvreRankRouter);
// oxp.2: office seats, read-only. Open read like its two siblings above; the
// XP derivation from these seats happens client-side in office-xp.js.
app.use('/api/office_seats', requireAuth, noCache(), officeSeatsRouter);
// cm-2: this mount replaced the old chapters path outright. No deprecated
// alias is left behind on purpose — cm-2b mounts its own router at that path,
// and Express first-match-wins would silently route its traffic here instead.
app.use('/api/story_cycles',   requireAuth, noCache(), storyCyclesRouter);

// Start server first, then attempt DB connection
// Server must be reachable even if MongoDB is unavailable
async function start() {
  const server = app.listen(config.PORT, () => {
    console.log(`TM Suite API running on port ${config.PORT} (${config.NODE_ENV})`);
  });

  // Attach WebSocket server for live tracker sync
  attachWS(server);

  try {
    await connectDb();
    // Ensure unique index on cyoa_passages (issue #971).
    // createIndex is idempotent — safe to call on every boot.
    getDb().collection('cyoa_passages').createIndex(
      { player_id: 1, story_id: 1 },
      { unique: true, background: true },
    );
    // Ensure partial unique index on office_actions (issue #1143) — makes
    // the per-target dedupe check for paid Status Actions (raise/lower)
    // atomic at the database level instead of a racing findOne.
    getDb().collection('office_actions').createIndex(
      { game_session_id: 1, actor_id: 1, target_id: 1 },
      {
        unique: true,
        background: true,
        partialFilterExpression: { action_type: { $in: ['raise', 'lower'] } },
      },
    );
    // Ensure partial unique index on contested_roll_requests (oaq.2) —
    // prevents a second concurrent PENDING status_action request for the
    // same (session, actor, target); scoped to status:'pending' so a
    // resolved/declined record never blocks a later resubmission.
    getDb().collection('contested_roll_requests').createIndex(
      { game_session_id: 1, actor_id: 1, target_id: 1 },
      {
        unique: true,
        background: true,
        partialFilterExpression: { request_type: 'status_action', status: 'pending' },
      },
    );
    // Ensure the defender-queue compound index on contested_roll_requests
    // (crd.1) — contested-rolls.js's GET /mine filters on target_character_id
    // + status and sorts by created_at descending. Until crd.1 the ONLY index
    // on this collection was the status_action partial unique one above, so a
    // player's queue poll (every 10s, 30+ players at real table scale) was an
    // unindexed scan across every historical challenge ever recorded.
    // Not awaited, and deliberately not unique: it constrains nothing, so
    // unlike the game_sessions.chapter_id index below it cannot reject at
    // build time on live data.
    getDb().collection('contested_roll_requests').createIndex(
      { target_character_id: 1, status: 1, created_at: -1 },
      { name: 'crd1_defender_queue', background: true },
    );
    // Ensure the terminal-status TTL index on contested_roll_requests (crd.1).
    // Nothing has ever expired records in this collection; resolved/declined/
    // voided documents accumulate for the life of the campaign. session_logs
    // (written by contested-rolls.js's own accept path) carries the durable
    // audit record, so no terminal request needs indefinite retention here.
    // Retention: 30 days — long enough to cover a game's own post-session
    // review window at this project's session cadence, short enough that the
    // collection stays bounded across a whole campaign.
    //
    // The partial filter is on status alone, so it also covers terminal
    // status_action records sharing this collection. That is safe and
    // intended: office_actions holds the durable applied-action log, oaq.3's
    // approval queue reads status:'pending' only, and oaq.2's "already acted
    // on this target this session" dedupe read is scoped to the CURRENT
    // game_session_id, whose records are days old, never 30+.
    //
    // KNOWN LIMITATION, deliberately not fixed here: MongoDB's TTL monitor
    // only expires documents whose indexed field holds a BSON Date. Every
    // writer on this collection (contested-rolls.js AND office-actions.js)
    // stores `new Date().toISOString()` — a string — so this index is correct
    // and idempotent but reaps nothing until updated_at becomes a real Date.
    // Converting it is a cross-route data-shape change plus a backfill of
    // every existing document, which crd.1 explicitly excludes. Flagged for a
    // follow-up story; see crd-1-contested-roll-request-shape.test.js's own
    // "DOCUMENTED LIMITATION" test, which fails the day updated_at changes.
    getDb().collection('contested_roll_requests').createIndex(
      { updated_at: 1 },
      {
        name: 'crd1_terminal_status_ttl',
        background: true,
        expireAfterSeconds: 2592000,
        partialFilterExpression: { status: { $in: ['resolved', 'declined', 'voided'] } },
      },
    );
    // Ensure partial unique index on game_sessions.chapter_id (CM-6, folded into cm-4 per
    // cycle-model.md §11a step 6) — makes the confirmed-always-1:1 session/Chapter invariant
    // (Angelus, 2026-08-16) a database constraint rather than a convention.
    //
    // `$type` rather than `$exists: true`: a partial filter of `$exists: true` would INCLUDE
    // documents holding an explicit null, and two of those would then collide on the unique key.
    // `$ne: null` is not accepted in a partial filter at all. `$type` is, and it is exactly
    // "unique where not null". Both storage types are listed because issue #497's mixed
    // ObjectId/string FK split is still live in this database; writes go through
    // `coerceChapterId` in server/routes/game-sessions.js, which only ever stores ObjectId.
    //
    // AWAITED, unlike the three above (cm-4 review, 2026-08-17, triple-confirmed). A unique index
    // build over data that ALREADY contains a duplicate rejects. Un-awaited, that rejection escapes
    // this try/catch entirely and surfaces as an unhandled promise rejection, which on Render can
    // boot-loop the API — the one index of the four whose uniqueness constraint spans data an ST
    // can hand-edit, so the one most able to find a duplicate at boot. Awaiting it means a
    // duplicate is caught below and logged as a startup problem instead of killing the process.
    try {
      await getDb().collection('game_sessions').createIndex(
        { chapter_id: 1 },
        {
          name: 'chapter_id_unique_notnull',
          unique: true,
          background: true,
          partialFilterExpression: { chapter_id: { $type: ['objectId', 'string'] } },
        },
      );
    } catch (indexErr) {
      // Nested deliberately: a live duplicate must be loud, but it must not take the rules-engine
      // gate down with it, and it must not read as "failed to connect to MongoDB" (which is what
      // the outer catch says).
      console.error(
        "Could not create the game_sessions.chapter_id unique index — the session/Chapter 1:1 " +
        'invariant is NOT enforced on this boot. Two sessions are probably paired with the same ' +
        `chapter. Resolve by hand: ${indexErr.message}`
      );
    }
    await runRulesEngineGate();
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    console.error('Health check will report disconnected status');
  }
}

// Verify the rules-engine seed state matches expected_sources.json. In
// production a missing tuple silently breaks XP/derived-stat calculations
// (RDE-3 PT XP refund regression) — fail boot so the deploy goes red instead
// of shipping silently broken behaviour. In dev/test we warn and continue so
// a fresh laptop without seed data can still boot.
async function runRulesEngineGate() {
  const dbName = process.env.MONGODB_DB || 'tm_game';
  const result = await verifyRulesEngine(getDb());
  if (result.ok) {
    console.log(formatPassReport(result.counts, dbName));
    return;
  }
  if (config.NODE_ENV === 'production') {
    console.error('CRITICAL: rules-engine verification failed — refusing to boot.');
    console.error(formatMissingReport(result.missing, dbName));
    process.exit(1);
  }
  console.warn('WARNING: rules-engine verification failed (non-production — continuing).');
  console.warn(formatMissingReport(result.missing, dbName));
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  closeDb().then(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
