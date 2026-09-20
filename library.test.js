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

test('version-one upgrade preserves all documents, identity, selection and migration marker', async t => {
  const name = 'upgrade-' + crypto.randomUUID();
  const old = new Dexie(name, { indexedDB, IDBKeyRange });
  old.version(1).stores({ documents: '&id,createdAt,updatedAt', meta: '&key' });
  const docs = [
    { id: 'one', title: 'Old one', text: 'Keep all of this.', color: COLORS[0], createdAt: 123, updatedAt: 456, revision: 7 },
    { id: 'two', title: 'Old two', text: 'And this.', color: COLORS[1], createdAt: 234, updatedAt: 567, revision: 2 }
  ];
  await old.documents.bulkAdd(docs);
  await old.meta.bulkPut([{ key: 'selected', value: 'two' }, { key: 'initial-document-v1', value: true }]);
  old.close();
  const s = store(t, name), result = await s.initialize('Do not import this again.');
  assert.equal(result.selectedId, 'two');
  assert.deepEqual(result.documents, docs.map(doc => ({ ...doc, tags: [], trashedAt: null })));
  assert.equal((await s.db.meta.get('initial-document-v1')).value, true);
  assert.equal(s.db.verno, 2);
});

test('tags autosave, normalize duplicates, and survive reopening without altering identity', async t => {
  const { normalizeTags } = require('./library.js');
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Keep text.');
  const original = { ...editor.active };
  await editor.edit({ tags: normalizeTags(' Science , history, SCIENCE,, history, Deep space ') });
  s.db.close();
  const result = await s.initialize('Old copy');
  const doc = result.documents[0];
  assert.deepEqual(doc.tags, ['Science', 'history', 'Deep space']);
  for (const key of ['id', 'title', 'text', 'color', 'createdAt']) assert.equal(doc[key], original[key]);
});

test('search, topic filtering, sorting and Trash views do not mutate documents', () => {
  const { visibleDocuments } = require('./library.js');
  const docs = [
    { id: 'a', title: 'Zebra', text: 'Space travel', tags: ['Science'], createdAt: 1, updatedAt: 8 },
    { id: 'b', title: 'alpha', text: 'Ocean life', tags: ['Science', 'Nature'], createdAt: 2, updatedAt: 7 },
    { id: 'c', title: 'Beta', text: 'Space travel', tags: ['History'], createdAt: 3, updatedAt: 9, trashedAt: 10 }
  ];
  const original = structuredClone(docs), ids = options => visibleDocuments(docs, options).map(d => d.id);
  assert.deepEqual(ids({}), ['a', 'b']);
  assert.deepEqual(ids({ sort: 'newest' }), ['b', 'a']);
  assert.deepEqual(ids({ sort: 'title' }), ['b', 'a']);
  assert.deepEqual(ids({ sort: 'updated' }), ['a', 'b']);
  assert.deepEqual(ids({ search: 'SPACE science' }), ['a']);
  assert.deepEqual(ids({ search: 'ALPHA', tag: 'nature' }), ['b']);
  assert.deepEqual(ids({ search: 'travel', tag: 'History' }), []);
  assert.deepEqual(ids({ trash: true, search: 'travel', tag: 'history' }), ['c']);
  assert.deepEqual(docs, original);
});

test('duplicate waits for saves and creates independent content, tags and identity', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Original.');
  const id = editor.active.id;
  const save = s.save.bind(s); let release;
  s.save = async draft => { await new Promise(resolve => { release = resolve; }); return save(draft); };
  const saving = editor.edit({ title: 'Latest title', text: 'Latest text', tags: ['Science'] });
  const duplicating = editor.organize('duplicate');
  release(); await saving; assert.equal(await duplicating, true);
  const original = await s.db.documents.get(id), copy = editor.active;
  assert.notEqual(copy.id, id); assert.notEqual(copy.color, original.color);
  assert.equal(copy.title, 'Latest title (copy)'); assert.equal(copy.text, original.text);
  assert.deepEqual(copy.tags, ['Science']); assert.equal(copy.revision, 1);
  s.save = save;
  await editor.edit({ text: 'Independent copy', tags: ['Other'] });
  assert.deepEqual(await s.db.documents.get(id), original);
  assert.equal((await s.db.meta.get('selected')).value, copy.id);
});

test('Trash retains full contents, blocks edits, and restore preserves identity', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Keep me.');
  await editor.edit({ tags: ['Topic'] });
  const original = { ...editor.active };
  assert.equal(await editor.organize('trash'), true);
  assert.equal(editor.active, null);
  let doc = await s.db.documents.get(original.id);
  assert.ok(doc.trashedAt); assert.equal(doc.revision, original.revision + 1);
  await assert.rejects(s.save(doc), { name: 'ConflictError' });
  await assert.rejects(s.organize('duplicate', doc), /Restore/);
  await editor.navigate(original.id);
  assert.equal(await editor.edit({ text: 'Should not change' }), undefined);
  assert.equal(editor.active.text, original.text);
  assert.equal(await editor.organize('restore'), true);
  doc = editor.active;
  assert.equal(doc.trashedAt, null);
  for (const key of ['id', 'title', 'text', 'color', 'createdAt', 'tags']) assert.deepEqual(doc[key], original[key]);
  s.db.close();
  const result = await s.initialize('Old localStorage text');
  assert.equal(result.selectedId, doc.id); assert.deepEqual(result.documents, [doc]);
});

test('only Trash can be permanently deleted, and empty libraries never remigrate legacy text', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Legacy text'); const id = editor.active.id;
  await assert.rejects(s.organize('delete', editor.active), /Trash first/);
  assert.equal((await s.list()).length, 1);
  await editor.organize('trash');
  await editor.navigate(id); await editor.organize('delete');
  assert.equal(editor.active, null); assert.deepEqual(await s.list(), []);
  assert.equal((await s.db.meta.get('selected')).value, null);
  s.db.close(); await editor.initialize('Legacy text must not return');
  assert.equal(editor.active, null); assert.deepEqual(editor.documents, []);
  assert.equal(await editor.navigate(), true); assert.equal(editor.active.text, '');
});

test('stale tab cannot trash, restore or permanently delete a newer revision', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Original'); const stale = { ...editor.active };
  const newer = await s.save({ ...stale, text: 'Newer edits' });
  await assert.rejects(s.organize('trash', stale), { name: 'ConflictError' });
  await s.organize('trash', newer);
  const trashed = await s.db.documents.get(stale.id);
  await s.organize('restore', trashed);
  await assert.rejects(s.organize('delete', trashed), { name: 'ConflictError' });
  await assert.rejects(s.organize('restore', trashed), { name: 'ConflictError' });
  assert.equal((await s.db.documents.get(stale.id)).text, 'Newer edits');
});

test('failed saves prevent organization and keep the draft available for retry', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Original');
  const save = s.save.bind(s);
  s.save = async () => { throw new Error('Storage full'); };
  await editor.edit({ text: 'Unsaved important changes', tags: ['Unsaved tag'] });
  for (const action of ['duplicate', 'trash']) assert.equal(await editor.organize(action), false);
  assert.equal(editor.active.text, 'Unsaved important changes'); assert.equal(editor.dirty, true);
  assert.equal((await s.list())[0].trashedAt, null);
  s.save = save;
  assert.equal(await editor.organize('trash'), true);
  assert.equal((await s.list())[0].text, 'Unsaved important changes');
  assert.deepEqual((await s.list())[0].tags, ['Unsaved tag']);
});

test('failed organization transactions roll back document and selection changes together', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Original'); const id = editor.active.id;
  const put = s.db.meta.put.bind(s.db.meta);
  for (const action of ['duplicate', 'trash']) {
    s.db.meta.put = async () => { throw new Error('Write failed'); };
    assert.equal(await editor.organize(action), false);
    assert.equal(editor.active.id, id); assert.equal(editor.state, 'error');
    assert.equal((await s.list()).length, 1); assert.equal((await s.list())[0].trashedAt, null);
    assert.equal((await s.db.meta.get('selected')).value, id);
    s.db.meta.put = put;
  }
  await editor.organize('trash'); await editor.navigate(id);
  s.db.meta.put = async () => { throw new Error('Write failed'); };
  assert.equal(await editor.organize('delete'), false);
  assert.ok((await s.db.documents.get(id)).trashedAt);
  s.db.meta.put = put;
  assert.equal(await editor.organize('restore'), true);
});

test('duplication uses a different identity color even after the palette is filled', async t => {
  const s = store(t), editor = new LibraryEditor(s);
  await editor.initialize('Original');
  for (let i = 1; i < COLORS.length; i++) await editor.navigate();
  const color = editor.active.color;
  assert.equal(await editor.organize('duplicate'), true);
  assert.notEqual(editor.active.color, color);
});
