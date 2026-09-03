// fix-oath-catalogue-casing-2026-09.mjs
// One-off: correct 14 Invictus Oath catalogue entries in tm_game.purchasable_powers to proper
// English title case (lowercase "of"/"the"), matching "Oath of the Hard Motherfucker" which was
// already correct. Ruled by Angelus 2026-09-03, party-mode Powers-tab planning thread.
//
// Run from TM Game/server:  node scripts/fix-oath-catalogue-casing-2026-09.mjs
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const FIXES = [
  ['Oath Of Abstinence', 'Oath of Abstinence'],
  ['Oath Of Action', 'Oath of Action'],
  ['Oath Of Fealty', 'Oath of Fealty'],
  ['Oath Of Matrimony', 'Oath of Matrimony'],
  ['Oath Of Office', 'Oath of Office'],
  ['Oath Of Penance', 'Oath of Penance'],
  ['Oath Of Serfdom', 'Oath of Serfdom'],
  ['Oath Of The Handshake Deal', 'Oath of the Handshake Deal'],
  ['Oath Of The Model Prisoner', 'Oath of the Model Prisoner'],
  ['Oath Of The Refugee', 'Oath of the Refugee'],
  ['Oath Of The Righteous Kill', 'Oath of the Righteous Kill'],
  ['Oath Of The Safe Word', 'Oath of the Safe Word'],
  ['Oath Of The Scapegoat', 'Oath of the Scapegoat'],
  ['Oath Of The True Knight', 'Oath of the True Knight'],
];

const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db('tm_game');

let totalMatched = 0, totalModified = 0;
for (const [oldName, newName] of FIXES) {
  const r = await db.collection('purchasable_powers').updateOne(
    { name: oldName, parent: 'Invictus Oath' },
    { $set: { name: newName } },
  );
  console.log(`${oldName} -> ${newName}  matched:${r.matchedCount} modified:${r.modifiedCount}`);
  totalMatched += r.matchedCount;
  totalModified += r.modifiedCount;
}
console.log(`\nTOTAL matched:${totalMatched} modified:${totalModified} (expected 14/14)`);

await client.close();
