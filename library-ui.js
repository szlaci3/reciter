/* Keep document storage and editing separate from the speech player. */
(function (root) {
  root.mountLibrary = async function ({ initialText, onTextChanged, onSwitch }) {
    const $ = id => document.getElementById(id);
    const title = $('document-title'), material = $('material'), status = $('save-status'), tags = $('document-tags');
    const search = $('library-search'), view = $('library-view'), sort = $('library-sort'), topic = $('library-tag');
    let ready = false, displayedId, renderedCards = '', failedNavigation = null, failedAction = null;
    let startupStep = 'loading library scripts';
    let transferBusy = false, importMode = null, pendingImport = null, downloadUrl = null, displayedVersion;
    const backupStatus = $('backup-status');
    function render(editor) {
      if (!ready) startupStep = 'displaying the library';
      const busy = editor.busy || transferBusy;
      const active = editor.active, activeId = active?.id || null, trashed = Boolean(active?.trashedAt);
      if (!ready && trashed) view.value = 'trash';
      if (activeId !== displayedId || displayedVersion !== editor.loadVersion) {
        displayedId = activeId; displayedVersion = editor.loadVersion;
        title.value = active?.title || ''; material.value = active?.text || ''; tags.value = (active?.tags || []).join(', ');
        onTextChanged();
      }
      title.disabled = material.disabled = tags.disabled = !ready || busy || !active;
      title.readOnly = material.readOnly = tags.readOnly = trashed;
      $('new-document').disabled = !ready || busy;
      for (const id of ['export-database', 'import-database', 'add-database', 'apply-import', 'cancel-import', 'import-policy']) {
        $(id).disabled = !ready || busy;
      }
      for (const field of [search, view, sort, topic]) field.disabled = !ready || busy;
      for (const id of ['duplicate-document', 'trash-document', 'restore-document', 'delete-document']) {
        $(id).disabled = !ready || busy || !active;
      }
      $('duplicate-document').hidden = $('trash-document').hidden = trashed;
      $('restore-document').hidden = $('delete-document').hidden = !trashed;
      $('trash-note').hidden = !trashed;
      $('autosave-note').hidden = !active || trashed;
      $('retry-save').hidden = editor.state !== 'error';
      $('retry-save').disabled = busy;
      status.textContent = editor.state === 'error'
        ? (editor.error?.name === 'ConflictError' ? 'Not saved. ' + editor.error.message
          : 'Could not complete this action. Your document is still here. Retry before leaving this page.')
        : editor.state === 'saving' ? 'Saving…' : trashed ? 'In Trash · read-only'
          : active ? 'Saved on this device' : 'Choose or create a document.';
      status.dataset.state = editor.state;
      if (active) $('material-section').style.setProperty('--document-color', active.color);
      else $('material-section').style.removeProperty('--document-color');
      $('editing-document').textContent = active ? active.title.trim() || 'Untitled document' : 'No document selected';
      // Keep existing buttons/focus while typing; update cards after saves.
      const signature = JSON.stringify([editor.documents, activeId, busy, view.value, search.value, sort.value, topic.value]);
      if (signature === renderedCards) return;
      renderedCards = signature;
      const trash = view.value === 'trash';
      const all = editor.documents.filter(doc => Boolean(doc.trashedAt) === trash);
      view.options[1].textContent = `Trash (${editor.documents.filter(doc => doc.trashedAt).length})`;
      const chosenTag = topic.value;
      const topicNames = new Map();
      for (const doc of all) for (const tag of doc.tags || []) {
        if (!topicNames.has(tag.toLowerCase())) topicNames.set(tag.toLowerCase(), tag);
      }
      if (chosenTag && !topicNames.has(chosenTag)) topicNames.set(chosenTag, chosenTag);
      topic.replaceChildren(new Option('All topics', ''), ...Array.from(topicNames)
        .sort((a, b) => a[1].localeCompare(b[1])).map(([key, name]) => new Option(name, key)));
      topic.value = chosenTag;
      const visible = root.ReciterLibrary.visibleDocuments(editor.documents,
        { trash, search: search.value, sort: sort.value, tag: topic.value });
      const filtered = search.value.trim() || topic.value;
      $('document-count').textContent = `${filtered ? visible.length + ' of ' : ''}${all.length} ${all.length === 1 ? 'document' : 'documents'}${trash ? ' in Trash' : ''}`;
      $('library-empty').hidden = visible.length !== 0;
      $('library-empty').textContent = all.length ? 'No documents match. Try a different search or topic.'
        : trash ? 'Trash is empty.' : 'Your library is empty. Create a document or restore one from Trash.';
      $('selection-note').hidden = !active || visible.some(doc => doc.id === activeId);
      const focused = document.activeElement?.dataset.documentId;
      const cards = visible.map(doc => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'document-card';
        button.dataset.documentId = doc.id;
        button.style.setProperty('--document-color', doc.color);
        button.setAttribute('aria-pressed', String(doc.id === activeId));
        button.disabled = busy;
        const name = document.createElement('strong'); name.textContent = doc.title.trim() || 'Untitled document';
        const preview = document.createElement('span'); preview.className = 'document-preview';
        preview.textContent = doc.text.replace(/\s+/g, ' ').trim().slice(0, 100) || 'No text yet.';
        const topicTags = document.createElement('span'); topicTags.className = 'document-tags';
        topicTags.textContent = (doc.tags || []).join(' · '); topicTags.hidden = !topicTags.textContent;
        const selected = document.createElement('span'); selected.className = 'document-selection';
        selected.textContent = doc.id === activeId ? 'Selected' : 'Open document';
        button.append(name, preview, topicTags, selected);
        button.addEventListener('click', () => switchDocument(doc.id));
        return button;
      });
      $('document-list').replaceChildren(...cards);
      cards.find(card => card.dataset.documentId === focused)?.focus({ preventScroll: true });
    }
    let editor;
    try {
      const missing = [];
      if (typeof root.Dexie !== 'function') missing.push('dexie.js');
      if (!root.ReciterLibrary) missing.push('library.js');
      if (missing.length) {
        const details = await Promise.all(missing.map(async name => {
          const failure = root.reciterScriptErrors?.[name];
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const script = Array.from(document.scripts).find(tag =>
              tag.src && new URL(tag.src).pathname.split('/').pop() === name);
            const response = await fetch(script?.src || name, { cache: 'no-store', signal: controller.signal });
            const type = response.headers?.get('content-type') || 'unknown content type';
            const delivery = response.headers?.get('x-reciter-static');
            const source = (await response.text()).replace(/\r\n/g, '\n');
            let hash = 2166136261;
            for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
            const fingerprint = source.length + ':' + (hash >>> 0).toString(16);
            const expected = script?.dataset.sourceFingerprint;
            const identity = expected ? (fingerprint === expected ? 'matches bundled source' : 'DIFFERS from bundled source ' + expected) : 'source fingerprint';
            const location = root.reciterScriptLocations?.[name];
            const line = location?.line && source.split('\n')[location.line - 1];
            const start = Math.max(0, (location?.column || 1) - 61);
            const excerpt = line ? '; source near error: ' + line.slice(start, start + 160).trim() : '';
            return `${name}: HTTP ${response.status}, ${type}${failure ? '; ' + failure : '; script did not initialize'}; recheck ${identity} (${fingerprint})${delivery ? '; delivery ' + delivery : ''}${excerpt}`;
          } catch (error) {
            return `${name}: ${failure || 'script unavailable'}; fetch check: ${error.message}`;
          } finally { clearTimeout(timeout); }
        }));
        throw new Error('Required script missing: ' + details.join(' | ') + '.');
      }
      startupStep = 'opening browser storage';
      if (!root.indexedDB) throw new Error('IndexedDB is not available in this browser.');
      editor = new root.ReciterLibrary.LibraryEditor(new root.ReciterLibrary.LibraryStore(root.Dexie), render);
      await editor.initialize(initialText);
      ready = true; render(editor);
    } catch (error) {
      const detail = `${error?.name || 'Error'}: ${error?.message || String(error)}`;
      status.textContent = `Library could not start (${startupStep}). ${detail} Your text is still here for listening; changes will not be saved. Copy it before leaving and reload to retry.`;
      status.dataset.state = 'error';
      $('document-count').textContent = 'Library unavailable';
      $('new-document').disabled = title.disabled = true;
      $('retry-save').hidden = true;
      if ($('autosave-note')) $('autosave-note').hidden = true;
      $('document-list').replaceChildren();
      material.disabled = false;
      console.error('Reciter library startup failed at ' + startupStep, error);
      return;
    }
    function showLibrary() {
      view.value = 'library'; search.value = ''; topic.value = '';
      render(editor);
    }
    async function switchDocument(id) {
      if (editor.busy || transferBusy || (id && id === editor.active?.id)) return;
      onSwitch();
      const switched = await editor.navigate(id);
      failedNavigation = switched ? null : { id }; failedAction = null;
      if (switched && !id) { showLibrary(); title.focus(); title.select(); }
    }
    async function organize(action) {
      if (editor.busy || transferBusy || !editor.active) return;
      if (action === 'delete' && !root.confirm(`Permanently delete “${editor.active.title.trim() || 'Untitled document'}”? This cannot be undone.`)) return;
      onSwitch();
      const completed = await editor.organize(action);
      failedAction = completed ? null : action; failedNavigation = null;
      if (completed && (action === 'duplicate' || action === 'restore')) showLibrary();
    }
    function transferMessage(message, error = false) {
      backupStatus.textContent = message; backupStatus.dataset.state = error ? 'error' : 'ready';
    }
    function closeReview() {
      pendingImport = null; $('import-review').hidden = true;
    }
    function showReview(plan, filename) {
      const total = plan.backup.documents.length;
      $('import-summary').textContent = `${filename}: ${total - plan.incomingTrash} documents and ${plan.incomingTrash} in Trash. `
        + (plan.mode === 'replace'
          ? `This will replace all ${plan.currentCount - plan.currentTrash} current documents and ${plan.currentTrash} in Trash.`
          : `${plan.added.length} new, ${plan.identical.length} identical (skipped), ${plan.conflicts.length} with matching IDs but different content or metadata.`);
      const rows = plan.mode === 'add' ? plan.conflicts.map(item => {
        const row = document.createElement('li');
        row.textContent = `Existing: ${item.currentTitle || 'Untitled document'} · Incoming: ${item.title || 'Untitled document'}`;
        return row;
      }) : [];
      $('import-conflicts').replaceChildren(...rows);
      $('import-policy-label').hidden = plan.mode !== 'add' || !rows.length;
      $('import-policy').value = 'both';
      $('import-explanation').textContent = plan.mode === 'replace'
        ? 'Replacement removes the current library, including Trash. Export it first if you want to keep a backup. A final confirmation follows.'
        : 'Existing documents stay unchanged. Identical matching documents are skipped. Keep both gives each incoming conflict a new ID, a different color and “(imported copy)” in its title. Repeating this choice can create further copies.';
      $('apply-import').textContent = plan.mode === 'replace' ? 'Replace library…' : 'Add documents';
      $('import-review').hidden = false;
      transferMessage('Backup validated. Review the details before applying.');
    }
    $('export-database').addEventListener('click', async () => {
      if (editor.busy || transferBusy) return;
      transferBusy = true; render(editor); transferMessage('Preparing backup…');
      $('download-backup').hidden = true;
      try {
        const backup = await editor.exportBackup();
        const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
        // A second, direct tap on the download link works without relying on
        // user activation surviving asynchronous storage reads on mobile.
        const url = URL.createObjectURL(blob);
        if (downloadUrl) URL.revokeObjectURL(downloadUrl);
        downloadUrl = url;
        // Use a fresh link so a previous blob URL cannot remain cached.
        const previousLink = $('download-backup'), link = previousLink.cloneNode(false);
        link.href = url;
        link.download = 'reciter-backup-' + new Date(backup.exportedAt).toISOString().replace(/[:.]/g, '-') + '.json';
        link.textContent = `Save backup file · ${backup.documents.length} documents · ${new Date(backup.exportedAt).toLocaleTimeString()}`;
        link.hidden = false; previousLink.replaceWith(link);
        transferMessage('Backup ready. Tap Save backup file and keep the JSON file in Files or Downloads.');
      } catch (error) { transferMessage('Export failed: ' + error.message, true); }
      finally { transferBusy = false; render(editor); }
    });
    function chooseBackup(mode) {
      if (editor.busy || transferBusy) return;
      closeReview(); importMode = mode; transferMessage('Choose a backup file to review.');
      $('backup-file').value = ''; $('backup-file').click();
    }
    $('import-database').addEventListener('click', () => chooseBackup('replace'));
    $('add-database').addEventListener('click', () => chooseBackup('add'));
    $('backup-file').addEventListener('change', async () => {
      const file = $('backup-file').files[0], mode = importMode;
      if (!file || !mode || editor.busy || transferBusy) return;
      closeReview(); transferBusy = true; render(editor); transferMessage('Validating backup…');
      try {
        if (file.size > root.ReciterLibrary.MAX_BACKUP_BYTES) throw new Error('Backup files must be at most 25 MiB.');
        const text = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('The backup file could not be read.'));
          reader.onabort = () => reject(new Error('Reading the backup was canceled.'));
          reader.readAsText(file);
        });
        const backup = root.ReciterLibrary.parseBackup(text);
        pendingImport = await editor.prepareImport(backup, mode);
        showReview(pendingImport, file.name);
      } catch (error) { transferMessage(error.message + ' No import was applied.', true); }
      finally { transferBusy = false; render(editor); }
    });
    $('cancel-import').addEventListener('click', () => {
      closeReview(); transferMessage('Import canceled. No import was applied.');
    });
    $('apply-import').addEventListener('click', async () => {
      if (!pendingImport || editor.busy || transferBusy) return;
      const plan = pendingImport;
      if (plan.mode === 'replace' && !root.confirm(`Replace all ${plan.currentCount} current documents (including Trash) with ${plan.backup.documents.length} documents from this backup? This cannot be undone without a backup of the current library.`)) return;
      transferBusy = true; render(editor); transferMessage('Applying backup…');
      try {
        const result = await editor.applyImport(plan, $('import-policy').value);
        // Stop/reset even when a replacement retains the selected ID.
        onSwitch(); failedNavigation = failedAction = null;
        view.value = editor.active?.trashedAt ? 'trash' : 'library'; search.value = ''; topic.value = '';
        closeReview();
        transferMessage(plan.mode === 'replace' ? `Library replaced: ${result.documents.length} documents, including Trash.`
          : `Added ${result.added} documents (${result.copies} imported copies); skipped ${result.skipped}. Existing documents retained.`);
      } catch (error) {
        closeReview(); transferMessage(error.message + ' No import was applied. Select the file again to retry.', true);
      } finally { transferBusy = false; render(editor); }
    });
    title.addEventListener('input', () => editor.edit({ title: title.value }));
    material.addEventListener('input', () => editor.edit({ text: material.value }));
    tags.addEventListener('input', () => editor.edit({ tags: root.ReciterLibrary.normalizeTags(tags.value) }));
    for (const field of [search, view, sort, topic]) {
      field.addEventListener(field === search ? 'input' : 'change', () => render(editor));
    }
    $('new-document').addEventListener('click', () => switchDocument());
    for (const action of ['duplicate', 'trash', 'restore', 'delete']) {
      $(action + '-document').addEventListener('click', () => organize(action));
    }
    $('retry-save').addEventListener('click', () => {
      if (editor.dirty) editor.flush();
      else if (failedAction) organize(failedAction);
      else if (failedNavigation) switchDocument(failedNavigation.id);
      else editor.flush();
    });
    // Saves begin on input, not on unload; mobile browsers can discard a page
    // without delivering unload. Warn on ordinary navigation if a write failed.
    root.addEventListener('beforeunload', event => {
      if (editor.dirty) { event.preventDefault(); event.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && editor.dirty) editor.flush();
    });
  };
})(globalThis);
