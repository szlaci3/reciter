const { test } = require('node:test');
const assert = require('node:assert/strict');
const Dexie = require('./dexie.js');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
const { COLORS, LibraryStore, LibraryEditor } = require('./library.js');

test('the shipped Dexie bundle parses using ES5 syntax', () => {
  const { parse } = require('acorn');
  const { readFileSync } = require('node:fs');
  parse(readFileSync(require.resolve('./dexie.js'), 'utf8'), { ecmaVersion: 5 });
});

function store(t, name = 'test-' + crypto.randomUUID()) {
  const result = new LibraryStore(Dexie, name, { indexedDB, IDBKeyRange });
  t.after(() => result.db.delete());
  return result;
}

test('migration preserves legacy text once and survives reopening with selection and colors', async t => {
  const s = store(t);
  const text = 'My old passage.\n\nKeep the second passage too.';
  const initial = await s.initialize(text);
  assert.equal(initial.documents.length, 1); assert.equal(initial.documents[0].text, text);
  const original = initial.documents[0];
  await s.initialize('Do not overwrite the original.');
  const created = await s.create();
  assert.notEqual(created.color, original.color);
  await s.save({ ...created, title: 'A new title', text: 'Saved material.' });
  s.db.close();
  const reopened = await s.initialize('Do not import this again.');
  assert.equal(reopened.documents.length, 2); assert.equal(reopened.selectedId, created.id);
  assert.deepEqual(reopened.documents.find(d => d.id === original.id), original);
  assert.equal(reopened.documents.find(d => d.id === created.id).color, created.color);
});

test('concurrent initializations cannot duplicate migrated content', async t => {
  const name = 'test-' + crypto.randomUUID();
  const a = store(t, name), b = new LibraryStore(Dexie, name, { indexedDB, IDBKeyRange });
  t.after(() => b.db.close());
  await Promise.all([a.initialize('Original.'), b.initialize('Original.')]);
  assert.equal((await a.list()).length, 1);
});

test('empty legacy text stays empty, and creation does not replace existing content', async t => {
  const s = store(t); const initial = await s.initialize('');
  const first = initial.documents[0]; assert.equal(first.text, '');
  const second = await s.create();
  assert.notEqual(second.id, first.id); assert.equal(second.title, 'Untitled document');
  assert.equal((await s.list()).length, 2);
});

test('rapid edits serialize saves and retain the latest draft when switching documents', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Original text');
  const firstId = editor.active.id;
  const save = s.save.bind(s); let release, first = true;
  s.save = async draft => {
    if (first) { first = false; await new Promise(r => { release = r; }); }
    return save(draft);
  };
  const saving = editor.edit({ text: 'Intermediate' });
  editor.edit({ text: 'Latest text' }); editor.edit({ title: 'Latest title' });
  const switching = editor.navigate();
  assert.equal(editor.busy, true); release(); await saving;
  assert.equal(await switching, true);
  assert.notEqual(editor.active.id, firstId);
  const persisted = await s.db.documents.get(firstId);
  assert.equal(persisted.text, 'Latest text'); assert.equal(persisted.title, 'Latest title');
  assert.equal(editor.dirty, false);
  await editor.navigate(firstId); assert.equal(editor.active.text, 'Latest text');
});

test('failed saves keep the draft and block switching until retry succeeds', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Original'); const id = editor.active.id;
  const save = s.save.bind(s);
  s.save = async () => { throw new Error('Quota exceeded'); };
  assert.equal(await editor.edit({ text: 'Unsaved changes' }), false);
  assert.equal(editor.state, 'error'); assert.equal(editor.dirty, true);
  assert.equal(await editor.navigate(), false);
  assert.equal(editor.active.id, id); assert.equal(editor.active.text, 'Unsaved changes');
  assert.equal((await s.list()).length, 1);
  s.save = save; assert.equal(await editor.flush(), true);
  assert.equal(editor.state, 'saved'); assert.equal(editor.dirty, false);
  assert.equal((await s.select(id)).text, 'Unsaved changes');
});

test('stale edits in another tab cannot silently overwrite a document', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Original');
  await s.save({ ...editor.active, text: 'Changed in other tab' });
  assert.equal(await editor.edit({ text: 'My local draft' }), false);
  assert.equal(editor.error.name, 'ConflictError');
  assert.equal(editor.active.text, 'My local draft');
  assert.equal((await s.select(editor.active.id)).text, 'Changed in other tab');
});

test('renames preserve identity, color, text, and creation time', async t => {
  const s = store(t); const { documents: [original] } = await s.initialize('Original text');
  const edited = await s.save({ ...original, title: 'Renamed', color: '#ffffff' });
  assert.equal(edited.title, 'Renamed'); assert.equal(edited.id, original.id);
  assert.equal(edited.color, original.color); assert.equal(edited.text, original.text);
  assert.equal(edited.createdAt, original.createdAt);
});

test('identity palette supports white text and avoids repeats until all colors are used', async t => {
  function luminance(hex) {
    const channels = hex.match(/[\da-f]{2}/gi).map(value => parseInt(value, 16) / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  }
  for (const color of COLORS) assert.ok(1.05 / (luminance(color) + .05) >= 4.5, color);
  const s = store(t); await s.initialize('First');
  for (let i = 1; i < COLORS.length; i++) await s.create();
  assert.equal(new Set((await s.list()).map(doc => doc.color)).size, COLORS.length);
});
