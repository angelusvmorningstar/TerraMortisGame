/**
 * Test helper — creates an Express app with auth bypass.
 * Instead of validating Discord tokens, injects req.user directly.
 */

import express from 'express';
import cors from 'cors';
import { requireRole } from '../../middleware/auth.js';
import { cacheControl, noCache } from '../../middleware/cache-control.js';
import charactersRouter from '../../routes/characters.js';
import territoriesRouter from '../../routes/territories.js';
import { cyclesRouter } from '../../routes/chapters.js';
import { submissionsRouter, projectInvitationsRouter } from '../../routes/downtime.js';
import gameSessionsRouter from '../../routes/game-sessions.js';
import playersRouter from '../../routes/players.js';
import attendanceRouter from '../../routes/attendance.js';
import trackerRouter from '../../routes/tracker.js';
import rankingBallotsRouter from '../../routes/ranking_ballots.js';
import ordealSubmissionsRouter from '../../routes/ordeal-submissions.js';
import ordealResponsesRouter from '../../routes/ordeal-responses.js';
import questionnaireRouter from '../../routes/questionnaire.js';
import historyRouter from '../../routes/history.js';
import rulesRouter from '../../routes/rules.js';
import {
  grantRouter, specialityGrantRouter, skillBonusRouter, nineAgainRouter, rulesAggregateRouter,
  discAttrRouter, derivedStatModRouter, tierBudgetRouter, statusFloorRouter,
  bonusSuccessRouter,
} from '../../routes/rules-engine.js';
import relationshipsRouter from '../../routes/relationships.js';
import npcFlagsRouter from '../../routes/npc-flags.js';
import npcsRouter from '../../routes/npcs.js';
import stModsRouter, { auditRouter as stModAuditRouter } from '../../routes/st_mods.js';
import writeOnceViolationsRouter from '../../routes/write-once-violations.js';
import appSettingsRouter from '../../routes/app-settings.js';
import buildEquipmentCatalogueRouter from '../../routes/equipment-catalogue.js';
import { storyCyclesRouter } from '../../routes/story-cycles.js';
import buildBloodlinesRouter from '../../routes/bloodlines.js';
import buildOfficeContentRouter from '../../routes/office-content.js';
import cyoaRouter from '../../routes/cyoa.js';
import officeActionsRouter from '../../routes/office-actions.js';
import rollLogRouter from '../../routes/roll-log.js';
import officeMeritDotsRouter from '../../routes/office-merit-dots.js';
import officeManoeuvreRankRouter from '../../routes/office-manoeuvre-rank.js';
import officeSeatsRouter from '../../routes/office-seats.js';
import praxisSessionsRouter from '../../routes/praxis-sessions.js';
import contestedRollsRouter from '../../routes/contested-rolls.js';
import humanityCheckRouter from '../../routes/humanity-check.js';
import officePurchaseRouter from '../../routes/office-purchase.js';

/**
 * Create a test app with a mock user injected via header.
 * Pass X-Test-User header as JSON to set req.user.
 */
export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Mock auth middleware — reads user from X-Test-User header
  function mockAuth(req, res, next) {
    const header = req.headers['x-test-user'];
    if (!header) {
      return res.status(401).json({ error: 'AUTH_ERROR', message: 'Authentication required' });
    }
    try {
      req.user = JSON.parse(header);
    } catch {
      return res.status(401).json({ error: 'AUTH_ERROR', message: 'Invalid test user header' });
    }
    next();
  }

  // Health check
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // Epic ECM (#868) equipment_catalogue — same factory pattern as prod, but
  // injects mockAuth (the test app's per-request auth surface) instead of
  // requireAuth. Reads stay public; writes still gate on the X-Test-User
  // header followed by requireRole('st'). The legacy /api/equipment alias
  // mount was removed in ECM-7 (#874).
  app.use('/api/equipment_catalogue', buildEquipmentCatalogueRouter(mockAuth));

  // Epic BL (#1008) bloodlines — public read only (ADMR-1, 2026-08-26,
  // retired the BL-4 write API this router used to also carry; see
  // server/routes/bloodlines.js). Same factory shape as before, so this
  // mount needed no change when the writes retired.
  app.use('/api/bloodlines', buildBloodlinesRouter(mockAuth));

  // oxp.10 office_content — public read only, same factory shape as bloodlines.
  app.use('/api/office_content', buildOfficeContentRouter(mockAuth));

  // Protected routes with mock auth.
  // Issue #255: mirror prod Cache-Control discipline so tests can assert
  // the headers are wired correctly through the same middleware stack.
  const CACHE_5MIN = cacheControl(300);
  app.use('/api/characters', mockAuth, noCache(), charactersRouter);
  app.use('/api/chapters', mockAuth, noCache(), cyclesRouter);
  app.use('/api/downtime_submissions', mockAuth, noCache(), submissionsRouter);
  app.use('/api/ranking_ballots', mockAuth, noCache(), rankingBallotsRouter);
  app.use('/api/project_invitations', mockAuth, noCache(), projectInvitationsRouter);
  app.use('/api/players', mockAuth, noCache(), playersRouter);
  app.use('/api/attendance', mockAuth, noCache(), attendanceRouter);

  // Territories — matches prod: auth required at app level; write gating is
  // inside the router (POST/PUT ST-only, PATCH /:id/feeding-rights regent+ST).
  app.use('/api/territories', mockAuth, CACHE_5MIN, territoriesRouter);
  // ST-only routes
  app.use('/api/game_sessions', mockAuth, requireRole('coordinator'), noCache(), gameSessionsRouter);
  // NOT requireRole('st') - production (server/index.js) mounts this behind `requireAuth` only,
  // relying on the router's OWN canAccess() (an ST/dev role OR the requesting player owning the
  // character) for its finer-grained check. A requireRole('st') gate here would 403 an owning
  // player before the router's own ownership branch ever runs - the opposite of what's live -
  // and would make it impossible to test the player-writable paths (Story 12.8's feeding
  // reconciliation, the Vitae/Willpower self-spend route) against a real player identity.
  app.use('/api/tracker_state', mockAuth, noCache(), trackerRouter);
  app.use('/api/ordeal_submissions', mockAuth, noCache(), ordealSubmissionsRouter);
  app.use('/api/ordeal-responses', mockAuth, noCache(), ordealResponsesRouter);
  // 2026-08-29: mounted for the first time — these two had never been wired into
  // the test app, so their retirement gate (like everything else in them) had
  // zero HTTP-level test coverage. Mirrors prod's own mount in server/index.js.
  app.use('/api/questionnaire', mockAuth, noCache(), questionnaireRouter);
  app.use('/api/history', mockAuth, noCache(), historyRouter);
  // RETIRED, Story 31-5 (TM Wiki) - the route moved to TM Wiki along with its data.
  // See the matching note in server/index.js.
  // Rules engine — must mount before /api/rules (purchasable_powers)
  // Kurtis W bug report (2026-09): reads open to any authenticated user now
  // (writes stay ST-only, enforced at the route level inside
  // rules-engine.js) — mirrors prod's own mount in server/index.js.
  app.use('/api/rules/grant',                 mockAuth, CACHE_5MIN, grantRouter);
  app.use('/api/rules/speciality_grant',      mockAuth, CACHE_5MIN, specialityGrantRouter);
  app.use('/api/rules/skill_bonus',           mockAuth, CACHE_5MIN, skillBonusRouter);
  app.use('/api/rules/nine_again',            mockAuth, CACHE_5MIN, nineAgainRouter);
  app.use('/api/rules/disc_attr',             mockAuth, CACHE_5MIN, discAttrRouter);
  app.use('/api/rules/derived_stat_modifier', mockAuth, CACHE_5MIN, derivedStatModRouter);
  app.use('/api/rules/tier_budget',           mockAuth, CACHE_5MIN, tierBudgetRouter);
  app.use('/api/rules/status_floor',          mockAuth, CACHE_5MIN, statusFloorRouter);
  // dtlt.1: roll-time bonus successes.
  app.use('/api/rules/bonus_success',         mockAuth, CACHE_5MIN, bonusSuccessRouter);
  // Issue #265 (rebase): aggregate endpoint same content as per-category
  // routes — mounted with the same CACHE_5MIN wiring.
  app.use('/api/rules/aggregate',             mockAuth, CACHE_5MIN, rulesAggregateRouter);
  app.use('/api/rules', mockAuth, CACHE_5MIN, rulesRouter);
  app.use('/api/relationships', mockAuth, noCache(), relationshipsRouter);
  app.use('/api/npcs', mockAuth, noCache(), npcsRouter);
  app.use('/api/npc-flags', mockAuth, noCache(), npcFlagsRouter);
  // Epic STM (issue #358): ST mod overlay foundation
  app.use('/api/st_mods', mockAuth, noCache(), stModsRouter);
  app.use('/api/st_mod_audit', mockAuth, noCache(), stModAuditRouter);
  // Issue #1132: refused write-once (clan/bloodline) transition attempts.
  // Mirrors prod's own mount in server/index.js, with mockAuth in place of
  // requireAuth. ST gating stays on the handler inside the router.
  app.use('/api/write_once_violations', mockAuth, noCache(), writeOnceViolationsRouter);
  // Epic STM (issue #378): app settings (global kill-switch)
  app.use('/api/settings', mockAuth, noCache(), appSettingsRouter);
  // CYCLE epic (#708): story cycle management (was /api/chapters until cm-2)
  app.use('/api/story_cycles', mockAuth, noCache(), storyCyclesRouter);
  // Issue #971: CYOA cross-project write-back
  app.use('/api/cyoa', mockAuth, noCache(), cyoaRouter);
  // gdx.8 (#989): persisted roll history
  app.use('/api/roll_log', mockAuth, noCache(), rollLogRouter);
  // Issue #691 / otc.2: office actions (Status Actions)
  app.use('/api/office_actions', mockAuth, noCache(), officeActionsRouter);
  app.use('/api/office_merit_dots', mockAuth, noCache(), officeMeritDotsRouter);
  // oxp.3: office manoeuvre purchase rank (open read, ST-only write)
  app.use('/api/office_manoeuvre_rank', mockAuth, noCache(), officeManoeuvreRankRouter);
  // oxp.2: office seats, read-only (open read, no write verb at all)
  app.use('/api/office_seats', mockAuth, noCache(), officeSeatsRouter);
  // prax.1: the Praxis night board. Mirrors prod's own mount in server/index.js
  // (auth at the mount, ST gating on every handler inside the router).
  app.use('/api/praxis_sessions', mockAuth, noCache(), praxisSessionsRouter);
  // oaq.2 review: needed to test contested-rolls.js's request_type guard
  // against status_action documents sharing the same collection.
  app.use('/api/contested_roll_requests', mockAuth, noCache(), contestedRollsRouter);
  // gdx.12: Humanity Check submit/accept/decline (shares the same collection).
  app.use('/api/humanity_check_requests', mockAuth, noCache(), humanityCheckRouter);
  // oxp.9: office XP spend requests (shares the same collection again).
  app.use('/api/office_purchase_requests', mockAuth, noCache(), officePurchaseRouter);

  return app;
}

/** Build X-Test-User header for an ST user */
export function stUser(overrides = {}) {
  return JSON.stringify({
    id: 'test-st-001',
    username: 'test_st',
    role: 'st',
    player_id: 'p-st-001',
    character_ids: [],
    ...overrides,
  });
}

/** Build X-Test-User header for a player user */
export function playerUser(characterIds = [], overrides = {}) {
  return JSON.stringify({
    id: 'test-player-001',
    username: 'test_player',
    role: 'player',
    player_id: 'p-player-001',
    character_ids: characterIds,
    ...overrides,
  });
}

/** Build X-Test-User header for a coordinator user (fin.1) */
export function coordinatorUser(overrides = {}) {
  return JSON.stringify({
    id: 'test-coord-001',
    username: 'test_coord',
    role: 'coordinator',
    player_id: 'p-coord-001',
    character_ids: [],
    ...overrides,
  });
}
