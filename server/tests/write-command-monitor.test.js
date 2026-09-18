/**
 * server/tests/write-command-monitor.test.js — Story storytab.4, AC 2 self-test.
 *
 * Proves the monitor helper records commandStarted events and that
 * assertNoWriteCommands actually FIRES on a write (discrimination) and passes on a
 * read-only workload, before it is trusted anywhere live. No real Mongo: an EventEmitter
 * stands in for the command-monitoring MongoClient (which is itself an EventEmitter),
 * same approach as TM Story's own canon-write-monitor.test.js this mirrors.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  attachCommandMonitor,
  assertNoWriteCommands,
  WRITE_COMMANDS,
} from '../lib/write-command-monitor.js';

describe('attachCommandMonitor', () => {
  it('records commandStarted command names in order', () => {
    const client = new EventEmitter();
    const { commands } = attachCommandMonitor(client);
    client.emit('commandStarted', { commandName: 'find' });
    client.emit('commandStarted', { commandName: 'aggregate' });
    client.emit('commandStarted', { commandName: 'ping' });
    expect(commands).toEqual(['find', 'aggregate', 'ping']);
  });

  it('detach removes the listener (no accumulation across tests) and is idempotent', () => {
    const client = new EventEmitter();
    const { commands, detach } = attachCommandMonitor(client);
    client.emit('commandStarted', { commandName: 'find' });
    expect(client.listenerCount('commandStarted')).toBe(1);
    detach();
    expect(client.listenerCount('commandStarted')).toBe(0);
    // after detach, further commands are NOT recorded.
    client.emit('commandStarted', { commandName: 'insert' });
    expect(commands).toEqual(['find']);
    // idempotent: a second detach is a harmless no-op.
    expect(() => detach()).not.toThrow();
    expect(client.listenerCount('commandStarted')).toBe(0);
  });
});

describe('assertNoWriteCommands', () => {
  it('passes for a read-only workload', () => {
    expect(() => assertNoWriteCommands(['find', 'findOne', 'count', 'aggregate', 'ping'])).not.toThrow();
  });

  it('(discrimination) THROWS on any write command, naming it', () => {
    expect(() => assertNoWriteCommands(['find', 'insert'])).toThrow(/write command\(s\) issued.*insert/);
    expect(() => assertNoWriteCommands(['update', 'delete'])).toThrow(/update, delete/);
  });

  it('end-to-end via the monitor catches a wire write', () => {
    const client = new EventEmitter();
    const { commands } = attachCommandMonitor(client);
    client.emit('commandStarted', { commandName: 'find' });
    client.emit('commandStarted', { commandName: 'insert' }); // a leak
    expect(() => assertNoWriteCommands(commands)).toThrow(/insert/);
  });

  it('a client-level bulkWrite wire command is caught (does not decompose to insert/update/delete)', () => {
    const client = new EventEmitter();
    const { commands } = attachCommandMonitor(client);
    client.emit('commandStarted', { commandName: 'find' });
    client.emit('commandStarted', { commandName: 'bulkWrite' });
    expect(() => assertNoWriteCommands(commands)).toThrow(/bulkWrite/);
  });

  it('an aggregate with an $out stage is caught as a write; a plain aggregate is not', () => {
    const client = new EventEmitter();
    const { commands } = attachCommandMonitor(client);
    client.emit('commandStarted', { commandName: 'aggregate', command: { pipeline: [{ $match: {} }] } });
    expect(() => assertNoWriteCommands(commands)).not.toThrow();
    client.emit('commandStarted', { commandName: 'aggregate', command: { pipeline: [{ $match: {} }, { $out: 'leak' }] } });
    expect(commands).toEqual(['aggregate', 'aggregateWrite']);
    expect(() => assertNoWriteCommands(commands)).toThrow(/aggregateWrite/);
  });

  it('an aggregate with a $merge stage is caught as a write', () => {
    const client = new EventEmitter();
    const { commands } = attachCommandMonitor(client);
    client.emit('commandStarted', { commandName: 'aggregate', command: { pipeline: [{ $merge: { into: 'leak' } }] } });
    expect(commands).toEqual(['aggregateWrite']);
    expect(() => assertNoWriteCommands(commands)).toThrow(/aggregateWrite/);
  });
});

describe('WRITE_COMMANDS', () => {
  it('covers the mutating wire commands and is frozen', () => {
    for (const cmd of ['insert', 'update', 'delete', 'findAndModify', 'bulkWrite',
      'collMod', 'mapReduce', 'drop', 'createIndexes', 'renameCollection']) {
      expect(WRITE_COMMANDS.has(cmd), `${cmd} must be treated as a write`).toBe(true);
    }
    // Reads are not writes. `aggregate` (the bare read name) is NOT a write — an
    // aggregate that writes is caught by pipeline inspection above and recorded as the
    // synthetic 'aggregateWrite', so the bare name stays a read.
    for (const cmd of ['find', 'aggregate', 'count', 'distinct', 'ping', 'getMore']) {
      expect(WRITE_COMMANDS.has(cmd), `${cmd} must NOT be treated as a write`).toBe(false);
    }
    expect(Object.isFrozen(WRITE_COMMANDS)).toBe(true);
  });
});
