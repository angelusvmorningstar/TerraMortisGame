/**
 * Contract tests — CYCLE epic #708, story 3: Phase controls
 * Static-grep assertions over server/routes/tracker.js and
 * public/js/admin/cycle-views.js.
 *
 * STORY tm-admin.27.1 (2026-10-02) retired both halves of what this file used to pin:
 *   - DELETE /api/tracker_state (the bulk tracker wipe) was REMOVED. Nothing called it after CM-4a moved
 *     the wipe into the phase PUT, and a one-request wipe of every character's live tracker is exactly
 *     the hazard of the 2026-08-20 incident. The ST's deliberate slate reset is the Tracker tab's
 *     Reset All (per-character PUTs behind a confirm).
 *   - The Cycle tab's four phase buttons became a READ-ONLY status display. TM Admin is the only
 *     writer of a Chapter's phase, and this app's PUT /api/chapters/:id refuses the phase fields.
 * The assertions below pin the new state. Behavioural coverage of the refusal lives in
 * cm-4a-phase-transition-enforcement.test.js.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';

const TRACKER      = fs.readFileSync('../server/routes/tracker.js', 'utf8');
const CYCLE_VIEWS  = fs.readFileSync('../public/js/admin/cycle-views.js', 'utf8');
const DOWNTIME_DB  = fs.readFileSync('../public/js/downtime/db.js', 'utf8');
const ADMIN_LAYOUT = fs.readFileSync('../public/css/admin-layout.css', 'utf8');

const codeOnly = (src) => src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');

describe('epic.708.3 — tracker.js: the bulk DELETE /api/tracker_state route is gone (27.1)', () => {
  it('has no router.delete route', () => {
    expect(codeOnly(TRACKER)).not.toContain('router.delete(');
  });

  it('never calls deleteMany on the tracker collection', () => {
    expect(codeOnly(TRACKER)).not.toContain('deleteMany');
  });

  it('the Tracker tab still has its own deliberate per-character Reset All', () => {
    const CLIENT_TRACKER = fs.readFileSync('../public/js/game/tracker.js', 'utf8');
    expect(CLIENT_TRACKER).toContain('export async function trackerReset');
    expect(CLIENT_TRACKER).toContain('Reset all characters to zero Vitae');
  });
});

describe('epic.708.3 — cycle-views.js: phase is a read-only status (27.1)', () => {
  it('imports apiPut from api.js (other Cycle tab controls still write)', () => {
    expect(CYCLE_VIEWS).toMatch(/import[^;]*apiPut[^;]*from/);
  });

  it('the canonical phase-writer setCyclePhase still exists in downtime/db.js, but the Cycle tab no longer uses it', () => {
    // setCyclePhase remains for the (unreachable) downtime views; this tab no longer calls it.
    expect(DOWNTIME_DB).toContain('export async function setCyclePhase');
    expect(CYCLE_VIEWS).not.toContain('setCyclePhase');
  });

  it('does NOT wipe the tracker client-side (the server never does either)', () => {
    expect(CYCLE_VIEWS).not.toContain('/api/tracker_state');
  });

  it('has no phase buttons, no phase write and no confirm dialog for a phase change', () => {
    const code = codeOnly(CYCLE_VIEWS);
    expect(code).not.toContain('cy-phase-btn');
    expect(code).not.toContain('writePhase');
    expect(code).not.toContain('phaseToggleTarget');
    expect(code).not.toContain('Phase change failed');
    expect(code).not.toContain('will reset the live tracker');
  });

  it('renders the phase as a status: glyph plus words, with the note that TM Admin sets it', () => {
    const start = CYCLE_VIEWS.indexOf('function buildPhaseCell');
    expect(start).toBeGreaterThan(-1);
    const body = CYCLE_VIEWS.slice(start, CYCLE_VIEWS.indexOf('// ── Prep Access section'));
    expect(body).toContain('cy-phase-readonly');
    expect(body).toContain('No phase set');
    expect(body).toContain('Set in TM Admin');
    expect(body).toContain('Phase is set in TM Admin');
    // Glyph plus words, never colour alone: both a filled and a hollow marker are used.
    expect(body).toContain('●');
    expect(body).toContain('○');
  });

  it('the read-only status has its own CSS, using the --txt3 token and no bare hex', () => {
    expect(ADMIN_LAYOUT).toMatch(/\.cy-phase-readonly--none\s*\{[^}]*var\(--txt3\)/);
    expect(ADMIN_LAYOUT).toMatch(/\.cy-phase-readonly-note\s*\{[^}]*var\(--txt3\)/);
  });

  it('#1002: cycle label cell derives the feeds-into span from game_number', () => {
    // The 2026-07-16 incident this issue tracks was exactly this confusion —
    // the cycle name alone invites the wrong flip. Derived text, not stored.
    expect(CYCLE_VIEWS).toMatch(/DT after Game \$\{cy\.game_number\} . feeds Game \$\{cy\.game_number \+ 1\}/);
  });
});
