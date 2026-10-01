/**
 * TM Admin Story tm-admin.10.5, Task 4 (AC4), TM Game server side: the character write paths
 * (POST /wizard, POST /, PUT /:id) silently strip any trait-level `bonus` key from the incoming body
 * BEFORE validation, so a stale client never fails and `bonus` never reaches the database.
 *
 * Ruled by Angelus 2026-10-01 ("strip silently", not "reject with a 400").
 *
 * No database: `../db.js` is mocked with recording in-memory collections, so the assertions read the
 * exact document handed to insertOne and the exact `$set` handed to findOneAndUpdate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ObjectId } from 'mongodb';

vi.mock('../db.js', () => ({ getCollection: vi.fn() }));

import { getCollection } from '../db.js';
import charactersRouter from '../routes/characters.js';

function fakeCollection(initial = []) {
  const docs = initial.map((d) => ({ ...d }));
  const calls = { insertOne: [], findOneAndUpdate: [], updateOne: [], insertMany: [] };
  const match = (d, q) => Object.entries(q || {}).every(([k, v]) => String(d[k]) === String(v));
  return {
    docs,
    calls,
    find(q = {}) { const r = docs.filter((d) => match(d, q)); return { toArray: async () => r, sort() { return this; } }; },
    async findOne(q = {}) { return docs.find((d) => match(d, q)) || null; },
    async insertOne(doc) {
      calls.insertOne.push(JSON.parse(JSON.stringify(doc)));
      const _id = new ObjectId();
      docs.push({ ...doc, _id });
      return { insertedId: _id };
    },
    async insertMany(arr) { calls.insertMany.push(arr); return { insertedCount: arr.length }; },
    async updateOne(q, u) { calls.updateOne.push([q, u]); return { matchedCount: 1 }; },
    async findOneAndUpdate(q, update) {
      calls.findOneAndUpdate.push(JSON.parse(JSON.stringify(update)));
      const i = docs.findIndex((d) => match(d, q));
      if (i === -1) return null;
      docs[i] = { ...docs[i], ...(update.$set || {}) };
      return docs[i];
    },
  };
}

function mockCollections(characters = []) {
  const cols = {
    characters: fakeCollection(characters),
    players: fakeCollection([{ _id: 'p-player-001', character_ids: [] }]),
    bloodlines: fakeCollection([]),
    equipment_catalogue: fakeCollection([]),
    xp_ledger: fakeCollection([]),
    write_once_violations: fakeCollection([]),
  };
  getCollection.mockImplementation((name) => {
    if (!cols[name]) throw new Error(`unexpected collection requested: ${name}`);
    return cols[name];
  });
  return cols;
}

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/characters', charactersRouter);
  return app;
}
const ST = { id: 'st', role: 'st', player_id: 'p-st-001', character_ids: [] };
const PLAYER = { id: 'pl', role: 'player', player_id: 'p-player-001', character_ids: [] };

/** Every path whose last key is literally `bonus`. */
function bonusPaths(obj, prefix = '') {
  const out = [];
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (k === 'bonus') out.push(p);
    out.push(...bonusPaths(v, p));
  }
  return out;
}

const ATTRS = ['Intelligence', 'Wits', 'Resolve', 'Strength', 'Dexterity', 'Stamina', 'Presence', 'Manipulation', 'Composure'];
// The full (POST) schema requires all nine attributes once `attributes` is present.
const traitsWith = (attrBonus, meritBonus) => ({
  attributes: Object.fromEntries(ATTRS.map((a) => [a, a === 'Wits' ? { dots: 2, bonus: attrBonus, cp: 1, xp: 0 } : { dots: 1, bonus: attrBonus }])),
  skills: { Brawl: { dots: 1, bonus: attrBonus, specs: [], nine_again: false } },
  disciplines: { Majesty: { dots: 1, bonus: attrBonus } },
  merits: [{ category: 'general', name: 'Resources', rating: 1, cp: 1, xp: 0, bonus: meritBonus }],
});

describe('10.5 TM Game character write paths strip a trait bonus before validation', () => {
  // Braces matter: a function returned from beforeEach is run by vitest as a teardown.
  beforeEach(() => { getCollection.mockReset(); });

  describe('PUT /:id', () => {
    const stored = () => ({ _id: new ObjectId(), name: 'Carver', clan: 'Mekhet', bloodline: null });

    it('accepts bonus: 0 and the stored $set has no bonus', async () => {
      const c = stored();
      const cols = mockCollections([c]);
      const res = await request(buildApp(ST)).put(`/api/characters/${c._id}`).send({ concept: 'Archivist', ...traitsWith(0, 0) });
      expect(res.status).toBe(200);
      const [update] = cols.characters.calls.findOneAndUpdate;
      expect(bonusPaths(update.$set)).toEqual([]);
      expect(update.$set.attributes.Wits).toEqual({ dots: 2, cp: 1, xp: 0 });
      expect(update.$set.merits[0]).toMatchObject({ name: 'Resources', rating: 1 });
      expect(update.$set.concept).toBe('Archivist');
    });

    it('a NONZERO bonus is stripped too, never persisted', async () => {
      const c = stored();
      const cols = mockCollections([c]);
      const res = await request(buildApp(ST)).put(`/api/characters/${c._id}`).send(traitsWith(3, 2));
      expect(res.status).toBe(200);
      expect(bonusPaths(cols.characters.calls.findOneAndUpdate[0].$set)).toEqual([]);
      expect(bonusPaths(cols.characters.docs[0])).toEqual([]);
    });

    it('a body with no bonus is saved unchanged', async () => {
      const c = stored();
      const cols = mockCollections([c]);
      const body = { concept: 'Archivist', attributes: { Wits: { dots: 2, cp: 1, xp: 0 } }, merits: [{ category: 'general', name: 'Resources', rating: 1 }] };
      const res = await request(buildApp(ST)).put(`/api/characters/${c._id}`).send(body);
      expect(res.status).toBe(200);
      expect(cols.characters.calls.findOneAndUpdate[0].$set).toEqual(body);
    });

    it('odd trait shapes do not crash the strip (validation still owns rejecting them)', async () => {
      const c = stored();
      mockCollections([c]);
      const res = await request(buildApp(ST)).put(`/api/characters/${c._id}`).send({ attributes: null, skills: ['Brawl'], merits: [null, 'x'] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('a negative bonus (which the schema would reject today) is stripped rather than 400ing', async () => {
      const c = stored();
      const cols = mockCollections([c]);
      const res = await request(buildApp(ST)).put(`/api/characters/${c._id}`).send({ attributes: { Wits: { dots: 2, bonus: -1 } } });
      expect(res.status).toBe(200);
      expect(cols.characters.calls.findOneAndUpdate[0].$set.attributes.Wits).toEqual({ dots: 2 });
    });
  });

  describe('POST /', () => {
    it('accepts bonus: 0 and a nonzero bonus, and the inserted document has none', async () => {
      const cols = mockCollections();
      const app = buildApp(ST);
      const zero = await request(app).post('/api/characters').send({ name: 'New One', ...traitsWith(0, 0) });
      expect(zero.status).toBe(201);
      const nonzero = await request(app).post('/api/characters').send({ name: 'New Two', ...traitsWith(2, 4) });
      expect(nonzero.status).toBe(201);
      expect(cols.characters.calls.insertOne).toHaveLength(2);
      for (const doc of cols.characters.calls.insertOne) expect(bonusPaths(doc)).toEqual([]);
      expect(cols.characters.calls.insertOne[0].attributes.Wits).toEqual({ dots: 2, cp: 1, xp: 0 });
    });
  });

  describe('POST /wizard', () => {
    it('accepts bonus: 0 and the inserted document has none', async () => {
      const cols = mockCollections();
      const res = await request(buildApp(PLAYER)).post('/api/characters/wizard').send({ name: 'Wiz', ...traitsWith(0, 1) });
      expect(res.status).toBe(201);
      expect(cols.characters.calls.insertOne).toHaveLength(1);
      expect(bonusPaths(cols.characters.calls.insertOne[0])).toEqual([]);
    });
  });

  it('the strip is wired after stripEphemeral and before validation on all three routes', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../routes/characters.js', import.meta.url), 'utf8');
    for (const route of [/router\.post\('\/wizard'[^\n]*/, /router\.post\('\/'[^\n]*/, /router\.put\('\/:id'[^\n]*/]) {
      const line = route.exec(src)[0];
      expect(line).toMatch(/stripEphemeral, stripTraitBonus, validateCharacter(Partial)?,/);
    }
  });
});
