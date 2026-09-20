/* Browser-local documents. No service credentials or audio are stored here. */
(function (root) {
  const learning = root.ReciterLearning || (typeof require !== 'undefined' ? require('./learning.js') : null);
  const COLORS = ['#31576e', '#653c60', '#715027', '#285941', '#663d39', '#444f7b',
    '#285a60', '#654674', '#595323', '#71404f', '#3b5862', '#485b35'];
  function titleFor(text) {
    return text.trim().split(/\r?\n/)[0].slice(0, 80) || 'Untitled document';
  }
  function colorFor(documents, excludedColor) {
    const counts = COLORS.map(color => color === excludedColor ? Infinity : documents.filter(doc => doc.color === color).length);
    const least = Math.min(...counts);
    const choices = COLORS.filter((_, i) => counts[i] === least);
    return choices[Math.floor(Math.random() * choices.length)];
  }
  function newId() {
    // getRandomValues works on the phone's HTTP LAN page as well as HTTPS.
    return Array.from(root.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  }
  function normalizeTags(value = []) {
    const seen = new Set();
    return (Array.isArray(value) ? value : value.split(',')).map(tag => tag.trim())
      .filter(tag => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
  }
  function visibleDocuments(documents, { trash = false, search = '', tag = '', sort = 'oldest' } = {}) {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return documents.filter(doc => {
      const tags = doc.tags || [];
      const text = [doc.title, doc.text, ...tags].join(' ').toLowerCase();
      return Boolean(doc.trashedAt) === trash && words.every(word => text.includes(word))
        && (!tag || tags.some(item => item.toLowerCase() === tag.toLowerCase()));
    }).sort((a, b) => {
      const order = sort === 'title' ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
        : sort === 'updated' ? b.updatedAt - a.updatedAt
        : sort === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
      return order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    });
  }
  function conflict() {
    const error = new Error('This document changed in another tab. Copy your edits before reloading.');
    error.name = 'ConflictError'; return error;
  }
  const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
  const MAX_BACKUP_DOCUMENTS = 10000;
  function validateBackup(value) {
    const invalid = message => { throw new Error('Invalid backup: ' + message); };
    const record = item => item && typeof item === 'object' && !Array.isArray(item);
    const timestamp = item => Number.isSafeInteger(item) && item >= 0 && item <= 8640000000000000;
    if (!record(value) || value.format !== 'reciter-library' || value.version !== 1 || ![2, 3].includes(value.schemaVersion)) {
      invalid('expected a Reciter library backup (format version 1, schema version 2).');
    }
    if (!timestamp(value.exportedAt) || !Array.isArray(value.documents) || value.documents.length > MAX_BACKUP_DOCUMENTS) {
      invalid('invalid export date or document list (maximum 10,000 documents).');
    }
    const ids = new Set();
    const documents = value.documents.map((doc, index) => {
      const label = 'document ' + (index + 1);
      if (!record(doc) || typeof doc.id !== 'string' || !doc.id.trim() || ids.has(doc.id)) invalid(label + ' has a missing or repeated ID.');
      ids.add(doc.id);
      if (typeof doc.title !== 'string' || typeof doc.text !== 'string') invalid(label + ' needs title and text strings.');
      if (typeof doc.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(doc.color)) invalid(label + ' has an invalid color.');
      const channels = doc.color.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255)
        .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      if (1.05 / (.2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2] + .05) < 4.5) invalid(label + ' needs a dark color readable with white text.');
      if (!timestamp(doc.createdAt) || !timestamp(doc.updatedAt)
        || !(doc.trashedAt === null || (timestamp(doc.trashedAt) && doc.trashedAt > 0))
        || !Number.isSafeInteger(doc.revision) || doc.revision < 1 || doc.revision >= Number.MAX_SAFE_INTEGER - 1) {
        invalid(label + ' has invalid dates, Trash state or revision.');
      }
      if (!Array.isArray(doc.tags) || doc.tags.some(tag => typeof tag !== 'string' || !tag.trim())
        || normalizeTags(doc.tags).length !== doc.tags.length) invalid(label + ' has invalid or repeated topic tags.');
      // Copy only known document fields. Imported objects never become configuration.
      return { id: doc.id, title: doc.title, text: doc.text, color: doc.color,
        createdAt: doc.createdAt, updatedAt: doc.updatedAt, revision: doc.revision,
        tags: [...doc.tags], trashedAt: doc.trashedAt,
        ...(doc.learning ? { learning: learning.managed(doc.learning) } : {}) };
    });
    if (!(value.selectedId === null || (typeof value.selectedId === 'string' && ids.has(value.selectedId)))) {
      invalid('selected document does not exist.');
    }
    const backup = { format: 'reciter-library', version: 1, schemaVersion: value.schemaVersion,
      exportedAt: value.exportedAt, selectedId: value.selectedId, documents,
      ...(value.schemaVersion === 3 ? learning.backupExtras(value, documents) : {}) };
    if (new root.Blob([JSON.stringify(backup)]).size > MAX_BACKUP_BYTES) invalid('maximum file size is 25 MiB.');
    return backup;
  }
  function parseBackup(text) {
    if (typeof text !== 'string' || new root.Blob([text]).size > MAX_BACKUP_BYTES) throw new Error('Backup files must be at most 25 MiB.');
    let value;
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch (_) { throw new Error('Invalid backup: the file is not valid JSON.'); }
    return validateBackup(value);
  }
  function sameDocument(a, b) {
    return ['title', 'text', 'color', 'createdAt', 'updatedAt', 'trashedAt'].every(key => a[key] === b[key])
      && JSON.stringify(a.tags) === JSON.stringify(b.tags) && JSON.stringify(a.learning) === JSON.stringify(b.learning);
  }
  function libraryToken(documents, generation) {
    return JSON.stringify([generation, documents.map(doc => [doc.id, doc.revision]).sort((a, b) => a[0].localeCompare(b[0]))]);
  }
  class LibraryStore {
    constructor(Dexie, name = 'reciter-library', options) {
      this.db = new Dexie(name, options);
      this.generation = null;
      this.db.version(1).stores({ documents: '&id,createdAt,updatedAt', meta: '&key' });
      this.db.version(2).stores({ documents: '&id,createdAt,updatedAt', meta: '&key' })
        .upgrade(tx => tx.table('documents').toCollection().modify(doc => {
          doc.tags = doc.tags || []; doc.trashedAt = doc.trashedAt || null;
        }));
      this.db.version(3).stores({ documents: '&id,createdAt,updatedAt', meta: '&key', packages: '&id,date', progress: '&occurrenceId,topicId' });
    }
    makeDocument(text, documents, title = titleFor(text)) {
      const now = Date.now();
      return { id: newId(), title, text, color: colorFor(documents), createdAt: now, updatedAt: now, revision: 1, tags: [], trashedAt: null };
    }
    async initialize(legacyText) {
      await this.db.open();
      await this.db.transaction('rw', this.db.documents, this.db.meta, async () => {
        if (await this.db.meta.get('initial-document-v1')) return;
        if (await this.db.documents.count() === 0) {
          const doc = this.makeDocument(legacyText, []);
          await this.db.documents.add(doc);
          await this.db.meta.put({ key: 'selected', value: doc.id });
        }
        await this.db.meta.put({ key: 'initial-document-v1', value: true });
      });
      this.generation = (await this.db.meta.get('generation'))?.value || null;
      const documents = await this.list();
      const selected = await this.db.meta.get('selected');
      return { documents, selectedId: documents.some(doc => doc.id === selected?.value)
        ? selected.value : documents.find(doc => !doc.trashedAt)?.id };
    }
    async assertGeneration() {
      if (((await this.db.meta.get('generation'))?.value || null) !== this.generation) {
        const error = conflict();
        error.message = 'The library was replaced in another tab. Copy your edits before reloading.';
        throw error;
      }
    }
    list() { return this.db.documents.orderBy('createdAt').toArray(); }
    async select(id) {
      return this.db.transaction('rw', this.db.documents, this.db.meta, async () => {
        await this.assertGeneration();
        const doc = await this.db.documents.get(id);
        if (!doc) throw new Error('This document is no longer available. Reload the library.');
        await this.db.meta.put({ key: 'selected', value: id });
        return doc;
      });
    }
    async create() {
      return this.db.transaction('rw', this.db.documents, this.db.meta, async () => {
        await this.assertGeneration();
        const doc = this.makeDocument('', await this.list());
        await this.db.documents.add(doc);
        await this.db.meta.put({ key: 'selected', value: doc.id });
        return doc;
      });
    }
    async save(draft) {
      return this.db.transaction('rw', this.db.documents, this.db.meta, async () => {
        await this.assertGeneration();
        const current = await this.db.documents.get(draft.id);
        if (!current || current.trashedAt || current.revision !== draft.revision) throw conflict();
        const doc = { ...current, title: draft.title, text: draft.text, tags: normalizeTags(draft.tags ?? current.tags),
          updatedAt: Date.now(), revision: current.revision + 1 };
        await this.db.documents.put(doc);
        return doc;
      });
    }
    async exportBackup() {
      return this.db.transaction('r', this.db.documents, this.db.meta, this.db.packages, this.db.progress, async () => {
        await this.assertGeneration();
        const documents = await this.list(), selected = (await this.db.meta.get('selected'))?.value;
        return validateBackup({ format: 'reciter-library', version: 1, schemaVersion: 3,
          exportedAt: Date.now(), selectedId: documents.some(doc => doc.id === selected) ? selected : null, documents,
          packages: await this.db.packages.toArray(), progress: await this.db.progress.toArray() });
      });
    }
    async prepareImport(value, mode) {
      if (!['replace', 'add'].includes(mode)) throw new Error('Choose Import database or Add to database.');
      const backup = validateBackup(value);
      return this.db.transaction('r', this.db.documents, this.db.meta, this.db.packages, this.db.progress, async () => {
        await this.assertGeneration();
        const documents = await this.list(), byId = new Map(documents.map(doc => [doc.id, doc]));
        const conflicts = [], identical = [], added = [];
        for (const doc of backup.documents) {
          const current = byId.get(doc.id);
          if (!current) added.push(doc.id);
          else if (sameDocument(current, doc)) identical.push(doc.id);
          else conflicts.push({ id: doc.id, title: doc.title, currentTitle: current.title });
        }
        return { mode, backup, backupToken: JSON.stringify(backup), token: libraryToken(documents, this.generation),
          learningToken: JSON.stringify([await this.db.packages.toArray(), await this.db.progress.toArray()]),
          currentCount: documents.length, currentTrash: documents.filter(doc => doc.trashedAt).length,
          incomingTrash: backup.documents.filter(doc => doc.trashedAt).length,
          added, identical, conflicts };
      });
    }
    async applyImport(plan, policy = 'both', preferredId = null) {
      if (!['replace', 'add'].includes(plan.mode) || !['both', 'keep'].includes(policy)) throw new Error('Invalid import choice.');
      const backup = validateBackup(plan.backup);
      if (JSON.stringify(backup) !== plan.backupToken) throw new Error('The backup changed. Select the file and review it again.');
      const result = await this.db.transaction('rw', this.db.documents, this.db.meta, this.db.packages, this.db.progress, async () => {
        await this.assertGeneration();
        const current = await this.list();
        if (libraryToken(current, this.generation) !== plan.token) throw new Error('The library changed since this review. Select the file and review it again.');
        if (JSON.stringify([await this.db.packages.toArray(), await this.db.progress.toArray()]) !== plan.learningToken) throw new Error('Listening data changed since this review. Review the file again.');
        const byId = new Map(current.map(doc => [doc.id, doc]));
        const generation = plan.mode === 'replace' ? newId() : this.generation;
        let documents, added = 0, skipped = 0, copies = 0;
        const remap = new Map(), ignored = new Set();
        if (plan.mode === 'replace') {
          documents = backup.documents.map(doc => ({ ...doc,
            revision: Math.max(doc.revision, byId.get(doc.id)?.revision || 0) + 1 }));
          await this.db.documents.clear();
          await this.db.documents.bulkAdd(documents);
          await this.db.packages.clear(); await this.db.progress.clear();
          await this.db.meta.put({ key: 'generation', value: generation });
        } else {
          documents = [...current];
          const reserved = new Set([...byId.keys(), ...backup.documents.map(doc => doc.id)]);
          for (const source of backup.documents) {
            const existing = byId.get(source.id);
            if (existing && (sameDocument(existing, source) || policy === 'keep')) { skipped++; if (!sameDocument(existing, source)) ignored.add(source.id); continue; }
            const doc = { ...source, tags: [...source.tags] };
            if (existing) {
              do { doc.id = newId(); } while (reserved.has(doc.id));
              doc.title = (doc.title.trim() || 'Untitled document') + ' (imported copy)';
              doc.color = colorFor(documents, existing.color); doc.revision = 1;
              remap.set(source.id, doc.id);
              // Imported copies are independent ordinary documents.
              delete doc.learning;
              copies++;
            }
            reserved.add(doc.id); documents.push(doc);
            await this.db.documents.add(doc); added++;
          }
        }
        const occurrenceMap = new Map();
        for (const p of backup.progress || []) {
          if (ignored.has(p.topicId)) continue;
          const copy = { ...p, topicId: remap.get(p.topicId) || p.topicId };
          const existing = await this.db.progress.get(p.occurrenceId);
          if (remap.has(p.topicId) || (existing && JSON.stringify(existing) !== JSON.stringify(copy))) {
            copy.occurrenceId = newId(); copy.eventId = newId();
          }
          occurrenceMap.set(p.occurrenceId, copy.occurrenceId);
          if (!existing || copy.occurrenceId !== p.occurrenceId || plan.mode === 'replace') await this.db.progress.put(copy);
        }
        for (const pack of backup.packages || []) {
          const copy = { ...pack, entries: pack.entries.filter(e => !ignored.has(e.topicId)).map(e => ({ ...e,
            topicId: remap.get(e.topicId) || e.topicId, occurrenceId: occurrenceMap.get(e.occurrenceId) || e.occurrenceId })) };
          const existing = await this.db.packages.get(copy.id);
          if (existing && JSON.stringify(existing) === JSON.stringify(copy)) continue;
          if (existing) copy.id = newId();
          await this.db.packages.put(copy);
        }
        const previousSelected = preferredId || (await this.db.meta.get('selected'))?.value;
        const wanted = plan.mode === 'replace' ? backup.selectedId : previousSelected;
        const selectedId = documents.some(doc => doc.id === wanted) ? wanted
          : documents.find(doc => !doc.trashedAt)?.id || null;
        // An additive result must remain exportable under the same limits.
        validateBackup({ ...backup, schemaVersion: 3, documents, selectedId,
          packages: await this.db.packages.toArray(), progress: await this.db.progress.toArray() });
        await this.db.meta.put({ key: 'selected', value: selectedId });
        await this.db.meta.put({ key: 'initial-document-v1', value: true });
        return { documents, selectedId, generation, added, skipped, copies };
      });
      // Updating only after commit keeps failed replacement transactions retryable.
      this.generation = result.generation;
      return result;
    }
    async organize(action, draft) {
      if (!['duplicate', 'trash', 'restore', 'delete'].includes(action)) throw new Error('Unknown document action.');
      return this.db.transaction('rw', this.db.documents, this.db.meta, this.db.packages, this.db.progress, async () => {
        await this.assertGeneration();
        const current = await this.db.documents.get(draft.id);
        if (!current || current.revision !== draft.revision) throw conflict();
        const trashed = Boolean(current.trashedAt);
        if (trashed !== (action === 'restore' || action === 'delete')) {
          throw new Error(trashed ? 'Restore this document before duplicating it.' : 'Move this document to Trash first.');
        }
        let selectedId = current.id;
        if (action === 'duplicate') {
          const existing = await this.list();
          const copy = this.makeDocument(current.text, existing, (current.title.trim() || 'Untitled document') + ' (copy)');
          copy.color = colorFor(existing, current.color);
          copy.tags = [...(current.tags || [])];
          await this.db.documents.add(copy);
          selectedId = copy.id;
        } else if (action === 'delete') {
          await this.db.documents.delete(current.id);
          await this.db.progress.where('topicId').equals(current.id).delete();
          await this.db.packages.toCollection().modify(pack => { pack.entries = pack.entries.filter(e => e.topicId !== current.id); });
        } else {
          await this.db.documents.put({ ...current, trashedAt: action === 'trash' ? Date.now() : null,
            updatedAt: Date.now(), revision: current.revision + 1 });
        }
        const documents = await this.list();
        if (action === 'trash' || action === 'delete') {
          selectedId = documents.find(doc => !doc.trashedAt)?.id || null;
        }
        await this.db.meta.put({ key: 'selected', value: selectedId });
        return { documents, selectedId };
      });
    }
  }
  // Serialize saves and navigation. A failed save leaves the draft in memory.
  learning?.install(LibraryStore, newId);
  class LibraryEditor {
    constructor(store, changed = () => {}) {
      this.store = store; this.changed = changed; this.documents = [];
      this.active = null; this.editVersion = 0; this.savedVersion = 0;
      this.busy = false; this.saving = null; this.state = 'loading'; this.loadVersion = 0;
    }
    emit() { this.changed(this); }
    get dirty() { return this.editVersion !== this.savedVersion; }
    async initialize(text) {
      const result = await this.store.initialize(text);
      this.documents = result.documents;
      const active = this.documents.find(doc => doc.id === result.selectedId);
      this.active = active ? { ...active } : null;
      this.state = 'saved'; this.emit();
    }
    edit(fields) {
      if (this.busy || !this.active?.id || this.active.trashedAt) return;
      Object.assign(this.active, fields);
      this.editVersion++; this.state = 'saving'; this.emit();
      return this.flush();
    }
    flush() {
      if (this.saving) return this.saving;
      if (!this.dirty) return Promise.resolve(true);
      this.state = 'saving'; this.emit();
      this.saving = (async () => {
        try {
          while (this.dirty) {
            const version = this.editVersion;
            const doc = await this.store.save({ ...this.active });
            this.active.revision = doc.revision; this.active.updatedAt = doc.updatedAt;
            this.savedVersion = version;
            this.documents = this.documents.map(item => item.id === doc.id ? doc : item);
          }
          this.state = 'saved'; this.error = null;
          return true;
        } catch (error) {
          this.state = 'error'; this.error = error;
          return false;
        } finally { this.saving = null; this.emit(); }
      })();
      return this.saving;
    }
    async transfer(work) {
      if (this.busy) throw new Error('Wait for the current library action to finish.');
      this.busy = true; this.emit();
      try {
        if (!await this.flush()) throw this.error || new Error('Save your edits before transferring the library.');
        return await work();
      } finally { this.busy = false; this.emit(); }
    }
    exportBackup() { return this.transfer(() => this.store.exportBackup()); }
    prepareImport(backup, mode) { return this.transfer(() => this.store.prepareImport(backup, mode)); }
    applyImport(plan, policy) {
      return this.transfer(async () => {
        const result = await this.store.applyImport(plan, policy, this.active?.id);
        this.documents = result.documents;
        const active = this.documents.find(doc => doc.id === result.selectedId);
        this.active = active ? { ...active } : null;
        this.editVersion = this.savedVersion = 0; this.loadVersion++;
        this.state = 'saved'; this.error = null;
        return result;
      });
    }
    async organize(action) {
      if (this.busy || !this.active) return false;
      this.busy = true; this.emit();
      try {
        if (!await this.flush()) return false;
        const result = await this.store.organize(action, this.active);
        this.documents = result.documents;
        const active = this.documents.find(doc => doc.id === result.selectedId);
        this.active = active ? { ...active } : null;
        this.editVersion = this.savedVersion = 0;
        this.state = 'saved'; this.error = null;
        return true;
      } catch (error) {
        this.state = 'error'; this.error = error; return false;
      } finally { this.busy = false; this.emit(); }
    }
    async navigate(id) {
      if (this.busy) return false;
      this.busy = true; this.emit();
      try {
        if (!await this.flush()) return false;
        const doc = id ? await this.store.select(id) : await this.store.create();
        if (!this.documents.some(item => item.id === doc.id)) this.documents.push(doc);
        else this.documents = this.documents.map(item => item.id === doc.id ? doc : item);
        this.active = { ...doc }; this.editVersion = this.savedVersion = 0;
        this.state = 'saved'; this.error = null;
        return true;
      } catch (error) {
        this.state = 'error'; this.error = error; return false;
      } finally { this.busy = false; this.emit(); }
    }
  }
  const api = { COLORS, normalizeTags, visibleDocuments, MAX_BACKUP_BYTES, validateBackup, parseBackup, LibraryStore, LibraryEditor, newId };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ReciterLibrary = api;
})(globalThis);
