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
// deliberately two DIFFERENT defence layers, not one check expressed twice). Deliberately
// broad/receiver-agnostic (e.g. `.drop(` matches any object's `.drop()`, not only a Mongo
// collection's): a false positive here just means an unrelated future refactor needs a
// one-line allowlist note, which is the safe failure direction for a guard test.
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
  { name: 'createIndex', re: /\.createIndex(es)?\s*\(/ },
  { name: 'dropIndex', re: /\.dropIndex(es)?\s*\(/ },
  { name: 'rename', re: /\.rename\s*\(/ },
  { name: 'createCollection', re: /\.createCollection\s*\(/ },
  { name: 'aggregateOut', re: /\$out\b/ },
  { name: 'aggregateMerge', re: /\$merge\b/ },
];

// Filesystem-write calls — AC 4's "not a file" clause applies on BOTH sides (a server-side
// cache-to-disk regression is exactly as prohibited as a client-side localStorage one).
const FILE_WRITE_PATTERNS = [
  { name: 'writeFileSync', re: /\bwriteFileSync\s*\(/ },
  { name: 'writeFile', re: /\bwriteFile\s*\(/ },
  { name: 'fsImport', re: /from\s+['"]node:fs['"]|require\(['"]fs['"]\)/ },
];

// Client-side persistence-shaped calls, for AC 4's "no local persistence anywhere" rule.
// `rawFetch` is deliberately a bare `fetch(` ban, not an enumeration of write-verb strings
// (a `nonGetFetch`-style allowlist of quoted method names misses a COMPUTED method value,
// and previously missed the `apiDelete(` client helper alongside apiPost/Put/Patch) — the
// scanned functions are only ever supposed to call `apiGet`, so ANY literal `fetch(` call
// inside them is itself the violation, regardless of what method it would use.
const CLIENT_PERSISTENCE_PATTERNS = [
  { name: 'localStorageSet', re: /localStorage\.setItem\s*\(/ },
  { name: 'sessionStorageSet', re: /sessionStorage\.setItem\s*\(/ },
  { name: 'indexedDB', re: /indexedDB/ },
  { name: 'rawFetch', re: /\bfetch\s*\(/ },
  { name: 'nonGetApiHelper', re: /\bapi(Post|Put|Patch|Delete)\s*\(/ },
];

function scan(source, patterns) {
  return patterns.filter(p => p.re.test(source)).map(p => p.name);
}

/** Extracts the substring between two unique literal markers (inclusive of start,
 * exclusive of end), the same technique used to isolate one route handler out of a
 * multi-route file. Throws if either marker is missing OR if either marker is not
 * genuinely unique across the whole source — a duplicate would make `indexOf` silently
 * select the wrong (or a truncated) region rather than the intended one, which is worse
 * than a missing marker because nothing signals it. */
function extractBetween(source, startMarker, endMarker) {
  const startCount = source.split(startMarker).length - 1;
  if (startCount === 0) throw new Error(`extractBetween: start marker not found: ${startMarker}`);
  if (startCount > 1) throw new Error(`extractBetween: start marker is not unique (${startCount} occurrences): ${startMarker}`);
  const endCount = source.split(endMarker).length - 1;
  if (endCount === 0) throw new Error(`extractBetween: end marker not found: ${endMarker}`);
  if (endCount > 1) throw new Error(`extractBetween: end marker is not unique (${endCount} occurrences): ${endMarker}`);
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`extractBetween: end marker does not appear after start marker: ${endMarker}`);
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

  // Codex external review (2026-09-19): the original pattern list named the CRUD verbs
  // only and missed index/collection/rename admin calls a future edit could plausibly add.
  it('catches index, collection, and rename admin calls, not just CRUD/aggregate writes', () => {
    expect(scan(`col.createIndex({ x: 1 })`, MONGO_WRITE_PATTERNS)).toEqual(['createIndex']);
    expect(scan(`col.createIndexes([{ x: 1 }])`, MONGO_WRITE_PATTERNS)).toEqual(['createIndex']);
    expect(scan(`col.dropIndex('x_1')`, MONGO_WRITE_PATTERNS)).toEqual(['dropIndex']);
    expect(scan(`col.rename('newName')`, MONGO_WRITE_PATTERNS)).toEqual(['rename']);
    expect(scan(`db.createCollection('x')`, MONGO_WRITE_PATTERNS)).toEqual(['createCollection']);
  });

  it('FILE_WRITE_PATTERNS actually flags a deliberately file-persisting fixture', () => {
    expect(scan(`fs.writeFileSync(cachePath, JSON.stringify(report));`, FILE_WRITE_PATTERNS))
      .toEqual(['writeFileSync']);
    expect(scan(`import fs from 'node:fs';`, FILE_WRITE_PATTERNS)).toEqual(['fsImport']);
  });

  it('FILE_WRITE_PATTERNS stays silent on a genuinely fs-free fixture', () => {
    expect(scan(`await fetchStoryDowntimes({ authorization, characterId });`, FILE_WRITE_PATTERNS)).toEqual([]);
  });

  it('CLIENT_PERSISTENCE_PATTERNS actually flags a deliberately persisting fixture, including a computed-method fetch and the apiDelete helper', () => {
    expect(scan(`localStorage.setItem('x', JSON.stringify(subs));`, CLIENT_PERSISTENCE_PATTERNS))
      .toEqual(['localStorageSet']);
    expect(scan(`fetch('/api/foo', { method: 'POST', body: '{}' })`, CLIENT_PERSISTENCE_PATTERNS))
      .toEqual(['rawFetch']);
    // A COMPUTED method value would evade any pattern enumerating quoted verb strings —
    // the bare `fetch(` ban catches it regardless of what method the call would use.
    expect(scan(`fetch('/api/foo', { method: someVerb })`, CLIENT_PERSISTENCE_PATTERNS))
      .toEqual(['rawFetch']);
    expect(scan(`apiDelete('/api/downtime_submissions/' + id)`, CLIENT_PERSISTENCE_PATTERNS))
      .toEqual(['nonGetApiHelper']);
  });

  it('CLIENT_PERSISTENCE_PATTERNS stays silent on a genuinely in-memory fixture', () => {
    const clean = `const { downtimes, chapters } = await apiGet(\`/api/downtime_submissions/story-tab?character_id=\${char._id}\`);`;
    expect(scan(clean, CLIENT_PERSISTENCE_PATTERNS)).toEqual([]);
  });

  it('extractBetween throws (fails loud) rather than silently scanning nothing when a marker goes missing', () => {
    expect(() => extractBetween('abc def ghi', 'zzz', 'ghi')).toThrow(/start marker not found/);
    expect(() => extractBetween('abc def ghi', 'abc', 'zzz')).toThrow(/end marker not found/);
  });

  // Codex external review (2026-09-19), Low: a duplicated marker previously made `indexOf`
  // silently select the wrong (or a truncated) region instead of failing loud.
  it('extractBetween throws (fails loud) when a marker is not unique, rather than silently picking the first occurrence', () => {
    expect(() => extractBetween('abc def abc xyz', 'abc', 'xyz')).toThrow(/start marker is not unique \(2 occurrences\)/);
    expect(() => extractBetween('abc def xyz ghi xyz', 'abc', 'xyz')).toThrow(/end marker is not unique \(2 occurrences\)/);
  });
});

describe('storytab4-readonly-guard: AC 1, server-side lexical write scan', () => {
  it('server/lib/story-downtime-fetch.js (the TM Story fetch helper, storytab.1) contains no Mongo write-shaped call or filesystem write', () => {
    const source = read('server/lib/story-downtime-fetch.js');
    expect(scan(source, MONGO_WRITE_PATTERNS)).toEqual([]);
    expect(scan(source, FILE_WRITE_PATTERNS)).toEqual([]);
  });

  it('the GET /story-tab route handler (server/routes/downtime.js) contains no Mongo write-shaped call or filesystem write', () => {
    const source = read('server/routes/downtime.js');
    const handler = extractBetween(
      source,
      `submissionsRouter.get('/story-tab',`,
      `submissionsRouter.get('/hold-flags',`,
    );
    expect(scan(handler, MONGO_WRITE_PATTERNS)).toEqual([]);
    expect(scan(handler, FILE_WRITE_PATTERNS)).toEqual([]);
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
  });

  // Codex external review (2026-09-19), Medium: the original scan stopped at the merge
  // function's own boundary and never followed the merged data into its two actual
  // callers, where a persistence regression would be just as real a violation of AC 4's
  // "anywhere" wording. Covers BOTH callers (renderLatestReport, the player-facing path,
  // and renderStoryTab, the ST-facing path with the chronicle-edit affordances) in one
  // scan, since both sit contiguously between the two exported functions either side of
  // them (renderLatestReport at line 52, renderChronicle at line 202).
  it('renderLatestReport and renderStoryTab (the two callers that receive the TM-Story-sourced merge) introduce no downstream persistence of their own', () => {
    const source = read('public/js/tabs/story-tab.js');
    const callers = extractBetween(
      source,
      'export async function renderLatestReport(',
      'export function renderChronicle(',
    );
    expect(scan(callers, CLIENT_PERSISTENCE_PATTERNS)).toEqual([]);
  });

  // Story storytab.5, AC 8: this guard's own Codex Pass 3a found and fixed exactly this
  // class of gap once already (the AC 4 scan stopped at the merge function's own boundary
  // until extended to follow data into its actual callers). storytab.5 adds TWO further
  // callers of fetchAndMergeStoryTabDowntimes — archive-tab.js's loadArchiveDowntimeData and
  // downtime-tab.js's loadPastOutcomesData — checked here rather than assumed covered.
  it('loadArchiveDowntimeData (archive-tab.js, storytab.5\'s first new caller) introduces no downstream persistence of the TM-Story-sourced merge', () => {
    const source = read('public/js/tabs/archive-tab.js');
    const fn = extractBetween(
      source,
      'export async function loadArchiveDowntimeData(char) {',
      'async function renderArchiveList() {',
    );
    expect(scan(fn, CLIENT_PERSISTENCE_PATTERNS)).toEqual([]);
    expect(fn).toMatch(/apiGet\(/);
  });

  it('loadPastOutcomesData (downtime-tab.js, storytab.5\'s second new caller) introduces no downstream persistence of the TM-Story-sourced merge', () => {
    const source = read('public/js/tabs/downtime-tab.js');
    const fn = extractBetween(
      source,
      'export async function loadPastOutcomesData(char) {',
      'export async function renderPastOutcomes(el, char) {',
    );
    expect(scan(fn, CLIENT_PERSISTENCE_PATTERNS)).toEqual([]);
    expect(fn).toMatch(/apiGet\(/);
  });
});
