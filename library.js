/* Browser-local documents. No service credentials or audio are stored here. */
(function (root) {
  const COLORS = ['#31576e', '#653c60', '#715027', '#285941', '#663d39', '#444f7b',
    '#285a60', '#654674', '#595323', '#71404f', '#3b5862', '#485b35'];
  function titleFor(text) {
    return text.trim().split(/\r?\n/)[0].slice(0, 80) || 'Untitled document';
  }
  function colorFor(documents) {
    const counts = COLORS.map(color => documents.filter(doc => doc.color === color).length);
    const least = Math.min(...counts);
    const choices = COLORS.filter((_, i) => counts[i] === least);
    return choices[Math.floor(Math.random() * choices.length)];
  }
  function newId() {
    // getRandomValues works on the phone's HTTP LAN page as well as HTTPS.
    return Array.from(root.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  }
  class LibraryStore {
    constructor(Dexie, name = 'reciter-library', options) {
      this.db = new Dexie(name, options);
      this.db.version(1).stores({ documents: '&id,createdAt,updatedAt', meta: '&key' });
    }
    makeDocument(text, documents, title = titleFor(text)) {
      const now = Date.now();
      return { id: newId(), title, text, color: colorFor(documents), createdAt: now, updatedAt: now, revision: 1 };
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
        ? selected.value : documents[0]?.id };
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
        if (!current || current.revision !== draft.revision) {
          const error = new Error('This document changed in another tab. Copy your edits before reloading.');
          error.name = 'ConflictError'; throw error;
        }
        const doc = { ...current, title: draft.title, text: draft.text,
          updatedAt: Date.now(), revision: current.revision + 1 };
        await this.db.documents.put(doc);
        return doc;
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
      this.active = { ...this.documents.find(doc => doc.id === result.selectedId) };
      this.state = 'saved'; this.emit();
    }
    edit(fields) {
      if (this.busy || !this.active?.id) return;
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
  const api = { COLORS, LibraryStore, LibraryEditor };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ReciterLibrary = api;
})(globalThis);
