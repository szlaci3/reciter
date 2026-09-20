/* One package queue shares the existing player and document editor. */
(function (root) {
  class PackageQueue {
    constructor({ editor, player, play, unlock = () => {}, changed = () => {}, error = () => {} }) {
      Object.assign(this, { editor, player, play, unlock, changed, error });
      this.generation = 0; this.pending = Promise.resolve(); this.context = null; this.switching = false;
      player.onCheckpoint = checkpoint => this.save(checkpoint);
      player.onDocumentEnd = () => this.advance();
    }
    save(checkpoint) {
      const context = this.context;
      if (!context || this.switching) return;
      const event = { eventId: root.ReciterLibrary.newId(), occurrenceId: context.entry.occurrenceId,
        topicId: context.entry.topicId, textHash: context.textHash, offset: checkpoint.offset,
        heardThrough: checkpoint.heardThrough, completedAt: checkpoint.completed ? Date.now() : null, updatedAt: Date.now() };
      this.pending = this.pending.then(() => this.editor.store.saveProgress(event)).then(() => { this.failure = null; this.retryEvent = null; })
        .catch(error => { this.failure = error; this.retryEvent = event; this.error(error); });
    }
    async flush() {
      await this.pending;
      if (this.failure && this.retryEvent) {
        await this.editor.store.saveProgress(this.retryEvent);
        this.failure = null; this.retryEvent = null;
      }
    }
    cancel() { this.generation++; this.context = null; this.player.stop(); this.changed(); }
    textChanged() { if (!this.switching) this.cancel(); }
    async start(pack, topicId = null, automatic = false) {
      const token = ++this.generation;
      // Remove old audio callbacks before unlocking the shared element. The
      // silent unlock must never complete the previous topic accidentally.
      this.context = null; this.player.stop();
      if (!automatic) this.unlock();
      await this.flush();
      if (token !== this.generation) return;
      const snapshot = await this.editor.store.learningSnapshot();
      if (token !== this.generation) return;
      const entries = [...pack.entries].sort((a, b) => root.ReciterLearning.priorities.indexOf(a.priority) - root.ReciterLearning.priorities.indexOf(b.priority))
        .filter(e => snapshot.documents.some(d => d.id === e.topicId && !d.trashedAt && d.text.trim()));
      let index = topicId ? entries.findIndex(e => e.topicId === topicId) : entries.findIndex(e => {
        const record = snapshot.progress.find(p => p.occurrenceId === e.occurrenceId);
        const doc = snapshot.documents.find(d => d.id === e.topicId);
        return !record?.completedAt || record.textHash !== root.ReciterLearning.fingerprint(doc.text);
      });
      if (!topicId && index < 0 && entries.length) index = 0;
      if (index < 0 || !entries[index]) { this.cancel(); return; }
      this.player.stop(); this.context = null; this.switching = true;
      try {
        if (!await this.editor.navigate(entries[index].topicId)) throw this.editor.error || new Error('Could not save before switching.');
        if (token !== this.generation) return;
        const doc = this.editor.active;
        const record = await this.editor.store.ensureOccurrence(entries[index]);
        if (token !== this.generation) return;
        const textHash = root.ReciterLearning.fingerprint(doc.text);
        if (!record || record.textHash !== textHash) throw new Error('This topic changed on the phone. Import a corrected learning package before listening.');
        this.context = { pack, entries, index, entry: entries[index], textHash };
        this.player.restoreCheckpoint(record.completedAt ? { offset: 0, heardThrough: 0 } : record);
        await this.editor.store.db.meta.put({ key: 'learning-listening', value: { packageId: pack.id, occurrenceId: entries[index].occurrenceId } });
      } finally { this.switching = false; }
      if (token === this.generation && this.context) { this.play(); this.changed(); }
    }
    async advance() {
      const token = this.generation, context = this.context;
      if (!context) return;
      try {
        await this.flush();
        if (token !== this.generation || this.player.state !== 'ended') return;
        const next = context.entries[context.index + 1];
        if (next) await this.start(context.pack, next.topicId, true);
        else this.changed();
      } catch (error) { this.error(error); }
    }
    async restore() {
      const saved = (await this.editor.store.db.meta.get('learning-listening'))?.value;
      if (!saved) return;
      const snapshot = await this.editor.store.learningSnapshot();
      const pack = snapshot.packages.find(p => p.id === saved.packageId);
      if (!pack) return;
      const entries = [...pack.entries].sort((a, b) => root.ReciterLearning.priorities.indexOf(a.priority) - root.ReciterLearning.priorities.indexOf(b.priority));
      const index = entries.findIndex(e => e.occurrenceId === saved.occurrenceId);
      if (index < 0 || entries[index].topicId !== this.editor.active?.id || this.editor.active.trashedAt) return;
      const record = snapshot.progress.find(p => p.occurrenceId === saved.occurrenceId);
      if (!record || record.completedAt || record.textHash !== root.ReciterLearning.fingerprint(this.editor.active.text)) return;
      this.context = { pack, entries, index, entry: entries[index], textHash: record.textHash };
      this.player.restoreCheckpoint(record);
    }
  }
  async function mount({ editor, player, play, unlock }) {
    const $ = id => root.document?.getElementById(id);
    let snapshot, plan, busy = false, downloadUrl, refreshToken = 0;
    const opened = new Set();
    function message(text, error = false) { if (!$('package-status')) return; $('package-status').textContent = text; $('package-status').dataset.state = error ? 'error' : ''; }
    const queue = new PackageQueue({ editor, player, play, unlock, changed: () => refresh(), error: e => message(e.message, true) });
    function run(work) { return async () => {
      if (busy || editor.busy) return;
      busy = true; buttons();
      try { await work(); } catch (error) { message(error.message, true); }
      finally { busy = false; buttons(); await refresh(); }
    }; }
    function buttons() {
      if (!$('import-package')) return;
      $('import-package').disabled = $('export-progress').disabled = busy || editor.busy;
      $('apply-package').disabled = busy || editor.busy;
    }
    function sync() {
      if (!snapshot || !root.document) return;
      for (const button of document.querySelectorAll('[data-package-play]')) {
        const active = queue.context?.pack.id === button.dataset.packagePlay;
        button.textContent = active && ['speaking', 'waiting'].includes(player.state) ? 'Pause'
          : active && player.state === 'paused' ? 'Resume' : active && player.state === 'ended' ? 'Replay' : 'Play';
        const pack = snapshot.packages.find(p => p.id === button.dataset.packagePlay);
        button.disabled = busy || editor.busy || !pack?.entries.some(e => snapshot.documents.some(d => d.id === e.topicId && !d.trashedAt && d.text.trim()));
      }
    }
    async function refresh() {
      const token = ++refreshToken;
      try {
        const data = await editor.store.learningSnapshot();
        if (token !== refreshToken || !root.document) return;
        snapshot = data; render();
      } catch (error) { message(error.message, true); }
    }
    function render() {
      const nodes = snapshot.packages.sort((a, b) => b.date.localeCompare(a.date)).map(pack => {
        const card = document.createElement('div'); card.className = 'package-card';
        const heading = document.createElement('div'); heading.className = 'package-heading';
        const open = document.createElement('button'); open.className = 'package-open';
        open.textContent = new Date(pack.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        open.setAttribute('aria-expanded', String(opened.has(pack.id)));
        open.onclick = () => { if (opened.has(pack.id)) opened.delete(pack.id); else opened.add(pack.id); render(); };
        const playButton = document.createElement('button'); playButton.dataset.packagePlay = pack.id;
        playButton.setAttribute('aria-label', 'Play, pause or resume ' + open.textContent);
        playButton.onclick = run(async () => {
          if (queue.context?.pack.id === pack.id && ['speaking', 'waiting'].includes(player.state)) player.pause();
          else if (queue.context?.pack.id === pack.id && player.state === 'paused') play();
          else await queue.start(pack);
        });
        heading.append(open, playButton); card.append(heading);
        const body = document.createElement('div'); body.hidden = !opened.has(pack.id);
        for (const priority of root.ReciterLearning.priorities) {
          const entries = pack.entries.filter(e => e.priority === priority).map(e => ({ e, doc: snapshot.documents.find(d => d.id === e.topicId && !d.trashedAt) })).filter(x => x.doc);
          if (!entries.length) continue;
          const title = document.createElement('h3'); title.textContent = priority; body.append(title);
          for (const { e, doc } of entries) {
            const progress = snapshot.progress.find(p => p.occurrenceId === e.occurrenceId && p.textHash === root.ReciterLearning.fingerprint(doc.text));
            const button = document.createElement('button'); button.className = 'package-topic'; button.dataset.topicId = doc.id;
            button.style.setProperty('--document-color', doc.color);
            const mins = Math.max(1, Math.round(doc.text.trim().split(/\s+/).length / (150 * Number($('rate').value || 1))));
            button.textContent = `${doc.title} · ~${mins} min · ${progress?.completedAt ? 'Completed' : progress?.offset ? 'In progress' : 'Not started'}`;
            button.setAttribute('aria-current', String(queue.context?.entry.occurrenceId === e.occurrenceId));
            button.disabled = busy || editor.busy;
            button.onclick = run(() => queue.start(pack, doc.id)); body.append(button);
          }
        }
        card.append(body); return card;
      });
      $('package-list').replaceChildren(...nodes);
      const sources = editor.active?.learning?.sources || [];
      $('document-sources').hidden = !sources.length;
      $('source-links').replaceChildren(...sources.map(url => {
        const li = document.createElement('li'), a = document.createElement('a'); a.href = url; a.textContent = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a); return li;
      }));
      sync();
    }
    $('import-package').onclick = () => { $('package-file').value = ''; $('package-file').click(); };
    $('package-file').onchange = run(async () => {
      plan = null; $('package-review').hidden = true;
      const file = $('package-file').files[0]; if (!file) return;
      if (file.size > root.ReciterLearning.LIMIT) throw new Error('Maximum package size is 25 MiB.');
      const text = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read package')); reader.readAsText(file); });
      plan = await editor.transfer(() => editor.store.preparePackage(JSON.parse(text.replace(/^\uFEFF/, ''))));
      $('package-summary').textContent = `${plan.data.package.date}: ${plan.data.package.entries.length} listening topics; ${plan.added} new, ${plan.updated} existing. ${plan.data.topics.filter(t => t.trashedAt).length} Trash updates. Changed text restarts its listening position.`;
      $('package-review').hidden = false;
      message('Review the package before importing.');
    });
    $('cancel-package').onclick = () => { plan = null; $('package-review').hidden = true; message('Import canceled.'); };
    $('apply-package').onclick = run(async () => {
      if (!plan) return;
      await queue.flush();
      const packageId = await editor.transfer(async () => {
        queue.cancel();
        const result = await editor.store.applyPackage(plan);
        editor.documents = await editor.store.list();
        editor.active = editor.documents.find(d => d.id === editor.active?.id) || null;
        editor.loadVersion++; return result;
      });
      opened.add(packageId); plan = null; $('package-review').hidden = true;
      message('Package imported. Tap a topic or its package Play button.');
    });
    $('export-progress').onclick = run(async () => {
      await queue.flush();
      const data = await editor.transfer(() => editor.store.exportProgress());
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      const previous = $('download-progress'), link = previous.cloneNode(false);
      link.href = downloadUrl; link.download = 'reciter-progress-' + new Date().toISOString().slice(0, 10) + '.json'; link.hidden = false; previous.replaceWith(link);
      message('Tap Save progress file, then give it to Codex when preparing your next package.');
    });
    const previousChanged = editor.changed;
    editor.changed = value => { previousChanged(value); buttons(); refresh(); };
    $('rate').addEventListener('input', () => { if (snapshot) render(); });
    await queue.restore();
    if (queue.context) opened.add(queue.context.pack.id);
    buttons(); await refresh();
    if ($('learning-section')) $('learning-section').dataset.ready = 'true';
    return { sync, cancel: () => queue.cancel(), textChanged: () => queue.textChanged(), queue,
      async playTopic(id) {
        const token = queue.generation;
        const data = await editor.store.learningSnapshot();
        if (token !== queue.generation || editor.active?.id !== id) return true;
        const pack = data.packages.sort((a, b) => b.date.localeCompare(a.date)).find(p => p.entries.some(e => e.topicId === id));
        if (!pack || editor.active?.trashedAt) return false;
        await queue.start(pack, id); return true;
      } };
  }
  const api = { PackageQueue, mount };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ReciterPackages = api;
})(globalThis);
