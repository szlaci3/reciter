const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const source = name => readFileSync(require.resolve('./' + name), 'utf8');
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('UI did not reach expected state');
}
async function page(t, { legacy = 'Legacy title.\n\nLegacy second passage.', beforeApp } = {}) {
  const dom = new JSDOM(source('index.html'), { url: 'http://reciter.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, spoken = [];
  const indexedDB = new IDBFactory();
  Object.assign(w, { indexedDB, IDBKeyRange, structuredClone, fetch: async () => { throw new Error('No PC configured'); } });
  let canceled = 0;
  w.speechSynthesis = { getVoices: () => [], addEventListener() {}, speak: u => spoken.push(u),
    cancel() { canceled++; }, pause() {}, resume() {} };
  w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.play = async function () {};
  w.localStorage.setItem('reciter-listening-v1', JSON.stringify({ text: legacy, source: 'browser' }));
  for (const name of ['dexie.js', 'library.js', 'library-ui.js', 'speech.js', 'edge-speech.js']) w.eval(source(name));
  const instances = [];
  const Store = w.ReciterLibrary.LibraryStore;
  w.ReciterLibrary.LibraryStore = class extends Store { constructor(...args) { super(...args); instances.push(this); } };
  beforeApp?.(w);
  w.eval(source('app.js'));
  t.after(() => { instances.forEach(s => s.db.close()); w.close(); });
  const $ = id => w.document.getElementById(id);
  await until(() => /Saved on this device|Library could not start/.test($('save-status').textContent));
  const edit = (id, text) => { $(id).value = text; $(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
  const saved = () => until(() => $('save-status').textContent === 'Saved on this device');
  return { w, $, edit, saved, spoken, store: instances[0], canceled: () => canceled };
}

test('library UI migrates text, creates and switches documents, and saves persistent identity', async t => {
  const p = await page(t);
  assert.equal(p.$('material').value, 'Legacy title.\n\nLegacy second passage.');
  assert.equal(p.$('document-title').value, 'Legacy title.');
  const first = p.w.document.querySelector('.document-card');
  const originalId = first.dataset.documentId, color = first.style.getPropertyValue('--document-color');
  p.$('new-document').click();
  await until(() => p.$('document-count').textContent === '2 documents' && !p.$('material').disabled);
  assert.equal(p.$('material').value, ''); assert.equal(p.$('play').disabled, true);
  p.edit('document-title', 'Second document'); p.edit('material', 'Listen to the second document.');
  await p.saved();
  const selectedId = p.w.document.querySelector('[aria-pressed=true]').dataset.documentId;
  assert.equal((await p.store.select(selectedId)).text, 'Listen to the second document.');
  p.w.document.querySelector(`[data-document-id="${originalId}"]`).click();
  await until(() => p.$('document-title').value === 'Legacy title.');
  assert.equal(p.$('material').value, 'Legacy title.\n\nLegacy second passage.');
  assert.equal(p.w.document.querySelector('[aria-pressed=true]').style.getPropertyValue('--document-color'), color);
  assert.equal(JSON.parse(p.w.localStorage.getItem('reciter-listening-v1')).text, 'Legacy title.\n\nLegacy second passage.');
});

test('renaming leaves speech running, editing text stops it, and selecting uses the chosen text', async t => {
  const p = await page(t);
  p.$('play').click(); assert.equal(p.spoken.at(-1).text, 'Legacy title.');
  const canceled = p.canceled();
  p.edit('document-title', 'Renamed while listening'); await p.saved();
  assert.equal(p.canceled(), canceled); assert.match(p.$('status').textContent, /^Speaking/);
  p.edit('material', 'Changed text.'); await p.saved();
  assert.ok(p.canceled() > canceled); assert.match(p.$('status').textContent, /^Ready/);
  p.$('play').click(); assert.equal(p.spoken.at(-1).text, 'Changed text.');
  p.$('new-document').click(); await until(() => p.$('document-title').value === 'Untitled document');
  assert.match(p.$('status').textContent, /^Ready/); assert.equal(p.$('play').disabled, true);
});

test('save failure remains visible, preserves edits, and prevents switching until retry', async t => {
  const p = await page(t);
  const original = p.store.save.bind(p.store);
  p.store.save = async () => { throw new Error('Quota exceeded'); };
  p.edit('material', 'Keep this unsaved draft.');
  await until(() => p.$('save-status').dataset.state === 'error');
  assert.equal(p.$('retry-save').hidden, false);
  p.$('new-document').click();
  await until(() => !p.$('new-document').disabled);
  assert.equal(p.$('document-count').textContent, '1 document');
  assert.equal(p.$('material').value, 'Keep this unsaved draft.');
  p.store.save = original; p.$('retry-save').click(); await p.saved();
  assert.equal((await p.store.list())[0].text, 'Keep this unsaved draft.');
});

test('blocked storage preserves the old text for listening and does not claim it is saved', async t => {
  const p = await page(t, { beforeApp(w) {
    w.ReciterLibrary.LibraryStore.prototype.initialize = async () => { throw new Error('Storage blocked'); };
  } });
  assert.match(p.$('save-status').textContent, /will not be saved/);
  assert.match(p.$('save-status').textContent, /opening browser storage.*Error: Storage blocked/);
  assert.equal(p.$('material').disabled, false); assert.equal(p.$('new-document').disabled, true);
  assert.equal(p.$('material').value, 'Legacy title.\n\nLegacy second passage.');
  p.$('play').click(); assert.equal(p.spoken.at(-1).text, 'Legacy title.');
});

test('document text and title are rendered as text, not HTML', async t => {
  const p = await page(t);
  p.edit('document-title', '<img src=x onerror=alert(1)>');
  p.edit('material', '<script>alert(1)</script>'); await p.saved();
  assert.equal(p.w.document.querySelectorAll('#document-list img, #document-list script').length, 0);
  assert.match(p.w.document.querySelector('.document-card strong').textContent, /<img/);
});

test('Retry repeats a failed document creation without losing the selected document', async t => {
  const p = await page(t);
  const original = p.store.create.bind(p.store);
  p.store.create = async () => { throw new Error('Temporary storage error'); };
  p.$('new-document').click();
  await until(() => p.$('save-status').dataset.state === 'error' && !p.$('new-document').disabled);
  assert.equal(p.$('document-count').textContent, '1 document');
  assert.equal(p.$('material').value, 'Legacy title.\n\nLegacy second passage.');
  p.store.create = original; p.$('retry-save').click();
  await until(() => p.$('document-count').textContent === '2 documents');
  assert.equal(p.$('document-title').value, 'Untitled document');
  assert.equal(p.$('material').value, '');
});

test('missing Dexie is identified as a script failure, not a blocked database', async t => {
  const p = await page(t, { beforeApp(w) {
    w.Dexie = undefined;
    w.fetch = async () => ({ status: 404, headers: { get: () => 'text/plain' } });
  } });
  assert.match(p.$('save-status').textContent, /loading library scripts.*dexie.js: HTTP 404/);
  assert.equal(p.$('material').value, 'Legacy title.\n\nLegacy second passage.');
  assert.equal(p.$('new-document').disabled, true);
  assert.equal(p.$('autosave-note').hidden, true);
});

test('startup errors display the actual browser error without removing persisted documents', async t => {
  const p = await page(t, { beforeApp(w) {
    const initialize = w.ReciterLibrary.LibraryStore.prototype.initialize;
    w.ReciterLibrary.LibraryStore.prototype.initialize = async function (text) {
      await initialize.call(this, text);
      throw new w.DOMException('Browser storage connection failed.', 'UnknownError');
    };
  } });
  assert.match(p.$('save-status').textContent, /UnknownError: Browser storage connection failed/);
  assert.equal((await p.store.list()).length, 1);
  assert.equal((await p.store.list())[0].text, 'Legacy title.\n\nLegacy second passage.');
});

test('dependency diagnostics distinguish a served script that failed to execute', async t => {
  const p = await page(t, { beforeApp(w) {
    w.Dexie = undefined;
    w.reciterScriptErrors = { 'dexie.js': 'SecurityError: Example browser restriction' };
    w.fetch = async () => ({ status: 200, headers: { get: () => 'text/javascript' } });
  } });
  assert.match(p.$('save-status').textContent, /dexie.js: HTTP 200, text\/javascript; SecurityError/);
  assert.equal(p.$('material').disabled, false);
});
