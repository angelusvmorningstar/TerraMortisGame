/**
 * server/lib/write-command-monitor.js — Story storytab.4, AC 2.
 *
 * A runtime "zero write commands" assertion, mirroring TM Story's own
 * `server/canon-write-monitor.js` (Story 4-1, AC #7) — same shape, generalised: this repo
 * has no prior "read-only connection" precedent of its own, so this is TM Game's first
 * instance of the pattern, scoped to the ONE code path storytab.4 guards (the storytab.1
 * TM-Story fetch-and-render path), not a whole second connection/credential the way TM
 * Story's canon/wiki split is.
 *
 * Complements the lexical guard (storytab4-readonly-guard.test.js scans the SOURCE for
 * write-shaped calls) by watching the WIRE instead: it records every command the shared
 * MongoClient issues while attached, and asserts none is a write. Requires the client to
 * be constructed with `{ monitorCommands: true }` (see server/db.js) for `commandStarted`
 * to fire at all.
 */

// The MongoDB wire command names that mutate data or schema, exactly as they appear on a
// `commandStarted` event's `commandName` — NOT driver method names (insertOne/insertMany
// and bulkWrite() on a collection all issue `insert`/`update`/`delete`/`bulkWrite`). Two
// vectors that do not decompose to a CRUD name and so are listed explicitly: the
// client-level MongoClient.bulkWrite (server 8.0+, driver v7+, a single `bulkWrite` wire
// command), and `collMod`/`mapReduce`, which mutate schema or can persist output. The
// aggregate write vector ($out / $merge) surfaces on the wire as `aggregate` (a read
// name), so it is caught by pipeline inspection in classifyCommand below and recorded as
// the synthetic name `aggregateWrite`, a member of this set.
export const WRITE_COMMANDS = Object.freeze(new Set([
  'insert',
  'update',
  'delete',
  'findAndModify',
  'bulkWrite',
  'create',
  'createIndexes',
  'collMod',
  'mapReduce',
  'drop',
  'dropDatabase',
  'dropIndexes',
  'renameCollection',
  'aggregateWrite', // synthetic: an aggregate carrying an $out / $merge stage
]));

// Classify one commandStarted event into a recorded name. Almost always this is just
// event.commandName, but an aggregation that writes through an output stage ($out /
// $merge) reports commandName 'aggregate' — a read name — so the pipeline is inspected
// and the synthetic write name 'aggregateWrite' recorded instead.
function classifyCommand(event) {
  const name = event.commandName;
  const pipeline = event.command && event.command.pipeline;
  if (name === 'aggregate' && Array.isArray(pipeline)) {
    const writesOut = pipeline.some(
      (stage) => stage && (('$out' in stage) || ('$merge' in stage)),
    );
    if (writesOut) return 'aggregateWrite';
  }
  return name;
}

/**
 * Attach a command monitor to a MongoClient and return `{ commands, detach }`:
 * `commands` is a live array of the (classified) command names the client issues, in
 * order; `detach` removes the listener. The client must be created with
 * `{ monitorCommands: true }` for `commandStarted` to fire.
 *
 * `detach` is idempotent and MUST be called (in a `finally`/`afterEach`) whenever this is
 * attached to the shared production client (`getClient()`), which every other suite in
 * this repo's own vitest run also uses — an un-detached listener would keep recording
 * (and leak) every later test file's commands too, since the whole suite runs
 * `fileParallelism: false` / `maxWorkers: 1` against ONE real connection.
 */
export function attachCommandMonitor(client) {
  const commands = [];
  const listener = (event) => {
    commands.push(classifyCommand(event));
  };
  client.on('commandStarted', listener);
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    client.removeListener('commandStarted', listener);
  };
  return { commands, detach };
}

/**
 * Throw if any recorded command name is a write. Pass the array returned by
 * attachCommandMonitor (or any array of command names). Fail-loud: the error lists
 * exactly which write command(s) leaked, so a regression is a hard, named test failure
 * rather than a silent leak.
 */
export function assertNoWriteCommands(commandNames) {
  const writes = commandNames.filter((name) => WRITE_COMMANDS.has(name));
  if (writes.length) {
    throw new Error(
      `storytab.4 guard: write command(s) issued on a read-only path: ${writes.join(', ')}`,
    );
  }
}
