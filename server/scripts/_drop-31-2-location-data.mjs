// _drop-31-2-location-data.mjs — Story 31-2 (TM Wiki), the deliberately SEPARATE,
// MANUAL final step of "copy, verify, cut over, then drop."
//
// ⚠ THIS IS THE DESTRUCTIVE STEP. Angelus's own action, ONLY, once he has
// personally confirmed the cutover works end to end against PRODUCTION (not
// just the dev copy the migration's own build-and-verify pass ran against).
// Never run this as part of any automated dev-story/code-review pass, and
// never bundle it with the copy or verify steps.
//
// What this does: drops `tm_suite.st_map_locations` and `tm_suite.locations`
// - and ONLY those two collections, nothing else in `tm_suite` - after
// re-confirming, live, that `tm_wiki`'s copies still match FIELD FOR FIELD (a
// second, independent verification pass, not a re-use of a stale result from
// earlier). If the counts, ids, OR any document's content disagree, it
// refuses and drops nothing.
//
// TWO REAL DEFECTS FOUND BY AN EXTERNAL REVIEW (2026-08-14), fixed here rather
// than shipped:
//   1. The first version of this re-verify compared only document COUNTS and
//      ID SETS, never field content - reproduced against a hermetic Mongo:
//      same ids, same counts, DIFFERENT field content in `tm_wiki` still
//      printed "Re-verify CLEAN". Fixed by a real field-by-field diff,
//      mirroring `TM Wiki/server/scripts/migrate-31-2-location-data.mjs`'s own
//      `diffDocuments`/`compareDocumentSets` (not imported cross-repo - this
//      is TM Suite's own script, so the equivalent logic is reimplemented
//      here, small enough that duplication is cheaper than a cross-repo
//      dependency for one ops script).
//   2. `dotenv/config`'s default `.env` resolution is CWD-relative, not
//      script-relative. Run from inside `TM Wiki`'s own directory (an easy
//      mistake - this whole story's development happened from there), it
//      silently loaded TM WIKI's `.env` (`MONGODB_WIKI_DB=tm_wiki_dev`)
//      instead of TM Suite's own (no override -> defaults to production
//      `tm_wiki`) - meaning the re-verify could pass against the DEV copy
//      while this script then drops the real, never-cut-over PRODUCTION
//      source. Fixed two ways: `.env` is now loaded from a path resolved
//      against THIS FILE's own location, never the caller's CWD; and the
//      resolved wiki database name is asserted to be EXACTLY `tm_wiki`
//      before `--write` proceeds at all - this script refuses to drop
//      anything if it is (even accidentally) pointed at `tm_wiki_dev` or any
//      other non-production name, because dropping the source based on a dev
//      copy matching is exactly the failure this script exists to prevent.
//
// WHY THIS IS ITS OWN SCRIPT, NOT A FLAG ON THE MIGRATION SCRIPT: the standing
// order (specs/deferred-work.md item 163, TM Wiki) is explicit - "copy,
// verify, cut over, then drop. Never delete the source first." Making the
// drop a separate, distinctly-named, always-manually-invoked script is what
// makes "never delete the source first" structurally true rather than a
// convention someone could bypass with one flag on a familiar command.
//
// Dry run by default.
//   node server/scripts/_drop-31-2-location-data.mjs           (dry run - report only, drops nothing)
//   node server/scripts/_drop-31-2-location-data.mjs --write   (drop, ONLY after a clean re-verify)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

// Script-relative, not CWD-relative - see defect 2 above.
const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(HERE, '..', '..', '.env') });

const WRITE = process.argv.includes('--write');
const COLLECTIONS = ['st_map_locations', 'locations'];

// The one thing standing between "verified the dev copy" and "dropped the
// only real copy": this script's entire safety model depends on comparing
// tm_suite against PRODUCTION tm_wiki. Refuse outright if the resolved
// target is anything else, rather than trusting whatever .env happened to
// load.
const WIKI_DB_NAME = process.env.MONGODB_WIKI_DB ?? 'tm_wiki';
if (WIKI_DB_NAME !== 'tm_wiki') {
  console.error(`REFUSING TO RUN: resolved wiki database is "${WIKI_DB_NAME}", not "tm_wiki".`);
  console.error('This script only ever compares against and protects PRODUCTION. If you intended');
  console.error('to test against a dev database, that is not what this script is for - nothing was');
  console.error('read or dropped.');
  process.exit(1);
}

// PURE. Structural equality that treats a Mongo ObjectId (or any BSON type
// exposing .equals()) correctly. Same shape as TM Wiki's own
// migrate-31-2-location-data.mjs; reimplemented here rather than imported
// across repos, for one small ops script.
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a === 'object' && typeof a.equals === 'function' && typeof b === 'object' && typeof b.equals === 'function') {
    try { return a.equals(b); } catch { return false; }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => valuesEqual(a[k], b[k]));
  }
  return false;
}

function diffDocuments(source, dest) {
  const keys = new Set([...Object.keys(source), ...Object.keys(dest)]);
  const diffs = [];
  for (const key of keys) {
    if (!valuesEqual(source[key], dest[key])) diffs.push(key);
  }
  return diffs;
}

const suite = new MongoClient(process.env.MONGODB_URI);
const wiki = new MongoClient(process.env.MONGODB_WIKI_URI ?? process.env.MONGODB_URI);
await suite.connect();
await wiki.connect();

const suiteDb = suite.db('tm_suite');
const wikiDb = wiki.db(WIKI_DB_NAME);

console.log(`Re-verifying tm_wiki ("${WIKI_DB_NAME}") matches tm_suite, live, right now, FIELD BY FIELD`);
console.log('(not trusting an earlier result, and not just counting ids)...\n');

let allClean = true;
for (const name of COLLECTIONS) {
  const [suiteDocs, wikiDocs] = await Promise.all([
    suiteDb.collection(name).find({}).toArray(),
    wikiDb.collection(name).find({}).toArray(),
  ]);
  const bySuite = new Map(suiteDocs.map((d) => [String(d._id), d]));
  const byWiki = new Map(wikiDocs.map((d) => [String(d._id), d]));
  const missing = [...bySuite.keys()].filter((id) => !byWiki.has(id));
  const mismatched = [];
  for (const [id, doc] of bySuite) {
    if (!byWiki.has(id)) continue;
    const diffs = diffDocuments(doc, byWiki.get(id));
    if (diffs.length) mismatched.push({ id, diffs });
  }
  console.log(`${name}: tm_suite=${suiteDocs.length} tm_wiki=${wikiDocs.length}`);
  if (missing.length) console.log(`  MISSING FROM tm_wiki: ${missing.length}`, missing);
  if (mismatched.length) {
    console.log(`  CONTENT MISMATCH: ${mismatched.length} document(s)`);
    for (const m of mismatched) console.log(`    ${m.id}: ${m.diffs.join(', ')}`);
  }
  if (!missing.length && !mismatched.length) console.log('  every document present in tm_wiki AND matches field for field.');
  if (suiteDocs.length !== wikiDocs.length || missing.length || mismatched.length) allClean = false;
}

if (!allClean) {
  console.error('\nREFUSING TO DROP: tm_wiki does not clearly match tm_suite right now. Re-run the migration');
  console.error('script (--write, then --verify) from TM Wiki first. Nothing was dropped.');
  await suite.close();
  await wiki.close();
  process.exit(1);
}

if (!WRITE) {
  console.log('\nRe-verify CLEAN. DRY RUN — nothing dropped. Re-run with --write to actually drop');
  console.log('tm_suite.st_map_locations and tm_suite.locations. THIS IS IRREVERSIBLE.');
  await suite.close();
  await wiki.close();
  process.exit(0);
}

console.log('\nRe-verify CLEAN. Dropping tm_suite collections now...');
for (const name of COLLECTIONS) {
  await suiteDb.collection(name).drop();
  console.log(`  dropped tm_suite.${name}`);
}
console.log('\nDone. st_map_locations and locations no longer exist in tm_suite.');

await suite.close();
await wiki.close();
