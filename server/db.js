import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client;
let db;

// Pure decision logic for the test-DB safety guard — extracted so it can be
// unit-tested without a real MongoDB connection.
//
// Vitest sets process.env.VITEST truthy in every worker. If we're running
// under vitest, the resolved DB name MUST end with `_test` — otherwise a
// regression in setup-env.js ordering (or an env override) would silently
// point a test run at production.
export function assertTestDbSafety(dbName, isVitest) {
  if (isVitest && !dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to connect: test context (VITEST) targeting non-test database '${dbName}'. ` +
        `Tests must use a *_test database — check tests/helpers/setup-env.js ordering.`
    );
  }
}

export async function connectDb() {
  if (db) return; // Already connected — idempotent for test suites sharing a process
  const dbName = process.env.MONGODB_DB || 'tm_game';
  assertTestDbSafety(dbName, !!process.env.VITEST);
  // Strip legacy ssl= param — not accepted by MongoDB driver v7
  const uri = config.MONGODB_URI.replace(/[&?]ssl=[^&]*/g, '');
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    tls: true,
    // Story storytab.4, AC 2: lets a test attach server/lib/write-command-monitor.js's
    // commandStarted listener to prove a code path (the storytab.1 TM-Story fetch-and-
    // render path) issues zero write commands. Query results and driver behaviour are
    // unchanged regardless of whether a listener is attached — but the option itself is
    // NOT free even with none attached (Codex external review, 2026-09-19: the driver
    // still timestamps and constructs/emits commandStarted/Succeeded/Failed events for
    // every command on every consumer of this shared client, it does not check listener
    // count first). That per-command event-emission overhead is negligible in practice,
    // not literally inert.
    monitorCommands: true,
  });
  await client.connect();
  db = client.db(dbName);
  console.log('MongoDB connected successfully');
}

export function getDb() {
  if (!db) throw new Error('Database not connected — call connectDb() first');
  return db;
}

export function getCollection(name) {
  return getDb().collection(name);
}

// issue-1143: needed to start a session for multi-document transactions
// (office-actions.js's atomic budget-claim + dedupe + write).
export function getClient() {
  if (!client) throw new Error('MongoDB client not connected — call connectDb() first');
  return client;
}

// Returns true if the DB connection is alive
export function isConnected() {
  try {
    return !!db;
  } catch {
    return false;
  }
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('MongoDB connection closed');
  }
}
