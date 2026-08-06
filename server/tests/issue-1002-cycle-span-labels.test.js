import { describe, it, expect, beforeAll } from 'vitest';

/**
 * #1002: cycle labels must state their feeds-into span. Downtimes are collected
 * after game N and consumed at the following session, so a cycle for game N feeds
 * game N+1. The 2026-07-16 incident was the cycle NAME ("Game 6") inviting the
 * ST to flip the wrong cycle. The span is derived from game_number, never stored.
 *
 * db.js is browser code (imports ../data/api.js which reads `location`), so we
 * stub the minimal browser globals and dynamic-import it.
 */

let cycleSpanLabel, cycleFeedsLabel;

beforeAll(async () => {
  globalThis.location = { hostname: 'test-host' };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => [] });
  const mod = await import('../../public/js/downtime/db.js');
  cycleSpanLabel = mod.cycleSpanLabel;
  cycleFeedsLabel = mod.cycleFeedsLabel;
});

describe('#1002 — cycleSpanLabel', () => {
  it('game N feeds game N+1 (off-by-one is the whole point)', () => {
    expect(cycleSpanLabel({ game_number: 5 })).toBe('Downtime after Game 5, feeds Game 6');
    expect(cycleSpanLabel({ game_number: 6 })).toBe('Downtime after Game 6, feeds Game 7');
  });

  it('empty string when game_number is missing (no fabricated span)', () => {
    expect(cycleSpanLabel({ label: 'Ad-hoc' })).toBe('');
    expect(cycleSpanLabel({})).toBe('');
    expect(cycleSpanLabel(null)).toBe('');
  });

  it('no em-dash in the copy', () => {
    expect(cycleSpanLabel({ game_number: 5 })).not.toContain('—');
  });
});

describe('#1002 — cycleFeedsLabel', () => {
  it('short form names the fed session', () => {
    expect(cycleFeedsLabel({ game_number: 5 })).toBe('feeds Game 6');
    expect(cycleFeedsLabel({ game_number: 1 })).toBe('feeds Game 2');
  });

  it('empty string when game_number is missing', () => {
    expect(cycleFeedsLabel({})).toBe('');
    expect(cycleFeedsLabel(null)).toBe('');
  });
});
