/**
 * server/tests/storytab4-readonly-guard.test.js — Story storytab.4.
 *
 * AC 1 (lexical guard): scans the storytab.1-introduced source for any Mongo
 * write-shaped call. This repo has no prior lexical write-scan precedent of its own to
 * extend (checked server/db.js and server/tests/ — none found; TM Story's own
 * `server/canon-write-monitor.js`/`mongo-store.test.js` is the precedent this mirrors,
 * see server/lib/write-command-monitor.js's own header), so this is a new, narrowly-
 * scoped scanner — narrower than TM Story's "whole canon layer" scan because only ONE
 * new code path needs guarding here, not a whole second connection.
 *
 * AC 4 (no local persistence): the client half of the same discipline — the merge
 * function that touches TM-Story-sourced data must never write to localStorage,
 * sessionStorage, IndexedDB, or issue a non-GET fetch of its own.
 *
 * Deliberately scoped to the SPECIFIC functions/handlers storytab.1 introduced, not
 * whole files: `server/routes/downtime.js` and `public/js/tabs/story-tab.js` both also
 * contain this repo's own EXISTING, legitimate write paths (the player-facing downtime
 * form, POST/PUT/DELETE `/api/downtime_submissions`, frozen per D6 but still live code)
 * — scanning those whole files would immediately misfire on code this story explicitly
 * does not touch (see the story file's own "Explicitly NOT in scope").
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = rel => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// Mongo write-shaped calls, matched lexically against the driver method name (not the
// wire command name — write-command-monitor.js's WRITE_COMMANDS is the wire-level twin
// of this list, kept independently because a lexical scan and a runtime monitor are
// deliberately two DIFFERENT defence layers, not one check expressed twice).
const MONGO_WRITE_PATTERNS = [
  { name: 'insertOne', re: /\.insertOne\s*\(/ },
  { name: 'insertMany', re: /\.insertMany\s*\(/ },
  { name: 'updateOne', re: /\.updateOne\s*\(/ },
  { name: 'updateMany', re: /\.updateMany\s*\(/ },
  { name: 'replaceOne', re: /\.replaceOne\s*\(/ },
  { name: 'deleteOne', re: /\.deleteOne\s*\(/ },
  { name: 'deleteMany', re: /\.deleteMany\s*\(/ },
  { name: 'findOneAndUpdate', re: /\.findOneAndUpdate\s*\(/ },
  { name: 'findOneAndReplace', re: /\.findOneAndReplace\s*\(/ },
  { name: 'findOneAndDelete', re: /\.findOneAndDelete\s*\(/ },
  { name: 'bulkWrite', re: /\.bulkWrite\s*\(/ },
  { name: 'dropCollection', re: /\.drop\s*\(/ },
  { name: 'dbCommand', re: /\.command\s*\(/ },
  { name: 'aggregateOut', re: /\$out\b/ },
  { name: 'aggregateMerge', re: /\$merge\b/ },
];

// Client-side persistence-shaped calls, for AC 4's "no local persistence anywhere" rule.
const CLIENT_PERSISTENCE_PATTERNS = [
  { name: 'localStorageSet', re: /localStorage\.setItem\s*\(/ },
  { name: 'sessionStorageSet', re: /sessionStorage\.setItem\s*\(/ },
  { name: 'indexedDB', re: /indexedDB/ },
  { name: 'nonGetFetch', re: /fetch\([^;]*?method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/ },
];

function scan(source, patterns) {
  return patterns.filter(p => p.re.test(source)).map(p => p.name);
}

/** Extracts the substring between two unique literal markers (inclusive of start,
 * exclusive of end), the same technique used to isolate one route handler out of a
 * multi-route file. Throws if either marker is missing, so a rename/move of the guarded
 * code silently disables the guard rather than the scan quietly covering nothing. */
function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`extractBetween: start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`extractBetween: end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

describe('storytab4-readonly-guard: scanner self-test (discrimination)', () => {
  it('MONGO_WRITE_PATTERNS actually flags a deliberately write-shaped fixture', () => {
    const dirty = `await submissions().insertOne({ character_id: charId });`;
    expect(scan(dirty, MONGO_WRITE_PATTERNS)).toEqual(['insertOne']);
  });

  it('MONGO_WRITE_PATTERNS stays silent on a genuinely read-only fixture', () => {
    const clean = `const existingSubs = await submissions().find({ character_id: charOid }).toArray();`;
    expect(scan(clean, MONGO_WRITE_PATTERNS)).toEqual([]);
  });

  it('catches an aggregate $out/$merge write vector, not just named CRUD methods', () => {
    expect(scan(`col.aggregate([{ $out: 'leak' }])`, MONGO_WRITE_PATTERNS)).toEqual(['aggregateOut']);
    expect(scan(`col.aggregate([{ $merge: { into: 'leak' } }])`, MONGO_WRITE_PATTERNS)).toEqual(['aggregateMerge']);
  });

  it('CLIENT_PERSISTENCE_PATTERNS actually flags a deliberately persisting fixture', () => {
    expect(scan(`localStorage.setItem('x', JSON.stringify(subs));`, CLIENT_PERSISTENCE_PATTERNS))
      .toEqual(['localStorageSet']);
    expect(scan(`fetch('/api/foo', { method: 'POST', body: '{}' })`, CLIENT_PERSISTENCE_PATTERNS))
      .toEqual(['nonGetFetch']);
  });

  it('CLIENT_PERSISTENCE_PATTERNS stays silent on a genuinely in-memory fixture', () => {
    const clean = `const { downtimes, chapters } = await apiGet(\`/api/downtime_submissions/story-tab?character_id=\${char._id}\`);`;
    expect(scan(clean, CLIENT_PERSISTENCE_PATTERNS)).toEqual([]);
  });

  it('extractBetween throws (fails loud) rather than silently scanning nothing when a marker goes missing', () => {
    expect(() => extractBetween('abc def ghi', 'zzz', 'ghi')).toThrow(/start marker not found/);
    expect(() => extractBetween('abc def ghi', 'abc', 'zzz')).toThrow(/end marker not found/);
  });
});

describe('storytab4-readonly-guard: AC 1, server-side lexical write scan', () => {
  it('server/lib/story-downtime-fetch.js (the TM Story fetch helper, storytab.1) contains no Mongo write-shaped call', () => {
    const source = read('server/lib/story-downtime-fetch.js');
    expect(scan(source, MONGO_WRITE_PATTERNS)).toEqual([]);
  });

  it('the GET /story-tab route handler (server/routes/downtime.js) contains no Mongo write-shaped call', () => {
    const source = read('server/routes/downtime.js');
    const handler = extractBetween(
      source,
      `submissionsRouter.get('/story-tab',`,
      `submissionsRouter.get('/hold-flags',`,
    );
    expect(scan(handler, MONGO_WRITE_PATTERNS)).toEqual([]);
  });
});

describe('storytab4-readonly-guard: AC 4, client-side no-local-persistence scan', () => {
  it('fetchAndMergeStoryTabDowntimes (public/js/tabs/story-tab.js) never persists the TM-Story-sourced merge past the in-memory render', () => {
    const source = read('public/js/tabs/story-tab.js');
    const fn = extractBetween(
      source,
      'async function fetchAndMergeStoryTabDowntimes(',
      'export async function renderLatestReport(',
    );
    expect(scan(fn, CLIENT_PERSISTENCE_PATTERNS)).toEqual([]);
    // The merge itself is exactly one GET, matching AC 3's server-side twin.
    expect(fn).toMatch(/apiGet\(/);
    expect(fn).not.toMatch(/apiPost\(|apiPut\(|apiPatch\(/);
  });
});
