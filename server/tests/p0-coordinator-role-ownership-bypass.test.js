/**
 * P0 (High severity) — 2026-09-01 general audit, security-auth dimension,
 * adversarially verified. Five route files gated ownership/redaction checks
 * on the literal string `req.user.role === 'player'` rather than excluding
 * only ST (`!isStRole(req.user)`). The real, distinct `coordinator` role
 * (scoped in this app's own model to check-in/finance/emergency only) was
 * never retrofitted into these checks, so a live coordinator-tier account
 * could read/write any player's private downtime submissions, history,
 * questionnaire, and ordeal responses with no ownership check at all, and
 * delete any game session despite a code comment claiming "(ST only)".
 *
 * These DB-backed routes cannot be exercised end-to-end in this checkout
 * (the server test suite's own #1117 infrastructure precondition refuses to
 * start without both a local mongod AND a markdown/ rulebook corpus, neither
 * present here) — this suite instead does a static source scan, the same
 * pattern this repo already uses for exactly this kind of "must never
 * reappear" guarantee (see ws-fanout.test.js, issue-918-cycle-tab-management
 * .test.js's DELETE-route regex check). Its own assertions need neither
 * mongod nor markdown/ — but note (2026-09-02 codex-review, Pass 3) this
 * file is still collected via this project's shared `vitest.config.js`
 * globalSetup like every other suite, so the STANDARD `npx vitest run`
 * invocation still requires a reachable MongoDB to get past collection at
 * all; only a bypass of that global setup (not the normal command) makes
 * this suite genuinely infrastructure-free. Fixing that is #1117's own
 * scope, not this file's.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }

const DOWNTIME = read('server/routes/downtime.js');
const HISTORY = read('server/routes/history.js');
const QUESTIONNAIRE = read('server/routes/questionnaire.js');
const ORDEAL_RESPONSES = read('server/routes/ordeal-responses.js');
const GAME_SESSIONS = read('server/routes/game-sessions.js');
const ORDEAL_RETIREMENT = read('server/middleware/ordeal-retirement.js');
const CHARACTERS = read('server/routes/characters.js');

describe('P0 — no route gates an ownership/redaction/lock check on the literal role==="player" string', () => {
  // The vulnerable pattern, precisely: a live `if` condition testing the
  // literal string. Matches both `req.user.role === 'player'` and the
  // `&&`-compound shape questionnaire.js's approved-lock check used.
  const VULNERABLE_PATTERN = /req\.user\.role\s*===\s*'player'/;

  it('downtime.js: zero live occurrences (was 6 — POST retirement gate, GET hold-flags scoping, GET / scoping + st_review strip, PUT ownership + st_review strip)', () => {
    expect(DOWNTIME).not.toMatch(VULNERABLE_PATTERN);
  });

  it('history.js: zero live occurrences (was 3 — GET/POST/PUT ownership checks)', () => {
    expect(HISTORY).not.toMatch(VULNERABLE_PATTERN);
  });

  it('questionnaire.js: zero live occurrences (was 4 — GET/POST/PUT ownership checks + the approved-lock check)', () => {
    expect(QUESTIONNAIRE).not.toMatch(VULNERABLE_PATTERN);
  });

  it('ordeal-responses.js: zero live occurrences (was 1 — PUT ownership + approved-lock check)', () => {
    expect(ORDEAL_RESPONSES).not.toMatch(VULNERABLE_PATTERN);
  });

  it('game-sessions.js never used the role==="player" pattern (different bug shape — see below)', () => {
    expect(GAME_SESSIONS).not.toMatch(VULNERABLE_PATTERN);
  });

  // 2026-09-02 codex-review (Pass 2 finding): the original five-file scan
  // above didn't cover the two extra fixes found while implementing (not
  // in the original audit's own finding) — this suite would have stayed
  // green even if either regressed. Closing that gap.
  it('ordeal-retirement.js (requireOrdealNotRetiredForPlayers, shared by history/questionnaire/ordeal-responses): zero live occurrences (was 1)', () => {
    expect(ORDEAL_RETIREMENT).not.toMatch(VULNERABLE_PATTERN);
  });

  it('characters.js: zero live occurrences (was 1 — GET /:id; the file\'s other four ownership checks were already correct pre-fix)', () => {
    expect(CHARACTERS).not.toMatch(VULNERABLE_PATTERN);
  });
});

describe('P0 — each file now gates on !isStRole(req.user), or a route-level requireRole', () => {
  it('downtime.js imports isStRole and uses !isStRole(req.user) at least 6 times (one per fixed gate)', () => {
    expect(DOWNTIME).toMatch(/import\s*\{[^}]*\bisStRole\b[^}]*\}\s*from\s*'\.\.\/middleware\/auth\.js'/);
    const count = (DOWNTIME.match(/!isStRole\(req\.user\)/g) || []).length;
    // Story storytab.1 (2026-09-18) added a 7th gate: GET /story-tab restricts a
    // non-ST caller to their own character_id, the SAME pattern every other gate
    // this test counts already follows. Raised from 6 to 7 deliberately, reviewed
    // alongside that story's own security review, not a silent drift.
    expect(count).toBe(7);
  });

  it('history.js uses !isStRole(req.user) at least 3 times (GET/POST/PUT)', () => {
    const count = (HISTORY.match(/!isStRole\(req\.user\)/g) || []).length;
    expect(count).toBe(3);
  });

  it('questionnaire.js uses !isStRole(req.user) at least 4 times (GET/POST/PUT + approved-lock)', () => {
    const count = (QUESTIONNAIRE.match(/!isStRole\(req\.user\)/g) || []).length;
    expect(count).toBe(4);
  });

  it('ordeal-responses.js uses !isStRole(req.user) once (ownership + approved-lock)', () => {
    const count = (ORDEAL_RESPONSES.match(/!isStRole\(req\.user\)/g) || []).length;
    expect(count).toBe(1);
  });

  it('game-sessions.js: DELETE /:id now carries requireRole(\'st\') as route-level middleware, overriding the looser router-level requireRole(\'coordinator\') mount', () => {
    expect(GAME_SESSIONS).toMatch(/import\s*\{[^}]*\brequireRole\b[^}]*\}\s*from\s*'\.\.\/middleware\/auth\.js'/);
    expect(GAME_SESSIONS).toMatch(/router\.delete\(\s*'\/:id'\s*,\s*requireRole\('st'\)\s*,/);
  });

  it('ordeal-retirement.js imports isStRole and uses !isStRole(req.user) once', () => {
    expect(ORDEAL_RETIREMENT).toMatch(/import\s*\{[^}]*\bisStRole\b[^}]*\}\s*from\s*'\.\/auth\.js'/);
    const count = (ORDEAL_RETIREMENT.match(/!isStRole\(req\.user\)/g) || []).length;
    expect(count).toBe(1);
  });

  it('characters.js uses !isStRole(req.user) exactly 5 times (the 4 pre-existing correct checks plus the fixed GET /:id)', () => {
    const count = (CHARACTERS.match(/!isStRole\(req\.user\)/g) || []).length;
    expect(count).toBe(5);
  });
});

describe('P0 — server/index.js mount-level gate for game-sessions is unchanged (confirms the bug\'s real mechanism)', () => {
  it('game_sessions router is still mounted behind requireRole(\'coordinator\'), which requireRole itself auto-expands to include st/dev', () => {
    const INDEX = read('server/index.js');
    expect(INDEX).toMatch(/app\.use\('\/api\/game_sessions',\s*requireAuth,\s*requireRole\('coordinator'\)/);
  });

  it('requireRole(\'st\') does NOT auto-expand to include coordinator (confirms the route-level fix actually excludes coordinator)', () => {
    const AUTH = read('server/middleware/auth.js');
    // The expansion rule: requesting 'st' auto-adds 'dev', but only requesting
    // 'coordinator' auto-adds 'st'/'dev' — never the reverse. Read directly
    // from source so this test breaks loudly if that asymmetry ever changes.
    const fn = AUTH.slice(AUTH.indexOf('export function requireRole'));
    expect(fn).toMatch(/if \(roles\.includes\('st'\)[\s\S]{0,40}\)\s*effective\.push\('dev'\);/);
    expect(fn).not.toMatch(/roles\.includes\('st'\)[\s\S]{0,80}effective\.push\('coordinator'\)/);
  });
});
