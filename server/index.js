import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { connectDb, closeDb, isConnected, getDb } from './db.js';
import { verifyRulesEngine, formatMissingReport, formatPassReport } from './scripts/rules-verify/verify-rules-engine.js';
import { verifyNoBonusWrites, formatViolationsReport, formatPassReport as formatBonusPassReport } from './scripts/rules-verify/verify-no-bonus-writes.js';
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
import attendanceRouter from './routes/attendance.js';
import rulesRouter from './routes/rules.js';
import officeActionsRouter from './routes/office-actions.js';
import officeMeritDotsRouter from './routes/office-merit-dots.js';
import officeManoeuvreRankRouter from './routes/office-manoeuvre-rank.js';
import officeSeatsRouter from './routes/office-seats.js';
import praxisSessionsRouter from './routes/praxis-sessions.js';
import {
  grantRouter, specialityGrantRouter, skillBonusRouter, nineAgainRouter, rulesAggregateRouter,
  discAttrRouter, derivedStatModRouter, tierBudgetRouter, statusFloorRouter,
  bonusSuccessRouter,
} from './routes/rules-engine.js';
import adminMigrationsRouter from './routes/admin-migrations.js';
import contestedRollsRouter from './routes/contested-rolls.js';
import humanityCheckRouter from './routes/humanity-check.js';
import officePurchaseRouter from './routes/office-purchase.js';
import stModsRouter, { auditRouter as stModAuditRouter } from './routes/st_mods.js';
import writeOnceViolationsRouter from './routes/write-once-violations.js';
import appSettingsRouter from './routes/app-settings.js';
import rollLogRouter from './routes/roll-log.js';
import buildEquipmentCatalogueRouter from './routes/equipment-catalogue.js';
import storyCyclesRouter from './routes/story-cycles.js';
import buildBloodlinesRouter from './routes/bloodlines.js';
import buildOfficeContentRouter from './routes/office-content.js';
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

// Bloodlines (public read only). Epic BL (#1008): the `bloodlines` collection
// lives at /api/bloodlines. `clanDiscList` reads it (public/js/data/accessors.js),
// and the player app needs it without a token, hence the unauthed mount.
// ADMR-1 (2026-08-26) retired the BL-4 write API this router used to also
// carry — ST authoring now lives entirely in TM Admin, a separate app writing
// to this same shared collection. `requireAuth` is accepted but unused by the
// router's own sole surviving route; kept only so this mount line needs no
// change (server/routes/bloodlines.js explains why).
app.use('/api/bloodlines', buildBloodlinesRouter(requireAuth));

// Office content (public read only). oxp.10 (split out of oxp.1,
// 2026-08-13): the `office_content` collection lives at /api/office_content,
// replacing the static OFFICE_DATA/MERIT_DOT_CAPS constants. Public for the
// same reason as bloodlines above — the player-facing office tab and the
// sheet editor both need it without a token. Read-only in this repo, same
// locked-scope decision as bloodlines (see server/schemas/office_content.schema.js).
app.use('/api/office_content', buildOfficeContentRouter(requireAuth));

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
// 2026-08-29: Downtime + Ordeals removed entirely from the running app
// (Angelus, via cross-session relay, confirmed directly). Not just gated:
// the ST admin marking UI, the player Ordeals tab, and the Downtime nav
// tile/tab are all unwired now (see admin.js, admin.html, app.js). The
// admin marking UI (ordeals-admin.js) was the ONLY consumer of these two
// routes, so unmounting them is safe; see this commit's own audit for the
// full per-collection reasoning. `/api/questionnaire`, `/api/history` and
// `/api/ordeal-responses` above stay mounted deliberately: their GET reads
// are shared with other live, unrelated features (Archive tab, Personal
// Story) and their writes were already 403'd for players by the retirement
// gate fix. `ordeal_submissions`/`ordeal_rubrics` had no such sharing,
// confirmed by grep before removing, same discipline as the
// archive_documents retirement above. Route files themselves are left on
// disk (server/routes/ordeal-submissions.js, ordeal-rubrics.js), unrouted,
// at Angelus's request, kept as reference for anything TM Story's own
// build may have missed, not deleted.
// app.use('/api/ordeal_submissions', requireAuth, noCache(), ordealSubmissionsRouter);
// app.use('/api/ordeal_rubrics', requireAuth, noCache(), ordealRubricsRouter);
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
// Kurtis W bug report (2026-09): these were ST-only for READS too (RE_ST
// applied to the whole mount, GET included), but this is reference
// rule-definition data, not a player secret — and the player-facing app's
// own preloadRules()/applyDerivedMerits pipeline needs read access to
// compute merit-granted bonuses (e.g. Professional Training's dot-4 skill
// bonus) for a PLAYER's own sheet. A player got a 403 on every load, so
// derived-merit values silently never appeared, masked by app.js's own
// Promise.allSettled + the #249 null-cache guard. Reads now open to any
// authenticated user, matching rules.js's own established pattern
// (purchasable_powers: public GET, requireRole('st') on writes only) —
// writes are now protected at the route level inside rules-engine.js
// instead, so this cannot also open up write access.
const CACHE_5MIN = cacheControl(300);
app.use('/api/rules/grant',                  requireAuth, CACHE_5MIN, grantRouter);
app.use('/api/rules/speciality_grant',       requireAuth, CACHE_5MIN, specialityGrantRouter);
app.use('/api/rules/skill_bonus',            requireAuth, CACHE_5MIN, skillBonusRouter);
app.use('/api/rules/nine_again',             requireAuth, CACHE_5MIN, nineAgainRouter);
app.use('/api/rules/disc_attr',              requireAuth, CACHE_5MIN, discAttrRouter);
app.use('/api/rules/derived_stat_modifier',  requireAuth, CACHE_5MIN, derivedStatModRouter);
app.use('/api/rules/tier_budget',            requireAuth, CACHE_5MIN, tierBudgetRouter);
app.use('/api/rules/status_floor',           requireAuth, CACHE_5MIN, statusFloorRouter);
// dtlt.1: roll-time bonus successes (Stronger Than You and any future
// "+N successes when X" house rule).
app.use('/api/rules/bonus_success',          requireAuth, CACHE_5MIN, bonusSuccessRouter);
// Issue #256 (perf): aggregated rules-engine endpoint — coalesces the
// 7 per-category endpoints into a single round-trip for `preloadRules`.
// Mounted before `/api/rules` (purchasable powers) so Express routes
// `/api/rules/aggregate` to this router, not the wildcard.
//
// Issue #265 (rebase-resolution): the aggregate endpoint serves the
// same rule-doc content the 7 per-category endpoints do, just merged
// into one response — so it gets the same CACHE_5MIN treatment.
// Closes #265's one-line follow-up as part of this rebase.
app.use('/api/rules/aggregate',              requireAuth, CACHE_5MIN, rulesAggregateRouter);
app.use('/api/rules', requireAuth, CACHE_5MIN, rulesRouter);
app.use('/api/contested_roll_requests', requireAuth, contestedRollsRouter);
// gdx.12: Humanity Check submit/accept/decline — shares the
// contested_roll_requests collection (request_type: 'humanity_check') but
// has its own route file/schema, same pattern as office_actions below.
app.use('/api/humanity_check_requests', requireAuth, noCache(), humanityCheckRouter);
// oxp.9: office XP spend requests — the fourth request_type sharing the
// contested_roll_requests collection ('office_purchase'), with its own route
// file/schema, same pattern as humanity_check above and office_actions below.
app.use('/api/office_purchase_requests', requireAuth, noCache(), officePurchaseRouter);

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
// Issue #1132: refused write-once (clan/bloodline) transition attempts.
// Same mount shape as st_mod_audit — ST gating lives on the handler itself,
// requireAuth first to populate req.user, no-cache because a violation an ST
// is looking for is by definition one that has just happened.
app.use('/api/write_once_violations', requireAuth, noCache(), writeOnceViolationsRouter);
// Epic STM (issue #378): global app settings (kill-switch lives here).
// ST-auth at router level; requireAuth populates req.user. no-cache since
// PATCH from the STM-5 admin panel needs to surface to all readers without
// stale-cache lag.
app.use('/api/settings', requireAuth, noCache(), appSettingsRouter);
// gdx.8 (#989): persisted roll history. POST is player-own-character-scoped
// inside the router (mirrors tracker.js's canAccess()); GET is ST/dev only,
// same router-level gating shape as office_actions below.
app.use('/api/roll_log', requireAuth, noCache(), rollLogRouter);
app.use('/api/office_actions', requireAuth, noCache(), officeActionsRouter);
app.use('/api/office_merit_dots', requireAuth, noCache(), officeMeritDotsRouter);
app.use('/api/office_manoeuvre_rank', requireAuth, noCache(), officeManoeuvreRankRouter);
// oxp.2: office seats, read-only. Open read like its two siblings above; the
// XP derivation from these seats happens client-side in office-xp.js.
app.use('/api/office_seats', requireAuth, noCache(), officeSeatsRouter);
// prax.1: the Praxis night board. Authenticated at the app level like every
// mount here, then ST-gated on EVERY handler inside the router (there is no
// open read verb in it at all - see that file's own header). noCache() because
// a stale board mid-Praxis is worse than no board.
app.use('/api/praxis_sessions', requireAuth, noCache(), praxisSessionsRouter);
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
    // Ensure partial unique index on contested_roll_requests (oxp.9) —
    // the one-pending-per-seat rule for office XP purchase requests. The
    // sibling of the oaq.2 index above, for the same reason and by the same
    // mechanism: office-purchase.js's POST kept a findOne pre-check as a
    // fast-path, but a findOne-then-insertOne pair is not atomic, and an
    // external Codex review round (2026-08-27, passes 1 and 2) REPRODUCED the
    // double spend — a 12-request burst created ten pending rows for one seat
    // and two of them were then accepted onto the same merit. This index is
    // the authoritative guard; the route translates its duplicate-key error
    // (11000) into the same 409 the pre-check already returns. Scoped to
    // status:'pending' so a resolved/declined record never blocks a later
    // resubmission, exactly as the oaq.2 index is.
    getDb().collection('contested_roll_requests').createIndex(
      { seat_id: 1 },
      {
        unique: true,
        background: true,
        partialFilterExpression: { request_type: 'office_purchase', status: 'pending' },
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
    // Ensure the TTL index on roll_log (gdx.8, #989). 30-day retention, same
    // window as its neighbour above. UNLIKE that neighbour, this one actually
    // reaps documents: roll-log.js's own POST handler stamps rolled_at with
    // `new Date()` (a genuine BSON Date), not `.toISOString()`, specifically
    // so MongoDB's TTL monitor — which only expires documents whose indexed
    // field holds a real Date — can act on it. Do not "fix" rolled_at to a
    // string to match this codebase's usual date-as-ISO-string convention;
    // that would silently repeat crd1_terminal_status_ttl's own documented,
    // still-live bug.
    getDb().collection('roll_log').createIndex(
      { rolled_at: 1 },
      { name: 'gdx8_roll_log_ttl', background: true, expireAfterSeconds: 2592000 },
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
    // prax.1: partial unique index on praxis_sessions.chapter_id - exactly ONE Praxis board per
    // Chapter, made a database constraint rather than a convention. Defence in depth alongside the
    // route-level 409 in POST /api/praxis_sessions, which cannot by itself close the read-then-write
    // gap between two STs opening the board in the same moment.
    //
    // Mirrors the game_sessions block immediately above in every respect that matters, and for the
    // same reasons: `$type` rather than `$exists: true` (an `$exists` filter would INCLUDE documents
    // holding an explicit null, and two of those would then collide on the unique key, while
    // `$ne: null` is not accepted in a partial filter at all), and AWAITED inside its own try/catch
    // so that a build which rejects over pre-existing duplicate data is caught and logged here
    // rather than escaping as an unhandled promise rejection that can boot-loop the API on Render.
    //
    // Unlike game_sessions, only 'objectId' is listed: this collection is new as of prax.1 and its
    // sole writer (server/routes/praxis-sessions.js) always stores a real ObjectId, so there is no
    // issue #497 mixed-type legacy to accommodate. If a string-typed chapter_id ever appears here it
    // is a bug in a new writer, and it should NOT be quietly admitted to the uniqueness constraint.
    try {
      await getDb().collection('praxis_sessions').createIndex(
        { chapter_id: 1 },
        {
          name: 'chapter_id_unique_notnull',
          unique: true,
          background: true,
          partialFilterExpression: { chapter_id: { $type: ['objectId'] } },
        },
      );
    } catch (indexErr) {
      console.error(
        'Could not create the praxis_sessions.chapter_id unique index - the one-board-per-Chapter ' +
        'invariant is NOT enforced on this boot. Two praxis boards are probably paired with the ' +
        `same chapter. Resolve by hand: ${indexErr.message}`
      );
    }
    await runRulesEngineGate();
    runBonusWriteGate();
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

// Verify no TM Game source file writes a changed value into a trait's
// `.bonus` field outside the named allowlist (TM Admin Story tm-admin.10.1,
// "one true rating" Stage 1, Phase A — bonus is write-frozen pending Story
// 10.2's fold). Pure static source scan, no DB dependency — synchronous,
// runs after the rules-engine gate. Same production/non-production split as
// runRulesEngineGate(): a real regression here is exactly the STM-14 class
// of bug this guard exists to catch loudly instead of letting it silently
// drift the live character population further apart.
//
// The allowlist (bonus-write-allowlist.json) has the original TWO durable
// audit exceptions (Mantle of Amorous Fire, Faith Militant). A TEMPORARY
// third entry (shAdjMeritBonus, public/js/editor/edit.js:599-608, the
// merit-bonus stepper, feature.333/335 — deliberately out of STM-14's own
// scope) was added 2026-08-31 with Angelus's explicit sign-off, then removed
// by TM Admin Story tm-admin.10.1b once it retired that write path entirely
// (the audited Add-ST-Mod flow, merits.N.bonus — see that story's own Dev
// Agent Record). Story 10.2's own drop step depended on 10.1b landing
// first, which it now has. Do not add a further entry without the same
// kind of explicit sign-off.
//
// TM Admin Story tm-admin.10.5 (Phase C, AC7, 2026-10-01): the rule is now
// "no persisted `bonus` key" (no trait in character.schema.js declares it).
// A quoted `.bonus` dot-path key is flagged at any value, zero included,
// unless the line says $unset, and a scan root that is missing or holds no
// source file now FAILS the gate instead of being scanned as zero files. A
// clean tree still passes (2683 files at the time of the change), so the
// production refusal below only fires on a real regression or a broken
// manifest. Both allowlist entries are obsolete but inert here (TM Admin
// paths outside this repo's scan roots).
function runBonusWriteGate() {
  const result = verifyNoBonusWrites();
  if (result.ok) {
    console.log(formatBonusPassReport(result.filesScanned));
    return;
  }
  if (config.NODE_ENV === 'production') {
    console.error('CRITICAL: no-persisted-bonus verification failed - refusing to boot.');
    console.error(formatViolationsReport(result.violations));
    process.exit(1);
  }
  console.warn('WARNING: no-persisted-bonus verification failed (non-production, continuing).');
  console.warn(formatViolationsReport(result.violations));
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  closeDb().then(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
