/* Browser-local documents. No service credentials or audio are stored here. */
(function (root) {
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
  class LibraryStore {
    constructor(Dexie, name = 'reciter-library', options) {
      this.db = new Dexie(name, options);
      this.db.version(1).stores({ documents: '&id,createdAt,updatedAt', meta: '&key' });
      this.db.version(2).stores({ documents: '&id,createdAt,updatedAt', meta: '&key' })
        .upgrade(tx => tx.table('documents').toCollection().modify(doc => {
          doc.tags = doc.tags || []; doc.trashedAt = doc.trashedAt || null;
        }));
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
      const documents = await this.list();
      const selected = await this.db.meta.get('selected');
      return { documents, selectedId: documents.some(doc => doc.id === selected?.value)
        ? selected.value : documents.find(doc => !doc.trashedAt)?.id };
    }
    list() { return this.db.documents.orderBy('createdAt').toArray(); }
    async select(id) {
      return this.db.transaction('rw', this.db.documents, this.db.meta, async () => {
        const doc = await this.db.documents.get(id);
        if (!doc) throw new Error('This document is no longer available. Reload the library.');
        await this.db.meta.put({ key: 'selected', value: id });
        return doc;
      });
    }
    async create() {
      return this.db.transaction('rw', this.db.documents, this.db.meta, async () => {
        const doc = this.makeDocument('', await this.list());
        await this.db.documents.add(doc);
        await this.db.meta.put({ key: 'selected', value: doc.id });
        return doc;
      });
    }
    async save(draft) {
      return this.db.transaction('rw', this.db.documents, async () => {
        const current = await this.db.documents.get(draft.id);
        if (!current || current.trashedAt || current.revision !== draft.revision) throw conflict();
        const doc = { ...current, title: draft.title, text: draft.text, tags: normalizeTags(draft.tags ?? current.tags),
          updatedAt: Date.now(), revision: current.revision + 1 };
        await this.db.documents.put(doc);
        return doc;
      });
    }
    async organize(action, draft) {
      if (!['duplicate', 'trash', 'restore', 'delete'].includes(action)) throw new Error('Unknown document action.');
      return this.db.transaction('rw', this.db.documents, this.db.meta, async () => {
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
  class LibraryEditor {
    constructor(store, changed = () => {}) {
      this.store = store; this.changed = changed; this.documents = [];
      this.active = null; this.editVersion = 0; this.savedVersion = 0;
      this.busy = false; this.saving = null; this.state = 'loading';
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
  const api = { COLORS, normalizeTags, visibleDocuments, LibraryStore, LibraryEditor };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ReciterLibrary = api;
})(globalThis);
