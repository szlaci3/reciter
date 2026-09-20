/* Learning exchange and storage, independent of audio and UI. */
(function (root) {
  const LIMIT = 25 * 1024 * 1024, priorities = ['Must', 'Should', 'Can'];
  const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
  const integer = v => Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
  const hash = v => typeof v === 'string' && /^[0-9a-f]{8}$/.test(v);
  const fail = message => { throw new Error('Learning data: ' + message); };
  function fingerprint(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  const normalized = text => text.trim().split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).join('\n\n');
  function checkSize(value) { if (new root.Blob([JSON.stringify(value)]).size > LIMIT) fail('maximum size is 25 MiB.'); }
  function topic(value) {
    if (!value || !id(value.id) || typeof value.title !== 'string' || typeof value.text !== 'string'
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision >= Number.MAX_SAFE_INTEGER
      || !hash(value.textHash) || fingerprint(value.text) !== value.textHash
      || !Number.isFinite(value.contentLengthPct) || value.contentLengthPct < 1 || value.contentLengthPct > 100
      || !(value.trashedAt === null || (integer(value.trashedAt) && value.trashedAt > 0))
      || !Array.isArray(value.sources) || value.sources.some(s => typeof s !== 'string' || !/^https:\/\/[^\s/]+/.test(s))) fail('invalid topic.');
    if (!value.trashedAt && !value.text.trim()) fail('active topics need text.');
    return { id: value.id, title: value.title, text: value.text, revision: value.revision, textHash: value.textHash,
      contentLengthPct: value.contentLengthPct, sources: [...value.sources], trashedAt: value.trashedAt };
  }
  function manifest(value) {
    if (!value || !id(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
      || !Number.isFinite(Date.parse(value.date)) || new Date(value.date).toISOString().slice(0, 10) !== value.date
      || !Array.isArray(value.entries) || value.entries.length > 10000) fail('invalid package.');
    const topics = new Set(), occurrences = new Set();
    const entries = value.entries.map(e => {
      if (!e || !id(e.topicId) || !id(e.occurrenceId) || !priorities.includes(e.priority)
        || topics.has(e.topicId) || occurrences.has(e.occurrenceId)) fail('invalid or repeated package entry.');
      topics.add(e.topicId); occurrences.add(e.occurrenceId);
      return { topicId: e.topicId, occurrenceId: e.occurrenceId, priority: e.priority };
    });
    return { id: value.id, date: value.date, revision: value.revision, entries };
  }
  function validatePackage(value) {
    checkSize(value);
    if (!value || value.format !== 'reciter-package' || value.version !== 1 || !Array.isArray(value.topics)
      || value.topics.length > 10000) fail('expected a Reciter learning package v1.');
    const topics = value.topics.map(topic), byId = new Map(topics.map(t => [t.id, t]));
    if (byId.size !== topics.length) fail('duplicate topic IDs.');
    const pack = manifest(value.package);
    if (pack.entries.some(e => !byId.has(e.topicId) || byId.get(e.topicId).trashedAt)) fail('package references missing or trashed topics.');
    return { format: 'reciter-package', version: 1, package: pack, topics };
  }
  function progress(value) {
    if (!value || !id(value.eventId) || !id(value.occurrenceId) || !id(value.topicId) || !hash(value.textHash)
      || !integer(value.offset) || !integer(value.heardThrough) || !integer(value.updatedAt)
      || !(value.completedAt === null || (integer(value.completedAt) && value.completedAt > 0 && value.completedAt <= value.updatedAt))) fail('invalid progress.');
    return Object.fromEntries(['eventId', 'occurrenceId', 'topicId', 'textHash', 'offset', 'heardThrough', 'completedAt', 'updatedAt'].map(k => [k, value[k]]));
  }
  function backupExtras(value, documents) {
    if (!Array.isArray(value.packages) || !Array.isArray(value.progress)) fail('backup needs package and progress arrays.');
    const packages = (value.packages || []).map(manifest), records = (value.progress || []).map(progress);
    if (packages.length > 10000 || records.length > 10000 || new Set(packages.map(p => p.id)).size !== packages.length
      || new Set(records.map(p => p.occurrenceId)).size !== records.length) fail('invalid backup collections.');
    const docs = new Map(documents.map(d => [d.id, d]));
    const byOccurrence = new Map(records.map(p => [p.occurrenceId, p]));
    for (const p of packages) if (p.entries.some(e => !docs.has(e.topicId) || byOccurrence.get(e.occurrenceId)?.topicId !== e.topicId)) fail('backup package references missing documents or progress.');
    for (const doc of documents) if (doc.learning && doc.learning.topicId !== doc.id) fail('managed topic identity does not match document.');
    for (const p of records) {
      const doc = docs.get(p.topicId);
      if (!doc) fail('backup progress references missing document.');
      if (p.textHash === fingerprint(doc.text) && (p.offset > normalized(doc.text).length || p.heardThrough > normalized(doc.text).length)) fail('invalid checkpoint.');
    }
    return { packages, progress: records };
  }
  function managed(value) {
    if (!value) return undefined;
    if (!id(value.topicId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !hash(value.textHash)
      || typeof value.title !== 'string' || !Number.isFinite(value.contentLengthPct) || value.contentLengthPct < 1 || value.contentLengthPct > 100
      || !Array.isArray(value.sources) || value.sources.some(s => typeof s !== 'string' || !/^https:\/\/[^\s/]+/.test(s))) fail('invalid managed topic metadata.');
    return { topicId: value.topicId, revision: value.revision, textHash: value.textHash, title: value.title,
      contentLengthPct: value.contentLengthPct, sources: [...value.sources] };
  }
  function install(Store, newId) {
    Object.assign(Store.prototype, {
      async learningSnapshot() {
        return this.db.transaction('r', this.db.documents, this.db.packages, this.db.progress, this.db.meta, async () => {
          await this.assertGeneration();
          return { documents: await this.list(), packages: await this.db.packages.toArray(), progress: await this.db.progress.toArray() };
        });
      },
      async preparePackage(value) {
        const data = validatePackage(value), snapshot = await this.learningSnapshot();
        return { data, dataToken: JSON.stringify(data), token: JSON.stringify([snapshot.documents, snapshot.packages]),
          added: data.topics.filter(t => !snapshot.documents.some(d => d.id === t.id)).length,
          updated: data.topics.filter(t => snapshot.documents.some(d => d.id === t.id)).length };
      },
      async applyPackage(plan) {
        const data = validatePackage(plan.data);
        if (JSON.stringify(data) !== plan.dataToken) fail('package changed after review.');
        return this.db.transaction('rw', this.db.documents, this.db.packages, this.db.progress, this.db.meta, async () => {
          await this.assertGeneration();
          const documents = await this.list(), packs = await this.db.packages.toArray();
          if (JSON.stringify([documents, packs]) !== plan.token) fail('library changed; review the file again.');
          const previous = packs.find(p => p.id === data.package.id);
          if (previous && (previous.revision > data.package.revision || (previous.revision === data.package.revision && JSON.stringify(previous) !== JSON.stringify(data.package)))) fail('stale or conflicting package revision.');
          for (const t of data.topics) {
            let doc = documents.find(d => d.id === t.id);
            if (doc) {
              if (!doc.learning || doc.learning.topicId !== t.id) fail('topic ID conflicts with an ordinary document.');
              if (doc.learning.revision > t.revision) fail('stale topic revision: ' + t.title);
              if ((fingerprint(doc.text) !== doc.learning.textHash || doc.title !== doc.learning.title)
                && (doc.text !== t.text || doc.title !== t.title)) fail('mobile edits conflict for ' + doc.title + '. Send your edits to Codex and import a corrected package matching them.');
              if (doc.learning.revision === t.revision && (doc.text !== t.text || doc.title !== t.title || Boolean(doc.trashedAt) !== Boolean(t.trashedAt)
                || doc.learning.contentLengthPct !== t.contentLengthPct || JSON.stringify(doc.learning.sources) !== JSON.stringify(t.sources))) fail('conflicting topic revision: ' + t.title);
              if (doc.learning.revision === t.revision) continue;
              doc = { ...doc, revision: doc.revision + 1, updatedAt: Date.now() };
            } else {
              doc = { ...this.makeDocument(t.text, documents, t.title), id: t.id };
              documents.push(doc);
            }
            Object.assign(doc, { title: t.title, text: t.text, trashedAt: t.trashedAt,
              learning: { topicId: t.id, revision: t.revision, textHash: t.textHash, title: t.title,
                contentLengthPct: t.contentLengthPct, sources: t.sources } });
            await this.db.documents.put(doc);
          }
          for (const e of data.package.entries) {
            const t = data.topics.find(t => t.id === e.topicId), old = await this.db.progress.get(e.occurrenceId);
            if (old && old.topicId !== e.topicId) fail('occurrence ID belongs to another topic.');
            if (!old || old.textHash !== t.textHash) await this.db.progress.put({ eventId: newId(), occurrenceId: e.occurrenceId,
              topicId: e.topicId, textHash: t.textHash, offset: 0, heardThrough: 0, completedAt: null, updatedAt: Date.now() });
          }
          await this.db.packages.put(data.package);
          if (await this.db.documents.count() > 10000 || await this.db.packages.count() > 10000 || await this.db.progress.count() > 10000) fail('maximum collection size is 10,000.');
          checkSize(await this.learningSnapshot());
          return data.package.id;
        });
      },
      async saveProgress(value) {
        return this.db.transaction('rw', this.db.documents, this.db.progress, this.db.meta, async () => {
          await this.assertGeneration();
          const p = progress(value), doc = await this.db.documents.get(p.topicId), old = await this.db.progress.get(p.occurrenceId);
          if (!doc || doc.trashedAt || fingerprint(doc.text) !== p.textHash || !old || old.textHash !== p.textHash) fail('topic changed during playback.');
          const length = normalized(doc.text).length;
          if (p.offset > length || p.heardThrough > length || (p.completedAt && p.heardThrough !== length)) fail('invalid completion/checkpoint.');
          // Serialize checkpoints; preserve completion and coverage across tabs/replays.
          p.heardThrough = Math.max(p.heardThrough, old.heardThrough);
          p.completedAt = old.completedAt || p.completedAt;
          p.updatedAt = Math.max(Date.now(), p.updatedAt, old.updatedAt + 1, p.completedAt || 0);
          await this.db.progress.put(p);
          return p;
        });
      },
      async ensureOccurrence(entry) {
        return this.db.transaction('rw', this.db.documents, this.db.progress, this.db.meta, async () => {
          await this.assertGeneration();
          const doc = await this.db.documents.get(entry.topicId), old = await this.db.progress.get(entry.occurrenceId);
          if (!doc || doc.trashedAt || !old || old.topicId !== doc.id) fail('listening item is unavailable.');
          const textHash = fingerprint(doc.text);
          if (old.textHash === textHash) return old;
          if (!doc.learning || doc.learning.textHash !== textHash) fail('text was edited on the phone; import a corrected package first.');
          const p = { ...old, eventId: newId(), textHash, offset: 0, heardThrough: 0, completedAt: null, updatedAt: Date.now() };
          await this.db.progress.put(p); return p;
        });
      },
      async exportProgress() {
        const snapshot = await this.learningSnapshot();
        return { format: 'reciter-progress', version: 1, events: snapshot.progress.map(progress) };
      }
    });
  }
  const api = { fingerprint, normalized, validatePackage, manifest, progress, managed, backupExtras, install, priorities, LIMIT };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ReciterLearning = api;
})(globalThis);
