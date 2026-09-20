/* Keep document storage and editing separate from the speech player. */
(function (root) {
  root.mountLibrary = async function ({ initialText, onTextChanged, onSwitch }) {
    const $ = id => document.getElementById(id);
    const title = $('document-title'), material = $('material'), status = $('save-status'), tags = $('document-tags');
    const search = $('library-search'), view = $('library-view'), sort = $('library-sort'), topic = $('library-tag');
    let ready = false, displayedId, renderedCards = '', failedNavigation = null, failedAction = null;
    let startupStep = 'loading library scripts';
    function render(editor) {
      if (!ready) startupStep = 'displaying the library';
      const active = editor.active, activeId = active?.id || null, trashed = Boolean(active?.trashedAt);
      if (!ready && trashed) view.value = 'trash';
      if (activeId !== displayedId) {
        displayedId = activeId;
        title.value = active?.title || ''; material.value = active?.text || ''; tags.value = (active?.tags || []).join(', ');
        onTextChanged();
      }
      title.disabled = material.disabled = tags.disabled = !ready || editor.busy || !active;
      title.readOnly = material.readOnly = tags.readOnly = trashed;
      $('new-document').disabled = !ready || editor.busy;
      for (const field of [search, view, sort, topic]) field.disabled = !ready || editor.busy;
      for (const id of ['duplicate-document', 'trash-document', 'restore-document', 'delete-document']) {
        $(id).disabled = !ready || editor.busy || !active;
      }
      $('duplicate-document').hidden = $('trash-document').hidden = trashed;
      $('restore-document').hidden = $('delete-document').hidden = !trashed;
      $('trash-note').hidden = !trashed;
      $('autosave-note').hidden = !active || trashed;
      $('retry-save').hidden = editor.state !== 'error';
      $('retry-save').disabled = editor.busy;
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
      const signature = JSON.stringify([editor.documents, activeId, editor.busy, view.value, search.value, sort.value, topic.value]);
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
        button.disabled = editor.busy;
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
      if (editor.busy || (id && id === editor.active?.id)) return;
      onSwitch();
      const switched = await editor.navigate(id);
      failedNavigation = switched ? null : { id }; failedAction = null;
      if (switched && !id) { showLibrary(); title.focus(); title.select(); }
    }
    async function organize(action) {
      if (editor.busy || !editor.active) return;
      if (action === 'delete' && !root.confirm(`Permanently delete “${editor.active.title.trim() || 'Untitled document'}”? This cannot be undone.`)) return;
      onSwitch();
      const completed = await editor.organize(action);
      failedAction = completed ? null : action; failedNavigation = null;
      if (completed && (action === 'duplicate' || action === 'restore')) showLibrary();
    }
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
