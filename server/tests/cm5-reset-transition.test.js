/**
 * CM-5a — the tracker slate-wipe moves to Prep entry; prep -> game is
 * non-destructive. Pure decision imported directly (no mirror); UI wiring
 * asserted via source text per the epic.708.1 convention.
 *
 * STORY 27.1 (2026-10-02): TM Game no longer sets a phase or wipes the trackers, so the writePhase
 * wiring and error-surface tests that used to live here were removed. The pure matrix stays, as the
 * record of the retired rule; nothing in the app consults it any more. See
 * cm-4a-phase-transition-enforcement.test.js for the refusal.
 *
 * Ruling document: D:/Terra Mortis/cycle-model.md Rev 2 section 2;
 * story: specs/stories/cm5-tracker-reset-to-prep.story.md.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

import { resetOnTransition } from '../../public/js/downtime/cycle-phase.js';

const DVIEWS = fs.readFileSync('../public/js/admin/downtime-views.js', 'utf8');

describe('cm5a — resetOnTransition matrix (executable, the full table)', () => {
  it('entering prep from a PRECEDING phase resets (the once-per-chapter slate)', () => {
    for (const from of [null, 'downtime', 'processing']) {
      expect(resetOnTransition(from, 'prep')).toBe(true);
    }
  });

  it('re-entering prep does NOT reset (would discard feeds already confirmed this week)', () =>
    expect(resetOnTransition('prep', 'prep')).toBe(false));

  it('game -> prep does NOT reset (a misclick beside Game must not wipe a live session)', () =>
    expect(resetOnTransition('game', 'prep')).toBe(false));

  it('prep to game is NON-destructive (the point of this story)', () =>
    expect(resetOnTransition('prep', 'game')).toBe(false));

  it('entering game from any non-prep state keeps the legacy reset', () => {
    for (const from of [null, 'downtime', 'processing', 'game']) {
      expect(resetOnTransition(from, 'game')).toBe(true);
    }
  });

  it('downtime, processing and clear-to-neutral never reset', () => {
    for (const from of [null, 'downtime', 'processing', 'prep', 'game']) {
      expect(resetOnTransition(from, 'downtime')).toBe(false);
      expect(resetOnTransition(from, 'processing')).toBe(false);
      expect(resetOnTransition(from, null)).toBe(false);
    }
  });
});

describe('cm5a — UI wiring (source, per the 708.1 convention)', () => {
  // The Cycle tab is the ONLY live phase-control surface. downtime-views.js's
  // handleOpenGamePhase looked like a second game-entry route but is dead code
  // (its sole reference is its own definition - verified by repo-wide grep,
  // review 2026-08-10), so CM-5a deliberately leaves it untouched rather than
  // wiring a reset into an unreachable function. If it is ever revived it must
  // consult resetOnTransition; this test fails loudly if it gains a listener
  // without one.
  it('the dead processing-view route stays dead, or gains the rule if revived', () => {
    const refs = (DVIEWS.match(/handleOpenGamePhase/g) || []).length;
    if (refs > 1) {
      expect(DVIEWS).toContain('resetOnTransition');
    } else {
      expect(refs).toBe(1);
      expect(DVIEWS).not.toContain('resetOnTransition');
    }
  });
});
