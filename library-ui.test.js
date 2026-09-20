const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const source = name => readFileSync(require.resolve('./' + name), 'utf8');
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('UI did not reach expected state');
}
async function page(t, { legacy = 'Legacy title.\n\nLegacy second passage.', beforeApp, database } = {}) {
  const dom = new JSDOM(source('index.html'), { url: 'http://reciter.test', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, spoken = [];
  const indexedDB = database || new IDBFactory();
  Object.assign(w, { indexedDB, IDBKeyRange, structuredClone, fetch: async () => { throw new Error('No PC configured'); } });
  let canceled = 0;
  w.speechSynthesis = { getVoices: () => [], addEventListener() {}, speak: u => spoken.push(u),
    cancel() { canceled++; }, pause() {}, resume() {} };
  w.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.play = async function () {};
  w.localStorage.setItem('reciter-listening-v1', JSON.stringify({ text: legacy, source: 'browser' }));
  for (const name of ['dexie.js', 'learning.js', 'library.js', 'library-ui.js', 'speech.js', 'edge-speech.js', 'package-ui.js']) w.eval(source(name));
  const instances = [];
  const Store = w.ReciterLibrary.LibraryStore;
  w.ReciterLibrary.LibraryStore = class extends Store { constructor(...args) { super(...args); instances.push(this); } };
  beforeApp?.(w);
  w.eval(source('app.js'));
  t.after(() => { instances.forEach(s => s.db.close()); w.close(); });
  const $ = id => w.document.getElementById(id);
  await until(() => /Saved on this device|Library could not start|Choose or create a document/.test($('save-status').textContent));
  if (/Saved on this device/.test($('save-status').textContent) && $('material').value.trim()) await until(() => !$('play').disabled);
  if (!/Library could not start/.test($('save-status').textContent)) await until(() => $('learning-section').dataset.ready === 'true');
  const edit = (id, text) => { $(id).value = text; $(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
  const saved = () => until(() => $('save-status').textContent === 'Saved on this device');
  return { w, $, edit, saved, spoken, store: instances[0], database: indexedDB, canceled: () => canceled };
}

test('Automatic Play speaks while connecting; Connect preserves playback and Phone only cancels the wake', async t => {
  const requests = [];
  const p = await page(t, { beforeApp(w) {
    w.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
  } });
  p.edit('pc-url', 'http://speech.test'); p.edit('pc-key', 'test');
  p.$('source').value = 'auto'; p.$('source').dispatchEvent(new p.w.Event('change'));
  p.$('play').click();
  assert.equal(p.spoken.length, 1); assert.match(p.$('connection').textContent, /waking/);
  assert.match(requests[0].url, /api\/voices$/);
  const canceled = p.canceled();
  p.$('connect').click();
  assert.equal(p.canceled(), canceled); assert.equal(p.spoken.length, 1);
  assert.equal(requests[0].options.signal.aborted, true);
  p.$('source').value = 'browser'; p.$('source').dispatchEvent(new p.w.Event('change'));
  assert.equal(requests[1].options.signal.aborted, true);
  const status = p.$('connection').textContent;
  for (const request of requests) request.resolve({ ok: true, json: async () => [
    { name: 'en-GB-SoniaNeural', locale: 'en-GB', gender: 'Female' }
  ] });
  await new Promise(setImmediate);
  assert.equal(p.$('connection').textContent, status);
  assert.equal(p.$('edge-voice').options.length, 1);
  p.$('connect').click(); p.$('play').click();
  assert.equal(requests.length, 2); assert.equal(p.spoken.length, 2);
});

test('cloud access key survives session restore and input without truncation or persistent export', async t => {
  const key = 'AbCd_0123456789-xyz'.repeat(3);
  const p = await page(t, { beforeApp(w) { w.sessionStorage.setItem('reciter-pc-key', key); } });
  assert.equal(p.$('pc-key').value, key);
  assert.equal(p.$('pc-key').type, 'password');
  p.edit('pc-key', key + '_NEW');
  assert.equal(p.$('pc-key').value, key + '_NEW');
  assert.equal(p.w.sessionStorage.getItem('reciter-pc-key'), key + '_NEW');
  assert.ok(!p.w.localStorage.getItem('reciter-listening-v1').includes(key));
});

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
    w.fetch = async () => ({ status: 404, headers: { get: () => 'text/plain' }, text: async () => 'Not found' });
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
    w.fetch = async () => ({ status: 200, headers: { get: () => 'text/javascript' }, text: async () => source('dexie.js') });
  } });
  assert.match(p.$('save-status').textContent, /dexie.js: HTTP 200, text\/javascript; SecurityError/);
  assert.equal(p.$('material').disabled, false);
});

test('dependency diagnostics capture browser location and recheck the versioned source', async t => {
  const p = await page(t, { beforeApp(w) {
    w.Dexie = undefined;
    w.eval(w.document.querySelector('script:not([src])').textContent);
    w.dispatchEvent(new w.ErrorEvent('error', {
      filename: 'http://reciter.test/dexie.js?v=4.4.6-diag2',
      message: "SyntaxError: Unexpected keyword 'function'", lineno: 18, colno: 10
    }));
    w.fetch = async (url, options) => {
      assert.equal(url, 'http://reciter.test/dexie.js?v=4.4.6-diag2');
      assert.equal(options.cache, 'no-store');
      // Checkout line endings must not cause a false mismatch.
      return { status: 200, headers: { get: () => 'text/javascript' },
        text: async () => source('dexie.js').replace(/\r?\n/g, '\r\n') };
    };
  } });
  const message = p.$('save-status').textContent;
  assert.match(message, /at line 18:10/);
  assert.match(message, /recheck matches bundled source/);
  assert.match(message, /source near error:.*function/);
  assert.equal(p.store, undefined);
});

test('dependency diagnostics flag changed contents without executing the fetched source', async t => {
  const p = await page(t, { beforeApp(w) {
    w.Dexie = undefined;
    w.fetch = async () => ({ status: 200, headers: { get: () => 'text/javascript' },
      text: async () => 'window.unexpectedExecution = true;' });
  } });
  assert.match(p.$('save-status').textContent, /DIFFERS from bundled source/);
  assert.equal(p.w.unexpectedExecution, undefined);
  assert.equal(p.store, undefined);
  assert.equal(JSON.parse(p.w.localStorage.getItem('reciter-listening-v1')).text,
    'Legacy title.\n\nLegacy second passage.');
});

function choose(p, id, value) {
  p.$(id).value = value;
  p.$(id).dispatchEvent(new p.w.Event('change', { bubbles: true }));
}
const cardNames = p => Array.from(p.w.document.querySelectorAll('.document-card strong'), node => node.textContent);

test('search, sorting and topic filtering keep selected text and playback intact', async t => {
  const p = await page(t);
  p.edit('document-title', 'Zebra'); p.edit('document-tags', 'Science, Space, SCIENCE'); await p.saved();
  const firstId = p.w.document.querySelector('.document-card').dataset.documentId;
  p.$('new-document').click(); await until(() => p.$('document-title').value === 'Untitled document');
  p.edit('document-title', 'Alpha'); p.edit('material', 'Ocean life'); p.edit('document-tags', 'Nature'); await p.saved();
  p.$('play').click(); const canceled = p.canceled();
  choose(p, 'library-sort', 'title'); assert.deepEqual(cardNames(p), ['Alpha', 'Zebra']);
  p.edit('library-search', 'legacy space'); assert.deepEqual(cardNames(p), ['Zebra']);
  assert.equal(p.$('document-title').value, 'Alpha'); assert.equal(p.$('material').value, 'Ocean life');
  assert.equal(p.$('selection-note').hidden, false);
  assert.equal(p.canceled(), canceled);
  assert.equal(p.w.document.querySelector('[aria-pressed=true]'), null);
  p.edit('library-search', ''); choose(p, 'library-tag', 'science');
  assert.deepEqual(cardNames(p), ['Zebra']);
  p.w.document.querySelector('.document-card').click(); await until(() => p.$('document-title').value === 'Zebra');
  assert.equal(p.w.document.querySelector('[aria-pressed=true]').dataset.documentId, firstId);
  assert.equal(p.$('document-tags').value, 'Science, Space');
  assert.equal(p.$('selection-note').hidden, true);
  p.edit('library-search', 'nothing matches');
  assert.match(p.$('library-empty').textContent, /No documents match/);
  assert.equal(cardNames(p).length, 0);
});

test('tag edits preserve playback and render tag markup as text', async t => {
  const p = await page(t);
  p.$('play').click(); const canceled = p.canceled();
  p.edit('document-tags', '<img src=x onerror=alert(1)>, Science'); await p.saved();
  assert.equal(p.canceled(), canceled);
  assert.equal(p.w.document.querySelector('#document-list img'), null);
  assert.match(p.w.document.querySelector('.document-tags').textContent, /<img/);
  assert.deepEqual(Array.from((await p.store.list())[0].tags), ['<img src=x onerror=alert(1)>', 'Science']);
});

test('duplicate opens the saved copy and clears filters so the new selection is visible', async t => {
  const p = await page(t);
  p.edit('document-tags', 'History'); await p.saved();
  const first = (await p.store.list())[0];
  p.edit('library-search', 'no matches');
  p.$('duplicate-document').click();
  await until(() => p.$('document-title').value === 'Legacy title. (copy)' && !p.$('duplicate-document').disabled);
  assert.equal(p.$('library-search').value, '');
  const copy = (await p.store.list()).find(doc => doc.id !== first.id);
  assert.equal(copy.text, first.text); assert.deepEqual(copy.tags, first.tags);
  assert.notEqual(copy.color, first.color);
  assert.equal(p.w.document.querySelector('[aria-pressed=true]').dataset.documentId, copy.id);
});

test('Trash is read-only, can restore identity, and permanent deletion requires confirmation', async t => {
  const p = await page(t);
  const first = (await p.store.list())[0];
  p.$('play').click(); const canceled = p.canceled();
  p.$('trash-document').click(); await until(() => p.$('editing-document').textContent === 'No document selected');
  assert.ok(p.canceled() > canceled);
  assert.equal(p.$('material').value, ''); assert.equal(p.$('play').disabled, true);
  assert.equal(p.$('material').disabled, true);
  assert.match(p.$('library-empty').textContent, /Your library is empty/);
  assert.match(p.$('library-view').options[1].textContent, /Trash \(1\)/);
  choose(p, 'library-view', 'trash'); p.w.document.querySelector('.document-card').click();
  await until(() => !p.$('restore-document').disabled);
  assert.equal(p.$('trash-note').hidden, false);
  assert.equal(p.$('document-title').readOnly, true); assert.equal(p.$('document-tags').readOnly, true);
  assert.equal(p.$('material').readOnly, true); assert.equal(p.$('material').value, first.text);
  await until(() => /^Speaking/.test(p.$('status').textContent));
  assert.equal(p.$('play').disabled, true);
  p.$('restore-document').click(); await until(() => p.$('library-view').value === 'library');
  assert.equal(p.$('material').disabled, false);
  assert.equal(p.w.document.querySelector('[aria-pressed=true]').dataset.documentId, first.id);
  assert.equal(p.w.document.querySelector('.document-card').style.getPropertyValue('--document-color'), first.color);
  p.$('trash-document').click(); await until(() => p.$('editing-document').textContent === 'No document selected');
  choose(p, 'library-view', 'trash'); p.w.document.querySelector('.document-card').click();
  await until(() => !p.$('delete-document').disabled);
  let prompts = [];
  p.w.confirm = message => { prompts.push(message); return false; };
  p.$('delete-document').click();
  assert.equal((await p.store.list()).length, 1);
  assert.match(prompts[0], /Legacy title\..*cannot be undone/);
  p.w.confirm = () => true; p.$('delete-document').click();
  await until(() => p.$('editing-document').textContent === 'No document selected');
  assert.equal((await p.store.list()).length, 0);
  assert.equal(p.$('library-empty').textContent, 'Trash is empty.');
  assert.equal(JSON.parse(p.w.localStorage.getItem('reciter-listening-v1')).text, first.text);
  p.$('new-document').click(); await until(() => p.$('document-title').value === 'Untitled document');
  assert.equal(p.$('library-view').value, 'library'); assert.equal(p.$('material').value, '');
});

test('failed permanent deletion preserves Trash and retry requests confirmation again', async t => {
  const p = await page(t);
  p.$('trash-document').click(); await until(() => p.$('editing-document').textContent === 'No document selected');
  choose(p, 'library-view', 'trash'); p.w.document.querySelector('.document-card').click();
  await until(() => !p.$('delete-document').disabled);
  const organize = p.store.organize.bind(p.store);
  p.store.organize = async () => { throw new Error('Temporary failure'); };
  let confirmations = 0; p.w.confirm = () => { confirmations++; return true; };
  p.$('delete-document').click(); await until(() => p.$('save-status').dataset.state === 'error');
  assert.equal((await p.store.list()).length, 1);
  assert.equal(p.$('material').value, 'Legacy title.\n\nLegacy second passage.');
  p.store.organize = organize;
  p.$('retry-save').click(); await until(() => p.$('editing-document').textContent === 'No document selected');
  assert.equal(confirmations, 2); assert.equal((await p.store.list()).length, 0);
});

test('reopening an emptied library clears legacy player text and permits a fresh document', async t => {
  const p = await page(t, { beforeApp(w) {
    const initialize = w.ReciterLibrary.LibraryStore.prototype.initialize;
    w.ReciterLibrary.LibraryStore.prototype.initialize = async function (text) {
      const result = await initialize.call(this, text);
      await this.organize('trash', result.documents[0]);
      const doc = (await this.list())[0];
      await this.organize('delete', doc);
      return initialize.call(this, text);
    };
  } });
  assert.equal(p.$('material').value, ''); assert.equal(p.$('play').disabled, true);
  assert.equal(p.$('new-document').disabled, false);
  assert.equal(p.$('document-count').textContent, '0 documents');
  p.$('new-document').click(); await until(() => p.$('document-title').value === 'Untitled document');
  assert.equal(p.$('material').value, ''); assert.equal(p.$('material').disabled, false);
});

async function loadBackup(p, mode, contents, name = 'backup.json') {
  p.$(mode === 'replace' ? 'import-database' : 'add-database').click();
  const file = new p.w.File([typeof contents === 'string' ? contents : JSON.stringify(contents)], name, { type: 'application/json' });
  Object.defineProperty(p.$('backup-file'), 'files', { configurable: true, value: [file] });
  p.$('backup-file').dispatchEvent(new p.w.Event('change'));
  await until(() => !p.$('import-review').hidden || p.$('backup-status').dataset.state === 'error');
  return file;
}
async function readBlob(w, blob) {
  return new Promise((resolve, reject) => {
    const reader = new w.FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = reject; reader.readAsText(blob);
  });
}

async function loadPackage(p, data) {
  p.$('import-package').click();
  const file = new p.w.File([JSON.stringify(data)], 'learning.json', { type: 'application/json' });
  Object.defineProperty(p.$('package-file'), 'files', { configurable: true, value: [file] });
  p.$('package-file').dispatchEvent(new p.w.Event('change'));
  await until(() => !p.$('package-review').hidden || p.$('package-status').dataset.state === 'error');
}

test('package import preview, topic tap, shared pause and automatic priority playback', async t => {
  const p = await page(t), data = JSON.parse(source('fixtures/learning-package.json'));
  const next = { ...data.topics[0], id: 'second', title: 'Next topic', text: 'Second document.' };
  next.textHash = p.w.ReciterLearning.fingerprint(next.text); data.topics.push(next);
  // Input order differs from priority order.
  data.package.entries.unshift({ topicId: 'second', occurrenceId: 'second-listen', priority: 'Can' });
  await loadPackage(p, data); assert.equal((await p.store.list()).length, 1);
  p.$('apply-package').click();
  await until(() => p.w.document.querySelectorAll('.package-topic').length === 2 && !p.$('import-package').disabled);
  p.w.document.querySelector('[data-package-play]').click();
  await until(() => p.spoken.length === 1);
  assert.equal(p.spoken[0].text, data.topics[0].text);
  await until(() => !p.w.document.querySelector('[data-package-play]').disabled);
  p.w.document.querySelector('[data-package-play]').click();
  await until(() => /Paused/.test(p.$('status').textContent));
  p.$('play').click(); assert.equal(p.spoken.length, 1);
  p.spoken[0].onend(); await until(() => p.spoken.length === 2);
  assert.equal(p.spoken[1].text, 'Second document.');
  p.spoken[1].onend(); await until(() => /Finished/.test(p.$('status').textContent));
  await until(() => /Completed/.test(p.w.document.querySelector('[data-topic-id="second"]').textContent));
  const progress = await p.store.exportProgress(); assert.equal(progress.events.filter(e => e.completedAt).length, 2);
  let blob; p.w.URL.createObjectURL = value => { blob = value; return 'blob:progress'; }; p.w.URL.revokeObjectURL = () => {};
  p.$('export-progress').click(); await until(() => !p.$('download-progress').hidden);
  const exported = JSON.parse(await readBlob(p.w, blob));
  assert.equal(exported.format, 'reciter-progress'); assert.equal(exported.events.length, 2);
  assert.ok(!JSON.stringify(exported).includes('Second document.'));
  await until(() => !p.w.document.querySelector('[data-topic-id="css-example"]').disabled);
  p.w.document.querySelector('[data-topic-id="css-example"]').click();
  await until(() => p.spoken.length === 3); assert.equal(p.spoken[2].text, data.topics[0].text);
});

test('package cancellation and malformed input leave stored library unchanged', async t => {
  const p = await page(t), data = JSON.parse(source('fixtures/learning-package.json'));
  await loadPackage(p, data); p.$('cancel-package').click();
  assert.equal((await p.store.list()).length, 1);
  data.topics[0].textHash = '00000000'; await loadPackage(p, data);
  assert.equal(p.$('package-status').dataset.state, 'error'); assert.equal((await p.store.list()).length, 1);
});

test('partially heard package resumes a saved checkpoint without marking it complete', async t => {
  const p = await page(t), data = JSON.parse(source('fixtures/learning-package.json'));
  data.topics[0].text = 'This is a short sentence. '.repeat(25).trim();
  data.topics[0].textHash = p.w.ReciterLearning.fingerprint(data.topics[0].text);
  await loadPackage(p, data); p.$('apply-package').click();
  await until(() => p.w.document.querySelector('.package-topic') && !p.$('import-package').disabled);
  p.w.document.querySelector('.package-topic').click(); await until(() => p.spoken.length === 1);
  const first = p.spoken[0].text; p.spoken[0].onend(); await until(() => p.spoken.length === 2);
  p.$('stop').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  let progress = await p.store.db.progress.get('listen-css-1'); assert.ok(progress.offset >= first.length); assert.equal(progress.completedAt, null);
  p.w.document.querySelector('.package-topic').click(); await until(() => p.spoken.length === 3);
  assert.equal(p.spoken[2].text, p.spoken[1].text);
  const canceled = p.spoken[2]; p.$('stop').click(); canceled.onend();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(p.spoken.length, 3);
});

test('reopening restores an unfinished package without autoplay and page Play resumes it', async t => {
  const p = await page(t), data = JSON.parse(source('fixtures/learning-package.json'));
  data.topics[0].text = 'An introduction to CSS. '.repeat(15) + 'A different ending. '.repeat(15);
  data.topics[0].textHash = p.w.ReciterLearning.fingerprint(data.topics[0].text);
  await loadPackage(p, data); p.$('apply-package').click();
  await until(() => p.w.document.querySelector('.package-topic') && !p.$('import-package').disabled);
  p.w.document.querySelector('.package-topic').click(); await until(() => p.spoken.length === 1);
  p.spoken[0].onend(); await until(() => p.spoken.length === 2);
  await until(async () => (await p.store.db.progress.get('listen-css-1')).offset > 0);
  const expected = p.spoken[1].text; p.store.db.close(); p.w.close();
  const reopened = await page(t, { database: p.database });
  assert.equal(reopened.spoken.length, 0);
  reopened.$('play').click(); await until(() => reopened.spoken.length === 1);
  assert.equal(reopened.spoken[0].text, expected);
});

test('export offers a mobile download containing saved content and no PC credentials', async t => {
  const p = await page(t);
  p.w.sessionStorage.setItem('reciter-pc-key', 'private-key');
  p.edit('document-tags', 'Exported'); p.edit('material', 'Latest exported text');
  let blob, next = 0, revoked = [];
  p.w.URL.createObjectURL = value => { blob = value; return 'blob:backup-' + ++next; };
  p.w.URL.revokeObjectURL = value => revoked.push(value);
  p.$('export-database').click(); await until(() => !p.$('download-backup').hidden);
  const json = await readBlob(p.w, blob), backup = JSON.parse(json);
  assert.equal(backup.documents[0].text, 'Latest exported text');
  assert.deepEqual(backup.documents[0].tags, ['Exported']);
  assert.equal(json.includes('private-key'), false);
  assert.match(p.$('download-backup').download, /^reciter-backup-.*\.json$/);
  assert.equal(p.$('download-backup').href, 'blob:backup-1');
  assert.match(p.$('backup-status').textContent, /Tap Save backup file/);
  assert.equal(p.$('export-database').disabled, false, p.$('backup-status').textContent);
  p.$('export-database').click(); await until(() => p.$('download-backup').href === 'blob:backup-2' || p.$('backup-status').dataset.state === 'error');
  assert.equal(p.$('download-backup').href, 'blob:backup-2', p.$('backup-status').textContent);
  assert.deepEqual(revoked, ['blob:backup-1']);
});

test('replacement validates and previews without mutation, supports cancel, and refreshes same-ID text after confirmation', async t => {
  const p = await page(t), backup = await p.store.exportBackup(), before = await p.store.list();
  backup.documents[0].title = 'Restored title'; backup.documents[0].text = 'Restored content';
  backup.documents[0].tags = ['Restored'];
  await loadBackup(p, 'replace', backup);
  assert.match(p.$('import-summary').textContent, /replace all 1 current documents/);
  assert.deepEqual(await p.store.list(), before);
  p.$('cancel-import').click(); assert.equal(p.$('import-review').hidden, true);
  assert.deepEqual(await p.store.list(), before);
  await loadBackup(p, 'replace', backup);
  let prompts = [];
  p.w.confirm = message => { prompts.push(message); return false; };
  p.$('apply-import').click(); assert.equal(p.$('import-review').hidden, false);
  assert.deepEqual(await p.store.list(), before); assert.match(prompts[0], /Replace all 1 current documents/);
  p.$('play').click(); const canceled = p.canceled();
  p.w.confirm = () => true; p.$('apply-import').click();
  await until(() => /Library replaced/.test(p.$('backup-status').textContent));
  assert.equal(p.$('document-title').value, 'Restored title');
  assert.equal(p.$('material').value, 'Restored content'); assert.equal(p.$('document-tags').value, 'Restored');
  assert.ok(p.canceled() > canceled);
  p.$('play').click(); assert.equal(p.spoken.at(-1).text, 'Restored content');
  assert.equal(p.w.document.querySelector('[aria-pressed=true]').dataset.documentId, backup.selectedId);
  assert.equal(p.$('import-review').hidden, true);
});

test('add review exposes conflict choices safely and supports keeping existing or both versions', async t => {
  const p = await page(t), backup = await p.store.exportBackup(), original = (await p.store.list())[0];
  backup.documents[0].title = '<img src=x onerror=alert(1)>'; backup.documents[0].text = 'Incoming version';
  await loadBackup(p, 'add', backup, '<script>bad</script>.json');
  assert.equal(p.$('import-policy-label').hidden, false);
  assert.match(p.$('import-conflicts').textContent, /<img/);
  assert.equal(p.w.document.querySelector('#import-review img, #import-review script'), null);
  choose(p, 'import-policy', 'keep'); p.$('apply-import').click();
  await until(() => /Added 0.*skipped 1/.test(p.$('backup-status').textContent));
  assert.deepEqual(await p.store.list(), [original]);
  await loadBackup(p, 'add', backup); p.$('apply-import').click();
  await until(() => /Added 1 documents \(1 imported copies\)/.test(p.$('backup-status').textContent));
  assert.equal((await p.store.list()).length, 2);
  assert.deepEqual(await p.store.db.documents.get(original.id), original);
  assert.equal(p.$('material').value, original.text);
  assert.equal(p.w.document.querySelector('#document-list img'), null);
});

test('invalid or unreadable files and failed replacements leave the displayed library intact', async t => {
  const p = await page(t), original = await p.store.list();
  await loadBackup(p, 'replace', '{bad JSON');
  assert.match(p.$('backup-status').textContent, /not valid JSON.*No import was applied/);
  assert.equal(p.$('import-review').hidden, true);
  assert.deepEqual(await p.store.list(), original);
  const backup = await p.store.exportBackup(); backup.documents = []; backup.selectedId = null;
  await loadBackup(p, 'replace', backup);
  const put = p.store.db.meta.put.bind(p.store.db.meta);
  p.store.db.meta.put = async () => { throw new Error('Quota failure'); };
  p.w.confirm = () => true; p.$('apply-import').click();
  await until(() => /Quota failure.*No import was applied/.test(p.$('backup-status').textContent));
  p.store.db.meta.put = put;
  assert.equal(p.$('material').value, original[0].text);
  assert.deepEqual(await p.store.list(), original);
  p.w.FileReader = class { readAsText() { this.onerror(); } };
  await loadBackup(p, 'replace', backup);
  assert.match(p.$('backup-status').textContent, /could not be read/);
  assert.deepEqual(await p.store.list(), original);
});

test('editing after review prevents replacement and requires a new review', async t => {
  const p = await page(t), backup = await p.store.exportBackup();
  backup.documents = []; backup.selectedId = null;
  await loadBackup(p, 'replace', backup);
  p.edit('material', 'New edits after review'); await p.saved();
  p.w.confirm = () => true; p.$('apply-import').click();
  await until(() => p.$('backup-status').dataset.state === 'error');
  assert.match(p.$('backup-status').textContent, /changed since this review/);
  assert.equal((await p.store.list())[0].text, 'New edits after review');
  assert.equal(p.$('import-review').hidden, true);
});

test('empty replacement clears the editor and a selected trashed import opens Trash read-only', async t => {
  const p = await page(t), backup = await p.store.exportBackup();
  p.w.confirm = () => true;
  await loadBackup(p, 'replace', { ...backup, documents: [], selectedId: null });
  p.$('apply-import').click(); await until(() => /Library replaced: 0/.test(p.$('backup-status').textContent));
  assert.equal(p.$('material').value, ''); assert.equal(p.$('play').disabled, true);
  backup.documents[0].trashedAt = Date.now();
  await loadBackup(p, 'replace', backup);
  p.$('apply-import').click(); await until(() => /Library replaced: 1/.test(p.$('backup-status').textContent));
  assert.equal(p.$('library-view').value, 'trash'); assert.equal(p.$('material').readOnly, true);
  assert.equal(p.$('material').value, backup.documents[0].text);
  assert.equal(p.$('restore-document').hidden, false);
});
