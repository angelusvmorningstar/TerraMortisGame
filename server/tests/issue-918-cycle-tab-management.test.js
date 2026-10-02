import { describe, it, expect } from 'vitest';
import fs from 'fs';

// cm-2b: the cycle DELETE route moved with cyclesRouter into chapters.js.
const DOWNTIME = fs.readFileSync('../server/routes/chapters.js', 'utf8');
const DB       = fs.readFileSync('../public/js/downtime/db.js', 'utf8');
const VIEWS    = fs.readFileSync('../public/js/admin/cycle-views.js', 'utf8');
const CSS      = fs.readFileSync('../public/css/admin-layout.css', 'utf8');

// ── Server: DELETE /api/chapters/:id ──────────────────────────────────

describe('issue-918 — cycle DELETE route', () => {
  it('DELETE /:id requires ST role', () =>
    expect(DOWNTIME).toMatch(/cyclesRouter\.delete\s*\(\s*'\/:id'\s*,\s*requireRole\s*\(\s*'st'\s*\)/));

  it('validates the id format (400)', () =>
    expect(DOWNTIME).toMatch(/cyclesRouter\.delete[\s\S]{0,400}VALIDATION_ERROR/));

  // cm-3 (2026-08-17): the proximity windows below were 600/800. The DELETE
  // handler gained a second 409 guard first (CYCLE_IS_STORY_FINALE, AC10) plus
  // its comment, which pushed the submission guard and the 404 past the old
  // limits. Widened, not weakened — every assertion still has to find its
  // target inside this one route handler.
  // cm-2b review rework (2026-08-17): the guard used to be
  // `countDocuments({ chapter_id: oid })` — an ObjectId-ONLY equality that
  // counted zero for a Chapter whose submissions carry DT1-era string FKs, and
  // deleted it, orphaning them. It now goes through the shared dual-read shim.
  // The behavioural proof is in cm-2b-chapters-route-and-dual-read.test.js;
  // this is the source contract that the shared helper is what is used, rather
  // than a re-derived match. Windows widened for the added comment, not
  // weakened — every assertion still has to land inside this one handler.
  it('guards against deleting a cycle with submissions (409), via the shared FK shim', () => {
    expect(DOWNTIME).toContain('CYCLE_HAS_SUBMISSIONS');
    expect(DOWNTIME).toMatch(/cyclesRouter\.delete[\s\S]{0,1800}countDocuments\(chapterFkFilter\(oid\)\)/);
    expect(DOWNTIME).toMatch(/cyclesRouter\.delete[\s\S]{0,1800}status\(409\)/);
    expect(DOWNTIME).toMatch(/import \{ chapterFkFilter \} from '\.\.\/helpers\/chapter-fk\.js'/);
  });

  it('returns 404 when nothing was deleted', () =>
    expect(DOWNTIME).toMatch(/cyclesRouter\.delete[\s\S]{0,2000}deletedCount === 0[\s\S]{0,120}NOT_FOUND/));
});

// ── Client db.js helpers ─────────────────────────────────────────────────────

describe('issue-918 — db.js cycle helpers', () => {
  it('exports deleteCycle', () =>
    expect(DB).toMatch(/export async function deleteCycle\(id\)/));

  it('deleteCycle DELETEs the cycle endpoint', () =>
    expect(DB).toMatch(/deleteCycle[\s\S]{0,120}apiDelete\('\/api\/chapters\/'\s*\+\s*id\)/));

  it('imports apiDelete', () =>
    expect(DB).toMatch(/import\s*\{[^}]*apiDelete[^}]*\}\s*from\s*'\.\.\/data\/api\.js'/));

  // cm-2: chapterId -> storyCycleId, body.chapter_id -> body.story_cycle_id.
  it('createCycle accepts label and storyCycleId options', () => {
    expect(DB).toMatch(/createCycle\(gameNumber,\s*\{[^}]*label/);
    expect(DB).toContain('storyCycleId');
    expect(DB).toMatch(/story_cycle_id = storyCycleId|body\.story_cycle_id = storyCycleId/);
  });
});

// ── Client cycle-views.js ────────────────────────────────────────────────────

describe('issue-918 — cycle-views.js wiring', () => {
  it('imports cycle CRUD + status helper from db.js', () =>
    expect(VIEWS).toMatch(/import\s*\{[^}]*createCycle[^}]*deleteCycle[^}]*deriveCycleStatus[^}]*\}\s*from\s*'\.\.\/downtime\/db\.js'/));

  it('renders a status ribbon', () => {
    expect(VIEWS).toContain('buildRibbon');
    expect(VIEWS).toContain('renderRibbon');
    expect(VIEWS).toContain('deriveCurrentCycle');
    expect(VIEWS).toContain('cy-ribbon');
  });

  // STORY tm-admin.27.1 (2026-10-02): the two assertions that stood here pinned the phase TOGGLE
  // (phaseToggleTarget) and the client-side tracker-reset guard (resetOnTransition(uiPhase(cy),
  // phaseOrNull)). Both are gone with the buttons: this tab no longer sets a phase at all (TM Admin does,
  // and PUT /api/chapters/:id refuses the phase fields), so there is no toggle to clear and no wipe to
  // guard. The intent that "clearing a phase never wipes the tracker" now holds more strongly: nothing in
  // this app wipes it on a phase change. Behavioural coverage: cm-4a-phase-transition-enforcement.test.js.
  it('the Cycle tab has no phase toggle any more: the phase cell is a read-only status', () => {
    expect(VIEWS).not.toContain('phaseToggleTarget');
    expect(VIEWS).not.toContain('writePhase');
    expect(VIEWS).toContain('cy-phase-readonly');
  });

  it('the Cycle tab never resets or deletes the tracker', () => {
    expect(VIEWS).not.toContain('resetOnTransition');
    expect(VIEWS).not.toContain("apiDelete('/api/tracker_state')");
    expect(VIEWS).not.toContain('/api/tracker_state');
  });

  it('inline-edits the label via updateCycle', () => {
    expect(VIEWS).toContain('buildLabelCell');
    expect(VIEWS).toMatch(/updateCycle\(cy\._id,\s*\{\s*label/);
  });

  it('assigns story cycle via a dropdown writing story_cycle_id', () => {
    expect(VIEWS).toContain('buildStoryCycleSelect');
    expect(VIEWS).toMatch(/updateCycle\(cy\._id,\s*\{\s*story_cycle_id/);
  });

  it('adds a new cycle via createCycle', () => {
    expect(VIEWS).toContain('new-cy-save');
    expect(VIEWS).toMatch(/createCycle\(num,\s*\{\s*label,\s*storyCycleId/);
  });

  it('add-cycle form uses the handler-free story cycle picker (no phantom updateCycle)', () => {
    // Regression (QA #918): the add form must NOT reuse buildStoryCycleSelect,
    // whose change handler persists to an existing cycle id. With no cycle to
    // write to, that fired updateCycle(undefined,...) and reverted the choice.
    expect(VIEWS).toContain('buildStoryCyclePicker(storyCycles)');
    expect(VIEWS).not.toContain('buildStoryCycleSelect({ story_cycle_id: null }');
  });

  it('deletes a cycle via deleteCycle with confirmation', () => {
    expect(VIEWS).toContain('btn-danger');
    expect(VIEWS).toMatch(/deleteCycle\(cy\._id\)/);
    expect(VIEWS).toContain('confirm(');
  });

  it('uses normalised CSS — no inline styles in the rewritten view', () => {
    expect(VIEWS).not.toContain('cssText');
    expect(VIEWS).not.toContain('style="');
  });
});

// ── CSS normalised classes ───────────────────────────────────────────────────

describe('issue-918 — admin-layout.css cycle classes', () => {
  it('defines the ribbon', () =>
    expect(CSS).toContain('.cy-ribbon'));

  it('defines the neutral phase chip', () =>
    expect(CSS).toContain('.cy-phase--none'));

  // Story tm-admin.27.1 (2026-10-02): the toggleable phase buttons are gone (the phase is a read-only
  // status; TM Admin sets it), so their CSS was removed and the read-only status classes are pinned instead.
  it('defines the read-only phase status, and no longer defines phase buttons', () => {
    expect(CSS).toContain('.cy-phase-readonly');
    expect(CSS).toContain('.cy-phase-readonly--none');
    expect(CSS).toContain('.cy-phase-readonly-note');
    expect(CSS).not.toContain('.cy-phase-btn');
    expect(CSS).not.toContain('.cy-phase-group');
  });
});
