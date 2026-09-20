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

async function backupFixture(t) {
  const source = store(t), editor = new LibraryEditor(source);
  await editor.initialize('Active document');
  await editor.edit({ tags: ['Science'] });
  const activeId = editor.active.id;
  await editor.navigate(); await editor.edit({ title: 'Trashed document', text: 'Keep this in Trash.', tags: ['History'] });
  await editor.organize('trash'); await editor.navigate(activeId);
  return source.exportBackup();
}

test('backup round-trip retains documents, Trash, identity, tags and selection, without private settings', async t => {
  const { parseBackup } = require('./library.js');
  const backup = await backupFixture(t), target = store(t);
  await target.initialize('Replace this');
  const plan = await target.prepareImport(parseBackup(JSON.stringify(backup)), 'replace');
  assert.equal((await target.list())[0].text, 'Replace this');
  await target.applyImport(plan);
  target.db.close(); const opened = await target.initialize('Do not migrate again');
  assert.equal(opened.selectedId, backup.selectedId);
  const exported = await target.exportBackup();
  const withoutRevision = doc => { const { revision, ...rest } = doc; return rest; };
  assert.deepEqual(exported.documents.map(withoutRevision), backup.documents.map(withoutRevision));
  assert.equal(exported.documents.filter(doc => doc.trashedAt).length, 1);
  assert.deepEqual(Object.keys(exported).sort(), ['documents', 'exportedAt', 'format', 'schemaVersion', 'selectedId', 'version']);
  const repeated = await target.prepareImport(backup, 'add');
  assert.equal(repeated.identical.length, 2); assert.equal(repeated.conflicts.length, 0);
});

test('invalid backups are rejected before any library or metadata changes', async t => {
  const { parseBackup, validateBackup } = require('./library.js');
  const backup = await backupFixture(t), target = store(t);
  await target.initialize('Original target');
  const original = await target.list(), meta = await target.db.meta.toArray();
  for (const modify of [
    b => { b.version = 999; }, b => { b.schemaVersion = 99; }, b => { b.format = 'other-app'; },
    b => { b.documents = {}; }, b => { b.documents.push(b.documents[0]); },
    b => { b.documents[0].id = ''; }, b => { b.documents[0].text = 42; },
    b => { b.documents[0].title = null; }, b => { b.documents[0].color = 'url(javascript:bad)'; },
    b => { b.documents[0].color = '#ffffff'; }, b => { b.documents[0].tags = ['tag', 'TAG']; },
    b => { b.documents[0].tags = [null]; }, b => { b.documents[0].revision = -1; },
    b => { b.documents[0].createdAt = Infinity; }, b => { b.documents[0].trashedAt = 'yesterday'; },
    b => { b.selectedId = 'missing'; }
  ]) {
    const broken = structuredClone(backup); modify(broken);
    await assert.rejects(target.prepareImport(broken, 'replace'), /Invalid backup/);
    assert.deepEqual(await target.list(), original); assert.deepEqual(await target.db.meta.toArray(), meta);
  }
  assert.throws(() => parseBackup('{broken JSON'), /not valid JSON/);
  assert.throws(() => parseBackup(' '.repeat(25 * 1024 * 1024 + 1)), /25 MiB/);
  assert.deepEqual(parseBackup('\uFEFF' + JSON.stringify(backup)), validateBackup(backup));
  const hostile = JSON.parse(JSON.stringify(backup));
  hostile.documents[0].__proto__ = { polluted: 'bad' };
  const clean = validateBackup(hostile);
  assert.equal(clean.documents[0].polluted, undefined); assert.equal({}.polluted, undefined);
});

test('add skips identical IDs, keeps both differing versions, and never overwrites existing documents', async t => {
  const s = store(t); await s.initialize('Existing');
  const backup = await s.exportBackup();
  const original = structuredClone(backup.documents[0]);
  const identicalPlan = await s.prepareImport(backup, 'add');
  assert.equal(identicalPlan.identical.length, 1);
  const identical = await s.applyImport(identicalPlan);
  assert.equal(identical.added, 0); assert.equal(identical.skipped, 1);
  const incoming = structuredClone(backup);
  incoming.documents[0].text = 'Incoming conflicting text'; incoming.documents[0].tags = ['Imported'];
  incoming.documents.push({ ...original, id: 'new-id', title: 'New incoming', tags: ['New'], trashedAt: Date.now() });
  const plan = await s.prepareImport(incoming, 'add');
  assert.equal(plan.conflicts.length, 1); assert.equal(plan.added.length, 1);
  const result = await s.applyImport(plan, 'both');
  assert.equal(result.added, 2); assert.equal(result.copies, 1);
  assert.deepEqual(await s.db.documents.get(original.id), original);
  const copy = result.documents.find(doc => doc.id !== original.id && doc.id !== 'new-id');
  assert.equal(copy.text, 'Incoming conflicting text'); assert.deepEqual(copy.tags, ['Imported']);
  assert.equal(copy.title, 'Existing (imported copy)'); assert.notEqual(copy.color, original.color);
  assert.equal(result.selectedId, original.id);
  assert.equal((await s.db.documents.get('new-id')).color, original.color);
  assert.ok((await s.db.documents.get('new-id')).trashedAt);
});

test('keep-existing policy skips conflicts, including an active versus Trash conflict', async t => {
  const s = store(t); await s.initialize('Local');
  const backup = await s.exportBackup(), original = backup.documents[0];
  backup.documents[0] = { ...original, trashedAt: Date.now() };
  const plan = await s.prepareImport(backup, 'add');
  assert.equal(plan.conflicts.length, 1);
  const result = await s.applyImport(plan, 'keep');
  assert.equal(result.added, 0); assert.equal(result.skipped, 1);
  assert.deepEqual(await s.list(), [original]);
});

test('empty replacement stays empty after reload and does not resurrect legacy text', async t => {
  const s = store(t); await s.initialize('Legacy');
  const backup = await s.exportBackup(); backup.documents = []; backup.selectedId = null;
  await s.applyImport(await s.prepareImport(backup, 'replace'));
  s.db.close(); const result = await s.initialize('Legacy');
  assert.deepEqual(result.documents, []); assert.equal(result.selectedId, undefined);
  assert.equal((await s.db.meta.get('initial-document-v1')).value, true);
});

test('replacement and additive failures roll back documents, selection and generation', async t => {
  const backup = await backupFixture(t), s = store(t); await s.initialize('Keep original');
  for (const mode of ['replace', 'add']) {
    const original = await s.list(), meta = await s.db.meta.toArray(), generation = s.generation;
    const plan = await s.prepareImport(backup, mode), put = s.db.meta.put.bind(s.db.meta);
    s.db.meta.put = async () => { throw new Error('Quota exceeded'); };
    await assert.rejects(s.applyImport(plan), /Quota exceeded/);
    s.db.meta.put = put;
    assert.deepEqual(await s.list(), original); assert.deepEqual(await s.db.meta.toArray(), meta);
    assert.equal(s.generation, generation);
  }
  await s.applyImport(await s.prepareImport(backup, 'replace'));
  assert.equal((await s.list()).length, 2);
});

test('changes in another tab after review invalidate both import modes', async t => {
  const s = store(t); await s.initialize('Local');
  const backup = await s.exportBackup();
  for (const mode of ['add', 'replace']) {
    const plan = await s.prepareImport(backup, mode);
    await s.save({ ...(await s.list())[0], text: 'New edits after review ' + mode });
    const current = await s.list();
    await assert.rejects(s.applyImport(plan), /changed since this review/);
    assert.deepEqual(await s.list(), current);
  }
});

test('a replacement invalidates older tabs even when imported IDs and revisions match', async t => {
  const name = 'replacement-tabs-' + crypto.randomUUID(), s = store(t, name), other = store(t, name);
  await s.initialize('Local'); await other.initialize('Unused');
  const stale = (await other.list())[0], backup = await s.exportBackup();
  backup.documents[0].text = 'Restored backup';
  await s.applyImport(await s.prepareImport(backup, 'replace'));
  await assert.rejects(other.save({ ...stale, text: 'Stale overwrite' }), /replaced in another tab/);
  await assert.rejects(other.create(), /replaced in another tab/);
  await assert.rejects(other.organize('trash', stale), /replaced in another tab/);
  await assert.rejects(s.save(stale), { name: 'ConflictError' });
  assert.equal((await s.list())[0].text, 'Restored backup');
  await other.initialize('Unused');
  await other.save({ ...(await other.list())[0], text: 'Fresh edits' });
  assert.equal((await s.list())[0].text, 'Fresh edits');
});

test('export flushes pending edits and transfer failures preserve the visible draft', async t => {
  const s = store(t), editor = new LibraryEditor(s); await editor.initialize('Local');
  const save = s.save.bind(s); let release;
  s.save = async draft => { await new Promise(resolve => { release = resolve; }); return save(draft); };
  const saving = editor.edit({ text: 'Latest draft' }), exporting = editor.exportBackup();
  release(); await saving; const backup = await exporting;
  assert.equal(backup.documents[0].text, 'Latest draft'); assert.equal(editor.busy, false);
  s.save = async () => { throw new Error('Save blocked'); };
  await editor.edit({ text: 'Unsaved draft' });
  await assert.rejects(editor.exportBackup(), /Save blocked/);
  await assert.rejects(editor.prepareImport(backup, 'replace'), /Save blocked/);
  assert.equal(editor.active.text, 'Unsaved draft'); assert.equal(editor.dirty, true);
  assert.equal(editor.busy, false);
});
