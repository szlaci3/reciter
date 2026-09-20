const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Dexie = require('./dexie.js');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
const L = require('./learning.js');
const { LibraryStore } = require('./library.js');
const fixture = () => JSON.parse(readFileSync(require.resolve('./fixtures/learning-package.json'), 'utf8'));
async function store(t) {
  const s = new LibraryStore(Dexie, 'learning-' + crypto.randomUUID(), { indexedDB, IDBKeyRange });
  t.after(() => s.db.delete()); await s.initialize('Existing private document.'); return s;
}
async function apply(s, data) { return s.applyPackage(await s.preparePackage(data)); }

test('shared JSON fixture imports idempotently without touching ordinary documents or progress', async t => {
  const s = await store(t), ordinary = (await s.list())[0];
  await apply(s, fixture());
  let p = await s.db.progress.get('listen-css-1');
  await s.saveProgress({ ...p, offset: 8, heardThrough: 8, eventId: 'played' });
  p = await s.db.progress.get('listen-css-1');
  await apply(s, fixture());
  assert.deepEqual(await s.db.documents.get(ordinary.id), ordinary);
  assert.deepEqual(await s.db.progress.get(p.occurrenceId), p);
  assert.equal((await s.list()).length, 2);
  assert.equal((await s.exportProgress()).events.length, 1);
  assert.ok(!JSON.stringify(await s.exportProgress()).includes('private document'));
});

test('changed text resets checkpoint; new occurrence of unchanged text starts independently', async t => {
  const s = await store(t), data = fixture(); await apply(s, data);
  await s.saveProgress({ ...(await s.db.progress.get('listen-css-1')), offset: 8, heardThrough: 8, eventId: 'played' });
  data.topics[0].text = 'A corrected example.'; data.topics[0].textHash = L.fingerprint(data.topics[0].text); data.topics[0].revision++;
  data.package.revision++; await apply(s, data);
  assert.equal((await s.db.progress.get('listen-css-1')).offset, 0);
  data.package.id = 'tomorrow'; data.package.date = '2026-09-22'; data.package.entries[0].occurrenceId = 'listen-css-2';
  await apply(s, data);
  assert.equal((await s.db.progress.toArray()).length, 2);
  assert.equal((await s.db.progress.get('listen-css-2')).completedAt, null);
});

test('stale packages, conflicting edits and stale reviews cannot overwrite stored data', async t => {
  const s = await store(t), data = fixture(); await apply(s, data);
  const plan = await s.preparePackage(data);
  let doc = await s.db.documents.get('css-example');
  await s.save({ ...doc, text: 'An important mobile edit.' });
  await assert.rejects(s.applyPackage(plan), /changed/);
  await assert.rejects(apply(s, data), /mobile edits/);
  assert.equal((await s.db.documents.get(doc.id)).text, 'An important mobile edit.');
  await s.db.documents.put(doc);
  data.package.revision = 3; data.topics[0].revision = 3; await apply(s, data);
  await assert.rejects(apply(s, fixture()), /stale/);
});

test('invalid package validation and transaction failures leave all tables unchanged', async t => {
  const s = await store(t), before = await s.learningSnapshot();
  const bad = fixture(); bad.topics[0].textHash = '00000000';
  await assert.rejects(s.preparePackage(bad), /invalid topic/);
  const plan = await s.preparePackage(fixture());
  const put = s.db.packages.put.bind(s.db.packages);
  s.db.packages.put = async () => { throw new Error('quota'); };
  await assert.rejects(s.applyPackage(plan), /quota/);
  s.db.packages.put = put;
  assert.deepEqual(await s.learningSnapshot(), before);
});

test('explicit Trash update and restoration retain topic identity', async t => {
  const s = await store(t), data = fixture(); await apply(s, data);
  const color = (await s.db.documents.get('css-example')).color;
  data.topics[0].revision++; data.topics[0].trashedAt = Date.now(); data.package.entries = []; data.package.revision++;
  await apply(s, data); assert.ok((await s.db.documents.get('css-example')).trashedAt);
  data.topics[0].revision++; data.topics[0].trashedAt = null; data.package.revision++;
  data.package.entries = fixture().package.entries; await apply(s, data);
  assert.equal((await s.db.documents.get('css-example')).color, color);
  assert.equal((await s.db.documents.get('css-example')).trashedAt, null);
});

test('backup round trip includes packages/progress; Keep both remaps references', async t => {
  const s = await store(t); await apply(s, fixture());
  const backup = await s.exportBackup(), other = await store(t);
  await other.applyImport(await other.prepareImport(backup, 'replace'));
  assert.deepEqual((await other.learningSnapshot()).packages, backup.packages);
  assert.deepEqual((await other.learningSnapshot()).progress, backup.progress);
  const doc = await other.db.documents.get('css-example'); await other.save({ ...doc, title: 'Local title' });
  await other.applyImport(await other.prepareImport(backup, 'add'), 'both');
  const snapshot = await other.learningSnapshot();
  const copy = snapshot.documents.find(d => d.title.endsWith('(imported copy)'));
  assert.ok(copy); assert.ok(!copy.learning);
  const pack = snapshot.packages.find(p => p.id !== backup.packages[0].id);
  assert.equal(pack.entries[0].topicId, copy.id);
  assert.equal(snapshot.progress.find(p => p.occurrenceId === pack.entries[0].occurrenceId).topicId, copy.id);
});

test('schema 2 database upgrades without losing documents', async t => {
  const name = 'old-' + crypto.randomUUID(); const old = new Dexie(name, { indexedDB, IDBKeyRange });
  old.version(2).stores({ documents: '&id,createdAt,updatedAt', meta: '&key' });
  await old.open(); await old.table('documents').put({ id: 'legacy', title: 'Legacy', text: 'Keep me', tags: [], trashedAt: null, color: '#31576e', revision: 1, createdAt: 1, updatedAt: 1 }); old.close();
  const s = new LibraryStore(Dexie, name, { indexedDB, IDBKeyRange }); t.after(() => s.db.delete());
  await s.initialize('No new migration'); assert.equal((await s.list())[0].text, 'Keep me');
  assert.equal(await s.db.packages.count(), 0);
});

test('completion requires full coverage and stale-version progress is rejected', async t => {
  const s = await store(t); await apply(s, fixture());
  const p = await s.db.progress.get('listen-css-1');
  await assert.rejects(s.saveProgress({ ...p, completedAt: p.updatedAt }), /invalid completion/);
  await assert.rejects(s.saveProgress({ ...p, textHash: '00000000' }), /changed/);
  await s.saveProgress({ ...p, offset: 20, heardThrough: 20, completedAt: p.updatedAt });
  assert.ok((await s.db.progress.get(p.occurrenceId)).completedAt);
});

test('fingerprints are shared with Python for non-BMP Unicode', () => assert.equal(L.fingerprint('Unicode 😀 café.'), 'bfee3438'));

test('a package tap cancels prior audio callbacks before unlocking the shared element', async () => {
  const { PackageQueue } = require('./package-ui.js'); const events = [];
  const queue = new PackageQueue({ editor: { store: { learningSnapshot: async () => ({ documents: [], progress: [] }) } },
    player: { stop() { events.push('stop'); } }, play() {}, unlock() { events.push('unlock'); } });
  await queue.start({ entries: [] });
  assert.deepEqual(events.slice(0, 2), ['stop', 'unlock']);
});
